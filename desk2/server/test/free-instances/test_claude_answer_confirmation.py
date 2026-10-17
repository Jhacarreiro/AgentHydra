"""Claude answers: a finished stream is kept when its stored copy is late; an unfinished stream still fails."""
import unittest
from unittest.mock import Mock, patch

from claudfree import http
from claudfree.http import ClaudeHttp, HttpError


class FakeClock:
    def __init__(self):
        self.now = 0.0
        self.sleeps = []

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.sleeps.append(seconds)
        self.now += seconds


class ConfirmAnswerTests(unittest.TestCase):
    def confirm(self, streamed, stream_finished, stream=None):
        """The stored copy never appears: the chat holds no new assistant message."""
        clock = FakeClock()
        client = ClaudeHttp({'cookies': [], 'origins': []}, session_factory=Mock())
        client.last_stream = stream or {'stop_reason': None, 'tool_calls': []}
        client.read = Mock(return_value={'is_temporary': True, 'chat_messages': []})
        with patch.object(http, 'time', clock):
            result = client._confirm_answer('org', 'chat', set(), None, streamed, stream_finished)
        return result, clock, client

    def test_a_finished_stream_with_a_late_stored_copy_returns_the_streamed_text_with_a_warning(self):
        (conversation, assistant, warning), clock, client = self.confirm('Example answer', True)
        self.assertEqual(warning, 'answer_unconfirmed')
        self.assertEqual(assistant['text'], 'Example answer')
        self.assertEqual(assistant['tool_calls'], [])
        self.assertIs(conversation['is_temporary'], True)
        self.assertAlmostEqual(sum(clock.sleeps), 15)
        self.assertEqual(client.read.call_count, len(clock.sleeps) + 1)

    def test_an_unconfirmed_reply_with_an_unknown_or_max_tokens_stop_is_not_reported_complete(self):
        for stop in (None, 'max_tokens', 'max_output_tokens'):
            with self.subTest(stop=stop):
                (_, assistant, warning), _, _ = self.confirm('Example answer', True, {'stop_reason': stop, 'tool_calls': []})
                self.assertEqual(warning, 'answer_unconfirmed')
                self.assertIs(assistant['truncated'], True)
                self.assertEqual(assistant['stop_reason'], stop)

    def test_an_unconfirmed_reply_keeps_the_streams_stop_reason_and_tool_calls(self):
        call = {'type': 'tool_use', 'id': 'toolu_example', 'name': 'example_tool', 'input': {'a': 1}}
        (_, assistant, _), _, _ = self.confirm('Example answer', True, {'stop_reason': 'tool_use', 'tool_calls': [call]})
        self.assertIs(assistant['truncated'], False)
        self.assertEqual(assistant['stop_reason'], 'tool_use')
        self.assertEqual(assistant['tool_calls'], [call])

    def test_the_stream_reader_collects_stop_reason_and_tool_input(self):
        seen = {'stop_reason': None, 'blocks': {}, 'partials': {}}
        for kind, event in [
            ('content_block_start', {'index': 1, 'content_block': {'type': 'tool_use', 'id': 'toolu_example', 'name': 'example_tool'}}),
            ('content_block_delta', {'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': '{"a":'}}),
            ('content_block_delta', {'index': 1, 'delta': {'type': 'input_json_delta', 'partial_json': ' 1}'}}),
            ('message_delta', {'delta': {'stop_reason': 'tool_use'}}),
        ]:
            http._note_stream_event(seen, event, kind)
        summary = http._stream_summary(seen)
        self.assertEqual(summary['stop_reason'], 'tool_use')
        self.assertEqual(summary['tool_calls'][0]['input'], {'a': 1})

    def test_the_stored_copy_is_polled_with_backoff_from_point_two_to_one_second(self):
        _, clock, _ = self.confirm('Example answer', True)
        for actual, expected in zip(clock.sleeps, [0.2, 0.4, 0.8, 1.0]):
            self.assertAlmostEqual(actual, expected)
        self.assertTrue(all(0 < seconds <= 1.0 for seconds in clock.sleeps))

    def test_an_unfinished_or_empty_stream_still_fails_with_answer_not_confirmed(self):
        for streamed, finished in [('Example answer', False), ('', True), ('   ', True)]:
            with self.subTest(streamed=streamed, finished=finished):
                with self.assertRaises(HttpError) as error:
                    self.confirm(streamed, finished)
                self.assertEqual(error.exception.code, 'answer_not_confirmed')


if __name__ == '__main__':
    unittest.main()
