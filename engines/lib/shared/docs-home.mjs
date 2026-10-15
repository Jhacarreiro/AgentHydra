// vendored from Connections packages/connections-arkitect/src/core/docs-home.mjs @ dd3d47a7ad
/**
 * docs-home - where the scanned repo's docs folder is read from: its own disk, or the CrAInium snapshot.
 * =======================================================================================================
 *
 * A repo-root marker `.crainium.json` (`{ "docs": { "home": "git" | "cloud", "repo", "root" } }`, `root`
 * default `docs`) says where a repo's knowledge docs live. Once the home is `cloud` the docs folder is gone
 * from the checkout and every doc lives only in the CrAInium, still addressed by its old repo path. The local
 * MCP's docs tool (`snapshot`) writes every live doc under `<dir>/<its repo path>` plus a `manifest.json`
 * (`{ repo, home, takenAt, docs: [{ path, sha }] }`), by default at `tmp/crainium/snapshot` in the checkout.
 *
 * ⭐ ONE REDIRECT, AT THE BOUNDARY. The runner opens the snapshot once per run (`openDocsHome`) and installs
 * it here (`setDocsHome`). Every core reader (the readdir seams, both file walkers, readTextFileIfPresent,
 * the source catalog through them, the verdict cache's hashes, the tracked-path listings) passes the path it
 * was asked for through `docsSnapshotPath` before touching the disk, and a directory listing through
 * `withDocsEntries`. The LOGICAL path never changes: a walker still joins `<root>/docs/<folder>/<doc>.md`, a
 * finding still names `docs/<folder>/<doc>.md`, a scan observation still records the declared directory. Only the
 * bytes come from the snapshot. So a check that globs `docs/**` or reads `docs/<doc>.md` sees what it saw when
 * the folder was on disk, without knowing the folder moved.
 *
 * ⛔ HOME GIT, OR NO MARKER, IS THE OLD PATH EXACTLY. `setDocsHome` installs nothing, every function below
 * returns its argument untouched, and no listing is copied or re-ordered.
 *
 * ⛔ NO SNAPSHOT IS NO-DATA, NEVER ZERO DOCS. When the home is cloud and no usable snapshot is on this
 * machine (CI has no sign-in), nothing is redirected, and every check whose declared `inputPaths` reach the
 * docs root answers no-data naming the fix (`docsHomeNoDataReason`). Reading the deleted folder instead
 * would be a clean pass over zero docs.
 *
 * A check that exists to see the REAL folder (`docs-live-in-the-crainium`, which flags any file left under
 * a cloud-home docs root) declares `docsHome: "disk"`, and the runner suspends the redirect for its run.
 *
 * ⛔ A DOC READ THE DECLARATION MISSED IS NO-DATA TOO (2026-10-12). `docsHomeNoDataReason` stops only checks
 * whose `inputPaths` reach the docs root, and 18 checks named a doc while declaring no such path (most on
 * the legacy undeclared-input baseline). With the snapshot an hour old, `data-api-parity-proof` read its
 * migration record from the deleted folder and gated "absent" over a doc the CrAInium holds. So the runner
 * also wraps each check in `runNotingDocsReach`: any path under the docs root asked of `docsSnapshotPath`
 * while the home is unavailable makes that check's verdict no-data, naming the fix and the doc it reached.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { readdirSync } from "./scan-directory.mjs";

export const DOCS_HOME_MARKER = ".crainium.json";
const DEFAULT_DOCS_ROOT = "docs";
/** The docs tool's own default snapshot folder (services/studio/local-mcp/src-impl/26n-tools-docs.mjs). */
export const DEFAULT_DOCS_SNAPSHOT_DIR = path.join("tmp", "crainium", "snapshot");
/** The same hour `scripts/lib/crainium-docs.mjs` `docsRoot()` treats as fresh. */
export const DEFAULT_DOCS_SNAPSHOT_MAX_AGE_MS = 3_600_000;
/** What a no-data row tells the operator to do: take the snapshot through the local MCP's docs tool. */
export const DOCS_SNAPSHOT_FIX =
  'take a docs snapshot through the local MCP (connections_execute { local: true, tool_name: "docs", params: { action: "snapshot" } }) and run again';

/** The installed redirect, or null (home git, no marker, or no usable snapshot). */
let active = null;
/** The run's cloud home that has no snapshot: the reason every docs-reading check reports as no-data. */
let unavailable = null;
/** One check's watch (`runNotingDocsReach`): the first docs-root path it asked for while the home was unavailable. */
const docsReach = new AsyncLocalStorage();
let suspended = 0;
/** Bumped by every `setDocsHome`, so a check abandoned by an earlier run cannot resume this run's redirect. */
let generation = 0;

function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

/**
 * The marker's docs block for `root`: `{ home: "cloud" | "git", docsRel, repo }`. No marker or no docs block
 * is `home: "git"`, the pre-cutover state. A marker that is not JSON throws: read as "git", a broken cloud
 * marker would quietly put the deleted docs folder back in charge.
 */
export function readDocsHomeMarker(root) {
  const file = path.join(root, DOCS_HOME_MARKER);
  const docs = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8"))?.docs ?? null) : null;
  return { home: docs?.home === "cloud" ? "cloud" : "git", docsRel: docsRootOf(docs?.root), repo: typeof docs?.repo === "string" ? docs.repo : null };
}

/**
 * The marker's `root` as a repo-relative POSIX folder strictly inside the repo, else `docs`. An absolute
 * root, a drive letter, a `..` segment or the repo root itself would widen the redirect past the docs
 * folder, so a marker naming one is read as naming none.
 */
function docsRootOf(declared) {
  if (typeof declared !== "string" || !declared.trim()) return DEFAULT_DOCS_ROOT;
  const posix = toPosix(declared.trim());
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return DEFAULT_DOCS_ROOT;
  const segments = posix.split("/").filter((segment) => segment && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return DEFAULT_DOCS_ROOT;
  return segments.join("/");
}

/** A manifest path that names a file under the docs root and nothing outside it. */
function isDocPath(rel, docsRel) {
  return rel.startsWith(`${docsRel}/`) && !rel.split("/").includes("..");
}

/**
 * Resolves the run's docs home for `root`: `{ home: "git" }`, `{ home: "cloud", docsRel, snapshotDir }`
 * or `{ home: "cloud", docsRel, unavailable: <reason naming the fix> }`. Pure apart from reading the
 * marker and the manifest. `snapshotDir` is a snapshot the caller has just taken (or been handed), so its
 * age is not judged; the conventional one under the checkout must be younger than `maxAgeMs`.
 */
export function openDocsHome(root, { snapshotDir = null, maxAgeMs = DEFAULT_DOCS_SNAPSHOT_MAX_AGE_MS, now = Date.now() } = {}) {
  const marker = readDocsHomeMarker(root);
  if (marker.home !== "cloud") return { home: "git" };
  const dir = path.resolve(root, snapshotDir ?? DEFAULT_DOCS_SNAPSHOT_DIR);
  const where = toPosix(path.relative(root, dir)) || ".";
  const cloud = (fields) => ({ home: "cloud", docsRel: marker.docsRel, ...fields });
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  } catch {
    return cloud({ unavailable: `this repo's docs live in the CrAInium and no docs snapshot is at ${where}: ${DOCS_SNAPSHOT_FIX}` });
  }
  if (marker.repo && manifest?.repo && manifest.repo !== marker.repo) {
    return cloud({ unavailable: `the docs snapshot at ${where} is of ${manifest.repo}, not ${marker.repo}: ${DOCS_SNAPSHOT_FIX}` });
  }
  if (!Array.isArray(manifest?.docs) || manifest.docs.length === 0) {
    return cloud({ unavailable: `the docs snapshot at ${where} holds no docs: ${DOCS_SNAPSHOT_FIX}` });
  }
  // A takenAt in the future is a clock or a manifest that cannot be trusted, never a fresh snapshot.
  const age = now - Date.parse(manifest.takenAt);
  if (snapshotDir === null && !(age >= 0 && age <= maxAgeMs)) {
    const hours = Number.isFinite(age) ? (age < 0 ? "dated in the future" : `${Math.round(age / 360_000) / 10}h old`) : "undated";
    return cloud({ unavailable: `the docs snapshot at ${where} is ${hours}: ${DOCS_SNAPSHOT_FIX}` });
  }
  const docPaths = manifest.docs.map((doc) => toPosix(doc?.path ?? "")).filter((rel) => isDocPath(rel, marker.docsRel));
  return cloud({ snapshotDir: dir, docPaths });
}

/**
 * Installs `state` (from `openDocsHome`) for the run over `root`, replacing whatever the previous run in
 * this process installed. Home git clears it.
 */
export function setDocsHome(root, state) {
  active = null;
  unavailable = null;
  suspended = 0;
  generation += 1;
  if (state?.home !== "cloud") return;
  if (state.unavailable) {
    unavailable = { docsRel: state.docsRel, docsAbs: path.resolve(root, state.docsRel), reason: state.unavailable };
    return;
  }
  const docsAbs = path.resolve(root, state.docsRel);
  active = {
    docsRel: state.docsRel,
    docsAbs,
    docsParent: path.dirname(docsAbs),
    docsName: path.basename(docsAbs),
    snapshotDocsAbs: path.resolve(state.snapshotDir, state.docsRel),
    docPaths: [...(state.docPaths ?? [])].sort(),
  };
}

function redirect() {
  return suspended === 0 ? active : null;
}

/** Which docs/ a read sees right now: "snapshot" while a cloud-home redirect is live, else "disk". Caches key on it. */
export function docsView() {
  return redirect() === null ? "disk" : "snapshot";
}

function insideOrAt(base, candidate) {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/**
 * The path to read for a repo path: its copy in the snapshot when it sits under a cloud-home docs root,
 * else the path itself (every non-string, every path outside the docs root, every run without a redirect).
 */
export function docsSnapshotPath(target) {
  const home = redirect();
  if (home === null) {
    noteUnavailableDocsReach(target);
    return target;
  }
  if (typeof target !== "string") return target;
  const absolute = path.resolve(target);
  if (!insideOrAt(home.docsAbs, absolute)) return target;
  return path.join(home.snapshotDocsAbs, path.relative(home.docsAbs, absolute));
}

/** Records, on the watching check, the first path under a cloud-home docs root this run has no snapshot of. */
function noteUnavailableDocsReach(target) {
  const watch = docsReach.getStore();
  if (!watch || watch.reached !== null || unavailable === null || typeof target !== "string") return;
  const absolute = path.resolve(target);
  if (!insideOrAt(unavailable.docsAbs, absolute)) return;
  const rel = toPosix(path.join(unavailable.docsRel, path.relative(unavailable.docsAbs, absolute)));
  watch.reached = { rel, reason: unavailable.reason };
}

/**
 * Runs `callback` (one check's run) and returns `{ value, docsUnavailable }`: the no-data reason when the
 * check asked for a path under a cloud-home docs root this run holds no snapshot of (naming the first doc it
 * reached), else null. Attribution is per async context, so checks running side by side never share it.
 */
export async function runNotingDocsReach(callback) {
  const watch = { reached: null };
  const value = await docsReach.run(watch, callback);
  const docsUnavailable = watch.reached === null ? null : `${watch.reached.reason} (this check reads ${watch.reached.rel})`;
  return { value, docsUnavailable };
}

function directoryOf(directory) {
  if (typeof directory === "string") return path.resolve(directory);
  if (directory instanceof URL && directory.protocol === "file:") return path.resolve(fileURLToPath(directory));
  return null;
}

function renameParent(entry, logical) {
  try {
    entry.parentPath = logical;
    if (Object.hasOwn(entry, "path")) entry.path = logical;
  } catch {
    /* a Dirent that will not take its logical parent still names its file correctly */
  }
  return entry;
}

function logicalParent(home, physical) {
  return insideOrAt(home.snapshotDocsAbs, physical) ? path.join(home.docsAbs, path.relative(home.snapshotDocsAbs, physical)) : physical;
}

/**
 * A listing of `directory` as the redirect presents it. Under the docs root (already read from the
 * snapshot) each Dirent's parent is renamed to its repo path. In the docs root's parent the docs folder is
 * listed whether or not it exists on disk; a recursive listing of an ancestor swaps the disk's docs
 * subtree for the snapshot's. Buffer-encoded listings and every run without a redirect pass through.
 */
export function withDocsEntries(directory, entries, options) {
  const home = redirect();
  if (home === null || !Array.isArray(entries)) return entries;
  const encoding = typeof options === "string" ? options : options?.encoding;
  if (encoding === "buffer") return entries;
  const dir = directoryOf(directory);
  if (dir === null) return entries;
  const withFileTypes = options?.withFileTypes === true;
  const recursive = options?.recursive === true;
  if (insideOrAt(home.docsAbs, dir)) {
    if (!withFileTypes) return entries;
    return entries.map((entry) => (typeof entry?.parentPath === "string" ? renameParent(entry, logicalParent(home, entry.parentPath)) : entry));
  }
  if (!insideOrAt(dir, home.docsParent)) return entries;
  const nameOf = (entry) => (typeof entry === "string" ? entry : entry?.name);
  if (!recursive) {
    if (dir !== home.docsParent || entries.some((entry) => nameOf(entry) === home.docsName)) return entries;
    const docsEntry = snapshotDocsEntry(home, withFileTypes, dir);
    if (docsEntry === null) return entries;
    const at = entries.findIndex((entry) => String(nameOf(entry)) > home.docsName);
    return at === -1 ? [...entries, docsEntry] : [...entries.slice(0, at), docsEntry, ...entries.slice(at)];
  }
  // Recursive: the disk's docs subtree (a stray left behind) is replaced by the snapshot's whole tree.
  const docsPrefix = path.relative(dir, home.docsAbs);
  const underDocs = (entry) => {
    const full = typeof entry === "string" ? path.resolve(dir, entry) : path.resolve(entry?.parentPath ?? dir, entry?.name ?? "");
    return insideOrAt(home.docsAbs, full);
  };
  const kept = entries.filter((entry) => !underDocs(entry));
  let snapshotEntries;
  try {
    snapshotEntries = readdirSync(home.snapshotDocsAbs, options);
  } catch {
    return kept;
  }
  const docsEntry = snapshotDocsEntry(home, withFileTypes, home.docsParent);
  const moved = withFileTypes
    ? snapshotEntries.map((entry) => renameParent(entry, logicalParent(home, entry.parentPath ?? home.snapshotDocsAbs)))
    : snapshotEntries.map((name) => path.join(docsPrefix, String(name)));
  return [...kept, ...(docsEntry === null ? [] : [withFileTypes ? docsEntry : docsPrefix]), ...moved];
}

/** The docs folder's own entry, taken from the snapshot so it is a real Dirent (isDirectory() true). */
function snapshotDocsEntry(home, withFileTypes, logicalParentDir) {
  if (!withFileTypes) return home.docsName;
  try {
    const entry = readdirSync(path.dirname(home.snapshotDocsAbs), { withFileTypes: true }).find((candidate) => candidate.name === home.docsName);
    return entry ? renameParent(entry, logicalParentDir) : null;
  } catch {
    return null;
  }
}

/**
 * The tracked-path roster as the redirect presents it: git's own rows minus anything under the docs root,
 * plus every doc the snapshot's manifest lists (repo-relative, POSIX). With `pathspecs`, a doc joins only
 * under a literal pathspec (a folder or file path); a glob pathspec adds none, since git's pattern
 * language is not re-implemented here. A run without a redirect gets `rows` untouched.
 */
export function withDocsTrackedPaths(rows, pathspecs = []) {
  const home = redirect();
  if (home === null) return rows;
  const prefix = `${home.docsRel}/`;
  const kept = [...rows].filter((row) => !toPosix(row).startsWith(prefix));
  const literal = pathspecs.map((spec) => toPosix(spec).replace(/^\.\/+/, "").replace(/\/+$/, "")).filter((spec) => !/[*?[:]/.test(spec));
  const docs =
    pathspecs.length === 0
      ? home.docPaths
      : home.docPaths.filter((doc) => literal.some((spec) => spec === "" || spec === "." || doc === spec || doc.startsWith(`${spec}/`)));
  return [...kept, ...docs];
}

/**
 * The no-data reason for `audit` when this run's docs live in the CrAInium and no snapshot could be had,
 * else null. A check whose declared `inputPaths` reach the docs root (a pattern under it, or one matching a
 * doc in it) cannot be judged; `docsHome: "disk"` checks read the real folder and are never stopped here.
 * `matches(pattern, path)` is the incremental planner's glob matcher.
 */
export function docsHomeNoDataReason(audit, matches) {
  if (unavailable === null || audit?.docsHome === "disk") return null;
  const patterns = Array.isArray(audit?.inputPaths) ? audit.inputPaths.filter((p) => typeof p === "string") : [];
  const docsRel = unavailable.docsRel;
  const probe = `${docsRel}/README.md`;
  const reaches = patterns.some((raw) => {
    const pattern = toPosix(raw).replace(/^\.\/+/, "");
    return pattern === docsRel || pattern.startsWith(`${docsRel}/`) || matches(pattern, probe);
  });
  return reaches ? unavailable.reason : null;
}

/**
 * Suspends the redirect while a `docsHome: "disk"` check runs. The runner enters it inside the check's own
 * try and restores it in that finally (and on a deadline). `restore()` is idempotent, never takes the count
 * below zero, and does nothing once a later run has installed its own docs home.
 */
export function beginDocsHomeForAudit(audit) {
  if (audit?.docsHome !== "disk" || active === null) return { restore() {} };
  suspended += 1;
  const owner = generation;
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      if (owner === generation) suspended = Math.max(0, suspended - 1);
    },
  };
}
