import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { DRONE_REFUSAL } from '../src/climayte-lib'
import { chatPaths } from '../src/hydra-core/paths'
import { CORE_TOOLS } from '../src/mcp-core'
import { FAN_OUT_TOOLS } from '../src/mcp-fan-out'
import { callerRole, setCallerTranscriptResolver } from '../src/mcp-self'
import { scratch } from './hydra-core-fixture'

const PRIME = 'chat-prime'
const FOLDER = 'D:/example/folder'

type Row = { id: string; role: string; sessionId: string; sessions?: string[] }

let dir = ''
let savedFetch: typeof fetch
let savedWorker: string | undefined
let workers: Row[] = []
let chats = new Map<string, Record<string, unknown>>()
let transcripts = new Map<string, { kind: string; text: string }[]>()
let posts: { path: string; body: Record<string, unknown> }[] = []
let nextId = 1

function json(v: unknown, status = 200): Response {
  return new Response(JSON.stringify(v), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function say(id: string, text: string): void {
  const items = transcripts.get(id) ?? []
  items.push({ kind: 'user', text }, { kind: 'assistant_text', text: 'Fake reply' })
  transcripts.set(id, items)
}

// One fake for both servers this path reaches: the daemon (/api/corch/workers) and the Desk (/api/chats).
function fakeServers(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url))
    const path = u.pathname
    const method = init?.method ?? 'GET'
    if (method === 'GET' && path === '/api/corch/workers') {
      if (u.searchParams.has('ids'))
        return json([{ id: 'w-new', status: 'done', report: 'Old path' }])
      const session = u.searchParams.get('session')
      return json(
        workers
          .filter((w) => session && [w.sessionId, ...(w.sessions ?? [])].includes(session))
          .map((w) => ({ id: w.id, role: w.role })),
      )
    }
    if (method === 'GET' && path.startsWith('/api/corch/workers/')) {
      const id = decodeURIComponent(path.split('/')[4])
      const w = workers.find((x) => x.id === id)
      return w ? json({ id, role: w.role }) : json({ error: 'worker not found' }, 404)
    }
    if (method === 'GET' && path === '/api/chats') return json([...chats.values()])
    if (method === 'GET' && path.endsWith('/transcript'))
      return json(transcripts.get(path.split('/')[3]) ?? [])
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    posts.push({ path, body })
    if (method === 'POST' && path === '/api/corch/workers')
      return json({ workers: [{ id: 'w-new' }] })
    if (method === 'POST' && path === '/api/chats') {
      const id = `chat-seat-${nextId++}`
      chats.set(id, {
        id,
        title: body.title,
        cwd: body.cwd,
        parentId: body.parentId,
        status: 'idle',
      })
      transcripts.set(id, [])
      say(id, String(body.prompt))
      return json({ id, title: body.title })
    }
    if (method === 'POST' && path.endsWith('/messages')) {
      say(path.split('/')[3], String(body.text))
      return json({ ok: true })
    }
    return json({ error: 'not in the fake' }, 404)
  }) as unknown as typeof fetch
}

/** The calling session, as the process walk would have traced it (the resolver seam). */
function callerIs(sessionId: string): void {
  setCallerTranscriptResolver(async () => ({
    sessionId,
    path: '',
    home: FOLDER,
    how: 'test resolver',
  }))
}

beforeEach(() => {
  dir = scratch()
  savedWorker = process.env.AGENTHYDRA_CLIMAYTE_WORKER
  delete process.env.AGENTHYDRA_CLIMAYTE_WORKER
  savedFetch = globalThis.fetch
  workers = [
    { id: 'w-prime', role: 'prime', sessionId: 'sess-prime' },
    { id: 'w-drone', role: 'drone', sessionId: 'sess-new', sessions: ['sess-drone'] },
  ]
  chats = new Map([[PRIME, { id: PRIME, title: 'Example prime', cwd: FOLDER, status: 'idle' }]])
  transcripts = new Map()
  posts = []
  nextId = 1
  mkdirSync(chatPaths(dir, PRIME).root, { recursive: true })
  writeFileSync(chatPaths(dir, PRIME).cwd, FOLDER)
  fakeServers()
})

afterEach(() => {
  globalThis.fetch = savedFetch
  setCallerTranscriptResolver(null)
  if (savedWorker === undefined) delete process.env.AGENTHYDRA_CLIMAYTE_WORKER
  else process.env.AGENTHYDRA_CLIMAYTE_WORKER = savedWorker
  rmSync(dir, { recursive: true, force: true })
})

const coreUse = CORE_TOOLS.find((t) => t.name === 'core_use')!
const fanOut = FAN_OUT_TOOLS.find((t) => t.name === 'fan_out')!

test('a Prime chat is found by its own session, with no env var set: role prime', async () => {
  callerIs('sess-prime')
  expect(await callerRole({})).toBe('prime')
  expect(process.env.AGENTHYDRA_CLIMAYTE_WORKER).toBeUndefined()
})

test('a drone is found by an earlier session of its worker: role drone', async () => {
  callerIs('sess-drone')
  expect(await callerRole({})).toBe('drone')
})

test('a session no worker owns has no role, and core_use keeps the old worker path', async () => {
  callerIs('sess-nobody')
  expect(await callerRole({})).toBeUndefined()
  const r = await coreUse.run({
    chat: PRIME,
    id: 'person:iris-ui',
    mode: 'consult',
    question: 'Is the grid right?',
    cwd: FOLDER,
  })
  expect(r).toMatchObject({ job: 'w-new', status: 'done', text: 'Old path' })
  expect(posts.some((p) => p.path === '/api/chats')).toBe(false)
})

test('core_use from a Prime chat opens a seat under it, with no env var set', async () => {
  callerIs('sess-prime')
  const r = await coreUse.run({
    chat: PRIME,
    id: 'person:iris-ui',
    mode: 'consult',
    question: 'Layout for the login page?',
  })
  expect(r).toMatchObject({
    status: 'done',
    reply: 'Fake reply',
    seat: { chat: 'chat-seat-1', title: 'Iris Example · Example prime' },
  })
  expect(posts.find((p) => p.path === '/api/chats')?.body).toMatchObject({
    parentId: PRIME,
    title: 'Iris Example · Example prime',
    cwd: FOLDER,
  })
  expect(posts.some((p) => p.path === '/api/corch/workers')).toBe(false)
})

test('core_use from a drone is refused and opens no chat', async () => {
  callerIs('sess-drone')
  await expect(
    coreUse.run({ chat: PRIME, id: 'person:iris-ui', mode: 'consult', question: 'Hi?' }),
  ).rejects.toThrow('A drone cannot consult person:iris-ui')
  expect(posts.filter((p) => p.path === '/api/chats')).toHaveLength(0)
})

test('fan_out from a drone is refused, with no env var set', async () => {
  callerIs('sess-drone')
  await expect(fanOut.run({ tasks: [{ cwd: FOLDER, prompt: 'p' }] })).rejects.toThrow(DRONE_REFUSAL)
  expect(posts.filter((p) => p.path === '/api/corch/workers')).toHaveLength(0)
})

test('with no traced caller, the env worker id is the stdio fallback', async () => {
  setCallerTranscriptResolver(async () => {
    throw new Error('no session for this process')
  })
  process.env.AGENTHYDRA_CLIMAYTE_WORKER = 'w-drone'
  expect(await callerRole({})).toBe('drone')
})
