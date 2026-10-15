import { createHash } from 'node:crypto'
import { type Keyring, open, seal } from '../../crypto'
import { type Db, withScope } from '../../db'
import { MAX_DOC_BYTES, MAX_USER_BYTES, MAX_USER_DOCS, PAGE_SIZE } from '../../limits'

export class StoreError extends Error {
  constructor(
    public status: number,
    message: string,
    public hint = '',
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export interface DocMeta {
  id: string
  version: number
  bytes: number
  updatedAt: string
}

export interface Preferences {
  trainingUse: boolean
  termsVersion: string
}

const aadOf = (sub: string, docId: string, version: number) => `user:${sub}/${docId}/${version}`
const iso = (v: unknown) => (v instanceof Date ? v : new Date(v as string)).toISOString()

export const hashWithSalt = (salt: string, v: string) =>
  createHash('sha256').update(`${salt}:${v}`).digest('hex')

export class PeopleStore {
  constructor(
    private db: Db,
    private ring: Keyring,
    private salt: string,
  ) {}

  async isDeleted(sub: string): Promise<boolean> {
    const r = await this.db.query('SELECT deleted_at FROM people_users WHERE sub = $1', [sub])
    return !!r[0]?.deleted_at
  }

  async getPreferences(sub: string): Promise<Preferences> {
    const r = await this.db.query(
      'SELECT training_use, terms_version FROM people_users WHERE sub = $1',
      [sub],
    )
    return { trainingUse: r[0] ? !!r[0].training_use : true, termsVersion: r[0]?.terms_version ?? '' }
  }

  async setPreferences(sub: string, p: Preferences): Promise<void> {
    await this.db.query(
      `INSERT INTO people_users (sub, training_use, terms_version, terms_accepted_at, training_use_off_at)
       VALUES ($1, $2::boolean, NULLIF($3::text, ''), CASE WHEN $3::text <> '' THEN now() END,
               CASE WHEN $2::boolean THEN NULL ELSE now() END)
       ON CONFLICT (sub) DO UPDATE SET
         training_use = $2::boolean,
         training_use_off_at = CASE WHEN $2::boolean THEN NULL
                                    ELSE COALESCE(people_users.training_use_off_at, now()) END,
         terms_accepted_at = CASE WHEN $3::text <> '' AND people_users.terms_version IS DISTINCT FROM $3::text
                                  THEN now() ELSE people_users.terms_accepted_at END,
         terms_version = COALESCE(NULLIF($3::text, ''), people_users.terms_version)`,
      [sub, p.trainingUse, p.termsVersion],
    )
  }

  list(sub: string, cursor: string | null) {
    return withScope(this.db, sub, async (tx) => {
      const rows = await tx.query(
        `SELECT doc_id, version, bytes, updated_at FROM people_docs
         WHERE deleted_at IS NULL AND ($1::text IS NULL OR doc_id > $1::text)
         ORDER BY doc_id LIMIT ${PAGE_SIZE + 1}`,
        [cursor],
      )
      const page = rows.slice(0, PAGE_SIZE)
      return {
        docs: page.map(
          (r): DocMeta => ({
            id: r.doc_id,
            version: r.version,
            bytes: r.bytes,
            updatedAt: iso(r.updated_at),
          }),
        ),
        nextCursor: rows.length > PAGE_SIZE ? (page[page.length - 1]!.doc_id as string) : null,
      }
    })
  }

  private decrypt(sub: string, docId: string, r: Record<string, any>): unknown {
    const plain = open(
      this.ring,
      sub,
      { ciphertext: r.body, nonce: r.nonce, keyId: r.key_id },
      aadOf(sub, docId, r.version),
    )
    return JSON.parse(plain.toString('utf8'))
  }

  read(sub: string, docId: string) {
    return withScope(this.db, sub, async (tx) => {
      const r = (
        await tx.query(
          'SELECT version, body, nonce, key_id FROM people_docs WHERE doc_id = $1 AND deleted_at IS NULL',
          [docId],
        )
      )[0]
      if (!r) return null
      return { doc: this.decrypt(sub, docId, r), version: r.version as number }
    })
  }

  async write(sub: string, docId: string, doc: unknown, baseVersion: number) {
    const plain = Buffer.from(JSON.stringify(doc), 'utf8')
    if (plain.length > MAX_DOC_BYTES)
      throw new StoreError(413, 'doc too large', `A doc is at most ${MAX_DOC_BYTES / 1024} KB.`)
    return withScope(this.db, sub, async (tx) => {
      const user = (
        await tx.query('SELECT terms_version, deleted_at FROM people_users WHERE sub = $1', [sub])
      )[0]
      if (user?.deleted_at) throw new StoreError(403, 'account deleted', 'This account was erased.')
      if (!user?.terms_version)
        throw new StoreError(403, 'terms not accepted', 'PUT /v1/me/preferences with a termsVersion first.')
      const cur = (
        await tx.query(
          'SELECT version, bytes, deleted_at FROM people_docs WHERE doc_id = $1 FOR UPDATE',
          [docId],
        )
      )[0]
      const live = !!cur && !cur.deleted_at
      const currentVersion = live ? (cur!.version as number) : 0
      if (baseVersion !== currentVersion)
        throw new StoreError(409, 'version conflict', 'Re-read the doc and retry.', { currentVersion })
      const usage = (
        await tx.query(
          'SELECT count(*)::int AS n, COALESCE(sum(bytes), 0)::bigint AS b FROM people_docs WHERE deleted_at IS NULL',
        )
      )[0]!
      if (!live && usage.n >= MAX_USER_DOCS)
        throw new StoreError(413, 'too many docs', `At most ${MAX_USER_DOCS} docs per user.`)
      if (Number(usage.b) - (live ? cur!.bytes : 0) + plain.length > MAX_USER_BYTES)
        throw new StoreError(413, 'storage quota exceeded', `At most ${MAX_USER_BYTES / 1024 / 1024} MB per user.`)

      const version = cur ? (cur.version as number) + 1 : 1
      const s = seal(this.ring, sub, plain, aadOf(sub, docId, version))
      if (cur) {
        // Keep every replaced row: the previous ciphertext is copied untouched.
        await tx.query(
          `INSERT INTO people_doc_versions (scope, doc_id, version, body, nonce, key_id, bytes, updated_at, deleted_at)
           SELECT scope, doc_id, version, body, nonce, key_id, bytes, updated_at, deleted_at
           FROM people_docs WHERE doc_id = $1
           ON CONFLICT DO NOTHING`,
          [docId],
        )
        await tx.query(
          `UPDATE people_docs SET version = $2, body = $3, nonce = $4, key_id = $5, bytes = $6,
             updated_at = now(), deleted_at = NULL WHERE doc_id = $1`,
          [docId, version, s.ciphertext, s.nonce, s.keyId, plain.length],
        )
      } else {
        await tx.query(
          `INSERT INTO people_docs (scope, doc_id, version, body, nonce, key_id, bytes)
           VALUES (current_setting('people.scope'), $1, $2, $3, $4, $5, $6)`,
          [docId, version, s.ciphertext, s.nonce, s.keyId, plain.length],
        )
      }
      return { version }
    })
  }

  remove(sub: string, docId: string) {
    return withScope(this.db, sub, async (tx) => {
      const r = await tx.query(
        'UPDATE people_docs SET deleted_at = now() WHERE doc_id = $1 AND deleted_at IS NULL RETURNING 1 AS x',
        [docId],
      )
      return r.length > 0
    })
  }

  /** Every live doc of this user, decrypted, for the export. */
  exportDocs(sub: string) {
    return withScope(this.db, sub, async (tx) => {
      const rows = await tx.query(
        'SELECT doc_id, version, body, nonce, key_id FROM people_docs WHERE deleted_at IS NULL ORDER BY doc_id',
      )
      return rows.map((r) => ({
        id: r.doc_id as string,
        version: r.version as number,
        doc: this.decrypt(sub, r.doc_id, r),
      }))
    })
  }

  /** This module's part of DELETE /v1/me; RLS limits both deletes to the caller's scope. */
  async eraseInTx(tx: Db): Promise<void> {
    await tx.query('DELETE FROM people_doc_versions')
    await tx.query('DELETE FROM people_docs')
  }

  private audit(tx: Db, sub: string, action: string, docId: string | null, requestId: string) {
    return tx.query(
      'INSERT INTO people_audit (sub_hash, action, doc_id, request_id) VALUES ($1, $2, $3, $4)',
      [hashWithSalt(this.salt, sub), action, docId, requestId || null],
    )
  }

  /** DELETE /v1/me: hard-delete every module's rows, tombstone the user, one audit row. */
  eraseUser(sub: string, modules: ((tx: Db) => Promise<void>)[], requestId = '') {
    return withScope(this.db, sub, async (tx) => {
      for (const m of modules) await m(tx)
      await tx.query(
        `INSERT INTO people_users (sub, training_use, deleted_at) VALUES ($1, false, now())
         ON CONFLICT (sub) DO UPDATE SET deleted_at = now(), training_use = false,
           terms_version = NULL, terms_accepted_at = NULL`,
        [sub],
      )
      await this.audit(tx, sub, 'user.erase', null, requestId)
    })
  }
}
