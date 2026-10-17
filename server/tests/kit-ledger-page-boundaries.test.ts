import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { type UsageQueryParams, usageQuery, usageQueryAsync } from '../src/kit/query'
import { KitStore, type UsageEventInput } from '../src/kit/store'

const HOUR = 3_600_000
const NOW = Date.UTC(2026, 9, 16, 12)
const params: UsageQueryParams = {
  window: { from: 0, to: NOW },
  groupBy: ['session'],
  measures: ['calls', 'input', 'list_usd'],
}

function storeOf(rows: UsageEventInput[]): KitStore {
  const store = new KitStore(':memory:', { now: NOW })
  store.upsertEvents(rows)
  store.runMaintenance(NOW)
  return store
}

function removeOwnedHome(home: string): void {
  const target = resolve(home)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('ah-kit-ledger-pages-'))
    throw new Error('Refusing to remove a folder outside the owned ledger fixture')
  rmSync(target, { recursive: true, force: true })
}

test('paged session totals include empty normalized keys at the start of the ledger', async () => {
  const rows: UsageEventInput[] = Array.from({ length: 4305 }, (_, i) => ({
    id: `example-${i}`,
    ts: NOW - 2 * HOUR,
    source: 'cli',
    session: `session-${String(i).padStart(5, '0')}`,
    ref: 'example-ref',
    input: 1,
    list_usd: 0.25,
  }))
  rows.push(
    {
      id: 'unattributed-a',
      ts: NOW - 2 * HOUR,
      source: 'cli',
      account: 'a',
      input: 7,
      list_usd: 0.5,
    },
    {
      id: 'unattributed-b',
      ts: NOW - 2 * HOUR,
      source: 'cli',
      account: 'b',
      input: 11,
      list_usd: 1,
    },
    {
      id: 'ref-only',
      ts: NOW - 2 * HOUR,
      source: 'cli',
      ref: 'example-ref',
      input: 13,
      list_usd: 2,
    },
  )
  const syncStore = storeOf(rows)
  const asyncStore = storeOf(rows)
  try {
    const expected = usageQuery(params, { store: syncStore, now: NOW })
    // A separate connection prevents the synchronous result cache from answering the async path.
    const actual = await usageQueryAsync(params, { store: asyncStore, now: NOW })
    expect(actual).toEqual(expected)
    expect(actual.totals).toEqual({ calls: 4308, input: 4336, list_usd: 1079.75 })
    expect(actual.rows.find((row) => row.session === null)).toEqual({
      session: null,
      calls: 3,
      input: 31,
      list_usd: 3.5,
    })
  } finally {
    syncStore.close()
    asyncStore.close()
  }
})

test('paging keeps whole boundary pairs once and includes keys beyond the old Unicode sentinel', async () => {
  const rows: UsageEventInput[] = Array.from({ length: 4500 }, (_, i) => ({
    id: `boundary-${i}`,
    ts: NOW - 2 * HOUR,
    source: 'cli',
    session: 'boundary-session',
    ref: 'shared-ref',
    account: `example-account-${i}`,
    input: (i % 3) + 1,
    list_usd: 0.25,
  }))
  rows.push(
    { id: 'unattributed', ts: NOW - 2 * HOUR, source: 'cli', input: 7, list_usd: 0.5 },
    {
      id: 'last-bmp',
      ts: NOW - 2 * HOUR,
      source: 'cli',
      session: '\uffff-late',
      input: 11,
      list_usd: 1,
    },
    {
      id: 'last-unicode',
      ts: NOW - 2 * HOUR,
      source: 'cli',
      session: '🙂-late',
      input: 13,
      list_usd: 2,
    },
  )
  const syncStore = storeOf(rows)
  const asyncStore = storeOf(rows)
  try {
    const expected = usageQuery(params, { store: syncStore, now: NOW })
    const actual = await usageQueryAsync(params, { store: asyncStore, now: NOW })
    expect(actual).toEqual(expected)
    expect(actual.totals).toEqual({ calls: 4503, input: 9031, list_usd: 1128.5 })
    expect(actual.rows).toHaveLength(4)
    expect(actual.rows.find((row) => row.session === 'boundary-session')).toEqual({
      session: 'boundary-session',
      calls: 4500,
      input: 9000,
      list_usd: 1125,
    })
    expect(actual.rows.find((row) => row.session === '🙂-late')).toEqual({
      session: '🙂-late',
      calls: 1,
      input: 13,
      list_usd: 2,
    })
  } finally {
    syncStore.close()
    asyncStore.close()
  }
})

test('the no-span-index fallback advances past a large pair and retains exact cut-window usage', async () => {
  // The old inclusive edge seek repeats forever inside a pair with over 4000 rows.
  // Keep this regression in a bounded owned process so a recurrence cannot hang the suite.
  const home = mkdtempSync(join(tmpdir(), 'ah-kit-ledger-pages-'))
  mkdirSync(join(home, 'data'))
  const source = (name: string) =>
    JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/kit', name)).href)
  try {
    const program = `
      import { isDeepStrictEqual } from 'node:util'
      const { KitStore } = await import(${source('store.ts')})
      const { usageQuery, usageQueryAsync } = await import(${source('query.ts')})
      const HOUR = ${HOUR}, NOW = ${NOW}
      const rows = Array.from({ length: 4500 }, (_, i) => ({
        id: 'boundary-' + i, ts: NOW - 2 * HOUR, source: 'cli',
        session: 'boundary-session', ref: 'shared-ref', account: 'example-account-' + i,
        input: i % 3 + 1, list_usd: 0.25,
      }))
      const add = (id, session, account, hours, input) => rows.push({
        id, session, account, source: 'cli', ts: NOW - hours * HOUR, input, list_usd: 0.5,
      })
      add('empty-before', null, 'cut-empty', 4, 7)
      add('empty-inside', null, 'cut-empty', 2, 11)
      add('after-inside', 'after-session', null, 2, 13)
      add('after-outside', 'after-session', null, 0.5, 17)
      add('both-before', 'cross-session', null, 4, 19)
      add('both-inside', 'cross-session', null, 2, 23)
      add('both-after', 'cross-session', null, 0.5, 29)
      add('unicode', '🙂-late', null, 2, 31)
      add('empty-whole', null, 'whole-empty', 2, 37)
      add('before-whole', 'aa-session', null, 2, 41)
      const make = () => {
        const store = new KitStore(':memory:', { now: NOW })
        store.upsertEvents(rows)
        store.runMaintenance(NOW)
        store.db.exec('drop index if exists usage_session_span')
        return store
      }
      const a = make(), b = make()
      try {
        const oldSeek = a.db.query('select session, ref from usage_session where (session, ref) >= (?, ?) order by session, ref limit 1 offset ?')
        const first = oldSeek.get('', '', 3999)
        const repeated = first ? oldSeek.get(first.session, first.ref, 4000) : null
        if (!first || !repeated || first.session !== repeated.session || first.ref !== repeated.ref)
          throw new Error('Fixture did not reach the old non-advancing page boundary')
        const params = { window: { from: NOW - 3 * HOUR, to: NOW - HOUR },
          groupBy: ['session'], measures: ['calls', 'input', 'list_usd'] }
        const expected = usageQuery(params, { store: a, now: NOW })
        const actual = await usageQueryAsync(params, { store: b, now: NOW })
        if (!isDeepStrictEqual(actual, expected)) throw new Error('Fallback changed cut-window results')
        if (b.db.query("select 1 from sqlite_master where name = 'usage_session_span'").get())
          throw new Error('Fixture unexpectedly used the span index')
        console.log(JSON.stringify({ exact: true, totals: actual.totals, rows: actual.rows.length,
          empty: actual.rows.find(row => row.session === null),
          boundary: actual.rows.find(row => row.session === 'boundary-session') }))
      } finally { a.close(); b.close() }
    `
    const fixture = Bun.spawn([process.execPath, '-e', program], {
      cwd: resolve(import.meta.dir, '..'),
      env: {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'roaming'),
        LOCALAPPDATA: join(home, 'local'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        CODEX_HOME: join(home, '.codex'),
        HSWARM_HOME: join(home, '.hswarm'),
        CCMANAGERUI_HOME: join(home, 'data'),
        AGENTHYDRA_HOME: home,
        AGENTHYDRA_DATA_DIR: join(home, 'data'),
        AGENTHYDRA_DB: join(home, 'data', 'test.db'),
        AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 15_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(fixture.stdout).text(),
      new Response(fixture.stderr).text(),
      fixture.exited,
    ])
    if (code !== 0) throw new Error(`Owned ledger fallback fixture failed: ${err || out}`)
    const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
      exact: boolean
      totals: { calls: number; input: number; list_usd: number }
      rows: number
      empty: { session: null; calls: number; input: number; list_usd: number }
      boundary: { session: string; calls: number; input: number; list_usd: number }
    }
    expect(result.exact).toBe(true)
    expect(result.totals).toEqual({ calls: 4506, input: 9156, list_usd: 1128 })
    expect(result.rows).toBe(6)
    expect(result.empty).toEqual({ session: null, calls: 2, input: 48, list_usd: 1 })
    expect(result.boundary).toEqual({
      session: 'boundary-session',
      calls: 4500,
      input: 9000,
      list_usd: 1125,
    })
  } finally {
    removeOwnedHome(home)
  }
}, 20_000)
