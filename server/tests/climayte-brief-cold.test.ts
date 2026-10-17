// An omitted judged worker must keep its cold prompt/report fields untouched. The getters below
// count the same boundary as the store's packed-field accessors, without real account data or I/O.
import { expect, test } from 'bun:test'
import { load, workers } from '../src/climayte-core'
import { type CliMayteWorker, isLive, toBrief } from '../src/climayte-lib'
import { climayteList } from '../src/climayte-view'

const GROUP = 'brief-cold-synthetic'
const TEXT = 'synthetic report '.repeat(256)

function worker(id: string, status: CliMayteWorker['status'], at: number, judged = false) {
  const reads = { long: 0 }
  const w: CliMayteWorker = {
    id,
    group: GROUP,
    title: id,
    cwd: '/synthetic',
    get prompt() {
      reads.long++
      return TEXT
    },
    get result() {
      reads.long++
      return TEXT
    },
    get results() {
      reads.long++
      return [TEXT]
    },
    get reports() {
      reads.long++
      return []
    },
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status,
    sessionId: null,
    accountId: null,
    attempts: [],
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: at,
    updatedAt: at,
    ...(judged
      ? {
          verdicts: [
            {
              at: at + 1,
              verdict: 'pass' as const,
              note: null,
              model: null,
              effort: null,
              units: 0,
            },
          ],
        }
      : {}),
  }
  return { w, reads }
}

function withWorkers<T>(fixtures: ReturnType<typeof worker>[], run: () => T): T {
  load()
  for (const { w } of fixtures) workers.set(w.id, w)
  try {
    return run()
  } finally {
    for (const { w } of fixtures) workers.delete(w.id)
  }
}

test('Climayte brief lists leave 2000 omitted judged workers cold and preserve every visible row', () => {
  const history = Array.from({ length: 2000 }, (_, n) => worker(`w-cold-${n}`, 'done', n, true))
  const visible = [
    worker('w-live-cold', 'running', 2001, true),
    worker('w-unjudged-cold', 'done', 2002),
  ]
  withWorkers([...history, ...visible], () => {
    // The former full-view-then-filter path is the expected result and the work avoided.
    const expected = climayteList({ group: GROUP })
      .filter((v) => isLive(v) || !v.judged)
      .map(toBrief)
    expect(history.reduce((n, f) => n + f.reads.long, 0)).toBeGreaterThanOrEqual(2000 * 4)
    for (const f of history) f.reads.long = 0
    expect(climayteList({ group: GROUP, brief: true })).toEqual(expected)
    expect(history.reduce((n, f) => n + f.reads.long, 0)).toBe(0)
  })
})

test('Climayte brief exclusion keeps the existing recent limit and explicit history overrides', () => {
  const live = worker('w-cold-limit-live', 'queued', 1)
  const older = worker('w-cold-limit-unjudged', 'done', 2)
  const latest = worker('w-cold-limit-judged', 'done', 3, true)
  withWorkers([live, older, latest], () => {
    const filter = { group: GROUP, brief: true as const, limit: 1 }
    // The newest judged row consumes the one finished slot; an older unjudged row is not substituted.
    expect(climayteList(filter).map((v) => v.id)).toEqual([live.w.id])
    expect(latest.reads.long).toBe(0)
    expect(older.reads.long).toBe(0)
    expect(climayteList({ ...filter, all: true }).map((v) => v.id)).toEqual([
      latest.w.id,
      live.w.id,
    ])
    expect(climayteList({ ...filter, id: latest.w.id }).map((v) => v.id)).toEqual([latest.w.id])
    expect(climayteList({ ...filter, ids: [latest.w.id] }).map((v) => v.id)).toEqual([latest.w.id])
    expect(latest.reads.long).toBeGreaterThan(0)
  })
})

test('Climayte brief lists immediately include new work after a prior verdict', () => {
  const latest = worker('w-cold-followup', 'done', 5, true)
  latest.w.attempts = [
    {
      account: { id: 'synthetic-account', num: 1, name: 'synthetic' },
      outcome: 'done',
      startedAt: 7,
      endedAt: 8,
      log: '/synthetic/attempt.jsonl',
      errLog: '/synthetic/attempt.err',
      pid: null,
      sessionId: null,
      notice: null,
      resumed: false,
    },
  ]
  withWorkers([latest], () => {
    expect(climayteList({ group: GROUP, brief: true })).toMatchObject([
      { id: latest.w.id, judged: false },
    ])
    expect(latest.reads.long).toBeGreaterThan(0)
  })
})
