"""Offline Windows ownership, IPC, cancellation and authoritative-lock checks."""

from contextlib import contextmanager
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from claudfree.chatgpt import browser_slots, request_ownership as ownership
from claudfree.errors import ClaudeError
from claudfree.registry import chat_lock


class Token:
    def __init__(self, handle=None):
        self.handle = handle
        self.event = threading.Event()
        self.waits = []

    def is_set(self):
        return self.event.is_set()

    def set(self):
        self.event.set()

    def wait(self, seconds):
        self.waits.append(seconds)
        return self.event.wait(seconds)


class Native:
    def __init__(self, result, token=None):
        self.result, self.token = result, token
        self.waits, self.released, self.closed = [], [], []
        self.created = 0

    def create(self, name):
        self.created += 1
        return self.created + 100

    def wait(self, handles, milliseconds):
        self.waits.append((handles[:], milliseconds))
        if self.token is not None:
            self.token.set()
        return self.result

    def release(self, handle):
        self.released.append(handle)

    def close(self, handle):
        self.closed.append(handle)


class CancellationTests(unittest.TestCase):
    def test_native_cancel_wakes_wait_without_file_probe_or_closing_shared_event(self):
        token, touched = Token(77), []
        native = Native(0, token)
        with patch.object(browser_slots, '_windows_api', return_value=native):
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot('synthetic-slots', wait=120,
                        deadline=time.monotonic() + 30, cancel=token,
                        locker=lambda *args: touched.append(args)):
                    self.fail('Cancelled before admission')
        self.assertEqual(caught.exception.code, 'operation_interrupted')
        self.assertEqual(native.waits[0][0], [77, 101, 102, 103])
        self.assertTrue(29_000 <= native.waits[0][1] <= 30_000)
        self.assertEqual(native.released, [])
        self.assertEqual(native.closed, [101, 102, 103])
        self.assertEqual(touched, [])

    def test_cancel_racing_owned_and_abandoned_mutex_releases_exact_ownership(self):
        for result in (2, 0x82):
            with self.subTest(result=result):
                token = Token(77)
                native = Native(result, token)
                with patch.object(browser_slots, '_windows_api', return_value=native):
                    with self.assertRaises(ClaudeError):
                        with browser_slots.browser_slot('synthetic-slots', wait=120,
                                cancel=token, locker=lambda *args: self.fail('No file')):
                            self.fail('Cancellation raced acquisition')
                self.assertEqual(native.released, [102])
                self.assertEqual(native.closed, [101, 102, 103])

    def test_native_failure_keeps_original_absolute_deadline_during_file_fallback(self):
        clock, probes = [10.0], []
        native = Native(0xffffffff)
        token = Token(77)

        @contextmanager
        def busy(root, key):
            probes.append(key)
            raise ClaudeError('Synthetic contention', code='chat_busy')
            yield

        def waiting(seconds):
            self.assertEqual(seconds, .1)
            clock[0] += seconds

        with patch.object(browser_slots, '_windows_api', return_value=native), \
                patch.object(browser_slots.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(token, 'wait', side_effect=waiting):
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot('synthetic-slots', wait=999, deadline=10.2,
                        cancel=token, locker=busy):
                    self.fail('Busy')
        self.assertEqual(caught.exception.code, 'browser_busy')
        self.assertEqual(len(native.waits), 1)
        self.assertEqual(native.waits[0][1], 200)
        self.assertEqual(len(probes), 6)
        self.assertLess(clock[0], 10.31)

    def test_plain_event_cancels_file_fallback_and_expired_anchor_never_admits(self):
        event = threading.Event()

        @contextmanager
        def busy(*args):
            event.set()
            raise ClaudeError('Synthetic contention', code='chat_busy')
            yield

        native = Native(0)
        with patch.object(browser_slots, '_windows_api', return_value=native):
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot('synthetic-slots', wait=120,
                        cancel=event, locker=busy):
                    self.fail('Cancelled')
        self.assertEqual(caught.exception.code, 'operation_interrupted')
        self.assertEqual(native.waits, [])
        with self.assertRaises(ClaudeError) as caught:
            with browser_slots.browser_slot('synthetic-slots', wait=999,
                    deadline=time.monotonic() - 1, locker=lambda *a: self.fail('No admission')):
                self.fail('Expired anchor')
        self.assertEqual(caught.exception.code, 'browser_busy')


class AccountLeaseTests(unittest.TestCase):
    def test_canonical_duplicate_and_separate_thread_conflict_without_extra_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder) / 'synthetic-account'
            leases = ownership.AccountLeases()
            errors = []

            def duplicate():
                try:
                    with leases.acquire(directory / '..' / directory.name,
                            deadline=time.monotonic() + .05):
                        self.fail('Duplicate account admitted')
                except ClaudeError as exc:
                    errors.append(exc.code)

            with leases.acquire(directory):
                duplicate()
                thread = threading.Thread(target=duplicate)
                thread.start()
                thread.join(timeout=2)
                self.assertFalse(thread.is_alive())
                with self.assertRaises(ClaudeError) as caught:
                    with chat_lock(directory / 'locks', 'session'):
                        self.fail('The authoritative lock must still be held')
                self.assertEqual(caught.exception.code, 'chat_busy')
            self.assertEqual(errors, ['chat_busy', 'chat_busy'])
            self.assertEqual(leases.accounts, set())
            with chat_lock(directory / 'locks', 'session'):
                pass

    def test_same_account_waits_then_serializes_after_original_owner_releases(self):
        with tempfile.TemporaryDirectory() as folder:
            leases, admitted = ownership.AccountLeases(), threading.Event()
            errors = []

            def waiting():
                try:
                    with leases.acquire(Path(folder) / 'nested' / '..',
                            deadline=time.monotonic() + 2):
                        admitted.set()
                except BaseException as exc:
                    errors.append(type(exc).__name__)

            with leases.acquire(Path(folder)):
                thread = threading.Thread(target=waiting)
                thread.start()
                self.assertFalse(admitted.wait(.06))
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.assertEqual(errors, [])
            self.assertTrue(admitted.is_set())

    def test_cancel_foreign_lock_wait_releases_reservation_and_never_steals_lock(self):
        with tempfile.TemporaryDirectory() as folder:
            directory, token = Path(folder), Token()
            leases = ownership.AccountLeases()
            timer = threading.Timer(.05, token.set)
            with chat_lock(directory / 'locks', 'session'):
                timer.start()
                try:
                    with self.assertRaises(ClaudeError) as caught:
                        with leases.acquire(directory, cancel=token,
                                deadline=time.monotonic() + 2):
                            self.fail('Lock is already held')
                    self.assertEqual(caught.exception.code, 'operation_interrupted')
                    self.assertEqual(leases.accounts, set())
                finally:
                    timer.cancel()
                    timer.join(timeout=2)
            with leases.acquire(directory):
                pass

    def test_quarantine_keeps_canonical_guard_and_authoritative_context(self):
        events = []

        @contextmanager
        def lock(*args, **kwargs):
            events.append('enter')
            try:
                yield
            finally:
                events.append('exit')

        leases = ownership.AccountLeases()
        with patch.object(ownership, 'chat_lock', side_effect=lock):
            with leases.acquire(Path('synthetic-account')) as lease:
                lease.quarantine()
            self.assertEqual(events, ['enter'])
            self.assertEqual(len(leases.quarantined), 1)
            with self.assertRaises(ClaudeError) as caught:
                with leases.acquire(Path('synthetic-account')):
                    self.fail('Quarantined')
            self.assertEqual(caught.exception.code, 'chat_busy')
            self.assertFalse(caught.exception.retryable)
        # Explicit fixture-only cleanup; production retains this until owner exit.
        leases.quarantined[0][1].__exit__(None, None, None)
        ownership._QUARANTINED.remove(leases.quarantined[0])
        self.assertEqual(events, ['enter', 'exit'])


class ReadPhaseTests(unittest.TestCase):
    def test_json_frame_preserves_unicode_byte_bound_and_lone_surrogate_roundtrip(self):
        value = {'text': '\u4e2d\u6587\u0416\U0001f642', 'surrogate': '\ud800', 'line': 'first\nsecond'}
        raw = ownership.json_frame(value)
        self.assertEqual(json.loads(raw), value)
        self.assertEqual(raw.count(b'\n'), 1)
        self.assertIn('\u4e2d\u6587\u0416\U0001f642'.encode('utf-8'), raw)
        self.assertIn(b'\\ud800', raw)
        dense = {'text': '\u4e2d' * 1000}
        self.assertEqual(len(ownership.json_frame(dense)), 3012)
        self.assertEqual(len((json.dumps(dense, separators=(',', ':')) + '\n').encode()), 6012)

    def test_join_and_close_happen_before_readiness_or_private_input(self):
        events = []

        class Api:
            def join(self, name):
                events.extend(['join', 'close-local-job'])

            def current_creation(self):
                return 123

        class Output(io.StringIO):
            def write(self, text):
                events.append('ready')
                return super().write(text)

        output = Output()
        with patch.object(ownership, '_windows', return_value=Api()), \
                patch.object(ownership.sys, 'stdin', type('Input', (), {
                    'buffer': io.BytesIO(b'{"synthetic":true}\n')})()), \
                patch.object(ownership.sys, 'stdout', output):
            self.assertEqual(ownership.read_phase_request('opaque-name'), {'synthetic': True})
        self.assertEqual(events[:3], ['join', 'close-local-job', 'ready'])
        self.assertEqual(json.loads(output.getvalue())['creation'], 123)
        self.assertNotIn('synthetic', output.getvalue())

    def test_bad_root_multiple_lines_and_size_are_rejected_without_echoing_input(self):
        api = type('Api', (), {'join': lambda *a: None, 'current_creation': lambda *a: 123})()
        for raw, bound in [(b'[]\n', 4096), (b'{}\n{}\n', 4096),
                (b'{"private":"synthetic"}', 4096), (b'{"a":"123456"}\n', 8)]:
            with self.subTest(raw=raw):
                output = io.StringIO()
                with patch.object(ownership, '_windows', return_value=api), \
                        patch.object(ownership.sys, 'stdin', type('Input', (), {
                            'buffer': io.BytesIO(raw)})()), \
                        patch.object(ownership.sys, 'stdout', output):
                    with self.assertRaises(ClaudeError) as caught:
                        ownership.read_phase_request('opaque-name', max_bytes=bound)
                self.assertEqual(caught.exception.code, 'phase_protocol_error')
                self.assertNotIn('synthetic', str(caught.exception))
                self.assertNotIn('private', output.getvalue())

    def test_decoder_recursion_failure_refuses_without_waiting_for_phase_deadline(self):
        api = type('Api', (), {'join': lambda *a: None, 'current_creation': lambda *a: 123})()
        output = io.StringIO()
        with patch.object(ownership, '_windows', return_value=api), \
                patch.object(ownership.sys, 'stdin', type('Input', (), {
                    'buffer': io.BytesIO(b'{"private":"synthetic-only"}\n')})()), \
                patch.object(ownership.sys, 'stdout', output), \
                patch.object(ownership.json, 'loads', side_effect=RecursionError):
            with self.assertRaises(ClaudeError) as caught:
                ownership.read_phase_request('opaque-name', max_bytes=4096)
        self.assertEqual(caught.exception.code, 'phase_protocol_error')
        self.assertNotIn('synthetic-only', output.getvalue())
        self.assertNotIn('synthetic-only', str(caught.exception))


def _environment():
    environment = os.environ.copy()
    # Base and venv launchers both see the test and already-installed dependencies.
    paths = [str(Path(__file__).parent), *[item for item in sys.path if item]]
    environment['PYTHONPATH'] = os.pathsep.join(dict.fromkeys(paths))
    environment['PYTHONDONTWRITEBYTECODE'] = '1'
    environment['HYDRA_OWNERSHIP_TEST_PYTHON'] = os.environ.get(
        'HYDRA_OWNERSHIP_TEST_PYTHON', sys.executable)
    return environment


def _phase_fixture(job_name):
    delay = float(os.environ.get('HYDRA_OWNERSHIP_TEST_BOOT_DELAY', '0'))
    if delay:
        time.sleep(delay)
    if os.environ.get('HYDRA_OWNERSHIP_TEST_FORGED_READY'):
        api = ownership._windows()
        api.join(job_name)
        print(json.dumps({'type': 'phase_ready', 'pid': os.getpid(),
            'creation': api.current_creation() + 1}), flush=True)
        if sys.stdin.buffer.readline():
            Path(os.environ['HYDRA_OWNERSHIP_TEST_FORGED_READY']).write_text('unexpected input')
        return
    value = ownership.read_phase_request(job_name)
    import ctypes
    ctypes.windll.kernel32.GetConsoleWindow.restype = ctypes.c_void_p
    result = {'ok': True, 'pid': os.getpid(),
        'creation': ownership._windows().current_creation(),
        'console': int(ctypes.windll.kernel32.GetConsoleWindow() or 0), 'value': value.get('value')}
    if value.get('marker'):
        Path(value['marker']).write_text(json.dumps(result), encoding='utf-8')
    if value.get('hang'):
        time.sleep(30)
    if value.get('extra'):
        print('{}')
    if value.get('oversized'):
        result['oversized'] = 'x' * 10000
    print(json.dumps(result), flush=True)


def _owner_fixture(mode, receipt, directory):
    directory = Path(directory)
    owner, token = ownership.OwnerJob(), ownership.CancelToken()
    environment = _environment()
    phase = None
    timer = None
    result = {'ok': False}
    native_errors = []
    for name in ('close', 'members', 'open_process', 'creation', 'parent', 'in_job', 'exited', 'terminate'):
        original = getattr(owner.api, name)

        def tracking(*args, _name=name, _original=original, **kwargs):
            try:
                return _original(*args, **kwargs)
            except BaseException as exc:
                native_errors.append({'operation': _name, 'type': type(exc).__name__,
                    'winerror': getattr(exc, 'winerror', None)})
                raise

        setattr(owner.api, name, tracking)
    try:
        leases = ownership.AccountLeases()
        marker = directory / 'synthetic-action.json'
        payload = {'value': 'synthetic-only', 'marker': str(marker)}
        if mode == 'before_ready':
            environment['HYDRA_OWNERSHIP_TEST_BOOT_DELAY'] = '1'
            timer = threading.Timer(.08, token.set)
        elif mode == 'after_ready':
            payload['hang'] = True

            def cancel_after_action():
                limit = time.monotonic() + 8
                while not marker.exists() and time.monotonic() < limit:
                    time.sleep(.01)
                token.set()

            timer = threading.Thread(target=cancel_after_action, daemon=True)
        elif mode == 'extra':
            payload['extra'] = True
        elif mode == 'forged':
            environment['HYDRA_OWNERSHIP_TEST_FORGED_READY'] = str(marker)
        elif mode == 'oversized':
            payload['oversized'] = True
        elif mode == 'death':
            payload['hang'] = True
        with leases.acquire(directory / 'account', cancel=token,
                deadline=time.monotonic() + 15):
            phase = ownership.PhaseProcess(owner, environment['HYDRA_OWNERSHIP_TEST_PYTHON'],
                'test_chatgpt_request_ownership', payload, cancel=token,
                deadline=time.monotonic() + 15, max_bytes=8192, env=environment)
            if timer is not None:
                timer.start()
            if mode == 'death':
                def collecting():
                    phase.collect()

                threading.Thread(target=collecting, daemon=True).start()
                limit = time.monotonic() + 10
                while not marker.exists() and time.monotonic() < limit:
                    time.sleep(.01)
                child = json.loads(marker.read_text(encoding='utf-8'))
                Path(receipt).write_text(json.dumps({'owner_pid': os.getpid(),
                    'owner_creation': owner.creation, 'phase': child,
                    'launcher_pid': phase.process.pid,
                    'launcher_creation': phase.launcher_creation}), encoding='utf-8')
                time.sleep(30)
                raise RuntimeError('Fixture owner should have been terminated')
            try:
                value = phase.collect()
                result = {'ok': True, 'result': value}
            except ClaudeError as exc:
                result = {'ok': True, 'error': exc.code, 'action': marker.exists()}
            result['clean'] = phase.cleanup_verified
            owner.assert_idle()
        with chat_lock(directory / 'account' / 'locks', 'session'):
            result['account_released'] = True
        result['phases'] = len(owner.phases)
    except BaseException as exc:
        result = {**result, 'ok': False, 'error_type': type(exc).__name__,
            'outer_error': getattr(exc, 'code', 'fixture_error'),
            'clean': phase.cleanup_verified if phase is not None else None,
            'native_errors': native_errors,
            'threads': [thread.is_alive() for thread in phase.threads] if phase is not None else []}
    finally:
        if timer is not None:
            if hasattr(timer, 'cancel'):
                timer.cancel()
            timer.join(timeout=2)
        token.close()
        Path(receipt).write_text(json.dumps(result), encoding='utf-8')


@unittest.skipUnless(os.name == 'nt', 'Windows named job ownership')
class NativeOwnershipTests(unittest.TestCase):
    def test_real_native_cancel_event_wakes_three_held_slots(self):
        api = browser_slots._windows_api()
        self.assertIsNotNone(api)
        token = ownership.CancelToken()
        handles, locks, errors = [], [], []
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            try:
                for index, name in enumerate(browser_slots._names(root)):
                    handle = api.create(name)
                    handles.append(handle)
                    self.assertEqual(api.wait([handle], 0), 0)
                    lock = chat_lock(root, 'chatgpt-' + str(index))
                    lock.__enter__()
                    locks.append(lock)

                def waiting():
                    try:
                        with browser_slots.browser_slot(root, wait=120,
                                deadline=time.monotonic() + 2, cancel=token, locker=chat_lock):
                            errors.append('unexpected_admission')
                    except ClaudeError as exc:
                        errors.append(exc.code)

                thread = threading.Thread(target=waiting)
                thread.start()
                time.sleep(.05)
                token.set()
                thread.join(timeout=3)
                self.assertFalse(thread.is_alive())
                self.assertEqual(errors, ['operation_interrupted'])
            finally:
                token.set()
                if 'thread' in locals():
                    thread.join(timeout=3)
                for lock in reversed(locks):
                    lock.__exit__(None, None, None)
                for handle in handles:
                    api.release(handle)
                    api.close(handle)
                token.close()

    def _run(self, mode):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            receipt = root / 'result.json'
            executable = Path(getattr(sys, '_base_executable', sys.executable)).with_name('pythonw.exe')
            self.assertTrue(executable.is_file())
            process = subprocess.Popen([str(executable), '-B', str(Path(__file__).absolute()),
                '--fixture', mode, str(receipt), str(root)], env=_environment(),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                process.wait(timeout=35)
            finally:
                if process.poll() is None:
                    # Only this exact owned fixture handle; its OwnerJob kills descendants.
                    process.terminate()
                    process.wait(timeout=10)
            self.assertEqual(process.returncode, 0)
            self.assertTrue(receipt.is_file(), 'Owned fixture returned no bounded receipt')
            value = json.loads(receipt.read_text(encoding='utf-8'))
            self.assertTrue(value['ok'], value)
            self.assertTrue(value['clean'], value)
            self.assertTrue(value['account_released'], value)
            self.assertEqual(value['phases'], 0)
            return value

    def test_hidden_phase_success_validates_actual_interpreter_and_launcher_exit(self):
        value = self._run('success')
        self.assertEqual(value['result']['value'], 'synthetic-only')
        self.assertEqual(value['result']['console'], 0)

    def test_cancel_before_readiness_performs_no_phase_action(self):
        value = self._run('before_ready')
        self.assertEqual(value['error'], 'operation_interrupted')
        self.assertFalse(value['action'])

    def test_cancel_after_handshake_stops_only_owned_phase_and_releases_account(self):
        value = self._run('after_ready')
        self.assertEqual(value['error'], 'operation_interrupted')
        self.assertTrue(value['action'])

    def test_extra_stdout_fails_closed_with_verified_cleanup(self):
        value = self._run('extra')
        self.assertEqual(value['error'], 'phase_protocol_error')

    def test_forged_creation_refuses_private_payload_and_cleans_owned_process(self):
        value = self._run('forged')
        self.assertEqual(value['error'], 'phase_protocol_error')
        self.assertFalse(value['action'])

    def test_oversized_result_fails_closed_and_releases_account(self):
        value = self._run('oversized')
        self.assertEqual(value['error'], 'phase_protocol_error')

    def test_owner_death_kills_phase_descendants_releases_lease_and_leaves_bystander(self):
        api = ownership._windows()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            receipt = root / 'owner.json'
            executable = Path(getattr(sys, '_base_executable', sys.executable)).with_name('pythonw.exe')
            process = subprocess.Popen([str(executable), '-B', str(Path(__file__).absolute()),
                '--fixture', 'death', str(receipt), str(root)], env=_environment(),
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            bystander = subprocess.Popen([str(executable), '-B', '-c', 'import time; time.sleep(30)'],
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            claimed = []
            try:
                limit = time.monotonic() + 12
                value = None
                while time.monotonic() < limit:
                    try:
                        value = json.loads(receipt.read_text(encoding='utf-8'))
                        break
                    except (OSError, ValueError):
                        if process.poll() is not None:
                            self.fail('Owned fixture exited before readiness')
                        time.sleep(.02)
                self.assertIsNotNone(value)
                for pid, creation in [(value['owner_pid'], value['owner_creation']),
                        (value['phase']['pid'], value['phase']['creation']),
                        (value['launcher_pid'], value['launcher_creation'])]:
                    handle = api.open_process(pid)
                    claimed.append(handle)
                    self.assertEqual(api.creation(handle), creation)
                with chat_lock(root / 'bystander' / 'locks', 'session'):
                    with self.assertRaises(ClaudeError):
                        with chat_lock(root / 'account' / 'locks', 'session'):
                            self.fail('Coordinator should still own the account lease')
                    api.terminate(claimed[0])
                    limit = time.monotonic() + 8
                    while not all(api.exited(handle) for handle in claimed) and time.monotonic() < limit:
                        time.sleep(.02)
                    self.assertTrue(all(api.exited(handle) for handle in claimed))
                    process.wait(timeout=5)
                    with chat_lock(root / 'account' / 'locks', 'session'):
                        pass
                    self.assertIsNone(bystander.poll())
                    with self.assertRaises(ClaudeError):
                        with chat_lock(root / 'bystander' / 'locks', 'session'):
                            self.fail('Unrelated lock must remain held')
            finally:
                for handle in claimed:
                    try:
                        api.terminate(handle)
                    finally:
                        api.close(handle)
                for owned in (process, bystander):
                    if owned.poll() is None:
                        owned.terminate()
                    owned.wait(timeout=10)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--owned-phase-job':
        _phase_fixture(sys.argv[2])
    elif len(sys.argv) > 1 and sys.argv[1] == '--fixture':
        _owner_fixture(*sys.argv[2:])
    else:
        unittest.main()
