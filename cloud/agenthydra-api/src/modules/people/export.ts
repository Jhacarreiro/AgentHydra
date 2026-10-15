import { createHmac } from 'node:crypto'
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Keyring, keyringFromEnv, open } from '../../crypto'
import { type Db, fromBunSql } from '../../migrate'

export const RETENTION_DAYS = 30
const SNAPSHOT_DIR = /^\d{4}-\d{2}-\d{2}$/

/**
 * Portraits never enter training data. A doc is dropped when its id contains "portrait"
 * or its JSON has a top-level `portrait` key. When unsure, drop.
 */
export function isPortrait(docId: string, doc?: unknown): boolean {
  if (/portrait/i.test(docId)) return true
  return doc !== undefined && typeof doc === 'object' && doc !== null && 'portrait' in doc
}

export function pseudonym(salt: string, sub: string): string {
  return createHmac('sha256', salt).update(sub).digest('hex')
}

/** Must match the AAD the routes seal docs with. */
export function docAad(sub: string, docId: string, version: number): string {
  return `user:${sub}/${docId}/${version}`
}

export interface ExportOptions {
  db: Db
  ring: Keyring
  salt: string
  outRoot: string
  now: Date
}

export interface ExportResult {
  date: string
  users: number
  docs: number
  skipped: number
  unreadable: number
  removed: string[]
}

export async function runExport(o: ExportOptions): Promise<ExportResult> {
  const date = o.now.toISOString().slice(0, 10)
  const dir = join(o.outRoot, date)
  const file = join(dir, 'people.jsonl')
  const tmp = `${file}.tmp`
  mkdirSync(dir, { recursive: true, mode: 0o700 })

  const subs = (await o.db.query('SELECT DISTINCT sub FROM training_eligible ORDER BY sub')).map(
    (r) => r.sub as string,
  )
  writeFileSync(tmp, '', { mode: 0o600 })

  let users = 0
  let docs = 0
  let skipped = 0
  let unreadable = 0
  try {
    for (const sub of subs) {
      const rows = await o.db.query(
        'SELECT doc_id, version, body, nonce, key_id, updated_at FROM training_eligible WHERE sub = $1 ORDER BY doc_id, version',
        [sub],
      )
      const pseud = pseudonym(o.salt, sub)
      let lines = ''
      for (const r of rows) {
        const docId = r.doc_id as string
        if (isPortrait(docId)) {
          skipped++
          continue
        }
        let doc: unknown
        try {
          const plain = open(
            o.ring,
            sub,
            {
              ciphertext: Buffer.from(r.body),
              nonce: Buffer.from(r.nonce),
              keyId: r.key_id as number,
            },
            docAad(sub, docId, r.version as number),
          )
          doc = JSON.parse(plain.toString('utf8'))
        } catch {
          unreadable++
          continue
        }
        if (isPortrait(docId, doc)) {
          skipped++
          continue
        }
        lines += `${JSON.stringify({
          pseudonym: pseud,
          docId,
          version: r.version,
          updatedAt: new Date(r.updated_at as Date).toISOString(),
          doc,
        })}\n`
        docs++
      }
      if (lines) {
        appendFileSync(tmp, lines)
        users++
      }
    }
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw err
  }

  await o.db.query(
    "INSERT INTO people_audit (sub_hash, action, request_id, detail) VALUES ('system', 'training_export', $1, $2::jsonb)",
    [`training-export-${date}`, JSON.stringify({ date, users, docs, skipped, unreadable })],
  )

  const cutoff = new Date(o.now.getTime() - RETENTION_DAYS * 86_400_000).toISOString().slice(0, 10)
  const removed: string[] = []
  for (const name of readdirSync(o.outRoot)) {
    if (SNAPSHOT_DIR.test(name) && name < cutoff) {
      rmSync(join(o.outRoot, name), { recursive: true, force: true })
      removed.push(name)
    }
  }

  return { date, users, docs, skipped, unreadable, removed }
}

if (import.meta.main) {
  const env = process.env
  const required = (name: string): string => {
    const v = env[name]
    if (!v) throw new Error(`${name} is not set`)
    return v
  }
  const salt = required('AGENTHYDRA_EXPORT_SALT')
  if (salt.length < 32) throw new Error('AGENTHYDRA_EXPORT_SALT must be at least 32 characters')
  const ring = keyringFromEnv(required('AGENTHYDRA_MASTER_KEYS'))
  const sql = new Bun.SQL(required('AGENTHYDRA_EXPORT_DATABASE_URL'))
  try {
    const result = await runExport({
      db: fromBunSql(sql),
      ring,
      salt,
      outRoot: env.AGENTHYDRA_EXPORT_DIR || '/var/lib/agenthydra/people-export',
      now: new Date(),
    })
    console.log(JSON.stringify(result))
  } finally {
    await sql.close()
  }
}
