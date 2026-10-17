// server/src/cloud-sessions-root.ts - where the opt-in cloud-session snapshots live, and their shape.
//
// Kept apart from cloud-sessions.ts on purpose: the writer there needs the network and the status
// store, while the catalog and the foreign adapter only need the folder. Importing this file runs
// nothing and opens nothing, so the catalog can name the root without starting the poller. It imports
// node:* modules only, for the same reason.

import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLOUD_SESSIONS_ENV = 'AGENTHYDRA_CLOUD_SESSIONS'
export const CLOUD_SESSIONS_DIR_ENV = 'AGENTHYDRA_CLOUD_SESSIONS_DIR'
const ACCOUNT_INDEX = 'accounts.json'
/** The untagged list leaves these out, so each gets its own query. */
export const LISTED_TAGS = ['hearth-thread', 'cowork-remote']
const MAX_TITLE_LENGTH = 500
const MAX_WORD_LENGTH = 64

/** Off unless the flag is exactly 1. Both the poller and the foreign adapter ask this. */
export function cloudSessionsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[CLOUD_SESSIONS_ENV] === '1'
}

/** What the cache keeps per session: the API item reduced to what the adapter and the status need. */
export interface CloudSessionRow {
  id: string
  title: string
  environment_kind: string
  status_bucket: string
  worker_status: string
  unread: boolean
  created_at: string | null
  last_event_at: string
  /** The session's tags. `hearth-thread` marks a thread of a claude.ai Project. */
  tags: string[]
}

/**
 * Whether a value is a row the cache may hold and list: every field has the type and size CloudSessionRow
 * names, and it is a session that runs in Anthropic's cloud or a Project thread. A Remote Control
 * ('bridge') session is left out, since a local one is already listed from its own store.
 */
export function isListedCloudRow(row: unknown): row is CloudSessionRow {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.id)) return false
  if (typeof r.title !== 'string' || r.title.length > MAX_TITLE_LENGTH) return false
  for (const k of ['environment_kind', 'status_bucket', 'worker_status']) {
    const v = r[k]
    if (typeof v !== 'string' || v.length > MAX_WORD_LENGTH) return false
  }
  if (typeof r.unread !== 'boolean') return false
  if (r.created_at !== null && typeof r.created_at !== 'string') return false
  if (typeof r.last_event_at !== 'string' || !Number.isFinite(Date.parse(r.last_event_at)))
    return false
  if (!Array.isArray(r.tags) || !r.tags.every((t) => typeof t === 'string')) return false
  if (r.environment_kind === 'bridge') return false
  return r.environment_kind === 'anthropic_cloud' || r.tags.some((t) => LISTED_TAGS.includes(t))
}

/** The writer and the reader both take their folder from here, so they can never disagree. */
export function cloudSessionsRoot(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return env[CLOUD_SESSIONS_DIR_ENV]?.trim() || join(home, '.agenthydra', 'cloud-sessions')
}

/** Session titles are chat text: the folders are the owner's alone where the OS has POSIX modes. */
function makePrivateDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  try {
    chmodSync(dir, 0o700)
  } catch {
    // Windows ACLs, or a filesystem without POSIX modes; the per-user location is the guard there.
  }
}

/** Written whole to a temp file and renamed into place, so a reader never sees half a file. */
function writeWhole(dir: string, name: string, text: string): void {
  const tmp = join(dir, `${name}.tmp`)
  writeFileSync(tmp, text, { mode: 0o600 })
  renameSync(tmp, join(dir, name))
}

export function writeCloudSnapshot(
  root: string,
  accountKey: string,
  rows: CloudSessionRow[],
): void {
  const dir = join(root, accountKey)
  makePrivateDir(dir)
  writeWhole(
    dir,
    'sessions.json',
    JSON.stringify({ written_at: new Date().toISOString(), sessions: rows }),
  )
}

/**
 * The account keys the poller polled on its last pass, written at the root beside the account folders.
 * The adapter lists only folders named here, so a folder left by a login that is gone stays unlisted.
 */
export function writeAccountIndex(root: string, accountKeys: string[]): void {
  makePrivateDir(root)
  writeWhole(
    root,
    ACCOUNT_INDEX,
    JSON.stringify({ written_at: new Date().toISOString(), accounts: accountKeys }),
  )
}

/** The account keys the last pass polled; none when the index is missing or unreadable. */
export function readAccountIndex(root: string): string[] {
  try {
    const index = JSON.parse(readFileSync(join(root, ACCOUNT_INDEX), 'utf8')) as {
      accounts?: unknown
    }
    return Array.isArray(index?.accounts)
      ? index.accounts.filter((k): k is string => typeof k === 'string')
      : []
  } catch {
    return []
  }
}

/**
 * The rows an account's snapshot holds, as written; none when the file is missing or unreadable. Not
 * type-checked: a reader that lists or releases from them filters them with isListedCloudRow.
 */
export function readCloudSnapshot(dir: string): unknown[] {
  try {
    const snap = JSON.parse(readFileSync(join(dir, 'sessions.json'), 'utf8')) as {
      sessions?: unknown
    }
    return Array.isArray(snap?.sessions) ? snap.sessions : []
  } catch {
    return []
  }
}
