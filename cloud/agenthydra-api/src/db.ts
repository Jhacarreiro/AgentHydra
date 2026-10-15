import { type Db, fromBunSql } from './migrate'

export type { Db }

/** Production: Bun.sql connected as the runtime role (agenthydra_app). */
export function openDb(url: string): { db: Db; close: () => Promise<void> } {
  const sql = new Bun.SQL(url)
  return { db: fromBunSql(sql), close: () => sql.close() }
}

/**
 * Runs `fn` in a transaction whose RLS scope is this user. `set_config(..., true)` is
 * transaction-local, so the scope cannot leak to the next request on a pooled connection.
 */
export function withScope<T>(db: Db, sub: string, fn: (tx: Db) => Promise<T>): Promise<T> {
  return db.begin(async (tx) => {
    await tx.query("SELECT set_config('people.scope', $1, true)", [`user:${sub}`])
    return fn(tx)
  })
}
