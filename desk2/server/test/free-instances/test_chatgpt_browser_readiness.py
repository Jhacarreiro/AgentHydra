"""Exercise readiness JavaScript with synthetic DOM and local fetches only."""

import json
import os
import shutil
import subprocess
from types import SimpleNamespace
import unittest

from claudfree.chatgpt import browser_request
from claudfree.errors import ClaudeError


# Previous ordering is the oracle whenever a visible cue makes identity relevant.
LEGACY_READY = r'''(async()=>{
 const r=await fetch('/api/auth/session',{signal:AbortSignal.timeout(3000)});
 if(!r.ok)return null;const s=await r.json();
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const composer=[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')].find(visible);
 return {email:s.user?.email,ready:document.readyState==='complete'&&!!s.accessToken&&!!composer,
 login:[...document.querySelectorAll('input[type="email"],input[type="password"]')].some(visible),
 challenge:[...document.querySelectorAll('iframe[src*="hcaptcha.com"][title*="challenge"],iframe[src*="recaptcha"][title*="challenge"]')].some(visible)||
  [...document.querySelectorAll('h1,h2,[role="alert"]')].some(e=>visible(e)&&/verify you are human|complete the captcha|verification required/i.test(e.innerText))};
})()'''

DOM_RUNNER = r'''
import { readFileSync } from 'node:fs';
const input=JSON.parse(readFileSync(0,'utf8'));
async function evaluate(source,fixture){
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
  if(fixture.fetchError)throw new Error('Synthetic session unavailable');
  if(fixture.afterFetch)Object.assign(state,fixture.afterFetch);
  return {ok:fixture.ok!==false,json:async()=>fixture.session??{
   user:{email:'owner@example.test'},accessToken:'synthetic-session'
  }};
 };
 try{
  const proof=await new Function('document','getComputedStyle','fetch','AbortSignal',
   'return '+source)(document,e=>({visibility:e.visibility}),fetch,
    {timeout:ms=>{timeouts.push(ms);return ms;}});
  return {proof,calls,timeouts};
 }catch(error){return {error:error.message,calls,timeouts};}
}
const output={};
for(const [name,fixture] of Object.entries(input.cases)){
 output[name]={current:await evaluate(input.source,fixture),
  legacy:await evaluate(input.oracle,fixture)};
}
output.loading_sequence={};
for(const [name,source] of [['current',input.source],['legacy',input.oracle]]){
 let calls=0;
 for(let poll=0;poll<20;poll++)calls+=(await evaluate(source,input.cases.loading)).calls;
 const final=await evaluate(source,input.cases.ready);
 output.loading_sequence[name]={calls:calls+final.calls,proof:final.proof};
}
process.stdout.write(JSON.stringify(output));
'''


class BrowserReadinessTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        bun = shutil.which('bun')
        if not bun:
            raise RuntimeError('Bun is required for the offline readiness JavaScript fixture')
        cls.cases = {
            'loading': {'dom': {'readyState': 'loading'}},
            'blank_complete': {'dom': {}},
            'hidden': {'dom': {'composer': 'hidden', 'login': 'css-hidden',
                'iframeChallenge': 'hidden', 'headingChallenge': 'css-hidden'}},
            'ready': {'dom': {'composer': True}},
            'incomplete_composer': {'dom': {'composer': True, 'readyState': 'loading'}},
            'login': {'dom': {'login': True}},
            'iframe_challenge': {'dom': {'iframeChallenge': True}},
            'heading_challenge': {'dom': {'headingChallenge': True}},
            'ordinary_heading': {'dom': {'headingChallenge': True},
                'headingText': 'Welcome to the synthetic page'},
            'no_token': {'dom': {'composer': True},
                'session': {'user': {'email': 'owner@example.test'}}},
            'no_email': {'dom': {'composer': True}, 'session': {'accessToken': 'synthetic'}},
            'non_ok': {'dom': {'login': True, 'iframeChallenge': True}, 'ok': False},
            'fetch_error': {'dom': {'composer': True}, 'fetchError': True},
            'dom_changed': {'dom': {'composer': True},
                'afterFetch': {'composer': False, 'login': True, 'iframeChallenge': True}},
            'mismatch': {'dom': {'composer': True, 'login': True, 'iframeChallenge': True},
                'session': {'user': {'email': 'other@example.test'}, 'accessToken': 'synthetic'}},
            'challenge_and_login': {'dom': {'login': True, 'iframeChallenge': True}},
        }
        result = subprocess.run([bun, '-e', DOM_RUNNER], input=json.dumps({
            'source': browser_request.READY, 'oracle': LEGACY_READY, 'cases': cls.cases}),
            capture_output=True, text=True, timeout=10, check=True,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == 'nt' else 0)
        cls.results = json.loads(result.stdout)

    def test_loading_and_hidden_cues_make_no_session_request(self):
        for name in ('loading', 'blank_complete', 'hidden', 'ordinary_heading'):
            with self.subTest(name=name):
                self.assertEqual(self.results[name]['current'], {
                    'proof': {'ready': False, 'login': False, 'challenge': False},
                    'calls': 0, 'timeouts': []})
                self.assertEqual(self.results[name]['legacy']['calls'], 1)

    def test_visible_cues_preserve_session_proof_and_timeout(self):
        for name in ('ready', 'incomplete_composer', 'login', 'iframe_challenge',
                'heading_challenge', 'no_token', 'no_email', 'non_ok', 'fetch_error',
                'dom_changed', 'mismatch', 'challenge_and_login'):
            with self.subTest(name=name):
                current = self.results[name]['current']
                self.assertEqual(current, self.results[name]['legacy'])
                self.assertEqual(current['calls'], 1)
                self.assertEqual(current['timeouts'], [3000])

    def test_twenty_loading_polls_then_composer_need_one_get_instead_of_twenty_one(self):
        sequence = self.results['loading_sequence']
        self.assertEqual(sequence['current']['calls'], 1)
        self.assertEqual(sequence['legacy']['calls'], 21)
        self.assertEqual(sequence['current']['proof'], sequence['legacy']['proof'])

    def test_dom_is_read_again_after_session_request(self):
        proof = self.results['dom_changed']['current']['proof']
        self.assertFalse(proof['ready'])
        self.assertTrue(proof['login'])
        self.assertTrue(proof['challenge'])
        self.assertFalse(self.results['incomplete_composer']['current']['proof']['ready'])

    def test_identity_challenge_and_login_error_precedence_stays_exact(self):
        for name, code in (('mismatch', 'login_account_mismatch'),
                ('challenge_and_login', 'browser_verification_required'),
                ('login', 'login_required')):
            with self.subTest(name=name):
                with self.assertRaises(ClaudeError) as raised:
                    browser_request._refuse_unready_proof(
                        SimpleNamespace(account_email='owner@example.test'),
                        self.results[name]['current']['proof'])
                self.assertEqual(raised.exception.code, code)

    def test_unavailable_session_retains_original_result_without_new_classification(self):
        self.assertIsNone(self.results['non_ok']['current']['proof'])
        self.assertEqual(self.results['fetch_error']['current']['error'],
            'Synthetic session unavailable')
        self.assertFalse(self.results['no_token']['current']['proof']['ready'])
        self.assertNotIn('email', self.results['no_email']['current']['proof'])


if __name__ == '__main__':
    unittest.main()
