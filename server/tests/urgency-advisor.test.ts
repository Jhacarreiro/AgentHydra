import { describe, expect, test } from 'bun:test'
import {
  type AdvisorChat,
  type AdvisorDeps,
  advisorPass,
  FALLBACK_LINE,
  type Memory,
  nudgeText,
} from '../src/urgency-advisor'

const MIN = 60_000
const T0 = 1_000_000_000_000

function rig(chats: AdvisorChat[], enabled = true) {
  let clock = T0
  let mem: Memory = {}
  const sent: { id: string; text: string }[] = []
  const deps: AdvisorDeps = {
    now: () => clock,
    settings: () => ({ enabled, intervalMinutes: 30 }),
    chats: async () => chats,
    send: async (id, text) => {
      sent.push({ id, text })
    },
    persona: () => ({ name: 'Test Name', lines: ['{title} has run {minutes} min.'] }),
    load: () => mem,
    save: (m) => {
      mem = m
    },
    log: () => {},
  }
  return { deps, sent, at: (m: number) => (clock = T0 + m * MIN) }
}

const working = (id: string, title: string): AdvisorChat => ({
  id,
  title,
  status: 'working',
  turnStartedAt: T0,
})

describe('urgency advisor', () => {
  test('29 min nothing, 31 one nudge, 45 nothing, 61 a second', async () => {
    const r = rig([working('c1', 'Invented chat')])
    r.at(29)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(0)
    r.at(31)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(1)
    r.at(45)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(1)
    r.at(61)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(2)
    expect(r.sent[1]?.text).toContain('has run 61 min.')
  })

  test('the text matches the contract exactly', async () => {
    const r = rig([working('c1', 'Invented chat')])
    r.at(31)
    await advisorPass(r.deps)
    expect(r.sent[0]?.text).toBe(
      "[Urgency Advisor · Test Name] Sent on the owner's behalf.\n\nInvented chat has run 31 min.",
    )
    expect(nudgeText('X', FALLBACK_LINE, 40, 'T')).toStartWith(
      "[Urgency Advisor · X] Sent on the owner's behalf.\n\n",
    )
  })

  test('idle, waiting-on-owner and drone-worker chats get nothing', async () => {
    const r = rig([
      { ...working('i', 'Idle'), status: 'idle' },
      { ...working('q', 'Question'), status: 'needs_you' },
      { ...working('w', 'Drone'), workerId: 'w-1' },
    ])
    r.at(40)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(0)
  })

  test('a seat that is a worker is still nudged', async () => {
    const r = rig([{ ...working('s', 'Seat'), workerId: 'w-2', manager: { role: 'seat' } }])
    r.at(40)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(1)
  })

  test('the setting off sends nothing', async () => {
    const r = rig([working('c1', 'Invented chat')], false)
    r.at(90)
    await advisorPass(r.deps)
    expect(r.sent).toHaveLength(0)
  })
})
