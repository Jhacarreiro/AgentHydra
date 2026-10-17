// server/src/cloud-sessions.ts - Claude Code cloud sessions and claude.ai Project threads.
// Remote Control sessions are not listed: a local one already is, from its own store.
//
// WHY THIS EXISTS. Every other source AgentHydra reads is a store on this disk. A cloud session has no
// local store, so the only list of them is the one claude.ai's sessions page reads. This poller asks
// that list, once a minute, for the logins this PC already holds, and writes what it learns where the
// rest of the app reads: a per-account snapshot the `claude-cloud` foreign adapter lists, and the live
// status store, as `claude-cloud` rows.
//
// OFF BY DEFAULT. Nothing here runs unless AGENTHYDRA_CLOUD_SESSIONS=1. Read-only: it never changes
// Claude's own autoUploadSessions or remoteControlAtStartup settings.
//
// CREDENTIALS. Value-blind, as in usage-api.ts. The CLI's OAuth access token goes into a request header
// and nowhere else: never persisted, logged or sent to a browser. It is never refreshed here, because
// the refresh token rotates in a family the CLI shares, and refreshing it would log the CLI out. An
// account whose token is refused (401/403) is skipped until the CLI writes a new one.
//
// WHAT COUNTS AS CLEAN. A pass over one account is clean only when both its untagged and its tagged
// query answered. Only a clean pass may release status rows, and only the rows that account's own
// previous snapshot named. A failed, refused or backed-off account changes nothing of its own.

import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentStatusEvent } from './agent-status'
import { recordAgentStatus, releaseCloudStatus } from './agent-status'
import {
  type CloudSessionRow,
  cloudSessionsEnabled,
  cloudSessionsRoot,
  isListedCloudRow,
  LISTED_TAGS,
  readCloudSnapshot,
  writeAccountIndex,
  writeCloudSnapshot,
} from './cloud-sessions-root'
import { accountUuidOfClaudeJson, orgUuidOfClaudeJson } from './core/account-holders'
import { resolveCliConfigDirToken } from './core/accounts'
import { listCliInstances } from './core/cli-instances'
import { claudeUserAgent, parseRetryAfter } from './usage-api'

/** The scope the sessions endpoint needs. A login without it is skipped, not retried. */
export const SESSIONS_SCOPE = 'user:sessions:claude_code'
export const SESSIONS_URL = 'https://api.anthropic.com/v1/code/sessions'
const ANTHROPIC_VERSION = '2023-06-01'
export const CLOUD_SESSIONS_TICK_MS = 60_000
const REQUEST_TIMEOUT_MS = 15_000
const LIST_LIMIT = 100
const MAX_PAGES = 20
/** Used when a 429 names no Retry-After. Never longer than an hour, whatever the server says. */
const BACKOFF_DEFAULT_MS = 5 * 60_000
const BACKOFF_MAX_MS = 60 * 60_000

export type Fetch = (url: string, init: RequestInit) => Promise<Response>

export interface CloudAccount {
  /** The account's uuid: the cache folder's name, and the key a second login of the same account drops
   *  into. Never the address. */
  key: string
  token: string
  orgUuid: string | null
}

/** Per-process memory of accounts to leave alone. Nothing here is persisted. */
export interface CloudSyncState {
  /** Epoch ms before which an account is not asked again (a 429). */
  backoffUntil: Map<string, number>
  /** A digest of the token a 401/403 refused. The account is skipped while its token is that one. */
  refused: Map<string, string>
  /** The same for the tagged query alone: the untagged list still runs while its token is that one. */
  taggedRefused: Map<string, string>
}

export function newCloudSyncState(): CloudSyncState {
  return { backoffUntil: new Map(), refused: new Map(), taggedRefused: new Map() }
}

export type AccountOutcome = 'clean' | 'partial' | 'skipped' | 'failed'
export interface CloudSyncResult {
  account: string
  outcome: AccountOutcome
  listed: number
}

// --- mapping -----------------------------------------------------------------

/** One item of `GET /v1/code/sessions` `data[]`, only the fields read. */
interface ApiCloudSession {
  id?: string
  title?: string | null
  status_bucket?: string | null
  /** 'idle' when no turn is running. */
  worker_status?: string | null
  environment_kind?: string | null
  unread?: boolean | null
  last_event_at?: string | null
  updated_at?: string | null
  created_at?: string | null
  tags?: string[] | null
}

interface ApiList {
  data?: ApiCloudSession[]
  next_cursor?: string | null
}

/** A string that the API sent as a short word, or null when it sent anything else. */
const word = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, 64) : null

/** An ISO time for a date the API sent, or null when it is not a date. */
function isoOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * One API item as a cache row, or null when it is not a session AgentHydra lists. The API's types are
 * not trusted: each field is typed here, and the result must pass isListedCloudRow. A Remote Control
 * session is left out (a local one is listed from its own store), and so is one whose last event is
 * not a date.
 */
export function toCloudRow(s: ApiCloudSession): CloudSessionRow | null {
  if (typeof s?.id !== 'string') return null
  const lastEvent = isoOf(s.last_event_at || s.updated_at || s.created_at)
  if (!lastEvent) return null
  const row = {
    id: s.id,
    title:
      typeof s.title === 'string' && s.title.trim()
        ? s.title.trim().slice(0, 500)
        : 'Claude Code session',
    environment_kind: word(s.environment_kind) ?? 'unknown',
    status_bucket: word(s.status_bucket) ?? 'unknown',
    worker_status: word(s.worker_status) ?? 'unknown',
    unread: s.unread === true,
    created_at: isoOf(s.created_at),
    last_event_at: lastEvent,
    tags: Array.isArray(s.tags) ? s.tags.filter((t): t is string => typeof t === 'string') : [],
  }
  return isListedCloudRow(row) ? row : null
}

/**
 * A cloud session's state, in the status store's terms.
 *
 * A running turn is working whatever else is true. Otherwise the session waits on the person when
 * claude.ai would show it so: a reply nobody has read, or a bucket that means "your move". Anything
 * else is a finished turn.
 *
 * A Project thread is read in the Project, not on the sessions page, so its `unread` flag never
 * clears. For those only the bucket counts.
 */
export function cloudStatusEvent(r: CloudSessionRow): AgentStatusEvent {
  const running = r.worker_status !== 'idle' && r.worker_status !== 'unknown'
  const base = { sessionId: r.id, source: 'claude-cloud' as const, at: r.last_event_at }
  if (running || r.status_bucket === 'working') return { ...base, event: 'cloud-working' }
  if (r.status_bucket === 'blocked')
    return { ...base, event: 'cloud-blocked', notificationType: 'input' }
  if (r.tags.includes('hearth-thread')) {
    return r.status_bucket === 'review_ready'
      ? { ...base, event: 'cloud-blocked', notificationType: 'review' }
      : { ...base, event: 'cloud-done' }
  }
  if (r.unread) return { ...base, event: 'cloud-blocked', notificationType: 'unread' }
  return { ...base, event: 'cloud-done' }
}

// --- accounts ----------------------------------------------------------------

interface Identity {
  accountUuid: string | null
  orgUuid: string | null
}

/** The last good read of each `.claude.json`, and the mtime and size it was read at. */
const identityCache = new Map<string, { stamp: string; identity: Identity }>()

/**
 * The account and org a `.claude.json` names. Identity only, never a token. The file is read again only
 * when its mtime or size has moved, so a poll tick does not re-read an unchanged file. A missing or
 * unreadable file answers nulls and is not cached as good.
 */
function readIdentity(path: string): Identity {
  let stamp: string
  try {
    const st = statSync(path)
    stamp = `${st.mtimeMs}:${st.size}`
  } catch {
    identityCache.delete(path)
    return { accountUuid: null, orgUuid: null }
  }
  const hit = identityCache.get(path)
  if (hit?.stamp === stamp) return hit.identity
  try {
    const identity = {
      accountUuid: accountUuidOfClaudeJson(readFileSync(path, 'utf8')),
      orgUuid: orgUuidOfClaudeJson(path),
    }
    identityCache.set(path, { stamp, identity })
    return identity
  } catch {
    identityCache.delete(path)
    return { accountUuid: null, orgUuid: null }
  }
}

/**
 * Every login on this PC that can list sessions, one per account. The default login comes first: its
 * credentials sit in ~/.claude (or CLAUDE_CONFIG_DIR) and its identity in ~/.claude.json, outside the
 * folder. Then each AgentHydra-managed CLI instance. A token that is expired or lacks the scope is
 * skipped; a login with no account uuid is skipped, since it cannot be told apart from another.
 */
export function cloudAccounts(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): CloudAccount[] {
  const own = env.CLAUDE_CONFIG_DIR?.trim()
  const logins = [
    {
      configDir: own || join(home, '.claude'),
      identity: own ? join(own, '.claude.json') : join(home, '.claude.json'),
    },
    ...listCliInstances()
      .filter((i) => i.loggedIn)
      .map((i) => ({ configDir: i.configDir, identity: join(i.configDir, '.claude.json') })),
  ]
  // Keep the identity cache to the files this call names, so a login that left drops out of it.
  const named = new Set(logins.map((login) => login.identity))
  for (const path of identityCache.keys()) if (!named.has(path)) identityCache.delete(path)
  const byAccount = new Map<string, CloudAccount>()
  for (const login of logins) {
    const cred = resolveCliConfigDirToken(login.configDir)
    if (!cred?.scopes.split(' ').includes(SESSIONS_SCOPE)) continue
    const id = readIdentity(login.identity)
    if (!id.accountUuid || byAccount.has(id.accountUuid)) continue
    byAccount.set(id.accountUuid, { key: id.accountUuid, token: cred.token, orgUuid: id.orgUuid })
  }
  return [...byAccount.values()]
}

// --- the list ----------------------------------------------------------------

type PageResult =
  | { ok: true; rows: CloudSessionRow[] }
  | { ok: false; status: number; retryAfterSec: number | null; error: string }

function headersFor(a: CloudAccount): Record<string, string> {
  return {
    Authorization: `Bearer ${a.token}`,
    Accept: 'application/json',
    'anthropic-version': ANTHROPIC_VERSION,
    'user-agent': claudeUserAgent(), // load-bearing, as in usage-api.ts
    ...(a.orgUuid ? { 'x-organization-uuid': a.orgUuid } : {}),
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** One query, following `next_cursor`. Never throws. The error carries a status, never a token. */
async function listPages(
  a: CloudAccount,
  extra: Array<[string, string]>,
  fetchFn: Fetch,
): Promise<PageResult> {
  const rows: CloudSessionRow[] = []
  let cursor: string | null = null
  try {
    for (let page = 0; page < MAX_PAGES; page++) {
      const q = new URLSearchParams([
        ['statuses', 'active'],
        ['statuses', 'paused'],
        ['limit', String(LIST_LIMIT)],
        ...extra,
      ])
      if (cursor) q.set('cursor', cursor)
      // The untagged list, then the tagged list for the sessions it leaves out: two queries, not one.
      // arkitect-ignore-next-line poll-tick-reads-same-source-twice/two-callers-one-reader - 2 queries
      const res = await fetchFn(`${SESSIONS_URL}?${q}`, {
        method: 'GET',
        headers: headersFor(a),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          retryAfterSec:
            res.status === 429 ? parseRetryAfter(res.headers.get('retry-after')) : null,
          error: `HTTP ${res.status}`,
        }
      }
      const body = (await res.json()) as ApiList
      for (const item of body.data ?? []) {
        const row = toCloudRow(item)
        if (row) rows.push(row)
      }
      cursor = body.next_cursor || null
      if (!cursor) break
    }
    return { ok: true, rows }
  } catch (err) {
    return { ok: false, status: 0, retryAfterSec: null, error: errorText(err) }
  }
}

const digest = (token: string): string => createHash('sha256').update(token).digest('hex')

const isTagged = (r: CloudSessionRow): boolean => r.tags.some((t) => LISTED_TAGS.includes(t))

/** A 429 from either query: the whole account waits, as the server's Retry-After says, within the cap. */
function backOff(
  state: CloudSyncState,
  key: string,
  retryAfterSec: number | null,
  now: number,
): void {
  const waitMs = Math.min(BACKOFF_MAX_MS, retryAfterSec ? retryAfterSec * 1000 : BACKOFF_DEFAULT_MS)
  state.backoffUntil.set(key, now + waitMs)
  console.error(
    `[cloud-sessions] account ${key} rate-limited; not asked again for ${Math.round(waitMs / 1000)} s`,
  )
}

/**
 * One account's pass. The untagged list decides whether the account listed at all. A failed tagged
 * query keeps the previous snapshot's tagged rows (carried forward, not refreshed), so their status
 * rows are neither lost nor released by a pass that could not see them.
 */
async function syncAccount(
  a: CloudAccount,
  root: string,
  fetchFn: Fetch,
  state: CloudSyncState,
  now: number,
): Promise<CloudSyncResult> {
  const skipped: CloudSyncResult = { account: a.key, outcome: 'skipped', listed: 0 }
  const token = digest(a.token)
  if (state.refused.get(a.key) === token) return skipped
  state.refused.delete(a.key) // a new token gets a fresh try
  if (now < (state.backoffUntil.get(a.key) ?? 0)) return skipped

  const main = await listPages(a, [], fetchFn)
  if (!main.ok) {
    if (main.status === 401 || main.status === 403) {
      state.refused.set(a.key, token)
      console.error(
        `[cloud-sessions] account ${a.key} refused (HTTP ${main.status}); skipped until its token changes`,
      )
      return skipped
    }
    if (main.status === 429) {
      backOff(state, a.key, main.retryAfterSec, now)
      return skipped
    }
    console.error(`[cloud-sessions] account ${a.key} did not list: ${main.error}`)
    return { account: a.key, outcome: 'failed', listed: 0 }
  }

  // A tagged query the server refused is not asked again with the same token, as the untagged one is not.
  const refusedTagged = state.taggedRefused.get(a.key) === token
  const tagged: PageResult = refusedTagged
    ? { ok: false, status: 403, retryAfterSec: null, error: 'refused with this token' }
    : await listPages(
        a,
        LISTED_TAGS.map((t): [string, string] => ['tags', t]),
        fetchFn,
      )
  if (tagged.ok) state.taggedRefused.delete(a.key)
  else if (tagged.status === 401 || tagged.status === 403) state.taggedRefused.set(a.key, token)
  const previous = readCloudSnapshot(join(root, a.key)).filter(isListedCloudRow)
  const rows = [...main.rows]
  const listed = new Set(rows.map((r) => r.id))
  if (tagged.ok) {
    for (const r of tagged.rows) {
      if (listed.has(r.id)) continue
      listed.add(r.id)
      rows.push(r)
    }
  } else {
    if (tagged.status === 429) backOff(state, a.key, tagged.retryAfterSec, now)
    if (!refusedTagged)
      console.error(
        `[cloud-sessions] account ${a.key}: tagged sessions not listed (${tagged.error}); keeping their last rows`,
      )
    for (const p of previous) {
      if (!isTagged(p) || listed.has(p.id)) continue
      listed.add(p.id)
      rows.push(p)
    }
  }

  writeCloudSnapshot(root, a.key, rows)
  for (const r of rows) recordAgentStatus(cloudStatusEvent(r))
  if (!tagged.ok) return { account: a.key, outcome: 'partial', listed: rows.length }
  releaseCloudStatus(
    previous.map((r) => r.id),
    listed,
  )
  return { account: a.key, outcome: 'clean', listed: rows.length }
}

/**
 * One pass over every account. `fetchFn` and `now` are injected by the tests; the poller passes the
 * real fetch. Accounts run one after another, so a pass never sends more than one request at a time.
 */
export async function syncCloudSessions(opts: {
  root: string
  accounts: CloudAccount[]
  fetchFn?: Fetch
  state?: CloudSyncState
  now?: number
}): Promise<CloudSyncResult[]> {
  const fetchFn: Fetch = opts.fetchFn ?? ((url, init) => fetch(url, init))
  const state = opts.state ?? newCloudSyncState()
  const now = opts.now ?? Date.now()
  // The adapter lists only the accounts this pass polls, so the index is written before any request.
  writeAccountIndex(
    opts.root,
    opts.accounts.map((a) => a.key),
  )
  const out: CloudSyncResult[] = []
  for (const a of opts.accounts) {
    // One account's failure stays in that account: the next one still lists, and the stale rows of a clean
    // account are still released.
    try {
      out.push(await syncAccount(a, opts.root, fetchFn, state, now))
    } catch (err) {
      console.error(`[cloud-sessions] account ${a.key} failed: ${errorText(err)}`)
      out.push({ account: a.key, outcome: 'failed', listed: 0 })
    }
  }
  return out
}

// --- the poller --------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null
let ticking = false
const pollState = newCloudSyncState()

/**
 * Start the poller when AGENTHYDRA_CLOUD_SESSIONS=1. With the flag unset this returns false before it
 * touches anything: no timer, no read of a login, no request, no folder.
 */
export function startCloudSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!cloudSessionsEnabled(env)) return false
  if (timer) return true
  const tick = async (): Promise<void> => {
    if (ticking) return
    ticking = true
    try {
      await syncCloudSessions({
        root: cloudSessionsRoot(env),
        accounts: cloudAccounts(env),
        state: pollState,
      })
    } catch (err) {
      console.error('[cloud-sessions] pass failed:', errorText(err))
    } finally {
      ticking = false
    }
  }
  void tick()
  timer = setInterval(tick, CLOUD_SESSIONS_TICK_MS)
  timer.unref?.()
  return true
}

/** Stop the poller (daemon shutdown). */
export function stopCloudSessions(): void {
  if (timer) clearInterval(timer)
  timer = null
}
