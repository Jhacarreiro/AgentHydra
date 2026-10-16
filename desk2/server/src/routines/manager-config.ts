import { bridge } from '../bridge'
import { createClient, type AhWorker, type StartWorker } from '../bridge/client'
import type { Describer } from './describe'
import { readTasks, runTaskNow, setTaskEnabled, type TaskReading } from './wintask'

/** The first look after a start waits for the rest of Desk to come up. */
export const FIRST_LOOK_MS = 60_000
/** While a prompt run is going, the manager looks this often to see whether its chat has ended. */
export const PROMPT_LOOK_MS = 30_000
/** A status command has this long to print its object. */
export const STATUS_MS = 60_000
/** Runs kept per routine. */
export const RUNS_KEPT = 30
/** A run's log moves to <id>.log.1 once it passes this. */
export const LOG_MAX_BYTES = 2 * 1024 * 1024
/** The exit code a busy routine answers with: its own lock is held by another run. */
export const BUSY_EXIT = 75
/** A command run's runner has this long to say it runs (<id>.run.json) before the run counts as not started: twice a chat
 *  host's start, as a powershell asking WMI on a PC at full load can take tens of seconds. */
export const RUNNER_START_MS = 60_000
/** A runner still going this long past its run's timeout (it ends the command itself at the timeout) is ended here. */
export const RUNNER_GRACE_MS = 2 * 60_000

/** How a worker stands now: the bridge's view of it. */
export type WorkerView = Pick<AhWorker, 'status' | 'error' | 'result' | 'sessionId'>

/** Desk's chats, as a routine's prompt run uses them. The default is AgentHydra's own bridge. */
export interface RoutineWorkers {
  start(task: StartWorker): Promise<{ id: string; sessionId: string | null }>
  read(id: string): Promise<WorkerView | null>
  cancel(id: string): Promise<void>
}

/** AgentHydra's incidents, as a routine's failed, timed-out or ok run opens or resolves them. The default is the daemon. */
export interface RoutineIncidents {
  record(body: { scope: string; key: string; message: string }): Promise<unknown>
  resolve(scope: string, key: string): Promise<unknown>
}

export const liveIncidents: RoutineIncidents = {
  record: (body) => createClient().recordIncident(body),
  resolve: (scope, key) => createClient().resolveIncidents(scope, key),
}

/** Windows' scheduled tasks, as a windowsTask routine uses them. The default is PowerShell and schtasks. */
export interface RoutineTasks {
  read(paths: string[]): Promise<TaskReading[]>
  run(path: string): Promise<void>
  setEnabled(path: string, enabled: boolean): Promise<void>
}

export interface RoutinesOptions {
  /** Test seam: scales every routine's timeout (its minutes times this). The server leaves it at 1. */
  timeoutScale?: number
  /** Test seam: the clock. The server leaves it at Date.now. */
  now?: () => number
  /** Test seam: the chats a prompt run uses. */
  workers?: RoutineWorkers
  /** Test seam: the Windows tasks a windowsTask routine uses. */
  tasks?: RoutineTasks
  /** Test seam: the incidents a failed or timed-out run opens and an ok run resolves. The server posts to AgentHydra. */
  incidents?: RoutineIncidents
  /** Test seam: the platform a windowsTask routine needs. */
  platform?: NodeJS.Platform
  /** Test seam: what describes a run. The server asks Haiku 5.5 (routines/describe.ts). */
  describer?: Describer
}

export const liveWorkers: RoutineWorkers = {
  start: (task) => bridge().startWorker(task),
  read: async (id) => (await bridge().workersByIds([id]))[0] ?? null,
  cancel: (id) => bridge().cancelWorker(id),
}

export const liveTasks: RoutineTasks = { read: readTasks, run: runTaskNow, setEnabled: setTaskEnabled }
