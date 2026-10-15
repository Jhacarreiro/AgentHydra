// vendored from Connections packages/connections-arkitect/src/core/atomic-io.mjs @ dd3d47a7ad
// Shared atomic file writes - the ONE `atomicWriteFile` / `atomicWriteJson` pair, used by
// `run-artifacts.mjs` (the run/report artifact writer), the verdict cache, the count ratchets, the
// cost caches and autofix.
//
// ★ WHY THIS EXISTS (2026-08). `run-artifacts.mjs`'s `atomicWriteFile` already wrapped its rename in
// a remove-and-retry fallback, with the comment below explaining why: Windows can reject replacing an
// existing destination outright (a transient lock - AV scan, a concurrent reader). A second writer's
// own `atomicWriteJson` did a bare `renameSync` with no such catch, so a momentarily locked file
// could fail a write that would otherwise have succeeded. Extracting one pair here - instead of
// copying the fallback into a second file - is what keeps the writers from drifting apart again.
//
// ★ WHY IT ALSO WAITS (2026-08-24). That fallback cures only ONE of the two ways a Windows rename can
// lose to a lock: a busy DESTINATION. The other is a busy SOURCE - the freshly written temp file
// itself - and it really happens. On 2026-08-24 a system-wide window made EVERY rename of a
// just-written temp file inside %TEMP% fail with EBUSY, under Node AND Bun alike, with the
// destination not existing at all; a 12-line reproduction that imports none of this package failed
// 40/40, and the same reproduction passed 40/40 minutes later with nothing changed. `rmSync(path)` on
// a path that is already absent is a no-op, so the fallback ran, cured nothing, and rethrew - which
// sent two specs red for a defect that was never in their subject. A sharing violation on
// a file nobody owns is by definition momentary, so the honest cure is to WAIT and try again: exactly
// what this module's own name promises and exactly what it did not do. Bounded, so a genuinely wedged
// file still fails loudly instead of hanging the run it sits inside.
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";

import { sleepSync } from "./execution-gateway.mjs";

// ~0.9s of total waiting across six attempts, sitting between the two costs it has to balance: a
// self-update state write that fails outright costs a whole update cycle, while one that retried
// without a ceiling would hang the run. A scanner/indexer handle on a file nobody owns is released in
// tens of milliseconds, so the early attempts catch nearly all of it and the long tail exists only
// for a loaded box.
const RENAME_RETRY_DELAYS_MS = [5, 15, 40, 100, 250, 500];

// EBUSY is Windows ERROR_SHARING_VIOLATION (something holds the file open); EPERM/EACCES are how the
// same contention surfaces when the denial lands on the delete/replace half instead. Every other code
// (ENOENT, EXDEV, ENOSPC) names a condition repetition cannot change, so it is rethrown at once
// rather than slept over.
const TRANSIENT_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES"]);

function commitRename(temp, path) {
  let firstError = null;
  for (let attempt = 0; attempt <= RENAME_RETRY_DELAYS_MS.length; attempt++) {
    if (attempt > 0) sleepSync(RENAME_RETRY_DELAYS_MS[attempt - 1]);
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      firstError ??= error;
    }
    try {
      // Windows can reject replacement of an existing destination. Keep the
      // non-atomic fallback scoped to one file; a reader sees an old or new
      // complete file, never a partially-written one.
      rmSync(path, { force: true });
      renameSync(temp, path);
      return;
    } catch (error) {
      // Only a lock is worth waiting out. Anything else is surfaced as the ORIGINAL rename error,
      // which is the one that describes what the caller actually asked for.
      if (!TRANSIENT_LOCK_CODES.has(error?.code)) throw firstError;
    }
  }
  throw firstError;
}

export function atomicWriteFile(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = join(dirname(path), `.${String(path).split(/[\\/]/).at(-1)}.${process.pid}.${randomUUID()}.tmp`);
  writeFileSync(temp, data);
  try {
    commitRename(temp, path);
  } catch (error) {
    // The scratch file is best-effort cleanup, never the story: if the very lock that beat the
    // rename also beats this unlink, the caller must still see why its WRITE failed, not why a
    // temp file survived it.
    try {
      rmSync(temp, { force: true });
    } catch {
      // Deliberately swallowed: see above. The write's failure is the story.
    }
    throw error;
  }
}

export function atomicWriteJson(path, value) {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
