// server/tests/session-usage.test.ts — the Sessions chip and run cost, answered from the analytics
// kit (server/src/session-usage.ts). Fixtures are events in an in-memory KitStore.

import { afterAll, describe, expect, test } from 'bun:test'
import type { CliMayteWorker } from '../src/climayte-lib'
import { KitStore, type UsageEventInput } from '../src/kit/store'
import { runCost, sessionUsage } from '../src/session-usage'
import type { TranscriptFile } from '../src/transcript'
import type { SessionSource } from '../src/types'

const store = new KitStore(':memory:')
afterAll(() => store.close())

const T0 = Date.now() - 3 * 3_600_000
let n = 0
const call = (session: string, e: Partial<UsageEventInput>): UsageEventInput => ({
  id: `e${++n}`,
  ts: T0,
  source: 'cli',
  session,
  model: 'claude-opus-5',
  ...e,
})
const tf = (session: string, source: SessionSource = 'claude'): TranscriptFile => ({
  session_id: session,
  source,
  path: '',
  project: 'proj',
  mtime_ms: 0,
  size_bytes: 0,
  archived: false,
})
const opts = { store }

store.upsertEvents([
  call('s-main', {
    input: 100,
    output: 10,
    cache_read: 5,
    cache_write_5m: 3,
    cache_write_1h: 2,
    list_usd: 1.5,
    agent: 'main',
  }),
  // a subagent's call belongs to the same session and is part of what the chip shows
  call('s-main', { input: 50, output: 5, list_usd: 0.5, agent: 'subagent', ts: T0 + 60_000 }),
  call('s-mystery', { model: 'mystery-model', input: 10, output: 20, list_usd: null }),
  call('s-mixed', { input: 1, list_usd: 2 }),
  call('s-mixed', { model: 'mystery-model', input: 9, list_usd: null }),
  call('s-run', { input: 1, list_usd: 1, ts: T0 - 600_000 }), // before the run
  call('s-run', { input: 2, list_usd: 2, ts: T0 }), // inside
  call('s-run', { input: 4, list_usd: 4, ts: T0 + 600_000 }), // after
])

describe('sessionUsage', () => {
  test('totals the session including its subagent calls, split into the four token kinds', () => {
    const u = sessionUsage(tf('s-main'), opts)
    expect(u.status).toBe('ok')
    expect(u.tokens).toEqual({
      input: 150,
      output: 15,
      cacheRead: 5,
      cacheCreation: 5,
      total: 175,
      turns: 2,
    })
    expect(u.costUsd).toBeCloseTo(2, 10)
    expect(u.pricedModels).toEqual(['claude-opus-5'])
    expect(u.unpricedModels).toEqual([])
  })

  test('an unpriced model keeps its tokens, is named, and leaves no dollar figure when alone', () => {
    const u = sessionUsage(tf('s-mystery'), opts)
    expect(u.tokens.total).toBe(30)
    expect(u.costUsd).toBeNull()
    expect(u.unpricedModels).toEqual(['mystery-model'])
    expect(u.pricedModels).toEqual([])
  })

  test('a mixed session reports the priced part as a lower bound and names the rest', () => {
    const u = sessionUsage(tf('s-mixed'), opts)
    expect(u.costUsd).toBeCloseTo(2, 10)
    expect(u.pricedModels).toEqual(['claude-opus-5'])
    expect(u.unpricedModels).toEqual(['mystery-model'])
  })

  test('a session the kit has not seen yet is a real zero, not an error', () => {
    const u = sessionUsage(tf('s-brand-new'), opts)
    expect(u.status).toBe('ok')
    expect(u.tokens.total).toBe(0)
    expect(u.costUsd).toBeNull()
  })

  test('a non-Claude source says why instead of showing a zero', () => {
    for (const source of ['codex', 'opencode'] as const) {
      const u = sessionUsage(tf('s-main', source), opts)
      expect(u.status).toBe('source-unsupported')
      expect(u.tokens.total).toBe(0)
    }
  })

  test('every answer carries the price-table date', () => {
    expect(sessionUsage(tf('s-main'), opts).pricesAsOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })
})

describe('runCost', () => {
  const item = (started: number | null, finished: number | null) => ({
    id: 'run-1',
    session_id: 's-run',
    status: 'done',
    started_at: started === null ? null : new Date(started).toISOString(),
    finished_at: finished === null ? null : new Date(finished).toISOString(),
  })

  test('counts only the calls inside the run window, closed at both ends', () => {
    const r = runCost(item(T0 - 1000, T0 + 1000), opts)
    expect(r.status_reason).toBe('ok')
    expect(r.tokens.input).toBe(2)
    expect(r.tokens.turns).toBe(1)
    expect(r.costUsd).toBeCloseTo(2, 10)
  })

  test('an unfinished run is open-ended: it is still spending', () => {
    const r = runCost(item(T0 - 1000, null), opts)
    expect(r.tokens.input).toBe(6)
    expect(r.costUsd).toBeCloseTo(6, 10)
  })

  test('a run with no start has no window', () => {
    expect(runCost(item(null, null), opts).status_reason).toBe('no-window')
  })
})

describe('delegated work', () => {
  // A thread that called HSwarm and CliMayte, beside another thread's work that must not count. HSwarm's ledger
  // names a caller by the first 8 characters of its session id (a newer line by the whole id); a CliMayte worker
  // names its chat by its ping origin, or only by its trace when HSwarm routed the task to CliMayte.
  const THREAD = 'a1b2c3d4-0000-4000-8000-000000000001'
  const OTHER = 'f0f0f0f0-0000-4000-8000-000000000002'
  const kit = new KitStore(':memory:')
  afterAll(() => kit.close())
  const worker = (id: string, w: Partial<CliMayteWorker>) =>
    ({ id, group: 'g-example', ...w }) as CliMayteWorker
  const workers = [
    worker('w-direct', {
      origin: {
        kind: 'chat',
        sessionId: THREAD,
        home: 'C:/Users/me/.claude',
        transcript: null,
        how: 'test',
      },
      sessionId: 'sess-direct',
      sessions: ['sess-direct-0'],
    }),
    worker('w-routed', {
      trace: { sessionId: THREAD, label: 'HSwarm job example' },
      sessionId: 'sess-routed',
    }),
    worker('w-nested', {
      origin: { kind: 'worker', workerId: 'w-direct' },
      sessionId: 'sess-nested',
    }),
    worker('w-other', {
      origin: {
        kind: 'chat',
        sessionId: OTHER,
        home: 'C:/Users/me/.claude',
        transcript: null,
        how: 'test',
      },
      sessionId: 'sess-other',
    }),
    worker('w-traced-other', { trace: { sessionId: OTHER }, sessionId: 'sess-traced-other' }),
  ]
  const hswarm = (session: string, provider: string, e: Partial<UsageEventInput>) =>
    call(session, { source: 'hswarm', provider, model: 'example-model', ...e })
  kit.upsertEvents([
    call(THREAD, { source: 'desktop', input: 100, output: 10, list_usd: 1 }),
    call('sess-direct', { source: 'climayte', input: 1000, list_usd: 2 }),
    call('sess-direct-0', { source: 'climayte', output: 500, list_usd: 1 }),
    call('sess-routed', { source: 'climayte', cache_read: 2000, list_usd: 0.5 }),
    call('sess-nested', { source: 'climayte', input: 300, list_usd: 0.25 }),
    call('sess-other', { source: 'climayte', input: 99_999, list_usd: 9 }),
    call('sess-traced-other', { source: 'climayte', input: 77_777, list_usd: 7 }),
    hswarm('a1b2c3d4', 'baseten', { input: 400, output: 40, list_usd: 0.1 }),
    hswarm(THREAD, 'openai', { input: 60, list_usd: 0.05 }),
    // HSwarm's line for a task it routed to CliMayte: that work is w-routed's session, counted under CliMayte
    hswarm('a1b2c3d4', 'climayte', { input: 5000, list_usd: 0 }),
    // a worker's own HSwarm call, keyed by its session's first 8 characters
    hswarm('sess-dir', 'deepseek', { input: 7, list_usd: 0.01 }),
    hswarm('f0f0f0f0', 'baseten', { input: 12_345, list_usd: 3 }),
  ])

  test('the total total is the thread, its HSwarm calls and every CliMayte worker it started, each once', () => {
    const u = sessionUsage(tf(THREAD), { store: kit, workers })
    expect(u.tokens.total).toBe(110)
    expect(u.delegated.climayte.workers).toBe(3)
    expect(u.delegated.climayte.tokens).toBe(1000 + 500 + 2000 + 300)
    expect(u.delegated.climayte.costUsd).toBeCloseTo(3.75, 10)
    expect(u.delegated.hswarm.calls).toBe(3)
    expect(u.delegated.hswarm.tokens).toBe(440 + 60 + 7)
    expect(u.delegated.hswarm.costUsd).toBeCloseTo(0.16, 10)
    expect(u.grand.tokens).toBe(110 + 3800 + 507)
    expect(u.grand.costUsd).toBeCloseTo(1 + 3.75 + 0.16, 10)
  })

  test('a thread that handed nothing off totals its own tokens', () => {
    const u = sessionUsage(tf('s-alone-0000'), { store: kit, workers })
    expect(u.delegated).toEqual({
      hswarm: { tokens: 0, costUsd: null, calls: 0 },
      climayte: { tokens: 0, costUsd: null, workers: 0 },
    })
    expect(u.grand).toEqual({ tokens: 0, costUsd: null })
  })
})
