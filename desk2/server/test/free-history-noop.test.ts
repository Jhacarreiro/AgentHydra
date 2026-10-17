import { afterEach, describe, expect, jest, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import type { FreeRequest, FreeResult, FreeThread } from '../../shared/free-instances'
import type { ServerContext } from '../src/context'
import type { FreeRunner } from '../src/free-instances/runner'
import type { FreeRuntime } from '../src/free-instances/runtime'
import { FreeInstances } from '../src/free-instances/service'
import type { FreeStorage } from '../src/free-instances/storage'
import plugin from '../src/plugins/55-free-instances'

const homes: string[] = []
const services: FreeInstances[] = []
const CHAT = '11111111-2222-4333-8444-555555555555'
const SERVER = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const AT = Date.UTC(2026, 0, 1)

afterEach(async () => {
  jest.restoreAllMocks()
  await Promise.all(services.splice(0).map((service) => service.stop()))
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

type Internals = {
  store: FreeStorage
  noteThread(
    request: FreeRequest,
    status: FreeThread['status'],
    chatId: string,
    error: string | null,
    serverId?: string,
    title?: string,
    createdAt?: number,
    used?: boolean,
  ): boolean
  apply(request: FreeRequest, result: FreeResult): unknown
}

function fixture(
  runner: FreeRunner = async () => {
    throw new Error('No provider operation was requested')
  },
) {
  const home = mkdtempSync(join(tmpdir(), 'free-history-noop-'))
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
  const service = new FreeInstances(home, runner, runtime)
  services.push(service)
  const instance = service.create({ provider: 'chatgpt', name: 'Example account' })
  const internal = service as unknown as Internals
  const app = new Hono()
  plugin(app, {
    home,
    deps: { freeInstances: service },
    onStop: () => {},
    broadcast: () => {},
  } as unknown as ServerContext)
  const request = (values: Partial<FreeRequest> = {}): FreeRequest => ({
    requestId: crypto.randomUUID(),
    instanceId: instance.id,
    provider: 'chatgpt',
    command: 'auth',
    ...values,
  })
  return { home, service, internal, instance, app, request }
}

function row(instanceId: string, chatId = CHAT): FreeThread {
  return {
    id: `${instanceId}/${chatId}`,
    instanceId,
    provider: 'chatgpt',
    chatId,
    title: 'Synthetic conversation',
    status: 'done',
    error: null,
    createdAt: AT,
    updatedAt: AT,
    serverId: SERVER,
    contextChars: 20,
  }
}

async function finish(service: FreeInstances, request: FreeRequest): Promise<void> {
  const job = service.start(request, true)
  while (job.state !== 'done') await new Promise((resolve) => setTimeout(resolve, 0))
  expect(job.result?.ok).toBe(true)
  await service.settled()
}

describe('Free history passive-list validators', () => {
  test('repeated rolling auth retains a 37595-row validator while login and usage still persist', async () => {
    let now = AT + 1000
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const calls: string[] = []
    let chats: NonNullable<FreeResult['chats']> = []
    const { home, service, internal, instance, app, request } = fixture(
      async (_config, operation) => {
        calls.push(operation.command)
        const value =
          operation.command === 'auth'
            ? { ok: true, authenticated: true, account_email: 'owner@example.test' }
            : operation.command === 'chats'
              ? { ok: true, chats }
              : {
                  ok: true,
                  available: true,
                  unlimited_text: true,
                  plan: 'free',
                  observed_at: new Date(now).toISOString(),
                  windows: [],
                }
        return { code: 0, stdout: JSON.stringify(value) }
      },
    )
    let loginChanges = 0
    service.onLoginChange = () => {
      loginChanges++
    }
    const threads = Array.from({ length: 37_595 }, (_, n) => {
      const chatId = `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`
      const owner =
        n % 110 === 0
          ? instance.id
          : `ffffffff-ffff-4fff-8fff-${(n % 110).toString(16).padStart(12, '0')}`
      return { ...row(owner, chatId), title: `Synthetic conversation ${n} ${'.'.repeat(100)}` }
    })
    internal.store.data.threads = threads
    chats = threads
      .filter((thread) => thread.instanceId === instance.id)
      .map((thread) => ({
        chat_id: thread.chatId,
        name: thread.title,
        is_temporary: true,
        status: 'available',
        server_conversation_id: thread.serverId,
        created_at: new Date(AT).toISOString(),
      }))
    const first = await app.request('/api/free/threads')
    const tag = first.headers.get('ETag')!
    expect((await first.text()).length).toBeGreaterThan(10_000_000)
    const before = { ...threads[0]! }
    await finish(service, request())
    now += 60_000
    await finish(service, request())
    expect(service.threadsETag()).toBe(tag)
    expect(service.threads()).toBe(threads)
    expect(threads[0]).toEqual(before)
    expect(calls).toEqual(['auth', 'chats', 'usage', 'auth', 'chats', 'usage'])
    expect(loginChanges).toBe(2)
    const unchanged = await app.request('/api/free/threads', { headers: { 'If-None-Match': tag } })
    expect(unchanged.status).toBe(304)
    expect(await unchanged.text()).toBe('')
    const saved = JSON.parse(readFileSync(join(home, 'free', 'accounts.json'), 'utf8'))
    expect(saved.instances[0].checkedAt).toBe(now)
    expect(saved.instances[0].lastSignedInAt).toBe(now)
    expect(saved.instances[0].usageReadAt).toBe(now)
    expect(saved.instances[0].usage.observed_at).toBe(new Date(now).toISOString())
    expect(saved.threads).toHaveLength(37_595)
    expect(saved.threads[0]).toEqual(before)
  }, 15_000)

  test('passive insertion, status, error, server identity and title mutations each invalidate', () => {
    const { service, internal, instance, request } = fixture()
    const operation = request({ command: 'chats' })
    const note = (
      status: FreeThread['status'],
      error: string | null,
      serverId?: string,
      title?: string,
      chatId = CHAT,
    ) => internal.noteThread(operation, status, chatId, error, serverId, title, AT, false)
    let tag = service.threadsETag()
    const changed = () => {
      expect(service.threadsETag()).not.toBe(tag)
      tag = service.threadsETag()
    }
    expect(note('done', null, SERVER, 'Synthetic conversation')).toBe(true)
    changed()
    const existing = service.threads()[0]!
    expect(existing.instanceId).toBe(instance.id)
    expect(note('done', null, SERVER, 'Synthetic conversation')).toBe(true)
    expect(service.threadsETag()).toBe(tag)
    note('running', null, SERVER, existing.title)
    changed()
    note('running', 'Synthetic failure', SERVER, existing.title)
    changed()
    note('running', 'Synthetic failure', CHAT, existing.title)
    changed()
    note('running', 'Synthetic failure', CHAT, 'Changed synthetic title')
    changed()
    expect(note('running', 'Synthetic failure', '', '')).toBe(true)
    expect(service.threadsETag()).toBe(tag)
    expect(existing.serverId).toBe(CHAT)
    expect(existing.title).toBe('Changed synthetic title')
    expect(existing.createdAt).toBe(AT)
    expect(existing.updatedAt).toBe(AT)
  })

  test('used operations preserve invalidation for later context accounting and update last use', async () => {
    let now = AT
    jest.spyOn(Date, 'now').mockImplementation(() => now)
    const { service, internal, instance, request } = fixture()
    const thread = row(instance.id)
    internal.store.data.threads.push(thread)
    let tag = service.threadsETag()
    // A same-clock read can change only contextChars after noteThread returns.
    internal.apply(request({ command: 'read', chatId: CHAT }), {
      ok: true,
      chat_id: CHAT,
      is_temporary: true,
      messages: [
        {
          id: 'synthetic-message',
          role: 'assistant',
          text: 'Synthetic response',
          code_blocks: [],
          citations: [],
        },
      ],
    })
    expect(service.threadsETag()).not.toBe(tag)
    expect(thread.updatedAt).toBe(AT)
    expect(thread.contextChars).toBe('Synthetic response'.length)
    tag = service.threadsETag()
    now += 1000
    internal.apply(request({ command: 'resume', chatId: CHAT, prompt: 'Synthetic followup' }), {
      ok: true,
      chat_id: CHAT,
      is_temporary: true,
      response: 'Synthetic reply',
    })
    expect(service.threadsETag()).not.toBe(tag)
    expect(thread.updatedAt).toBe(now)
    expect(thread.contextChars).toBe('Synthetic responseSynthetic followupSynthetic reply'.length)
    await service.settled()
  })
})
