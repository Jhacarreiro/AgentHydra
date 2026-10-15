// vendored from Connections scripts/lib/rename-retrying.mjs @ dd3d47a7ad
// rename-retrying.mjs - a file rename that waits out a Windows lock instead of failing on it.
//
// Windows refuses a rename onto a file another process holds open, even for reading (a peer writer, the
// antivirus scan, the search indexer): EPERM, EACCES or EBUSY, gone a few milliseconds later. So the rename
// is tried again with a short backoff, about two seconds in all, before the error reaches the caller. Any
// other code (ENOENT, EXDEV, ENOSPC) is thrown at once: waiting cannot change it.
//
// Users: tools/4man/lib/store.mjs (the board file), tools/sue (atomic-json, tape/atomic, run-dir),
// scripts/git/pin-credential-account.mjs.
import fs from "node:fs";

export const RENAME_RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);
/** Waits between the tries of one rename: 11 retries, 2 s of waiting in all. */
export const RENAME_BACKOFF_MS = Object.freeze([10, 20, 40, 80, 160, 250, 250, 250, 250, 345, 345]);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** `io` and `sleep` are for a spec: it hands in a rename that fails, and a sleep that does not wait. */
export function renameSyncRetrying(from, to, { io = fs, sleep = sleepSync, backoffMs = RENAME_BACKOFF_MS } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      io.renameSync(from, to);
      return;
    } catch (err) {
      if (!RENAME_RETRYABLE.has(err?.code) || attempt >= backoffMs.length) throw err;
      sleep(backoffMs[attempt]);
    }
  }
}
