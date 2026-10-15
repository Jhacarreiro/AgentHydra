import { existsSync, statSync } from 'node:fs'
import type { Config } from './config'
import type { Db } from './db'

export interface HealthDeps {
  db: Db
  cfg: Pick<Config, 'writeBlockFile' | 'backupStampFile' | 'auth'>
  /** Test hook; default fetches the JWKS URL. */
  jwksCheck?: () => Promise<boolean>
}

async function defaultJwks(url?: string): Promise<boolean> {
  if (!url) return false
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
    await r.arrayBuffer()
    return r.ok
  } catch {
    return false
  }
}

export async function health(d: HealthDeps) {
  let dbOk = false
  try {
    dbOk = (await d.db.query('SELECT 1 AS ok'))[0]?.ok === 1
  } catch {}
  const jwksOk = await (d.jwksCheck ? d.jwksCheck() : defaultJwks(d.cfg.auth.jwksUrl))
  let backupAgeSeconds: number | null = null
  try {
    backupAgeSeconds = Math.max(0, Math.round((Date.now() - statSync(d.cfg.backupStampFile).mtimeMs) / 1000))
  } catch {}
  const writeBlocked = existsSync(d.cfg.writeBlockFile)
  return {
    ok: dbOk && jwksOk && !writeBlocked,
    db: dbOk ? 'ok' : 'down',
    jwks: jwksOk ? 'ok' : 'unreachable',
    writeBlocked,
    lastBackupAgeSeconds: backupAgeSeconds,
  }
}
