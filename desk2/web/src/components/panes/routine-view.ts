// What the Routines list says at a glance, as pure functions: a status from the routine's state and last run, times as
// '2 h ago' / 'in 3 h', a schedule in plain words with its time zone, and the Active / Paused groups.
import type { Routine, RoutineOutcome } from '@shared/routines'

export type RoutineStatus = 'ok' | 'failed' | 'running' | 'paused' | 'waiting' | 'new'

const FAILED: RoutineOutcome[] = ['failed', 'timed-out', 'interrupted']

/** The chip a routine wears: running wins, then paused (and off, ended), then a broken file or a failed last run, else ok. */
export function routineStatus(r: Pick<Routine, 'state' | 'runs'>): RoutineStatus {
  if (r.state === 'running') return 'running'
  if (r.state === 'waiting') return 'waiting'
  if (r.state === 'paused' || r.state === 'off' || r.state === 'ended') return 'paused'
  if (r.state === 'broken') return 'failed'
  const last = r.runs[0]
  if (!last) return 'new'
  return FAILED.includes(last.outcome) ? 'failed' : 'ok'
}

export const STATUS_LABEL: Record<RoutineStatus, string> = {
  ok: 'OK',
  failed: 'Failed',
  running: 'Running',
  paused: 'Paused',
  waiting: 'Awaiting approval',
  new: 'Not run yet',
}

/** A result's icon family: ok, failed or busy (busy is neither a pass nor a failure). */
export function outcomeKind(o: RoutineOutcome): 'ok' | 'failed' | 'busy' {
  return o === 'ok' ? 'ok' : o === 'busy' ? 'busy' : 'failed'
}

/** A span of time: 'under a minute', '12 min', '2 h', '3 d'. */
export function spanOf(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000))
  if (m < 1) return 'under a minute'
  if (m < 60) return `${m} min`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h`
  return `${Math.max(1, Math.round(m / (24 * 60)))} d`
}

/** A moment next to now: '2 h ago', 'in 3 d', 'just now' within a minute either way. */
export function relativeTime(at: number, now: number): string {
  const diff = at - now
  if (Math.abs(diff) < 60_000) return 'just now'
  return diff < 0 ? `${spanOf(-diff)} ago` : `in ${spanOf(diff)}`
}

/** The row's last-run text: null when it never ran. */
export function lastRunText(r: Pick<Routine, 'runs' | 'lastRunAt'>, now: number): string | null {
  const at = r.runs[0]?.endedAt ?? r.lastRunAt
  return at === null || at === undefined ? null : relativeTime(at, now)
}

/** The row's next-run text: 'paused' or 'not scheduled' when there is none, 'running now' while it runs. */
export function nextRunText(r: Pick<Routine, 'state' | 'nextRunAt' | 'paused'>, now: number): string {
  if (r.state === 'running') return 'running now'
  if (r.paused || r.state === 'paused') return 'paused'
  if (r.state === 'ended' || r.state === 'off' || r.nextRunAt === null) return 'not scheduled'
  return r.nextRunAt <= now ? 'due now' : relativeTime(r.nextRunAt, now)
}

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

export interface RoutineGroup {
  key: 'active' | 'paused'
  title: string
  routines: Routine[]
}

/** Active and Paused groups from the data, empty ones left out (Awaiting approval comes from the proposals). */
export function groupRoutines(routines: Routine[]): RoutineGroup[] {
  const paused = routines.filter((r) => routineStatus(r) === 'paused')
  const active = routines.filter((r) => routineStatus(r) !== 'paused')
  return [
    { key: 'active' as const, title: 'Active', routines: active },
    { key: 'paused' as const, title: 'Paused', routines: paused },
  ].filter((g) => g.routines.length > 0)
}
