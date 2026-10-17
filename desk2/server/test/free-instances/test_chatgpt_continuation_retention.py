"""Release prior transcript data before queueing, retaining exact send evidence."""

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4
import weakref

from claudfree.chatgpt import api, browser_request, http
from claudfree.errors import ClaudeError


CONVERSATION, OLD_USER, OLD_REPLY, HIDDEN, SIBLING, USER, REPLY = [str(uuid4()) for _ in range(7)]
PROMPT = 'Synthetic continuation 世界'
MODEL = 'gpt-6'
ENTRY = {'chat_id': str(uuid4()), 'name': 'synthetic-chat'}
BRANCH = {'conversation_id': CONVERSATION, 'current_node': HIDDEN, 'is_temporary_chat': True}


def message(identity, role, text):
    return {'id': identity, 'author': {'role': role},
        'content': {'content_type': 'text', 'parts': [text]},
        'metadata': {'model_slug': MODEL}, 'status': 'finished_successfully'}


def original():
    hidden = message(HIDDEN, 'assistant', 'Synthetic hidden response')
    hidden['metadata']['is_visually_hidden_from_conversation'] = True
    return {**BRANCH, 'mapping': {
        OLD_USER: {'parent': None, 'message': message(OLD_USER, 'user', 'Synthetic original prompt')},
        OLD_REPLY: {'parent': OLD_USER, 'message': message(OLD_REPLY, 'assistant',
            'Synthetic original reply ' + 'x' * 100_000)},
        HIDDEN: {'parent': OLD_REPLY, 'message': hidden},
        SIBLING: {'parent': SIBLING, 'message': message(SIBLING, 'assistant', 'Unselected cyclic sibling')},
    }}


def completed():
    body = original()
    body['current_node'] = REPLY
    body['mapping'][USER] = {'parent': HIDDEN, 'message': message(USER, 'user', PROMPT)}
    reply = message(REPLY, 'assistant', 'Synthetic reply é\n'
        '\ue200url\ue202Example source\ue202https://example.test/source\ue201\n'
        '```python\nexample_value = 1\n```\n')
    reply['metadata']['citations'] = [{'url': 'https://example.test/citation', 'title': 'Example citation'}]
    body['mapping'][REPLY] = {'parent': USER, 'message': reply}
    return body


def prepared(body):
    return {'payload': {'action': 'next', 'messages': [message(USER, 'user', PROMPT)],
        'conversation_id': CONVERSATION, 'parent_message_id': HIDDEN, 'model': MODEL,
        'history_and_training_disabled': True}, 'headers': {}, 'already_sent': True,
        'server_id': CONVERSATION, 'confirmed_conversation': body, 'metrics': {'synthetic': True}}


class Observed(dict):
    """A weak-referenceable JSON object; collection requires no forced GC."""


def setup(*, automatic=True, command='resume', load=None, server_id=CONVERSATION):
    client = object.__new__(api.ChatGPTClient)
    client._state = SimpleNamespace(directory=Path('synthetic-state'))
    client.auto_prepare = automatic
    client._resolve = Mock(return_value=(ENTRY, server_id))
    transport = object.__new__(http.ChatGPTHttp)
    transport.preparations = None if automatic else Mock()
    if transport.preparations:
        transport.preparations.take.return_value = {}
        transport.account_key = 'synthetic-account'
    transport._request = Mock()
    transport.model_for = Mock(return_value=MODEL)
    transport.read = Mock(side_effect=load)
    registry = Mock()
    registry.record.return_value = ENTRY
    pool = Mock()
    args = SimpleNamespace(command=command, request_timeout=120, prefer=None, prompt=PROMPT, name=None)
    return client, transport, registry, pool, args


class ContinuationRetentionTests(unittest.TestCase):
    def assert_rich_result(self, result, body):
        expected = http.visible_messages(body)
        self.assertEqual(result['messages'], expected)
        self.assertEqual(result['response'], expected[-1]['text'])
        self.assertEqual(result['model'], MODEL)
        self.assertEqual(result['code_blocks'], [{'language': 'python', 'code': 'example_value = 1\n'}])
        self.assertEqual(result['citations'][0], {'title': 'Example citation', 'url': 'https://example.test/citation'})
        self.assertIn('[Example source](https://example.test/source)', result['response'])
        self.assertEqual([item['id'] for item in expected], [OLD_USER, OLD_REPLY, USER, REPLY])
        for field in ('content', 'tool_calls', 'tool_results'):
            self.assertIn(field, result['messages'][-1])

    def test_automatic_continuation_releases_body_and_mapping_before_browser_queue(self):
        references = []

        def load(_identity):
            body = Observed(original())
            body['mapping'] = Observed(body['mapping'])
            references.extend([weakref.ref(body), weakref.ref(body['mapping'])])
            return body

        final = completed()
        client, transport, registry, pool, args = setup(load=load)

        def prepare(_http, prompt, branch, **options):
            self.assertTrue(all(reference() is None for reference in references))
            self.assertEqual(prompt, PROMPT)
            self.assertEqual(branch, BRANCH)
            self.assertEqual(options['model'], MODEL)
            return prepared(final)

        with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch('claudfree.chatgpt.preparation.Preparations', return_value=pool), \
                patch.object(browser_request, 'prepare', side_effect=prepare) as prepare_call, \
                patch.object(transport, 'send', wraps=transport.send) as sending, \
                patch.object(http, 'confirmed_reply', wraps=http.confirmed_reply) as confirmation:
            result = client._http_execute(args)
        self.assertTrue(all(reference() is None for reference in references))
        self.assertEqual(sending.call_args.kwargs['existing'], BRANCH)
        self.assertEqual(sending.call_args.kwargs['previous_ids'], frozenset({OLD_USER, OLD_REPLY}))
        self.assertIsInstance(sending.call_args.kwargs['previous_ids'], frozenset)
        self.assertEqual(confirmation.call_args.args[-1], {OLD_USER, OLD_REPLY})
        prepare_call.assert_called_once()
        transport._request.assert_not_called()
        transport.read.assert_called_once_with(CONVERSATION)
        transport.model_for.assert_not_called()
        pool.require_available.assert_not_called()
        registry.close.assert_called_once()
        self.assert_rich_result(result, final)

    def test_manual_continuation_releases_history_before_its_one_post(self):
        references = []
        final = completed()
        reads = [0]

        def load(_identity):
            reads[0] += 1
            if reads[0] > 1:
                return final
            body = Observed(original())
            body['mapping'] = Observed(body['mapping'])
            references.extend([weakref.ref(body), weakref.ref(body['mapping'])])
            return body

        client, transport, registry, pool, args = setup(automatic=False, load=load)

        def post(*_args, **_kwargs):
            self.assertTrue(all(reference() is None for reference in references))
            return object()

        transport._request.side_effect = post
        with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch('claudfree.chatgpt.preparation.Preparations', return_value=pool), \
                patch.object(browser_request, 'prepare', side_effect=AssertionError('Manual mode never prepares')), \
                patch.object(http, '_read_stream', return_value=(CONVERSATION, True)):
            result = client._http_execute(args)
        pool.require_available.assert_called_once()
        transport.preparations.take.assert_called_once_with('synthetic-account')
        transport._request.assert_called_once()
        payload = transport._request.call_args.kwargs['json']
        self.assertEqual((payload['conversation_id'], payload['parent_message_id'], payload['model']),
            (CONVERSATION, HIDDEN, MODEL))
        self.assertEqual(payload['messages'][0]['content']['parts'], [PROMPT])
        self.assertIs(payload['history_and_training_disabled'], True)
        self.assertEqual(transport.read.call_count, 2)
        self.assert_rich_result(result, final)

    def test_malformed_selected_branches_fail_before_preparation_or_dispatch(self):
        bodies = []
        for key, value in [('mapping', []), ('current_node', None), ('current_node', 'missing-node')]:
            body = original()
            body[key] = value
            bodies.append(body)
        body = original()
        body['mapping'][OLD_USER]['parent'] = HIDDEN
        bodies.append(body)
        for key, value in [('author', None), ('metadata', ['invalid']),
                ('content', {'content_type': 'text', 'parts': 'invalid'})]:
            body = original()
            body['mapping'][OLD_REPLY]['message'][key] = value
            bodies.append(body)
        for body in bodies:
            with self.subTest(body=body):
                client, transport, registry, pool, args = setup(load=lambda _id: body)
                with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                        patch.object(api, 'connection', return_value=nullcontext(transport)), \
                        patch('claudfree.chatgpt.preparation.Preparations', return_value=pool), \
                        patch.object(browser_request, 'prepare') as prepare_call:
                    with self.assertRaises(ClaudeError) as caught:
                        client._http_execute(args)
                self.assertEqual(caught.exception.code, 'invalid_response')
                prepare_call.assert_not_called()
                transport._request.assert_not_called()
                registry.close.assert_called_once()

    def test_compact_previous_ids_do_not_accept_an_old_reply_or_resend(self):
        client, transport, registry, pool, args = setup(automatic=False, load=lambda _id: original())
        with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch('claudfree.chatgpt.preparation.Preparations', return_value=pool), \
                patch.object(http, '_read_stream', return_value=(CONVERSATION, True)):
            with self.assertRaises(ClaudeError) as caught:
                client._http_execute(args)
        self.assertEqual(caught.exception.code, 'response_pending')
        self.assertEqual(caught.exception.chat_id, ENTRY['chat_id'])
        transport._request.assert_called_once()
        self.assertEqual(transport.read.call_count, 2)

    def test_direct_send_without_previous_ids_keeps_full_body_validation_and_output(self):
        initial, final = original(), completed()
        client, transport, registry, pool, _args = setup(automatic=False, load=lambda _id: final)
        with patch.object(http, 'visible_messages', wraps=http.visible_messages) as projection, \
                patch.object(transport, 'send', wraps=transport.send) as sending, \
                patch.object(http, '_read_stream', return_value=(CONVERSATION, True)):
            result = client._send(transport, registry, pool, PROMPT, ENTRY, CONVERSATION, initial, MODEL)
        self.assertIs(sending.call_args.kwargs['existing'], initial)
        self.assertNotIn('previous_ids', sending.call_args.kwargs)
        self.assertEqual(projection.call_args_list[0].args, (initial,))
        self.assertEqual(projection.call_args_list[0].kwargs, {'rich': False})
        transport._request.assert_called_once()
        self.assert_rich_result(result, final)

    def test_direct_http_still_refuses_malformed_mapping_without_a_precomputed_set(self):
        for body in [{**BRANCH, 'mapping': []}, {**BRANCH, 'mapping': {HIDDEN: {'parent': HIDDEN}}}]:
            with self.subTest(body=body):
                _client, transport, _registry, _pool, _args = setup()
                with self.assertRaises(ClaudeError) as caught:
                    transport.send(PROMPT, existing=body, model=MODEL)
                self.assertEqual(caught.exception.code, 'invalid_response')
                transport._request.assert_not_called()
                transport.read.assert_not_called()

    def test_compact_branch_preserves_privacy_and_prepared_parent_refusal(self):
        final = completed()
        for branch, error in [({**BRANCH, 'is_temporary_chat': False}, 'privacy_not_verified'),
                ({**BRANCH, 'current_node': str(uuid4())}, 'browser_preparation_invalid')]:
            with self.subTest(branch=branch):
                _client, transport, _registry, _pool, _args = setup()
                with self.assertRaises(ClaudeError) as caught:
                    transport.send(PROMPT, existing=branch, model=MODEL, prepared_request=prepared(final),
                        previous_ids=frozenset({OLD_USER, OLD_REPLY}))
                self.assertEqual(caught.exception.code, error)
                transport._request.assert_not_called()
                transport.read.assert_not_called()

    def test_empty_prevalidated_id_set_is_not_confused_with_unvalidated_history(self):
        final = completed()
        _client, transport, _registry, _pool, _args = setup()
        with patch.object(http, 'visible_messages', wraps=http.visible_messages) as projection:
            body, messages, reply, complete = transport.send(PROMPT, existing=BRANCH, model=MODEL,
                prepared_request=prepared(final), previous_ids=frozenset())
        self.assertEqual(len(projection.call_args_list), 1)
        self.assertIs(projection.call_args.args[0], final)
        self.assertIs(body, final)
        self.assertIs(reply, messages[-1])
        self.assertTrue(complete)
        transport._request.assert_not_called()
        transport.read.assert_not_called()

    def test_new_chat_keeps_default_send_arguments_and_its_single_post(self):
        final = completed()
        final['mapping'] = {key: final['mapping'][key] for key in (USER, REPLY)}
        final['mapping'][USER]['parent'] = None
        client, transport, registry, pool, args = setup(automatic=False, command='chat',
            load=lambda _id: final, server_id=None)
        with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch('claudfree.chatgpt.preparation.Preparations', return_value=pool), \
                patch.object(transport, 'send', wraps=transport.send) as sending, \
                patch.object(http, '_read_stream', return_value=(CONVERSATION, True)):
            result = client._http_execute(args)
        self.assertIsNone(sending.call_args.kwargs['existing'])
        self.assertNotIn('previous_ids', sending.call_args.kwargs)
        transport.model_for.assert_called_once_with(None)
        transport._request.assert_called_once()
        payload = transport._request.call_args.kwargs['json']
        self.assertNotIn('conversation_id', payload)
        self.assertIs(payload['temporary_chat_requests_personalization'], False)
        self.assertEqual(payload['model'], MODEL)
        self.assertEqual(result['messages'], http.visible_messages(final))
        transport.read.assert_called_once_with(CONVERSATION)

    def test_read_command_retains_its_complete_rich_history(self):
        body = original()
        client, transport, registry, pool, args = setup(command='read', load=lambda _id: body)
        with patch.object(api, 'ChatGPTRegistry', return_value=registry), \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch.object(browser_request, 'prepare') as preparing:
            result = client._http_execute(args)
        self.assertEqual(result['messages'], http.visible_messages(body))
        self.assertEqual(len(result['messages'][1]['text']), len(body['mapping'][OLD_REPLY]['message']['content']['parts'][0]))
        preparing.assert_not_called()
        transport._request.assert_not_called()
        registry.close.assert_called_once()


if __name__ == '__main__':
    unittest.main()
