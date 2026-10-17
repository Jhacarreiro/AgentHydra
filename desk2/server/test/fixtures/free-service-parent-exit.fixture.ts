import assert from 'node:assert/strict'
import { dlopen, FFIType, ptr } from 'bun:ffi'
import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// A real Bun parent invokes the production startup functions against a fake,
// stdlib-only Python package. No account state, browser or provider is touched.
const FILES = [
  'chatgpt/request_phases.py',
  'chatgpt/request_coordinator.py',
  'chatgpt/request_ownership.py',
  'chatgpt/request_phase_worker.py',
  'chatgpt/browser_slots.py',
  'chatgpt/browser_pool.py',
  'chatgpt/browser_request.py',
  'chatgpt/api.py',
  'chatgpt/http.py',
  'chatgpt/state.py',
  'chatgpt/registry.py',
  'state.py',
  'registry.py',
  'errors.py',
  'http.py',
  'results.py',
  'signin.py',
  '__init__.py',
  'chatgpt/__init__.py',
]
const TOKEN = 'a'.repeat(64)
const FAKE_SERVICE = `import argparse, ctypes, json, os, pathlib, socket, sys, time
from ctypes import wintypes
p = argparse.ArgumentParser()
p.add_argument('--directory', required=True)
p.add_argument('--version', required=True)
a, _ = p.parse_known_args()
k = ctypes.WinDLL('kernel32', use_last_error=True)
k.GetCurrentProcess.restype = wintypes.HANDLE
k.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
k.OpenProcess.restype = wintypes.HANDLE
k.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4
k.CloseHandle.argtypes = [wintypes.HANDLE]
k.GetConsoleWindow.restype = wintypes.HANDLE
visible = ctypes.WinDLL('user32', use_last_error=True).IsWindowVisible
visible.argtypes = [wintypes.HANDLE]
visible.restype = wintypes.BOOL
owner_job = None
if pathlib.Path(__file__).name == 'request_coordinator.py':
    class Basic(ctypes.Structure):
        _fields_ = [('process_time', ctypes.c_longlong), ('job_time', ctypes.c_longlong),
            ('flags', wintypes.DWORD), ('minimum_ws', ctypes.c_size_t), ('maximum_ws', ctypes.c_size_t),
            ('process_limit', wintypes.DWORD), ('affinity', ctypes.c_size_t),
            ('priority', wintypes.DWORD), ('scheduling', wintypes.DWORD)]
    class Counters(ctypes.Structure):
        _fields_ = [(name, ctypes.c_ulonglong) for name in
            ('read_ops', 'write_ops', 'other_ops', 'read_bytes', 'write_bytes', 'other_bytes')]
    class Extended(ctypes.Structure):
        _fields_ = [('basic', Basic), ('io', Counters), ('process_memory', ctypes.c_size_t),
            ('job_memory', ctypes.c_size_t), ('peak_process', ctypes.c_size_t), ('peak_job', ctypes.c_size_t)]
    k.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
    k.CreateJobObjectW.restype = wintypes.HANDLE
    k.SetInformationJobObject.argtypes = [wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD]
    k.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]
    owner_job = k.CreateJobObjectW(None, None)
    info = Extended()
    info.basic.flags = 0x2000
    if not owner_job or not k.SetInformationJobObject(owner_job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise ctypes.WinError(ctypes.get_last_error())
    if not k.AssignProcessToJobObject(owner_job, k.GetCurrentProcess()):
        raise ctypes.WinError(ctypes.get_last_error())
def creation(handle):
    values = [wintypes.FILETIME() for _ in range(4)]
    if not k.GetProcessTimes(handle, *(ctypes.byref(value) for value in values)):
        raise ctypes.WinError(ctypes.get_last_error())
    return str((values[0].dwHighDateTime << 32) | values[0].dwLowDateTime)
launcher = None
if sys.prefix != sys.base_prefix:
    handle = k.OpenProcess(0x1000, False, os.getppid())
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        launcher = {'pid': os.getppid(), 'creation': creation(handle)}
    finally:
        k.CloseHandle(handle)
with socket.socket() as listener:
    listener.bind(('127.0.0.1', 0))
    listener.listen()
    listener.settimeout(.2)
    endpoint = {'port': listener.getsockname()[1], 'token': 'a' * 64,
        'version': a.version, 'pid': os.getpid(), 'creation': creation(k.GetCurrentProcess()),
        'console_visible': bool(visible(k.GetConsoleWindow())) if k.GetConsoleWindow() else False,
        'windowless_executable': pathlib.Path(sys.executable).name.lower() == 'pythonw.exe',
        'owner_job': owner_job is not None,
        'launcher': launcher}
    folder = pathlib.Path(a.directory)
    folder.mkdir(parents=True, exist_ok=True)
    temporary = folder / 'endpoint.next'
    temporary.write_text(json.dumps(endpoint), encoding='utf-8')
    temporary.replace(folder / 'endpoint.json')
    deadline = time.monotonic() + 40
    while time.monotonic() < deadline:
        try:
            client, _ = listener.accept()
        except socket.timeout:
            continue
        with client:
            client.settimeout(1)
            try:
                raw = b''
                while not raw.endswith(b'\\n') and len(raw) < 4096:
                    part = client.recv(4096)
                    if not part:
                        break
                    raw += part
                value = json.loads(raw)
                client.sendall((json.dumps({'ok': value.get('op') == 'ping'
                    and value.get('token') == 'a' * 64, 'pid': os.getpid()}) + '\\n').encode())
            except (OSError, ValueError):
                pass
`

interface Receipt {
  pid: number
  creation: string
  console_visible: boolean
  windowless_executable: boolean
  owner_job: boolean
  port: number
  launcher: { pid: number; creation: string } | null
}

function openProcessLibrary() {
  return dlopen('kernel32.dll', {
    OpenProcess: { args: [FFIType.u32, FFIType.i32, FFIType.u32], returns: FFIType.ptr },
    GetProcessTimes: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    QueryFullProcessImageNameW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    WaitForSingleObject: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.u32 },
    TerminateProcess: { args: [FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    CloseHandle: { args: [FFIType.ptr], returns: FFIType.i32 },
  })
}

// Match production's process-lifetime Win32 bindings. Fixture process handles are
// closed individually; the shared DLL is not unloaded between unrelated test files.
let processLibrary: ReturnType<typeof openProcessLibrary> | undefined

/** Retain exact native process handles before the parent exits; never kill by a recycled PID. */
function nativeProcesses() {
  processLibrary ??= openProcessLibrary()
  const library = processLibrary
  type Handle = ReturnType<typeof library.symbols.OpenProcess>
  const handles: Handle[] = []
  const claimed = new Map<number, Handle>()
  return {
    claim(pid: number, creation: string) {
      if (claimed.has(pid)) return claimed.get(pid)!
      const handle = library.symbols.OpenProcess(0x100401, 0, pid)
      if (!handle) throw new Error('Synthetic service process exited before it could be claimed')
      try {
        const times = new BigUint64Array(4)
        if (
          !library.symbols.GetProcessTimes(
            handle,
            ptr(times.subarray(0, 1)),
            ptr(times.subarray(1, 2)),
            ptr(times.subarray(2, 3)),
            ptr(times.subarray(3, 4)),
          )
        )
          throw new Error('Synthetic process creation could not be verified')
        assert.strictEqual(times[0]!.toString(), creation)
        const image = new Uint16Array(32768),
          length = new Uint32Array([image.length])
        if (!library.symbols.QueryFullProcessImageNameW(handle, 0, ptr(image), ptr(length)))
          throw new Error('Synthetic interpreter image could not be verified')
        assert.strictEqual(
          Buffer.from(image.buffer, 0, length[0]! * 2)
            .toString('utf16le')
            .toLowerCase()
            .endsWith('\\pythonw.exe'),
          true,
        )
      } catch (error) {
        library.symbols.CloseHandle(handle)
        throw error
      }
      handles.push(handle)
      claimed.set(pid, handle)
      return handle
    },
    alive(handle: Handle) {
      const status = library.symbols.WaitForSingleObject(handle, 0)
      if (status !== 0 && status !== 0x102) throw new Error('Synthetic process wait failed')
      return status === 0x102
    },
    async close() {
      try {
        for (const handle of handles)
          if (library.symbols.WaitForSingleObject(handle, 0) === 0x102)
            library.symbols.TerminateProcess(handle, 197)
        const deadline = Date.now() + 5000
        while (
          handles.some((handle) => library.symbols.WaitForSingleObject(handle, 0) === 0x102) &&
          Date.now() < deadline
        )
          await Bun.sleep(20)
        assert.strictEqual(
          handles.every((handle) => library.symbols.WaitForSingleObject(handle, 0) === 0),
          true,
        )
      } finally {
        for (const handle of handles) library.symbols.CloseHandle(handle)
      }
    },
  }
}

async function ping(port: number): Promise<{ ok: boolean; pid?: number }> {
  return new Promise((resolve) => {
    const socket = connect({ host: '127.0.0.1', port })
    let raw = '',
      settled = false
    const finish = (answer: { ok: boolean; pid?: number }) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(answer)
    }
    const timer = setTimeout(() => finish({ ok: false }), 1000)
    socket.once('error', () => finish({ ok: false }))
    socket.once('end', () => finish({ ok: false }))
    socket.once('connect', () => socket.write(JSON.stringify({ op: 'ping', token: TOKEN }) + '\n'))
    socket.on('data', (chunk) => {
      raw += chunk.toString('utf8')
      if (raw.length > 4096) return finish({ ok: false })
      if (!raw.includes('\n')) return
      try {
        finish(JSON.parse(raw.split('\n')[0]!))
      } catch {
        finish({ ok: false })
      }
    })
  })
}

function removeFixture(root: string): void {
  const absolute = resolve(root)
  if (!absolute.startsWith(resolve(tmpdir()) + '\\'))
    throw new Error('Fixture cleanup escaped its owned temp root')
  rmSync(absolute, { recursive: true, force: true })
}

async function verify(kind: 'browser-pool' | 'request-coordinator') {
  const basePython = Bun.which('pythonw.exe')
  if (!basePython) throw new Error('The windowless Python fixture runtime is unavailable')
  const root = mkdtempSync(join(tmpdir(), 'free-service-owner-'))
  const venv = join(root, 'venv')
  execFileSync(basePython, ['-m', 'venv', '--without-pip', venv], {
    windowsHide: true,
    stdio: 'ignore',
    timeout: 20_000,
  })
  const python = join(venv, 'Scripts', 'pythonw.exe')
  const config = {
    python,
    harnessDir: join(root, 'harness'),
    cacheDir: join(root, 'cache'),
    stateDir: join(root, 'unused-state', 'synthetic-account'),
  }
  const release = join(root, 'parent-exit')
  const receipt = join(root, 'ready.json')
  const script = join(root, 'parent.ts')
  const fixtureEnv = {
    ...process.env,
    HOME: root,
    USERPROFILE: root,
    LOCALAPPDATA: root,
    APPDATA: root,
    CLAUDFREE_STATE_DIR: join(root, 'unused-state'),
    CLAUDFREE_CACHE_DIR: config.cacheDir,
    PYTHONDONTWRITEBYTECODE: '1',
  }
  for (const file of FILES) {
    const path = join(config.harnessDir, 'claudfree', file)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, '# Synthetic, stdlib-only service fixture.\n')
  }
  writeFileSync(join(config.harnessDir, 'claudfree', 'chatgpt', 'browser_pool.py'), FAKE_SERVICE)
  writeFileSync(
    join(config.harnessDir, 'claudfree', 'chatgpt', 'request_coordinator.py'),
    FAKE_SERVICE,
  )
  const source = pathToFileURL(
    resolve(import.meta.dir, '../../src/free-instances', kind + '.ts'),
  ).href
  writeFileSync(
    script,
    `import { existsSync, readFileSync, writeFileSync } from 'node:fs'
const mod = await import(${JSON.stringify(source)})
const config = ${JSON.stringify(config)}
const result = ${
      kind === 'browser-pool'
        ? 'await mod.ensureBrowserPool(config, new AbortController().signal)'
        : `await mod.ensureRequestCoordinator(config, ${JSON.stringify(join(root, 'unused-browser-endpoint.json'))}, new AbortController().signal)`
    }
${
  kind === 'browser-pool'
    ? 'const endpoint = result'
    : `const { readdirSync } = await import('node:fs'); const { join } = await import('node:path'); const base = join(config.cacheDir, 'chatgpt-request-coordinator'); const endpoint = join(base, readdirSync(base)[0], 'endpoint.json')`
}
const { pid, creation, console_visible, windowless_executable, owner_job, port, launcher } = JSON.parse(readFileSync(endpoint, 'utf8'))
writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ pid, creation, console_visible, windowless_executable, owner_job, port, launcher }))
const deadline = Date.now() + 15000
while (!existsSync(${JSON.stringify(release)}) && Date.now() < deadline) await Bun.sleep(20)
process.exit(existsSync(${JSON.stringify(release)}) ? 0 : 2)
`,
  )
  const native = nativeProcesses()
  const parent = Bun.spawn([process.execPath, script], {
    cwd: root,
    env: fixtureEnv,
    stdin: 'ignore',
    stdout: 'ignore',
    stderr: 'ignore',
    windowsHide: true,
    timeout: 70_000,
  })
  try {
    let frame: Receipt | undefined
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      try {
        frame = JSON.parse(readFileSync(receipt, 'utf8')) as Receipt
        break
      } catch {
        if (parent.exitCode !== null)
          throw new Error('Synthetic spawning parent exited before readiness')
        await Bun.sleep(25)
      }
    }
    if (!frame) throw new Error('Synthetic spawning parent did not become ready')
    const actual = native.claim(frame.pid, frame.creation)
    if (!frame.launcher) throw new Error('Synthetic managed venv did not expose its launcher')
    const launcher = native.claim(frame.launcher.pid, frame.launcher.creation)
    assert.strictEqual(frame.console_visible, false)
    assert.strictEqual(frame.windowless_executable, true)
    assert.strictEqual(frame.owner_job, kind === 'request-coordinator')
    assert.deepStrictEqual(await ping(frame.port), { ok: true, pid: frame.pid })
    writeFileSync(release, 'exit')
    assert.strictEqual(await parent.exited, 0)
    await Bun.sleep(1000)
    // This is the required production ownership contract, not a provider send.
    assert.strictEqual(native.alive(actual), true)
    assert.strictEqual(native.alive(launcher), true)
    assert.deepStrictEqual(await ping(frame.port), { ok: true, pid: frame.pid })
  } finally {
    if (parent.exitCode === null) parent.kill()
    await parent.exited
    // A startup failure can precede the parent's receipt. Claim any endpoint
    // written by these exact fake modules before releasing their owned folder.
    for (const family of ['chatgpt-browser-pool', 'chatgpt-request-coordinator']) {
      const base = join(config.cacheDir, family)
      if (!existsSync(base)) continue
      for (const generation of readdirSync(base)) {
        try {
          const frame = JSON.parse(
            readFileSync(join(base, generation, 'endpoint.json'), 'utf8'),
          ) as Receipt
          native.claim(frame.pid, frame.creation)
          if (frame.launcher) native.claim(frame.launcher.pid, frame.launcher.creation)
        } catch {
          /* already exited, or never produced a complete owned endpoint */
        }
      }
    }
    await native.close()
    removeFixture(root)
  }
}

const kind = process.argv[2]
if (kind !== 'browser-pool' && kind !== 'request-coordinator')
  throw new Error('Unknown synthetic service')
await verify(kind)
console.log(JSON.stringify({ kind, verified: true }))
