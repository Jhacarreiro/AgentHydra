// instance-manager/io.ts with the engine, over HTTP against a stand-in AgentHydra that answers in the shapes the real
// daemon answers (read from it on 2026-10-15), and real app logs in a temp folder. What it guards is the protocol: the
// fleet's live engines become the chats the manager remembers (its refs spell the drive letter differently from the
// app's), the gate is asked about a quiet chat with its engine's start, the move goes to migrate_batch with its argv and
// idempotency key, its report is read past what the script printed first, and the new app's chat list confirms the
// chats run. Only the clock is the test's: the engine's waits are minutes long.

import { afterAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExternalSession } from '@shared/protocol'
import { createInstanceManager, GRACE_MS, OPEN_SETTLE_MS } from '../../src/instance-manager/engine'
import { daemonIO } from '../../src/instance-manager/io'

const root = mkdtempSync(join(tmpdir(), 'im-io-'))
const stubs: { stop: (force: boolean) => void }[] = []
afterAll(() => {
  for (const s of stubs) s.stop(true)
  if (root.startsWith(tmpdir()) && root.includes('im-io-')) rmSync(root, { recursive: true, force: true })
})

const T0 = new Date(2026, 9, 15, 3, 0, 0).getTime()
const stamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

/** A Claude profile folder with its main.log. */
function profile(name: string, ...lines: [number, string][]): string {
  const dir = join(root, name)
  mkdirSync(join(dir, 'logs'), { recursive: true })
  writeFileSync(join(dir, 'logs', 'main.log'), `${lines.map(([ms, t]) => `${stamp(ms)} [info] ${t}`).join('\n')}\n`)
  return dir
}

const ext = (id: string, fields: Partial<ExternalSession>): ExternalSession => ({
  id,
  title: id,
  cwd: null,
  source: 'desktop',
  instance: null,
  status: 'idle',
  activity: null,
  lastActivityAt: null,
  model: null,
  accountId: null,
  canResume: false,
  fromPc: null,
  pinned: false,
  archived: false,
  unread: false,
  group: null,
  ...fields,
})

interface Run {
  script: string
  args: string[]
  key: string | null
  async: boolean
}

/** A stand-in AgentHydra: `routes` answers by method and path, and every orchestrator run is recorded. */
function standIn(routes: (method: string, url: URL, body: Record<string, unknown>) => { status?: number; body: unknown } | null) {
  const runs: Run[] = []
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      const body = req.method === 'POST' ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
      if (url.pathname === '/api/orchestrator/run')
        runs.push({ script: String(body.script), args: body.args as string[], key: req.headers.get('x-idempotency-key'), async: body.async === true })
      const a = routes(req.method, url, body)
      return a ? Response.json(a.body, { status: a.status ?? 200 }) : Response.json({ error: 'not here' }, { status: 404 })
    },
  })
  stubs.push(server)
  return { base: `http://127.0.0.1:${server.port}`, runs }
}

test('a Claude app that crashes: its working chat and its quiet one mid-tool-call move to the roomiest live account and are seen running', async () => {
  let clock = T0
  const p1 = profile('p1', [T0 - 60_000, '[Stop hook] Query completed for session local_a'], [T0 + 5_000, '[process-memory] trigger=interval'])
  const p2 = profile('p2', [T0 - 60_000, '[Stop hook] Query completed for session local_b'])
  const p3 = profile('p3')
  const app = { p1Running: true, opStatus: 'running', moved: false }
  // AgentHydra writes an app's ref with a lower-case drive letter and an engine's with the upper-case one.
  const ref = (dir: string) => `desktop:${dir.replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`)}`
  const engineRef = (dir: string) => `desktop:${dir.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`)}`
  const s2Started = T0 - 3_600_000
  const verdict = {
    session_id: 's2',
    quiet_secs: 95,
    live: null,
    crashed: { kind: 'mid-turn' },
    finished: null,
    stalled: null,
    idle: null,
    state: 'crashed',
    cause: 'died mid-turn (last record: a tool call whose result never landed)',
    background: { scanned: true, outstanding: [], launched: 0, notified: 0, why: 'no background job outstanding' },
  }
  const report = {
    ok: true,
    moved: 2,
    results: [
      { chat: 's1', landed: true, resume: { delivered: true, staged: false, why: 'delivered' } },
      { chat: 's2', landed: true, resume: { delivered: true, staged: false, why: 'delivered' } },
    ],
  }
  const hydra = standIn((method, url, body) => {
    const path = url.pathname
    if (path === '/api/fleet')
      return {
        body: {
          instances: [
            { num: 1, name: 'p1', dir: p1, ref: ref(p1), isRunning: app.p1Running, signedIn: true, account: { status: 'cache', email: 'p1@example.com', planLabel: 'Max 5×' } },
            { num: 2, name: 'p2', dir: p2, ref: ref(p2), isRunning: true, signedIn: true, account: { status: 'cache', email: 'p2@example.com', planLabel: 'Max 20×' } },
            { num: 3, name: 'p3', dir: p3, ref: ref(p3), isRunning: false, signedIn: true, account: { status: 'cache', email: 'p3@example.com', planLabel: 'Free' } },
          ],
          sessions: app.p1Running
            ? [
                { name: 'Fix the parser', pid: 11, sessionId: 's1', startedAt: T0 - 600_000, instanceRef: engineRef(p1), transcript: { path: join(p1, 's1.jsonl') } },
                { name: 'Run the full build', pid: 12, sessionId: 's2', startedAt: s2Started, instanceRef: engineRef(p1), transcript: { path: join(p1, 's2.jsonl') } },
                // A spare engine the app keeps warm: no transcript, no chat's work.
                { name: '', pid: 13, sessionId: 'spare', startedAt: T0 - 60_000, instanceRef: engineRef(p1), transcript: { path: null } },
              ]
            : [],
        },
      }
    if (path === '/api/codex-instances') return { body: [] }
    if (path === '/api/usage/survey')
      return {
        body: {
          rows: [
            { kind: 'desktop', num: 2, result: { snapshot: { session: { pct: 10 }, weekAll: { pct: 20 } } }, advice: { severity: 'ok' } },
            { kind: 'desktop', num: 3, result: { snapshot: { session: { pct: 0 }, weekAll: { pct: 0 } } }, advice: { severity: 'ok' } },
          ],
        },
      }
    if (path.startsWith('/api/instances/') && path.endsWith('/account')) return { body: { status: 'live', planLabel: 'Max 5×' } }
    if (path === '/api/orchestrator/run' && body.script === 'gate_chat')
      return { body: { ok: true, exitCode: 0, stdout: `${JSON.stringify(verdict, null, 2)}\n`, stderr: '' } }
    if (path === '/api/orchestrator/run' && body.script === 'migrate_batch') return { status: 202, body: { ok: true, operationId: 'op-1', status: 'running', reused: false } }
    if (path === '/api/orchestrator/operations/op-1')
      return app.opStatus === 'running'
        ? { body: { id: 'op-1', status: 'running' } }
        : { body: { id: 'op-1', status: 'succeeded', result: { exitCode: 0, stdout: `moving 2 chats\n${JSON.stringify(report, null, 2)}\n`, stderr: '' } } }
    if (path === '/api/chats' && url.searchParams.get('instance') === '2')
      return { body: { rows: app.moved ? [{ instance: 'p2', sessionId: 's1', lastActivityAt: new Date(clock).toISOString(), isArchived: false }] : [] } }
    if (method === 'POST' && path.endsWith('/open')) return { body: { ok: true, message: 'opened' } }
    return null
  })
  // Desk's own list: s1 wrote just now; s2 is inside one long tool call and reads idle.
  let outside: ExternalSession[] = [
    ext('s1', { title: 'Fix the parser', instance: 'p1', status: 'working' }),
    ext('s2', { title: 'Run the full build', instance: 'p1', status: 'idle' }),
  ]
  const io = { ...daemonIO({ base: hydra.base, outside: async () => outside }), now: () => clock }
  const m = createInstanceManager(io, { memory: {}, recoveries: [] })
  await m.look(true)
  expect(m.status(true, null).instances.map((i) => [i.num, i.working, i.dead !== null])).toEqual([
    [1, 1, false],
    [2, 0, false],
    [3, 0, true],
  ])

  // #1 dies without quitting; its engines go with it.
  clock += 20_000
  app.p1Running = false
  outside = []
  await m.look(true)
  expect(m.status(true, null).recoveries.map((r) => [r.state, r.chats.map((c) => c.id)])).toEqual([['waiting', ['s1', 's2']]])

  // Past the grace: the quiet one is gated with its engine's start, the working one is not; #2 is up and takes both.
  clock += GRACE_MS
  await m.look(true)
  expect(hydra.runs.map((r) => [r.script, r.async])).toEqual([
    ['gate_chat', false],
    ['migrate_batch', true],
  ])
  expect(hydra.runs[0]?.args).toEqual(['s2', '--json', '--background', '--engine-started', String(s2Started)])
  const move = hydra.runs[1] as Run
  const at = move.args.indexOf('--resume')
  expect(move.args.slice(0, at)).toEqual(['--from', '1', '--to', '2', '--stop-idle', '--now', '--idle-wait', '0', '--json', '--chat', 's1', '--chat', 's2'])
  expect(move.args[at + 1]).toContain('the app crashed')
  expect(move.args).not.toContain('--terminate-live')
  const r = m.status(true, null).recoveries[0]
  expect([r?.state, r?.cause, r?.to?.num, move.key]).toEqual(['moving', 'crashed', 2, `instance-manager:${r?.id}:${ref(p2)}`])

  // The move is still running at the next look; then it reports, past the line it printed first.
  clock += 20_000
  await m.look(true)
  expect(m.status(true, null).recoveries[0]?.state).toBe('moving')
  app.opStatus = 'succeeded'
  clock += 20_000
  await m.look(true)
  expect(m.status(true, null).recoveries[0]?.chats.map((c) => c.state)).toEqual(['moved', 'moved'])

  // s1 writes in #2 (its chat list says so); s2 is seen working there in Desk's list.
  clock += 20_000
  app.moved = true
  outside = [ext('s2', { title: 'Run the full build', instance: 'p2', status: 'working' })]
  await m.look(true)
  const done = m.status(true, null).recoveries[0]
  expect([done?.state, done?.detail, done?.chats.map((c) => c.state)]).toEqual(['done', '2 of 2 chats run again in #2 p2', ['running', 'running']])
  expect(hydra.runs.filter((x) => x.script === 'migrate_batch')).toHaveLength(1)
})

test('a Codex app signed out as it closes: its chat moves to another Codex account that is opened for it, through the move-chats plan', async () => {
  let clock = T0
  const app = { x: true, y: false }
  const calls: string[] = []
  const hydra = standIn((method, url, body) => {
    const path = url.pathname
    if (path !== '/api/fleet' && path !== '/api/codex-instances') calls.push(`${method} ${path}${url.search}${method === 'POST' ? ` ${JSON.stringify(body)}` : ''}`)
    if (path === '/api/fleet') return { body: { instances: [], sessions: [] } }
    if (path === '/api/codex-instances')
      return {
        body: [
          { id: 'cx1', num: 203, name: 'x', isDesktopRunning: app.x, loggedIn: app.x, isExternal: false, account: { email: 'x@example.com', planLabel: 'Plus' } },
          { id: 'cx2', num: 204, name: 'y', isDesktopRunning: app.y, loggedIn: true, isExternal: false, account: { email: 'y@example.com', planLabel: 'Pro' } },
        ],
      }
    if (path === '/api/codex-instances/cx1/account') return { body: { status: 'loggedout' } }
    if (path === '/api/codex-instances/cx2/usage') return { body: { snapshot: { session: null, weekAll: { pct: 10 } } } }
    if (path === '/api/codex-instances/cx2/desktop/open') {
      app.y = true
      return { body: { ok: true, message: 'opened' } }
    }
    if (path === '/api/codex-instances/cx1/move-chats')
      return { body: { chats: [{ id: 't1', updatedAt: 1_700 }], sourceAccountId: 'acc-x', targetAccountId: 'acc-y' } }
    if (path === '/api/codex-instances/cx1/move-chat') return { body: { ok: true, destinationThreadId: 't1-new' } }
    return null
  })
  let outside = [ext('t1', { source: 'codex', title: 'Port the CLI', status: 'working', codexAccountId: 'cx1' })]
  const io = { ...daemonIO({ base: hydra.base, outside: async () => outside }), now: () => clock }
  const m = createInstanceManager(io, { memory: {}, recoveries: [] })
  await m.look(true)
  clock += 20_000
  app.x = false
  outside = []
  await m.look(true)
  clock += GRACE_MS
  await m.look(true)
  clock += 20_000
  await m.look(true)
  clock += OPEN_SETTLE_MS
  await m.look(true)
  clock += 20_000
  await m.look(true)
  expect(calls).toEqual([
    'GET /api/codex-instances/cx1/account',
    'GET /api/codex-instances/cx2/usage',
    'POST /api/codex-instances/cx2/desktop/open {"raise":false}',
    'GET /api/codex-instances/cx1/move-chats?targetId=cx2',
    'POST /api/codex-instances/cx1/move-chat {"targetId":"cx2","threadId":"t1","updatedAt":1700,"sourceAccountId":"acc-x","targetAccountId":"acc-y"}',
  ])
  expect(hydra.runs).toEqual([])
  const r = m.status(true, null).recoveries[0]
  expect([r?.cause, r?.state, r?.detail]).toEqual(['logged-out', 'done', '1 of 1 chat moved to #204 y'])
})
