// server/tests/revoked-grants.test.ts — a usage check that finds a desktop profile's saved logins
// revoked takes them out of the closed profile, and keeps the live one.
//
// The contract (core/revoked-grants.ts): Claude Desktop keeps a revoked grant through a re-login to the
// same account and uses it until its own expiry date, so AgentHydra removes the grants the profile
// endpoint calls revoked while the app is closed, and the app makes new ones. Instance #72, 2026-10-16:
// after the owner signed it out and back in, its Claude Code and year-long grants still answered 401
// "OAuth access token has been revoked." beside the new profile grant. A wrong removal signs a working
// app out of a feature; a missing one leaves a dead login in use for up to a year. Mocked fetch only;
// the profile is the test's own under the scratch instances root. Windows only: the profile key is
// DPAPI's.

import { afterEach, describe, expect, mock, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../src/config'
import { decryptSafeStorage, encryptSafeStorage } from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'
import { instancesRoot } from '../src/core/paths'
import { pruneRevokedGrants } from '../src/core/revoked-grants'
import { PROFILE_API_URL } from '../src/core/shared'
import { resetUsageApiBackoff } from '../src/usage'
import { USAGE_API_URL } from '../src/usage-api'
import { checkUsageForDesktop } from '../src/usage-service'
import { rmRetry } from './rm-retry'

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  resetUsageApiBackoff()
})

describe.skipIf(process.platform !== 'win32')('revoked desktop grants', () => {
  test('a closed profile loses the grants Anthropic revoked at its usage check, and keeps the live one', async () => {
    const uuid = randomUUID()
    const org = randomUUID()
    const key = (client: string, scopes: string) =>
      `acct:${uuid}|${client}:${org}:https://api.anthropic.com:${scopes}`
    const later = (days: number) => Date.now() + days * 86_400_000
    const code = `sk-ant-oat-test-code-${uuid}`
    const year = `sk-ant-oat-test-year-${uuid}`
    const legacy = `sk-ant-oat-test-legacy-${uuid}`
    const profileGrant = `sk-ant-oat-test-profile-${uuid}`
    const live = {
      [key('app', 'user:profile')]: {
        token: profileGrant,
        refreshToken: 'r',
        expiresAt: later(30),
      },
    }
    const v2 = JSON.stringify({
      [key('code', 'user:inference user:file_upload user:profile user:sessions:claude_code')]: {
        token: code,
        refreshToken: 'r',
        expiresAt: later(12),
      },
      [key('code', 'user:inference user:file_upload user:profile')]: {
        token: year,
        refreshToken: 'r',
        expiresAt: later(340),
      },
      ...live,
    })
    const v1 = JSON.stringify({
      [key('legacy', 'user:inference')]: { token: legacy, expiresAt: 0 },
    })
    const dir = join(instancesRoot(), `revoked-${uuid.slice(0, 8)}`)
    mkdirSync(dir, { recursive: true })
    try {
      await ensureWindowsMasterKey(dir)
      writeFileSync(
        join(dir, 'config.json'),
        JSON.stringify({
          locale: 'en-US',
          lastKnownAccountUuid: uuid,
          'oauth:tokenCacheV2': await encryptSafeStorage(v2, dir),
          'oauth:tokenCache': await encryptSafeStorage(v1, dir),
        }),
      )
      // As measured on #72: the usage endpoint answers every grant 429, and the profile endpoint
      // answers the dead ones 401 revoked and the live one 200.
      globalThis.fetch = mock(async (url: unknown, init?: RequestInit) => {
        const auth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? ''
        if (String(url) === USAGE_API_URL)
          return new Response('{"error":{"type":"rate_limit_error"}}', {
            status: 429,
            headers: { 'retry-after': '3600' },
          })
        if (String(url) === PROFILE_API_URL && auth.endsWith(profileGrant))
          return new Response('{}', { status: 200 })
        if (String(url) === PROFILE_API_URL)
          return new Response(
            '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
            { status: 401 },
          )
        throw new TypeError('fetch failed')
      }) as unknown as typeof fetch

      const r = await checkUsageForDesktop(dir)
      expect(r.reason).toBe('token_revoked')

      const cfg = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))
      expect(cfg.lastKnownAccountUuid).toBe(uuid)
      expect(await decryptSafeStorage(cfg['oauth:tokenCacheV2'], dir)).toBe(JSON.stringify(live))
      expect(await decryptSafeStorage(cfg['oauth:tokenCache'], dir)).toBe('{}')
      // Remembered by digest only: no file in the data dir holds a token.
      for (const f of readdirSync(DATA_DIR).filter((n) => n.startsWith('revoked-grants'))) {
        const text = readFileSync(join(DATA_DIR, f), 'utf8')
        for (const t of [code, year, legacy]) expect(text).not.toContain(t)
      }
    } finally {
      rmRetry(dir)
    }
  }, 60_000)

  test('a login saved while the prune is asking the network is not overwritten by the older copy', async () => {
    const uuid = randomUUID()
    const org = randomUUID()
    const grantKey = `acct:${uuid}|code:${org}:https://api.anthropic.com:user:inference user:profile`
    const dead = `sk-ant-oat-test-dead-${uuid}`
    const synced = `sk-ant-oat-test-synced-${uuid}`
    const dir = join(instancesRoot(), `revoked-race-${uuid.slice(0, 8)}`)
    const path = join(dir, 'config.json')
    mkdirSync(dir, { recursive: true })
    try {
      await ensureWindowsMasterKey(dir)
      const cache = (token: string) =>
        encryptSafeStorage(
          JSON.stringify({ [grantKey]: { token, refreshToken: 'r', expiresAt: Date.now() + 1e9 } }),
          dir,
        )
      writeFileSync(
        path,
        JSON.stringify({ lastKnownAccountUuid: uuid, 'oauth:tokenCacheV2': await cache(dead) }),
      )
      // Login sync lands a newer login while the prune awaits the profile endpoint's answer.
      const landed = JSON.stringify(
        { lastKnownAccountUuid: uuid, 'oauth:tokenCacheV2': await cache(synced) },
        null,
        2,
      )
      globalThis.fetch = mock(async (url: unknown) => {
        if (String(url) !== PROFILE_API_URL) throw new TypeError('fetch failed')
        writeFileSync(path, landed)
        return new Response(
          '{"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."}}',
          { status: 401 },
        )
      }) as unknown as typeof fetch

      expect(await pruneRevokedGrants(dir, { prove: true })).toBe(0)
      expect(readFileSync(path, 'utf8')).toBe(landed)
    } finally {
      rmRetry(dir)
    }
  }, 60_000)
})
