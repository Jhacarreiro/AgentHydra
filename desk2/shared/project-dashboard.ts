// The project dashboard template: one page in AgentHydra's own look, drawn from a fixed set of section types, which any
// project fills from a data source of its choice (an MCP tool or an HTTP endpoint). Two documents meet here:
//
// - the spec, a small file in the project's checkout (SPEC_FILE): the page's sections in order, and where each one's
//   data comes from;
// - the feed, what every source answers (FEED_FORMAT): each section's data keyed by its id, one typed shape per section
//   type, optionally one per range (Today, 7 days, 30 days).
//
// Desk 2's server reads the spec, asks the sources, checks every answer here and keeps the last good one
// (server/src/project-dashboard/); the window draws it (web/src/components/dashboard/template/), and Project Hydra draws
// the same answer from Desk 2's GET /api/project-dashboard. No other copy of these shapes exists.
//
// null in a number is NOT MEASURED: drawn as a dash with its reason, never as zero.

/** Where a project keeps its spec, relative to its checkout. */
export const SPEC_FILE = '.agenthydra/dashboard.json'
/** What a source's answer says it is. */
export const FEED_FORMAT = 'agenthydra-dashboard/1'

export const RANGES = ['today', '7d', '30d'] as const
export type RangeId = (typeof RANGES)[number]
export const RANGE_LABEL: Record<RangeId, string> = { today: 'Today', '7d': '7 days', '30d': '30 days' }
/** "against <this>", for a tile's change. */
export const RANGE_BEFORE: Record<RangeId, string> = { today: 'the day before', '7d': 'the 7 days before', '30d': 'the 30 days before' }

export const SECTION_TYPES = ['stats', 'list', 'errors', 'breakdown'] as const
export type SectionType = (typeof SECTION_TYPES)[number]

/** The icons a spec may name for a section or a tile; each app draws them from its own icon set. */
export const ICONS = ['users', 'user-plus', 'mail', 'hand', 'bug', 'bot', 'globe', 'list', 'chart', 'clock', 'alert', 'check', 'star', 'money', 'bolt', 'apps'] as const
export type IconName = (typeof ICONS)[number]
/** The icon a section shows when its spec names none. */
export const TYPE_ICON: Record<SectionType, IconName> = { stats: 'chart', list: 'list', errors: 'bug', breakdown: 'globe' }

/** Rows a list, errors or breakdown section shows before "Show N more". */
export const DEFAULT_SHOW = 5
export const DEFAULT_REFRESH_MINUTES = 5

// The spec

/** An MCP tool call: `server` is the name of an MCP server in the person's Claude config (~/.claude.json mcpServers). */
export interface McpSourceSpec {
  mcp: { server: string; tool: string; arguments?: Record<string, unknown> }
}
/** A GET of an HTTP endpoint. A header value may hold ${env:NAME}, read from the environment at each call. */
export interface HttpSourceSpec {
  http: { url: string; headers?: Record<string, string> }
}
export type SourceSpec = McpSourceSpec | HttpSourceSpec

export interface SectionSpec {
  /** Unique in the spec; also the key of this section's data in its source's answer, unless `key` says otherwise. */
  id: string
  type: SectionType
  title: string
  /** The source's id in `sources`; may be left out when the spec has one source. */
  source?: string
  /** The section's key in the answer's `sections`, when it differs from `id`. */
  key?: string
  icon?: IconName
  /** Rows shown before "Show N more" (list, errors, breakdown). */
  show?: number
  /** A list of things that need the person: a dot beside its title while it has any. */
  attention?: boolean
}

export interface DashboardSpec {
  title?: string
  /** How often each source is read while the dashboard is open, in minutes (1 to 1440). */
  refreshMinutes?: number
  sources: Record<string, SourceSpec>
  sections: SectionSpec[]
}

// The feed: what a source answers

export interface StatTile {
  label: string
  /** null: not measured; `note` says why. */
  value: number | null
  /** A floor when the exact count is not known (shown as "50+"). */
  atLeast?: number
  /** Percent change against the window before; null or absent when there is none. */
  change?: number | null
  unit?: 'count' | 'percent'
  icon?: IconName
  /** Where the number comes from, or why it is missing: the tile's tooltip. */
  note?: string
}
export interface StatsData {
  tiles: StatTile[]
}

export interface ListItem {
  title: string
  /** When it started waiting (ISO 8601): the row shows its age. */
  since?: string | null
  tags?: string[]
  /** 1 is the most urgent, 4 the least: a small meter of rising bars. */
  priority?: 1 | 2 | 3 | 4 | null
  /** Someone is on it now. */
  active?: boolean
  note?: string
  href?: string
}
export interface ListData {
  items: ListItem[]
  /** How many there are in all, when `items` is only the first of them ("15 of 337"). */
  total?: number
}

export interface ErrorGroup {
  message: string
  /** Where it happens: a host, a service. */
  source?: string
  count: number
  kind?: string
  path?: string
  severity?: string
  href?: string
}
export interface ErrorsData {
  groups: ErrorGroup[]
  /** Open errors in all ("11 open"); null: not measured. */
  open?: number | null
  note?: string
}

export interface BreakdownRow {
  label: string
  value: number
  icon?: IconName
  note?: string
}
export interface BreakdownData {
  rows: BreakdownRow[]
  note?: string
}

export type SectionData = StatsData | ListData | ErrorsData | BreakdownData
export interface SectionDataOf {
  stats: StatsData
  list: ListData
  errors: ErrorsData
  breakdown: BreakdownData
}

/** A section that could not be filled, and why. */
export interface Missing {
  missing: string
}
/** One answer for each range the source measures. */
export interface Ranged<T> {
  ranges: Partial<Record<RangeId, T | Missing>>
}
export type SectionFeed<T = SectionData> = T | Missing | Ranged<T>

export interface DashboardFeed {
  format?: typeof FEED_FORMAT
  /** When the numbers were made (ISO 8601). */
  generatedAt?: string
  /** How often the source makes new numbers, in minutes: the page says when they are late. */
  everyMinutes?: number
  sections: Record<string, SectionFeed>
}

// What Desk 2 serves (GET /api/project-dashboard?cwd=): the spec, checked and filled

export interface FilledSection {
  id: string
  type: SectionType
  title: string
  icon: IconName
  show: number
  attention: boolean
  /** Checked data, or null with `missing` saying why. */
  feed: SectionFeed | null
  missing: string | null
}

export interface SourceState {
  id: string
  /** "MCP connections-local · connections_execute", "HTTP example.com". */
  label: string
  /** The last good answer's times; null until one arrives. */
  fetchedAt: string | null
  generatedAt: string | null
  everyMinutes: number | null
  /** The last read failed (the last good answer, if any, is still shown). */
  error: string | null
  reading: boolean
}

export interface ProjectDashboard {
  /** Changes whenever anything below can: compare it instead of the whole answer. */
  version: string
  /** The checkout, forward slashes. */
  workspace: string
  /** The spec file's absolute path. */
  specFile: string
  title: string
  refreshMinutes: number
  /** The ranges any section answers per range; empty when none does (no range picker). */
  ranges: RangeId[]
  sections: FilledSection[]
  sources: SourceState[]
  /** What is wrong with the spec itself; the page shows the sections it could still read. */
  problems: string[]
}

export interface ProjectDashboardList {
  /** Each checkout among the person's projects that has a spec. */
  dashboards: { workspace: string; title: string }[]
}

// Checks. Each returns the value in the one shape the pages draw, or the problems with where each one is.

/** ok carries the problems it could step past (a row left out), so a provider still hears of them. */
export type Checked<T> = { ok: true; value: T; problems: string[] } | { ok: false; problems: string[] }

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const isText = (v: unknown, max = 2000): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const ID = /^[a-z0-9][a-z0-9_-]{0,63}$/i
const MAX_ROWS = 500
const MAX_TILES = 12
const MAX_SECTIONS = 24

function optText(o: Record<string, unknown>, k: string, at: string, out: string[], max = 2000): string | undefined {
  const v = o[k]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || v.length > max) {
    out.push(`${at}.${k} must be text of up to ${max} characters`)
    return undefined
  }
  return v
}

function optIcon(o: Record<string, unknown>, at: string, out: string[]): IconName | undefined {
  const v = o.icon
  if (v === undefined || v === null) return undefined
  if (!(ICONS as readonly unknown[]).includes(v)) {
    out.push(`${at}.icon must be one of ${ICONS.join(', ')}`)
    return undefined
  }
  return v as IconName
}

function list<T>(o: Record<string, unknown>, k: string, at: string, out: string[], max: number, one: (v: unknown, at: string) => T | null): T[] {
  const v = o[k]
  if (!Array.isArray(v)) {
    out.push(`${at}.${k} must be a list`)
    return []
  }
  if (v.length > max) out.push(`${at}.${k} has ${v.length} rows; at most ${max} are drawn`)
  const kept: T[] = []
  v.slice(0, max).forEach((row, i) => {
    const got = one(row, `${at}.${k}[${i}]`)
    if (got) kept.push(got)
  })
  return kept
}

function tile(v: unknown, at: string, out: string[]): StatTile | null {
  if (!isObj(v)) return out.push(`${at} must be an object`), null
  if (!isText(v.label, 80)) return out.push(`${at}.label must be text of up to 80 characters`), null
  if (v.value !== null && !isNum(v.value)) return out.push(`${at}.value must be a number, or null when not measured`), null
  const t: StatTile = { label: v.label, value: v.value as number | null }
  if (v.atLeast !== undefined && v.atLeast !== null) {
    if (isNum(v.atLeast)) t.atLeast = v.atLeast
    else out.push(`${at}.atLeast must be a number`)
  }
  if (v.change !== undefined) {
    if (v.change === null || isNum(v.change)) t.change = v.change
    else out.push(`${at}.change must be a number (percent) or null`)
  }
  if (v.unit !== undefined) {
    if (v.unit === 'count' || v.unit === 'percent') t.unit = v.unit
    else out.push(`${at}.unit must be count or percent`)
  }
  const icon = optIcon(v, at, out)
  if (icon) t.icon = icon
  const note = optText(v, 'note', at, out)
  if (note) t.note = note
  return t
}

function item(v: unknown, at: string, out: string[]): ListItem | null {
  if (!isObj(v)) return out.push(`${at} must be an object`), null
  if (!isText(v.title, 500)) return out.push(`${at}.title must be text of up to 500 characters`), null
  const it: ListItem = { title: v.title }
  if (v.since !== undefined && v.since !== null) {
    if (typeof v.since === 'string' && !Number.isNaN(Date.parse(v.since))) it.since = v.since
    else out.push(`${at}.since must be an ISO 8601 time`)
  }
  if (v.tags !== undefined) {
    if (Array.isArray(v.tags) && v.tags.every((t) => isText(t, 60))) it.tags = v.tags as string[]
    else out.push(`${at}.tags must be a list of short texts`)
  }
  if (v.priority !== undefined && v.priority !== null) {
    if (v.priority === 1 || v.priority === 2 || v.priority === 3 || v.priority === 4) it.priority = v.priority
    else out.push(`${at}.priority must be 1, 2, 3 or 4`)
  }
  if (v.active !== undefined) {
    if (typeof v.active === 'boolean') it.active = v.active
    else out.push(`${at}.active must be true or false`)
  }
  const note = optText(v, 'note', at, out)
  if (note) it.note = note
  const href = optText(v, 'href', at, out)
  if (href && /^https?:\/\//.test(href)) it.href = href
  return it
}

function errorGroup(v: unknown, at: string, out: string[]): ErrorGroup | null {
  if (!isObj(v)) return out.push(`${at} must be an object`), null
  if (!isText(v.message, 1000)) return out.push(`${at}.message must be text of up to 1000 characters`), null
  if (!isNum(v.count) || v.count < 0) return out.push(`${at}.count must be a number, 0 or more`), null
  const g: ErrorGroup = { message: v.message, count: v.count }
  for (const k of ['source', 'kind', 'path', 'severity'] as const) {
    const t = optText(v, k, at, out, 300)
    if (t) g[k] = t
  }
  const href = optText(v, 'href', at, out)
  if (href && /^https?:\/\//.test(href)) g.href = href
  return g
}

function breakdownRow(v: unknown, at: string, out: string[]): BreakdownRow | null {
  if (!isObj(v)) return out.push(`${at} must be an object`), null
  if (!isText(v.label, 200)) return out.push(`${at}.label must be text of up to 200 characters`), null
  if (!isNum(v.value)) return out.push(`${at}.value must be a number`), null
  const r: BreakdownRow = { label: v.label, value: v.value }
  const icon = optIcon(v, at, out)
  if (icon) r.icon = icon
  const note = optText(v, 'note', at, out)
  if (note) r.note = note
  return r
}

/** One section's data against its type. */
export function checkSectionData<K extends SectionType>(type: K, raw: unknown, at = 'data'): Checked<SectionDataOf[K]> {
  const out: string[] = []
  if (!isObj(raw)) return { ok: false, problems: [`${at} must be an object`] }
  let value: SectionData
  if (type === 'stats') {
    const tiles = list(raw, 'tiles', at, out, MAX_TILES, (v, a) => tile(v, a, out))
    value = { tiles }
  } else if (type === 'list') {
    const d: ListData = { items: list(raw, 'items', at, out, MAX_ROWS, (v, a) => item(v, a, out)) }
    if (raw.total !== undefined && raw.total !== null) {
      if (isNum(raw.total) && raw.total >= 0) d.total = raw.total
      else out.push(`${at}.total must be a number, 0 or more`)
    }
    value = d
  } else if (type === 'errors') {
    const d: ErrorsData = { groups: list(raw, 'groups', at, out, MAX_ROWS, (v, a) => errorGroup(v, a, out)) }
    if (raw.open !== undefined) {
      if (raw.open === null || isNum(raw.open)) d.open = raw.open
      else out.push(`${at}.open must be a number, or null when not measured`)
    }
    const note = optText(raw, 'note', at, out)
    if (note) d.note = note
    value = d
  } else {
    const d: BreakdownData = { rows: list(raw, 'rows', at, out, MAX_ROWS, (v, a) => breakdownRow(v, a, out)) }
    const note = optText(raw, 'note', at, out)
    if (note) d.note = note
    value = d
  }
  // A list that came back as a list keeps the rows that passed: one bad row costs that row, not the section.
  const fatal = out.some((p) => p === `${at}.tiles must be a list` || p === `${at}.items must be a list` || p === `${at}.groups must be a list` || p === `${at}.rows must be a list`)
  return fatal ? { ok: false, problems: out } : { ok: true, value: value as SectionDataOf[K], problems: out }
}

export const isMissing = (f: unknown): f is Missing => isObj(f) && typeof f.missing === 'string'
export const isRanged = (f: unknown): f is Ranged<unknown> => isObj(f) && isObj(f.ranges)

/** A section's feed (plain, missing, or one per range) against its type; problems name where each is. */
export function checkSectionFeed(type: SectionType, raw: unknown, at: string): { feed: SectionFeed | null; problems: string[] } {
  if (isMissing(raw)) return { feed: { missing: raw.missing.slice(0, 500) }, problems: [] }
  if (isRanged(raw)) {
    const problems: string[] = []
    const ranges: Partial<Record<RangeId, SectionData | Missing>> = {}
    for (const [k, v] of Object.entries(raw.ranges)) {
      if (!(RANGES as readonly string[]).includes(k)) {
        problems.push(`${at}.ranges.${k} is not a range: use ${RANGES.join(', ')}`)
        continue
      }
      if (isMissing(v)) {
        ranges[k as RangeId] = { missing: v.missing.slice(0, 500) }
        continue
      }
      const got = checkSectionData(type, v, `${at}.ranges.${k}`)
      ranges[k as RangeId] = got.ok ? got.value : { missing: `the answer for ${RANGE_LABEL[k as RangeId]} does not fit: ${got.problems[0]}` }
      problems.push(...got.problems)
    }
    if (!Object.keys(ranges).length) return { feed: null, problems: problems.length ? problems : [`${at}.ranges has no range`] }
    return { feed: { ranges }, problems }
  }
  const got = checkSectionData(type, raw, at)
  return { feed: got.ok ? got.value : null, problems: got.problems }
}

/** A source's answer: its sections stay raw here (each is checked against the section that reads it). */
export function checkFeed(raw: unknown): Checked<DashboardFeed> {
  if (!isObj(raw)) return { ok: false, problems: ['the answer must be a JSON object'] }
  if (raw.format !== undefined && raw.format !== FEED_FORMAT) return { ok: false, problems: [`format must be ${FEED_FORMAT}`] }
  if (!isObj(raw.sections)) return { ok: false, problems: ['sections must be an object: each section id and its data'] }
  const out: string[] = []
  const feed: DashboardFeed = { format: FEED_FORMAT, sections: raw.sections as Record<string, SectionFeed> }
  if (raw.generatedAt !== undefined && raw.generatedAt !== null) {
    if (typeof raw.generatedAt === 'string' && !Number.isNaN(Date.parse(raw.generatedAt))) feed.generatedAt = raw.generatedAt
    else out.push('generatedAt must be an ISO 8601 time')
  }
  if (raw.everyMinutes !== undefined && raw.everyMinutes !== null) {
    if (isNum(raw.everyMinutes) && raw.everyMinutes > 0) feed.everyMinutes = raw.everyMinutes
    else out.push('everyMinutes must be a number above 0')
  }
  return out.length ? { ok: false, problems: out } : { ok: true, value: feed, problems: [] }
}

function source(v: unknown, at: string, out: string[]): SourceSpec | null {
  if (!isObj(v)) return out.push(`${at} must be an object with mcp or http`), null
  if (isObj(v.mcp)) {
    const m = v.mcp
    if (!isText(m.server, 120)) return out.push(`${at}.mcp.server must name an MCP server in your Claude config`), null
    if (!isText(m.tool, 120)) return out.push(`${at}.mcp.tool must name the tool to call`), null
    if (m.arguments !== undefined && !isObj(m.arguments)) return out.push(`${at}.mcp.arguments must be an object`), null
    return { mcp: { server: m.server, tool: m.tool, ...(m.arguments ? { arguments: m.arguments as Record<string, unknown> } : {}) } }
  }
  if (isObj(v.http)) {
    const h = v.http
    if (typeof h.url !== 'string' || !/^https?:\/\/\S+$/.test(h.url)) return out.push(`${at}.http.url must be an http or https address`), null
    if (h.headers !== undefined && !(isObj(h.headers) && Object.values(h.headers).every((x) => typeof x === 'string')))
      return out.push(`${at}.http.headers must map header names to text`), null
    return { http: { url: h.url, ...(h.headers ? { headers: h.headers as Record<string, string> } : {}) } }
  }
  return out.push(`${at} must have mcp {server, tool, arguments} or http {url, headers}`), null
}

/** A spec file's content. Sections that cannot be read are left out and named in the problems; the rest still draw. */
export function checkSpec(raw: unknown): { spec: DashboardSpec | null; problems: string[] } {
  if (!isObj(raw)) return { spec: null, problems: ['the spec must be a JSON object with sources and sections'] }
  const problems: string[] = []
  const sources: Record<string, SourceSpec> = {}
  if (!isObj(raw.sources) || !Object.keys(raw.sources).length) problems.push('sources must name at least one source')
  else
    for (const [id, v] of Object.entries(raw.sources)) {
      if (!ID.test(id)) {
        problems.push(`sources.${id}: an id is letters, digits, - and _`)
        continue
      }
      const s = source(v, `sources.${id}`, problems)
      if (s) sources[id] = s
    }
  const ids = Object.keys(sources)
  const sections: SectionSpec[] = []
  if (!Array.isArray(raw.sections) || !raw.sections.length) problems.push('sections must list at least one section')
  else {
    const seen = new Set<string>()
    raw.sections.slice(0, MAX_SECTIONS).forEach((v, i) => {
      const at = `sections[${i}]`
      if (!isObj(v)) return problems.push(`${at} must be an object`)
      if (typeof v.id !== 'string' || !ID.test(v.id)) return problems.push(`${at}.id must be letters, digits, - and _`)
      if (seen.has(v.id)) return problems.push(`${at}.id ${v.id} is used twice`)
      if (!(SECTION_TYPES as readonly unknown[]).includes(v.type)) return problems.push(`${at}.type must be one of ${SECTION_TYPES.join(', ')}`)
      if (!isText(v.title, 80)) return problems.push(`${at}.title must be text of up to 80 characters`)
      const src = v.source === undefined ? (ids.length === 1 ? ids[0] : undefined) : v.source
      if (typeof src !== 'string' || !sources[src]) return problems.push(`${at}.source must name one of the sources (${ids.join(', ') || 'none'})`)
      const s: SectionSpec = { id: v.id, type: v.type as SectionType, title: v.title, source: src }
      if (v.key !== undefined) {
        if (typeof v.key === 'string' && v.key) s.key = v.key
        else problems.push(`${at}.key must be text`)
      }
      const icon = optIcon(v, at, problems)
      if (icon) s.icon = icon
      if (v.show !== undefined) {
        if (Number.isInteger(v.show) && (v.show as number) >= 1 && (v.show as number) <= 50) s.show = v.show as number
        else problems.push(`${at}.show must be a whole number from 1 to 50`)
      }
      if (v.attention !== undefined) {
        if (typeof v.attention === 'boolean') s.attention = v.attention
        else problems.push(`${at}.attention must be true or false`)
      }
      seen.add(v.id)
      sections.push(s)
    })
    if (raw.sections.length > MAX_SECTIONS) problems.push(`sections has ${raw.sections.length}; the first ${MAX_SECTIONS} are drawn`)
  }
  const spec: DashboardSpec = { sources, sections }
  const title = optText(raw, 'title', 'spec', problems, 80)
  if (title) spec.title = title
  if (raw.refreshMinutes !== undefined) {
    if (isNum(raw.refreshMinutes) && raw.refreshMinutes >= 1 && raw.refreshMinutes <= 1440) spec.refreshMinutes = raw.refreshMinutes
    else problems.push('refreshMinutes must be a number from 1 to 1440')
  }
  return { spec: sections.length ? spec : null, problems }
}

/** The data a section shows for a range: its one answer, or its answer for that range (null when it has none). */
export function forRange<T extends SectionData>(feed: SectionFeed<T> | null, range: RangeId): T | Missing | null {
  if (!feed) return null
  if (isRanged(feed)) return (feed as Ranged<T>).ranges[range] ?? null
  return feed as T | Missing
}
