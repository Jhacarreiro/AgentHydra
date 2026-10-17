"""Windows ownership for short, private request phases.

An OwnerJob is retained until its coordinator exits: closing its native job would
also terminate the coordinator itself. PhaseProcess(owner, python, module, value,
cancel=token, deadline=absolute_monotonic, max_bytes=...) starts a hidden phase;
collect() validates readiness, supplies one private JSON request, and returns one
bounded JSON object only after both the interpreter and its launcher have exited.
Workers call read_phase_request(job_name) before importing their phase handlers.
AccountLeases.acquire(directory, cancel=token, deadline=...) is a context manager;
lease.quarantine() retains an uncertain lease until the coordinator exits.
"""

from contextlib import contextmanager
from functools import lru_cache
import json
import os
from pathlib import Path
import queue
import re
import subprocess
import sys
import threading
import time
from uuid import uuid4

from ..errors import ClaudeError
from ..registry import chat_lock


_OWNERS = []  # A self-assigned KILL_ON_JOB_CLOSE handle must never be GC-closed.
_QUARANTINED = []  # Unconfirmed children cannot outlive a GC-released account lease.
_INPUT_LIMIT = 16 * 1024 * 1024


def json_frame(value):
    """One UTF-8 JSON line, escaping lone surrogates without inflating Unicode."""
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':')) + '\n').encode(
        'utf-8', 'backslashreplace')


def _interrupted():
    return ClaudeError('The request was cancelled. Its owned phase was stopped.',
        code='operation_interrupted')


def _check(cancel, deadline):
    if cancel is not None and cancel.is_set():
        raise _interrupted()
    if time.monotonic() >= deadline:
        raise ClaudeError('The request phase deadline expired.', code='operation_timeout')


def _protocol():
    return ClaudeError('The request phase did not return a valid bounded response.',
        code='phase_protocol_error')


@lru_cache(maxsize=1)
def _windows():
    if os.name != 'nt':
        raise ClaudeError('The shared request coordinator requires Windows ownership.',
            code='coordinator_unavailable')
    import ctypes as c
    from ctypes import wintypes as w

    class Basic(c.Structure):
        _fields_ = [('process_time', c.c_longlong), ('job_time', c.c_longlong),
            ('flags', w.DWORD), ('minimum_ws', c.c_size_t), ('maximum_ws', c.c_size_t),
            ('process_limit', w.DWORD), ('affinity', c.c_size_t),
            ('priority', w.DWORD), ('scheduling', w.DWORD)]

    class Counters(c.Structure):
        _fields_ = [(name, c.c_ulonglong) for name in
            ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]

    class Extended(c.Structure):
        _fields_ = [('basic', Basic), ('io', Counters), ('process_memory', c.c_size_t),
            ('job_memory', c.c_size_t), ('peak_process', c.c_size_t), ('peak_job', c.c_size_t)]

    class ProcessInfo(c.Structure):
        _fields_ = [('reserved1', w.LPVOID), ('peb', w.LPVOID),
            ('reserved2', w.LPVOID * 2), ('pid', c.c_size_t), ('parent', c.c_size_t)]

    class Windows:
        def __init__(self):
            self.kernel = c.WinDLL('kernel32', use_last_error=True)
            self.nt = c.WinDLL('ntdll', use_last_error=True)
            signatures = {
                'CreateJobObjectW': ([w.LPVOID, w.LPCWSTR], w.HANDLE),
                'OpenJobObjectW': ([w.DWORD, w.BOOL, w.LPCWSTR], w.HANDLE),
                'SetInformationJobObject': ([w.HANDLE, c.c_int, w.LPVOID, w.DWORD], w.BOOL),
                'AssignProcessToJobObject': ([w.HANDLE, w.HANDLE], w.BOOL),
                'QueryInformationJobObject': ([w.HANDLE, c.c_int, w.LPVOID, w.DWORD,
                    c.POINTER(w.DWORD)], w.BOOL),
                'IsProcessInJob': ([w.HANDLE, w.HANDLE, c.POINTER(w.BOOL)], w.BOOL),
                'GetCurrentProcess': ([], w.HANDLE),
                'OpenProcess': ([w.DWORD, w.BOOL, w.DWORD], w.HANDLE),
                'GetProcessTimes': ([w.HANDLE] + [c.POINTER(w.FILETIME)] * 4, w.BOOL),
                'GetExitCodeProcess': ([w.HANDLE, c.POINTER(w.DWORD)], w.BOOL),
                'WaitForSingleObject': ([w.HANDLE, w.DWORD], w.DWORD),
                'TerminateProcess': ([w.HANDLE, w.UINT], w.BOOL),
                'CreateEventW': ([w.LPVOID, w.BOOL, w.BOOL, w.LPCWSTR], w.HANDLE),
                'SetEvent': ([w.HANDLE], w.BOOL),
                'CloseHandle': ([w.HANDLE], w.BOOL),
            }
            for name, (args, result) in signatures.items():
                function = getattr(self.kernel, name)
                function.argtypes, function.restype = args, result
            self.nt.NtQueryInformationProcess.argtypes = [w.HANDLE, w.DWORD,
                w.LPVOID, w.DWORD, c.POINTER(w.DWORD)]
            self.nt.NtQueryInformationProcess.restype = c.c_long

        @staticmethod
        def checked(value):
            if not value:
                raise c.WinError(c.get_last_error())
            return value

        def close(self, handle):
            self.checked(self.kernel.CloseHandle(handle))

        def job(self, name=None, *, own=False):
            handle = self.checked(self.kernel.CreateJobObjectW(None, name))
            try:
                info = Extended()
                info.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
                self.checked(self.kernel.SetInformationJobObject(handle, 9,
                    c.byref(info), c.sizeof(info)))
                if own:
                    self.checked(self.kernel.AssignProcessToJobObject(handle,
                        self.kernel.GetCurrentProcess()))
                return handle
            except BaseException:
                self.close(handle)
                raise

        def join(self, name):
            handle = self.checked(self.kernel.OpenJobObjectW(1, False, name))
            try:
                self.checked(self.kernel.AssignProcessToJobObject(handle,
                    self.kernel.GetCurrentProcess()))
            finally:
                # The coordinator alone retains the phase job during its handshake.
                self.close(handle)

        def event(self):
            return self.checked(self.kernel.CreateEventW(None, True, False, None))

        def signal(self, handle):
            self.checked(self.kernel.SetEvent(handle))

        def open_process(self, pid):
            return self.checked(self.kernel.OpenProcess(0x100401, False, pid))

        def creation(self, handle):
            values = [w.FILETIME() for _ in range(4)]
            self.checked(self.kernel.GetProcessTimes(handle,
                *(c.byref(value) for value in values)))
            return (values[0].dwHighDateTime << 32) | values[0].dwLowDateTime

        def current_creation(self):
            return self.creation(self.kernel.GetCurrentProcess())

        def parent(self, handle):
            info, used = ProcessInfo(), w.DWORD()
            if self.nt.NtQueryInformationProcess(handle, 0, c.byref(info),
                    c.sizeof(info), c.byref(used)) != 0:
                raise OSError('Owned process identity query failed')
            return info.parent

        def in_job(self, process, job):
            result = w.BOOL()
            self.checked(self.kernel.IsProcessInJob(process, job, c.byref(result)))
            return bool(result.value)

        def exited(self, handle):
            result = self.kernel.WaitForSingleObject(handle, 0)
            if result == 0xffffffff:
                raise c.WinError(c.get_last_error())
            return result == 0

        def exit_code(self, handle):
            result = w.DWORD()
            self.checked(self.kernel.GetExitCodeProcess(handle, c.byref(result)))
            return result.value

        def terminate(self, handle):
            if not self.exited(handle):
                if not self.kernel.TerminateProcess(handle, 197) and not self.exited(handle):
                    raise c.WinError(c.get_last_error())

        def members(self, job):
            count = 32
            while count <= 65536:
                raw = c.create_string_buffer(8 + count * c.sizeof(c.c_size_t))
                used = w.DWORD()
                if self.kernel.QueryInformationJobObject(job, 3, raw,
                        c.sizeof(raw), c.byref(used)):
                    listed = int.from_bytes(raw.raw[4:8], 'little')
                    return list((c.c_size_t * listed).from_buffer(raw, 8))
                if c.get_last_error() != 234:
                    raise c.WinError(c.get_last_error())
                count *= 2
            raise OSError('Owned process inventory exceeded its safety bound')

    return Windows()


class CancelToken:
    """Thread and native wait cancellation. Close only after all its users exit."""

    def __init__(self):
        self.event = threading.Event()
        self.handle = _windows().event() if os.name == 'nt' else None

    def is_set(self):
        return self.event.is_set()

    def set(self):
        self.event.set()
        if self.handle is not None:
            _windows().signal(self.handle)

    def wait(self, seconds=None):
        return self.event.wait(seconds)

    def close(self):
        if self.handle is not None:
            _windows().close(self.handle)
            self.handle = None


class OwnerJob:
    """Own all phase descendants for this coordinator's entire process lifetime."""

    def __init__(self):
        self.api = _windows()
        if _OWNERS:
            raise ClaudeError('This coordinator already owns a request job.',
                code='coordinator_unavailable')
        try:
            self.handle = self.api.job(own=True)
        except OSError:
            raise ClaudeError('Windows could not establish coordinator ownership.',
                code='coordinator_unavailable') from None
        self.pid = os.getpid()
        self.creation = self.api.current_creation()
        self.lock = threading.Lock()
        self.phases = set()
        _OWNERS.append(self)

    def assert_idle(self):
        with self.lock:
            if self.phases:
                raise ClaudeError('Owned request phases have not finished cleanup.',
                    code='browser_busy')

    def register(self, phase):
        with self.lock:
            self.phases.add(phase)

    def finished(self, phase, verified):
        # An unconfirmed phase stays owned until this process exits and its job close ends it.
        # Only its account is held (a quarantined lease): refusing every later phase made one
        # uncertain phase fail every account's sends (2026-10-17).
        if verified:
            with self.lock:
                self.phases.discard(phase)


class _Lease:
    def __init__(self):
        self.quarantined = False

    def quarantine(self):
        self.quarantined = True


class AccountLeases:
    """Canonical in-process admission plus the existing authoritative session lock."""

    def __init__(self):
        self.lock = threading.Condition()
        self.accounts = set()
        self.quarantined = []
        self.quarantined_keys = set()

    @contextmanager
    def acquire(self, directory, *, cancel=None, deadline=None):
        deadline = min(deadline if deadline is not None else float('inf'),
            time.monotonic() + 210)
        canonical = os.path.normcase(os.path.realpath(os.path.expanduser(directory)))
        def check_wait():
            if cancel is not None and cancel.is_set():
                raise _interrupted()
            if time.monotonic() >= deadline:
                raise ClaudeError('Timed out waiting for this account request to finish.',
                    code='chat_busy', retryable=True)

        check_wait()
        with self.lock:
            while canonical in self.accounts:
                if canonical in self.quarantined_keys:
                    raise ClaudeError('This account remains reserved because phase cleanup is unconfirmed.',
                        code='chat_busy', retryable=False)
                check_wait()
                self.lock.wait(min(.05, max(0, deadline - time.monotonic())))
            check_wait()
            self.accounts.add(canonical)
        held, lease = None, _Lease()
        try:
            while True:
                check_wait()
                candidate = chat_lock(Path(directory) / 'locks', 'session', wait=0)
                try:
                    candidate.__enter__()
                except ClaudeError as exc:
                    if exc.code != 'chat_busy':
                        raise
                    if cancel is None:
                        time.sleep(.05)
                    else:
                        cancel.wait(.05)
                else:
                    held = candidate
                    break
            check_wait()
            yield lease
        finally:
            if held is not None and lease.quarantined:
                # Keep the generator and its file handle alive, including on errors.
                with self.lock:
                    retained = (canonical, held)
                    self.quarantined.append(retained)
                    self.quarantined_keys.add(canonical)
                    _QUARANTINED.append(retained)
                    self.lock.notify_all()
            else:
                try:
                    if held is not None:
                        held.__exit__(None, None, None)
                finally:
                    with self.lock:
                        self.accounts.discard(canonical)
                        self.lock.notify_all()


def read_phase_request(job_name, *, max_bytes=_INPUT_LIMIT):
    """Join the owned job before readiness, then read one private EOF-ended object."""
    api = _windows()
    try:
        api.join(job_name)
    except OSError:
        raise ClaudeError('The request phase owner is no longer available.',
            code='operation_interrupted') from None
    frame = {'type': 'phase_ready', 'pid': os.getpid(), 'creation': api.current_creation()}
    sys.stdout.write(json.dumps(frame, separators=(',', ':')) + '\n')
    sys.stdout.flush()
    raw = sys.stdin.buffer.readline(max_bytes + 1)
    if len(raw) > max_bytes or not raw.endswith(b'\n') or sys.stdin.buffer.read(1):
        raise _protocol()
    try:
        value = json.loads(raw)
    except (ValueError, UnicodeError, RecursionError):
        raise _protocol() from None
    if not isinstance(value, dict):
        raise _protocol()
    return value


class PhaseProcess:
    """One owned hidden worker. No credential payload is sent before identity proof."""

    def __init__(self, owner, python, module, value, *, cancel, deadline,
            max_bytes=_INPUT_LIMIT, env=None):
        self.owner, self.api = owner, owner.api
        self.cancel, self.deadline, self.max_bytes = cancel, deadline, max_bytes
        self.cleanup_verified = True
        self.process = self.job = self.launcher = self.actual = None
        self.actual_pid = None
        self.handles = {}
        self.threads = []
        self.value = None
        self.collected = False
        _check(cancel, deadline)
        executable = Path(python)
        if not executable.is_absolute() or executable.name.lower() not in {'python.exe', 'pythonw.exe'}:
            raise ClaudeError('An absolute managed windowless Python is required.',
                code='coordinator_unavailable')
        executable = executable.with_name('pythonw.exe')
        if not executable.is_file() or not re.fullmatch(r'[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*', module):
            raise ClaudeError('The managed request phase runtime is unavailable.',
                code='coordinator_unavailable')
        if not isinstance(value, dict) or not isinstance(max_bytes, int) or max_bytes < 4096:
            raise _protocol()
        try:
            raw = json_frame(value)
        except (TypeError, ValueError, RecursionError):
            raise _protocol() from None
        if len(raw) > _INPUT_LIMIT:
            raise _protocol()
        self.value = raw
        self.job_name = 'Local\\ClaudFreePhase-' + uuid4().hex
        owner.register(self)
        try:
            self.job = self.api.job(self.job_name)
            self.process = subprocess.Popen([str(executable), '-B', '-m', module,
                '--owned-phase-job', self.job_name], stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW, env=env)
            self.cleanup_verified = False
            self.launcher = self.api.open_process(self.process.pid)
            if self.api.parent(self.launcher) != owner.pid or not self.api.in_job(self.launcher, owner.handle):
                raise _protocol()
            self.launcher_creation = self.api.creation(self.launcher)
            if self.launcher_creation < owner.creation:
                raise _protocol()
            self.handles[self.process.pid] = (self.launcher, self.launcher_creation)
        except BaseException:
            self.value = None
            self._cleanup()
            raise

    def _claim(self, frame):
        if (not isinstance(frame, dict) or frame.get('type') != 'phase_ready'
                or type(frame.get('pid')) is not int or type(frame.get('creation')) is not int
                or frame['pid'] <= 0):
            raise _protocol()
        pid = frame['pid']
        handle = self.api.open_process(pid)
        try:
            creation = self.api.creation(handle)
            expected_parent = self.owner.pid if pid == self.process.pid else self.process.pid
            if (creation != frame['creation'] or creation < self.launcher_creation
                    or self.api.parent(handle) != expected_parent
                    or not self.api.in_job(handle, self.job)
                    or not self.api.in_job(handle, self.owner.handle)):
                raise _protocol()
        except BaseException:
            self.api.close(handle)
            raise
        if pid in self.handles:
            self.api.close(handle)
            handle = self.handles[pid][0]
        else:
            self.handles[pid] = (handle, creation)
        self.actual, self.actual_pid = handle, pid

    def _discover_descendants(self):
        """Claim only exact descendants of our retained launcher within OwnerJob."""
        candidates = {}
        try:
            for pid in self.api.members(self.owner.handle):
                if pid in self.handles or pid == self.owner.pid:
                    continue
                try:
                    handle = self.api.open_process(pid)
                except OSError:
                    continue  # A member can exit between the inventory and OpenProcess.
                try:
                    if self.api.exited(handle):
                        self.api.close(handle)
                        continue
                    creation = self.api.creation(handle)
                    if not self.api.in_job(handle, self.owner.handle):
                        self.api.close(handle)
                        continue
                    candidates[pid] = (handle, creation, self.api.parent(handle))
                except OSError:
                    exited = self.api.exited(handle)
                    self.api.close(handle)
                    if exited:
                        continue
                    raise
                except BaseException:
                    self.api.close(handle)
                    raise
            changed = True
            while changed:
                changed = False
                for pid, (handle, creation, parent) in list(candidates.items()):
                    ancestor = self.handles.get(parent)
                    if ancestor is not None and creation >= ancestor[1]:
                        self.handles[pid] = (handle, creation)
                        del candidates[pid]
                        changed = True
        finally:
            for handle, _, _ in candidates.values():
                self.api.close(handle)

    def _cleanup(self):
        self.value = None
        verified = self.process is None
        try:
            if self.job is not None:
                self.api.close(self.job)
                self.job = None
            if self.process is not None:
                requested = set()

                def stop(handle):
                    if handle in requested:
                        return
                    try:
                        self.api.terminate(handle)
                    except OSError as exc:
                        # Job close and TerminateProcess are asynchronous. Windows
                        # may deny a repeated termination while it is still pending;
                        # the bounded exact-handle wait below must still prove exit.
                        if getattr(exc, 'winerror', None) != 5:
                            raise
                    requested.add(handle)

                # Capture a base interpreter even when cancellation preceded readiness.
                self._discover_descendants()
                if self.launcher is None:
                    self.launcher = self.api.open_process(self.process.pid)
                    if (self.api.parent(self.launcher) != self.owner.pid
                            or not self.api.in_job(self.launcher, self.owner.handle)):
                        raise _protocol()
                    self.launcher_creation = self.api.creation(self.launcher)
                    self.handles[self.process.pid] = (self.launcher, self.launcher_creation)
                stop(self.launcher)
                cleanup_deadline = time.monotonic() + 10
                while True:
                    self._discover_descendants()
                    for handle, _ in self.handles.values():
                        stop(handle)
                    if all(self.api.exited(handle) for handle, _ in self.handles.values()):
                        self._discover_descendants()
                        if all(self.api.exited(handle) for handle, _ in self.handles.values()):
                            self.process.wait(timeout=max(.01, cleanup_deadline - time.monotonic()))
                            verified = True
                            break
                    if time.monotonic() >= cleanup_deadline:
                        break
                    time.sleep(.01)
                if verified:
                    for stream in (self.process.stdin, self.process.stdout):
                        if stream is not None:
                            stream.close()
                    for thread in self.threads:
                        thread.join(timeout=1)
                    verified = not any(thread.is_alive() for thread in self.threads)
        except (OSError, ValueError, ClaudeError, subprocess.TimeoutExpired):
            verified = False
        finally:
            if verified:
                try:
                    for handle, _ in self.handles.values():
                        self.api.close(handle)
                except OSError:
                    verified = False
                else:
                    self.handles.clear()
                    self.launcher = self.actual = None
            self.cleanup_verified = verified
            self.owner.finished(self, verified)
        if not verified:
            raise ClaudeError('The owned phase could not be confirmed stopped. Its account remains reserved.',
                code='phase_cleanup_unconfirmed')

    def collect(self):
        if self.collected:
            raise _protocol()
        self.collected = True
        frames = queue.Queue(maxsize=3)

        def read():
            try:
                ready = self.process.stdout.readline(4097)
                if len(ready) > 4096 or not ready.endswith(b'\n'):
                    raise _protocol()
                frames.put(('ready', json.loads(ready)))
                raw = self.process.stdout.readline(self.max_bytes + 1)
                if len(ready) + len(raw) > self.max_bytes or not raw.endswith(b'\n'):
                    raise _protocol()
                value = json.loads(raw)
                if not isinstance(value, dict) or self.process.stdout.read(1):
                    raise _protocol()
                frames.put(('result', value))
            except (OSError, ValueError, RecursionError, ClaudeError):
                frames.put(('error', _protocol()))

        def write(raw):
            try:
                self.process.stdin.write(raw)
                self.process.stdin.close()
            except (OSError, ValueError):
                frames.put(('error', _protocol()))

        reader = threading.Thread(target=read, daemon=True)
        self.threads.append(reader)
        reader.start()
        try:
            ready = False
            while True:
                _check(self.cancel, self.deadline)
                try:
                    kind, value = frames.get(timeout=min(.05, max(.001, self.deadline - time.monotonic())))
                except queue.Empty:
                    continue
                if kind == 'error':
                    raise value
                if kind == 'ready':
                    if ready:
                        raise _protocol()
                    self._claim(value)
                    _check(self.cancel, self.deadline)
                    writer = threading.Thread(target=write, args=(self.value,), daemon=True)
                    self.value = None
                    self.threads.append(writer)
                    writer.start()
                    ready = True
                elif kind == 'result' and ready:
                    while not all(self.api.exited(handle) for handle, _ in self.handles.values()):
                        _check(self.cancel, self.deadline)
                        if self.cancel is None:
                            time.sleep(.01)
                        else:
                            self.cancel.wait(.01)
                    if any(self.api.exit_code(handle) != 0 for handle, _ in self.handles.values()):
                        raise _protocol()
                    return value
                else:
                    raise _protocol()
        finally:
            self._cleanup()
