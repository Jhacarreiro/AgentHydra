/**
 * tape/lock.mjs - who owns a tape's recorder: `<tape>/recorder.lock`, created with an exclusive flag (`wx`), holding
 * `{ pid, at }`. Whoever creates it is the one writer of the tape's screens and edges; the others talk to it.
 *
 * A process that dies holding the lock must not block the next round, so a lock is taken over when its owner is
 * gone: its pid is dead, or it is older than STALE_AFTER_MS and the recorder it names no longer answers. Two clients
 * taking over at once are decided by a second exclusive file (`recorder.lock.takeover`), and the lock is read again
 * under it, so only the stale lock that was judged is ever removed.
 *
 * Also here: the names of the recorder's other files (`recorder.json`, where it listens; `recorder.log`, what it did).
 */
import { appendFileSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { writeAtomic } from "./atomic.mjs";

export const lockPath = (tapeDir) => path.join(tapeDir, "recorder.lock");
export const infoPath = (tapeDir) => path.join(tapeDir, "recorder.json");
export const logPath = (tapeDir) => path.join(tapeDir, "recorder.log");
const takeoverPath = (tapeDir) => `${lockPath(tapeDir)}.takeover`;

/** A lock this old whose recorder does not answer is dead, even when its pid was reused by another program. */
export const STALE_AFTER_MS = 30_000;
/** A lock file that cannot be read yet is the half of a write in flight for this long, then it is dead. */
const UNREADABLE_GRACE_MS = 5_000;
const TAKEOVER_STALE_MS = 10_000;

/** Is a process with this pid running (this machine, any user)? */
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM"; // it exists, it is only not ours to signal
  }
}

/** The lock as it stands: `{ pid, at }`, `{ unreadable: true, ageMs }` for a file nobody finished writing, or null. */
export function readLock(tapeDir) {
  const file = lockPath(tapeDir);
  try {
    const held = JSON.parse(readFileSync(file, "utf8"));
    if (Number.isInteger(held?.pid)) return { pid: held.pid, at: Number(held.at) || 0 };
  } catch (err) {
    if (err?.code === "ENOENT") return null;
  }
  try {
    return { unreadable: true, ageMs: Date.now() - statSync(file).mtimeMs };
  } catch {
    return null;
  }
}

/** Does the lock's owner still run the recorder? `answers()` asks the recorder itself (a ping). */
async function isStale(held, answers) {
  if (held.unreadable) return held.ageMs > UNREADABLE_GRACE_MS;
  if (!pidAlive(held.pid)) return true;
  return Date.now() - held.at > STALE_AFTER_MS && !(await answers());
}

const sameLock = (a, b) => a && b && !a.unreadable && !b.unreadable && a.pid === b.pid && a.at === b.at;

/** Remove the stale lock `held`, once, with one taker at a time. True when it is gone. */
async function takeOver(tapeDir, held) {
  const guard = takeoverPath(tapeDir);
  try {
    writeFileSync(guard, String(process.pid), { flag: "wx" });
  } catch (err) {
    if (err?.code !== "EEXIST") throw err;
    try {
      if (Date.now() - statSync(guard).mtimeMs > TAKEOVER_STALE_MS) rmSync(guard, { force: true }); // a taker that died
    } catch {
      // the guard went by itself
    }
    return false;
  }
  try {
    const now = readLock(tapeDir);
    if (now === null) return true;
    if (!held.unreadable && !sameLock(now, held)) return false; // someone else already replaced it
    rmSync(lockPath(tapeDir), { force: true });
    return true;
  } finally {
    rmSync(guard, { force: true });
  }
}

/**
 * Try to become the tape's recorder owner. Resolves true when `recorder.lock` is ours now (created, or taken over
 * from a dead owner), false when a live owner holds it. `answers()` resolves true when the recorder named by an old
 * lock still answers.
 */
export async function claimLock(tapeDir, { pid = process.pid, answers = async () => false } = {}) {
  for (let tries = 0; tries < 4; tries++) {
    try {
      writeFileSync(lockPath(tapeDir), JSON.stringify({ pid, at: Date.now() }), { flag: "wx" });
      return true;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
    const held = readLock(tapeDir);
    if (!held) continue;
    if (!(await isStale(held, answers))) return false;
    if (!(await takeOver(tapeDir, held))) return false;
  }
  return false;
}

/** The lock is the recorder process's now (the client that claimed it started that process). */
export function handOver(tapeDir, pid) {
  writeAtomic(lockPath(tapeDir), JSON.stringify({ pid, at: Date.now() }));
}

/** Give the lock up, only when it still names `pid`. */
export function releaseLock(tapeDir, pid = process.pid) {
  const held = readLock(tapeDir);
  if (held && !held.unreadable && held.pid === pid) rmSync(lockPath(tapeDir), { force: true });
}

/** `{ pid, port, token, startedAt }` of the recorder listening now, or null. */
export function readInfo(tapeDir) {
  try {
    return JSON.parse(readFileSync(infoPath(tapeDir), "utf8"));
  } catch {
    return null;
  }
}

export const hasLock = (tapeDir) => existsSync(lockPath(tapeDir));

/** One event of the recorder's life, a line of `recorder.log`: `{ at, pid, event, ... }`. */
export function logEvent(tapeDir, event, fields = {}) {
  appendFileSync(logPath(tapeDir), `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...fields })}\n`);
}

/** Every event of the log, in order. */
export function readEvents(tapeDir) {
  try {
    return readFileSync(logPath(tapeDir), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}
