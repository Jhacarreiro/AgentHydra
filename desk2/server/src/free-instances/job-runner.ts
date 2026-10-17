// The runner of one Free operation (jobs.ts), outside Desk's process tree: Desk starts it with jobs.ts launchRunner, so
// a Desk restart leaves the harness running, and the next Desk reads how it ended. It takes its spec by renaming it
// (Desk takes back a spec no runner came for the same way, so exactly one of them has it), says it runs in <id>.run.json,
// deletes the spec (the environment and the message are in it), runs the harness on the spawn-off worker, as Desk ran it
// before (lib/spawn-off.ts: its timeout, output cap and tree kill), and writes how it ended to <id>.result.json, whole,
// before it goes. A cancel is a file Desk writes: the runner ends its harness and says so. On Windows Bun ends a
// process's own children when it ends, so a runner that is killed takes its harness with it.

import { existsSync, renameSync, rmSync, utimesSync } from 'node:fs'
import { dirname } from 'node:path'
import { SpawnLaunchError, spawnOff } from '../lib/spawn-off'
import { readJson, writeJson } from '../routines/runner'
import { jobPaths, type JobResult, type JobRun, type JobSpec } from './jobs'
import { runCoordinatorRequest } from './request-coordinator'

/** How often the runner looks for a cancel. */
const CANCEL_POLL_MS = 250

async function main(): Promise<number> {
  const at = process.argv.indexOf('--spec')
  const specPath = at > 0 ? process.argv[at + 1] : undefined
  if (!specPath) return 2
  const taken = `${specPath}.taken`
  try {
    renameSync(specPath, taken)
    // A rename keeps the spec's own time; Desk measures the take from now.
    const now = new Date()
    utimesSync(taken, now, now)
  } catch {
    // Desk took it back before the runner came for it: it is no longer this runner's to run.
    return 2
  }
  const spec = readJson<JobSpec>(taken)
  if (!spec) {
    rmSync(taken, { force: true })
    return 2
  }
  const paths = jobPaths(dirname(specPath), spec.id)
  // Said before the spec goes, so at every moment one of them is there.
  writeJson(paths.run, { id: spec.id, pid: process.pid, pidStartedAt: Date.now(), timeoutMs: spec.spawn.timeoutMs ?? 300_000 } satisfies JobRun)
  rmSync(taken, { force: true })
  const stop = new AbortController()
  const cancel = setInterval(() => {
    if (existsSync(paths.cancel)) stop.abort()
  }, CANCEL_POLL_MS)
  let result: JobResult
  try {
    // A coordinator that took no request lets the harness run it, as runFree does.
    const coordinated = spec.coordinator ? await runCoordinatorRequest(spec.coordinator.endpoint, spec.coordinator.request, spec.coordinator.stateDir, stop.signal) : undefined
    if (coordinated) result = { id: spec.id, code: coordinated.code, stdout: coordinated.stdout }
    else {
      const out = await spawnOff(spec.spawn, stop.signal)
      result = { id: spec.id, code: out.code, stdout: Buffer.from(out.stdout.buffer, out.stdout.byteOffset, out.stdout.byteLength).toString('utf8'), ...(out.aborted || out.capped || out.timedOut ? { stopped: true } : {}) }
    }
  } catch (err) {
    result = { id: spec.id, code: -1, stdout: '', error: err instanceof SpawnLaunchError ? 'launch_failed' : 'stopped' }
  }
  clearInterval(cancel)
  // The run file stays: Desk deletes both once its record holds the result, so no moment shows neither.
  writeJson(paths.result, result)
  return 0
}

// The spawn-off worker would keep the process alive: it exits once its result is on disk.
if (import.meta.main) process.exit(await main())
