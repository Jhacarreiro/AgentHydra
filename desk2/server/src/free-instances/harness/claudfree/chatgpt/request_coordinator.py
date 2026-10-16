"""Windowless request ownership with short-lived HTTP phases and no send retries.

The account lease spans preflight, browser admission, confirmation and persistence.
Only the existing browser broker dispatches a message; HTTP phases are GET-only.
Queued requests retain small cookie/branch snapshots instead of Python interpreters.
"""

import argparse
import asyncio
from concurrent.futures import ThreadPoolExecutor
import hashlib
import hmac
import json
import os
import queue
import secrets
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from uuid import UUID, uuid4

from ..errors import ClaudeError
from ..registry import chat_lock
from .api import ChatGPTClient
from .browser_pool import MAX_FRAME as BROKER_FRAME
from .browser_request import adopt_cookies
from .browser_slots import browser_slot
from .http import ChatGPTHttp
from .registry import ChatGPTRegistry
from .request_ownership import AccountLeases, CancelToken, OwnerJob, PhaseProcess, json_frame
from .state import ChatGPTState

INPUT_LIMIT = 1024 * 1024
OUTPUT_LIMIT = 8 * 1024 * 1024
PHASE_LIMIT = 12 * 1024 * 1024 + 65536
MAX_ACTIVE = 16


def failure(error):
    return {'ok': False, 'error': error.as_dict()}


def phase_error(value):
    error = value.get('error', {})
    return ClaudeError(error.get('message', 'The request phase could not finish.'),
        code=error.get('code', 'operation_failed'), status=error.get('http_status'),
        retryable=error.get('retryable', False), chat_id=error.get('chat_id'),
        model=error.get('model'))


def validate(value, root):
    """Account scope and command checks precede acceptance or any account traffic."""
    identity = str(UUID(value['request_id']))
    directory = Path(value['state_dir']).resolve()
    if directory.parent != root or str(UUID(directory.name)) != directory.name.lower():
        raise ValueError('Account directory is outside the configured state root')
    request = value['request']
    if not isinstance(request, dict) or request.get('provider') != 'chatgpt' or request.get('command') not in {'chat', 'resume'}:
        raise ValueError('Unsupported request')
    prompt = request.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip() or len(prompt) > 100000:
        raise ValueError('Invalid prompt')
    for name in ('chatId', 'name', 'model'):
        if request.get(name) is not None and not isinstance(request[name], str):
            raise ValueError('Invalid request field')
    if request.get('webSearch') not in (None, False, True):
        raise ValueError('Invalid search option')
    return identity, directory, request


class Coordinator:
    def __init__(self, owner, python, root, browser_endpoint, token, *, cache_dir=None, idle_seconds=60):
        self.owner, self.python = owner, python
        self.root, self.browser_endpoint, self.token = root.resolve(), browser_endpoint, token
        self.slots_root = (cache_dir or root) / 'browser-slots'
        self.leases = AccountLeases()
        self.active = 0
        self.seen = set()
        self.draining = False
        self.last_used = time.monotonic()
        self.idle_seconds = idle_seconds
        self.loop = None

    async def write(self, writer, value):
        writer.write(json_frame(value))
        await writer.drain()

    async def handle(self, reader, writer):
        task = disconnected = None
        cancel = None
        claimed = False
        identity = None
        try:
            raw = await asyncio.wait_for(reader.readline(), 5)
            if not raw.endswith(b'\n') or len(raw) > INPUT_LIMIT:
                raise ValueError('Invalid request frame')
            value = json.loads(raw)
            if not isinstance(value, dict):
                raise ValueError('Invalid request')
            token = value.get('token', '')
            if not isinstance(token, str) or not hmac.compare_digest(token, self.token):
                await self.write(writer, {'accepted': False, 'error': {'code': 'unauthorized'}})
                return
            if value.get('op') == 'ping':
                await self.write(writer, {'ok': not self.draining, 'pid': os.getpid()})
                return
            if value.get('op') != 'run':
                raise ValueError('Invalid operation')
            identity, directory, request = validate(value, self.root)
            if self.draining or self.active >= MAX_ACTIVE or identity in self.seen:
                await self.write(writer, {'accepted': False, 'request_id': identity,
                    'error': {'code': 'request_already_claimed' if identity in self.seen else 'coordinator_unavailable'}})
                return
            self.seen.add(identity)
            self.active += 1
            claimed = True
            cancel = CancelToken()
            deadline = time.monotonic() + 300
            await self.write(writer, {'accepted': True, 'request_id': identity})
            task = asyncio.create_task(asyncio.to_thread(self.execute, directory, request, cancel, deadline))
            disconnected = asyncio.create_task(reader.read(1))
            done, _ = await asyncio.wait((task, disconnected), return_when=asyncio.FIRST_COMPLETED)
            if task not in done:
                cancel.set()
            # Do not release account/phase ownership just because its caller left.
            output = await task
            if task in done:
                await self.write(writer, {'request_id': identity, **output})
        except (ValueError, KeyError, TypeError, asyncio.TimeoutError, asyncio.LimitOverrunError):
            if not claimed:
                try:
                    await self.write(writer, {'accepted': False, 'request_id': identity,
                        'error': {'code': 'invalid_request'}})
                except (ConnectionError, OSError):
                    pass
        except (ConnectionError, OSError):
            pass
        finally:
            if cancel:
                cancel.set()
            if task and not task.done():
                await asyncio.shield(task)
            if disconnected and not disconnected.done():
                disconnected.cancel()
                await asyncio.gather(disconnected, return_exceptions=True)
            if cancel:
                cancel.close()
            if claimed:
                self.active -= 1
                self.last_used = time.monotonic()
                # Claims are never replayed within this service lifetime. Bound
                # the set by retiring the service once its current work drains.
                if len(self.seen) >= 4096:
                    self.draining = True
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    def phase(self, kind, arguments, cancel, deadline):
        process = PhaseProcess(self.owner, self.python, 'claudfree.chatgpt.request_phase_worker',
            {'phase': kind, 'arguments': arguments}, cancel=cancel, deadline=deadline,
            max_bytes=PHASE_LIMIT if kind == 'readback' else BROKER_FRAME + 65536)
        return process.collect()

    def execute(self, directory, request, cancel, deadline):
        result = None
        try:
            store = ChatGPTState(directory / 'chatgpt')
            with self.leases.acquire(store.directory, cancel=cancel,
                    deadline=min(deadline, time.monotonic() + 210)) as lease:
                def quarantine():
                    lease.quarantine()
                    self.draining = True
                try:
                    result = self.account(store, request, cancel, deadline, quarantine=quarantine)
                except ClaudeError as error:
                    if error.code == 'phase_cleanup_unconfirmed':
                        lease.quarantine()
                        self.draining = True
                    raise
        except ClaudeError as error:
            result = failure(error)
        except Exception:
            result = failure(ClaudeError('The request outcome could not be confirmed. Do not resend automatically.',
                code='operation_failed'))
        raw = json_frame(result)[:-1].decode('utf-8')
        code = 0 if result.get('ok') else 1
        if len(raw.encode()) > OUTPUT_LIMIT:
            code = 1
            raw = json.dumps(failure(ClaudeError('The request output exceeded its limit. Read the chat before sending again.',
                code='output_too_large', chat_id=result.get('chat_id') or result.get('error', {}).get('chat_id'),
                model=result.get('model') or result.get('error', {}).get('model'))), separators=(',', ':'))
        return {'code': code, 'stdout': raw}

    def account(self, store, request, cancel, deadline, *, quarantine=None):
        saved = latest = None
        registry = None
        result = None
        entry = model = None
        pending = False
        try:
            self.check(cancel, deadline)
            if request.get('webSearch'):
                raise ClaudeError('ChatGPT currently supports default-model Temporary Chats. Forced web search is not supported.', code='unsupported_option')
            registry = ChatGPTRegistry(store.directory)
            name = request.get('name')
            # Node's UTF-8 hashing replaces unpaired UTF-16 surrogates with U+FFFD.
            normalized = name.encode('utf-16-le', 'surrogatepass').decode('utf-16-le', 'replace') if name else None
            alias = f"desk-{hashlib.sha256(normalized.encode()).hexdigest()[:24]}" if normalized else None
            args = SimpleNamespace(command=request['command'], name=alias,
                identifier=request.get('chatId'), chat_id=None)
            entry, server_id = ChatGPTClient._resolve(registry, args)
            saved = latest = store.load()
            if saved is None:
                raise ClaudeError('Run login --provider chatgpt first.', code='login_required')
            preflight = self.phase('preflight', {'saved_state': saved, 'server_id': server_id,
                'prefer': request.get('model'), 'timeout': 120}, cancel, deadline)
            if preflight.get('saved_state_valid'):
                latest = preflight['saved_state']
            if not preflight.get('ok'):
                raise phase_error(preflight)
            if not preflight.get('saved_state_valid'):
                raise ClaudeError('Rotated login cookies could not be captured.', code='session_save_failed')
            model = preflight['model']
            self.check(cancel, deadline)
            entry = registry.record(entry['chat_id'], 'chatgpt', name=entry['name'], temporary=True, status='pending')
            pending = True
            if server_id:
                registry.link(entry['chat_id'], server_id)
            # This is the original browser wait anchor, after successful HTTP
            # preflight and registry recording; phase transitions never reset it.
            queue_deadline = min(deadline, time.monotonic() + 120)
            with browser_slot(self.slots_root, wait=120, locker=chat_lock, cancel=cancel, deadline=queue_deadline):
                browser_result, latest = self.browser(preflight, latest, request['prompt'],
                    lambda value: registry.link(entry['chat_id'], value), cancel, deadline)
                if not browser_result.get('ok'):
                    raise phase_error(browser_result)
                prepared = browser_result['request']
            self.check(cancel, deadline)
            tail = self.phase('readback', {'saved_state': latest, 'headers': preflight['headers'],
                'branch': preflight['existing'], 'previous_ids': preflight['previous_ids'],
                'model': model, 'prompt': request['prompt'], 'prepared': prepared,
                'entry': {'chat_id': entry['chat_id'], 'name': entry['name']},
                'command': request['command'], 'timeout': 120, 'brief': True}, cancel, deadline)
            if tail.get('saved_state_valid'):
                latest = tail['saved_state']
            if not tail.get('ok'):
                raise phase_error(tail)
            if not tail.get('saved_state_valid'):
                raise ClaudeError('Rotated login cookies could not be captured.', code='session_save_failed')
            result = tail['result']
            registry.link(entry['chat_id'], result['server_conversation_id'])
            registry.status(entry['chat_id'], 'available')
        except ClaudeError as error:
            if error.code == 'phase_cleanup_unconfirmed' and quarantine:
                quarantine()  # Latch before fallible registry/cookie bookkeeping.
            if isinstance(getattr(error, '_saved_state', None), dict):
                latest = error._saved_state
            if isinstance(getattr(error, '_browser_response', None), dict):
                try:
                    latest = self.snapshot(error._browser_response, latest)
                except Exception:
                    pass  # Preserve the cleanup failure and last verified snapshot.
            for found in getattr(error, '_server_ids', []):
                registry.link(entry['chat_id'], found)
            if pending:
                registry.status(entry['chat_id'], error.code)
                error = ClaudeError(str(error), code=error.code, status=error.status,
                    retryable=error.retryable, chat_id=entry['chat_id'], model=model)
            result = failure(error)
            if error.code == 'phase_cleanup_unconfirmed':
                raise
        finally:
            try:
                if saved is not None and latest is not None and latest != saved:
                    try:
                        store.save(latest)
                    except (OSError, ClaudeError):
                        if result is None or result.get('ok'):
                            result = failure(ClaudeError('The reply was received but rotated login cookies could not be saved. Do not resend automatically.',
                                code='session_save_failed', chat_id=entry['chat_id'] if entry else None, model=model))
            finally:
                if registry is not None:
                    registry.close()
        return result

    @staticmethod
    def check(cancel, deadline):
        if cancel.is_set() or time.monotonic() >= deadline:
            raise ClaudeError('The request was stopped. Read its chat before sending again.', code='stopped')

    def browser(self, preflight, saved, prompt, on_id, cancel, deadline):
        events = queue.Queue()
        closed = threading.Event()
        state = {'verified': False, 'task': None}
        terminal = False
        updated = None

        def launch():
            task = asyncio.create_task(self.browser_request(preflight, saved, prompt, events, state))
            state['task'] = task
            def finished(done):
                if done.cancelled() and not state.get('connected'):
                    state['verified'] = True
                elif not done.cancelled():
                    done.exception()  # Consume unexpected failures without printing private data.
                closed.set()
            task.add_done_callback(finished)

        self.loop.call_soon_threadsafe(launch)
        try:
            while True:
                self.check(cancel, deadline)
                try:
                    kind, value = events.get(timeout=min(.25, max(.001, deadline - time.monotonic())))
                except queue.Empty:
                    if closed.is_set():
                        raise ClaudeError('The browser outcome could not be confirmed. No automatic resend was made.', code='stream_interrupted')
                    continue
                if kind == 'server_id':
                    on_id(value)
                elif kind == 'error':
                    terminal = True
                    raise value
                else:
                    terminal = True
                    response = value
                    # Adopt exactly the same cookie-domain replacement rules as
                    # the legacy broker client, including rotated error cookies.
                    updated = self.snapshot(response, saved)
                    return response, updated
        finally:
            def stop():
                task = state['task']
                if task and not task.done():
                    task.cancel()
            # Runs after launch even if the caller stopped before task creation.
            if not terminal:
                self.loop.call_soon_threadsafe(stop)
            cleanup_finished = closed.wait(10)
            buffered_ids, buffered_response = [], None
            if cleanup_finished:
                while True:
                    try:
                        kind, value = events.get_nowait()
                    except queue.Empty:
                        break
                    if kind == 'server_id':
                        buffered_ids.append(value)
                    elif kind == 'result':
                        buffered_response = value
            if not cleanup_finished or not state['verified']:
                error = ClaudeError('The owned browser request could not confirm cleanup. This account is held for review; no automatic resend was made.',
                    code='phase_cleanup_unconfirmed')
                if updated is not None:
                    error._saved_state = updated  # Memory only; never part of error.as_dict().
                error._server_ids = buffered_ids
                error._browser_response = buffered_response
                raise error
            for found in buffered_ids:
                on_id(found)  # SQLite remains on the account-owning thread.
            if buffered_response is not None and updated is None:
                updated = self.snapshot(buffered_response, saved)
            active_error = sys.exc_info()[1]
            if isinstance(active_error, ClaudeError) and updated is not None:
                active_error._saved_state = updated

    @staticmethod
    def snapshot(response, saved):
        http = ChatGPTHttp(saved, timeout=120)
        try:
            if isinstance(response.get('cookies'), list):
                adopt_cookies(http, response['cookies'])
            return http.saved_state()
        finally:
            http.close()

    async def browser_request(self, preflight, saved, prompt, events, state):
        writer = None
        reader = None
        final = None
        submitted = False
        try:
            info = json.loads(self.browser_endpoint.read_text(encoding='utf-8'))
            port, token = info['port'], info['token']
            if isinstance(port, bool) or not isinstance(port, int) or not 0 < port < 65536 or not isinstance(token, str) or len(token) != 64:
                raise ValueError('Invalid broker endpoint')
            body = {'op': 'send', 'token': token, 'request_id': str(uuid4()),
                'cookies': saved['cookies'], 'email': preflight['account_email'],
                'headers': preflight['headers'], 'timeout': 120, 'prompt': prompt,
                'model': preflight['model'], 'existing': preflight['existing'], 'temporary': True}
            raw = (json.dumps(body, separators=(',', ':')) + '\n').encode()
            if len(raw) > BROKER_FRAME:
                raise ClaudeError('The browser request is too large. No message was sent.', code='invalid_arguments')
            reader, writer = await asyncio.wait_for(asyncio.open_connection('127.0.0.1', port, limit=BROKER_FRAME + 1), 10)
            state['connected'] = True
            submitted = True
            writer.write(raw)
            await writer.drain()
            # Match the original per-read socket deadline. Progress may extend
            # readback, but the outer request's fixed 300s deadline still applies.
            while True:
                line = await asyncio.wait_for(reader.readline(), 165)
                if not line.endswith(b'\n') or len(line) > BROKER_FRAME:
                    raise ValueError('Invalid broker frame')
                response = json.loads(line)
                if not isinstance(response, dict):
                    raise ValueError('Invalid broker response')
                if response.get('server_id'):
                    events.put(('server_id', response['server_id']))
                if 'ok' in response:
                    final = response
                    events.put(('result', response))
                    return
        except ClaudeError as error:
            events.put(('error', error))
        except (OSError, ValueError, KeyError, TypeError, asyncio.TimeoutError):
            events.put(('error', ClaudeError('The browser outcome is not confirmed. No automatic resend was made.' if submitted
                else 'The browser service is unavailable. No message was sent.',
                code='stream_interrupted' if submitted else 'browser_pool_unavailable', retryable=not submitted)))
        finally:
            if writer:
                try:
                    if final is None:
                        # The broker treats one extra byte as caller cancellation,
                        # awaits context disposal, then sends its cleanup receipt.
                        try:
                            writer.write(b'\n')
                            await writer.drain()
                        except OSError:
                            pass  # A final frame may already be buffered before EOF.
                        cleanup_deadline = time.monotonic() + 5
                        received = 0
                        while True:
                            trailer = await asyncio.wait_for(reader.readline(),
                                max(.001, cleanup_deadline - time.monotonic()))
                            if not trailer:
                                break
                            received += len(trailer)
                            if received > BROKER_FRAME * 2:
                                raise ValueError('Cleanup receipt exceeded its bound')
                            receipt = json.loads(trailer)
                            if not isinstance(receipt, dict):
                                raise ValueError('Invalid cleanup receipt')
                            if receipt.get('server_id'):
                                events.put(('server_id', receipt['server_id']))
                            if 'ok' in receipt:
                                events.put(('result', receipt))
                            if 'cleanup_verified' in receipt:
                                state['verified'] = receipt['cleanup_verified'] is True
                    else:
                        state['verified'] = final.get('cleanup_verified') is True
                        if await asyncio.wait_for(reader.read(1), 5) != b'':
                            state['verified'] = False
                except (OSError, ValueError, asyncio.TimeoutError):
                    state['verified'] = False
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionError, OSError):
                    pass
            else:
                state['verified'] = True


async def serve(directory, version, root, python, browser_endpoint, *, cache_dir=None, idle_seconds=60):
    # The broker is a separately owned sibling, never a descendant of this job.
    owner = OwnerJob()
    directory.mkdir(parents=True, exist_ok=True)
    endpoint = directory / 'endpoint.json'
    with chat_lock(directory, 'owner'):
        coordinator = Coordinator(owner, python, root, browser_endpoint, secrets.token_hex(32), cache_dir=cache_dir, idle_seconds=idle_seconds)
        coordinator.loop = asyncio.get_running_loop()
        # Small-core PCs must still perform all admitted preflights concurrently;
        # native browser waits cannot occupy the default executor ahead of them.
        coordinator.loop.set_default_executor(ThreadPoolExecutor(max_workers=MAX_ACTIVE,
            thread_name_prefix='free-account'))
        server = await asyncio.start_server(coordinator.handle, '127.0.0.1', 0, limit=INPUT_LIMIT + 1)
        try:
            port = server.sockets[0].getsockname()[1]
            temporary = endpoint.with_suffix('.next')
            temporary.write_text(json.dumps({'port': port, 'token': coordinator.token, 'version': version, 'pid': os.getpid()}), encoding='utf-8')
            temporary.chmod(0o600)
            temporary.replace(endpoint)
            async with server:
                while coordinator.active or coordinator.leases.quarantined or (not coordinator.draining and time.monotonic() - coordinator.last_used < idle_seconds):
                    await asyncio.sleep(1)
        finally:
            endpoint.unlink(missing_ok=True)
            owner.assert_idle()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--version', required=True)
    parser.add_argument('--state-root', type=Path, required=True)
    parser.add_argument('--python', required=True)
    parser.add_argument('--browser-endpoint', type=Path, required=True)
    parser.add_argument('--cache-dir', type=Path, required=True)
    args = parser.parse_args()
    asyncio.run(serve(args.directory, args.version, args.state_root, args.python, args.browser_endpoint, cache_dir=args.cache_dir))
