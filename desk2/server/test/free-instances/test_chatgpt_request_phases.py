"""File-free coordinator phases: only offline HTTP doubles and synthetic account data."""

from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch
from uuid import uuid4

from requests.cookies import RequestsCookieJar

from claudfree.chatgpt import api, browser_request, http, request_phases as phases
from claudfree.errors import ClaudeError
from claudfree.results import brief_result


CONVERSATION, OLD_USER, OLD_REPLY, HIDDEN, USER, REPLY = [str(uuid4()) for _ in range(6)]
PROMPT = 'Synthetic continuation 世界 \ud800'
MODEL = 'gpt-6'
ENTRY = {'chat_id': str(uuid4()), 'name': 'synthetic-phase-chat'}
BRANCH = {'conversation_id': CONVERSATION, 'current_node': HIDDEN, 'is_temporary_chat': True}
HEADERS = {'Authorization': 'Bearer synthetic-preflight', 'User-Agent': 'synthetic-agent'}
SAVED = {'cookies': [], 'origins': []}


def message(identity, role, text):
    return {'id': identity, 'author': {'role': role},
        'content': {'content_type': 'text', 'parts': [text]},
        'metadata': {'model_slug': MODEL}, 'status': 'finished_successfully'}


def original():
    hidden = message(HIDDEN, 'assistant', 'Synthetic hidden result')
    hidden['metadata']['is_visually_hidden_from_conversation'] = True
    return {**BRANCH, 'mapping': {
        OLD_USER: {'parent': None, 'message': message(OLD_USER, 'user', 'Synthetic original request')},
        OLD_REPLY: {'parent': OLD_USER, 'message': message(OLD_REPLY, 'assistant', 'Synthetic previous response')},
        HIDDEN: {'parent': OLD_REPLY, 'message': hidden},
    }}


def completed():
    body = original()
    body['current_node'] = REPLY
    body['mapping'][USER] = {'parent': HIDDEN, 'message': message(USER, 'user', PROMPT)}
    reply = message(REPLY, 'assistant', 'Synthetic reply é \udfff\n```python\nexample_value = 1\n```\n')
    reply['metadata']['citations'] = [{'url': 'https://example.test/source', 'title': 'Example source'}]
    body['mapping'][REPLY] = {'parent': USER, 'message': reply}
    return body


def prepared(body=None):
    return {'payload': {'action': 'next', 'messages': [message(USER, 'user', PROMPT)],
        'conversation_id': CONVERSATION, 'parent_message_id': HIDDEN, 'model': MODEL,
        'history_and_training_disabled': True},
        'headers': {'Authorization': 'Bearer synthetic-captured', 'openai-sentinel-token': 'synthetic-only'},
        'already_sent': True, 'server_id': CONVERSATION,
        'confirmed_conversation': completed() if body is None else body,
        'metrics': {'synthetic': True, 'browser_completed_send': True}}


def transport(body=None):
    session = SimpleNamespace(headers={}, cookies=RequestsCookieJar(), close=Mock())
    client = phases.ReadOnlyChatGPTHttp(SAVED, session_factory=lambda: session)
    client.account_email = 'owner@example.test'
    client.account_label = 'Example Owner'
    client.session.headers.update({**HEADERS, 'Cookie': 'must-not-cross', 'Accept': 'application/json'})
    client.authenticate = Mock()
    client.model_for = Mock(return_value=MODEL)
    client.read = Mock(return_value=completed() if body is None else body)
    client._request = Mock(wraps=client._request)
    session.request = Mock(side_effect=AssertionError('No network is allowed'))
    factory = Mock(return_value=client)
    return client, factory


def readback(client_factory, **changes):
    args = {'headers': HEADERS, 'branch': BRANCH, 'previous_ids': [OLD_USER, OLD_REPLY],
        'model': MODEL, 'prompt': PROMPT, 'prepared': prepared(), 'entry': ENTRY,
        'command': 'resume', 'http_factory': client_factory}
    args.update(changes)
    return phases.readback(SAVED, **args)


class RequestPhaseTests(unittest.TestCase):
    def assert_read_only(self, client):
        client.authenticate.assert_not_called()
        client.session.request.assert_not_called()
        self.assertTrue(all(call.args[0] == 'GET' for call in client._request.call_args_list))
        client.session.close.assert_called_once()

    def test_preflight_new_chat_authenticates_selects_model_and_returns_only_allowed_headers(self):
        client, factory = transport()
        result = phases.preflight(SAVED, prefer='gpt-thinking', timeout=17, http_factory=factory)
        self.assertTrue(result['ok'])
        self.assertTrue(result['saved_state_valid'])
        self.assertEqual(result['headers'], HEADERS)
        self.assertEqual((result['account_email'], result['account_label']),
            ('owner@example.test', 'Example Owner'))
        self.assertEqual((result['existing'], result['previous_ids'], result['model']), (None, [], MODEL))
        client.authenticate.assert_called_once_with()
        client.model_for.assert_called_once_with('gpt-thinking')
        client.read.assert_not_called()
        client.session.request.assert_not_called()
        factory.assert_called_once_with(SAVED, timeout=17)
        client.session.close.assert_called_once()

    def test_preflight_continuation_preserves_exact_visible_ids_and_drops_history(self):
        body = original()
        client, factory = transport(body)
        result = phases.preflight(SAVED, server_id=CONVERSATION, prefer='ignored', http_factory=factory)
        self.assertTrue(result['ok'])
        self.assertEqual(result['existing'], BRANCH)
        self.assertEqual(result['previous_ids'], [OLD_USER, OLD_REPLY])
        self.assertNotIn('mapping', result['existing'])
        self.assertEqual(result['model'], http.thread_model(body))
        client.read.assert_called_once_with(CONVERSATION)
        client.model_for.assert_not_called()
        client.session.request.assert_not_called()

    def test_default_transport_rejects_non_get_before_the_underlying_http_client(self):
        client, _ = transport()
        with patch.object(http.ChatGPTHttp, '_request', return_value='synthetic-get') as base:
            self.assertEqual(client._request('GET', '/synthetic'), 'synthetic-get')
            for method in ('POST', 'DELETE', 'PATCH'):
                with self.assertRaises(ClaudeError) as error:
                    client._request(method, '/backend-api/f/conversation')
                self.assertEqual(error.exception.code, 'phase_mutation_refused')
            base.assert_called_once_with('GET', '/synthetic')
        client.close()

    def test_readback_matches_legacy_full_and_brief_envelopes_without_post_or_authenticate(self):
        for brief in (False, True):
            with self.subTest(brief=brief):
                client, factory = transport()
                legacy_client = object.__new__(api.ChatGPTClient)
                legacy_client._state = SimpleNamespace(directory=Path('synthetic-unused'))
                legacy_client.auto_prepare = True
                registry = Mock()
                registry.record.return_value = ENTRY
                with patch.object(browser_request, 'prepare', return_value=prepared()):
                    value = legacy_client._send(client, registry, None, PROMPT, ENTRY,
                        CONVERSATION, BRANCH, MODEL, previous_ids=frozenset({OLD_USER, OLD_REPLY}))
                expected = {'ok': True, 'schema_version': 1, 'provider': 'chatgpt',
                    'command': 'resume', 'transport': 'http', **value}
                if brief:
                    expected = brief_result(expected)
                client.session.close.reset_mock()
                phase = readback(factory, brief=brief)
                self.assertTrue(phase['ok'])
                self.assertEqual(phase['result'], expected)
                self.assertEqual(phase['result']['response'], 'Synthetic reply é \udfff\n```python\nexample_value = 1\n```\n')
                self.assertEqual(phase['result']['code_blocks'], [{'language': 'python', 'code': 'example_value = 1\n'}])
                self.assertEqual(phase['result']['citations'], [{'title': 'Example source', 'url': 'https://example.test/source'}])
                self.assertEqual(client.session.headers['Authorization'], 'Bearer synthetic-captured')
                self.assert_read_only(client)

    def test_readback_uses_one_fallback_get_when_the_browser_omits_its_snapshot(self):
        client, factory = transport()
        proof = prepared()
        del proof['confirmed_conversation']
        result = readback(factory, prepared=proof)
        self.assertTrue(result['ok'])
        client.read.assert_called_once_with(CONVERSATION)
        self.assert_read_only(client)

    def test_new_chat_readback_accepts_no_prior_branch_and_keeps_unicode_exact(self):
        body = completed()
        body['mapping'] = {key: body['mapping'][key] for key in (HIDDEN, USER, REPLY)}
        body['mapping'][HIDDEN] = {'parent': None, 'message': None}
        proof = prepared(body)
        del proof['payload']['conversation_id']
        # A lone surrogate cannot be UTF-8 sized for the optional browser
        # snapshot. Its safe GET fallback must return this same new-chat branch.
        client, factory = transport(body)
        result = readback(factory, branch=None, previous_ids=[], command='chat', prepared=proof)
        self.assertTrue(result['ok'])
        self.assertEqual(result['result']['command'], 'chat')
        self.assertEqual(result['result']['messages'][0]['text'], PROMPT)
        self.assertIn('\udfff', result['result']['response'])
        client.read.assert_called_once_with(CONVERSATION)
        self.assert_read_only(client)

    def test_phases_construct_no_state_or_registry_and_write_no_saved_account(self):
        client, factory = transport()
        with patch.object(api.ChatGPTClient, '__init__', side_effect=AssertionError('No client state')), \
                patch.object(api, 'ChatGPTRegistry', side_effect=AssertionError('No registry')), \
                patch.object(api, 'ChatGPTState', side_effect=AssertionError('No state')), \
                patch('claudfree.state.atomic_write', side_effect=AssertionError('No persistence')) as write:
            self.assertTrue(readback(factory)['ok'])
            self.assertTrue(phases.preflight(SAVED, http_factory=factory)['ok'])
        write.assert_not_called()

    def test_preflight_returns_rotated_cookies_when_authentication_fails(self):
        client, factory = transport()
        failure = ClaudeError('Synthetic auth refusal', code='login_required', status=401)

        def authenticate():
            client.session.cookies.set('synthetic-rotated', 'latest', domain='chatgpt.com', path='/')
            raise failure

        client.authenticate.side_effect = authenticate
        result = phases.preflight(SAVED, http_factory=factory)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error'], failure.as_dict())
        self.assertIn('latest', [cookie['value'] for cookie in result['saved_state']['cookies']])
        self.assertEqual(SAVED, {'cookies': [], 'origins': []})
        client.session.close.assert_called_once()

    def test_readback_returns_latest_cookies_and_original_contextual_error_on_failure(self):
        client, factory = transport()

        def failed(*_args, **_kwargs):
            client.session.cookies.set('synthetic-rotated', 'latest', domain='chatgpt.com', path='/')
            raise ClaudeError('Synthetic confirmation refusal', code='rate_limited', status=429, retryable=True)

        client.send = Mock(side_effect=failed)
        result = readback(factory)
        self.assertFalse(result['ok'])
        self.assertEqual(result['result'], {'ok': False, 'error': result['error']})
        self.assertEqual(result['error'], {'code': 'rate_limited', 'message': 'Synthetic confirmation refusal',
            'retryable': True, 'http_status': 429, 'chat_id': ENTRY['chat_id'], 'model': MODEL})
        self.assertIn('latest', [cookie['value'] for cookie in result['saved_state']['cookies']])
        self.assert_read_only(client)

    def test_state_extraction_failure_never_masks_the_primary_error_or_returns_false_success(self):
        for failed in (False, True):
            with self.subTest(failed=failed):
                client, factory = transport()
                client.saved_state = Mock(side_effect=RuntimeError('Synthetic snapshot failure'))
                if failed:
                    client.send = Mock(side_effect=ClaudeError('Original failure', code='response_pending'))
                result = readback(factory)
                self.assertFalse(result['ok'])
                self.assertFalse(result['saved_state_valid'])
                self.assertEqual(result['state_error']['code'], 'session_save_failed')
                self.assertEqual(result['error']['code'], 'response_pending' if failed else 'session_save_failed')
                self.assertEqual(result['result'], {'ok': False, 'error': result['error']})
                self.assert_read_only(client)

    def test_close_failure_keeps_the_primary_error_and_latest_snapshot(self):
        client, factory = transport()
        client.session.close.side_effect = RuntimeError('Synthetic close failure')
        client.send = Mock(side_effect=ClaudeError('Original refusal', code='response_pending'))
        result = readback(factory)
        self.assertFalse(result['ok'])
        self.assertTrue(result['saved_state_valid'])
        self.assertEqual(result['error']['code'], 'response_pending')
        self.assert_read_only(client)

    def test_no_false_already_sent_value_can_reach_send(self):
        for flag in (False, 1, 'true', None):
            with self.subTest(flag=flag):
                client, factory = transport()
                client.send = Mock(wraps=client.send)
                proof = prepared()
                proof['already_sent'] = flag
                result = readback(factory, prepared=proof)
                self.assertFalse(result['ok'])
                self.assertEqual(result['error']['code'], 'browser_preparation_invalid')
                client.send.assert_not_called()
                self.assert_read_only(client)

    def test_invalid_contracts_refuse_without_post_authentication_or_persistence(self):
        cases = [
            {'headers': {'Cookie': 'synthetic'}},
            {'headers': {'Authorization': 'Bearer bad\nheader'}},
            {'headers': {}},
            {'branch': {'conversation_id': CONVERSATION}},
            {'branch': {**BRANCH, 'is_temporary_chat': False}},
            {'previous_ids': 'not-a-list'},
            {'previous_ids': [None]},
            {'command': 'read'},
            {'prompt': ' '},
            {'entry': {'chat_id': 'invalid', 'name': None}},
            {'model': 'unsupported-model'},
            {'prepared': {**prepared(), 'metrics': None}},
        ]
        for options in cases:
            with self.subTest(fields=list(options)):
                client, factory = transport()
                result = readback(factory, **options)
                self.assertFalse(result['ok'])
                self.assert_read_only(client)

    def test_invalid_final_branch_or_nonfresh_reply_cannot_confirm_the_send(self):
        wrong = completed()
        wrong['conversation_id'] = str(uuid4())
        private = completed()
        private['is_temporary_chat'] = False
        duplicate = completed()
        duplicate['mapping'][REPLY]['message']['id'] = OLD_REPLY
        for proof, previous in [(prepared(wrong), [OLD_USER, OLD_REPLY]),
                (prepared(private), [OLD_USER, OLD_REPLY]),
                (prepared(duplicate), [OLD_USER, OLD_REPLY]),
                (prepared(), [OLD_USER, OLD_REPLY, USER, REPLY])]:
            client, factory = transport()
            self.assertFalse(readback(factory, prepared=proof, previous_ids=previous)['ok'])
            client.read.assert_not_called()
            self.assert_read_only(client)

    def test_invalid_previous_branch_fails_during_preflight_before_any_browser_phase(self):
        body = original()
        body['mapping'][OLD_REPLY]['message']['id'] = None
        client, factory = transport(body)
        result = phases.preflight(SAVED, server_id=CONVERSATION, http_factory=factory)
        self.assertFalse(result['ok'])
        self.assertEqual(result['error']['code'], 'invalid_response')
        client.session.request.assert_not_called()


if __name__ == '__main__':
    unittest.main()
