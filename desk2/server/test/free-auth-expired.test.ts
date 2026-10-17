import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeRequest, FreeUsage } from '../../shared/free-instances'
import { nudgeDue } from '../src/free-instances/keepalive'
import { nextRead } from '../src/free-instances/refresh'
import type { RunOutput } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'
import type { FreeStorage } from '../src/free-instances/storage'

const homes: string[] = []
const services: FreeInstances[] = []
const HOUR = 3_600_000
const settings = { keepWindows: true, weeklyFloorPct: 85 }
const output = (value: unknown, code = 0): RunOutput => ({ code, stdout: JSON.stringify(value) })

afterEach(async () => {
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
}, 30_000)

function fixture(code: string) {
  const home = mkdtempSync(join(tmpdir(), 'free-auth-expired-'))
  homes.push(home)
  const runtime: FreeRuntime = {
    ready: () => true,
    ensure: async () => {},
    config: (id) => ({
      harnessDir: home,
      python: join(home, 'unused-python.exe'),
      stateDir: join(home, 'free', 'instances', id),
      cacheDir: join(home, 'cache'),
    }),
  }
  const commands: string[] = []
  let reply = output(
    { ok: false, error: { code, message: 'Synthetic authentication outcome.' } },
    1,
  )
  const service = new FreeInstances(
    home,
    async (_config, request) => {
      commands.push(request.command)
      if (request.command === 'chats') return output({ ok: true, chats: [] })
      if (request.command === 'usage') return output({ ok: true, available: true, windows: [] })
      return reply
    },
    runtime,
  )
  services.push(service)
  const instance = service.create({ provider: 'claude', name: 'Example account' })
  const lastSignedInAt = Date.now() - 6 * HOUR
  const usage: FreeUsage = {
    available: true,
    is_snapshot: false,
    observed_at: null,
    note: 'Synthetic quota reading',
    windows: [
      {
        id: 'five_hour',
        used_percent: 0,
        remaining_percent: 100,
        resets_at: new Date(lastSignedInAt).toISOString(),
        reset_passed: true,
      },
      {
        id: 'seven_day',
        used_percent: 10,
        remaining_percent: 90,
        resets_at: null,
        reset_passed: false,
      },
    ],
  }
  Object.assign(instance, {
    loggedIn: true,
    email: 'account@example.test',
    lastSignedInAt,
    checkedAt: lastSignedInAt,
    usageReadAt: lastSignedInAt,
    usage,
  })
  const store = (service as unknown as { store: FreeStorage }).store
  store.data.settings = settings
  const request = (): FreeRequest => ({
    requestId: crypto.randomUUID(),
    instanceId: instance.id,
    provider: 'claude',
    command: 'auth',
  })
  const saved = () =>
    JSON.parse(readFileSync(join(home, 'free', 'accounts.json'), 'utf8')).instances[0]
  return {
    service,
    instance,
    commands,
    request,
    saved,
    lastSignedInAt,
    usage,
    succeed: () => {
      reply = output({ ok: true, authenticated: true, account_email: 'account@example.test' })
    },
  }
}

async function check(f: ReturnType<typeof fixture>) {
  const job = f.service.start(f.request(), true)
  const deadline = Date.now() + 2000
  while (job.state !== 'done') {
    if (Date.now() >= deadline) throw new Error('Synthetic authentication check did not finish.')
    await Bun.sleep(2)
  }
  await f.service.settled()
  return job
}

for (const code of ['login_expired', 'login_required']) {
  test(`${code} ends automatic refresh and nudge eligibility while keeping the last sign-in`, async () => {
    const f = fixture(code)
    expect(nextRead([f.instance], () => false, Date.now())).toEqual({
      id: f.instance.id,
      command: 'usage',
    })
    expect(nudgeDue(f.instance, settings, Date.now())).toBe(true)
    const job = await check(f)
    expect(job.result?.error?.code).toBe(code)
    expect(f.instance.loggedIn).toBe(false)
    expect(f.instance.checkedAt).toBeGreaterThan(f.lastSignedInAt)
    expect(f.instance.lastSignedInAt).toBe(f.lastSignedInAt)
    expect(f.instance.email).toBe('account@example.test')
    expect(f.instance.usage).toBe(f.usage)
    expect(nextRead([f.instance], () => false, Date.now() + 24 * HOUR)).toBeNull()
    expect(nudgeDue(f.instance, settings, Date.now() + 24 * HOUR)).toBe(false)
    f.service.refreshNext()
    f.service.keepWindows()
    expect(f.commands).toEqual(['auth'])
    expect(f.service.status().jobs).toHaveLength(1)
    expect(f.saved()).toMatchObject({
      loggedIn: false,
      lastSignedInAt: f.lastSignedInAt,
      checkedAt: f.instance.checkedAt,
      email: 'account@example.test',
      usage: f.usage,
    })
  })
}

for (const code of ['network_error', 'http_verification_required', 'harness_failed']) {
  test(`${code} keeps signed-in metadata and future refresh eligibility`, async () => {
    const f = fixture(code)
    const job = await check(f)
    expect(job.result?.error?.code).toBe(code)
    expect(f.instance.loggedIn).toBe(true)
    expect(f.instance.lastSignedInAt).toBe(f.lastSignedInAt)
    expect(f.instance.checkedAt).toBeGreaterThan(f.lastSignedInAt)
    expect(f.instance.usage).toBe(f.usage)
    expect(nextRead([f.instance], () => false, Date.now() + 24 * HOUR)).not.toBeNull()
    expect(nudgeDue(f.instance, settings, Date.now())).toBe(true)
    expect(f.commands).toEqual(['auth'])
    expect(f.saved()).toMatchObject({
      loggedIn: true,
      lastSignedInAt: f.lastSignedInAt,
      checkedAt: f.instance.checkedAt,
      usage: f.usage,
    })
  })
}

test('an expired login can be checked successfully after its saved sign-in is renewed', async () => {
  const f = fixture('login_expired')
  await check(f)
  expect(f.instance.loggedIn).toBe(false)
  f.succeed()
  const job = await check(f)
  expect(job.result?.ok).toBe(true)
  expect(f.instance.loggedIn).toBe(true)
  expect(f.instance.lastSignedInAt).toBe(f.instance.checkedAt)
  expect(f.instance.lastSignedInAt).toBeGreaterThan(f.lastSignedInAt)
  expect(f.commands).toEqual(['auth', 'auth', 'chats', 'usage'])
  expect(f.saved()).toMatchObject({ loggedIn: true, lastSignedInAt: f.instance.checkedAt })
})
