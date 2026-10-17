// A CLI login whose token Anthropic revoked says so, as a desktop profile's does (server/src/usage-service.ts).
// 2026-10-16: the CLI logins linked to instances #72 and #8 carried the same revoked tokens as their desktop
// profiles, and while those rows came to say "revoked", these two still read "check failed" with no detail.
// Mocked fetch only: no live call, and a spawn fails the test.
import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createCliInstance, deleteCliInstance, getCliInstance } from '../src/core/cli-instances'
import { resetUsageApiBackoff } from '../src/usage'
import { USAGE_API_URL } from '../src/usage-api'
import { checkUsageForCliInstance } from '../src/usage-service'

const realFetch = globalThis.fetch
const made: string[] = []
beforeEach(() => resetUsageApiBackoff())
afterEach(() => {
  globalThis.fetch = realFetch
  resetUsageApiBackoff()
  for (const id of made.splice(0)) deleteCliInstance(id, getCliInstance(id)?.name ?? '')
})

test('a CLI login the profile endpoint calls revoked reads token_revoked, with the server words', async () => {
  const created = createCliInstance('revoked-login-test')
  expect(created.ok).toBe(true)
  const id = created.data?.id as string
  made.push(id)
  const inst = getCliInstance(id)
  writeFileSync(
    join(inst?.configDir ?? '', '.credentials.json'),
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat-test-cli',
        refreshToken: 'test-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile'],
      },
    }),
  )
  expect(getCliInstance(id)?.loggedIn).toBe(true)

  globalThis.fetch = mock(async (url: unknown) =>
    String(url) === USAGE_API_URL
      ? new Response(JSON.stringify({ error: { type: 'rate_limit_error' } }), {
          status: 429,
          headers: { 'retry-after': '3600' },
        })
      : new Response(
          JSON.stringify({
            type: 'error',
            error: {
              type: 'authentication_error',
              message: 'OAuth access token has been revoked.',
            },
          }),
          { status: 401 },
        ),
  ) as unknown as typeof fetch
  const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
    throw new Error('a CLI probe was spawned')
  })
  try {
    const result = await checkUsageForCliInstance(id)
    expect(result?.reason).toBe('token_revoked')
    expect(result?.detail).toContain('has been revoked')
  } finally {
    spawnSpy.mockRestore()
  }
})
