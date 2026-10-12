// ArchAIngel's judgment (shared/archaingel.ts says what it is for). Pure: the plugin (plugins/73-archaingel.ts) runs each
// status command and each tick, this judges what each agent's state is and whether a tick starts now, and the plugin
// starts what it says. Nothing here reads a file or runs a command.

import type { ArchAIngelRun, ArchAIngelRunning, ArchAIngelState } from '@shared/archaingel'
import type { Entry } from './manifest'

/** A tick of an agent starts only this long after its last one ended. */
export const MIN_GAP_MS = 15 * 60_000

/** What a status command printed, checked: the fields ArchAIngel reads (the rest is ignored). */
export interface Reading {
  nextTickAt: number | null
  lastTickAt: number | null
  off: boolean
  headline: string | null
  totals: Record<string, number> | null
}

/** One agent as the last look saw it: its entry, and what its status read (or why that failed). */
export interface Seen {
  entry: Entry
  reading: Reading | null
  readError: string | null
}

/** An agent's memory: its last ticks, newest first, and the tick running now, if any. */
export interface Memory {
  runs: ArchAIngelRun[]
  running: ArchAIngelRunning | null
}

export interface Judged {
  state: ArchAIngelState
  reason: string
  /** Whether a tick starts now. */
  start: boolean
}

export const emptyMemory = (): Memory => ({ runs: [], running: null })

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
  }
}

/** When the agent's last tick ended, ms: its own record, or its status's last_tick_at when that is later; null when none. */
export function lastEndOf(reading: Reading | null, mem: Memory): number | null {
  const ends = [mem.runs[0]?.endedAt, reading?.lastTickAt].filter((t): t is number => typeof t === 'number')
  return ends.length ? Math.max(...ends) : null
}

/**
 * The state of one agent now, and whether a tick starts. A look (`manual` false) starts a due agent while ArchAIngel is on
 * and its last tick ended 15 minutes ago or more. A manual run (`manual` true) starts an idle or due agent at once,
 * skipping the due time, the 15 minutes and the switch, but never an agent that is broken, off or running.
 */
export function judge(seen: Seen, mem: Memory, now: number, enabled: boolean, manual: boolean): Judged {
  const { entry, reading } = seen
  if (entry.broken !== null) return { state: 'broken', reason: entry.broken, start: false }
  if (mem.running) return { state: 'running', reason: 'a tick is running now', start: false }
  if (!reading) return { state: 'broken', reason: seen.readError ?? 'its status has not been read', start: false }
  if (reading.off) return { state: 'off', reason: 'its status says off, so it is never ticked', start: false }
  const at = reading.nextTickAt
  const notDue = at !== null && at > now
  if (manual) return { state: notDue ? 'idle' : 'due', reason: 'run now', start: true }
  if (notDue) return { state: 'idle', reason: `next due ${new Date(at).toISOString()}`, start: false }
  if (!enabled) return { state: 'due', reason: 'due; ArchAIngel is off, so it waits', start: false }
  const last = lastEndOf(reading, mem)
  if (last !== null && now - last < MIN_GAP_MS) return { state: 'due', reason: 'due; it waits 15 minutes after its last tick', start: false }
  return { state: 'due', reason: 'due; ticking now', start: true }
}
