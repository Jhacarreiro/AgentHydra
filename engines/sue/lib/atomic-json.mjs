/**
 * atomic-json - write a JSON file through a temp file and a rename, safe when several processes write one file.
 * ==========================================================================================
 *
 * WHY: on Windows a rename over a file fails (EPERM, EACCES, EBUSY) while another process has that file open, and
 * a SUE round starts all its runs side by side, so they write the same page target and the same scenario at once.
 * 2026-10-03: eight `sue run` calls on one page section, one died on `EPERM ... rename` and left its .tmp behind.
 * 21:18Z the same day, Lift's class round: 2 of 8 runs failed to start (kid-jo on the scenario
 * `.sue/scenarios/intent-4a7ddcab.json`, crazygames-kid on `.sue/target.learn-demo-futurethatworks-org-demo.json`),
 * one because lib/workspace.mjs had its own writer with no retry, one because eight renames over one file in the
 * same second outlasted two seconds of backoff. So two defences:
 *   1. a file that already holds exactly the bytes to write is not touched (no temp, no rename): side-by-side runs
 *      almost always write what is already there;
 *   2. otherwise the rename is retried with a short backoff, about two seconds in all, and the writer's own temp
 *      file is deleted when it finally gives up.
 *
 * WHO DEPENDS ON IT: sue.mjs (writeJson), browser-host.mjs, lib/workspace.mjs (targets, scenarios, the scoreboard).
 */
import fs from "node:fs";

import { renameSyncRetrying, sleepSync } from "../../lib/shared/rename-retrying.mjs";

/** `io` and `sleep` are for a spec: it hands in a rename that fails, and a sleep that does not wait. */
export function writeJsonAtomic(file, value, { io = fs, sleep = sleepSync } = {}) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    if (io.readFileSync(file, "utf8") === text) return;
  } catch {
    // missing or unreadable: write it
  }
  const tmp = `${file}.${process.pid}.tmp`;
  io.writeFileSync(tmp, text, "utf8");
  try {
    renameSyncRetrying(tmp, file, { io, sleep });
  } catch (err) {
    try {
      io.rmSync(tmp, { force: true });
    } catch {
      // the rename's error is the one worth reporting
    }
    throw err;
  }
}
