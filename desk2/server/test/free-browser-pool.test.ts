import { afterAll, beforeAll, expect, test } from 'bun:test'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserPoolPython, ensureBrowserPool } from '../src/free-instances/browser-pool'

let root: string
let server: Server
let pings = 0
const token = 'a'.repeat(64)
let endpoint: string
let config: { harnessDir: string; python: string; stateDir: string; cacheDir: string }

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'free-browser-pool-'))
  config = { harnessDir: join(root, 'harness'), python: 'unused-fixture-python', stateDir: join(root, 'state'), cacheDir: join(root, 'cache') }
  mkdirSync(join(config.harnessDir, 'claudfree', 'chatgpt'), { recursive: true })
  const hash = createHash('sha256')
  for (const name of ['chatgpt/browser_pool.py', 'chatgpt/browser_request.py', 'chatgpt/http.py', 'signin.py', 'state.py', 'errors.py', 'registry.py']) {
    writeFileSync(join(config.harnessDir, 'claudfree', name), 'fixture')
    hash.update('fixture')
  }
  const version = hash.digest('hex')
  const directory = join(config.cacheDir, 'chatgpt-browser-pool', version.slice(0, 16))
  mkdirSync(directory, { recursive: true })
  server = createServer(socket => {
    socket.once('data', data => {
      const request = JSON.parse(data.toString()) as { op: string; token: string }
      expect(request).toEqual({ op: 'ping', token })
      pings++
      socket.end(JSON.stringify({ ok: true }) + '\n')
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  endpoint = join(directory, 'endpoint.json')
  writeFileSync(endpoint, JSON.stringify({ port: address.port, token, version }))
})

afterAll(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()))
  rmSync(root, { recursive: true, force: true })
})

test('headless browser pool coalesces simultaneous startup checks and reuses the owned endpoint', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, () => ensureBrowserPool(config, new AbortController().signal)))
  expect(results).toEqual(Array(12).fill(endpoint))
  expect(pings).toBe(1)
  expect(await ensureBrowserPool(config, new AbortController().signal)).toBe(endpoint)
  expect(pings).toBe(2)
})

test('cancelling one browser-pool waiter leaves another waiter and the shared browser alone', async () => {
  const cancelled = new AbortController()
  const first = ensureBrowserPool(config, cancelled.signal)
  const second = ensureBrowserPool(config, new AbortController().signal)
  cancelled.abort()
  await expect(first).rejects.toThrow('stopped')
  expect(await second).toBe(endpoint)
})

test('Windows broker selects only the configured environment\'s windowless Python sibling', () => {
  const scripts = join(root, 'selection', 'Scripts')
  mkdirSync(scripts, { recursive: true })
  const windowless = join(scripts, 'pythonw.exe')
  writeFileSync(windowless, 'synthetic wrapper')
  expect(browserPoolPython(join(scripts, 'python.exe'), 'win32')).toBe(windowless)
  expect(browserPoolPython(windowless, 'win32')).toBe(windowless)
  expect(browserPoolPython('python3', 'linux')).toBe('python3')
  expect(browserPoolPython('/opt/example/bin/python', 'darwin')).toBe('/opt/example/bin/python')
})

test('Windows broker fails closed when the windowless sibling is missing or not a file', () => {
  const scripts = join(root, 'missing', 'Scripts')
  mkdirSync(scripts, { recursive: true })
  expect(() => browserPoolPython(join(scripts, 'python.exe'), 'win32')).toThrow('browser_pool_requires_pythonw')
  mkdirSync(join(scripts, 'pythonw.exe'))
  expect(() => browserPoolPython(join(scripts, 'python.exe'), 'win32')).toThrow('browser_pool_requires_pythonw')
  expect(() => browserPoolPython(join(scripts, 'other.exe'), 'win32')).toThrow('browser_pool_requires_pythonw')
  expect(() => browserPoolPython('python.exe', 'win32')).toThrow('browser_pool_requires_pythonw')
})

test.skipIf(process.platform !== 'win32')('pool startup reports the missing windowless wrapper without a console fallback', async () => {
  await expect(ensureBrowserPool({
    ...config,
    python: join(root, 'absent-wrapper', 'Scripts', 'python.exe'),
    cacheDir: join(root, 'absent-wrapper-cache'),
  }, new AbortController().signal)).rejects.toThrow('browser_pool_requires_pythonw')
})

test.skipIf(process.platform !== 'win32')('detached Windows broker launcher preserves its venv without a console', async () => {
  const venv = join(root, 'isolated-venv')
  // No packages, browser or account access: this proves the interpreter wrapper alone.
  const python = Bun.which('pythonw.exe') ?? browserPoolPython(Bun.which('python.exe') ?? '')
  execFileSync(python, ['-m', 'venv', '--without-pip', venv], { windowsHide: true, stdio: 'ignore', timeout: 20_000 })
  const selected = browserPoolPython(join(venv, 'Scripts', 'python.exe'))
  const ready = join(root, 'windowless-ready.json')
  const script = [
    'import ctypes, json, pathlib, sys',
    'pathlib.Path(sys.argv[1]).write_text(json.dumps({"prefix": sys.prefix, "executable": sys.executable, "console": ctypes.windll.kernel32.GetConsoleWindow()}), encoding="utf-8")',
  ].join('\n')
  const child = spawn(selected, ['-c', script, ready], { windowsHide: true, detached: true, stdio: 'ignore' })
  const ended = new Promise<void>((ok, fail) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      // Only this isolated probe's tree; never the live broker or another Python process.
      if (child.pid) {
        try { execFileSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }) }
        catch { child.kill() }
      }
    }, 10_000)
    child.once('error', error => { clearTimeout(timer); fail(error) })
    child.once('exit', code => {
      clearTimeout(timer)
      if (timedOut) fail(new Error('windowless probe timed out'))
      else if (code === 0) ok()
      else fail(new Error(`windowless probe exited ${code}`))
    })
  })
  child.unref()
  await ended
  const receipt = JSON.parse(readFileSync(ready, 'utf8')) as { prefix: string; executable: string; console: number }
  expect(resolve(receipt.prefix).toLowerCase()).toBe(resolve(venv).toLowerCase())
  expect(resolve(receipt.executable).toLowerCase()).toBe(resolve(selected).toLowerCase())
  expect(receipt.console).toBe(0)
}, 45_000)
