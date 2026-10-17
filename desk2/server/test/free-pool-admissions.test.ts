import { afterEach, expect, spyOn, test } from 'bun:test'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { FreeInstance, FreeProvider, FreeRequest } from '../../shared/free-instances'
import type { ServerContext } from '../src/context'
import type { FreeRunRequest, RunOutput } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeError, FreeInstances } from '../src/free-instances/service'
import { FreeStorage } from '../src/free-instances/storage'
import { readLogin, writeLogin } from '../src/free-instances/sync'
import plugin from '../src/plugins/55-free-instances'

const native = test.skipIf(process.platform !== 'win32')
const fixtures: { home: string; service: FreeInstances }[] = []
const releases: (() => void)[] = []
const spies: { mockRestore(): void }[] = []
const output = (body: unknown, code = 0): RunOutput => ({ code, stdout: JSON.stringify(body) })
const CHAT = '11111111-2222-4333-8444-555555555555'

function gate() {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  releases.push(release)
  return { promise, release }
}
async function until(check: () => boolean) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Synthetic operation did not advance')
    await Bun.sleep(2)
  }
}

function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'free-pool-admission-'))
  const commands: Array<{ id: string; command: string }> = []
  let handler: ((r: FreeRunRequest) => Promise<RunOutput | undefined>) | undefined
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
  const service: FreeInstances = new FreeInstances(
    home,
    async (_config, request): Promise<RunOutput> => {
      commands.push({ id: request.instanceId, command: request.command })
      const custom = await handler?.(request)
      const row = service.allInstances().find((i) => i.id === request.instanceId)!
      const authProof = () => createHash('sha256').update(readFileSync(join(_config.stateDir, 'chatgpt', 'session.dpapi'))).digest('hex')
      if (custom) {
        if (request.command !== 'auth' || row.provider !== 'chatgpt') return custom
        const body = JSON.parse(custom.stdout)
        if (body.ok && body.authenticated && !Object.hasOwn(body, 'login_fingerprint')) body.login_fingerprint = authProof()
        return { ...custom, stdout: JSON.stringify(body) }
      }
      if (request.command === 'auth')
        return output({
          ok: true,
          authenticated: true,
          account_email: row.poolAdmission?.email ?? row.email,
          ...(row.provider === 'chatgpt' ? { login_fingerprint: authProof() } : {}),
        })
      if (request.command === 'usage')
        return output({
          ok: true,
          available: true,
          is_snapshot: false,
          plan: row.poolAdmission?.plan ?? row.plan,
          observed_at: new Date().toISOString(),
          checked_at: new Date().toISOString(),
          windows: [],
        })
      if (request.command === 'read')
        return output({ ok: true, is_temporary: true, chat_id: CHAT, messages: [] })
      throw new Error('Unexpected provider action in an offline pool fixture')
    },
    runtime,
  )
  const store = (service as unknown as { store: FreeStorage }).store
  const app = new Hono()
  plugin(app, {
    home,
    deps: { freeInstances: service },
    onStop: () => {},
    broadcast: () => {},
  } as unknown as ServerContext)
  const file = (row: FreeInstance) => service.syncHost().sessionFile(row)
  const login = (row: FreeInstance, marker = row.id) => {
    const domain = row.provider === 'chatgpt' ? '.chatgpt.com' : '.claude.ai'
    const names =
      row.provider === 'chatgpt'
        ? ['__Secure-next-auth.session-token', '_uasid', '_umsid']
        : ['sessionKey']
    expect(
      writeLogin(
        file(row),
        row.provider,
        names.map((name) => ({ name, value: `${name}-${marker}`, domain, path: '/', expires: -1 })),
      ),
    ).toBe(true)
  }
  const account = (email: string, plan = 'free', fields: Partial<FreeInstance> = {}) => {
    const row = service.create({ provider: fields.provider ?? 'chatgpt', name: 'Example account' })
    Object.assign(row, {
      email,
      plan,
      loggedIn: true,
      checkedAt: Date.now(),
      lastSignedInAt: Date.now(),
      ...fields,
    })
    login(row)
    return row
  }
  const stage = async (
    email: string,
    plan: 'free' | 'go' = 'free',
    limit = 40,
    instanceId?: string,
    provider: FreeProvider = 'chatgpt',
  ) => {
    const body = {
      requestId: randomUUID(),
      provider,
      email,
      plan,
      limit,
      ...(instanceId ? { instanceId } : {}),
    }
    const admission = await service.admitPool(body)
    login(admission.instance)
    return { ...admission, body }
  }
  const result = {
    home,
    service,
    store,
    app,
    commands,
    file,
    login,
    account,
    stage,
    handle: (fn?: typeof handler) => {
      handler = fn
    },
  }
  fixtures.push(result)
  return result
}

afterEach(async () => {
  for (const release of releases.splice(0)) release()
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const f of fixtures.splice(0)) {
    await f.service.settled()
    await f.service.stop()
    rmSync(f.home, { recursive: true, force: true })
  }
}, 30_000)

native('retiring an idle Free account durably releases its slot without touching its login', async () => {
  const f = fixture()
  const row = f.account('retire@example.test', 'free', { provider: 'claude', lastActiveAt: 123 })
  f.account('keep@example.test', 'free', { provider: 'claude' })
  const original = readFileSync(f.file(row))
  const url = `/api/free/pool/instances/${row.id}/retire`
  expect((await f.app.request(url, { method: 'POST', headers: { origin: 'https://example.test' } })).status).toBe(403)
  for (let retry = 0; retry < 2; retry++) {
    const response = await f.app.request(url, { method: 'POST' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true, id: row.id, retired: true, count: 1 })
  }
  expect(new FreeStorage(f.home).data.instances.find(i => i.id === row.id)?.poolState).toBe('retired')
  expect(row.loggedIn).toBe(true)
  expect(row.lastActiveAt).toBe(123)
  expect(readFileSync(f.file(row))).toEqual(original)
  expect(f.service.syncHost().busy(row.id)).toBe(true)
  expect(() => f.service.start({ requestId: randomUUID(), instanceId: row.id, provider: 'claude', command: 'chat', prompt: 'Synthetic request' })).toThrow('retired')
  f.service.refreshNext()
  expect(f.commands).toEqual([])
})

native('pool retirement refuses busy, pending, unverified and non-Free accounts', async () => {
  const f = fixture()
  for (const plan of ['go', 'plus', 'pro', 'unknown']) {
    const row = f.account(`${plan}@example.test`, plan)
    await expect(f.service.retirePool(row.id)).rejects.toMatchObject({ code: 'pool_changed' })
    expect(row.poolState).toBeUndefined()
  }
  const pending = await f.stage('pending@example.test')
  await expect(f.service.retirePool(pending.instance.id)).rejects.toMatchObject({ code: 'pool_pending' })
  const unverified = f.account('unverified@example.test', 'free', { loggedIn: false })
  await expect(f.service.retirePool(unverified.id)).rejects.toMatchObject({ code: 'pool_verification_failed' })
  const busy = f.account('busy@example.test')
  const hold = gate()
  f.handle(async r => { if (r.instanceId === busy.id) await hold.promise; return undefined })
  const job = f.service.start({ requestId: randomUUID(), instanceId: busy.id, provider: 'chatgpt', command: 'read', chatId: CHAT })
  await expect(f.service.retirePool(busy.id)).rejects.toMatchObject({ code: 'pool_busy' })
  expect(busy.poolState).toBeUndefined()
  hold.release()
  await until(() => job.state === 'done')
  await f.service.stop()
  await expect(f.service.retirePool(busy.id)).rejects.toMatchObject({ status: 503 })
})

native('failed retirement acknowledgement restores active metadata and preserves credentials', async () => {
  const f = fixture()
  const row = f.account('retire@example.test')
  const original = readFileSync(f.file(row))
  const save = f.store.saveDurable.bind(f.store)
  spies.push(spyOn(f.store, 'saveDurable').mockImplementationOnce(async () => { await save(); return false }))
  await expect(f.service.retirePool(row.id)).rejects.toMatchObject({ code: 'pool_persist_failed' })
  await f.service.settled()
  expect(row.poolState).toBeUndefined()
  expect(new FreeStorage(f.home).data.instances.find(i => i.id === row.id)?.poolState).toBeUndefined()
  expect(readFileSync(f.file(row))).toEqual(original)
  expect(f.commands).toEqual([])
  expect(await f.service.retirePool(row.id)).toMatchObject({ ok: true, retired: true, count: 0 })
})

native(
  'admission is durable, idempotent, provider-free and remains pending after restart',
  async () => {
    const f = fixture()
    const a = await f.stage('new@example.test')
    expect(f.commands).toEqual([])
    expect(a.instance.poolState).toBe('pending')
    expect((await f.service.admitPool(a.body)).instance.id).toBe(a.instance.id)
    expect(new FreeStorage(f.home).data.instances[0]?.poolState).toBe('pending')
    await expect(f.service.admitPool({ ...a.body, limit: 41 })).rejects.toMatchObject({
      code: 'pool_changed',
    })
    const op: FreeRequest = {
      requestId: randomUUID(),
      instanceId: a.instance.id,
      provider: 'chatgpt',
      command: 'auth',
    }
    expect(() => f.service.start(op)).toThrow('pending pool import')
    f.service.refreshNext()
    f.service.keepWindows()
    expect(f.commands).toEqual([])
    expect(f.service.syncHost().busy(a.instance.id)).toBe(true)
  },
)

native(
  'verified Go replaces idle Free copies at exactly 40 total slots and preserves their complete history',
  async () => {
    const f = fixture()
    const victim = f.account('old@example.test')
    const duplicate = f.account('OLD@example.test')
    const oldBytes = readFileSync(f.file(victim))
    for (let n = 1; n < 40; n++) f.account(`go${n}@example.test`, 'go')
    f.store.data.threads.push({
      id: `${victim.id}/${CHAT}`,
      instanceId: victim.id,
      provider: 'chatgpt',
      chatId: CHAT,
      title: 'Synthetic retained thread',
      status: 'done',
      createdAt: 1,
      updatedAt: 2,
      error: null,
    })
    f.store.data.tokens = { [victim.id]: { entries: [], total: { input: 3, output: 4 } } }
    const stats = {
      '2020-01-01': { [victim.id]: { 'gpt-example': { sent: 1, failed: 0, input: 3, output: 4 } } },
    } as NonNullable<typeof f.store.data.stats>
    f.store.data.stats = stats
    const a = await f.stage('incoming@example.test', 'go', 40)
    const receipt = await f.service.commitPool(a.requestId)
    expect(receipt).toEqual({
      ok: true,
      id: a.instance.id,
      existing: false,
      replaced: [victim.id, duplicate.id],
      count: 40,
      limit: 40,
    })
    expect(victim.poolState).toBe('retired')
    expect(duplicate.poolState).toBe('retired')
    expect(a.instance.poolState).toBeUndefined()
    expect(f.service.threads()).toHaveLength(1)
    expect(f.store.data.tokens[victim.id]?.total).toEqual({ input: 3, output: 4 })
    expect(f.store.data.stats).toBe(stats)
    expect(f.store.data.deleted ?? []).toEqual([])
    expect(readFileSync(f.file(victim))).toEqual(oldBytes)
    expect(
      f.service
        .syncHost()
        .list()
        .some((i) => i.id === victim.id),
    ).toBe(true)
    expect(f.service.syncHost().busy(victim.id)).toBe(true)
    const calls = f.commands.length
    expect(await f.service.commitPool(a.requestId)).toEqual(receipt)
    expect(f.commands).toHaveLength(calls)
    expect(f.commands.map((c) => c.command)).toEqual(['auth', 'usage'])
    await expect(f.service.abortPool(a.requestId)).rejects.toMatchObject({ code: 'pool_changed' })
  },
)

native(
  'a fresh Free replaces a dead Free in a vacancy, never healthy Free at capacity',
  async () => {
    const f = fixture()
    const dead = f.account('dead@example.test', 'free', { loggedIn: false })
    f.account('working@example.test')
    const a = await f.stage('incoming@example.test', 'free', 2)
    expect((await f.service.commitPool(a.requestId)).replaced).toEqual([dead.id])
    const full = await f.stage('full@example.test', 'free', 2)
    await expect(f.service.commitPool(full.requestId)).rejects.toMatchObject({
      code: 'pool_full',
      status: 409,
    })
    expect(full.instance.poolState).toBe('pending')
    expect(f.service.allInstances().filter((i) => !i.poolState && i.loggedIn)).toHaveLength(2)
  },
)

native('parallel verified admissions cannot exceed the limit or retire a Go account', async () => {
  const f = fixture()
  const a = await f.stage('first@example.test', 'go', 1)
  const b = await f.stage('second@example.test', 'go', 1)
  const results = await Promise.allSettled([
    f.service.commitPool(a.requestId),
    f.service.commitPool(b.requestId),
  ])
  expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
  expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)
  expect(f.service.allInstances().filter((i) => !i.poolState && i.loggedIn)).toHaveLength(1)
  expect(f.service.allInstances().filter((i) => i.poolState === 'retired')).toHaveLength(0)
  expect(results.find((r) => r.status === 'rejected')).toMatchObject({
    reason: { code: 'pool_full' },
  })
})

for (const [provider, plan] of [['claude', 'free'], ['chatgpt', 'free'], ['chatgpt', 'go']] as const) {
  for (const state of ['live', 'signed-out', 'retired'] as const) {
    native(`${provider} ${plan} ${state} renewal bypasses capacity without retiring anyone`, async () => {
      const f = fixture()
      const working = f.account('working@example.test', 'free', { provider })
      const dead = f.account('dead@example.test', 'free', { provider, loggedIn: false })
      const preserved = [working, dead].map(row => readFileSync(f.file(row)))
      const existing = f.account('renew@example.test', plan, {
        provider,
        ...(state === 'signed-out' ? { loggedIn: false } : {}),
        ...(state === 'retired' ? { poolState: 'retired' } : {}),
      })
      const a = await f.stage(existing.email!, plan, 0, existing.id, provider)
      expect(await f.service.commitPool(a.requestId)).toMatchObject({
        ok: true, id: existing.id, existing: true, replaced: [], count: 2, limit: 0,
      })
      expect(existing.loggedIn).toBe(true)
      expect(existing.poolState).toBeUndefined()
      expect(existing.plan).toBe(plan)
      expect(f.service.allInstances()).toHaveLength(3)
      for (const [index, row] of [working, dead].entries()) {
        expect(row.poolState).toBeUndefined()
        expect(readFileSync(f.file(row))).toEqual(preserved[index])
      }
    })
  }
}

native('uncapped renewal still verifies identity and refuses missing original metadata', async () => {
  const f = fixture()
  const existing = f.account('renew@example.test', 'free', { loggedIn: false })
  const working = f.account('working@example.test')
  const a = await f.stage(existing.email!, 'free', 0, existing.id)
  f.handle(async r => r.command === 'auth'
    ? output({ ok: true, authenticated: true, account_email: 'other@example.test' })
    : undefined)
  await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({ code: 'pool_verification_failed' })
  expect(existing.poolState).toBe('pending')
  expect(working.poolState).toBeUndefined()
  f.handle()
  delete existing.poolAdmission!.before
  await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({ code: 'pool_changed' })
  expect(existing.poolState).toBe('pending')
  expect(working.poolState).toBeUndefined()
})

native(
  'failed auth, mismatched identity, unknown plans, stale snapshots and missing browser markers cannot evict',
  async () => {
    const f = fixture()
    const victim = f.account('old@example.test')
    const a = await f.stage('incoming@example.test', 'go', 1)
    for (const body of [
      { ok: false, error: { code: 'login_required', message: 'Synthetic expired login' } },
      { ok: true, authenticated: false },
      { ok: true, authenticated: true, account_email: 'other@example.test' },
    ]) {
      f.handle(async (r) => (r.command === 'auth' ? output(body, body.ok ? 0 : 1) : undefined))
      await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({
        code: 'pool_verification_failed',
      })
      expect(victim.poolState).toBeUndefined()
    }
    for (const fields of [
      { plan: null },
      { plan: 'plus' },
      { is_snapshot: true },
      { available: false },
      { observed_at: '2000-01-01T00:00:00Z' },
      { observed_at: 'invalid' },
    ]) {
      f.handle(async (r) =>
        r.command === 'usage'
          ? output({
              ok: true,
              available: true,
              is_snapshot: false,
              observed_at: new Date().toISOString(),
              plan: 'go',
              windows: [],
              ...fields,
            })
          : undefined,
      )
      await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({
        code: 'pool_verification_failed',
      })
      expect(victim.poolState).toBeUndefined()
    }
    f.handle()
    expect(
      writeLogin(f.file(a.instance), 'chatgpt', [
        { name: '__Secure-next-auth.session-token', value: 'synthetic', expires: -1 },
      ]),
    ).toBe(true)
    await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({
      code: 'pool_verification_failed',
    })
    expect(a.instance.poolState).toBe('pending')
  },
)

native(
  'a failed acknowledgement restores safe pending metadata and the same UUID can resolve the commit',
  async () => {
    const f = fixture()
    const victim = f.account('old@example.test')
    const a = await f.stage('incoming@example.test', 'go', 1)
    const save = f.store.saveDurable.bind(f.store)
    const spy = spyOn(f.store, 'saveDurable').mockImplementationOnce(async () => {
      await save()
      return false
    })
    spies.push(spy)
    await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({
      code: 'pool_persist_failed',
    })
    await f.service.settled()
    expect(a.instance.poolState).toBe('pending')
    expect(victim.poolState).toBeUndefined()
    expect(
      new FreeStorage(f.home).data.instances.find((i) => i.id === a.instance.id)?.poolState,
    ).toBe('pending')
    expect(await f.service.commitPool(a.requestId)).toMatchObject({
      ok: true,
      replaced: [victim.id],
      count: 1,
    })
  },
)

native(
  'abort restores existing metadata and a new import retires without deleting its cookies or receipt',
  async () => {
    const f = fixture()
    const existing = f.account('existing@example.test', 'go', { lastActiveAt: 123 })
    const before = structuredClone(existing)
    const original = readFileSync(f.file(existing))
    const a = await f.stage(existing.email!, 'free', 40, existing.id)
    // The caller restores original bytes before requesting abort; the server never writes or logs out a login.
    const { writeFileSync } = await import('node:fs')
    writeFileSync(f.file(existing), original)
    await f.service.abortPool(a.requestId)
    const { poolAdmission, ...restored } = existing
    expect(restored).toEqual(before)
    expect(poolAdmission?.state).toBe('aborted')
    expect(readFileSync(f.file(existing))).toEqual(original)
    expect(await f.service.abortPool(a.requestId)).toMatchObject({ aborted: true })
    const b = await f.stage('new@example.test')
    await f.service.abortPool(b.requestId)
    expect(b.instance.poolState).toBe('retired')
    expect(readLogin(f.file(b.instance), 'chatgpt')).not.toBeNull()
    expect(f.store.data.deleted ?? []).toEqual([])
    expect(f.commands).toEqual([])
  },
)

native(
  'pending verification is visible to idle guards, joins retries and refuses concurrent abort or jobs',
  async () => {
    const f = fixture()
    const a = await f.stage('new@example.test')
    const hold = gate()
    f.handle(async (r) => {
      if (r.command === 'usage') await hold.promise
      return undefined
    })
    const first = f.service.commitPool(a.requestId)
    await until(() => f.commands.some((c) => c.command === 'usage'))
    expect(f.service.commitPool(a.requestId)).toBe(first)
    expect(f.service.status().jobs.some((j) => j.id === a.requestId && j.state === 'running')).toBe(
      true,
    )
    await expect(f.service.abortPool(a.requestId)).rejects.toMatchObject({ code: 'pool_busy' })
    expect(() =>
      f.service.start({
        requestId: randomUUID(),
        instanceId: a.instance.id,
        provider: 'chatgpt',
        command: 'auth',
      }),
    ).toThrow()
    hold.release()
    await first
    expect(f.commands.map((c) => c.command)).toEqual(['auth', 'usage'])
  },
)

native(
  'pool accepts same-account usage and final-auth cookie rotation with a bound saved-login proof',
  async () => {
    const f = fixture()
    const victim = f.account('old@example.test')
    const a = await f.stage('new@example.test', 'go', 1)
    let rotated = false
    f.handle(async (r) => {
      if (r.command === 'usage') {
        f.login(a.instance, 'first-rotation')
        rotated = true
      } else if (r.command === 'auth' && rotated) f.login(a.instance, 'second-rotation')
      return undefined
    })
    await expect(f.service.commitPool(a.requestId)).resolves.toMatchObject({ ok: true })
    expect(victim.poolState).toBe('retired')
    expect(a.instance.poolState).toBeUndefined()
    expect(f.commands.map((c) => c.command)).toEqual(['auth', 'usage', 'auth'])
  },
)

native('pool refuses missing, malformed or mismatched saved-login auth proofs', async () => {
  const f = fixture()
  const victim = f.account('old@example.test')
  const a = await f.stage('incoming@example.test', 'go', 1)
  for (const proof of [null, '', 'not-a-digest', '0'.repeat(64)]) {
    f.handle(async r => r.command === 'auth' ? output({ ok: true, authenticated: true,
      account_email: a.body.email, login_fingerprint: proof }) : undefined)
    await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({
      code: proof === '0'.repeat(64) ? 'pool_changed' : 'pool_verification_failed',
    })
    expect(victim.poolState).toBeUndefined()
    expect(a.instance.poolState).toBe('pending')
  }
})

native('pool refuses another identity after usage rotates its login', async () => {
  const f = fixture()
  const victim = f.account('old@example.test')
  const a = await f.stage('incoming@example.test', 'go', 1)
  let rotated = false
  f.handle(async r => {
    if (r.command === 'usage') { f.login(a.instance, 'rotated'); rotated = true }
    if (r.command === 'auth' && rotated) return output({ ok: true, authenticated: true, account_email: 'other@example.test' })
    return undefined
  })
  await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({ code: 'pool_verification_failed' })
  expect(victim.poolState).toBeUndefined()
  expect(a.instance.poolState).toBe('pending')
})

native('pool refuses an external write between locked auth proof and commit', async () => {
  const f = fixture()
  const victim = f.account('old@example.test')
  const a = await f.stage('incoming@example.test', 'go', 1)
  f.handle(async r => {
    if (r.command !== 'auth') return undefined
    const proof = createHash('sha256').update(readFileSync(f.file(a.instance))).digest('hex')
    f.login(a.instance, 'external-login-write')
    return output({ ok: true, authenticated: true, account_email: a.body.email, login_fingerprint: proof })
  })
  await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({ code: 'pool_changed' })
  expect(victim.poolState).toBeUndefined()
  expect(a.instance.poolState).toBe('pending')
})

native('pool refuses a login replaced after auth proof while entering the serialized commit', async () => {
  const f = fixture()
  const victim = f.account('old@example.test')
  const a = await f.stage('incoming@example.test', 'go', 1)
  const serial = f.service as unknown as { poolSerial<T>(work: () => Promise<T>): Promise<T> }
  const original = serial.poolSerial.bind(serial)
  spies.push(spyOn(serial, 'poolSerial').mockImplementation(<T>(work: () => Promise<T>): Promise<T> => {
    f.login(a.instance, 'post-proof-external-change')
    return original(work)
  }))
  await expect(f.service.commitPool(a.requestId)).rejects.toMatchObject({ code: 'pool_changed' })
  expect(victim.poolState).toBeUndefined()
  expect(a.instance.poolState).toBe('pending')
})

native(
  'fresh Claude plan proof is independent of unavailable or cached quota counters',
  async () => {
    const f = fixture()
    const a = await f.stage('claude@example.test', 'free', 60, undefined, 'claude')
    f.handle(async (r) =>
      r.command === 'usage'
        ? output({
            ok: true,
            available: false,
            is_snapshot: true,
            observed_at: null,
            checked_at: new Date().toISOString(),
            plan: 'free',
            windows: [],
          })
        : undefined,
    )
    expect(await f.service.commitPool(a.requestId)).toMatchObject({ ok: true, count: 1, limit: 60 })
    expect(a.instance.usage).toMatchObject({
      available: false,
      is_snapshot: true,
      observed_at: null,
      plan: 'free',
    })
  },
)

native(
  'pool routes keep origin validation, strict inputs, versioning and typed capacity errors',
  async () => {
    const f = fixture()
    expect(await (await f.app.request('/api/free/pool')).json()).toEqual({ version: 1 })
    const body = {
      requestId: randomUUID(),
      provider: 'chatgpt',
      email: 'new@example.test',
      plan: 'free',
      limit: 0,
    }
    const request = (value: unknown, headers: Record<string, string> = {}) =>
      f.app.request('/api/free/pool/admissions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify(value),
      })
    expect((await request(body, { origin: 'https://example.test' })).status).toBe(403)
    for (const changed of [
      { limit: 501 },
      { limit: -1 },
      { limit: 1.5 },
      { provider: 'claude', plan: 'go' },
      { email: 'invalid' },
      { requestId: 'bad' },
      { extra: true },
    ])
      expect((await request({ ...body, ...changed })).status).toBe(400)
    const response = await request(body)
    expect(response.status).toBe(201)
    const staged = (await response.json()) as { instance: FreeInstance }
    const row = f.service.allInstances().find((i) => i.id === staged.instance.id)!
    f.login(row)
    const refused = await f.app.request(`/api/free/pool/admissions/${body.requestId}/commit`, {
      method: 'POST',
    })
    expect(refused.status).toBe(409)
    expect(await refused.json()).toMatchObject({ code: 'pool_full' })
    const aborted = await f.app.request(`/api/free/pool/admissions/${body.requestId}/abort`, {
      method: 'POST',
    })
    expect(await aborted.json()).toMatchObject({ ok: true, aborted: true, id: row.id })
  },
)
