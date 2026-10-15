// instance-manager/decide.ts: noticing an app that went down with chats open in it, why it went down (from Claude
// Desktop's own log lines and the account), which chats it cut off mid-work, and which same-kind account takes them.

import { expect, test } from 'bun:test'
import {
  type Candidate,
  causeOf,
  cutOff,
  deadFromLog,
  detect,
  ERROR_WITH_DOWN_MS,
  FORGET_MS,
  rankTargets,
  type SeenInstance,
  STALE_MEMORY_MS,
  type TurnState,
} from '../../src/instance-manager/decide'

const NOW = new Date(2026, 9, 15, 3, 40, 0).getTime()

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

const stamp = (ms: number): string => {
  const d = new Date(ms)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const log = (...lines: [number, string][]): string => lines.map(([ms, text]) => `${stamp(ms)} [info] ${text}`).join('\n')

test('an app that was up with chats open and is down now is noticed once; idle, never-up and stale apps are not', () => {
  const a = app(1)
  const b = app(2)
  const c = app(3)
  // s2 is in one long tool call: its engine lives, but it wrote nothing within Desk's working window.
  const open = [
    { id: 's1', title: 'Fix the parser', ref: a.ref, busy: true, startedAt: null },
    { id: 's2', title: 'Run the full build', ref: a.ref, busy: false, startedAt: NOW - 600_000 },
  ]
  const first = detect({}, [a, b, c], open, NOW)
  expect(first.down).toEqual([])

  // a closes with its two chats; b closes with nothing open; c is signed out while still running. a's account reads
  // no address once signed out, and keeps the one it had, so the same account is still told apart.
  const second = detect(first.memory, [{ ...a, running: false, email: null }, { ...b, running: false }, { ...c, signedIn: false }], [], NOW + 20_000)
  expect(second.down.map((d) => [d.instance.num, d.closed, d.chats.map((x) => [x.id, x.busy, x.startedAt]), d.instance.email])).toEqual([
    [
      1,
      true,
      [
        ['s1', true, null],
        ['s2', false, NOW - 600_000],
      ],
      'p1@example.com',
    ],
  ])
  expect(second.down[0]?.lastUpAt).toBe(NOW)

  // Open but with its account dead (its log says so, or its plan reads Free): not up, so an app that turns so is down.
  const dead = detect(first.memory, [{ ...a, dead: 'its log: Your organization has disabled Claude subscription access' }], [], NOW + 20_000)
  expect(dead.down.map((d) => [d.instance.num, d.closed])).toEqual([[1, false]])

  // Still down a look later: not noticed again.
  expect(detect(second.memory, [{ ...a, running: false }], [], NOW + 40_000).down).toEqual([])

  // A memory older than STALE_MEMORY_MS (Desk was not running) says nothing about what the app was doing.
  const stale = detect(first.memory, [{ ...a, running: false }], [], NOW + STALE_MEMORY_MS + 1)
  expect(stale.down).toEqual([])

  // An app the read did not list keeps its memory, so it is still noticed when it comes back down in a later read.
  const dropped = detect(first.memory, [b], [], NOW + 20_000)
  expect(detect(dropped.memory, [{ ...a, running: false }], [], NOW + 40_000).down.map((d) => d.instance.num)).toEqual([1])
  // One unlisted for FORGET_MS was removed: it is forgotten, not carried in every later memory.
  expect(Object.keys(detect(dropped.memory, [b], [], NOW + FORGET_MS + 1).memory)).toEqual([b.ref])
})

test('why it went down: a sign-out or a dead account beats a clean quit, start-up noise is not a sign-out, and a log that stops without a quit is a crash', () => {
  const lastUp = NOW - 60_000
  const down = { closed: true, lastUpAt: lastUp, instance: { signedIn: true, plan: 'Max 5×', kind: 'desktop' as const, dead: null } }
  const quit = log([lastUp - 10_000, 'beforeQuit: handler is ready for quit, so quitting'], [lastUp + 5_000, 'willQuit: handler is ready for quit, so quitting'])
  expect(causeOf(down, { status: 'live', plan: 'Max 5×' }, quit).cause).toBe('quit')

  const signOut = '[account] Login-state transition (loggedOut: false → true, uuid: a1 → <none>), clearing oauth cache'
  const quitting = 'beforeQuit: handler is ready for quit, so quitting'
  expect(causeOf(down, null, log([lastUp + 1_000, signOut], [lastUp + 2_000, quitting])).cause).toBe('logged-out')

  // What every start and a routine token refresh write is not a sign-out, nor is one undone by signing in again.
  const startNoise = log(
    [lastUp - 20_000, '[account] User is logged out, skipping account ID wait'],
    [lastUp - 10_000, 'OAuth token refresh failed (auth_error status=400 detail=<json error=invalid_grant len=85>)'],
    [lastUp + 2_000, quitting],
  )
  expect(causeOf(down, null, startNoise).cause).toBe('quit')
  const signedInAgain = log([lastUp - 5_000, signOut], [lastUp - 4_000, '[account] Login-state transition (loggedOut: true → false, uuid: <none> → a1)'], [lastUp + 2_000, quitting])
  expect(causeOf(down, null, signedInAgain).cause).toBe('quit')

  const orgOff = log([lastUp + 1_000, 'API error: This organization has been disabled.'], [lastUp + 2_000, 'willQuit: handler is ready for quit, so quitting'])
  expect(causeOf(down, null, orgOff).cause).toBe('account-dead')
  // What Claude Desktop really writes when an organization turns Claude Code off (two profiles' logs, 2026-09-24 and
  // 2026-10-14), then the sign-out and quit that followed it.
  const orgDisabled =
    '[CCD CycleHealth] local_x api_error (success): Your organization has disabled Claude subscription access for Claude Code · Use an Anthropic API key instead'
  expect(causeOf(down, null, log([lastUp + 1_000, orgDisabled], [lastUp + 2_000, signOut], [lastUp + 3_000, quitting])).cause).toBe('account-dead')
  // An app still open that its log marks dead says so before anything else does.
  expect(causeOf({ ...down, closed: false, instance: { ...down.instance, dead: 'its log: org off' } }, null, null)).toEqual({ cause: 'account-dead', detail: 'its log: org off' })

  const crash = log([lastUp + 1_000, '[process-memory] trigger=interval tree_rss_sum=2100MB'])
  expect(causeOf(down, null, crash)).toEqual({ cause: 'crashed', detail: 'its log stops without a quit' })

  // A quit long before it was last seen up is an earlier session's, not this one's.
  expect(causeOf(down, null, log([lastUp - 3_600_000, 'beforeQuit: handler is ready for quit, so quitting'])).cause).toBe('crashed')

  // The account says it before the log does: signed out, or a paid plan that turned free.
  expect(causeOf({ ...down, instance: { ...down.instance, signedIn: false } }, null, quit).cause).toBe('logged-out')
  expect(causeOf(down, { status: 'loggedout', plan: null }, quit).cause).toBe('logged-out')
  expect(causeOf(down, { status: 'live', plan: 'Free' }, quit).cause).toBe('account-dead')

  expect(causeOf(down, null, null).cause).toBe('unknown')
})

test('the chats go to the same-kind account with the most room, never the same account, and a running app wins a tie', () => {
  const down = app(1, { running: false, email: 'owner@example.com' })
  const cand = (inst: SeenInstance, fiveHourPct: number | null, weeklyPct: number | null, known = true): Candidate => ({
    instance: inst,
    fiveHourPct,
    weeklyPct,
    capPct: 85,
    known,
  })
  const ranked = rankTargets(down, [
    cand(app(1), 0, 0), // the app that went down
    cand(app(2, { email: 'OWNER@example.com' }), 0, 0), // the same account in another profile
    cand(app(3, { plan: 'Max 20×', running: false }), 10, 40), // 20 x (85 - 40) = 900
    cand(app(4, { plan: 'Max 5×' }), 0, 5), // 5 x 80 = 400
    cand(app(5, { plan: 'Max 20×' }), 90, 10), // its five hours are past the line
    cand(app(6, { plan: 'Max 20×' }), null, null, false), // no real reading
    cand(app(7, { plan: 'Pro', running: false }), 0, 0), // 1 x 85
    cand(app(8, { plan: 'Pro' }), 0, 0), // the same room, already running
    cand(app(9, { kind: 'codex', ref: 'codex:x', plan: 'Pro' }), 0, 0), // another kind of app
    cand(app(10, { signedIn: false, plan: 'Max 20×' }), 0, 0),
    cand(app(11, { plan: 'Max 20×', running: false, dead: 'its log: org off' }), 0, 0), // its account died
  ])
  expect(ranked.map((r) => [r.instance.num, r.room])).toEqual([
    [3, 900],
    [4, 400],
    [8, 85],
    [7, 85],
  ])
})

test("an app's own log marks its account dead while it stays open, until a turn runs to its end or it is signed in again", () => {
  const t = NOW - 600_000
  const orgOff = 'Session local_x query error: Claude Code returned an error result: Your organization has disabled Claude subscription access'
  const done = '[Stop hook] Query completed for session local_y'
  const signIn = '[account] Login-state transition (loggedOut: true → false, uuid: <none> → a1)'
  expect(deadFromLog(log([t, done], [t + 1_000, orgOff]))).toContain('organization has disabled')
  expect(deadFromLog(log([t, orgOff], [t + 1_000, done]))).toBeNull()
  expect(deadFromLog(log([t, orgOff], [t + 1_000, signIn]))).toBeNull()
  expect(deadFromLog(log([t, '[CCD CycleHealth] local_x api_error (success): Your organization has disabled Claude subscription access']))).toContain(
    'organization has disabled',
  )
  // A usage limit resets by itself: not a dead account. Nor is a line that only mentions a plan or a payment, or an
  // account-dead phrase outside a chat's failed turn: a match takes a running app's chats off it.
  expect(deadFromLog(log([t, "Session local_x query error: Claude Code returned an error result: You've hit your session limit"]))).toBeNull()
  expect(deadFromLog(log([t, 'Session local_x query error: payment required for this model; the plan has ended']))).toBeNull()
  expect(deadFromLog(log([t, '[settings] Banner: your organization has been disabled? learn more']))).toBeNull()
  expect(deadFromLog(null)).toBeNull()
})

test('which open chats a going-down cut off: one seen working, one mid-turn, an error as it went down, background jobs it waits on', () => {
  const lastUp = NOW - 20_000
  const v = (state: string, fields: Partial<TurnState> = {}): TurnState => ({
    state,
    kind: null,
    idle: false,
    lane: null,
    quietSecs: 30,
    outstanding: 0,
    cause: 'c',
    ...fields,
  })
  const cases: [string, boolean, TurnState | null, boolean | null][] = [
    ['seen working, with no verdict', true, null, true],
    ['seen working, a finished turn that does not claim done', true, v('finished', { lane: 'needs-input-review' }), true],
    ['seen working, its turn ended on a done recap', true, v('finished', { lane: 'archive-candidate' }), false],
    ['an engine alive mid-turn', false, v('running'), true],
    ['an engine alive and idle', false, v('running', { idle: true }), false],
    ['died mid-turn', false, v('crashed', { kind: 'mid-turn' }), true],
    // written 110 s before its last look up, inside ERROR_WITH_DOWN_MS
    ['an error as the app went down', false, v('crashed', { kind: 'error', quietSecs: 130 }), 130_000 - 20_000 <= ERROR_WITH_DOWN_MS],
    ['an error long before', false, v('crashed', { kind: 'usage-limit', quietSecs: 3_600 }), false],
    ['finished, waiting on background jobs', false, v('finished', { lane: 'needs-input-review', outstanding: 1 }), true],
    ['stopped by a person, jobs or not', false, v('finished', { lane: 'human', outstanding: 1 }), false],
    ['finished', false, v('finished', { lane: 'archive-candidate' }), false],
    ['finished, its jobs not scanned', false, v('finished', { lane: 'needs-input-review', outstanding: null }), null],
    ['a state it does not know', false, v('something-new'), false],
    ['no verdict read', false, null, null],
  ]
  expect(cases.map(([name, busy, t]) => [name, cutOff(busy, t, lastUp, NOW)?.cut ?? null])).toEqual(cases.map(([name, , , want]) => [name, want]))
})
