// Central routines (routines/central.ts, routines/manager-central.ts): an approval holds only for what a trusted key signed,
// and the routines plugin end to end over a temp home whose routines-store.json names a store, read and written through
// the real Connections client against a fake Connections server whose `docs` tool keeps the store in a file. Never the
// real home, the real store or a real routine.
//
// Each test answers the test-audit gate: the approval test guards the security contract (a routine runs only with a
// trusted key's signature over exactly what it holds now); the plugin tests guard /api/routines over a central store
// (a proposal waits, the owner's approve signs it into the store, runsOn places it, a local file of the same id wins, an
// edit is signed back with the sha it read, and the copy on this computer runs while the store is down).
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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
const dir = process.argv[2]
const state = () => JSON.parse(readFileSync(dir + '/state.json', 'utf8'))
const save = (s) => writeFileSync(dir + '/state.json', JSON.stringify(s))
const sha = (t) => createHash('sha256').update(t.replace(/\\r\\n/g, '\\n')).digest('hex')
const fail = (error, detail) => JSON.stringify({ error, detail })
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
  const text = a.tool_name === 'docs' ? docs(a.params ?? {}) : 'no such tool'
  send({ id: m.id, result: { content: [{ type: 'text', text }] } })
})
`

interface StoreState {
  repo: string
  down?: boolean
  docs: Record<string, { text: string; retiredAt?: string }>
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

/** A temp home whose routines-store.json names the fake store, as runner example-pc trusting one other approver. */
function rig(): Rig {
  const home = temp('desk-central-')
  const dir = temp('desk-central-cx-')
  mkdirSync(join(home, 'routines'), { recursive: true })
  writeFileSync(join(home, 'tick.cjs'), "require('node:fs').appendFileSync(process.argv[2], 'tick\\n'); console.log('ticked')\n")
  writeFileSync(join(dir, 'loader.mjs'), LOADER)
  writeFileSync(join(dir, 'claude.json'), JSON.stringify({ mcpServers: { connections: { command: process.execPath, args: [join(dir, 'loader.mjs'), dir] } } }))
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ repo: REPO, docs: {} }))
  const otherKey = approverKey(join(dir, 'other.key'))
  writeFileSync(
    join(home, 'routines-store.json'),
    JSON.stringify({ store: { kind: 'crainium', repo: REPO }, runner: 'example-pc', approverName: 'Example Owner', approvers: [{ name: 'Example Approver', key: otherKey.public }] }),
  )
  return {
    home,
    config: join(dir, 'claude.json'),
    store: { read: () => JSON.parse(readFileSync(stateFile, 'utf8')) as StoreState, write: (s) => writeFileSync(stateFile, JSON.stringify(s)) },
    ownKey: approverKey(join(home, 'routines-approver.key')),
    otherKey,
    tick: (file) => [process.execPath, join(home, 'tick.cjs'), file],
  }
}

/** Puts a routine document in the store: as it is, or approved by `key`. */
function putDoc(r: Rig, id: string, f: Record<string, unknown>, key?: ApproverKey, by = 'Example Approver'): void {
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

/** A Desk over the rig's home, reading the fake Connections server's config. */
function desk(r: Rig): Desk {
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
  const clock = { now: at(2026, 10, 12, 9, 0) + 30_000 }
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
