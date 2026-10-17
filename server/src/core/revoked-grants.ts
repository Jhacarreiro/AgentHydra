// server/src/core/revoked-grants.ts — the saved Claude Desktop logins Anthropic has revoked, taken out
// of a closed profile so its app makes new ones.
//
// WHY (owner, 2026-10-16, after signing instance #72 out and back in and still reading "revoked": "was
// there a reason it was using the old tokens? Does it not update or what?"). AgentHydra reads a
// profile's grants fresh on every check; it was reading what the app kept. Claude Desktop keeps its
// saved OAuth grants across a sign-in to the same account (its main.log: "preserving oauth cache
// (same-user re-login)"), and its token getter hands out a saved grant until the grant's own expiresAt
// without asking whether it still works. It makes a new one only when the grant is missing, or expired
// with its refresh refused ("refresh token rejected ... dropping it and trying a fresh exchange"; read
// in app 2.42304.0 on 2026-10-16). Revoking a grant does not move its expiresAt, so a revoked Claude
// Code grant (a month long) or inference grant (a year long) stays in use through any number of
// re-logins: after #72's re-login that day both still answered the profile endpoint 401 "OAuth access
// token has been revoked." beside the new profile grant the re-login made, and the app's own refresh
// of one failed invalid_grant.
//
// THE RULES
// - A grant is revoked only on the profile endpoint's word: a 401 that says revoked. An expired grant
//   is the app's to refresh and is left alone.
// - A revoked grant is remembered by a digest of its token (never the token) in revoked-grants.json in
//   the data dir, for as long as the longest grant lives.
// - It leaves a profile's token caches only while the app is closed (the app holds config.json and
//   saves its own copy over it): when a usage check finds it, and before AgentHydra opens the profile.
//   The app then makes a new grant from its claude.ai sign-in the next time it needs one.
// - Login sync never lands a remembered grant and leaves it out of "the later expiry wins", so a dead
//   year-long grant in another PC's copy cannot win the account back (core/desktop-login-sync.ts).
//
// ⛔ SECRETS: tokens are read to be asked about and digested; nothing here logs or stores one.

import { createHash } from 'node:crypto'
import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../config'
import { revokedLoginError } from '../usage-api'
import { deleteAccountsCacheEntry } from './accounts'
import { decryptSafeStorage, encryptSafeStorage } from './crypto'
import { normalizePath } from './paths'
import { listClaudeProcesses } from './process'

/** A year-long grant's life, and a month over: a revoked token is never accepted again, so its
 *  digest only has to outlive any copy of it. */
const KEEP_MS = 400 * 24 * 60 * 60_000
const TOKEN_CACHES = ['oauth:tokenCacheV2', 'oauth:tokenCache'] as const

type Book = Record<string, { at: number; account: string | null }>
let book: Book | null = null
const bookPath = (): string => join(DATA_DIR, 'revoked-grants.json')

/** A token's name here: its SHA-256, shortened. */
export const grantDigest = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32)

function load(): Book {
  if (book) return book
  try {
    book = JSON.parse(readFileSync(bookPath(), 'utf8')) as Book
  } catch {
    book = {}
  }
  const cutoff = Date.now() - KEEP_MS
  for (const [d, e] of Object.entries(book)) if (!(e?.at > cutoff)) delete book[d]
  return book
}

function save(b: Book): void {
  const path = bookPath()
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  try {
    writeFileSync(tmp, JSON.stringify(b))
    renameSync(tmp, path)
  } catch {
    // floor-ok: unsaved, the digest is still remembered by this process and found again next check.
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Remember revoked grants by digest, under the account they belong to when it is known (a usage
 *  check knows the grant but not its account; the profile it came from does). */
export function noteRevokedDigests(digests: Iterable<string>, account: string | null): void {
  const b = load()
  let changed = false
  for (const d of digests) {
    if (typeof d !== 'string' || !/^[0-9a-f]{32}$/.test(d)) continue
    if (b[d] && (b[d].account || !account)) continue
    b[d] = { at: b[d]?.at ?? Date.now(), account }
    changed = true
  }
  if (changed) save(b)
}

export function noteRevokedGrant(token: string, account: string | null = null): void {
  noteRevokedDigests([grantDigest(token)], account)
}

export const isRevokedGrant = (token: string): boolean => !!load()[grantDigest(token)]

/** The remembered revoked grants of one account: what a login sent to the other PC carries. */
export function revokedDigestsFor(account: string): string[] {
  return Object.entries(load())
    .filter(([, e]) => e.account === account)
    .map(([d]) => d)
}

type Grants = Record<string, { token?: unknown } | null>

function grantsOf(cache: string | null): Grants | null {
  if (!cache) return null
  try {
    const g = JSON.parse(cache) as unknown
    return g && typeof g === 'object' ? (g as Grants) : null
  } catch {
    return null
  }
}

const tokenOf = (g: { token?: unknown } | null): string | null =>
  typeof g?.token === 'string' && g.token ? g.token : null

/** `cache` without the grants remembered as revoked: the same string when it holds none. */
export function withoutRevokedGrants(cache: string | null): string | null {
  const grants = grantsOf(cache)
  if (!grants) return cache
  const kept = Object.entries(grants).filter(([, g]) => {
    const t = tokenOf(g)
    return !t || !isRevokedGrant(t)
  })
  return kept.length === Object.keys(grants).length
    ? cache
    : JSON.stringify(Object.fromEntries(kept))
}

/** Ask the profile endpoint about every grant not yet remembered, and remember the ones it calls
 *  revoked. */
async function proveGrants(
  caches: Array<string | null>,
  account: string | null,
  timeoutMs?: number,
): Promise<void> {
  const tokens = new Set<string>()
  for (const c of caches)
    for (const g of Object.values(grantsOf(c) ?? {})) {
      const t = tokenOf(g)
      if (t && !isRevokedGrant(t)) tokens.add(t)
    }
  await Promise.all(
    [...tokens].map(async (t) => {
      const said = await revokedLoginError(t, timeoutMs)
      if (said && /revoked/i.test(said)) noteRevokedGrant(t, account)
    }),
  )
}

/**
 * Take the remembered revoked grants out of a profile's token caches. Nothing is written while its
 * app runs, or when that cannot be ruled out. With `prove`, every grant not yet remembered is asked
 * about first (a usage check sees only the usage-capable ones). The number of grants taken out; 0
 * when there were none or the profile could not be read or written. Never throws.
 */
export async function pruneRevokedGrants(
  dir: string,
  opts: { prove?: boolean; timeoutMs?: number } = {},
): Promise<number> {
  try {
    const path = join(dir, 'config.json')
    const text = readFileSync(path, 'utf8')
    const cfg = JSON.parse(text) as Record<string, unknown>
    const account = typeof cfg.lastKnownAccountUuid === 'string' ? cfg.lastKnownAccountUuid : null
    const plain = await Promise.all(
      TOKEN_CACHES.map((k) =>
        typeof cfg[k] === 'string' ? decryptSafeStorage(cfg[k] as string, dir) : null,
      ),
    )
    if (opts.prove) await proveGrants(plain, account, opts.timeoutMs)
    const kept = plain.map(withoutRevokedGrants)
    if (kept.every((c, i) => c === plain[i])) return 0
    const dead = plain.flatMap((c) =>
      Object.values(grantsOf(c) ?? {}).flatMap((g) => {
        const t = tokenOf(g)
        return t && isRevokedGrant(t) ? [grantDigest(t)] : []
      }),
    )
    noteRevokedDigests(dead, account)
    const procs = await listClaudeProcesses({ fresh: true })
    if (procs.some((p) => p.dir && normalizePath(p.dir) === normalizePath(dir))) return 0
    let removed = 0
    for (const [i, k] of TOKEN_CACHES.entries()) {
      if (kept[i] === plain[i]) continue
      const sealed = await encryptSafeStorage(kept[i] as string, dir)
      if (!sealed) return 0
      cfg[k] = sealed
      removed +=
        Object.keys(grantsOf(plain[i]) ?? {}).length - Object.keys(grantsOf(kept[i]) ?? {}).length
    }
    // Desktop login sync, the owner of this file, may have saved it while the steps above awaited
    // (decrypting, asking the network, encrypting, the process scan): writing `cfg` now would put
    // that older copy back over it. Leave it; the next check finds the dead grants again. Nothing
    // awaits between this read and the rename, so no writer in this process lands in between.
    if (readFileSync(path, 'utf8') !== text) return 0
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    try {
      writeFileSync(tmp, JSON.stringify(cfg, null, 2))
      renameSync(tmp, path)
    } finally {
      rmSync(tmp, { force: true })
    }
    deleteAccountsCacheEntry(dir)
    return removed
  } catch {
    return 0
  }
}

/** Before AgentHydra opens a profile: the grants already known dead leave first, without asking
 *  the network, so Open is not slowed (core/instances.ts setBeforeLaunchHook). */
export async function pruneBeforeLaunch(normDir: string): Promise<void> {
  await pruneRevokedGrants(normDir)
}
