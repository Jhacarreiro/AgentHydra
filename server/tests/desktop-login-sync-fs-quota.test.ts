import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const PREFIX = 'ah-desktop-login-fs-quota-'
const source = (name: string) =>
  JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src/core', name)).href)

function removeOwnedHome(home: string): void {
  const target = resolve(home)
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith(PREFIX))
    throw new Error('Refusing to remove a folder outside the owned fixture')
  rmSync(target, { recursive: true, force: true })
}

async function child<T>(body: string): Promise<T> {
  const home = mkdtempSync(join(tmpdir(), PREFIX))
  mkdirSync(join(home, 'data'))
  mkdirSync(join(home, 'copies'))
  try {
    const program = `
      import { Database } from 'bun:sqlite'
      import { spyOn } from 'bun:test'
      import * as fs from 'node:fs'
      import * as fsp from 'node:fs/promises'
      import { tmpdir } from 'node:os'
      import { join, resolve } from 'node:path'
      const home = ${JSON.stringify(home)}
      const desktop = await import(${source('desktop-login-sync.ts')})
      const { fsSlot } = await import(${source('fs-slots.ts')})
      const { instancesRoot, normalizePath } = await import(${source('paths.ts')})
      const assert = (value, message) => { if (!value) throw new Error(message) }
      assert(resolve(tmpdir()) === resolve(join(home, 'copies')), 'Temporary copies escaped the fixture')
      const uuid = i => '00000000-0000-4000-8000-' + String(i + 1).padStart(12, '0')
      const cookiePath = dir => join(dir, 'Network', 'Cookies')
      function profile(name, kind, index = 0) {
        const dir = join(instancesRoot(), name)
        fs.mkdirSync(join(dir, 'Network'), { recursive: true })
        const cfg = { lastKnownAccountUuid: kind === 'bad-uuid' ? 'not-an-account' : uuid(index) }
        if (kind !== 'signed-out') cfg['oauth:tokenCacheV2'] = 'synthetic-cache-not-decrypted'
        fs.writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg))
        if (kind !== 'missing' && kind !== 'signed-out' && kind !== 'bad-uuid') {
          const db = new Database(cookiePath(dir), { create: true })
          try {
            if (kind === 'schema-error') db.run('create table unrelated(value text)')
            else {
              db.run('create table cookies(host_key text, name text)')
              db.run('insert into cookies values (?, ?)',
                kind === 'session' ? ['.claude.ai', 'sessionKey-example'] : ['.example.test', 'sessionKey-example'])
            }
          } finally { db.close() }
        }
        return dir
      }
      let active = 0, peak = 0
      const counts = { stat: 0, copyFile: 0, rm: 0 }
      const faults = { stat: null, copyFile: null, copyAfter: null, rmAfter: null }
      const copySources = new Map()
      const copied = [], removed = []
      const original = { stat: fsp.stat, copyFile: fsp.copyFile, rm: fsp.rm }
      const same = (a, b) => a !== null && normalizePath(String(a)) === normalizePath(String(b))
      for (const kind of ['stat', 'copyFile', 'rm'])
        spyOn(fsp, kind).mockImplementation(async (path, ...args) => {
          counts[kind]++; active++; peak = Math.max(peak, active)
          try {
            await Bun.sleep(1)
            if (kind === 'stat' && same(faults.stat, path)) throw new Error('Synthetic stat failure')
            if (kind === 'copyFile') {
              copySources.set(String(args[0]), String(path))
              if (same(faults.copyFile, path)) throw new Error('Synthetic copy failure')
            }
            const value = await original[kind](path, ...args)
            if (kind === 'copyFile') {
              copied.push(String(args[0]))
              if (same(faults.copyAfter, path)) throw new Error('Synthetic partial-copy failure')
            }
            if (kind === 'rm') {
              removed.push(String(path))
              // Preserve the existing rejected-cleanup contract while keeping the owned fixture clean.
              if (same(faults.rmAfter, copySources.get(String(path))))
                throw new Error('Synthetic cleanup acknowledgement failure')
            }
            return value
          } finally { active-- }
        })
      async function occupy() {
        const gate = Promise.withResolvers()
        let entered = 0
        const holds = Array.from({ length: 8 }, () => fsSlot(async () => { entered++; await gate.promise }))
        while (entered !== 8) await Bun.sleep(0)
        return { release: () => gate.resolve(), holds }
      }
      const noCopies = () => fs.readdirSync(tmpdir()).length === 0
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
        TEMP: join(home, 'copies'),
        TMP: join(home, 'copies'),
        TMPDIR: join(home, 'copies'),
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
      windowsHide: true,
      timeout: 25_000,
    })
    const [out, err, code] = await Promise.all([
      new Response(fixture.stdout).text(),
      new Response(fixture.stderr).text(),
      fixture.exited,
    ])
    if (code !== 0) throw new Error(`Owned desktop-login fixture failed: ${err || out}`)
    return JSON.parse(out.trim().split('\n').at(-1)!) as T
  } finally {
    removeOwnedHome(home)
  }
}

test('overlapping desktop lists share the eight slots and retain exact cookie-presence states', async () => {
  const result = await child<{
    before: number
    peak: number
    active: number
    rows: number
    copies: number
    removals: number
    empty: boolean
    counts: { stat: number; copyFile: number; rm: number }
  }>(`
    const expected = new Map()
    const kinds = ['session', 'no-session', 'missing', 'schema-error']
    for (let i = 0; i < 32; i++) {
      const kind = kinds[i % kinds.length]
      const name = 'profile-' + String(i).padStart(2, '0')
      profile(name, kind, i)
      expected.set(name, { uuid: uuid(i), hasSessionKey: kind === 'session' ? true : kind === 'schema-error' ? null : false })
    }
    for (const [name, kind] of [['signed-out', 'signed-out'], ['bad-uuid', 'bad-uuid']]) {
      profile(name, kind, 100)
      expected.set(name, { uuid: null, hasSessionKey: null })
    }
    const order = fs.readdirSync(instancesRoot(), { withFileTypes: true })
      .filter(entry => entry.isDirectory()).map(entry => entry.name)
    const occupied = await occupy()
    const pending = Promise.all([desktop.listDesktopProfiles(), desktop.listDesktopProfiles()])
    await Bun.sleep(10)
    const before = Object.values(counts).reduce((sum, count) => sum + count, 0)
    occupied.release()
    const lists = await pending
    await Promise.all(occupied.holds)
    assert(lists.every(rows => rows.length === expected.size), 'Desktop profiles disappeared')
    for (const rows of lists) {
      assert(JSON.stringify(rows.map(row => row.name)) === JSON.stringify(order), 'Directory order changed')
      for (const row of rows) {
        const wanted = expected.get(row.name)
        assert(row.uuid === wanted.uuid && row.hasSessionKey === wanted.hasSessionKey, 'Cookie-presence state changed')
        assert(Number.isInteger(row.num) && row.num > 0, 'Stable profile number missing')
      }
    }
    assert(JSON.stringify(lists[0]) === JSON.stringify(lists[1]), 'Overlapping reads returned different identities')
    assert(copied.every(path => removed.includes(path)), 'A successful copy was not removed')
    console.log(JSON.stringify({ before, peak, active, rows: lists[0].length,
      copies: copied.length, removals: removed.length, empty: noCopies(), counts }))
  `)
  expect(result.before).toBe(0)
  expect(result.peak).toBe(8)
  expect(result.active).toBe(0)
  expect(result.rows).toBe(34)
  expect(result.copies).toBe(48)
  expect(result.removals).toBe(48)
  expect(result.empty).toBe(true)
  expect(result.counts).toEqual({ stat: 64, copyFile: 48, rm: 48 })
}, 30_000)

test('desktop cookie-copy faults preserve false, null and rejected-cleanup results without leaking quota', async () => {
  const result = await child<{
    cases: number
    removed: number
    rejectedCleanup: boolean
    empty: boolean
    active: number
    peak: number
    recovered: number
  }>(`
    const good = profile('good', 'session')
    const broken = profile('broken', 'schema-error', 1)
    const missing = profile('missing', 'missing', 2)
    assert(await desktop.hasSessionKey(good) === true, 'Synthetic signed-in cookie was not found')
    assert(await desktop.hasSessionKey(missing) === false, 'Missing cookie database changed from false')
    let cases = 0
    for (const [kind, dir, expected, shouldRemove] of [
      ['stat', good, false, false],
      ['copyFile', good, null, true],
      ['copyAfter', good, null, true],
      ['sqlite', broken, null, true],
    ]) {
      const before = removed.length
      if (kind !== 'sqlite') faults[kind] = cookiePath(dir)
      assert(await desktop.hasSessionKey(dir) === expected, 'Failure changed the cookie-presence result')
      assert(removed.length - before === (shouldRemove ? 1 : 0), 'Incorrect temporary-copy cleanup')
      assert(noCopies() && active === 0, 'Failure left a temporary copy or occupied native call')
      if (kind !== 'sqlite') faults[kind] = null
      assert(await desktop.hasSessionKey(good) === true, 'Fault leaked quota or cached failure')
      cases++
    }
    faults.rmAfter = cookiePath(good)
    const before = removed.length
    let rejectedCleanup = false
    try { await desktop.hasSessionKey(good) } catch { rejectedCleanup = true }
    assert(rejectedCleanup, 'A rejected cleanup was silently changed to a presence result')
    assert(removed.length === before + 1 && noCopies(), 'Cleanup was not awaited')
    faults.rmAfter = null
    assert(await desktop.hasSessionKey(good) === true, 'Cleanup error leaked quota')
    cases++
    const occupied = await occupy()
    let recovered = 0
    const later = Array.from({ length: 24 }, () => fsSlot(async () => { recovered++ }))
    await Bun.sleep(5)
    assert(recovered === 0, 'External quota was not fully occupied')
    occupied.release()
    await Promise.all([...occupied.holds, ...later])
    console.log(JSON.stringify({ cases, removed: removed.length, rejectedCleanup,
      empty: noCopies(), active, peak, recovered }))
  `)
  expect(result.cases).toBe(5)
  expect(result.removed).toBe(10)
  expect(result.rejectedCleanup).toBe(true)
  expect(result.empty).toBe(true)
  expect(result.active).toBe(0)
  expect(result.peak).toBeLessThanOrEqual(8)
  expect(result.recovered).toBe(24)
}, 30_000)
