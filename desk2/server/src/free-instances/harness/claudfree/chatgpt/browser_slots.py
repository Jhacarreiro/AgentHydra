"""Blocking Windows queueing, with the existing file locks authoritative."""

from contextlib import contextmanager
from functools import lru_cache
from hashlib import sha256
import math
import os
import time

from ..errors import ClaudeError


_CAPACITY = 3
_TIMEOUT = -1


def _busy():
    return ClaudeError('The browser request queue is busy. No message was sent.',
        code='browser_busy', retryable=True)


def _check_cancel(cancel):
    if cancel is not None and cancel.is_set():
        raise ClaudeError('The browser request was cancelled. No message was sent.',
            code='operation_interrupted')


def _names(root):
    # Aliased paths can use different mutexes safely: the files still enforce capacity.
    normalized = os.path.normcase(os.path.abspath(root))
    digest = sha256(os.fsencode(normalized)).hexdigest()
    return [f'Global\\ClaudFreeBrowserSlot-{digest}-{slot}' for slot in range(_CAPACITY)]


@lru_cache(maxsize=1)
def _windows_api():
    if os.name != 'nt':
        return None
    try:
        import ctypes
        from ctypes import wintypes

        class Mutexes:
            def __init__(self):
                self.kernel = ctypes.WinDLL('kernel32', use_last_error=True)
                self.kernel.CreateMutexW.argtypes = [wintypes.LPVOID, wintypes.BOOL, wintypes.LPCWSTR]
                self.kernel.CreateMutexW.restype = wintypes.HANDLE
                self.kernel.WaitForMultipleObjects.argtypes = [wintypes.DWORD,
                    ctypes.POINTER(wintypes.HANDLE), wintypes.BOOL, wintypes.DWORD]
                self.kernel.WaitForMultipleObjects.restype = wintypes.DWORD
                self.kernel.ReleaseMutex.argtypes = [wintypes.HANDLE]
                self.kernel.ReleaseMutex.restype = wintypes.BOOL
                self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
                self.kernel.CloseHandle.restype = wintypes.BOOL

            def create(self, name):
                handle = self.kernel.CreateMutexW(None, False, name)
                if not handle:
                    raise ctypes.WinError(ctypes.get_last_error())
                return handle

            def wait(self, handles, milliseconds):
                return self.kernel.WaitForMultipleObjects(len(handles),
                    (wintypes.HANDLE * len(handles))(*handles), False, milliseconds)

            def release(self, handle):
                self.kernel.ReleaseMutex(handle)

            def close(self, handle):
                self.kernel.CloseHandle(handle)

        return Mutexes()
    except (AttributeError, OSError):
        return None


@contextmanager
def _native_slot(root, deadline, cancel=None):
    handles = []
    selected = None
    outcome = None
    api = _windows_api()
    try:
        _check_cancel(cancel)
        # A plain threading.Event cannot wake an indefinite native wait. The
        # opt-in coordinator supplies a retained native event; others use files.
        native_cancel = getattr(cancel, 'handle', None)
        if api is not None and (cancel is None or native_cancel is not None):
            try:
                for name in _names(root):
                    handles.append(api.create(name))
                remaining = max(0, deadline - time.monotonic())
                milliseconds = min(0xfffffffe, math.ceil(remaining * 1000))
                waiting = ([native_cancel] if native_cancel is not None else []) + handles
                offset = len(waiting) - len(handles)
                result = api.wait(waiting, milliseconds)
                if offset and result == 0:
                    raise ClaudeError('The browser request was cancelled. No message was sent.',
                        code='operation_interrupted')
                if offset <= result < offset + _CAPACITY:
                    selected = outcome = result - offset
                elif 0x80 + offset <= result < 0x80 + offset + _CAPACITY:
                    # An abandoned mutex is acquired, and must be released normally.
                    selected = outcome = result - 0x80 - offset
                elif result == 0x102:
                    outcome = _TIMEOUT
                # WAIT_FAILED or an unexpected result uses the file-only path.
            except (OSError, OverflowError):
                pass
        # Record any raced mutex ownership above before reacting to cancellation.
        _check_cancel(cancel)
        yield outcome
    finally:
        try:
            if selected is not None:
                api.release(handles[selected])
        finally:
            for handle in handles:
                api.close(handle)


@contextmanager
def _file_slot(root, deadline, locker, cancel=None, strict_deadline=False):
    # Preserve the standalone/old-version polling path and its initial attempt.
    while True:
        _check_cancel(cancel)
        if strict_deadline and time.monotonic() >= deadline:
            raise _busy()
        for slot in range(_CAPACITY):
            _check_cancel(cancel)
            held = locker(root, 'chatgpt-' + str(slot))
            try:
                held.__enter__()
            except ClaudeError as exc:
                if exc.code != 'chat_busy':
                    raise
                continue
            try:
                _check_cancel(cancel)
                if strict_deadline and time.monotonic() >= deadline:
                    raise _busy()
                yield
            finally:
                held.__exit__(None, None, None)
            return
        if time.monotonic() >= deadline:
            raise _busy()
        if cancel is None:
            time.sleep(.1)
        else:
            cancel.wait(.1)


@contextmanager
def browser_slot(root, *, wait, locker, cancel=None, deadline=None):
    """The legacy wait is unchanged; coordinator callers may supply its old anchor."""
    strict_deadline = deadline is not None
    deadline = time.monotonic() + wait if deadline is None else deadline
    _check_cancel(cancel)
    if strict_deadline and time.monotonic() >= deadline:
        raise _busy()
    with _native_slot(root, deadline, cancel) as selected:
        if selected == _TIMEOUT:
            raise _busy()
        if selected is not None:
            held = locker(root, 'chatgpt-' + str(selected))
            try:
                held.__enter__()
            except ClaudeError as exc:
                if exc.code != 'chat_busy':
                    raise
                # A legacy owner has no mutex. Release native resources before the
                # original file scan, rather than reacquiring the lowest mutex.
            else:
                try:
                    _check_cancel(cancel)
                    if strict_deadline and time.monotonic() >= deadline:
                        raise _busy()
                    yield
                finally:
                    held.__exit__(None, None, None)
                return
    with _file_slot(root, deadline, locker, cancel, strict_deadline):
        yield
