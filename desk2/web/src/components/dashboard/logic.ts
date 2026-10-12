import type { DashboardSeries, DashboardSummary, DashboardWidget, DashboardWidgetSize } from '@shared/dashboards'

/** A folder as the dashboards list keys it: forward slashes, no trailing slash, lower case on a Windows drive path. */
export function workspaceKey(path: string): string {
  const slashed = path.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[a-z]:/i.test(slashed) ? slashed.toLowerCase() : slashed
}

export function findDashboard(list: DashboardSummary[] | null, path: string): DashboardSummary | undefined {
  if (!list) return undefined
  const key = workspaceKey(path)
  return list.find((d) => workspaceKey(d.workspace) === key)
}

export function widgetSize(w: Pick<DashboardWidget, 'kind' | 'size'>): DashboardWidgetSize {
  if (w.size) return w.size
  return w.kind === 'stat' || w.kind === 'progress' ? 'small' : 'wide'
}

/** Columns of the card grid at a width in px: three at full width, fewer as the page narrows. */
export function gridColumns(width: number): number {
  if (width >= 720) return 3
  if (width >= 460) return 2
  return 1
}

export function cardSpan(size: DashboardWidgetSize, columns: number): number {
  return size === 'wide' ? columns : 1
}

export const CHART_COLORS = ['var(--accent-text)', 'var(--success-text)', 'var(--warning-text)', 'var(--danger-text)'] as const

export interface ChartLine {
  d: string
  color: string
  label?: string
}

export interface ChartGeometry {
  lines: ChartLine[]
  /** The area under the first series, closed to the baseline. */
  area: string
  yMin: number
  yMax: number
}

/** Y range of every point, padded when they are all equal so the line sits mid-chart. */
export function chartRange(series: DashboardSeries[]): { yMin: number; yMax: number } {
  const values = series.flatMap((s) => s.points).filter((v) => Number.isFinite(v))
  if (!values.length) return { yMin: 0, yMax: 1 }
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  return lo === hi ? { yMin: lo - 1, yMax: hi + 1 } : { yMin: lo, yMax: hi }
}

const r1 = (n: number) => Math.round(n * 10) / 10

export function chartGeometry(series: DashboardSeries[], width: number, height: number): ChartGeometry {
  const { yMin, yMax } = chartRange(series)
  const longest = Math.max(0, ...series.map((s) => s.points.length))
  const x = (i: number) => (longest > 1 ? (i * width) / (longest - 1) : width / 2)
  const y = (v: number) => height - ((v - yMin) / (yMax - yMin)) * height
  const pathOf = (points: number[]) => points.map((v, i) => `${i ? 'L' : 'M'}${r1(x(i))} ${r1(y(v))}`).join(' ')
  const lines = series.flatMap((s, i) =>
    s.points.length ? [{ d: pathOf(s.points), color: CHART_COLORS[i % CHART_COLORS.length]!, label: s.label }] : []
  )
  const first = series[0]?.points ?? []
  const area = first.length ? `${pathOf(first)} L${r1(x(first.length - 1))} ${height} L${r1(x(0))} ${height} Z` : ''
  return { lines, area, yMin, yMax }
}

/** "just now", "3m ago", "2h ago", "5d ago"; empty for a time that does not parse. */
export function timeAgo(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const mins = Math.floor((now - then) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

/** A link the browser opens; anything else in a list item's href is a file path, revealed on the PC. */
export const isWebLink = (href: string): boolean => /^https?:\/\//i.test(href.trim())

export function progressPercent(current: number | undefined, max: number | undefined): number {
  if (!max || !Number.isFinite(max) || max <= 0 || !Number.isFinite(current ?? NaN)) return 0
  return Math.min(100, Math.max(0, Math.round(((current ?? 0) / max) * 100)))
}

export function removeBody(cwd: string, id: string): { cwd: string; remove: string[] } {
  return { cwd, remove: [id] }
}

export const EXAMPLE_PROMPT = "Put this project's current status on its dashboard."
