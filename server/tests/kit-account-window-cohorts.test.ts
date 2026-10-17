import { expect, spyOn, test } from 'bun:test'
import { accountTokenWindows, accountTokenWindowsAsync } from '../src/kit/account-windows'
import { resolveWindow, type UsageQueryOpts } from '../src/kit/query'
import { KitStore } from '../src/kit/store'
import type { AccountTokens, TokenParts } from '../src/types'

const H = 3_600_000
const NOW = Date.UTC(2026, 5, 15, 12, 20)
const SPLIT = Date.UTC(2026, 5, 15, 10)
const zero = (): TokenParts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 })

// The prior complete per-account SQL is the oracle: preserve each SQLite SUM, not JS partial sums.
const OLD_SQL = `select sum(input) as input, sum(output) as output, sum(cache_read) as cache_read,
  sum(cache_write) as cache_write from (
    select h.input, h.output, h.cache_read, h.cache_write_5m + h.cache_write_1h as cache_write
      from usage_hour h where h.account = $id and h.hour >= $fc and h.hour < $split
    union all
    select e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
      from usage_event e where e.account = $id and e.ts >= $f and e.ts < $fc
    union all
    select e.input, e.output, e.cache_read, e.cache_write_5m + e.cache_write_1h
      from usage_event e where e.account = $id and e.ts >= max($fc, $split)
    union all
    select h.input, h.output, h.cache_read, h.cache_write_5m + h.cache_write_1h
      from usage_hour h where h.account = $id and h.hour >= max($fc, $split)
        and h.pc in (select pc from imported_pc)
  )`

function legacy(ids: string[], store: KitStore, quota: NonNullable<UsageQueryOpts['quota']>) {
  const out = new Map<string, AccountTokens>()
  const stmt = store.db.query(OLD_SQL)
  for (const id of new Set(ids)) {
    const sums = (from: number): TokenParts => {
      const row = stmt.get({
        $id: id,
        $f: from,
        $fc: Math.ceil(from / H) * H,
        $split: SPLIT,
      }) as Record<string, number | null>
      if (row.input === null) return zero()
      const input = Number(row.input)
      const output = Number(row.output)
      const cacheRead = Number(row.cache_read)
      const cacheWrite = Number(row.cache_write)
      return {
        input,
        output,
        cacheRead,
        cacheWrite,
        total: input + output + cacheRead + cacheWrite,
      }
    }
    out.set(id, {
      fiveHour: sums(resolveWindow({ account: id, kind: '5h' }, NOW, quota).from),
      week: sums(resolveWindow({ account: id, kind: 'week' }, NOW, quota).from),
      total: sums(0),
    })
  }
  return out
}

const quota: NonNullable<UsageQueryOpts['quota']> = (id) => {
  const n = Number(id.replace('acct-', ''))
  if (!Number.isInteger(n) || n % 4 === 3) return null
  const shift = n % 4 === 1 ? 1 : 0
  return {
    sessionResetsAt: new Date(NOW + (n % 4 === 2 ? -6 : 4) * H + shift).toISOString(),
    weekResetsAt: new Date(NOW + (n % 4 === 2 ? -8 : 5) * 24 * H + shift).toISOString(),
  }
}

function dense(store: KitStore, accounts: string[]) {
  const hour = store.db.query(`insert into usage_hour
    (hour, day, pc, account, source, input, output, cache_read, cache_write_5m, cache_write_1h)
    values (?, '2026-06-15', ?, ?, 'cli', ?, ?, ?, ?, ?)`)
  const raw = store.db.query(`insert into usage_event
    (id, ts, day, pc, account, source, input, output, cache_read, cache_write_5m, cache_write_1h)
    values (?, ?, '2026-06-15', 'local', ?, 'cli', ?, ?, ?, ?, ?)`)
  store.db.transaction(() => {
    store.db
      .query('insert into imported_pc (pc, sig, rows, at) values (?, ?, 0, 0)')
      .run('imported', 'fixture')
    for (const [i, id] of accounts.entries()) {
      if (id === 'acct-none') continue
      for (let ago = 0; ago < 180; ago++)
        for (const pc of ['local', 'imported', 'unregistered'])
          hour.run(Math.floor(NOW / H) * H - ago * H, pc, id, i + 1, 2, 3, 4, 5)
      const edges = new Set([
        SPLIT,
        Math.ceil(resolveWindow({ account: id, kind: '5h' }, NOW, quota).from / H) * H,
        Math.ceil(resolveWindow({ account: id, kind: 'week' }, NOW, quota).from / H) * H,
        resolveWindow({ account: id, kind: '5h' }, NOW, quota).from,
        resolveWindow({ account: id, kind: 'week' }, NOW, quota).from,
        NOW,
      ])
      for (const edge of edges)
        for (const offset of [-1, 0, 1])
          raw.run(`${i}-${edge}-${offset}`, edge + offset, id, i + 2, 7, 11, 13, 17)
    }
    // Preserve SQLite's single complete integer sum before converting it to a JavaScript number.
    hour.run(SPLIT - 200 * H, 'local', accounts[0]!, Number.MAX_SAFE_INTEGER, 0, 0, 0, 0)
  })()
}

function statementCount(ids: string[], q: NonNullable<UsageQueryOpts['quota']>) {
  let count = 0
  for (const kind of ['5h', 'week', 'all'] as const) {
    const groups = new Map<number, number>()
    for (const id of new Set(ids)) {
      const from = kind === 'all' ? 0 : resolveWindow({ account: id, kind }, NOW, q).from
      groups.set(from, (groups.get(from) ?? 0) + 1)
    }
    for (const n of groups.values()) count += Math.ceil(n / 4)
  }
  return count
}

const isWindowSQL = (sql: string) => sql.includes('from usage_hour h') && sql.includes('union all')

test('bounded account cohorts preserve exact mixed quota, raw/imported boundary sums and input order', async () => {
  const store = new KitStore(':memory:', { now: NOW })
  const split = spyOn(store, 'readSplit').mockReturnValue(SPLIT)
  try {
    const ids = [
      'acct-7',
      'acct-none',
      '',
      ...Array.from({ length: 16 }, (_, i) => `acct-${i}`),
      'acct-7',
    ]
    dense(store, [...new Set(ids)])
    const expected = legacy(ids, store, quota)
    const statements = spyOn(store.db, 'query')
    let done = false
    let turns = 0
    const turn = () => {
      if (done) return
      turns++
      setImmediate(turn)
    }
    let got: Map<string, AccountTokens>
    let sql: string[]
    try {
      const pending = accountTokenWindowsAsync(ids, { store, now: NOW, quota })
      setImmediate(turn)
      got = await pending
      sql = statements.mock.calls.map(([text]) => text).filter(isWindowSQL)
    } finally {
      done = true
      statements.mockRestore()
    }
    expect([...got!]).toEqual([...expected])
    expect([...got!.keys()]).toEqual([...new Set(ids)])
    expect(got!.get('acct-none')).toEqual({ fiveHour: zero(), week: zero(), total: zero() })
    expect(sql!).toHaveLength(statementCount(ids, quota))
    expect(sql!.length).toBeLessThan(new Set(ids).size * 3)
    for (const query of sql!) {
      const names = new Set(query.match(/\$a\d+/g))
      expect(names.size).toBeGreaterThan(0)
      expect(names.size).toBeLessThanOrEqual(4)
      expect(query.match(/account in \(/g)).toHaveLength(4)
      expect(query).toContain('group by account')
    }
    expect(turns).toBeGreaterThanOrEqual(sql!.length - 1)
  } finally {
    split.mockRestore()
    store.close()
  }
})

test('account cohorts keep cache clones, writes, changed account order and exact singleton windows fresh', () => {
  const store = new KitStore(':memory:', { now: NOW })
  const split = spyOn(store, 'readSplit').mockReturnValue(SPLIT)
  try {
    const ids = Array.from({ length: 13 }, (_, i) => `acct-${i}`)
    dense(store, ids)
    const rolling = () => null
    const opts = { store, now: NOW, quota: rolling }
    const expected = legacy(ids, store, rolling)
    const first = accountTokenWindows(ids, opts)
    expect([...first]).toEqual([...expected])
    first.get(ids[0]!)!.fiveHour.input = -123
    first.delete(ids[1]!)
    const queries = spyOn(store.db, 'query')
    try {
      expect([...accountTokenWindows(ids, opts)]).toEqual([...expected])
      expect(queries.mock.calls.filter(([sql]) => isWindowSQL(sql))).toHaveLength(0)
    } finally {
      queries.mockRestore()
    }
    store.upsertEvents([
      { id: 'example-new-call', ts: NOW, account: ids[0], source: 'cli', input: 101 },
    ])
    const changed = legacy(ids, store, rolling)
    expect([...accountTokenWindows(ids, opts)]).toEqual([...changed])
    expect(changed.get(ids[0]!)?.fiveHour.input).toBe(expected.get(ids[0]!)!.fiveHour.input + 101)
    ids.reverse()
    ids.push(ids[0]!)
    expect([...accountTokenWindows(ids, opts)]).toEqual([...legacy(ids, store, rolling)])
    expect([...accountTokenWindows([ids[0]!], { ...opts, quota })]).toEqual([
      ...legacy([ids[0]!], store, quota),
    ])
    expect(accountTokenWindows([], opts).size).toBe(0)
  } finally {
    split.mockRestore()
    store.close()
  }
})
