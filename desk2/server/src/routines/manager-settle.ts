import { existsSync, rmSync } from 'node:fs'
import type { RoutineDefinition, RoutineRun } from '@shared/routines'
import { killHostTree, pidAlive, recordedPidOwner } from '../host/launch'
import type { Memory } from './decide'
import { TIMEOUT_DEFAULT } from './manifest'
import { readJson, runPaths, type RunFile, type RunResult } from './runner'
import { RUNNER_GRACE_MS, RUNNER_START_MS } from './manager-config'
import { finishRun, refreshStatus, save, type Manager } from './manager'
import { ageMs, outcomeOf } from './manager-files'
import { endCommandGroup, takeBack } from './manager-runs'

type Running = NonNullable<Memory['running']>

/** A command run being settled: its routine, its memory and files, and the moment of the look that settles it. */
interface Settling {
  id: string
  mem: Memory
  running: Running
  def: RoutineDefinition | null | undefined
  paths: ReturnType<typeof runPaths>
  t: number
}

/** The runs a look cannot watch from outside, read from their runners' files (routines/runner.ts): a command run whose
 *  runner wrote how it ended is recorded; one whose runner is gone without a word, interrupted; one past its timeout that
 *  its runner did not end is ended here; one whose runner never came for its spec, not started. A prompt run that never
 *  got its chat (Desk stopped as it started one) is interrupted. Each by the kind it started as, whatever its routine's
 *  file says now. One reading at a time, so no run is recorded twice; a run is recorded, and on disk, before its files go. */
export function settleCommands(m: Manager): Promise<void> {
  m.settling ??= (async () => {
    for (const [id, mem] of Object.entries(m.memory)) {
      const running = mem.running
      if (!running || running.workerId) continue
      const key = `${id}@${running.startedAt}`
      const def = m.seen.find((s) => s.entry.id === id)?.entry.def
      const t = m.clock()
      if (running.kind === 'prompt') {
        if (!m.startingPrompts.has(key))
          finishRun(m, id, mem, { startedAt: running.startedAt, endedAt: t, outcome: 'interrupted', exitCode: null, lastLine: 'AgentHydra restarted before its chat started', workerId: null, sessionId: null })
        continue
      }
      await settleCommandRun(m, { id, mem, running, def, paths: runPaths(m.runsDir, id), t })
    }
  })().finally(() => (m.settling = null))
  return m.settling
}

/** Records a run, refreshes its routine's status and, once the record is on disk, clears the run's files. */
function recordRun(m: Manager, s: Settling, r: Pick<RoutineRun, 'endedAt' | 'outcome' | 'lastLine'> & { exitCode?: number | null }, output = ''): void {
  finishRun(m, s.id, s.mem, { startedAt: s.running.startedAt, exitCode: null, workerId: null, sessionId: null, ...r }, output)
  if (s.def?.status) refreshStatus(m, s.def)
  try {
    m.writer.flushSync()
  } catch {
    return // Not on disk yet: a later save lands the record, and the routine's next start clears its files.
  }
  for (const f of [s.paths.spec, s.paths.taken, s.paths.run, s.paths.result]) {
    try {
      rmSync(f, { force: true })
    } catch {
      // Held for a moment (an indexer): the routine's next start clears it.
    }
  }
}

/** Records the run when its runner wrote how it ended. */
function endedRun(m: Manager, s: Settling): boolean {
  const result = readJson<RunResult>(s.paths.result)
  if (result?.startedAt !== s.running.startedAt) return false
  recordRun(m, s, { endedAt: s.running.startedAt + result.durationMs, outcome: outcomeOf(result), exitCode: result.code, lastLine: result.lastLine }, result.output ?? result.lastLine)
  return true
}

async function settleCommandRun(m: Manager, s: Settling): Promise<void> {
  if (endedRun(m, s)) return
  const runner = readJson<RunFile>(s.paths.run)
  if (runner?.startedAt === s.running.startedAt) {
    await settleLiveRunner(m, s, runner)
    return
  }
  // No runner file. A spec taken: the runner is saying it runs (a moment), or it died there.
  const takenAge = ageMs(s.paths.taken)
  if (takenAge !== null) {
    if (takenAge < RUNNER_START_MS) return
    if (!endedRun(m, s)) recordRun(m, s, { endedAt: s.t, outcome: 'interrupted', lastLine: 'its runner stopped as it started' })
    return
  }
  // A spec waiting: the runner has not come yet. Past the start window Desk takes it back, so a runner that comes late
  // finds nothing to run.
  const specAge = ageMs(s.paths.spec)
  if (specAge !== null) {
    if (specAge < RUNNER_START_MS) return
    if (!takeBack(s.paths.spec)) return // The runner took it just now.
    recordRun(m, s, { endedAt: s.t, outcome: 'failed', lastLine: `its runner did not start within ${RUNNER_START_MS / 1000} seconds` })
    return
  }
  // Nothing at all, or the spec gone since the read above: a run from a Desk before runners, or one whose runner
  // has just taken its spec.
  if (existsSync(s.paths.taken) || existsSync(s.paths.run) || endedRun(m, s)) return
  recordRun(m, s, { endedAt: s.t, outcome: 'interrupted', lastLine: 'AgentHydra restarted' })
}

/** A command run whose runner file is there: a runner that is gone is recorded; one still going is watched to its timeout. */
async function settleLiveRunner(m: Manager, s: Settling, runner: RunFile): Promise<void> {
  if (s.running.pid !== runner.pid) {
    s.running.pid = runner.pid
    save(m)
  }
  const owner = pidAlive(runner.pid) ? await recordedPidOwner(runner.pid, runner.pidStartedAt) : 'foreign'
  if (owner === 'foreign') {
    // Gone. Its result may have landed after the read above.
    if (endedRun(m, s)) return
    await endCommandGroup(runner)
    if (!endedRun(m, s)) recordRun(m, s, { endedAt: s.t, outcome: 'interrupted', lastLine: 'its runner ended without saying how the run ended' })
    return
  }
  const minutes = s.def?.timeoutMinutes ?? TIMEOUT_DEFAULT
  if (s.t - s.running.startedAt < minutes * 60_000 * m.timeoutScale + RUNNER_GRACE_MS) return
  // Its runner ends the command at the timeout and then itself; one still going hangs, and is ended here. A pid
  // whose start cannot be read is never killed: it is most likely a process that took the number since, one
  // this user cannot read. Nothing would ever end that run, so it is closed, its process left alone.
  if (owner === 'unknown') {
    if (!endedRun(m, s)) recordRun(m, s, { endedAt: s.t, outcome: 'interrupted', lastLine: `its runner could not be checked past its ${minutes}-minute timeout, so Desk stopped watching it and ended nothing` })
    return
  }
  if (!(await killHostTree(runner.pid, runner.pidStartedAt))) return
  await endCommandGroup(runner)
  if (!endedRun(m, s)) recordRun(m, s, { endedAt: s.t, outcome: 'timed-out', lastLine: `timed out after ${minutes} minutes; its runner did not end it, so Desk did` })
}
