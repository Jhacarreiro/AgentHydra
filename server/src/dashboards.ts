// server/src/dashboards.ts - one small dashboard per project (its checkout), written by any AI through the agenthydra
// MCP and drawn by AgentHydra's window. One JSON file per workspace under DATA_DIR/dashboards, named by a sha1 of the
// workspace key; writes to one workspace are serialized in this process so two AIs writing at once keep both widgets.
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { DATA_DIR } from './config'
import { writeJsonTextAtomic } from './core/json-store'

export const WIDGET_KINDS = ['stat', 'list', 'note', 'progress', 'chart'] as const
export type WidgetKind = (typeof WIDGET_KINDS)[number]
export type Tone = 'good' | 'bad' | 'warn' | 'neutral'
export type WidgetSize = 'small' | 'wide'

export interface DashboardItem {
  text: string
  detail?: string
  href?: string
  tone?: Tone
  done?: boolean
}

export interface DashboardSeries {
  label?: string
  points: number[]
}

export interface DashboardWidget {
  id: string
  kind: WidgetKind
  title: string
  order?: number
  size?: WidgetSize
  value?: string | number
  unit?: string
  delta?: string
  tone?: Tone
  caption?: string
  items?: DashboardItem[]
  text?: string
  current?: number
  max?: number
  series?: DashboardSeries[]
  labels?: string[]
  updatedAt: string
  updatedBy: string
}

export type WidgetInput = Omit<DashboardWidget, 'updatedAt' | 'updatedBy'>

export interface Dashboard {
  workspace: string
  name: string
  widgets: DashboardWidget[]
  updatedAt: string | null
}

export interface DashboardSummary {
  workspace: string
  name: string
  widgets: number
  updatedAt: string
}

export class DashboardError extends Error {}

export const MAX_WIDGETS = 40
export const MAX_WIDGET_BYTES = 32 * 1024
const MAX_TITLE = 80
const MAX_ITEMS = 50
const MAX_NOTE = 8000
const MAX_SERIES = 4
const MAX_POINTS = 200
const MAX_BY = 60
const DEFAULT_BY = 'the person'
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/
const TONES: readonly Tone[] = ['good', 'bad', 'warn', 'neutral']

type Obj = Record<string, unknown>

/** The workspace key: the nearest checkout (a folder with .git) up from `folder`, else the folder itself. */
export function workspaceOf(folder: string): string {
  let real: string
  try {
    real = realpathSync.native(resolve(folder))
  } catch {
    throw new DashboardError(`cwd is not an existing folder: ${folder}`)
  }
  let at = real
  for (;;) {
    if (existsSync(join(at, '.git'))) return at.replace(/\\/g, '/')
    const up = dirname(at)
    if (up === at) return real.replace(/\\/g, '/')
    at = up
  }
}

function fileFor(workspace: string): string {
  const key = process.platform === 'win32' ? workspace.toLowerCase() : workspace
  const digest = createHash('sha1').update(key).digest('hex')
  return join(DATA_DIR, 'dashboards', `${digest}.json`)
}

function emptyDashboard(workspace: string): Dashboard {
  return { workspace, name: basename(workspace), widgets: [], updatedAt: null }
}

function fail(message: string): never {
  throw new DashboardError(message)
}

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function optStr(o: Obj, key: string, where: string, max?: number): string | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') fail(`${where}: ${key} must be text`)
  if (max !== undefined && v.length > max) fail(`${where}: ${key} is over ${max} characters`)
  return v
}

function optNum(o: Obj, key: string, where: string): number | undefined {
  const v = o[key]
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(`${where}: ${key} must be a finite number`)
  return v
}

function optTone(o: Obj, where: string): Tone | undefined {
  const v = o.tone
  if (v === undefined || v === null) return undefined
  if (!TONES.includes(v as Tone)) fail(`${where}: tone must be one of ${TONES.join(', ')}`)
  return v as Tone
}

function checkHref(href: string, where: string): string {
  if (href.trim() === '') fail(`${where}: href is empty`)
  if (/^https?:\/\//i.test(href)) return href
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href))
    fail(`${where}: href must be an http(s) link or a file path`)
  return href
}

function checkItem(raw: unknown, where: string): DashboardItem {
  if (!isObj(raw)) fail(`${where}: each item must be an object`)
  const text = optStr(raw, 'text', where)
  if (text === undefined) fail(`${where}: each item needs text`)
  const out: DashboardItem = { text }
  const detail = optStr(raw, 'detail', where)
  if (detail !== undefined) out.detail = detail
  const href = optStr(raw, 'href', where)
  if (href !== undefined) out.href = checkHref(href, where)
  const tone = optTone(raw, where)
  if (tone !== undefined) out.tone = tone
  if (raw.done !== undefined && raw.done !== null) {
    if (typeof raw.done !== 'boolean') fail(`${where}: done must be true or false`)
    out.done = raw.done
  }
  return out
}

function checkPoints(raw: unknown, where: string): number[] {
  if (!Array.isArray(raw)) fail(`${where}: points must be a list of numbers`)
  if (raw.length > MAX_POINTS) fail(`${where}: at most ${MAX_POINTS} points per series`)
  for (const p of raw)
    if (typeof p !== 'number' || !Number.isFinite(p))
      fail(`${where}: points must be finite numbers`)
  return raw as number[]
}

/** One widget as the store keeps it, or a DashboardError naming what is wrong. Unknown fields are dropped. */
export function checkWidget(raw: unknown): WidgetInput {
  if (!isObj(raw)) fail('each widget must be an object')
  const id = raw.id
  if (typeof id !== 'string' || !ID_RE.test(id))
    fail(
      `widget id ${JSON.stringify(id ?? null)} must be 1 to 64 lowercase letters, digits, "-" or "_", starting with a letter or digit`,
    )
  const where = `widget "${id}"`
  const kind = raw.kind
  if (!WIDGET_KINDS.includes(kind as WidgetKind))
    fail(
      `${where}: kind ${JSON.stringify(kind ?? null)} is unknown; kind must be one of ${WIDGET_KINDS.join(', ')}`,
    )
  const title = optStr(raw, 'title', where, MAX_TITLE)
  if (title === undefined || title.trim() === '')
    fail(`${where}: title is required (up to ${MAX_TITLE} characters)`)
  const order = optNum(raw, 'order', where)
  const sizeRaw = raw.size
  if (sizeRaw !== undefined && sizeRaw !== null && sizeRaw !== 'small' && sizeRaw !== 'wide')
    fail(`${where}: size must be small or wide`)
  const size: WidgetSize =
    (sizeRaw as WidgetSize | undefined) ??
    (kind === 'stat' || kind === 'progress' ? 'small' : 'wide')
  const out: WidgetInput = { id, kind: kind as WidgetKind, title, size }
  if (order !== undefined) out.order = order

  if (kind === 'stat') {
    const value = raw.value
    if (value === undefined || value === null) fail(`${where}: a stat needs value`)
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) fail(`${where}: value must be a finite number or text`)
      out.value = value
    } else if (typeof value === 'string') out.value = value
    else fail(`${where}: value must be a number or text`)
    for (const k of ['unit', 'delta', 'caption'] as const) {
      const v = optStr(raw, k, where)
      if (v !== undefined) out[k] = v
    }
    const tone = optTone(raw, where)
    if (tone !== undefined) out.tone = tone
  } else if (kind === 'list') {
    if (!Array.isArray(raw.items)) fail(`${where}: a list needs items`)
    if (raw.items.length > MAX_ITEMS) fail(`${where}: at most ${MAX_ITEMS} items`)
    out.items = raw.items.map((i) => checkItem(i, where))
  } else if (kind === 'note') {
    const text = optStr(raw, 'text', where, MAX_NOTE)
    if (text === undefined)
      fail(`${where}: a note needs text (markdown, up to ${MAX_NOTE} characters)`)
    out.text = text
  } else if (kind === 'progress') {
    const current = optNum(raw, 'current', where)
    const max = optNum(raw, 'max', where)
    if (current === undefined || max === undefined)
      fail(`${where}: a progress widget needs current and max`)
    out.current = current
    out.max = max
  } else {
    if (!Array.isArray(raw.series)) fail(`${where}: a chart needs series`)
    if (raw.series.length > MAX_SERIES) fail(`${where}: at most ${MAX_SERIES} series`)
    out.series = raw.series.map((s) => {
      if (!isObj(s)) fail(`${where}: each series must be an object`)
      const series: DashboardSeries = { points: checkPoints(s.points, where) }
      const label = optStr(s, 'label', where)
      if (label !== undefined) series.label = label
      return series
    })
    if (raw.labels !== undefined && raw.labels !== null) {
      if (!Array.isArray(raw.labels) || raw.labels.some((l) => typeof l !== 'string'))
        fail(`${where}: labels must be a list of text`)
      out.labels = raw.labels as string[]
    }
  }

  if (Buffer.byteLength(JSON.stringify(out)) > MAX_WIDGET_BYTES)
    fail(`${where} is over ${MAX_WIDGET_BYTES / 1024} KB of JSON`)
  return out
}

export interface DashboardChange {
  put: WidgetInput[]
  remove: string[]
  clear: boolean
  by: string
}

/** The body of a write, checked whole: any refusal means nothing is written. */
export function parseChange(raw: unknown): DashboardChange {
  if (!isObj(raw)) fail('the body must be an object with cwd, put, remove, clear, by')
  if (raw.put !== undefined && raw.put !== null && !Array.isArray(raw.put))
    fail('put must be a list of widgets')
  const put = ((raw.put as unknown[] | undefined) ?? []).map(checkWidget)
  if (raw.remove !== undefined && raw.remove !== null && !Array.isArray(raw.remove))
    fail('remove must be a list of widget ids')
  const remove = ((raw.remove as unknown[] | undefined) ?? []).map((id) => {
    if (typeof id !== 'string' || !ID_RE.test(id))
      fail(`remove: ${JSON.stringify(id ?? null)} is not a widget id`)
    return id as string
  })
  if (raw.clear !== undefined && raw.clear !== null && typeof raw.clear !== 'boolean')
    fail('clear must be true or false')
  let by = DEFAULT_BY
  if (raw.by !== undefined && raw.by !== null) {
    if (typeof raw.by !== 'string' || raw.by.trim() === '')
      fail('by must be a name of up to 60 characters')
    if (raw.by.length > MAX_BY) fail(`by is over ${MAX_BY} characters`)
    by = raw.by.trim()
  }
  return { put, remove, clear: raw.clear === true, by }
}

function sortWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  return [...widgets].sort((a, b) => {
    const ao = a.order ?? Number.POSITIVE_INFINITY
    const bo = b.order ?? Number.POSITIVE_INFINITY
    if (ao !== bo) return ao < bo ? -1 : 1
    return a.updatedAt < b.updatedAt ? -1 : a.updatedAt > b.updatedAt ? 1 : 0
  })
}

function applyChange(current: Dashboard, change: DashboardChange, now: string): Dashboard {
  let widgets = change.clear ? [] : current.widgets
  if (change.remove.length) widgets = widgets.filter((w) => !change.remove.includes(w.id))
  const byId = new Map(widgets.map((w) => [w.id, w]))
  for (const w of change.put) byId.set(w.id, { ...w, updatedAt: now, updatedBy: change.by })
  const next = [...byId.values()]
  if (next.length > MAX_WIDGETS)
    fail(
      `a workspace holds at most ${MAX_WIDGETS} widgets; this change would leave ${next.length}. Remove some first.`,
    )
  return { ...current, widgets: sortWidgets(next), updatedAt: now }
}

async function readStored(workspace: string): Promise<Dashboard | null> {
  let text: string
  try {
    text = await readFile(fileFor(workspace), 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  return JSON.parse(text) as Dashboard
}

/** Writes to one workspace run one after another in this process: each reads the file the one before wrote. */
const queues = new Map<string, Promise<unknown>>()
function serialized<T>(workspace: string, fn: () => Promise<T>): Promise<T> {
  const key = fileFor(workspace)
  const next = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(fn)
  const tail = next.catch(() => {})
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return next
}

export async function readDashboard(folder: string): Promise<Dashboard> {
  const workspace = workspaceOf(folder)
  return (await readStored(workspace)) ?? emptyDashboard(workspace)
}

export async function writeDashboard(folder: string, raw: unknown): Promise<Dashboard> {
  const change = parseChange(raw)
  const workspace = workspaceOf(folder)
  return serialized(workspace, async () => {
    const current = (await readStored(workspace)) ?? emptyDashboard(workspace)
    const changed = change.clear || change.remove.length > 0 || change.put.length > 0
    if (!changed) return current
    const next = applyChange(current, change, new Date().toISOString())
    await writeJsonTextAtomic(fileFor(workspace), JSON.stringify(next, null, 2))
    return next
  })
}

/** Every workspace with at least one widget, newest first. A file that does not parse is skipped. */
export async function listDashboards(): Promise<DashboardSummary[]> {
  let names: string[]
  try {
    names = await readdir(join(DATA_DIR, 'dashboards'))
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const found = await Promise.all(
    names
      .filter((n) => n.endsWith('.json'))
      .map(async (n) => {
        try {
          const d = JSON.parse(await readFile(join(DATA_DIR, 'dashboards', n), 'utf8')) as Dashboard
          return d.widgets.length && d.updatedAt
            ? {
                workspace: d.workspace,
                name: d.name,
                widgets: d.widgets.length,
                updatedAt: d.updatedAt,
              }
            : null
        } catch {
          return null
        }
      }),
  )
  return found
    .filter((s): s is DashboardSummary => s !== null)
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
}
