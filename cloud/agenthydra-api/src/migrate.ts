import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Minimal driver surface so Bun.sql in production and PGlite in tests both fit. */
export interface Db {
  exec(text: string): Promise<void>
  query(text: string, params?: unknown[]): Promise<Record<string, any>[]>
  begin<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

/** Adapter over a Bun.sql instance. */
export function fromBunSql(sql: any): Db {
  const wrap = (c: any): Db => ({
    exec: async (t) => {
      await c.unsafe(t)
    },
    query: async (t, p = []) => [...(await c.unsafe(t, p))],
    begin: (fn) => c.begin((tx: any) => fn(wrap(tx))),
  })
  return wrap(sql)
}

// Source tree: src/../migrations. Release bundle: migrate.js sits beside migrations/.
const besideBundle = join(import.meta.dir, 'migrations')
export const defaultMigrationsDir = existsSync(besideBundle)
  ? besideBundle
  : join(import.meta.dir, '..', 'migrations')

export function checksum(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')
}

export async function migrate(db: Db, dir = defaultMigrationsDir): Promise<{ applied: string[] }> {
  const files = readdirSync(dir)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort()
  await db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
  )
  const done = new Map(
    (await db.query('SELECT name, checksum FROM schema_migrations')).map((r) => [
      r.name as string,
      r.checksum as string,
    ]),
  )
  for (const name of done.keys()) {
    if (!files.includes(name)) throw new Error(`applied migration ${name} is missing from ${dir}`)
  }
  const applied: string[] = []
  for (const name of files) {
    const text = readFileSync(join(dir, name), 'utf8')
    const sum = checksum(text)
    const prior = done.get(name)
    if (prior !== undefined) {
      if (prior !== sum) throw new Error(`migration ${name} changed after it was applied`)
      continue
    }
    await db.begin(async (tx) => {
      await tx.exec(text)
      await tx.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, sum])
    })
    applied.push(name)
  }
  return { applied }
}

if (import.meta.main) {
  const url = process.env.AGENTHYDRA_OWNER_DATABASE_URL ?? process.env.DATABASE_URL
  if (!url) throw new Error('AGENTHYDRA_OWNER_DATABASE_URL or DATABASE_URL is not set')
  const sql = new Bun.SQL(url)
  const r = await migrate(fromBunSql(sql))
  console.log(r.applied.length ? `applied: ${r.applied.join(', ')}` : 'up to date')
  await sql.close()
}
