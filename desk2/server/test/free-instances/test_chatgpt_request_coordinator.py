"""Coordinator account ownership with local mocks only; no provider or subprocess work."""

import asyncio
from contextlib import contextmanager
import json
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from claudfree.chatgpt import request_coordinator as module
from claudfree.errors import ClaudeError


ACCOUNT, CHAT, SERVER, REQUEST = [str(uuid4()) for _ in range(4)]
ENTRY = {'chat_id': CHAT, 'name': 'synthetic-chat'}
MODEL = 'gpt-6'
ROOT = Path('synthetic-coordinator-root').resolve()
HEADERS = {'Authorization': 'Bearer synthetic-only'}
BRANCH = {'conversation_id': SERVER, 'current_node': str(uuid4()), 'is_temporary_chat': True}
PROMPT = 'Synthetic continuation 世界 \ud800'


def snapshot(label):
    return {'cookies': [{'name': 'synthetic', 'value': label, 'domain': 'chatgpt.com', 'path': '/'}], 'origins': []}


class Cancel:
    def __init__(self):
        self.flag = False
        self.closed = False

    def is_set(self):
        return self.flag

    def set(self):
        self.flag = True

    def close(self):
        self.closed = True


class Lease:
    def __init__(self, events):
        self.events = events
        self.quarantined = False

    def __enter__(self):
        self.events.append('lease-enter')
        return self

    def quarantine(self):
        self.quarantined = True
        self.events.append('quarantine')

    def __exit__(self, *_args):
        self.events.append('lease-exit')


class Fixture:
    def __init__(self):
        self.clock = 100
        self.events = []
        self.cancel = Cancel()
        self.store = SimpleNamespace(directory=ROOT / ACCOUNT / 'chatgpt',
            load=Mock(return_value=snapshot('original')), save=Mock())
        self.registry = Mock()
        self.registry.resolve.return_value = (dict(ENTRY), SERVER)
        self.registry.by_name.return_value = None
        self.registry.record.side_effect = lambda identity, _org, **kw: {'chat_id': identity, 'name': kw['name']}
        self.registry.status.side_effect = lambda _identity, status: self.events.append(f'status:{status}')
        self.registry.close.side_effect = lambda: self.events.append('registry-close')
        self.owner = module.Coordinator(object(), 'synthetic-python', ROOT, Path('synthetic-endpoint'),
            'synthetic-token', cache_dir=Path('synthetic-cache'))
        self.lease = Lease(self.events)
        self.owner.leases = SimpleNamespace(acquire=Mock(return_value=self.lease))
        self.owner.phase = Mock(side_effect=self.phase)
        self.owner.browser = Mock(side_effect=self.browser)
        self.request = {'provider': 'chatgpt', 'command': 'resume', 'chatId': CHAT, 'prompt': PROMPT}
        self.proof = {'already_sent': True, 'server_id': SERVER, 'metrics': {'synthetic': True}}

    def phase(self, kind, arguments, _cancel, _deadline):
        self.events.append(f'phase:{kind}')
        self.clock += 10
        if kind == 'preflight':
            return {'ok': True, 'saved_state_valid': True, 'saved_state': snapshot('preflight'),
                'headers': HEADERS, 'account_email': 'owner@example.test', 'account_label': 'Example Owner',
                'model': MODEL, 'existing': BRANCH, 'previous_ids': ['synthetic-old-message']}
        return {'ok': True, 'saved_state_valid': True, 'saved_state': snapshot('readback'),
            'result': {'ok': True, 'schema_version': 1, 'provider': 'chatgpt', 'command': 'resume',
                'transport': 'http', 'chat_id': arguments['entry']['chat_id'], 'server_conversation_id': SERVER,
                'response': 'Synthetic reply é \udfff', 'model': MODEL}}

    def browser(self, _preflight, _saved, prompt, on_id, _cancel, _deadline):
        self.events.append('browser')
        self.clock += 15
        on_id(SERVER)
        return {'ok': True, 'request': self.proof}, snapshot('browser')

    @contextmanager
    def slot(self, root, **options):
        self.slot_root, self.slot_options = root, options
        self.events.append('slot-enter')
        try:
            yield
        finally:
            self.events.append('slot-exit')

    @contextmanager
    def patched(self):
        with patch.object(module, 'ChatGPTRegistry', return_value=self.registry), \
                patch.object(module, 'ChatGPTState', return_value=self.store), \
                patch.object(module, 'browser_slot', side_effect=self.slot), \
                patch.object(module.time, 'monotonic', side_effect=lambda: self.clock):
            yield

    def account(self):
        with self.patched():
            return self.owner.account(self.store, self.request, self.cancel, 500)


class CoordinatorAccountTests(unittest.TestCase):
    def test_preflight_queue_browser_readback_and_final_persistence_keep_one_account_workflow(self):
        f = Fixture()
        result = f.account()
        self.assertTrue(result['ok'])
        self.assertEqual(result['response'], 'Synthetic reply é \udfff')
        self.assertEqual(f.events, ['phase:preflight', 'slot-enter', 'browser', 'slot-exit',
            'phase:readback', 'status:available', 'registry-close'])
        self.assertEqual([call.args[0] for call in f.owner.phase.call_args_list], ['preflight', 'readback'])
        self.assertEqual(f.owner.phase.call_args_list[1].args[1]['saved_state'], snapshot('browser'))
        self.assertEqual(f.owner.phase.call_args_list[1].args[1]['previous_ids'], ['synthetic-old-message'])
        self.assertEqual(f.owner.phase.call_args_list[1].args[1]['entry'], ENTRY)
        self.assertEqual(f.owner.phase.call_args_list[1].args[1]['prompt'], PROMPT)
        self.assertEqual(f.slot_root, Path('synthetic-cache') / 'browser-slots')
        self.assertEqual(f.slot_options['deadline'], 230)
        self.assertIs(f.slot_options['cancel'], f.cancel)
        self.assertTrue(all(call.args[3] == 500 for call in f.owner.phase.call_args_list))
        f.owner.browser.assert_called_once()
        self.assertEqual(f.registry.link.call_args_list[-1].args, (CHAT, SERVER))
        f.store.save.assert_called_once_with(snapshot('readback'))
        self.assertEqual(f.store.load.return_value, snapshot('original'))

    def test_preflight_failure_persists_its_rotated_cookies_without_recording_or_dispatching(self):
        f = Fixture()
        f.owner.phase.side_effect = lambda *_args: {'ok': False, 'saved_state_valid': True,
            'saved_state': snapshot('preflight-failure'),
            'error': {'code': 'login_required', 'message': 'Synthetic authentication refusal'}}
        result = f.account()
        self.assertEqual(result['error']['code'], 'login_required')
        f.owner.browser.assert_not_called()
        f.registry.record.assert_not_called()
        f.store.save.assert_called_once_with(snapshot('preflight-failure'))
        f.registry.close.assert_called_once()

    def test_browser_refusal_saves_error_cookies_and_recovery_handle_without_replay(self):
        f = Fixture()

        def refuse(_preflight, _saved, _prompt, on_id, *_rest):
            on_id(SERVER)
            return {'ok': False, 'error': {'code': 'browser_send_rejected',
                'message': 'Synthetic refusal', 'http_status': 429}}, snapshot('browser-error')

        f.owner.browser.side_effect = refuse
        result = f.account()
        self.assertEqual(result['error']['code'], 'browser_send_rejected')
        self.assertEqual(result['error']['chat_id'], CHAT)
        self.assertEqual(result['error']['model'], MODEL)
        f.owner.browser.assert_called_once()
        self.assertEqual(f.owner.phase.call_count, 1)
        f.store.save.assert_called_once_with(snapshot('browser-error'))
        self.assertEqual(f.store.load.return_value, snapshot('original'))
        self.assertIn((CHAT, SERVER), [call.args for call in f.registry.link.call_args_list])
        f.registry.status.assert_called_once_with(CHAT, 'browser_send_rejected')

    def test_failed_readback_preserves_original_error_even_when_cookie_save_fails(self):
        f = Fixture()
        phase = f.phase

        def failed(kind, *arguments):
            if kind == 'preflight':
                return phase(kind, *arguments)
            return {'ok': False, 'saved_state_valid': True, 'saved_state': snapshot('readback-error'),
                'error': {'code': 'response_pending', 'message': 'Original synthetic confirmation failure'}}

        f.owner.phase.side_effect = failed
        f.store.save.side_effect = OSError('Synthetic persistence refusal')
        result = f.account()
        self.assertEqual(result['error']['code'], 'response_pending')
        self.assertEqual(result['error']['message'], 'Original synthetic confirmation failure')
        f.owner.browser.assert_called_once()
        f.store.save.assert_called_once_with(snapshot('readback-error'))
        f.registry.status.assert_called_once_with(CHAT, 'response_pending')

    def test_successful_confirmation_cannot_claim_success_if_final_cookie_persistence_fails(self):
        f = Fixture()
        f.store.save.side_effect = OSError('Synthetic persistence refusal')
        result = f.account()
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'session_save_failed')
        self.assertEqual((result['error']['chat_id'], result['error']['model']), (CHAT, MODEL))
        f.owner.browser.assert_called_once()
        self.assertEqual(f.owner.phase.call_count, 2)

    def test_invalid_phase_snapshot_is_never_persisted_over_the_last_verified_cookies(self):
        for kind in ('preflight', 'readback'):
            with self.subTest(kind=kind):
                f = Fixture()
                phase = f.phase

                def failed(current, *arguments):
                    if current == kind:
                        return {'ok': False, 'saved_state_valid': False, 'saved_state': snapshot('invalid'),
                            'error': {'code': 'response_pending', 'message': 'Synthetic phase failure'},
                            'state_error': {'code': 'session_save_failed'}}
                    return phase(current, *arguments)

                f.owner.phase.side_effect = failed
                self.assertFalse(f.account()['ok'])
                if kind == 'preflight':
                    f.store.save.assert_not_called()
                    f.owner.browser.assert_not_called()
                else:
                    f.store.save.assert_called_once_with(snapshot('browser'))

    def test_cancelled_browser_queue_keeps_its_anchor_and_does_not_start_browser_or_readback(self):
        f = Fixture()

        @contextmanager
        def cancelled(root, **options):
            self.assertEqual(options['deadline'], 230)
            f.cancel.set()
            f.clock = 200
            raise ClaudeError('Synthetic queue cancellation', code='stopped')
            yield

        with f.patched(), patch.object(module, 'browser_slot', side_effect=cancelled):
            result = f.owner.account(f.store, f.request, f.cancel, 500)
        self.assertEqual(result['error']['code'], 'stopped')
        f.owner.browser.assert_not_called()
        self.assertEqual(f.owner.phase.call_count, 1)
        f.store.save.assert_called_once_with(snapshot('preflight'))

    def test_unconfirmed_phase_cleanup_quarantines_before_fallible_registry_cleanup(self):
        for kind in ('preflight', 'browser', 'readback'):
            with self.subTest(kind=kind):
                f = Fixture()
                phase = f.phase

                def failed(current, *arguments):
                    if current == kind:
                        raise ClaudeError('Synthetic child cleanup is unconfirmed', code='phase_cleanup_unconfirmed')
                    return phase(current, *arguments)

                def status(_identity, outcome):
                    if outcome == 'phase_cleanup_unconfirmed':
                        self.assertTrue(f.lease.quarantined)
                        raise OSError('Synthetic status failure')

                def close():
                    self.assertTrue(f.lease.quarantined)
                    raise OSError('Synthetic registry close failure')

                f.owner.phase.side_effect = failed
                if kind == 'browser':
                    f.owner.browser.side_effect = ClaudeError('Synthetic browser cleanup is unconfirmed', code='phase_cleanup_unconfirmed')
                f.registry.status.side_effect = status
                f.registry.close.side_effect = close
                with f.patched():
                    output = f.owner.execute(ROOT / ACCOUNT, f.request, f.cancel, 500)
                self.assertFalse(json.loads(output['stdout'])['ok'])
                self.assertTrue(f.lease.quarantined)
                self.assertTrue(f.owner.draining)
                self.assertLess(f.events.index('quarantine'), f.events.index('lease-exit'))

    def test_missing_login_and_unsupported_options_short_circuit_before_phase_or_browser(self):
        for missing in (False, True):
            f = Fixture()
            if missing:
                f.store.load.return_value = None
            else:
                f.request['webSearch'] = True
            result = f.account()
            self.assertEqual(result['error']['code'], 'login_required' if missing else 'unsupported_option')
            f.owner.phase.assert_not_called()
            f.owner.browser.assert_not_called()
            f.store.save.assert_not_called()

    def test_final_output_limit_counts_utf8_bytes_without_expanding_unicode_replies(self):
        f = Fixture()
        reply = '\u4e2d' * 200
        f.owner.account = Mock(return_value={'ok': True, 'chat_id': CHAT, 'model': MODEL, 'response': reply})
        with f.patched(), patch.object(module, 'OUTPUT_LIMIT', 1000):
            output = f.owner.execute(ROOT / ACCOUNT, f.request, f.cancel, 500)
        self.assertEqual(output['code'], 0)
        self.assertLess(len(output['stdout'].encode('utf-8')), 1000)
        self.assertEqual(json.loads(output['stdout'])['response'], reply)


class Reader:
    def __init__(self, value):
        self.value = value
        self.closed = asyncio.get_running_loop().create_future()

    async def readline(self):
        return (json.dumps(self.value) + '\n').encode()

    async def read(self, _count):
        return await self.closed


class Writer:
    def __init__(self):
        self.frames = []
        self.closed = False

    def write(self, value):
        self.frames.append(json.loads(value))

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass


class CoordinatorAdmissionTests(unittest.IsolatedAsyncioTestCase):
    def request(self):
        return {'op': 'run', 'token': 'synthetic-token', 'request_id': REQUEST,
            'state_dir': str(ROOT / ACCOUNT),
            'request': {'provider': 'chatgpt', 'command': 'chat', 'prompt': 'Synthetic request'}}

    async def test_accepted_request_is_not_replayed_when_the_same_identity_reconnects(self):
        f = Fixture()
        f.owner.execute = Mock(return_value={'code': 0, 'stdout': '{"ok":true}'})
        with patch.object(module, 'CancelToken', side_effect=Cancel):
            first, second = Writer(), Writer()
            await f.owner.handle(Reader(self.request()), first)
            await f.owner.handle(Reader(self.request()), second)
        f.owner.execute.assert_called_once()
        self.assertTrue(first.frames[0]['accepted'])
        self.assertFalse(second.frames[0]['accepted'])
        self.assertEqual(second.frames[0]['error']['code'], 'request_already_claimed')
        self.assertEqual(f.owner.active, 0)

    async def test_disconnect_keeps_admission_owned_until_cancelled_work_really_finishes(self):
        f = Fixture()
        started, cleanup = threading.Event(), threading.Event()
        cancelled = []

        def execute(_directory, _request, cancel, _deadline):
            started.set()
            until = time.monotonic() + 2
            while not cancel.is_set() and time.monotonic() < until:
                time.sleep(.001)
            cancelled.append(cancel)
            cleanup.wait(2)
            return {'code': 1, 'stdout': '{"ok":false}'}

        f.owner.execute = Mock(side_effect=execute)
        reader, writer = Reader(self.request()), Writer()
        with patch.object(module, 'CancelToken', side_effect=Cancel):
            running = asyncio.create_task(f.owner.handle(reader, writer))
            try:
                self.assertTrue(await asyncio.to_thread(started.wait, 1))
                reader.closed.set_result(b'')
                await asyncio.sleep(.02)
                self.assertEqual(f.owner.active, 1)
                self.assertFalse(running.done())
            finally:
                cleanup.set()
                await asyncio.wait_for(running, 3)
        self.assertTrue(cancelled[0].closed)
        self.assertEqual(f.owner.active, 0)
        self.assertEqual(len(writer.frames), 1)
        self.assertTrue(writer.closed)


class CoordinatorBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def broker(self, handler):
        """Only an invented loopback peer; no browser or provider is started."""
        tasks = set()

        async def owned(reader, writer):
            task = asyncio.current_task()
            tasks.add(task)
            try:
                await handler(reader, writer)
            finally:
                writer.close()
                await writer.wait_closed()
                tasks.discard(task)

        server = await asyncio.start_server(owned, '127.0.0.1', 0)
        scratch = tempfile.TemporaryDirectory(prefix='synthetic-coordinator-')
        endpoint = Path(scratch.name) / 'endpoint.json'
        endpoint.write_text(json.dumps({'port': server.sockets[0].getsockname()[1], 'token': 'a' * 64}), encoding='utf-8')
        owner = module.Coordinator(object(), 'synthetic-python', ROOT, endpoint, 'synthetic-token')
        owner.loop = asyncio.get_running_loop()
        self.addAsyncCleanup(self.close_broker, server, tasks, scratch)
        return owner

    async def close_broker(self, server, tasks, scratch):
        server.close()
        await server.wait_closed()
        for task in list(tasks):
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        scratch.cleanup()

    def start_browser(self, owner, cancel, on_id=None):
        preflight = {'account_email': 'owner@example.test', 'headers': HEADERS,
            'model': MODEL, 'existing': BRANCH}
        return asyncio.create_task(asyncio.to_thread(owner.browser, preflight, snapshot('original'),
            PROMPT, on_id or Mock(), cancel, time.monotonic() + 10))

    @contextmanager
    def local_http(self):
        http = SimpleNamespace(saved_state=Mock(return_value=snapshot('browser-final')), close=Mock())
        with patch.object(module, 'ChatGPTHttp', return_value=http), patch.object(module, 'adopt_cookies') as adopt:
            yield http, adopt

    async def test_final_result_does_not_release_browser_ownership_before_cleanup_eof(self):
        final_sent, allow_eof = asyncio.Event(), asyncio.Event()
        requests = []

        async def handler(reader, writer):
            requests.append(json.loads(await reader.readline()))
            writer.write((json.dumps({'server_id': SERVER}) + '\n').encode())
            writer.write((json.dumps({'ok': True, 'request': {'already_sent': True},
                'cookies': snapshot('browser-final')['cookies'], 'cleanup_verified': True}) + '\n').encode())
            await writer.drain()
            final_sent.set()
            await allow_eof.wait()

        owner = await self.broker(handler)
        on_id = Mock()
        with self.local_http() as (http, adopt):
            running = self.start_browser(owner, Cancel(), on_id)
            try:
                await asyncio.wait_for(final_sent.wait(), 2)
                await asyncio.sleep(.02)
                self.assertFalse(running.done())
            finally:
                allow_eof.set()
                result, saved = await asyncio.wait_for(running, 3)
        self.assertTrue(result['ok'])
        self.assertEqual(saved, snapshot('browser-final'))
        self.assertEqual(len(requests), 1)
        self.assertEqual(requests[0]['prompt'], PROMPT)
        self.assertEqual(requests[0]['existing'], BRANCH)
        on_id.assert_called_once_with(SERVER)
        adopt.assert_called_once_with(http, snapshot('browser-final')['cookies'])
        http.close.assert_called_once()

    async def test_cancel_waits_for_remote_cleanup_receipt_and_actual_async_task_completion(self):
        dispatched, stopped, allow_cleanup = asyncio.Event(), asyncio.Event(), asyncio.Event()
        requests = []

        async def handler(reader, writer):
            requests.append(json.loads(await reader.readline()))
            dispatched.set()
            self.assertEqual(await reader.readline(), b'\n')
            stopped.set()
            await allow_cleanup.wait()
            writer.write(b'{"cleanup_verified":true}\n')
            await writer.drain()

        owner = await self.broker(handler)
        cancel = Cancel()
        running = self.start_browser(owner, cancel)
        try:
            await asyncio.wait_for(dispatched.wait(), 2)
            cancel.set()
            await asyncio.wait_for(stopped.wait(), 2)
            self.assertFalse(running.done())
        finally:
            allow_cleanup.set()
            with self.assertRaises(ClaudeError) as caught:
                await asyncio.wait_for(running, 3)
        self.assertEqual(caught.exception.code, 'stopped')
        self.assertEqual(len(requests), 1)

    async def test_cancel_drains_buffered_server_id_before_cleanup_receipt_on_owner_thread(self):
        progress_sent, stopped = asyncio.Event(), asyncio.Event()
        callback_threads, owner_threads, requests = [], [], []
        open_connection = asyncio.open_connection

        class BufferedReader:
            def __init__(self, reader):
                self.reader, self.first = reader, True

            async def readline(self):
                if self.first:
                    self.first = False
                    # Hold the ordinary response read until cancellation, leaving
                    # the real broker progress frame buffered for cleanup to drain.
                    await asyncio.Future()
                return await self.reader.readline()

            async def read(self, count):
                return await self.reader.read(count)

        async def connected(*args, **kwargs):
            reader, writer = await open_connection(*args, **kwargs)
            return BufferedReader(reader), writer

        async def handler(reader, writer):
            requests.append(json.loads(await reader.readline()))
            writer.write((json.dumps({'server_id': SERVER}) + '\n').encode())
            await writer.drain()
            progress_sent.set()
            self.assertEqual(await reader.readline(), b'\n')
            stopped.set()
            writer.write(b'{"cleanup_verified":true}\n')
            await writer.drain()

        owner = await self.broker(handler)
        browser = owner.browser

        def owned_browser(*args):
            owner_threads.append(threading.get_ident())
            return browser(*args)

        owner.browser = owned_browser
        on_id = Mock(side_effect=lambda _value: callback_threads.append(threading.get_ident()))
        cancel = Cancel()
        with patch.object(module.asyncio, 'open_connection', side_effect=connected):
            running = self.start_browser(owner, cancel, on_id)
            try:
                await asyncio.wait_for(progress_sent.wait(), 2)
            finally:
                cancel.set()
                with self.assertRaises(ClaudeError) as caught:
                    await asyncio.wait_for(running, 3)
        self.assertTrue(stopped.is_set())
        self.assertEqual(caught.exception.code, 'stopped')
        on_id.assert_called_once_with(SERVER)
        self.assertEqual(callback_threads, owner_threads)
        self.assertNotEqual(owner_threads[0], threading.get_ident())
        self.assertEqual(len(requests), 1)

    async def test_unverified_cleanup_receipt_never_claims_a_successful_send_is_safe(self):
        requests = []

        async def handler(reader, writer):
            requests.append(json.loads(await reader.readline()))
            writer.write((json.dumps({'ok': True, 'request': {'already_sent': True},
                'cookies': snapshot('browser-final')['cookies'], 'cleanup_verified': False}) + '\n').encode())
            await writer.drain()

        owner = await self.broker(handler)
        with self.local_http():
            with self.assertRaises(ClaudeError) as caught:
                await asyncio.wait_for(self.start_browser(owner, Cancel()), 3)
        self.assertEqual(caught.exception.code, 'phase_cleanup_unconfirmed')
        self.assertEqual(caught.exception._saved_state, snapshot('browser-final'))
        self.assertNotIn('_saved_state', caught.exception.as_dict())
        self.assertEqual(len(requests), 1)


if __name__ == '__main__':
    unittest.main()
