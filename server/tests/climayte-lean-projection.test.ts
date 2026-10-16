import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { load, workers } from '../src/climayte-core'
import {
  type CliMayteWorker,
  type CliMayteWorkerView,
  recentWorkers,
  toView,
} from '../src/climayte-lib'
import { UNITS_PER_PRO_PERCENT } from '../src/climayte-scorecard'
import { climayteLeanWorker, climayteList } from '../src/climayte-view'

const GROUP = 'lean-projection-synthetic'
const NOW = 1_000_000
let saved: Array<[string, CliMayteWorker]> = []
let clock: { mockRestore(): void }
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
  clock = spyOn(Date, 'now').mockReturnValue(NOW)
})
afterEach(() => {
  clock.mockRestore()
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
})

const tokens = { input: 100, output: 200, cacheRead: 300, cacheWrite: 400 }
function attempt(
  i: number,
  extra: Partial<CliMayteWorker['attempts'][number]> = {},
): CliMayteWorker['attempts'][number] {
  return {
    account: { id: 'example-account', num: 1, name: 'Example' },
    pid: null,
    started: true,
    startedAt: i * 1_000,
    endedAt: i * 1_000 + 500,
    outcome: 'done',
    sessionId: `example-session-${i}`,
    log: `/synthetic/attempt-${i}`,
    errLog: `/synthetic/attempt-${i}.err`,
    notice: 'Example notice',
    resumed: false,
    requested: { model: 'claude-sonnet-5-5', effort: 'medium' },
    model: 'claude-sonnet-5-5',
    tokens,
    spend: { costUsd: 0.1, turns: 1, reread: i ? tokens : null },
    ...extra,
  }
}

function worker(id: string, extra: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    group: GROUP,
    title: `Example ${id}`,
    cwd: '/synthetic',
    prompt: 'Example task '.repeat(50),
    pending: ['Example follow-up'],
    model: 'claude-sonnet-5-5',
    effort: 'medium',
    accounts: null,
    status: 'done',
    sessionId: 'example-current-session',
    accountId: 'example-account',
    attempts: [
      attempt(0),
      attempt(1, { ceiling: { pct: 100, week: false, resetsAt: null }, cacheTtl: '5m' }),
    ],
    result: 'Example stored result',
    results: ['Example current result'],
    error: null,
    lastActivity: 'Example activity',
    costUsd: 0.2,
    turns: 2,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1,
    updatedAt: 2,
    verdicts: [
      {
        at: 1_500,
        verdict: 'pass',
        note: `${'Example long first line '.repeat(20)}\nExample second line`,
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        units: UNITS_PER_PRO_PERCENT / 2,
        by: 'check',
      },
    ],
    ...extra,
  }
}

const lookup = {
  sessionOf: (id: string) => workers.get(id)?.sessionId ?? null,
  titleOf: () => null,
}

/** Existing public full view followed by the original lean conversion is the compatibility oracle. */
const legacyLean = (w: CliMayteWorker) => climayteLeanWorker(toView(w, NOW, lookup))

test('direct lean rows have identical JSON to full-view conversion across states and optional fields', () => {
  const examples: CliMayteWorker[] = [
    worker('lean-empty', { attempts: [], verdicts: undefined, result: null, results: undefined }),
    worker('lean-legacy', { results: undefined }),
    worker('lean-no-match', { accountId: 'missing-account' }),
    worker('lean-cache', {
      attempts: [
        attempt(0, { cacheTtl: '5m', model: 'claude-opus-5-5' }),
        attempt(1, {
          cacheTtl: '1h',
          model: undefined,
          ceiling: { pct: 100, week: false, resetsAt: null },
        }),
      ],
    }),
    ...(['queued', 'waiting', 'running', 'checking', 'done', 'failed', 'cancelled'] as const).map(
      (status, i) =>
        worker(`lean-${status}`, {
          status,
          createdAt: i + 10,
          updatedAt: i + 20,
          waitUntil: '2026-10-17T00:00:00.000Z',
          stepAt: 5_000,
          stateAt: { key: status, at: 4_000 },
          saidLine: 'Example current narration',
          saidAt: 6_000,
          origin: { kind: 'worker', workerId: 'lean-empty' },
          question: status === 'waiting' ? { text: 'Example question', at: 7_000 } : undefined,
          eta:
            i % 2
              ? { minutes: 2, at: 1, attempt: 0, tookS: 15, doneAt: 3 }
              : { minutes: 2, at: 1, attempt: 0 },
          attempts: [attempt(0), attempt(1, { endedAt: null, outcome: 'running' })],
        }),
    ),
  ]
  Object.assign(examples[0]!, { unknownMetadata: { example: ['retained', 1] } })
  for (const [i, w] of examples.entries()) {
    w.createdAt += i
    workers.set(w.id, w)
  }
  const expected = recentWorkers(examples, undefined).map(legacyLean)
  expect(JSON.stringify(climayteList({ group: GROUP, lean: true }))).toBe(JSON.stringify(expected))
  const rows = climayteList({ group: GROUP, lean: true })
  expect(rows.find((r) => r.id === 'lean-no-match')!.account).toBeNull()
  expect(rows.find((r) => r.id === 'lean-cache')!.reportedModel).toBe('claude-opus-5-5')
  expect(rows.find((r) => r.id === 'lean-done')!.verdicts?.[0]).toMatchObject({
    pct: 0.5,
    note: examples
      .find((w) => w.id === 'lean-done')!
      .verdicts![0]!.note!.split('\n')[0]!
      .slice(0, 200),
  })
})

test('a repeated read sees direct attempt, verdict, account and worker mutations immediately', () => {
  const w = worker('lean-mutable')
  workers.set(w.id, w)
  const first = climayteList({ id: w.id, lean: true })[0]!
  const account = { id: 'example-account', num: null, name: 'Latest example' }
  w.attempts.push(
    attempt(2, { account, model: 'claude-opus-5-5', tokens: { ...tokens, output: 700_000 } }),
  )
  w.verdicts![0]!.units = 0
  w.verdicts![0]!.note = null
  w.status = 'running'
  w.attempts.at(-1)!.endedAt = null
  w.attempts.at(-1)!.outcome = 'running'
  const next = climayteList({ id: w.id, lean: true })[0]!
  expect(JSON.stringify(next)).toBe(JSON.stringify(legacyLean(w)))
  expect(next.account).toBe('Latest example')
  expect(next.reportedModel).toBe('claude-opus-5-5')
  expect(next.verdicts![0]).toMatchObject({ pct: null, note: null })
  expect(next.ranS).toBeGreaterThan(first.ranS)
  expect(next.used.pct).toBeGreaterThan(first.used.pct)
  expect(next.attempts).toHaveLength(3)
  expect(first.attempts).toHaveLength(2)
})

test('18,000 lean rows skip 180,000 discarded attempt-field reads while matching the old rows', () => {
  let discardedReads = 0
  let attemptCount = 0
  for (let i = 0; i < 18_000; i++) {
    const attempts = Array.from({ length: 1 + (i % 4) }, (_, j) => attempt(j))
    attemptCount += attempts.length
    for (const a of attempts)
      for (const key of ['notice', 'requested', 'left', 'peakProcesses'])
        Object.defineProperty(a, key, {
          enumerable: true,
          get() {
            discardedReads++
            return undefined
          },
        })
    const w = worker(`lean-cost-${i}`, { attempts, createdAt: i, updatedAt: i })
    workers.set(w.id, w)
  }
  const expected = recentWorkers([...workers.values()], undefined).map(legacyLean)
  expect(attemptCount).toBe(45_000)
  expect(discardedReads).toBe(4 * attemptCount)
  discardedReads = 0
  const next = climayteList({ group: GROUP, lean: true })
  expect(discardedReads).toBe(0)
  expect(JSON.stringify(next)).toBe(JSON.stringify(expected))
})

test('latest account/model lookup does not copy the attempts array and preserves full details', () => {
  const w = worker('lean-no-copy', {
    attempts: [
      attempt(0, { model: 'claude-opus-5-5' }),
      attempt(1, {
        account: { id: 'other-account', num: 2, name: 'Other example' },
        model: 'claude-sonnet-5-5',
      }),
      attempt(2, {
        account: { id: 'example-account', num: null, name: 'Latest example' },
        model: undefined,
      }),
    ],
  })
  let copies = 0
  Object.defineProperty(w.attempts, Symbol.iterator, {
    value: function* (this: CliMayteWorker['attempts']) {
      copies++
      yield* Array.prototype.values.call(this)
    },
  })
  const expectedAccount = [...w.attempts]
    .reverse()
    .find((a) => a.account.id === w.accountId)!.account
  const expectedModel = [...w.attempts].reverse().find((a) => a.model)!.model
  expect(copies).toBe(2)
  copies = 0
  const full = toView(w, NOW)
  expect(copies).toBe(0)
  expect(full.account).toBe(expectedAccount.name)
  expect(full.reportedModel).toBe(expectedModel!)
  expect(full.attempts[1]).toMatchObject({
    notice: 'Example notice',
    requested: { model: 'claude-sonnet-5-5', effort: 'medium' },
    costUsd: 0.1,
    turns: 1,
    because: { cause: 'follow-up', detail: null },
  } satisfies Partial<CliMayteWorkerView['attempts'][number]>)
})

test('the full view computes each attempt cause once and retains its check explanation', () => {
  const w = worker('full-cause-once', {
    verdicts: [
      {
        at: 500,
        verdict: 'fail',
        note: null,
        model: 'claude-sonnet-5-5',
        effort: 'medium',
        units: 100,
        by: 'check',
      },
    ],
  })
  let noteReads = 0
  Object.defineProperty(w.verdicts![0]!, 'note', {
    enumerable: true,
    get() {
      noteReads++
      return 'The check failed (1).\nExample final output'
    },
  })
  const full = toView(w, NOW)
  expect(noteReads).toBe(2) // One verdict copy and one explanation; the old path explained twice.
  expect(full.attempts[1]!.because).toEqual({ cause: 'check', detail: '1: Example final output' })
})
