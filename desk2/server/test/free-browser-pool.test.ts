import { afterAll, beforeAll, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureBrowserPool } from '../src/free-instances/browser-pool'

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
