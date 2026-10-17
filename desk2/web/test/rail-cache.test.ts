// The rail's cache: a revisit finds the last-seen numbers at once, the least recently used session goes first past the bound,
// and a reload (a fresh memory over the same storage) finds them too.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { RAIL_KEPT, cachedConnectors, keepConnectors, keepRailFacts, railFacts, resetRailCache } from '@/components/rail/rail-cache'
import type { AhUsage } from '@/components/session-header/logic'
import type { ConnectorView } from '@shared/connectors'

const real = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
const store = new Map<string, string>()
beforeEach(() => {
  store.clear()
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
  })
  resetRailCache()
})
afterEach(() => {
  if (real) Object.defineProperty(globalThis, 'localStorage', real)
  else delete (globalThis as { localStorage?: unknown }).localStorage
})

const usage = (total: number): AhUsage => ({ status: 'ok', tokens: { input: 1, output: 1, cacheRead: 0, cacheCreation: 0, total, turns: 1 }, costUsd: 0.1, unpricedModels: [], pricesAsOf: '2026-10-01' })

/** A reload: the memory goes, the storage stays. */
function reload() {
  const saved = new Map(store)
  resetRailCache()
  for (const [k, v] of saved) store.set(k, v)
}

test('a kept value is there on the next visit, and survives a reload', () => {
  keepRailFacts('s1', { usage: usage(5) })
  expect(railFacts('s1')?.usage?.tokens.total).toBe(5)
  keepRailFacts('s1', { delegation: [] })
  expect(railFacts('s1')?.usage?.tokens.total).toBe(5) // a second kind of fact does not drop the first
  keepConnectors([{ id: 'c', name: 'Example', givesChats: true, state: 'ready' } as unknown as ConnectorView])
  reload()
  expect(railFacts('s1')?.usage?.tokens.total).toBe(5)
  expect(cachedConnectors()?.[0]?.name).toBe('Example')
})

test('past the bound the least recently used session is dropped', () => {
  for (let i = 0; i < RAIL_KEPT; i++) keepRailFacts(`s${i}`, { usage: usage(i) })
  railFacts('s0') // visited again: s1 is now the oldest
  keepRailFacts('new', { usage: usage(1) })
  expect(railFacts('s0')).not.toBeNull()
  expect(railFacts('s1')).toBeNull()
})
