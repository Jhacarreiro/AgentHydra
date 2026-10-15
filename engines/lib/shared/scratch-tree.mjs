// vendored from Connections packages/connections-arkitect/src/core/scratch-tree.mjs @ dd3d47a7ad
// Deleting a scratch tree that may hold links into a live checkout - never THROUGH a link.
//
// WHY THIS EXISTS (2026-09-24, found during JE-ARKITECT-049): `arkitect-ab` builds two arm trees per run
// and links each one to a real directory OUTSIDE it - `<arm>/node_modules/connections-arkitect` to the
// core (in a repository that only installs the core, that is the real package source itself), and a
// vendored arm's `packages/connections-arkitect/node_modules` to the real package's dependencies. Arm A
// is copied from arm B, and a copy carries the links too. Two exit paths left the arms on disk: `fail()`
// exits the process without reaching the runner's cleanup, and a killed run cleans nothing. A leftover
// arm is then one link-following recursive delete (Git Bash `rm -rf`, the 2026-09-13 incident that took
// the primary checkout's node_modules) away from deleting a live checkout's dependencies or the
// Architect's own source.
//
// Measured the same day: bun's `rmSync({ recursive })` and PowerShell's `Remove-Item -Recurse` both
// unlink a junction rather than enter it. This module does not rely on that - it unlinks every link it
// meets before anything recursive runs, so the answer does not depend on which runtime deletes.
import { lstatSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";

import { pidIsAlive } from "./run-artifacts.mjs";
import { readdirSync } from "./scan-directory.mjs";

/** The owner marker a scratch dir carries while its run is alive. */
export const SCRATCH_OWNER_FILE = ".scratch-owner.json";

// A directory junction is removed like a file on some platforms and like a directory on others; both
// calls remove the LINK and never its target (`rmSync` without `recursive` never descends - measured
// on a junction under bun 2026-09-24, target intact).
function removeLink(path) {
  try {
    unlinkSync(path);
  } catch {
    rmSync(path, { force: true });
  }
}

/** Unlinks every symlink and junction under `dir` without entering one. Returns how many it removed. */
export function unlinkLinksUnder(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      removeLink(path);
      removed += 1;
    } else if (entry.isDirectory()) removed += unlinkLinksUnder(path);
  }
  return removed;
}

/** Deletes `dir` and everything in it. A link anywhere in it, or `dir` itself as a link, is unlinked, never followed. */
export function removeTreeNoFollow(dir) {
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return;
  }
  if (stat.isSymbolicLink()) return removeLink(dir);
  if (stat.isDirectory()) unlinkLinksUnder(dir);
  rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
}

/**
 * Creates a scratch dir under `home` that no other run holds and returns its name. Creating the
 * directory IS the claim: `mkdir` without `recursive` fails on a name that exists, so two runs that
 * derive the same name cannot share one - the second takes `<name>-2`. Until 2026-10-01 two
 * `arkitect-ab` runs started in the same second at the same commit shared one stamp directory: the
 * second materialized its arms into the first run's, stopped on a locked file and deleted both arms
 * on its way out.
 */
export function createFreshScratchDir(home, name) {
  mkdirSync(home, { recursive: true });
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}-${attempt}`;
    try {
      mkdirSync(join(home, candidate));
      return candidate;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
}

/** Marks `dir` as owned by this process, so a later run can tell a live scratch dir from an abandoned one. */
export function claimScratchDir(dir, { keep = false, pid = process.pid, host = hostname(), now = new Date() } = {}) {
  writeFileSync(join(dir, SCRATCH_OWNER_FILE), `${JSON.stringify({ pid, host, keep, startedAt: now.toISOString() })}\n`);
}

/**
 * The scratch dirs directly under `home` whose owning process is CONFIRMED gone on this host. A dir with
 * no owner file, an owner that is alive or cannot be determined (a reused pid reads as alive), another
 * host's owner (a shared home directory), or one kept on purpose (`keep: true`) is never returned: a
 * leftover nobody can vouch for is left alone.
 */
export function orphanedScratchDirs(home, { isAlive = pidIsAlive, host = hostname() } = {}) {
  let names;
  try {
    names = readdirSync(home);
  } catch {
    return [];
  }
  const orphaned = [];
  for (const name of names) {
    let owner;
    try {
      owner = JSON.parse(readFileSync(join(home, name, SCRATCH_OWNER_FILE), "utf8"));
    } catch {
      continue;
    }
    if (owner?.keep === true || owner?.host !== host) continue;
    if (isAlive(owner?.pid) !== false) continue;
    orphaned.push(name);
  }
  return orphaned.sort();
}
