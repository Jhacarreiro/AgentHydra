import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveAccount } from '../src/core/accounts'
import { encryptSafeStorage } from '../src/core/crypto'
import { ensureWindowsMasterKey } from '../src/core/crypto/keys.win'

const native = test.skipIf(process.platform !== 'win32')
const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function profile(newer: string, older?: string) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-cleared-login-'))
  roots.push(root)
  expect(await ensureWindowsMasterKey(root)).toBeTruthy()
  writeFileSync(
    join(root, 'config.json'),
    JSON.stringify({
      lastKnownAccountUuid: '11111111-1111-4111-8111-111111111111',
      'oauth:tokenCacheV2': await encryptSafeStorage(newer, root),
      ...(older === undefined ? {} : { 'oauth:tokenCache': await encryptSafeStorage(older, root) }),
    }),
  )
  return root
}

native(
  'successfully decrypted cleared caches report signed out instead of a cached login',
  async () => {
    for (const older of [undefined, '{}']) {
      expect((await resolveAccount(await profile('{}', older))).status).toBe('loggedout')
    }
  },
)

native(
  'an older populated cache, malformed data and unknown shapes are not proof of sign out',
  async () => {
    for (const [newer, older] of [
      ['{}', '{"legacy":{}}'],
      ['not-json', undefined],
      ['[]', undefined],
    ]) {
      expect((await resolveAccount(await profile(newer!, older))).status).not.toBe('loggedout')
    }
  },
)

native(
  'an observation read never decrypts storage or infers a sign out from a cached identity',
  async () => {
    const root = await profile('{}', '{}')
    expect((await resolveAccount(root, { noNetwork: true })).status).not.toBe('loggedout')
  },
)
