// The routines' judgment (shared/routines.ts says what they are for). Pure: the plugin (plugins/73-routines.ts) reads each
// routine's status or Windows task and starts each run this says to start; this says what each routine's state is and
// whether a run starts now. Nothing here reads a file, a clock or a command.

import type { RoutineRun, RoutineRunning, RoutineState } from '@shared/routines'
import { untilEndOf, type Entry } from './manifest'
import { nextSlot, parseCron, previousSlot } from './cron'
import type { TaskReading } from './wintask'

/** A status-kind routine's run starts only this long after its last one ended. */
export const MIN_GAP_MS = 15 * 60_000
/** A schedule slot missed by more than this is skipped, not run late. */
export const MISSED_MS = 12 * 3600_000

/** What a status command printed, checked: the fields the manager reads (the rest is ignored). */
export interface Reading {
  nextTickAt: number | null
  lastTickAt: number | null
  off: boolean
  headline: string | null
  totals: Record<string, number> | null
  settings: Record<string, string | number | boolean> | null
}

/** One routine as the last look saw it: its entry, what its status read (or why it did not), and its Windows task. */
export interface Seen {
  entry: Entry
  reading: Reading | null
  readError: string | null
  task: TaskReading | null
}

/** A routine's memory: its last runs, newest first; the run going on, if any; the newest schedule slot it ran for; paused. */
export interface Memory {
  runs: RoutineRun[]
  running: RoutineRunning | null
  lastSlot: number | null
  paused: boolean
}

export interface Judged {
  state: RoutineState
  reason: string
  /** Whether a run starts now. */
  start: boolean
  /** The schedule slot a started run is for (null for the other kinds and for a manual run). */
  slot: number | null
  /** A slot too old to run: the memory moves past it, and nothing runs. */
  skipSlot: number | null
  /** When it next runs, ms; null when unknown. */
  nextRunAt: number | null
}

export const emptyMemory = (lastSlot: number | null = null): Memory => ({ runs: [], running: null, lastSlot, paused: false })

/** An ISO time field: a string that parses, or null (or absent). Throws with the field's name otherwise. */
function isoTime(o: Record<string, unknown>, key: string): number | null {
  const v = o[key] ?? null
  if (v === null) return null
  const ms = typeof v === 'string' ? Date.parse(v) : Number.NaN
  if (!Number.isFinite(ms)) throw new Error(`"${key}" must be an ISO time or null`)
  return ms
}

/** A status command's stdout: one JSON object, its fields checked. Throws with the reason when it does not hold. */
export function parseReading(stdout: string): Reading {
  let v: unknown
  try {
    v = JSON.parse(stdout.trim())
  } catch {
    throw new Error('the status command printed no JSON object')
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('the status command printed no JSON object')
  const o = v as Record<string, unknown>
  if (o.off !== undefined && typeof o.off !== 'boolean') throw new Error('"off" must be true or false')
  if (o.headline !== undefined && o.headline !== null && typeof o.headline !== 'string') throw new Error('"headline" must be a string')
  if (o.totals !== undefined && o.totals !== null && (typeof o.totals !== 'object' || Array.isArray(o.totals)))
    throw new Error('"totals" must be an object of numbers')
  const headline = typeof o.headline === 'string' ? o.headline.replace(/\s+/g, ' ').trim().slice(0, 160) : ''
  const totals = Object.entries((o.totals ?? {}) as Record<string, unknown>).flatMap(([k, n]) =>
    typeof n === 'number' && Number.isFinite(n) ? [[k, n] as const] : [],
  )
  return {
    nextTickAt: isoTime(o, 'next_tick_at'),
    lastTickAt: isoTime(o, 'last_tick_at'),
    off: o.off === true,
    headline: headline || null,
    totals: o.totals ? Object.fromEntries(totals) : null,
    settings: settingsOf(o.settings),
  }
}

/** The status's `settings`: scalar values only, at most 12 entries, names cut to 40 and strings to 120. Null when not an object. */
function settingsOf(v: unknown): Record<string, string | number | boolean> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const kept: [string, string | number | boolean][] = []
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (kept.length === 12) break
    if (typeof x === 'string') kept.push([k.slice(0, 40), x.slice(0, 120)])
    else if ((typeof x === 'number' && Number.isFinite(x)) || typeof x === 'boolean') kept.push([k.slice(0, 40), x])
  }
  return Object.fromEntries(kept)
}

/** When the routine's last run ended, ms: its own record, or its status's last_tick_at when that is later; null when none. */
export function lastEndOf(reading: Reading | null, mem: Memory): number | null {
  const ends = [mem.runs[0]?.endedAt, reading?.lastTickAt].filter((t): t is number => typeof t === 'number')
  return ends.length ? Math.max(...ends) : null
}

/** The schedule's newest slot at or before `now`, and the next one after it, for a `schedule` routine; null otherwise. */
export function slotsOf(entry: Entry, now: number): { newest: number | null; next: number | null } | null {
  if (!entry.def?.schedule) return null
  const c = parseCron(entry.def.schedule)
  return { newest: previousSlot(c, now), next: nextSlot(c, now) }
}

const idle = (reason: string, nextRunAt: number | null, state: RoutineState = 'idle'): Judged => ({ state, reason, start: false, slot: null, skipSlot: null, nextRunAt })

/**
 * The state of one routine now, and whether a run starts. A look (`manual` false) starts a due routine while the manager is
 * on. A manual run (`manual` true) starts an idle or due routine at once, skipping the due time, the 15 minutes and the
 * switch, but never a routine that is broken, off, ended, paused or running (the server refuses those before it asks).
 */
export function judge(seen: Seen, mem: Memory, now: number, enabled: boolean, manual: boolean): Judged {
  const { entry } = seen
  if (entry.broken !== null || !entry.def) return idle(entry.broken ?? 'its file does not check out', null, 'broken')
  const def = entry.def
  if (mem.running) return idle('a run is running now', null, 'running')
  if (def.until !== undefined) {
    const end = untilEndOf(def.until)
    if (end !== null && now >= end) return idle(`ended after ${def.until}: it never runs`, null, 'ended')
  }
  if (def.windowsTask !== undefined) return judgeTask(seen)
  if (mem.paused) return idle('paused by the owner', null, 'paused')
  if (def.schedule !== undefined) return judgeSchedule(seen, mem, now, enabled, manual)
  return judgeStatus(seen, mem, now, enabled, manual)
}

function judgeSchedule(seen: Seen, mem: Memory, now: number, enabled: boolean, manual: boolean): Judged {
  const slots = slotsOf(seen.entry, now)
  const next = slots?.next ?? null
  if (manual) return { state: 'due', reason: 'run now', start: true, slot: null, skipSlot: null, nextRunAt: next }
  const newest = slots?.newest ?? null
  if (newest === null || mem.lastSlot === null || newest <= mem.lastSlot) return idle(next ? `next due ${new Date(next).toISOString()}` : 'no slot ahead', next)
  if (now - newest > MISSED_MS) return { ...idle(`slot ${new Date(newest).toISOString()} was missed by more than 12 hours: skipped`, next, 'idle'), skipSlot: newest }
  if (!enabled) return { state: 'due', reason: 'due; the routine manager is off, so it waits', start: false, slot: null, skipSlot: null, nextRunAt: next }
  return { state: 'due', reason: 'due; running now', start: true, slot: newest, skipSlot: null, nextRunAt: next }
}

function judgeStatus(seen: Seen, mem: Memory, now: number, enabled: boolean, manual: boolean): Judged {
  const { reading } = seen
  if (!reading) return idle(seen.readError ?? 'its status has not been read', null, 'broken')
  if (reading.off) return idle('its status says off, so it is never run', null, 'off')
  const at = reading.nextTickAt
  const notDue = at !== null && at > now
  if (manual) return { state: notDue ? 'idle' : 'due', reason: 'run now', start: true, slot: null, skipSlot: null, nextRunAt: at }
  if (notDue) return idle(`next due ${new Date(at).toISOString()}`, at)
  if (!enabled) return { state: 'due', reason: 'due; the routine manager is off, so it waits', start: false, slot: null, skipSlot: null, nextRunAt: null }
  const last = lastEndOf(reading, mem)
  if (last !== null && now - last < MIN_GAP_MS) return { state: 'due', reason: 'due; it waits 15 minutes after its last run', start: false, slot: null, skipSlot: null, nextRunAt: null }
  return { state: 'due', reason: 'due; running now', start: true, slot: null, skipSlot: null, nextRunAt: null }
}

/** A windowsTask routine never starts from here: Windows runs it, and a manual run is schtasks (the plugin's). */
function judgeTask(seen: Seen): Judged {
  const task = seen.task
  if (!task) return idle(seen.readError ?? 'its Windows task has not been read', null, 'broken')
  if (!task.found) return idle(`no Windows task ${task.path}`, null, 'broken')
  if (task.state === 'Running') return idle('Windows is running the task now', null, 'running')
  if (task.state === 'Disabled') return idle('the Windows task is disabled: paused', null, 'paused')
  return idle('Windows runs it on its own schedule', task.nextRunAt)
}
