// server/tests/mcp-free.test.ts - the Free account tools (server/src/mcp-free.ts) against a stand-in Desk 2
// on a free port (HYDRA_DESK_PORT), never the real one: which account a task goes to, one operation per
// account at a time, and a continuation on its own thread's account.
import { afterAll, beforeAll, describe, expect, spyOn, test } from 'bun:test'
import {
  FREE_TOOLS,
  type FreeInstance,
  noteFreeOutcome,
  noteFreeSend,
  noteProviderOutcome,
  paceCap,
  pickFreeAccount,
  providerDown,
  resetFreeHealth,
  restingFor,
  windowResetAt,
} from '../src/mcp-free'

const usage = (fiveHour: number | null, week: number | null, unlimited = false) => ({
  available: true,
  ...(unlimited ? { unlimited_text: true } : {}),
  windows: unlimited
    ? []
    : [
        { id: 'five_hour', used_percent: fiveHour },
        { id: 'seven_day', used_percent: week },
      ],
})
const INSTANCES: FreeInstance[] = [
  { id: 'a', num: 1, provider: 'claude', name: 'one', loggedIn: true, usage: usage(40, 10) },
  {
    id: 'b',
    num: 2,
    provider: 'chatgpt',
    name: 'two',
    loggedIn: true,
    usage: usage(null, null, true),
  },
  { id: 'c', num: 3, provider: 'claude', name: 'three', loggedIn: false, usage: null },
  { id: 'd', num: 4, provider: 'claude', name: 'four', loggedIn: true, usage: usage(5, 95) },
]
const THREAD = '11111111-1111-4111-8111-111111111111'

describe('pickFreeAccount', () => {
  test('an idle account with room, used longest ago first; never one signed out, and one at 90% of its week only by number', () => {
    // ChatGPT's unlimited text and a Claude window under half used are the same room: Claude first on a tie.
    expect(pickFreeAccount(INSTANCES, new Set(), {})?.num).toBe(1)
    const justUsed = INSTANCES.map((i) => (i.id === 'a' ? { ...i, lastActiveAt: Date.now() } : i))
    expect(pickFreeAccount(justUsed, new Set(), {})?.num).toBe(2)
    const halfUsed = INSTANCES.map((i) => (i.id === 'a' ? { ...i, usage: usage(60, 10) } : i))
    expect(pickFreeAccount(halfUsed, new Set(), {})?.num).toBe(2)
    expect(pickFreeAccount(INSTANCES, new Set(['b']), {})?.num).toBe(1)
    expect(pickFreeAccount(INSTANCES, new Set(['a', 'b']), {})).toBeNull()
    expect(pickFreeAccount(INSTANCES, new Set(), { provider: 'claude' })?.num).toBe(1)
    expect(pickFreeAccount(INSTANCES, new Set(), { account: 4 })?.num).toBe(4)
    expect(pickFreeAccount(INSTANCES, new Set(), { account: 3 })).toBeNull()
  })

  test('a thinking model goes to a paid ChatGPT plan before a Free-plan one; an instant model does not care', () => {
    const plan = (i: FreeInstance, p: string) => ({
      ...i,
      usage: { ...usage(null, null, true), plan: p },
    })
    const accounts = [
      plan({ ...INSTANCES[1], id: 'f', num: 5 }, 'free'),
      plan({ ...INSTANCES[1], id: 'g', num: 6, lastActiveAt: Date.now() }, 'go'),
    ]
    expect(pickFreeAccount(accounts, new Set(), { model: 'luna-thinking' })?.num).toBe(6)
    expect(pickFreeAccount(accounts, new Set(), { model: 'gpt-6-t-mini' })?.num).toBe(6)
    expect(pickFreeAccount(accounts, new Set(), { model: 'gpt-instant' })?.num).toBe(5)
    expect(pickFreeAccount(accounts, new Set(['g']), { model: 'luna-thinking' })?.num).toBe(5)
  })

  test('a rate-limited account with a spent 5-hour window rests until it resets, not 30 minutes', () => {
    resetFreeHealth()
    const now = Date.UTC(2026, 9, 8, 12)
    const resets = new Date(now + 3 * 3_600_000).toISOString()
    const spent = {
      ...INSTANCES[0],
      usage: {
        available: true,
        windows: [{ id: 'five_hour', used_percent: 94, resets_at: resets }],
      },
    }
    noteFreeOutcome('a', 'rate_limited', now, windowResetAt(spent, now))
    expect(restingFor('a', now)?.until).toBe(Date.parse(resets))
    // A window with room says the refusal was something shorter: the usual 30 minutes.
    const roomy = {
      ...spent,
      usage: { ...spent.usage, windows: [{ ...spent.usage.windows[0], used_percent: 40 }] },
    }
    noteFreeOutcome('b', 'rate_limited', now, windowResetAt(roomy, now))
    expect(restingFor('b', now)?.until).toBe(now + 30 * 60_000)
    resetFreeHealth()
  })

  test('a ChatGPT account at its cap of new chats waits; a lockout lowers the cap, a window it held raises it', () => {
    // 2026-10-08: ChatGPT Free locked out for 30-60 min after ~75 new chats in half an hour, 17 times on two accounts.
    resetFreeHealth()
    const gpt = INSTANCES[1]
    const now = Date.now()
    for (let n = 0; n < 70; n++) noteFreeSend('b', now - n * 1000)
    expect(pickFreeAccount([gpt], new Set(), {})).toBeNull()
    expect(pickFreeAccount([gpt, INSTANCES[0]], new Set(), {})?.num).toBe(1)
    expect(pickFreeAccount([gpt], new Set(), { account: 2 })?.num).toBe(2) // a named account is never held back
    // pickFreeAccount reads the real clock, so the held window began a few ms after `now` whenever the
    // box was busy (2026-10-11: 70, not 73, in the parallel suite). A full window is counted from after it.
    const heldAt = Date.now()
    expect(paceCap(gpt, heldAt + 30 * 60_000)).toBe(73)
    // Locked out with 60 chats allowed in the window: the cap goes a tenth under that.
    resetFreeHealth()
    for (let n = 0; n < 61; n++) noteFreeSend('b', now - n * 1000)
    noteFreeOutcome('b', 'rate_limited', now)
    expect(paceCap(gpt, now)).toBe(54)
    resetFreeHealth()
  })

  test('a provider failing five sends in a row takes no new thread; after its rest one probe goes, a failure rests it longer', () => {
    // 2026-10-15: chatgpt.com answered 421 of 421 sends 404 not_found; no account rested, so ChatGPT kept taking work.
    resetFreeHealth()
    const now = Date.now()
    for (let n = 0; n < 4; n++) noteProviderOutcome('chatgpt', 'not_found', now)
    expect(providerDown('chatgpt', now)).toBeNull()
    noteProviderOutcome('chatgpt', 'not_found', now)
    expect(providerDown('chatgpt', now)?.until).toBe(now + 10 * 60_000)
    const gptOnly = INSTANCES.filter((i) => i.id === 'b')
    expect(pickFreeAccount(gptOnly, new Set(), {})).toBeNull()
    expect(pickFreeAccount(INSTANCES, new Set(), {})?.provider).toBe('claude')
    expect(pickFreeAccount(gptOnly, new Set(), { account: 2 })?.num).toBe(2) // a named account is never held back
    // The rest over: one probe, and nothing else until it ends.
    resetFreeHealth()
    const past = now - 11 * 60_000
    for (let n = 0; n < 5; n++) noteProviderOutcome('chatgpt', 'not_found', past)
    const two = [INSTANCES[1], { ...INSTANCES[1], id: 'e', num: 5 }]
    expect(pickFreeAccount(two, new Set(), {})?.provider).toBe('chatgpt')
    expect(pickFreeAccount(two, new Set(['b']), {})).toBeNull()
    noteProviderOutcome('chatgpt', 'not_found', now)
    expect(providerDown('chatgpt', now)?.until).toBe(now + 20 * 60_000)
    noteProviderOutcome('chatgpt', null, now)
    expect(providerDown('chatgpt', now)).toBeNull()
    resetFreeHealth()
  })
})

describe('free_chat through a stand-in Desk 2', () => {
  type Job = {
    id: string
    instanceId: string
    state: 'running' | 'done'
    command: string
    chatId?: string
    result?: unknown
  }
  const jobs = new Map<string, Job>()
  const ran: {
    instance: string
    command: string
    chatId?: string
    prompt: string
    model?: string
  }[] = []
  let overlap = 0
  let statusReads = 0
  let threadReads = 0
  let statusDelay = 0
  let threadDelay = 0
  let emptyThreads = false
  let threadFailures = 0
  /** A continuation's lookup by chat id (`view=lookup`) answers 503 this many more times. */
  let lookupFailures = 0
  let statusFailures = 0
  let jobReadDelay = 0
  let activeJobReads = 0
  let peakJobReads = 0
  let bulkSupported = false
  let bulkReads = 0
  let individualJobReads = 0
  let server: ReturnType<typeof Bun.serve>
  let port: string | undefined

  beforeAll(() => {
    // From no sends, rests or caps: a pacing test above that fails before its own reset leaves #2 at its
    // cap, and two of these then waited out their 30 s for an account that never frees (2026-10-11).
    resetFreeHealth()
    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        const path = url.pathname.replace('/api/free', '')
        if (path === '/status') {
          statusReads++
          if (statusDelay) await Bun.sleep(statusDelay)
          if (statusFailures-- > 0)
            return Response.json({ error: 'status unavailable' }, { status: 503 })
          return Response.json({ ready: true, instances: INSTANCES, jobs: [...jobs.values()] })
        }
        if (path === '/threads') {
          threadReads++
          if (threadDelay) await Bun.sleep(threadDelay)
          if (threadFailures-- > 0)
            return Response.json({ error: 'history unavailable' }, { status: 503 })
          if (url.searchParams.get('view') === 'lookup' && lookupFailures-- > 0)
            return Response.json({ error: 'Desk is busy' }, { status: 503 })
          if (emptyThreads) return Response.json([])
          return Response.json([
            {
              instanceId: 'b',
              provider: 'chatgpt',
              chatId: THREAD,
              title: 'earlier',
              status: 'done',
              createdAt: 1,
              updatedAt: 2,
              error: null,
            },
          ])
        }
        if (path === '/jobs' && req.method === 'POST') {
          const r = (await req.json()) as {
            requestId: string
            instanceId: string
            command: string
            chatId?: string
            prompt: string
            name?: string
            model?: string
          }
          if (
            [...jobs.values()].some((j) => j.instanceId === r.instanceId && j.state === 'running')
          ) {
            overlap++
            return Response.json(
              { error: 'This account already has an operation running.' },
              { status: 409 },
            )
          }
          const job: Job = {
            id: r.requestId,
            instanceId: r.instanceId,
            state: 'running',
            command: r.command,
            chatId: r.chatId,
          }
          jobs.set(job.id, job)
          // 'refused' is turned away by the first account it reaches, before any chat exists.
          const refuse = r.prompt === 'refused' && !ran.some((x) => x.prompt === 'refused')
          ran.push({
            instance: r.instanceId,
            command: r.command,
            chatId: r.chatId,
            prompt: r.prompt,
            model: r.model,
          })
          setTimeout(() => {
            if (r.prompt === 'missing-operation') {
              jobs.delete(job.id)
              return
            }
            job.state = 'done'
            job.result = refuse
              ? {
                  ok: false,
                  error: { code: 'http_rejected', message: 'ChatGPT rejected the HTTP request.' },
                }
              : {
                  ok: true,
                  chat_id: r.chatId ?? crypto.randomUUID(),
                  chat_name: r.name ?? null,
                  response: `re: ${r.prompt}`,
                  model: 'm',
                }
          }, 100)
          return Response.json(job, { status: 202 })
        }
        if (path === '/jobs' && req.method === 'GET') {
          bulkReads++
          if (!bulkSupported) return Response.json({ error: 'unknown route' }, { status: 404 })
          const ids = (url.searchParams.get('ids') ?? '').split(',')
          return Response.json({
            jobs: Object.fromEntries(ids.map((id) => [id, jobs.get(id) ?? null])),
          })
        }
        individualJobReads++
        activeJobReads++
        peakJobReads = Math.max(peakJobReads, activeJobReads)
        try {
          if (jobReadDelay) await Bun.sleep(jobReadDelay)
          const job = jobs.get(path.replace('/jobs/', ''))
          return job ? Response.json(job) : Response.json({ error: 'gone' }, { status: 404 })
        } finally {
          activeJobReads--
        }
      },
    })
    port = process.env.HYDRA_DESK_PORT
    process.env.HYDRA_DESK_PORT = String(server.port)
  })
  afterAll(() => {
    if (port === undefined) delete process.env.HYDRA_DESK_PORT
    else process.env.HYDRA_DESK_PORT = port
    server.stop(true)
  })
  const run = (name: string, args: Record<string, unknown>) =>
    FREE_TOOLS.find((t) => t.name === name)!.run(args) as Promise<any>

  test('overlapping Free callers share in-flight reads, then read fresh status without rereading empty history', async () => {
    resetFreeHealth()
    statusDelay = threadDelay = 50
    emptyThreads = true
    const before = { statusReads, threadReads }
    try {
      const replies = await Promise.all(Array.from({ length: 12 }, () => run('free_status', {})))
      expect(replies.every((s) => s.ready)).toBe(true)
      expect(statusReads - before.statusReads).toBe(1)
      expect(threadReads - before.threadReads).toBe(1)
      const prior = INSTANCES[0]!.loggedIn
      INSTANCES[0]!.loggedIn = false
      try {
        const fresh = await run('free_status', {})
        expect(fresh.accounts.find((a: { num: number }) => a.num === 1).signedIn).toBe(false)
        expect(statusReads - before.statusReads).toBe(2)
        expect(threadReads - before.threadReads).toBe(1)
      } finally {
        INSTANCES[0]!.loggedIn = prior
      }
    } finally {
      statusDelay = threadDelay = 0
      emptyThreads = false
      resetFreeHealth()
    }
  })

  test('failed shared status and history reads are retried on the next Free call', async () => {
    resetFreeHealth()
    statusDelay = 75
    threadDelay = 25
    statusFailures = threadFailures = 1
    emptyThreads = true
    const before = { statusReads, threadReads }
    try {
      const failed = await Promise.allSettled(
        Array.from({ length: 12 }, () => run('free_status', {})),
      )
      expect(failed.every((r) => r.status === 'rejected')).toBe(true)
      expect(statusReads - before.statusReads).toBe(1)
      expect(threadReads - before.threadReads).toBe(1)
      expect((await run('free_status', {})).ready).toBe(true)
      expect(statusReads - before.statusReads).toBe(2)
      expect(threadReads - before.threadReads).toBe(2)
      await run('free_status', {})
      expect(threadReads - before.threadReads).toBe(2)
    } finally {
      statusDelay = threadDelay = 0
      statusFailures = threadFailures = 0
      emptyThreads = false
      resetFreeHealth()
    }
  })

  test('Free job reads run at a bounded eight-way concurrency while task results retain their order', async () => {
    resetFreeHealth()
    const original = [...INSTANCES]
    const priorJobs = new Set(jobs.keys())
    const priorRan = ran.length
    INSTANCES.splice(
      0,
      INSTANCES.length,
      ...Array.from({ length: 24 }, (_, n) => ({
        id: `parallel-${n}`,
        num: n + 1,
        provider: 'claude' as const,
        name: `account-${n}`,
        loggedIn: true,
        usage: usage(10, 10),
      })),
    )
    jobReadDelay = 50
    peakJobReads = 0
    try {
      const prompts = Array.from({ length: 24 }, (_, n) => `parallel prompt ${n}`)
      const out = await run('free_chat', { tasks: prompts.map((prompt) => ({ prompt })) })
      expect(out.finished).toBe(true)
      expect(out.tasks.map((t: { response: string }) => t.response)).toEqual(
        prompts.map((p) => `re: ${p}`),
      )
      expect(peakJobReads).toBe(8)
      expect(overlap).toBe(0)
    } finally {
      jobReadDelay = 0
      INSTANCES.splice(0, INSTANCES.length, ...original)
      ran.splice(priorRan)
      for (const id of jobs.keys()) if (!priorJobs.has(id)) jobs.delete(id)
      resetFreeHealth()
    }
  }, 15_000)

  test('one Free bulk read replaces 24 individual job requests without changing ordered replies', async () => {
    resetFreeHealth()
    const original = [...INSTANCES]
    const priorJobs = new Set(jobs.keys())
    const priorRan = ran.length
    const before = { bulkReads, individualJobReads }
    bulkSupported = true
    INSTANCES.splice(
      0,
      INSTANCES.length,
      ...Array.from({ length: 24 }, (_, n) => ({
        id: `bulk-${n}`,
        num: n + 1,
        provider: 'claude' as const,
        name: `bulk account ${n}`,
        loggedIn: true,
        usage: usage(10, 10),
      })),
    )
    try {
      const prompts = Array.from({ length: 24 }, (_, n) => `bulk prompt ${n}`)
      const out = await run('free_chat', { tasks: prompts.map((prompt) => ({ prompt })) })
      expect(out.finished).toBe(true)
      expect(out.tasks.map((t: { response: string }) => t.response)).toEqual(
        prompts.map((p) => `re: ${p}`),
      )
      expect(bulkReads - before.bulkReads).toBe(1)
      expect(individualJobReads - before.individualJobReads).toBe(0)
      expect(ran.length - priorRan).toBe(24)
      expect(overlap).toBe(0)
    } finally {
      bulkSupported = false
      INSTANCES.splice(0, INSTANCES.length, ...original)
      ran.splice(priorRan)
      for (const id of jobs.keys()) if (!priorJobs.has(id)) jobs.delete(id)
      resetFreeHealth()
    }
  }, 15_000)

  test('an expired bulk operation fails only its task and never repeats either send', async () => {
    resetFreeHealth()
    const before = ran.length
    bulkSupported = true
    try {
      const out = await run('free_chat', {
        tasks: [{ prompt: 'missing-operation' }, { prompt: 'bulk sibling' }],
      })
      expect(out.finished).toBe(true)
      expect(out.tasks[0].state).toBe('failed')
      expect(out.tasks[0].error).toContain('no longer holds this operation')
      expect(out.tasks[1]).toMatchObject({ state: 'done', response: 're: bulk sibling' })
      expect(ran.length - before).toBe(2)
    } finally {
      bulkSupported = false
      resetFreeHealth()
    }
  }, 15_000)

  test('more tasks than idle accounts all finish, one operation per account at a time; a continuation goes to its thread', async () => {
    const beforeBulk = bulkReads
    const out = await run('free_chat', {
      tasks: [
        { prompt: 'p1' },
        { prompt: 'p2' },
        { prompt: 'p3', name: 'named' },
        { prompt: 'again', chat_id: THREAD },
      ],
    })
    expect(out.finished).toBe(true)
    expect(out.tasks.map((t: { state: string }) => t.state)).toEqual([
      'done',
      'done',
      'done',
      'done',
    ])
    expect(out.tasks[3]).toMatchObject({
      chat_id: THREAD,
      account: '#2 chatgpt (two)',
      response: 're: again',
    })
    expect(ran.find((r) => r.prompt === 'again')).toMatchObject({
      instance: 'b',
      command: 'resume',
      chatId: THREAD,
    })
    // Never the signed-out #3 or #4 at 95% of its week, and never a second operation on a busy account.
    expect(new Set(ran.map((r) => r.instance))).toEqual(new Set(['a', 'b']))
    expect(overlap).toBe(0)
    const batch = await run('free_results', { batch: out.batch, wait_s: 0 })
    expect(batch.done).toBe('4 of 4')
    expect(bulkReads - beforeBulk).toBe(1)
  }, 30_000)

  // 2026-10-16: a thread lookup Desk could not answer (a 503) failed the continuation as "No Free thread has
  // chat_id", though the thread was there; it stays queued and the next tick finds it.
  test('a continuation whose thread lookup Desk cannot answer now goes to its thread on a later tick', async () => {
    lookupFailures = 1
    try {
      const out = await run('free_chat', { tasks: [{ prompt: 'later', chat_id: THREAD }] })
      expect(out.tasks[0]).toMatchObject({ state: 'done', chat_id: THREAD, response: 're: later' })
    } finally {
      lookupFailures = 0
    }
  }, 30_000)

  // 2026-10-08: the GPT-6 trial asks a Free ChatGPT account for GPT-6 by name.
  test('a ChatGPT model goes to a ChatGPT account and reaches Desk; a Claude family is never sent to one', async () => {
    const out = await run('free_chat', {
      tasks: [
        { prompt: 'six', model: 'gpt-6' },
        { prompt: 'light', model: 'haiku', account: 2 },
      ],
    })
    expect(out.tasks.map((t: { state: string }) => t.state)).toEqual(['done', 'done'])
    expect(ran.find((r) => r.prompt === 'six')).toMatchObject({ instance: 'b', model: 'gpt-6' })
    expect(ran.find((r) => r.prompt === 'light')?.model).toBeUndefined()
    await expect(
      run('free_chat', { tasks: [{ prompt: 'x', provider: 'claude', model: 'gpt-6' }] }),
    ).rejects.toThrow('ChatGPT model')
  }, 30_000)

  // Contract (free-model-currency plan): a role name or any gpt- slug is a ChatGPT model, so a release the
  // code never heard of ('gpt-6-1-mini') reaches a ChatGPT account without a code change.
  test('a gpt- slug and a role name are accepted and go to a ChatGPT account', async () => {
    const out = await run('free_chat', {
      tasks: [
        { prompt: 'slug', model: 'gpt-6-1-mini' },
        { prompt: 'role', model: 'gpt-instant' },
      ],
    })
    expect(out.tasks.map((t: { state: string }) => t.state)).toEqual(['done', 'done'])
    expect(ran.find((r) => r.prompt === 'slug')).toMatchObject({
      instance: 'b',
      model: 'gpt-6-1-mini',
    })
    expect(ran.find((r) => r.prompt === 'role')).toMatchObject({
      instance: 'b',
      model: 'gpt-instant',
    })
  }, 30_000)

  // Contract: a model that is neither a Claude family nor a ChatGPT name/slug is refused before any send.
  test('a model that is not a slug is refused', async () => {
    await expect(run('free_chat', { tasks: [{ prompt: 'x', model: 'GPT 6!' }] })).rejects.toThrow(
      'model is haiku, sonnet',
    )
  })

  // Contract: a ChatGPT name (a role) with provider claude is a conflict, as gpt-6 always was.
  test('a ChatGPT role name with provider claude is refused', async () => {
    await expect(
      run('free_chat', { tasks: [{ prompt: 'x', provider: 'claude', model: 'gpt-thinking' }] }),
    ).rejects.toThrow('ChatGPT model')
  })

  // Contract: free_status shows a ChatGPT account's `roles` (and default_moved) so a caller sees which
  // slug each role resolves to today.
  test('free_status passes roles through for a ChatGPT account', async () => {
    const b = INSTANCES[1]!
    const saved = b.usage
    b.usage = {
      ...usage(null, null, true),
      models: [{ slug: 'gpt-6-1-mini' }],
      roles: { instant: 'gpt-6-1-mini' },
      default_moved: true,
    } as FreeInstance['usage']
    try {
      const st = await run('free_status', {})
      const acct = st.accounts.find((a: { num: number }) => a.num === 2)
      expect(acct.roles).toEqual({ instant: 'gpt-6-1-mini' })
      expect(acct.default_moved).toBe(true)
      expect(acct.offers).toEqual(['gpt-6-1-mini'])
    } finally {
      b.usage = saved
    }
  })

  test('a new thread its account refuses is answered by another idle account, and the refusing one rests', async () => {
    // 2026-10-07: a failing ChatGPT account stayed first in line and took ~3,700 sends in a row.
    const out = await run('free_chat', { tasks: [{ prompt: 'refused' }] })
    expect(out.tasks[0]).toMatchObject({ state: 'done', response: 're: refused' })
    expect(out.tasks[0].retried).toContain('http_rejected')
    const [first, second] = ran.filter((r) => r.prompt === 'refused').map((r) => r.instance)
    expect(second).not.toBe(first)
    const status = await run('free_status', {})
    const refuser = INSTANCES.find((i) => i.id === first)!
    expect(status.accounts.find((a: { num: number }) => a.num === refuser.num).resting).toContain(
      'http_rejected',
    )
    // While it rests, new work goes to the account that answered.
    await run('free_chat', { tasks: [{ prompt: 'next' }] })
    expect(ran.find((r) => r.prompt === 'next')?.instance).toBe(second)
  }, 30_000)

  test('a task no signed-in account can take fails at once, naming why', async () => {
    const out = await run('free_chat', { tasks: [{ prompt: 'x', account: 3 }] })
    expect(out.tasks[0].state).toBe('failed')
    expect(out.tasks[0].error).toContain('account #3')
  }, 15_000)

  test('free_results expires a normally completed batch after six hours without starting another batch', async () => {
    resetFreeHealth()
    const out = await run('free_chat', {
      tasks: [{ prompt: 'Synthetic retained result', account: 1 }],
    })
    expect(out.finished).toBe(true)
    expect(out.tasks[0]).toMatchObject({
      state: 'done',
      response: 're: Synthetic retained result',
    })
    const retained = await run('free_results', { batch: out.batch, wait_s: 0 })
    expect(retained.tasks).toEqual(out.tasks)
    const sends = ran.length
    const expiredAt = Date.now() + 6 * 60 * 60_000 + 1
    const clock = spyOn(Date, 'now').mockReturnValue(expiredAt)
    try {
      await expect(run('free_results', { batch: out.batch, wait_s: 0 })).rejects.toThrow(
        `no batch ${out.batch} here (kept 6 hours`,
      )
      expect(ran.length).toBe(sends)
    } finally {
      clock.mockRestore()
      resetFreeHealth()
    }
  }, 15_000)
})
