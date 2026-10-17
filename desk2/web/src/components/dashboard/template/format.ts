// The template's words and numbers: counts with their thousands, a row's age, a tile's change, and how fresh the page's
// numbers are. Pure, so the page and its tests share them.
import type { ProjectDashboard, RangeId, StatTile } from '@shared/project-dashboard'

const DAY = 86_400_000

/** What a tile's change is against, by range. */
export const VS: Record<RangeId, string> = { today: 'vs yesterday', '7d': 'vs prior 7 days', '30d': 'vs prior 30 days' }

export const fmt = (n: number): string => n.toLocaleString('en-US')

/** A tile's value: "638", "18%", "50+" when only a floor is known, a dash when not measured. */
export function tileValue(t: StatTile): string {
  if (t.value === null) return t.atLeast !== undefined ? `${fmt(t.atLeast)}+` : '–'
  return t.unit === 'percent' ? `${fmt(Math.round(t.value * 10) / 10)}%` : fmt(t.value)
}

/** A change against the window before, as a number to show with its arrow: "18.9%"; null when there is none. */
export function changeText(change: number | null | undefined): string | null {
  if (change === null || change === undefined || !Number.isFinite(change)) return null
  return `${fmt(Math.abs(Math.round(change * 10) / 10))}%`
}

/** How long a row has waited: "today", "3d", "5w"; empty when it has no start. */
export function age(since: string | null | undefined, now: number): string {
  if (!since) return ''
  const t = Date.parse(since)
  if (Number.isNaN(t)) return ''
  const days = Math.floor((now - t) / DAY)
  if (days < 1) return 'today'
  return days < 70 ? `${days}d` : `${Math.floor(days / 7)}w`
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(ms: number): string {
  const m = Math.round(ms / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

export interface Freshness {
  /** "Updated 12 min ago"; empty before any source has answered. */
  text: string
  /** The numbers are late: past two and a half of their source's rounds, or its last read failed. */
  late: boolean
  /** The tooltip: when the numbers are from, and what went wrong. */
  tip: string
}

/** How fresh the page is: its oldest source's numbers decide, since every section is only as new as its source. */
export function freshness(d: ProjectDashboard, now: number): Freshness {
  let oldest: number | null = null
  let every = d.refreshMinutes
  for (const s of d.sources) {
    const at = Date.parse(s.generatedAt ?? s.fetchedAt ?? '')
    if (Number.isNaN(at)) continue
    if (oldest === null || at < oldest) {
      oldest = at
      every = s.everyMinutes ?? d.refreshMinutes
    }
  }
  const failed = d.sources.filter((s) => s.error)
  if (oldest === null) return { text: '', late: failed.length > 0, tip: failed.map((s) => `${s.label}: ${s.error}`).join('\n') }
  const late = now - oldest > every * 2.5 * 60_000 || failed.length > 0
  const from = `Numbers from ${new Date(oldest).toLocaleString()}`
  const tip = [failed.length ? `The last read failed. ${from}` : from, ...failed.map((s) => `${s.label}: ${s.error}`)].join('\n')
  return { text: `Updated ${ago(now - oldest)}`, late, tip }
}

/** A bar's width on a shared scale: never thinner than 4% so a small count still shows. */
export const barWidth = (value: number, max: number): string => `${Math.max(4, (value / Math.max(1, max)) * 100)}%`

/** Why sections could not be filled, when two or more share it (one source that could not be read): said once above them. */
export function sharedReasons(sections: readonly { missing: string | null }[]): string[] {
  const seen = new Map<string, number>()
  for (const s of sections) if (s.missing) seen.set(s.missing, (seen.get(s.missing) ?? 0) + 1)
  return [...seen].filter(([, n]) => n > 1).map(([why]) => why)
}
