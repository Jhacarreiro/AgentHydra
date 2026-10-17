// Validate one managed CLI grant without sending a message, refreshing it or trusting mint-time metadata.
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, openSync, readSync, type Stats, statSync } from 'node:fs'
import { join } from 'node:path'
import { IDENTITY_WALL, ORG_DISABLED_WALL } from '../climayte-lib'
import { claudeUserAgent } from '../usage-api'
import { OAUTH_BETA_HEADER, PROFILE_API_URL } from './shared'

const CREDENTIAL_MAX = 64 * 1024
const PROFILE_MAX = 64 * 1024
const CHECK_TIMEOUT_MS = 15_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const emailOf = (value: unknown): string | null =>
  typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null

interface ManagedLogin {
  id: string
  configDir: string
  accountEmail?: string | null
  name?: string
}
interface AuthWall {
  reason: string
  until: number
  cred?: number | null
}
export interface CliAuthCheckResult {
  ok: boolean
  loggedIn: boolean
  wallCleared: boolean
  /** A definitive rejection of the unchanged current grant recorded a signed-out wall. */
  wallSet?: boolean
  reason:
    | 'verified'
    | 'not_found'
    | 'identity_required'
    | 'identity_mismatch'
    | 'credentials_invalid'
    | 'credentials_changed'
    | 'profile_rejected'
    | 'profile_unavailable'
    | 'profile_invalid'
    | 'state_changed'
    | 'account_restricted'
  status: number | null
  email: string | null
  accountUuid: string | null
}
interface CheckDeps {
  instance(id: string): ManagedLogin | null
  wall(id: string): AuthWall | undefined
  clearWall(id: string): void
  verified?(instance: ManagedLogin, token: string): void
  rejected?(instance: ManagedLogin): void
  fetchProfile?(url: string, init: RequestInit): Promise<Response>
  /** Only tests shorten the real 15-second deadline. */
  timeoutMs?: number
}

const failed = (
  reason: CliAuthCheckResult['reason'],
  status: number | null = null,
): CliAuthCheckResult => ({
  ok: false,
  loggedIn: false,
  wallCleared: false,
  reason,
  status,
  email: null,
  accountUuid: null,
})
const stamp = (s: Stats): string => `${s.dev}:${s.ino}:${s.mtimeMs}:${s.ctimeMs}:${s.size}`

/** A fixed-size read also bounds a file that grows after its initial stat. Never return raw bytes. */
function credential(configDir: string): { token: string; identity: string } | null {
  let fd: number | undefined
  try {
    const path = join(configDir, '.credentials.json')
    fd = openSync(path, 'r')
    const before = fstatSync(fd)
    if (!before.isFile() || before.size < 1 || before.size > CREDENTIAL_MAX) return null
    const bytes = Buffer.alloc(CREDENTIAL_MAX + 1)
    let length = 0
    while (length < bytes.length) {
      const n = readSync(fd, bytes, length, bytes.length - length, length)
      if (!n) break
      length += n
    }
    if (
      length > CREDENTIAL_MAX ||
      stamp(before) !== stamp(fstatSync(fd)) ||
      stamp(before) !== stamp(statSync(path))
    )
      return null
    const raw = bytes.subarray(0, length)
    const oauth = JSON.parse(raw.toString('utf8'))?.claudeAiOauth
    if (
      typeof oauth?.accessToken !== 'string' ||
      !oauth.accessToken.trim() ||
      !Number.isFinite(oauth.expiresAt) ||
      oauth.expiresAt <= Date.now() ||
      !Array.isArray(oauth.scopes) ||
      (!oauth.scopes.includes('user:inference') &&
        !oauth.scopes.includes('user:sessions:claude_code')) ||
      !oauth.scopes.includes('user:profile')
    )
      return null
    return {
      token: oauth.accessToken,
      identity: `${stamp(before)}:${createHash('sha256').update(raw).digest('hex')}`,
    }
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        /* A failed close does not authenticate anything. */
      }
    }
  }
}

async function profileJson(response: Response, signal: AbortSignal): Promise<unknown> {
  const advertised = Number(response.headers.get('content-length'))
  if (advertised > PROFILE_MAX || !response.body || signal.aborted)
    throw new Error('invalid profile')
  const reader = response.body.getReader()
  const cancel = () => {
    void reader.cancel().catch(() => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  let length = 0
  const chunks: Uint8Array[] = []
  try {
    for (;;) {
      const next = await reader.read()
      if (signal.aborted) throw new Error('profile timeout')
      if (next.done) break
      length += next.value.byteLength
      if (length > PROFILE_MAX) throw new Error('invalid profile')
      chunks.push(next.value)
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } finally {
    signal.removeEventListener('abort', cancel)
    cancel()
  }
}

/** The checker owns no login cache. Every request authenticates exactly the file it captured. */
export function createCliAuthChecker(deps: CheckDeps) {
  return async (id: string, expectedEmail?: string): Promise<CliAuthCheckResult> => {
    const instance = deps.instance(id)
    if (!instance || instance.id !== id) return failed('not_found')
    const managedEmail = emailOf(instance.accountEmail)
    const expected = expectedEmail === undefined ? managedEmail : emailOf(expectedEmail)
    if (!expected) return failed('identity_required')
    if (managedEmail && expected !== managedEmail) return failed('identity_mismatch')
    const captured = credential(instance.configDir)
    if (!captured) return failed('credentials_invalid')
    const originalWall = deps.wall(id)
    const wallState = originalWall ? { ...originalWall } : null
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      // The same deadline covers connection, headers and the bounded response body. Raw provider
      // errors are never returned: a server can echo the supplied Authorization into its body.
      const request = (async (): Promise<CliAuthCheckResult> => {
        const response = await (deps.fetchProfile ?? fetch)(PROFILE_API_URL, {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${captured.token}`,
            Accept: 'application/json',
            'anthropic-beta': OAUTH_BETA_HEADER,
            'anthropic-version': '2023-06-01',
            'user-agent': claudeUserAgent(),
          },
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          void response.body?.cancel().catch(() => {})
          return failed(
            response.status === 401 || response.status === 403
              ? 'profile_rejected'
              : 'profile_unavailable',
            response.status,
          )
        }
        let profile: unknown
        try {
          profile = await profileJson(response, controller.signal)
        } catch {
          return failed(
            controller.signal.aborted ? 'profile_unavailable' : 'profile_invalid',
            response.status,
          )
        }
        const account = (profile as { account?: { email?: unknown; uuid?: unknown } } | null)
          ?.account
        const email = emailOf(account?.email)
        const uuid =
          typeof account?.uuid === 'string' && UUID.test(account.uuid)
            ? account.uuid.toLowerCase()
            : null
        if (!email || !uuid) return failed('profile_invalid', response.status)
        if (email !== expected) return failed('identity_mismatch', response.status)
        return {
          ok: true,
          loggedIn: true,
          wallCleared: false,
          reason: 'verified',
          status: response.status,
          email,
          accountUuid: uuid,
        }
      })()
      const timeout = new Promise<CliAuthCheckResult>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort()
            resolve(failed('profile_unavailable'))
          },
          Math.min(CHECK_TIMEOUT_MS, Math.max(1, deps.timeoutMs ?? CHECK_TIMEOUT_MS)),
        )
      })
      const result = await Promise.race([request, timeout])
      // A 401 is also an answer about this exact grant. Run it through the same race guards as
      // success before recording a signed-out wall; transport failures and 403s prove no such thing.
      const rejected = result.reason === 'profile_rejected' && result.status === 401
      if (!result.ok && !rejected) return result
      // No await between this validation and the mutation: a later grant, account or server
      // failure must never be cleared by a successful answer for the earlier one.
      const current = deps.instance(id)
      if (
        !current ||
        current.id !== id ||
        current.configDir !== instance.configDir ||
        current.name !== instance.name ||
        emailOf(current.accountEmail) !== managedEmail
      )
        return failed('state_changed')
      if (credential(instance.configDir)?.identity !== captured.identity)
        return failed('credentials_changed')
      const wall = deps.wall(id)
      if (
        (originalWall &&
          (!wallState ||
            originalWall.reason !== wallState.reason ||
            originalWall.until !== wallState.until ||
            originalWall.cred !== wallState.cred)) ||
        (wall !== originalWall && !(wall === undefined && wallState?.reason === 'signed out'))
      )
        return failed('state_changed')
      // A concurrent proof may already have removed this unchanged signed-out wall. The same
      // verified grant succeeds idempotently; a replacement or another kind of wall never does.
      if (wall && (wall.reason === ORG_DISABLED_WALL || wall.reason === IDENTITY_WALL))
        return { ...result, ok: false, loggedIn: false, reason: 'account_restricted' }
      if (rejected) {
        if (deps.rejected) {
          deps.rejected(current)
          result.wallSet = true
        }
        return result
      }
      deps.verified?.(current, captured.token)
      if (wall?.reason === 'signed out') {
        deps.clearWall(id)
        result.wallCleared = true
      }
      return result
    } catch {
      return failed('profile_unavailable')
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      controller.abort()
    }
  }
}
