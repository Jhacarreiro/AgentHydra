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

test('Go replaces one oldest idle live Free below, at and above the cap by default', () => {
  const oldest = row(1)
  const duplicate = row(2, { email: oldest.email?.toUpperCase() })
  const other = row(3)
  const go = row(4, { plan: 'go' })
  const dead = row(5, { loggedIn: false })
  const incoming = row(6, { plan: 'go', poolState: 'pending' })
  for (const limit of [40, 3, 1]) {
    const rows = [oldest, duplicate, other, go, dead, incoming]
    const victims = poolVictims(rows, incoming, 'go', limit, idle)
    expect(victims).toEqual([oldest, duplicate])
    const retired = new Set(victims!.map(i => i.id))
    const next = rows.map(i => i.id === incoming.id ? { ...i, poolState: undefined } : retired.has(i.id) ? { ...i, poolState: 'retired' as const } : i)
    expect(poolCount(next, 'chatgpt')).toBe(poolCount(rows, 'chatgpt'))
  }
  expect(poolVictims([oldest, incoming], incoming, 'go', 0, idle)).toBeNull()
})

test('replacement off never retires live Free but can clean a known dead row in unused capacity', () => {
  const live = row(1)
  const dead = row(2, { loggedIn: false })
  const incoming = row(3, { plan: 'go', poolState: 'pending' })
  const rows = [live, dead, incoming]
  expect(poolVictims(rows, incoming, 'go', 40, idle, false)).toEqual([dead])
  expect(poolVictims([live, incoming], incoming, 'go', 40, idle, false)).toEqual([])
  for (const limit of [1, 0]) expect(poolVictims(rows, incoming, 'go', limit, idle, false)).toBeNull()
})

test('Go replacement never selects busy, paid, unknown, moved or pending identities', () => {
  const incoming = row(10, { plan: 'go', poolState: 'pending' })
  const live = row(1)
  const protectedRows = [
    row(2, { email: live.email, plan: 'go' }),
    row(2, { email: live.email, plan: 'plus' }),
    row(2, { email: live.email, plan: null }),
    row(2, { email: live.email, poolState: 'pending' }),
    { ...row(2, { email: live.email }), movedAway: { at: 1 } } as FreeInstance,
  ]
  for (const copy of protectedRows)
    expect(poolVictims([live, copy, incoming], incoming, 'go', 1, idle)).toBeNull()
  expect(poolVictims([live, incoming], incoming, 'go', 1, id => id === live.id)).toBeNull()
  expect(poolVictims([row(1, { provider: 'claude' }), incoming], incoming, 'go', 40, idle)).toEqual([])
})

test('an already counted identity and Free admission never displace a working bystander', () => {
  const live = row(1)
  const same = row(2, { email: live.email?.toUpperCase(), plan: 'go', poolState: 'pending' })
  const other = row(3)
  expect(poolVictims([live, same, other], same, 'go', 1, idle)).toEqual([])
  const incoming = row(4, { poolState: 'pending' })
  expect(poolVictims([live, incoming], incoming, 'free', 40, idle)).toEqual([])
  expect(poolVictims([live, incoming], incoming, 'free', 1, idle)).toBeNull()
})
