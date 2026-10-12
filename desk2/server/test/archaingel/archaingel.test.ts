// ArchAIngel's judgment (archaingel/decide.ts) and the plugin (plugins/73-archaingel.ts) through its routes. The plugin is
// run over a temp home holding a fake standing agent: one small script that is both its status and its tick, so the
// whole loop (manifest, status, a hidden tick, the run record, the second look) runs for real. Nothing outside the temp
// home is read or written, and no model is asked.

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { DeskSettings } from '@shared/protocol'
import type { ArchAIngelStatus } from '@shared/archaingel'
import type { ServerContext } from '../../src/context'
import { emptyMemory, judge, MIN_GAP_MS, parseReading, type Memory, type Seen } from '../../src/archaingel/decide'
import plugin, { type ArchAIngelOptions } from '../../src/plugins/73-archaingel'

const NOW = Date.parse('2026-10-11T12:00:00Z')
const MIN = 60_000

// The fake agent: `tick` appends a line to a count file and prints two lines (exit 0), `busy` exits 75, `hang` outlives
// any timeout, and `status` reports the next tick an hour away once a tick has counted.
const AGENT = `const fs = require('node:fs')
const [mode, file] = process.argv.slice(2)
if (mode === 'tick') {
  fs.appendFileSync(file, 'tick\\n')
  console.log('first line of the sortie')
  console.log('sortie done: 3 items checked')
  process.exit(0)
}
if (mode === 'busy') process.exit(75)
if (mode === 'hang') setTimeout(() => {}, 30000)
if (mode === 'status') {
  const ticked = fs.existsSync(file) && fs.readFileSync(file, 'utf8') !== ''
  console.log(JSON.stringify({ next_tick_at: ticked ? new Date(Date.now() + 3600000).toISOString() : null, last_tick_at: null, headline: 'Example headline', totals: { items: 3, note: 'x' } }))
}
`

const temps: string[] = []
const stops: (() => void | Promise<void>)[] = []
const prevHome = process.env.HYDRA_DESK_HOME
afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  for (const d of temps.splice(0)) if (d) rmSync(d, { recursive: true, force: true })
  if (prevHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = prevHome
})

interface Desk {
  home: string
  app: Hono
  /** The fake agent's script, and the count file its tick writes to. */
  script: string
  count: string
  /** The argv of the fake agent in `mode`, with the count file as its argument. */
  argv(mode: string): string[]
  register(id: string, body: Record<string, unknown>): void
}

/** The plugin over a temp home, with the fake agent written into it. */
function desk(opts: ArchAIngelOptions = {}): Desk {
  const home = mkdtempSync(join(tmpdir(), 'desk-archaingel-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const agents = join(home, 'archaingel', 'agents')
  mkdirSync(agents, { recursive: true })
  const script = join(home, 'agent.cjs')
  writeFileSync(script, AGENT)
  const count = join(home, 'ticks.txt')
  const settings = { archaingel: true }
  const app = new Hono()
  const ctx = {
    home,
    settings: () => settings as unknown as DeskSettings,
    updateSettings: (patch: Partial<DeskSettings>) => Object.assign(settings, patch),
    onStop: (fn: () => void | Promise<void>) => stops.push(fn),
    deps: {},
  } as unknown as ServerContext
  plugin(app, ctx, opts)
  const argv = (mode: string): string[] => [process.execPath, script, mode, count]
  return {
    home,
    app,
    script,
    count,
    argv,
    register: (id, body) => writeFileSync(join(agents, `${id}.json`), JSON.stringify(body)),
  }
}

const get = async (app: Hono, fresh = false): Promise<ArchAIngelStatus> =>
  (await (await app.request(fresh ? '/api/archaingel?fresh=1' : '/api/archaingel')).json()) as ArchAIngelStatus

/** Reads the status until `done` holds, or 20 seconds pass. */
async function settle(app: Hono, done: (s: ArchAIngelStatus) => boolean): Promise<ArchAIngelStatus> {
  const until = Date.now() + 20_000
  let s = await get(app)
  while (!done(s) && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 50))
    s = await get(app)
  }
  return s
}

const agent = (id: string, next: string | null, last: number | null = null, fields: Partial<Memory> = {}): { seen: Seen; mem: Memory } => ({
  seen: {
    entry: { id, manifest: { id, name: 'Example Agent', tick: ['x'], status: ['y'], timeoutMinutes: 120 }, broken: null },
    reading: { nextTickAt: next === null ? null : Date.parse(next), lastTickAt: null, off: false, headline: null, totals: null },
    readError: null,
  },
  mem: { ...emptyMemory(), runs: last === null ? [] : [{ startedAt: last - MIN, endedAt: last, outcome: 'ok', exitCode: 0, lastLine: '' }], ...fields },
})

describe('judging (archaingel/decide.ts)', () => {
  test('due: a next tick in the future is not due, in the past or null is, and an off agent never is', () => {
    const later = agent('later', new Date(NOW + 3_600_000).toISOString())
    expect(judge(later.seen, later.mem, NOW, true, false)).toMatchObject({ state: 'idle', start: false })
    const past = agent('past', new Date(NOW - MIN).toISOString())
    expect(judge(past.seen, past.mem, NOW, true, false)).toMatchObject({ state: 'due', start: true })
    const none = agent('none', null)
    expect(judge(none.seen, none.mem, NOW, true, false)).toMatchObject({ state: 'due', start: true })
    const off = agent('off', null)
    off.seen.reading = { ...off.seen.reading!, off: true }
    expect(judge(off.seen, off.mem, NOW, true, false)).toMatchObject({ state: 'off', start: false })
    expect(judge(off.seen, off.mem, NOW, true, true)).toMatchObject({ state: 'off', start: false })
  })

  test('a running agent is not started again, and the switch off starts nothing', () => {
    const running = agent('busy', null, null, { running: { startedAt: NOW - MIN, pid: 42 } })
    expect(judge(running.seen, running.mem, NOW, true, false)).toMatchObject({ state: 'running', start: false })
    expect(judge(running.seen, running.mem, NOW, true, true)).toMatchObject({ state: 'running', start: false })
    const idle = agent('idle', null)
    expect(judge(idle.seen, idle.mem, NOW, false, false)).toMatchObject({ state: 'due', start: false })
  })

  test('MIN_GAP: a tick waits 15 minutes after the last one ended, and a manual run skips the wait', () => {
    expect(MIN_GAP_MS).toBe(15 * MIN)
    const recent = agent('recent', null, NOW - 5 * MIN)
    expect(judge(recent.seen, recent.mem, NOW, true, false)).toMatchObject({ state: 'due', start: false })
    expect(judge(recent.seen, recent.mem, NOW, true, true)).toMatchObject({ start: true })
    const old = agent('old', null, NOW - 16 * MIN)
    expect(judge(old.seen, old.mem, NOW, true, false)).toMatchObject({ state: 'due', start: true })
    // The status's own last_tick_at counts too, when it is the later one.
    const reported = agent('reported', null, NOW - 16 * MIN)
    reported.seen.reading = { ...reported.seen.reading!, lastTickAt: NOW - 2 * MIN }
    expect(judge(reported.seen, reported.mem, NOW, true, false)).toMatchObject({ start: false })
  })

  test('a broken agent is never started, not even by a manual run', () => {
    const broken = agent('broken', null)
    broken.seen = { entry: { id: 'broken', manifest: null, broken: 'the file is not JSON' }, reading: null, readError: null }
    expect(judge(broken.seen, broken.mem, NOW, true, true)).toEqual({ state: 'broken', reason: 'the file is not JSON', start: false })
    const unread = agent('unread', null)
    unread.seen = { ...unread.seen, reading: null, readError: 'the status command exited 1' }
    expect(judge(unread.seen, unread.mem, NOW, true, false)).toMatchObject({ state: 'broken', reason: 'the status command exited 1', start: false })
  })

  test('the status object is checked: ISO times, a boolean off, a one-line headline cut to 160 characters', () => {
    const r = parseReading(JSON.stringify({ next_tick_at: null, last_tick_at: '2026-10-11T10:00:00Z', headline: 'a\n  b '.padEnd(200, 'c'), totals: { n: 2, s: 'no' } }))
    expect(r.nextTickAt).toBeNull()
    expect(r.lastTickAt).toBe(Date.parse('2026-10-11T10:00:00Z'))
    expect(r.headline).toBe(('a b ' + 'c'.repeat(200)).slice(0, 160))
    expect(r.totals).toEqual({ n: 2 })
    expect(() => parseReading('[1]')).toThrow('no JSON object')
    expect(() => parseReading('not json')).toThrow('no JSON object')
    expect(() => parseReading(JSON.stringify({ next_tick_at: 'soon' }))).toThrow('"next_tick_at" must be an ISO time or null')
    expect(() => parseReading(JSON.stringify({ off: 'yes' }))).toThrow('"off" must be true or false')
  })
})

describe('the plugin', () => {
  test('a manifest that does not check out is listed broken with its reason, and its agent never runs', async () => {
    const d = desk()
    const dir = join(d.home, 'archaingel', 'agents')
    writeFileSync(join(dir, 'bad-argv.json'), JSON.stringify({ name: 'Example Agent', tick: 'node tick.js', status: d.argv('status') }))
    writeFileSync(join(dir, 'Bad_ID.json'), JSON.stringify({ name: 'Example Agent', tick: d.argv('tick'), status: d.argv('status') }))
    writeFileSync(join(dir, 'bad-timeout.json'), JSON.stringify({ name: 'Example Agent', tick: d.argv('tick'), status: d.argv('status'), timeoutMinutes: 2 }))
    const s = await get(d.app, true)
    expect(s.agents.map((a) => [a.id, a.state])).toEqual([
      ['Bad_ID', 'broken'],
      ['bad-argv', 'broken'],
      ['bad-timeout', 'broken'],
    ])
    expect(s.agents[1].reason).toContain('"tick" must be a command')
    expect(s.agents[2].reason).toContain('"timeoutMinutes" must be a number from 5 to 360')
    expect(existsSync(d.count)).toBe(false)
  })

  test('end to end: one look ticks a due agent once, keeps the run with its last line, and a second look does not tick it again', async () => {
    const d = desk()
    d.register('example-agent', { name: 'Example Agent', tick: d.argv('tick'), status: d.argv('status') })
    const first = await get(d.app, true)
    expect(first.agents.map((a) => a.id)).toEqual(['example-agent'])
    const done = await settle(d.app, (s) => s.agents[0].runs.length === 1 && s.agents[0].running === null)
    expect(done.agents[0].runs).toHaveLength(1)
    expect(done.agents[0].runs[0]).toMatchObject({ outcome: 'ok', exitCode: 0, lastLine: 'sortie done: 3 items checked' })
    expect(readFileSync(join(d.home, 'archaingel', 'logs', 'example-agent.log'), 'utf8')).toContain('first line of the sortie')

    const second = await get(d.app, true)
    expect(second.agents[0]).toMatchObject({ state: 'idle', headline: 'Example headline', totals: { items: 3 } })
    expect(second.agents[0].runs).toHaveLength(1)
    expect(readFileSync(d.count, 'utf8')).toBe('tick\n')
  })

  test('exit 75 is recorded as busy, not as a failure', async () => {
    const d = desk()
    d.register('busy-agent', { name: 'Example Agent', tick: d.argv('busy'), status: d.argv('status') })
    const s = await settle(d.app, (x) => x.agents[0].runs.length === 1 && x.agents[0].running === null)
    expect(s.agents[0].runs[0]).toMatchObject({ outcome: 'busy', exitCode: 75 })
  })

  test('a tick past its timeout is killed and recorded timed-out', async () => {
    const d = desk({ timeoutScale: 0.001 })
    d.register('hang-agent', { name: 'Example Agent', tick: d.argv('hang'), status: d.argv('status'), timeoutMinutes: 5 })
    const s = await settle(d.app, (x) => x.agents[0].runs.length === 1 && x.agents[0].running === null)
    // The exit code is the platform's (taskkill /F ends it with 1 on Windows, a signal leaves null elsewhere): the outcome is the contract.
    expect(s.agents[0].runs[0].outcome).toBe('timed-out')
  })
})
