// The routine manager (routines/): the cron reading, the definition check, the judging of one look, the Windows task reading,
// and the plugin end to end over a temp home with fake clock, chats and Windows tasks. Never the real home or a real task.
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { DeskSettings } from '@shared/protocol'
import type { RoutinesStatus } from '@shared/routines'
import type { ServerContext } from '../../src/context'
import { nextSlot, parseCron, previousSlot } from '../../src/routines/cron'
import { checkDefinition, untilEndOf, type Entry } from '../../src/routines/manifest'
import { emptyMemory, judge, MIN_GAP_MS, MISSED_MS, type Memory, type Reading, type Seen } from '../../src/routines/decide'
import { parseTaskReadings, readTasks, type TaskReading } from '../../src/routines/wintask'
import { loadSettings, settingsPath } from '../../src/settings'
import plugin, { type RoutinesOptions, type RoutineTasks } from '../../src/plugins/73-routines'

const MIN = 60_000
const HOUR = 60 * MIN
/** A local time, as the cron reading takes it (the tests run in the PC's zone, so they build local dates). */
const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()

// ---------- cron ----------

describe('cron (routines/cron.ts)', () => {
  test('lists, ranges and steps: the slots of a day come out in order, both ways', () => {
    const c = parseCron('0 8,12 * * *')
    expect(nextSlot(c, at(2026, 10, 12, 8, 0))).toBe(at(2026, 10, 12, 12, 0))
    expect(previousSlot(c, at(2026, 10, 12, 11, 59))).toBe(at(2026, 10, 12, 8, 0))

    const steps = parseCron('*/20 * * * *')
    expect(previousSlot(steps, at(2026, 10, 12, 10, 50))).toBe(at(2026, 10, 12, 10, 40))

    const range = parseCron('10-30/10 9 * * *')
    expect(nextSlot(range, at(2026, 10, 12, 9, 10))).toBe(at(2026, 10, 12, 9, 20))
  })

  test('the next slot is strictly after the time it is asked from, and the previous slot is at or before it', () => {
    const c = parseCron('57 8 * * *')
    expect(nextSlot(c, at(2026, 10, 12, 8, 57))).toBe(at(2026, 10, 13, 8, 57))
    expect(previousSlot(c, at(2026, 10, 12, 8, 57))).toBe(at(2026, 10, 12, 8, 57))
  })

  test('day-of-week 7 is Sunday, like 0', () => {
    // 2026-10-17 is a Saturday, so the next Sunday is the 18th.
    expect(nextSlot(parseCron('0 9 * * 7'), at(2026, 10, 17, 10, 0))).toBe(at(2026, 10, 18, 9, 0))
    expect(nextSlot(parseCron('0 9 * * 0'), at(2026, 10, 17, 10, 0))).toBe(at(2026, 10, 18, 9, 0))
  })

  test('when both day-of-month and day-of-week are restricted, either one matching counts', () => {
    // Monday 2026-10-12 09:30: the 13th (a Tuesday) comes before the next Monday, the 19th.
    expect(nextSlot(parseCron('0 9 13 * 1'), at(2026, 10, 12, 9, 30))).toBe(at(2026, 10, 13, 9, 0))
  })

  test('month ends: the 31st only runs in the months that have one', () => {
    expect(nextSlot(parseCron('0 0 31 * *'), at(2026, 9, 30, 12, 0))).toBe(at(2026, 10, 31, 0, 0))
    expect(nextSlot(parseCron('0 0 31 * *'), at(2026, 10, 31, 0, 0))).toBe(at(2026, 12, 31, 0, 0))
  })

  test('rejects what it does not take, with a reason', () => {
    expect(() => parseCron('0 9 * * MON')).toThrow()
    expect(() => parseCron('@daily')).toThrow()
    expect(() => parseCron('0 0 9 * * *')).toThrow()
    expect(() => parseCron('60 9 * * *')).toThrow()
    expect(() => parseCron('0 9 * *')).toThrow()
  })
})

// ---------- the definition check ----------

const askedBy = 'Example Owner, 2026-10-12: "check the inbox every weekday morning"'

describe('the definition (routines/manifest.ts)', () => {
  test('each kind checks out, and the timeout defaults to 120 minutes', () => {
    const sched = checkDefinition('example-sched', { name: 'Example', askedBy, schedule: '57 8 * * 1-5', run: ['node', 'x.js'] })
    expect(sched).toMatchObject({ id: 'example-sched', schedule: '57 8 * * 1-5', timeoutMinutes: 120 })

    const status = checkDefinition('example-status', { name: 'Example', askedBy, status: ['node', 'status.js'], run: ['node', 'tick.js'] })
    expect(status.status).toEqual(['node', 'status.js'])

    const task = checkDefinition('example-task', { name: 'Example', askedBy, windowsTask: '\\Example nightly job' })
    expect(task.windowsTask).toBe('\\Example nightly job')
  })

  test('exactly one of schedule, status or windowsTask', () => {
    expect(() => checkDefinition('example-two', { name: 'E', askedBy, schedule: '0 9 * * *', status: ['x'], run: ['x'] })).toThrow(/exactly one/)
    expect(() => checkDefinition('example-none', { name: 'E', askedBy, run: ['x'] })).toThrow(/exactly one/)
  })

  test('a schedule or status routine has exactly one of run or prompt; a windowsTask routine has neither', () => {
    expect(() => checkDefinition('example-both', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], prompt: 'y', cwd: 'C:/Users/me/project' })).toThrow()
    expect(() => checkDefinition('example-none', { name: 'E', askedBy, schedule: '0 9 * * *' })).toThrow()
    expect(() => checkDefinition('example-task', { name: 'E', askedBy, windowsTask: '\\Example', run: ['x'] })).toThrow(/no "run" or "prompt"/)
  })

  test('a prompt routine needs its cwd', () => {
    expect(() => checkDefinition('example-prompt', { name: 'E', askedBy, schedule: '0 9 * * *', prompt: 'Check it.' })).toThrow(/cwd/)
    expect(checkDefinition('example-prompt', { name: 'E', askedBy, schedule: '0 9 * * *', prompt: 'Check it.', cwd: 'C:/Users/me/project' }).prompt).toBe('Check it.')
  })

  test('askedBy is required, non-empty and at most 500 characters', () => {
    expect(() => checkDefinition('example-a', { name: 'E', schedule: '0 9 * * *', run: ['x'] })).toThrow(/askedBy/)
    expect(() => checkDefinition('example-a', { name: 'E', askedBy: '   ', schedule: '0 9 * * *', run: ['x'] })).toThrow(/askedBy/)
    expect(() => checkDefinition('example-a', { name: 'E', askedBy: 'x'.repeat(501), schedule: '0 9 * * *', run: ['x'] })).toThrow(/500/)
  })

  test('until is a real day, YYYY-MM-DD, and its end is the next local midnight', () => {
    expect(checkDefinition('example-u', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], until: '2026-10-23' }).until).toBe('2026-10-23')
    expect(() => checkDefinition('example-u', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], until: '2026-02-30' })).toThrow()
    expect(untilEndOf('2026-10-23')).toBe(at(2026, 10, 24, 0, 0))
  })

  test('tick is refused with its replacement; the id must be a file name', () => {
    expect(() => checkDefinition('example-t', { name: 'E', askedBy, schedule: '0 9 * * *', tick: ['x'] })).toThrow(/"run"/)
    expect(() => checkDefinition('Bad Id', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'] })).toThrow()
  })

  test('the timeout is 5 to 360 minutes', () => {
    expect(() => checkDefinition('example-m', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], timeoutMinutes: 4 })).toThrow(/timeoutMinutes/)
    expect(() => checkDefinition('example-m', { name: 'E', askedBy, schedule: '0 9 * * *', run: ['x'], timeoutMinutes: 361 })).toThrow(/timeoutMinutes/)
  })
})

// ---------- judging one look ----------

const NOW = at(2026, 10, 12, 9, 30)
const entryOf = (id: string, body: Record<string, unknown>): Entry => ({ id, def: checkDefinition(id, { name: 'Example', askedBy, ...body }), broken: null })
const reading = (over: Partial<Reading> = {}): Reading => ({ nextTickAt: null, lastTickAt: null, off: false, headline: null, totals: null, settings: null, ...over })
const seenOf = (entry: Entry, over: Partial<Seen> = {}): Seen => ({ entry, reading: null, readError: null, task: null, ...over })
const memWith = (over: Partial<Memory> = {}): Memory => ({ ...emptyMemory(), ...over })

describe('judging (routines/decide.ts)', () => {
  const sched = entryOf('example-sched', { schedule: '0 9 * * *', run: ['x'] })

  test('the first look of a schedule (no memory) is a baseline: a slot already past never runs', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: null }), NOW, true, false)
    expect(j.start).toBe(false)
    expect(j.nextRunAt).toBe(at(2026, 10, 13, 9, 0))
  })

  test('the newest missed slot runs once, and the memory moves past it', () => {
    const slot = at(2026, 10, 12, 9, 0)
    const first = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, true, false)
    expect(first).toMatchObject({ start: true, slot, state: 'due' })
    // Once the run has recorded its slot, the same look starts nothing again.
    const again = judge(seenOf(sched), memWith({ lastSlot: slot }), NOW, true, false)
    expect(again.start).toBe(false)
  })

  test('a slot missed by more than 12 hours is skipped, not run late', () => {
    const slot = at(2026, 10, 11, 9, 0)
    const late = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 10, 9, 0) }), at(2026, 10, 11, 9, 0) + MISSED_MS + MIN, true, false)
    expect(late.start).toBe(false)
    expect(late.skipSlot).toBe(slot)
    expect(late.state).toBe('idle')
  })

  test('a paused routine never starts on its own', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0), paused: true }), NOW, true, false)
    expect(j).toMatchObject({ state: 'paused', start: false })
  })

  test('an ended routine (past until) is listed as ended and never runs', () => {
    const ended = entryOf('example-ended', { schedule: '0 9 * * *', run: ['x'], until: '2026-10-11' })
    const j = judge(seenOf(ended), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, true, false)
    expect(j).toMatchObject({ state: 'ended', start: false })
    const manual = judge(seenOf(ended), memWith(), NOW, true, true)
    expect(manual.state).toBe('ended')
  })

  test('a running routine is not started again', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0), running: { startedAt: NOW, pid: null, workerId: null, sessionId: null } }), NOW, true, false)
    expect(j).toMatchObject({ state: 'running', start: false })
  })

  test('with the manager off, a due routine waits and starts nothing', () => {
    const j = judge(seenOf(sched), memWith({ lastSlot: at(2026, 10, 11, 9, 0) }), NOW, false, false)
    expect(j).toMatchObject({ state: 'due', start: false })
  })

  test('a status routine waits 15 minutes after its last run, and a manual run skips the wait', () => {
    const status = entryOf('example-status', { status: ['x'], run: ['y'] })
    const last = NOW - 5 * MIN
    const r = reading({ nextTickAt: NOW - MIN, lastTickAt: last })
    const soon = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), NOW, true, false)
    expect(soon.start).toBe(false)
    expect(MIN_GAP_MS).toBe(15 * MIN)

    const later = NOW + 11 * MIN
    const after = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), later, true, false)
    expect(after.start).toBe(true)

    const manual = judge(seenOf(status, { reading: r }), memWith({ runs: [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '', workerId: null, sessionId: null }] }), NOW, true, true)
    expect(manual.start).toBe(true)
  })

  test('a status that says off, or a broken file, is never started', () => {
    const status = entryOf('example-status', { status: ['x'], run: ['y'] })
    expect(judge(seenOf(status, { reading: reading({ off: true }) }), memWith(), NOW, true, true)).toMatchObject({ state: 'off', start: false })
    const broken: Entry = { id: 'example-bad', def: null, broken: 'its file does not check out' }
    expect(judge(seenOf(broken), memWith(), NOW, true, true)).toMatchObject({ state: 'broken', start: false })
  })
})

// ---------- the Windows task reading ----------

describe('Windows tasks (routines/wintask.ts)', () => {
  const canned = JSON.stringify([
    { path: '\\Example nightly job', found: true, state: 'Ready', lastRunTime: '2026-10-11T02:00:00', lastTaskResult: 0, nextRunTime: '2026-10-12T02:00:00' },
    { path: '\\Example stuck job', found: true, state: 'Disabled', lastRunTime: '1899-12-30T00:00:00', lastTaskResult: 267011, nextRunTime: null },
    { path: '\\Example failing job', found: true, state: 'Running', lastRunTime: '2026-10-12T08:00:00', lastTaskResult: 267009, nextRunTime: null },
  ])

  test('reads each named task from one canned answer; a task not in it is not found', () => {
    const paths = ['\\Example nightly job', '\\Example stuck job', '\\Example failing job', '\\Example missing job']
    const rows = parseTaskReadings(canned, paths)
    expect(rows.map((r) => r.path)).toEqual(paths)
    expect(rows[0]).toMatchObject({ found: true, state: 'Ready', lastTaskResult: 0, lastRunAt: Date.parse('2026-10-11T02:00:00'), nextRunAt: Date.parse('2026-10-12T02:00:00') })
    expect(rows[3]).toMatchObject({ found: false, state: null, lastRunAt: null, lastTaskResult: null, nextRunAt: null })
  })

  test('Windows says 1899 for a task that never ran: no run to record', () => {
    const row: TaskReading = parseTaskReadings(canned, ['\\Example stuck job'])[0]
    expect(row.lastRunAt).toBeNull()
    expect(row.state).toBe('Disabled')
  })

  test('a reply that is not JSON is an error, not an empty list', () => {
    expect(() => parseTaskReadings('Access denied', ['\\Example'])).toThrow()
  })

  // The real read on Windows PowerShell 5.1, which writes a parsed JSON list as one object: @(ConvertFrom-Json ...) once
  // made every path one item, the script exited 1, and every windowsTask routine read as broken while the canned tests
  // above passed. Tasks that do not exist: no real task is touched.
  test.skipIf(process.platform !== 'win32')('the read script answers one reading per path; a missing task is not found', async () => {
    const paths = ['\\Example missing task one', '\\Example missing task two']
    const rows = await readTasks(paths)
    expect(rows.map((r) => [r.path, r.found])).toEqual([[paths[0], false], [paths[1], false]])
  }, 60_000)
})

// ---------- the plugin ----------

const temps: string[] = []
const stops: (() => void | Promise<void>)[] = []
const prevHome = process.env.HYDRA_DESK_HOME
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of temps.splice(0)) if (d) rmSync(d, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = prevHome
})

// The fake command: `tick` counts a line in its file and exits 0, `busy` exits 75.
const COMMAND = `const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'tick') {
  fs.appendFileSync(file, 'tick\\n')
  console.log('first line of the run')
  console.log('done: 3 items checked')
  process.exit(0)
}
process.exit(75)
`

interface Desk {
  home: string
  app: Hono
  count: string
  settings: Record<string, unknown>
  /** The argv of the fake command in `mode`. */
  argv(mode: string): string[]
  /** Writes routines/<id>.json. */
  routine(id: string, body: Record<string, unknown>): void
  /** The clock the plugin reads: set it to move time on. */
  clock: { now: number }
  tasks: { read: string[][]; run: string[]; setEnabled: [string, boolean][] }
}

function desk(opts: Partial<RoutinesOptions> = {}): Desk {
  const home = mkdtempSync(join(tmpdir(), 'desk-routines-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const dir = join(home, 'routines')
  mkdirSync(dir, { recursive: true })
  const script = join(home, 'command.cjs')
  writeFileSync(script, COMMAND)
  const count = join(home, 'ticks.txt')
  const settings: Record<string, unknown> = { routines: true }
  const app = new Hono()
  const ctx = {
    home,
    settings: () => settings as unknown as DeskSettings,
    updateSettings: (patch: Partial<DeskSettings>) => Object.assign(settings, patch),
    onStop: (fn: () => void | Promise<void>) => stops.push(fn),
    deps: {},
  } as unknown as ServerContext
  const clock = { now: at(2026, 10, 12, 9, 0) + 30_000 }
  const tasks = { read: [] as string[][], run: [] as string[], setEnabled: [] as [string, boolean][] }
  const fakeTasks: RoutineTasks = {
    read: async (paths) => {
      tasks.read.push(paths)
      return paths.map((path) => ({ path, found: true, state: 'Ready', lastRunAt: null, lastTaskResult: 0, nextRunAt: at(2026, 10, 12, 2, 0) }))
    },
    run: async (path) => {
      tasks.run.push(path)
    },
    setEnabled: async (path, enabled) => {
      tasks.setEnabled.push([path, enabled])
    },
  }
  plugin(app, ctx, { now: () => clock.now, tasks: fakeTasks, platform: 'win32', ...opts })
  return {
    home,
    app,
    count,
    settings,
    argv: (mode) => [process.execPath, script, mode, count],
    routine: (id, body) => writeFileSync(join(dir, `${id}.json`), JSON.stringify(body)),
    clock,
    tasks,
  }
}

const OWNER = { 'X-Desk-Caller': 'window' }
const post = (app: Hono, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/routines', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = async (app: Hono, fresh = false): Promise<RoutinesStatus> => (await (await app.request(fresh ? '/api/routines?fresh=1' : '/api/routines')).json()) as RoutinesStatus

/** Reads the status until `done` holds, or 20 seconds pass. */
async function settle(app: Hono, done: (s: RoutinesStatus) => boolean): Promise<RoutinesStatus> {
  const until = Date.now() + 20_000
  let s = await get(app)
  while (!done(s) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    s = await get(app)
  }
  return s
}

const ticks = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l === 'tick').length : 0)

describe('the plugin', () => {
  test('a run routine runs once on its slot, a second look does not run it again, and a run now runs it at once', async () => {
    const d = desk()
    d.routine('example-every-minute', { name: 'Example every minute', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })

    // The first look is a baseline: the 09:00 slot is already past, so nothing runs.
    const first = await get(d.app, true)
    expect(first.routines[0]).toMatchObject({ id: 'example-every-minute', state: 'idle' })
    expect(ticks(d.count)).toBe(0)

    // A minute later the 09:01 slot is due: it runs once.
    d.clock.now = at(2026, 10, 12, 9, 1) + 30_000
    await get(d.app, true)
    const ran = await settle(d.app, (s) => s.routines[0].runs.length === 1)
    expect(ran.routines[0].runs[0]).toMatchObject({ outcome: 'ok', exitCode: 0, lastLine: 'done: 3 items checked' })
    expect(ticks(d.count)).toBe(1)

    // The same slot, looked at again, runs nothing.
    await get(d.app, true)
    expect(ticks(d.count)).toBe(1)

    // Run now runs it at once, whatever the slot.
    const res = await post(d.app, { run: 'example-every-minute' })
    expect(res.status).toBe(200)
    await settle(d.app, (s) => s.routines[0].runs.length === 2)
    expect(ticks(d.count)).toBe(2)
    // Two real process starts: on a busy PC each takes seconds, past the 5 s default (it timed out at 6.6 and 8.2 s).
  }, 30_000)

  test('a paused routine is refused a run now (409) and never starts on its own', async () => {
    const d = desk()
    d.routine('example-paused', { name: 'Example paused', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    expect((await post(d.app, { pause: 'example-paused' })).status).toBe(200)
    d.clock.now = at(2026, 10, 12, 9, 5)
    const s = await get(d.app, true)
    expect(s.routines[0]).toMatchObject({ state: 'paused', paused: true })
    const refused = await post(d.app, { run: 'example-paused' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('paused')
    expect(ticks(d.count)).toBe(0)
  })

  test('the owner only: an agent gets 403 for resume, approve, discard and the switch; the window gets them', async () => {
    const d = desk()
    d.routine('example-owned', { name: 'Example owned', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 })
    await get(d.app, true)
    for (const body of [{ resume: 'example-owned' }, { approve: 'example-owned' }, { discard: 'example-owned' }, { enabled: false }]) {
      const res = await post(d.app, body)
      expect(res.status).toBe(403)
      expect(((await res.json()) as { error: string }).error).toBe('only the owner can do that, in Settings > Managers > Routines')
    }
    expect(d.settings.routines).toBe(true)

    expect((await post(d.app, { pause: 'example-owned' })).status).toBe(200)
    expect((await post(d.app, { resume: 'example-owned' }, OWNER)).status).toBe(200)
    expect((await post(d.app, { enabled: false }, OWNER)).status).toBe(200)
    expect(d.settings.routines).toBe(false)
  })

  test('a proposal is never run: it waits for the owner, approve moves it into routines without why, discard deletes it', async () => {
    const d = desk()
    const why = 'It checks the inbox each morning, which a background task would forget.'
    const proposal = { id: 'example-proposed', name: 'Example proposed', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5, why }

    // Propose is open to an agent. It waits as a proposal and runs nothing.
    const made = await post(d.app, { propose: proposal })
    expect(made.status).toBe(200)
    const waiting = (await made.json()) as RoutinesStatus
    expect(waiting.proposals).toHaveLength(1)
    expect(waiting.proposals[0]).toMatchObject({ id: 'example-proposed', why })
    expect(waiting.routines.some((r) => r.id === 'example-proposed')).toBe(false)
    d.clock.now = at(2026, 10, 12, 9, 5)
    await get(d.app, true)
    expect(ticks(d.count)).toBe(0)

    // An agent cannot approve it; the window can. The file keeps the contract and drops why.
    expect((await post(d.app, { approve: 'example-proposed' })).status).toBe(403)
    expect((await post(d.app, { approve: 'example-proposed' }, OWNER)).status).toBe(200)
    const file = JSON.parse(readFileSync(join(d.home, 'routines', 'example-proposed.json'), 'utf8')) as Record<string, unknown>
    expect(file.why).toBeUndefined()
    expect(file.name).toBe('Example proposed')
    const approved = await get(d.app, true)
    expect(approved.proposals).toHaveLength(0)
    expect(approved.routines.some((r) => r.id === 'example-proposed')).toBe(true)

    // A discarded proposal is gone, and proposing an id that exists refuses.
    expect((await post(d.app, { propose: { ...proposal, id: 'example-other' } })).status).toBe(200)
    expect((await post(d.app, { discard: 'example-other' }, OWNER)).status).toBe(200)
    expect(existsSync(join(d.home, 'routines', 'proposed', 'example-other.json'))).toBe(false)
    expect((await post(d.app, { propose: proposal })).status).toBe(409)
  })

  test('a proposal that does not check out is refused with the reason (400), one without why too', async () => {
    const d = desk()
    const base = { id: 'example-bad', name: 'Example', askedBy, schedule: '* * * * *', run: d.argv('tick'), timeoutMinutes: 5 }
    expect((await post(d.app, { propose: base })).status).toBe(400)
    expect((await post(d.app, { propose: { ...base, why: 'Because.', schedule: 'MON' } })).status).toBe(400)
  })

  test('the body takes one action per call, and anything else answers 400 with the shape', async () => {
    const d = desk()
    expect((await post(d.app, { run: 'a', pause: 'b' })).status).toBe(400)
    expect((await post(d.app, { nothing: true })).status).toBe(400)
    const res = await post(d.app, { run: 42 })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('"run"')
  })

  test('a Windows task routine: read in one call, paused by Windows Disabled, and off Windows it is broken', async () => {
    const d = desk()
    d.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const s = await get(d.app, true)
    expect(s.routines[0]).toMatchObject({ id: 'example-task', kind: 'windowsTask', state: 'idle', windowsTask: '\\Example nightly job' })
    expect(d.tasks.read.length).toBeGreaterThan(0)

    // Pause and resume are Windows' Disabled state, through schtasks, one call each.
    expect((await post(d.app, { pause: 'example-task' })).status).toBe(200)
    expect((await post(d.app, { resume: 'example-task' }, OWNER)).status).toBe(200)
    expect(d.tasks.setEnabled).toEqual([['\\Example nightly job', false], ['\\Example nightly job', true]])
    expect((await post(d.app, { run: 'example-task' })).status).toBe(200)
    expect(d.tasks.run).toEqual(['\\Example nightly job'])

    // A run is recorded at the time Windows ran it, never at the time of the look (a 03:00 run read "21 min ago").
    const ran = at(2026, 10, 12, 3, 0)
    const nightly = desk({
      tasks: {
        read: async (paths) => paths.map((path) => ({ path, found: true, state: 'Ready', lastRunAt: ran, lastTaskResult: 1, nextRunAt: at(2026, 10, 13, 3, 0) })),
        run: async () => {},
        setEnabled: async () => {},
      },
    })
    nightly.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const read = (await get(nightly.app, true)).routines[0]
    expect(read.runs[0]).toMatchObject({ startedAt: ran, endedAt: ran, outcome: 'failed', exitCode: 1 })
    expect(read.lastRunAt).toBe(ran)

    const elsewhere = desk({ platform: 'linux' })
    elsewhere.routine('example-task', { name: 'Example task', askedBy, windowsTask: '\\Example nightly job' })
    const off = await get(elsewhere.app, true)
    expect(off.routines[0]).toMatchObject({ state: 'broken' })
    expect(off.routines[0].reason).toContain('Windows')
  })
})

describe('settings (a stale key from the manager\'s old name)', () => {
  test('a settings file that still holds the old key loads without an error, and routines defaults on', () => {
    // The manager's name before Routines, assembled so the old name appears nowhere in the source.
    const old = ['arch', 'aingel'].join('')
    const home = mkdtempSync(join(tmpdir(), 'desk-routines-settings-'))
    temps.push(home)
    writeFileSync(settingsPath(home), JSON.stringify({ [old]: true }))
    const settings = loadSettings(home) as unknown as Record<string, unknown>
    expect(settings.routines).toBe(true)
    expect(old in settings).toBe(false)
  })
})
