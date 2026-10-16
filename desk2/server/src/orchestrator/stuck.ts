// CliMayte workers that sit stuck: nothing else is going to move them, so the orchestrator flags them (plugins/70-orchestrator.ts).
// Pure: the daemon's workers in, the stuck ones out. A queued, running or checking worker is never stuck.

import type { CliMayteWorker } from '@shared/protocol'

/** A held or unanswered worker is stuck once it has sat this long. */
export const STUCK_MS = 2 * 3_600_000
/** A usage wall whose end passed this long ago and still holds the worker is stuck. */
export const WALL_OVERDUE_MS = 30 * 60_000

export type StuckReason = 'question' | 'wave' | 'held' | 'wall'

export interface Stuck {
  worker: CliMayteWorker
  reason: StuckReason
  /** Epoch ms it has been stuck since. */
  since: number
  /** The reason in plain words: the question, the hold or error line, or what a manager waits on. */
  why: string
}

const cut = (s: string, n = 300): string => (s.replace(/\s+/g, ' ').trim().length > n ? `${s.replace(/\s+/g, ' ').trim().slice(0, n)}...` : s.replace(/\s+/g, ' ').trim())

export function stuckWorkers(workers: readonly CliMayteWorker[], now: number): Stuck[] {
  const liveWaves = new Set(workers.filter((t) => t.kind !== 'manage' && t.active).map((t) => t.wave))
  const out: Stuck[] = []
  for (const w of workers) {
    const stuck = stuckOf(w, now, liveWaves)
    if (stuck) out.push(stuck)
  }
  return out
}

/** Why one worker is stuck, or nothing: a worker is judged by its first matching state. */
function stuckOf(w: CliMayteWorker, now: number, liveWaves: ReadonlySet<CliMayteWorker['wave']>): Stuck | undefined {
  if (w.pc || (w.active && w.status !== 'waiting')) return undefined
  if (w.status === 'done' && w.question) return questionStuck(w, w.question, now)
  if (w.status !== 'waiting') return undefined
  const wall = w.waitUntil ? Date.parse(w.waitUntil) : NaN
  if (Number.isFinite(wall)) return wallStuck(w, wall, now)
  const changed = w.lastActivityAt ?? w.startedAt ?? now
  if (now - changed <= STUCK_MS) return undefined
  if (w.kind === 'manage' && w.hold === 'wave') {
    if (liveWaves.has(w.wave)) return undefined
    return { worker: w, reason: 'wave', since: changed, why: `wave ${w.wave ?? '?'}: this manager waits on it, but none of its tasks is live` }
  }
  return { worker: w, reason: 'held', since: changed, why: `it is held: ${cut(w.lastActivity ?? w.error ?? 'no reason given')}` }
}

function questionStuck(w: CliMayteWorker, question: NonNullable<CliMayteWorker['question']>, now: number): Stuck | undefined {
  if (now - question.at <= STUCK_MS) return undefined
  return { worker: w, reason: 'question', since: question.at, why: `it asked: ${cut(question.text)}` }
}

function wallStuck(w: CliMayteWorker, wall: number, now: number): Stuck | undefined {
  if (now - wall <= WALL_OVERDUE_MS) return undefined
  return { worker: w, reason: 'wall', since: wall, why: `it waits on a usage wall that ended ${new Date(wall).toISOString().replace(/\.\d+Z$/, 'Z')} and still holds it` }
}
