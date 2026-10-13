import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

export const KINDS = ['person', 'instrument', 'worker', 'knowledge', 'skill'] as const
export type Kind = (typeof KINDS)[number]
export const MODES = ['become', 'consult', 'hire'] as const
const COSTS = ['free', 'low', 'medium', 'high']
const TIERS = ['employee', 'manager', 'c-suite', 'founder', 'board']
const ID = /^(person|instrument|worker|knowledge|skill):[a-z0-9][a-z0-9-]*$/

export type Load =
  | { type: 'file'; path: string }
  | { type: 'skill'; name: string }
  | { type: 'tool'; call: string }
  | { type: 'none' }

export interface CatalogEntry {
  id: string
  kind: Kind
  name: string
  title?: string
  tier?: string
  when: string
  tags: string[]
  modes?: string[]
  cost: string
  folders?: string[]
  how: string
  load: Load
  source?: string
}

export interface Skip {
  file: string
  id?: string
  why: string
}

export interface Catalog {
  entries: Map<string, CatalogEntry>
  skipped: Skip[]
}

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const texts = (v: unknown): string[] | null =>
  v === undefined
    ? []
    : Array.isArray(v) && v.every((x) => typeof x === 'string')
      ? (v as string[])
      : null

function checkLoad(v: unknown): Load | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (o.type === 'none') return { type: 'none' }
  if (o.type === 'file' && text(o.path)) return { type: 'file', path: text(o.path) as string }
  if (o.type === 'skill' && text(o.name)) return { type: 'skill', name: text(o.name) as string }
  if (o.type === 'tool' && text(o.call)) return { type: 'tool', call: text(o.call) as string }
  return null
}

export function checkEntry(raw: unknown): { entry: CatalogEntry } | { why: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { why: 'not an object' }
  const o = raw as Record<string, unknown>
  const id = text(o.id)
  if (!id || !ID.test(id)) return { why: 'id must be <kind>:<slug>' }
  const kind = o.kind as Kind
  if (!KINDS.includes(kind) || !id.startsWith(`${kind}:`))
    return { why: 'kind must match the id prefix' }
  const name = text(o.name)
  if (!name) return { why: 'name missing' }
  const when = text(o.when)
  if (!when || when.length >= 160) return { why: 'when must be 1 to 159 characters' }
  const how = text(o.how)
  if (!how) return { why: 'how missing' }
  if (!COSTS.includes(o.cost as string)) return { why: 'cost must be free, low, medium or high' }
  if (o.title !== undefined && typeof o.title !== 'string') return { why: 'title must be a string' }
  const tags = texts(o.tags)
  if (!tags) return { why: 'tags must be a list of strings' }
  const folders = texts(o.folders)
  if (!folders) return { why: 'folders must be a list of strings' }
  const load = checkLoad(o.load)
  if (!load) return { why: 'load must be file, skill, tool or none' }
  const entry: CatalogEntry = {
    id,
    kind,
    name,
    when,
    tags,
    cost: o.cost as string,
    how,
    load,
  }
  if (o.title !== undefined) entry.title = o.title as string
  if (folders.length) entry.folders = folders
  if (typeof o.source === 'string') entry.source = o.source
  if (kind === 'person') {
    if (!TIERS.includes(o.tier as string)) return { why: 'a person needs a tier' }
    const modes = texts(o.modes)
    if (!modes?.length || !modes.every((m) => (MODES as readonly string[]).includes(m)))
      return { why: 'a person needs modes from become, consult, hire' }
    entry.tier = o.tier as string
    entry.modes = modes
  }
  return { entry }
}

const rank = (file: string) => (file.startsWith('generated-') ? 0 : 1)

/** Loads catalog/generated-*.json, then catalog/hand-*.json; a hand entry with the same id replaces the generated one. */
export function loadCatalog(dir: string): Catalog {
  const entries = new Map<string, CatalogEntry>()
  const skipped: Skip[] = []
  const root = join(dir, 'catalog')
  if (!existsSync(root)) return { entries, skipped }
  const files = readdirSync(root)
    .filter((f) => /^(generated|hand)-.*\.json$/.test(f))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
  for (const file of files) {
    let list: unknown
    try {
      list = JSON.parse(readFileSync(join(root, file), 'utf8'))
    } catch (e) {
      skipped.push({
        file,
        why: `not readable JSON: ${e instanceof Error ? e.message : String(e)}`,
      })
      continue
    }
    if (!Array.isArray(list)) {
      skipped.push({ file, why: 'not a JSON array' })
      continue
    }
    for (const raw of list) {
      const r = checkEntry(raw)
      if ('why' in r) {
        const id = raw && typeof raw === 'object' ? (raw as { id?: unknown }).id : undefined
        skipped.push({ file, id: typeof id === 'string' ? id : undefined, why: r.why })
      } else entries.set(r.entry.id, r.entry)
    }
  }
  return { entries, skipped }
}

/** How a load is written in a hydra.md line: the file path, the skill name, or the tool call. */
export function loadRef(e: CatalogEntry): string {
  const l = e.load
  if (l.type === 'file') return l.path
  if (l.type === 'skill') return `skill ${l.name}`
  if (l.type === 'tool') return l.call
  return 'none'
}

/** The full text of an entry, read on demand; an unreadable file is named, not thrown. */
export function loadText(e: CatalogEntry): string {
  const l = e.load
  if (l.type === 'file') {
    try {
      return readFileSync(l.path, 'utf8')
    } catch {
      return `(unreadable: ${l.path})`
    }
  }
  if (l.type === 'skill') return `Use the Skill tool with skill "${l.name}".`
  if (l.type === 'tool') return `Run: ${l.call}`
  return ''
}
