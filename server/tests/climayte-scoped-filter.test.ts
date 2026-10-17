import { afterEach, beforeEach, expect, test } from 'bun:test'
import { listeners, load, workers } from '../src/climayte-core'
import { type CliMayteWorker, recentWorkers } from '../src/climayte-lib'
import {
  type CliMayteListFilter,
  climayteList,
  climayteWait,
  dispatchedFrom,
  matches,
} from '../src/climayte-view'

const GROUP = 'scoped-filter-synthetic'
let saved: Array<[string, CliMayteWorker]> = []
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
})
afterEach(() => {
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
})

function worker(id: string, extra: Partial<CliMayteWorker> = {}): CliMayteWorker {
  return {
    id,
    group: GROUP,
    title: `Example ${id}`,
    cwd: '/synthetic',
    prompt: 'Example task',
    pending: [],
    model: null,
    effort: null,
    accounts: null,
    status: 'done',
    sessionId: `session-${id}`,
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
    updatedAt: 2,
    ...extra,
  }
}

/** Original ancestry/session predicate, kept as an independent ordering and membership oracle. */
function legacyDispatched(all: Iterable<CliMayteWorker>, sessions: readonly string[]): Set<string> {
  const want = new Set(sessions)
  const list = [...all]
  const managers = new Map<string, string>()
  for (const w of list) if (w.kind === 'manage' && w.wave) managers.set(w.wave, w.id)
  const children = new Map<string, string[]>()
  const seeds: string[] = []
  for (const w of list) {
    const up =
      w.origin?.kind === 'worker'
        ? w.origin.workerId
        : !w.origin && w.wave && w.kind !== 'manage'
          ? managers.get(w.wave)
          : undefined
    if (up && up !== w.id) {
      const list = children.get(up)
      if (list) list.push(w.id)
      else children.set(up, [w.id])
    }
    if (w.origin?.kind === 'chat' && want.has(w.origin.sessionId)) seeds.push(w.id)
  }
  for (const w of list)
    if ([w.sessionId, ...(w.sessions ?? [])].some((s) => s && want.has(s)))
      seeds.push(...(children.get(w.id) ?? []))
  const mine = new Set<string>()
  for (let queue = seeds; queue.length; ) {
    const next: string[] = []
    for (const id of queue) {
      if (mine.has(id)) continue
      mine.add(id)
      next.push(...(children.get(id) ?? []))
    }
    queue = next
  }
  return mine
}

function expectedIds(filter: CliMayteListFilter): string[] {
  const all = [...workers.values()]
  const mine = filter.origin?.length ? legacyDispatched(all, filter.origin) : null
  return recentWorkers(
    all.filter((w) => matches(w, filter) && (!mine || mine.has(w.id))),
    filter.limit,
  ).map((w) => w.id)
}
const idsFor = (filter: CliMayteListFilter) =>
  climayteList({ ...filter, lean: true }).map((w) => w.id)

test('compiled scopes preserve empty, duplicate, AND, ancestry, brief and recent-limit semantics', () => {
  const origin = {
    kind: 'chat' as const,
    sessionId: 'example-origin',
    home: '/synthetic',
    transcript: null,
    how: 'synthetic',
  }
  const rows = [
    worker('w-manager', {
      origin,
      kind: 'manage',
      wave: 'example-wave',
      sessions: ['prior-manager'],
    }),
    worker('w-child', {
      status: 'running',
      origin: { kind: 'worker', workerId: 'w-manager' },
      sessions: ['prior-child', ''],
    }),
    worker('w-wave-task', {
      wave: 'example-wave',
      kind: 'task',
      status: 'waiting',
      sessionId: null,
    }),
    worker('w-grandchild', { origin: { kind: 'worker', workerId: 'w-child' }, createdAt: 3 }),
    worker('w-other', { group: 'other-group', sessionId: '', sessions: [''], createdAt: 2 }),
    worker('w-cycle-a', { origin: { kind: 'worker', workerId: 'w-cycle-b' }, updatedAt: 4 }),
    worker('w-cycle-b', { origin: { kind: 'worker', workerId: 'w-cycle-a' }, updatedAt: 5 }),
  ]
  for (const w of rows) workers.set(w.id, w)
  const filters: CliMayteListFilter[] = [
    {},
    { id: '', group: '', origin: [] },
    { ids: [] },
    { sessions: [] },
    { ids: [''] },
    { sessions: [''] },
    { ids: ['w-manager'] },
    { ids: ['w-other', 'w-child', 'w-manager', 'w-child'] },
    { sessions: ['session-w-manager', 'prior-child', 'prior-child'] },
    { sessions: ['prior-manager'] },
    { id: 'w-manager', ids: ['w-child'] },
    { ids: ['w-child', 'w-other'], sessions: ['prior-child', ''], group: GROUP, active: true },
    { ids: ['w-child', 'w-other'], sessions: ['prior-child'], active: false },
    {
      origin: ['example-origin'],
      ids: ['w-manager', 'w-child', 'w-grandchild', 'w-other'],
      limit: 1,
    },
    { origin: ['prior-manager'], sessions: ['prior-child', 'session-w-grandchild'] },
    { origin: ['example-origin'], active: true, group: GROUP, brief: true },
    { ids: rows.map((w) => w.id), limit: 0 },
    { ids: rows.map((w) => w.id), limit: 2, brief: true },
  ]
  for (const filter of filters) expect(idsFor(filter)).toEqual(expectedIds(filter))
  expect([...dispatchedFrom(rows, ['prior-manager'])]).toEqual([
    ...legacyDispatched(rows, ['prior-manager']),
  ])
  expect([...dispatchedFrom(rows, [''])]).toEqual([])
})

test('membership is rebuilt for every read after filter arrays and worker fields change', () => {
  const a = worker('w-a', { sessions: ['prior-a'] })
  const b = worker('w-b', { sessions: ['prior-b'] })
  workers.set(a.id, a)
  workers.set(b.id, b)
  const filter: CliMayteListFilter = { ids: [a.id, 'missing'], sessions: ['prior-a'] }
  expect(idsFor(filter)).toEqual([a.id])
  filter.ids!.splice(0, 2, b.id, 'missing')
  filter.sessions!.splice(0, 1, 'new-b')
  b.sessions!.push('new-b')
  expect(idsFor(filter)).toEqual([b.id])
  b.sessions = []
  b.sessionId = 'new-b'
  filter.active = true
  expect(idsFor(filter)).toEqual([])
  b.status = 'checking'
  expect(idsFor(filter)).toEqual([b.id])
  filter.ids = []
  expect(idsFor(filter)).toEqual([])
})

test('a waiting subscription keeps reading mutable filters before its final scoped list', async () => {
  const a = worker('w-wait-a', { status: 'running' })
  const b = worker('w-wait-b', { status: 'running' })
  workers.set(a.id, a)
  workers.set(b.id, b)
  const filter: CliMayteListFilter = {
    ids: [a.id, 'missing'],
    sessions: [a.sessionId!],
    lean: true,
  }
  const pending = climayteWait(filter, 1_000)
  filter.ids!.splice(0, 2, b.id, 'missing')
  filter.sessions!.splice(0, 1, b.sessionId!)
  b.status = 'done'
  for (const listener of [...listeners]) listener(b)
  expect((await pending).map((w) => w.id)).toEqual([b.id])
})

test('18,000-row scoped reads avoid per-row requested-ID searches and session array copies', () => {
  let includes = 0
  let copies = 0
  for (let i = 0; i < 18_000; i++) {
    const sessions = [`prior-${i}`, `earlier-${i}`]
    Object.defineProperty(sessions, Symbol.iterator, {
      value: function* (this: string[]) {
        copies++
        yield* Array.prototype.values.call(this)
      },
    })
    const w = worker(`w-cost-${i}`, { sessions, createdAt: i })
    workers.set(w.id, w)
  }
  const ids = Array.from({ length: 1_000 }, (_, i) => `w-cost-${i * 17}`)
  const sessions = Array.from({ length: 1_000 }, (_, i) => `prior-${i * 17}`)
  for (const values of [ids, sessions])
    Object.defineProperty(values, 'includes', {
      value(this: string[], value: string) {
        includes++
        return Array.prototype.includes.call(this, value)
      },
    })
  const filter: CliMayteListFilter = { ids, sessions }
  const expected = expectedIds(filter)
  expect(includes).toBeGreaterThanOrEqual(18_000)
  expect(copies).toBe(1_000)
  includes = 0
  copies = 0
  expect(idsFor(filter)).toEqual(expected)
  expect(includes).toBe(0)
  expect(copies).toBe(0)

  const originSessions = sessions.slice(0, 10)
  legacyDispatched(workers.values(), originSessions)
  expect(copies).toBe(18_000)
  copies = 0
  expect([...dispatchedFrom(workers.values(), originSessions)]).toEqual([])
  expect(copies).toBe(0)
})
