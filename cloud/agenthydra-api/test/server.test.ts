import { afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose'
import { keyringFromEnv } from '../src/crypto'
import { type Db } from '../src/db'
import { makeLimiters } from '../src/limits'
import { migrate } from '../src/migrate'
import { createApp } from '../src/server'

const ISS = 'https://id.example.test'
const AUD = 'https://site.example.test'

function fromPglite(c: any): Db {
  return {
    exec: async (t) => {
      await c.exec(t)
    },
    query: async (t, p = []) => (await c.query(t, p)).rows,
    begin: (fn) => c.transaction((tx: any) => fn(fromPglite(tx))),
  }
}

let priv: CryptoKey
let keys: ReturnType<typeof createLocalJWKSet>

beforeAll(async () => {
  const kp = await generateKeyPair('RS256', { extractable: true })
  priv = kp.privateKey
  const jwk = { ...(await exportJWK(kp.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' }
  keys = createLocalJWKSet({ keys: [jwk] })
})

const mint = (sub: string) =>
  new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
    .setIssuer(ISS)
    .setAudience(AUD)
    .setSubject(sub)
    .setExpirationTime('5m')
    .sign(priv)

let pg: PGlite
let dir: string
let logs: string[]
let app: ReturnType<typeof createApp>
let tokenA: string
let tokenB: string

async function setup(limiters = makeLimiters()) {
  pg = new PGlite()
  const roles = await Bun.file(join(import.meta.dir, '..', 'bootstrap', 'roles.sql')).text()
  await pg.exec(roles)
  const db = fromPglite(pg)
  await migrate(db)
  // PGlite is a superuser (bypasses RLS): run every request as the runtime role, like production.
  await pg.exec('SET ROLE agenthydra_app')
  dir = mkdtempSync(join(tmpdir(), 'ahapi-'))
  logs = []
  app = createApp({
    db,
    cfg: {
      auth: { keys, issuer: ISS, audience: AUD },
      keyring: keyringFromEnv(`1:${Buffer.alloc(32, 7).toString('base64')}`),
      auditSalt: 'salt',
      writeBlockFile: join(dir, 'write-block'),
      backupStampFile: join(dir, 'last-backup'),
      trustProxyHeader: true,
    },
    limiters,
    jwksCheck: async () => true,
    log: (l) => logs.push(l),
  })
  tokenA = await mint('user-a')
  tokenB = await mint('user-b')
}

const call = (
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
  headers: Record<string, string> = {},
  peer = '127.0.0.1',
) =>
  app.handle(
    new Request(`http://localhost:18790${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    peer,
  )

const accept = (t: string) => call('PUT', '/v1/me/preferences', t, { trainingUse: true, termsVersion: '1' })
const put = (t: string, id: string, doc: unknown, baseVersion: number) =>
  call('POST', `/v1/people/docs/${id}`, t, { doc, baseVersion })

beforeEach(() => setup())
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('auth', () => {
  test('missing and bad tokens are 401 with { error, hint }', async () => {
    const r = await call('GET', '/v1/people/docs', null)
    expect(r.status).toBe(401)
    expect(Object.keys(await r.json()).sort()).toEqual(['error', 'hint'])
    expect((await call('GET', '/v1/people/docs', 'not.a.jwt')).status).toBe(401)
  })

  test('10 failed auths per IP then 429', async () => {
    for (let i = 0; i < 10; i++) expect((await call('GET', '/v1/me/preferences', 'bad')).status).toBe(401)
    expect((await call('GET', '/v1/me/preferences', 'bad')).status).toBe(429)
    expect((await call('GET', '/v1/me/preferences', tokenA)).status).toBe(429)
  })

  test('CF-Connecting-IP counts only from loopback', async () => {
    // From a non-loopback peer the header is ignored: both callers share the peer address.
    for (let i = 0; i < 10; i++)
      await call('GET', '/v1/me/preferences', 'bad', undefined, { 'cf-connecting-ip': `203.0.113.${i}` }, '198.51.100.9')
    expect(
      (await call('GET', '/v1/me/preferences', 'bad', undefined, { 'cf-connecting-ip': '203.0.113.99' }, '198.51.100.9')).status,
    ).toBe(429)
    // From Caddy on loopback, a different client IP is a different bucket.
    expect(
      (await call('GET', '/v1/me/preferences', tokenA, undefined, { 'cf-connecting-ip': '203.0.113.99' })).status,
    ).toBe(200)
  })

  test('per-IP limit before auth', async () => {
    await setup(makeLimiters())
    let last = 0
    for (let i = 0; i < 121; i++) last = (await call('GET', '/healthz', null)).status
    expect(last).toBe(429)
  })
})

describe('people docs', () => {
  test('first write needs terms; then create, read, update, 409, delete', async () => {
    const denied = await put(tokenA, 'p1', { n: 1 }, 0)
    expect(denied.status).toBe(403)
    expect((await denied.json()).error).toBe('terms not accepted')
    expect((await call('GET', '/v1/me/preferences', tokenA)).status).toBe(200)
    await accept(tokenA)

    const c = await put(tokenA, 'p1', { n: 1 }, 0)
    expect(c.status).toBe(200)
    expect(await c.json()).toEqual({ version: 1 })
    expect(await (await call('GET', '/v1/people/docs/p1', tokenA)).json()).toEqual({ doc: { n: 1 }, version: 1 })

    expect(await (await put(tokenA, 'p1', { n: 2 }, 1)).json()).toEqual({ version: 2 })
    const stale = await put(tokenA, 'p1', { n: 3 }, 1)
    expect(stale.status).toBe(409)
    expect((await stale.json()).currentVersion).toBe(2)
    expect((await put(tokenA, 'p1', { n: 3 }, 0)).status).toBe(409)

    expect((await call('DELETE', '/v1/people/docs/p1', tokenA)).status).toBe(200)
    expect((await call('GET', '/v1/people/docs/p1', tokenA)).status).toBe(404)
    expect((await call('DELETE', '/v1/people/docs/p1', tokenA)).status).toBe(404)
    // A deleted id can be created again; versions continue.
    expect(await (await put(tokenA, 'p1', { n: 4 }, 0)).json()).toEqual({ version: 3 })
  })

  test('preferences default and round trip', async () => {
    expect(await (await call('GET', '/v1/me/preferences', tokenA)).json()).toEqual({ trainingUse: true, termsVersion: '' })
    await call('PUT', '/v1/me/preferences', tokenA, { trainingUse: false, termsVersion: '2' })
    expect(await (await call('GET', '/v1/me/preferences', tokenA)).json()).toEqual({ trainingUse: false, termsVersion: '2' })
    expect((await call('PUT', '/v1/me/preferences', tokenA, { trainingUse: 'x' })).status).toBe(400)
  })

  test('list pages 100 at a time with a cursor, no bodies', async () => {
    await accept(tokenA)
    for (let i = 0; i < 120; i++) await app.store.write('user-a', `d${String(i).padStart(3, '0')}`, { i }, 0)
    const p1 = await (await call('GET', '/v1/people/docs', tokenA)).json()
    expect(p1.docs.length).toBe(100)
    expect(p1.nextCursor).toBe('d099')
    expect(Object.keys(p1.docs[0]).sort()).toEqual(['bytes', 'id', 'updatedAt', 'version'])
    const p2 = await (await call('GET', `/v1/people/docs?cursor=${p1.nextCursor}`, tokenA)).json()
    expect(p2.docs.length).toBe(20)
    expect(p2.nextCursor).toBeNull()
  }, 60_000)

  test('user A cannot read or write user B', async () => {
    await accept(tokenA)
    await accept(tokenB)
    await put(tokenA, 'secret', { s: 1 }, 0)
    expect((await call('GET', '/v1/people/docs/secret', tokenB)).status).toBe(404)
    expect((await call('DELETE', '/v1/people/docs/secret', tokenB)).status).toBe(404)
    expect((await put(tokenB, 'secret', { s: 2 }, 1)).status).toBe(409)
    expect((await (await call('GET', '/v1/people/docs', tokenB)).json()).docs).toEqual([])
    // B's own doc under the same id is a separate row.
    expect(await (await put(tokenB, 'secret', { s: 9 }, 0)).json()).toEqual({ version: 1 })
    expect((await (await call('GET', '/v1/people/docs/secret', tokenA)).json()).doc).toEqual({ s: 1 })
  })

  test('replace keeps the old row in people_doc_versions; bodies are encrypted', async () => {
    await accept(tokenA)
    await put(tokenA, 'v', { word: 'plaintext-marker' }, 0)
    await put(tokenA, 'v', { word: 'two' }, 1)
    await put(tokenA, 'v', { word: 'three' }, 2)
    await pg.exec('RESET ROLE') // superuser view: RLS would hide rows without a scope
    const rows = (await pg.query(
      "SELECT version FROM people_doc_versions WHERE scope = 'user:user-a' AND doc_id = 'v' ORDER BY version",
    )).rows
    expect(rows.map((r: any) => r.version)).toEqual([1, 2])
    const raw = (await pg.query("SELECT body FROM people_docs WHERE doc_id = 'v'")).rows[0] as any
    expect(Buffer.from(raw.body).includes('three')).toBe(false)
    await pg.exec('SET ROLE agenthydra_app')
  })

  test('limits: 512 KB per doc, 200 docs, bad doc id, body 600 KB', async () => {
    await accept(tokenA)
    expect((await put(tokenA, 'big', { x: 'a'.repeat(513 * 1024) }, 0)).status).toBe(413)
    expect((await put(tokenA, 'big', { x: 'a'.repeat(100 * 1024) }, 0)).status).toBe(200)
    expect((await call('POST', '/v1/people/docs/bad%20id', tokenA, { doc: 1, baseVersion: 0 })).status).toBe(400)
    expect((await put(tokenA, 'x'.repeat(129), 1, 0)).status).toBe(400)
    const huge = await call('POST', '/v1/people/docs/h', tokenA, { doc: 'a'.repeat(700 * 1024), baseVersion: 0 })
    expect(huge.status).toBe(413)
    await call('DELETE', '/v1/people/docs/big', tokenA)
    for (let i = 0; i < 200; i++) {
      // Fill straight through the store so this test does not hit the 20/min write limit.
      await app.store.write('user-a', `n${i}`, { i }, 0)
    }
    const r = await put(tokenA, 'one-too-many', 1, 0)
    expect(r.status).toBe(413)
    expect((await r.json()).error).toBe('too many docs')
  }, 120_000)

  test('8 MB per user', async () => {
    await accept(tokenA)
    for (let i = 0; i < 16; i++) await app.store.write('user-a', `m${i}`, { x: 'a'.repeat(500 * 1024) }, 0)
    const r = await put(tokenA, 'm-over', { x: 'a'.repeat(200 * 1024) }, 0)
    expect(r.status).toBe(413)
    expect((await r.json()).error).toBe('storage quota exceeded')
  }, 60_000)

  test('rate limit: 20 writes per minute per sub, then 429', async () => {
    await accept(tokenA)
    let last = 0
    for (let i = 0; i < 22; i++) last = (await put(tokenA, 'r', { i }, 0)).status
    expect(last).toBe(429)
    expect((await put(tokenB, 'r', { i: 0 }, 0)).status).not.toBe(429)
  })

  test('write block returns 503 storage full, reads still work', async () => {
    await accept(tokenA)
    await put(tokenA, 'w', { a: 1 }, 0)
    writeFileSync(join(dir, 'write-block'), '')
    const r = await put(tokenA, 'w', { a: 2 }, 1)
    expect(r.status).toBe(503)
    expect((await r.json()).error).toBe('storage full')
    expect((await call('GET', '/v1/people/docs/w', tokenA)).status).toBe(200)
    expect((await call('DELETE', '/v1/people/docs/w', tokenA)).status).toBe(503)
  })
})

describe('/v1/me', () => {
  test('DELETE /v1/me erases everything for that scope and leaves one audit row', async () => {
    await accept(tokenA)
    await accept(tokenB)
    await put(tokenA, 'a1', { a: 1 }, 0)
    await put(tokenA, 'a1', { a: 2 }, 1)
    await put(tokenB, 'b1', { b: 1 }, 0)
    expect((await call('DELETE', '/v1/me', tokenA)).status).toBe(200)
    const n = async (t: string) =>
      ((await pg.query(`SELECT count(*)::int AS n FROM ${t} WHERE scope = 'user:user-a'`)).rows[0] as any).n
    // Superuser view, so RLS does not hide anything.
    await pg.exec('RESET ROLE')
    expect(await n('people_docs')).toBe(0)
    expect(await n('people_doc_versions')).toBe(0)
    const audit = (await pg.query("SELECT sub_hash, action FROM people_audit")).rows as any[]
    expect(audit.length).toBe(1)
    expect(audit[0].action).toBe('user.erase')
    expect(audit[0].sub_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(audit[0].sub_hash).not.toContain('user-a')
    const u = (await pg.query("SELECT deleted_at FROM people_users WHERE sub = 'user-a'")).rows[0] as any
    expect(u.deleted_at).not.toBeNull()
    expect(((await pg.query("SELECT count(*)::int AS n FROM people_docs WHERE scope = 'user:user-b'")).rows[0] as any).n).toBe(1)
    await pg.exec('SET ROLE agenthydra_app')
    expect((await call('GET', '/v1/people/docs', tokenA)).status).toBe(403)
  })

  test('export is a zip holding only the caller docs', async () => {
    await accept(tokenA)
    await accept(tokenB)
    await put(tokenA, 'mine', { who: 'a-doc' }, 0)
    await put(tokenB, 'theirs', { who: 'b-doc' }, 0)
    const r = await call('GET', '/v1/me/export', tokenA)
    expect(r.headers.get('content-type')).toBe('application/zip')
    const buf = Buffer.from(await r.arrayBuffer())
    expect(buf.readUInt32LE(0)).toBe(0x04034b50)
    const text = buf.toString('latin1')
    expect(text).toContain('people/mine.json')
    expect(text).toContain('a-doc')
    expect(text).not.toContain('theirs')
    expect(text).not.toContain('b-doc')
  })
})

describe('healthz and logs', () => {
  test('healthz shape, no auth needed', async () => {
    writeFileSync(join(dir, 'last-backup'), '')
    const r = await call('GET', '/healthz', null)
    expect(r.status).toBe(200)
    const h = await r.json()
    expect(h).toMatchObject({ ok: true, db: 'ok', jwks: 'ok', writeBlocked: false })
    expect(typeof h.lastBackupAgeSeconds).toBe('number')
  })

  test('logs never contain the Authorization header, the token, or bodies', async () => {
    await accept(tokenA)
    await put(tokenA, 'l', { note: 'body-marker-xyz' }, 0)
    await call('GET', '/v1/people/docs', 'garbage-token')
    const all = logs.join('\n')
    expect(logs.length).toBeGreaterThan(0)
    expect(all).not.toContain('Bearer')
    expect(all).not.toContain(tokenA)
    expect(all).not.toContain('garbage-token')
    expect(all).not.toContain('body-marker-xyz')
  })
})
