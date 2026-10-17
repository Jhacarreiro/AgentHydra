// Every transport and clock is injected; no test messages a real chat.
import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type CliMayteOrigin, type PingWorker, startCliMaytePing } from '../src/climayte-ping'

const scratch = mkdtempSync(join(tmpdir(), 'climayte-ping-cold-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))
const NOW = Date.UTC(2026, 9, 16)
const origin: CliMayteOrigin = { kind: 'worker', workerId: 'w-origin' }
let nextDir = 0

function worker(id: string, extra: Partial<PingWorker> = {}): PingWorker {
  return {
    id,
    title: `Example ${id}`,
    group: 'cold-ping-synthetic',
    status: 'done',
    accountId: null,
    attempts: [],
    error: null,
    origin,
    ...extra,
  }
}

function cold(w: PingWorker) {
  let reads = 0
  for (const [key, value] of Object.entries({
    prompt: 'Example task',
    result: 'Example result',
    results: ['Example result'],
    reports: [],
  }))
    Object.defineProperty(w, key, {
      configurable: true,
      enumerable: true,
      get() {
        reads++
        return value
      },
    })
  return () => reads
}

function harness(workers: PingWorker[]) {
  const dir = join(scratch, `ping-${++nextDir}`)
  mkdirSync(dir)
  let now = NOW
  let nextTimer = 0
  const timers = new Map<number, { fn: () => void; at: number }>()
  const sent: Array<{ id: string; text: string }> = []
  const ping = startCliMaytePing({
    dir,
    workers: () => workers,
    subscribe: () => () => {},
    clock: {
      now: () => now,
      setTimeout(fn, ms) {
        const id = ++nextTimer
        timers.set(id, { fn, at: now + ms })
        return id
      },
      clearTimeout: (id) => {
        timers.delete(id as number)
      },
    },
    climayteSend(id, text) {
      sent.push({ id, text })
      return { ok: true, message: 'synthetic delivery' }
    },
    deliverPeer: async (id, _transcript, text) => {
      sent.push({ id, text })
      return { ok: true, reason: 'synthetic delivery' }
    },
    toast: async () => {},
    journal: () => {},
  })
  return {
    ping,
    sent,
    async heartbeat() {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0]
      if (!next) throw new Error('The synthetic heartbeat was not armed')
      timers.delete(next[0])
      now = next[1].at
      next[1].fn()
      await ping.idle()
    },
  }
}

test('a heartbeat over 20,000 unchanged history workers reads zero cold fields', async () => {
  const workers = Array.from({ length: 20_000 }, (_, i) => worker(`w-cold-${i}`))
  const reads = workers.map(cold)
  const h = harness(workers)
  try {
    await h.heartbeat()
    await h.heartbeat()
    expect(reads.reduce((n, read) => n + read(), 0)).toBe(0)
    expect(h.sent).toEqual([])
  } finally {
    h.ping.stop()
  }
})

test('an eventful failure still delivers its group outcome without reading cold fields', async () => {
  const w = worker('w-failure', { status: 'running' })
  const reads = cold(w)
  const h = harness([w])
  try {
    w.status = 'failed'
    w.error = 'Example failure'
    h.ping.observe(w)
    await h.ping.flushNow()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].id).toBe(origin.workerId)
    expect(h.sent[0].text).toContain('failed: no reason recorded; details in climayte_status.')
    expect(h.sent[0].text).not.toContain('Example failure')
    expect(h.sent[0].text).toContain('Group cold-ping-synthetic settled')
    expect(reads()).toBe(0)
  } finally {
    h.ping.stop()
  }
})

test('wave questions use the manager origin without unpacking the task', async () => {
  const manager = worker('w-wave-manager', { kind: 'manage', wave: 'synthetic-wave' })
  const task = worker('w-wave-task', {
    status: 'running',
    wave: 'synthetic-wave',
    kind: 'task',
    origin: undefined,
  })
  const reads = cold(task)
  const h = harness([manager, task])
  try {
    task.question = { text: 'Which example option?', at: NOW + 1 }
    h.ping.observe(task)
    await h.ping.flushNow()
    expect(h.sent).toHaveLength(1)
    expect(h.sent[0].id).toBe(origin.workerId)
    expect(h.sent[0].text).toContain('Which example option?')
    expect(reads()).toBe(0)
  } finally {
    h.ping.stop()
  }
})

test('eventful owner chats and a worker reporting to itself stay suppressed and packed', async () => {
  const own = worker('w-origin', { status: 'running' })
  const chat = worker('w-owner-chat', { status: 'running', chat: true })
  const reads = [cold(own), cold(chat)]
  const h = harness([own, chat])
  try {
    for (const w of [own, chat]) {
      w.status = 'failed'
      w.error = 'Example failure'
      h.ping.observe(w)
    }
    await h.ping.flushNow()
    expect(h.sent).toEqual([])
    expect(reads.map((read) => read())).toEqual([0, 0])
  } finally {
    h.ping.stop()
  }
})

test('real core-packed history remains packed through heartbeat and failure delivery', async () => {
  const home = join(scratch, 'packed-home')
  const done = join(home, 'corch', 'done')
  mkdirSync(done, { recursive: true })
  mkdirSync(join(home, 'data'), { recursive: true })
  mkdirSync(join(home, 'pings'), { recursive: true })
  const fixture = {
    ...worker('w-core-packed'),
    cwd: '/synthetic',
    prompt: 'Example task '.repeat(100),
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    sessionId: null,
    result: 'Example result',
    results: ['Example result'],
    reports: [],
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1,
    updatedAt: 2,
  }
  writeFileSync(join(done, `${fixture.id}.json`), JSON.stringify(fixture))
  const core = pathToFileURL(resolve(import.meta.dir, '../src/climayte-core.ts')).href
  const ping = pathToFileURL(resolve(import.meta.dir, '../src/climayte-ping.ts')).href
  const script = `
    const core = await import(${JSON.stringify(core)})
    const { startCliMaytePing } = await import(${JSON.stringify(ping)})
    await core.preloadDone()
    core.load()
    const w = core.workers.get('w-core-packed')
    const packed = () => ['prompt', 'result', 'results', 'reports'].every(k =>
      typeof Object.getOwnPropertyDescriptor(w, k)?.get === 'function')
    const before = packed()
    let tick
    let sends = 0
    const p = startCliMaytePing({
      dir: ${JSON.stringify(join(home, 'pings'))},
      workers: () => [w], subscribe: () => () => {},
      clock: { now: () => ${NOW}, setTimeout: fn => { tick = fn; return 1 }, clearTimeout: () => {} },
      climayteSend: () => { sends++; return { ok: true, message: 'synthetic delivery' } },
      deliverPeer: async () => { throw new Error('Unexpected peer delivery') },
      toast: async () => {}, journal: () => {}
    })
    tick()
    await p.idle()
    const afterHeartbeat = packed()
    w.status = 'failed'
    w.error = 'Example failure'
    p.observe(w)
    await p.flushNow()
    const afterFailure = packed()
    p.stop()
    console.log('@@ping-cold@@' + JSON.stringify({ before, afterHeartbeat, afterFailure, sends }))
  `
  const child = Bun.spawn([process.execPath, '-e', script], {
    cwd: resolve(import.meta.dir, '..'),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 30_000,
    windowsHide: true,
    env: {
      ...process.env,
      AGENTHYDRA_HOME: home,
      AGENTHYDRA_DATA_DIR: join(home, 'data'),
      AGENTHYDRA_DB: join(home, 'data', 'test.db'),
      AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
    },
  })
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  const marker = '@@ping-cold@@'
  const line = out.split('\n').find((value) => value.startsWith(marker))
  if (code !== 0 || !line) throw new Error(`The scratch process failed (${code}): ${err}\n${out}`)
  expect(JSON.parse(line.slice(marker.length))).toEqual({
    before: true,
    afterHeartbeat: true,
    afterFailure: true,
    sends: 1,
  })
}, 40_000)
