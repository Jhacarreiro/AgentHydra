"""One compact continuation projection; no HTTP, browser, registry or provider work."""

from contextlib import nullcontext
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import UUID, uuid4
import weakref

from claudfree.chatgpt import api, http, request_phases as phases
from claudfree.errors import ClaudeError


MODEL = 'gpt-6'
SAVED = {'cookies': [], 'origins': []}
ENTRY = {'chat_id': str(uuid4()), 'name': 'synthetic-continuation'}


def graph(count=4):
    mapping = {}
    parent = None
    for index in range(count):
        identity = str(UUID(int=index + 1))
        mapping[identity] = {'parent': parent, 'message': {
            'id': identity, 'author': {'role': 'assistant' if index % 2 else 'user'},
            'content': {'content_type': 'text', 'parts': ['Synthetic history 世界 \ud800']},
            'metadata': {'model_slug': MODEL}, 'status': 'finished_successfully'}}
        parent = identity
    return {'conversation_id': str(uuid4()), 'current_node': parent,
        'is_temporary_chat': True, 'mapping': mapping}


def legacy_summary(body):
    return http.thread_model(body), [message['id'] for message in http.visible_messages(body, rich=False)]


def phase_transport(body):
    return SimpleNamespace(authenticate=Mock(), read=Mock(return_value=body),
        model_for=Mock(side_effect=AssertionError('Continuation must use its thread model')),
        session=SimpleNamespace(headers={'Authorization': 'Bearer synthetic-only'}, request=Mock()),
        account_email='owner@example.test', account_label='Example Owner',
        saved_state=Mock(return_value=SAVED), close=Mock())


def api_client(body):
    client = object.__new__(api.ChatGPTClient)
    client._state = SimpleNamespace(directory=Path('synthetic-unused'))
    client.auto_prepare = True
    client._resolve = Mock(return_value=(ENTRY, body['conversation_id'] if body else None))
    client._send = Mock(return_value={'synthetic': True})
    client._read_or_track = Mock(return_value={'synthetic_read': True})
    transport = SimpleNamespace(read=Mock(return_value=body), model_for=Mock(return_value=MODEL))
    args = SimpleNamespace(command='resume', request_timeout=120, prefer='ignored', prompt='Synthetic prompt')
    return client, transport, args


class Observed(dict):
    """Weak-referenceable synthetic JSON data."""


class ContinuationSummaryTests(unittest.TestCase):
    def test_thousand_node_continuation_reduces_actual_projections_from_two_thousand_to_one_thousand(self):
        body = graph(1000)
        with patch.object(http, '_visible_message', wraps=http._visible_message) as projection, \
                patch.object(http, '_branch', wraps=http._branch) as branch:
            expected = legacy_summary(body)
            self.assertEqual((projection.call_count, branch.call_count), (2000, 2))
            projection.reset_mock()
            branch.reset_mock()
            self.assertEqual(http.continuation_summary(body), expected)
            self.assertEqual((projection.call_count, branch.call_count), (1000, 1))
            self.assertTrue(all(call.kwargs == {'rich': False} for call in projection.call_args_list))

    def test_model_ids_order_and_visible_filtering_match_legacy(self):
        for changes in ({}, {'metadata': {'resolved_model_slug': 'gpt-other'}},
                {'metadata': {'model_slug': 'unsupported-model'}}, {'metadata': {}},
                {'metadata': {'is_visually_hidden_from_conversation': True}},
                {'channel': 'analysis'}, {'recipient': 'synthetic_tool'},
                {'content': {'content_type': 'text', 'parts': []}},
                {'content': {'content_type': 'multimodal_text', 'parts': ['Synthetic ', {}, 'text']}}):
            with self.subTest(changes=changes):
                body = graph()
                body['mapping'][body['current_node']]['message'].update(changes)
                body['mapping']['unselected'] = {'parent': 'unselected', 'message': None}
                self.assertEqual(http.continuation_summary(body), legacy_summary(body))

    def test_malformed_branches_preserve_legacy_failure_code_and_message(self):
        variants = []
        for key, value in (('mapping', []), ('current_node', 'missing'), ('current_node', None)):
            body = graph()
            body[key] = value
            variants.append(body)
        body = graph()
        body['mapping'][str(UUID(int=1))]['parent'] = body['current_node']
        variants.append(body)
        for changes in ({'author': None}, {'metadata': ['invalid']},
                {'content': {'content_type': 'text', 'parts': 'invalid'}}):
            body = graph()
            body['mapping'][body['current_node']]['message'].update(changes)
            variants.append(body)
        for body in variants:
            with self.subTest(body=body['current_node']):
                with self.assertRaises(ClaudeError) as old:
                    legacy_summary(body)
                with self.assertRaises(ClaudeError) as new:
                    http.continuation_summary(body)
                self.assertEqual((new.exception.code, str(new.exception)),
                    (old.exception.code, str(old.exception)))

    def test_summary_retains_only_model_and_ids_not_projected_rows_or_source_graph(self):
        body = Observed(graph())
        body['mapping'] = Observed(body['mapping'])
        source_refs = [weakref.ref(body), weakref.ref(body['mapping'])]
        projected_refs = []
        project = http._visible_message

        def observe(message, **kwargs):
            row = project(message, **kwargs)
            if row is not None:
                row = Observed(row)
                projected_refs.append(weakref.ref(row))
            return row

        with patch.object(http, '_visible_message', side_effect=observe):
            model, identities = http.continuation_summary(body)
        self.assertEqual(model, MODEL)
        self.assertEqual(identities, list(body['mapping']))
        self.assertEqual(len(projected_refs), 4)
        self.assertTrue(all(reference() is None for reference in projected_refs))
        del body
        self.assertTrue(all(reference() is None for reference in source_refs))

    def test_coordinator_preflight_projects_once_and_returns_exact_compact_evidence(self):
        body = graph(1000)
        client = phase_transport(body)
        with patch.object(http, '_visible_message', wraps=http._visible_message) as projection:
            result = phases.preflight(SAVED, server_id=body['conversation_id'], prefer='ignored',
                http_factory=Mock(return_value=client))
        self.assertTrue(result['ok'])
        self.assertEqual(projection.call_count, 1000)
        self.assertEqual(result['model'], MODEL)
        self.assertEqual(result['previous_ids'], list(body['mapping']))
        self.assertEqual(result['existing'], {key: body[key] for key in phases.BRANCH_FIELDS})
        client.read.assert_called_once_with(body['conversation_id'])
        client.authenticate.assert_called_once_with()
        client.model_for.assert_not_called()
        client.session.request.assert_not_called()
        client.close.assert_called_once_with()

    def test_preflight_keeps_ordered_deduplication_and_invalid_id_refusal(self):
        body = graph()
        first = next(iter(body['mapping']))
        body['mapping'][body['current_node']]['message']['id'] = first
        expected = legacy_summary(body)
        self.assertEqual(http.continuation_summary(body), expected)
        client = phase_transport(body)
        result = phases.preflight(SAVED, server_id=body['conversation_id'],
            http_factory=Mock(return_value=client))
        self.assertTrue(result['ok'])
        self.assertEqual(result['previous_ids'], list(dict.fromkeys(expected[1])))
        body['mapping'][body['current_node']]['message']['id'] = None
        client = phase_transport(body)
        result = phases.preflight(SAVED, server_id=body['conversation_id'],
            http_factory=Mock(return_value=client))
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'invalid_response')
        client.session.request.assert_not_called()

    def test_legacy_client_projects_once_before_its_original_send_call(self):
        body = graph(1000)
        client, transport, args = api_client(body)
        with patch.object(api, 'ChatGPTRegistry') as registry, \
                patch.object(api, 'connection', return_value=nullcontext(transport)), \
                patch('claudfree.chatgpt.preparation.Preparations'), \
                patch.object(http, '_visible_message', wraps=http._visible_message) as projection:
            self.assertEqual(client._http_execute(args), {'synthetic': True})
        self.assertEqual(projection.call_count, 1000)
        self.assertEqual(client._send.call_args.args[-2:],
            ({key: body[key] for key in phases.BRANCH_FIELDS}, MODEL))
        self.assertEqual(client._send.call_args.kwargs['previous_ids'], frozenset(body['mapping']))
        transport.read.assert_called_once_with(body['conversation_id'])
        transport.model_for.assert_not_called()
        registry.return_value.close.assert_called_once_with()

    def test_new_chat_and_read_bypass_continuation_summary(self):
        for command, body in (('chat', None), ('read', graph())):
            with self.subTest(command=command):
                client, transport, args = api_client(body)
                args.command = command
                with patch.object(api, 'ChatGPTRegistry'), \
                        patch.object(api, 'connection', return_value=nullcontext(transport)), \
                        patch('claudfree.chatgpt.preparation.Preparations'), \
                        patch.object(api, 'continuation_summary', side_effect=AssertionError('Not a continuation')):
                    result = client._http_execute(args)
                if command == 'chat':
                    self.assertEqual(result, {'synthetic': True})
                    self.assertNotIn('previous_ids', client._send.call_args.kwargs)
                    transport.model_for.assert_called_once_with('ignored')
                    transport.read.assert_not_called()
                else:
                    self.assertEqual(result, {'synthetic_read': True})
                    client._send.assert_not_called()
                    transport.model_for.assert_not_called()


if __name__ == '__main__':
    unittest.main()
