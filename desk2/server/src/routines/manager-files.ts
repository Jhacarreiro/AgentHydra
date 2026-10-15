import { readFileSync, statSync } from 'node:fs'
import type { RoutineDefinition, RoutineOutcome, RoutineProposal, RunDescription } from '@shared/routines'
import { renameOver, writeFlushed } from '../write-flushed'
import type { Memory } from './decide'
import { ROUTINE_ID } from './manifest'
import type { RunResult } from './runner'
import { BUSY_EXIT, RUNS_KEPT } from './manager-config'

const pad = (n: number): string => String(n).padStart(2, '0')
/** A local time, YYYY-MM-DD HH:mm. */
export const localStamp = (ms: number): string => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
/** A local time as the chat group's stamp, YYYYMMDDHHmm. */
export const groupStamp = (ms: number): string => localStamp(ms).replace(/[-: ]/g, '')

/** A description still being written when Desk stopped is never finished: the output it read went with that Desk. */
const RESTARTED: RunDescription = { state: 'failed', text: 'AgentHydra restarted before it was described' }

/** <home>/routines.json, or empty memory when it is missing or damaged (a forgotten run only means a routine counts from zero). */
export function load(file: string): Record<string, Memory> {
  let saved: { routines?: unknown } | null = null
  try {
    saved = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT' && code !== 'ENOTDIR') console.error('[routines] routines.json did not load; starting with no memory:', err)
  }
  const routines = saved?.routines && typeof saved.routines === 'object' && !Array.isArray(saved.routines) ? (saved.routines as Record<string, Partial<Memory>>) : {}
  // Keyed by routine id with no prototype: a plain object handed a routine named "constructor" Object's own function as
  // its memory, and the whole list failed.
  const memory: Record<string, Memory> = Object.create(null)
  return Object.assign(memory, Object.fromEntries(
    // Only routine ids: a run's files are named by its id, so a key that is not one never names a path.
    Object.entries(routines).filter(([id]) => ROUTINE_ID.test(id)).map(([id, m]) => {
      const mem: Memory = {
        runs: Array.isArray(m?.runs) ? m.runs.slice(0, RUNS_KEPT).map((r) => (r?.description?.state === 'pending' ? { ...r, description: RESTARTED } : r)) : [],
        running: null,
        lastSlot: typeof m?.lastSlot === 'number' ? m.lastSlot : null,
        paused: m?.paused === true,
      }
      // A run still marked running when AgentHydra started again goes on: a prompt run's chat runs on, and a command run's
      // runner is outside Desk's process tree. The first look reads whether it ended meanwhile.
      if (m?.running && Number.isFinite(m.running.startedAt)) {
        const workerId = typeof m.running.workerId === 'string' ? m.running.workerId : null
        const pid = typeof m.running.pid === 'number' ? m.running.pid : null
        // A run kept without its kind (a Desk before 2026-10-13) is a prompt run when it has its chat, else a command run.
        const kind = m.running.kind === 'prompt' || workerId ? 'prompt' : 'command'
        mem.running = { startedAt: m.running.startedAt, kind, pid: workerId ? null : pid, workerId, sessionId: null }
      }
      return [id, mem]
    }),
  ))
}

/** How long ago a file was last written, ms; null when it is not there. */
export function ageMs(file: string): number | null {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return null
  }
}

/** A routine or proposal file, whole or not at all: a crash mid-write leaves the file as it was, never half of one. */
export function writeWhole(file: string, body: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`
  writeFlushed(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameOver(tmp, file)
}

export function outcomeOf(r: Pick<RunResult, 'code' | 'timedOut' | 'error'>): RoutineOutcome {
  if (r.timedOut) return 'timed-out'
  if (r.error === null && r.code === 0) return 'ok'
  if (r.error === null && r.code === BUSY_EXIT) return 'busy'
  return 'failed'
}

/** A routine's file body, as written: the contract without its id (the file name) and without `why`. */
export function contractOf(def: RoutineDefinition | RoutineProposal): Record<string, unknown> {
  const body: Record<string, unknown> = { ...def }
  delete body.id
  return body
}
