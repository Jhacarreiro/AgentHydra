import { Database } from 'bun:sqlite'
import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { load, workers } from '../src/climayte-core'
import type { CliMayteWorker } from '../src/climayte-lib'
import { climayteTotals, kitSpend } from '../src/climayte-totals'
import { KitStore } from '../src/kit/store'

const T = Date.now()
const scratch = mkdtempSync(join(tmpdir(), 'climayte-kit-membership-'))
afterAll(async () => {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(scratch, { recursive: true, force: true })
      return
    } catch (error) {
      const code = (error as { code?: string }).code
      if (code !== 'EBUSY' && code !== 'EPERM') throw error
      // Closed SQLite handles can remain locked briefly on Windows. The test preload's
      // aged-temp sweep later removes a fixture still locked after this bounded wait.
      if (attempt === 10) return
      await Bun.sleep(50)
    }
  }
})
let saved: Array<[string, CliMayteWorker]> = []
let stores: KitStore[] = []
beforeEach(() => {
  load()
  saved = [...workers]
  workers.clear()
})
afterEach(() => {
  workers.clear()
  for (const [id, w] of saved) workers.set(id, w)
  for (const store of stores.splice(0)) store.close()
})

function fixture(path = ':memory:') {
  const store = new KitStore(path)
  // These small ledger fixtures exercise membership, not background WAL checkpointing.
  store.ckptEveryMs = Infinity
  stores.push(store)
  let queries = 0
  let fail = false
  const query = store.db.query.bind(store.db)
  store.db.query = ((sql: string) => {
    if (sql.startsWith('select distinct session from usage_session')) {
      queries++
      if (fail) throw new Error('Synthetic membership read failure')
    }
    return query(sql)
  }) as typeof store.db.query
  const add = (session: string, input: number) => {
    store.upsertEvents([
      {
        id: `event-${session}`,
        ts: T,
        source: 'climayte',
        session,
        model: 'claude-sonnet-5-5',
        input,
        weighted: input,
        list_usd: input / 10,
      },
    ])
    // The production ledger is populated by maintenance, after raw ingestion.
    store.rollup()
  }
  add('anchor-session', 1)
  return {
    store,
    add,
    queries: () => queries,
    fail: (on: boolean) => {
      fail = on
    },
  }
}
function put(id: string, session: string, input: number) {
  const w = {
    id,
    title: id,
    group: 'kit-membership-synthetic',
    status: 'done',
    createdAt: T - 100,
    updatedAt: T,
    cwd: '/synthetic',
    prompt: 'synthetic task',
    pending: [],
    effort: null,
    accounts: null,
    accountId: null,
    result: null,
    error: null,
    lastActivity: null,
    turns: 1,
    moves: 0,
    retries: 0,
    notBefore: null,
    model: 'claude-sonnet-5-5',
    costUsd: input / 10,
    tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
    sessionId: session,
    attempts: [
      {
        account: { id: 'synthetic-account', num: 1, name: 'Example' },
        pid: null,
        started: true,
        startedAt: T - 100,
        endedAt: T,
        outcome: 'done',
        sessionId: session,
        log: '/synthetic/attempt',
        errLog: '/synthetic/attempt.err',
        notice: null,
        resumed: false,
        tokens: { input, output: 0, cacheRead: 0, cacheWrite: 0 },
        spend: { costUsd: input / 10, turns: 1, reread: null },
      },
    ],
  } as CliMayteWorker
  workers.set(id, w)
  return w
}
const read = (f: ReturnType<typeof fixture>) => climayteTotals(0, { store: f.store })
const kitInput = (f: ReturnType<typeof fixture>) => kitSpend(0, f.store)!.tokens.input

describe('CliMayte kit session membership cache', () => {
  test('unchanged membership reads once despite reordered workers and duplicate sessions; add/remove replaces the one entry', () => {
    const f = fixture()
    f.add('known-session', 10)
    const a = put('membership-a', 'known-session', 100)
    put('membership-b', 'missing-session', 200)
    expect(read(f).tokens.input).toBe(kitInput(f) + 200)
    expect(f.queries()).toBe(1)
    workers.delete(a.id)
    workers.set(a.id, a)
    put('membership-duplicate', 'known-session', 999)
    for (let n = 0; n < 20; n++) expect(read(f).tokens.input).toBe(kitInput(f) + 200)
    expect(f.queries()).toBe(1)
    workers.delete('membership-b')
    expect(read(f).tokens.input).toBe(kitInput(f))
    expect(f.queries()).toBe(2)
    put('membership-b', 'missing-session', 200)
    expect(read(f).tokens.input).toBe(kitInput(f) + 200)
    expect(f.queries()).toBe(3)
    workers.clear()
    expect(read(f).tokens.input).toBe(kitInput(f))
    put('membership-a', 'known-session', 100)
    expect(read(f).tokens.input).toBe(kitInput(f))
    expect(f.queries()).toBe(4)
  })

  test('same-connection inserts and removals immediately refresh known and missing sessions', () => {
    const f = fixture()
    put('membership-change', 'changing-session', 100)
    expect(read(f).tokens.input).toBe(kitInput(f) + 100)
    expect(f.queries()).toBe(1)
    f.add('changing-session', 10)
    expect(read(f).tokens.input).toBe(kitInput(f))
    expect(f.queries()).toBe(2)
    f.store.db
      .query("delete from usage_session where session = ? and source = 'climayte'")
      .run('changing-session')
    expect(read(f).tokens.input).toBe(kitInput(f) + 100)
    expect(f.queries()).toBe(3)
  })

  test('another connection invalidates membership without changing this connection total_changes', () => {
    const path = join(scratch, 'other-connection.db')
    const f = fixture(path)
    put('membership-external', 'external-session', 100)
    expect(read(f).tokens.input).toBe(kitInput(f) + 100)
    const changes = f.store.db.query('select total_changes() as n').get()
    const other = new Database(path)
    try {
      other
        .query(
          "insert into usage_session(session, source, first_ts, last_ts, calls, input, weighted, list_usd) values (?, 'climayte', ?, ?, 1, 10, 10, 1)",
        )
        .run('external-session', T, T)
      expect(f.store.db.query('select total_changes() as n').get()).toEqual(changes)
      expect(read(f).tokens.input).toBe(kitInput(f))
      expect(f.queries()).toBe(2)
      other.query('delete from usage_session where session = ?').run('external-session')
      expect(read(f).tokens.input).toBe(kitInput(f) + 100)
      expect(f.queries()).toBe(3)
    } finally {
      other.close()
    }
  })

  test('independent and reopened connections never inherit another database membership', () => {
    const a = fixture()
    const b = fixture()
    a.add('database-session', 10)
    b.add('different-session', 10)
    put('membership-isolation', 'database-session', 100)
    expect(read(a).tokens.input).toBe(kitInput(a))
    expect(read(b).tokens.input).toBe(kitInput(b) + 100)
    expect(a.queries()).toBe(1)
    expect(b.queries()).toBe(1)
    const path = join(scratch, 'reopened.db')
    const first = fixture(path)
    first.add('database-session', 10)
    expect(read(first).tokens.input).toBe(kitInput(first))
    first.store.close()
    stores = stores.filter((store) => store !== first.store)
    const reopened = fixture(path)
    expect(read(reopened).tokens.input).toBe(kitInput(reopened))
    expect(reopened.queries()).toBe(1)
  })

  test('a failed membership query propagates and is retried instead of caching an empty result', () => {
    const f = fixture()
    f.add('known-session', 10)
    put('membership-original', 'known-session', 100)
    read(f)
    put('membership-new', 'missing-session', 200)
    f.fail(true)
    expect(() => read(f)).toThrow('Synthetic membership read failure')
    f.fail(false)
    expect(read(f).tokens.input).toBe(kitInput(f) + 200)
    expect(f.queries()).toBe(3)
  })
})
