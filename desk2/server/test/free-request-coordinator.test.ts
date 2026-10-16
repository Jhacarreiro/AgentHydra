import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { pathToFileURL } from 'node:url'
import type { FreeConfig } from '@shared/free-instances'
import {
  createRequestCoordinatorStarter,
  ensureRequestCoordinator,
  type RequestCoordinatorEndpoint,
  runCoordinatedFree,
  runCoordinatorRequest,
} from '../src/free-instances/request-coordinator'
import type { FreeRunRequest } from '../src/free-instances/runner'

const TOKEN = 'a'.repeat(64)
const STATE = '/synthetic/state/11111111-1111-4111-8111-111111111111'
const request: FreeRunRequest = {
  requestId: '22222222-2222-4222-8222-222222222222',
  instanceId: '11111111-1111-4111-8111-111111111111',
  provider: 'chatgpt',
  command: 'chat',
  prompt: 'Synthetic request',
}
const config: FreeConfig = {
  harnessDir: '/synthetic/harness',
  python: '/synthetic/python.exe',
  stateDir: STATE,
  cacheDir: '/synthetic/cache',
}
type Wire = {
  op: string
  token: string
  request_id: string
  state_dir: string
  request: FreeRunRequest
}

/** A local protocol stand-in only: no Python, provider, account, browser or managed process. */
async function broker<T>(
  handle: (socket: Socket, wire: Wire) => void,
  body: (endpoint: RequestCoordinatorEndpoint) => Promise<T>,
): Promise<T> {
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    socket.on('error', () => {})
    socket.once('close', () => sockets.delete(socket))
    const decoder = new StringDecoder('utf8')
    let text = '',
      received = false
    socket.on('data', (chunk) => {
      if (received) return
      text += decoder.write(chunk)
      const end = text.indexOf('\n')
      if (end < 0) return
      received = true
      handle(socket, JSON.parse(text.slice(0, end)) as Wire)
    })
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(0, '127.0.0.1', ok)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No synthetic coordinator port')
  try {
    return await body({ port: address.port, token: TOKEN, version: 'synthetic-version' })
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise<void>((ok) => server.close(() => ok()))
  }
}

function ack(socket: Socket, wire: Wire): void {
  socket.write(JSON.stringify({ accepted: true, request_id: wire.request_id }) + '\n')
}
function final(socket: Socket, wire: Wire, stdout = 'Synthetic reply', code = 0): void {
  socket.end(JSON.stringify({ request_id: wire.request_id, code, stdout }) + '\n')
}

function removeScratch(root: string): void {
  const target = resolve(root)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('free-request-coordinator-')
  )
    throw new Error('Refusing unexpected scratch cleanup')
  rmSync(target, { recursive: true, force: true })
}

test('coordinator frames preserve chunked Unicode, request identity and legacy UTF-8 stdin normalization', async () => {
  let received: Wire | undefined
  const prompt = 'Synthetic é🙂 ' + String.fromCharCode(0xd800)
  await broker(
    (socket, wire) => {
      received = wire
      const bytes = Buffer.from(
        [
          JSON.stringify({ accepted: true, request_id: wire.request_id }),
          JSON.stringify({ request_id: wire.request_id, progress: 'Synthetic é🙂 progress' }),
          JSON.stringify({ request_id: wire.request_id, code: 7, stdout: 'Synthetic é🙂 result' }),
          '',
        ].join('\n'),
      )
      let at = 0
      const send = () => {
        if (at === bytes.length) {
          socket.end()
          return
        }
        socket.write(bytes.subarray(at, ++at))
        setImmediate(send)
      }
      send()
    },
    async (endpoint) => {
      expect(
        await runCoordinatorRequest(
          endpoint,
          { ...request, prompt },
          STATE,
          new AbortController().signal,
        ),
      ).toEqual({ code: 7, stdout: 'Synthetic é🙂 result' })
    },
  )
  expect(received).toMatchObject({
    op: 'run',
    token: TOKEN,
    state_dir: STATE,
    request: { ...request, prompt: Buffer.from(prompt).toString('utf8') },
  })
  expect(received!.request_id).toMatch(/^[a-f0-9-]{36}$/)
  expect(prompt.endsWith(String.fromCharCode(0xd800))).toBe(true)
})

test('post-write refusals, wrong IDs, malformed replies, missing ACKs and lost completions never fall back', async () => {
  const cases: Array<[string, (socket: Socket, wire: Wire) => void]> = [
    [
      'refused',
      (socket, wire) =>
        socket.end(
          JSON.stringify({
            accepted: false,
            request_id: wire.request_id,
            error: 'Synthetic busy',
          }) + '\n',
        ),
    ],
    [
      'wrong_request',
      (socket, _wire) =>
        socket.end(JSON.stringify({ accepted: true, request_id: 'different-id' }) + '\n'),
    ],
    ['malformed', (socket) => socket.end('{malformed}\n')],
    ['malformed', (socket, wire) => final(socket, wire)],
    [
      'refused',
      (socket, wire) => {
        ack(socket, wire)
        ack(socket, wire)
        final(socket, wire)
      },
    ],
    [
      'malformed',
      (socket, wire) => {
        ack(socket, wire)
        socket.end('{unfinished')
      },
    ],
    [
      'malformed',
      (socket, wire) => {
        ack(socket, wire)
        socket.end('\n')
      },
    ],
    [
      'completion_unknown',
      (socket, wire) => {
        ack(socket, wire)
        socket.end()
      },
    ],
  ]
  for (const [error, handle] of cases)
    await broker(handle, async (endpoint) => {
      await expect(
        runCoordinatedFree(config, request, '/synthetic/pool.json', new AbortController().signal, {
          platform: 'win32',
          ensure: async () => endpoint,
        }),
      ).rejects.toThrow(`request_coordinator_${error}`)
    })
})

test('abort closes only the request socket and progress cannot extend the absolute deadline', async () => {
  const cancelled = new AbortController()
  let closed = false
  let resolveClosed!: () => void
  const closedSocket = new Promise<void>((ok) => {
    resolveClosed = ok
  })
  await broker(
    (socket, wire) => {
      socket.once('close', () => {
        closed = true
        resolveClosed()
      })
      ack(socket, wire)
      cancelled.abort()
    },
    async (endpoint) => {
      await expect(
        runCoordinatorRequest(endpoint, request, STATE, cancelled.signal),
      ).rejects.toThrow('stopped')
      await closedSocket
    },
  )
  expect(closed).toBe(true)
  await broker(
    (socket, wire) => {
      ack(socket, wire)
      const timer = setInterval(
        () =>
          socket.write(
            JSON.stringify({ request_id: wire.request_id, progress: 'still running' }) + '\n',
          ),
        5,
      )
      socket.once('close', () => clearInterval(timer))
    },
    async (endpoint) => {
      await expect(
        runCoordinatorRequest(endpoint, request, STATE, new AbortController().signal, {
          timeoutMs: 40,
        }),
      ).rejects.toThrow('stopped')
    },
  )
})

test('coordinator joins chunk fragments and accepts a final frame at EOF without a newline', async () => {
  const stdout = 'Synthetic EOF é🙂 result'
  await broker(
    (socket, wire) => {
      const prefix = [
        JSON.stringify({ accepted: true, request_id: wire.request_id }),
        JSON.stringify({ request_id: wire.request_id, progress: 'Synthetic progress' }),
        '',
      ].join('\n')
      const bytes = Buffer.from(JSON.stringify({ request_id: wire.request_id, code: 0, stdout }))
      const split = bytes.indexOf(Buffer.from('🙂')) + 2
      socket.write(Buffer.concat([Buffer.from(prefix), bytes.subarray(0, split)]))
      setImmediate(() => socket.end(bytes.subarray(split)))
    },
    async (endpoint) => {
      expect(
        await runCoordinatorRequest(endpoint, request, STATE, new AbortController().signal),
      ).toEqual({ code: 0, stdout })
    },
  )
})

test('a large fragmented coordinator frame scans only incoming chunks and retains exact output', async () => {
  // Isolate the global scan counter: no other suite or caller shares its String prototype.
  const moduleUrl = JSON.stringify(
    pathToFileURL(resolve(import.meta.dir, '../src/free-instances/request-coordinator.ts')).href,
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
      import { createServer } from 'node:net'
      import { createHash } from 'node:crypto'
      const { runCoordinatorRequest } = await import(${moduleUrl})
      const expected = 'Synthetic fragmented é🙂 ' + 'x'.repeat(256 * 1024)
      const digest = value => createHash('sha256').update(value).digest('hex')
      const wanted = digest(expected)
      const sockets = new Set()
      let frameBytes = 0, writes = 0
      const server = createServer(socket => {
        sockets.add(socket)
        socket.on('error', () => {})
        socket.once('close', () => sockets.delete(socket))
        let input = ''
        socket.on('data', async chunk => {
          input += chunk.toString('utf8')
          if (!input.includes('\\n')) return
          socket.removeAllListeners('data')
          const wire = JSON.parse(input)
          const frame = Buffer.from([
            JSON.stringify({ accepted: true, request_id: wire.request_id }),
            JSON.stringify({ request_id: wire.request_id, progress: 'Synthetic progress' }),
            JSON.stringify({ request_id: wire.request_id, code: 0, stdout: expected }), ''
          ].join('\\n'))
          frameBytes = frame.length
          for (let at = 0; at < frame.length && !socket.destroyed; at += 1024) {
            const before = scans
            socket.write(frame.subarray(at, at + 1024)); writes++
            // Wait for the actual client's newline search, so TCP coalescing
            // cannot turn this into a one-chunk test under a busy scheduler.
            while (!socket.destroyed && scans === before)
              await new Promise(resolve => setImmediate(resolve))
          }
          socket.end()
        })
      })
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
      const indexOf = String.prototype.indexOf
      let scanned = 0, scans = 0
      String.prototype.indexOf = function(search, from) {
        if (search === '\\n') { scanned += Math.max(0, this.length - (from ?? 0)); scans++ }
        return indexOf.call(this, search, from)
      }
      try {
        const result = await runCoordinatorRequest({ port: server.address().port, token: 'a'.repeat(64), version: 'synthetic' },
          { requestId: '22222222-2222-4222-8222-222222222222', instanceId: '11111111-1111-4111-8111-111111111111', provider: 'chatgpt', command: 'chat', prompt: 'Synthetic prompt' },
          '/synthetic/state/11111111-1111-4111-8111-111111111111', new AbortController().signal, { timeoutMs: 10000 })
        if (!result || result.code !== 0 || digest(result.stdout) !== wanted) throw new Error('Fragmented output changed')
        console.log(JSON.stringify({ scanned, scans, frameBytes, writes, exact: true }))
      } finally {
        String.prototype.indexOf = indexOf
        for (const socket of sockets) socket.destroy()
        await new Promise(resolve => server.close(resolve))
      }
    `,
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 15_000,
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Synthetic fragmented coordinator failed: ${err || out}`)
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
    scanned: number
    scans: number
    frameBytes: number
    writes: number
    exact: boolean
  }
  expect(result.exact).toBe(true)
  expect(result.writes).toBeGreaterThan(250)
  expect(result.scans).toBeGreaterThan(16)
  expect(result.scanned).toBeLessThan(result.frameBytes * 4)
}, 20_000)

test('input, decoded stdout and outer framing caps stop requests without a legacy replay', async () => {
  await expect(
    runCoordinatorRequest(
      { port: 1, token: TOKEN, version: 'synthetic' },
      { ...request, prompt: 'x'.repeat(1024 * 1024) },
      STATE,
      new AbortController().signal,
    ),
  ).rejects.toThrow('input_limit')
  for (const over of [false, true])
    await broker(
      (socket, wire) => {
        ack(socket, wire)
        final(socket, wire, 'x'.repeat(8 * 1024 * 1024 + Number(over)))
      },
      async (endpoint) => {
        const result = runCoordinatorRequest(endpoint, request, STATE, new AbortController().signal)
        if (over) await expect(result).rejects.toThrow('output_limit')
        else expect((await result)!.stdout.length).toBe(8 * 1024 * 1024)
      },
    )
  await broker(
    (socket, wire) => {
      ack(socket, wire)
      socket.end(Buffer.alloc(16 * 1024 * 1024 + 64 * 1024 + 1, 0x78))
    },
    async (endpoint) => {
      await expect(
        runCoordinatorRequest(endpoint, request, STATE, new AbortController().signal),
      ).rejects.toThrow('output_limit')
    },
  )
}, 30_000)

test('only unsupported platforms or availability failures before dispatch permit legacy fallback', async () => {
  const signal = new AbortController().signal
  let ensured = 0
  const unavailable = async () => {
    ensured++
    throw new Error('Synthetic unavailable service')
  }
  expect(
    await runCoordinatedFree(config, request, '/synthetic/pool', signal, {
      platform: 'linux',
      ensure: unavailable,
    }),
  ).toBeUndefined()
  expect(
    await runCoordinatedFree(
      config,
      { ...request, provider: 'claude' },
      '/synthetic/pool',
      signal,
      { platform: 'win32', ensure: unavailable },
    ),
  ).toBeUndefined()
  expect(
    await runCoordinatedFree(config, { ...request, command: 'read' }, '/synthetic/pool', signal, {
      platform: 'win32',
      ensure: unavailable,
    }),
  ).toBeUndefined()
  expect(ensured).toBe(0)
  expect(
    await runCoordinatedFree(config, request, '/synthetic/pool', signal, {
      platform: 'win32',
      ensure: unavailable,
    }),
  ).toBeUndefined()
  expect(ensured).toBe(1)
  let closed: RequestCoordinatorEndpoint | undefined
  await broker(
    (_socket, _wire) => {},
    async (endpoint) => {
      closed = endpoint
    },
  )
  expect(await runCoordinatorRequest(closed!, request, STATE, signal)).toBeUndefined()
  const cancelled = new AbortController()
  cancelled.abort()
  await expect(
    runCoordinatedFree(config, request, '/synthetic/pool', cancelled.signal, {
      platform: 'win32',
      ensure: unavailable,
    }),
  ).rejects.toThrow('stopped')
  expect(ensured).toBe(1)
})

test('startup coalesces by version directory, a cancelled waiter leaves startup alive, and code changes start a new generation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'free-request-coordinator-'))
  const fixture: FreeConfig = {
    harnessDir: join(root, 'harness'),
    python: join(root, 'Scripts', 'python.exe'),
    stateDir: join(root, 'state', '11111111-1111-4111-8111-111111111111'),
    cacheDir: join(root, 'cache'),
  }
  const names = [
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
  ]
  try {
    for (const name of names) {
      const path = join(fixture.harnessDir, 'claudfree', name)
      mkdirSync(resolve(path, '..'), { recursive: true })
      writeFileSync(path, 'synthetic source')
    }
    let release!: () => void
    const gate = new Promise<void>((ok) => {
      release = ok
    })
    const starts: Array<{ directory: string; version: string }> = []
    const ensure = createRequestCoordinatorStarter(async (_config, directory, version, _pool) => {
      starts.push({ directory, version })
      await gate
      return { port: 1, token: TOKEN, version }
    })
    const cancelled = new AbortController()
    const first = ensure(fixture, join(root, 'pool.json'), cancelled.signal).catch((error) => error)
    const second = ensure(fixture, join(root, 'pool.json'), new AbortController().signal)
    cancelled.abort()
    expect(((await first) as Error).message).toBe('stopped')
    expect(starts.length).toBe(1)
    release()
    const endpoint = await second
    expect(endpoint.version).toBe(starts[0]!.version)
    await ensure(fixture, join(root, 'pool.json'), new AbortController().signal)
    expect(starts.length).toBe(2)
    expect(starts[1]).toEqual(starts[0])
    writeFileSync(
      join(fixture.harnessDir, 'claudfree', 'chatgpt/request_phase_worker.py'),
      'changed synthetic source',
    )
    await ensure(fixture, join(root, 'pool.json'), new AbortController().signal)
    expect(starts.length).toBe(3)
    expect(starts[2]!.version).not.toBe(starts[0]!.version)
    expect(starts[2]!.directory).not.toBe(starts[0]!.directory)
    let pings = 0
    await broker(
      (socket, wire) => {
        // The startup frame is a ping, not the run frame used by this stand-in's other tests.
        expect(wire as unknown).toEqual({ op: 'ping', token: TOKEN })
        pings++
        socket.end(JSON.stringify({ ok: true }) + '\n')
      },
      async (endpoint) => {
        const generation = starts[2]!
        mkdirSync(generation.directory, { recursive: true })
        writeFileSync(
          join(generation.directory, 'endpoint.json'),
          JSON.stringify({ ...endpoint, version: generation.version }),
        )
        const endpoints = await Promise.all(
          Array.from({ length: 8 }, () =>
            ensureRequestCoordinator(
              fixture,
              join(root, 'pool.json'),
              new AbortController().signal,
            ),
          ),
        )
        expect(endpoints).toEqual(Array(8).fill({ ...endpoint, version: generation.version }))
        expect(pings).toBe(1)
      },
    )
  } finally {
    removeScratch(root)
  }
})

test('runner keeps the first three admissions legacy, coordinates excess waiters after pool startup and never replays unknown sends', async () => {
  const moduleUrl = (name: string) =>
    JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', name)).href)
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { mock } from 'bun:test'
    import assert from 'node:assert/strict'
    const calls = [], spawns = []
    let answer = undefined, failure = null, held = 3, releasePool, poolError = null, poolAbort = null
    const poolGate = new Promise(ok => releasePool = ok)
    mock.module(${moduleUrl('free-instances/browser-pool.ts')}, () => ({ ensureBrowserPool: async () => {
      calls.push('pool')
      if (poolError) throw poolError
      poolAbort?.abort()
      if (held > 0) { held--; await poolGate }
      return 'synthetic-pool'
    } }))
    mock.module(${moduleUrl('free-instances/request-coordinator.ts')}, () => ({ runCoordinatedFree: async (_config, request, pool) => { calls.push('coordinator:' + request.command); assert.equal(pool, 'synthetic-pool'); if (failure) throw failure; return answer } }))
    class SpawnLaunchError extends Error {}
    mock.module(${moduleUrl('lib/spawn-off.ts')}, () => ({ SpawnLaunchError, spawnOff: async (options) => { calls.push('legacy'); spawns.push(options); return { code: 3, stdout: Buffer.from('Synthetic legacy'), aborted: false, capped: false, timedOut: false } } }))
    const { runFree, commandArgs } = await import(${moduleUrl('free-instances/runner.ts')})
    const config = { harnessDir: '/synthetic/harness', python: '/synthetic/python', stateDir: '/synthetic/state', cacheDir: '/synthetic/cache' }
    const request = { requestId: 'synthetic', instanceId: 'synthetic', provider: 'chatgpt', command: 'chat', prompt: 'Synthetic prompt' }
    const firstThree = Array.from({ length: 3 }, () => runFree(config, request, new AbortController().signal))
    assert.deepEqual(calls.splice(0), ['pool', 'pool', 'pool'])
    answer = { code: 0, stdout: 'Synthetic coordinated' }
    assert.deepEqual(await runFree(config, request, new AbortController().signal), answer)
    assert.deepEqual(calls.splice(0), ['pool', 'coordinator:chat'])
    failure = new Error('request_coordinator_completion_unknown: do not replay')
    await assert.rejects(runFree(config, { ...request, command: 'resume', chatId: 'synthetic-thread' }, new AbortController().signal), /completion_unknown/)
    assert.deepEqual(calls.splice(0), ['pool', 'coordinator:resume'])
    assert.equal(spawns.length, 0)
    failure = null; answer = undefined
    assert.deepEqual(await runFree(config, request, new AbortController().signal), { code: 3, stdout: 'Synthetic legacy' })
    assert.deepEqual(calls.splice(0), ['pool', 'coordinator:chat', 'legacy'])
    assert.equal(spawns.at(-1).stdin, 'Synthetic prompt')
    assert.equal(spawns.at(-1).env.CLAUDFREE_BROWSER_POOL, 'synthetic-pool')
    poolError = new Error('Synthetic pool unavailable')
    await assert.rejects(runFree(config, request, new AbortController().signal), /pool unavailable/)
    assert.deepEqual(calls.splice(0), ['pool'])
    poolError = null
    poolAbort = new AbortController()
    await assert.rejects(runFree(config, request, poolAbort.signal), /stopped/)
    assert.deepEqual(calls.splice(0), ['pool'])
    poolAbort = null
    for (const [provider, command] of [['claude', 'chat'], ['chatgpt', 'read'], ['chatgpt', 'login'], ['chatgpt', 'forget']]) {
      const next = { ...request, provider, command }
      await runFree(config, next, new AbortController().signal)
      assert.deepEqual(calls.splice(0), ['legacy'])
      assert.deepEqual(spawns.at(-1).cmd, [config.python, ...commandArgs(config, next)])
      assert.equal(spawns.at(-1).env.CLAUDFREE_BROWSER_POOL, '')
      assert.equal(spawns.at(-1).timeoutMs, command === 'login' ? 960000 : 300000)
    }
    releasePool()
    await Promise.all(firstThree)
    assert.deepEqual(calls.splice(0), ['legacy', 'legacy', 'legacy'], 'First three never start the coordinator')
    answer = { code: 0, stdout: 'Unexpected coordinator' }
    const fresh = await Promise.all(Array.from({ length: 3 }, () => runFree(config, request, new AbortController().signal)))
    assert.deepEqual(calls.splice(0), ['pool', 'pool', 'pool', 'legacy', 'legacy', 'legacy'], 'Every success, failure and cancellation released admission')
    assert.ok(fresh.every(out => out.stdout === 'Synthetic legacy'))
    console.log('coordinator-runner-ok')
  `,
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 20_000,
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Synthetic runner failed (${code}): ${err}\n${out}`)
  expect(out.trim()).toBe('coordinator-runner-ok')
}, 30_000)
