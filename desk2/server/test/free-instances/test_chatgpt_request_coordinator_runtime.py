"""Production module smoke checks in an owned windowless, account-free fixture."""

import asyncio
import ctypes
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from claudfree.chatgpt import request_coordinator as coordinator
from claudfree.chatgpt import request_ownership as ownership
from claudfree.errors import ClaudeError


async def exchange(endpoint, value):
    reader, writer = await asyncio.open_connection('127.0.0.1', endpoint['port'])
    try:
        writer.write(ownership.json_frame({'token': endpoint['token'], **value}))
        await writer.drain()
        frames = []
        while line := await asyncio.wait_for(reader.readline(), 5):
            frames.append(json.loads(line))
        return frames
    finally:
        writer.close()
        await writer.wait_closed()


async def runtime_fixture(root, python):
    root = Path(root)
    directory, accounts = root / 'service', root / 'accounts'
    endpoint_path = directory / 'endpoint.json'
    service = asyncio.create_task(coordinator.serve(directory, 'synthetic-runtime', accounts,
        python, root / 'no-browser-endpoint.json', cache_dir=root / 'cache', idle_seconds=.1))
    try:
        limit = time.monotonic() + 8
        while not endpoint_path.is_file():
            if service.done():
                await service
            if time.monotonic() >= limit:
                raise TimeoutError('Synthetic coordinator readiness expired')
            await asyncio.sleep(.01)
        endpoint = json.loads(endpoint_path.read_text(encoding='utf-8'))
        ping = await exchange(endpoint, {'op': 'ping'})
        frames = await exchange(endpoint, {'op': 'run', 'request_id': str(uuid4()),
            'state_dir': str(accounts / str(uuid4())),
            'request': {'provider': 'chatgpt', 'command': 'chat', 'prompt': 'Synthetic missing-login check'}})
        owner = ownership._OWNERS[0]
        owner.assert_idle()
        before_phase = owner.api.members(owner.handle)
        await asyncio.wait_for(service, 5)
        token = ownership.CancelToken()
        try:
            phase = ownership.PhaseProcess(owner, python, 'claudfree.chatgpt.request_phase_worker',
                {'phase': 'preflight', 'arguments': {'saved_state': None}}, cancel=token,
                deadline=time.monotonic() + 8, max_bytes=8192)
            phase_result = phase.collect()
            owner.assert_idle()
        finally:
            token.close()
        ctypes.windll.kernel32.GetConsoleWindow.restype = ctypes.c_void_p
        return {'ok': True, 'ping': ping, 'frames': frames, 'pid': os.getpid(),
            'console': int(ctypes.windll.kernel32.GetConsoleWindow() or 0),
            'owner_creation': owner.creation, 'before_phase_members': before_phase,
            'after_phase_members': owner.api.members(owner.handle), 'phase_result': phase_result,
            'phase_cleanup': phase.cleanup_verified, 'phases': len(owner.phases),
            'endpoint_removed': not endpoint_path.exists()}
    finally:
        if not service.done():
            service.cancel()
        await asyncio.gather(service, return_exceptions=True)


def fixture(receipt, root, python):
    try:
        result = asyncio.run(runtime_fixture(root, python))
    except BaseException as error:
        result = {'ok': False, 'error_type': type(error).__name__,
            'error': getattr(error, 'code', 'fixture_error')}
    Path(receipt).write_text(json.dumps(result), encoding='utf-8')


@unittest.skipUnless(os.name == 'nt', 'Windows windowless production ownership')
class CoordinatorRuntimeTests(unittest.TestCase):
    def test_production_coordinator_and_phase_modules_run_without_login_browser_or_console(self):
        with tempfile.TemporaryDirectory(prefix='synthetic-request-runtime-') as folder:
            root = Path(folder)
            receipt = root / 'receipt.json'
            base = Path(getattr(sys, '_base_executable', sys.executable)).with_name('pythonw.exe')
            managed = Path(sys.executable).with_name('pythonw.exe')
            self.assertTrue(base.is_file())
            self.assertTrue(managed.is_file())
            environment = os.environ.copy()
            environment['PYTHONPATH'] = os.pathsep.join(dict.fromkeys(item for item in sys.path if item))
            environment['PYTHONDONTWRITEBYTECODE'] = '1'
            process = subprocess.Popen([str(base), '-B', str(Path(__file__).absolute()),
                '--fixture', str(receipt), str(root), str(managed)], env=environment,
                stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                creationflags=subprocess.CREATE_NO_WINDOW)
            try:
                process.wait(timeout=25)
            finally:
                if process.poll() is None:
                    # The exact synthetic owner handle; its private job owns any phase descendants.
                    process.terminate()
                    process.wait(timeout=10)
            self.assertEqual(process.returncode, 0)
            self.assertTrue(receipt.is_file(), 'Production fixture returned no receipt')
            value = json.loads(receipt.read_text(encoding='utf-8'))
            self.assertTrue(value['ok'], value)
            self.assertEqual(value['pid'], process.pid)
            self.assertEqual(value['console'], 0)
            self.assertTrue(value['ping'][0]['ok'])
            self.assertEqual(value['ping'][0]['pid'], process.pid)
            self.assertTrue(value['frames'][0]['accepted'])
            self.assertEqual(value['frames'][1]['code'], 1)
            failure = json.loads(value['frames'][1]['stdout'])
            self.assertEqual(failure['error']['code'], 'login_required')
            self.assertEqual(failure['error']['message'], 'Run login --provider chatgpt first.')
            self.assertEqual(value['before_phase_members'], [process.pid])
            self.assertEqual(value['after_phase_members'], [process.pid])
            self.assertFalse(value['phase_result']['ok'])
            self.assertFalse(value['phase_result']['saved_state_valid'])
            self.assertEqual(value['phase_result']['error']['code'], 'invalid_arguments')
            self.assertTrue(value['phase_cleanup'])
            self.assertEqual(value['phases'], 0)
            self.assertTrue(value['endpoint_removed'])


class UncertainAccountTests(unittest.IsolatedAsyncioTestCase):
    async def test_an_unconfirmed_phase_holds_only_its_account_and_the_idle_coordinator_still_retires(self):
        # 2026-10-17: sends on a wedged Chrome ended phase_cleanup_unconfirmed. The coordinator then
        # refused every account's sends and, waiting on the held account, never exited (7 hours).
        uncertain, other = str(uuid4()), str(uuid4())

        def account(_coordinator, store, _request, _cancel, _deadline, *, quarantine=None):
            if store.directory.parent.name == uncertain:
                raise ClaudeError('Synthetic browser cleanup is unconfirmed', code='phase_cleanup_unconfirmed')
            return {'ok': True}

        def outcome(frames):
            return json.loads(frames[-1]['stdout'])

        retained = len(ownership._QUARANTINED)
        with tempfile.TemporaryDirectory(prefix='synthetic-uncertain-account-') as folder:
            root = Path(folder)
            directory, accounts = root / 'service', root / 'accounts'
            endpoint_path = directory / 'endpoint.json'

            def run(identity):
                return {'op': 'run', 'request_id': str(uuid4()), 'state_dir': str(accounts / identity),
                    'request': {'provider': 'chatgpt', 'command': 'chat', 'prompt': 'Synthetic prompt'}}

            with patch.object(coordinator, 'OwnerJob', return_value=SimpleNamespace(assert_idle=lambda: None)), \
                    patch.object(coordinator.Coordinator, 'account', account):
                service = asyncio.create_task(coordinator.serve(directory, 'synthetic-uncertain', accounts,
                    'synthetic-python', root / 'no-browser-endpoint.json', cache_dir=root / 'cache', idle_seconds=1))
                try:
                    for _ in range(200):
                        if endpoint_path.is_file() or service.done():
                            break
                        await asyncio.sleep(.02)
                    endpoint = json.loads(endpoint_path.read_text(encoding='utf-8'))
                    unconfirmed = await exchange(endpoint, run(uncertain))
                    ping = await exchange(endpoint, {'op': 'ping'})
                    served = await exchange(endpoint, run(other))
                    again = await exchange(endpoint, run(uncertain))
                    retired = True
                    try:
                        await asyncio.wait_for(asyncio.shield(service), 10)
                    except TimeoutError:
                        retired = False
                    endpoint_left = endpoint_path.exists()
                finally:
                    if not service.done():
                        service.cancel()
                    await asyncio.gather(service, return_exceptions=True)
                    # This process keeps a held account's lock until it exits; release it for the folder.
                    for entry in ownership._QUARANTINED[retained:]:
                        entry[1].__exit__(None, None, None)
                    del ownership._QUARANTINED[retained:]
        self.assertEqual(outcome(unconfirmed)['error']['code'], 'phase_cleanup_unconfirmed')
        self.assertTrue(ping[0]['ok'])
        self.assertTrue(served[0]['accepted'])
        self.assertTrue(outcome(served)['ok'])
        self.assertEqual(outcome(again)['error']['code'], 'chat_busy')
        self.assertTrue(retired, 'The coordinator never retired while it held an uncertain account.')
        self.assertFalse(endpoint_left)


if __name__ == '__main__':
    if len(sys.argv) == 5 and sys.argv[1] == '--fixture':
        fixture(*sys.argv[2:])
    else:
        unittest.main()
