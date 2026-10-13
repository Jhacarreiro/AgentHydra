import { SYNONYMS, words } from '../mcp-find'
import type { CatalogEntry, Kind } from './catalog'

export interface FindOpts {
  kinds?: readonly Kind[]
  mode?: string
  start?: number
  limit?: number
}

export interface Match {
  id: string
  kind: Kind
  name: string
  title?: string
  when: string
  cost: string
  how: string
}

export const PAGE = 5

export function modesOf(e: CatalogEntry): string[] {
  return e.kind === 'person' ? (e.modes ?? []) : ['load']
}

function terms(need: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const w of words(need)) {
    out.set(w, 1)
    for (const s of SYNONYMS[w] ?? []) out.set(s, Math.max(out.get(s) ?? 0, 0.6))
  }
  return out
}

/** A word in the name weighs 5, in the title, tags or when 2, in the how 1; synonyms count at 0.6. */
export function scoreEntry(e: CatalogEntry, need: Map<string, number>): number {
  const name = new Set(words(e.name))
  const near = new Set(words([e.title ?? '', e.tags.join(' '), e.when].join(' ')))
  const how = new Set(words(e.how))
  let score = 0
  for (const [w, tw] of need) {
    if (name.has(w)) score += 5 * tw
    if (near.has(w)) score += 2 * tw
    if (how.has(w)) score += tw
  }
  return score
}

export function findPage(
  entries: Iterable<CatalogEntry>,
  need: string,
  opts: FindOpts = {},
): { ids: string[]; total: number } {
  const t = terms(need)
  const scored: { id: string; score: number }[] = []
  if (t.size)
    for (const e of entries) {
      if (opts.kinds && !opts.kinds.includes(e.kind)) continue
      if (opts.mode && !modesOf(e).includes(opts.mode)) continue
      const score = scoreEntry(e, t)
      if (score > 0) scored.push({ id: e.id, score })
    }
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const start = opts.start ?? 0
  const limit = opts.limit ?? PAGE
  return { ids: scored.slice(start, start + limit).map((s) => s.id), total: scored.length }
}

export function matchOf(e: CatalogEntry): Match {
  const m: Match = { id: e.id, kind: e.kind, name: e.name, when: e.when, cost: e.cost, how: e.how }
  if (e.title) m.title = e.title
  return m
}
