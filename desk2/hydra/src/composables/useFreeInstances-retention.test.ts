import { afterEach, beforeEach, expect, spyOn, test } from 'bun:test'
import { toRaw } from 'vue'
import type { FreeInstance, FreeJob, FreeRequest, FreeResult, FreeStatus } from '@desk/shared/free-instances'
import { FreeApiError, freeApi, rememberedJob } from '@/lib/free-instances'
import { useFreeInstances } from './useFreeInstances'

const realSessionStorage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage')
const spies: { mockRestore(): unknown }[] = []
const pending: Promise<unknown>[] = []
const releaseGates: (() => void)[] = []
const owned = new Set<string>()
let storage: Map<string, string>

beforeEach(() => {
  storage = new Map()
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } })
})

afterEach(async () => {
  for (const release of releaseGates.splice(0)) release()
  await Promise.allSettled(pending.splice(0))
  const free = useFreeInstances()
  for (const id of owned) { delete free.jobs[id]; delete free.errors[id] }
  free.instances.value = free.instances.value.filter(instance => !owned.has(instance.id))
  free.threads.value = free.threads.value.filter(thread => !owned.has(thread.instanceId))
  owned.clear()
  for (const spy of spies.splice(0)) spy.mockRestore()
  if (realSessionStorage) Object.defineProperty(globalThis, 'sessionStorage', realSessionStorage)
  else delete (globalThis as { sessionStorage?: Storage }).sessionStorage
}, 30_000)

function track<T>(operation: Promise<T>): Promise<T> {
  pending.push(operation)
  return operation
}

function gate<T>(fallback: T) {
  let release!: (value: T) => void
  const promise = new Promise<T>(resolve => { release = resolve })
  releaseGates.push(() => release(fallback))
  return { promise, release }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Synthetic client operation did not advance.')
    await Bun.sleep(2)
  }
}

function fixture() {
  const free = useFreeInstances()
  const accounts: FreeInstance[] = [1, 2].map(num => ({ id: crypto.randomUUID(), num,
    provider: 'chatgpt', name: `Example account ${num}`, autoName: false,
    loggedIn: true, checkedAt: 1, lastSignedInAt: 1, lastActiveAt: null, usage: null }))
  for (const account of accounts) owned.add(account.id)
  const instance = accounts[0]!
  const bystander = accounts[1]!
  const result: FreeResult = { ok: true, chat_id: crypto.randomUUID(), is_temporary: true,
    response: 'Synthetic reply', messages: [{ id: 'synthetic-message', role: 'assistant',
      text: 'Synthetic retained transcript\n'.repeat(20_000),
      code_blocks: [{ language: 'text', code: 'Synthetic code' }],
      citations: [{ title: 'Example source', url: 'https://example.test/source' }] }],
    warnings: ['Synthetic preserved warning'], incomplete: false }
  const jobs = new Map<string, FreeJob>()
  const completed = (request: FreeRequest, value = result): FreeJob => ({ id: request.requestId,
    instanceId: request.instanceId, provider: request.provider, command: request.command,
    state: 'done', phase: 'working', startedAt: 1, finishedAt: 2,
    chatId: value.chat_id ?? value.error?.chat_id ?? request.chatId, result: value })
  const start = spyOn(freeApi, 'start').mockImplementation(async request => {
    const job = completed(request)
    jobs.set(job.id, job)
    return job
  })
  const read = spyOn(freeApi, 'job').mockImplementation(async id => {
    const job = jobs.get(id)
    if (!job) throw new FreeApiError('Synthetic operation missing', 404)
    return job
  })
  const status = spyOn(freeApi, 'status').mockImplementation(async () => ({
    ready: true, instances: accounts, running: 0, threadCounts: {}, jobs: [], tokens: {}, health: {},
  }))
  const history = spyOn(freeApi, 'changedThreads').mockResolvedValue({ threads: [], version: null })
  const remove = spyOn(freeApi, 'remove').mockResolvedValue({ ok: true })
  spies.push(start, read, status, history, remove)
  return { free, instance, bystander, accounts, result, jobs, completed, start, read, status, remove }
}

test('completed replies go unchanged to the caller while the shared cache keeps only recovery metadata', async () => {
  const f = fixture()
  const result = await track(f.free.run(f.instance, 'chat', { prompt: 'Synthetic input' }))
  expect(result).toBe(f.result)
  expect(result!.messages![0]!.text).toHaveLength('Synthetic retained transcript\n'.length * 20_000)
  expect(result!.messages![0]!.code_blocks).toEqual([{ language: 'text', code: 'Synthetic code' }])
  expect(result!.warnings).toEqual(['Synthetic preserved warning'])
  const request = f.start.mock.calls[0]![0]!
  const original = f.jobs.get(request.requestId)!
  const { result: _result, ...metadata } = original
  expect(toRaw(f.free.jobs[f.instance.id])).toEqual(metadata)
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
  expect(f.free.busy(f.instance.id)).toBe(false)
  expect(rememberedJob(f.instance.id)).toBeNull()
  expect(original.result).toBe(f.result)
  // A caller retaining or updating its own transcript never changes cached job metadata.
  result!.messages![0]!.text = 'Synthetic caller-owned view'
  expect(f.free.jobs[f.instance.id]!.chatId).toBe(f.result.chat_id)
  expect(f.start).toHaveBeenCalledTimes(1)
})

test('recovery reads the saved job ID and returns the full result without another POST', async () => {
  const f = fixture()
  await track(f.free.run(f.instance, 'chat', { prompt: 'Synthetic input' }))
  const id = f.free.jobs[f.instance.id]!.id
  const recovered = await track(f.free.recover(f.instance.id))
  expect(recovered).toBe(f.result)
  expect(f.read).toHaveBeenCalledTimes(1)
  expect(f.read).toHaveBeenCalledWith(id)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(f.free.jobs[f.instance.id]).toMatchObject({ id, state: 'done', chatId: f.result.chat_id })
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
})

test('failed results retain their error and chat recovery ID without retaining the result graph', async () => {
  const f = fixture()
  const failure: FreeResult = { ok: false, error: { code: 'operation_unconfirmed',
    message: 'Synthetic unknown outcome; read before sending again.', chat_id: f.result.chat_id } }
  f.start.mockImplementation(async request => {
    const job = f.completed(request, failure)
    f.jobs.set(job.id, job)
    return job
  })
  expect(await track(f.free.run(f.instance, 'resume', { chatId: f.result.chat_id, prompt: 'Synthetic continuation' }))).toBe(failure)
  expect(f.free.errors[f.instance.id]).toBe(failure.error!.message)
  expect(f.free.jobs[f.instance.id]).toMatchObject({ state: 'done', chatId: failure.error!.chat_id })
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
  expect(f.start).toHaveBeenCalledTimes(1)
})

test('an unknown start outcome keeps its busy state and IDs until read-only recovery succeeds', async () => {
  const f = fixture()
  f.start.mockRejectedValue(new DOMException('Synthetic lost acknowledgement', 'TimeoutError'))
  f.read.mockRejectedValue(new Error('Synthetic offline read'))
  expect(await track(f.free.run(f.instance, 'chat', { prompt: 'Synthetic input' }))).toBeNull()
  const request = f.start.mock.calls[0]![0]!
  expect(f.free.busy(f.instance.id)).toBe(true)
  expect(f.free.jobs[f.instance.id]).toMatchObject({ id: request.requestId, state: 'running' })
  expect(rememberedJob(f.instance.id)).toBe(request.requestId)
  expect(await track(f.free.remove(f.instance))).toBe(false)
  expect(f.remove).toHaveBeenCalledTimes(0)
  const done = f.completed(request)
  f.read.mockResolvedValue(done)
  expect(await track(f.free.recover(f.instance.id))).toBe(f.result)
  expect(f.free.busy(f.instance.id)).toBe(false)
  expect(f.free.errors[f.instance.id]).toBe('')
  expect(f.free.jobs[f.instance.id]!.id).toBe(request.requestId)
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
  expect(f.start).toHaveBeenCalledTimes(1)
})

test('active results stay intact until completion, which releases the cache before the snapshot wait', async () => {
  const f = fixture()
  const snapshot: FreeStatus = { ready: true, instances: f.accounts, running: 0, threadCounts: {}, jobs: [] }
  const refresh = gate(snapshot)
  const reading = gate<FreeJob>({ id: 'synthetic-fallback', instanceId: f.instance.id,
    provider: 'chatgpt', command: 'chat', state: 'done', phase: 'working', startedAt: 1, result: f.result })
  let completed!: FreeJob
  f.status.mockImplementation(() => refresh.promise)
  f.read.mockImplementation(() => reading.promise)
  f.start.mockImplementation(async request => {
    const done = f.completed(request)
    completed = done
    f.jobs.set(done.id, done)
    return { ...done, state: 'running', finishedAt: undefined }
  })
  let settled = false
  const sending = track(f.free.run(f.instance, 'chat', { prompt: 'Synthetic input' }).then(result => {
    settled = true
    return result
  }))
  await until(() => f.free.jobs[f.instance.id]?.phase === 'working')
  expect(f.free.busy(f.instance.id)).toBe(true)
  expect(toRaw(f.free.jobs[f.instance.id]!.result)).toBe(f.result)
  expect(await track(f.free.remove(f.instance))).toBe(false)
  expect(f.remove).toHaveBeenCalledTimes(0)
  await until(() => f.read.mock.calls.length === 1)
  expect(f.free.busy(f.instance.id)).toBe(true)
  expect(f.free.jobs[f.instance.id]!.id).toBe(completed.id)
  expect(toRaw(f.free.jobs[f.instance.id]!.result)).toBe(f.result)
  reading.release(completed)
  await until(() => f.status.mock.calls.length === 1)
  expect(settled).toBe(false)
  expect(f.free.jobs[f.instance.id]!.state).toBe('done')
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
  expect(f.read).toHaveBeenCalledTimes(1)
  refresh.release(snapshot)
  expect(await sending).toBe(f.result)
  expect(f.start).toHaveBeenCalledTimes(1)
}, 10_000)

test('successful removal clears only that account cache and leaves a pending bystander intact', async () => {
  const f = fixture()
  const completed: FreeJob = { id: crypto.randomUUID(), instanceId: f.instance.id,
    provider: 'chatgpt', command: 'read', state: 'done', phase: 'working', startedAt: 1, result: f.result }
  const running: FreeJob = { ...completed, id: crypto.randomUUID(), instanceId: f.bystander.id, state: 'running' }
  f.free.jobs[f.instance.id] = completed
  f.free.jobs[f.bystander.id] = running
  f.free.errors[f.instance.id] = 'Synthetic old note'
  f.free.errors[f.bystander.id] = 'Synthetic pending note'
  rememberedJob(f.instance.id, completed.id)
  rememberedJob(f.bystander.id, running.id)
  f.free.instances.value = f.accounts
  f.free.threads.value = f.accounts.map(instance => ({ id: `${instance.id}/synthetic-chat`,
    instanceId: instance.id, provider: instance.provider, chatId: 'synthetic-chat',
    title: 'Synthetic history', createdAt: 1, updatedAt: 1, status: 'done', error: null }))
  expect(await track(f.free.remove(f.instance))).toBe(true)
  expect(f.free.jobs[f.instance.id]).toBeUndefined()
  expect(f.free.errors[f.instance.id]).toBeUndefined()
  expect(rememberedJob(f.instance.id)).toBeNull()
  expect(toRaw(f.free.jobs[f.bystander.id])).toBe(running)
  expect(f.free.errors[f.bystander.id]).toBe('Synthetic pending note')
  expect(rememberedJob(f.bystander.id)).toBe(running.id)
  expect(f.free.instances.value.map(instance => instance.id)).toEqual([f.bystander.id])
  expect(f.free.threads.value.map(thread => thread.instanceId)).toEqual([f.bystander.id])
  expect(await track(f.free.remove(f.bystander))).toBe(false)
  expect(f.remove).toHaveBeenCalledTimes(1)
  expect(f.remove).toHaveBeenCalledWith(f.instance.id)
})

test.each([new FreeApiError('Synthetic operation busy', 409), new DOMException('Synthetic uncertain deletion', 'TimeoutError')])(
  'a refused or uncertain removal keeps recovery IDs and cached state: %s', async error => {
    const f = fixture()
    const job: FreeJob = { id: crypto.randomUUID(), instanceId: f.instance.id, provider: 'chatgpt',
      command: 'read', state: 'done', phase: 'working', startedAt: 1, chatId: f.result.chat_id }
    f.free.jobs[f.instance.id] = job
    rememberedJob(f.instance.id, job.id)
    f.remove.mockRejectedValue(error)
    expect(await track(f.free.remove(f.instance))).toBe(false)
    expect(toRaw(f.free.jobs[f.instance.id])).toBe(job)
    expect(rememberedJob(f.instance.id)).toBe(job.id)
    expect(f.free.errors[f.instance.id]).not.toBe('')
    expect(f.start).toHaveBeenCalledTimes(0)
  },
)

test('a delayed deletion acknowledgement never clears an operation started while it waited', async () => {
  const f = fixture()
  const deletion = gate({ ok: true as const })
  const dispatch = gate<FreeJob>({ id: 'synthetic-fallback', instanceId: f.instance.id,
    provider: 'chatgpt', command: 'chat', state: 'done', phase: 'working', startedAt: 1, result: f.result })
  f.remove.mockImplementation(() => deletion.promise)
  f.start.mockImplementation(request => dispatch.promise.then(() => f.completed(request)))
  const removing = track(f.free.remove(f.instance))
  const sending = track(f.free.run(f.instance, 'chat', { prompt: 'Synthetic pending input' }))
  const request = f.start.mock.calls[0]![0]!
  expect(f.free.busy(f.instance.id)).toBe(true)
  deletion.release({ ok: true })
  expect(await removing).toBe(true)
  expect(f.free.jobs[f.instance.id]).toMatchObject({ id: request.requestId, state: 'running' })
  expect(rememberedJob(f.instance.id)).toBe(request.requestId)
  dispatch.release(f.completed(request))
  expect(await sending).toBe(f.result)
  expect(f.start).toHaveBeenCalledTimes(1)
  expect(Object.hasOwn(f.free.jobs[f.instance.id]!, 'result')).toBe(false)
})
