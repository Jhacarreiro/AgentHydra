import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codexAccountsCacheFile,
  deleteCodexCacheEntry,
  localCodexAccount,
  resolveCodexAccount,
} from '../src/core/codex-account'
import { isCodexLoggedIn } from '../src/core/codex-instances'

const dirs: string[] = []
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  for (const dir of dirs.splice(0)) {
    deleteCodexCacheEntry(dir)
    rmSync(dir, { recursive: true, force: true })
  }
})
const jwt = (value: unknown) =>
  `synthetic.${Buffer.from(JSON.stringify(value)).toString('base64url')}.signature`
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'ah-codex-auth-rejection-'))
  dirs.push(home)
  const file = join(home, 'auth.json')
  const auth = {
    auth_mode: 'chatgpt',
    tokens: {
      access_token: jwt({ exp: 4_102_444_800 }),
      refresh_token: 'synthetic-refresh',
      id_token: jwt({
        email: 'account@example.test',
        'https://api.openai.com/auth': {
          chatgpt_account_id: 'example-account',
          chatgpt_plan_type: 'plus',
        },
      }),
      account_id: 'example-account',
    },
  }
  writeFileSync(file, JSON.stringify(auth))
  return { home, file, auth }
}
const respond = (status: number) => {
  globalThis.fetch = (async () => new Response(null, { status })) as unknown as typeof fetch
}

test('an authoritative 401 persists a value-blind signed-out proof for this exact saved grant', async () => {
  const f = fixture()
  const before = readFileSync(f.file, 'utf8')
  respond(401)
  const result = await resolveCodexAccount(f.home)
  expect(result.account).toMatchObject({ status: 'loggedout', source: 'auth_rejected' })
  expect(localCodexAccount(f.home).status).toBe('loggedout')
  expect(isCodexLoggedIn(f.home)).toBe(false)
  expect(readFileSync(f.file, 'utf8')).toBe(before)
  const saved = readFileSync(codexAccountsCacheFile(), 'utf8')
  expect(saved).not.toContain(f.auth.tokens.access_token)
  expect(saved).not.toContain(f.auth.tokens.refresh_token)
})

test('403, rate limits, server errors and offline reads do not mark a saved login dead', async () => {
  for (const status of [403, 429, 500]) {
    const f = fixture()
    respond(status)
    expect((await resolveCodexAccount(f.home)).account.status).not.toBe('loggedout')
    expect(isCodexLoggedIn(f.home)).toBe(true)
  }
  const f = fixture()
  globalThis.fetch = (async () => {
    throw new Error('offline')
  }) as unknown as typeof fetch
  await resolveCodexAccount(f.home)
  expect(isCodexLoggedIn(f.home)).toBe(true)
})

test('a replaced fresh grant clears the old local rejection without another provider request', async () => {
  const f = fixture()
  respond(401)
  await resolveCodexAccount(f.home)
  f.auth.tokens.access_token = jwt({ exp: 4_102_444_801 })
  writeFileSync(f.file, JSON.stringify(f.auth))
  expect(localCodexAccount(f.home).source).not.toBe('auth_rejected')
  expect(isCodexLoggedIn(f.home)).toBe(true)
})

test('a rejection of an older in-flight grant cannot sign out its replacement', async () => {
  const f = fixture()
  globalThis.fetch = (async () => {
    f.auth.tokens.refresh_token = 'synthetic-replacement-refresh'
    writeFileSync(f.file, JSON.stringify(f.auth))
    return new Response(null, { status: 401 })
  }) as unknown as typeof fetch
  const result = await resolveCodexAccount(f.home)
  expect(result.account.status).not.toBe('loggedout')
  expect(isCodexLoggedIn(f.home)).toBe(true)
})

test('a later successful authentication clears a rejection for the same unchanged login', async () => {
  const f = fixture()
  respond(401)
  await resolveCodexAccount(f.home)
  globalThis.fetch = (async () =>
    Response.json({
      account_id: 'example-account',
      email: 'account@example.test',
      plan_type: 'plus',
      rate_limit: {},
    })) as unknown as typeof fetch
  expect((await resolveCodexAccount(f.home)).account.status).toBe('live')
  expect(isCodexLoggedIn(f.home)).toBe(true)
})

test('API keys and unknown legacy auth shapes retain their existing local login semantics', () => {
  const f = fixture()
  writeFileSync(f.file, JSON.stringify({ OPENAI_API_KEY: 'synthetic-api-key' }))
  expect(localCodexAccount(f.home).authMode).toBe('apikey')
  expect(isCodexLoggedIn(f.home)).toBe(true)
  writeFileSync(f.file, '{}')
  expect(isCodexLoggedIn(f.home)).toBe(true)
})
