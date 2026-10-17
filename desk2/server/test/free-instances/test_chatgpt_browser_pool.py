"""No-network checks for shared-browser isolation and single-dispatch guards."""

import asyncio
import json
from pathlib import Path
import socket
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from claudfree.chatgpt.browser_pool import MAX_FRAME, ContextBrowser, Pool, serve
from claudfree.errors import ClaudeError
from claudfree.registry import chat_lock


def fixture():
    cdp = SimpleNamespace(
        storage=SimpleNamespace(
            get_cookies=Mock(return_value='get-context-cookies'),
            set_cookies=Mock(return_value='set-context-cookies'),
        ),
        target=SimpleNamespace(
            dispose_browser_context=Mock(return_value='dispose-context'),
        ),
    )
    browser = SimpleNamespace(
        connection=SimpleNamespace(send=AsyncMock(return_value=[])),
        cookies=SimpleNamespace(get_all=AsyncMock(), set_all=AsyncMock()),
        create_context=AsyncMock(side_effect=AssertionError('No context may start')),
        get=AsyncMock(),
        stop=AsyncMock(),
    )
    return browser, cdp


def context_argument(call):
    return call.kwargs.get('browser_context_id', call.args[0] if call.args else None)


class Writer:
    def __init__(self):
        self.data = bytearray()
        self.closed = False

    def write(self, data):
        self.data.extend(data)

    async def drain(self):
        pass

    def close(self):
        self.closed = True

    async def wait_closed(self):
        pass

    def is_closing(self):
        return self.closed


async def invoke(pool, request, *, disconnect=False):
    async def read(_size):
        if disconnect:
            await asyncio.sleep(0)
            return b''
        await asyncio.get_running_loop().create_future()

    reader = SimpleNamespace(readline=AsyncMock(side_effect=[
        json.dumps(request).encode() + b'\n', b'',
    ]), read=AsyncMock(side_effect=read))
    writer = Writer()
    await pool.handle(reader, writer)
    return [json.loads(line) for line in writer.data.splitlines()]


def request(token='fixture-token', **changes):
    return {
        'token': token,
        'request_id': str(uuid4()),
        'op': 'send',
        'state': {'cookies': [], 'origins': []},
        'account_email': 'example@example.test',
        'prompt': 'Example prompt',
        'model': 'gpt-4o-mini',
        'directory': 'unused-fixture-directory',
        'timeout': 1,
        'temporary': True,
        'existing': None,
        **changes,
    }


class ContextBrowserTests(unittest.IsolatedAsyncioTestCase):
    async def test_cookie_reads_are_scoped_to_each_context(self):
        browser, cdp = fixture()
        first = ContextBrowser(browser, SimpleNamespace(
            target=SimpleNamespace(browser_context_id='context-a')), cdp)
        second = ContextBrowser(browser, SimpleNamespace(
            target=SimpleNamespace(browser_context_id='context-b')), cdp)
        await first.cookies.get_all()
        await second.cookies.get_all()
        self.assertEqual([context_argument(call) for call in
            cdp.storage.get_cookies.call_args_list], ['context-a', 'context-b'])
        browser.cookies.get_all.assert_not_awaited()

    async def test_cookie_writes_cannot_use_the_default_browser_jar(self):
        browser, cdp = fixture()
        scoped = ContextBrowser(browser, SimpleNamespace(
            target=SimpleNamespace(browser_context_id='context-a')), cdp)
        cookies = [SimpleNamespace(name='fixture-cookie')]
        await scoped.cookies.set_all(cookies)
        call = cdp.storage.set_cookies.call_args
        self.assertEqual(call.args[0], cookies)
        self.assertEqual(call.kwargs.get('browser_context_id',
            call.args[1] if len(call.args) > 1 else None), 'context-a')
        browser.cookies.set_all.assert_not_awaited()

    async def test_navigation_stays_in_the_accounts_existing_context(self):
        browser, cdp = fixture()
        tab = SimpleNamespace(target=SimpleNamespace(browser_context_id='context-a'),
            get=AsyncMock())
        scoped = ContextBrowser(browser, tab, cdp)
        await scoped.get('https://chatgpt.com/')
        tab.get.assert_awaited_once_with('https://chatgpt.com/')
        browser.get.assert_not_awaited()

    async def test_stop_disposes_only_its_context_and_is_idempotent(self):
        browser, cdp = fixture()
        scoped = ContextBrowser(browser, SimpleNamespace(
            target=SimpleNamespace(browser_context_id='context-a')), cdp)
        await scoped.stop()
        await scoped.stop()
        cdp.target.dispose_browser_context.assert_called_once()
        self.assertEqual(context_argument(cdp.target.dispose_browser_context.call_args),
            'context-a')
        browser.stop.assert_not_awaited()

    async def test_missing_context_id_refuses_before_default_context_access(self):
        browser, cdp = fixture()
        for context_id in (None, ''):
            with self.subTest(context_id=context_id), self.assertRaises(ClaudeError):
                ContextBrowser(browser, SimpleNamespace(
                    target=SimpleNamespace(browser_context_id=context_id)), cdp)
        browser.connection.send.assert_not_awaited()
        browser.cookies.get_all.assert_not_awaited()
        browser.cookies.set_all.assert_not_awaited()
        browser.stop.assert_not_awaited()


class PoolGuardTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_pre_dispatch_refusals_report_no_context_to_clean(self):
        for state in ('draining', 'busy', 'duplicate'):
            browser, cdp = fixture()
            pool = Pool(browser, cdp, 'fixture-token')
            value = request()
            if state == 'draining':
                pool.draining = True
            elif state == 'busy':
                pool.active = 3
            else:
                pool.seen.add(value['request_id'])
            replies = await invoke(pool, value)
            self.assertFalse(replies[-1]['ok'])
            self.assertTrue(replies[-1]['cleanup_verified'])
            browser.connection.send.assert_not_awaited()

    async def test_disposal_receipt_distinguishes_closed_context_from_failed_cleanup(self):
        for failed in (False, True):
            browser, cdp = fixture()
            cdp.target.create_browser_context = Mock(return_value='create-context')
            cdp.target.create_target = Mock(return_value='create-target')
            tab = SimpleNamespace(target=SimpleNamespace(browser_context_id='owned-context'))
            browser._get_tab = AsyncMock(return_value=tab)
            browser.connection.send.side_effect = ['owned-context', 'owned-target',
                RuntimeError('Synthetic disposal failure') if failed else None]
            pool = Pool(browser, cdp, 'fixture-token')

            async def prepare(*_args, browser_factory, **_kwargs):
                scoped = await browser_factory()
                await scoped.stop()
                return {'metrics': {}, 'already_sent': True}

            value = request(cookies=[], headers={}, email='owner@example.test', _cleanup_verified=True)
            writer = Writer()
            with patch('claudfree.chatgpt.browser_request._prepare', side_effect=prepare):
                await pool.send(value, writer)
            result = json.loads(writer.data)
            self.assertEqual(result['cleanup_verified'], not failed)
            self.assertEqual(pool.draining, failed)
            browser.stop.assert_not_awaited()

    async def test_cancel_receipt_is_written_after_owned_cleanup(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        events = []

        async def send(value, _writer):
            try:
                await asyncio.get_running_loop().create_future()
            finally:
                await asyncio.sleep(0)
                value['_cleanup_verified'] = False
                events.append('cleanup-failed')

        pool.send = AsyncMock(side_effect=send)
        replies = await invoke(pool, request(), disconnect=True)
        self.assertEqual(events, ['cleanup-failed'])
        self.assertEqual(replies[-1], {'cleanup_verified': False})
        self.assertEqual(pool.active, 0)

    async def test_optional_readback_cannot_overflow_the_complete_ipc_frame(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        prepared = {'already_sent': True, 'server_id': str(uuid4()),
            'payload': 'x' * (MAX_FRAME - 1000),
            'confirmed_conversation': {'text': '\u4e00' * 1000}}
        value = {'ok': True, 'request': prepared,
            'cookies': [{'name': 'fixture-cookie', 'value': 'fixture-only'}]}
        writer = Writer()
        await pool.write(writer, value)
        self.assertLessEqual(len(writer.data), MAX_FRAME)
        restored = json.loads(writer.data)
        self.assertNotIn('confirmed_conversation', restored['request'])
        self.assertEqual(restored['cookies'], value['cookies'])
        self.assertEqual(restored['request'], {key: item for key, item in prepared.items()
            if key != 'confirmed_conversation'})
        self.assertIn('confirmed_conversation', prepared)

    async def test_small_readback_is_preserved_in_the_ipc_reply(self):
        browser, cdp = fixture()
        writer = Writer()
        value = {'ok': True, 'request': {'already_sent': True,
            'confirmed_conversation': {'mapping': {}}}, 'cookies': []}
        await Pool(browser, cdp, 'fixture-token').write(writer, value)
        self.assertEqual(json.loads(writer.data), value)

    async def test_idle_stop_drains_without_stopping_an_active_context(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        pool.active = 1
        replies = await invoke(pool, request(op='stop'))
        self.assertFalse(replies[-1]['ok'])
        self.assertFalse(pool.draining)
        pool.active = 0
        replies = await invoke(pool, request(op='stop'))
        self.assertTrue(replies[-1]['ok'])
        self.assertTrue(pool.draining)
        replies = await invoke(pool, request())
        self.assertFalse(replies[-1]['ok'])
        browser.stop.assert_not_awaited()

    async def test_success_returns_progress_then_result_and_releases_capacity(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        server_id = str(uuid4())
        message = request()
        saved_cookies = [{'name': 'fixture-cookie', 'value': 'fixture-only',
            'domain': '.chatgpt.com'}]

        async def send(_request, writer):
            self.assertEqual(pool.active, 1)
            await pool.write(writer, {'server_id': server_id})
            await asyncio.sleep(0)
            await pool.write(writer, {'ok': True, 'request': {
                'already_sent': True, 'server_id': server_id}, 'cookies': saved_cookies})

        pool.send = AsyncMock(side_effect=send)
        before = pool.last_used
        replies = await invoke(pool, message)
        self.assertEqual(replies[0], {'server_id': server_id})
        self.assertTrue(replies[1]['ok'])
        self.assertTrue(replies[1]['request']['already_sent'])
        self.assertEqual(replies[1]['cookies'], saved_cookies)
        self.assertEqual(pool.active, 0)
        self.assertGreaterEqual(pool.last_used, before)
        self.assertIn(message['request_id'], pool.seen)
        pool.send.assert_awaited_once()
        browser.stop.assert_not_awaited()

    async def test_disconnect_cancels_only_its_context_and_never_replays(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        scoped = ContextBrowser(browser, SimpleNamespace(
            target=SimpleNamespace(browser_context_id='disconnect-context')), cdp)
        entered = asyncio.Event()
        cancelled = asyncio.Event()

        async def send(_request, _writer):
            entered.set()
            try:
                await asyncio.get_running_loop().create_future()
            except asyncio.CancelledError:
                cancelled.set()
                raise
            finally:
                await scoped.stop()

        pool.send = AsyncMock(side_effect=send)
        message = request()
        before = pool.last_used
        await invoke(pool, message, disconnect=True)
        self.assertTrue(entered.is_set())
        self.assertTrue(cancelled.is_set())
        self.assertEqual(pool.active, 0)
        self.assertGreaterEqual(pool.last_used, before)
        self.assertIn(message['request_id'], pool.seen)
        cdp.target.dispose_browser_context.assert_called_once()
        self.assertEqual(context_argument(cdp.target.dispose_browser_context.call_args),
            'disconnect-context')
        browser.stop.assert_not_awaited()
        replies = await invoke(pool, message)
        self.assertFalse(replies[-1]['ok'])
        pool.send.assert_awaited_once()

    async def test_ping_does_not_create_an_account_context(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        replies = await invoke(pool, request(op='ping'))
        self.assertTrue(replies[-1]['ok'])
        self.assertIsInstance(replies[-1]['pid'], int)
        browser.create_context.assert_not_awaited()
        browser.stop.assert_not_awaited()

    async def test_unauthenticated_request_is_refused_before_account_work(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        request_id = str(uuid4())
        for token in ('wrong-token', ''):
            with self.subTest(token=token):
                replies = await invoke(pool, request(token, request_id=request_id))
                self.assertFalse(replies[-1]['ok'])
        self.assertEqual(pool.active, 0)
        self.assertNotIn(request_id, pool.seen)
        browser.create_context.assert_not_awaited()
        browser.stop.assert_not_awaited()

    async def test_fourth_request_is_refused_without_dispatch_or_affecting_others(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        pool.active = 3
        replies = await invoke(pool, request())
        self.assertFalse(replies[-1]['ok'])
        self.assertEqual(replies[-1]['error']['code'], 'browser_busy')
        self.assertEqual(pool.active, 3)
        browser.create_context.assert_not_awaited()
        cdp.target.dispose_browser_context.assert_not_called()
        browser.stop.assert_not_awaited()

    async def test_seen_request_is_never_dispatched_again(self):
        browser, cdp = fixture()
        pool = Pool(browser, cdp, 'fixture-token')
        request_id = str(uuid4())
        pool.seen.add(request_id)
        replies = await invoke(pool, request(request_id=request_id))
        self.assertFalse(replies[-1]['ok'])
        self.assertEqual(pool.active, 0)
        self.assertIn(request_id, pool.seen)
        browser.create_context.assert_not_awaited()
        browser.stop.assert_not_awaited()


def ping(port, token):
    with socket.create_connection(('127.0.0.1', port), timeout=5) as connection:
        connection.sendall((json.dumps({'op': 'ping', 'token': token}) + '\n').encode())
        with connection.makefile('rb') as stream:
            return json.loads(stream.readline())


@unittest.skipUnless(sys.platform == 'win32', "the proactor transport that can fail to detach a connection is Windows'")
class IdleExitTests(unittest.IsolatedAsyncioTestCase):
    async def test_idle_exit_frees_endpoint_and_owner_lock_when_a_connection_never_detaches(self):
        # 2026-10-17: two live brokers sat in Server.wait_closed() for hours, each with served
        # connections whose shutdown() had raised, so CPython never detached them. Their owner lock
        # and dead endpoint.json stopped every new broker, and every ChatGPT send failed at 25 s.
        browser = SimpleNamespace(stopped=False, stop=AsyncMock())
        zendriver = SimpleNamespace(start=AsyncMock(return_value=browser), cdp=SimpleNamespace())
        served_port = None
        real_shutdown = socket.socket.shutdown

        def shutdown(sock, how):
            if served_port is not None and sock.getsockname()[1] == served_port:
                raise OSError(10057, 'The socket is not connected')
            return real_shutdown(sock, how)

        with tempfile.TemporaryDirectory() as folder:
            directory = Path(folder)
            endpoint = directory / 'endpoint.json'
            with patch.dict(sys.modules, {'zendriver': zendriver}), patch.object(socket.socket, 'shutdown', shutdown):
                served = asyncio.create_task(serve(directory, 'fixture-version', idle_seconds=2))
                for _ in range(200):
                    if endpoint.exists() or served.done():
                        break
                    await asyncio.sleep(0.05)
                info = json.loads(endpoint.read_text(encoding='utf-8'))
                served_port = info['port']
                self.assertTrue((await asyncio.to_thread(ping, served_port, info['token']))['ok'])
                try:
                    await asyncio.wait_for(asyncio.shield(served), 15)
                except TimeoutError:
                    served.cancel()
                    await asyncio.gather(served, return_exceptions=True)
                    self.fail('The idle broker never exited, so its owner lock and endpoint stayed taken.')
            self.assertFalse(endpoint.exists())
            with chat_lock(directory, 'owner'):
                pass
            browser.stop.assert_awaited_once()


if __name__ == '__main__':
    unittest.main()
