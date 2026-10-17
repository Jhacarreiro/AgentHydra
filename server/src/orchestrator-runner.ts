/**
 * A toolbox run that acts on chats at length, outside the daemon (orchestrator.ts outlivesDaemon:
 * a move, an acting sweep, a fan_out spawn): started under a runner, read back only from files, and
 * so carried on by the next daemon after a restart.
 *
 * ⛔ WHY (owner, 2026-10-17: each part of AgentHydra must restart on its own without blocking or
 * breaking the others). A move ran as the daemon's own child, and Bun on Windows ends its children
 * when it exits, however it exits. On 2026-10-08 a restart 23 minutes into a 9-chat migrate_batch
 * left two chats on their new account and still unarchived on the old one, and seven never tried;
 * from then on every restart and auto-update was refused while a move ran (moveRestartRefusal), for
 * as long as an hour.
 *
 * So the python runs under the CliMayte runner (climayte-runner.ts: the native runner through the
 * WMI hand-off on Windows, this app in runner mode in its own session elsewhere), born outside the
 * daemon's tree. The runner owns the script's stdout and stderr files and writes its pid and exit to
 * files. This module reads only files, so a daemon that did not start the run watches it the same way
 * as the one that did.
 */

import { closeSync, existsSync, openSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runnerSpecPath, voidSpec } from './climayte-core'
import {
  launchRunner,
  RUNNER_CLAIM_MS,
  readRunnerExit,
  readRunnerPids,
  unclaimedFor,
} from './climayte-runner'
import { isPidAlive } from './core/process'
import { nativeCommandLines } from './core/win-process-table'

/** One run's files, all named by its operation id. The spec is `<out>.spec.json` (runnerSpecPath),
 *  and its path in the runner's command line is how a pid is known to be that runner's. */
export interface RunnerFiles {
  out: string
  err: string
  stdin: string
  spec: string
  pidFile: string
  exitFile: string
}

export function runnerFiles(dir: string, id: string): RunnerFiles {
  const out = join(dir, `${id}.out`)
  return {
    out,
    err: join(dir, `${id}.err`),
    stdin: join(dir, `${id}.stdin`),
    spec: runnerSpecPath(out),
    pidFile: join(dir, `${id}.pid.json`),
    exitFile: join(dir, `${id}.exit.json`),
  }
}

/** What a watch hands back: the shape of the orchestrator's in-process spawn. `*Dropped` counts the
 *  bytes left unread at the front of a file far longer than any answer keeps. */
export interface RunnerOutcome {
  code: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  stdoutDropped: number
  stderrDropped: number
}

/** Hand `command` to a runner outside this process's tree. Throws when there is no runner to start
 *  (climayte-runner.ts nativeRunner names the missing file). */
export function startRunner(
  files: RunnerFiles,
  command: string[],
  cwd: string,
  env: Record<string, string>,
): void {
  writeFileSync(files.stdin, '')
  launchRunner(
    {
      argv: command,
      cwd,
      env,
      stdin: files.stdin,
      stdout: files.out,
      stderr: files.err,
      pidFile: files.pidFile,
      exitFile: files.exitFile,
      fresh: true,
    },
    files.spec,
  )
}

/** Everything but the record, once the result is in it. */
export function removeRunnerFiles(files: RunnerFiles): void {
  for (const f of [
    files.out,
    files.err,
    files.stdin,
    files.pidFile,
    files.exitFile,
    files.spec,
    `${files.spec}.taken`,
  ])
    rmSync(f, { force: true })
}

const POLL_MS = 500
/** A runner writes its pid the moment it claims the spec, so one that claimed it and wrote nothing
 *  for this long died in between (the reading climayte-stops.ts RUNNER_CLAIM_GIVE_UP_MS makes). */
const CLAIM_GIVE_UP_MS = 5 * 60_000
/** Past the run's deadline its runner's tree was killed; this long after, the watch answers with
 *  what the files hold (orchestrator.ts realSpawn's hard stop, the same bound). */
const HARD_STOP_GRACE_MS = 30_000
/** The most of each output file read back: an answer keeps 200k characters of it anyway. */
const READ_CAP_BYTES = 8 * 1024 * 1024

/** 'gone' once the pid is dead or, on Windows, held by a process whose command line does not name
 *  this run's spec (a pid reused after the runner died). 'unknown' when the line cannot be read: it
 *  is then neither given up on nor killed. */
function runnerState(pid: number, spec: string): 'ours' | 'gone' | 'unknown' {
  if (!isPidAlive(pid)) return 'gone'
  if (process.platform !== 'win32') return 'ours'
  const line = nativeCommandLines([pid])?.get(pid)
  if (!line) return 'unknown'
  return line.includes(spec) ? 'ours' : 'gone'
}

/** End a runner and everything it started. The Windows runner holds its script in a kill-on-close job
 *  (misc/climayte-runner-native, job.rs), so ending the runner ends the job; elsewhere the runner leads
 *  its own session and process group (launchRunner's detached spawn), so the group goes at once. */
function killRunner(pid: number): void {
  try {
    process.kill(process.platform === 'win32' ? pid : -pid, 'SIGKILL')
  } catch {
    // Already gone: the watch reads its exit, or its absence, on the next tick.
  }
}

function readTail(path: string): { text: string; dropped: number } {
  let fd: number | null = null
  try {
    const size = statSync(path).size
    const start = Math.max(0, size - READ_CAP_BYTES)
    const buf = Buffer.alloc(size - start)
    fd = openSync(path, 'r')
    readSync(fd, buf, 0, buf.length, start)
    return { text: buf.toString('utf8'), dropped: start }
  } catch {
    return { text: '', dropped: 0 }
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/**
 * Watch a run until it ends, from its files alone. `onProcess` gets the kill switch at once: before
 * the runner claims the spec it voids it, so nothing ever starts; after, it kills the runner's tree
 * (the Windows runner's job takes the script and what it started with it).
 */
export function watchRunner(
  files: RunnerFiles,
  run: { startedAt: number; timeoutMs: number },
  onProcess?: (kill: () => void) => void,
): Promise<RunnerOutcome> {
  return new Promise((resolve) => {
    let timedOut = false
    let voided = false
    let confirmed = false
    const state = (pid: number) => {
      if (confirmed) return isPidAlive(pid) ? 'ours' : 'gone'
      const s = runnerState(pid, files.spec)
      confirmed = s === 'ours'
      return s
    }
    const kill = () => {
      if (voidSpec(files.out)) {
        voided = true
        return
      }
      const pid = readRunnerPids(files.pidFile)?.runner
      if (pid && state(pid) === 'ours') killRunner(pid)
    }
    const finish = (code: number | null, note?: string) => {
      clearInterval(timer)
      const out = readTail(files.out)
      const err = readTail(files.err)
      const stderr = note
        ? `${err.text}${err.text && !err.text.endsWith('\n') ? '\n' : ''}[agenthydra] ${note}\n`
        : err.text
      resolve({
        code,
        stdout: out.text,
        stderr,
        timedOut,
        stdoutDropped: out.dropped,
        stderrDropped: err.dropped,
      })
    }
    const step = () => {
      const now = Date.now()
      const exit = readRunnerExit(files.exitFile)
      if (exit)
        return finish(
          exit.code,
          exit.error ? `the script could not start: ${exit.error}` : undefined,
        )
      if (!timedOut && now >= run.startedAt + run.timeoutMs) {
        timedOut = true
        kill()
      }
      if (voided) return finish(null, 'stopped before its runner started it; nothing ran')
      const pids = readRunnerPids(files.pidFile)
      if (pids) {
        if (state(pids.runner) === 'gone') {
          // Read again: the runner may have written its exit and ended since the first read.
          const late = readRunnerExit(files.exitFile)
          return finish(
            late?.code ?? null,
            late
              ? undefined
              : 'its runner ended without writing an exit (killed, or the PC restarted)',
          )
        }
      } else if (existsSync(files.spec)) {
        // Null while this daemon's hand-off is still on its way: not started yet is not lost.
        const age = unclaimedFor(files.spec, run.startedAt, now)
        if (age !== null && age > RUNNER_CLAIM_MS && voidSpec(files.out))
          return finish(
            null,
            `its runner never started within ${RUNNER_CLAIM_MS / 1000} s; nothing ran`,
          )
      } else if (now - run.startedAt > CLAIM_GIVE_UP_MS) {
        return finish(null, 'its runner took the run and never wrote its pid')
      }
      if (now >= run.startedAt + run.timeoutMs + HARD_STOP_GRACE_MS)
        return finish(
          null,
          `the run did not settle within ${Math.round((run.timeoutMs + HARD_STOP_GRACE_MS) / 1000)}s of starting (deadline ${Math.round(run.timeoutMs / 1000)}s + grace) and was abandoned; its exit code is unknown.`,
        )
    }
    // A tick that throws is a tick skipped, never an uncaught exception (the daemon exits on one).
    const tick = () => {
      try {
        step()
      } catch (err) {
        console.error(`[orchestrator] watching ${files.out}:`, err)
      }
    }
    const timer = setInterval(tick, POLL_MS)
    // A daemon is long-lived anyway; a watch must never be why a test run or a CLI refuses to exit.
    timer.unref?.()
    onProcess?.(kill)
  })
}
