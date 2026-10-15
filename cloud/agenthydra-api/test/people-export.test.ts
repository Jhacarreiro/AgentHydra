import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { type Keyring, seal } from '../src/crypto'
import { type Db, migrate } from '../src/migrate'
import { docAad, pseudonym, runExport } from '../src/modules/people/export'

function fromPglite(c: any): Db {
  return {
    exec: async (t) => {
      await c.exec(t)
    },
    query: async (t, p = []) => (await c.query(t, p)).rows,
    begin: (fn) => c.transaction((tx: any) => fn(fromPglite(tx))),
  }
}

const roles = readFileSync(join(import.meta.dir, '..', 'bootstrap', 'roles.sql'), 'utf8')
const SALT = 'test-salt-0123456789-0123456789-abcdef'
const ring: Keyring = { current: 1, keys: new Map([[1, randomBytes(32)]]) }
const RUN_DAY = new Date('2026-10-15T03:00:00Z')
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/

let pg: PGlite
let db: Db
let root: string

beforeEach(async () => {
  pg = new PGlite()
  await pg.exec(roles)
  db = fromPglite(pg)
  await migrate(db)
  root = mkdtempSync(join(tmpdir(), 'people-export-'))
})

afterEach(async () => {
  await pg.close()
  rmSync(root, { recursive: true, force: true })
})

async function addUser(
  sub: string,
  o: { training?: boolean; terms?: boolean; deleted?: boolean } = {},
) {
  const terms = o.terms ?? true
  await db.query(
    'INSERT INTO people_users (sub, training_use, terms_version, terms_accepted_at, deleted_at) VALUES ($1, $2, $3, $4, $5)',
    [
      sub,
      o.training ?? true,
      terms ? 'v1' : null,
      terms ? '2026-10-01T00:00:00Z' : null,
      o.deleted ? '2026-10-02T00:00:00Z' : null,
    ],
  )
}

async function addDoc(sub: string, docId: string, doc: unknown, version = 1) {
  const s = seal(
    ring,
    sub,
    new TextEncoder().encode(JSON.stringify(doc)),
    docAad(sub, docId, version),
  )
  await db.query(
    'INSERT INTO people_docs (scope, doc_id, version, body, nonce, key_id, bytes) VALUES ($1, $2, $3, $4, $5, $6, $7)',
    [
      `user:${sub}`,
      docId,
      version,
      new Uint8Array(s.ciphertext),
      new Uint8Array(s.nonce),
      s.keyId,
      s.ciphertext.length,
    ],
  )
}

/** Runs the job the way the timer does: as the export role, which reads only the view. */
async function runJob(now: Date = RUN_DAY) {
  await pg.exec('SET ROLE agenthydra_export')
  try {
    return await runExport({ db, ring, salt: SALT, outRoot: root, now })
  } finally {
    await pg.exec('RESET ROLE')
  }
}

function readLines(day = '2026-10-15'): any[] {
  return readFileSync(join(root, day, 'people.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

describe('people training export', () => {
  test('opted-out users are absent and the next run drops them', async () => {
    await addUser('sub-7f3c01')
    await addUser('sub-7f3c02', { training: false })
    await addDoc('sub-7f3c01', 'friend-1', { note: 'in' })
    await addDoc('sub-7f3c02', 'friend-1', { note: 'out' })

    await runJob()
    expect(readLines().map((l) => l.pseudonym)).toEqual([pseudonym(SALT, 'sub-7f3c01')])

    await pg.exec("UPDATE people_users SET training_use = false WHERE sub = 'sub-7f3c01'")
    await runJob()
    expect(readLines()).toEqual([])
  })

  test('deleted users are absent', async () => {
    await addUser('sub-7f3c03', { deleted: true })
    await addDoc('sub-7f3c03', 'friend-1', { note: 'gone' })

    await runJob()
    expect(readLines()).toEqual([])
  })

  test('users without accepted terms are absent', async () => {
    await addUser('sub-7f3c04', { terms: false })
    await addDoc('sub-7f3c04', 'friend-1', { note: 'no terms' })

    await runJob()
    expect(readLines()).toEqual([])
  })

  test('pseudonym is stable across runs and differs per user', async () => {
    await addUser('sub-7f3c05')
    await addUser('sub-7f3c06')
    await addDoc('sub-7f3c05', 'friend-1', { note: 'a' })
    await addDoc('sub-7f3c06', 'friend-1', { note: 'b' })

    await runJob(RUN_DAY)
    await runJob(new Date('2026-10-16T03:00:00Z'))
    const first = readLines('2026-10-15').map((l) => l.pseudonym)
    const second = readLines('2026-10-16').map((l) => l.pseudonym)

    expect(new Set(first).size).toBe(2)
    expect(first.sort()).toEqual(second.sort())
    expect(first.sort()).toEqual(
      [pseudonym(SALT, 'sub-7f3c05'), pseudonym(SALT, 'sub-7f3c06')].sort(),
    )
  })

  test('no line contains the sub or an email-like string', async () => {
    await addUser('sub-7f3c07')
    await addDoc('sub-7f3c07', 'friend-1', { name: 'Ada Lovelace', note: 'met at the lab' })

    await runJob()
    const raw = readFileSync(join(root, '2026-10-15', 'people.jsonl'), 'utf8')
    expect(raw).not.toContain('sub-7f3c07')
    expect(raw).not.toMatch(EMAIL)
    const line = readLines()[0]
    expect(Object.keys(line).sort()).toEqual(['doc', 'docId', 'pseudonym', 'updatedAt', 'version'])
    expect(line.doc).toEqual({ name: 'Ada Lovelace', note: 'met at the lab' })
  })

  test('portraits are dropped by id and by a portrait field', async () => {
    await addUser('sub-7f3c08')
    await addDoc('sub-7f3c08', 'portrait-1', { note: 'by id' })
    await addDoc('sub-7f3c08', 'Portrait:abc', { note: 'by id, other case' })
    await addDoc('sub-7f3c08', 'people-x', { portrait: 'data:image/png;base64,AAAA' })
    await addDoc('sub-7f3c08', 'friend-1', { note: 'kept' })

    const result = await runJob()
    expect(readLines().map((l) => l.docId)).toEqual(['friend-1'])
    expect(result).toMatchObject({ users: 1, docs: 1, skipped: 3 })
  })

  test('snapshots older than 30 days are removed', async () => {
    await addUser('sub-7f3c09')
    await addDoc('sub-7f3c09', 'friend-1', { note: 'x' })
    for (const day of ['2026-08-01', '2026-09-15', '2026-09-20']) {
      mkdirSync(join(root, day), { recursive: true })
    }

    const result = await runJob()
    expect(result.removed).toEqual(['2026-08-01'])
    expect(existsSync(join(root, '2026-08-01'))).toBe(false)
    expect(existsSync(join(root, '2026-09-15'))).toBe(true)
    expect(existsSync(join(root, '2026-09-20'))).toBe(true)
  })

  test('audit row with counts is written', async () => {
    await addUser('sub-7f3c10')
    await addDoc('sub-7f3c10', 'friend-1', { note: 'x' })
    await addDoc('sub-7f3c10', 'portrait-2', { note: 'y' })

    await runJob()
    const rows = await db.query(
      "SELECT sub_hash, request_id, detail FROM people_audit WHERE action = 'training_export'",
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.sub_hash).toBe('system')
    expect(rows[0]!.request_id).toBe('training-export-2026-10-15')
    expect(rows[0]!.detail).toMatchObject({ users: 1, docs: 1, skipped: 1, unreadable: 0 })
  })

  test('export role cannot read the base tables', async () => {
    await pg.exec('SET ROLE agenthydra_export')
    try {
      await expect(db.query('SELECT 1 FROM people_docs')).rejects.toThrow()
      await expect(db.query('SELECT 1 FROM people_users')).rejects.toThrow()
    } finally {
      await pg.exec('RESET ROLE')
    }
  })
})
