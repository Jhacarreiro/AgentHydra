import { afterEach, expect, spyOn, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { FreeRequest, FreeUsage } from '../../shared/free-instances'
import type { FreeRunner, RunOutput } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'
import { FreeStorage } from '../src/free-instances/storage'

const CHAT = '11111111-2222-4333-8444-555555555555'
const dirs: string[] = []
const services: FreeInstances[] = []
const cleanupGates: (() => void)[] = []
const spies: { mockRestore(): void }[] = []
const output = (body: unknown, code = 0): RunOutput => ({ code, stdout: JSON.stringify(body) })
const usage: FreeUsage = { available: true, is_snapshot: false,
  observed_at: '2020-10-06T12:00:00Z', note: 'Synthetic quota reading', plan: 'free',
  windows: [{ id: 'five_hour', used_percent: 20, remaining_percent: 80,
    resets_at: '2020-10-06T17:00:00Z', reset_passed: false }] }

function gate<T>(fallback: T) {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  cleanupGates.push(() => release(fallback))
  return { promise, release }
}

async function until(check: () => boolean): Promise<void> {
  const until = Date.now() + 2000
  while (!check()) {
    if (Date.now() > until) throw new Error('Synthetic job did not settle.')
    await Bun.sleep(2)
  }
}

async function fixture(runner: FreeRunner) {
  const home = mkdtempSync(join(tmpdir(), 'free-save-count-'))
  dirs.push(home)
  const runtime: FreeRuntime = { ready: () => true, ensure: async () => {},
    config: id => ({ harnessDir: home, python: join(home, 'unused-python.exe'),
      stateDir: join(home, 'free', 'instances', id), cacheDir: join(home, 'cache') }) }
  const service = new FreeInstances(home, runner, runtime)
  services.push(service)
  const instance = service.create({ provider: 'claude', name: 'Example account' })
  await service.settled()
  const store = (service as unknown as { store: FreeStorage }).store
  const saves = spyOn(store, 'save')
  spies.push(saves)
  const op = (fields: Partial<FreeRequest> = {}): FreeRequest => ({ requestId: crypto.randomUUID(),
    instanceId: instance.id, provider: 'claude', command: 'auth', ...fields })
  const saved = (backup = false) => JSON.parse(readFileSync(join(home, 'free', `accounts.json${backup ? '.bak' : ''}`), 'utf8'))
  // Let this operation's final save exercise the normal due-backup path as well.
  const backupDue = () => { (store as unknown as { backedUpAt: number }).backedUpAt = 0 }
  return { home, service, instance, store, saves, op, saved, backupDue }
}

afterEach(async () => {
  for (const release of cleanupGates.splice(0)) release()
  await Promise.all(services.splice(0).map(async service => { await service.settled(); await service.stop() }))
  for (const spy of spies.splice(0)) spy.mockRestore()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
}, 30_000)

test('auth keeps its chat checkpoint before the usage await and saves the final reading once', async () => {
  const reading = gate(output({ ok: true, ...usage }))
  let readingStarted = false
  const commands: string[] = []
  const f = await fixture(async (_config, request) => {
    commands.push(request.command)
    if (request.command === 'auth') return output({ ok: true, authenticated: true,
      account_email: 'account@example.test', account_label: 'Example account' })
    if (request.command === 'chats') return output({ ok: true, chats: [{ chat_id: CHAT,
      name: 'Synthetic private chat', is_temporary: true, created_at: '2020-10-06T12:00:00Z' }] })
    readingStarted = true
    return reading.promise
  })
  const job = f.service.start(f.op())
  await until(() => readingStarted)
  await f.service.settled()
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(job.state).toBe('running')
  const checkpoint = f.saved()
  expect(checkpoint.instances[0]).toMatchObject({ id: f.instance.id, loggedIn: true,
    email: 'account@example.test', usage: null })
  expect(checkpoint.instances[0].lastSignedInAt).toBeNumber()
  expect(checkpoint.threads).toHaveLength(1)
  expect(checkpoint.threads[0]).toMatchObject({ instanceId: f.instance.id, chatId: CHAT,
    title: 'Synthetic private chat', status: 'done' })
  f.backupDue()
  reading.release(output({ ok: true, ...usage }))
  await until(() => job.state === 'done')
  await f.service.stop()
  expect(f.saves).toHaveBeenCalledTimes(2)
  expect(commands).toEqual(['auth', 'chats', 'usage'])
  const final = f.saved()
  expect(final.instances[0]).toMatchObject({ loggedIn: true, email: 'account@example.test', usage })
  expect(final.instances[0].usageReadAt).toBeNumber()
  expect(final.threads).toEqual(checkpoint.threads)
  expect(f.saved(true)).toEqual(final)
  expect(new FreeStorage(f.home).data.instances[0]?.usage).toEqual({ ...usage, unlimited_text: false })
  expect(f.service.get(job.id).result).toMatchObject({ ok: true, authenticated: true })
}, 30_000)

test('a failed final usage reading still persists the successful auth checkpoint on shutdown', async () => {
  const f = await fixture(async (_config, request) => {
    if (request.command === 'auth') return output({ ok: true, authenticated: true,
      account_email: 'account@example.test' })
    if (request.command === 'chats') return output({ ok: true, chats: [{ chat_id: CHAT,
      name: 'Synthetic retained chat', is_temporary: true }] })
    return output({ ok: false, error: { code: 'network_error', message: 'Synthetic read failure' } }, 1)
  })
  const job = f.service.start(f.op())
  await until(() => job.state === 'done')
  await f.service.stop()
  expect(f.saves).toHaveBeenCalledTimes(2)
  expect(f.saved().instances[0]).toMatchObject({ loggedIn: true,
    email: 'account@example.test', usage: null })
  expect(f.saved().instances[0].usageReadAt).toBeNumber()
  expect(new FreeStorage(f.home).data.threads[0]).toMatchObject({ chatId: CHAT, status: 'done' })
  expect(f.service.get(job.id).result).toMatchObject({ ok: true, authenticated: true })
}, 30_000)

test('nudge records its quota and nudge outcome in one final save including the backup', async () => {
  const reading = gate(output({ ok: true, ...usage }))
  let readingStarted = false
  const commands: string[] = []
  const f = await fixture(async (_config, request) => {
    commands.push(request.command)
    if (request.command === 'nudge') return output({ ok: true })
    readingStarted = true
    return reading.promise
  })
  const job = f.service.start(f.op({ command: 'nudge' }))
  await until(() => readingStarted)
  expect(job.state).toBe('running')
  expect(f.saves).toHaveBeenCalledTimes(0)
  f.backupDue()
  reading.release(output({ ok: true, ...usage }))
  await until(() => job.state === 'done')
  await f.service.stop()
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(commands).toEqual(['nudge', 'usage'])
  const saved = f.saved()
  expect(saved.instances[0]).toMatchObject({ usage, nudge: { ok: true } })
  expect(saved.instances[0].nudge.at).toBeNumber()
  expect(saved.instances[0].usageReadAt).toBeNumber()
  expect(f.saved(true)).toEqual(saved)
  expect(new FreeStorage(f.home).data.instances[0]?.nudge).toEqual(saved.instances[0].nudge)
}, 30_000)

test('shutdown cancellation saves recovery IDs and failed thread state once after the start checkpoint', async () => {
  let started = false
  let calls = 0
  const f = await fixture(async (_config, _request, signal) => {
    calls++
    started = true
    return new Promise<RunOutput>((_resolve, reject) => signal.addEventListener('abort',
      () => reject(new Error('Synthetic cancellation')), { once: true }))
  })
  const job = f.service.start(f.op({ command: 'resume', chatId: CHAT, prompt: 'Synthetic input' }))
  await until(() => started)
  await f.service.settled()
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(f.saved().threads[0]).toMatchObject({ chatId: CHAT, status: 'running' })
  f.backupDue()
  await f.service.stop()
  expect(f.saves).toHaveBeenCalledTimes(2)
  expect(calls).toBe(1)
  const error = 'The operation was interrupted. Refresh the chat list and read the chat before sending again.'
  expect(f.service.get(job.id)).toMatchObject({ id: job.id, chatId: CHAT, state: 'done',
    result: { ok: false, error: { code: 'operation_interrupted', message: error, chat_id: CHAT } } })
  const saved = f.saved()
  expect(saved.threads[0]).toMatchObject({ id: `${f.instance.id}/${CHAT}`,
    instanceId: f.instance.id, chatId: CHAT, status: 'failed', error })
  expect(f.saved(true)).toEqual(saved)
  expect(new FreeStorage(f.home).data.threads[0]).toMatchObject({ chatId: CHAT, status: 'failed', error })
  expect(saved.tokens ?? {}).toEqual({})
  expect(saved.stats ?? {}).toEqual({})
}, 30_000)

test('an ordinary new chat keeps its existing single completion save and persisted accounting', async () => {
  let calls = 0
  const f = await fixture(async () => {
    calls++
    return output({ ok: true, chat_id: CHAT, is_temporary: true, response: 'Synthetic reply', model: 'haiku' })
  })
  f.backupDue()
  const job = f.service.start(f.op({ command: 'chat', prompt: 'Synthetic input' }))
  await until(() => job.state === 'done')
  await f.service.stop()
  expect(f.saves).toHaveBeenCalledTimes(1)
  expect(calls).toBe(1)
  expect(f.service.get(job.id).result).toMatchObject({ ok: true, chat_id: CHAT, response: 'Synthetic reply' })
  const saved = f.saved()
  expect(saved.threads[0]).toMatchObject({ chatId: CHAT, status: 'done', error: null })
  expect(saved.tokens[f.instance.id].total).toEqual({ input: 4, output: 4 })
  expect(Object.values(saved.stats)).toHaveLength(1)
  expect(f.saved(true)).toEqual(saved)
  expect(new FreeStorage(f.home).data.tokens?.[f.instance.id]?.total).toEqual({ input: 4, output: 4 })
}, 30_000)
