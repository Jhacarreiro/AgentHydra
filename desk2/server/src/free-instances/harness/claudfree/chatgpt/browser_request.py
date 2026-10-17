"""Send once with the current website, then dispose the request's browser context.

No login is submitted. The website owns its ordinary verification and sends the
requested message once over its normal HTTP connection. Python verifies readback
without resending. Desk shares one headless browser; account contexts are cleared
afterward and the empty browser closes when idle. Standalone callers own a profile.
"""

import asyncio
import base64
import json
import os
import re
import tempfile
import time
import unicodedata
from contextlib import contextmanager, nullcontext
from pathlib import Path
from urllib.parse import urlparse
from requests.cookies import RequestsCookieJar

from ..errors import ClaudeError
from .. import signin
from ..registry import chat_lock
from .http import BASE, bounded_confirmed_conversation, load_chatgpt_cookies, visible_messages


def markers_missing(cookies, now=None):
    now = time.time() if now is None else now
    return not all(any(c.get('name') == name and c.get('value') and
        c.get('domain', '').lstrip('.') == 'chatgpt.com' and
        (c.get('expires', -1) == -1 or c.get('expires', 0) > now)
        for c in cookies) for name in ('_uasid', '_umsid'))


@contextmanager
def browser_slot(directory, *, wait):
    """Bound owned browser memory across harness processes, without stopping work."""
    from .browser_slots import browser_slot as acquire

    root = Path(os.environ.get('CLAUDFREE_CACHE_DIR') or directory) / 'browser-slots'
    with acquire(root, wait=wait, locker=chat_lock):
        yield

READY = r'''(async()=>{
 const visible=e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
 const cues=()=>({
 composer:[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')].find(visible),
 login:[...document.querySelectorAll('input[type="email"],input[type="password"]')].some(visible),
 challenge:[...document.querySelectorAll('iframe[src*="hcaptcha.com"][title*="challenge"],iframe[src*="recaptcha"][title*="challenge"]')].some(visible)||
  [...document.querySelectorAll('h1,h2,[role="alert"]')].some(e=>visible(e)&&/verify you are human|complete the captcha|verification required/i.test(e.innerText))});
 const proof=(dom,session,status,s)=>{
  const state=document.readyState;
  const email=typeof s?.user?.email==='string'?s.user.email:undefined;
  return {email,ready:state==='complete'&&session==='ok'&&!!s?.accessToken&&!!dom.composer,
   login:dom.login,challenge:dom.challenge,diagnostic:{
    document_state:['loading','interactive','complete'].includes(state)?state:'unknown',
    composer:!!dom.composer,session,
    ...(Number.isInteger(status)&&status>=100&&status<=599?{http_status:status}:{}),
    ...(session==='ok'?{authorized:!!s?.accessToken,identity:!!email}:{})}};
 };
 const before=cues();
 if(!before.composer&&!before.login&&!before.challenge)return proof(before,'skipped');
 let session='fetch_error',status,s;
 try{
  const r=await fetch('/api/auth/session',{signal:AbortSignal.timeout(3000)});status=r.status;
  if(!r.ok)session='http_error';
  else{
   session='invalid_json';
   try{s=await r.json();if(s&&typeof s==='object'&&!Array.isArray(s))session='ok';}
   catch(error){
    if(['TimeoutError','AbortError'].includes(error?.name))session='fetch_timeout';
    else if(error?.name!=='SyntaxError')session='fetch_error';
   }
  }
 }catch(error){if(['TimeoutError','AbortError'].includes(error?.name))session='fetch_timeout';}
 // Refresh visible cues even when session lookup fails; never infer a challenge from an HTTP error.
 return proof(cues(),session,status,s);
})()'''

FOCUS = r'''(()=>{const e=[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')]
 .find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');if(!e)return false;e.focus();return true;})()'''
SUBMIT = r'''(()=>{const b=[...document.querySelectorAll('button[data-testid="send-button"],button[aria-label="Send prompt"],button[aria-label="Send message"],button[type="submit"]')]
 .find(b=>b.getClientRects().length&&!b.disabled&&b.getAttribute('aria-disabled')!=='true');if(!b)return false;b.click();return true;})()'''
TEMPORARY = r'''(()=>{const b=document.querySelector('button[aria-label="Temporary chat"]');if(!b)return 'missing';
 const pressed=b.getAttribute('aria-pressed');
 if(pressed==='true'||b.getAttribute('data-state')==='on')return 'on';
 return 'off';})()'''
TEMPORARY_CLICK = r'''(()=>{const b=document.querySelector('button[aria-label="Temporary chat"]');if(!b)return false;b.click();return true;})()'''
COMPOSER_LENGTH = r'''(()=>{const e=[...document.querySelectorAll('[role="textbox"],[contenteditable="true"],textarea')]
 .find(e=>e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden');if(!e)return 0;
 return (e.value??e.textContent??'').replace(/\s/g,'').length;})()'''


def _check_shape(payload, existing):
    """The website must have prepared one user message, on the chat and branch asked for."""
    if not isinstance(payload, dict) or payload.get('action') != 'next':
        raise ClaudeError('The website prepared an unexpected action. No message was sent.', code='browser_preparation_invalid')
    messages = payload.get('messages')
    if not isinstance(messages, list) or len(messages) != 1:
        raise ClaudeError('The prepared message did not match. No message was sent.', code='browser_preparation_invalid')
    message = messages[0]
    author = message.get('author') if isinstance(message, dict) else None
    if not isinstance(author, dict) or author.get('role') != 'user':
        raise ClaudeError('The prepared message was not from the user. No message was sent.', code='browser_preparation_invalid')
    if existing:
        if payload.get('conversation_id') != existing.get('conversation_id') or payload.get('parent_message_id') != existing.get('current_node'):
            raise ClaudeError('The website selected a different chat or branch. No message was sent.', code='browser_preparation_invalid')
    elif payload.get('conversation_id'):
        raise ClaudeError('The website selected an existing chat. No message was sent.', code='browser_preparation_invalid')


def validate(payload, prompt, existing, *, temporary=True):
    """Refuse other prompts, accounts' threads, actions or privacy modes before dispatch."""
    _check_shape(payload, existing)
    content = payload['messages'][0].get('content')
    if not isinstance(content, dict) or content.get('parts') != [prompt]:
        raise ClaudeError('The prepared text did not match. No message was sent.', code='browser_preparation_invalid')
    if temporary and payload.get('history_and_training_disabled') is not True:
        raise ClaudeError('The website did not confirm Temporary Chat. No message was sent.', code='privacy_not_verified')
    if temporary and not existing and payload.get('temporary_chat_requests_personalization') is True:
        raise ClaudeError('The prepared chat enabled personalization. No message was sent.', code='privacy_not_verified')


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
        endpoint = os.environ.get('CLAUDFREE_BROWSER_POOL')
        if endpoint:
            from .browser_pool import request
            return request(http, prompt, existing, endpoint=endpoint, model=model, temporary=temporary, on_id=on_id)
        return asyncio.run(_prepare(http, prompt, existing, directory=directory, model=model, temporary=temporary, on_id=on_id))


def adopt_cookies(http, cookies):
    http.session.cookies = load_chatgpt_cookies(RequestsCookieJar(), cookies)
    http.original['cookies'] = cookies


def _refuse_unready_proof(http, proof):
    if proof and proof.get('email') and proof['email'].casefold() != (http.account_email or '').casefold():
        raise ClaudeError('The saved browser belongs to another account. No message was sent.', code='login_account_mismatch')
    if proof and proof.get('challenge'):
        raise ClaudeError('The website requires an interactive verification. No message was sent; open this account to complete it before retrying.', code='browser_verification_required')
    if proof and proof.get('login'):
        raise ClaudeError('The saved browser login has expired. No login or message was submitted.', code='login_required')


async def _wait_for_composer(http, tab):
    deadline = time.monotonic() + min(30, http.timeout)
    proof = None
    diagnostic = None
    proof_poll = polls = evaluation_timeouts = evaluation_errors = 0
    last_evaluation = 'none'
    while time.monotonic() < deadline:
        polls += 1
        try:
            proof = await asyncio.wait_for(tab.evaluate(READY, await_promise=True), 5)
        except asyncio.TimeoutError:
            proof = None
            evaluation_timeouts += 1
            last_evaluation = 'timeout'
        except Exception:
            proof = None
            evaluation_errors += 1
            last_evaluation = 'error'
        else:
            observed = _readiness_diagnostic(proof)
            last_evaluation = 'proof' if observed is not None else 'no proof'
            if observed is not None:
                diagnostic, proof_poll = observed, polls
        _refuse_unready_proof(http, proof)
        if proof and proof.get('ready') and proof.get('email'):
            return
        await asyncio.sleep(.3)
    if diagnostic is None:
        observed = 'No DOM proof was obtained.'
    else:
        fields = [f"state={diagnostic['document_state']}",
            f"composer={'present' if diagnostic['composer'] else 'missing'}",
            f"session={diagnostic['session']}"]
        if 'http_status' in diagnostic:
            fields.append(f"session HTTP={diagnostic['http_status']}")
        for name in ('authorized', 'identity'):
            if name in diagnostic:
                fields.append(f"{name}={'present' if diagnostic[name] else 'missing'}")
        observed = f"Last DOM proof (poll {proof_poll}): {', '.join(fields)}."
    raise ClaudeError('The saved browser did not reach its composer. '
        f'{observed} Polls={polls}; evaluation timeouts={evaluation_timeouts}; '
        f'evaluation errors={evaluation_errors}; last evaluation={last_evaluation}. '
        'No login or message was submitted.', code='browser_preparation_timeout')


def _readiness_diagnostic(proof):
    """Keep only bounded readiness facts, never provider text, URLs or account values."""
    raw = proof.get('diagnostic') if isinstance(proof, dict) else None
    if not isinstance(raw, dict):
        return None
    states = ('loading', 'interactive', 'complete', 'unknown')
    sessions = ('skipped', 'ok', 'http_error', 'fetch_error', 'fetch_timeout', 'invalid_json')
    if raw.get('document_state') not in states or raw.get('session') not in sessions or type(raw.get('composer')) is not bool:
        return None
    safe = {key: raw[key] for key in ('document_state', 'composer', 'session')}
    status = raw.get('http_status')
    if type(status) is int and 100 <= status <= 599:
        safe['http_status'] = status
    for key in ('authorized', 'identity'):
        if type(raw.get(key)) is bool:
            safe[key] = raw[key]
    return safe


async def _select_temporary_chat(tab, temporary, existing):
    """Wait until the button shows Temporary Chat on, clicking once only when it is not already on.

    Returns True when the page confirmed it; False when there is no page state to read (a continued chat).
    """
    if not temporary or existing:
        return False
    deadline = time.monotonic() + 10
    clicked = False
    while True:
        state = await tab.evaluate(TEMPORARY)
        if state == 'on':
            return True
        if not clicked:
            clicked = bool(await tab.evaluate(TEMPORARY_CLICK))
        if time.monotonic() >= deadline:
            raise ClaudeError('Temporary Chat could not be confirmed. No message was sent.', code='privacy_not_verified')
        await asyncio.sleep(.2)


def _prepared_request(event, raw, prompt, model, existing, temporary, steps, page_private=False):
    """Keep the website's request and its own headers; the prompt text and privacy flag are ours.

    steps records each stage in turn, so a refusal names the one that failed. The flag is forced
    only after pre-send evidence of a private chat: for a new chat, the page showed Temporary Chat on
    (page_private) or the website's own body already carried the flag; for a continuation, the
    website's record of that chat says it is Temporary.
    """
    steps.append('parse_post_data')
    payload = json.loads(raw or '{}')
    steps.append('check_website_request')
    _check_shape(payload, existing)
    if temporary and existing and existing.get('is_temporary_chat') is not True:
        raise ClaudeError('The chat to continue is not a Temporary Chat. No message was sent.', code='privacy_not_verified')
    steps.append('substitute_text_and_privacy')
    if temporary and not existing and not page_private and payload.get('history_and_training_disabled') is not True:
        raise ClaudeError('The website did not confirm Temporary Chat. No message was sent.', code='privacy_not_verified')
    payload['model'] = model
    payload['messages'][0]['content'] = {'content_type': 'text', 'parts': [prompt]}
    if temporary:
        payload['history_and_training_disabled'] = True
    if temporary and not existing:
        payload['temporary_chat_requests_personalization'] = False
    steps.append('validate')
    validate(payload, prompt, existing, temporary=temporary)
    steps.append('request_headers')
    headers = request_headers(dict(event.request.headers))
    steps.append('network_id')
    if not event.network_id:
        raise ValueError('No network request identity')
    return payload, headers


async def _request_post_data(tab, zd, event):
    """Return the body and where it came from, so a refusal can say which source was empty."""
    if event.request.post_data:
        return event.request.post_data, 'post_data'
    if not event.network_id:
        return None, 'missing'
    try:
        return await tab.send(zd.cdp.network.get_request_post_data(event.network_id)), 'getRequestPostData'
    except Exception:
        return None, 'getRequestPostDataFailed'


KNOWN_ACTIONS = ('next', 'variant', 'continue')


def _normalised(text):
    """The composer may change line endings, trailing spaces or Unicode form; compare past those."""
    lines = unicodedata.normalize('NFC', text).replace('\r\n', '\n').split('\n')
    return '\n'.join(line.rstrip() for line in lines).rstrip()


def _flag(value):
    return 'absent' if value is None else str(value).lower() if isinstance(value, bool) else 'other'


def _prepared_diagnostic(raw, source, prompt):
    """Bounded facts about the website's body. Never its text: only lengths, counts and flags."""
    facts = [f'post_data={source}']
    try:
        payload = json.loads(raw or '{}')
    except Exception:  # a diagnostic must never replace the refusal it explains (RecursionError included)
        return ' '.join(facts + ['body=unreadable', f'body_chars={len(raw or "")}'])
    if not isinstance(payload, dict):
        return ' '.join(facts + ['body=not_an_object'])
    messages = payload.get('messages')
    message = messages[0] if isinstance(messages, list) and messages and isinstance(messages[0], dict) else {}
    content = message.get('content') if isinstance(message.get('content'), dict) else {}
    parts = content.get('parts') if isinstance(content.get('parts'), list) else []
    part = parts[0] if len(parts) == 1 and isinstance(parts[0], str) else None
    action = payload.get('action')
    return ' '.join(facts + [
        f"action={action if action in KNOWN_ACTIONS else 'other'}",
        f"messages={len(messages) if isinstance(messages, list) else 'missing'}",
        f"content_type={content.get('content_type') if content.get('content_type') == 'text' else 'other'}",
        f'parts={len(parts)}',
        f'text_equal={part == prompt}',
        f'text_equal_normalised={part is not None and _normalised(part) == _normalised(prompt)}',
        f'prompt_chars={len(prompt)}',
        f"part_chars={len(part) if part is not None else 'none'}",
        f"history_and_training_disabled={_flag(payload.get('history_and_training_disabled'))}",
        f"conversation_id={'present' if payload.get('conversation_id') else 'absent'}",
    ])


def _preparation_refusal(inner, steps, raw, source, prompt):
    """Keep the inner code and message; name the failing step when the cause is not a ClaudeError."""
    diagnostic = _prepared_diagnostic(raw, source, prompt)
    if isinstance(inner, ClaudeError):
        return ClaudeError(f'{inner} Diagnostic: {diagnostic}', code=inner.code)
    step = steps[-1] if steps else 'parse_post_data'
    return ClaudeError(f'The prepared request could not be verified at {step} ({type(inner).__name__}). '
        f'No message was sent. Diagnostic: {diagnostic}', code='browser_preparation_invalid')


async def _answer_conversation_request(tab, zd, event, *, captured, dispatch, prompt, model, existing, temporary,
        page_private=False):
    request = event.request
    if urlparse(request.url).path != '/backend-api/f/conversation' or request.method != 'POST':
        await tab.send(zd.cdp.fetch.continue_request(event.request_id))
        return
    raw, source = await _request_post_data(tab, zd, event)
    if captured.done() or dispatch['sent']:
        await tab.send(zd.cdp.fetch.fail_request(event.request_id, zd.cdp.network.ErrorReason.BLOCKED_BY_CLIENT))
        return
    steps = []
    try:
        payload, headers = _prepared_request(event, raw, prompt, model, existing, temporary, steps, page_private)
        dispatch.update(sent=True, network_id=event.network_id)
        encoded = base64.b64encode(json.dumps(payload).encode()).decode()
        # This IS the requested message, never a probe followed by
        # another send. Block any subsequent website retry.
        await tab.send(zd.cdp.fetch.continue_request(event.request_id, post_data=encoded))
        captured.set_result((payload, headers))
    except Exception as inner:
        if not dispatch['sent']:
            await tab.send(zd.cdp.fetch.fail_request(event.request_id, zd.cdp.network.ErrorReason.BLOCKED_BY_CLIENT))
        captured.set_exception(ClaudeError(
            'The browser message outcome is not confirmed. No second message was sent.', code='stream_interrupted')
            if dispatch['sent'] else _preparation_refusal(inner, steps, raw, source, prompt))


async def _arm_interception(tab, zd, *, captured, dispatch, prompt, model, existing, temporary, page_private=False):
    async def response(event):
        if event.request_id == dispatch['network_id']:
            dispatch['status'] = int(event.response.status)

    await tab.send(zd.cdp.network.enable())
    tab.add_handler(zd.cdp.network.ResponseReceived, response)

    async def pause(event):
        await _answer_conversation_request(tab, zd, event, captured=captured, dispatch=dispatch,
            prompt=prompt, model=model, existing=existing, temporary=temporary, page_private=page_private)

    tab.add_handler(zd.cdp.fetch.RequestPaused, pause)
    await tab.send(zd.cdp.fetch.enable(patterns=[zd.cdp.fetch.RequestPattern(
        url_pattern=BASE + '/backend-api/f/conversation*', request_stage=zd.cdp.fetch.RequestStage.REQUEST)]))


def _submit_deadline(prompt):
    """Long prompts take longer to type into the composer: 8 s, plus 1 s per 2,000 characters, at most 40 s."""
    return min(40, 8 + len(prompt) / 2000)


async def _submit_prompt(tab, zd, prompt):
    if not await tab.evaluate(FOCUS):
        raise ClaudeError('The composer is unavailable. No message was sent.', code='browser_preparation_timeout')
    await tab.send(zd.cdp.input_.insert_text(prompt))
    # The page counts UTF-16 units, Python code points.
    typed = len(re.sub(r'\s', '', prompt).encode('utf-16-le')) // 2
    deadline = time.monotonic() + _submit_deadline(prompt)
    while time.monotonic() < deadline:
        # Click only once the composer holds the typed text, never a half-typed prompt.
        if await tab.evaluate(COMPOSER_LENGTH) >= typed and await tab.evaluate(SUBMIT):
            return
        await asyncio.sleep(.2)
    raise ClaudeError('The submit button did not become ready. No message was sent.', code='browser_preparation_timeout')


async def _await_capture(http, captured):
    try:
        return await asyncio.wait_for(captured, min(35, http.timeout))
    except TimeoutError:
        raise ClaudeError('The website did not finish preparing the request. No message was sent.', code='browser_preparation_timeout') from None


async def _adopt_captured_session(http, browser, headers):
    cookies = await signin.export_cookies(browser)
    adopt_cookies(http, cookies)
    context = {'authorization','user-agent','oai-language','oai-did','chatgpt-account-id'}
    http.session.headers.update({k:v for k,v in headers.items() if k.lower() in context})


async def _conversation_candidate(tab, existing):
    if existing:
        return existing['conversation_id']
    path = await tab.evaluate('location.pathname')
    match = re.fullmatch(r'/c/([0-9a-f-]{36})', path or '')
    return match[1] if match else None


async def _own_message_completed(http, server_id, own_message, prompt, temporary, confirmed=None):
    try:
        body = await asyncio.to_thread(http._json, 'GET', '/backend-api/conversation/' + server_id)
        if body.get('conversation_id') != server_id:
            raise ClaudeError('ChatGPT returned a different conversation.', code='invalid_response')
        messages = visible_messages(body, rich=False)
        positions = [i for i,m in enumerate(messages) if m['role']=='user' and m['id']==own_message and m['text']==prompt]
        if not positions or not any(m['role']=='assistant' and not m['incomplete'] for m in messages[positions[-1]+1:]):
            return False
        if temporary and body.get('is_temporary_chat') is not True:
            raise ClaudeError('The completed browser message was not Temporary. No second message was sent.', code='privacy_not_verified')
        if confirmed is not None:
            confirmed['body'] = body
        return True
    except ClaudeError as exc:
        if exc.code not in {'not_found','invalid_response'}:
            raise
        return False


async def _await_confirmation(http, tab, browser, dispatch, payload, prompt, existing, temporary, on_id, confirmed=None):
    deadline = time.monotonic() + min(90, http.timeout)
    own_message = payload['messages'][0].get('id')
    server_id = existing['conversation_id'] if existing else None
    notified = False
    while time.monotonic() < deadline:
        adopt_cookies(http, await signin.export_cookies(browser))
        if server_id is None:
            server_id = await _conversation_candidate(tab, existing)
        if server_id:
            if not notified and on_id:
                on_id(server_id)
            notified = True
            if await _own_message_completed(http, server_id, own_message, prompt, temporary, confirmed):
                return server_id
        if dispatch['status'] and dispatch['status'] >= 400:
            raise ClaudeError('The ordinary browser send was refused. No second message was sent.', code='browser_send_rejected', status=dispatch['status'])
        await asyncio.sleep(.3)
    raise ClaudeError('The browser message outcome is not confirmed. No second message was sent.', code='stream_interrupted') from None


async def _close_browser(http, browser, identity_verified):
    try:
        if identity_verified:
            adopt_cookies(http, await signin.export_cookies(browser))
    finally:
        await browser.stop()


async def _prepare(http, prompt, existing, *, directory, model, temporary, on_id, browser_factory=None):
    import zendriver as zd

    started = time.monotonic()
    browser = None
    missing_before = markers_missing(http.saved_state()['cookies'])
    dispatch = {'network_id': None, 'status': None, 'sent': False}
    identity_verified = False
    server_id = None
    confirmed = {}
    # The session lock held by ChatGPTClient protects both cookies and this profile.
    with nullcontext(None) if browser_factory else tempfile.TemporaryDirectory(prefix='request-', dir=directory) as profile:
        try:
            browser = await browser_factory() if browser_factory else await zd.start(user_data_dir=profile, headless=True,
                browser_args=['--window-size=650,850','--no-first-run','--no-default-browser-check'])
            await signin.load_cookies(browser, http.saved_state()['cookies'])
            path = '/c/' + existing['conversation_id'] if existing else ('/?temporary-chat=true' if temporary else '/')
            tab = await browser.get(BASE + path)
            await _wait_for_composer(http, tab)
            identity_verified = True
            page_private = await _select_temporary_chat(tab, temporary, existing)
            captured = asyncio.get_running_loop().create_future()
            await _arm_interception(tab, zd, captured=captured, dispatch=dispatch,
                prompt=prompt, model=model, existing=existing, temporary=temporary, page_private=page_private is True)
            await _submit_prompt(tab, zd, prompt)
            payload, headers = await _await_capture(http, captured)
            await _adopt_captured_session(http, browser, headers)
            if dispatch['sent']:
                server_id = await _await_confirmation(http, tab, browser, dispatch, payload, prompt, existing, temporary, on_id, confirmed)
            result = {'payload': payload, 'headers': headers,
                'already_sent': True, 'server_id': server_id,
                'metrics': {'seconds': round(time.monotonic()-started, 2), 'browser_preparation': True,
                    'browser_closed_before_send': False, 'browser_completed_send': True,
                    'renewed_browser_markers': missing_before}}
            snapshot = bounded_confirmed_conversation(confirmed.pop('body', None))
            if snapshot is not None:
                result['confirmed_conversation'] = snapshot
            return result
        finally:
            if browser:
                await _close_browser(http, browser, identity_verified)
