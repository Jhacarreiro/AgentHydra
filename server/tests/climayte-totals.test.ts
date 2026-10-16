// CliMayte's totals: tasks that ran vs tasks filed, runs that never launched a CLI, the first task's time.
import { afterEach, describe, expect, test } from 'bun:test'
import { climayteTotals } from '../src/climayte'
import { workers } from '../src/climayte-core'

const ids: string[] = []
afterEach(() => {
  for (const id of ids.splice(0)) workers.delete(id)
})

// Stamped far ahead so `since` holds these tasks and none another test file left in the process.
const T = Date.now() + 40 * 86_400_000
const attempt = (over: Record<string, unknown>) => ({
  account: { id: 'acct-example', num: 1, name: 'Example' },
  pid: null,
  startedAt: T,
  endedAt: T + 1_000,
  outcome: 'done',
  started: false,
  ...over,
})
const put = (id: string, status: string, attempts: unknown[]) => {
  ids.push(id)
  workers.set(id, { id, title: id, status, createdAt: T, attempts } as any)
}

describe('climayteTotals honesty fields', () => {
  test('counts tasks that ran apart from tasks filed, and never-launched attempts apart from runs', () => {
    put('t-ran-done', 'done', [attempt({ pid: 4242, started: true })])
    put('t-ran-failed', 'failed', [
      attempt({ outcome: 'interrupted' }), // never launched
      attempt({ started: true, startedAt: T + 2_000, endedAt: T + 3_000, outcome: 'error' }),
    ])
    put('t-cancelled-before-run', 'cancelled', [attempt({ outcome: 'cancelled' })])
    put('t-queued-never', 'done', [])
    put('t-runner-claimed', 'done', [attempt({ runner: { pid: 77 }, outcome: 'interrupted' })])

    const t = climayteTotals(T - 1)
    expect(t.tasks).toBe(5)
    expect(t.tasksRan).toBeGreaterThanOrEqual(3)
    expect(t.tasksByStatus).toEqual({ done: 2, failed: 1, cancelled: 0, neverRan: 2 })
    // 4 launched attempts + 0; the two never-launched ones are counted apart, outside both sums.
    expect(t.sessions).toBe(3)
    expect(t.neverLaunched).toBe(2)
    expect(t.runsByOutcome.interrupted).toBe(1)
    expect(Object.values(t.runsByOutcome).reduce((a, b) => a + (b ?? 0), 0)).toBe(t.sessions)
  })

  test('firstAt is the first task on record, whatever `since` is', () => {
    put('t-first', 'done', [])
    const t = climayteTotals(T - 1)
    expect(t.firstAt).not.toBeNull()
    expect(t.firstAt!).toBeLessThanOrEqual(T)
  })
})

describe('climayteTotals interval counts', () => {
  test('matches the former inclusive scan for unsorted, open, zero-length and out-of-scope runs', () => {
    const ceiling = { pct: 90, week: false, resetsAt: null }
    const group = [
      attempt({ started: true, startedAt: T + 10, endedAt: T + 20, ceiling }),
      attempt({ started: true, startedAt: T - 100, endedAt: null }),
      attempt({ started: true, startedAt: T + 10, endedAt: T + 10 }),
      attempt({ started: true, startedAt: T, endedAt: T + 10, ceiling }),
      attempt({ started: true, startedAt: T + 30, endedAt: T + 5 }),
      attempt({ started: true, startedAt: T, endedAt: T, ceiling }),
      attempt({ started: false, startedAt: T + 8, endedAt: T + 12 }),
    ]
    const earlier = attempt({ started: true, startedAt: T + 5, endedAt: T + 12 })
    const other = attempt({
      account: { id: 'other-example', num: 2, name: 'Other' },
      started: true,
    })
    put('t-intervals', 'done', group)
    put('t-interval-earlier', 'done', [earlier])
    workers.get('t-interval-earlier')!.createdAt = T - 1000
    put('t-interval-other', 'done', [other])
    const all = [...group, earlier, other]
    const totals = climayteTotals(T)
    const stops = totals.ceilingStopList.filter((s) => s.id === 't-intervals')
    expect(stops).toHaveLength(3)
    for (const stop of stops) {
      const at = Date.parse(stop.at)
      const expected = all.filter(
        (a) =>
          a.account.id === 'acct-example' &&
          a.startedAt <= at &&
          (a.endedAt ?? Number.MAX_SAFE_INTEGER) >= at,
      ).length
      expect(stop.workers).toBe(expected)
    }
    expect(stops.map((s) => s.workers)).toEqual([2, 6, 3])
    // Never-launched and open attempts were excluded from these future-scoped totals, but the
    // interval scan always included them when counting overlap. A fresh totals call sees edits.
    group[1]!.endedAt = T + 5
    expect(
      climayteTotals(T).ceilingStopList.find(
        (s) => s.id === 't-intervals' && Date.parse(s.at) === T + 10,
      )?.workers,
    ).toBe(5)
  })

  test('12000 historical attempts are visited once for 4000 ceiling stops instead of once per stop', () => {
    let startReads = 0
    const count = 12000
    for (let worker = 0; worker < 1000; worker++) {
      const attempts = Array.from({ length: 12 }, (_, i) => {
        const n = worker * 12 + i
        return {
          ...attempt({ started: true, endedAt: T + n * 10 + 100 }),
          get startedAt() {
            startReads++
            return T + n * 10
          },
          ...(n % 3 === 0 ? { ceiling: { pct: 90, week: false, resetsAt: null } } : {}),
        }
      })
      put(`t-interval-scale-${worker}`, 'done', attempts)
    }
    const totals = climayteTotals(T - 1)
    expect(totals.ceilingStops).toBe(4000)
    expect(startReads).toBeLessThanOrEqual(count * 2)
    // Independent closed-form counts: each 100 ms interval overlaps the next ten starts,
    // including the start/end tie, until the end of the record cuts that number short.
    for (const stop of totals.ceilingStopList) {
      const n = (Date.parse(stop.at) - T - 100) / 10
      expect(stop.workers).toBe(Math.min(11, count - n))
    }
  })
})
