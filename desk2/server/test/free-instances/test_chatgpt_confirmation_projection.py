"""Proof polling keeps branch/text guards without rendering historical replies."""

from copy import deepcopy
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from claudfree.chatgpt import browser_request, http
from claudfree.errors import ClaudeError


PROOF_FIELDS = {'id', 'role', 'text', 'model', 'incomplete'}


def fixture():
    conversation, user, assistant = [str(uuid4()) for _ in range(3)]
    question = 'Example \u4e16\u754c \U0001f30e question'
    answer = ('Example answer \u00e9\n'
        '\ue200url\ue202Read docs\ue202https://example.test/guide\ue201\n'
        '```python\nexample_value = 1\n```\n')
    body = {'conversation_id': conversation, 'is_temporary_chat': True,
        'current_node': assistant, 'mapping': {
            user: {'parent': None, 'message': {'id': user, 'author': {'role': 'user'},
                'content': {'content_type': 'text', 'parts': [question]},
                'status': 'finished_successfully'}},
            assistant: {'parent': user, 'message': {'id': assistant,
                'author': {'role': 'assistant'}, 'channel': 'final', 'recipient': 'all',
                'content': {'content_type': 'text', 'parts': [answer]},
                'metadata': {'model_slug': http.TEXT_MODEL,
                    'citations': [{'url': 'https://example.test/citation', 'title': 'Example source'}]},
                'status': 'finished_successfully'}},
        }}
    return body, question, user, assistant


class ConfirmationProjectionTests(unittest.TestCase):
    def test_proof_is_exact_rich_projection_with_unicode_and_link_normalization(self):
        body, question, _, _ = fixture()
        rich = http.visible_messages(body)
        proof = http.visible_messages(body, rich=False)
        self.assertEqual(proof, [{key: value for key, value in message.items()
            if key in PROOF_FIELDS} for message in rich])
        self.assertEqual([set(message) for message in proof], [PROOF_FIELDS, PROOF_FIELDS])
        self.assertEqual(proof[0]['text'], question)
        self.assertIn('[Read docs](https://example.test/guide)', proof[1]['text'])
        self.assertNotIn('\ue200', proof[1]['text'])
        self.assertEqual(proof[1]['model'], http.TEXT_MODEL)
        self.assertEqual(rich[1]['content'], [{'type': 'text', 'text': proof[1]['text']}])
        self.assertEqual(rich[1]['code_blocks'], [{'language': 'python', 'code': 'example_value = 1\n'}])
        self.assertEqual(rich[1]['citations'][0]['url'], 'https://example.test/citation')
        self.assertEqual(rich[1]['tool_calls'], [])
        self.assertEqual(rich[1]['tool_results'], [])

    def test_proof_never_invokes_code_or_citation_extractors(self):
        body, _, _, _ = fixture()
        with patch.object(http, 'code_blocks', Mock(side_effect=AssertionError('No code extraction in proof'))), \
                patch.object(http, '_citations', Mock(side_effect=AssertionError('No citation extraction in proof'))):
            messages = http.visible_messages(body, rich=False)
        self.assertEqual(len(messages), 2)

    def test_incomplete_and_fallback_model_fields_match_rich_output(self):
        body, _, _, assistant = fixture()
        message = body['mapping'][assistant]['message']
        message['status'] = 'in_progress'
        message['metadata'] = {'resolved_model_slug': http.TEXT_MODEL}
        proof = http.visible_messages(body, rich=False)
        rich = http.visible_messages(body)
        self.assertEqual(proof[-1], {key: value for key, value in rich[-1].items() if key in PROOF_FIELDS})
        self.assertTrue(proof[-1]['incomplete'])
        self.assertEqual(proof[-1]['model'], http.TEXT_MODEL)

    def test_hidden_analysis_tool_and_empty_messages_stay_hidden(self):
        original, question, _, assistant = fixture()
        variants = [
            {'metadata': {'is_visually_hidden_from_conversation': True}},
            {'channel': 'analysis'},
            {'recipient': 'example_tool'},
            {'author': {'role': 'tool'}},
            {'content': {'content_type': 'image_asset_pointer', 'parts': ['Example image']}},
            {'content': {'content_type': 'text', 'parts': []}},
        ]
        for changes in variants:
            with self.subTest(changes=changes):
                body = deepcopy(original)
                body['mapping'][assistant]['message'].update(changes)
                rich = http.visible_messages(body)
                proof = http.visible_messages(body, rich=False)
                self.assertEqual(proof, [{key: value for key, value in message.items()
                    if key in PROOF_FIELDS} for message in rich])
                self.assertEqual([message['text'] for message in proof], [question])

    def test_malformed_and_cyclic_selected_branches_keep_identical_refusals(self):
        original, _, user, assistant = fixture()
        invalid = []
        for field, value in [('mapping', []), ('current_node', None), ('current_node', 'missing-node')]:
            body = deepcopy(original)
            body[field] = value
            invalid.append(body)
        body = deepcopy(original)
        body['mapping'][user]['parent'] = assistant
        invalid.append(body)
        body = deepcopy(original)
        body['mapping'][assistant]['parent'] = 'missing-parent'
        invalid.append(body)
        for field, value in [('author', None), ('metadata', ['invalid']),
                             ('content', None), ('content', {'content_type': 'text', 'parts': 'invalid'})]:
            body = deepcopy(original)
            body['mapping'][assistant]['message'][field] = value
            invalid.append(body)
        for body in invalid:
            with self.subTest(body=body):
                codes = []
                for rich in (True, False):
                    with self.assertRaises(ClaudeError) as error:
                        http.visible_messages(body, rich=rich)
                    codes.append(error.exception.code)
                self.assertEqual(codes, ['invalid_response', 'invalid_response'])

    def test_unselected_sibling_messages_and_cycles_remain_excluded(self):
        body, _, user, _ = fixture()
        sibling = str(uuid4())
        body['mapping'][sibling] = {'parent': sibling, 'message': {
            'id': sibling, 'author': {'role': 'assistant'},
            'content': {'content_type': 'text', 'parts': ['Unselected reply']}}}
        proof = http.visible_messages(body, rich=False)
        self.assertEqual(proof[0]['id'], user)
        self.assertNotIn(sibling, [message['id'] for message in proof])


class ConfirmationPollingTests(unittest.IsolatedAsyncioTestCase):
    async def test_polling_checks_actual_reply_without_any_rich_extraction(self):
        body, prompt, user, _ = fixture()
        client = SimpleNamespace(_json=Mock(return_value=body))
        confirmed = {}
        with patch.object(http, 'code_blocks', Mock(side_effect=AssertionError('No code extraction on poll'))), \
                patch.object(http, '_citations', Mock(side_effect=AssertionError('No citations on poll'))):
            complete = await browser_request._own_message_completed(client,
                body['conversation_id'], user, prompt, True, confirmed)
        self.assertIs(complete, True)
        self.assertIs(confirmed['body'], body)
        client._json.assert_called_once_with('GET', '/backend-api/conversation/' + body['conversation_id'])

    async def test_polling_still_refuses_incomplete_wrong_message_or_nonprivate_reply(self):
        original, prompt, user, assistant = fixture()
        body = deepcopy(original)
        body['mapping'][assistant]['message']['status'] = 'in_progress'
        client = SimpleNamespace(_json=Mock(return_value=body))
        self.assertIs(await browser_request._own_message_completed(client,
            body['conversation_id'], user, prompt, True), False)
        client._json.return_value = original
        self.assertIs(await browser_request._own_message_completed(client,
            original['conversation_id'], str(uuid4()), prompt, True), False)
        private = deepcopy(original)
        private['is_temporary_chat'] = False
        client._json.return_value = private
        with self.assertRaises(ClaudeError) as error:
            await browser_request._own_message_completed(client,
                private['conversation_id'], user, prompt, True)
        self.assertEqual(error.exception.code, 'privacy_not_verified')


if __name__ == '__main__':
    unittest.main()
