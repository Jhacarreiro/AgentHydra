import { beforeEach, describe, expect, test } from 'bun:test'
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { type Db, migrate } from '../src/migrate'

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

async function fresh() {
  const pg = new PGlite()
  await pg.exec(roles)
  return { pg, db: fromPglite(pg) }
}

/** Run as the non-superuser runtime role (superusers bypass RLS). */
async function asApp<T>(pg: PGlite, scope: string | null, fn: () => Promise<T>): Promise<T> {
  await pg.exec('SET ROLE agenthydra_app')
  try {
    if (scope !== null) await pg.query("SELECT set_config('people.scope', $1, false)", [scope])
    return await fn()
  } finally {
    await pg.exec('RESET people.scope')
    await pg.exec('RESET ROLE')
  }
}

const ins =
  "INSERT INTO people_docs (scope, doc_id, version, body, nonce, key_id, bytes) VALUES ($1, 'd1', 1, '\\x00', '\\x01', 1, 1)"
const insV =
  "INSERT INTO people_doc_versions (scope, doc_id, version, body, nonce, key_id, bytes) VALUES ($1, 'd1', 1, '\\x00', '\\x01', 1, 1)"

describe('migrate', () => {
  let ctx: Awaited<ReturnType<typeof fresh>>
  beforeEach(async () => {
    ctx = await fresh()
  })

  test('applies in order, then re-running is a no-op', async () => {
    const first = await migrate(ctx.db)
    expect(first.applied).toEqual([
      '0001_tables.sql',
      '0002_rls.sql',
      '0003_view_indexes.sql',
      '0004_grants.sql',
    ])
    expect((await migrate(ctx.db)).applied).toEqual([])
  })

  test('refuses a changed applied file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'people-mig-'))
    cpSync(join(import.meta.dir, '..', 'migrations'), dir, { recursive: true })
    await migrate(ctx.db, dir)
    writeFileSync(
      join(dir, '0001_tables.sql'),
      `${readFileSync(join(dir, '0001_tables.sql'), 'utf8')}\n-- edited\n`,
    )
    await expect(migrate(ctx.db, dir)).rejects.toThrow(/changed after it was applied/)
  })

  test('a failing migration rolls back and is not recorded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'people-mig-'))
    writeFileSync(join(dir, '0001_bad.sql'), 'CREATE TABLE t1 (a int); SELECT nope FROM missing;')
    await expect(migrate(ctx.db, dir)).rejects.toThrow()
    expect((await ctx.db.query('SELECT * FROM schema_migrations')).length).toBe(0)
    expect((await ctx.db.query("SELECT to_regclass('t1') AS r"))[0]!.r).toBeNull()
  })

  test('RLS blocks a cross-scope read under the runtime role', async () => {
    await migrate(ctx.db)
    await asApp(ctx.pg, 'user:a', () => ctx.pg.query(ins, ['user:a']))
    await asApp(ctx.pg, 'user:b', () => ctx.pg.query(ins, ['user:b']))
    const seenByA = await asApp(
      ctx.pg,
      'user:a',
      async () => (await ctx.pg.query('SELECT scope FROM people_docs')).rows,
    )
    expect(seenByA).toEqual([{ scope: 'user:a' }])
    const unscoped = await asApp(
      ctx.pg,
      null,
      async () => (await ctx.pg.query('SELECT scope FROM people_docs')).rows,
    )
    expect(unscoped).toEqual([])
    // writing into someone else's scope is refused too
    await expect(asApp(ctx.pg, 'user:a', () => ctx.pg.query(ins, ['user:b']))).rejects.toThrow(
      /row-level security/,
    )
    // and A cannot touch B's row
    const upd = await asApp(ctx.pg, 'user:a', () =>
      ctx.pg.query("UPDATE people_docs SET bytes = 9 WHERE scope = 'user:b'"),
    )
    expect(upd.affectedRows).toBe(0)
  })

  test('versions table is append-only for the runtime role', async () => {
    await migrate(ctx.db)
    await asApp(ctx.pg, 'user:a', () => ctx.pg.query(insV, ['user:a']))
    expect(
      (
        await asApp(
          ctx.pg,
          'user:a',
          async () => (await ctx.pg.query('SELECT 1 FROM people_doc_versions')).rows,
        )
      ).length,
    ).toBe(1)
    await expect(
      asApp(ctx.pg, 'user:a', () => ctx.pg.query('UPDATE people_doc_versions SET bytes = 2')),
    ).rejects.toThrow(/permission denied/)
    await expect(
      asApp(ctx.pg, 'user:a', () => ctx.pg.query('DELETE FROM people_doc_versions')),
    ).rejects.toThrow(/permission denied/)
  })

  test('training_eligible hides opted-out and deleted users', async () => {
    await migrate(ctx.db)
    await ctx.pg.exec(`
      INSERT INTO people_users (sub, training_use) VALUES ('in', true), ('out', false);
      INSERT INTO people_users (sub, deleted_at) VALUES ('gone', now());`)
    for (const s of ['in', 'out', 'gone']) await ctx.pg.query(ins, [`user:${s}`])
    await ctx.pg.exec('SET ROLE agenthydra_export')
    const rows = (await ctx.pg.query('SELECT user_ref FROM training_eligible')).rows as {
      user_ref: string
    }[]
    await expect(ctx.pg.query('SELECT * FROM people_docs')).rejects.toThrow(/permission denied/)
    await ctx.pg.exec('RESET ROLE')
    expect(rows.length).toBe(1)
    expect(rows[0]!.user_ref).toMatch(/^[0-9a-f]{64}$/)
  })
})
