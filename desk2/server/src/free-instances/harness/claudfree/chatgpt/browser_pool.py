"""Server-owned headless Chrome with one disposable cookie context per request.

Only authenticated loopback IPC carries credentials, in memory. A disconnected
caller cancels its context, never another request or the shared browser. The
empty browser and owned profile close after 60 idle seconds.
"""

import argparse
import asyncio
import hmac
import json
import os
import secrets
import socket
import tempfile
import time
from pathlib import Path
from uuid import UUID

from ..errors import ClaudeError
from ..registry import chat_lock
from .http import ChatGPTHttp

MAX_FRAME = 4 * 1024 * 1024


class ContextBrowser:
    """The cookie/browser interface used by signin, scoped to exactly one context."""

    def __init__(self, browser, tab, cdp, on_disposal_error=None):
        self.browser, self.tab, self.cdp = browser, tab, cdp
        self.context_id = tab.target.browser_context_id
        if not self.context_id:
            raise ClaudeError('An isolated browser context was not created. No message was sent.', code='browser_pool_unavailable')
        self.cookies = self
        self.closed = False
        self.on_disposal_error = on_disposal_error

    async def get_all(self):
        return await self.browser.connection.send(self.cdp.storage.get_cookies(browser_context_id=self.context_id))

    async def set_all(self, cookies):
        await self.browser.connection.send(self.cdp.storage.set_cookies(cookies, browser_context_id=self.context_id))

    async def get(self, url):
        await self.tab.get(url)
        return self.tab

    async def stop(self):
        if not self.closed:
            try:
                await self.browser.connection.send(self.cdp.target.dispose_browser_context(self.context_id))
                self.closed = True
            except Exception:
                if self.on_disposal_error:
                    self.on_disposal_error()
                raise


class Pool:
    def __init__(self, browser, cdp, token, idle_seconds=60):
        self.browser, self.cdp, self.token = browser, cdp, token
        self.idle_seconds = idle_seconds
        self.active = 0
        self.last_used = time.monotonic()
        self.seen = set()
        self.requests = 0
        self.draining = False

    async def write(self, writer, value):
        raw = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        prepared = value.get('request')
        if len(raw) > MAX_FRAME and isinstance(prepared, dict) and 'confirmed_conversation' in prepared:
            # The verified snapshot only saves a readback. Preserve the real
            # result and cookies when the complete IPC envelope is too large.
            value = {**value, 'request': {key: item for key, item in prepared.items()
                if key != 'confirmed_conversation'}}
            raw = (json.dumps(value, separators=(',', ':')) + '\n').encode()
        writer.write(raw)
        await writer.drain()

    async def handle(self, reader, writer):
        task = disconnected = None
        claimed = False
        try:
            raw = await asyncio.wait_for(reader.readline(), 5)
            if len(raw) > MAX_FRAME:
                raise ValueError('Request too large')
            request = json.loads(raw)
            if not isinstance(request, dict):
                raise ValueError('Invalid request')
            token = request.get('token', '')
            if not isinstance(token, str) or not hmac.compare_digest(token, self.token):
                await self.write(writer, {'ok': False, 'error': {'code': 'unauthorized'}})
                return
            if getattr(self.browser, 'stopped', False):
                self.drain()
            if request.get('op') == 'ping':
                await self.write(writer, {'ok': not self.draining, 'pid': os.getpid()})
                return
            if request.get('op') == 'stop':
                if self.active:
                    await self.write(writer, {'ok': False, 'error': {'code': 'browser_busy'}})
                else:
                    self.drain()
                    await self.write(writer, {'ok': True})
                return
            if request.get('op') != 'send':
                raise ValueError('Invalid operation')
            if self.draining:
                await self.write(writer, {'ok': False, 'error': {'code': 'browser_pool_unavailable', 'message': 'The browser is draining after a cleanup failure. No message was sent.'}})
                return
            identity = str(UUID(request['request_id']))
            if identity in self.seen:
                await self.write(writer, {'ok': False, 'error': {'code': 'request_already_claimed', 'message': 'This request was already claimed. Read its chat before sending again.'}})
                return
            if self.active >= 3:
                await self.write(writer, {'ok': False, 'error': {'code': 'browser_busy', 'message': 'The browser queue is busy. No message was sent.', 'retryable': True}})
                return
            self.seen.add(identity)
            self.active += 1
            self.requests += 1
            claimed = True
            task = asyncio.create_task(self.send(request, writer))
            disconnected = asyncio.create_task(reader.read(1))
            done, _ = await asyncio.wait([task, disconnected], return_when=asyncio.FIRST_COMPLETED)
            if task in done:
                await task
            else:
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
        except (ValueError, KeyError, TypeError, asyncio.TimeoutError, asyncio.LimitOverrunError):
            try:
                await self.write(writer, {'ok': False, 'error': {'code': 'invalid_request', 'message': 'The browser request was refused before dispatch.'}})
            except (ConnectionError, OSError):
                pass
        except (ConnectionError, OSError):
            pass
        finally:
            for pending in (task, disconnected):
                if pending and not pending.done():
                    pending.cancel()
                    await asyncio.gather(pending, return_exceptions=True)
            if claimed:
                self.active -= 1
                self.last_used = time.monotonic()
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def send(self, request, writer):
        from .browser_request import _prepare

        http = ChatGPTHttp({'cookies': request['cookies'], 'origins': []}, timeout=min(120, max(1, request['timeout'])))
        http.account_email = request['email']
        allowed = {'authorization', 'user-agent', 'oai-language', 'oai-did', 'chatgpt-account-id'}
        http.session.headers.update({k: v for k, v in request['headers'].items() if k.lower() in allowed})
        server_id = None

        def found(value):
            nonlocal server_id
            server_id = value
            # Synchronous on_id callback: enqueue immediately; the next await
            # flushes this small progress frame before reply verification.
            writer.write((json.dumps({'server_id': value}) + '\n').encode())

        async def context():
            # Own the ID before creating a tab, so partial tab creation failures
            # cannot leave an account context behind in the shared process.
            context_id = await self.browser.connection.send(self.cdp.target.create_browser_context(dispose_on_detach=True))
            try:
                target_id = await self.browser.connection.send(self.cdp.target.create_target('about:blank', browser_context_id=context_id, new_window=True))
                tab = await self.browser._get_tab(target_id)
                return ContextBrowser(self.browser, tab, self.cdp, on_disposal_error=self.drain)
            except BaseException:
                try:
                    await self.browser.connection.send(self.cdp.target.dispose_browser_context(context_id))
                except Exception:
                    self.drain()
                raise

        try:
            prepared = await _prepare(http, request['prompt'], request.get('existing'), directory=Path('.'),
                model=request['model'], temporary=request.get('temporary', True), on_id=found, browser_factory=context)
            prepared['metrics'].update(shared_headless_browser=True, reused_browser=self.requests > 1)
            result = {'ok': True, 'request': prepared}
        except ClaudeError as error:
            result = {'ok': False, 'error': error.as_dict()}
        except Exception:
            result = {'ok': False, 'error': {'code': 'stream_interrupted', 'message': 'The browser outcome is not confirmed. No automatic resend was made.'}}
        finally:
            cookies = http.saved_state()['cookies']
            http.close()
        result.update(cookies=cookies, server_id=server_id)
        await self.write(writer, result)

    def drain(self):
        self.draining = True


def request(http, prompt, existing, *, endpoint, model, temporary, on_id):
    """One IPC attempt. Connection loss must never replay a possibly dispatched send."""
    from uuid import uuid4
    from .browser_request import adopt_cookies

    try:
        info = json.loads(Path(endpoint).read_text(encoding='utf-8'))
        port, token = info['port'], info['token']
        if not isinstance(port, int) or not 0 < port < 65536 or not isinstance(token, str) or len(token) != 64:
            raise ValueError()
    except (OSError, ValueError, KeyError, TypeError):
        raise ClaudeError('The browser service is unavailable. No message was sent.', code='browser_pool_unavailable', retryable=True) from None
    # Only the branch identity is needed; never copy a growing transcript over IPC.
    branch = {k: existing[k] for k in ('conversation_id', 'current_node', 'is_temporary_chat') if k in existing} if existing else None
    body = {'op': 'send', 'token': token, 'request_id': str(uuid4()), 'cookies': http.saved_state()['cookies'],
        'email': http.account_email, 'headers': dict(http.session.headers), 'timeout': http.timeout,
        'prompt': prompt, 'model': model, 'existing': branch, 'temporary': temporary}
    raw = (json.dumps(body, separators=(',', ':')) + '\n').encode()
    if len(raw) > MAX_FRAME:
        raise ClaudeError('The browser request is too large. No message was sent.', code='invalid_arguments')
    submitted = False
    try:
        with socket.create_connection(('127.0.0.1', port), timeout=min(10, http.timeout)) as connection:
            connection.settimeout(http.timeout + 45)
            submitted = True
            connection.sendall(raw)
            with connection.makefile('rb') as stream:
                while True:
                    line = stream.readline(MAX_FRAME + 1)
                    if not line or len(line) > MAX_FRAME:
                        raise ValueError()
                    response = json.loads(line)
                    if response.get('server_id') and on_id:
                        on_id(response['server_id'])
                    if 'ok' not in response:
                        continue
                    if isinstance(response.get('cookies'), list):
                        adopt_cookies(http, response['cookies'])
                    if response['ok']:
                        prepared = response['request']
                        allowed = {'authorization', 'user-agent', 'oai-language', 'oai-did', 'chatgpt-account-id'}
                        http.session.headers.update({k: v for k, v in prepared['headers'].items() if k.lower() in allowed})
                        return prepared
                    error = response.get('error', {})
                    raise ClaudeError(error.get('message', 'The browser request was refused.'), code=error.get('code', 'browser_pool_unavailable'),
                        status=error.get('http_status'), retryable=error.get('retryable', False))
    except (OSError, ValueError, KeyError, TypeError):
        raise ClaudeError('The browser outcome is not confirmed. No automatic resend was made.' if submitted else
            'The browser service is unavailable. No message was sent.', code='stream_interrupted' if submitted else
            'browser_pool_unavailable', retryable=not submitted) from None


async def serve(directory, version, *, idle_seconds=60):
    import zendriver as zd

    directory.mkdir(parents=True, exist_ok=True)
    endpoint = directory / 'endpoint.json'
    with chat_lock(directory, 'owner'), tempfile.TemporaryDirectory(prefix='empty-', dir=directory) as profile:
        browser = await zd.start(user_data_dir=profile, headless=True,
            browser_args=['--no-first-run', '--no-default-browser-check', '--window-size=650,850'])
        token = secrets.token_hex(32)
        pool = Pool(browser, zd.cdp, token, idle_seconds)
        try:
            server = await asyncio.start_server(pool.handle, '127.0.0.1', 0, limit=MAX_FRAME + 1)
            port = server.sockets[0].getsockname()[1]
            temporary = endpoint.with_suffix('.next')
            temporary.write_text(json.dumps({'port': port, 'token': token, 'pid': os.getpid(), 'version': version}), encoding='utf-8')
            temporary.chmod(0o600)
            temporary.replace(endpoint)
            async with server:
                while pool.active or (not pool.draining and time.monotonic() - pool.last_used < idle_seconds):
                    await asyncio.sleep(1)
                    if browser.stopped:
                        pool.drain()
        finally:
            try:
                await browser.stop()
            finally:
                endpoint.unlink(missing_ok=True)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--version', required=True)
    args = parser.parse_args()
    asyncio.run(serve(args.directory, args.version))
