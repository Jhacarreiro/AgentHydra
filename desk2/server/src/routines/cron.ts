// A routine's `schedule`: a 5-field cron expression in one time zone's wall-clock time (shared/routines.ts says which forms
// are taken). A local routine keeps this computer's zone; a central one names its IANA `timeZone`, so a runner anywhere runs
// it at the same moments. Pure: it parses, and finds the next slot after a time and the newest slot at or before one, in a
// zone (Intl reads the zone's rules). Nothing here reads a clock.

export interface Cron {
  minutes: number[]
  hours: number[]
  months: Set<number>
  weekdays: Set<number>
  /** Day-of-month and day-of-week are both restricted: either matching counts. */
  eitherDay: boolean
  daysOfMonth: Set<number>
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day-of-week', min: 0, max: 7 },
] as const

/** How many days the search walks before it gives up: about 8 years covers every real expression (Feb 29 included). */
const MAX_DAYS = 366 * 8
const DAY = 86_400_000
/** The most a zone's clocks move at once (a summer time change): a wall time this far before the search's start is never a slot after it. */
const SHIFT_MAX = 3 * 3_600_000

/** One field's values, from `*`, `n`, `a-b`, `*\/n`, `a-b/n` and their comma lists. Throws with the reason. */
function parseField(text: string, name: string, min: number, max: number): Set<number> {
  const values = new Set<number>()
  const bad = (): Error => new Error(`${name} "${text}" must be a number, a range a-b, a list a,b, or a step */n or a-b/n`)
  for (const part of text.split(',')) {
    const m = /^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part)
    if (!m) throw bad()
    const [, star, a, b, step] = m
    if (star !== undefined && step === undefined) {
      for (let v = min; v <= max; v++) values.add(v)
      continue
    }
    const from = star !== undefined ? min : Number(a)
    const to = b !== undefined ? Number(b) : star !== undefined || step !== undefined ? max : from
    const by = step !== undefined ? Number(step) : 1
    if (by < 1 || from < min || to > max || from > to) throw bad()
    for (let v = from; v <= to; v += by) values.add(v)
  }
  return values
}

/** The expression, parsed. Throws with the reason it is not a cron expression this manager takes. */
export function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5 || expr.trim() === '') throw new Error('a schedule is 5 fields: minute hour day-of-month month day-of-week (no names, no @daily, no seconds)')
  const [minute, hour, dom, month, dow] = fields.map((text, i) => parseField(text, FIELDS[i].name, FIELDS[i].min, FIELDS[i].max))
  const weekdays = new Set([...dow].map((d) => (d === 7 ? 0 : d)))
  const domRestricted = fields[2] !== '*'
  const dowRestricted = fields[4] !== '*'
  return {
    minutes: [...minute].sort((a, b) => a - b),
    hours: [...hour].sort((a, b) => a - b),
    months: month,
    weekdays,
    eitherDay: domRestricted && dowRestricted,
    daysOfMonth: dom,
  }
}

/** This computer's time zone: a local routine's schedule keeps it. */
export const systemZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

const formats = new Map<string, Intl.DateTimeFormat>()

/** One formatter per zone, made on first use: a look asks for the same zones again and again. */
function formatOf(zone: string): Intl.DateTimeFormat {
  let f = formats.get(zone)
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    formats.set(zone, f)
  }
  return f
}

/** The wall-clock time a moment shows in a zone, written as the UTC ms of those fields (its milliseconds dropped). */
function wallOf(zone: string, t: number): number {
  const n: Record<string, number> = {}
  for (const p of formatOf(zone).formatToParts(t)) if (p.type !== 'literal') n[p.type] = Number(p.value)
  return Date.UTC(n.year, n.month - 1, n.day, n.hour % 24, n.minute, n.second)
}

/** How far a zone's wall clock is ahead of UTC at a moment, ms. */
const offsetAt = (zone: string, t: number): number => wallOf(zone, t) - Math.floor(t / 1000) * 1000

/** The moments one civil day's wall-clock times name in a zone, the day and the wall times written as UTC fields. A day with
 *  no change of offset near it maps each wall time by one offset. On a day the clocks move, a wall time the zone skips (moved
 *  forward) is the moment after the gap and one it shows twice (moved back) the first of them, as Date does in local time. */
function dayClock(zone: string, day: number): (wall: number) => number {
  const before = offsetAt(zone, day - DAY)
  const after = offsetAt(zone, day + 2 * DAY)
  if (before === after) return (wall) => wall - before
  return (wall) => {
    const shown = [wall - before, wall - after].filter((t) => wallOf(zone, t) === wall)
    return shown.length ? Math.min(...shown) : wall - before
  }
}

/** The moment a wall-clock time (its fields written as UTC ms) names in a zone. */
export function momentOf(zone: string, wall: number): number {
  return dayClock(zone, wall - (((wall % DAY) + DAY) % DAY))(wall)
}

/** The civil day (as UTC midnight ms) a moment falls on in a zone. */
function dayOf(zone: string, t: number): number {
  const w = wallOf(zone, t)
  return w - (((w % DAY) + DAY) % DAY)
}

/** Whether the expression runs on a civil day (UTC midnight ms). */
function dayMatches(c: Cron, day: number): boolean {
  const d = new Date(day)
  if (!c.months.has(d.getUTCMonth() + 1)) return false
  const byDom = c.daysOfMonth.has(d.getUTCDate())
  const byDow = c.weekdays.has(d.getUTCDay())
  return c.eitherDay ? byDom || byDow : byDom && byDow
}

/** The first slot strictly after `after` (ms) in `zone`, or null when none falls within the search. */
export function nextSlot(c: Cron, after: number, zone: string = systemZone()): number | null {
  const start = Math.floor(after / 60_000) * 60_000 + 60_000
  const startWall = wallOf(zone, start)
  let day = dayOf(zone, start)
  for (let i = 0; i < MAX_DAYS; i++, day += DAY) {
    if (!dayMatches(c, day)) continue
    const at = dayClock(zone, day)
    for (const h of c.hours) {
      for (const m of c.minutes) {
        const wall = day + h * 3_600_000 + m * 60_000
        if (wall < startWall - SHIFT_MAX) continue
        const t = at(wall)
        if (t >= start) return t
      }
    }
  }
  return null
}

/** The newest slot at or before `at` (ms) in `zone`, or null when none falls within the search. */
export function previousSlot(c: Cron, at: number, zone: string = systemZone()): number | null {
  const end = Math.floor(at / 60_000) * 60_000
  const endWall = wallOf(zone, end)
  let day = dayOf(zone, end)
  for (let i = 0; i < MAX_DAYS; i++, day -= DAY) {
    if (!dayMatches(c, day)) continue
    const clock = dayClock(zone, day)
    for (let h = c.hours.length - 1; h >= 0; h--) {
      for (let m = c.minutes.length - 1; m >= 0; m--) {
        const wall = day + c.hours[h] * 3_600_000 + c.minutes[m] * 60_000
        if (wall > endWall + SHIFT_MAX) continue
        const slot = clock(wall)
        if (slot <= end) return slot
      }
    }
  }
  return null
}
