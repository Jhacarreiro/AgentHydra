import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createCliAuthChecker } from '../src/core/cli-auth-check'
import { feedCliFromDesktop, setDesktopCliAuthChecker } from '../src/core/desktop-cli-feed'

const roots: string[] = []
let previousChecker: ReturnType<typeof setDesktopCliAuthChecker> = null
beforeEach(() => {
  previousChecker = setDesktopCliAuthChecker(null)
})
afterEach(() => {
  setDesktopCliAuthChecker(previousChecker)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(expiresAt = Date.now() + 3_600_000) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-cli-reactivate-'))
  roots.push(root)
  const path = join(root, '.credentials.json')
  writeFileSync(
    path,
    JSON.stringify({
      keep: 'settings',
      claudeAiOauth: { accessToken: 'old', refreshToken: 'old-refresh', expiresAt },
    }),
  )
  const cli = {
    id: 'synthetic-cli',
    configDir: root,
    associatedDesktopDir: join(root, 'desktop'),
    loggedIn: false,
    loginNote: 'Signed out: synthetic refusal',
    accountEmail: 'owner@example.test',
  }
  const fresh = {
    accessToken: 'fresh',
    expiresAt: Date.now() + 7_200_000,
    scopes: ['user:profile', 'user:sessions:claude_code'],
    subscriptionType: 'max',
    rateLimitTier: null,
  }
  return { cli, path, fresh, bytes: readFileSync(path) }
}

test('fresh Desktop login renews an idle rejected own CLI grant and requests verified wall clearing', async () => {
  const f = fixture()
  let wall: { reason: string; until: number } | undefined = { reason: 'signed out', until: 1 }
  setDesktopCliAuthChecker(
    createCliAuthChecker({
      instance: () => f.cli,
      wall: () => wall,
      clearWall: () => {
        wall = undefined
      },
      fetchProfile: async (_url, init) => {
        expect(new Headers(init.headers).get('authorization')).toBe('Bearer fresh')
        expect(init.method).toBe('GET')
        return Response.json({
          account: { email: 'owner@example.test', uuid: '11111111-1111-4111-8111-111111111111' },
        })
      },
    }),
  )
  expect(await feedCliFromDesktop(f.cli, async () => f.fresh)).toBe('fed')
  expect(wall).toBeUndefined()
  const stored = JSON.parse(readFileSync(f.path, 'utf8'))
  expect(stored.keep).toBe('settings')
  expect(stored.claudeAiOauth).toEqual(f.fresh)
  expect(stored.claudeAiOauth.refreshToken).toBeUndefined()
})

test('a rejected replacement grant does not clear the signed-out wall', async () => {
  const f = fixture()
  let cleared = false
  setDesktopCliAuthChecker(
    createCliAuthChecker({
      instance: () => f.cli,
      wall: () => ({ reason: 'signed out', until: 1 }),
      clearWall: () => {
        cleared = true
      },
      fetchProfile: async () => Response.json({}, { status: 401 }),
    }),
  )
  expect(await feedCliFromDesktop(f.cli, async () => f.fresh)).toBe('fed')
  expect(cleared).toBe(false)
})

test('an expired linked own grant can renew without a signed-out veto', async () => {
  const f = fixture(Date.now() - 1000)
  expect(
    await feedCliFromDesktop(
      { ...f.cli, loggedIn: true, loginNote: undefined },
      async () => f.fresh,
    ),
  ).toBe('fed')
})

test('the same refused grant neither writes credentials nor requests a wall clear', async () => {
  const f = fixture()
  setDesktopCliAuthChecker(async () => {
    throw Error('No new sign-in was supplied')
  })
  expect(await feedCliFromDesktop(f.cli, async () => ({ ...f.fresh, accessToken: 'old' }))).toBe(
    'current',
  )
  expect(readFileSync(f.path)).toEqual(f.bytes)
})

test('healthy own logins and organization or identity restrictions remain unchanged', async () => {
  for (const loginNote of [
    undefined,
    'Needs identity verification: synthetic',
    'Claude Code is turned off',
  ]) {
    const f = fixture()
    expect(
      await feedCliFromDesktop({ ...f.cli, loggedIn: !loginNote, loginNote }, async () => {
        throw Error('Do not read Desktop')
      }),
    ).toBe('own-login')
    expect(readFileSync(f.path)).toEqual(f.bytes)
  }
})

test('busy logins and concurrent credential replacements remain untouched', async () => {
  const f = fixture()
  expect(await feedCliFromDesktop({ ...f.cli, inUse: true }, async () => f.fresh)).toBe('busy')
  expect(readFileSync(f.path)).toEqual(f.bytes)
  const replacement = Buffer.from(
    JSON.stringify({ claudeAiOauth: { accessToken: 'new-own', refreshToken: 'new-refresh' } }),
  )
  expect(
    await feedCliFromDesktop(f.cli, async () => {
      writeFileSync(f.path, replacement)
      return f.fresh
    }),
  ).toBe('own-login')
  expect(readFileSync(f.path)).toEqual(replacement)
})
