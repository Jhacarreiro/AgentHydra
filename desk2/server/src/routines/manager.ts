import { join } from 'node:path'
import type { RoutineDefinition, RoutineProposal, RoutineRun, RunDescription } from '@shared/routines'
import type { AsyncFile } from '../async-file'
import type { ServerContext } from '../context'
import { emptyMemory, parseReading, slotsOf, type Memory, type Reading, type Seen } from './decide'
import type { Describer } from './describe'
import type { Entry } from './manifest'
import { routineBrokenMessage, routineIncidentAction } from './incident'
import { appendRows, descriptionRow, readHistory, syncHistory } from './history'
import { LINE_CHARS, message, runArgv } from './proc'
import { RUNS_KEPT, STATUS_MS, type RoutineIncidents, type RoutineTasks, type RoutineWorkers } from './manager-config'
import type { Central } from './manager-central'
import { reportDescribed, reportEnded } from './manager-board'

/** One routines manager's state: the folders it reads, its seams, and what its looks have seen and remember. */
export interface Manager {
  ctx: ServerContext
  routinesDir: string
  proposedDir: string
  logsDir: string
  runsDir: string
  historyDir: string
  writer: AsyncFile
  timeoutScale: number
  clock: () => number
  platform: NodeJS.Platform
  workers: RoutineWorkers
  incidents: RoutineIncidents
  tasks: RoutineTasks
  describer: Describer
  /** The central store routines-store.json names (routines/manager-central.ts), or null: none, or its file does not check
   *  out (`centralError` says why). */
  central: Central | null
  centralError: string | null
  memory: Record<string, Memory>
  /** The routines whose broken file this Desk has reported and not yet seen check out (in memory: a restart re-reports). */
  reportedBroken: Set<string>
  /** The prompt runs this Desk is starting (`<id>@<startedAt>`): their chat id is not known yet. */
  startingPrompts: Set<string>
  runCounts: Map<string, number>
  settling: Promise<void> | null
  seen: Seen[]
  proposals: RoutineProposal[]
  checkedAt: number | null
  nextCheckAt: number | null
  lastError: string | null
  timer: ReturnType<typeof setTimeout> | undefined
  looking: Promise<void> | null
  stopping: boolean
}

export function enabled(m: Manager): boolean {
  return m.ctx.settings().routines && !m.stopping
}

/** A routine's memory. The first time it is seen, a schedule starts from its newest slot: a slot already past never runs. */
export function memOf(m: Manager, entry: Entry, t: number): Memory {
  if (!m.runCounts.has(entry.id) && m.memory[entry.id]) keepHistory(m, entry.id, m.memory[entry.id])
  m.memory[entry.id] ??= emptyMemory(entry.def?.schedule !== undefined ? (slotsOf(entry, t)?.newest ?? t) : null)
  return m.memory[entry.id]
}

export function save(m: Manager): void {
  m.writer.write(JSON.stringify({ routines: m.memory }))
}

export function historyFile(m: Manager, id: string): string {
  return join(m.historyDir, `${id}.jsonl`)
}

/** Writes what the memory holds that the routine's full history does not (a new run; the first time, all of them). Best effort. */
export function keepHistory(m: Manager, id: string, mem: Memory): void {
  try {
    syncHistory(historyFile(m, id), mem.runs)
    m.runCounts.set(id, readHistory(historyFile(m, id)).length)
  } catch (err) {
    console.error('[routines] history did not save:', message(err))
  }
}

/** Records a run and keeps the newest RUNS_KEPT of them. When its routine describes its runs, a run that printed
 *  something (`output`) and was not busy is described in the background. */
export function finishRun(m: Manager, id: string, mem: Memory, r: RoutineRun, output = ''): void {
  const def = m.seen.find((s) => s.entry.id === id)?.entry.def
  const described = def?.describe === true && r.outcome !== 'busy' && output.trim() !== ''
  if (described) r.description = { state: 'pending', text: '' }
  mem.runs.unshift(r)
  mem.runs.splice(RUNS_KEPT)
  reportEnded(m, id, mem.running, r)
  mem.running = null
  save(m)
  keepHistory(m, id, mem)
  reportIncident(m, id, def?.name ?? id, r)
  if (described) void describeRun(m, id, def, r, output)
}

/** A failed or timed-out run opens the routine's incident and pings the owner; an ok run resolves it. Best effort:
 *  an AgentHydra that is down keeps the incident as it was, and the next run of this routine settles it. */
function reportIncident(m: Manager, id: string, name: string, r: RoutineRun): void {
  const action = routineIncidentAction({ id, name }, r)
  if (!action) return
  const sent = action.kind === 'record'
    ? m.incidents.record({ scope: action.scope, key: action.key, message: action.message })
    : m.incidents.resolve(action.scope, action.key)
  sent.catch(() => undefined)
}

/** A routine whose file does not check out, its Windows task is missing, or it is a Windows task off Windows: its reason, else null. */
function brokenReason(s: Seen): string | null {
  if (s.entry.broken !== null) return s.entry.broken
  if (s.task !== null && !s.task.found) return `no Windows task ${s.entry.def?.windowsTask}`
  return null
}

/** A broken routine opens one incident until it checks out again, then resolves it. A failed last run keeps its incident open. */
export function reportBroken(m: Manager, s: Seen): void {
  const id = s.entry.id
  const reason = brokenReason(s)
  if (reason !== null) {
    if (m.reportedBroken.has(id)) return
    m.reportedBroken.add(id)
    const name = s.entry.def?.name ?? (s.entry.broken === null ? undefined : s.entry.name) ?? id
    m.incidents.record({ scope: 'routine', key: id, message: routineBrokenMessage({ id, name }, reason) }).catch(() => undefined)
    return
  }
  if (!m.reportedBroken.delete(id)) return
  const last = m.memory[id]?.runs[0]
  if (last?.outcome === 'failed' || last?.outcome === 'timed-out') return
  m.incidents.resolve('routine', id).catch(() => undefined)
}

/** Asks for a run's description and keeps it on the run, found again by its start. A failure keeps its reason. */
async function describeRun(m: Manager, id: string, def: RoutineDefinition, r: RoutineRun, output: string): Promise<void> {
  let description: RunDescription
  try {
    const minutes = Math.round((r.endedAt - r.startedAt) / 6_000) / 10
    const text = await m.describer({ name: def.name, what: r.workerId ? 'prompt' : 'command', outcome: r.outcome, exitCode: r.exitCode, minutes, output })
    description = { state: 'done', text }
  } catch (err) {
    description = { state: 'failed', text: message(err).slice(0, LINE_CHARS) }
  }
  const kept = m.memory[id]?.runs.find((x) => x.startedAt === r.startedAt)
  if (!kept || m.stopping) return
  kept.description = description
  save(m)
  reportDescribed(m, id, r, description)
  try {
    appendRows(historyFile(m, id), [descriptionRow(r.startedAt, description)])
  } catch (err) {
    console.error('[routines] history did not save:', message(err))
  }
}

/** A status command's reading, or why it did not read. A failure is its reason, never a guess. */
export async function readStatus(def: RoutineDefinition): Promise<{ reading: Reading | null; readError: string | null }> {
  if (!def.status) return { reading: null, readError: null }
  const unread = (readError: string): { reading: null; readError: string } => ({ reading: null, readError })
  const r = await runArgv(def.status, { cwd: def.cwd, timeoutMs: STATUS_MS })
  if (r.timedOut) return unread('the status command timed out after 60 seconds')
  if (r.error !== null) return unread(`the status command could not start: ${r.error}`)
  if (r.code !== 0) return unread(`the status command exited ${r.code ?? 'without a code'}`)
  try {
    return { reading: parseReading(r.stdout), readError: null }
  } catch (err) {
    return unread(message(err))
  }
}

/** Reads a routine's status again after its run ended, in the background, so the page shows what the run left. */
export function refreshStatus(m: Manager, def: RoutineDefinition): void {
  void readStatus(def).then((fresh) => {
    m.seen = m.seen.map((s) => (s.entry.id === def.id ? { ...s, ...fresh } : s))
  })
}
