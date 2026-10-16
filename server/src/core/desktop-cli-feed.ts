// server/src/core/desktop-cli-feed.ts — a CLI instance linked to a desktop instance takes its login
// from the desktop login, so one sign-in (the desktop's) serves both.
//
// WHY (owner, 2026-10-01): "If I log into desktop, can it auto-log into CLI? ... to save me from
// having to do both individually". Checked on real logins, by field names and lifetimes only: a
// desktop token cache holds a grant with the Claude Code scopes (`user:inference user:file_upload
// user:profile user:sessions:claude_code`), an access token good for weeks. A `.credentials.json`
// made from it (access token, expiry, scopes, plan; NO refresh token) passes `claude auth status`
// and answers `/usage` from Anthropic (run 2026-10-01 against a scratch config dir). The other way
// round cannot work: a desktop sign-in also needs the claude.ai browser cookie and grants a CLI
// login never has.
//
// THE RULES
// - Only a CLI instance LINKED to a desktop instance (linkCliInstanceToDesktop: "Add a CLI login…"
//   on the desktop row) is fed, and only while it has no login of its own: a credential with a
//   refresh token is a real CLI sign-in and is never touched.
// - No refresh token is copied. The desktop app owns that one; a CLI that refreshed with it would
//   rotate it and sign the desktop out. The fed login lasts as long as the grant (weeks) and is
//   replaced whenever the desktop app renews its own, so a desktop instance left closed past the
//   grant's expiry leaves its CLI login expired until it is opened once.
// - A Log out of a fed CLI instance cuts the link (routes/usage.ts), so the feed does not sign it
//   straight back in.
// - The folder's `.claude.json` names the fed login's account (matchFedAccount). Writing only the
//   credential left it naming the account the folder held before (2026-10-15: a desktop signed in to
//   another account fed its CLI folder, and the account menu, the kit's token credit and the renaming
//   pass all read that folder as the old account: two rows with one name and two different usages).
//
// ⛔ SECRETS: the token goes from one of the owner's files to another and is never logged.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fetchProfile, type ProfileResponse } from './accounts'
import { listCliInstances } from './cli-instances'
import { credPath } from './cli-login-move'
import { readDesktopTokens } from './desktop-login-sync'

const CLAUDE_CODE_SCOPE = 'user:sessions:claude_code'
/** A grant this close to its end is not worth writing: the CLI would open on an expired login. */
const MIN_LEFT_MS = 10 * 60_000

interface CliOauth {
  accessToken: string
  expiresAt: number
  scopes: string[]
  subscriptionType: string | null
  rateLimitTier: string | null
  refreshToken?: string
}

/** The desktop token cache's Claude Code grant as a CLI credential, the longest-lived one that has
 *  time left; null when the cache holds none. */
export function cliCredentialFromDesktop(tokenCache: string, now = Date.now()): CliOauth | null {
  let grants: Record<string, Record<string, unknown>>
  try {
    grants = JSON.parse(tokenCache) as Record<string, Record<string, unknown>>
  } catch {
    return null
  }
  let best: CliOauth | null = null
  for (const [key, g] of Object.entries(grants ?? {})) {
    if (!key.includes(CLAUDE_CODE_SCOPE) || typeof g?.token !== 'string' || !g.token) continue
    const expiresAt = Number(g.expiresAt) || 0
    if (expiresAt - now < MIN_LEFT_MS || (best && best.expiresAt >= expiresAt)) continue
    best = {
      accessToken: g.token,
      expiresAt,
      scopes: key.match(/user:[a-z_:]+/g) ?? [],
      subscriptionType: typeof g.subscriptionType === 'string' ? g.subscriptionType : null,
      rateLimitTier: typeof g.rateLimitTier === 'string' ? g.rateLimitTier : null,
    }
  }
  return best
}

export function readCredentials(path: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** Whether this config dir's login is its own sign-in (it can refresh itself). */
export function hasOwnCliLogin(configDir: string): boolean {
  const own = readCredentials(credPath(configDir))?.claudeAiOauth as CliOauth | undefined
  return typeof own?.refreshToken === 'string' && own.refreshToken.length > 0
}

/** The CLI login a desktop profile can give right now; null when it has none (signed out, or its
 *  Claude Code grant ran out while the app stayed closed). */
export async function desktopCliCredential(desktopDir: string): Promise<CliOauth | null> {
  const tokens = existsSync(desktopDir) ? await readDesktopTokens(desktopDir) : null
  return tokens?.v2 ? cliCredentialFromDesktop(tokens.v2) : null
}

export type FeedResult = 'fed' | 'current' | 'own-login' | 'no-desktop-login' | 'not-linked'

/** Give one linked CLI instance its desktop instance's login (see the header). */
export async function feedCliFromDesktop(cli: {
  configDir: string
  associatedDesktopDir?: string | null
}): Promise<FeedResult> {
  if (!cli.associatedDesktopDir) return 'not-linked'
  if (hasOwnCliLogin(cli.configDir)) return 'own-login'
  const cred = await desktopCliCredential(cli.associatedDesktopDir)
  if (!cred) return 'no-desktop-login'
  const path = credPath(cli.configDir)
  const file = readCredentials(path) ?? {}
  if ((file.claudeAiOauth as CliOauth | undefined)?.accessToken === cred.accessToken)
    return 'current'
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ ...file, claudeAiOauth: cred }))
    renameSync(tmp, path)
  } finally {
    rmSync(tmp, { force: true })
  }
  return 'fed'
}

/** Config dir -> SHA-256 of the fed token its `.claude.json` was last checked against: one profile
 *  read per token, not one per pass. */
const matchedToken = new Map<string, string>()
/** Config dir -> when an unread profile may be asked for again. */
const profileRetryAt = new Map<string, number>()
const PROFILE_RETRY_MS = 10 * 60_000

/** The oauthAccount the CLI itself keeps, from the profile; null when it names no account. */
function oauthAccountOf(p: ProfileResponse, now: number): Record<string, unknown> | null {
  const a = p.account
  const o = p.organization
  if (!a?.uuid || !o?.uuid) return null
  const fields: Record<string, unknown> = {
    accountUuid: a.uuid,
    emailAddress: a.email,
    displayName: a.display_name,
    fullName: a.full_name,
    organizationUuid: o.uuid,
    organizationName: o.name,
    organizationType: o.organization_type,
    billingType: o.billing_type,
    organizationRateLimitTier: o.rate_limit_tier,
    profileFetchedAt: now,
  }
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null))
}

const sameId = (a: unknown, b: unknown) =>
  String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase()

export type FedAccountResult = 'current' | 'corrected' | 'own-login' | 'no-login' | 'unread'

/** Make a fed folder's `.claude.json` name the account its login belongs to (see the header). The
 *  token's own profile decides; a sign-in of the folder's own, a missing `.claude.json` (the CLI
 *  writes it from its own profile read on its first run) and an unreadable one are left alone. */
export async function matchFedAccount(
  configDir: string,
  now = Date.now(),
): Promise<FedAccountResult> {
  const login = readCredentials(credPath(configDir))?.claudeAiOauth as CliOauth | undefined
  if (typeof login?.refreshToken === 'string' && login.refreshToken) return 'own-login'
  if (typeof login?.accessToken !== 'string' || !login.accessToken) return 'no-login'
  const key = configDir.toLowerCase()
  const token = createHash('sha256').update(login.accessToken).digest('hex')
  if (matchedToken.get(key) === token) return 'current'
  if ((profileRetryAt.get(key) ?? 0) > now) return 'unread'
  const read = await fetchProfile(login.accessToken)
  const fresh = read.ok ? oauthAccountOf(read.profile, now) : null
  if (!fresh) {
    profileRetryAt.set(key, now + PROFILE_RETRY_MS)
    return 'unread'
  }
  const path = join(configDir, '.claude.json')
  if (!existsSync(path)) {
    matchedToken.set(key, token)
    return 'current'
  }
  let config: Record<string, unknown>
  try {
    config = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  } catch {
    return 'unread' // mid-write by the CLI: the next pass reads it again
  }
  const held = config?.oauthAccount as Record<string, unknown> | undefined
  if (
    sameId(held?.accountUuid, fresh.accountUuid) &&
    sameId(held?.organizationUuid, fresh.organizationUuid)
  ) {
    matchedToken.set(key, token)
    return 'current'
  }
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify({ ...config, oauthAccount: fresh }, null, 2))
    renameSync(tmp, path)
  } catch {
    return 'unread'
  } finally {
    rmSync(tmp, { force: true })
  }
  matchedToken.set(key, token)
  return 'corrected'
}

/** Feed every linked CLI instance; how many logins were written. Never throws. */
export async function feedLinkedCliLogins(): Promise<number> {
  let fed = 0
  for (const cli of listCliInstances()) {
    if (!cli.associatedDesktopDir) continue
    try {
      if ((await feedCliFromDesktop(cli)) === 'fed') fed++
      await matchFedAccount(cli.configDir)
    } catch {
      // one unreadable profile must not stop the rest
    }
  }
  return fed
}
