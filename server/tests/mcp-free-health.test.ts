// server/tests/mcp-free-health.test.ts - the daemon's Free account health (server/src/mcp-free.ts): the leases on
// Claude accounts, the one retry after a send that never reached the provider, stale 5-hour readings, provider
// health, the rests a relaunch must keep. A stand-in Desk 2 answers on a free port (HYDRA_DESK_PORT), never the
// real one, and free-health.json is written to the test's scratch DATA_DIR (the test preload).
import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from '../src/config'
import {
  FREE_TOOLS,
  type FreeInstance,
  leaseOf,
  loadFreeHealth,
  noteFreeOutcome,
  noteProviderOutcome,
  pickFreeAccount,
  providerDown,
  providerHealthOf,
  resetFreeHealth,
  restingFor,
} from '../src/mcp-free'

const HOUR = 3_600_000
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const HEALTH_FILE = join(DATA_DIR, 'free-health.json')
const CHAT = '22222222-2222-4222-8222-222222222222'

/** A Claude account: its 5-hour window at `used` percent (null: no reading), reset at `resetsAt` (ms). */
const claude = (num: number, used: number | null, resetsAt?: number): FreeInstance => ({
  id: `claude-${num}`,
  num,
  provider: 'claude',
  name: `Example ${num}`,
  loggedIn: true,
  usage: {
    available: true,
    windows:
      used == null
        ? []
        : [
            {
              id: 'five_hour',
              used_percent: used,
              resets_at: resetsAt == null ? null : new Date(resetsAt).toISOString(),
            },
            { id: 'seven_day', used_percent: 10 },
          ],
  },
})
const gpt = (num: number): FreeInstance => ({
  id: `chatgpt-${num}`,
  num,
  provider: 'chatgpt',
  name: `Example ${num}`,
  loggedIn: true,
  usage: { available: true, unlimited_text: true, windows: [] },
})
const fleet = (): FreeInstance[] => [claude(11, 20), claude(12, 20), gpt(21)]

type Thread = {
  instanceId: string
  provider: 'claude' | 'chatgpt'
  chatId: string
  title: string
  status: string
  createdAt: number
  updatedAt: number
  error: string | null
}
let instances: FreeInstance[] = []
const jobs = new Map<string, { id: string; instanceId: string; state: string; result?: unknown }>()
let threads: Thread[] = []
const ran: { instance: string; command: string; chatId?: string; prompt: string }[] = []
/** The error code the stand-in answers a send with, or null for an ok answer. */
let codeFor: (instanceId: string, prompt: string) => string | null = () => null
let server: ReturnType<typeof Bun.serve>
let port: string | undefined

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const path = url.pathname.replace('/api/free', '')
      if (path === '/status')
        return Response.json({ ready: true, instances, jobs: [...jobs.values()] })
      if (path === '/threads') {
        if (url.searchParams.get('view') !== 'lookup') return Response.json([])
        const chatIds = url.searchParams.getAll('chat_id')
        return Response.json(threads.filter((t) => chatIds.includes(t.chatId)))
      }
      if (path === '/jobs' && req.method === 'POST') {
        const r = (await req.json()) as {
          requestId: string
          instanceId: string
          command: string
          chatId?: string
          prompt: string
          name?: string
        }
        if ([...jobs.values()].some((j) => j.instanceId === r.instanceId && j.state === 'running'))
          return Response.json(
            { error: 'This account already has an operation running.' },
            { status: 409 },
          )
        const job = { id: r.requestId, instanceId: r.instanceId, state: 'running' }
        jobs.set(job.id, job)
        ran.push({ instance: r.instanceId, command: r.command, chatId: r.chatId, prompt: r.prompt })
        setTimeout(() => {
          const code = codeFor(r.instanceId, r.prompt)
          const chatId = r.chatId ?? crypto.randomUUID()
          Object.assign(job, {
            state: 'done',
            result: code
              ? {
                  ok: false,
                  error: { code, message: `${code} from the stand-in. No message was sent.` },
                }
              : {
                  ok: true,
                  chat_id: chatId,
                  chat_name: r.name ?? null,
                  response: `re: ${r.prompt}`,
                  model: 'm',
                },
          })
          if (!code && !r.chatId)
            threads.push({
              instanceId: r.instanceId,
              provider: instances.find((i) => i.id === r.instanceId)?.provider ?? 'claude',
              chatId,
              title: r.prompt,
              status: 'done',
              createdAt: Date.now(),
              updatedAt: Date.now(),
              error: null,
            })
        }, 50)
        return Response.json(job, { status: 202 })
      }
      // The stand-in has no bulk job lookup: the daemon falls back to one read per job, as an older Desk 2 needs.
      if (path === '/jobs' && req.method === 'GET')
        return Response.json({ error: 'unknown route' }, { status: 404 })
      const job = jobs.get(path.replace('/jobs/', ''))
      return job ? Response.json(job) : Response.json({ error: 'gone' }, { status: 404 })
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
beforeEach(() => {
  resetFreeHealth()
  instances = fleet()
  jobs.clear()
  threads = []
  ran.length = 0
  codeFor = () => null
})

const run = (name: string, args: Record<string, unknown>) =>
  FREE_TOOLS.find((t) => t.name === name)!.run(args) as Promise<any>
/** Sends tasks as free_chat does, then waits for the batch to finish (free_results). */
async function send(tasks: Record<string, unknown>[]) {
  const started = await run('free_chat', { tasks, wait_s: 0 })
  return run('free_results', { batch: started.batch, wait_s: 30 })
}
const accountOf = (status: { accounts: { num: number }[] }, num: number) =>
  status.accounts.find((a) => a.num === num) as Record<string, unknown>

describe('a send that never reached the provider', () => {
  test('is retried once: off the failing account, and to the other provider when none was named', async () => {
    codeFor = (id, prompt) =>
      prompt === 'nosend' && id === 'claude-11' ? 'browser_preparation_invalid' : null
    const out = await send([{ prompt: 'nosend' }])
    expect(out.tasks[0]).toMatchObject({ state: 'done', response: 're: nosend' })
    expect(ran.filter((r) => r.prompt === 'nosend').map((r) => r.instance)).toEqual([
      'claude-11',
      'chatgpt-21',
    ])
    expect(out.tasks[0].retried).toContain('browser_preparation_invalid')
  }, 20_000)

  test('is retried only once: a second such failure ends the task with its code', async () => {
    codeFor = (_id, prompt) => (prompt === 'nosend-all' ? 'browser_preparation_invalid' : null)
    const out = await send([{ prompt: 'nosend-all' }])
    expect(out.tasks[0].state).toBe('failed')
    expect(out.tasks[0].error).toMatch(/^browser_preparation_invalid: /)
    expect(ran.filter((r) => r.prompt === 'nosend-all')).toHaveLength(2)
  }, 20_000)
})

describe('a Claude-family ask, retried', () => {
  test('stays on Claude: the other Claude account takes it, and the model is never sent to ChatGPT', async () => {
    codeFor = (id, prompt) =>
      prompt === 'haiku retry' && id === 'claude-11' ? 'browser_preparation_invalid' : null
    const out = await send([{ prompt: 'haiku retry', model: 'haiku' }])
    expect(out.tasks[0]).toMatchObject({ state: 'done', account: '#12 claude (Example 12)' })
    expect(ran.filter((r) => r.prompt === 'haiku retry').map((r) => r.instance)).toEqual([
      'claude-11',
      'claude-12',
    ])
  }, 20_000)
})

describe('Claude leases', () => {
  test('a new thread holds its Claude account: the next new thread goes elsewhere, the chat itself still continues', async () => {
    const first = await send([{ prompt: 'lease A' }])
    const chat = first.tasks[0].chat_id as string
    expect(first.tasks[0].account).toBe('#11 claude (Example 11)')
    expect(accountOf(await run('free_status', {}), 11).leased).toBe(true)

    const second = await send([{ prompt: 'lease B' }])
    expect(second.tasks[0].account).toBe('#12 claude (Example 12)')

    const again = await send([{ prompt: 'continue A', chat_id: chat }])
    expect(again.tasks[0]).toMatchObject({ state: 'done', chat_id: chat })
    expect(ran.find((r) => r.prompt === 'continue A')?.instance).toBe('claude-11')
  }, 20_000)

  test('free_release ends the lease, once; an unknown chat holds none', async () => {
    const first = await send([{ prompt: 'hold' }])
    const chat = first.tasks[0].chat_id as string
    expect(await run('free_release', { chat_id: chat })).toEqual({ released: true })
    expect(await run('free_release', { chat_id: chat })).toEqual({ released: false })
    expect(await run('free_release', { chat_id: 'no-such-chat' })).toEqual({ released: false })
    expect(accountOf(await run('free_status', {}), 11).leased).toBe(false)
    const next = await send([{ prompt: 'after release', account: 11 }])
    expect(next.tasks[0]).toMatchObject({ state: 'done', account: '#11 claude (Example 11)' })
  }, 20_000)

  test('the lease ends four minutes after the chat’s last turn, without a release', async () => {
    const first = await send([{ prompt: 'idle' }])
    expect(first.tasks[0].state).toBe('done')
    const t0 = Date.now()
    const clock = spyOn(Date, 'now')
    try {
      clock.mockReturnValue(t0 + 3 * 60_000)
      expect(accountOf(await run('free_status', {}), 11).leased).toBe(true)
      clock.mockReturnValue(t0 + 4 * 60_000 + 1_000)
      expect(accountOf(await run('free_status', {}), 11).leased).toBe(false)
      expect(leaseOf('claude-11', t0 + 4 * 60_000 + 1_000)).toBeNull()
    } finally {
      clock.mockRestore()
    }
  }, 20_000)
})

describe('a new thread’s lease before its chat is known', () => {
  test('a new thread that fails leaves its Claude account unleased: the next new thread may take it', async () => {
    codeFor = (_id, prompt) => (prompt === 'fails new' ? 'browser_preparation_timeout' : null)
    const failed = await send([{ prompt: 'fails new', account: 11 }])
    expect(failed.tasks[0]).toMatchObject({ state: 'failed' })
    expect(accountOf(await run('free_status', {}), 11).leased).toBe(false)
    const next = await send([
      { prompt: 'after the failure', provider: 'claude', exclude_accounts: [12] },
    ])
    expect(next.tasks[0]).toMatchObject({ state: 'done', account: '#11 claude (Example 11)' })
  }, 20_000)

  test('a successful new thread’s lease is bound to its chat, and free_release ends it', async () => {
    const first = await send([{ prompt: 'bind me', account: 11 }])
    const chat = first.tasks[0].chat_id as string
    expect(leaseOf('claude-11')?.chatId).toBe(chat)
    expect(await run('free_release', { chat_id: chat })).toEqual({ released: true })
    expect(leaseOf('claude-11')).toBeNull()
  }, 20_000)
})

describe('free-health.json on disk', () => {
  test('notes inside one second share one write, made once the second ends', async () => {
    await sleep(1100) // the reset's own write lands first
    const before = readFileSync(HEALTH_FILE, 'utf8')
    noteProviderOutcome('claude', 'rate_limited')
    noteProviderOutcome('claude', 'rate_limited')
    noteFreeOutcome('claude-11', 'rate_limited')
    expect(readFileSync(HEALTH_FILE, 'utf8')).toBe(before)
    await sleep(1100)
    const saved = JSON.parse(readFileSync(HEALTH_FILE, 'utf8'))
    expect(saved.outcomes).toHaveLength(2) // the two provider notes
    expect(Object.keys(saved.rests)).toEqual(['claude-11']) // and the account note
  }, 10_000)

  test('a file of the wrong shape loads without throwing: bad entries are skipped, good ones kept', async () => {
    await sleep(1100) // a pending write from the reset would overwrite the file this test writes
    const now = Date.now()
    writeFileSync(
      HEALTH_FILE,
      JSON.stringify({
        outcomes: 'not a list',
        rests: {
          'claude-11': null,
          'claude-12': { until: now + HOUR, code: 'rate_limited', strikes: 1 },
        },
        providerRests: { chatgpt: null },
        leases: { 'claude-11': null, 'claude-12': { until: 'soon' } },
        lastPicked: { 'claude-11': 'x' },
      }),
    )
    expect(() => loadFreeHealth(now)).not.toThrow()
    expect(restingFor('claude-11', now)).toBeNull()
    expect(restingFor('claude-12', now)?.code).toBe('rate_limited')
    expect(leaseOf('claude-12', now)).toBeNull()
    expect(providerHealthOf('chatgpt', now).sent).toBe(0)
  }, 10_000)
})

describe('free_status', () => {
  test('five_hour_pct is 0 for a window whose reset passed, null with no reading and for ChatGPT; providerHealth is there', async () => {
    instances = [
      claude(11, 90, Date.now() - HOUR),
      claude(12, 30, Date.now() + HOUR),
      claude(13, null),
      gpt(21),
    ]
    noteProviderOutcome('chatgpt', 'not_found')
    const status = await run('free_status', {})
    expect(accountOf(status, 11)).toMatchObject({ five_hour_pct: 0 })
    expect(accountOf(status, 12)).toMatchObject({ five_hour_pct: 30 })
    expect(accountOf(status, 13)).toMatchObject({ five_hour_pct: null })
    expect(accountOf(status, 21)).toMatchObject({ five_hour_pct: null, leased: false })
    expect(status.providerHealth.chatgpt).toMatchObject({
      sent: 1,
      failed: 1,
      okShare: 0,
      topReason: 'not_found',
    })
    expect(status.providerHealth.claude).toMatchObject({
      sent: 0,
      failed: 0,
      okShare: null,
      down: false,
    })
  })

  test('a passed 5-hour reset is ranked as empty, not last; a never-used account ranks with the empty ones', () => {
    const stale = { ...claude(11, 90, Date.now() - HOUR), lastActiveAt: Date.now() - 1_000 }
    expect(pickFreeAccount([claude(12, 60), stale], new Set(), {})?.num).toBe(11)
    expect(pickFreeAccount([claude(12, 60), claude(13, null)], new Set(), {})?.num).toBe(13)
  })

  test('a Claude-family model with no provider goes to a Claude account with room before ChatGPT; ChatGPT still takes it without room', () => {
    const chatgpt = gpt(21)
    const recentClaude = { ...claude(11, 20), lastActiveAt: Date.now() }
    expect(pickFreeAccount([chatgpt, recentClaude], new Set(), { model: 'sonnet' })?.num).toBe(11)
    expect(pickFreeAccount([chatgpt, recentClaude], new Set(), {})?.num).toBe(21)
    expect(pickFreeAccount([chatgpt, claude(11, 60)], new Set(), { model: 'haiku' })?.num).toBe(21)
  })
})

describe('provider health', () => {
  test('counts the last hour of sends from the outcome notes: sent, failed, okShare and the top reason', () => {
    const now = Date.now()
    for (let n = 0; n < 3; n++) noteProviderOutcome('chatgpt', null, now)
    noteProviderOutcome('chatgpt', 'browser_preparation_invalid', now)
    noteProviderOutcome('chatgpt', 'browser_preparation_invalid', now)
    expect(providerHealthOf('chatgpt', now)).toEqual({
      sent: 5,
      failed: 2,
      okShare: 0.6,
      down: false,
      downUntil: null,
      topReason: 'browser_preparation_invalid',
    })
    expect(providerHealthOf('chatgpt', now + 61 * 60_000)).toMatchObject({
      sent: 0,
      failed: 0,
      okShare: null,
      topReason: null,
    })
  })

  test('a provider-wide failure in a row reports down until its rest ends; a per-account code never rests the provider', () => {
    const now = Date.now()
    for (let n = 0; n < 6; n++) noteProviderOutcome('claude', 'rate_limited', now)
    expect(providerDown('claude', now)).toBeNull()
    expect(providerHealthOf('claude', now)).toMatchObject({ down: false, failed: 6, okShare: 0 })
    for (let n = 0; n < 5; n++) noteProviderOutcome('chatgpt', 'browser_preparation_timeout', now)
    expect(providerHealthOf('chatgpt', now)).toMatchObject({
      down: true,
      downUntil: new Date(now + 10 * 60_000).toISOString(),
      topReason: 'browser_preparation_timeout',
    })
  })

  test('a new chatgpt thread while ChatGPT rests provider-wide fails at once, saying when and why, sends nothing', async () => {
    const now = Date.now()
    for (let n = 0; n < 5; n++) noteProviderOutcome('chatgpt', 'browser_preparation_invalid', now)
    const out = await send([{ prompt: 'no chatgpt', provider: 'chatgpt' }])
    const until = new Date(providerDown('chatgpt', now)!.until).toISOString()
    expect(out.tasks[0]).toMatchObject({
      state: 'failed',
      error: `chatgpt is resting until ${until} after 5 provider-wide failures (browser_preparation_invalid)`,
    })
    expect(ran).toHaveLength(0)
  }, 20_000)
})

describe('continuations, exclusions and the relaunch', () => {
  test('a continuation whose account rests after rate_limited fails at once, unsent, with the rest’s time', async () => {
    threads.push({
      instanceId: 'claude-11',
      provider: 'claude',
      chatId: CHAT,
      title: 'held',
      status: 'done',
      createdAt: 1,
      updatedAt: 2,
      error: null,
    })
    const now = Date.now()
    noteFreeOutcome('claude-11', 'rate_limited', now)
    const out = await run('free_chat', { tasks: [{ prompt: 'refused turn', chat_id: CHAT }] })
    const rest = restingFor('claude-11', now)!
    expect(out.tasks[0]).toMatchObject({
      state: 'failed',
      chat_id: CHAT,
      error: `rate_limited: account resting until ${new Date(rest.until).toISOString()}`,
    })
    expect(ran.some((r) => r.prompt === 'refused turn')).toBe(false)
  })

  test('exclude_accounts keeps a new thread off the listed accounts; a continuation ignores it', async () => {
    const skipped = await send([
      { prompt: 'skip eleven', provider: 'claude', exclude_accounts: [11] },
    ])
    expect(skipped.tasks[0].account).toBe('#12 claude (Example 12)')
    const first = await send([{ prompt: 'thread', account: 11 }])
    const chat = first.tasks[0].chat_id as string
    const again = await send([{ prompt: 'again', chat_id: chat, exclude_accounts: [11] }])
    expect(again.tasks[0]).toMatchObject({ state: 'done', chat_id: chat })
    expect(ran.find((r) => r.prompt === 'again')?.instance).toBe('claude-11')
  }, 30_000)

  test('rests, leases, last picks and the outcome log survive a reload of free-health.json; expired rests are dropped', async () => {
    const now = Date.now()
    noteFreeOutcome('claude-11', 'rate_limited', now)
    noteFreeOutcome('claude-13', 'rate_limited', now - 2 * HOUR)
    for (let n = 0; n < 5; n++) noteProviderOutcome('chatgpt', 'browser_preparation_invalid', now)
    const held = await send([{ prompt: 'held', account: 12 }])
    const before = {
      rest: restingFor('claude-11', now)?.until,
      down: providerDown('chatgpt', now)?.until,
      lease: leaseOf('claude-12', now),
      health: providerHealthOf('chatgpt', now),
    }

    loadFreeHealth(now)

    expect(restingFor('claude-11', now)?.until).toBe(before.rest)
    expect(providerDown('chatgpt', now)?.until).toBe(before.down)
    expect(leaseOf('claude-12', now)).toEqual(before.lease)
    expect(before.lease?.chatId).toBe(held.tasks[0].chat_id)
    expect(providerHealthOf('chatgpt', now)).toEqual(before.health)
    expect(restingFor('claude-13', now)).toBeNull()
    expect(accountOf(await run('free_status', {}), 12).leased).toBe(true)
  }, 20_000)
})
