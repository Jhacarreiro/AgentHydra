/**
 * _scratch.mjs - the one scratch-directory reaper every Dredd spec uses.
 *
 * WHY: six specs each carried their own afterEach that rmSync'd their temp dirs, and they had drifted -
 * one swallowed errors in an empty catch (a lint error), one let the error out. On Windows a detached
 * child (runDetached's instrument, a spawned room) can still hold its dir when the test ends, and
 * rmSync then throws EPERM or EBUSY: hearing.spec's runDetached test went red on 2026-09-23 for exactly
 * that, in a test whose assertions all passed. Cleanup must never fail a test, so a dir that is still
 * held after a few retries is left for the OS temp sweep.
 *
 *   const scratchDirs = reapAfterEach([]);   // then scratchDirs.push(dir) as before
 */
import { rmSync } from "node:fs";
import { afterEach } from "node:test";

/** Remove one scratch dir; a dir Windows still holds after the retries is left for the temp sweep. */
export function removeScratch(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    // Still held open by a detached child (EPERM/EBUSY on Windows): the OS temp sweep takes it.
  }
}

/** Registers an afterEach that reaps every dir pushed onto `dirs`, whatever the test's outcome. */
export function reapAfterEach(dirs) {
  afterEach(() => {
    for (const dir of dirs.splice(0)) removeScratch(dir);
  });
  return dirs;
}
