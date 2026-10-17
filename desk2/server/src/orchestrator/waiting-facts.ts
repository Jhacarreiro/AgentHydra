import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { CliMayteWorker } from '@shared/protocol'

const HOUR_MS = 3_600_000

/** A job or worker still running this long after a chat began waiting on it is overdue, and its chat is judged anyway. */
const WAIT_OVERDUE_MS = 6 * HOUR_MS

/** What the orchestrator found out about one thing a chat waits on, without a model. */
export interface Fact {
  /** The line for the judge. */
  text: string
  /** Still running and not yet overdue: its chat is left alone. */
  running: boolean
}

/** The plugin's GET of one of AgentHydra's own routes, null when the route did not answer ok. */
export type Get = <T>(path: string) => Promise<T | null>

const HSWARM_JOB = /^\d{8}-\d{6}-[0-9a-f]{4}$/
const WORKER_ID = /^w-[0-9a-f]{8}$/
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z')

/** What a job's record says (~/.hswarm/jobs/<id>/job.json): finished when and with what counts, or still running. */
function jobFact(id: string, now: number, hswarmHome: () => string): Fact {
  let job: { state?: unknown; finished?: unknown; summary?: { created?: unknown; finished?: unknown; counts?: unknown } }
  try {
    job = JSON.parse(readFileSync(join(hswarmHome(), 'jobs', id, 'job.json'), 'utf8'))
  } catch {
    return { text: `HSwarm job ${id}: no record of it could be read`, running: false }
  }
  const finished = typeof job.finished === 'string' && job.finished ? job.finished : typeof job.summary?.finished === 'string' ? job.summary.finished : ''
  const counts = job.summary?.counts && typeof job.summary.counts === 'object' ? Object.entries(job.summary.counts as Record<string, unknown>).map(([k, n]) => `${String(n)} ${k}`).join(', ') : ''
  if (finished && Number.isFinite(Date.parse(finished)))
    return { text: `HSwarm job ${id} finished at ${iso(Date.parse(finished))}${counts ? ` (${counts})` : ''}; its results: hswarm_results('${id}')`, running: false }
  const created = typeof job.summary?.created === 'string' ? Date.parse(job.summary.created) : NaN
  const overdue = Number.isFinite(created) && now - created > WAIT_OVERDUE_MS
  return { text: `HSwarm job ${id} is ${String(job.state ?? 'running')}${overdue ? ' and overdue' : ''}${counts ? ` (${counts})` : ''}`, running: !overdue }
}

function workerFact(id: string, w: CliMayteWorker | undefined, now: number): Fact {
  if (!w) return { text: `CliMayte worker ${id}: the daemon does not list it`, running: false }
  if (!w.active) return { text: `CliMayte worker ${id} is ${w.status}${w.endedAt ? ` since ${iso(w.endedAt)}` : ''}`, running: false }
  const overdue = w.startedAt !== null && now - w.startedAt > WAIT_OVERDUE_MS
  return { text: `CliMayte worker ${id} is ${w.status}${overdue ? ' and overdue' : ''}`, running: !overdue }
}

/** The facts that can be checked without a model about what a chat waits on: HSwarm job ids and CliMayte worker ids. */
export async function factsOf(on: readonly string[], now: number, hswarmHome: () => string, get: Get): Promise<Fact[]> {
  const out: Fact[] = []
  let workers: Map<string, CliMayteWorker> | null | undefined
  for (const id of on) {
    if (HSWARM_JOB.test(id)) out.push(jobFact(id, now, hswarmHome))
    else if (WORKER_ID.test(id)) {
      if (!workers) {
        const list = await get<CliMayteWorker[]>('/api/climayte/workers?all=1')
        workers = list && new Map(list.map((w) => [w.id, w]))
      }
      out.push(workerFact(id, workers?.get(id), now))
    }
  }
  return out
}
