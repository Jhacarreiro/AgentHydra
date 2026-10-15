import { type AuthConfig } from './auth'
import { type Keyring, keyringFromEnv } from './crypto'

export interface Config {
  port: number
  databaseUrl: string
  auth: AuthConfig
  keyring: Keyring
  auditSalt: string
  writeBlockFile: string
  backupStampFile: string
  /** Trust CF-Connecting-IP only when the TCP peer is loopback (Caddy). */
  trustProxyHeader: boolean
}

type Env = Record<string, string | undefined>

/** `AGENTHYDRA_API_<NAME>` wins; the deploy env file's `AGENTHYDRA_<NAME>` is the fallback. */
function pick(env: Env, name: string): string | undefined {
  return env[`AGENTHYDRA_API_${name}`] ?? env[`AGENTHYDRA_${name}`]
}

function need(env: Env, name: string): string {
  const v = pick(env, name)
  if (!v) throw new Error(`AGENTHYDRA_API_${name} is not set`)
  return v
}

export function loadConfig(env: Env = process.env): Config {
  const port = Number(pick(env, 'PORT') ?? 18790)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad AGENTHYDRA_API_PORT')
  const keys = pick(env, 'MASTER_KEYS')
  const single = pick(env, 'MASTER_KEY')
  const keyring = keyringFromEnv(keys ?? (single ? `1:${single}` : ''))
  return {
    port,
    databaseUrl: need(env, 'DATABASE_URL'),
    auth: {
      jwksUrl: need(env, 'JWKS_URL'),
      issuer: need(env, 'JWT_ISSUER'),
      audience: need(env, 'JWT_AUDIENCE'),
    },
    keyring,
    auditSalt: need(env, 'AUDIT_SALT'),
    writeBlockFile: pick(env, 'WRITE_BLOCK_FILE') ?? '/run/agenthydra/write-block',
    backupStampFile: pick(env, 'BACKUP_STAMP_FILE') ?? '/var/backups/agenthydra/last-backup',
    trustProxyHeader: pick(env, 'TRUST_PROXY') !== '0',
  }
}
