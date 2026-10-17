"""ChatGPT Free sends: the website's prepared request is kept, its text and privacy flag are ours.

A refusal keeps the real reason and names the step that failed, and its diagnostic never carries prompt text.
"""
import asyncio
import base64
import json
import unicodedata
import unittest
from copy import deepcopy
from itertools import count
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch
from uuid import uuid4

from claudfree.chatgpt import browser_request as br
from claudfree.chatgpt.browser_request import (TEMPORARY_CLICK, _answer_conversation_request, _prepared_request,
    _select_temporary_chat, _submit_deadline)
from claudfree.chatgpt.http import BASE, TEXT_MODEL
from claudfree.errors import ClaudeError

PROMPT = 'Example prompt line one\nline two with ü\n'
HEADERS = {'authorization': 'Bearer fixture-only'}


def website_body(text, *, action='next', messages=None, existing=None):
    """What the website prepares: its own text, its own privacy flag, the chat and branch it is on."""
    message = {'id': str(uuid4()), 'author': {'role': 'user'}, 'content': {'content_type': 'text', 'parts': [text]}}
    body = {'action': action, 'messages': [message] if messages is None else messages,
        'parent_message_id': str(uuid4()), 'model': 'website-default', 'history_and_training_disabled': False}
    if existing:
        body['conversation_id'] = existing['conversation_id']
        body['parent_message_id'] = existing['current_node']
    return body


def event(body, *, network_id='network-1', headers=HEADERS):
    post_data = body if isinstance(body, str) else json.dumps(body)
    request = SimpleNamespace(url=BASE + '/backend-api/f/conversation', method='POST',
        headers=dict(headers), post_data=post_data)
    return SimpleNamespace(request=request, network_id=network_id, request_id='request-1')


def answer(body, *, prompt=PROMPT, existing=None, network_id='network-1', headers=HEADERS, page_private=True):
    """Run the intercepted request through the real handler; return the outcome and what the tab sent."""
    async def run():
        captured = asyncio.get_running_loop().create_future()
        dispatch = {'network_id': None, 'status': None, 'sent': False}
        tab = SimpleNamespace(send=AsyncMock())
        zd = Mock()
        await _answer_conversation_request(tab, zd, event(body, network_id=network_id, headers=headers),
            captured=captured, dispatch=dispatch, prompt=prompt, model=TEXT_MODEL, existing=existing, temporary=True, page_private=page_private)
        return captured, dispatch, zd
    return asyncio.run(run())


def sent_body(zd):
    return json.loads(base64.b64decode(zd.cdp.fetch.continue_request.call_args.kwargs['post_data']))


class PreparedSendTests(unittest.TestCase):
    def test_website_text_differing_only_in_line_endings_spaces_or_form_is_sent_as_the_exact_prompt(self):
        website = unicodedata.normalize('NFD', PROMPT.replace('\n', '\r\n')) + '   \r\n'
        captured, dispatch, zd = answer(website_body(website))
        self.assertTrue(dispatch['sent'])
        self.assertIsNone(captured.exception())
        sent = sent_body(zd)
        self.assertEqual(sent['messages'][0]['content'], {'content_type': 'text', 'parts': [PROMPT]})
        self.assertIs(sent['history_and_training_disabled'], True)
        self.assertEqual(captured.result()[0]['messages'][0]['content']['parts'], [PROMPT])

    def test_continuation_keeps_the_website_chat_and_branch_and_sends_the_exact_prompt(self):
        existing = {'conversation_id': str(uuid4()), 'current_node': str(uuid4()), 'is_temporary_chat': True}
        captured, dispatch, zd = answer(website_body(PROMPT.replace('\n', '\r\n'), existing=existing),
            existing=existing, page_private=False)
        self.assertIsNone(captured.exception())
        self.assertTrue(dispatch['sent'])
        sent = sent_body(zd)
        self.assertEqual(sent['conversation_id'], existing['conversation_id'])
        self.assertEqual(sent['parent_message_id'], existing['current_node'])
        self.assertEqual(sent['messages'][0]['content']['parts'], [PROMPT])

    def test_a_continued_chat_that_is_not_temporary_is_refused_before_dispatch(self):
        existing = {'conversation_id': str(uuid4()), 'current_node': str(uuid4()), 'is_temporary_chat': False}
        body = website_body(PROMPT, existing=existing)
        body['history_and_training_disabled'] = True
        for existing_chat in (existing, {k: v for k, v in existing.items() if k != 'is_temporary_chat'}):
            with self.subTest(existing=existing_chat):
                captured, dispatch, zd = answer(body, existing=existing_chat)
                self.assertFalse(dispatch['sent'])
                zd.cdp.fetch.continue_request.assert_not_called()
                error = captured.exception()
                self.assertEqual(error.code, 'privacy_not_verified')
                self.assertIn('No message was sent.', str(error))

    def test_without_page_or_body_evidence_of_a_private_chat_nothing_is_sent(self):
        captured, dispatch, zd = answer(website_body(PROMPT), page_private=False)
        self.assertFalse(dispatch['sent'])
        zd.cdp.fetch.continue_request.assert_not_called()
        error = captured.exception()
        self.assertEqual(error.code, 'privacy_not_verified')
        self.assertIn('did not confirm Temporary Chat', str(error))
        self.assertIn('No message was sent.', str(error))

    def test_the_websites_own_private_flag_is_evidence_without_the_page_state(self):
        body = website_body(PROMPT)
        body['history_and_training_disabled'] = True
        captured, dispatch, zd = answer(body, page_private=False)
        self.assertTrue(dispatch['sent'])
        self.assertIs(sent_body(zd)['history_and_training_disabled'], True)

    def test_the_url_hint_is_not_evidence_of_temporary_mode(self):
        self.assertNotIn('temporary-chat', br.TEMPORARY)
        self.assertNotIn('location', br.TEMPORARY)

    def test_two_messages_or_a_wrong_action_are_refused_before_dispatch_and_name_the_check(self):
        two = website_body(PROMPT)
        two['messages'].append(deepcopy(two['messages'][0]))
        cases = {'messages=2': two, 'action=variant': website_body(PROMPT, action='variant')}
        for expected, body in cases.items():
            with self.subTest(expected=expected):
                captured, dispatch, zd = answer(body)
                self.assertFalse(dispatch['sent'])
                zd.cdp.fetch.continue_request.assert_not_called()
                error = captured.exception()
                self.assertIsInstance(error, ClaudeError)
                self.assertEqual(error.code, 'browser_preparation_invalid')
                self.assertIn('No message was sent.', str(error))
                self.assertIn(expected, str(error))

    def test_a_refusal_keeps_the_inner_claude_error_code_and_message(self):
        refusal = ClaudeError('The website did not confirm Temporary Chat. No message was sent.', code='privacy_not_verified')
        with patch.object(br, 'validate', side_effect=refusal):
            captured, dispatch, zd = answer(website_body(PROMPT))
        self.assertFalse(dispatch['sent'])
        error = captured.exception()
        self.assertEqual(error.code, 'privacy_not_verified')
        self.assertIn('did not confirm Temporary Chat', str(error))
        self.assertIn('No message was sent.', str(error))

    def test_a_non_claude_failure_names_its_step_under_browser_preparation_invalid(self):
        captured, dispatch, zd = answer(website_body(PROMPT), network_id=None)
        self.assertFalse(dispatch['sent'])
        error = captured.exception()
        self.assertEqual(error.code, 'browser_preparation_invalid')
        self.assertIn('at network_id', str(error))
        self.assertIn('No message was sent.', str(error))
        captured, dispatch, zd = answer('not json')
        self.assertIn('at parse_post_data', str(captured.exception()))

    def test_refusal_diagnostic_never_carries_prompt_or_website_text(self):
        prompt_marker = 'PROMPT-MARKER-4c1e'
        website_marker = 'WEBSITE-MARKER-9b2d'
        prompt = prompt_marker + ' ' + 'x' * 50
        two = website_body(website_marker)
        two['messages'].append(deepcopy(two['messages'][0]))
        cases = [
            (two, {}),
            (website_body(website_marker, action='variant'), {}),
            (website_body(website_marker), {'network_id': None}),
            ('not json ' + website_marker, {}),
        ]
        for body, options in cases:
            with self.subTest(body=str(body)[:40], options=options):
                captured, _, _ = answer(body, prompt=prompt, **options)
                message = str(captured.exception())
                self.assertIn('No message was sent.', message)
                self.assertNotIn(prompt_marker, message)
                self.assertNotIn(website_marker, message)

    def test_diagnostic_reports_text_equality_by_flags_and_lengths_not_by_text(self):
        website = PROMPT.replace('\n', '\r\n') + '  '
        diagnostic = br._prepared_diagnostic(json.dumps(website_body(website)), 'post_data', PROMPT)
        self.assertIn('text_equal=False', diagnostic)
        self.assertIn('text_equal_normalised=True', diagnostic)
        self.assertIn(f'prompt_chars={len(PROMPT)}', diagnostic)
        self.assertIn(f'part_chars={len(website)}', diagnostic)
        self.assertIn('history_and_training_disabled=false', diagnostic)
        self.assertIn('conversation_id=absent', diagnostic)
        self.assertIn('post_data=post_data', diagnostic)
        self.assertNotIn('Example', diagnostic)

    def test_diagnostic_never_raises_on_a_body_json_cannot_parse(self):
        for raw in ('[' * 200000, 'not json', None):
            with self.subTest(raw=str(raw)[:10]):
                self.assertIn('body=unreadable' if raw else 'action=other', br._prepared_diagnostic(raw, 'post_data', PROMPT))

    def test_prepared_request_substitutes_the_text_and_privacy_flag_on_a_direct_call(self):
        event_ = event(website_body('Website text'))
        payload, headers = _prepared_request(event_, json.dumps(website_body('Website text')), PROMPT,
            TEXT_MODEL, None, True, [], True)
        self.assertEqual(payload['messages'][0]['content'], {'content_type': 'text', 'parts': [PROMPT]})
        self.assertIs(payload['history_and_training_disabled'], True)
        self.assertEqual(payload['model'], TEXT_MODEL)
        self.assertEqual(headers['authorization'], 'Bearer fixture-only')


class FakeTab:
    def __init__(self, states):
        self.states = list(states)
        self.clicks = 0

    async def evaluate(self, script):
        # Any script that clicks counts, whatever its wording.
        if 'click()' in script:
            self.clicks += 1
            return True
        return self.states.pop(0)


class TemporaryChatTests(unittest.TestCase):
    def test_a_page_already_in_temporary_mode_is_not_clicked(self):
        tab = FakeTab(['on'])
        self.assertIs(asyncio.run(_select_temporary_chat(tab, True, None)), True)
        self.assertEqual(tab.clicks, 0)

    def test_a_button_that_stays_off_is_never_taken_as_private(self):
        clock = count(0, 2.0)
        tab = FakeTab(['off'] * 20)
        with patch.object(br, 'time', SimpleNamespace(monotonic=lambda: next(clock))):
            with self.assertRaises(ClaudeError) as error:
                asyncio.run(_select_temporary_chat(tab, True, None))
        self.assertEqual(error.exception.code, 'privacy_not_verified')
        self.assertEqual(tab.clicks, 1)

    def test_the_composer_gate_counts_utf16_units_like_the_page(self):
        prompt = '\U0001F600' * 3
        async def run(composer_length):
            seen = []
            async def evaluate(script):
                if script == br.COMPOSER_LENGTH:
                    return composer_length
                seen.append(script)
                return True
            tab = SimpleNamespace(evaluate=evaluate, send=AsyncMock())
            await br._submit_prompt(tab, Mock(), prompt)
            return seen
        self.assertIn(br.SUBMIT, asyncio.run(run(6)))
        clock = count(0, 5.0)
        with patch.object(br, 'time', SimpleNamespace(monotonic=lambda: next(clock))):
            with self.assertRaises(ClaudeError):
                asyncio.run(run(3))

    def test_the_page_is_polled_until_temporary_mode_shows_and_clicked_once(self):
        tab = FakeTab(['missing', 'off', 'off', 'on'])
        asyncio.run(_select_temporary_chat(tab, True, None))
        self.assertEqual(tab.clicks, 1)
        self.assertEqual(tab.states, [])

    def test_temporary_mode_that_never_shows_fails_before_sending(self):
        clock = count(0, 2.0)
        tab = FakeTab(['missing'] * 20)
        with patch.object(br, 'time', SimpleNamespace(monotonic=lambda: next(clock))):
            with self.assertRaises(ClaudeError) as error:
                asyncio.run(_select_temporary_chat(tab, True, None))
        self.assertEqual(error.exception.code, 'privacy_not_verified')
        self.assertIn('No message was sent.', str(error.exception))

    def test_the_submit_deadline_grows_with_the_prompt_to_at_most_forty_seconds(self):
        self.assertAlmostEqual(_submit_deadline('x'), 8, places=2)
        self.assertAlmostEqual(_submit_deadline('x' * 8000), 12, places=2)
        self.assertEqual(_submit_deadline('x' * 200000), 40)


if __name__ == '__main__':
    unittest.main()
