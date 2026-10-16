// The placement history owns immutable entries: only live account load changes every tick.
import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { CliMayteWorker } from '../src/climayte-lib'

const actual = { ...(await import('../src/climayte-placement')) }
type History = Parameters<typeof actual.expectedCost>[1]
const seen: History[] = []
mock.module('../src/climayte-placement', () => ({
  ...actual,
  expectedCost: (...args: Parameters<typeof actual.expectedCost>) => {
    seen.push(args[1])
    return actual.expectedCost(...args)
  },
}))
const { load, placementState, workers } = await import('../src/climayte-core')
load()
const previousWorkers = [...workers]
beforeEach(() => {
  workers.clear()
  seen.length = 0
})
afterAll(() => {
  workers.clear()
  for (const [id, w] of previousWorkers) workers.set(id, w)
  mock.module('../src/climayte-placement', () => actual)
})

const ASK = { kind: 'code', model: 'claude-sonnet-5-5', effort: 'medium' }
const tokens = (n = 1000) => ({ input: n, output: 100, cacheRead: 2000, cacheWrite: 3000 })
function worker(
  id: string,
  kind = 'code',
  status: CliMayteWorker['status'] = 'done',
): CliMayteWorker {
  return {
    id,
    group: 'history-synthetic',
    title: id,
    cwd: '/synthetic',
    prompt: 'synthetic task',
    pending: [],
    accounts: null,
    sessionId: null,
    accountId: null,
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 1,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1,
    updatedAt: 1,
    kind,
    status,
    model: ASK.model,
    effort: ASK.effort,
    tokens: tokens(),
    attempts: [
      {
        account: { id: 'history-account', num: 1, name: 'Example' },
        pid: null,
        log: '/synthetic/attempt.jsonl',
        errLog: '/synthetic/attempt.err',
        startedAt: 10,
        endedAt: 40,
        outcome: 'done',
        notice: null,
        resumed: false,
        tokens: tokens(),
        spend: { costUsd: 0, turns: 1, reread: tokens(100) },
      },
    ],
  }
}
function read() {
  const state = placementState()
  state.costOf(ASK)
  return { state, history: seen.at(-1)! }
}
function checkEstimates(state: ReturnType<typeof placementState>, history: History) {
  for (const kind of ['code', 'docs', 'manage'])
    for (const model of ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'])
      for (const effort of ['low', 'medium', 'high', null]) {
        const ask = { kind, model, effort }
        expect(state.costOf(ask)).toEqual(actual.expectedCost(ask, [...history]))
      }
}

describe('CliMayte immutable placement history', () => {
  test('unchanged passes reuse one history and its exact estimates, including managers', () => {
    for (let n = 0; n < 2000; n++) workers.set(`history-${n}`, worker(`history-${n}`))
    workers.set('history-manager', worker('history-manager', 'manage', 'running'))
    const first = read()
    expect(first.history).toHaveLength(2001)
    for (let n = 0; n < 20; n++) {
      const next = read()
      expect(next.history).toBe(first.history)
      expect(next.state.costOf(ASK)).toEqual(first.state.costOf(ASK))
    }
    checkEstimates(first.state, first.history)
  })

  test('every fingerprinted field invalidates the history without mutating the prior snapshot', () => {
    const changes: Array<(w: CliMayteWorker) => void> = [
      (w) => {
        w.status = 'failed'
      },
      (w) => {
        w.kind = 'docs'
      },
      (w) => {
        w.model = 'claude-haiku-5-5'
      },
      (w) => {
        w.effort = 'high'
      },
      (w) => {
        w.chat = true
      },
      (w) => {
        w.tokens = tokens(2000)
      },
      (w) => {
        w.attempts.push({ ...w.attempts[0]!, tokens: tokens(4000) })
      },
      (w) => {
        w.attempts[0]!.tokens = tokens(5000)
      },
      (w) => {
        w.attempts[0]!.spend = { ...w.attempts[0]!.spend!, reread: tokens(200) }
      },
      (w) => {
        w.attempts[0]!.model = 'claude-opus-5-5'
      },
      (w) => {
        w.attempts[0]!.cacheTtl = '5m'
      },
    ]
    for (const change of changes) {
      workers.clear()
      const w = worker('history-change')
      workers.set(w.id, w)
      const first = read()
      const saved = structuredClone(first.history)
      change(w)
      const next = read()
      expect(next.history).not.toBe(first.history)
      expect(first.history).toEqual(saved)
      checkEstimates(next.state, next.history)
      expect(read().history).toBe(next.history)
    }
  })

  test('insertion, removal, worker reordering and attempt reordering preserve exact history order', () => {
    const a = worker('history-a')
    const b = worker('history-b', 'docs')
    workers.set(a.id, a)
    const first = read()
    workers.set(b.id, b)
    const added = read()
    expect(added.history).not.toBe(first.history)
    expect(added.history.map((e) => e.kind)).toEqual(['code', 'docs'])
    workers.delete(a.id)
    workers.set(a.id, a)
    const reordered = read()
    expect(reordered.history.map((e) => e.kind)).toEqual(['docs', 'code'])
    expect(added.history.map((e) => e.kind)).toEqual(['code', 'docs'])
    workers.delete(b.id)
    const removed = read()
    expect(removed.history.map((e) => e.kind)).toEqual(['code'])
    a.attempts.push({ ...a.attempts[0]!, tokens: tokens(9000) })
    const twoAttempts = read()
    a.attempts.reverse()
    const reversedAttempts = read()
    expect(reversedAttempts.history).not.toBe(twoAttempts.history)
    checkEstimates(reversedAttempts.state, reversedAttempts.history)
    workers.clear()
    expect(read().history).toHaveLength(0)
    expect(removed.history).toHaveLength(1)
  })

  test('manager token/reread changes invalidate estimates even while the manager stays running', () => {
    const manager = worker('history-manager', 'manage', 'running')
    workers.set(manager.id, manager)
    const first = read()
    const saved = structuredClone(first.history)
    manager.attempts[0]!.tokens = tokens(10000)
    const grown = read()
    expect(grown.history).not.toBe(first.history)
    expect(grown.history[0]!.pct).toBeGreaterThan(first.history[0]!.pct)
    manager.attempts[0]!.spend = { ...manager.attempts[0]!.spend!, reread: tokens(4000) }
    const reread = read()
    expect(reread.history).not.toBe(grown.history)
    expect(reread.history[0]!.pct).toBeLessThan(grown.history[0]!.pct)
    expect(first.history).toEqual(saved)
    checkEstimates(reread.state, reread.history)
  })

  test('live loads and ended-at sharing refresh while unchanged historical costs stay shared', () => {
    const done = worker('history-done')
    const live = worker('history-live', 'code', 'running')
    live.accountId = 'history-account'
    live.attempts[0]!.startedAt = 20
    live.attempts[0]!.endedAt = null
    live.attempts[0]!.startPct = 10
    workers.set(done.id, done)
    workers.set(live.id, live)
    const first = read()
    done.attempts[0]!.endedAt = 60
    live.attempts[0]!.startPct = 33
    live.lastActivity = 'synthetic progress'
    live.updatedAt++
    const next = read()
    expect(next.history).toBe(first.history)
    expect(next.state.running).not.toBe(first.state.running)
    expect(next.state.running.get('history-account')![0]!.startPct).toBe(33)
    expect(next.state.finishedSince.get('history-account')).toBeGreaterThan(
      first.state.finishedSince.get('history-account')!,
    )
    expect(first.state.running.get('history-account')![0]!.startPct).toBe(10)
  })
})
