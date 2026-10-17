"""Closed link tokens keep their rendering; unfinished suffixes are never rescanned."""

import random
import re
import unittest
from unittest.mock import Mock, patch

from claudfree.chatgpt import http


TOKEN = re.compile(r"\ue200url\ue202([^\ue202]+)\ue202(https?://[^\ue201]+)\ue201")
OPEN = '\ue200url\ue202'
CLOSE = '\ue201'
SEP = '\ue202'


def legacy(text):
    return TOKEN.sub(r"[\1](\2)", text)


class LinkRenderingTests(unittest.TestCase):
    def test_visible_messages_preserve_text_code_and_citations(self):
        text = f'{OPEN}Example source{SEP}https://example.test/source{CLOSE}\n```text\nvalue\n```\n'
        unfinished = f'{OPEN}Unfinished{SEP}https://example.test/unfinished'
        message = {'id': 'example-message', 'author': {'role': 'assistant'},
            'content': {'content_type': 'text', 'parts': [text, unfinished]},
            'status': 'finished_successfully'}
        for rich in (False, True):
            with self.subTest(rich=rich):
                result = http._visible_message(message, rich=rich)
                self.assertEqual(result['text'], legacy(text + unfinished))
                if rich:
                    self.assertEqual(result['content'], [{'type': 'text', 'text': result['text']}])
                    self.assertEqual(result['code_blocks'], [{'language': 'text', 'code': 'value\n'}])
                    self.assertEqual([c['url'] for c in result['citations']],
                        ['https://example.test/source', 'https://example.test/unfinished'])
                else:
                    self.assertNotIn('content', result)

    def test_exact_legacy_semantics_for_closed_nested_empty_and_malformed_tokens(self):
        cases = ['', 'plain text', CLOSE, OPEN, OPEN + SEP + 'https://example.test' + CLOSE,
            OPEN + 'title' + SEP + 'http://' + CLOSE,
            OPEN + 'title' + SEP + 'https://' + CLOSE,
            OPEN + 'title' + SEP + 'HTTP://example.test' + CLOSE,
            OPEN + 'title\nnext' + SEP + 'http://example.test\nmore' + CLOSE,
            OPEN + 'title' + CLOSE + SEP + 'https://example.test' + CLOSE,
            OPEN + 'outer' + OPEN + 'inner' + SEP + 'https://example.test' + CLOSE,
            OPEN + 'title' + SEP + 'https://' + OPEN + 'nested' + SEP + 'https://example.test' + CLOSE,
            OPEN + 'title' + SEP + 'https://example.test' + CLOSE + OPEN + 'partial' + SEP + 'https://example.test']
        for text in cases:
            with self.subTest(text=text):
                self.assertEqual(http._render_links(text), legacy(text))

    def test_deterministic_fragment_fuzz_matches_the_previous_renderer(self):
        rng = random.Random(731)
        fragments = [OPEN, CLOSE, SEP, '\ue200', 'url', 'http://', 'https://',
            'https://example.test/', 'x', '\n', '\\1', '[', ')', '世界', 'é']
        for _ in range(2500):
            text = ''.join(rng.choices(fragments, k=rng.randrange(1, 45)))
            self.assertEqual(http._render_links(text), legacy(text))

    def test_snapshot_sized_unclosed_tail_is_excluded_from_regex_work(self):
        opener = OPEN + 'Example' + SEP + 'https://example.test/'
        tail = opener * (http.CONFIRMED_CONVERSATION_MAX_BYTES // len(opener))
        closed = opener + CLOSE
        matcher = Mock(wraps=TOKEN)
        with patch.object(http, '_LINK_TOKEN', matcher):
            self.assertIs(http._render_links(tail), tail)
            matcher.sub.assert_not_called()
            self.assertEqual(http._render_links(closed + tail), legacy(closed) + tail)
        matcher.sub.assert_called_once_with(r"[\1](\2)", closed)


if __name__ == '__main__':
    unittest.main()
