/**
 * HydraSwarm sidecar management.
 *
 * Starts, restarts with backoff, and stops the hswarm Python sidecar that the daemon exposes
 * through a proxy at /api/hswarm/*. Driven by a daemon setting and integrated into the boot
 * and shutdown sequence.
 *
 * The server outlives the daemon: every chat's hswarm MCP talks to it, so a self-update relaunch must
 * not end it and every call in flight on it. On Windows a child Bun.spawn starts sits in Bun's own
 * kill-on-close job and ends with the daemon (measured 2026-10-12: a new server pid after one
 * relaunch), so there it starts outside the daemon's tree (core/outside-start.ts), as the helpers do;
 * the daemon's exit leaves it running, and the next daemon adopts it as its own.
 */

import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdirSync, openSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { APP_ROOT, appEnv, DATA_DIR } from './config'
import { startOutsideDaemon } from './core/outside-start'
import { killProcessTree, spawnCaptured, startProcess } from './core/process'
import type { StartedChild } from './core/spawn-worker'
import { IS_PRIMARY_INSTALL } from './instance'

/** Default port hswarm listens on. */
const DEFAULT_HSWARM_PORT = 7793

const LOG_MAX_BYTES = 5 * 1024 * 1024

const hasPackage = (d: string) => existsSync(join(d, 'hswarm', '__init__.py'))

/** Where the `hswarm` package lives. `AGENTHYDRA_HSWARM_DIR` when set (and only it: a wrong
 *  override is reported, not quietly replaced), else the app root, then one level up (compiled dist/). */
export function hswarmDir(env: NodeJS.ProcessEnv = process.env, appRoot = APP_ROOT): string | null {
  const override = env.AGENTHYDRA_HSWARM_DIR?.trim()
  if (override) return hasPackage(override) ? override : null
  return [appRoot, join(appRoot, '..')].find(hasPackage) ?? null
}

/** hswarm's state dir; the sidecar and the proxy must agree on it (the console token lives here). */
export function hswarmHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HSWARM_HOME?.trim() || join(homedir(), '.hswarm')
}

/** The id hswarm prints for an account: hswarm/accounts.py account_id. It lives here, not in
 *  routes/hswarm.ts, because kit/ingest-claude.ts and routes/usage.ts need it, and importing a
 *  routes module registers its routes before index.ts mounts the /api guard (http-app.ts). */
export function hswarmAccountId(uuid: string): string {
  return `acct-${createHash('sha256').update(uuid, 'utf8').digest('hex').slice(0, 8)}`
}

/** `<logDir>/hswarm.log`, rotated one generation past 5 MiB first. */
function hswarmLogFile(logDir: string, maxBytes = LOG_MAX_BYTES): string {
  mkdirSync(logDir, { recursive: true })
  const file = join(logDir, 'hswarm.log')
  try {
    if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`)
  } catch {
    // no log yet, or a running server still has it open
  }
  return file
}

/** Open `<logDir>/hswarm.log` for append, rotating one generation past 5 MiB first. */
export function openHSwarmLog(logDir: string, maxBytes = LOG_MAX_BYTES): number {
  return openSync(hswarmLogFile(logDir, maxBytes), 'a')
}

/** The port hswarm should listen on. `HSWARM_PORT` env var or default. */
function hswarmPort(env: NodeJS.ProcessEnv = process.env): number {
  const override = env.HSWARM_PORT?.trim()
  if (override && /^\d+$/.test(override)) return parseInt(override, 10)
  return DEFAULT_HSWARM_PORT
}

/** The interpreter. `python` on Windows; `python3` on Unix. `AGENTHYDRA_PYTHON` names a specific binary. */
function pythonBinary(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  const override = env.AGENTHYDRA_PYTHON?.trim()
  if (override) return override
  return platform === 'win32' ? 'python' : 'python3'
}

/** Probe GET http://127.0.0.1:<port>/health and return the parsed response, or null if not hswarm. */
async function probeHSwarm(port: number, timeoutMs = 500): Promise<Record<string, unknown> | null> {
  const url = `http://127.0.0.1:${port}/health`
  try {
    const abortController = new AbortController()
    const timeout = setTimeout(() => abortController.abort(), timeoutMs)
    try {
      const response = await fetch(url, { signal: abortController.signal })
      if (response.status === 200) {
        const data: unknown = await response.json()
        if (
          typeof data === 'object' &&
          data !== null &&
          (data as Record<string, unknown>)['hswarm'] === true
        ) {
          return data as Record<string, unknown>
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  } catch {
    // connection failed, timeout, or invalid JSON
  }
  return null
}

/** Everything startHSwarm can be handed; tests inject spawn, probe and watchEveryMs to stay off the real port. */
interface HSwarmDeps {
  enabled?: boolean
  dir?: string
  python?: string
  port?: number
  logDir?: string
  env?: NodeJS.ProcessEnv
  spawn?: typeof Bun.spawn
  /** Spawns the ZSwarm import (tests pass a fake). */
  importSpawn?: typeof Bun.spawn
  importFirstMs?: number
  probe?: (port: number, timeoutMs?: number) => Promise<Record<string, unknown> | null>
  /** Ends a foreign server, or our own child gone silent, by pid (tests pass a fake). */
  kill?: (pid: number) => void
  /** Whether a pid still runs (tests pass a fake): how the exit of a server we hold no handle on is seen. */
  alive?: (pid: number) => boolean
  watchEveryMs?: number
  /** How long our own child may answer no /health before it is ended and started again. */
  silentLimitMs?: number
  /** A side-run daemon (not the primary install) never ends a server it did not start; defaults to
   *  `!IS_PRIMARY_INSTALL`. Tests inject it. */
  sideRun?: boolean
}

interface HSwarmState {
  running: boolean
  /** Whether the server's /health answered when last looked at; null before the first look. A server can run
   *  and still answer nobody (its event loop held), which the window must not call "running". */
  answering: boolean | null
  port: number | null
  pid: number | null
  lastError: string | null
}

let state: HSwarmState = {
  running: false,
  answering: null,
  port: null,
  pid: null,
  lastError: null,
}

/** The server this daemon owns: its own start, or the one the daemon before a relaunch started. */
let proc: StartedChild | null = null
/** What the last start was handed; a stop ends the server with its `kill`. */
let startDeps: HSwarmDeps = {}
let stopRequested = false
/** A start awaiting its worker (spawnServer): a second start meanwhile would run a second server. */
let starting = false
/** Close one spawn's log handle. Each handle is closed exactly once, by the spawn that opened it
 *  (its exit handler, or its own failed start): a second close could hit a reused fd number. */
function closeLog(fd: number): void {
  if (fd < 0) return
  try {
    closeSync(fd)
  } catch (e) {
    console.error('[hswarm] closing the log failed:', e instanceof Error ? e.message : String(e))
  }
}

/** Backoff: start with a 1s delay, cap at 30s. */
const MIN_BACKOFF_MS = 1_000
const MAX_BACKOFF_MS = 30_000
let backoffMs = MIN_BACKOFF_MS

/** How often an adopted server's /health is looked at again. */
const ADOPT_WATCH_MS = 15_000
let adoptTimer: ReturnType<typeof setTimeout> | null = null
function clearAdoptTimer(): void {
  if (adoptTimer) clearTimeout(adoptTimer)
  adoptTimer = null
}

/** How often the pid of a server we hold no handle on is looked at: its exit is seen within this. */
const PID_POLL_MS = 1_000
let pidPoll: ReturnType<typeof setInterval> | null = null
function stopPidPoll(): void {
  if (pidPoll) clearInterval(pidPoll)
  pidPoll = null
}

/** Whether `pid` still runs. Signal 0 only asks: ESRCH is gone (on Windows an exited process whose
 *  handle someone still holds as well), EPERM a live process this one may not signal. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code !== 'ESRCH'
  }
}

/** A server we hold no handle on (started outside the daemon's tree on Windows, or adopted from the
 *  daemon before a relaunch) as a child: `exited` settles once its pid is gone, `kill` ends its tree. */
function watchedPid(deps: HSwarmDeps, pid: number): StartedChild {
  stopPidPoll()
  const alive = deps.alive ?? pidAlive
  const exited = new Promise<number | null>((resolve) => {
    const poll = setInterval(
      () => {
        try {
          if (alive(pid)) return
          clearInterval(poll)
          if (pidPoll === poll) pidPoll = null
          resolve(null)
        } catch (e) {
          console.error('[hswarm] pid check failed:', e instanceof Error ? e.message : String(e))
        }
      },
      Math.min(deps.watchEveryMs ?? PID_POLL_MS, PID_POLL_MS),
    )
    ;(poll as { unref?(): void }).unref?.()
    pidPoll = poll
  })
  return { pid, exited, kill: () => (deps.kill ?? killProcessTree)(pid) }
}

/** A folder path in a form two spellings of the same folder share. */
function normalizeDir(p: string): string {
  const resolved = resolve(p)
  return process.platform === 'win32' ? resolved.replace(/\\/g, '/').toLowerCase() : resolved
}

function isSideRun(deps: HSwarmDeps): boolean {
  return deps.sideRun ?? !IS_PRIMARY_INSTALL
}

/** True when a live server's /health says it runs from `dir`; a server of older code names no folder. */
function runsFrom(live: Record<string, unknown>, dir: string): boolean {
  return typeof live.package === 'string' && normalizeDir(live.package) === normalizeDir(dir)
}

/** Ends a server that runs from another folder, the way HSwarm's own restart does (its running jobs are
 *  carried on by the next server's adopt_orphans), and waits a few seconds for the port to go quiet.
 *  Returns whether the port is free. */
async function replaceForeign(
  deps: HSwarmDeps,
  port: number,
  dir: string,
  live: Record<string, unknown>,
): Promise<boolean> {
  const theirs = typeof live.package === 'string' ? live.package : 'an unknown folder'
  console.log(`[hswarm] server on port ${port} runs from ${theirs}, not ${dir}; replacing it`)
  try {
    if (typeof live.pid === 'number') (deps.kill ?? killProcessTree)(live.pid)
  } catch (e) {
    console.error('[hswarm] ending the server failed:', e instanceof Error ? e.message : String(e))
  }
  const probe = deps.probe ?? probeHSwarm
  for (let waited = 0; waited <= REPLACE_WAIT_MS; waited += REPLACE_POLL_MS) {
    if (!(await probe(port))) return true
    await Bun.sleep(REPLACE_POLL_MS)
  }
  return false
}

const REPLACE_WAIT_MS = 5_000
const REPLACE_POLL_MS = 100

/** A side-run daemon's adopted server is somebody else's, read-only: look at /health on an interval and,
 *  when it stops answering, clear the state and start again (which spawns our own supervised child). */
function watchAdopted(deps: HSwarmDeps, port: number): void {
  clearAdoptTimer()
  adoptTimer = setTimeout(async () => {
    adoptTimer = null
    if (stopRequested || !state.running || proc) return
    const live = await (deps.probe ?? probeHSwarm)(port)
    if (stopRequested || !state.running || proc) return
    if (live?.hswarm === true) {
      state.answering = true
      watchAdopted(deps, port)
      return
    }
    console.log(`[hswarm] adopted server on port ${port} stopped answering; starting our own`)
    state.running = false
    state.pid = null
    state.lastError = 'adopted server stopped answering'
    void startHSwarm(deps)
  }, deps.watchEveryMs ?? ADOPT_WATCH_MS)
}

/**
 * Start hswarm if enabled and not running. Restarts with exponential backoff on crash.
 * Logging goes to a file under the daemon's data dir, resolved lazily.
 */
export async function startHSwarm(deps: HSwarmDeps = {}): Promise<void> {
  if (stopRequested) return
  startDeps = deps

  const dir = enabledDir(deps)
  if (!dir) return
  const port = deps.port ?? hswarmPort(deps.env)
  const python = deps.python ?? pythonBinary(deps.env)

  // Check if hswarm package exists
  const initPy = join(dir, 'hswarm', '__init__.py')
  if (!existsSync(initPy)) {
    state.lastError = `hswarm package not found at ${dir}/hswarm/__init__.py`
    return
  }

  if (state.running && state.pid) return

  // The sidecar's env, shared by the spawn path and the ZSwarm import of an adopted server.
  const env: NodeJS.ProcessEnv = {
    ...(deps.env ?? process.env),
    HSWARM_PORT: String(port),
    HSWARM_HOME: hswarmHome(deps.env),
    HSWARM_SUPERVISED: '1',
    PYTHONUNBUFFERED: '1',
  }

  if (await settleLive(deps, { port, dir, python, env })) return
  await spawnServer(deps, { port, dir, python, env })
}

/** The package folder to run, or null (state.lastError says why) when hswarm is off or has none. */
function enabledDir(deps: HSwarmDeps): string | null {
  const enabled = deps.enabled ?? appEnv('HSWARM_ENABLED')?.trim() !== '0'
  if (!enabled) {
    state.lastError = 'hswarm is disabled'
    return null
  }

  const dir = deps.dir ?? hswarmDir(deps.env)
  if (!dir) {
    const override = (deps.env ?? process.env).AGENTHYDRA_HSWARM_DIR?.trim()
    state.lastError = override
      ? `AGENTHYDRA_HSWARM_DIR=${override} has no hswarm/__init__.py`
      : 'hswarm package not found (no hswarm/__init__.py beside the app)'
    console.log(`[hswarm] ${state.lastError}; sidecar not started`)
    return null
  }
  console.log(`[hswarm] using package folder ${dir}`)
  return dir
}

/** What one start runs: the port, package folder, interpreter and the sidecar's env. */
interface StartPlan {
  port: number
  dir: string
  python: string
  env: NodeJS.ProcessEnv
}

/** How long a start waits for the server already on the port to answer /health. A busy one took 3.9 s
 *  and 14 s (measured 2026-10-16) where it usually takes 2 ms, and after a relaunch a missed answer
 *  starts a second server beside the one serving every chat. A port nothing listens on answers at once. */
const SETTLE_PROBE_TIMEOUT_MS = 20_000

/** Probe for an existing live hswarm before starting a competitor: one of another folder is replaced,
 *  any other is adopted. True when that ends this start (adopted, or a replacement that did not end). */
async function settleLive(deps: HSwarmDeps, plan: StartPlan): Promise<boolean> {
  const { port, dir, python, env } = plan
  const liveHSwarm = await (deps.probe ?? probeHSwarm)(port, SETTLE_PROBE_TIMEOUT_MS)
  const sideRun = isSideRun(deps)
  if (liveHSwarm?.hswarm === true && !sideRun && !runsFrom(liveHSwarm, dir)) {
    // Adopting it would leave this folder's code unserved: end it and start our own.
    if (await replaceForeign(deps, port, dir, liveHSwarm)) return false
    state.lastError = `the server on port ${port} runs from another folder and did not end`
    console.log(`[hswarm] ${state.lastError}`)
    scheduleRestart(deps)
    return true
  }
  if (liveHSwarm?.hswarm !== true || !(sideRun || typeof liveHSwarm.pid === 'number')) return false
  // A side-run adopts whatever server answers, read-only: spawning beside it would fight for the port.
  state.running = true
  state.answering = true
  state.pid = typeof liveHSwarm.pid === 'number' ? liveHSwarm.pid : null
  state.port = port
  state.lastError = null
  backoffMs = MIN_BACKOFF_MS
  console.log(`[hswarm] adopting existing server on port ${port} with pid ${liveHSwarm.pid}`)
  // The old sidecar usually survives a daemon restart; the hourly import must not stop with it.
  startZswarmImport({ python, dir, env, spawn: deps.importSpawn, firstMs: deps.importFirstMs })
  // The primary takes it as its own, as it is after a relaunch (the server the daemon before this one
  // started): ended by a stop, or once it answers nothing for SILENT_LIMIT_MS. A side-run only watches.
  if (sideRun) watchAdopted(deps, port)
  else supervise(deps, watchedPid(deps, liveHSwarm.pid as number), port, { adopted: true })
  return true
}

/** Watches a server this daemon owns, as `proc`, and starts the next once it exits: at once after an
 *  adopted one, which had been serving; after the backoff for our own start, which may die as it starts.
 *  `gone` runs when it has exited. */
function supervise(
  deps: HSwarmDeps,
  child: StartedChild,
  port: number,
  o: { adopted: boolean; gone?: () => void },
): void {
  proc = child
  watchChild(deps, child, port)
  child.exited
    .finally(o.gone)
    .then(() => {
      if (proc !== child) return // stopped, or left running for the next daemon
      proc = null
      restartOnExit(deps, o.adopted)
    })
    .catch((e) => {
      // A failure in the restart path would otherwise leave hswarm down with no reason shown.
      state.lastError = `restart failed: ${e instanceof Error ? e.message : String(e)}`
      console.error('[hswarm]', state.lastError)
    })
}

function restartOnExit(deps: HSwarmDeps, adopted: boolean): void {
  if (!stopRequested && state.running) {
    state.running = false
    state.answering = null
    state.pid = null
    state.lastError ??= 'process exited'
    if (adopted) void startHSwarm(deps)
    else scheduleRestart(deps)
  }
}

/** How long our own child may go without answering /health before it is ended and started again. Its process
 *  exiting is the only other sign we get, and a server whose event loop is held lives on deaf: on 2026-10-09 one
 *  answered nobody for fifteen minutes (a worker's glob on its loop) while the window said HSwarm ran. Three
 *  minutes leaves room for a slow start; its running jobs are carried on by the next server (adopt_orphans). */
const SILENT_LIMIT_MS = 3 * 60_000
/** A busy server still answers /health within this; the adopt watch's 500 ms is for a server we may replace. */
const CHILD_PROBE_TIMEOUT_MS = 3_000

/** Looks at our own child's /health on an interval: `state.answering` says what it saw, and a child silent for
 *  SILENT_LIMIT_MS is ended, which its exit handler answers with a fresh start. */
function watchChild(deps: HSwarmDeps, child: StartedChild, port: number): void {
  clearAdoptTimer()
  let heardAt = Date.now()
  let gone = false
  void child.exited.finally(() => {
    gone = true
  })
  const live = () => !stopRequested && !gone && proc === child
  const tick = async () => {
    adoptTimer = null
    if (!live()) return
    const answer = await (deps.probe ?? probeHSwarm)(port, CHILD_PROBE_TIMEOUT_MS)
    if (!live()) return
    state.answering = answer?.hswarm === true
    if (state.answering) heardAt = Date.now()
    // The server's own pid, the one a daemon adopting it sees: the pid our start has may be its parent
    // (cmd.exe under an outside start, or hswarm's launcher of a committed copy).
    if (state.answering && typeof answer?.pid === 'number') state.pid = answer.pid
    const silentMs = Date.now() - heardAt
    if (silentMs >= (deps.silentLimitMs ?? SILENT_LIMIT_MS) && child.pid) {
      state.lastError = `answered nothing for ${Math.round(silentMs / 1000)} s; ended and started again`
      console.log(`[hswarm] pid ${child.pid} on port ${port} ${state.lastError}`)
      try {
        ;(deps.kill ?? killProcessTree)(child.pid)
      } catch (e) {
        console.error(
          '[hswarm] ending the silent server failed:',
          e instanceof Error ? e.message : String(e),
        )
      }
      return
    }
    adoptTimer = setTimeout(tick, deps.watchEveryMs ?? ADOPT_WATCH_MS)
  }
  adoptTimer = setTimeout(tick, deps.watchEveryMs ?? ADOPT_WATCH_MS)
}

async function spawnServer(deps: HSwarmDeps, plan: StartPlan): Promise<void> {
  if (starting) return
  starting = true
  const { port, dir, python, env } = plan
  const logDir = deps.logDir ?? join(DATA_DIR, 'logs')
  // On Windows it starts outside the daemon's tree and its jobs, to outlive the daemon's relaunch;
  // cmd.exe appends its output to the log there, so no handle on the log is held here.
  const outside = !deps.spawn && process.platform === 'win32'
  let fd = -1
  try {
    if (!outside) fd = openHSwarmLog(logDir)

    // The shared server itself, in the foreground: `hswarm ui` only starts it detached and exits,
    // which read as a crash here and restarted it forever.
    const command = [python, '-m', 'hswarm', 'mcp', '--http', '--port', String(port)]

    // Elsewhere, started on a spawn-worker thread of its own, which watches it for its exit:
    // CreateProcess of python held the daemon's thread for seconds on a loaded box (STALL lines on
    // this call, 2026-10-11), and that thread serves every route.
    const child: StartedChild = deps.spawn
      ? deps.spawn(command, {
          cwd: dir,
          stdout: fd,
          stderr: fd,
          stdin: 'ignore',
          windowsHide: true,
          env,
        })
      : outside
        ? watchedPid(deps, await startOutside(command, dir, env, hswarmLogFile(logDir)))
        : await startProcess(command, { cwd: dir, stdout: fd, stderr: fd, env, lane: 'hswarm' })
    if (stopRequested) {
      // stopHSwarm ran while it started and found no child to end.
      const logFd = fd
      void child.exited.finally(() => closeLog(logFd))
      if (child.pid) killProcessTree(child.pid)
      else child.kill()
      return
    }

    state.running = true
    state.answering = null
    state.pid = child.pid ?? null
    state.port = port
    state.lastError = null
    backoffMs = MIN_BACKOFF_MS
    startZswarmImport({ python, dir, env, spawn: deps.importSpawn, firstMs: deps.importFirstMs })
    supervise(deps, child, port, { adopted: false, gone: () => closeLog(fd) })
  } catch (e) {
    closeLog(fd)
    state.running = false
    state.pid = null
    state.lastError = e instanceof Error ? e.message : String(e)
    scheduleRestart(deps)
  } finally {
    starting = false
  }
}

/** Starts the server outside this daemon (core/outside-start.ts); resolves the pid of the cmd.exe it
 *  runs under. */
async function startOutside(
  command: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  logFile: string,
): Promise<number> {
  const exe = Bun.which(command[0] as string)
  if (!exe) throw new Error(`${command[0]} is not on PATH`)
  return startOutsideDaemon([exe, ...command.slice(1)], { cwd, env, logFile, lane: 'hswarm' })
}

function scheduleRestart(deps: HSwarmDeps): void {
  if (stopRequested) return
  const delay = Math.min(backoffMs, MAX_BACKOFF_MS)
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  setTimeout(() => startHSwarm(deps), delay)
}

const ZSWARM_IMPORT_FIRST_MS = 30_000
/** A ZSwarm import still running after this is ended, and tried again within the hour. */
const ZSWARM_IMPORT_TIMEOUT_MS = 10 * 60_000
const ZSWARM_IMPORT_EVERY_MS = 60 * 60 * 1000
let importTimer: ReturnType<typeof setTimeout> | null = null
let importRunning = false

/** The counts-only log line for one `import-zswarm --json` result. */
function importSummary(stdout: string): string {
  try {
    const counts = JSON.parse(stdout).counts as Record<string, Record<string, unknown>>
    let read = 0
    let added = 0
    const add = (c: Record<string, unknown>) => {
      read += Number(c.read) || 0
      added += Number(c.added) || 0
    }
    for (const [kind, c] of Object.entries(counts)) {
      if (kind === 'sqlite') for (const t of Object.values(c)) add(t as Record<string, unknown>)
      else add(c)
    }
    return `read ${read}, added ${added}`
  } catch {
    return 'finished with output that is not the counts'
  }
}

/**
 * Bring ZSwarm's stats and history into HSwarm's own home: once shortly after the sidecar starts. A one-shot
 * (ZSwarm is retired and archived): after a run that exits 0 nothing is scheduled again, and the Python side
 * records that it ran and does nothing on any later call. A failed run is retried hourly while ~/.zswarm exists.
 * Hidden, unref'd. Logs counts only.
 */
export function startZswarmImport(deps: {
  python: string
  dir: string
  env: NodeJS.ProcessEnv
  spawn?: typeof Bun.spawn
  firstMs?: number
  everyMs?: number
}): void {
  const homeDir = deps.env.HOME || deps.env.USERPROFILE || homedir()
  const zswarmHome = deps.env.ZSWARM_HOME?.trim() || join(homeDir, '.zswarm')
  if (importTimer) clearTimeout(importTimer)
  const cmd = [deps.python, '-m', 'hswarm', 'import-zswarm', '--json']
  // On the hswarm lane's spawn worker, never the daemon's thread (spawnServer); a test's fake spawn
  // runs here.
  const run = async (): Promise<{ code: number | null; out: string }> => {
    if (!deps.spawn) {
      const r = await spawnCaptured(cmd, {
        cwd: deps.dir,
        env: deps.env,
        wantStderr: false,
        timeoutMs: ZSWARM_IMPORT_TIMEOUT_MS,
        lane: 'hswarm',
      })
      return { code: r.code, out: r.stdout }
    }
    const child = deps.spawn(cmd, {
      cwd: deps.dir,
      stdout: 'pipe',
      stderr: 'ignore',
      stdin: 'ignore',
      windowsHide: true,
      env: deps.env,
    })
    const out = await new Response(child.stdout as ReadableStream).text()
    return { code: await child.exited, out }
  }
  const tick = async () => {
    importTimer = null
    if (stopRequested) return
    let done = false
    if (existsSync(zswarmHome) && !importRunning) {
      importRunning = true
      try {
        const { code, out } = await run()
        done = code === 0
        console.log(
          `[hswarm] zswarm import ${code === 0 ? importSummary(out) : `failed (exit ${code})`}`,
        )
      } catch (e) {
        console.error('[hswarm] zswarm import failed:', e instanceof Error ? e.message : String(e))
      } finally {
        importRunning = false
      }
    }
    if (!done && !stopRequested && existsSync(zswarmHome)) {
      importTimer = setTimeout(tick, deps.everyMs ?? ZSWARM_IMPORT_EVERY_MS)
      importTimer.unref?.()
    }
  }
  importTimer = setTimeout(tick, deps.firstMs ?? ZSWARM_IMPORT_FIRST_MS)
  importTimer.unref?.()
}

/** A stop waits this long for a server we hold no handle on to go, then forgets it. */
const STOP_WAIT_MS = 10_000

function forgetServer(): void {
  stopPidPoll()
  proc = null
  state.running = false
  state.answering = null
  state.pid = null
}

/** Stop hswarm. Returns a promise that settles once the server is gone. `leaveRunning` is the daemon's
 *  own exit, a relaunch's included: it stops looking after the server and leaves it serving every chat,
 *  for the next daemon to adopt. */
export async function stopHSwarm(o: { leaveRunning?: boolean } = {}): Promise<void> {
  stopRequested = true
  if (importTimer) clearTimeout(importTimer)
  importTimer = null
  clearAdoptTimer()
  const child = proc
  // A side-run's adopted server is somebody else's process: forget it, never kill it.
  if (!child || o.leaveRunning) {
    forgetServer()
    return
  }
  if (!state.running) return

  try {
    if (child.pid) (startDeps.kill ?? killProcessTree)(child.pid)
    else child.kill()
  } catch {
    // already gone
  }

  // Its exit handler closes its log. A pid we hold no handle on may refuse to end: not waited on for good.
  let cap: ReturnType<typeof setTimeout> | undefined
  await Promise.race([
    child.exited.catch(() => null),
    new Promise((done) => {
      cap = setTimeout(done, STOP_WAIT_MS)
    }),
  ])
  clearTimeout(cap)
  forgetServer()
}

/** Get the current hswarm status. */
export function getHSwarmStatus(): HSwarmState {
  return { ...state }
}

/** Set whether hswarm should be enabled. */
export function setHSwarmEnabled(enabled: boolean): void {
  if (enabled) {
    stopRequested = false
    void startHSwarm()
  } else {
    stopRequested = true
    void stopHSwarm()
  }
}

/** Exposed for testing: reset internal state. */
export function resetHSwarmStateForTests(): void {
  stopRequested = false
  clearAdoptTimer()
  stopPidPoll()
  state = { running: false, answering: null, port: null, pid: null, lastError: null }
  proc = null
  startDeps = {}
  starting = false
  backoffMs = MIN_BACKOFF_MS
}
