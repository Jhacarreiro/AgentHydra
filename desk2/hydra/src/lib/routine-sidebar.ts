// The Routines tab's sidebar rows, as pure functions: every routine in a folder (its group, else 'Other'), the proposals
// in an 'Awaiting approval' folder first, a folder that holds a problem wearing its mark, and the search. Desk draws the
// rows in its one sidebar (useDeskSidebar, shared/hydra-embed.ts); outside Desk RoutinesView draws the same rows as its
// own left column. Keys: 'f:<folder>' for a folder, 'r:<id>' for a routine, 'p:<id>' for a proposal.
import type { EmbedTone, SidebarRow } from '@desk/shared/hydra-embed'
import type { Routine, RoutineProposal, RoutinesStatus } from '@desk/shared/routines'
import { dotTone, type RoutineTone, sidebarMeta, stateView } from './routine-words'

const TONE: Record<RoutineTone, EmbedTone> = { success: 'success', info: 'info', warning: 'warning', danger: 'danger', muted: 'muted' }

export interface SidebarArgs {
  status: RoutinesStatus | null
  query: string
  /** Folder key -> open. A folder not named is open. */
  open: Record<string, boolean>
  now: number
  labels: { awaiting: string; other: string; needsLook: string; waitingMark: string }
}

interface Item {
  row: SidebarRow
  danger: boolean
}
interface Folder {
  key: string
  label: string
  items: Item[]
  warning: boolean
  /** Sorts 'Awaiting approval' first and 'Other' last. */
  rank: number
}

/** The folder a routine belongs in: its group, else 'Other'. */
export function folderName(group: string | null | undefined, other: string): string {
  const g = group?.trim()
  return g ? g : other
}

/** The sidebar rows for the routines and proposals that match the search, folders in order and each one's items
 *  under it (none while the folder is closed, unless a search is on: a search opens every folder it hits). */
export function routineSidebarRows(a: SidebarArgs): SidebarRow[] {
  const status = a.status
  if (!status) return []
  const q = a.query.trim().toLowerCase()
  const folders = new Map<string, Folder>()
  const folder = (name: string, rank: number, warning = false): Folder => {
    const key = `f:${name}`
    let f = folders.get(key)
    if (!f) {
      f = { key, label: name, items: [], warning, rank }
      folders.set(key, f)
    }
    return f
  }
  // A search matches the name (highlighted) or the id, group and campaign ids (not highlighted).
  const hitOf = (name: string, extra: string[]): [number, number] | undefined | false => {
    if (!q) return undefined
    const at = name.toLowerCase().indexOf(q)
    if (at >= 0) return [at, at + q.length]
    return extra.some((x) => x.toLowerCase().includes(q)) ? undefined : false
  }

  for (const p of status.proposals) {
    const hit = hitOf(p.name, proposalExtra(p))
    if (hit === false) continue
    const f = folder(a.labels.awaiting, 0, true)
    f.items.push({ danger: false, row: proposalRow(p, hit, a.labels.awaiting) })
  }
  for (const r of status.routines) {
    const hit = hitOf(r.name, routineExtra(r))
    if (hit === false) continue
    const name = folderName(r.group, a.labels.other)
    const f = folder(name, name === a.labels.other ? 2 : 1)
    const danger = dotTone(r.state, r.runs, r.paused).tone === 'danger'
    f.items.push({ danger, row: routineRow(r, hit, a.now) })
  }

  const ordered = [...folders.values()].sort((x, y) => x.rank - y.rank || x.label.localeCompare(y.label))
  const rows: SidebarRow[] = []
  for (const f of ordered) {
    f.items.sort((x, y) => x.row.label.localeCompare(y.row.label))
    const open = q ? true : a.open[f.key] !== false
    const danger = f.items.some((i) => i.danger)
    const mark = danger
      ? { icon: 'alert' as const, tone: 'danger' as const, label: a.labels.needsLook }
      : f.warning
        ? { icon: 'hourglass' as const, tone: 'warning' as const, label: a.labels.waitingMark }
        : undefined
    rows.push({ key: f.key, label: f.label, depth: 0, branch: open ? 'open' : 'closed', count: f.items.length, mark })
    if (open) rows.push(...f.items.map((i) => ({ ...i.row, depth: 1 })))
  }
  return rows
}

/** The folder keys of a status, as the rows name them (the awaiting folder by its label, as the rows do). */
export function folderKeys(status: RoutinesStatus | null, labels: Pick<SidebarArgs['labels'], 'awaiting' | 'other'>): string[] {
  if (!status) return []
  const keys = new Set<string>()
  if (status.proposals.length) keys.add(`f:${labels.awaiting}`)
  for (const r of status.routines) keys.add(`f:${folderName(r.group, labels.other)}`)
  return [...keys]
}

function routineExtra(r: Routine): string[] {
  return [r.id, r.group ?? '', ...(r.campaigns ?? [])]
}

function proposalExtra(p: RoutineProposal): string[] {
  return [p.id, p.group ?? '', ...(p.campaigns ?? [])]
}

function routineRow(r: Routine, hit: [number, number] | undefined, now: number): SidebarRow {
  const view = stateView(r)
  const dot = dotTone(r.state, r.runs, r.paused)
  return {
    key: `r:${r.id}`,
    label: r.name,
    hit,
    status: { dot: dot.hollow ? 'hollow' : TONE[dot.tone], pulse: dot.pulse, label: view.word },
    meta: sidebarMeta(r, now) || undefined,
    hint: `${r.name}: ${view.word}`,
  }
}

function proposalRow(p: RoutineProposal, hit: [number, number] | undefined, awaiting: string): SidebarRow {
  return {
    key: `p:${p.id}`,
    label: p.name,
    hit,
    status: { dot: 'warning', label: awaiting },
    hint: `${p.name}: ${awaiting}`,
  }
}
