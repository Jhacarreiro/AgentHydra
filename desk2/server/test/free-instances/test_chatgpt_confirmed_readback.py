"""No-network checks for bounded, branch-verified browser readback reuse."""

from contextlib import ExitStack
from copy import deepcopy
import json
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from claudfree.chatgpt import browser_request
from claudfree.chatgpt.http import (
    CONFIRMED_CONVERSATION_MAX_BYTES,
    ChatGPTHttp,
    TEXT_MODEL,
    bounded_confirmed_conversation,
)
from claudfree.errors import ClaudeError


PROMPT = 'Example prompt'


def fixture():
    conversation, root, user, reply = [str(uuid4()) for _ in range(4)]
    payload = {'action': 'next', 'messages': [{'id': user, 'author': {'role': 'user'},
        'content': {'content_type': 'text', 'parts': [PROMPT]}}],
        'parent_message_id': root, 'model': TEXT_MODEL,
        'history_and_training_disabled': True,
        'temporary_chat_requests_personalization': False}
    body = {'conversation_id': conversation, 'current_node': reply,
        'is_temporary_chat': True, 'mapping': {
            root: {'parent': None, 'message': None},
            user: {'parent': root, 'message': deepcopy(payload['messages'][0])},
            reply: {'parent': user, 'message': {'id': reply,
                'author': {'role': 'assistant'},
                'content': {'content_type': 'text', 'parts': ['Example reply']},
                'status': 'finished_successfully'}},
        }}
    return payload, body


def prepared(payload, body, *, snapshot=True):
    value = {'payload': payload, 'headers': {}, 'already_sent': True,
        'server_id': body['conversation_id']}
    if snapshot:
        value['confirmed_conversation'] = body
    return value


def client(body):
    http = ChatGPTHttp({'cookies': []})
    http._request = Mock(side_effect=AssertionError('A completed send must not POST again'))
    http.read = Mock(return_value=body)
    return http


class ConfirmedReadbackTests(unittest.TestCase):
    def test_completed_snapshot_reuses_actual_reply_without_another_get_or_post(self):
        payload, body = fixture()
        http = client(body)
        try:
            result = http.send(PROMPT, prepared_request=prepared(payload, body))
            self.assertIs(result[0], body)
            self.assertEqual(result[2]['text'], 'Example reply')
            self.assertTrue(result[3])
            http.read.assert_not_called()
            http._request.assert_not_called()
        finally:
            http.close()

    def test_absent_snapshot_keeps_one_authenticated_read_and_no_second_post(self):
        payload, body = fixture()
        http = client(body)
        try:
            result = http.send(PROMPT, prepared_request=prepared(payload, body, snapshot=False))
            self.assertEqual(result[2]['text'], 'Example reply')
            http.read.assert_called_once_with(body['conversation_id'])
            http._request.assert_not_called()
        finally:
            http.close()

    def test_wrong_identity_privacy_message_and_incomplete_evidence_is_refused(self):
        payload, original = fixture()
        user = payload['messages'][0]['id']
        reply = original['current_node']
        bad = []
        for field, value in [('conversation_id', str(uuid4())),
                             ('is_temporary_chat', False), ('mapping', [])]:
            body = deepcopy(original)
            body[field] = value
            bad.append(body)
        body = deepcopy(original)
        body['mapping'][user]['message']['content']['parts'] = ['Another prompt']
        bad.append(body)
        body = deepcopy(original)
        body['mapping'][user]['message']['id'] = str(uuid4())
        bad.append(body)
        body = deepcopy(original)
        body['mapping'][reply]['message']['status'] = 'in_progress'
        bad.append(body)
        body = deepcopy(original)
        body['mapping'][reply]['message']['id'] = None
        bad.append(body)
        body = deepcopy(original)
        body['mapping'][reply]['message']['id'] = user
        bad.append(body)
        body = deepcopy(original)
        body['mapping'][reply]['parent'] = reply
        bad.append(body)
        bad.extend([[], 'invalid snapshot'])
        for snapshot in bad:
            with self.subTest(snapshot=snapshot):
                http = client(original)
                try:
                    value = prepared(payload, original)
                    value['confirmed_conversation'] = snapshot
                    with self.assertRaises(ClaudeError):
                        http.send(PROMPT, prepared_request=value)
                    http.read.assert_not_called()
                    http._request.assert_not_called()
                finally:
                    http.close()

    def test_reply_on_an_unselected_sibling_branch_cannot_confirm_the_send(self):
        payload, body = fixture()
        sibling_user, sibling_reply = str(uuid4()), str(uuid4())
        root = payload['parent_message_id']
        body['mapping'][sibling_user] = {'parent': root, 'message': {
            'id': sibling_user, 'author': {'role': 'user'},
            'content': {'content_type': 'text', 'parts': ['Other request']}}}
        body['mapping'][sibling_reply] = {'parent': sibling_user, 'message': {
            'id': sibling_reply, 'author': {'role': 'assistant'},
            'content': {'content_type': 'text', 'parts': ['Other reply']},
            'status': 'finished_successfully'}}
        body['current_node'] = sibling_reply
        http = client(body)
        try:
            with self.assertRaises(ClaudeError):
                http.send(PROMPT, prepared_request=prepared(payload, body))
            http.read.assert_not_called()
            http._request.assert_not_called()
        finally:
            http.close()

    def test_a_later_users_reply_does_not_complete_this_incomplete_turn(self):
        payload, body = fixture()
        prior = body['current_node']
        body['mapping'][prior]['message']['status'] = 'in_progress'
        later_user, later_reply = str(uuid4()), str(uuid4())
        body['mapping'][later_user] = {'parent': prior, 'message': {
            'id': later_user, 'author': {'role': 'user'},
            'content': {'content_type': 'text', 'parts': ['Later request']}}}
        body['mapping'][later_reply] = {'parent': later_user, 'message': {
            'id': later_reply, 'author': {'role': 'assistant'},
            'content': {'content_type': 'text', 'parts': ['Later reply']},
            'status': 'finished_successfully'}}
        body['current_node'] = later_reply
        http = client(body)
        try:
            with self.assertRaises(ClaudeError):
                http.send(PROMPT, prepared_request=prepared(payload, body))
            http.read.assert_not_called()
            http._request.assert_not_called()
        finally:
            http.close()

    def test_continuation_requires_a_fresh_reply_after_its_own_captured_message(self):
        payload, body = fixture()
        root = payload['parent_message_id']
        old_user = str(uuid4())
        old_reply = {'id': root, 'author': {'role': 'assistant'},
            'content': {'content_type': 'text', 'parts': ['Previous reply']},
            'status': 'finished_successfully'}
        old_question = {'id': old_user, 'author': {'role': 'user'},
            'content': {'content_type': 'text', 'parts': ['Previous question']}}
        body['mapping'][old_user] = {'parent': None, 'message': old_question}
        body['mapping'][root] = {'parent': old_user, 'message': old_reply}
        existing = deepcopy(body)
        existing['current_node'] = root
        payload['conversation_id'] = body['conversation_id']
        http = client(body)
        try:
            result = http.send(PROMPT, existing=existing, prepared_request=prepared(payload, body))
            self.assertEqual(result[2]['text'], 'Example reply')
            http.read.assert_not_called()
            body['mapping'][body['current_node']]['message']['id'] = root
            with self.assertRaises(ClaudeError):
                http.send(PROMPT, existing=existing, prepared_request=prepared(payload, body))
            http._request.assert_not_called()
        finally:
            http.close()

    def test_snapshot_limit_is_exact_utf8_json_bytes(self):
        _, body = fixture()
        body['padding'] = ''
        size = len(json.dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        body['padding'] = 'x' * (CONFIRMED_CONVERSATION_MAX_BYTES - size)
        self.assertIs(bounded_confirmed_conversation(body), body)
        body['padding'] += 'x'
        self.assertIsNone(bounded_confirmed_conversation(body))
        body['padding'] = '\u00e9' * (CONFIRMED_CONVERSATION_MAX_BYTES // 2)
        self.assertIsNone(bounded_confirmed_conversation(body))

    def test_obviously_oversized_valid_strings_skip_serialization_and_fragment_copies(self):
        bodies = [
            {'mapping': {'node': {'metadata': {'large': 'x' * (CONFIRMED_CONVERSATION_MAX_BYTES + 1)}}}},
            {'mapping': {'parts': ['x' * 8192 for _ in range(128)]}},
            {'mapping': {'parts': ('x' * (CONFIRMED_CONVERSATION_MAX_BYTES + 1),)}},
        ]
        for body in bodies:
            with self.subTest(shape=type(body['mapping']).__name__), \
                    patch('claudfree.chatgpt.http.json.dumps',
                        side_effect=AssertionError('A proven oversized snapshot must not serialize')):
                self.assertIsNone(bounded_confirmed_conversation(body))

    def test_exact_unicode_cap_and_escaping_still_use_the_original_encoder(self):
        padding = {'padding': ''}
        overhead = len(json.dumps(padding, ensure_ascii=False, separators=(',', ':')).encode('utf-8'))
        remaining = CONFIRMED_CONVERSATION_MAX_BYTES - overhead
        bodies = [
            {'padding': '\u00e9' * (remaining // 2) + 'x' * (remaining % 2)},
            {'padding': '\u754c' * (remaining // 3) + 'x' * (remaining % 3)},
            {'padding': '\U0001f642' * (remaining // 4) + 'x' * (remaining % 4)},
            {'padding': '\x00' * (remaining // 6) + 'x' * (remaining % 6)},
        ]
        dumps = json.dumps
        for body in bodies:
            with self.subTest(character=body['padding'][0]), \
                    patch('claudfree.chatgpt.http.json.dumps', wraps=dumps) as encode:
                self.assertEqual(len(dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')),
                    CONFIRMED_CONVERSATION_MAX_BYTES)
                self.assertIs(bounded_confirmed_conversation(body), body)
                encode.assert_called_once_with(body, ensure_ascii=False, separators=(',', ':'), allow_nan=False)
            body['padding'] += 'x'
            self.assertIsNone(bounded_confirmed_conversation(body))

    def test_bounded_inspection_preserves_wide_nested_shared_and_invalid_json_cases(self):
        nested = {'value': 'small'}
        for _ in range(60):
            nested = {'nested': nested}
        shared = ['shared text']
        accepted = [nested, {'parts': [0] * 100_000}, {'parts': [shared] * 3000}]
        invalid = [
            {'text': '\ud800'},
            {'text': '\udc00'},
            {'text': '\ud83d\ude42'},
            {'number': float('nan')},
            {'number': float('inf')},
            {'unsupported': object()},
            {'unsupported': {1, 2}},
        ]
        cyclic = {}
        cyclic['cycle'] = cyclic
        invalid.append(cyclic)
        dumps = json.dumps
        for body in accepted:
            with self.subTest(kind='accepted'), patch('claudfree.chatgpt.http.json.dumps', wraps=dumps) as encode:
                self.assertIs(bounded_confirmed_conversation(body), body)
                encode.assert_called_once()
        for body in invalid:
            with self.subTest(kind='invalid'), patch('claudfree.chatgpt.http.json.dumps', wraps=dumps) as encode:
                self.assertIsNone(bounded_confirmed_conversation(body))
                encode.assert_called_once()
        # A large later string lies beyond the inspection allowance. It still
        # receives the exact ordinary check, rather than widening admission.
        wide = {'parts': [0] * 2048 + ['x' * CONFIRMED_CONVERSATION_MAX_BYTES]}
        with patch('claudfree.chatgpt.http.json.dumps', wraps=dumps) as encode:
            self.assertIsNone(bounded_confirmed_conversation(wide))
            encode.assert_called_once()

    def test_custom_builtin_subclasses_cannot_supply_false_lower_bounds(self):
        class LongString(str):
            def __len__(self):
                return CONFIRMED_CONVERSATION_MAX_BYTES + 1

        class LongList(list):
            def __len__(self):
                return CONFIRMED_CONVERSATION_MAX_BYTES + 1

        class LongDict(dict):
            def __len__(self):
                return CONFIRMED_CONVERSATION_MAX_BYTES + 1

        class SmallTuple(tuple):
            def __len__(self):
                return CONFIRMED_CONVERSATION_MAX_BYTES + 1

        bodies = [{'value': LongString('small')}, {'value': LongList(['small'])},
            LongDict(value='small'), {'value': SmallTuple(('small',))}]
        dumps = json.dumps
        for body in bodies:
            with self.subTest(kind=type(body).__name__), \
                    patch('claudfree.chatgpt.http.json.dumps', wraps=dumps) as encode:
                self.assertLess(len(dumps(body, ensure_ascii=False, separators=(',', ':')).encode('utf-8')),
                    CONFIRMED_CONVERSATION_MAX_BYTES)
                self.assertIs(bounded_confirmed_conversation(body), body)
                encode.assert_called_once()

    def test_oversized_snapshot_retains_normal_read_fallback(self):
        payload, body = fixture()
        snapshot = deepcopy(body)
        snapshot['padding'] = 'x' * CONFIRMED_CONVERSATION_MAX_BYTES
        http = client(body)
        try:
            value = prepared(payload, body)
            value['confirmed_conversation'] = snapshot
            result = http.send(PROMPT, prepared_request=value)
            self.assertIs(result[0], body)
            http.read.assert_called_once_with(body['conversation_id'])
            http._request.assert_not_called()
        finally:
            http.close()


class BrowserConfirmationTests(unittest.IsolatedAsyncioTestCase):
    async def test_known_continuation_never_evaluates_the_page_path(self):
        payload, body = fixture()
        tab = SimpleNamespace(evaluate=AsyncMock(side_effect=AssertionError('Known ID needs no URL read')))
        existing = {'conversation_id': body['conversation_id']}
        self.assertEqual(await browser_request._conversation_candidate(tab, existing), body['conversation_id'])
        completed = AsyncMock(side_effect=[False, False, True])
        http = SimpleNamespace(timeout=1)
        export = AsyncMock(return_value=[])
        on_id = Mock()
        with patch.object(browser_request, '_own_message_completed', completed), \
                patch.object(browser_request.signin, 'export_cookies', export), \
                patch.object(browser_request, 'adopt_cookies'), \
                patch.object(browser_request.asyncio, 'sleep', AsyncMock()) as sleep:
            result = await browser_request._await_confirmation(http, tab, object(),
                {'status': None}, payload, PROMPT, existing, True, on_id)
        self.assertEqual(result, body['conversation_id'])
        tab.evaluate.assert_not_awaited()
        on_id.assert_called_once_with(body['conversation_id'])
        self.assertEqual(export.await_count, 3)
        self.assertEqual([call.args for call in sleep.await_args_list], [(.3,), (.3,)])

    async def test_new_chat_stops_evaluating_the_path_once_its_id_is_found(self):
        payload, body = fixture()
        tab = SimpleNamespace(evaluate=AsyncMock(return_value='/c/' + body['conversation_id']))
        with patch.object(browser_request, '_own_message_completed', AsyncMock(side_effect=[False, False, True])), \
                patch.object(browser_request.signin, 'export_cookies', AsyncMock(return_value=[])), \
                patch.object(browser_request, 'adopt_cookies'), \
                patch.object(browser_request.asyncio, 'sleep', AsyncMock()):
            result = await browser_request._await_confirmation(SimpleNamespace(timeout=1),
                tab, object(), {'status': None}, payload, PROMPT, None, True, None)
        self.assertEqual(result, body['conversation_id'])
        tab.evaluate.assert_awaited_once_with('location.pathname')

    async def test_confirmed_readback_keeps_internal_boolean_return_compatibility(self):
        payload, body = fixture()
        http = SimpleNamespace(_json=Mock(return_value=body))
        confirmed = {}
        result = await browser_request._own_message_completed(http, body['conversation_id'],
            payload['messages'][0]['id'], PROMPT, True, confirmed)
        self.assertIs(result, True)
        self.assertIs(confirmed['body'], body)
        http._json.assert_called_once_with('GET', '/backend-api/conversation/' + body['conversation_id'])

    async def test_prepare_omits_oversized_snapshot_without_changing_send_result(self):
        payload, body = fixture()
        body['padding'] = 'x' * CONFIRMED_CONVERSATION_MAX_BYTES
        browser = SimpleNamespace(get=AsyncMock(return_value=object()))
        http = SimpleNamespace(saved_state=Mock(return_value={'cookies': []}))

        async def arm(_tab, _zd, **options):
            options['dispatch']['sent'] = True

        async def confirm(_http, _tab, _browser, _dispatch, _payload, _prompt,
                          _existing, _temporary, _on_id, confirmed):
            confirmed['body'] = body
            return body['conversation_id']

        with ExitStack() as stack:
            stack.enter_context(patch.dict('sys.modules', {'zendriver': SimpleNamespace()}))
            for name in ('_wait_for_composer', '_select_temporary_chat', '_submit_prompt',
                         '_adopt_captured_session', '_close_browser'):
                stack.enter_context(patch.object(browser_request, name, AsyncMock()))
            stack.enter_context(patch.object(browser_request.signin, 'load_cookies', AsyncMock()))
            stack.enter_context(patch.object(browser_request, '_arm_interception', AsyncMock(side_effect=arm)))
            stack.enter_context(patch.object(browser_request, '_await_capture', AsyncMock(return_value=(payload, {}))))
            stack.enter_context(patch.object(browser_request, '_await_confirmation', AsyncMock(side_effect=confirm)))
            result = await browser_request._prepare(http, PROMPT, None, directory=Path('.'),
                model=TEXT_MODEL, temporary=True, on_id=None, browser_factory=AsyncMock(return_value=browser))
        self.assertTrue(result['already_sent'])
        self.assertEqual(result['server_id'], body['conversation_id'])
        self.assertNotIn('confirmed_conversation', result)


if __name__ == '__main__':
    unittest.main()
