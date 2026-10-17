import { expect, test } from 'bun:test'
import type { FreeInstance } from '../../shared/free-instances'
import { poolCount, poolVictims } from '../src/free-instances/pool-policy'

function row(num: number, fields: Partial<FreeInstance> = {}): FreeInstance {
  return {
    id: `00000000-0000-4000-8000-${String(num).padStart(12, '0')}`,
    num,
    provider: 'chatgpt',
    name: 'Example account',
    autoName: false,
    email: `account${num}@example.test`,
    loggedIn: true,
    checkedAt: 10,
    lastSignedInAt: 10,
    lastActiveAt: num,
    plan: 'free',
    usage: null,
    ...fields,
  }
}
const idle = () => false

test('the configured web limit counts distinct active Free and Go identities, never paid or retired copies', () => {
  const first = row(1)
  const rows = [
    first,
    row(2, { email: first.email?.toUpperCase() }),
    row(3, { plan: 'go' }),
    row(4, { plan: 'plus' }),
    row(5, { loggedIn: false }),
    row(6, { poolState: 'retired' }),
    row(7, { plan: null }),
    row(8, { provider: 'claude' }),
  ]
  expect(poolCount(rows, 'chatgpt')).toBe(3)
  expect(poolCount(rows, 'claude')).toBe(1)
  expect(poolCount([{ ...first, movedAway: { at: 1 } } as FreeInstance], 'chatgpt')).toBe(0)
})

test('Go retires the entire idle Free identity group but never another Go or a protected duplicate', () => {
  const first = row(1)
  const duplicate = row(2, { email: first.email?.toUpperCase() })
  const go = row(3, { plan: 'go' })
  const incoming = row(4, { plan: 'go', poolState: 'pending' })
  expect(poolVictims([first, duplicate, go, incoming], incoming, 'go', 2, idle)).toEqual([
    first,
    duplicate,
  ])
  for (const protectedCopy of [
    row(2, { email: first.email, plan: 'go' }),
    row(2, { email: first.email, plan: 'plus' }),
    row(2, { email: first.email, plan: null }),
    row(2, { email: first.email, poolState: 'pending' }),
    { ...duplicate, movedAway: { at: 1 } } as FreeInstance,
  ]) {
    expect(poolVictims([first, protectedCopy, go, incoming], incoming, 'go', 2, idle)).toBeNull()
  }
  expect(
    poolVictims([first, duplicate, go, incoming], incoming, 'go', 2, (id) => id === duplicate.id),
  ).toBeNull()
})

test('Free cannot displace healthy Free, Go or unknown plans and zero never creates a new slot', () => {
  const incoming = row(9, { poolState: 'pending' })
  for (const plan of ['free', 'go', null]) {
    expect(poolVictims([row(1, { plan }), incoming], incoming, 'free', 1, idle)).toBeNull()
  }
  expect(poolVictims([incoming], incoming, 'free', 0, idle)).toBeNull()
  expect(poolVictims([row(1, { plan: 'go' }), incoming], incoming, 'go', 1, idle)).toBeNull()
  expect(poolVictims([row(1), row(2), incoming], incoming, 'go', 1, idle)).toEqual([row(1)])
})

test('an unused slot can replace a known signed-out Free while transient health is irrelevant', () => {
  const dead = row(1, { loggedIn: false })
  const live = row(2)
  const incoming = row(3, { poolState: 'pending' })
  expect(poolCount([dead, live, incoming], 'chatgpt')).toBe(1)
  expect(poolVictims([dead, live, incoming], incoming, 'free', 2, idle)).toEqual([dead])
  expect(
    poolVictims(
      [row(1, { loggedIn: false, checkedAt: null }), live, incoming],
      incoming,
      'free',
      2,
      idle,
    ),
  ).toEqual([])
  // A dead row cannot free another live account's slot when the live pool is already full.
  expect(poolVictims([dead, live, incoming], incoming, 'free', 1, idle)).toBeNull()
})

test('pending live renewals reserve their old slot and cannot be displaced through a duplicate', () => {
  const before = row(1)
  const pending = row(1, {
    poolState: 'pending',
    poolAdmission: {
      requestId: crypto.randomUUID(),
      email: before.email!,
      plan: 'free',
      limit: 1,
      existing: true,
      state: 'pending',
      before,
    },
  })
  const duplicate = row(2, { email: before.email })
  const incoming = row(3, { poolState: 'pending' })
  expect(poolCount([pending, duplicate, incoming], 'chatgpt')).toBe(1)
  expect(poolVictims([pending, duplicate, incoming], incoming, 'go', 1, idle)).toBeNull()
  expect(
    poolVictims([pending, row(2, { poolState: 'retired' }), incoming], incoming, 'free', 2, idle),
  ).toEqual([])
})
