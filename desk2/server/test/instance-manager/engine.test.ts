// instance-manager/engine.ts over a stand-in AgentHydra: the world below is what AgentHydra would answer, and every
// open and move the manager asks for is recorded. A recovery is driven look by look, as the plugin's timer does.

import { expect, test } from 'bun:test'
import type { ManagedKind, RecoveryState } from '@shared/instance-manager'
import type { AccountProbe, Candidate, OpenChat, SeenInstance, TurnState } from '../../src/instance-manager/decide'
import {
  createInstanceManager,
  GRACE_MS,
  type InstanceManagerIO,
  type Landed,
  type MoveResult,
  OPEN_SETTLE_MS,
  READ_RETRY_MS,
  type Saved,
  WATCH_MS,
} from '../../src/instance-manager/engine'

const T0 = new Date(2026, 9, 15, 3, 0, 0).getTime()

function app(num: number, fields: Partial<SeenInstance> = {}): SeenInstance {
  return {
    ref: `desktop:C:/Users/me/.claude-instances/p${num}`,
    kind: 'desktop',
    num,
    name: `p${num}`,
    handle: `C:/Users/me/.claude-instances/p${num}`,
    email: `p${num}@example.com`,
    plan: 'Max 5×',
    running: true,
    signedIn: true,
    dead: null,
    ...fields,
  }
}

const codex = (num: number, fields: Partial<SeenInstance> = {}): SeenInstance =>
  app(num, { kind: 'codex', ref: `codex:id${num}`, handle: `id${num}`, plan: 'Plus', ...fields })

/** A chat open in an app: busy (seen working), or quiet (its engine alive, nothing written lately). */
const busy = (id: string, title: string, ref: string): OpenChat => ({ id, title, ref, busy: true, startedAt: null })
const quiet = (id: string, title: string, ref: string): OpenChat => ({ id, title, ref, busy: false, startedAt: T0 - 3_600_000 })

/** gate_chat's verdicts, as io.ts reads them. */
const gate = (state: string, fields: Partial<TurnState> = {}): TurnState => ({
  state,
  kind: null,
  idle: false,
  lane: null,
  quietSecs: 30,
  outstanding: 0,
  cause: '',
  ...fields,
})

interface World {
  now: number
  apps: SeenInstance[]
  open: OpenChat[]
  /** The gate's verdict on each chat (absent: it could not be read). */
  turns: Record<string, TurnState>
  gated: string[]
  usage: Record<number, [number, number]>
  logs: Record<string, string>
  probe: AccountProbe | null
  opened: number[]
  moves: { from: number; to: number; ids: string[]; text: string; terminateLive: boolean }[]
  /** The answer each started move gets: null while it runs. */
  moveAnswer: { results: MoveResult[] } | { error: string } | null
  /** What a Codex move answers at once. */
  codexMove: MoveResult[]
  landed: Record<string, Landed>
}

function world(apps: SeenInstance[], open: OpenChat[] = []): World {
  return {
    now: T0,
    apps,
    open,
    turns: {},
    gated: [],
    usage: {},
    logs: {},
    probe: { status: 'live', plan: 'Max 5×' },
    opened: [],
    moves: [],
    moveAnswer: null,
    codexMove: [],
    landed: {},
  }
}

function io(w: World): InstanceManagerIO {
  return {
    instances: async () => w.apps.map((a) => ({ ...a })),
    openChats: async () => [...w.open],
    turns: async (chats) => {
      w.gated.push(...chats.map((c) => c.id))
      return new Map(chats.map((c) => [c.id, w.turns[c.id] ?? null]))
    },
    candidates: async (kind: ManagedKind, seen) =>
      seen
        .filter((i) => i.kind === kind)
        .map((instance): Candidate => {
          const u = w.usage[instance.num]
          return { instance, fiveHourPct: u?.[0] ?? null, weeklyPct: u?.[1] ?? null, capPct: 85, known: u !== undefined }
        }),
    probe: async () => w.probe,
    appLog: async (inst) => w.logs[inst.ref] ?? null,
    open: async (inst) => {
      w.opened.push(inst.num)
      return { ok: true, detail: 'opened' }
    },
    startMove: async (from, to, ids, text, _key, terminateLive) => {
      w.moves.push({ from: from.num, to: to.num, ids, text, terminateLive })
      return from.kind === 'codex' ? { results: w.codexMove } : { operationId: `op${w.moves.length}` }
    },
    moveResult: async () => w.moveAnswer,
    chatsIn: async (_inst, ids) => new Map(ids.flatMap((id): [string, Landed][] => (w.landed[id] ? [[id, w.landed[id]]] : []))),
    now: () => w.now,
  }
}

const stamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

const empty = (): Saved => ({ memory: {}, recoveries: [] })

test('a crashed app with two working chats: the roomiest same-kind account is opened, the chats move there, start again and are seen running', async () => {
  const [a, b, c] = [app(1), app(2, { plan: 'Max 20×', running: false }), app(3)]
  const w = world([a, b, c], [busy('s1', 'Fix the parser', a.ref), busy('s2', 'Write docs', a.ref)])
  w.usage = { 2: [10, 40], 3: [0, 0] } // #2: 20 x 45 = 900 of room; #3: 5 x 85 = 425
  w.logs[a.ref] = `${stamp(T0 + 10_000)} [info] [process-memory] trigger=interval`
  const m = createInstanceManager(io(w), empty())
  await m.look(true)

  // #1 dies: no quit in its log.
  w.now += 20_000
  w.apps = [{ ...a, running: false }, b, c]
  w.open = []
  await m.look(true)
  expect(m.status(true, null).recoveries.map((r) => [r.state, r.chats.map((x) => x.id)])).toEqual([['waiting', ['s1', 's2']]])
  expect(w.opened).toEqual([])

  // Past the grace: a crash, so #2 (Max 20x, closed) is opened rather than #3. Both were seen working: no gate is asked.
  w.now += GRACE_MS
  await m.look(true)
  let r = m.status(true, null).recoveries[0]
  expect([r?.state, r?.cause, r?.to?.num, w.opened, w.gated]).toEqual(['opening', 'crashed', 2, [2], []])

  // #2 comes up; the chats move once it has settled.
  w.now += 20_000
  w.apps = [{ ...a, running: false }, { ...b, running: true }, c]
  await m.look(true)
  expect(w.moves).toEqual([])
  w.now += OPEN_SETTLE_MS
  await m.look(true)
  expect(w.moves.map((x) => [x.from, x.to, x.ids, x.terminateLive])).toEqual([[1, 2, ['s1', 's2'], false]])
  expect(w.moves[0]?.text).toContain('the app crashed')
  expect(m.status(true, null).recoveries[0]?.state).toBe('moving')

  // The move reports: both landed, one started again.
  w.now += 20_000
  w.moveAnswer = {
    results: [
      { id: 's1', landed: true, resumed: true, detail: '' },
      { id: 's2', landed: true, resumed: false, detail: 'the chat was mid-turn' },
    ],
  }
  await m.look(true)
  r = m.status(true, null).recoveries[0]
  expect([r?.state, r?.chats.map((x) => x.state)]).toEqual(['watching', ['moved', 'moved']])

  // One writes again, the other is seen working: both run, and the recovery is done.
  w.now += 20_000
  w.landed = { s1: { archived: false, activeSince: true } }
  w.open = [busy('s2', 'Write docs', b.ref)]
  await m.look(true)
  r = m.status(true, null).recoveries[0]
  expect([r?.state, r?.detail, r?.chats.map((x) => x.state)]).toEqual(['done', '2 of 2 chats run again in #2 p2', ['running', 'running']])
  expect(w.moves).toHaveLength(1)
})

test('a crash moves only the chats it cut off: one in a long tool call, one waiting on its background jobs; a finished one and one a person stopped stay', async () => {
  const [a, b] = [app(1), app(2)]
  // Nothing was written in the last 30 s, so none reads as working: only the gate tells them apart.
  const w = world([a, b], [
    quiet('long', 'Run the full build', a.ref),
    quiet('jobs', 'Wait on the workflow', a.ref),
    quiet('done', 'Answered a question', a.ref),
    quiet('stopped', 'Interrupted by a person', a.ref),
    quiet('lost', 'Its transcript is unreadable', a.ref),
  ])
  w.usage = { 2: [0, 0] }
  w.logs[a.ref] = `${stamp(T0 + 10_000)} [info] [process-memory] trigger=interval`
  const m = createInstanceManager(io(w), empty())
  await m.look(true)
  w.now += 20_000
  w.apps = [{ ...a, running: false }, b]
  w.open = []
  await m.look(true)

  // The first read leaves one verdict unread: the gate is asked again rather than the chat being judged on nothing.
  w.turns = {
    long: gate('crashed', { kind: 'mid-turn', cause: 'died mid-turn (last record: a tool call whose result never landed)' }),
    jobs: gate('finished', { lane: 'needs-input-review', outstanding: 2 }),
    done: gate('finished', { lane: 'archive-candidate' }),
    stopped: gate('finished', { lane: 'human', outstanding: 1 }),
  }
  w.now += GRACE_MS
  await m.look(true)
  expect([m.status(true, null).recoveries[0]?.state, w.moves]).toEqual(['waiting', []])

  // Past the reread window the unread one stays too; the two cut off move into the running #2 and start again.
  w.now += READ_RETRY_MS
  await m.look(true)
  const r = m.status(true, null).recoveries[0]
  expect(w.moves.map((x) => [x.from, x.to, x.ids])).toEqual([[1, 2, ['long', 'jobs']]])
  expect(r?.chats.map((c) => [c.id, c.state])).toEqual([
    ['long', 'pending'],
    ['jobs', 'pending'],
    ['done', 'stays'],
    ['stopped', 'stays'],
    ['lost', 'stays'],
  ])
  expect(r?.chats.find((c) => c.id === 'jobs')?.detail).toContain('2 background jobs')
  expect(w.moves[0]?.text).toContain('background job')

  // An app whose open chats had all finished is said and left: nothing is opened or moved.
  const w2 = world([a, b], [quiet('done', 'Answered a question', a.ref)])
  w2.usage = { 2: [0, 0] }
  w2.turns = { done: gate('finished', { lane: 'archive-candidate' }) }
  w2.logs[a.ref] = w.logs[a.ref] as string
  const m2 = createInstanceManager(io(w2), empty())
  await m2.look(true)
  w2.now += 20_000
  w2.apps = [{ ...a, running: false }, b]
  w2.open = []
  await m2.look(true)
  w2.now += GRACE_MS
  await m2.look(true)
  const left = m2.status(true, null).recoveries[0]
  expect([left?.state, left?.chats[0]?.state, w2.moves, w2.opened]).toEqual(['left', 'stays', [], []])
  expect(left?.detail).toContain('none of its 1 open chat was cut off')
})

test('an app left open whose account died is down: its chats move off it with their engines stopped, and a dead account is never where they go', async () => {
  const [a, b] = [app(1), app(2, { plan: 'Max 5×' })]
  const free = app(3, { plan: 'Free', running: false, dead: 'its plan reads Free, and Claude Code does not run on Free' })
  const w = world([a, b, free], [busy('s1', 'Fix the parser', a.ref)])
  w.usage = { 2: [50, 50], 3: [0, 0] } // the Free account reads more room, and is still never chosen
  const m = createInstanceManager(io(w), empty())
  await m.look(true)

  // Its organization is disabled: the app stays open and signed in, and every chat fails.
  w.now += 20_000
  const dead = 'its log: Session local_x query error: Claude Code returned an error result: Your organization has disabled Claude subscription access'
  w.apps = [{ ...a, dead }, b, free]
  w.open = []
  await m.look(true)
  expect(m.status(true, null).recoveries[0]?.detail).toContain('its account stopped working')
  w.now += GRACE_MS
  await m.look(true)
  const r = m.status(true, null).recoveries[0]
  expect([r?.cause, r?.causeDetail, r?.to?.num]).toEqual(['account-dead', dead, 2])
  expect(w.moves.map((x) => [x.from, x.to, x.ids, x.terminateLive])).toEqual([[1, 2, ['s1'], true]])
  expect(w.moves[0]?.text).toContain('its account stopped working')
})

test('a clean quit, a Codex app closed for no known reason, an app that comes back by itself, several apps at once and a manager switched off move nothing', async () => {
  const quitLine = (ms: number) => `${stamp(ms)} [info] beforeQuit: handler is ready for quit, so quitting`
  const cases: { name: string; start?: SeenInstance[]; run: (w: World) => SeenInstance[]; enabled: boolean; state: RecoveryState }[] = [
    { name: 'quit', run: (w) => ((w.logs[app(1).ref] = quitLine(T0 + 15_000)), [{ ...app(1), running: false }, app(2)]), enabled: true, state: 'left' },
    {
      name: 'codex closed',
      start: [codex(1), codex(2), codex(3)],
      run: () => [{ ...codex(1), running: false }, codex(2), codex(3)],
      enabled: true,
      state: 'left',
    },
    { name: 'came back', run: () => [app(1), app(2)], enabled: true, state: 'came-back' },
    {
      name: 'three at once',
      run: () => [{ ...app(1), running: false }, { ...app(2), running: false }, { ...app(3), running: false }],
      enabled: true,
      state: 'left',
    },
    { name: 'off', run: () => [{ ...app(1), running: false }, app(2)], enabled: false, state: 'left' },
  ]
  for (const k of cases) {
    const ups = k.start ?? [app(1), app(2), app(3)]
    const w = world(ups, ups.map((u) => busy(`chat-${u.num}`, 'Some work', u.ref)))
    w.usage = { 2: [0, 0], 3: [0, 0] }
    const m = createInstanceManager(io(w), empty())
    await m.look(k.enabled)
    w.now += 20_000
    w.apps = k.name === 'came back' ? [{ ...app(1), running: false }, app(2), app(3)] : k.run(w)
    w.open = []
    await m.look(k.enabled)
    w.now += GRACE_MS
    if (k.name === 'came back') w.apps = k.run(w)
    await m.look(k.enabled)
    expect([k.name, m.status(k.enabled, null).recoveries.map((r) => r.state)]).toEqual([k.name, k.name === 'three at once' ? ['left', 'left', 'left'] : [k.state]])
    expect([k.name, w.opened, w.moves]).toEqual([k.name, [], []])
  }
})

test('an app that comes back while an account is being opened for its chats keeps them: nothing is moved', async () => {
  const [a, b] = [app(1), app(2, { plan: 'Max 20×', running: false })]
  const w = world([a, b], [busy('s1', 'Fix the parser', a.ref)])
  w.usage = { 2: [0, 0] }
  w.logs[a.ref] = `${stamp(T0 + 10_000)} [info] [process-memory] trigger=interval`
  const m = createInstanceManager(io(w), empty())
  await m.look(true)
  w.now += 20_000
  w.apps = [{ ...a, running: false }, b]
  w.open = []
  await m.look(true)
  w.now += GRACE_MS
  await m.look(true)
  expect([m.status(true, null).recoveries[0]?.state, w.opened]).toEqual(['opening', [2]])

  // A person starts #1 again; then #2 comes up too.
  w.now += 20_000
  w.apps = [a, b]
  w.open = [busy('s1', 'Fix the parser', a.ref)]
  await m.look(true)
  w.now += 20_000
  w.apps = [a, { ...b, running: true }]
  w.now += OPEN_SETTLE_MS
  await m.look(true)
  expect([m.status(true, null).recoveries[0]?.state, w.moves]).toEqual(['came-back', []])
})

test('two apps down together wait on one app opened for both, and give up after two opens rather than opening every account', async () => {
  const crash = `${stamp(T0 + 10_000)} [info] [process-memory] trigger=interval`
  const [a, b] = [app(1), app(2)]
  const closed = [app(3, { plan: 'Max 20×', running: false }), app(4, { plan: 'Max 5×', running: false }), app(5, { plan: 'Pro', running: false })]
  const w = world([a, b, ...closed], [busy('s1', 'Fix the parser', a.ref), busy('s2', 'Write docs', b.ref)])
  w.usage = { 3: [0, 0], 4: [0, 0], 5: [0, 0] }
  w.logs = { [a.ref]: crash, [b.ref]: crash }
  const m = createInstanceManager(io(w), empty())
  await m.look(true)
  w.now += 20_000
  w.apps = [{ ...a, running: false }, { ...b, running: false }, ...closed]
  w.open = []
  await m.look(true)
  w.now += GRACE_MS
  await m.look(true)
  expect([m.status(true, null).recoveries.map((r) => [r.state, r.to?.num]), w.opened]).toEqual([[['opening', 3], ['opening', 3]], [3]])

  // #3 never comes up: both pass it, and #4 is opened once for both.
  w.now += 3 * 60_000
  await m.look(true)
  w.now += 20_000
  await m.look(true)
  expect(w.opened).toEqual([3, 4])

  // #4 never comes up either: both give up, and #5 is never opened.
  w.now += 3 * 60_000
  await m.look(true)
  w.now += 20_000
  await m.look(true)
  expect([m.status(true, null).recoveries.map((r) => r.state), w.opened, w.moves]).toEqual([['failed', 'failed'], [3, 4], []])
})

test('a Desk restart mid-move polls the same move and starts no second one; a chat already being recovered is not taken twice', async () => {
  const [a, b] = [app(1, { signedIn: true }), app(2)]
  const w = world([a, b], [busy('s1', 'Fix the parser', a.ref)])
  w.usage = { 2: [0, 0] }
  const m1 = createInstanceManager(io(w), empty())
  await m1.look(true)
  // Signed out under a running app: its engines are stopped on the move.
  w.now += 20_000
  w.apps = [{ ...a, signedIn: false }, b]
  w.open = []
  await m1.look(true)
  w.now += GRACE_MS
  await m1.look(true)
  expect(w.moves.map((x) => [x.to, x.ids, x.terminateLive])).toEqual([[2, ['s1'], true]])
  expect(m1.status(true, null).recoveries[0]?.cause).toBe('logged-out')

  // Desk restarts: the saved state round-trips through JSON, as instance-manager.json does.
  const m2 = createInstanceManager(io(w), JSON.parse(JSON.stringify(m1.saved())) as Saved)
  w.now += 20_000
  await m2.look(true)
  expect(w.moves).toHaveLength(1)
  w.moveAnswer = { results: [{ id: 's1', landed: true, resumed: true, detail: '' }] }
  w.now += 20_000
  await m2.look(true)
  expect(m2.status(true, null).recoveries[0]?.state).toBe('watching')

  // Not seen running within the watch window: stuck, for a person.
  w.now += WATCH_MS
  await m2.look(true)
  const r = m2.status(true, null).recoveries[0]
  expect([r?.state, r?.chats[0]?.state]).toEqual(['done', 'stuck'])
  expect(w.moves).toHaveLength(1)
})

test('a Codex app signed out as it closes moves its working chats to another Codex account, never to a Claude one, and says the Codex app continues them', async () => {
  const [x, y] = [codex(10, { plan: 'Pro Lite' }), codex(11, { running: false })]
  const claude = app(2, { plan: 'Max 20×' })
  const w = world([x, y, claude], [busy('t1', 'Port the CLI', x.ref)])
  w.usage = { 11: [0, 10], 2: [0, 0] }
  w.codexMove = [{ id: 't1', landed: true, resumed: false, detail: '', newId: 't1-new' }]
  const m = createInstanceManager(io(w), empty())
  await m.look(true)
  w.now += 20_000
  w.apps = [{ ...x, running: false, signedIn: false }, y, claude]
  w.open = []
  await m.look(true)
  w.now += GRACE_MS
  await m.look(true)
  expect(w.opened).toEqual([11])
  w.now += 20_000
  w.apps = [{ ...x, running: false, signedIn: false }, { ...y, running: true }, claude]
  await m.look(true)
  w.now += OPEN_SETTLE_MS
  await m.look(true)
  expect(w.moves.map((v) => [v.from, v.to, v.ids])).toEqual([[10, 11, ['t1']]])
  w.now += 20_000
  await m.look(true)
  const r = m.status(true, null).recoveries[0]
  expect([r?.state, r?.detail, r?.chats[0]?.state]).toEqual(['done', '1 of 1 chat moved to #11 p11', 'moved'])
  expect(r?.chats[0]?.detail).toContain('Codex app')
})
