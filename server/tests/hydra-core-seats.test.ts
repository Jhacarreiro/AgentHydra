import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chatPaths } from '../src/hydra-core/paths'
import { type Daemon, use } from '../src/hydra-core/use'
import { scratch } from './hydra-core-fixture'

const PRIME = 'chat-prime'
const FOLDER = 'C:/Users/me/example-folder'
const now = new Date('2026-10-14T10:00:00.000Z')

const noDaemon: Daemon = {
  dispatch: async () => {
    throw new Error('a seat never dispatches a worker')
  },
  report: async () => null,
}

let dir = ''
let savedFetch: typeof fetch
let savedManagers: string | undefined
let answers = true
let chats = new Map<string, Record<string, unknown>>()
let transcripts = new Map<string, { kind: string; text: string }[]>()
let posts: { path: string; body: Record<string, unknown> }[] = []
let gets: string[] = []
let nextId = 1

function say(id: string, text: string): void {
  const items = transcripts.get(id) ?? []
  items.push({ kind: 'user', text })
  if (answers) items.push({ kind: 'assistant_text', text: 'Fake reply' })
  transcripts.set(id, items)
}

function fakeDesk(): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const path = new URL(String(url)).pathname
    const method = init?.method ?? 'GET'
    const json = (v: unknown, status = 200) =>
      new Response(JSON.stringify(v), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    if (method === 'GET' && path === '/api/chats') return json([...chats.values()])
    if (method === 'GET' && path.endsWith('/transcript')) {
      const id = path.split('/')[3]
      gets.push(id)
      return json(transcripts.get(id) ?? [])
    }
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
    posts.push({ path, body })
    if (method === 'POST' && path === '/api/chats') {
      const id = `chat-seat-${nextId++}`
      chats.set(id, {
        id,
        title: body.title,
        cwd: body.cwd,
        parentId: body.parentId,
        managerSlug: body.managerSlug,
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
    return json({ error: 'not in the fake Desk' }, 404)
  }) as unknown as typeof fetch
}

beforeEach(() => {
  dir = scratch()
  const managers = join(dir, 'managers')
  mkdirSync(join(managers, 'iris-ui'), { recursive: true })
  writeFileSync(join(managers, 'iris-ui', 'persona.json'), JSON.stringify({ name: 'Iris Example' }))
  savedManagers = process.env.AGENTHYDRA_MANAGERS_DIR
  process.env.AGENTHYDRA_MANAGERS_DIR = managers
  savedFetch = globalThis.fetch
  chats = new Map([[PRIME, { id: PRIME, title: 'Example prime', cwd: FOLDER, status: 'idle' }]])
  transcripts = new Map()
  posts = []
  gets = []
  nextId = 1
  answers = true
  fakeDesk()
})

afterEach(() => {
  globalThis.fetch = savedFetch
  if (savedManagers === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = savedManagers
  rmSync(dir, { recursive: true, force: true })
})

const consult = (
  id: string,
  question: string | undefined,
  caller: 'prime' | 'drone' | 'seat' = 'prime',
  cwd?: string,
) => use(dir, { chat: PRIME, id, mode: 'consult', question, caller, cwd }, noDaemon, now)

const seatPosts = () => posts.filter((p) => p.path === '/api/chats')

test('a Prime chat consult opens one seat under it, named for the persona and the chat, with its manager slug', async () => {
  const r = await consult('person:iris-ui', 'Layout for the login page?')
  expect(r).toMatchObject({
    status: 'done',
    reply: 'Fake reply',
    seat: { chat: 'chat-seat-1', title: 'Iris Example · Example prime' },
  })
  expect(seatPosts()).toHaveLength(1)
  expect(seatPosts()[0].body).toMatchObject({
    parentId: PRIME,
    managerSlug: 'iris-ui',
    title: 'Iris Example · Example prime',
    prompt: 'Layout for the login page?',
  })
  expect(JSON.parse(readFileSync(chatPaths(dir, PRIME).seats, 'utf8'))).toEqual({
    'person:iris-ui': { chat: 'chat-seat-1', title: 'Iris Example · Example prime' },
  })
})

test('a second consult for the same persona reuses its seat: no new chat, the question goes to it', async () => {
  await consult('person:iris-ui', 'First?')
  const r = await consult('person:iris-ui', 'Second?')
  expect(r).toMatchObject({ status: 'done', seat: { chat: 'chat-seat-1' } })
  expect(seatPosts()).toHaveLength(1)
  expect(
    posts.filter((p) => p.path === '/api/chats/chat-seat-1/messages').map((p) => p.body.text),
  ).toEqual(['Second?'])
})

test('a different persona opens its own seat, briefed with its catalog text in the first message', async () => {
  await consult('person:iris-ui', 'Layout?')
  const r = await consult('person:pricing-expert', 'Price for the Pro plan?')
  expect(r).toMatchObject({ seat: { chat: 'chat-seat-2', title: 'Pat Example · Example prime' } })
  const second = seatPosts()[1]
  expect(second.body.managerSlug).toBeUndefined()
  expect(String(second.body.prompt)).toContain('Prices plans and pricing for a product')
  expect(String(second.body.prompt)).toContain('Price for the Pro plan?')
})

test('a drone or a seat cannot consult or hire: it is refused and no chat opens', async () => {
  for (const caller of ['drone', 'seat'] as const) {
    await expect(consult('person:iris-ui', 'Hi?', caller)).rejects.toThrow(
      `A ${caller} cannot consult person:iris-ui`,
    )
    await expect(
      use(
        dir,
        { chat: PRIME, id: 'person:intern-ivan', mode: 'hire', job: 'Pull numbers', caller },
        noDaemon,
        now,
      ),
    ).rejects.toThrow(`A ${caller} cannot hire person:intern-ivan`)
  }
  expect(seatPosts()).toHaveLength(0)
})

test('a seat opened without cwd takes the Prime chat folder, and an explicit cwd wins', async () => {
  await consult('person:iris-ui', 'Hi?')
  expect(seatPosts()[0].body.cwd).toBe(FOLDER)
  await consult('person:pricing-expert', 'Hi?', 'prime', 'C:/Users/me/other-folder')
  expect(seatPosts()[1].body.cwd).toBe('C:/Users/me/other-folder')
})

test('hire opens the seat and returns at once with its id, without waiting for a reply', async () => {
  answers = false
  const started = Date.now()
  const r = await use(
    dir,
    {
      chat: PRIME,
      id: 'person:intern-ivan',
      mode: 'hire',
      job: 'Pull the pricing numbers',
      caller: 'prime',
    },
    noDaemon,
    now,
  )
  expect(Date.now() - started).toBeLessThan(5000)
  expect(r).toMatchObject({
    status: 'started',
    seat: { chat: 'chat-seat-1', title: 'Ivan Example · Example prime' },
  })
  expect(gets).toEqual([])
  expect(String(seatPosts()[0].body.prompt)).toContain('Pull the pricing numbers')
})

test('consult with no question reads the seat reply once it is done', async () => {
  await consult('person:iris-ui', 'Hi?')
  const r = await consult('person:iris-ui', undefined)
  expect(r).toMatchObject({ status: 'done', reply: 'Fake reply' })
  expect(seatPosts()).toHaveLength(1)
})

test('a consult outside a seat dispatches its worker in the chat folder when no cwd is given', async () => {
  const files = chatPaths(dir, 'chat-legacy')
  mkdirSync(files.root, { recursive: true })
  writeFileSync(files.cwd, FOLDER)
  const dispatched: string[] = []
  const daemon: Daemon = {
    dispatch: async (_prompt, _title, cwd) => {
      dispatched.push(cwd)
      return 'w-1'
    },
    report: async () => ({ status: 'done', text: 'Worker reply' }),
  }
  const r = await use(
    dir,
    { chat: 'chat-legacy', id: 'person:iris-ui', mode: 'consult', question: 'Hi?' },
    daemon,
    now,
  )
  expect(dispatched).toEqual([FOLDER])
  expect(r).toMatchObject({ job: 'w-1', status: 'done', text: 'Worker reply' })
})
