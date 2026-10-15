// server/tests/session-message-peer-only.test.ts — the mid-turn rail, enforced where the
// channel is actually chosen.
//
// The bug this pins (found 2026-09-07, reproduced 09-09 and 09-10). courier.py's rail 4 says a
// chat whose turn is IN FLIGHT is never interrupted FOR THE COMPOSER ROUTE, because the peer
// channel enqueues natively and drains after the turn. The courier could not express that: it
// had to decide before the daemon picked a channel, so it refused every live chat outright and
// a chat in a continuous work loop never received its reply at all. The courier now sends
// `peer_only` for a mid-turn chat, and THIS is where it has to mean something: on a session
// with no peer pipe the route otherwise falls through to the composer, which TYPES.
//
// Since 2026-10-15 never-type is every caller's default (owner: a move's resume had raised his
// window full screen, minimized it, then clicked through its menus): only `allow_typing: true`,
// AgentHydra's own chat box, reaches the composer.
//
// Routes are exercised through the real registration on a PRIVATE Hono copied from the shared
// app (see queue-patch-guard.test.ts for why the copy matters). Every collaborator the handler
// reaches for is mocked, so nothing here touches a real app, a real pipe, or PowerShell.
import { afterAll, beforeEach, expect, mock, test } from 'bun:test'
import { Hono } from 'hono'

const HOME = 'c:\\i\\temp1'
const SID = 'peeronly-1111-2222-3333-444455556666'

// ⛔ THE REAL EXPORTS, CAPTURED BEFORE ANY FAKE IS INSTALLED, AND PUT BACK IN afterAll
// (scripts/checks/test-stub-outlives-its-file.mjs rule 2). `bun test` runs every file in ONE
// process and mock.module applies to the WHOLE run - mock.restore() does not undo it - so a fake
// left installed here lands on whichever file happens to run next, and the failure surfaces
// there rather than in the file that caused it. Captured BEFORE, never after: mock.module
// rewrites the live bindings of a namespace that was already imported, so a copy taken after the
// fake IS the fake, and "restoring" it would reinstall the mock forever.
const realLiveRegistry = { ...(await import('../src/live-registry')) }
const realInstanceSessions = { ...(await import('../src/instance-sessions')) }
const realSessionLaunch = { ...(await import('../src/session-launch')) }
const realCoreInstances = { ...(await import('../src/core/instances')) }
const realPeerMessage = { ...(await import('../src/peer-message')) }

// Mocks must be installed BEFORE the route module is imported: findTranscriptById is a static
// import in the handler's module, and the rest are dynamic imports resolved at request time.
// Each fake spreads the real namespace first, so a collaborator this test does not care about
// keeps its real implementation instead of becoming undefined.
// The per-test answers for the named-instance cases: which instances exist, and which one (if
// any) holds this session as a desktop chat.
type FakeInstance = { name: string; dir: string; isRunning: boolean }
let instances: FakeInstance[] = [{ name: 'temp1', dir: HOME, isRunning: true }]
let namedChat: { chatId: string; title: string } | null = null
const OTHER_HOME = 'c:\\i\\temp2'

mock.module('../src/live-registry', () => ({
  ...realLiveRegistry,
  findTranscriptById: () => null,
}))
mock.module('../src/instance-sessions', () => ({
  ...realInstanceSessions,
  findDesktopChat: () => ({ title: 'A working chat' }),
  desktopChatOn: () => namedChat,
}))
mock.module('../src/session-launch', () => ({
  ...realSessionLaunch,
  desktopHomeFor: async () => HOME,
  liveSessionEntry: () => null,
}))
mock.module('../src/core/instances', () => ({
  ...realCoreInstances,
  listInstances: async () => instances,
}))
// 'not-live' is the case under test: a session with NO peer pipe, which is exactly when the
// route would otherwise downgrade to the composer.
const peerCalls: string[] = []
const peerHosts: Array<string | undefined> = []
mock.module('../src/peer-message', () => ({
  ...realPeerMessage,
  deliverPeerMessage: async (
    sessionId: string,
    _transcript: unknown,
    _text: unknown,
    _ms: unknown,
    _home: unknown,
    hostSessionId?: string,
  ) => {
    peerCalls.push(sessionId)
    peerHosts.push(hostSessionId)
    return { ok: false, reason: 'not-live' }
  },
}))

afterAll(() => {
  mock.module('../src/live-registry', () => realLiveRegistry)
  mock.module('../src/instance-sessions', () => realInstanceSessions)
  mock.module('../src/session-launch', () => realSessionLaunch)
  mock.module('../src/core/instances', () => realCoreInstances)
  mock.module('../src/peer-message', () => realPeerMessage)
})

const { app } = await import('../src/http-app')
await import('../src/routes/session-message')
const http = new Hono().route('/', app)

async function post(body: Record<string, unknown>) {
  const res = await http.request(`/api/sessions/${SID}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}

beforeEach(() => {
  peerCalls.length = 0
  peerHosts.length = 0
  namedChat = null
  instances = [{ name: 'temp1', dir: HOME, isRunning: true }]
})

test.each([
  ['a caller that asks for nothing (the courier, fan_out_send, archive, CliMayte, spawn)', {}],
  ['a mid-turn caller (peer_only)', { peer_only: true }],
  ['peer_only even beside allow_typing', { peer_only: true, allow_typing: true }],
])('%s, on a session with no pipe, is REFUSED instead of typed', async (_who, flags) => {
  const { status, body } = await post({ text: 'carry on', ...flags })
  expect(status).toBe(409)
  expect(body.delivered).toBe(false)
  expect(body.route).toBe('peer')
  expect(String(body.error)).toContain('never types')
  // the peer channel was still tried first - never-type forbids the FALLBACK, not the attempt
  expect(peerCalls).toEqual([SID])
})

test('the refusal says why, so a caller can tell "not now" from "went wrong"', async () => {
  const { body } = await post({ text: 'carry on' })
  expect(String(body.detail)).toContain("types into the app's window - refusing")
  expect(String(body.detail)).toContain('native control')
})

test("allow_typing (a person's own send) still falls through to the composer path", async () => {
  // A person who typed into AgentHydra's chat box asked for exactly this. With no transcript and
  // no verify_text the composer path refuses at its OWN rail (the wrong-chat guard), which proves
  // the request got past the never-type gate without typing.
  const { status, body } = await post({ text: 'carry on', allow_typing: true })
  expect(status).toBe(422)
  expect(String(body.error)).toContain('no verify snippet derivable')
})

test('a named instance that does not hold the session is refused, never guessed at', async () => {
  instances = [
    { name: 'temp1', dir: HOME, isRunning: true },
    { name: 'temp2', dir: OTHER_HOME, isRunning: true },
  ]
  namedChat = null
  const { status, body } = await post({ text: 'carry on', instance: 'temp2' })
  expect(status).toBe(409)
  expect(body.error).toBe('not on the named instance')
  expect(peerCalls).toEqual([])
})

test('a named instance that is not configured is refused the same way', async () => {
  namedChat = { chatId: 'local_copy', title: 'A working chat' }
  const { status, body } = await post({ text: 'carry on', instance: 'nobody' })
  expect(status).toBe(409)
  expect(body.error).toBe('not on the named instance')
})

test('the named instance copy wins, and only its own live engine is asked', async () => {
  instances = [
    { name: 'temp1', dir: HOME, isRunning: true },
    { name: 'temp2', dir: OTHER_HOME, isRunning: true },
  ]
  namedChat = { chatId: 'local_copy-on-temp2', title: 'A working chat' }
  const { body } = await post({ text: 'carry on', instance: 'temp2' })
  expect(String(body.error ?? '')).not.toContain('not on the named instance')
  expect(peerCalls).toEqual([SID])
  expect(peerHosts).toEqual(['local_copy-on-temp2'])
})

test('allow_typing is not honoured as a truthy string - only a real boolean opts in', async () => {
  // A JSON body is caller-supplied; a stray "true" or "1" must not silently arm the keyboard.
  const { status } = await post({ text: 'carry on', allow_typing: 'true' })
  expect(status).toBe(409)
})
