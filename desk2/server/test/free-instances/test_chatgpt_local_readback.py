"""Captured reply rendering stays offline; owned HTTP fallback and account cleanup remain intact."""

from copy import deepcopy
import unittest
from unittest.mock import patch
from uuid import uuid4

from claudfree.chatgpt import http, request_coordinator as coordinator, request_phases as phases
from claudfree.chatgpt.request_ownership import json_frame
from claudfree.errors import ClaudeError
import test_chatgpt_request_coordinator as account_fixture


SERVER, OLD_USER, OLD_REPLY, USER, REPLY, CHAT = [str(uuid4()) for _ in range(6)]
MODEL = 'gpt-6'
PROMPT = 'Synthetic requested continuation 世界'
ENTRY = {'chat_id': CHAT, 'name': 'synthetic-local-readback'}
BRANCH = {'conversation_id': SERVER, 'current_node': OLD_REPLY, 'is_temporary_chat': True}
SAVED = {'cookies': [
    {'name': 'synthetic-auth', 'value': 'synthetic-only', 'domain': 'chatgpt.com', 'expires': -1},
    {'name': 'synthetic-old', 'value': 'expired', 'domain': 'chatgpt.com', 'expires': 1},
    {'name': 'synthetic-other', 'value': 'preserved', 'domain': 'auth.example.test'}], 'origins': []}


def message(identity, role, text):
    return {'id': identity, 'author': {'role': role},
        'content': {'content_type': 'text', 'parts': [text]},
        'metadata': {'model_slug': MODEL}, 'status': 'finished_successfully'}


def arguments(**changes):
    body = {**BRANCH, 'current_node': REPLY, 'mapping': {
        OLD_USER: {'parent': None, 'message': message(OLD_USER, 'user', 'Synthetic first request')},
        OLD_REPLY: {'parent': OLD_USER, 'message': message(OLD_REPLY, 'assistant', 'Synthetic first reply')},
        USER: {'parent': OLD_REPLY, 'message': message(USER, 'user', PROMPT)},
        REPLY: {'parent': USER, 'message': message(REPLY, 'assistant',
            'Synthetic reply é 世界\n```python\nexample_value = 1\n```\n'
            '\ue200url\ue202Example source\ue202https://example.test/source\ue201')},
    }}
    body['mapping'][REPLY]['message']['metadata']['citations'] = [
        {'url': 'https://example.test/citation', 'title': 'Synthetic citation'}]
    prepared = {'already_sent': True, 'server_id': SERVER, 'metrics': {'synthetic': True},
        'headers': {'Authorization': 'Bearer synthetic-captured'},
        'payload': {'action': 'next', 'messages': [body['mapping'][USER]['message']],
            'conversation_id': SERVER, 'parent_message_id': OLD_REPLY, 'model': MODEL,
            'history_and_training_disabled': True}, 'confirmed_conversation': body}
    value = {'saved_state': deepcopy(SAVED), 'headers': {'Authorization': 'Bearer synthetic-preflight'},
        'branch': BRANCH, 'previous_ids': [OLD_USER, OLD_REPLY], 'model': MODEL,
        'prompt': PROMPT, 'prepared': prepared, 'entry': ENTRY, 'command': 'resume'}
    value.update(changes)
    return value


def fixture():
    f = account_fixture.Fixture()
    f.request['prompt'] = PROMPT
    f.registry.resolve.return_value = (dict(account_fixture.ENTRY), SERVER)
    f.proof = arguments()['prepared']
    original_phase = f.phase

    def phase(kind, *rest):
        value = original_phase(kind, *rest)
        if kind == 'preflight':
            value.update(existing=BRANCH, previous_ids=[OLD_USER, OLD_REPLY])
        return value

    def browser(_preflight, _saved, _prompt, on_id, *_rest):
        f.events.append('browser')
        f.clock += 15
        on_id(SERVER)
        return {'ok': True, 'request': f.proof}, account_fixture.snapshot('browser')

    f.owner.phase.side_effect = phase
    f.owner.browser.side_effect = browser
    return f


class OfflineReadback(unittest.TestCase):
    def setUp(self):
        guard = patch('requests.Session.request', side_effect=AssertionError('No provider access'))
        self.network = guard.start()
        self.addCleanup(guard.stop)

    def tearDown(self):
        self.network.assert_not_called()


class LocalReadbackTests(OfflineReadback):
    def test_full_and_brief_envelopes_headers_cookies_and_unicode_match_existing_phase(self):
        for brief in (False, True):
            args = arguments(brief=brief)
            original = deepcopy(args)
            expected = phases.readback(**args)
            actual = phases.readback_if_confirmed(**args)
            self.assertEqual(actual, expected)
            self.assertTrue(actual['ok'])
            self.assertEqual(args, original)
            self.assertEqual(actual['result']['model'], MODEL)
            self.assertEqual(actual['result']['code_blocks'], [{'language': 'python', 'code': 'example_value = 1\n'}])
            self.assertEqual([cookie['name'] for cookie in actual['saved_state']['cookies']],
                ['synthetic-other', 'synthetic-auth'])

    def test_bounded_invalid_evidence_preserves_refusals_without_http_or_replay(self):
        for change in ('conversation', 'privacy', 'prompt', 'duplicate', 'incomplete', 'hidden', 'mapping'):
            with self.subTest(change=change):
                args = arguments()
                body = args['prepared']['confirmed_conversation']
                if change == 'conversation':
                    body['conversation_id'] = str(uuid4())
                elif change == 'privacy':
                    body['is_temporary_chat'] = False
                elif change == 'prompt':
                    body['mapping'][USER]['message']['content']['parts'] = ['Another synthetic prompt']
                elif change == 'duplicate':
                    body['mapping'][REPLY]['message']['id'] = OLD_REPLY
                elif change == 'incomplete':
                    body['mapping'][REPLY]['message']['status'] = 'in_progress'
                elif change == 'hidden':
                    body['mapping'][REPLY]['message']['metadata']['is_visually_hidden_from_conversation'] = True
                else:
                    body['mapping'] = []
                expected = phases.readback(**args)
                actual = phases.readback_if_confirmed(**args)
                self.assertEqual(actual, expected)
                self.assertFalse(actual['ok'])

    def test_missing_oversize_surrogate_and_non_json_snapshots_defer_without_constructing_http(self):
        for body in (None, {'text': 'x' * (http.CONFIRMED_CONVERSATION_MAX_BYTES + 1)},
                {'text': '\ud800'}, {'not_json': object()}):
            args = arguments()
            args['prepared']['confirmed_conversation'] = body
            with patch.object(phases, '_ConfirmedReadbackHttp') as factory:
                self.assertIsNone(phases.readback_if_confirmed(**args))
            factory.assert_not_called()

    def test_guarded_get_requests_defer_and_non_get_requests_refuse(self):
        for method in ('GET', 'POST'):
            with self.subTest(method=method):
                def request(client, *_args, **_kwargs):
                    return client._request(method, '/backend-api/conversation/' + SERVER)

                with patch.object(http.ChatGPTHttp, 'send', new=request):
                    result = phases.readback_if_confirmed(**arguments())
                if method == 'GET':
                    self.assertIsNone(result)
                else:
                    self.assertFalse(result['ok'])
                    self.assertEqual(result['error']['code'], 'phase_mutation_refused')

    def test_snapshot_and_close_failures_preserve_error_precedence(self):
        for operation_error in (False, True):
            for failing in ('saved_state', 'close'):
                with self.subTest(operation_error=operation_error, failing=failing):
                    args = arguments()
                    if operation_error:
                        args['prepared']['confirmed_conversation']['is_temporary_chat'] = False
                    with patch.object(http.ChatGPTHttp, failing, side_effect=OSError('Synthetic local failure')):
                        expected = phases.readback(**args)
                        actual = phases.readback_if_confirmed(**args)
                    self.assertEqual(actual, expected)
                    self.assertFalse(actual['ok'])
                    if operation_error:
                        self.assertEqual(actual['error']['code'], 'privacy_not_verified')

    def test_non_completed_send_and_invalid_headers_cannot_use_captured_evidence(self):
        for change in ('already_sent', 'headers'):
            args = arguments()
            if change == 'already_sent':
                args['prepared']['already_sent'] = False
            else:
                args['headers'] = {'Authorization': 'Bearer invalid\nvalue'}
            self.assertEqual(phases.readback_if_confirmed(**args), phases.readback(**args))
            self.assertFalse(phases.readback_if_confirmed(**args)['ok'])


class CoordinatorLocalReadbackTests(OfflineReadback):
    def test_real_bounded_local_render_keeps_lease_through_persistence_without_second_phase(self):
        f = fixture()
        f.store.save.side_effect = lambda _value: f.events.append('save')
        with f.patched():
            output = f.owner.execute(account_fixture.ROOT / account_fixture.ACCOUNT,
                f.request, f.cancel, 500)
        self.assertEqual(output['code'], 0)
        self.assertEqual([call.args[0] for call in f.owner.phase.call_args_list], ['preflight'])
        f.owner.browser.assert_called_once()
        self.assertEqual(f.events[-3:], ['save', 'registry-close', 'lease-exit'])
        self.assertEqual(f.store.save.call_args.args[0]['cookies'][0]['value'], 'browser')
        f.registry.status.assert_called_once_with(account_fixture.CHAT, 'available')

    def test_missing_oversize_and_guarded_get_use_one_original_owned_readback_with_same_arguments(self):
        for kind in ('missing', 'oversize', 'get'):
            with self.subTest(kind=kind):
                f = fixture()
                if kind == 'missing':
                    f.proof.pop('confirmed_conversation')
                elif kind == 'oversize':
                    f.proof['confirmed_conversation'] = {'text': 'x' * (http.CONFIRMED_CONVERSATION_MAX_BYTES + 1)}

                def request(client, *_args, **_kwargs):
                    return client._request('GET', '/backend-api/conversation/' + SERVER)

                with patch.object(http.ChatGPTHttp, 'send', new=request) if kind == 'get' else patch.object(
                        coordinator, 'readback_if_confirmed', wraps=phases.readback_if_confirmed):
                    result = f.account()
                self.assertTrue(result['ok'])
                self.assertEqual([call.args[0] for call in f.owner.phase.call_args_list], ['preflight', 'readback'])
                tail = f.owner.phase.call_args_list[-1]
                self.assertIs(tail.args[1]['prepared'], f.proof)
                self.assertEqual(tail.args[1]['saved_state'], account_fixture.snapshot('browser'))
                self.assertIs(tail.args[2], f.cancel)
                self.assertEqual(tail.args[3], 500)
                f.owner.browser.assert_called_once()

    def test_output_framing_uses_utf8_surrogate_escaping_and_defers_near_original_phase_limit(self):
        tail = {'ok': True, 'saved_state_valid': True, 'saved_state': account_fixture.snapshot('local'),
            'result': {'ok': True, 'server_conversation_id': SERVER, 'response': '世界\ud800'}}
        required = len(json_frame(tail)) + 4096
        for limit, calls in ((required - 1, 2), (required, 1)):
            with self.subTest(limit=limit):
                f = fixture()
                with patch.object(coordinator, 'readback_if_confirmed', return_value=deepcopy(tail)), \
                        patch.object(coordinator, 'PHASE_LIMIT', limit):
                    self.assertTrue(f.account()['ok'])
                self.assertEqual(f.owner.phase.call_count, calls)

    def test_original_phase_input_limit_counts_unicode_and_surrogates_before_local_admission(self):
        for accepted in (False, True):
            f = fixture()
            f.proof['metrics']['synthetic_unicode'] = '世界\ud800'
            arguments = {'saved_state': account_fixture.snapshot('browser'),
                'headers': account_fixture.HEADERS, 'branch': BRANCH,
                'previous_ids': [OLD_USER, OLD_REPLY], 'model': MODEL, 'prompt': PROMPT,
                'prepared': f.proof, 'entry': account_fixture.ENTRY,
                'command': 'resume', 'timeout': 120, 'brief': True}
            required = len(json_frame({'phase': 'readback', 'arguments': arguments}))
            original = f.owner.phase.side_effect

            def phase(kind, value, *rest):
                if kind == 'readback':
                    self.assertGreater(len(json_frame({'phase': kind, 'arguments': value})),
                        coordinator.PHASE_INPUT_LIMIT)
                    raise ClaudeError('Synthetic original phase input refusal', code='phase_protocol_error')
                return original(kind, value, *rest)

            f.owner.phase.side_effect = phase
            with patch.object(coordinator, 'PHASE_INPUT_LIMIT', required if accepted else required - 1), \
                    patch.object(coordinator, 'readback_if_confirmed', wraps=phases.readback_if_confirmed) as local:
                result = f.account()
            self.assertEqual(local.call_count, 1 if accepted else 0)
            self.assertEqual(f.owner.phase.call_count, 1 if accepted else 2)
            if accepted:
                self.assertTrue(result['ok'])
            else:
                self.assertEqual(result['error']['code'], 'phase_protocol_error')

    def test_cancel_or_absolute_deadline_before_and_after_local_work_cannot_mark_available(self):
        for when in ('before', 'after'):
            for stop in ('cancel', 'deadline'):
                with self.subTest(when=when, stop=stop):
                    f = fixture()

                    def interrupt():
                        if stop == 'cancel':
                            f.cancel.set()
                        else:
                            f.clock = 500

                    browser = f.owner.browser.side_effect

                    def finish_browser(*args):
                        result = browser(*args)
                        if when == 'before':
                            interrupt()
                        return result

                    def render(**kwargs):
                        result = phases.readback_if_confirmed(**kwargs)
                        if when == 'after':
                            interrupt()
                        return result

                    f.owner.browser.side_effect = finish_browser
                    with patch.object(coordinator, 'readback_if_confirmed', side_effect=render) as local:
                        result = f.account()
                    self.assertEqual(result['error']['code'], 'stopped')
                    self.assertEqual(local.call_count, 0 if when == 'before' else 1)
                    self.assertEqual(f.owner.phase.call_count, 1)
                    self.assertNotIn('status:available', f.events)
                    self.assertEqual(f.store.save.call_args.args[0]['cookies'][0]['value'], 'browser')

    def test_local_refusal_and_cookie_persistence_failure_preserve_original_error(self):
        f = fixture()
        f.proof['confirmed_conversation']['is_temporary_chat'] = False
        f.store.save.side_effect = OSError('Synthetic persistence failure')
        result = f.account()
        self.assertEqual(result['error']['code'], 'privacy_not_verified')
        self.assertEqual(f.owner.phase.call_count, 1)
        f.owner.browser.assert_called_once()

    def test_successful_local_reply_still_fails_if_rotated_cookies_cannot_be_persisted(self):
        f = fixture()
        f.store.save.side_effect = OSError('Synthetic persistence failure')
        result = f.account()
        self.assertEqual(result['error']['code'], 'session_save_failed')
        self.assertEqual(f.owner.phase.call_count, 1)
        f.owner.browser.assert_called_once()

    def test_owned_fallback_cleanup_failure_still_quarantines_the_account(self):
        f = fixture()
        f.proof.pop('confirmed_conversation')
        original = f.owner.phase.side_effect

        def fail_cleanup(kind, *args):
            if kind == 'readback':
                raise ClaudeError('Synthetic phase cleanup failure', code='phase_cleanup_unconfirmed')
            return original(kind, *args)

        f.owner.phase.side_effect = fail_cleanup
        with f.patched():
            output = f.owner.execute(account_fixture.ROOT / account_fixture.ACCOUNT,
                f.request, f.cancel, 500)
        self.assertEqual(output['code'], 1)
        self.assertEqual(f.owner.phase.call_count, 2)
        self.assertTrue(f.lease.quarantined)
        self.assertTrue(f.owner.draining)

    def test_unverified_browser_cleanup_never_reaches_local_render_and_retains_quarantine(self):
        f = fixture()
        f.owner.browser.side_effect = ClaudeError('Synthetic cleanup failure', code='phase_cleanup_unconfirmed')
        with patch.object(coordinator, 'readback_if_confirmed') as local, f.patched():
            output = f.owner.execute(account_fixture.ROOT / account_fixture.ACCOUNT,
                f.request, f.cancel, 500)
        self.assertEqual(output['code'], 1)
        local.assert_not_called()
        self.assertTrue(f.lease.quarantined)
        self.assertTrue(f.owner.draining)
        self.assertEqual(f.owner.phase.call_count, 1)


if __name__ == '__main__':
    unittest.main()
