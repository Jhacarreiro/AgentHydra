// What a routine says, as pure functions for the Tools tab's routines: its state as a word and a tone, times as '2 h ago' and
// 'in 3 h', a duration, and a schedule in plain words with its time zone. The schedule and time wording is copied from
// desk2/web/src/components/panes/routine-view.ts and routine-details.ts (hydra may not import from web/); keep the two
// in step. Times in ms.
import type { Routine, RoutineOutcome, RoutineState } from '@desk/shared/routines'

/** A state's colour family: success is the healthy idle, danger a problem, warning a wait for the owner, info a run. */
export type RoutineTone = 'success' | 'info' | 'warning' | 'danger' | 'muted'

export interface StateView {
  word: string
  tone: RoutineTone
}

const FAILED: RoutineOutcome[] = ['failed', 'timed-out', 'interrupted']

/** The one word a routine wears: a broken file or a failed last run is a problem, a run is running, the rest are
 *  said as the manager says them (waiting, paused, off, ended, elsewhere). */
export function stateView(r: Pick<Routine, 'state' | 'runs' | 'paused'>): StateView {
  const last = r.runs[0]
  switch (r.state) {
    case 'broken':
      return { word: 'Broken', tone: 'danger' }
    case 'waiting':
      return { word: 'Awaiting approval', tone: 'warning' }
    case 'running':
      return { word: 'Running', tone: 'info' }
    case 'paused':
      return { word: 'Paused', tone: 'muted' }
    case 'off':
      return { word: 'Off', tone: 'muted' }
    case 'ended':
      return { word: 'Ended', tone: 'muted' }
    case 'elsewhere':
      return { word: 'Runs elsewhere', tone: 'muted' }
  }
  if (r.paused) return { word: 'Paused', tone: 'muted' }
  if (last && FAILED.includes(last.outcome)) return { word: 'Failed', tone: 'danger' }
  if (!last) return { word: 'Not run yet', tone: 'muted' }
  return { word: r.state === 'due' ? 'Due' : 'On schedule', tone: r.state === 'due' ? 'info' : 'success' }
}

/** The status dot a sidebar row wears: running pulses, a problem is danger, paused, off and ended are hollow. */
export function dotTone(state: RoutineState, runs: Pick<Routine, 'runs'>['runs'], paused: boolean): { tone: RoutineTone; hollow: boolean; pulse: boolean } {
  if (state === 'running') return { tone: 'info', hollow: false, pulse: true }
  if (state === 'broken' || (state !== 'paused' && state !== 'off' && state !== 'ended' && runs[0] && FAILED.includes(runs[0].outcome)))
    return { tone: 'danger', hollow: false, pulse: false }
  if (state === 'waiting') return { tone: 'warning', hollow: false, pulse: false }
  if (state === 'paused' || state === 'off' || state === 'ended' || paused || state === 'elsewhere') return { tone: 'muted', hollow: true, pulse: false }
  return { tone: 'success', hollow: false, pulse: false }
}

/** A span of time as one unit: '45 s', '6 min', '2 h 5 min'; '-' when unknown (a run's duration). */
export function durationText(ms: number | null): string {
  if (ms === null) return '-'
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`
}

/** A span for 'next in 2h 10m': '45m', '2h 10m', '3d 4h'. Compact on purpose; the exact time is a tooltip. */
export function compactSpan(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

/** A moment next to now: '2 h ago', 'in 3 d', 'just now' within a minute either way. */
export function relativeTime(at: number, now: number): string {
  const diff = at - now
  if (Math.abs(diff) < 60_000) return 'just now'
  return diff < 0 ? `${compactSpan(-diff)} ago` : `in ${compactSpan(diff)}`
}

/** The next run as the header says it: 'next in 2h 10m', 'due now', or the state word when none is scheduled. */
export function nextRunText(r: Pick<Routine, 'state' | 'nextRunAt' | 'paused'>, now: number): string {
  if (r.state === 'running') return 'running now'
  if (r.state === 'elsewhere') return 'on another computer'
  if (r.paused || r.state === 'paused') return 'paused'
  if (r.state === 'ended' || r.state === 'off' || r.nextRunAt === null) return 'not scheduled'
  return r.nextRunAt <= now ? 'due now' : `next in ${compactSpan(r.nextRunAt - now)}`
}

/** The sidebar's meta: 'in 3h' for the next run, the state word for a paused, ended or broken routine. */
export function sidebarMeta(r: Pick<Routine, 'state' | 'nextRunAt' | 'paused' | 'runs'>, now: number): string {
  if (r.state === 'broken') return 'broken'
  if (r.state === 'paused' || r.paused) return 'paused'
  if (r.state === 'ended') return 'ended'
  if (r.state === 'running') return 'running'
  if (r.nextRunAt === null) return ''
  return r.nextRunAt <= now ? 'due' : `in ${compactSpan(r.nextRunAt - now)}`
}

/** Whole-history numbers as a percentage: '92%', or '-' when nothing counts. */
export const percentText = (rate: number | null): string => (rate === null ? '-' : `${Math.round(rate * 100)}%`)

/** A date for a tile: 'Oct 12', with the year when it is not this one. */
export function sinceText(ms: number | null, now: number): string {
  if (ms === null) return '-'
  const d = new Date(ms)
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) })
}

/** The exact time, for a tooltip. */
export const exactTime = (ms: number | null): string => (ms === null ? '' : new Date(ms).toLocaleString())

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const plain = (f: string): number[] | null => (/^\d+(,\d+)*$/.test(f) ? f.split(',').map(Number) : null)
const joinAnd = (xs: string[]): string => (xs.length < 3 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`)

/** 'America/Chicago' to 'Chicago'; UTC stays 'UTC'. */
export function zoneName(zone: string): string {
  return zone === 'UTC' ? 'UTC' : (zone.split('/').pop() ?? zone).replace(/_/g, ' ')
}

/** This computer's time zone (where the server reads local time too). */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * A cron expression in plain words: 'Weekdays at 8:57 and 12:57, Chicago time'. A form it does not read plainly (ranges or
 * steps in the time fields, month limits) comes back as 'Cron <expr>, <zone> time', never a guess.
 */
export function scheduleSentence(expr: string, zone: string): string {
  const f = expr.trim().split(/\s+/)
  const tail = `${zoneName(zone)} time`
  if (f.length !== 5) return `${expr}, ${tail}`
  const [minute, hour, dom, month, dow] = f as [string, string, string, string, string]
  const mins = plain(minute)
  const hours = plain(hour)
  if (!mins || !hours || month !== '*') return `Cron ${expr}, ${tail}`
  const times = hours.flatMap((h) => mins.map((m) => `${h}:${String(m).padStart(2, '0')}`))
  const at = times.length > 4 ? `${times.length} times a day` : joinAnd(times)
  let day: string
  if (dom === '*' && dow === '*') day = 'Every day'
  else if (dom === '*' && dow === '1-5') day = 'Weekdays'
  else if (dom === '*' && (dow === '0,6' || dow === '6,0' || dow === '6,7')) day = 'Weekends'
  else if (dom === '*' && /^[0-7](,[0-7])*$/.test(dow)) day = joinAnd(dow.split(',').map((d) => DAYS[Number(d) % 7]!))
  else if (/^\d+$/.test(dom) && dow === '*') day = `Day ${dom} of the month`
  else return `Cron ${expr}, ${tail}`
  return `${day} at ${at}, ${tail}`
}

/** The schedule in words for any routine kind: its cron in words, a status routine's pacing, or the Windows task. */
export function scheduleWords(r: Pick<Routine, 'kind' | 'schedule' | 'windowsTask' | 'timeZone'>, zone: string): string {
  if (r.kind === 'windowsTask' || r.windowsTask) return 'Windows task'
  if (r.schedule) return scheduleSentence(r.schedule, r.timeZone ?? zone)
  if (r.kind === 'status') return 'Every 15 min, self-paced'
  return 'Not scheduled'
}
