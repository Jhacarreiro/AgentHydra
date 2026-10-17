// The Tools tab's sidebar sections, as pure functions: an Overview row, then the Managers group (Babysitter,
// Orchestrator, Instance manager, Routine manager) and the Routines group (its folders, routines and proposals, from
// routine-sidebar.ts). Desk draws them in its one sidebar (useDeskSidebar, shared/hydra-embed.ts); outside Desk
// ToolsView draws the same groups as its own column. Keys: 'overview', 'm:<manager>', then routine-sidebar's f:/r:/p:.
import type { EmbedTone, SidebarRow } from '@desk/shared/hydra-embed'
import type { BabysitterStatus } from '@desk/shared/babysitter'
import type { InstanceManagerStatus } from '@desk/shared/instance-manager'
import type { OrchestratorPlan } from '@desk/shared/orchestrator'
import type { RoutinesStatus } from '@desk/shared/routines'
import { babysitterDot, instanceManagerDot, managerDot, type ManagerDot } from './managers'

export interface ToolsSidebarLabels {
  overview: string
  managers: string
  routines: string
  babysitter: string
  orchestrator: string
  instanceManager: string
  routineManager: string
  on: string
  off: string
  armed: string
  shadow: string
  /** The Babysitter's meta while chats are stopped. */
  stopped: (n: number) => string
  /** The Routine manager's meta while proposals wait for a yes. */
  waiting: (n: number) => string
}

export interface ToolsSidebarArgs {
  babysitter: BabysitterStatus | null
  orchestrator: OrchestratorPlan | null
  instanceManager: InstanceManagerStatus | null
  routines: RoutinesStatus | null
  /** routineSidebarRows' rows for the same query, so the Routines group shows what the search left. */
  routineRows: SidebarRow[]
  query: string
  labels: ToolsSidebarLabels
}

type Sections = { key: string; label?: string; count?: number; rows: SidebarRow[] }[]

const TONE: Record<ManagerDot, EmbedTone> = { ok: 'success', warn: 'warning', off: 'muted', run: 'info', bad: 'danger' }

/** The match, when the query is on: where it sits in the label. Undefined when it is off; false when it misses. */
function hitOf(label: string, q: string): [number, number] | undefined | false {
  if (!q) return undefined
  const at = label.toLowerCase().indexOf(q)
  return at >= 0 ? [at, at + q.length] : false
}

/** The Tools sidebar's sections for a query: while a search is on, the Overview row goes, and a group it leaves empty
 *  goes too (a query that matches only a routine drops the Managers group). */
export function toolsSections(a: ToolsSidebarArgs): Sections {
  const q = a.query.trim().toLowerCase()
  const L = a.labels
  const up = a.instanceManager?.instances.filter((i) => i.running && i.signedIn && i.dead === null).length ?? 0
  const total = a.instanceManager?.instances.length ?? 0

  const managerRows: SidebarRow[] = []
  const manager = (key: string, label: string, dot: ManagerDot | undefined, meta: string | undefined) => {
    const hit = hitOf(label, q)
    if (hit === false) return
    const tone = dot ? TONE[dot] : undefined
    // A dot that says a read failed has no on/off word: its meta, or nothing, is the row's words.
    const word = meta ?? (dot === 'ok' ? L.on : dot === 'off' ? L.off : undefined)
    managerRows.push({ key, label, hit: hit || undefined, status: tone ? { dot: tone, tone, label: word } : undefined, meta })
  }

  const s = a.babysitter
  const stopped = s?.stopped.length ?? 0
  manager('m:babysitter', L.babysitter, babysitterDot(s), stopped ? L.stopped(stopped) : undefined)
  const orc = a.orchestrator
  manager('m:orchestrator', L.orchestrator, managerDot(orc ? orc.mode === 'armed' : undefined, false), orc ? (orc.mode === 'armed' ? L.armed : L.shadow) : undefined)
  manager('m:instances', L.instanceManager, instanceManagerDot(a.instanceManager), a.instanceManager ? `${up}/${total}` : undefined)
  const rt = a.routines
  const waiting = rt?.proposals.length ?? 0
  manager('m:routines', L.routineManager, managerDot(rt?.enabled, !!rt?.error || !!rt?.store?.error), waiting ? L.waiting(waiting) : undefined)

  // The count is the group's items: every routine and proposal, or what a search left of them.
  const routineItems = a.routineRows.filter((r) => r.key.startsWith('r:') || r.key.startsWith('p:')).length
  const sections: Sections = []
  if (!q) sections.push({ key: 'overview', rows: [{ key: 'overview', label: L.overview, icon: 'grid' }] })
  if (managerRows.length || !q) sections.push({ key: 'managers', label: L.managers, count: managerRows.length, rows: managerRows })
  if (a.routineRows.length || !q) {
    const all = (rt?.routines.length ?? 0) + (rt?.proposals.length ?? 0)
    sections.push({ key: 'routines', label: L.routines, count: q ? routineItems : all, rows: a.routineRows })
  }
  return sections
}
