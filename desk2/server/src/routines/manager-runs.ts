import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { RoutineDefinition } from '@shared/routines'
import { isActiveWorkerStatus } from '../bridge/climayte'
import { chatAddOns } from '../engine/desk-prompt'
import { recordedPidOwner, startDetached } from '../host/launch'
import type { Memory, Seen } from './decide'
import { TIMEOUT_DEFAULT } from './manifest'
import { lastLineOf, LINE_CHARS, message } from './proc'
import { RUNNER_ENTRY, runPaths, writeJson, type RunFile, type RunSpec } from './runner'
import { TASK_NEVER_RAN, TASK_RUNNING } from './wintask'
import { finishRun, keepHistory, save, type Manager } from './manager'
import { reportStarted } from './manager-board'
import { groupStamp, localStamp } from './manager-files'
import { LOG_MAX_BYTES, RUNS_KEPT, type WorkerView } from './manager-config'

/** Starts a command run: its runner (routines/runner.ts), hidden and outside Desk's process tree, runs it, writes its log
 *  and says how it ended; settleCommands reads that. */
export function startCommand(m: Manager, def: RoutineDefinition, mem: Memory, startedAt: number): void {
  mkdirSync(m.logsDir, { recursive: true })
  mkdirSync(m.runsDir, { recursive: true })
  const log = join(m.logsDir, `${def.id}.log`)
  try {
    if (statSync(log).size > LOG_MAX_BYTES) renameSync(log, `${log}.1`)
  } catch {
    // No log yet.
  }
  const paths = runPaths(m.runsDir, def.id)
  const spec: RunSpec = {
    id: def.id,
    startedAt,
    launchedAt: startedAt + (Date.now() - m.clock()),
    argv: def.run ?? [],
    // A runner WMI starts sits in system32: the folder is resolved here, against Desk's own, as the run had it before.
    cwd: resolve(process.cwd(), def.cwd ?? '.'),
    env: { ...process.env, PYTHONIOENCODING: 'utf-8' } as Record<string, string>,
    timeoutMs: (def.timeoutMinutes ?? TIMEOUT_DEFAULT) * 60_000 * m.timeoutScale,
    log,
  }
  const notStarted = (why: string): void =>
    finishRun(m, def.id, mem, { startedAt, endedAt: m.clock(), outcome: 'failed', exitCode: null, lastLine: `its runner could not start: ${why}`.slice(0, LINE_CHARS), workerId: null, sessionId: null })
  try {
    for (const f of [paths.spec, paths.taken, paths.run, paths.result]) rmSync(f, { force: true })
    writeJson(paths.spec, spec)
    // The powershell is a console program (hidden); it exits once WMI has started the runner. When it could not, the
    // run fails at once with its reason, the spec taken back as settleCommands takes back one no runner came for.
    startDetached([process.execPath, RUNNER_ENTRY, '--spec', paths.spec], (why) => {
      if (mem.running?.startedAt !== startedAt || !takeBack(paths.spec)) return
      notStarted(why)
    })
  } catch (err) {
    rmSync(paths.spec, { force: true })
    notStarted(message(err))
  }
}

/** Takes a spec back from a runner that has not come for it: false when the runner took it first. */
export function takeBack(spec: string): boolean {
  try {
    renameSync(spec, `${spec}.cancelled`)
  } catch {
    return false
  }
  try {
    rmSync(`${spec}.cancelled`, { force: true })
  } catch {
    // Held for a moment: the routine's next start clears its files.
  }
  return true
}

/** Off Windows a command leads its own process group, which its runner's end does not end: once the runner is gone or
 *  ended, its group is ended too, when its leader is proven to be the command still (by its start). On Windows the
 *  runner's end ended its command (Bun ends its children). */
export async function endCommandGroup(runner: RunFile): Promise<void> {
  if (process.platform === 'win32' || runner.commandPid === null || typeof runner.commandStartedAt !== 'number') return
  if ((await recordedPidOwner(runner.commandPid, runner.commandStartedAt)) !== 'ours') return
  try {
    process.kill(-runner.commandPid, 'SIGKILL')
  } catch {
    // Its group has ended.
  }
}

/** Starts a prompt run: a Desk chat, its prompt led by a short header that says whose routine it is and who asked for it. */
async function startPrompt(m: Manager, def: RoutineDefinition, mem: Memory, startedAt: number): Promise<void> {
  const header = `This is the routine "${def.name}" run by AgentHydra's routine manager at ${localStamp(startedAt)}; asked for by ${def.askedBy}. Do exactly what it says; never create, change, pause or schedule any routine or scheduled task.`
  const key = `${def.id}@${startedAt}`
  m.startingPrompts.add(key)
  try {
    const w = await m.workers.start({
      prompt: `${header}\n\n${def.prompt ?? ''}`,
      cwd: def.cwd ?? '',
      title: `Routine: ${def.name}`,
      group: `routine-${def.id}-${groupStamp(startedAt)}`,
      desk: chatAddOns(def.cwd ?? '', false),
    })
    mem.running = { startedAt, kind: 'prompt', pid: null, workerId: w.id, sessionId: w.sessionId }
    save(m)
  } catch (err) {
    finishRun(m, def.id, mem, { startedAt, endedAt: m.clock(), outcome: 'failed', exitCode: null, lastLine: message(err).slice(0, LINE_CHARS), workerId: null, sessionId: null })
  } finally {
    m.startingPrompts.delete(key)
  }
}

/** Starts one run of a routine now. The run is marked running before anything waits, so no second run starts meanwhile.
 *  It starts at the clock's now, not at its look's: the status commands a look reads first can take a minute. */
export function startRun(m: Manager, def: RoutineDefinition, mem: Memory, slot: number | null): void {
  const t = m.clock()
  mem.running = { startedAt: t, kind: def.prompt !== undefined ? 'prompt' : 'command', pid: null, workerId: null, sessionId: null, slot }
  if (slot !== null) mem.lastSlot = slot
  save(m)
  reportStarted(m, def.id, mem.running)
  if (def.prompt !== undefined) void startPrompt(m, def, mem, t)
  else startCommand(m, def, mem, t)
}

/** The prompt runs going on: each whose chat has ended is recorded; each past its timeout is cancelled and recorded. */
export async function pollPrompts(m: Manager, t: number): Promise<void> {
  for (const [id, mem] of Object.entries(m.memory)) {
    const running = mem.running
    if (!running?.workerId) continue
    const workerId = running.workerId
    const minutes = m.seen.find((s) => s.entry.id === id)?.entry.def?.timeoutMinutes ?? TIMEOUT_DEFAULT
    let w: WorkerView | null
    try {
      w = await m.workers.read(workerId)
    } catch {
      continue
    }
    if (w && isActiveWorkerStatus(w.status)) {
      if (t - running.startedAt < minutes * 60_000 * m.timeoutScale) continue
      await m.workers.cancel(workerId).catch(() => undefined)
      finishRun(m, id, mem, { startedAt: running.startedAt, endedAt: m.clock(), outcome: 'timed-out', exitCode: null, lastLine: `timed out after ${minutes} minutes`, workerId, sessionId: running.sessionId })
      continue
    }
    const failed = !w || w.error !== null || /fail|cancel|stop|error/.test(w.status)
    const last = w ? lastLineOf(w.result ?? w.error ?? '') || w.status : 'its chat is gone'
    finishRun(m, id, mem, { startedAt: running.startedAt, endedAt: m.clock(), outcome: failed ? 'failed' : 'ok', exitCode: null, lastLine: last.slice(0, LINE_CHARS), workerId, sessionId: w?.sessionId ?? running.sessionId }, w?.result ?? '')
  }
}

/** A Windows task's last run, recorded once when it is newer than the newest one kept. Still running, or never ran: nothing. */
export function recordTaskRun(m: Manager, s: Seen, mem: Memory): void {
  const task = s.task
  if (!task?.found || task.lastRunAt === null || task.lastTaskResult === null) return
  if (task.lastTaskResult === TASK_RUNNING || task.lastTaskResult === TASK_NEVER_RAN) return
  if (mem.runs[0] && task.lastRunAt <= mem.runs[0].startedAt) return
  const code = task.lastTaskResult
  // Windows says when a task started and never when it ended, so its start stands for both. The time of this look
  // is no run time: after a restart every task read as run minutes ago (2026-10-12: a 03:00 run read "21 min ago").
  mem.runs.unshift({ startedAt: task.lastRunAt, endedAt: task.lastRunAt, outcome: code === 0 ? 'ok' : 'failed', exitCode: code, lastLine: `Windows task result ${code}`, workerId: null, sessionId: null })
  mem.runs.splice(RUNS_KEPT)
  save(m)
  keepHistory(m, s.entry.id, mem)
}
