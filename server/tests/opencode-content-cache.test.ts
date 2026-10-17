import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PREFIX = 'ah-opencode-content-'
const source = JSON.stringify(
  pathToFileURL(resolve(import.meta.dir, '../src/opencode-sessions.ts')).href,
)

function removeOwnedHome(home: string): void {
  const target = resolve(home)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(PREFIX))
    throw new Error('Refusing to remove a folder outside the owned content fixture')
  rmSync(target, { recursive: true, force: true })
}

async function child<T>(body: string): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), PREFIX))
  try {
    const program = `
      import { Database } from 'bun:sqlite'
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import { join } from 'node:path'
      const home = ${JSON.stringify(home)}
      const { readOpenCodeSession: read } = await import(${source})
      const assert = (value, message) => { if (!value) throw new Error(message) }
      const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message)
      function fixture(name, mode = 'delete') {
        const path = join(home, name + '.db')
        const db = new Database(path)
        db.exec('pragma journal_mode=' + mode)
        db.exec('begin; create table message (id text, session_id text, time_created integer, data text);' +
          'create table part (id text, message_id text, session_id text, time_created integer, data text); commit')
        return { path, db }
      }
      function message(db, sid, id, role = 'assistant', at = 1000) {
        db.run('insert into message values (?, ?, ?, ?)', [id, sid, at, JSON.stringify({ role })])
      }
      function part(db, sid, mid, id, value, at = 1000) {
        db.run('insert into part values (?, ?, ?, ?, ?)', [id, mid, sid, at, JSON.stringify(value)])
      }
      function text(db, sid, value) {
        message(db, sid, sid)
        part(db, sid, sid, sid, { type: 'text', text: value })
      }
      function update(db, sid, value) {
        db.run('update part set data=? where session_id=?', [JSON.stringify({ type: 'text', text: value }), sid])
      }
      const originalQuery = Database.prototype.query
      let queries = 0, afterParts = null
      spyOn(Database.prototype, 'query').mockImplementation(function(sql, ...args) {
        const contentQuery = sql.startsWith('select id, data, time_created from message') ||
            sql.startsWith('select message_id, data, time_created from part')
        if (contentQuery) queries++
        const statement = originalQuery.call(this, sql, ...args)
        if (contentQuery) {
          if (sql.startsWith('select message_id')) {
            const all = statement.all.bind(statement)
            statement.all = (...params) => {
              const rows = all(...params)
              const action = afterParts
              afterParts = null
              if (action) action()
              return rows
            }
          }
        }
        return statement
      })
      const queryCount = action => { const before = queries; action(); return queries - before }
      const settled = () => Bun.sleep(1150)
      ${body}
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
        AGENTHYDRA_RUN_LOG_DIR: join(home, 'run-logs'),
        AGENTHYDRA_CLAUDE_PROJECTS_ROOT: join(home, '.claude', 'projects'),
        AGENTHYDRA_INSTANCES_ROOT: join(home, '.claude-instances'),
      },
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 25_000,
      windowsHide: true,
    })
    const [exit, stdout, stderr] = await Promise.all([
      fixture.exited,
      new Response(fixture.stdout).text(),
      new Response(fixture.stderr).text(),
    ])
    expect(stderr).toBe('')
    expect(exit).toBe(0)
    return JSON.parse(stdout) as T
  } finally {
    removeOwnedHome(home)
  }
}

test('settled OpenCode content reuses bounded owned DTO bytes with exact order and caller isolation', async () => {
  const result = await child<{ cold: number; warm: number; alias: number; missing: number }>(`
    const { path, db } = fixture('content')
    db.exec('begin')
    message(db, 's', 'b', 'assistant', 1000)
    message(db, 's', 'a', 'user', 1000)
    message(db, 's', 'c', 'ignored', 1001)
    part(db, 's', 'b', 'b2', { type: 'text', text: ' Second  reply ' }, 1001)
    part(db, 's', 'a', 'a', { type: 'text', text: ' hello\\nworld \\ud83d\\ude42 \\ud800' }, 1000)
    part(db, 's', 'b', 'b1', { type: 'tool', tool: 'example', state: {
      input: { a: 1 }, output: ' tool\\nresult ', time: { completed: 2000 } } }, 1000)
    part(db, 's', 'b', 'hidden', { type: 'reasoning', text: 'private synthetic reasoning' }, 1000)
    part(db, 's', 'c', 'ignored', { type: 'text', text: 'not shown' })
    db.run('insert into part values (?, ?, ?, ?, ?)', ['bad', 'b', 's', 1000, '{bad'])
    text(db, 'other', 'different session')
    db.exec('commit')
    db.close()
    await settled()
    let first
    const cold = queryCount(() => { first = read('s', path) })
    equal(first, { events: [
      { role: 'user', kind: 'text', text: 'hello world 🙂 \\ud800', tool_name: null,
        timestamp: '1970-01-01T00:00:01.000Z' },
      { role: 'assistant', kind: 'tool_use', text: '{"a":1}', tool_name: 'example',
        timestamp: '1970-01-01T00:00:01.000Z' },
      { role: 'user', kind: 'tool_result', text: 'tool result', tool_name: 'example',
        timestamp: '1970-01-01T00:00:02.000Z' },
      { role: 'assistant', kind: 'text', text: 'Second reply', tool_name: null,
        timestamp: '1970-01-01T00:00:01.001Z' },
    ], messageCount: 2 }, 'Converted output/order changed')
    const expected = JSON.stringify(first)
    first.events[0].text = 'caller mutation'
    first.events.push({ kind: 'text', text: 'extra' })
    let second
    const warm = queryCount(() => { second = read('s', path) })
    assert(JSON.stringify(second) === expected, 'First caller mutated cache')
    second.events[1].tool_name = 'another mutation'
    assert(JSON.stringify(read('s', path)) === expected, 'Hit caller mutated cache')
    process.chdir(home)
    const alias = queryCount(() => read('s', './content.db'))
    assert(read('other', path).events[0].text === 'different session', 'Session identities merged')
    const secondStore = fixture('second')
    text(secondStore.db, 's', 'different database')
    secondStore.db.close()
    assert(read('s', secondStore.path).events[0].text === 'different database', 'Database identities merged')
    const missing = queryCount(() => { equal(read('empty', path), { events: [], messageCount: 0 }, 'Empty changed') })
    assert(queryCount(() => read('empty', path)) === 0, 'Empty content not cached')
    assert(read('s', join(home, 'absent.db')) === null, 'Missing database changed')
    const renamed = join(home, 'renamed.db')
    fs.renameSync(path, renamed)
    assert(read('s', path) === null, 'Cache retained an open file handle or served a missing database')
    console.log(JSON.stringify({ cold, warm, alias, missing }))
  `)
  expect(result).toEqual({ cold: 2, warm: 0, alias: 0, missing: 1 })
}, 30_000)

test('content freshness observes kept-open commits, restored mtime, WAL reuse and checkpoint removal', async () => {
  const result = await child<{ modes: string[]; updates: number; checkpoint: boolean }>(`
    let updates = 0
    for (const mode of ['delete', 'wal']) {
      const { path, db } = fixture(mode, mode)
      text(db, 's', 'value-0000')
      await settled()
      assert(read('s', path).events[0].text === 'value-0000', 'Initial content missing')
      assert(queryCount(() => read('s', path)) === 0, 'Settled open-writer result not cached')
      const original = fs.statSync(mode === 'wal' ? path + '-wal' : path)
      for (let i = 1; i <= 40; i++) {
        const value = 'value-' + String(i).padStart(4, '0')
        update(db, 's', value)
        assert(read('s', path).events[0].text === value, 'Kept-open update served stale content')
        updates++
      }
      const stamped = mode === 'wal' ? path + '-wal' : path
      update(db, 's', 'value-0041')
      assert(fs.statSync(stamped).size === original.size || mode === 'wal', 'DELETE update grew fixture')
      fs.utimesSync(stamped, original.atime, original.mtime)
      assert(read('s', path).events[0].text === 'value-0041', 'Restored mtime hid changed bytes')
      if (mode === 'wal') {
        db.exec('pragma wal_checkpoint(restart)')
        await settled()
        assert(read('s', path).events[0].text === 'value-0041', 'Checkpoint changed content')
        assert(queryCount(() => read('s', path)) === 0, 'Settled restarted WAL not cached')
        const walSize = fs.statSync(path + '-wal').size
        update(db, 's', 'value-0042')
        assert(fs.statSync(path + '-wal').size === walSize, 'Fixture failed to reuse WAL allocation')
        assert(read('s', path).events[0].text === 'value-0042', 'Reused WAL served stale content')
      }
      db.close()
      assert(!fs.existsSync(path + '-wal'), 'Writer close failed to remove WAL')
      assert(read('s', path).events[0].text === (mode === 'wal' ? 'value-0042' : 'value-0041'),
        'WAL removal/checkpoint served stale content')
    }
    console.log(JSON.stringify({ modes: ['delete', 'wal'], updates, checkpoint: true }))
  `)
  expect(result).toEqual({ modes: ['delete', 'wal'], updates: 80, checkpoint: true })
}, 30_000)

test('content does not cache racy, future-stamped, failed or replaced database reads', async () => {
  const result = await child<{
    race: number
    future: number
    error: number
    replacement: boolean
  }>(`
    const { path, db } = fixture('racy')
    text(db, 's', 'old')
    await settled()
    afterParts = () => update(db, 's', 'new')
    assert(read('s', path).events[0].text === 'old', 'Read raced before its returned snapshot')
    const race = queryCount(() => assert(read('s', path).events[0].text === 'new', 'Post-read change was cached'))
    const futureDate = new Date(Date.now() + 60_000)
    fs.utimesSync(path, futureDate, futureDate)
    read('s', path)
    const future = queryCount(() => read('s', path))
    db.close()
    const broken = fixture('broken')
    text(broken.db, 's', 'before error')
    broken.db.exec('drop table part')
    await settled()
    assert(read('s', broken.path) === null, 'Schema failure changed')
    const error = queryCount(() => assert(read('s', broken.path) === null, 'Error was cached as content'))
    broken.db.exec('create table part (id text, message_id text, session_id text, time_created integer, data text)')
    part(broken.db, 's', 's', 's', { type: 'text', text: 'repaired' })
    broken.db.close()
    assert(read('s', broken.path).events[0].text === 'repaired', 'Failure cache hid repaired schema')
    const replacement = fixture('replacement')
    text(replacement.db, 's', 'before')
    replacement.db.close()
    await settled()
    read('s', replacement.path)
    assert(queryCount(() => read('s', replacement.path)) === 0, 'Replacement premise not cached')
    const old = fs.statSync(replacement.path)
    const next = fixture('replacement-next')
    text(next.db, 's', 'after!')
    next.db.close()
    assert(fs.statSync(next.path).size === old.size, 'Replacement size premise changed')
    fs.rmSync(replacement.path)
    fs.renameSync(next.path, replacement.path)
    fs.utimesSync(replacement.path, old.atime, old.mtime)
    assert(read('s', replacement.path).events[0].text === 'after!', 'Physical replacement served old content')
    console.log(JSON.stringify({ race, future, error, replacement: true }))
  `)
  expect(result).toEqual({ race: 2, future: 2, error: 2, replacement: true })
}, 30_000)

test('content LRU and owned byte budget stay bounded and oversized answers still render', async () => {
  const result = await child<{
    truncated: number
    cacheBytes: number
    oversizeQueries: number
    evicted: number
    byteEvicted: number
  }>(`
    const { path, db } = fixture('bounded')
    db.exec('begin')
    text(db, 'small', 'x'.repeat(8 * 1024 * 1024))
    message(db, 'huge', 'huge')
    part(db, 'huge', 'huge', 'huge', { type: 'tool', tool: 'x'.repeat(5 * 1024 * 1024), state: {} })
    for (let i = 0; i < 70; i++) text(db, 'session-' + i, 'bounded result')
    for (let i = 0; i < 9; i++) {
      const sid = 'bytes-' + i
      message(db, sid, sid)
      part(db, sid, sid, sid, { type: 'tool', tool: 'x'.repeat(500_000), state: {} })
    }
    db.exec('commit')
    db.close()
    await settled()
    const alloc = Buffer.allocUnsafeSlow
    let cacheBytes = 0
    spyOn(Buffer, 'allocUnsafeSlow').mockImplementation(size => { cacheBytes += size; return alloc(size) })
    const first = read('small', path)
    assert(first.events[0].text.length === 6001, 'Visible text truncation changed')
    assert(cacheBytes < 16_000, 'Cache retained raw truncated payload instead of owned DTO bytes')
    assert(queryCount(() => read('small', path)) === 0, 'Truncated visible result not cached')
    assert(read('huge', path).events[0].tool_name.length === 5 * 1024 * 1024, 'Oversized result changed')
    const oversizeQueries = queryCount(() => read('huge', path))
    assert(cacheBytes < 16_000, 'Oversized result allocated cache bytes')
    for (let i = 0; i < 70; i++) read('session-' + i, path)
    assert(queryCount(() => read('session-69', path)) === 0, 'Newest entry evicted')
    const evicted = queryCount(() => read('small', path))
    const smallAllocations = cacheBytes
    for (let i = 0; i < 9; i++) read('bytes-' + i, path)
    assert(queryCount(() => read('bytes-8', path)) === 0, 'Newest byte-bound entry evicted')
    const byteEvicted = queryCount(() => read('bytes-0', path))
    assert(cacheBytes > 4 * 1024 * 1024, 'Byte-budget fixture did not exceed the aggregate cap')
    console.log(JSON.stringify({ truncated: first.events[0].text.length,
      cacheBytes: smallAllocations, oversizeQueries, evicted, byteEvicted }))
  `)
  expect(result.truncated).toBe(6001)
  expect(result.cacheBytes).toBeLessThan(64_000)
  expect(result.oversizeQueries).toBe(2)
  expect(result.evicted).toBe(2)
  expect(result.byteEvicted).toBe(2)
}, 30_000)

test('optional content allocation, serialization and decode faults preserve fresh SQLite answers', async () => {
  const result = await child<{
    allocation: number
    decode: number
    parse: number
    serialization: number
  }>(`
    const { path, db } = fixture('optional-faults')
    text(db, 's', 'valid SQLite answer')
    text(db, 'other', 'another valid answer')
    db.close()
    await settled()
    const alloc = Buffer.allocUnsafeSlow
    let failAllocation = true, cachedBytes = null
    spyOn(Buffer, 'allocUnsafeSlow').mockImplementation(size => {
      if (failAllocation) { failAllocation = false; throw new Error('Synthetic allocation failure') }
      cachedBytes = alloc(size)
      return cachedBytes
    })
    assert(read('s', path).events[0].text === 'valid SQLite answer', 'Allocation hid a valid answer')
    const allocation = queryCount(() => read('s', path))
    const toString = Buffer.prototype.toString
    let failDecode = true
    spyOn(Buffer.prototype, 'toString').mockImplementation(function(...args) {
      if (failDecode && this === cachedBytes) {
        failDecode = false
        throw new Error('Synthetic decode failure')
      }
      return toString.apply(this, args)
    })
    const decode = queryCount(() =>
      assert(read('s', path).events[0].text === 'valid SQLite answer', 'Decode hid a valid answer'))
    const parseJson = JSON.parse
    let failParse = true
    spyOn(JSON, 'parse').mockImplementation(value => {
      if (failParse && typeof value === 'string' && value.startsWith('{"events":')) {
        failParse = false
        throw new Error('Synthetic cached JSON failure')
      }
      return parseJson(value)
    })
    const parse = queryCount(() =>
      assert(read('s', path).events[0].text === 'valid SQLite answer', 'Cached JSON hid a valid answer'))
    const stringify = JSON.stringify
    let failSerialize = true
    spyOn(JSON, 'stringify').mockImplementation((value, ...args) => {
      if (failSerialize && value && Array.isArray(value.events)) {
        failSerialize = false
        throw new Error('Synthetic serialization failure')
      }
      return stringify(value, ...args)
    })
    assert(read('other', path).events[0].text === 'another valid answer', 'Serialization hid valid content')
    const serialization = queryCount(() => read('other', path))
    assert(queryCount(() => read('other', path)) === 0, 'Recovered optional cache did not work')
    console.log(JSON.stringify({ allocation, decode, parse, serialization }))
  `)
  expect(result).toEqual({ allocation: 2, decode: 2, parse: 2, serialization: 2 })
}, 30_000)
