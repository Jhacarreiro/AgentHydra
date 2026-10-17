// Brings Desk 2's server back when it died while nobody meant it to stop (Windows, primary install).
//
// WHY (2026-10-17, ~/.hydra-desk-2/logs and daemon.log): at 14:51:22Z a Ticket Tool chat's `taskkill /F /IM bun.exe`
// ended Desk 2's server along with the daemon. The tray revived the daemon in 14 s; nothing watched Desk 2's server,
// which stayed down until 15:39:30Z, 48 minutes of a window that answered nothing. Its own name (AgentHydra-desk.exe,
// desk2/launcher/start.ps1) now passes that kill by; this is for every other death.
//
// The one signal that tells a death from a stop: every deliberate stop runs desk2/launcher/stop.ps1 (the tray's Quit,
// Restart to update through restart.ps1, the updater's desk2.stop()), and stop.ps1 removes ~/.hydra-desk-2/server.pid
// last. A server that died leaves its pid file behind, naming processes that are gone. So Desk 2 is started again,
// through the same desk2.start() the daemon's pages use (start.ps1 -NoWindow -NoDialog), only when all of these hold:
//   - its /api/health has not answered for DOWN_FOR_MS, the pid file unchanged all that time (stop.ps1 removes it
//     seconds after the server exits, and a start writes a new one at once);
//   - no process the pid file names is running with the start time it recorded (a busy or booting server is never
//     touched, and a recycled pid is not mistaken for it);
//   - it is this daemon's own desk2/ (deskRoot), and it was started after this PC booted (one left over from before
//     a reboot is the owner's to open);
//   - fewer than MAX_REVIVES starts inside REVIVE_WINDOW_MS, and desk2/ is not being installed by the updater.
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { uptime } from 'node:os'
import { join, resolve } from 'node:path'

export const DOWN_FOR_MS = 45_000
export const WATCH_INTERVAL_MS = 15_000
export const MAX_REVIVES = 3
export const REVIVE_WINDOW_MS = 10 * 60_000

/** A process server.pid names, with the start time start.ps1 recorded for it ('o' format, UTC). */
export interface RecordedProcess {
  pid: number
  started: string
}

/** What ~/.hydra-desk-2/server.pid says, and its text (a changed file is a new start). */
export interface DeskPidFile {
  raw: string
  deskRoot: string
  startedAtMs: number
  processes: RecordedProcess[]
}

export type WatchVerdict =
  | 'up'
  | 'stopped'
  | 'installing'
  | 'elsewhere'
  | 'before-boot'
  | 'alive'
  | 'down'
  | 'paused'
  | 'revive'

export interface WatchState {
  downSince: number | null
  downRaw: string | null
  revives: number[]
}

export function newWatchState(): WatchState {
  return { downSince: null, downRaw: null, revives: [] }
}

/** One look, in the order the watch takes it: each later field is only read when the earlier ones leave it open. */
export interface WatchLook {
  healthy: boolean
  installing: boolean
  pidFile: DeskPidFile | null
  ownDesk: boolean
  bootAtMs: number
  /** Whether a recorded process still runs; only asked when everything before it says dead. */
  alive: () => Promise<boolean>
}

const sameDir = (a: string, b: string) =>
  resolve(a).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase() ===
  resolve(b).replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()

/** The watch's whole policy: what this look means, and (on 'revive') the start it records. */
export async function watchVerdict(
  state: WatchState,
  look: WatchLook,
  now: number,
): Promise<WatchVerdict> {
  const reset = (v: WatchVerdict): WatchVerdict => {
    state.downSince = null
    state.downRaw = null
    return v
  }
  if (look.healthy) return reset('up')
  if (look.installing) return reset('installing')
  const pid = look.pidFile
  if (!pid) return reset('stopped')
  if (!look.ownDesk) return reset('elsewhere')
  if (!(pid.startedAtMs > look.bootAtMs)) return reset('before-boot')
  if (await look.alive()) return reset('alive')
  if (state.downSince === null || state.downRaw !== pid.raw) {
    state.downSince = now
    state.downRaw = pid.raw
    return 'down'
  }
  if (now - state.downSince < DOWN_FOR_MS) return 'down'
  state.revives = state.revives.filter((t) => now - t < REVIVE_WINDOW_MS)
  if (state.revives.length >= MAX_REVIVES) return 'paused'
  state.revives.push(now)
  state.downSince = null
  state.downRaw = null
  return 'revive'
}

/** server.pid as start.ps1 writes it (PowerShell, with a BOM), or null when it is absent or unreadable. */
export function parsePidFile(raw: string): DeskPidFile | null {
  try {
    const info = JSON.parse(raw.replace(/^﻿/, '')) as Record<string, unknown>
    const processes: RecordedProcess[] = []
    for (const key of ['serverPid', 'wrapperPid'] as const) {
      const pid = Number(info[key])
      const started = info[key.replace(/Pid$/, 'Started')]
      if (pid > 0 && typeof started === 'string' && started) processes.push({ pid, started })
    }
    const startedAtMs = Date.parse(String(info.startedAt ?? ''))
    return {
      raw,
      deskRoot: typeof info.deskRoot === 'string' ? info.deskRoot : '',
      startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : 0,
      processes,
    }
  } catch {
    return null
  }
}

/** The start time of each running pid among `pids`, in start.ps1's format, read with PowerShell (async: never on the
 *  main thread's clock). Null when PowerShell could not say, which the caller reads as alive. */
function startTimes(pids: number[]): Promise<Map<number, string> | null> {
  const script = `Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | ForEach-Object { '{0} {1}' -f $_.Id, $_.StartTime.ToUniversalTime().ToString('o') }`
  return new Promise((done) => {
    let out = ''
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    const timer = setTimeout(() => {
      child.kill()
      done(null)
    }, 15_000)
    child.stdout.on('data', (b: Buffer) => {
      out += b.toString()
    })
    child.once('error', () => {
      clearTimeout(timer)
      done(null)
    })
    child.once('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) return done(null)
      const map = new Map<number, string>()
      for (const line of out.split(/\r?\n/)) {
        const [id, started] = line.trim().split(' ')
        if (id && started) map.set(Number(id), started)
      }
      done(map)
    })
  })
}

/** Whether a recorded process still runs as itself: a pid that answers signal 0 and still has its recorded start. */
export async function recordedAlive(
  processes: RecordedProcess[],
  deps: {
    exists?: (pid: number) => boolean
    startTimes?: (pids: number[]) => Promise<Map<number, string> | null>
  } = {},
): Promise<boolean> {
  const exists =
    deps.exists ??
    ((pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (e) {
        // EPERM: it runs, as someone else.
        return (e as NodeJS.ErrnoException).code === 'EPERM'
      }
    })
  const running = processes.filter((p) => exists(p.pid))
  if (running.length === 0) return false
  const times = await (deps.startTimes ?? startTimes)(running.map((p) => p.pid))
  if (!times) return true
  return running.some((p) => times.get(p.pid) === p.started)
}

export interface Desk2WatchDeps {
  healthy: () => Promise<boolean>
  installing: () => boolean
  present: () => boolean
  deskDir: () => string
  home: () => string
  readPidFile: (path: string) => string | null
  alive: (processes: RecordedProcess[]) => Promise<boolean>
  start: () => Promise<{ ok: boolean; started: boolean; reason?: string }>
  bootAtMs: () => number
  now: () => number
  log: (line: string) => void
  warn: (line: string) => void
}

/** The watch's tick, with its state: each call takes one look and acts on it. One tick at a time. */
export function createDesk2Watch(deps: Desk2WatchDeps) {
  const state = newWatchState()
  let running = false
  let last: WatchVerdict | null = null

  async function tick(): Promise<WatchVerdict | null> {
    if (running || !deps.present()) return null
    running = true
    try {
      const raw = deps.readPidFile(join(deps.home(), 'server.pid'))
      const pidFile = raw === null ? null : parsePidFile(raw)
      const verdict = await watchVerdict(
        state,
        {
          healthy: await deps.healthy(),
          installing: deps.installing(),
          pidFile,
          ownDesk: pidFile !== null && sameDir(pidFile.deskRoot, deps.deskDir()),
          bootAtMs: deps.bootAtMs(),
          alive: () => deps.alive(pidFile?.processes ?? []),
        },
        deps.now(),
      )
      // 'down' and 'paused' are logged as they begin, not at every tick they last.
      if (verdict === 'down' && last !== 'down')
        deps.log(
          `[agenthydra] desk watch: Desk 2's server is not answering and its processes are gone; starting it again in ${DOWN_FOR_MS / 1000}s unless it comes back or is stopped`,
        )
      if (verdict === 'paused' && last !== 'paused')
        deps.warn(
          `[agenthydra] desk watch: Desk 2's server is down, and ${MAX_REVIVES} starts in ${REVIVE_WINDOW_MS / 60_000} minutes did not keep it up; not starting it again (its log: ${join(deps.home(), 'logs', 'server.log')})`,
        )
      if (verdict === 'up' && last === 'paused')
        deps.log("[agenthydra] desk watch: Desk 2's server answers again")
      if (verdict === 'revive') {
        deps.warn(
          "[agenthydra] desk watch: Desk 2's server died without a stop (its pid file names processes that are gone); starting it again",
        )
        const r = await deps.start()
        if (r.ok)
          deps.log(
            `[agenthydra] desk watch: Desk 2's server is back${r.started ? '' : ' (it was already answering)'}`,
          )
        else
          deps.warn(
            `[agenthydra] desk watch: Desk 2's server did not come back: ${r.reason ?? 'no reason given'}`,
          )
      }
      last = verdict
      return verdict
    } finally {
      running = false
    }
  }

  return { tick, state }
}

/** The real deps, around the daemon's desk2 (desk2.ts). */
export function realDesk2WatchDeps(
  desk: {
    healthy: (fresh?: boolean) => Promise<boolean>
    present: () => boolean
    dir: () => string
    home: () => string
    start: () => Promise<{ ok: boolean; started: boolean; reason?: string }>
  },
  installing: () => boolean,
): Desk2WatchDeps {
  return {
    healthy: () => desk.healthy(true),
    installing,
    present: desk.present,
    deskDir: desk.dir,
    home: desk.home,
    readPidFile: (path) => {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return null
      }
    },
    alive: (processes) => recordedAlive(processes),
    start: () => desk.start(),
    bootAtMs: () => Date.now() - uptime() * 1000,
    now: () => Date.now(),
    log: (line) => console.log(line),
    warn: (line) => console.warn(line),
  }
}
