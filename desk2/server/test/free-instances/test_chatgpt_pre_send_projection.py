"""Pre-send identity/model reads skip display extraction; final replies remain rich."""

from copy import deepcopy
import unittest
from unittest.mock import Mock, call, patch
from uuid import uuid4

from claudfree.chatgpt import http
from claudfree.errors import ClaudeError


PROMPT = 'Synthetic continuation \u4e16\u754c'
MODEL = 'gpt-6'


def message(identity, role, text, *, model=None):
    return {'id': identity, 'author': {'role': role},
        'content': {'content_type': 'text', 'parts': [text]},
        'metadata': {'model_slug': model} if model else {},
        'status': 'finished_successfully'}


def fixture():
    conversation, old_user, old_reply, user, reply = [str(uuid4()) for _ in range(5)]
    original = {'conversation_id': conversation, 'is_temporary_chat': True,
        'current_node': old_reply, 'mapping': {
            old_user: {'parent': None, 'message': message(old_user, 'user', 'Synthetic first request')},
            old_reply: {'parent': old_user, 'message': message(old_reply, 'assistant',
                'Synthetic historical reply\n```text\nHistorical code\n```\n', model=MODEL)},
        }}
    payload = {'action': 'next', 'messages': [message(user, 'user', PROMPT)],
        'conversation_id': conversation, 'parent_message_id': old_reply,
        'model': MODEL, 'history_and_training_disabled': True}
    completed = deepcopy(original)
    completed['current_node'] = reply
    completed['mapping'][user] = {'parent': old_reply, 'message': deepcopy(payload['messages'][0])}
    completed['mapping'][reply] = {'parent': user, 'message': message(reply, 'assistant',
        'Synthetic reply \u00e9\n\ue200url\ue202Example source\ue202https://example.test/source\ue201\n'
        '```python\nexample_value = 1\n```\n', model=MODEL)}
    completed['mapping'][reply]['message']['metadata']['citations'] = [
        {'title': 'Example citation', 'url': 'https://example.test/citation'}]
    prepared = {'payload': payload, 'headers': {}, 'already_sent': True,
        'server_id': conversation, 'confirmed_conversation': completed}
    return original, completed, prepared, old_user, old_reply, user, reply


def client(body):
    # These tests exercise send itself without constructing a network session.
    result = object.__new__(http.ChatGPTHttp)
    result.preparations = None
    result._request = Mock()
    result.read = Mock(return_value=body)
    return result


class PreSendProjectionTests(unittest.TestCase):
    def test_thread_model_preserves_visible_model_selection_without_display_extraction(self):
        original, _, _, _, old_reply, _, _ = fixture()
        variants = [({}, MODEL), ({'metadata': {'resolved_model_slug': MODEL}}, MODEL),
            ({'metadata': {'model_slug': 'unsupported-model'}}, http.TEXT_MODEL),
            ({'metadata': {}}, http.TEXT_MODEL),
            ({'metadata': {'model_slug': 'gpt-other', 'is_visually_hidden_from_conversation': True}}, http.TEXT_MODEL),
            ({'channel': 'analysis'}, http.TEXT_MODEL),
            ({'recipient': 'synthetic_tool'}, http.TEXT_MODEL),
            ({'content': {'content_type': 'text', 'parts': []}}, http.TEXT_MODEL)]
        for changes, expected in variants:
            body = deepcopy(original)
            body['mapping'][old_reply]['message'].update(changes)
            with self.subTest(changes=changes), \
                    patch.object(http, 'code_blocks', side_effect=AssertionError('No pre-send code extraction')), \
                    patch.object(http, '_citations', side_effect=AssertionError('No pre-send citation extraction')):
                self.assertEqual(http.thread_model(body), expected)

    def test_browser_completed_continuation_keeps_exact_previous_ids_and_final_rich_reply(self):
        original, completed, prepared, old_user, old_reply, _, _ = fixture()
        expected = http.visible_messages(completed)
        transport = client(completed)
        transport._request.side_effect = AssertionError('A completed message must never POST again')
        transport.read.side_effect = AssertionError('The confirmed readback needs no second GET')
        with patch.object(http, 'visible_messages', wraps=http.visible_messages) as projection, \
                patch.object(http, 'confirmed_reply', wraps=http.confirmed_reply) as confirmation, \
                patch.object(http, 'code_blocks', wraps=http.code_blocks) as code, \
                patch.object(http, '_citations', wraps=http._citations) as citations:
            selected = http.thread_model(original)
            body, messages, reply, complete = transport.send(PROMPT, existing=original,
                model=selected, prepared_request=prepared)
        self.assertEqual(projection.call_args_list, [call(original, rich=False),
            call(original, rich=False), call(completed)])
        self.assertEqual(confirmation.call_args.args[-1], {old_user, old_reply})
        self.assertEqual(code.call_count, len(expected))
        self.assertEqual(citations.call_count, len(expected))
        self.assertIs(body, completed)
        self.assertEqual(messages, expected)
        self.assertIs(reply, messages[-1])
        self.assertEqual(reply['model'], MODEL)
        self.assertEqual(reply['code_blocks'], [{'language': 'python', 'code': 'example_value = 1\n'}])
        self.assertIn('[Example source](https://example.test/source)', reply['text'])
        self.assertEqual(reply['citations'][0], {'title': 'Example citation', 'url': 'https://example.test/citation'})
        self.assertIn('content', reply)
        self.assertIn('tool_calls', reply)
        self.assertIn('tool_results', reply)
        self.assertTrue(complete)
        transport._request.assert_not_called()
        transport.read.assert_not_called()

    def test_ordinary_continuation_posts_once_and_only_extracts_display_fields_after_dispatch(self):
        original, completed, _, _, _, _, _ = fixture()
        expected = http.visible_messages(completed)
        transport = client(completed)
        response = object()
        with patch.object(http, 'code_blocks', wraps=http.code_blocks) as code, \
                patch.object(http, '_citations', wraps=http._citations) as citations, \
                patch.object(http, '_read_stream', return_value=(original['conversation_id'], True)) as stream:
            def post(*_args, **_kwargs):
                code.assert_not_called()
                citations.assert_not_called()
                return response
            transport._request.side_effect = post
            selected = http.thread_model(original)
            body, messages, reply, complete = transport.send(PROMPT, existing=original, model=selected)
        transport._request.assert_called_once()
        sent = transport._request.call_args
        self.assertEqual(sent.args, ('POST', '/backend-api/f/conversation'))
        self.assertEqual(sent.kwargs['json']['model'], MODEL)
        self.assertEqual(sent.kwargs['json']['conversation_id'], original['conversation_id'])
        self.assertEqual(sent.kwargs['json']['parent_message_id'], original['current_node'])
        self.assertEqual(sent.kwargs['json']['messages'][0]['content']['parts'], [PROMPT])
        self.assertIs(sent.kwargs['json']['history_and_training_disabled'], True)
        stream.assert_called_once_with(response, original['conversation_id'], None)
        transport.read.assert_called_once_with(original['conversation_id'])
        self.assertIs(body, completed)
        self.assertEqual(messages, expected)
        self.assertEqual(reply, expected[-1])
        self.assertEqual(code.call_count, len(expected))
        self.assertEqual(citations.call_count, len(expected))
        self.assertTrue(complete)

    def test_selected_malformed_or_cyclic_branches_are_refused_before_any_post(self):
        original, _, _, old_user, old_reply, _, _ = fixture()
        malformed = []
        for key, value in [('mapping', []), ('current_node', None), ('current_node', 'missing-node')]:
            body = deepcopy(original)
            body[key] = value
            malformed.append(body)
        body = deepcopy(original)
        body['mapping'][old_user]['parent'] = old_reply
        malformed.append(body)
        for key, value in [('author', None), ('metadata', ['invalid']), ('content', None),
                           ('content', {'content_type': 'text', 'parts': 'invalid'})]:
            body = deepcopy(original)
            body['mapping'][old_reply]['message'][key] = value
            malformed.append(body)
        for body in malformed:
            with self.subTest(body=body):
                with self.assertRaises(ClaudeError) as model_error:
                    http.thread_model(body)
                self.assertEqual(model_error.exception.code, 'invalid_response')
                transport = client(body)
                with self.assertRaises(ClaudeError) as send_error:
                    transport.send(PROMPT, existing=body)
                self.assertEqual(send_error.exception.code, 'invalid_response')
                transport._request.assert_not_called()
                transport.read.assert_not_called()

    def test_hidden_and_sibling_messages_do_not_enter_previous_ids_or_model_selection(self):
        original, completed, prepared, old_user, old_reply, user, _ = fixture()
        hidden, sibling = str(uuid4()), str(uuid4())
        hidden_message = message(hidden, 'assistant', 'Synthetic hidden response', model='gpt-other')
        hidden_message['metadata']['is_visually_hidden_from_conversation'] = True
        for body in (original, completed):
            body['mapping'][hidden] = {'parent': old_reply, 'message': deepcopy(hidden_message)}
            body['mapping'][sibling] = {'parent': sibling, 'message': message(sibling,
                'assistant', 'Synthetic unselected sibling', model='gpt-other')}
        original['current_node'] = hidden
        completed['mapping'][user]['parent'] = hidden
        prepared['payload']['parent_message_id'] = hidden
        transport = client(completed)
        with patch.object(http, 'confirmed_reply', wraps=http.confirmed_reply) as confirmation:
            self.assertEqual(http.thread_model(original), MODEL)
            _, messages, _, _ = transport.send(PROMPT, existing=original, model=MODEL, prepared_request=prepared)
        self.assertEqual(confirmation.call_args.args[-1], {old_user, old_reply})
        self.assertNotIn(hidden, [item['id'] for item in messages])
        self.assertNotIn(sibling, [item['id'] for item in messages])
        transport._request.assert_not_called()

    def test_an_old_reply_cannot_be_mistaken_for_a_fresh_reply_or_trigger_a_resend(self):
        original, _, _, _, _, _, _ = fixture()
        transport = client(original)
        with patch.object(http, '_read_stream', return_value=(original['conversation_id'], True)):
            with self.assertRaises(ClaudeError) as error:
                transport.send(PROMPT, existing=original, model=MODEL)
        self.assertEqual(error.exception.code, 'response_pending')
        transport._request.assert_called_once()
        transport.read.assert_called_once_with(original['conversation_id'])


if __name__ == '__main__':
    unittest.main()
