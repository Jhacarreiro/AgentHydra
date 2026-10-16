import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { load, workers } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import {
  originChatTitle,
  TITLE_LOOKUPS_PER_PASS,
  TITLE_RETRY_MS,
  warmOriginTitles,
} from '../src/core/climayte-queue-sync'

const T = 1_800_000_000_000
let saved: Array<[string, CliMayteWorker]> = []
const realSetTimeout = globalThis.setTimeout
const realClearTimeout = globalThis.clearTimeout
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
})
afterEach(() => {
  globalThis.setTimeout = realSetTimeout
  globalThis.clearTimeout = realClearTimeout
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
})

function put(
  id: string,
  session: string | null,
  status: CliMayteWorker['status'],
  updatedAt: number,
): CliMayteWorker {
  const w: CliMayteWorker = {
    id,
    group: 'origin-title-efficient-synthetic',
    title: id,
    cwd: '/synthetic',
    prompt: 'Synthetic task',
    pending: [],
    accounts: null,
    model: null,
    effort: null,
    status,
    sessionId: null,
    accountId: null,
    attempts: [],
    result: null,
    error: null,
    lastActivity: null,
    costUsd: 0,
    turns: 0,
    moves: 0,
    retries: 0,
    notBefore: null,
    createdAt: 1,
    updatedAt,
    ...(session === null
      ? {}
      : {
          origin: {
            kind: 'chat' as const,
            sessionId: session,
            home: '/synthetic/home',
            transcript: null,
            how: 'Synthetic dispatch',
          },
        }),
  }
  workers.set(id, w)
  return w
}

type Cache = Map<string, { title: string | null; at: number }>
// The former sort-everything selection is the oracle, including stable order among duplicate origins.
function formerPick(now: number, cache: Cache): string[] {
  const todo: string[] = []
  const finished = (s: string) => s === 'done' || s === 'failed' || s === 'cancelled'
  const rank = [...workers.values()].sort(
    (a, b) => Number(finished(a.status)) - Number(finished(b.status)) || b.updatedAt - a.updatedAt,
  )
  for (const w of rank) {
    const id = w.origin?.kind === 'chat' ? w.origin.sessionId : null
    if (!id || todo.includes(id)) continue
    const have = cache.get(id)
    if (have && (have.title !== null || now - have.at < TITLE_RETRY_MS)) continue
    todo.push(id)
    if (todo.length >= TITLE_LOOKUPS_PER_PASS) break
  }
  return todo
}

describe('efficient origin title warming', () => {
  test('same stable active-first/newest/duplicate priority and ten-title cap as the former selection', async () => {
    const cache: Cache = new Map()
    const cached = 'efficient-positive-cached'
    const missed = 'efficient-null-cached'
    put('cached-positive', cached, 'done', 1)
    put('cached-miss', missed, 'done', 1)
    await warmOriginTitles(T, async (id) => (id === cached ? 'Existing title' : null))
    cache.set(cached, { title: 'Existing title', at: T })
    cache.set(missed, { title: null, at: T })
    workers.clear()
    put('cached-newest', cached, 'running', 100_000)
    put('miss-newest', missed, 'running', 99_999)
    put('worker-origin', null, 'running', 99_998).origin = {
      kind: 'worker',
      workerId: 'another-worker',
    }
    put('no-origin', null, 'running', 99_997)
    put('duplicate-finished', 'efficient-shared', 'done', 90_000)
    put('tie-first', 'efficient-tie-first', 'running', 500)
    put('tie-second', 'efficient-tie-second', 'queued', 500)
    put('duplicate-active', 'efficient-shared', 'waiting', 700)
    for (let i = 0; i < 20; i++)
      put(`candidate-${i}`, `efficient-candidate-${i}`, i % 3 === 0 ? 'done' : 'running', 400 - i)
    for (let pass = 0; pass < 4; pass++) {
      const now = pass === 3 ? T + TITLE_RETRY_MS : T + pass
      const expected = formerPick(now, cache)
      const calls: string[] = []
      await warmOriginTitles(now, async (id) => {
        calls.push(id)
        return `Title ${id}`
      })
      expect(calls).toEqual(expected)
      expect(calls.length).toBeLessThanOrEqual(TITLE_LOOKUPS_PER_PASS)
      for (const id of calls) cache.set(id, { title: `Title ${id}`, at: now })
      if (pass === 0)
        expect(calls.slice(0, 3)).toEqual([
          'efficient-shared',
          'efficient-tie-first',
          'efficient-tie-second',
        ])
    }
    expect(originChatTitle(cached)).toBe('Existing title')
    expect(originChatTitle(missed)).toBe(`Title ${missed}`)
  })

  test('miss, undefined, blank, rejection and synchronous throw retain the exact retry boundary and title cleanup', async () => {
    const ids = ['null', 'undefined', 'blank', 'rejected', 'thrown', 'success'].map(
      (s) => `efficient-miss-${s}`,
    )
    for (let i = 0; i < ids.length; i++) put(`miss-${i}`, ids[i]!, 'running', ids.length - i)
    const calls: string[] = []
    await warmOriginTitles(T, (id) => {
      calls.push(id)
      if (id.endsWith('-thrown')) throw new Error('Synthetic immediate failure')
      if (id.endsWith('-rejected')) return Promise.reject(new Error('Synthetic rejected lookup'))
      return Promise.resolve(
        id.endsWith('-undefined')
          ? undefined
          : id.endsWith('-blank')
            ? ' \n '
            : id.endsWith('-success')
              ? `  ${'x'.repeat(130)}  `
              : null,
      )
    })
    expect(calls).toEqual(ids)
    for (const id of ids.slice(0, -1)) expect(originChatTitle(id)).toBeNull()
    expect(originChatTitle(ids.at(-1)!)).toBe('x'.repeat(120))
    for (const now of [T - 1, T + TITLE_RETRY_MS - 1]) {
      const early: string[] = []
      await warmOriginTitles(now, async (id) => {
        early.push(id)
        return 'Unexpected early retry'
      })
      expect(early).toEqual([])
    }
    const retried: string[] = []
    await warmOriginTitles(T + TITLE_RETRY_MS, async (id) => {
      retried.push(id)
      return 'Recovered title'
    })
    expect(retried).toEqual(ids.slice(0, -1))
    const successes: string[] = []
    await warmOriginTitles(T + 100 * TITLE_RETRY_MS, async (id) => {
      successes.push(id)
      return null
    })
    expect(successes).toEqual([])
  })

  test('17425 cached or ineligible workers perform zero ranking reads instead of sorting the whole history', async () => {
    const session = 'efficient-large-cached'
    put('seed-large-cache', session, 'done', 1)
    await warmOriginTitles(T, async () => 'Cached title')
    workers.clear()
    let rankingReads = 0
    const size = 17_425
    for (let i = 0; i < size; i++) {
      const status = i % 3 === 0 ? 'running' : 'done'
      const updatedAt = (i * 7919) % size
      const w = put(`large-${i}`, i % 2 ? session : null, status, updatedAt)
      Object.defineProperty(w, 'status', {
        enumerable: true,
        get: () => {
          rankingReads++
          return status
        },
      })
      Object.defineProperty(w, 'updatedAt', {
        enumerable: true,
        get: () => {
          rankingReads++
          return updatedAt
        },
      })
    }
    let lookups = 0
    await warmOriginTitles(T + 1, async () => {
      lookups++
      return 'Unexpected lookup'
    })
    expect(lookups).toBe(0)
    expect(rankingReads).toBe(0)
    expect(formerPick(T + 1, new Map([[session, { title: 'Cached title', at: T }]]))).toEqual([])
    expect(rankingReads).toBeGreaterThan(size)
    console.info(
      `[climayte-origin-titles] ${size} cached/ineligible workers: former ranking reads=${rankingReads}, new=0`,
    )
  })

  test('cached history is not ranked while a small eligible subset retains the former order', async () => {
    const cached = 'efficient-mixed-cache'
    put('mixed-seed', cached, 'done', 1)
    await warmOriginTitles(T, async () => 'Cached title')
    workers.clear()
    for (let i = 0; i < 5000; i++) {
      const w = put(`mixed-cached-${i}`, i % 2 ? cached : null, 'running', 100_000 + i)
      Object.defineProperty(w, 'status', {
        get: () => {
          throw new Error('Ranked cached history')
        },
      })
      Object.defineProperty(w, 'updatedAt', {
        get: () => {
          throw new Error('Ranked cached history')
        },
      })
    }
    const wanted = [
      'efficient-mixed-active-new',
      'efficient-mixed-active-old',
      'efficient-mixed-finished',
    ]
    put('mixed-finished', wanted[2]!, 'done', 1000)
    put('mixed-old', wanted[1]!, 'queued', 1)
    put('mixed-new', wanted[0]!, 'waiting', 2)
    const got: string[] = []
    await warmOriginTitles(T + 1, async (id) => {
      got.push(id)
      return 'New title'
    })
    expect(got).toEqual(wanted)
  })

  test('immediate lookup completion and failure clear every created deadline timer', async () => {
    const live = new Set<ReturnType<typeof setTimeout>>()
    let created = 0
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      const timer = realSetTimeout(callback, ms)
      live.add(timer)
      created++
      return timer
    }) as typeof setTimeout
    globalThis.clearTimeout = ((timer: ReturnType<typeof setTimeout>) => {
      live.delete(timer)
      return realClearTimeout(timer)
    }) as typeof clearTimeout
    const ids = ['ok', 'null', 'reject', 'throw'].map((s) => `efficient-timers-${s}`)
    for (let i = 0; i < ids.length; i++) put(`timer-${i}`, ids[i]!, 'running', ids.length - i)
    await warmOriginTitles(T, (id) => {
      if (id.endsWith('-throw')) throw new Error('Synthetic immediate failure')
      if (id.endsWith('-reject')) return Promise.reject(new Error('Synthetic rejection'))
      return Promise.resolve(id.endsWith('-null') ? null : 'Title')
    })
    expect(created).toBe(3)
    expect(live.size).toBe(0)
  })

  test('a timed-out lookup remains a miss, ignores late resolution and retries only after its original deadline', async () => {
    const delays: number[] = []
    globalThis.setTimeout = ((callback: () => void, ms?: number) => {
      if (ms !== undefined) delays.push(ms)
      return realSetTimeout(callback, ms === 2000 ? 0 : ms)
    }) as typeof setTimeout
    const id = 'efficient-timeout'
    put('timeout-worker', id, 'running', 1)
    let resolveLate!: (value: string) => void
    await warmOriginTitles(
      T,
      () =>
        new Promise<string>((resolve) => {
          resolveLate = resolve
        }),
    )
    expect(delays).toEqual([2000])
    expect(originChatTitle(id)).toBeNull()
    resolveLate('A late title')
    await Promise.resolve()
    expect(originChatTitle(id)).toBeNull()
    let retry = 0
    await warmOriginTitles(T + TITLE_RETRY_MS - 1, async () => {
      retry++
      return 'Too early'
    })
    expect(retry).toBe(0)
    await warmOriginTitles(T + TITLE_RETRY_MS, async () => {
      retry++
      return 'Recovered'
    })
    expect(retry).toBe(1)
    expect(originChatTitle(id)).toBe('Recovered')
  })
})
