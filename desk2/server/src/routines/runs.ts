// The run board's language (shared/routines.ts, "CENTRAL ROUTINES"). A schedule routine that any runner carrying its labels may
// run is claimed slot by slot: its claim is one lease per routine (as a Kubernetes Lease is one object per thing held) naming
// the slot it holds, the runner holding it, until when by the board's own clock, and when that run ended. The board grants a
// slot to the first runner that asks; the holder renews it while the run lives and ends it when the run ends; a lease that
// lapsed lets another runner take it; while one slot's run lives no newer slot is granted (overlap Skip, Temporal's default).
// Every central run, wherever it runs, is reported to the run log as CloudEvents 1.0: routine.claimed, routine.started and
// routine.ended, `source` its runner, `subject` its routine, `id` its routine, slot, runner and phase. Pure.

import type { CentralRun, RoutineOutcome } from '@shared/routines'

export type RunPhase = 'claimed' | 'started' | 'ended'

/** A routine's claim, as the run board answers it (ms): the slot it holds, its holder, until when, and when that run ended. */
export interface Claim {
  slot: number
  holder: string
  leaseUntil: number
  endedAt: number | null
}

/** A run event's data: the store, the run (every event of one run carries the same), its runner and slot, and the phase's facts. */
export interface RunEventData {
  store: string
  run: string
  runner: string
  /** The schedule slot it runs for (ISO), or null for a run not tied to one (a manual run, a status routine's). */
  slot: string | null
  startedAt?: string
  endedAt?: string
  outcome?: RoutineOutcome
  exitCode?: number | null
  lastLine?: string
  description?: string
}

/** One CloudEvents 1.0 event of the run log. */
export interface RunEvent {
  specversion: '1.0'
  id: string
  source: string
  type: `routine.${RunPhase}`
  subject: string
  time: string
  datacontenttype: 'application/json'
  data: RunEventData
}

const iso = (ms: number): string => new Date(ms).toISOString()

/** A runner as a CloudEvents source: a URN that names it. */
export const sourceOf = (runner: string): string => `urn:routine-runner:${runner}`

/** One run's key: its routine, its slot (or, for a run not tied to one, its start) and its runner. */
export const runKeyOf = (routine: string, slot: number | null, startedAt: number, runner: string): string =>
  `${routine}/${slot !== null ? iso(slot) : `run-${iso(startedAt)}`}/${runner}`

/** What a run event says: its store, routine, runner, slot and start, when it happened, and an ended run's facts. */
export interface RunFacts {
  store: string
  routine: string
  runner: string
  slot: number | null
  startedAt: number
  at: number
  ended?: { endedAt: number; outcome: RoutineOutcome; exitCode: number | null; lastLine: string; description?: string }
}

/** One phase of a run as a CloudEvent. */
export function runEvent(phase: RunPhase, f: RunFacts): RunEvent {
  const run = runKeyOf(f.routine, f.slot, f.startedAt, f.runner)
  const data: RunEventData = { store: f.store, run, runner: f.runner, slot: f.slot === null ? null : iso(f.slot) }
  if (phase !== 'claimed') data.startedAt = iso(f.startedAt)
  if (f.ended) {
    data.endedAt = iso(f.ended.endedAt)
    data.outcome = f.ended.outcome
    data.exitCode = f.ended.exitCode
    data.lastLine = f.ended.lastLine
    if (f.ended.description !== undefined) data.description = f.ended.description
  }
  return { specversion: '1.0', id: `${run}/${phase}`, source: sourceOf(f.runner), type: `routine.${phase}`, subject: f.routine, time: iso(f.at), datacontenttype: 'application/json', data }
}

const PHASES = ['routine.claimed', 'routine.started', 'routine.ended']
const OUTCOMES: RoutineOutcome[] = ['ok', 'busy', 'failed', 'timed-out', 'interrupted']
const msOf = (v: unknown): number | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)

/** Whether a value from the run log is a run event this computer can read (another computer wrote it). */
function isRunEvent(e: unknown): e is RunEvent {
  const v = e as RunEvent | null
  return (
    !!v &&
    typeof v === 'object' &&
    PHASES.includes(v.type) &&
    typeof v.id === 'string' &&
    typeof v.subject === 'string' &&
    msOf(v.time) !== null &&
    !!v.data &&
    typeof v.data === 'object' &&
    typeof v.data.run === 'string' &&
    typeof v.data.runner === 'string'
  )
}

/** The newest run of each routine in the run log's events, by the newest event of each run; each with its run key. */
export function foldRuns(events: unknown[]): Map<string, { key: string; at: number; run: CentralRun }> {
  const runs = new Map<string, { subject: string; key: string; at: number; run: CentralRun }>()
  for (const e of events) {
    if (!isRunEvent(e)) continue
    const id = `${e.subject}\n${e.data.run}`
    const r = runs.get(id) ?? {
      subject: e.subject,
      key: e.data.run,
      at: 0,
      run: { runner: e.data.runner, slot: msOf(e.data.slot), startedAt: null, endedAt: null, outcome: null, exitCode: null, lastLine: null, description: null },
    }
    r.at = Math.max(r.at, msOf(e.time)!)
    r.run.startedAt ??= msOf(e.data.startedAt)
    if (e.type === 'routine.ended') {
      r.run.endedAt = msOf(e.data.endedAt) ?? msOf(e.time)
      r.run.outcome = OUTCOMES.includes(e.data.outcome as RoutineOutcome) ? (e.data.outcome as RoutineOutcome) : null
      r.run.exitCode = typeof e.data.exitCode === 'number' ? e.data.exitCode : null
      r.run.lastLine = typeof e.data.lastLine === 'string' ? e.data.lastLine : null
      r.run.description = typeof e.data.description === 'string' ? e.data.description : null
    }
    runs.set(id, r)
  }
  const latest = new Map<string, { key: string; at: number; run: CentralRun }>()
  for (const r of runs.values()) {
    const held = latest.get(r.subject)
    if (!held || r.at > held.at) latest.set(r.subject, { key: r.key, at: r.at, run: r.run })
  }
  return latest
}
