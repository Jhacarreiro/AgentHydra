// What Desk keeps of each Free operation on disk, and the runner each one's harness runs under, so a Desk restart
// (POST /api/server/restart, an update) neither ends a message on its way nor forgets its reply (owner, 2026-10-17:
// each part of AgentHydra restarts on its own without breaking the others). Before, FreeInstances.stop() aborted every
// running operation and the operations lived only in Desk's memory: the daemon then read 404 and reported
// operation_lost while the provider turn may or may not have landed. On Windows Bun ends a process's own children when
// it ends, however it ends (measured 2026-10-12), so the harness runs under a runner (job-runner.ts) started outside
// Desk's process tree through host/launch.ts detachedCommand, as a routine's command runs (routines/runner.ts).
//
// In <home>/free/jobs, per operation id:
//   <id>.job.json          Desk's record (JobRecord): what GET /api/free/jobs answers, before and after a restart.
//   <id>.spec.json         what the runner runs; the environment and the message travel in it (WMI starts the runner
//                          with the user's default environment). The runner takes it by rename (.taken) and deletes it.
//   <id>.run.json          the runner's pid, and when it started (the proof the pid is still it).
//   <id>.result.json       how the harness ended, whole, written before the runner goes.
//   <id>.cancel            a cancel: the runner ends its harness and says so in its result.
// The runner's files go once the record holds the result; the record goes 15 minutes after the operation ended.

import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { access, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FreeJob, FreeRequest } from '@shared/free-instances'
import { detachedCommand, killHostTree, pidAlive, recordedPidOwner, startDetached } from '../host/launch'
import { spawnOff, type SpawnOffOptions } from '../lib/spawn-off'
import { readJson, writeJson } from '../routines/runner'
import type { RequestCoordinatorEndpoint } from './request-coordinator'
import type { FreeRunRequest, RunOutput } from './runner'

/** The runner program. */
export const JOB_RUNNER_ENTRY = join(import.meta.dir, 'job-runner.ts')

/** A runner that has not taken its spec, or said it runs, this long after either was written never will. */
export const RUNNER_START_MS = 60_000
/** Past its harness's own timeout plus this, a runner that has not ended is ended by Desk. */
const RUNNER_GRACE_MS = 2 * 60_000
/** A cancelled runner that has not said it ended its harness this long after the cancel is ended by Desk. */
const CANCEL_GRACE_MS = 5_000
/** How long the launcher (a powershell asking WMI) may take. Measured 1.4 s on an idle PC (2026-10-17). */
const LAUNCH_MS = 60_000
/** How often a watch looks at the runner's files, and how often it proves the runner's pid is still the runner. */
const POLL_MS = 200
const OWNER_EVERY_MS = 5_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** What the runner runs: the harness (runner.ts commandArgs), or a ChatGPT message beyond the browser slots through
 *  the request coordinator (request-coordinator.ts), which falls back to the harness when it took no request. */
export interface JobSpec {
  id: string
  spawn: SpawnOffOptions
  coordinator?: { endpoint: RequestCoordinatorEndpoint; request: FreeRunRequest; stateDir: string }
}

/** <id>.run.json: the runner's pid, when it started, and its harness's timeout (Desk's backstop counts from it). */
export interface JobRun {
  id: string
  pid: number
  pidStartedAt: number
  timeoutMs: number
}

/** <id>.result.json. `stopped`: the harness was cancelled, capped or timed out; `error`: it did not run to its end
 *  (`launch_failed` when it could not start). */
export interface JobResult {
  id: string
  code: number
  stdout: string
  stopped?: boolean
  error?: string
}

/** <id>.job.json. `request` holds the message until the operation ends, so an operation the last Desk never got to
 *  start can be started by the next one. `detached`: its harness runs under a runner. `desk`: the pid of the Desk that
 *  runs it, and `left` once that Desk stopped and left it to the next (FreeInstances.adopt). */
export interface JobRecord {
  job: FreeJob
  fingerprint: string
  request: FreeRequest
  detached: boolean
  desk: number
  left?: boolean
}

export interface JobPaths {
  record: string
  spec: string
  taken: string
  run: string
  result: string
  cancel: string
}

export function jobPaths(dir: string, id: string): JobPaths {
  const spec = join(dir, `${id}.spec.json`)
  return { record: join(dir, `${id}.job.json`), spec, taken: `${spec}.taken`, run: join(dir, `${id}.run.json`), result: join(dir, `${id}.result.json`), cancel: join(dir, `${id}.cancel`) }
}

/** Desk's stop reached an operation whose runner goes on (or that never started): the next Desk takes it over. */
export class LeftRunning extends Error {
  constructor() {
    super('left to the next Desk')
  }
}

function remove(file: string): void {
  try {
    rmSync(file, { force: true })
  } catch {
    // Held for a moment (an indexer): the record's drop or the next prune tries again.
  }
}

// A watch's looks are asynchronous: every running operation looks five times a second, on Desk's one loop.

/** Takes a spec back from a runner that has not come for it: false when the runner took it first. */
async function takeBack(spec: string): Promise<boolean> {
  try {
    await rename(spec, `${spec}.cancelled`)
  } catch {
    return false
  }
  await rm(`${spec}.cancelled`, { force: true }).catch(() => {})
  return true
}

async function ageMs(file: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(file)).mtimeMs
  } catch {
    return null
  }
}

function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  )
}

/** readJson's twin: a JSON file's value, or null when it is missing or does not parse. */
async function readJsonFile<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T
  } catch {
    return null
  }
}

/** The records and runner files of one Desk home's Free operations. */
export class JobFiles {
  constructor(readonly dir: string) {}

  paths(id: string): JobPaths {
    return jobPaths(this.dir, id)
  }

  /** Writes a record whole and flushed: a restart a moment later still finds it. */
  save(record: JobRecord): void {
    mkdirSync(this.dir, { recursive: true })
    writeJson(this.paths(record.job.id).record, record)
  }

  /** True once a runner was asked for: its spec, or anything the runner wrote, is there. */
  launched(id: string): boolean {
    const p = this.paths(id)
    return existsSync(p.spec) || existsSync(p.taken) || existsSync(p.run) || existsSync(p.result)
  }

  /** The runner's files, once the record holds how the operation ended. */
  clearRunner(id: string): void {
    const p = this.paths(id)
    for (const f of [p.spec, p.taken, p.run, p.result, p.cancel]) remove(f)
  }

  drop(id: string): void {
    this.clearRunner(id)
    remove(this.paths(id).record)
  }

  /** Every readable record; one that is damaged, or not an operation's, is dropped. */
  load(): JobRecord[] {
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const out: JobRecord[] = []
    for (const name of names) {
      const id = /^(.+)\.job\.json$/.exec(name)?.[1]
      if (!id || !UUID.test(id)) continue
      const r = readJson<JobRecord>(this.paths(id).record)
      const ok = r && r.job?.id === id && r.request?.requestId === id && r.request.instanceId === r.job.instanceId && typeof r.fingerprint === 'string' && (r.job.state === 'running' || r.job.state === 'done')
      if (ok) out.push(r)
      else this.drop(id)
    }
    return out
  }
}

/**
 * Starts the runner for `spec`, hidden and outside Desk's process tree (host/launch.ts detachedCommand). On Windows the
 * powershell that asks WMI runs on the spawn-off worker (lib/spawn-off.ts): a process start there takes seconds on a
 * busy PC, and Free starts many. Answers why the runner could not be started, once that is known (null meanwhile); the
 * watch takes its spec back then, so no runner that comes late runs it.
 */
export function launchRunner(paths: JobPaths, spec: JobSpec): () => string | null {
  mkdirSync(dirname(paths.spec), { recursive: true })
  for (const f of [paths.taken, paths.run, paths.result, paths.cancel]) rmSync(f, { force: true })
  writeJson(paths.spec, spec)
  const argv = [process.execPath, JOB_RUNNER_ENTRY, '--spec', paths.spec]
  let failure: string | null = null
  if (process.platform === 'win32') {
    // No pipes: Start-Process (the fallback when WMI refuses) may hand them to the runner, and the result would wait on it.
    const plan = detachedCommand('win32', argv)
    void spawnOff({ cmd: plan.argv, stdout: 'ignore', stderr: 'ignore', timeoutMs: LAUNCH_MS }).then(
      (out) => {
        if (out.code !== 0) failure = out.timedOut ? `its launcher did not finish within ${LAUNCH_MS / 1000} s` : `WMI and Start-Process both refused it (its launcher exited ${out.code})`
      },
      (err: Error) => (failure = err.message),
    )
  } else startDetached(argv, (why) => (failure = why))
  return () => failure
}

/** How a watch ended. `left`: Desk is stopping, and the runner goes on. `not-taken`: no runner came for the spec, which
 *  was taken back, so none will. */
export type Watched =
  | { end: 'result'; result: JobResult }
  | { end: 'left' }
  | { end: 'not-taken'; why: string }
  | { end: 'cancelled' }
  | { end: 'lost'; why: string }

export interface WatchOptions {
  /** A cancel: the runner is told to end its harness, and ended here when it does not. */
  cancel: AbortSignal
  /** Desk's stop: the watch ends, the runner goes on. */
  leave: AbortSignal
  /** Why the runner could not be started (launchRunner), when this Desk started it. */
  failed?: () => string | null
}

/** Off Windows the runner leads its own process group, which its harness is in and which the runner's end does not end:
 *  that group is ended once the runner is gone (a group's id is not reused while any of it runs). On Windows a runner's
 *  end ends its harness (Bun ends its children). */
function endGroup(run: JobRun): void {
  if (process.platform === 'win32') return
  try {
    process.kill(-run.pid, 'SIGKILL')
  } catch {
    // Its group has ended.
  }
}

function pause(ms: number, signals: AbortSignal[]): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      clearTimeout(timer)
      for (const s of signals) s.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    for (const s of signals) s.addEventListener('abort', done, { once: true })
  })
}

/** Watches an operation's runner until its result is there, the runner is gone, or Desk stops. */
export async function watchRunner(paths: JobPaths, id: string, o: WatchOptions): Promise<Watched> {
  /** A result written after the look that found the runner gone wins. */
  const final = async (w: Watched): Promise<Watched> => {
    const result = await readJsonFile<JobResult>(paths.result)
    return result?.id === id ? { end: 'result', result } : w
  }
  let run: JobRun | null = null
  let cancelledAt: number | null = null
  let ownerAt = 0
  let missing = 0
  for (;;) {
    if (o.leave.aborted) return { end: 'left' }
    if (await exists(paths.result)) {
      const w = await final({ end: 'lost', why: 'its result could not be read' })
      if (w.end === 'result') return w
    }
    if (o.cancel.aborted && cancelledAt === null) {
      cancelledAt = Date.now()
      // A failed write is ended below once the grace is over.
      await writeFile(paths.cancel, '').catch(() => {})
    }
    // The runner writes its file once.
    run ??= await readJsonFile<JobRun>(paths.run)
    if (run?.id === id) {
      missing = 0
      const dead = !pidAlive(run.pid)
      let foreign = false
      if (!dead && Date.now() - ownerAt > OWNER_EVERY_MS) {
        ownerAt = Date.now()
        foreign = (await recordedPidOwner(run.pid, run.pidStartedAt)) === 'foreign'
      }
      if (dead || foreign) {
        // A pid another process took since means the runner's group had ended, and the group of that id is a stranger's.
        if (dead) endGroup(run)
        return final({ end: 'lost', why: 'its runner ended without saying how the operation ended' })
      }
      const cancelOver = cancelledAt !== null && Date.now() - cancelledAt > CANCEL_GRACE_MS
      if (cancelOver || Date.now() - run.pidStartedAt > run.timeoutMs + RUNNER_GRACE_MS) {
        if (await killHostTree(run.pid, run.pidStartedAt)) endGroup(run)
        return final(cancelOver ? { end: 'cancelled' } : { end: 'lost', why: 'its runner did not end it past its timeout, so Desk did' })
      }
    } else if (await exists(paths.taken)) {
      // The runner is saying it runs (a moment), or it died there.
      missing = 0
      if (((await ageMs(paths.taken)) ?? 0) > RUNNER_START_MS) return final({ end: 'lost', why: 'its runner stopped as it started' })
    } else if (await exists(paths.spec)) {
      missing = 0
      const why = o.cancel.aborted ? 'cancelled' : (o.failed?.() ?? (((await ageMs(paths.spec)) ?? 0) > RUNNER_START_MS ? `its runner did not start within ${RUNNER_START_MS / 1000} s` : null))
      if (why && (await takeBack(paths.spec))) return why === 'cancelled' ? { end: 'cancelled' } : { end: 'not-taken', why }
    } else if (++missing > 2) {
      // Nothing twice running: not a runner between its spec and its run file.
      return final({ end: 'lost', why: 'its runner files are gone' })
    }
    await pause(POLL_MS, [o.cancel, o.leave])
  }
}

/** A watch's end as runFree answers: the harness's output, or the error execute() records as an interruption. */
export function outputOf(w: Watched): RunOutput {
  if (w.end === 'left') throw new LeftRunning()
  if (w.end === 'result') {
    if (w.result.error === 'launch_failed') throw new Error('launch_failed')
    if (w.result.stopped || w.result.error) throw new Error('stopped')
    return { code: w.result.code, stdout: w.result.stdout }
  }
  throw new Error(w.end === 'not-taken' ? 'launch_failed' : 'stopped')
}
