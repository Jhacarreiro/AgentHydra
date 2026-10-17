// The session rail's last-seen numbers, kept per session so a revisit paints at once and the fresh read replaces them a moment
// later (stale-while-revalidate; owner, 2026-10-17: the rail's cards "pop in slowly"). In memory, and in this browser's
// localStorage under a versioned key so a reload keeps them too. Only numbers and labels are kept (the tokens summary, the
// delegation stats, the connectors' names and states): never transcript text, a prompt or a secret. The newest RAIL_KEPT
// sessions stay; the least recently used go first. Nothing here is sent anywhere.
import type { ServiceStats } from './delegation'
import type { AhUsage } from '@/components/session-header/logic'
import type { ConnectorView } from '@shared/connectors'

const STORE_KEY = 'hydra-desk.rail-cache.v1'
export const RAIL_KEPT = 200

/** A connector as the rail draws it: its label and state, none of the connector's settings. */
export type CachedConnector = Pick<ConnectorView, 'id' | 'name' | 'givesChats'> & { state?: string; reason?: string }

export interface RailFacts {
  usage?: AhUsage
  delegation?: ServiceStats[]
}

interface Store {
  /** Least recently used first. */
  sessions: [string, RailFacts][]
  connectors?: CachedConnector[]
}

let memory: Map<string, RailFacts> | null = null
let connectors: CachedConnector[] | null = null

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

function load(): Map<string, RailFacts> {
  if (memory) return memory
  memory = new Map()
  try {
    const raw = storage()?.getItem(STORE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<Store>) : null
    if (parsed && Array.isArray(parsed.sessions)) for (const [id, facts] of parsed.sessions) if (typeof id === 'string' && facts && typeof facts === 'object') memory.set(id, facts)
    if (parsed && Array.isArray(parsed.connectors)) connectors = parsed.connectors
  } catch {
    // another build's or a hand-edited value: start empty
  }
  return memory
}

function save(): void {
  try {
    storage()?.setItem(STORE_KEY, JSON.stringify({ sessions: [...load()], ...(connectors ? { connectors } : {}) } satisfies Store))
  } catch {
    // storage full or off: the memory copy still serves this window
  }
}

/** What the rail last showed for the session (it counts as used), or null. */
export function railFacts(sessionId: string): RailFacts | null {
  const all = load()
  const hit = all.get(sessionId)
  if (!hit) return null
  all.delete(sessionId)
  all.set(sessionId, hit)
  return hit
}

/** Keeps `facts` over what is kept for the session, and drops the least recently used past RAIL_KEPT. */
export function keepRailFacts(sessionId: string, facts: RailFacts): void {
  const all = load()
  const next = { ...all.get(sessionId), ...facts }
  all.delete(sessionId)
  all.set(sessionId, next)
  while (all.size > RAIL_KEPT) all.delete(all.keys().next().value!)
  save()
}

/** The connectors list last seen (it is the same for every chat), or null. */
export function cachedConnectors(): CachedConnector[] | null {
  load()
  return connectors
}

export function keepConnectors(list: readonly ConnectorView[]): void {
  load()
  connectors = list.map((c) => ({ id: c.id, name: c.name, givesChats: c.givesChats, state: c.state, reason: c.reason }))
  save()
}

/** Forgets everything kept (a test's). */
export function resetRailCache(): void {
  memory = null
  connectors = null
  try {
    storage()?.removeItem(STORE_KEY)
  } catch {
    // nothing to remove
  }
}
