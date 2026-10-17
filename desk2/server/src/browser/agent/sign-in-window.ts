// The plain sign-in window that browser_handoff leaves on a profile (Connections browser.mjs:3233-3349): its marker, and the
// graceful close the next browser_* call on that profile makes before it relaunches the profile with a debugging port.

import { spawn } from 'node:child_process'
import { lstatSync, readFileSync, readlinkSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const SIGN_IN_MARKER = 'ConnectionsSignInWindow.json'
const LOCK_FILES = ['lockfile', 'SingletonLock']

// Connections browser.mjs:3250. The marker counts only while its window still holds the profile.
export function signInWindowLive({
  pid,
  pidAlive = false,
  locked = false,
  lockTarget = null,
  portFile = false,
}: {
  pid: number | null
  pidAlive?: boolean
  locked?: boolean
  lockTarget?: string | null
  portFile?: boolean
}): boolean {
  if (!Number.isInteger(pid) || (pid as number) <= 0 || !pidAlive || !locked || portFile) return false
  return lockTarget == null || lockTarget.endsWith(`-${pid}`)
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === 'EPERM'
  }
}

export function profileLocked(dir: string): boolean {
  return LOCK_FILES.some((f) => {
    try {
      lstatSync(join(dir, f))
      return true
    } catch {
      return false
    }
  })
}

function lockTargetOf(dir: string): string | null {
  try {
    return readlinkSync(join(dir, 'SingletonLock'))
  } catch {
    return null
  }
}

// Connections browser.mjs:3266. Returns the marker's pid while that window is live; a stale marker is removed.
export function readSignInWindow(dir: string): number | null {
  let pid: number | null = null
  try {
    const marker = JSON.parse(readFileSync(join(dir, SIGN_IN_MARKER), 'utf8')) as { pid?: unknown }
    pid = Number.isInteger(marker?.pid) ? (marker.pid as number) : null
  } catch {
    pid = null
  }
  const live = signInWindowLive({
    pid,
    pidAlive: pid !== null && processAlive(pid),
    locked: profileLocked(dir),
    lockTarget: lockTargetOf(dir),
    portFile: lstatExists(join(dir, 'DevToolsActivePort')),
  })
  if (live) return pid
  rmSync(join(dir, SIGN_IN_MARKER), { force: true })
  return null
}

function lstatExists(path: string): boolean {
  try {
    lstatSync(path)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil(done: () => boolean, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const until = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > until) return false
    await sleep(stepMs)
  }
  return true
}

async function askToClose(pid: number): Promise<void> {
  if (process.platform === 'win32') {
    await new Promise<void>((res) => {
      const k = spawn('taskkill', ['/PID', String(pid)], { windowsHide: true, stdio: 'ignore' })
      k.once('error', () => res())
      k.once('exit', () => res())
    })
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // already gone - the lock wait is the real signal
    }
  }
}

// Connections browser.mjs:3298. The window is closed the way a person closes it, so Chrome flushes its cookies: taskkill
// WITHOUT /F on Windows (WM_CLOSE; /F would lose the flush), SIGTERM elsewhere. No SIGKILL: a window that ignores the close
// is usually showing the human a dialog, and killing it would throw away what they typed.
// On Windows the close is asked again every 2 s while the window still holds the profile: Chrome drops a WM_CLOSE that
// comes while it is still starting, though taskkill reports success (2026-10-16: closes sent 0.6-0.8 s after launch were
// all lost, every one from 0.85 s closed it in 0.2 s), and a busy box stretches that start past the next browser call.
// SIGTERM is sent once: Chrome takes a second one as a kill, which loses the flush.
async function closeSignInWindow(dir: string, pid: number): Promise<void> {
  const until = Date.now() + 20_000
  const again = process.platform === 'win32' ? 2_000 : Infinity
  let closed = false
  for (let first = true; !closed && Date.now() < until; first = false) {
    if (first || processAlive(pid)) await askToClose(pid)
    closed = await waitUntil(() => !profileLocked(dir), Math.min(again, until - Date.now()))
  }
  if (!closed)
    throw new Error(
      `the plain sign-in window on ${dir} (pid ${pid}) did not close within 20s - it is most likely showing the human a dialog. ` +
        'Close that window by hand, then retry this call.',
    )
  rmSync(join(dir, SIGN_IN_MARKER), { force: true })
}

// Connections browser.mjs:3324. Runs before the next attach or launch on the profile, so the profile is relaunched with a
// debugging port and the login the human made is still in its cookie store.
export async function releaseSignInWindow(dir: string): Promise<void> {
  const pid = readSignInWindow(dir)
  if (pid === null) return
  await closeSignInWindow(dir, pid)
}
