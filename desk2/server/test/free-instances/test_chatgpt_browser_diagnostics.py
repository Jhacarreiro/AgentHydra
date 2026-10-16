"""Readiness evidence uses synthetic DOM, local fetch stubs and a fake wait clock."""

import asyncio
import json
import os
import shutil
import subprocess
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

from claudfree.chatgpt import browser_request
from claudfree.errors import ClaudeError


DOM_RUNNER = r'''
import { readFileSync } from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
const results={};
for(const [name,fixture] of Object.entries(input.cases)){
 let calls=0;const timeouts=[];
 const state={readyState:'complete',...fixture.dom};
 const elements=(value,text='')=>!value?[]:[{
  getClientRects:()=>value==='hidden'?[]:[{}],
  visibility:value==='css-hidden'?'hidden':'visible',innerText:text
 }];
 const document={get readyState(){return state.readyState;},querySelectorAll(selector){
  if(selector.startsWith('[role="textbox"]'))return elements(state.composer);
  if(selector.startsWith('input[type="email"]'))return elements(state.login);
  if(selector.startsWith('iframe['))return elements(state.iframeChallenge);
  if(selector==='h1,h2,[role="alert"]')return elements(state.headingChallenge,
   fixture.headingText??'Verify you are human');
  throw new Error('Unexpected DOM query');
 }};
 const fetch=async(url,options)=>{
  if(url!=='/api/auth/session'||options.signal!==3000)throw new Error('Unexpected request');
  calls++;
  if(fixture.afterFetch)Object.assign(state,fixture.afterFetch);
  if(fixture.fetchError){const error=new Error('PRIVATE_ERROR_TEXT');
   error.name=fixture.errorName??'Error';throw error;}
  return {ok:fixture.ok!==false,status:fixture.status??200,json:async()=>{
   if(fixture.jsonError){const error=new SyntaxError('PRIVATE_JSON_TEXT');
    error.name=fixture.jsonErrorName??'SyntaxError';throw error;}
   return fixture.session??{user:{email:'owner@example.test'},accessToken:'synthetic-session'};
  }};
 };
 const proof=await new Function('document','getComputedStyle','fetch','AbortSignal',
  'return '+input.source)(document,e=>({visibility:e.visibility}),fetch,
   {timeout:ms=>{timeouts.push(ms);return ms;}});
 results[name]={proof,calls,timeouts};
}
process.stdout.write(JSON.stringify(results));
'''


class BrowserReadinessDiagnosticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bun = shutil.which('bun')
        if not bun:
            raise RuntimeError('Bun is required for the offline readiness fixture')
        cases = {
            'http_401': {'dom': {'composer': True}, 'ok': False, 'status': 401},
            'http_503': {'dom': {'composer': True}, 'ok': False, 'status': 503},
            'login_http_error': {'dom': {'login': True}, 'ok': False, 'status': 503},
            'challenge_fetch_error': {'dom': {'iframeChallenge': True}, 'fetchError': True},
            'changed_error': {'dom': {'composer': True}, 'fetchError': True,
                'afterFetch': {'composer': False, 'login': True, 'headingChallenge': True}},
            'wrong_identity': {'dom': {'composer': True, 'login': True, 'iframeChallenge': True},
                'session': {'user': {'email': 'other@example.test'}, 'accessToken': 'synthetic'}},
            'invalid_json': {'dom': {'composer': True}, 'jsonError': True},
            'body_timeout': {'dom': {'composer': True}, 'jsonError': True,
                'jsonErrorName': 'TimeoutError'},
            'fetch_timeout': {'dom': {'composer': True}, 'fetchError': True,
                'errorName': 'TimeoutError'},
            'hidden_challenge': {'dom': {'composer': True, 'iframeChallenge': 'hidden',
                'headingChallenge': 'css-hidden'}, 'ok': False, 'status': 503},
            'ordinary_heading': {'dom': {'headingChallenge': True},
                'headingText': 'PRIVATE_PAGE_TEXT'},
            'unrecognized_state_status': {'dom': {'composer': True, 'readyState': 'PRIVATE_PAGE_TEXT'},
                'ok': False, 'status': 'https://example.test/private?token=synthetic'},
        }
        result = subprocess.run([bun, '-e', DOM_RUNNER],
            input=json.dumps({'source': browser_request.READY, 'cases': cases}),
            capture_output=True, text=True, timeout=10, check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        cls.results = json.loads(result.stdout)

    def test_http_failures_alone_never_claim_login_or_interactive_verification(self):
        for status in (401, 503):
            with self.subTest(status=status):
                result = self.results[f'http_{status}']
                self.assertEqual(result, {
                    'proof': {'ready': False, 'login': False, 'challenge': False,
                        'diagnostic': {'document_state': 'complete', 'composer': True,
                            'session': 'http_error', 'http_status': status}},
                    'calls': 1, 'timeouts': [3000]})
                browser_request._refuse_unready_proof(
                    SimpleNamespace(account_email='owner@example.test'), result['proof'])

    def test_real_visible_cues_survive_session_failure_and_identity_still_wins(self):
        for name, code in (
                ('login_http_error', 'login_required'),
                ('challenge_fetch_error', 'browser_verification_required'),
                ('changed_error', 'browser_verification_required'),
                ('wrong_identity', 'login_account_mismatch')):
            with self.subTest(name=name):
                result = self.results[name]
                with self.assertRaises(ClaudeError) as raised:
                    browser_request._refuse_unready_proof(
                        SimpleNamespace(account_email='owner@example.test'), result['proof'])
                self.assertEqual(raised.exception.code, code)
                self.assertEqual(result['calls'], 1)
                self.assertEqual(result['timeouts'], [3000])
        changed = self.results['changed_error']['proof']
        self.assertEqual(changed, {'ready': False, 'login': True, 'challenge': True,
            'diagnostic': {'document_state': 'complete', 'composer': False,
                'session': 'fetch_error'}})

    def test_json_fetch_and_hidden_states_return_only_bounded_passive_facts(self):
        self.assertEqual(self.results['invalid_json']['proof']['diagnostic'], {
            'document_state': 'complete', 'composer': True,
            'session': 'invalid_json', 'http_status': 200})
        self.assertEqual(self.results['fetch_timeout']['proof']['diagnostic'], {
            'document_state': 'complete', 'composer': True, 'session': 'fetch_timeout'})
        self.assertEqual(self.results['body_timeout']['proof']['diagnostic'], {
            'document_state': 'complete', 'composer': True,
            'session': 'fetch_timeout', 'http_status': 200})
        hidden = self.results['hidden_challenge']['proof']
        self.assertFalse(hidden['challenge'])
        self.assertFalse(hidden['login'])
        browser_request._refuse_unready_proof(
            SimpleNamespace(account_email='owner@example.test'), hidden)
        self.assertEqual(self.results['ordinary_heading'], {
            'proof': {'ready': False, 'login': False, 'challenge': False,
                'diagnostic': {'document_state': 'complete', 'composer': False, 'session': 'skipped'}},
            'calls': 0, 'timeouts': []})
        self.assertEqual(self.results['unrecognized_state_status']['proof']['diagnostic'], {
            'document_state': 'unknown', 'composer': True, 'session': 'http_error'})
        for result in self.results.values():
            diagnostic = json.dumps(result['proof']['diagnostic'])
            for private in ('PRIVATE_', 'owner@example.test', 'other@example.test',
                    'synthetic-session', 'https://'):
                self.assertNotIn(private, diagnostic)


def proof(state='complete', composer=False, session='skipped', **extra):
    return {'ready': False, 'login': False, 'challenge': False,
        'diagnostic': {'document_state': state, 'composer': composer, 'session': session, **extra}}


class BrowserComposerWaitDiagnosticTests(unittest.IsolatedAsyncioTestCase):
    async def timed_out(self, outcomes):
        clock = [0.0]

        async def sleep(seconds):
            self.assertEqual(seconds, .3)
            clock[0] += seconds

        tab = SimpleNamespace(evaluate=AsyncMock(side_effect=outcomes))
        wait = AsyncMock(wraps=asyncio.wait_for)
        runtime = SimpleNamespace(sleep=sleep, wait_for=wait, TimeoutError=asyncio.TimeoutError)
        with patch.object(browser_request, 'time', SimpleNamespace(monotonic=lambda: clock[0])), \
                patch.object(browser_request, 'asyncio', runtime), \
                self.assertRaises(ClaudeError) as raised:
            await browser_request._wait_for_composer(
                SimpleNamespace(timeout=1, account_email='owner@example.test'), tab)
        self.assertEqual(raised.exception.code, 'browser_preparation_timeout')
        self.assertEqual(tab.evaluate.await_count, 4)
        for call in tab.evaluate.await_args_list:
            self.assertEqual(call.args, (browser_request.READY,))
            self.assertEqual(call.kwargs, {'await_promise': True})
        self.assertTrue(all(call.args[1] == 5 for call in wait.await_args_list))
        self.assertLess(len(str(raised.exception)), 512)
        return str(raised.exception)

    async def test_latest_complete_observation_and_later_evaluation_failures_are_distinct(self):
        message = await self.timed_out([
            proof('loading'), proof(composer=True, session='http_error', http_status=503),
            asyncio.TimeoutError(), RuntimeError('PRIVATE_ERROR_TEXT owner@example.test')])
        self.assertIn('Last DOM proof (poll 2): state=complete, composer=present, session=http_error', message)
        self.assertIn('session HTTP=503', message)
        self.assertIn('Polls=4; evaluation timeouts=1; evaluation errors=1; last evaluation=error', message)
        self.assertNotIn('state=loading', message)
        self.assertNotIn('PRIVATE_', message)
        self.assertNotIn('owner@example.test', message)

    async def test_most_recent_proof_replaces_older_loading_or_http_failure(self):
        message = await self.timed_out([
            proof('loading'), proof(session='http_error', http_status=401),
            proof('interactive'), proof(composer=True, session='ok', authorized=False, identity=True)])
        self.assertIn('Last DOM proof (poll 4): state=complete, composer=present, session=ok', message)
        self.assertIn('authorized=missing, identity=present', message)
        self.assertIn('evaluation timeouts=0; evaluation errors=0; last evaluation=proof', message)
        self.assertNotIn('HTTP=401', message)
        self.assertNotIn('state=loading', message)

    async def test_all_failed_evaluations_report_no_dom_proof_without_error_text(self):
        message = await self.timed_out([
            asyncio.TimeoutError(), RuntimeError('PRIVATE_PROVIDER_TEXT'), None, asyncio.TimeoutError()])
        self.assertIn('No DOM proof was obtained.', message)
        self.assertIn('evaluation timeouts=2; evaluation errors=1; last evaluation=timeout', message)
        self.assertNotIn('Last DOM proof', message)
        self.assertNotIn('PRIVATE_', message)

    async def test_untrusted_diagnostic_fields_never_reach_terminal_message(self):
        unsafe = proof('PRIVATE_PAGE_TEXT', session='https://example.test/private?token=synthetic',
            http_status='PRIVATE_STATUS', email='owner@example.test', error='PRIVATE_ERROR_TEXT')
        message = await self.timed_out([unsafe] * 4)
        self.assertIn('No DOM proof was obtained.', message)
        self.assertIn('last evaluation=no proof', message)
        for private in ('PRIVATE_', 'owner@example.test', 'https://', 'token='):
            self.assertNotIn(private, message)

    async def test_verified_success_and_cancellation_do_not_wait_or_submit_anything_else(self):
        ready = proof(composer=True, session='ok', authorized=True, identity=True)
        ready.update(ready=True, email='owner@example.test')
        tab = SimpleNamespace(evaluate=AsyncMock(return_value=ready))
        await browser_request._wait_for_composer(
            SimpleNamespace(timeout=1, account_email='owner@example.test'), tab)
        self.assertEqual(tab.evaluate.await_count, 1)
        tab.evaluate = AsyncMock(side_effect=asyncio.CancelledError())
        with self.assertRaises(asyncio.CancelledError):
            await browser_request._wait_for_composer(
                SimpleNamespace(timeout=1, account_email='owner@example.test'), tab)
        self.assertEqual(tab.evaluate.await_count, 1)


if __name__ == '__main__':
    unittest.main()
