// server/tests/desktop-login-sync.test.ts — a desktop login reaches the other PC readable, and only
// where it should.
//
// The contract (core/desktop-login-sync.ts, run by core/cli-login-sync.ts's pass): what a profile's
// key encrypts opens with that key and no other; an account only the store holds gets a profile here
// with the sender's folder name and number, its tokens and claude.ai cookies encrypted under the new
// profile's own key (the cookie plaintext led by SHA-256 of its host, as Chromium writes it); of two
// copies in one family the later expiry wins; a login this PC signed in on its own is left alone
// both ways; a desktop login is never left out; a profile deleted on one PC is deleted on the other,
// which says who deleted it and why. A wrong write here signs a desktop app out, and
// a wrong direction ties two working sign-ins to each other's refreshes. The store is the real
// Worker on bun:sqlite; the other PC is played by writing to the store with this PC's key.
// Windows only: the profile key is DPAPI's.

import { Database } from 'bun:sqlite'
import { describe, expect, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { basename, join } from 'node:path'
import {
  cliAccountIdentity,
  createCliInstance,
  deleteCliInstance,
  getCliInstance,
  linkCliInstanceToDesktop,
} from '../src/core/cli-instances'
import {
  configureLoginSync,
  disconnectLoginSync,
  loginSyncPairingCode,
  loginSyncStatus,
  removeLoginEverywhere,
  runLoginSync,
  sealLogin,
  setLoginSyncExcluded,
} from '../src/core/cli-login-sync'
import { logoutCliInstance } from '../src/core/cli-logout'
import {
  decryptSafeStorage,
  decryptV10Gcm,
  encryptSafeStorage,
  encryptV10Gcm,
} from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'
import { feedCliFromDesktop, feedLinkedCliLogins } from '../src/core/desktop-cli-feed'
import { renewDesktopGrant } from '../src/core/desktop-cli-renew'
import {
  type DesktopSyncContext,
  desktopNotes,
  listDesktopProfiles,
  type PortableDesktopLogin,
  readAuthCookies,
  readDesktopTokens,
  syncDesktopLogins,
  tokenExpiry,
} from '../src/core/desktop-login-sync'
import { removeInstance } from '../src/core/lifecycle'
import { instancesRoot } from '../src/core/paths'
import { grantDigest } from '../src/core/revoked-grants'
import { base, store, token } from './login-sync-store'
import './no-chats'

const HOST = '.claude.ai'
const grants = (expiresAt: number) =>
  JSON.stringify({
    'client:org:https://api:user:inference': { token: `t-${expiresAt}`, expiresAt },
  })
const cookie = (value: string, name = 'sessionKey') => ({
  creation_utc: '13400000000000000',
  host_key: HOST,
  top_frame_site_key: '',
  name,
  value,
  path: '/',
  expires_utc: '13500000000000000',
  is_secure: 1,
  is_httponly: 1,
  last_access_utc: '13400000000000001',
  has_expires: 1,
  is_persistent: 1,
  priority: 1,
  samesite: 0,
  source_scheme: 2,
  source_port: 443,
  last_update_utc: '13400000000000002',
  source_type: 0,
  has_cross_site_ancestor: 0,
})

/** A signed-in desktop profile as Claude Desktop leaves one: its key in Local State, its token cache
 *  in config.json and its sign-in cookie in a version-24 cookie database, all under that key. */
async function profile(
  name: string,
  uuid: string,
  expiresAt: number,
  session: string,
  cookieName = 'sessionKey',
) {
  const dir = join(instancesRoot(), name)
  mkdirSync(join(dir, 'Network'), { recursive: true })
  const key = (await ensureWindowsMasterKey(dir))!
  writeFileSync(
    join(dir, 'config.json'),
    JSON.stringify({
      locale: 'en-US',
      lastKnownAccountUuid: uuid,
      'oauth:tokenCacheV2': await encryptSafeStorage(grants(expiresAt), dir),
    }),
  )
  const d = new Database(join(dir, 'Network', 'Cookies'), { create: true })
  // One transaction: each bare statement commits, and each commit is a disk flush that a loaded
  // Windows runner makes slow.
  d.run('BEGIN')
  d.run('CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR)')
  d.run(
    'CREATE TABLE cookies(creation_utc INTEGER NOT NULL,host_key TEXT NOT NULL,top_frame_site_key TEXT NOT NULL,name TEXT NOT NULL,value TEXT NOT NULL,encrypted_value BLOB NOT NULL,path TEXT NOT NULL,expires_utc INTEGER NOT NULL,is_secure INTEGER NOT NULL,is_httponly INTEGER NOT NULL,last_access_utc INTEGER NOT NULL,has_expires INTEGER NOT NULL,is_persistent INTEGER NOT NULL,priority INTEGER NOT NULL,samesite INTEGER NOT NULL,source_scheme INTEGER NOT NULL,source_port INTEGER NOT NULL,last_update_utc INTEGER NOT NULL,source_type INTEGER NOT NULL,has_cross_site_ancestor INTEGER NOT NULL)',
  )
  d.run(
    'CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, has_cross_site_ancestor, name, path, source_scheme, source_port)',
  )
  d.run("insert into meta values ('version', '24'), ('last_compatible_version', '24')")
  const c = cookie(session, cookieName)
  const sealed = await encryptV10Gcm(
    key,
    new Uint8Array([
      ...createHash('sha256').update(HOST).digest(),
      ...new TextEncoder().encode(session),
    ]),
  )
  d.run('insert into cookies values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [
    BigInt(c.creation_utc),
    c.host_key,
    c.top_frame_site_key,
    c.name,
    '',
    sealed,
    c.path,
    BigInt(c.expires_utc),
    c.is_secure,
    c.is_httponly,
    BigInt(c.last_access_utc),
    c.has_expires,
    c.is_persistent,
    c.priority,
    c.samesite,
    c.source_scheme,
    c.source_port,
    BigInt(c.last_update_utc),
    c.source_type,
    c.has_cross_site_ancestor,
  ])
  d.run('COMMIT')
  d.close()
  return dir
}

describe.skipIf(process.platform !== 'win32')('desktop login sync', () => {
  test('a value encrypted for a profile opens with that profile’s key and no other', async () => {
    const a = join(instancesRoot(), 'key-a')
    const b = join(instancesRoot(), 'key-b')
    try {
      const keyA = await ensureWindowsMasterKey(a)
      expect(keyA?.length).toBe(32)
      // A second call keeps the key the profile already has: it encrypts what the profile stores.
      expect(Buffer.from((await ensureWindowsMasterKey(a))!).equals(Buffer.from(keyA!))).toBe(true)
      await ensureWindowsMasterKey(b)
      const sealed = (await encryptSafeStorage('{"grant":"é ünïcode"}', a))!
      expect(await decryptSafeStorage(sealed, a)).toBe('{"grant":"é ünïcode"}')
      expect(await decryptSafeStorage(sealed, b)).toBeNull()
    } finally {
      rmSync(a, { recursive: true, force: true })
      rmSync(b, { recursive: true, force: true })
    }
  })

  test('the store’s account gets a profile here, the later expiry wins, and a separate sign-in is left alone', async () => {
    const [UA, UB, UC] = [randomUUID(), randomUUID(), randomUUID()]
    const made: string[] = []
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync() // the pass that setting up starts: later calls would otherwise join it
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const meta = async (id: string) =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).find((r) => r.id === id)
      /** The other PC writes its copy of `id` into the store. */
      const otherPc = async (
        id: string,
        name: string,
        num: number,
        expiresAt: number,
        session: string,
      ) => {
        const login: PortableDesktopLogin = {
          kind: 'desktop',
          id,
          num,
          name,
          tokenCacheV2: grants(expiresAt),
          tokenCache: null,
          cookies: [cookie(session)],
          expiresAt,
        }
        const r = await store('PUT', `/v1/logins/${id}`, {
          version: (await meta(id))?.version ?? 0,
          blob: sealLogin(key, login),
          meta: { kind: 'desktop', num, name, expiresAt },
        })
        expect(r.status).toBe(200)
      }
      const here = async (dir: string) => ({
        expiry: tokenExpiry((await readDesktopTokens(dir))?.v2 ?? null),
        session: (await readAuthCookies(dir))?.find((c) => c.name === 'sessionKey')?.value,
      })

      // An account only the store holds, on a PC with no desktop profile yet (so no cookie database
      // to copy a layout from): a profile here with the sender's folder name and number, signed in
      // under its OWN key, its cookie written the way Chromium stores one.
      await otherPc(UB, 'from-pc1', 4242, 5000, 'sk-b')
      await runLoginSync()
      const b = (await listDesktopProfiles()).find((p) => p.name === 'from-pc1')!
      made.push(b.dir)
      expect(b).toMatchObject({ uuid: UB, num: 4242 })
      expect(await here(b.dir)).toEqual({ expiry: 5000, session: 'sk-b' })
      // Closed at once: an open handle locks the file on Windows, and the cleanup below then fails with EBUSY.
      const cookies = new Database(join(b.dir, 'Network', 'Cookies'), { readonly: true })
      const row = cookies.query('select value, encrypted_value from cookies').get() as {
        value: string
        encrypted_value: Uint8Array
      }
      cookies.close()
      const plain = (await decryptV10Gcm(
        (await ensureWindowsMasterKey(b.dir))!,
        new Uint8Array(row.encrypted_value),
      ))!
      expect(row.value).toBe('')
      expect(
        Buffer.from(plain.subarray(0, 32)).equals(createHash('sha256').update(HOST).digest()),
      ).toBe(true)

      // A login signed in here goes up, keyed by its account.
      const a = await profile('acct-a', UA, 1000, 'sk-a1')
      made.push(a)
      await runLoginSync()
      expect(await meta(UA)).toMatchObject({
        meta: { kind: 'desktop', name: 'acct-a', expiresAt: 1000 },
      })
      // The other PC refreshed the shared login: its newer copy lands here.
      await otherPc(UA, 'acct-a', 1, 2000, 'sk-a2')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a2' })
      // An older copy in the store never replaces the newer one here; this PC's goes back up.
      await otherPc(UA, 'acct-a', 1, 500, 'sk-old')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a2' })
      expect((await meta(UA)).meta.expiresAt).toBe(2000)
      // The same tokens with other cookies (a profile that was open when its tokens went up sends
      // its cookies once it closes): the cookies land.
      await otherPc(UA, 'acct-a', 1, 2000, 'sk-a3')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 2000, session: 'sk-a3' })

      // Signed in here on its own while the store holds the other PC's sign-in of that account:
      // neither replaces the other.
      await otherPc(UC, 'solo', 9, 9000, 'sk-theirs')
      const solo = await profile('solo', UC, 100, 'sk-mine')
      made.push(solo)
      const before = (await meta(UC)).version
      await runLoginSync()
      expect(await here(solo)).toEqual({ expiry: 100, session: 'sk-mine' })
      expect((await meta(UC)).version).toBe(before)
      expect((await loginSyncStatus()).logins.find((l) => l.id === UC)?.note).toBe('own')

      // A desktop login is never left out (owner, 2026-10-16): asked to, it still takes the newer copy.
      setLoginSyncExcluded(UA, true)
      await otherPc(UA, 'acct-a', 1, 9999, 'sk-a9')
      await runLoginSync()
      expect(await here(a)).toEqual({ expiry: 9999, session: 'sk-a9' })
    } finally {
      disconnectLoginSync()
      // Retried: on the Windows runner a handle the sync just closed can still hold the folder a moment
      // (EBUSY failed CI run 36986153843 after every assertion had passed).
      for (const dir of made)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)

  // A revoked grant keeps its expiry date, and the year-long one a profile keeps through a re-login
  // (core/revoked-grants.ts) would win every "later expiry" and put itself back on every PC.
  test('a grant Anthropic revoked never lands, and never wins the later expiry', async () => {
    const [UA, UB] = [randomUUID(), randomUUID()]
    const made: string[] = []
    const LIVE = 'client:org:https://api:user:inference'
    const DEAD = 'client:org:https://api:user:inference user:file_upload'
    const cache = (g: Record<string, { token: string; expiresAt: number }>) => JSON.stringify(g)
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const meta = async (id: string) =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).find((r) => r.id === id)
      const otherPc = async (id: string, name: string, v2: string, revoked?: string[]) => {
        const login: PortableDesktopLogin = {
          kind: 'desktop',
          id,
          num: 4343,
          name,
          tokenCacheV2: v2,
          tokenCache: null,
          cookies: [cookie('sk-r')],
          expiresAt: 9000,
          ...(revoked && { revoked }),
        }
        const r = await store('PUT', `/v1/logins/${id}`, {
          version: (await meta(id))?.version ?? 0,
          blob: sealLogin(key, login),
          meta: { kind: 'desktop', num: 4343, name, expiresAt: 9000 },
        })
        expect(r.status).toBe(200)
      }
      const v2Here = async (dir: string) => (await readDesktopTokens(dir))?.v2

      const a = await profile('rev-a', UA, 2000, 'sk-r')
      made.push(a)
      await runLoginSync()
      const mine = await v2Here(a)
      // An older live grant beside one the other PC found revoked: this PC's 2000 is the later.
      await otherPc(
        UA,
        'rev-a',
        cache({
          [LIVE]: { token: 't-1500', expiresAt: 1500 },
          [DEAD]: { token: 'dead-9000', expiresAt: 9000 },
        }),
        [grantDigest('dead-9000')],
      )
      await runLoginSync()
      expect(await v2Here(a)).toBe(mine)
      expect((await meta(UA)).meta.expiresAt).toBe(2000)
      // A copy that differs from this one only by a grant known revoked is this one: nothing lands
      // and nothing goes back up, pass after pass (an older PC keeps sending such a copy).
      await otherPc(
        UA,
        'rev-a',
        cache({
          [LIVE]: { token: 't-2000', expiresAt: 2000 },
          [DEAD]: { token: 'dead-9000', expiresAt: 9000 },
        }),
      )
      const version = (await meta(UA)).version
      await runLoginSync()
      await runLoginSync()
      expect(await v2Here(a)).toBe(mine)
      expect((await meta(UA)).version).toBe(version)
      // An account only the store holds lands here without the grant its sender found revoked.
      await otherPc(
        UB,
        'rev-b',
        cache({
          [LIVE]: { token: 't-5000', expiresAt: 5000 },
          [DEAD]: { token: 'dead-b', expiresAt: 9000 },
        }),
        [grantDigest('dead-b')],
      )
      await runLoginSync()
      const b = (await listDesktopProfiles()).find((p) => p.name === 'rev-b')!
      made.push(b.dir)
      expect(await v2Here(b.dir)).toBe(cache({ [LIVE]: { token: 't-5000', expiresAt: 5000 } }))
    } finally {
      disconnectLoginSync()
      for (const dir of made)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)

  // Owner, 2026-10-16: "If one of us removes it ... It removes from the other ... let us know that the
  // other person removed it ... leave a note". The other PC is played by writing its removal marker.
  test('a profile deleted on one PC is deleted on the other, which says who and why; a sign-in after that syncs again', async () => {
    const U = randomUUID()
    const NOTE = 'Moved to the laptop'
    const made: string[] = []
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const row = async () =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).find((r) => r.id === U)
      const gone = await profile(
        `gone-${randomUUID().slice(0, 8)}`,
        U,
        Date.now() + 86_400_000,
        'sk-1',
      )
      made.push(gone)
      await runLoginSync()
      const shared = await row()
      expect(shared.meta.kind).toBe('desktop')

      // The other PC's owner deleted their profile of this account, with a note.
      const marker = { id: U, signedOut: true, removed: true, note: NOTE }
      const put = await store('PUT', `/v1/logins/${U}`, {
        version: shared.version,
        blob: sealLogin(key, marker),
        meta: {
          ...shared.meta,
          signedOut: true,
          removed: true,
          expiresAt: 0,
          by: 'PC-B',
          at: Date.now(),
        },
      })
      expect(put.status).toBe(200)
      const r = await runLoginSync()
      expect(existsSync(gone)).toBe(false)
      expect(r.removed).toEqual([
        expect.objectContaining({ kind: 'desktop', by: 'PC-B', note: NOTE }),
      ])
      const event = (await loginSyncStatus()).events.find((e) => e.action === 'removed')
      expect(event?.note).toContain(NOTE)

      // Signed in here again after that: a new sign-in, so it goes up and syncs again.
      const again = await profile(
        `again-${randomUUID().slice(0, 8)}`,
        U,
        Date.now() + 86_400_000,
        'sk-2',
      )
      made.push(again)
      await runLoginSync()
      expect(existsSync(again)).toBe(true)
      expect((await row()).meta).not.toHaveProperty('removed')

      // This PC's owner deletes it with a note (the delete route's two calls): the store tells the other PC.
      expect((await removeInstance(again, { note: 'Not needed here' })).ok).toBe(true)
      removeLoginEverywhere(U, {
        kind: 'desktop',
        num: null,
        name: basename(again),
        note: 'Not needed here',
      })
      await runLoginSync()
      const sent = (await row()).meta
      expect(sent).toMatchObject({ signedOut: true, removed: true, by: hostname() })
      expect(JSON.stringify(sent)).not.toContain('Not needed here')
    } finally {
      disconnectLoginSync()
      for (const dir of made)
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)

  // Found 2026-10-16: both PCs renewed a shared desktop login's Claude Code grant within a minute of
  // each other with the same refresh token. A refresh rotates it, so the second PC was refused and
  // walled its linked CLI login as "open its desktop app once". Only the PC whose claim the store
  // takes refreshes now; the others get the renewed copy from the store.
  test('of two PCs holding one desktop login, only the one whose claim the store takes refreshes its grant', async () => {
    const U = randomUUID()
    const HOUR = 3_600_000
    let dir = ''
    try {
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      const row = async () =>
        ((await store('GET', '/v1/logins')).json.logins as any[]).find((r) => r.id === U)
      /** The other PC rewrites the row with the same login and `meta` of its own. */
      const otherPcWrites = async (meta: Record<string, unknown>) => {
        const r = await row()
        const blob = (await store('GET', `/v1/logins/${U}`)).json.blob
        expect(
          (
            await store('PUT', `/v1/logins/${U}`, {
              version: r.version,
              blob,
              meta: { ...r.meta, by: 'other-pc', ...meta },
            })
          ).status,
        ).toBe(200)
      }
      const grantKey = `acct:${U}:${U}:https://api.anthropic.com:user:inference user:file_upload user:profile user:sessions:claude_code`
      const due = Date.now() + HOUR
      dir = await profile(`renew-shared-${randomUUID()}`, U, 0, 'sk-r')
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          locale: 'en-US',
          lastKnownAccountUuid: U,
          'oauth:tokenCacheV2': await encryptSafeStorage(
            JSON.stringify({
              [grantKey]: { token: 'old-access', refreshToken: 'old-refresh', expiresAt: due },
            }),
            dir,
          ),
        }),
      )
      await runLoginSync() // up it goes; this PC and the store agree on it
      /** The token endpoint; each call records whose claim the store's row carried at that moment. */
      const claims: unknown[] = []
      const fetchFn = (async () => {
        claims.push((await row()).meta.renewBy)
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 28800,
        })
      }) as unknown as typeof fetch
      const renew = (now: number) =>
        renewDesktopGrant(dir, { now, fetchFn, running: async () => new Set() })

      // The other PC's copy moved on: this PC waits for it to land instead of refreshing its own.
      await otherPcWrites({})
      expect((await renew(Date.now())).state).toBe('skipped')
      // The other PC claimed the renewal: this PC leaves the grant alone while the claim holds.
      await runLoginSync()
      await otherPcWrites({ renewBy: 'other-pc-id', renewUntil: Date.now() + 5 * 60_000 })
      await runLoginSync()
      expect((await renew(Date.now())).state).toBe('skipped')
      // The other PC sent it from a running app, which refreshes its own grant: left to it until it
      // runs out.
      await otherPcWrites({ open: true, renewBy: undefined, renewUntil: undefined })
      await runLoginSync()
      expect((await renew(Date.now())).state).toBe('skipped')
      expect(claims).toHaveLength(0)

      // Run out with nobody renewing it: this PC claims first, and only then refreshes.
      const out = await renew(due + 1)
      expect(out.state).toBe('renewed')
      expect(claims).toHaveLength(1)
      expect(typeof claims[0]).toBe('string')
      // The next pass sends the renewed grant up and its claim ends with it.
      await runLoginSync()
      const sent = await row()
      expect(sent.meta.renewBy).toBeUndefined()
      expect(sent.meta.expiresAt).toBe((out as { expiresAt: number }).expiresAt)
    } finally {
      disconnectLoginSync()
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  }, 120_000)

  test('a linked CLI instance takes its desktop login, a CLI sign-in of its own is never touched, and a logout cuts the link', async () => {
    const dir = await profile('feeds', randomUUID(), 1000, 'sk')
    const made = createCliInstance('fed (CLI)')
    const id = (made.data as { id: string }).id
    const cliDir = getCliInstance(id)!.configDir
    const far = Date.now() + 30 * 86_400_000
    /** The desktop app's token cache: its Claude Code grant, and one a CLI cannot use. */
    const desktopHas = async (accessToken: string, expiresAt: number) =>
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          lastKnownAccountUuid: randomUUID(),
          'oauth:tokenCacheV2': await encryptSafeStorage(
            JSON.stringify({
              'c:o:https://api.anthropic.com:user:profile': { token: 'profile-only', expiresAt },
              'c:o:https://api.anthropic.com:user:inference user:file_upload user:profile user:sessions:claude_code':
                {
                  token: accessToken,
                  refreshToken: 'the-desktop-keeps-this',
                  expiresAt,
                  subscriptionType: 'max',
                  rateLimitTier: 'tier',
                },
            }),
            dir,
          ),
        }),
      )
    const login = () =>
      JSON.parse(readFileSync(join(cliDir, '.credentials.json'), 'utf8')).claudeAiOauth
    // Anthropic's profile read: every desk-* token is the desktop's account, whatever the folder held.
    const profileReads: string[] = []
    const realFetch = globalThis.fetch
    globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
      profileReads.push(
        (new Headers(init?.headers).get('authorization') ?? '').replace(/^Bearer /, ''),
      )
      return Response.json({
        account: { uuid: randomUUID(), email: 'alex@example.com', full_name: 'Alex Example' },
        organization: { uuid: randomUUID(), name: 'Example org', organization_type: 'claude_max' },
      })
    }) as unknown as typeof fetch
    // The folder still names the account it held before the link.
    writeFileSync(
      join(cliDir, '.claude.json'),
      JSON.stringify({
        numStartups: 4,
        oauthAccount: {
          accountUuid: randomUUID(),
          emailAddress: 'pc-two@example.com',
          fullName: 'Example Owner',
        },
      }),
    )
    try {
      await desktopHas('desk-1', far)
      linkCliInstanceToDesktop(id, dir, 'feeds')
      expect(await feedLinkedCliLogins()).toBe(1)
      // The folder now names the fed login's account, keeps the CLI's own settings, and the next pass
      // reads no profile for the same token.
      expect(cliAccountIdentity(cliDir)).toEqual({
        email: 'alex@example.com',
        name: 'Alex Example',
      })
      expect(JSON.parse(readFileSync(join(cliDir, '.claude.json'), 'utf8')).numStartups).toBe(4)
      await feedLinkedCliLogins()
      expect(profileReads).toEqual(['desk-1'])
      // The Claude Code grant, and no refresh token: that one stays the desktop app's.
      expect(login()).toEqual({
        accessToken: 'desk-1',
        expiresAt: far,
        scopes: ['user:inference', 'user:file_upload', 'user:profile', 'user:sessions:claude_code'],
        subscriptionType: 'max',
        rateLimitTier: 'tier',
      })
      // The desktop app renewed its grant: the CLI login follows.
      await desktopHas('desk-2', far + 1000)
      await feedLinkedCliLogins()
      expect(login().accessToken).toBe('desk-2')
      // Logged out: the link goes with it, so the feed does not sign it back in.
      expect(logoutCliInstance(id).ok).toBe(true)
      expect(getCliInstance(id)?.associatedDesktopDir ?? null).toBeNull()
      expect(await feedLinkedCliLogins()).toBe(0)
      // A CLI sign-in of its own (it can refresh itself) is left exactly as it is.
      linkCliInstanceToDesktop(id, dir, 'feeds')
      writeFileSync(
        join(cliDir, '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'own', refreshToken: 'own-refresh', expiresAt: far },
        }),
      )
      expect(await feedCliFromDesktop(getCliInstance(id)!)).toBe('own-login')
      expect(login().accessToken).toBe('own')
      // A renewed grant is one more profile read; a sign-in of the folder's own is never read.
      await feedLinkedCliLogins()
      expect(profileReads).toEqual(['desk-1', 'desk-2'])
    } finally {
      globalThis.fetch = realFetch
      deleteCliInstance(id, getCliInstance(id)?.name)
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  })

  describe('a profile with no claude.ai sign-in cookie is signed out', () => {
    const future = () => Date.now() + 10 * 86_400_000
    const suffix = () => randomUUID().slice(0, 8)
    const sessionOf = async (dir: string) =>
      (await readAuthCookies(dir))?.find((c) => c.name === 'sessionKey')?.value
    /** The other PC's copy of `id` in the store, sealed with this PC's sync key. */
    async function putStoreCopy(
      id: string,
      name: string,
      num: number,
      expiresAt: number,
      session: string,
    ) {
      const key = Buffer.from(
        JSON.parse(
          Buffer.from(loginSyncPairingCode()!.slice('ahsync1:'.length), 'base64url').toString(),
        ).k,
        'base64',
      )
      const login: PortableDesktopLogin = {
        kind: 'desktop',
        id,
        num,
        name,
        tokenCacheV2: grants(expiresAt),
        tokenCache: null,
        cookies: [cookie(session)],
        expiresAt,
      }
      const meta = ((await store('GET', '/v1/logins')).json.logins as any[]).find(
        (r) => r.id === id,
      )
      const r = await store('PUT', `/v1/logins/${id}`, {
        version: meta?.version ?? 0,
        blob: sealLogin(key, login),
        meta: { kind: 'desktop', num, name, expiresAt },
      })
      expect(r.status).toBe(200)
    }
    /** A sync pass's context over a store holding one row, `login` as its copy (for passes that need no store). */
    function stubSync(
      id: string,
      signedOut: boolean,
      login: PortableDesktopLogin,
    ): DesktopSyncContext {
      return {
        store: new Map([
          [
            id,
            {
              version: 3,
              num: login.num,
              kind: 'desktop',
              name: login.name,
              signedOut,
              at: Date.now(),
            },
          ],
        ]),
        state: {},
        out: { pushed: 0, landed: 0, unchanged: 0, problems: [] },
        upload: async () => null,
        download: async (uuid: string) => (uuid === id ? login : null),
        markSignedOut: async () => null,
        confirmGone: () => false,
        clearGone: () => {},
        dropUsage: () => {},
        note: () => {},
      } as unknown as DesktopSyncContext
    }
    const copyOf = (id: string, session: string, expiresAt: number): PortableDesktopLogin => ({
      kind: 'desktop',
      id,
      num: 9,
      name: 'copy',
      tokenCacheV2: grants(expiresAt),
      tokenCache: null,
      cookies: [cookie(session)],
      expiresAt,
    })

    test('a closed profile with no sign-in cookie takes its account’s signed-in store copy', async () => {
      const id = randomUUID()
      const dir = await profile(`nokey-${suffix()}`, id, 100, 'org-id', 'lastActiveOrg')
      try {
        expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
        await runLoginSync()
        const expiresAt = future()
        await putStoreCopy(id, 'nokey', 7, expiresAt, 'sk-landed')
        await runLoginSync()
        expect(await sessionOf(dir)).toBe('sk-landed')
        expect(tokenExpiry((await readDesktopTokens(dir))?.v2 ?? null)).toBe(expiresAt)
        expect((await loginSyncStatus()).logins.find((l) => l.id === id)?.note).toBeNull()
      } finally {
        disconnectLoginSync()
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }, 120_000)

    test('a profile with a sign-in cookie keeps its own sign-in, whatever the store copy’s expiry', async () => {
      const id = randomUUID()
      expect((await configureLoginSync({ url: base, token })).ok).toBe(true)
      await runLoginSync()
      await putStoreCopy(id, 'keyed', 8, future() + 86_400_000, 'sk-theirs')
      const dir = await profile(`keyed-${suffix()}`, id, future(), 'sk-mine')
      try {
        await runLoginSync()
        expect(await sessionOf(dir)).toBe('sk-mine')
        expect((await loginSyncStatus()).logins.find((l) => l.id === id)?.note).toBe('own')
      } finally {
        disconnectLoginSync()
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    }, 120_000)

    test('never lands while its app runs', async () => {
      const id = randomUUID()
      const dir = await profile(`running-${suffix()}`, id, 100, 'org-run', 'lastActiveOrg')
      try {
        const ctx = stubSync(id, false, copyOf(id, 'sk-run', future()))
        await syncDesktopLogins(
          ctx,
          async () => new Set((await listDesktopProfiles()).map((p) => p.dir)),
        )
        expect(ctx.out.landed).toBe(0)
        expect(await sessionOf(dir)).toBeUndefined()
        expect(desktopNotes.waiting.has(id)).toBe(true)
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    })

    test('never lands a signed-out store copy, even one with a sign-in and a grant', async () => {
      const id = randomUUID()
      const dir = await profile(`signedout-${suffix()}`, id, 100, 'org-out', 'lastActiveOrg')
      try {
        const ctx = stubSync(id, true, copyOf(id, 'sk-out', future()))
        await syncDesktopLogins(ctx, async () => new Set<string>())
        expect(ctx.out.landed).toBe(0)
        expect(await sessionOf(dir)).toBeUndefined()
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      }
    })
  })
})
