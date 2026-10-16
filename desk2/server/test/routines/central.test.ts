// Central routines (routines/central.ts, routines/manager-central.ts): an approval holds only for what a trusted key signed,
// and the routines plugin end to end over a temp home whose routines-store.json names a store, read and written through
// the real Connections client against a fake Connections server whose `docs` tool keeps the store in a file. Never the
// real home, the real store or a real routine.
//
// Each test answers the test-audit gate: the approval test guards the security contract (a routine runs only with a
// trusted key's signature over exactly what it holds now); the plugin tests guard /api/routines over a central store
// (a proposal waits, the owner's approve signs it into the store, runsOn places it, a local file of the same id wins, an
// edit is signed back with the sha it read, and the copy on this computer runs a pinned routine while the store and its
// run board are down) and over its run board (a routine shared by two runners runs once per slot of its own time zone and
// both cards show that run; a lease is honoured while it lives, taken over once it lapsed, renewed and ended by its holder,
// and a board that does not answer holds the shared slot back).
import { afterEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { DeskSettings } from '@shared/protocol'
import type { RoutinesStatus } from '@shared/routines'
import type { ServerContext } from '../../src/context'
import { approvedText, approverKey, checkApproval, FORMAT, parseDoc, renderDoc, type ApproverKey } from '../../src/routines/central'
import plugin from '../../src/plugins/73-routines'

/** An approval's time: signed into the text, never compared with the clock. */
const SIGNED_AT = new Date().toISOString()
const at = (y: number, mo: number, d: number, h: number, mi = 0): number => new Date(y, mo - 1, d, h, mi).getTime()
const ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone
const askedBy = 'Example Owner, 2026-10-15: "run the example check every minute"'
const REPO = 'example/routines'

const temps: string[] = []
const stops: (() => void | Promise<void>)[] = []
const prevHome = process.env.HYDRA_DESK_HOME

const temp = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix))
  temps.push(d)
  return d
}

afterEach(async () => {
  for (const s of stops.splice(0)) await s()
  // Windows holds a folder until the fake Connections server that started in it has gone.
  for (const d of temps.splice(0)) {
    for (let i = 0; i < 40; i++) {
      try {
        rmSync(d, { recursive: true, force: true })
        break
      } catch {
        await Bun.sleep(50)
      }
    }
  }
  if (prevHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = prevHome
})

const front = (over: Record<string, unknown>): Record<string, unknown> => ({
  kind: 'routine',
  format: FORMAT,
  title: 'Example central',
  askedBy,
  schedule: '* * * * *',
  timeZone: ZONE,
  run: ['node', 'check.js'],
  runsOn: ['example-pc'],
  ...over,
})

describe('approval (routines/central.ts)', () => {
  test('an approval holds only for the routine a trusted key signed, exactly as it was signed', () => {
    const dir = temp('desk-central-keys-')
    const owner = approverKey(join(dir, 'owner.key'))
    const stranger = approverKey(join(dir, 'stranger.key'))
    const trusted = [{ name: 'Example Owner', key: owner.public }]
    const signed = approvedText(parseDoc('example-a', renderDoc(front({}), '')), owner, 'Example Owner', SIGNED_AT)

    expect(checkApproval(parseDoc('example-a', signed), trusted)).toEqual({ ok: true, by: 'Example Owner' })
    // Its display line is not signed: the store's page may change it.
    const described = signed.replace('"kind"', '"description": "A new line for the page",\n  "kind"')
    expect(checkApproval(parseDoc('example-a', described), trusted).ok).toBe(true)
    // Any change to what it runs, where or when stops it.
    const changed = signed.replace('"check.js"', '"other.js"')
    expect(checkApproval(parseDoc('example-a', changed), trusted)).toMatchObject({ ok: false, why: 'it changed after it was approved' })
    // The same text under another id is another routine: the signature names the id.
    expect(checkApproval(parseDoc('example-b', signed), trusted)).toMatchObject({ ok: false, why: 'its approval signature does not check out' })
    // A key this computer does not trust approves nothing, even one that signed correctly.
    const theirs = approvedText(parseDoc('example-a', renderDoc(front({}), '')), stranger, 'Example Owner', SIGNED_AT)
    expect(checkApproval(parseDoc('example-a', theirs), trusted).ok).toBe(false)
  })
})

// The fake Connections server: its `docs` tool keeps the store's documents in <dir>/state.json ({ repo, down, docs }), the
// sha of a text is sha256 of it with LF line ends, a put names the sha it replaces (docs_changed otherwise), and `down`
// answers in words as a signed-out Connections does.
const LOADER = `
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
const dir = process.argv[2]
const state = () => JSON.parse(readFileSync(dir + '/state.json', 'utf8'))
const save = (s) => writeFileSync(dir + '/state.json', JSON.stringify(s))
const sha = (t) => createHash('sha256').update(t.replace(/\\r\\n/g, '\\n')).digest('hex')
const fail = (error, detail) => JSON.stringify({ error, detail })
// Two Desks start a server each over the same state: one call at a time holds it.
function locked(fn) {
  for (;;) {
    try {
      mkdirSync(dir + '/lock')
      break
    } catch {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(dir + '/lock', { recursive: true, force: true })
  }
}
// The run board: one claim per routine, granted to the first runner that asks for a slot, renewed by its holder, taken
// over once its lease lapsed, and never granted for a newer slot while one runs; the run log keeps each event by id.
function runs(p) {
  const s = state()
  if (s.down || s.runsDown) return 'Connections is not signed in: open https://studio.example.com/device to sign in'
  if (p.repo !== s.repo) return fail('runs_not_found', 'no run board under ' + p.repo)
  s.claims ??= {}
  s.events ??= {}
  s.calls ??= []
  const now = Date.now()
  const c = s.claims[p.routine]
  if (p.action === 'claim' || p.action === 'end') s.calls.push({ action: p.action, routine: p.routine, slot: p.slot, runner: p.runner, leaseMs: p.leaseMs })
  if (p.action === 'claim') {
    const at = Date.parse(p.slot)
    const lapsed = c && c.endedAt === null && Date.parse(c.leaseUntil) < now
    const renew = c && c.slot === p.slot && c.holder === p.runner && c.endedAt === null
    if (!c || renew || (c.endedAt !== null && Date.parse(c.slot) < at) || (lapsed && Date.parse(c.slot) <= at))
      s.claims[p.routine] = { slot: p.slot, holder: p.runner, leaseUntil: new Date(now + p.leaseMs).toISOString(), endedAt: null }
    save(s)
    return JSON.stringify({ claim: s.claims[p.routine] })
  }
  if (p.action === 'end') {
    if (c && c.slot === p.slot && c.holder === p.runner && c.endedAt === null) c.endedAt = new Date(now).toISOString()
    save(s)
    return JSON.stringify({ claim: c ?? null })
  }
  if (p.action === 'report') {
    for (const e of p.events) s.events[e.id] = e
    save(s)
    return JSON.stringify({ kept: p.events.length })
  }
  if (p.action === 'latest') return JSON.stringify({ events: Object.values(s.events) })
  return fail('bad_action', p.action)
}
function docs(p) {
  const s = state()
  if (s.down) return 'Connections is not signed in: open https://studio.example.com/device to sign in'
  if (p.repo !== s.repo) return fail('docs_not_found', 'no docs under ' + p.repo)
  const doc = s.docs[p.path]
  const live = doc && !doc.retiredAt
  if (p.action === 'search')
    return JSON.stringify({ board: 'b', docs: Object.entries(s.docs).filter(([path]) => path.startsWith(p.folder)).map(([path, d]) => ({ path, sha: sha(d.text), retiredAt: d.retiredAt ?? null })) })
  if (p.action === 'get') return live ? JSON.stringify({ board: 'b', doc: { path: p.path, text: doc.text, sha: sha(doc.text) }, versions: [] }) : fail('docs_not_found', p.path)
  if (p.action === 'put') {
    if (live ? p.baseSha !== sha(doc.text) : p.baseSha !== undefined) return fail('docs_changed', p.path + ' is at another version')
    s.docs[p.path] = { text: p.text }
    save(s)
    return '[docs] ' + (live ? 'updated ' : 'created ') + p.path + ' in the CrAInium (version ' + sha(p.text).slice(0, 12) + ').'
  }
  if (p.action === 'retire') {
    if (!live) return fail('docs_not_found', p.path)
    doc.retiredAt = new Date().toISOString()
    save(s)
    return '[docs] retired ' + p.path + '.'
  }
  return fail('bad_action', p.action)
}
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') return send({ id: m.id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '1' } } })
  if (m.method !== 'tools/call') return
  const a = m.params.arguments
  const text = locked(() => (a.tool_name === 'docs' ? docs(a.params ?? {}) : a.tool_name === 'routine_runs' ? runs(a.params ?? {}) : 'no such tool'))
  send({ id: m.id, result: { content: [{ type: 'text', text }] } })
})
`

interface BoardClaim {
  slot: string
  holder: string
  leaseUntil: string
  endedAt: string | null
}

interface StoreState {
  repo: string
  /** Connections signed out: no tool answers. */
  down?: boolean
  /** Only the run board does not answer. */
  runsDown?: boolean
  docs: Record<string, { text: string; retiredAt?: string }>
  claims?: Record<string, BoardClaim>
  events?: Record<string, { type: string; source: string; subject: string; specversion: string; data: Record<string, unknown> }>
  /** Every claim and end the board was asked for, in order. */
  calls?: { action: string; routine: string; slot: string; runner: string; leaseMs?: number }[]
}

interface Rig {
  home: string
  /** The claude.json that names the fake Connections server. */
  config: string
  /** The store's documents, as the fake server keeps them. */
  store: { read(): StoreState; write(s: StoreState): void }
  /** This home's approver key (the plugin reads the same file), and another key the store config trusts. */
  ownKey: ApproverKey
  otherKey: ApproverKey
  /** The argv of a command that adds a line to `file`. */
  tick(file: string): string[]
}

/** The fake Connections server one or more Desks start: its folder, the claude.json that names it, its state (read and
 *  written under its lock), and an approver key every rig on it trusts. */
interface Cx {
  dir: string
  config: string
  store: { read(): StoreState; write(s: StoreState): void }
  otherKey: ApproverKey
}

function connections(): Cx {
  const dir = temp('desk-central-cx-')
  mkdirSync(join(dir, 'local-mcp'))
  writeFileSync(join(dir, 'local-mcp', 'loader.mjs'), LOADER)
  writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { connections: { command: process.execPath, args: [join(dir, 'local-mcp', 'loader.mjs'), dir] } } }))
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ repo: REPO, docs: {} }))
  const locked = <T>(fn: () => T): T => {
    for (;;) {
      try {
        mkdirSync(join(dir, 'lock'))
        break
      } catch {
        Bun.sleepSync(5)
      }
    }
    try {
      return fn()
    } finally {
      rmSync(join(dir, 'lock'), { recursive: true, force: true })
    }
  }
  return {
    dir,
    config: join(dir, 'claude.json'),
    store: {
      read: () => locked(() => JSON.parse(readFileSync(stateFile, 'utf8')) as StoreState),
      write: (s) => locked(() => writeFileSync(stateFile, JSON.stringify(s))),
    },
    otherKey: approverKey(join(dir, 'other.key')),
  }
}

/** A temp home whose routines-store.json names the fake store, as `runner` (example-pc unless given) carrying `labels` and
 *  trusting the server's other approver. */
function rig(cx: Cx = connections(), runner = 'example-pc', labels: string[] = []): Rig {
  const home = temp('desk-central-')
  mkdirSync(join(home, 'routines'), { recursive: true })
  writeFileSync(join(home, 'tick.cjs'), "require('node:fs').appendFileSync(process.argv[2], 'tick\\n'); console.log('ticked')\n")
  writeFileSync(
    join(home, 'routines-store.json'),
    JSON.stringify({ store: { kind: 'crainium', repo: REPO }, runner, labels, approverName: 'Example Owner', approvers: [{ name: 'Example Approver', key: cx.otherKey.public }] }),
  )
  return {
    home,
    config: cx.config,
    store: cx.store,
    ownKey: approverKey(join(home, 'routines-approver.key')),
    otherKey: cx.otherKey,
    tick: (file) => [process.execPath, join(home, 'tick.cjs'), file],
  }
}

/** The argv of a command that waits until `gate` exists (at most 20 seconds), then adds a line to `file`. */
function gated(cx: Cx, file: string, gate: string): string[] {
  const script = join(cx.dir, 'gated.cjs')
  writeFileSync(
    script,
    "const fs = require('node:fs'); const end = Date.now() + 20000; (function wait() { if (fs.existsSync(process.argv[3]) || Date.now() > end) { fs.appendFileSync(process.argv[2], 'tick\\n'); console.log('ticked'); return } setTimeout(wait, 20) })()\n",
  )
  return [process.execPath, script, file, gate]
}

/** Puts a routine document in the store: as it is, or approved by `key`. */
function putDoc(r: Pick<Rig, 'store'>, id: string, f: Record<string, unknown>, key?: ApproverKey, by = 'Example Approver'): void {
  const text = renderDoc(f, '')
  const s = r.store.read()
  s.docs[`routines/${id}.md`] = { text: key ? approvedText(parseDoc(id, text), key, by, SIGNED_AT) : text }
  r.store.write(s)
}

const docOf = (r: Rig, id: string) => parseDoc(id, r.store.read().docs[`routines/${id}.md`]!.text)

interface Desk {
  app: Hono
  clock: { now: number }
  stop(): Promise<void>
}

/** A Desk over the rig's home, reading the fake Connections server's config, its clock at `start`. */
function desk(r: Rig, start = at(2026, 10, 12, 9, 0) + 30_000): Desk {
  process.env.HYDRA_DESK_HOME = r.home
  const app = new Hono()
  const own: (() => void | Promise<void>)[] = []
  const settings: Record<string, unknown> = { routines: true }
  const ctx = {
    home: r.home,
    settings: () => settings as unknown as DeskSettings,
    updateSettings: (patch: Partial<DeskSettings>) => Object.assign(settings, patch),
    onStop: (fn: () => void | Promise<void>) => {
      own.push(fn)
      stops.push(fn)
    },
    deps: { mainClaudeJson: r.config },
  } as unknown as ServerContext
  const clock = { now: start }
  plugin(app, ctx, { now: () => clock.now, platform: 'win32' })
  return {
    app,
    clock,
    stop: async () => {
      for (const fn of own.splice(0)) {
        stops.splice(stops.indexOf(fn), 1)
        await fn()
      }
    },
  }
}

const OWNER = { 'X-Desk-Caller': 'window' }
const post = (d: Desk, body: unknown, headers: Record<string, string> = {}) =>
  d.app.request('/api/routines', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
const get = async (d: Desk, fresh = false): Promise<RoutinesStatus> => (await (await d.app.request(fresh ? '/api/routines?fresh=1' : '/api/routines')).json()) as RoutinesStatus
const routine = (s: RoutinesStatus, id: string) => s.routines.find((x) => x.id === id)
const ticks = (file: string): number => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter((l) => l === 'tick').length : 0)

/** Waits until `done` holds, or 20 seconds pass. */
async function until(done: () => boolean): Promise<void> {
  const end = Date.now() + 20_000
  while (!done() && Date.now() < end) await Bun.sleep(50)
}

/** Reads the status until `done` holds, or 20 seconds pass. */
async function settle(d: Desk, done: (s: RoutinesStatus) => boolean): Promise<RoutinesStatus> {
  const until = Date.now() + 20_000
  let s = await get(d)
  while (!done(s) && Date.now() < until) {
    await Bun.sleep(50)
    s = await get(d)
  }
  return s
}

describe('central routines through the plugin', () => {
  test("a central proposal waits, the owner's approve signs it into the store and it runs on its slot; one placed elsewhere never runs here; a local file of the same id wins", async () => {
    const r = rig()
    const here = join(r.home, 'here.txt')
    const there = join(r.home, 'there.txt')
    putDoc(r, 'example-central', front({ why: 'The owner asked for it every minute.', run: r.tick(here) }))
    putDoc(r, 'example-elsewhere', front({ title: 'Example elsewhere', run: r.tick(there), runsOn: ['other-pc'] }), r.otherKey)
    putDoc(r, 'example-local', front({ title: 'Example local (central)', run: r.tick(there) }), r.otherKey)
    writeFileSync(join(r.home, 'routines', 'example-local.json'), JSON.stringify({ name: 'Example local', askedBy, schedule: '0 9 * * *', run: r.tick(there) }))
    const d = desk(r)

    const first = await get(d, true)
    expect(first.store).toMatchObject({ repo: REPO, runner: 'example-pc', approverKey: r.ownKey.public, error: null })
    expect(first.proposals).toEqual([expect.objectContaining({ id: 'example-central', source: 'central', runsOn: ['example-pc'] })])
    expect(routine(first, 'example-elsewhere')).toMatchObject({ state: 'elsewhere', source: 'central', runsOn: ['other-pc'] })
    // The file is the one listed; the document of the same id is named as a problem, never run.
    expect(first.routines.filter((x) => x.id === 'example-local')).toEqual([expect.objectContaining({ name: 'Example local' })])
    expect(routine(first, 'example-local')?.source).toBeUndefined()
    expect(first.store?.problems.map((p) => p.id)).toEqual(['example-local'])

    // An agent cannot approve; the window can, and its key's signature goes to the store.
    expect((await post(d, { approve: 'example-central' })).status).toBe(403)
    expect((await post(d, { approve: 'example-central' }, OWNER)).status).toBe(200)
    expect(docOf(r, 'example-central').approval).toMatchObject({ by: 'Example Owner', key: r.ownKey.public })
    const approved = await get(d)
    expect(approved.proposals).toEqual([])
    expect(routine(approved, 'example-central')).toMatchObject({ state: 'idle', source: 'central' })

    // A minute on, its slot is due: it runs once here, and the routine placed on another computer does not.
    d.clock.now += 60_000
    await get(d, true)
    const ran = await settle(d, (s) => routine(s, 'example-central')?.runs.length === 1)
    expect(routine(ran, 'example-central')?.runs[0]).toMatchObject({ outcome: 'ok' })
    expect(ticks(here)).toBe(1)
    expect(ticks(there)).toBe(0)
    const refused = await post(d, { run: 'example-elsewhere' })
    expect(refused.status).toBe(409)
    expect(((await refused.json()) as { error: string }).error).toContain('other-pc')
    expect(ticks(there)).toBe(0)
  }, 40_000)

  test("an agent's central proposal lands in the store unapproved; the owner's edit is signed back, and an edit of a document that moved on is refused", async () => {
    const r = rig()
    putDoc(r, 'example-central', front({ run: r.tick(join(r.home, 'here.txt')) }), r.ownKey, 'Example Owner')
    const d = desk(r)
    await get(d, true)

    const proposal = { id: 'example-proposed', name: 'Example proposed', askedBy, why: 'The owner asked for a nightly check.', schedule: '0 2 * * *', run: ['node', 'nightly.js'], store: 'central' }
    expect((await post(d, { propose: { ...proposal, approval: { by: 'an agent' } } })).status).toBe(400)
    expect((await post(d, { propose: proposal })).status).toBe(200)
    // It runs on this computer in this computer's zone unless it says otherwise, and nobody has approved it.
    expect(docOf(r, 'example-proposed')).toMatchObject({ runsOn: ['example-pc'], approval: null, front: expect.objectContaining({ timeZone: ZONE }) })
    expect((await get(d)).proposals.map((p) => p.id)).toEqual(['example-proposed'])

    expect((await post(d, { edit: { id: 'example-central', set: { timeoutMinutes: 30 } } }, OWNER)).status).toBe(200)
    const edited = docOf(r, 'example-central')
    expect(edited.front.timeoutMinutes).toBe(30)
    expect(checkApproval(edited, [{ name: 'Example Owner', key: r.ownKey.public }]).ok).toBe(true)
    expect(routine(await get(d), 'example-central')).toMatchObject({ timeoutMinutes: 30, state: 'idle' })

    // Someone else changes the document (its page line, which leaves it approved) before this Desk reads it again.
    const s = r.store.read()
    s.docs['routines/example-central.md']!.text = s.docs['routines/example-central.md']!.text.replace('"kind"', '"description": "Changed elsewhere",\n  "kind"')
    r.store.write(s)
    const stale = await post(d, { edit: { id: 'example-central', set: { timeoutMinutes: 45 } } }, OWNER)
    expect(stale.status).toBe(409)
    expect(docOf(r, 'example-central').front).toMatchObject({ timeoutMinutes: 30, description: 'Changed elsewhere' })
  }, 40_000)

  test('with the store not answering, a restarted Desk runs its central routines from the copy on this computer', async () => {
    const r = rig()
    const here = join(r.home, 'here.txt')
    putDoc(r, 'example-central', front({ run: r.tick(here) }), r.ownKey, 'Example Owner')
    const a = desk(r)
    expect(routine(await get(a, true), 'example-central')).toMatchObject({ state: 'idle', source: 'central' })
    await a.stop()

    r.store.write({ ...r.store.read(), down: true })
    const b = desk(r)
    const down = await get(b, true)
    expect(down.store?.error).toContain('did not answer')
    expect(routine(down, 'example-central')).toMatchObject({ state: 'idle', source: 'central' })
    b.clock.now += 60_000
    await get(b, true)
    await settle(b, (s) => routine(s, 'example-central')?.runs.length === 1)
    expect(ticks(here)).toBe(1)
  }, 40_000)
})

// The zone the run board tests' routine keeps: one with no summer time that is not this computer's, so its slot is a fixed
// moment whatever zone the tests run in.
const OTHER_ZONE = ZONE === 'Asia/Kolkata' ? 'Asia/Tokyo' : 'Asia/Kolkata'
/** 14:30 on 2026-10-12 in OTHER_ZONE: 09:00 UTC in Kolkata (+05:30), 05:30 UTC in Tokyo (+09:00). */
const SLOT = OTHER_ZONE === 'Asia/Kolkata' ? Date.UTC(2026, 9, 12, 9, 0) : Date.UTC(2026, 9, 12, 5, 30)
const SLOT_ISO = new Date(SLOT).toISOString()

/** A routine any runner labelled example-pool may run, daily at 14:30 in OTHER_ZONE, whose run waits for `gate`. */
const shared = (cx: Cx, file: string, gate: string): Record<string, unknown> =>
  front({ title: 'Example shared', schedule: '30 14 * * *', timeZone: OTHER_ZONE, runsOn: ['example-pool'], timeoutMinutes: 30, run: gated(cx, file, gate) })

const eventsOf = (cx: Cx) => Object.values(cx.store.read().events ?? {})

describe('the run board: a routine any runner carrying its labels may run', () => {
  test('kept in another time zone, it runs once at its slot in that zone, on the one of two runners the board grants it to, and both cards show that run', async () => {
    const cx = connections()
    const out = join(cx.dir, 'ran.txt')
    const gate = join(cx.dir, 'go')
    putDoc(cx, 'example-shared', shared(cx, out, gate), cx.otherKey)
    const a = desk(rig(cx, 'example-a', ['example-pool']), SLOT - 30_000)
    const b = desk(rig(cx, 'example-b', ['example-pool']), SLOT - 30_000)
    // Its next run is 14:30 in its own zone, whatever zone this computer keeps.
    for (const d of [a, b]) expect(routine(await get(d, true), 'example-shared')).toMatchObject({ state: 'idle', nextRunAt: SLOT, timeZone: OTHER_ZONE })

    a.clock.now = SLOT + 30_000
    b.clock.now = SLOT + 30_000
    // A asks first: the board grants it the slot and it runs. B asks while that run lives, and is told where it runs.
    expect(routine(await get(a, true), 'example-shared')?.state).toBe('running')
    expect(routine(await get(b, true), 'example-shared')).toMatchObject({ state: 'running', reason: expect.stringContaining('on example-a'), runs: [] })

    writeFileSync(gate, '')
    const ran = await settle(a, (s) => routine(s, 'example-shared')?.runs.length === 1)
    expect(routine(ran, 'example-shared')?.runs[0]).toMatchObject({ outcome: 'ok' })
    await until(() => cx.store.read().claims?.['example-shared']?.endedAt != null && eventsOf(cx).some((e) => e.type === 'routine.ended'))
    // B asks again: that slot ran, so B leaves it behind without running it, and its card shows A's run from the run log.
    b.clock.now += 1000
    expect(routine(await get(b, true), 'example-shared')).toMatchObject({ state: 'idle', runs: [], latestRun: { runner: 'example-a', slot: SLOT, outcome: 'ok', lastLine: 'ticked' } })
    expect(routine(await get(a, true), 'example-shared')?.latestRun).toMatchObject({ runner: 'example-a', slot: SLOT, outcome: 'ok' })
    expect(ticks(out)).toBe(1)
    // The run log holds that run as CloudEvents from A's runner.
    const from = (type: string) => [type, 'urn:routine-runner:example-a', 'example-shared', '1.0']
    expect(eventsOf(cx).map((e) => [e.type, e.source, e.subject, e.specversion]).sort()).toEqual([from('routine.claimed'), from('routine.ended'), from('routine.started')])
  }, 60_000)

  test("its slot waits while another runner's lease lives or the board does not answer; a lapsed lease is taken over, renewed while the run lives and ended when it ends", async () => {
    const cx = connections()
    const out = join(cx.dir, 'ran.txt')
    const gate = join(cx.dir, 'go')
    putDoc(cx, 'example-shared', shared(cx, out, gate), cx.otherKey)
    const d = desk(rig(cx, 'example-b', ['example-pool']), SLOT - 30_000)
    await get(d, true)
    d.clock.now = SLOT + 30_000
    const look = async () => routine(await get(d, true), 'example-shared')

    // The board does not answer: the slot waits for it, and never runs unclaimed.
    cx.store.write({ ...cx.store.read(), runsDown: true })
    expect(await look()).toMatchObject({ state: 'due', reason: expect.stringContaining('run board did not answer') })

    // Another runner holds the slot under a live lease: it runs there.
    const gone = { slot: SLOT_ISO, holder: 'example-gone', leaseUntil: new Date(Date.now() + 600_000).toISOString(), endedAt: null }
    cx.store.write({ ...cx.store.read(), runsDown: false, claims: { 'example-shared': gone } })
    expect(await look()).toMatchObject({ state: 'running', reason: expect.stringContaining('on example-gone') })
    expect(ticks(out)).toBe(0)

    // Its lease lapses (that runner is gone): this runner takes the slot over and runs it.
    cx.store.write({ ...cx.store.read(), claims: { 'example-shared': { ...gone, leaseUntil: new Date(Date.now() - 1000).toISOString() } } })
    expect((await look())?.state).toBe('running')
    expect(cx.store.read().claims?.['example-shared']).toMatchObject({ holder: 'example-b', endedAt: null })

    // A quarter of its lease on, the run still living, the next look renews the claim; when the run ends, the claim ends.
    const lease = 2 * 30 * 60_000
    d.clock.now += lease / 4
    await look()
    writeFileSync(gate, '')
    await settle(d, (s) => routine(s, 'example-shared')?.runs.length === 1)
    await until(() => cx.store.read().claims?.['example-shared']?.endedAt != null)
    const asked = { routine: 'example-shared', slot: SLOT_ISO, runner: 'example-b' }
    expect(cx.store.read().calls?.filter((c) => c.runner === 'example-b')).toEqual([
      { action: 'claim', ...asked, leaseMs: lease }, // refused: example-gone's lease lives
      { action: 'claim', ...asked, leaseMs: lease }, // granted: the lapsed lease taken over
      { action: 'claim', ...asked, leaseMs: lease }, // renewed while the run lives
      { action: 'end', ...asked },
    ])
    expect(ticks(out)).toBe(1)
  }, 60_000)
})
