// A project's dashboard: the widgets its AIs put there through the agenthydra MCP (dashboard_write), read by the window
// through Desk's /ah/api/dashboards routes. The daemon keeps one per checkout; a widget's id is unique within it.

export type DashboardWidgetKind = 'stat' | 'list' | 'note' | 'progress' | 'chart'
export type DashboardTone = 'good' | 'bad' | 'warn' | 'neutral'
export type DashboardWidgetSize = 'small' | 'wide'

export interface DashboardListItem {
  text: string
  detail?: string
  /** An http(s) address opens in the browser; a file path is revealed on the PC. */
  href?: string
  tone?: DashboardTone
  done?: boolean
}

export interface DashboardSeries {
  label?: string
  points: number[]
}

export interface DashboardWidget {
  id: string
  kind: DashboardWidgetKind
  title: string
  order?: number
  /** small = one third of the row, wide = the full row. Default: small for stat and progress, wide for the rest. */
  size?: DashboardWidgetSize
  value?: string | number
  unit?: string
  delta?: string
  tone?: DashboardTone
  caption?: string
  items?: DashboardListItem[]
  /** Markdown. */
  text?: string
  current?: number
  max?: number
  series?: DashboardSeries[]
  labels?: string[]
  updatedAt: string
  updatedBy: string
}

export type DashboardWidgetInput = Omit<DashboardWidget, 'updatedAt' | 'updatedBy'>

export interface Dashboard {
  /** The project's checkout, forward slashes. */
  workspace: string
  name: string
  /** Already sorted. */
  widgets: DashboardWidget[]
  updatedAt: string | null
}

export interface DashboardSummary {
  workspace: string
  name: string
  widgets: number
  updatedAt: string | null
}

export interface DashboardList {
  dashboards: DashboardSummary[]
}

export interface DashboardWriteBody {
  cwd: string
  remove?: string[]
  put?: DashboardWidgetInput[]
  clear?: boolean
  by?: string
}
