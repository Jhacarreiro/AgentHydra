import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { IDENTITY_WALL, ORG_DISABLED_WALL } from '../src/climayte-lib'
import { type CliAuthCheckResult, createCliAuthChecker } from '../src/core/cli-auth-check'
import { OAUTH_BETA_HEADER, PROFILE_API_URL } from '../src/core/shared'
import {
  checkUsage,
  clearVerifiedUsageAuthFailure,
  lastUsageApiFailure,
  resetUsageApiBackoff,
} from '../src/usage'
import { USAGE_API_URL } from '../src/usage-api'

const UUID = 'aaaaaaaa-0000-4000-8000-000000000001'
const EMAIL = 'example@example.test'
const TOKEN = 'synthetic-current-grant'
const scratch: string[] = []
const originalFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = originalFetch
  resetUsageApiBackoff()
  for (const dir of scratch.splice(0))
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
})

const profile = (email = EMAIL, uuid: unknown = UUID) => Response.json({ account: { email, uuid } })
const credentials = (token = TOKEN, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      expiresAt: Date.now() + 3_600_000,
      scopes: ['user:profile', 'user:inference'],
      ...overrides,
    },
  })

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cli-auth-check-'))
  scratch.push(dir)
  const file = join(dir, '.credentials.json')
  writeFileSync(file, credentials())
  const state: {
    instance: { id: string; configDir: string; accountEmail: string; name: string } | null
    wall: { reason: string; until: number; cred: number } | undefined
    cleared: number
    verified: number
  } = {
    instance: { id: 'example-managed', configDir: dir, accountEmail: EMAIL, name: EMAIL },
    wall: { reason: 'signed out', until: 1, cred: statSync(file).mtimeMs },
    cleared: 0,
    verified: 0,
  }
  const check = (
    fetchProfile: NonNullable<Parameters<typeof createCliAuthChecker>[0]['fetchProfile']>,
    timeoutMs?: number,
  ) =>
    createCliAuthChecker({
      instance: () => state.instance && { ...state.instance },
      wall: () => state.wall,
      clearWall: () => {
        state.cleared++
        state.wall = undefined
      },
      verified: () => {
        state.verified++
      },
      fetchProfile,
      timeoutMs,
    })('example-managed')
  return { dir, file, state, check }
}

test('the exact current grant is verified read-only before a signed-out wall is cleared', async () => {
  const f = fixture()
  const before = readFileSync(f.file, 'utf8')
  let requests = 0
  const result = await f.check(async (url, init) => {
    requests++
    expect(url).toBe(PROFILE_API_URL)
    expect(init.method).toBe('GET')
    expect(init.redirect).toBe('error')
    expect(init.body).toBeUndefined()
    const headers = new Headers(init.headers)
    expect(headers.get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(headers.get('anthropic-beta')).toBe(OAUTH_BETA_HEADER)
    expect(headers.get('user-agent')).toMatch(/^claude-code\//)
    return profile(`  ${EMAIL.toUpperCase()}  `)
  })
  expect(result).toEqual({
    ok: true,
    loggedIn: true,
    wallCleared: true,
    reason: 'verified',
    status: 200,
    email: EMAIL,
    accountUuid: UUID,
  })
  expect(requests).toBe(1)
  expect(f.state.cleared).toBe(1)
  expect(f.state.verified).toBe(1)
  expect(f.state.wall).toBeUndefined()
  expect(readFileSync(f.file, 'utf8')).toBe(before)
  expect(JSON.stringify(result)).not.toContain(TOKEN)
})

test('rejections, mismatched identities and malformed profiles keep the authentication wall', async () => {
  const cases: Array<[Response, CliAuthCheckResult['reason']]> = [
    [new Response(`error echoes ${TOKEN}`, { status: 401 }), 'profile_rejected'],
    [new Response(`error echoes ${TOKEN}`, { status: 403 }), 'profile_rejected'],
    [new Response('rate limited', { status: 429 }), 'profile_unavailable'],
    [profile('different@example.test'), 'identity_mismatch'],
    [profile(EMAIL, 'not-a-uuid'), 'profile_invalid'],
    [Response.json({ account: { uuid: UUID } }), 'profile_invalid'],
    [new Response('{broken'), 'profile_invalid'],
    [new Response('x'.repeat(65_537)), 'profile_invalid'],
    [new Response('{}', { headers: { 'content-length': '65537' } }), 'profile_invalid'],
  ]
  for (const [response, reason] of cases) {
    const f = fixture()
    const wall = f.state.wall
    const result = await f.check(async () => response)
    expect(result.reason).toBe(reason)
    expect(result.ok).toBe(false)
    expect(f.state.wall).toBe(wall)
    expect(f.state.cleared).toBe(0)
    expect(f.state.verified).toBe(0)
    expect(JSON.stringify(result)).not.toContain(TOKEN)
  }
  const f = fixture()
  const unavailable = await f.check(async () => {
    throw new Error(`Synthetic transport error ${TOKEN}`)
  })
  expect(unavailable.reason).toBe('profile_unavailable')
  expect(JSON.stringify(unavailable)).not.toContain(TOKEN)
  expect(f.state.cleared).toBe(0)
})

test('invalid or oversized credentials and unknown identity fail before any request', async () => {
  for (const raw of [
    '{}',
    '{broken',
    'x'.repeat(65_537),
    credentials(TOKEN, { expiresAt: Date.now() - 1 }),
    credentials(TOKEN, { scopes: ['user:profile'] }),
    credentials('', {}),
  ]) {
    const f = fixture()
    writeFileSync(f.file, raw)
    expect(
      (
        await f.check(async () => {
          throw new Error('Request must not start')
        })
      ).reason,
    ).toBe('credentials_invalid')
    expect(f.state.cleared).toBe(0)
  }
  const f = fixture()
  const fetchProfile = async () => {
    throw new Error('Request must not start')
  }
  const checker = createCliAuthChecker({
    instance: () => f.state.instance,
    wall: () => f.state.wall,
    clearWall: () => {},
    fetchProfile,
  })
  expect((await checker('example-managed', 'different@example.test')).reason).toBe(
    'identity_mismatch',
  )
  expect((await checker('example-managed', '')).reason).toBe('identity_required')
  f.state.instance = null
  expect((await checker('missing')).reason).toBe('not_found')
})

test('credential changes, deletion and account or wall replacement during the request cannot clear state', async () => {
  const changes: Array<
    [string, (f: ReturnType<typeof fixture>) => void, CliAuthCheckResult['reason']]
  > = [
    [
      'credential content with restored mtime',
      (f) => {
        const old = statSync(f.file)
        writeFileSync(
          f.file,
          readFileSync(f.file, 'utf8').replace(TOKEN, 'synthetic-changed-grant'),
        )
        utimesSync(f.file, old.atime, old.mtime)
      },
      'credentials_changed',
    ],
    ['credential removal', (f) => rmSync(f.file), 'credentials_changed'],
    [
      'replacement file with identical bytes',
      (f) => {
        const old = statSync(f.file)
        const bytes = readFileSync(f.file)
        rmSync(f.file)
        writeFileSync(f.file, bytes)
        utimesSync(f.file, old.atime, old.mtime)
      },
      'credentials_changed',
    ],
    [
      'instance removal',
      (f) => {
        f.state.instance = null
      },
      'state_changed',
    ],
    [
      'instance identity changed',
      (f) => {
        f.state.instance!.id = 'another-managed'
      },
      'state_changed',
    ],
    [
      'instance folder replacement',
      (f) => {
        f.state.instance!.configDir = join(f.dir, 'other')
      },
      'state_changed',
    ],
    [
      'account replacement',
      (f) => {
        f.state.instance!.accountEmail = 'other@example.test'
      },
      'state_changed',
    ],
    [
      'new wall',
      (f) => {
        f.state.wall = { ...f.state.wall!, until: 2 }
      },
      'state_changed',
    ],
    [
      'in-place wall mutation',
      (f) => {
        f.state.wall!.cred++
      },
      'state_changed',
    ],
  ]
  for (const [label, change, reason] of changes) {
    const f = fixture()
    const result = await f.check(async () => {
      change(f)
      return profile()
    })
    expect(result.reason, label).toBe(reason)
    expect(f.state.cleared, label).toBe(0)
    expect(f.state.verified, label).toBe(0)
  }
})

test('a valid grant preserves organization, identity and quota walls', async () => {
  for (const reason of [ORG_DISABLED_WALL, IDENTITY_WALL, 'session limit']) {
    const f = fixture()
    f.state.wall!.reason = reason
    const wall = f.state.wall
    const result = await f.check(async () => profile())
    expect(f.state.wall).toBe(wall)
    expect(f.state.cleared).toBe(0)
    expect(result.wallCleared).toBe(false)
    expect(result.ok).toBe(reason === 'session limit')
    expect(f.state.verified).toBe(reason === 'session limit' ? 1 : 0)
  }
})

test('one deadline bounds stalled headers and bodies, with no retries or late wall mutation', async () => {
  const f = fixture()
  let release: ((response: Response) => void) | undefined
  let requests = 0
  const result = await f.check(async () => {
    requests++
    return await new Promise<Response>((resolve) => {
      release = resolve
    })
  }, 20)
  expect(result.reason).toBe('profile_unavailable')
  release!(profile())
  await Bun.sleep(10)
  expect(requests).toBe(1)
  expect(f.state.cleared).toBe(0)
  let cancelled = false
  const bodyResult = await f.check(
    async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            cancelled = true
          },
        }),
      ),
    20,
  )
  expect(bodyResult.reason).toBe('profile_unavailable')
  expect(cancelled).toBe(true)
  expect(f.state.cleared).toBe(0)
})

test('verified usage reconciliation clears only that grant’s 401, preserving other grants and real 429s', async () => {
  const auth = (secret: string) => ({ authType: 'oauth_token' as const, secret })
  let usageRequests = 0
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const token = new Headers(init?.headers).get('authorization')?.slice(7)
    if (String(url) === USAGE_API_URL) {
      usageRequests++
      return new Response('{}', { status: 429, headers: { 'retry-after': '3600' } })
    }
    return token === 'synthetic-rate-limit' ? profile() : new Response('{}', { status: 401 })
  }) as unknown as typeof fetch
  await checkUsage({ auth: auth(TOKEN), account: 'same-label' })
  await checkUsage({ auth: auth('synthetic-other-grant'), account: 'same-label' })
  expect(lastUsageApiFailure('same-label')?.status).toBe(401)
  clearVerifiedUsageAuthFailure('same-label', TOKEN)
  // The later failure belongs to the other grant and must remain.
  expect(lastUsageApiFailure('same-label')?.status).toBe(401)
  const before = usageRequests
  await checkUsage({ auth: auth('synthetic-other-grant'), account: 'same-label' })
  expect(usageRequests).toBe(before)
  await checkUsage({ auth: auth(TOKEN), account: 'same-label' })
  expect(usageRequests).toBe(before + 1)
  clearVerifiedUsageAuthFailure('other-label', TOKEN)
  expect(lastUsageApiFailure('same-label')?.status).toBe(401)
  clearVerifiedUsageAuthFailure('same-label', TOKEN)
  expect(lastUsageApiFailure('same-label')).toBeNull()
  await checkUsage({ auth: auth('synthetic-rate-limit'), account: 'rate-label' })
  expect(lastUsageApiFailure('rate-label')?.status).toBe(429)
  clearVerifiedUsageAuthFailure('rate-label', 'synthetic-rate-limit')
  expect(lastUsageApiFailure('rate-label')?.status).toBe(429)
  const rateBefore = usageRequests
  await checkUsage({ auth: auth('synthetic-rate-limit'), account: 'rate-label' })
  expect(usageRequests).toBe(rateBefore)
})

test('the actual HTTP endpoint reconciles one managed login and rejects invalid targets without CLI or message sends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ah-cli-auth-route-'))
  scratch.push(dir)
  const url = (file: string) =>
    JSON.stringify(pathToFileURL(resolve(import.meta.dir, '../src', file)).href)
  const script = `
    import assert from 'node:assert/strict'
    import { mkdirSync, writeFileSync, statSync } from 'node:fs'
    import { join } from 'node:path'
    let requests=0
    globalThis.fetch=async(url,init)=>{
      assert.equal(String(url), ${JSON.stringify(PROFILE_API_URL)})
      assert.equal(init.method,'GET')
      assert.equal(init.body,undefined)
      requests++
      return Response.json({account:{email:${JSON.stringify(EMAIL)},uuid:${JSON.stringify(UUID)}}})
    }
    const {createCliInstance,getCliInstance}=await import(${url('core/cli-instances.ts')})
    const core=await import(${url('climayte-core.ts')})
    await import(${url('routes/usage.ts')})
    const {app}=await import(${url('http-app.ts')})
    const made=createCliInstance(${JSON.stringify(EMAIL)})
    assert.equal(made.ok,true)
    const id=made.data.id
    const file=join(made.dir,'.credentials.json')
    writeFileSync(file,${JSON.stringify(credentials())})
    writeFileSync(join(made.dir,'.claude.json'),JSON.stringify({oauthAccount:{emailAddress:${JSON.stringify(EMAIL)}}}))
    core.load()
    core.walls[id]={reason:'signed out',until:1,cred:statSync(file).mtimeMs}
    assert.equal(getCliInstance(id).loggedIn,false)
    let response=await app.request('/api/cli-instances/'+id+'/auth-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedEmail:${JSON.stringify(EMAIL)}})})
    const result=await response.json()
    assert.equal(result.ok,true)
    assert.equal(result.wallCleared,true)
    assert.equal(getCliInstance(id).loggedIn,true)
    assert.equal(requests,1)
    response=await app.request('/api/cli-instances/missing/auth-check',{method:'POST'})
    assert.equal(response.status,404)
    response=await app.request('/api/cli-instances/'+id+'/auth-check',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedEmail:7})})
    assert.equal(response.status,400)
    assert.equal(requests,1)
    console.log('cli-auth-route-ok')
    process.exit(0)
  `
  const env = { ...process.env }
  for (const key of [
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'AGENTHYDRA_HOME',
    'AGENTHYDRA_DATA_DIR',
    'AGENTHYDRA_INSTANCES_ROOT',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'HSWARM_HOME',
    'AGENTHYDRA_CLAUDE_PROJECTS_ROOT',
    'AGENTHYDRA_CORE_DIR',
    'AGENTHYDRA_RUN_LOG_DIR',
  ]) {
    env[key] = join(dir, key.toLowerCase())
    mkdirSync(env[key]!, { recursive: true })
  }
  env.AGENTHYDRA_DB = join(dir, 'test.sqlite')
  env.AGENTHYDRA_CLAUDE_PATH = join(dir, 'no-such-cli.exe')
  env.AGENTHYDRA_CLAUDE_GUARD = '0'
  const child = Bun.spawn([process.execPath, '-e', script], {
    env,
    windowsHide: true,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: 25_000,
  })
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect(code, `${err}\n${out}`).toBe(0)
  expect(out.trim()).toBe('cli-auth-route-ok')
}, 30_000)
