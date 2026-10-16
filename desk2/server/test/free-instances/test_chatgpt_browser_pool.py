"""No-network checks for shared-browser isolation and single-dispatch guards."""

import asyncio
import json
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock
from uuid import uuid4

from claudfree.chatgpt.browser_pool import ContextBrowser, Pool
from claudfree.errors import ClaudeError


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


if __name__ == '__main__':
    unittest.main()
