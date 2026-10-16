"""Cookie adoption matches the prior jar without temporary sessions or copies."""

import copy
from http.cookiejar import Cookie
import unittest
from unittest.mock import Mock, patch
from uuid import UUID

import requests

from claudfree.chatgpt.browser_request import adopt_cookies
from claudfree.chatgpt.http import ChatGPTHttp, PER_CHAT_COOKIES_KEPT, prune_per_chat_cookies


NOW = 2_000_000_000


def cookie(name, **changes):
    return {'name': name, 'value': 'fixture-only', 'domain': '.chatgpt.com',
        'path': '/', 'expires': NOW + 3600, 'secure': True,
        'httpOnly': False, 'sameSite': 'Lax', **changes}


def exported_cookies():
    cookies = [
        cookie('__Secure-next-auth.session-token.0'),
        cookie('__Secure-next-auth.session-token.1'),
        cookie('_uasid'), cookie('_umsid'),
        cookie('oai-did', value='initial-device'),
        cookie('outside-auth', domain='auth.openai.com', fixtureMetadata={'keep': True}),
        cookie('wrong-subdomain', domain='sub.chatgpt.com'),
        cookie('missing-domain', domain=''),
        cookie('expired', expires=NOW - 1),
        cookie('expires-now', expires=NOW),
        cookie('session-cookie', expires=-1),
        cookie('zero-expiry', expires=0),
        cookie('__Host-host-only', domain='chatgpt.com', httpOnly=True, sameSite='Strict'),
        cookie('subpath', path='/settings', secure=False, sameSite='None'),
        cookie('unusual-flags', secure=None, httpOnly=None, sameSite='unknown'),
        cookie('case-domain', domain='.CHATGPT.COM'),
        cookie('duplicate', value='earlier'),
        cookie('duplicate', value='later'),
        cookie('duplicate', value='other-path', path='/other'),
        cookie('duplicate', value='host-only', domain='chatgpt.com'),
        cookie('conv_key_not-a-uuid'),
    ]
    for index in range(PER_CHAT_COOKIES_KEPT + 5):
        identifier = str(UUID(int=index + 1))
        for family in ('conv_key_', 'history_off_'):
            cookies.append(cookie(family + identifier, expires=NOW + 7200 + index))
    return cookies


def legacy_restore(cookies):
    """The previous restoration boundary, retained as an independent parity oracle."""
    replacement = requests.Session()
    try:
        for entry in prune_per_chat_cookies(cookies):
            expiry = entry.get('expires', -1)
            if entry.get('domain', '').lstrip('.').lower() != 'chatgpt.com' or (
                expiry > 0 and expiry <= NOW
            ):
                continue
            replacement.cookies.set(entry['name'], entry['value'], domain=entry['domain'],
                path=entry.get('path', '/'), secure=entry.get('secure', True),
                expires=int(expiry) if expiry > 0 else None,
                rest={'HttpOnly': entry.get('httpOnly', False), 'SameSite': entry.get('sameSite', 'Lax')})
            if entry['name'] == 'oai-did':
                replacement.headers['OAI-Device-ID'] = entry['value']
        return replacement.cookies.copy(), {
            key: value for key, value in replacement.headers.items() if key == 'OAI-Device-ID'}
    finally:
        replacement.close()


def jar_values(jar):
    return [vars(entry) for entry in jar]


class CookieAdoptionTests(unittest.TestCase):
    def test_constructor_and_adoption_match_legacy_cookie_attributes_and_saved_state(self):
        cookies = exported_cookies()
        origins = [{'origin': 'https://chatgpt.com', 'localStorage': [
            {'name': 'fixture-key', 'value': 'fixture-value'}]}]
        with patch('claudfree.chatgpt.http.time.time', return_value=NOW):
            expected_jar, device_headers = legacy_restore(cookies)
            actual = ChatGPTHttp({'cookies': cookies, 'origins': origins})
            reference = ChatGPTHttp({'cookies': [], 'origins': origins})
            reference.session.cookies = expected_jar
            reference.original['cookies'] = copy.deepcopy(cookies)
            reference.session.headers.update(device_headers)
            try:
                self.assertEqual(jar_values(actual.session.cookies), jar_values(expected_jar))
                self.assertEqual(actual.session.headers['OAI-Device-ID'], device_headers['OAI-Device-ID'])
                self.assertEqual(actual.saved_state(), reference.saved_state())
                adopt_cookies(actual, cookies)
                self.assertEqual(jar_values(actual.session.cookies), jar_values(expected_jar))
                self.assertEqual(vars(actual.session.cookies.get_policy()), vars(expected_jar.get_policy()))
                self.assertEqual(actual.saved_state(), reference.saved_state())
                self.assertIs(actual.original['cookies'], cookies)
                self.assertIs(actual.original['origins'], origins)
                self.assertEqual(actual.original['cookies'], cookies)
                names = [entry.name for entry in actual.session.cookies]
                for excluded in ('outside-auth', 'wrong-subdomain', 'missing-domain', 'expired', 'expires-now'):
                    self.assertNotIn(excluded, names)
                for included in ('_uasid', '_umsid', '__Host-host-only', 'subpath', 'session-cookie', 'zero-expiry'):
                    self.assertIn(included, names)
                self.assertEqual(sum(name.startswith('history_off_') for name in names), PER_CHAT_COOKIES_KEPT)
                self.assertEqual(sum(name.startswith('conv_key_') for name in names), PER_CHAT_COOKIES_KEPT + 1)
                self.assertEqual(next(entry.value for entry in actual.session.cookies
                    if entry.name == 'duplicate' and entry.domain == '.chatgpt.com' and entry.path == '/'), 'later')
                self.assertIn('outside-auth', [entry['name'] for entry in actual.saved_state()['cookies']])
            finally:
                actual.close()
                reference.close()

    def test_adoption_preserves_existing_session_pools_headers_and_account_metadata(self):
        http = ChatGPTHttp({'cookies': [cookie('oai-did', value='existing-device')], 'origins': []})
        session = http.session
        adapters = dict(session.adapters)
        pools = {key: adapter.poolmanager for key, adapter in adapters.items()}
        http.account_key = 'fixture-account'
        http.account_label = 'Example account'
        http.account_email = 'example@example.test'
        http.preparations = object()
        metadata = (http.account_key, http.account_label, http.account_email, http.preparations)
        session.headers['Authorization'] = 'Bearer fixture-only'
        headers = dict(session.headers)
        incoming = [cookie('oai-did', value='renewed-device'), cookie('_uasid'), cookie('_umsid')]
        try:
            with patch.object(session, 'close', Mock(side_effect=AssertionError('Do not close the real session'))):
                adopt_cookies(http, incoming)
                self.assertIs(http.session, session)
                self.assertEqual(dict(session.headers), headers)
                self.assertEqual(session.headers['OAI-Device-ID'], 'existing-device')
                self.assertEqual((http.account_key, http.account_label, http.account_email, http.preparations), metadata)
                for key, adapter in adapters.items():
                    self.assertIs(session.adapters[key], adapter)
                    self.assertIs(adapter.poolmanager, pools[key])
                self.assertEqual(next(entry.value for entry in session.cookies if entry.name == 'oai-did'), 'renewed-device')
        finally:
            http.close()

    def test_adoption_allocates_no_temporary_session_adapter_or_duplicate_cookie(self):
        http = ChatGPTHttp({'cookies': []})
        incoming = [cookie('first'), cookie('second', path='/other'),
            cookie('third', domain='chatgpt.com'), cookie('expired', expires=NOW - 1),
            cookie('wrong-domain', domain='auth.openai.com')]
        original_copy = copy.copy
        duplicate_cookies = []

        def tracked_copy(value):
            if isinstance(value, Cookie):
                duplicate_cookies.append(value)
            return original_copy(value)

        create_cookie = requests.cookies.create_cookie
        try:
            with patch('claudfree.chatgpt.http.time.time', return_value=NOW), \
                    patch('requests.Session', Mock(side_effect=AssertionError('No temporary session'))), \
                    patch('requests.sessions.HTTPAdapter', Mock(side_effect=AssertionError('No temporary adapters'))), \
                    patch('requests.cookies.RequestsCookieJar.copy', Mock(side_effect=AssertionError('No copied jar'))), \
                    patch('claudfree.chatgpt.http.deepcopy', Mock(side_effect=AssertionError('No copied raw export'))), \
                    patch('requests.cookies.create_cookie', wraps=create_cookie) as created, \
                    patch('copy.copy', side_effect=tracked_copy):
                adopt_cookies(http, incoming)
            self.assertEqual(created.call_count, 3)
            self.assertEqual(len(http.session.cookies), 3)
            self.assertEqual(duplicate_cookies, [])
        finally:
            http.close()

    def test_empty_export_replaces_the_jar_without_changing_origins(self):
        origins = [{'origin': 'https://example.test', 'localStorage': []}]
        http = ChatGPTHttp({'cookies': [cookie('_uasid')], 'origins': origins})
        try:
            incoming = []
            adopt_cookies(http, incoming)
            self.assertEqual(list(http.session.cookies), [])
            self.assertIs(http.original['cookies'], incoming)
            self.assertIs(http.original['origins'], origins)
        finally:
            http.close()

    def test_invalid_export_does_not_replace_existing_jar_or_raw_metadata(self):
        http = ChatGPTHttp({'cookies': [cookie('_uasid')]})
        jar = http.session.cookies
        raw = http.original['cookies']
        invalid = cookie('invalid')
        del invalid['value']
        try:
            with self.assertRaises(KeyError):
                adopt_cookies(http, [invalid])
            self.assertIs(http.session.cookies, jar)
            self.assertIs(http.original['cookies'], raw)
        finally:
            http.close()


if __name__ == '__main__':
    unittest.main()
