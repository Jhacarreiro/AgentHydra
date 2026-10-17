"""Offline slot ownership/fallback checks; child processes use synthetic locks only."""

from contextlib import contextmanager
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from claudfree.chatgpt import browser_slots
from claudfree.errors import ClaudeError
from claudfree.registry import chat_lock


class Native:
    def __init__(self, events, result=0, fail_create=None):
        self.events = events
        self.result = result
        self.fail_create = fail_create
        self.created = 0

    def create(self, name):
        index = self.created
        self.events.append(('create', index, name))
        if index == self.fail_create:
            raise OSError('Synthetic native API failure')
        self.created += 1
        return index + 100

    def wait(self, handles, milliseconds):
        self.events.append(('wait', tuple(handles), milliseconds))
        return self.result() if callable(self.result) else self.result

    def release(self, handle):
        self.events.append(('release', handle))

    def close(self, handle):
        self.events.append(('close', handle))


def locker(events, busy=(), error=None):
    @contextmanager
    def acquire(root, key):
        events.append(('file_enter', key))
        if error:
            raise error
        if key in busy:
            raise ClaudeError('Synthetic contention', code='chat_busy')
        try:
            yield
        finally:
            events.append(('file_exit', key))
    return acquire


class BrowserSlotTests(unittest.TestCase):
    def test_native_wait_claims_exact_file_and_releases_file_before_mutex(self):
        events = []
        native = Native(events, result=2)
        with patch.object(browser_slots, '_windows_api', return_value=native), \
                patch.object(browser_slots.time, 'sleep', side_effect=AssertionError('No polling')):
            with browser_slots.browser_slot(Path('synthetic-slots'), wait=120, locker=locker(events)):
                events.append(('body',))
        operations = [event[:2] for event in events]
        self.assertEqual(operations[-7:], [('file_enter', 'chatgpt-2'), ('body',),
            ('file_exit', 'chatgpt-2'), ('release', 102), ('close', 100), ('close', 101), ('close', 102)])
        self.assertEqual(sum(event[0] == 'wait' for event in events), 1)
        self.assertTrue(119_000 <= next(event[2] for event in events if event[0] == 'wait') <= 120_000)

    def test_abandoned_mutex_is_owned_and_released(self):
        events = []
        with patch.object(browser_slots, '_windows_api', return_value=Native(events, result=0x81)):
            with browser_slots.browser_slot(Path('synthetic-slots'), wait=0, locker=locker(events)):
                pass
        self.assertIn(('file_enter', 'chatgpt-1'), events)
        self.assertIn(('release', 101), events)
        self.assertEqual([event for event in events if event[0] == 'close'],
            [('close', 100), ('close', 101), ('close', 102)])

    def test_native_timeout_does_not_probe_files_or_extend_deadline(self):
        events = []
        with patch.object(browser_slots, '_windows_api', return_value=Native(events, result=0x102)), \
                patch.object(browser_slots.time, 'monotonic', side_effect=[10, 10.125]), \
                patch.object(browser_slots.time, 'sleep', side_effect=AssertionError('No polling')):
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot(Path('synthetic-slots'), wait=.375, locker=locker(events)):
                    self.fail('No slot available')
        self.assertEqual(caught.exception.code, 'browser_busy')
        self.assertTrue(caught.exception.retryable)
        self.assertEqual(next(event[2] for event in events if event[0] == 'wait'), 250)
        self.assertFalse(any(event[0].startswith('file_') or event[0] == 'release' for event in events))
        self.assertEqual(sum(event[0] == 'close' for event in events), 3)

    def test_legacy_contention_closes_mutex_handles_before_original_file_scan(self):
        events = []
        with patch.object(browser_slots, '_windows_api', return_value=Native(events)), \
                patch.object(browser_slots.time, 'sleep', side_effect=AssertionError('Slot one is free')):
            with browser_slots.browser_slot(Path('synthetic-slots'), wait=0,
                    locker=locker(events, busy={'chatgpt-0'})):
                events.append(('body',))
        self.assertEqual([event[:2] for event in events if event[0] not in {'create', 'wait'}], [
            ('file_enter', 'chatgpt-0'), ('release', 100), ('close', 100), ('close', 101), ('close', 102),
            ('file_enter', 'chatgpt-0'), ('file_enter', 'chatgpt-1'), ('body',), ('file_exit', 'chatgpt-1')])

    def test_legacy_fallback_uses_original_absolute_deadline_and_100ms_cadence(self):
        events = []
        clock = [10.0]

        def native_wait():
            clock[0] = 10.25
            return 0

        def sleep(seconds):
            self.assertEqual(seconds, .1)
            clock[0] += seconds

        with patch.object(browser_slots, '_windows_api', return_value=Native(events, result=native_wait)), \
                patch.object(browser_slots.time, 'monotonic', side_effect=lambda: clock[0]), \
                patch.object(browser_slots.time, 'sleep', side_effect=sleep) as sleeping:
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot(Path('synthetic-slots'), wait=.3,
                        locker=locker(events, busy={'chatgpt-0', 'chatgpt-1', 'chatgpt-2'})):
                    self.fail('All files are held by legacy callers')
        self.assertEqual(caught.exception.code, 'browser_busy')
        self.assertEqual(sleeping.call_count, 1)
        self.assertEqual(sum(event[0] == 'wait' for event in events), 1)
        self.assertEqual(sum(event[0] == 'file_enter' for event in events), 7)

    def test_unavailable_failed_and_partial_native_setup_keep_file_capacity(self):
        for native_result, fail_create in [(None, None), (0xffffffff, None), (0x400, None), (0, 1)]:
            with self.subTest(native_result=native_result, fail_create=fail_create):
                events = []
                native = None if native_result is None else Native(events, native_result, fail_create)
                with patch.object(browser_slots, '_windows_api', return_value=native):
                    with browser_slots.browser_slot(Path('synthetic-slots'), wait=0,
                            locker=locker(events, busy={'chatgpt-0', 'chatgpt-1'})):
                        events.append(('body',))
                self.assertIn(('file_enter', 'chatgpt-2'), events)
                self.assertEqual(sum(event[0] == 'close' for event in events), native.created if native else 0)
                self.assertFalse(any(event[0] == 'release' for event in events))

    def test_body_cancellation_is_not_caught_replayed_or_converted_to_fallback(self):
        for error in [OSError('Synthetic body failure'), KeyboardInterrupt(),
                ClaudeError('Synthetic body contention', code='chat_busy')]:
            with self.subTest(error=type(error).__name__):
                events = []
                with patch.object(browser_slots, '_windows_api', return_value=Native(events)):
                    with self.assertRaises(type(error)) as caught:
                        with browser_slots.browser_slot(Path('synthetic-slots'), wait=0, locker=locker(events)):
                            raise error
                self.assertIs(caught.exception, error)
                self.assertEqual(sum(event[0] == 'file_enter' for event in events), 1)
                self.assertLess(events.index(('file_exit', 'chatgpt-0')), events.index(('release', 100)))
                self.assertEqual(sum(event[0] == 'close' for event in events), 3)

    def test_noncontention_file_error_is_preserved_with_native_cleanup(self):
        events = []
        error = ClaudeError('Synthetic invalid file lock', code='invalid_chat_id')
        with patch.object(browser_slots, '_windows_api', return_value=Native(events)):
            with self.assertRaises(ClaudeError) as caught:
                with browser_slots.browser_slot(Path('synthetic-slots'), wait=0,
                        locker=locker(events, error=error)):
                    self.fail('Invalid lock')
        self.assertIs(caught.exception, error)
        self.assertEqual(sum(event[0] == 'file_enter' for event in events), 1)
        self.assertEqual(sum(event[0] == 'close' for event in events), 3)

    def test_names_are_stable_private_and_root_specific(self):
        root = Path('synthetic') / 'private-account@example.test' / '..' / 'slots'
        names = browser_slots._names(root)
        self.assertEqual(names, browser_slots._names(root.absolute()))
        self.assertEqual(len(set(names)), 3)
        self.assertTrue(all(name.startswith('Global\\ClaudFreeBrowserSlot-') for name in names))
        self.assertTrue(all('example.test' not in name and 'slots' not in name for name in names))
        self.assertNotEqual(names, browser_slots._names(root / 'other'))
        if os.name == 'nt':
            self.assertEqual(names, browser_slots._names(str(root).upper()))

    def test_browser_request_keeps_existing_locker_injection_seam(self):
        from claudfree.chatgpt import browser_request
        events = []
        with patch.dict(os.environ, {'CLAUDFREE_CACHE_DIR': 'synthetic-cache'}), \
                patch.object(browser_slots, '_windows_api', return_value=None), \
                patch.object(browser_request, 'chat_lock', side_effect=locker(events)) as lock:
            with browser_request.browser_slot(Path('synthetic-account'), wait=0):
                pass
        lock.assert_called_once_with(Path('synthetic-cache') / 'browser-slots', 'chatgpt-0')


@unittest.skipUnless(os.name == 'nt', 'Win32 kernel mutex interoperability')
class NativeBrowserSlotTests(unittest.TestCase):
    def setUp(self):
        if browser_slots._windows_api() is None:
            self.skipTest('Win32 mutex APIs unavailable')
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.children = []
        base = Path(getattr(sys, '_base_executable', sys.executable))
        self.python = base.with_name('pythonw.exe')
        if not self.python.is_file():
            self.temp.cleanup()
            self.skipTest('Hidden base Python interpreter unavailable')

    def tearDown(self):
        for process, own in self.children:
            (own / 'stop').touch()
        for process, _ in self.children:
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)
        self.temp.cleanup()

    def spawn(self, mode='native'):
        own = self.root / f'child-{len(self.children)}'
        own.mkdir()
        # Use the direct hidden interpreter for exact process ownership while
        # retaining dependencies installed only in the parent's virtualenv.
        import_paths = [str(Path(browser_slots.__file__).resolve().parents[2]),
            *(path for path in sys.path if path and Path(path).is_dir())]
        environment = {**os.environ, 'PYTHONDONTWRITEBYTECODE': '1',
            'PYTHONPATH': os.pathsep.join(import_paths),
            'HOME': str(own), 'USERPROFILE': str(own), 'LOCALAPPDATA': str(own), 'APPDATA': str(own),
            'CLAUDFREE_STATE_DIR': str(own / 'state'), 'CLAUDFREE_CACHE_DIR': str(own / 'cache')}
        process = subprocess.Popen([str(self.python), '-B', str(Path(__file__).resolve()),
            '--slot-child', str(self.root / 'slots'), str(own), mode], env=environment,
            cwd=own, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=subprocess.CREATE_NO_WINDOW)
        self.children.append((process, own))
        ready = self.read_stage(own, 'waiting', process)
        # A direct base interpreter avoids a venv launcher/child ownership ambiguity.
        self.assertEqual(ready['pid'], process.pid)
        return process, own

    def read_stage(self, own, stage, process, timeout=8):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                receipt = json.loads((own / f'{stage}.json').read_text(encoding='utf-8'))
                return receipt
            except (OSError, ValueError):
                pass
            self.assertIsNone(process.poll(), 'Synthetic slot child exited before its receipt')
            time.sleep(.02)
        self.fail(f'Synthetic child did not reach {stage}')

    def assert_files_full(self):
        for slot in range(3):
            with self.assertRaises(ClaudeError) as caught:
                with chat_lock(self.root / 'slots', f'chatgpt-{slot}'):
                    self.fail('An owned file slot was unexpectedly free')
            self.assertEqual(caught.exception.code, 'chat_busy')

    def test_real_capacity_waiter_cancellation_abandoned_owner_and_directory_cleanup(self):
        owners = [self.spawn() for _ in range(3)]
        acquired = [self.read_stage(own, 'acquired', process) for process, own in owners]
        self.assertEqual({receipt['key'] for receipt in acquired}, {'chatgpt-0', 'chatgpt-1', 'chatgpt-2'})
        waiting, waiting_home = self.spawn()
        time.sleep(.15)
        self.assertFalse((waiting_home / 'acquired.json').exists())
        waiting.kill()
        waiting.wait(timeout=3)
        self.assert_files_full()

        waiting, waiting_home = self.spawn()
        time.sleep(.1)
        self.assertFalse((waiting_home / 'acquired.json').exists())
        owner, owner_home = owners[1]
        key = acquired[1]['key']
        owner.kill()
        owner.wait(timeout=3)
        replacement = self.read_stage(waiting_home, 'acquired', waiting)
        self.assertEqual(replacement['key'], key)
        # Windows can abandon the mutex before releasing the terminated owner's
        # file handle. The authoritative file lock may require the safe fallback.
        self.assertGreaterEqual(replacement['probes'], 1)
        self.assert_files_full()
        started = time.monotonic()
        cpu = time.process_time()
        with self.assertRaises(ClaudeError) as caught:
            with browser_slots.browser_slot(self.root / 'slots', wait=.2, locker=chat_lock):
                self.fail('A fourth native owner was admitted')
        self.assertEqual(caught.exception.code, 'browser_busy')
        # A Windows wait may time out up to one clock tick (15.6 ms) early: 0.187 s on a CI runner.
        self.assertGreaterEqual(time.monotonic() - started, .2 - .016)
        self.assertLess(time.process_time() - cpu, .1)

        for process, own in self.children:
            (own / 'stop').touch()
        for process, _ in self.children:
            process.wait(timeout=3)
        for path in (self.root / 'slots').iterdir():
            path.unlink()
        (self.root / 'slots').rmdir()
        with browser_slots.browser_slot(self.root / 'slots', wait=0, locker=chat_lock):
            pass

    def test_real_legacy_file_owner_falls_back_without_exceeding_capacity(self):
        process, own = self.spawn('legacy')
        self.read_stage(own, 'acquired', process)
        probes = []

        def counted(root, key):
            probes.append(key)
            return chat_lock(root, key)

        with self.assertRaises(ClaudeError) as caught:
            with browser_slots.browser_slot(self.root / 'slots', wait=.14, locker=counted):
                self.fail('Legacy locks are authoritative')
        self.assertEqual(caught.exception.code, 'browser_busy')
        self.assertEqual(probes[:4], ['chatgpt-0', 'chatgpt-0', 'chatgpt-1', 'chatgpt-2'])
        self.assert_files_full()
        (own / 'stop').touch()
        process.wait(timeout=3)
        with browser_slots.browser_slot(self.root / 'slots', wait=0, locker=chat_lock):
            pass


def _slot_child(root, own, mode):
    from contextlib import ExitStack
    state = {'pid': os.getpid(), 'probes': 0}

    def note(stage):
        (own / f'{stage}.json').write_text(json.dumps(state), encoding='utf-8')

    def counted(folder, key):
        state['probes'] += 1
        state['key'] = key
        return chat_lock(folder, key)

    note('waiting')
    with ExitStack() as held:
        if mode == 'legacy':
            for slot in range(3):
                held.enter_context(counted(root, f'chatgpt-{slot}'))
        else:
            held.enter_context(browser_slots.browser_slot(root, wait=12, locker=counted))
        note('acquired')
        deadline = time.monotonic() + 20
        while not (own / 'stop').exists() and time.monotonic() < deadline:
            time.sleep(.02)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--slot-child':
        _slot_child(Path(sys.argv[2]), Path(sys.argv[3]), sys.argv[4])
    else:
        unittest.main()
