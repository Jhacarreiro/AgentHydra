"""Actual Zendriver event dispatch stays on-loop without browser/network work."""

import asyncio
import base64
from collections import defaultdict
import inspect
import json
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

import zendriver as zd
from zendriver.core.connection import Listener

from claudfree.chatgpt import browser_request
from claudfree.chatgpt.http import TEXT_MODEL
from claudfree.errors import ClaudeError


PROMPT = 'Synthetic requested message'


def response(request_id, status):
    return {'method': 'Network.responseReceived', 'params': {
        'requestId': request_id, 'loaderId': 'synthetic-loader', 'timestamp': 1,
        'type': 'XHR', 'hasExtraInfo': False, 'response': {
            'url': 'https://example.test/synthetic-response', 'status': status,
            'statusText': 'Synthetic status', 'headers': {}, 'mimeType': 'application/json',
            'charset': 'utf-8', 'connectionReused': False, 'connectionId': 0,
            'encodedDataLength': 0, 'securityState': 'unknown',
        }}}


class Tab:
    def __init__(self):
        self.handlers = defaultdict(list)
        self.commands = []

    async def send(self, command):
        # Consume CDP commands locally; no websocket or browser exists.
        self.commands.append(next(command))

    def add_handler(self, event, callback):
        self.handlers[event].append(callback)


async def armed(dispatch=None, page_private=True):
    tab = Tab()
    captured = asyncio.get_running_loop().create_future()
    dispatch = dispatch if dispatch is not None else {'network_id': None, 'status': None, 'sent': False}
    await browser_request._arm_interception(tab, zd, captured=captured, dispatch=dispatch,
        prompt=PROMPT, model=TEXT_MODEL, existing=None, temporary=True, page_private=page_private)
    return tab, captured, dispatch


class NetworkResponseDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def test_response_handler_is_async_and_interception_scope_stays_exact(self):
        tab, captured, _ = await armed()
        try:
            handler = tab.handlers[zd.cdp.network.ResponseReceived][0]
            self.assertTrue(inspect.iscoroutinefunction(handler))
            self.assertEqual([command['method'] for command in tab.commands],
                ['Network.enable', 'Fetch.enable'])
            self.assertEqual(tab.commands[1]['params']['patterns'], [{
                'urlPattern': 'https://chatgpt.com/backend-api/f/conversation*',
                'requestStage': 'Request'}])
        finally:
            captured.cancel()

    async def test_actual_zendriver_dispatch_handles_1003_responses_without_executor_hops(self):
        completed = asyncio.Event()
        observed = []
        expected_thread = threading.get_ident()

        class Dispatch(dict):
            def __setitem__(self, key, value):
                super().__setitem__(key, value)
                if key == 'status':
                    observed.append((value, threading.get_ident()))
                    if value == 429:
                        completed.set()

        dispatch = Dispatch(network_id='synthetic-target', status=None, sent=True)
        tab, captured, _ = await armed(dispatch)
        queue = asyncio.Queue()
        for index in range(1000):
            queue.put_nowait(response(f'synthetic-other-{index}', 401))
        for status in (200, 503, 429):
            queue.put_nowait(response('synthetic-target', status))
        connection = SimpleNamespace(_receive_message=queue.get, handlers=tab.handlers,
            mapper={}, _sessions={}, _fail_pending_transactions=Mock())
        # Listener is Zendriver's installed dispatcher, not a copied dispatch model.
        listener = None
        with patch('asyncio.to_thread', side_effect=AssertionError('No response executor hop')) as executor:
            try:
                listener = Listener(connection)
                await asyncio.wait_for(completed.wait(), 5)
                self.assertEqual(observed, [(200, expected_thread), (503, expected_thread), (429, expected_thread)])
                self.assertEqual(dispatch['status'], 429)
                self.assertTrue(queue.empty())
                executor.assert_not_called()
            finally:
                if listener:
                    listener.cancel()
                    await asyncio.gather(listener.task, return_exceptions=True)
                captured.cancel()

    async def test_registered_pause_dispatches_one_message_and_blocks_a_second_request(self):
        tab, captured, dispatch = await armed()
        payload = {'action': 'next', 'messages': [{'id': str(uuid4()),
            'author': {'role': 'user'}, 'content': {'content_type': 'text', 'parts': [PROMPT]}}],
            'parent_message_id': str(uuid4()), 'model': 'synthetic-website-default',
            'history_and_training_disabled': True}
        request = SimpleNamespace(url='https://chatgpt.com/backend-api/f/conversation',
            method='POST', post_data=json.dumps(payload), headers={'Authorization': 'Bearer synthetic-only'})
        event = SimpleNamespace(request=request, request_id=zd.cdp.fetch.RequestId('synthetic-first'),
            network_id=zd.cdp.network.RequestId('synthetic-network'))
        handler = tab.handlers[zd.cdp.fetch.RequestPaused][0]
        await handler(event)
        prepared, headers = await captured
        event.request_id = zd.cdp.fetch.RequestId('synthetic-second')
        await handler(event)
        actions = tab.commands[2:]
        self.assertEqual([command['method'] for command in actions],
            ['Fetch.continueRequest', 'Fetch.failRequest'])
        sent = json.loads(base64.b64decode(actions[0]['params']['postData']))
        self.assertEqual(sent['messages'][0]['content']['parts'], [PROMPT])
        self.assertEqual(sent['model'], TEXT_MODEL)
        self.assertIs(sent['history_and_training_disabled'], True)
        self.assertIs(sent['temporary_chat_requests_personalization'], False)
        self.assertEqual(sent, prepared)
        self.assertEqual(headers, {'Authorization': 'Bearer synthetic-only'})
        self.assertEqual(actions[1]['params']['errorReason'], 'BlockedByClient')
        self.assertTrue(dispatch['sent'])
        self.assertEqual(dispatch['network_id'], 'synthetic-network')

    async def test_registered_pause_sends_the_exact_prompt_privately_whatever_the_website_typed(self):
        # The website's composer may change the typed text, or its body may not carry the private flag while the page
        # shows Temporary Chat on; the body that goes out carries the prompt and the private flag either way, once the
        # page or the website's own body showed the chat private. The post-send readback still checks both.
        for page_private, private, text in [(True, False, PROMPT), (True, True, 'Synthetic other message'),
                                            (False, True, PROMPT)]:
            with self.subTest(page_private=page_private, private=private, text=text):
                tab, captured, dispatch = await armed(page_private=page_private)
                payload = {'action': 'next', 'messages': [{'id': str(uuid4()),
                    'author': {'role': 'user'}, 'content': {'content_type': 'text', 'parts': [text]}}],
                    'parent_message_id': str(uuid4()), 'model': TEXT_MODEL,
                    'history_and_training_disabled': private}
                event = SimpleNamespace(request=SimpleNamespace(
                    url='https://chatgpt.com/backend-api/f/conversation', method='POST',
                    post_data=json.dumps(payload), headers={'Authorization': 'Bearer synthetic-only'}),
                    request_id=zd.cdp.fetch.RequestId('synthetic-accepted'),
                    network_id=zd.cdp.network.RequestId('synthetic-network'))
                await tab.handlers[zd.cdp.fetch.RequestPaused][0](event)
                prepared, _headers = await captured
                actions = tab.commands[2:]
                self.assertEqual([command['method'] for command in actions], ['Fetch.continueRequest'])
                sent = json.loads(base64.b64decode(actions[0]['params']['postData']))
                self.assertEqual(sent['messages'][0]['content']['parts'], [PROMPT])
                self.assertIs(sent['history_and_training_disabled'], True)
                self.assertEqual(sent, prepared)
                self.assertTrue(dispatch['sent'])

    async def test_registered_pause_refuses_a_chat_nothing_showed_private(self):
        # Neither the page (Temporary Chat never read on) nor the website's body says the chat is private: the flag is
        # not forced onto it, and nothing is sent.
        tab, captured, dispatch = await armed(page_private=False)
        payload = {'action': 'next', 'messages': [{'id': str(uuid4()),
            'author': {'role': 'user'}, 'content': {'content_type': 'text', 'parts': [PROMPT]}}],
            'parent_message_id': str(uuid4()), 'model': TEXT_MODEL, 'history_and_training_disabled': False}
        event = SimpleNamespace(request=SimpleNamespace(
            url='https://chatgpt.com/backend-api/f/conversation', method='POST',
            post_data=json.dumps(payload), headers={'Authorization': 'Bearer synthetic-only'}),
            request_id=zd.cdp.fetch.RequestId('synthetic-unverified'),
            network_id=zd.cdp.network.RequestId('synthetic-network'))
        await tab.handlers[zd.cdp.fetch.RequestPaused][0](event)
        with self.assertRaises(ClaudeError) as error:
            await captured
        self.assertEqual(error.exception.code, 'privacy_not_verified')
        self.assertIn('No message was sent.', str(error.exception))
        self.assertNotIn(PROMPT, str(error.exception))
        self.assertEqual([command['method'] for command in tab.commands[2:]], ['Fetch.failRequest'])
        self.assertFalse(dispatch['sent'])

    async def test_registered_pause_refuses_a_misshapen_request_before_dispatch(self):
        one = {'id': str(uuid4()), 'author': {'role': 'user'}, 'content': {'content_type': 'text', 'parts': [PROMPT]}}
        for name, action, messages in [('two messages', 'next', [one, dict(one, id=str(uuid4()))]),
                                       ('wrong action', 'variant', [one])]:
            with self.subTest(name):
                tab, captured, dispatch = await armed()
                payload = {'action': action, 'messages': messages, 'parent_message_id': str(uuid4()),
                    'model': TEXT_MODEL, 'history_and_training_disabled': True}
                event = SimpleNamespace(request=SimpleNamespace(
                    url='https://chatgpt.com/backend-api/f/conversation', method='POST',
                    post_data=json.dumps(payload), headers={'Authorization': 'Bearer synthetic-only'}),
                    request_id=zd.cdp.fetch.RequestId('synthetic-refused'),
                    network_id=zd.cdp.network.RequestId('synthetic-network'))
                await tab.handlers[zd.cdp.fetch.RequestPaused][0](event)
                with self.assertRaises(ClaudeError) as error:
                    await captured
                self.assertEqual(error.exception.code, 'browser_preparation_invalid')
                self.assertIn('No message was sent.', str(error.exception))
                self.assertNotIn(PROMPT, str(error.exception))
                self.assertEqual([command['method'] for command in tab.commands[2:]], ['Fetch.failRequest'])
                self.assertFalse(dispatch['sent'])
                self.assertIsNone(dispatch['network_id'])


if __name__ == '__main__':
    unittest.main()
