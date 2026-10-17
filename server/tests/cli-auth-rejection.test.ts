import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { IDENTITY_WALL, ORG_DISABLED_WALL } from '../src/climayte-lib'
import { createCliAuthChecker } from '../src/core/cli-auth-check'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-auth-rejection-'))
  dirs.push(dir)
  const file = join(dir, '.credentials.json')
  writeFileSync(
    file,
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'synthetic-grant',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
      },
    }),
  )
  const state: {
    instance: { id: string; configDir: string; accountEmail: string; name: string } | null
    wall: { reason: string; until: number; cred?: number } | undefined
    rejected: number
  } = {
    instance: {
      id: 'example-managed',
      configDir: dir,
      accountEmail: 'account@example.test',
      name: 'Example',
    },
    wall: undefined,
    rejected: 0,
  }
  const check = (
    fetchProfile: NonNullable<Parameters<typeof createCliAuthChecker>[0]['fetchProfile']>,
  ) =>
    createCliAuthChecker({
      instance: () => state.instance && { ...state.instance },
      wall: () => state.wall,
      clearWall: () => {
        throw new Error('A rejection must never clear a wall')
      },
      rejected: () => {
        state.rejected++
        state.wall = { reason: 'signed out', until: Number.MAX_SAFE_INTEGER }
      },
      fetchProfile,
    })('example-managed')
  return { file, state, check }
}

test('a definitive 401 records a signed-out wall without rewriting the login', async () => {
  const f = fixture()
  const before = readFileSync(f.file, 'utf8')
  const result = await f.check(async () => new Response('untrusted provider text', { status: 401 }))
  expect(result).toMatchObject({
    ok: false,
    loggedIn: false,
    wallSet: true,
    status: 401,
    reason: 'profile_rejected',
  })
  expect(f.state.rejected).toBe(1)
  expect(f.state.wall?.reason).toBe('signed out')
  expect(readFileSync(f.file, 'utf8')).toBe(before)
  expect(JSON.stringify(result)).not.toContain('synthetic-grant')
})

test('a 403, rate limit or transport failure never marks a login dead', async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture()
    const result = await f.check(async () => new Response(null, { status }))
    expect(result.wallSet).toBeUndefined()
    expect(f.state.rejected).toBe(0)
    expect(f.state.wall).toBeUndefined()
  }
  const f = fixture()
  await f.check(async () => {
    throw new Error('offline')
  })
  expect(f.state.rejected).toBe(0)
})

test('an earlier grant rejection cannot mark a replacement grant dead', async () => {
  const f = fixture()
  const result = await f.check(async () => {
    writeFileSync(
      f.file,
      readFileSync(f.file, 'utf8').replace('synthetic-grant', 'synthetic-renewed-grant'),
    )
    return new Response(null, { status: 401 })
  })
  expect(result.reason).toBe('credentials_changed')
  expect(f.state.rejected).toBe(0)
})

test('an earlier rejection cannot overwrite a changed identity or concurrent wall', async () => {
  for (const change of ['identity', 'removed', 'wall'] as const) {
    const f = fixture()
    const result = await f.check(async () => {
      if (change === 'identity') f.state.instance!.accountEmail = 'other@example.test'
      else if (change === 'removed') f.state.instance = null
      else f.state.wall = { reason: 'weekly limit', until: Date.now() + 60_000 }
      return new Response(null, { status: 401 })
    })
    expect(result.reason).toBe('state_changed')
    expect(f.state.rejected).toBe(0)
  }
})

test('identity and organization restrictions remain the actionable reason', async () => {
  for (const reason of [IDENTITY_WALL, ORG_DISABLED_WALL]) {
    const f = fixture()
    f.state.wall = { reason, until: Number.MAX_SAFE_INTEGER }
    const result = await f.check(async () => new Response(null, { status: 401 }))
    expect(result.reason).toBe('account_restricted')
    expect(f.state.wall?.reason).toBe(reason)
    expect(f.state.rejected).toBe(0)
  }
})
