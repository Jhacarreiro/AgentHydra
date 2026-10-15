// server/src/core/app-sign-in-log.ts - whether a RUNNING Claude Desktop app has signed itself out.
//
// `loginUuid` (core/login-state.ts) is the stored login, and it outlives the app's own sign-out: the
// app goes to its logout page and keeps config.json as it was. Claude Desktop does that on a first
// start on a newer version (17 of 64 "[account] Navigated to /logout" lines in this PC's profile logs
// came on such a start, 2026-10-15: a spare profile unused for four days signed out two seconds after
// it started), and when the server pushes an account change. Until this, such an app read signed in
// everywhere, so landing, moves and fan-outs could pick an app that cannot run a chat, and the
// Instances list showed it signed in while the app showed its sign-in page.
//
// The app's own log is the only place that says so. The rule matches the Instance manager's
// (desk2/server/src/instance-manager/decide.ts signedOutFromLog), replayed over every profile's
// full logs: of 12,541 chat turns that ran to their end, none did while it read signed out.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { join } from 'node:path'

/** How much of the log is read from its end (a few hours on a busy profile). */
const TAIL_BYTES = 256 * 1024

const LOG_LINE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\b/
// The app's own sign-out. Not a chat's "OAuth token revoked" error: after one the app authorizes
// again by itself and its chats run on (one profile, 219 turns, 2026-10-09).
const SIGNED_OUT =
  /\[account\] Navigated to \/logout|synthesizing logged-out|Login-state transition \(loggedOut: false\b/i
/** Signed in again, or a start with its account loaded: an earlier sign-out line no longer counts. */
const SIGNED_IN =
  /Login-state transition \(loggedOut: true\b|claude\.ai account active and logged in\b/i

/**
 * The app's last sign-out line, without its time, when it comes after its last sign-in; null when
 * it does not, or there is no log.
 */
export function appSignedOutFromLog(log: string | null): string | null {
  if (log === null) return null
  const lines = log.split(/\r?\n/)
  const out = lines.findLastIndex((l) => LOG_LINE.test(l) && SIGNED_OUT.test(l))
  if (out < 0 || out < lines.findLastIndex((l) => SIGNED_IN.test(l))) return null
  const line = (lines[out] as string)
    .replace(LOG_LINE, '')
    .replace(/^\s*\[\w+\]\s*/, '')
    .trim()
  return line.length > 140 ? `${line.slice(0, 139)}…` : line
}

// main.log only grows while the app writes, so its size and time say when it must be read again.
const cache = new Map<string, { size: number; mtimeMs: number; answer: string | null }>()

/**
 * Whether the app of `instanceDir` has signed itself out, read from the tail of its
 * `logs/main.log`. Ask it only for a running app: a closed app's last line says nothing about how
 * it will start. Never throws; an unreadable log is null (the stored login decides, as before).
 */
export function readAppSignedOut(instanceDir: string): string | null {
  const file = join(instanceDir, 'logs', 'main.log')
  let fd: number | undefined
  try {
    fd = openSync(file, 'r')
    const { size, mtimeMs } = fstatSync(fd)
    const hit = cache.get(file)
    if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.answer
    const length = Math.min(size, TAIL_BYTES)
    const buf = Buffer.alloc(length)
    readSync(fd, buf, 0, length, size - length)
    const answer = appSignedOutFromLog(buf.toString('utf8'))
    cache.set(file, { size, mtimeMs, answer })
    return answer
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
