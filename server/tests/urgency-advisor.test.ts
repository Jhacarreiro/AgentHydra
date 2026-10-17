import { describe, expect, test } from 'bun:test'
import {
  type AdvisorChat,
  type AdvisorDeps,
  buildTldr,
  composeBody,
  createAdvisor,
  type Memory,
} from '../src/urgency-advisor'

const MIN = 60_000
const T0 = 1_000_000_000_000
const HEADER = "[Urgency Advisor · Test Name] Sent on the owner's behalf.\n\n"

interface Rig {
  advisor: ReturnType<typeof createAdvisor>
  sent: string[]
  composed: string[]
  chats: AdvisorChat[]
  at: (m: number) => number
  enabled: boolean
  composeOut: (string | null)[]
  answers: (string | null)[]
}

function rig(chats: AdvisorChat[]): Rig {
  let clock = T0
  let mem: Memory = {}
  const r: Rig = {
    advisor: undefined as never,
    sent: [],
    composed: [],
    chats,
    at: (m) => (clock = T0 + m * MIN),
    enabled: true,
    composeOut: [],
    answers: [],
  }
  const deps: AdvisorDeps = {
    now: () => clock,
    settings: () => ({ enabled: r.enabled, intervalMinutes: 30 }),
    chats: async () => r.chats,
    send: async (_c, text) => {
      r.sent.push(text)
    },
    persona: () => ({ name: 'Test Name', lines: ['Fallback for {title} after {minutes}.'] }),
    brief: () => 'BRIEF',
    tldr: async (c) => `TLDR of ${c.title}`,
    compose: async (_c, _s, prompt) => {
      r.composed.push(prompt)
      return r.composeOut.length ? (r.composeOut.shift() ?? null) : 'Model push.'
    },
    baseline: async () => 0,
    answer: async () => (r.answers.length ? (r.answers.shift() ?? null) : null),
    load: () => mem,
    save: (m) => {
      mem = m
    },
    log: () => {},
  }
  r.advisor = createAdvisor(deps)
  return r
}

const working = (id: string, title: string, startedMin = 0): AdvisorChat => ({
  id,
  title,
  status: 'working',
  turnStartedAt: T0 + startedMin * MIN,
})

/** A look every 5 minutes up to `to`, as the minute loop would. */
async function watchTo(r: Rig, to: number) {
  for (let m = 0; m <= to; m += 5) {
    r.at(m)
    await r.advisor.pass()
  }
}

describe('urgency advisor', () => {
  test('visited at 31, 61 and 91 minutes, not in between', async () => {
    const r = rig([working('c1', 'Invented chat')])
    await watchTo(r, 29)
    expect(r.sent).toHaveLength(0)
    r.at(31)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(1)
    r.at(45)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(1)
    r.at(61)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(2)
    r.at(75)
    await r.advisor.pass()
    r.at(91)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(3)
  })

  test('the contract: header line, blank line, then the persona words', async () => {
    const r = rig([working('c1', 'Invented chat')])
    await watchTo(r, 31)
    expect(r.sent[0]).toBe(`${HEADER}Model push.`)
    expect(r.composed[0]).toContain('TLDR of Invented chat')
  })

  test('the streak survives an owner message 30 seconds before the visit', async () => {
    const r = rig([working('c1', 'Invented chat')])
    await watchTo(r, 25)
    r.at(30.4)
    await r.advisor.pass()
    r.chats = [working('c1', 'Invented chat', 30.5)] // the owner's message restarts the turn clock
    r.at(31)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(1)
  })

  test('a chat that just woke from a long idle is not visited', async () => {
    const r = rig([{ ...working('c1', 'Invented chat'), status: 'idle' }])
    await watchTo(r, 55)
    r.chats = [working('c1', 'Invented chat', 58)]
    r.at(60)
    await r.advisor.pass()
    r.at(65)
    await r.advisor.pass()
    expect(r.sent).toHaveLength(0)
  })

  test('idle, waiting-on-owner and drone-worker chats get nothing; a worker seat does', async () => {
    const r = rig([
      { ...working('i', 'Idle'), status: 'idle' },
      { ...working('q', 'Question'), status: 'needs_you' },
      { ...working('w', 'Drone'), workerId: 'w-1' },
      { ...working('s', 'Seat'), workerId: 'w-2', manager: { role: 'seat' } },
    ])
    await watchTo(r, 35)
    expect(r.sent).toHaveLength(1)
    expect(r.composed[0]).toContain('TLDR of Seat')
  })

  test('a weak answer gets a reply; SKIP is honoured', async () => {
    const r = rig([working('c1', 'Invented chat')])
    await watchTo(r, 29)
    r.at(31)
    r.answers = ['It will take another hour.']
    r.composeOut = ['Push.', 'Not good enough. Make it a hundred times faster.']
    await r.advisor.pass()
    expect(r.sent).toEqual([
      `${HEADER}Push.`,
      `${HEADER}Not good enough. Make it a hundred times faster.`,
    ])

    const s = rig([working('c2', 'Other invented chat')])
    await watchTo(s, 29)
    s.at(31)
    s.answers = ['Done, all tests pass.']
    s.composeOut = ['Push.', 'SKIP']
    await s.advisor.pass()
    expect(s.sent).toEqual([`${HEADER}Push.`])
  })

  test('at most 2 replies per visit', async () => {
    const r = rig([working('c1', 'Invented chat')])
    await watchTo(r, 29)
    r.at(31)
    r.answers = ['a1', 'a2', 'a3']
    r.composeOut = ['Push.', 'R1.', 'R2.', 'R3.']
    await r.advisor.pass()
    expect(r.sent).toHaveLength(3)
    expect(r.sent[2]).toBe(`${HEADER}R2.`)
  })

  test('the model failing falls back to the persona line', async () => {
    const r = rig([working('c1', 'Invented chat')])
    r.composeOut = [null]
    await watchTo(r, 31)
    expect(r.sent[0]).toBe(`${HEADER}Fallback for Invented chat after 30.`)
  })

  test('the setting off sends nothing', async () => {
    const r = rig([working('c1', 'Invented chat')])
    r.enabled = false
    await watchTo(r, 95)
    expect(r.sent).toHaveLength(0)
  })

  test('the TL;DR is capped', () => {
    const items = Array.from({ length: 9 }, (_, i) => ({
      kind: i % 2 ? 'user' : 'assistant_text',
      text: 'x'.repeat(5000),
    }))
    expect(buildTldr('T', items).length).toBeLessThanOrEqual(4001)
  })
})

describe('compose body', () => {
  const chat = { id: 'chat-1', title: 'T' } as AdvisorChat

  test('a worker-backed chat sends the config folder of the account its worker runs on', () => {
    const body = composeBody({ ...chat, workerId: 'w1' }, 'S', 'P', (w) =>
      w === 'w1' ? 'C:/acc' : null,
    )
    expect(body).toEqual({ chatId: 'chat-1', system: 'S', prompt: 'P', configDir: 'C:/acc' })
  })

  test('a plain chat sends no config folder and does not look up a worker', () => {
    let asked = false
    const body = composeBody(chat, 'S', 'P', () => {
      asked = true
      return 'C:/acc'
    })
    expect(body).toEqual({ chatId: 'chat-1', system: 'S', prompt: 'P' })
    expect(asked).toBe(false)
  })

  test('a worker whose account is unknown sends no config folder', () => {
    const body = composeBody({ ...chat, workerId: 'w1' }, 'S', 'P', () => null)
    expect(body).toEqual({ chatId: 'chat-1', system: 'S', prompt: 'P' })
    expect('configDir' in body).toBe(false)
  })
})
