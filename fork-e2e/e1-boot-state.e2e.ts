// E1: two boots on one store. A fresh home boots, takes settings over HTTP, refuses a second daemon
// on the same store, dies on SIGHUP with a crash record, and the next boot finds every setting where
// it was left. Covers from outside what tests/settings.test.ts covers in process, and reads the
// store's schema the way a person debugging it would: sqlite_master, read-only.
import { Database } from 'bun:sqlite'
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { type Daemon, exitWithin, knownBug, REPO, scenario, start, tail } from './harness'

const lane = scenario('E1')
const home = lane.home()
const db = home.env.AGENTHYDRA_DB as string

/** Whether the store has the session_stats_gone index the schema's v1 step drops (server/src/db.ts:562). */
function hasGoneIndex(): boolean {
  const s = new Database(db, { readonly: true })
  try {
    return !!s
      .query("select 1 from sqlite_master where type = 'index' and name = 'session_stats_gone'")
      .get()
  } finally {
    s.close()
  }
}

let first: Daemon
const goneIndex: Record<string, boolean> = {}

test('E1: a fresh home boots from its own store, auto-update on by default until switched off', async () => {
  first = await lane.boot(home)
  const health = (await first.api('/api/health')).body
  expect(health.ok).toBe(true)
  expect(health.dbPath).toBe(db)
  // db.ts DEFAULT_SETTINGS seeds auto_update_enabled '1' on a store that never chose.
  expect(first.autoUpdateAtBoot).toBe(true)
  expect((await first.api('/api/update/settings')).body.enabled).toBe(false)
  goneIndex.firstBoot = hasGoneIndex()
}, 60_000)

test('E1: settings written over HTTP read back at once', async () => {
  const set = await first.api('/api/settings', {
    method: 'POST',
    body: JSON.stringify({ hideTrayIcon: true, transcriptEditor: 'fork-e2e-editor' }),
  })
  expect(set.status).toBe(200)
  expect(set.body.hideTrayIcon).toBe(true)
  const got = (await first.api('/api/settings')).body
  expect(got.hideTrayIcon).toBe(true)
  expect(got.transcriptEditor).toBe('fork-e2e-editor')
})

test('E1: a second daemon on the same store says so, exits 0 and leaves the first one serving', async () => {
  const pid = (await first.api('/api/health')).body.pid
  const log = join(home.dir, 'logs', 'second-daemon.log')
  const second = start([process.execPath, 'server/src/main.ts'], {
    cwd: REPO,
    env: { ...home.env, PORT: String(first.port) },
    log,
  })
  const code = await exitWithin(second, 30_000)
  if (code === null) second.kill('SIGKILL')
  expect({ code, log: tail(log, 8) }).toMatchObject({
    code: 0,
    log: expect.stringContaining('already running'),
  })
  const health = await first.api('/api/health')
  expect(health.status).toBe(200)
  expect(health.body.pid).toBe(pid)
  goneIndex.secondStart = hasGoneIndex()
}, 45_000)

test('E1: SIGHUP ends the daemon at once, with a crash record naming the signal', async () => {
  // index.ts registers SIGHUP as fatal on purpose: nothing asked for a tidy stop.
  first.proc.kill('SIGHUP')
  expect(await exitWithin(first.proc, 15_000)).toBe(1)
  expect(tail(first.log, 20)).toContain('CRASH reason=signal:SIGHUP')
}, 30_000)

test('E1: the next boot on the same store keeps every setting, auto-update off included', async () => {
  const again = await lane.boot(home, { port: first.port })
  expect(again.autoUpdateAtBoot).toBe(false)
  const got = (await again.api('/api/settings')).body
  expect(got.hideTrayIcon).toBe(true)
  expect(got.transcriptEditor).toBe('fork-e2e-editor')
  expect(await again.stop('SIGTERM')).toBe(0)
  goneIndex.reboot = hasGoneIndex()
}, 60_000)

knownBug(
  {
    issue:
      'db.ts recreates the session_stats_gone index on every boot after the v1 migration drops it',
    where:
      'server/src/db.ts:424 creates it unconditionally; db.ts:562 drops it only while user_version < 1',
    fix: 'https://github.com/LunarWerxs/AgentHydra/pull/16',
  },
  'E1: no start after the first brings back the index the schema v1 step dropped',
  () => {
    expect(goneIndex).toEqual({ firstBoot: false, secondStart: false, reboot: false })
  },
)

lane.realHomeUntouched()
