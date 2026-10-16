// Real MCP contracts against an isolated stand-in window; no provider traffic or browsers.
import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from 'bun:test'
import { freeBatchLifecycle } from '../src/free-batch-lifecycle'
import {
  accountLabel,
  FREE_TOOLS,
  type FreeInstance,
  freeBatchPendingCount,
  markUnconfirmedFreeOperations,
  releaseFreeBatchInputs,
  resetFreeHealth,
} from '../src/mcp-free'

const CHAT = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const ORPHAN = '33333333-3333-4333-8333-333333333333'
const accounts: FreeInstance[] = [
  {
    id: 'synthetic-first',
    num: 1,
    provider: 'claude',
    name: 'First account',
    loggedIn: true,
    usage: null,
  },
  {
    id: 'synthetic-second',
    num: 2,
    provider: 'chatgpt',
    name: 'Second account',
    loggedIn: true,
    usage: { available: true, unlimited_text: true, windows: [] },
  },
]
function thread(chatId: string, instanceId: string, updatedAt: number) {
  return {
    instanceId,
    provider: 'claude',
    chatId,
    title: 'Synthetic history',
    status: 'done',
    createdAt: 1,
    updatedAt,
    error: null,
  }
}
const history = [
  thread(CHAT, accounts[0]!.id, 5),
  thread(CHAT, accounts[1]!.id, 999),
  thread(OTHER, accounts[1]!.id, 6),
  thread(ORPHAN, 'removed-account', 7),
  thread(ORPHAN, accounts[0]!.id, 8),
  ...Array.from({ length: 600 }, (_, index) =>
    thread(`synthetic-${index}`, accounts[index % 2]!.id, Math.floor(index / 2)),
  ),
]
type Job = { id: string; instanceId: string; state: 'running' | 'done'; result: unknown }
const jobs = new Map<string, Job>()
const reads: Array<{ path: string; query: URLSearchParams }> = []
const posted: Array<{ instanceId: string; command: string; prompt?: string; chatId?: string }> = []
const batches: string[] = []
const admissions: Promise<any>[] = []
let supported = true
let holdJobs = false
let statusFails = false
let statusGate: Promise<void> | null = null
let releaseStatus: (() => void) | null = null
let server: ReturnType<typeof Bun.serve>
let previousPort: string | undefined

const run = (name: string, args: Record<string, unknown>) => {
  const call = FREE_TOOLS.find((tool) => tool.name === name)!.run(args) as Promise<any>
  if (name === 'free_chat') admissions.push(call)
  return call
}

function completeJobs(): void {
  holdJobs = false
  for (const job of jobs.values()) job.state = 'done'
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('The synthetic operation did not advance')
    await Bun.sleep(5)
  }
}

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const path = url.pathname.replace('/api/free', '')
      reads.push({ path, query: url.searchParams })
      if (path === '/status') {
        if (statusGate) await statusGate
        if (statusFails)
          return Response.json({ error: 'Synthetic unavailable window' }, { status: 503 })
        return Response.json({ ready: true, instances: accounts, jobs: [...jobs.values()] })
      }
      if (path === '/threads') {
        if (supported && url.searchParams.get('view') === 'recent') {
          const account = url.searchParams.has('account')
            ? Number(url.searchParams.get('account'))
            : undefined
          const count = Math.max(1, Math.min(Number(url.searchParams.get('limit')) || 30, 500))
          const mine = history
            .filter(
              (t) =>
                account === undefined ||
                accounts.find((a) => a.id === t.instanceId)?.num === account,
            )
            .sort((a, b) => b.updatedAt - a.updatedAt)
          return Response.json({ total: mine.length, threads: mine.slice(0, count) })
        }
        if (supported && url.searchParams.get('view') === 'lookup') {
          const wanted = new Set(url.searchParams.getAll('chat_id'))
          return Response.json(history.filter((t) => wanted.delete(t.chatId)))
        }
        return Response.json(history)
      }
      if (path === '/jobs' && request.method === 'POST') {
        const body = (await request.json()) as {
          requestId: string
          instanceId: string
          command: string
          prompt?: string
          chatId?: string
        }
        posted.push(body)
        const result =
          body.command === 'read'
            ? {
                ok: true,
                messages: [
                  { role: 'user', text: 'Synthetic question' },
                  { role: 'assistant', text: 'Synthetic answer' },
                ],
              }
            : {
                ok: true,
                chat_id: body.chatId ?? crypto.randomUUID(),
                response: 'Synthetic retained answer',
              }
        const job: Job = {
          id: body.requestId,
          instanceId: body.instanceId,
          state: holdJobs ? 'running' : 'done',
          result,
        }
        jobs.set(job.id, job)
        return Response.json(job, { status: 202 })
      }
      if (path === '/jobs')
        return Response.json({
          jobs: Object.fromEntries(
            (url.searchParams.get('ids') ?? '').split(',').map((id) => [id, jobs.get(id) ?? null]),
          ),
        })
      const job = jobs.get(path.replace('/jobs/', ''))
      return job
        ? Response.json(job)
        : Response.json({ error: 'Unknown synthetic operation' }, { status: 404 })
    },
  })
  previousPort = process.env.HYDRA_DESK_PORT
  process.env.HYDRA_DESK_PORT = String(server.port)
})

beforeEach(() => {
  jobs.clear()
  reads.length = posted.length = 0
  supported = true
  holdJobs = statusFails = false
  statusGate = null
  releaseStatus = null
  freeBatchLifecycle.abortRestart()
  resetFreeHealth()
})

afterEach(async () => {
  releaseStatus?.()
  statusGate = null
  statusFails = false
  completeJobs()
  const settled = await Promise.allSettled(admissions.splice(0))
  for (const admission of settled)
    if (admission.status === 'fulfilled' && admission.value?.batch)
      batches.push(admission.value.batch)
  for (const batch of new Set(batches.splice(0))) await run('free_results', { batch, wait_s: 10 })
  freeBatchLifecycle.abortRestart()
  resetFreeHealth()
})

afterAll(() => {
  if (previousPort === undefined) delete process.env.HYDRA_DESK_PORT
  else process.env.HYDRA_DESK_PORT = previousPort
  server.stop(true)
})

function legacyThreads(args: Record<string, unknown>) {
  const byId = new Map(accounts.map((account) => [account.id, account]))
  const count = Math.max(1, Math.min(Number(args.limit) || 30, 500))
  const mine = history
    .filter((t) => args.account == null || byId.get(t.instanceId)?.num === Number(args.account))
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const shown = mine.slice(0, count).map((t) => ({
    chat_id: t.chatId,
    account: byId.has(t.instanceId)
      ? accountLabel(byId.get(t.instanceId)!)
      : `${t.provider} (account removed)`,
    name: t.title,
    status: t.status,
    updated: new Date(t.updatedAt).toISOString(),
  }))
  return {
    total: mine.length,
    threads: shown,
    ...(mine.length > shown.length
      ? { more: `${mine.length - shown.length} older: raise limit (at most 500) or pass account` }
      : {}),
  }
}

test('bounded recent history and an old full-array window produce the exact legacy MCP answer', async () => {
  for (const args of [
    {},
    { limit: 0 },
    { limit: -2 },
    { limit: Number.NaN },
    { limit: 2.5 },
    { limit: Infinity },
    { account: 1 },
    { account: 2, limit: 1 },
    { account: 999 },
    { account: Number.NaN },
  ]) {
    for (const available of [true, false]) {
      supported = available
      const before = reads.length
      expect(await run('free_threads', args)).toEqual(legacyThreads(args))
      const historyReads = reads.slice(before).filter((read) => read.path === '/threads')
      expect(historyReads).toHaveLength(1)
      expect(historyReads[0]!.query.get('view')).toBe('recent')
    }
  }
})

test('single-chat reads preserve the first duplicate account and removed-account failure on new and old windows', async () => {
  for (const available of [true, false]) {
    supported = available
    const before = reads.length
    const reply = await run('free_read', { chat_id: CHAT, last: 1 })
    expect(reply).toMatchObject({
      chat_id: CHAT,
      account: accountLabel(accounts[0]!),
      messages: [{ role: 'assistant', text: 'Synthetic answer' }],
    })
    expect(posted.at(-1)).toMatchObject({
      instanceId: accounts[0]!.id,
      command: 'read',
      chatId: CHAT,
    })
    const lookup = reads.slice(before).filter((read) => read.path === '/threads')
    expect(lookup).toHaveLength(1)
    expect(lookup[0]!.query.getAll('chat_id')).toEqual([CHAT])
    const posts = posted.length
    await expect(run('free_read', { chat_id: ORPHAN })).rejects.toThrow(
      `No Free thread has chat_id ${ORPHAN}`,
    )
    expect(posted).toHaveLength(posts)
  }
})

test('a continuation batch captures all IDs once, keeps duplicate routing and protects its background lease', async () => {
  for (const available of [true, false]) {
    supported = available
    holdJobs = true
    const before = reads.length
    const previousPosts = posted.length
    const initial = await run('free_chat', {
      tasks: [
        { chat_id: CHAT, prompt: 'Synthetic first continuation' },
        { chat_id: CHAT, prompt: 'Synthetic second continuation' },
        { chat_id: OTHER, prompt: 'Synthetic other continuation' },
      ],
      wait_s: 0,
    })
    batches.push(initial.batch)
    await until(() => posted.length >= previousPosts + 2)
    expect(freeBatchPendingCount()).toBeGreaterThan(0)
    const lookup = reads.slice(before).filter((read) => read.query.get('view') === 'lookup')
    expect(lookup).toHaveLength(1)
    expect(lookup[0]!.query.getAll('chat_id')).toEqual([CHAT, OTHER])
    completeJobs()
    const done = await run('free_results', { batch: initial.batch, wait_s: 10 })
    expect(done.finished).toBe(true)
    expect(done.tasks.map((task: { state: string }) => task.state)).toEqual([
      'done',
      'done',
      'done',
    ])
    const dispatches = posted.slice(previousPosts)
    expect(
      dispatches.filter((task) => task.chatId === CHAT).map((task) => task.instanceId),
    ).toEqual([accounts[0]!.id, accounts[0]!.id])
    expect(dispatches.map((task) => task.prompt).sort()).toEqual(
      [
        'Synthetic first continuation',
        'Synthetic second continuation',
        'Synthetic other continuation',
      ].sort(),
    )
    expect(reads.slice(before).filter((read) => read.query.get('view') === 'lookup')).toHaveLength(
      1,
    )
    expect(freeBatchPendingCount()).toBe(0)
  }
}, 30_000)

test('a batch admission is counted before a slow status preflight and remains held after wait_s zero', async () => {
  holdJobs = true
  statusGate = new Promise((resolve) => {
    releaseStatus = resolve
  })
  const pending = run('free_chat', { tasks: [{ prompt: 'Synthetic admitted task' }], wait_s: 0 })
  expect(freeBatchPendingCount()).toBe(1)
  expect(freeBatchLifecycle.beginRestart()).toBe(false)
  expect(posted).toHaveLength(0)
  releaseStatus!()
  statusGate = null
  const batch = await pending
  batches.push(batch.batch)
  await until(() => posted.length > 0)
  expect(freeBatchPendingCount()).toBe(1)
  completeJobs()
  expect((await run('free_results', { batch: batch.batch, wait_s: 10 })).finished).toBe(true)
  expect(freeBatchPendingCount()).toBe(0)
}, 15_000)

test('failed preflight releases admission and restart admission refuses a task before any dispatch', async () => {
  statusFails = true
  await expect(
    run('free_chat', { tasks: [{ prompt: 'Synthetic preflight failure' }], wait_s: 0 }),
  ).rejects.toThrow('Synthetic unavailable window')
  expect(freeBatchPendingCount()).toBe(0)
  statusFails = false
  expect(freeBatchLifecycle.beginRestart()).toBe(true)
  const before = reads.length
  await expect(
    run('free_chat', { tasks: [{ prompt: 'Synthetic rejected admission' }], wait_s: 0 }),
  ).rejects.toThrow('restarting')
  expect(reads).toHaveLength(before)
  expect(posted).toHaveLength(0)
  expect(freeBatchPendingCount()).toBe(0)
})

test('abandoned running operations keep their request and chat evidence and report an unknown outcome', () => {
  const running = {
    task: { prompt: 'Synthetic pending input' },
    requestId: 'synthetic-request',
    instanceId: accounts[0]!.id,
    startedAt: 123,
    s: {
      task: 0,
      state: 'running' as const,
      chat_id: CHAT,
      account: accountLabel(accounts[0]!),
      thread: 'Synthetic thread',
      model: 'haiku',
      seconds: 2,
      response: 'Preserved partial evidence',
      warnings: ['Preserved synthetic warning'],
    },
  }
  const queued = {
    task: { prompt: 'Synthetic queued input' },
    s: { task: 1, state: 'queued' as const },
  }
  const completed = {
    task: { prompt: '' },
    s: { task: 2, state: 'done' as const, response: 'Completed answer' },
  }
  const before = structuredClone(running)
  markUnconfirmedFreeOperations([running, queued, completed])
  expect(running.s).toMatchObject({
    state: 'failed',
    chat_id: CHAT,
    response: 'Preserved partial evidence',
    warnings: ['Preserved synthetic warning'],
  })
  expect((running.s as { error?: string }).error).toMatch(
    /^operation_unconfirmed:.*final status is unknown/,
  )
  expect((running.s as { error?: string }).error).toContain(
    'free_threads and free_read before sending again',
  )
  const {
    state: _state,
    error: _error,
    ...evidence
  } = running.s as typeof running.s & { error: string }
  const { state: _beforeState, ...previousEvidence } = before.s
  expect(evidence).toEqual(previousEvidence)
  expect(running.requestId).toBe(before.requestId)
  expect(running.instanceId).toBe(before.instanceId)
  expect(running.startedAt).toBe(before.startedAt)
  expect(queued.s.state).toBe('queued')
  expect(completed.s).toEqual({ task: 2, state: 'done', response: 'Completed answer' })
  releaseFreeBatchInputs([running, queued, completed])
  expect(running.task.prompt).toBe('')
  expect(running.requestId).toBe(before.requestId)
  expect(running.s.chat_id).toBe(CHAT)
  expect(queued.task.prompt).toBe('Synthetic queued input')
})
