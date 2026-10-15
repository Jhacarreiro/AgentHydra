"""Prepare a single request with the current website, then close its browser.

No login is submitted. The website owns its ordinary verification and sends the
requested message once over its normal HTTP connection. Python verifies readback
without resending. The browser closes and its owned profile is removed afterward.
Cookies and request credentials stay in memory and the owned profile is removed.
"""

import asyncio
import base64
import json
import os
import re
import tempfile
import time
from contextlib import contextmanager
from pathlib import Path
from urllib.parse import urlparse

from ..errors import ClaudeError
from .. import signin
from ..registry import chat_lock
from .http import BASE, ChatGPTHttp, visible_messages


def markers_missing(cookies, now=None):
    now = time.time() if now is None else now
    return not all(any(c.get('name') == name and c.get('value') and
        c.get('domain', '').lstrip('.') == 'chatgpt.com' and
        (c.get('expires', -1) == -1 or c.get('expires', 0) > now)
        for c in cookies) for name in ('_uasid', '_umsid'))


@contextmanager
def browser_slot(directory, *, wait):
    """Bound owned browser memory across harness processes, without stopping work."""
    root = Path(os.environ.get('CLAUDFREE_CACHE_DIR') or directory) / 'browser-slots'
    deadline = time.monotonic() + wait
    while True:
        for slot in range(3):
            held = chat_lock(root, 'chatgpt-' + str(slot))
            try:
                held.__enter__()
            except ClaudeError as exc:
                if exc.code != 'chat_busy':
                    raise
                continue
            try:
                yield
            finally:
                held.__exit__(None, None, None)
            return
        if time.monotonic() >= deadline:
            raise ClaudeError('The browser request queue is busy. No message was sent.', code='browser_busy', retryable=True)
        time.sleep(.1)

READY = r'''(async()=>{
 const r=await fetch('/api/auth/session',{signal:AbortSignal.timeout(3000)});
 if(!r.ok)return null;const s=await r.json();
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const composer=[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')].find(visible);
 return {email:s.user?.email,ready:document.readyState==='complete'&&!!s.accessToken&&!!composer,
 login:[...document.querySelectorAll('input[type="email"],input[type="password"]')].some(visible),
 challenge:[...document.querySelectorAll('iframe[src*="hcaptcha.com"][title*="challenge"],iframe[src*="recaptcha"][title*="challenge"]')].some(visible)||
  [...document.querySelectorAll('h1,h2,[role="alert"]')].some(e=>visible(e)&&/verify you are human|complete the captcha|verification required/i.test(e.innerText))};
})()'''

FOCUS = r'''(()=>{const e=[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')]
 .find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');if(!e)return false;e.focus();return true;})()'''
SUBMIT = r'''(()=>{const b=[...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[type="submit"]')]
 .find(b=>b.getClientRects().length&&!b.disabled&&b.getAttribute('aria-disabled')!=='true');if(!b)return false;b.click();return true;})()'''


def validate(payload, prompt, existing, *, temporary=True):
    """Refuse other prompts, accounts' threads, actions or privacy modes before dispatch."""
    if not isinstance(payload, dict) or payload.get('action') != 'next':
        raise ClaudeError('The website prepared an unexpected action. No message was sent.', code='browser_preparation_invalid')
    messages = payload.get('messages')
    if not isinstance(messages, list) or len(messages) != 1:
        raise ClaudeError('The prepared message did not match. No message was sent.', code='browser_preparation_invalid')
    message = messages[0]
    author = message.get('author') if isinstance(message, dict) else None
    content = message.get('content') if isinstance(message, dict) else None
    if not isinstance(author, dict) or not isinstance(content, dict) or author.get('role') != 'user' or content.get('parts') != [prompt]:
        raise ClaudeError('The prepared text did not match. No message was sent.', code='browser_preparation_invalid')
    if temporary and payload.get('history_and_training_disabled') is not True:
        raise ClaudeError('The website did not confirm Temporary Chat. No message was sent.', code='privacy_not_verified')
    if temporary and not existing and payload.get('temporary_chat_requests_personalization') is True:
        raise ClaudeError('The prepared chat enabled personalization. No message was sent.', code='privacy_not_verified')
    if existing:
        if payload.get('conversation_id') != existing.get('conversation_id') or payload.get('parent_message_id') != existing.get('current_node'):
            raise ClaudeError('The website selected a different chat or branch. No message was sent.', code='browser_preparation_invalid')
    elif payload.get('conversation_id'):
        raise ClaudeError('The website selected an existing chat. No message was sent.', code='browser_preparation_invalid')


def request_headers(headers):
    """Validate authorization before dispatch and exclude connection-owned headers."""
    banned = {'cookie','host','content-length','connection','accept-encoding','transfer-encoding'}
    headers = {k: v for k, v in headers.items() if k.lower() not in banned}
    authorization = next((v for k,v in headers.items() if k.lower() == 'authorization'), '')
    if not isinstance(authorization, str) or not authorization.startswith('Bearer ') or not authorization[7:].strip() or '\r' in authorization or '\n' in authorization:
        raise ClaudeError('The prepared request has no account authorization. No message was sent.', code='browser_preparation_invalid')
    return headers


def prepare(http, prompt, existing=None, *, directory, model, temporary=True, on_id=None):
    """One bound request, never a reusable preparation pool or an automatic resend."""
    with browser_slot(directory, wait=min(120, http.timeout)):
        return asyncio.run(_prepare(http, prompt, existing, directory=directory, model=model, temporary=temporary, on_id=on_id))


def adopt_cookies(http, cookies):
    replacement = ChatGPTHttp({'cookies': cookies, 'origins': []}, timeout=http.timeout)
    try:
        http.session.cookies = replacement.session.cookies.copy()
        http.original['cookies'] = cookies
    finally:
        replacement.close()


async def _prepare(http, prompt, existing, *, directory, model, temporary, on_id):
    import zendriver as zd

    started = time.monotonic()
    browser = None
    missing_before = markers_missing(http.saved_state()['cookies'])
    dispatch = {'network_id': None, 'status': None, 'sent': False}
    identity_verified = False
    server_id = None
    # The session lock held by ChatGPTClient protects both cookies and this profile.
    with tempfile.TemporaryDirectory(prefix='request-', dir=directory) as profile:
        try:
            browser = await zd.start(user_data_dir=profile, headless=False,
                browser_args=['--window-size=650,850','--no-first-run','--no-default-browser-check'])
            await signin.load_cookies(browser, http.saved_state()['cookies'])
            path = '/c/' + existing['conversation_id'] if existing else '/'
            tab = await browser.get(BASE + path)
            deadline = time.monotonic() + min(30, http.timeout)
            proof = None
            while time.monotonic() < deadline:
                try:
                    proof = await asyncio.wait_for(tab.evaluate(READY, await_promise=True), 5)
                except Exception:
                    proof = None
                if proof and proof.get('email') and proof['email'].casefold() != (http.account_email or '').casefold():
                    raise ClaudeError('The saved browser belongs to another account. No message was sent.', code='login_account_mismatch')
                if proof and proof.get('challenge'):
                    raise ClaudeError('The website requires an interactive verification. No message was sent; open this account to complete it before retrying.', code='browser_verification_required')
                if proof and proof.get('login'):
                    raise ClaudeError('The saved browser login has expired. No login or message was submitted.', code='login_required')
                if proof and proof.get('ready') and proof.get('email'):
                    identity_verified = True
                    break
                await asyncio.sleep(.3)
            else:
                raise ClaudeError('The saved browser did not reach its composer. No login or message was submitted.', code='browser_preparation_timeout')
            if temporary and not existing:
                selected = await tab.evaluate(r'''(()=>{const b=document.querySelector('button[aria-label="Temporary chat"]');if(!b)return false;b.click();return true;})()''')
                if not selected:
                    raise ClaudeError('Temporary Chat could not be selected. No message was sent.', code='privacy_not_verified')
                await asyncio.sleep(.4)
            captured = asyncio.get_running_loop().create_future()

            def response(event):
                if event.request_id == dispatch['network_id']:
                    dispatch['status'] = int(event.response.status)

            await tab.send(zd.cdp.network.enable())
            tab.add_handler(zd.cdp.network.ResponseReceived, response)

            async def pause(event):
                request = event.request
                if urlparse(request.url).path != '/backend-api/f/conversation' or request.method != 'POST':
                    await tab.send(zd.cdp.fetch.continue_request(event.request_id))
                    return
                raw = request.post_data
                if not raw and event.network_id:
                    try:
                        raw = await tab.send(zd.cdp.network.get_request_post_data(event.network_id))
                    except Exception:
                        raw = None
                if captured.done() or dispatch['sent']:
                    await tab.send(zd.cdp.fetch.fail_request(event.request_id, zd.cdp.network.ErrorReason.BLOCKED_BY_CLIENT))
                    return
                try:
                    payload = json.loads(raw or '{}')
                    payload['model'] = model
                    if temporary and not existing:
                        payload['temporary_chat_requests_personalization'] = False
                    validate(payload, prompt, existing, temporary=temporary)
                    headers = request_headers(dict(request.headers))
                    if not event.network_id:
                        raise ValueError('No network request identity')
                    dispatch.update(sent=True, network_id=event.network_id)
                    encoded = base64.b64encode(json.dumps(payload).encode()).decode()
                    # This IS the requested message, never a probe followed by
                    # another send. Block any subsequent website retry.
                    await tab.send(zd.cdp.fetch.continue_request(event.request_id, post_data=encoded))
                    captured.set_result((payload, headers))
                except Exception:
                    if not dispatch['sent']:
                        await tab.send(zd.cdp.fetch.fail_request(event.request_id, zd.cdp.network.ErrorReason.BLOCKED_BY_CLIENT))
                    captured.set_exception(ClaudeError(
                        'The browser message outcome is not confirmed. No second message was sent.' if dispatch['sent'] else
                        'The prepared request could not be verified. No message was sent.',
                        code='stream_interrupted' if dispatch['sent'] else 'browser_preparation_invalid'))

            tab.add_handler(zd.cdp.fetch.RequestPaused, pause)
            await tab.send(zd.cdp.fetch.enable(patterns=[zd.cdp.fetch.RequestPattern(
                url_pattern=BASE + '/backend-api/f/conversation*', request_stage=zd.cdp.fetch.RequestStage.REQUEST)]))
            if not await tab.evaluate(FOCUS):
                raise ClaudeError('The composer is unavailable. No message was sent.', code='browser_preparation_timeout')
            await tab.send(zd.cdp.input_.insert_text(prompt))
            deadline = time.monotonic() + 8
            while time.monotonic() < deadline:
                if await tab.evaluate(SUBMIT):
                    break
                await asyncio.sleep(.2)
            else:
                raise ClaudeError('The submit button did not become ready. No message was sent.', code='browser_preparation_timeout')
            try:
                payload, headers = await asyncio.wait_for(captured, min(35, http.timeout))
            except TimeoutError:
                raise ClaudeError('The website did not finish preparing the request. No message was sent.', code='browser_preparation_timeout') from None
            cookies = await signin.export_cookies(browser)
            adopt_cookies(http, cookies)
            context = {'authorization','user-agent','oai-language','oai-did','chatgpt-account-id'}
            http.session.headers.update({k:v for k,v in headers.items() if k.lower() in context})
            if dispatch['sent']:
                deadline = time.monotonic() + min(90, http.timeout)
                own_message = payload['messages'][0].get('id')
                while time.monotonic() < deadline:
                    adopt_cookies(http, await signin.export_cookies(browser))
                    path = await tab.evaluate('location.pathname')
                    match = re.fullmatch(r'/c/([0-9a-f-]{36})', path or '')
                    candidate = existing['conversation_id'] if existing else match[1] if match else None
                    if candidate:
                        if server_id is None and on_id:
                            on_id(candidate)
                        server_id = candidate
                        try:
                            body = await asyncio.to_thread(http._json, 'GET', '/backend-api/conversation/' + server_id)
                            messages = visible_messages(body)
                            positions = [i for i,m in enumerate(messages) if m['role']=='user' and m['id']==own_message and m['text']==prompt]
                            if positions and any(m['role']=='assistant' and not m['incomplete'] for m in messages[positions[-1]+1:]):
                                if temporary and body.get('is_temporary_chat') is not True:
                                    raise ClaudeError('The completed browser message was not Temporary. No second message was sent.', code='privacy_not_verified')
                                break
                        except ClaudeError as exc:
                            if exc.code not in {'not_found','invalid_response'}:
                                raise
                    if dispatch['status'] and dispatch['status'] >= 400:
                        raise ClaudeError('The ordinary browser send was refused. No second message was sent.', code='browser_send_rejected', status=dispatch['status'])
                    await asyncio.sleep(.3)
                else:
                    raise ClaudeError('The browser message outcome is not confirmed. No second message was sent.', code='stream_interrupted') from None
            return {'payload': payload, 'headers': headers,
                'already_sent': True, 'server_id': server_id,
                'metrics': {'seconds': round(time.monotonic()-started, 2), 'browser_preparation': True,
                    'browser_closed_before_send': False, 'browser_completed_send': True,
                    'renewed_browser_markers': missing_before}}
        finally:
            if browser:
                try:
                    if identity_verified:
                        adopt_cookies(http, await signin.export_cookies(browser))
                finally:
                    await browser.stop()
