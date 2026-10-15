import { afterEach, expect, test } from 'bun:test'
import {
  type ConnectLike,
  createPeopleServerAdapter,
  HomeUnavailable,
  NOT_CONFIGURED,
  type PersonRecord,
  SIGNED_OUT,
} from '../src/people-store'

type Stored = { doc: PersonRecord; version: number; updatedAt: string }

interface FakeServer {
  url: string
  docs: Map<string, Stored>
  seen: string[]
  accepted: { token: string }
  conflictAlways: boolean
  prefs: { trainingUse: boolean; termsVersion: string }
  stop(): void
}

const PAGE = 2
const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

function fakeServer(): FakeServer {
  const srv: FakeServer = {
    url: '',
    docs: new Map(),
    seen: [],
    accepted: { token: 'fresh' },
    conflictAlways: false,
    prefs: { trainingUse: true, termsVersion: '2026-10-01' },
    stop: () => {},
  }
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(req) {
      const url = new URL(req.url)
      srv.seen.push(`${req.method} ${url.pathname}`)
      if (req.headers.get('authorization') !== `Bearer ${srv.accepted.token}`)
        return json({ error: 'unauthorized', hint: 'sign in again' }, 401)
      const doc = url.pathname.match(/^\/v1\/people\/docs\/([A-Za-z0-9._-]{1,128})$/)
      if (url.pathname === '/v1/people/docs' && req.method === 'GET') {
        const keys = [...srv.docs.keys()].sort()
        const start = Number(url.searchParams.get('cursor') ?? 0)
        const slice = keys.slice(start, start + PAGE)
        const next = start + PAGE < keys.length ? String(start + PAGE) : null
        return json({
          docs: slice.map((id) => {
            const s = srv.docs.get(id) as Stored
            return { id, version: s.version, bytes: 100, updatedAt: s.updatedAt }
          }),
          nextCursor: next,
        })
      }
      if (doc && req.method === 'GET') {
        const s = srv.docs.get(doc[1] as string)
        if (!s) return json({ error: 'not found' }, 404)
        return json({ doc: s.doc, version: s.version, updatedAt: s.updatedAt })
      }
      if (doc && req.method === 'POST') {
        const id = doc[1] as string
        const body = (await req.json()) as { doc: PersonRecord; baseVersion: number }
        const current = srv.docs.get(id)?.version ?? 0
        if (srv.conflictAlways || body.baseVersion !== current)
          return json({ error: 'stale', currentVersion: current }, 409)
        const version = current + 1
        srv.docs.set(id, { doc: body.doc, version, updatedAt: '2026-10-15T00:00:00.000Z' })
        return json({ version })
      }
      if (doc && req.method === 'DELETE') {
        srv.docs.delete(doc[1] as string)
        return json({ ok: true })
      }
      if (url.pathname === '/v1/me/preferences' && req.method === 'GET') return json(srv.prefs)
      if (url.pathname === '/v1/me/preferences' && req.method === 'PUT') {
        srv.prefs = (await req.json()) as typeof srv.prefs
        return json(srv.prefs)
      }
      if (url.pathname === '/v1/me' && req.method === 'DELETE') {
        srv.docs.clear()
        return json({ ok: true })
      }
      if (url.pathname === '/v1/me/export' && req.method === 'GET')
        return new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
      return json({ error: 'no such route' }, 404)
    },
  })
  srv.url = `http://127.0.0.1:${server.port}`
  srv.stop = () => server.stop(true)
  return srv
}

let server: FakeServer | null = null
afterEach(() => {
  server?.stop()
  server = null
})

/** A connect stand-in that hands out the tokens in order; the last one repeats. */
function fakeConnect(tokens: string[], signedIn = true): ConnectLike {
  let i = 0
  return {
    isSignedIn: async () => signedIn,
    getAccessToken: async () => tokens[Math.min(i++, tokens.length - 1)] as string,
    getUser: async () => ({ name: 'Example Owner', email: 'owner@example.com' }),
    signInLoopback: async () => ({}),
    signOut: async () => {},
  }
}

const homeFor = (srv: FakeServer, tokens = ['fresh']) =>
  createPeopleServerAdapter({ baseUrl: srv.url, connect: fakeConnect(tokens) }).home()

const rec = (slug: string, extra: Partial<PersonRecord> = {}): PersonRecord => ({
  id: `manager/${slug}`,
  family: 'manager',
  slug,
  persona: { name: `Example ${slug}` },
  brief: `Brief of ${slug}`,
  learnings: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...extra,
})

test('not configured: no URL means no network and a plain sentence', async () => {
  const adapter = createPeopleServerAdapter({ baseUrl: '', connect: fakeConnect(['fresh']) })
  expect(adapter.configured).toBe(false)
  await expect(adapter.home().list()).rejects.toThrow(NOT_CONFIGURED)
  await expect(adapter.signIn()).rejects.toThrow(NOT_CONFIGURED)
})

test('not signed in: the home says signed out before any request is sent', async () => {
  server = fakeServer()
  const home = createPeopleServerAdapter({
    baseUrl: server.url,
    connect: fakeConnect([], false),
  }).home()
  const err = await home.list().catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HomeUnavailable)
  expect((err as Error).message).toBe(SIGNED_OUT)
  expect(server.seen).toEqual([])
})

test('list pages through the cursor until the last page', async () => {
  server = fakeServer()
  for (const slug of ['ada', 'bo', 'cy', 'di', 'ed']) {
    server.docs.set(`manager.${slug}`, {
      doc: rec(slug),
      version: 1,
      updatedAt: '2026-01-01T00:00:00.000Z',
    })
  }
  const ids = (await homeFor(server).list()).map((p) => p.id)
  expect(ids).toEqual(['manager/ada', 'manager/bo', 'manager/cy', 'manager/di', 'manager/ed'])
  expect(server.seen.filter((s) => s === 'GET /v1/people/docs').length).toBe(3)
})

test('create, read, and delete one person as one doc', async () => {
  server = fakeServer()
  const home = homeFor(server)
  await home.put(
    rec('ada', { learnings: [{ id: 'l1', text: 'Ask first', at: '2026-01-01T00:00:00.000Z' }] }),
  )
  expect(server.docs.has('manager.ada')).toBe(true)
  const got = await home.get('manager/ada')
  expect(got?.persona.name).toBe('Example ada')
  expect(got?.learnings[0]?.text).toBe('Ask first')
  expect(await home.get('manager/nobody')).toBeNull()
  await home.delete('manager/ada')
  expect(await home.get('manager/ada')).toBeNull()
  expect(server.docs.size).toBe(0)
})

test('a stale write gets 409, re-reads the version and retries once', async () => {
  server = fakeServer()
  const home = homeFor(server)
  await home.put(rec('ada'))
  // Another device writes the doc first.
  server.docs.set('manager.ada', {
    doc: rec('ada', { brief: 'other device' }),
    version: 2,
    updatedAt: '2026-02-01T00:00:00.000Z',
  })
  await home.put(rec('ada', { brief: 'mine' }))
  expect(server.seen.filter((s) => s === 'POST /v1/people/docs/manager.ada').length).toBe(3)
  expect(server.docs.get('manager.ada')?.version).toBe(3)
  expect(server.docs.get('manager.ada')?.doc.brief).toBe('mine')
})

test('a write that is stale twice gives up in words', async () => {
  server = fakeServer()
  const home = homeFor(server)
  server.conflictAlways = true
  await expect(home.put(rec('ada'))).rejects.toThrow('changed on another device')
  expect(server.seen.filter((s) => s.startsWith('POST')).length).toBe(2)
})

test('a 401 refreshes the token once and then works', async () => {
  server = fakeServer()
  server.docs.set('manager.ada', {
    doc: rec('ada'),
    version: 1,
    updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const people = await homeFor(server, ['stale', 'fresh']).list()
  expect(people.map((p) => p.id)).toEqual(['manager/ada'])
  expect(server.seen.filter((s) => s === 'GET /v1/people/docs').length).toBe(2)
})

test('a 401 after the refresh is signed out, in the Connections words', async () => {
  server = fakeServer()
  const home = homeFor(server, ['stale'])
  const err = await home.list().catch((e: unknown) => e)
  expect(err).toBeInstanceOf(HomeUnavailable)
  expect((err as Error).message).toBe(SIGNED_OUT)
  expect(server.seen.length).toBe(2)
})

test('preferences round trip through the server', async () => {
  server = fakeServer()
  const home = homeFor(server)
  expect(await home.getPreferences()).toEqual({ trainingUse: true, termsVersion: '2026-10-01' })
  await home.setPreferences({ trainingUse: false, termsVersion: '2026-10-15' })
  expect(server.prefs).toEqual({ trainingUse: false, termsVersion: '2026-10-15' })
  expect(await home.getPreferences()).toEqual({ trainingUse: false, termsVersion: '2026-10-15' })
})

test('deleting the account removes every doc; the export is the server bytes', async () => {
  server = fakeServer()
  const home = homeFor(server)
  await home.put(rec('ada'))
  await home.put(rec('bo'))
  expect(await home.exportAll()).toEqual(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))
  await home.deleteAccount()
  expect(await home.list()).toEqual([])
  expect(server.docs.size).toBe(0)
})
