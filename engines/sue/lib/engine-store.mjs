/**
 * engine-store - snapshots of Sue's code, so a wave runs to its end on the code it started with.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-25): "someone starts a Sue on 1.14, you push 1.15, all the Sues keep
 * running on 1.14, all new Sues start on 1.15, we never stop the current Sues ... smart updates in the
 * back end." Sue runs from source only (the Chair, 2026-09-25), and the source is a checkout about twenty
 * chats land into every few minutes, while a wave loads its code lazily: every Sue's body, the
 * mailroom, the report and the reaper start as new node processes off whatever files are on disk, so a
 * land mid-wave handed it half-new code or a half-written file. Now `sue run` copies the code it is
 * about to run into a snapshot and starts the wave's runner from there. Everything the runner starts
 * finds its files beside itself (HERE), so the whole wave runs on that one copy while the checkout
 * moves on:
 *
 *   <store>/<id>/sue/...         sue, less state, runs, tmp, tests, node_modules, desktop,
 *                                      scratch *.tmp.mjs files, what sue/.gitignore ignores and the
 *                                      docs (*.md) no code opens (a critic's mind is not in the engine at all: it is
 *                                      her playbook in Connections, cached in the workspace's .sue/minds)
 *   <store>/<id>/<repo path>           every file outside sue the engine imports, or reads by a path
 *                                      built from its own folder (computeClosure reads the code for both)
 *   <store>/<id>/node_modules          a junction to the checkout's, and one for every other node_modules
 *                                      on the way up from a closure file, so a bare import (sharp,
 *                                      playwright-core, @aws-sdk/...) resolves from any store location
 *   <store>/<id>/.sue-engine.json      { id, commit, checkout, files, outOfTree, stagedAt, stageMs }, last
 *   <store>/<id>/.leases/<pid>.json    one per live process running this copy (lib/engine-lease.mjs)
 *
 * The store is SUE_ENGINE_STORE, else the checkout's sue/state/engines (gitignored; not under
 * SUE_HOME, so a spec points it at a temp dir on its own). The id is the first 16 hex of a sha256 over
 * every file's path and bytes (read again when one changed while it was read), so identical code is one
 * snapshot. A snapshot is written into `.staging-<pid>-<rand>` from the very bytes that were hashed, its
 * manifest last, and renamed onto its id, so a folder under an id is always whole; a stager that finds
 * its id taken lost the race and drops its copy. The collector deletes a snapshot only when it is not
 * the checkout's current code, holds no live lease, and was not staged or reused in the last ten
 * minutes (the gap between staging and a runner writing its lease), and it looks again right before and
 * right after it moves one aside, putting back one a `sue run` reused or leased meanwhile. It never
 * follows a junction, skips what Windows will not let go of (and asks again next time), and never
 * touches anything outside the store.
 *
 * An engine as it was at a git ref (stageEngineAt, 2026-10-04): the same staging, read from that commit's
 * files instead of the checkout's, so the id is the one a checkout at that commit would give and the
 * manifest's `commit` names it. The commit's files are written into a staging folder of the store by git
 * (an index of its own, so the checkout's files and its index are never touched), only the ones the
 * closure asks about, and that folder is removed once the snapshot is whole. node_modules stay junctions
 * to the live checkout's. It is how an A/B gets an old-engine arm on today's builds (README, "The A/B").
 *
 * DEPENDED ON BY: sue.mjs (startRun stages and pins every wave, then collects in the background; `run`
 * with `engineRef` stages that commit's engine and hands it the wave), round.mjs (`--engine-ref`),
 * manager.mjs (its hourly collection, and the engine id its refresh watches). CLI: `node
 * sue/lib/engine-store.mjs stage [--ref <git ref>]|gc [--store <dir>] [--keep <id>]`. Spec:
 * tests/engine-store.spec.mjs.
 */
import { loadTarget, targetPath } from "../../lib/target.mjs";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkoutRoot, ENGINE_MANIFEST, readEngineManifest, readLeases } from "./engine-lease.mjs";
import { readLandedVersion } from "./version.mjs";
import { isMainModule } from "../../lib/shared/is-main.mjs";

const THIS_FILE = fileURLToPath(import.meta.url);
/** The checkout this code belongs to (a snapshot's manifest names it). */
export const CHECKOUT = checkoutRoot(path.dirname(path.dirname(THIS_FILE)));

/** A snapshot staged or reused this recently is kept whatever it holds: its runner may not have leased it yet. */
export const YOUNG_MS = 10 * 60_000;
/** A staging folder untouched this long belongs to a copy that crashed. */
export const STAGING_STALE_MS = 60 * 60_000;
/** A pid is the process a lease names only if Windows created it within this of the lease's start. */
export const PID_MATCH_MS = 10_000;
const ID = /^[0-9a-f]{16}$/;
const STAGING = /^\.staging-\d+-[0-9a-f]+$/;
const TRASH = /^\.trash-\d+-[0-9a-f]+$/;
/** In the store: which snapshot each commit staged by ref became (`<full sha>.json`, `{ id }`). No snapshot, so never collected. */
const REFS_DIR = ".refs";
/** sue's own folders that are never code: what it writes, its specs, and the retired desktop app. */
// eval/ is the A/B ledger, a record of measurements and not code: carried, each row recorded made a new engine (2026-10-04).
const SKIP_TOP = new Set(["state", "runs", "tmp", "tests", "desktop", "eval"]);
const CODE = /\.(mjs|cjs|js|ts|mts|cts)$/;
/** TypeScript: only bun runs it, and bun reads the nearest tsconfig.json's `paths` before node_modules. */
const TS = /\.(ts|mts|cts)$/;
/** A doc: no code reads one unless it names it, so it is left out of a snapshot and its id until code does. */
const DOC = /\.md$/i;

/** Where snapshots live: SUE_ENGINE_STORE, else the checkout's sue/state/engines. */
export function storeRoot({ env = process.env, checkout = CHECKOUT } = {}) {
  if (env.SUE_ENGINE_STORE) return path.resolve(env.SUE_ENGINE_STORE);
  const home = path.resolve(checkout) === path.resolve(CHECKOUT) ? targetPath(loadTarget().sueStore) : path.join(checkout, ".sue");
  return path.join(home, "state", "engines");
}

const toPosix = (p) => p.split(path.sep).join("/");
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const norm = (p) => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
function isInside(child, parent) {
  const rel = path.relative(norm(parent), norm(child));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * The commit a closure is being read from when it is not a checkout on disk (stageEngineAt): `root` (the
 * folder its files are written under), `files` and `dirs` (the commit's, as repo paths) and `write(rel)`,
 * which puts that file there once. A commit is ~46,000 files and an engine reads ~400 of them, so a file
 * is written the first time the closure asks whether it is there. null while a checkout is read.
 */
let lazyTree = null;
/** One start of git costs about what writing a few hundred files does, so a file asked for brings its folder's files with it, up to this many. */
const BESIDE_MAX = 400;

/** Put `abs` on disk when it is a file or folder of the commit being read and is not there yet. */
function present(abs) {
  if (!lazyTree || !isInside(abs, lazyTree.root)) return;
  const rel = toPosix(path.relative(lazyTree.root, abs));
  if (lazyTree.files.has(rel)) lazyTree.write(rel);
  else if (lazyTree.dirs.has(rel)) fs.mkdirSync(abs, { recursive: true });
}

// ── what a snapshot holds ───────────────────────────────────────────────────────────────────

function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      out += glob[i + 2] === "/" ? "(?:.*/)?" : ".*";
      i += glob[i + 2] === "/" ? 2 : 1;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else out += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

/** sue/.gitignore as rules: the plain gitignore forms (anchoring, trailing slash, *, ?, **, !). */
function ignoreRules(sueDir) {
  let lines;
  try {
    lines = fs.readFileSync(path.join(sueDir, ".gitignore"), "utf8").split(/\r?\n/);
  } catch {
    return [];
  }
  const rules = [];
  for (const raw of lines) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const dirOnly = line.endsWith("/");
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes("/");
    if (line.startsWith("/")) line = line.slice(1);
    const body = globToRegex(line);
    rules.push({ negate, dirOnly, re: new RegExp(anchored ? `^${body}$` : `(?:^|/)${body}$`) });
  }
  return rules;
}

function ignored(rules, rel, isDir) {
  let out = false;
  for (const rule of rules) if ((!rule.dirOnly || isDir) && rule.re.test(rel)) out = !rule.negate;
  return out;
}

/**
 * Every file of sue a snapshot carries, as repo paths ("sue/..."), sorted, docs only when
 * `docs` (README and SPEC edits happen many times a day and change no code). Links are never followed.
 */
function sueFiles(checkout, { docs = false } = {}) {
  const sueDir = path.join(checkout, "sue");
  const rules = ignoreRules(sueDir);
  const out = [];
  (function walk(rel) {
    let entries;
    try {
      entries = fs.readdirSync(path.join(sueDir, rel), { withFileTypes: true });
    } catch (err) {
      // A folder removed since its parent was listed: whoever reads the list checks it again.
      if (rel && err.code === "ENOENT") return;
      throw err;
    }
    for (const entry of entries.sort(byName)) {
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if ((!rel && SKIP_TOP.has(entry.name)) || entry.name === "node_modules" || ignored(rules, child, true)) continue;
        walk(child);
      } else if (entry.isFile()) {
        if (/\.tmp\.mjs$|\.tmp$/.test(entry.name) || ignored(rules, child, false) || (!docs && DOC.test(entry.name))) continue;
        out.push(`sue/${child}`);
      }
    }
  })("");
  return out;
}

/**
 * The source with its comments blanked: an import or a path named in a comment is not one the code
 * uses. Strings and regular expressions are kept whole so a `//` inside one is not read as a comment.
 */
export function stripComments(src) {
  const out = [];
  let from = 0;
  let last = "";
  const n = src.length;
  for (let i = 0; i < n;) {
    const c = src[i];
    const d = src[i + 1];
    if (c === "/" && (d === "/" || d === "*")) {
      out.push(src.slice(from, i), " ");
      if (d === "/") while (i < n && src[i] !== "\n") i += 1;
      else {
        const end = src.indexOf("*/", i + 2);
        i = end === -1 ? n : end + 2;
      }
      from = i;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c && (c === "`" || src[j] !== "\n")) j += src[j] === "\\" ? 2 : 1;
      last = c;
      i = j + 1;
      continue;
    }
    // A regular expression may only start where a value may: after an operator, a bracket or a comma.
    if (c === "/" && (last === "" || "(,=:[!&|?{};+-*%<>~^".includes(last))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== "\n") {
        if (src[j] === "\\") j += 1;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        else if (src[j] === "/" && !inClass) break;
        j += 1;
      }
      last = "/";
      i = j + 1;
      continue;
    }
    if (!/\s/.test(c)) last = c;
    i += 1;
  }
  out.push(src.slice(from));
  return out.join("");
}

/** A file named from its own folder, not imported: a worker's entry, a folder, a data file. */
const NEW_URL = /\bnew\s+URL\(\s*(["'`])([^"'`\n$]+)\1\s*,\s*import\.meta\.url/g;
const IMPORTS = [
  /(?:^|[\s;}])import\s+(?:[\w$*{}\s,]+?\s+from\s+)?(["'])([^"'\n]+)\1/g,
  /(?:^|[\s;}])export\s+(?:\*(?:\s+as\s+[\w$]+)?|\{[^}]*\})\s+from\s+(["'])([^"'\n]+)\1/g,
  /\bimport\(\s*(["'`])([^"'`\n$]+)\1\s*[,)]/g,
  /\brequire\(\s*(["'])([^"'\n]+)\1\s*\)/g,
  NEW_URL,
];
/** A worker's side of node:worker_threads: what a thread's entry module takes from its parent. */
const WORKER_SIDE = /\bimport\s*\{[^}]*\b(?:workerData|parentPort)\b[^}]*\}\s*from\s*["']node:worker_threads["']/;
const STRING = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
const PATH_CALL = /\bpath\.(?:join|resolve)\(([^()]*)\)/g;
/** A string that reads like a file path relative to somewhere: a folder, a name and an extension. */
const PATHLIKE = /^(?:\.{1,2}\/)*[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,5}$/;

/** How a file named by a path literal is accepted: read by the code, not imported by it. */
const DATA = { imported: false };
/** `import type { X } from "y"`: erased before the code runs, so it loads nothing. */
const TYPE_ONLY = /^[\s;}]*(?:import|export)\s+type\s+[\w${*]/;

function importsOf(text) {
  const specs = [];
  for (const re of IMPORTS) for (const m of text.matchAll(re)) if (!TYPE_ONLY.test(m[0])) specs.push(m[2]);
  return specs;
}

/**
 * Paths the code builds relative to where it sits: `path.join(HERE, "..", "x", "y.json")` whose every
 * part after the first is a string, and any string that is itself a relative path with an extension.
 *
 * A path whose first part is a call is not one of them, and that is how code names a file it means to
 * be the CHECKOUT's: `path.join(checkoutRoot(), "dredd", "dredd.mjs")` (round.mjs starting
 * Dredd's round hearing) is the live file, started as a process of its own on the current code, so no
 * snapshot carries it or anything it imports.
 */
function pathLiteralsOf(text) {
  const found = new Set();
  for (const m of text.matchAll(PATH_CALL)) {
    const args = m[1]
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);
    const literal = (a) => /^(["'`])[^"'`$\\]*\1$/.test(a);
    const parts = args.every(literal) ? args : args.slice(1);
    if (!parts.length || !parts.every(literal)) continue;
    const joined = parts.map((a) => a.slice(1, -1)).join("/");
    if (joined.includes("/")) found.add(joined.replace(/\/{2,}/g, "/"));
  }
  for (const m of text.matchAll(STRING)) if (PATHLIKE.test(m[2])) found.add(m[2]);
  return [...found];
}

function isFile(file) {
  present(file);
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function isDir(dir) {
  present(dir);
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

function resolveRelative(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [
    base,
    ...[".mjs", ".js", ".cjs", ".json", ".ts", ".mts"].map((ext) => base + ext),
    path.join(base, "index.mjs"),
    path.join(base, "index.js"),
    path.join(base, "index.ts"),
  ])
    if (isFile(candidate)) return candidate;
  return null;
}

/** The package a bare specifier names: `@scope/name` or `name`. */
const packageOf = (spec) =>
  spec
    .split("/")
    .slice(0, spec.startsWith("@") ? 2 : 1)
    .join("/");

function readPackageJson(dir) {
  present(path.join(dir, "package.json"));
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

/**
 * The folder of THIS repo's own package `name` as node would find it from `fromFile`: the package the
 * file sits in when that is `name` (node's self-reference, tried first), else the first
 * node_modules/<name> on the way up whose real folder is in the repo and in no node_modules. null for a
 * package installed from outside (sharp, playwright-core...), which the node_modules junctions serve.
 * `modules` is the checkout whose node_modules a snapshot of `root` links (root itself, but for a commit
 * staged by ref): what is installed is read there, and the folder answered is its twin under `root`.
 */
function repoPackageDir(root, fromFile, name, modules = root) {
  let dir = path.dirname(fromFile);
  for (; isInside(dir, root); dir = path.dirname(dir)) {
    if (readPackageJson(dir)?.name === name) return dir;
    if (isFile(path.join(dir, "package.json"))) break;
  }
  for (dir = path.dirname(fromFile); ; dir = path.dirname(dir)) {
    try {
      const real = fs.realpathSync(path.join(modules, path.relative(root, dir), "node_modules", ...name.split("/")));
      const rel = path.relative(modules, real);
      return isInside(real, modules) && !toPosix(rel).split("/").includes("node_modules") ? path.join(root, rel) : null;
    } catch {
      /* not installed here: one folder up */
    }
    if (norm(dir) === norm(root) || !isInside(dir, root)) return null;
  }
}

/** A tsconfig.json as bun reads it: JSON with comments and trailing commas. null when it does not parse. */
function readTsconfig(file) {
  try {
    const text = stripComments(fs.readFileSync(file, "utf8")).replace(/,(\s*[}\]])/g, "$1");
    const { compilerOptions = {} } = JSON.parse(text);
    return { file, dir: path.dirname(file), baseUrl: compilerOptions.baseUrl ?? ".", paths: compilerOptions.paths ?? {} };
  } catch {
    return null;
  }
}

/**
 * The file a tsconfig `paths` alias names for `spec` (`@infra-shared/lambda/http` by
 * `"@infra-shared/*": ["../../../infra/shared/*"]`): the longest matching pattern, its targets in order,
 * each resolved as an import from the tsconfig's baseUrl. null when no pattern matches or no target is a file.
 */
function aliasFile(tsconfig, spec) {
  let best = null;
  for (const [pattern, targets] of Object.entries(tsconfig.paths)) {
    const star = pattern.indexOf("*");
    const [pre, post] = star < 0 ? [pattern, ""] : [pattern.slice(0, star), pattern.slice(star + 1)];
    const matches = star < 0 ? spec === pattern : spec.startsWith(pre) && spec.endsWith(post) && spec.length >= pre.length + post.length;
    if (!matches || (best && pre.length <= best.pre.length)) continue;
    best = { pre, targets, rest: star < 0 ? "" : spec.slice(pre.length, spec.length - post.length) };
  }
  if (!best) return null;
  const from = path.join(path.resolve(tsconfig.dir, tsconfig.baseUrl), "tsconfig.json");
  for (const target of [].concat(best.targets)) {
    const hit = resolveRelative(from, target.replaceAll("*", best.rest));
    if (hit) return hit;
  }
  return null;
}

/** Node's conditions for an ESM import, in the order a package's exports object is read. */
const CONDITIONS = new Set(["node", "import", "module-sync", "default"]);
function exportTarget(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(exportTarget).find(Boolean) ?? null;
  if (value && typeof value === "object")
    for (const [condition, inner] of Object.entries(value)) if (CONDITIONS.has(condition)) return exportTarget(inner);
  return null;
}

/**
 * The file `name` + `subpath` names inside the package at `dir`, by its package.json `exports` as node
 * reads them (an exact key, else the matching `*` pattern with the longest prefix; the import
 * condition), or by `main` and the plain path when it has no exports.
 */
function packageFile(dir, subpath) {
  const pkg = readPackageJson(dir) ?? {};
  const key = `.${subpath}`;
  let exportsMap = pkg.exports;
  if (exportsMap === undefined) return resolveRelative(path.join(dir, "index.mjs"), `./${subpath.slice(1) || pkg.main || "index.js"}`);
  if (typeof exportsMap !== "object" || Array.isArray(exportsMap) || !Object.keys(exportsMap).some((k) => k.startsWith(".")))
    exportsMap = { ".": exportsMap };
  let target = Object.hasOwn(exportsMap, key) && !key.includes("*") ? exportTarget(exportsMap[key]) : null;
  if (!target) {
    let best = null;
    for (const [pattern, value] of Object.entries(exportsMap)) {
      const star = pattern.indexOf("*");
      if (star < 0) continue;
      const [pre, post] = [pattern.slice(0, star), pattern.slice(star + 1)];
      if (!key.startsWith(pre) || !key.endsWith(post) || key.length < pre.length + post.length) continue;
      if (best && (pre.length < best.pre.length || (pre.length === best.pre.length && pattern.length <= best.pattern.length))) continue;
      best = { pattern, pre, value, match: key.slice(pre.length, key.length - post.length) };
    }
    target = best ? exportTarget(best.value)?.replaceAll("*", best.match) : null;
  }
  if (!target) return null;
  const file = path.resolve(dir, target);
  return isFile(file) ? file : null;
}

/**
 * What a snapshot of `checkout` holds, read from the code: `files` (repo paths, sorted), `outOfTree`
 * (the ones outside sue), `junctions` (the node_modules folders it links), `bare` (the packages it
 * imports by name), `bareInRepo` (those that are this repo's own workspace packages: the files they
 * name are carried, with their package.json), `unpinned` (imports of such a package from outside it,
 * which node resolves through the junction to the checkout's live copy; none today, and the spec keeps
 * it so), `unresolved` (imports naming no file), `workers` (thread entries: carried, run only inside the
 * Worker that names them), the `id`, and `contents`, the very bytes hashed. TypeScript is walked too, and
 * an alias its nearest tsconfig.json maps carries the file it names and that tsconfig.json.
 *
 * Read again when anything moved while it was read (a file rewritten in place reads back empty
 * mid-write, and a module that lands mid-read is missing from the first walk): `attempts` reads in
 * all, a moment apart, then it throws rather than name a torn copy.
 *
 * `modules` is the checkout whose node_modules the snapshot will link, when the files are read from
 * somewhere else (a commit staged by ref): which node_modules exist, which names are this repo's own
 * packages and what its .gitignore claims are read there.
 */
export function computeClosure({ checkout = CHECKOUT, modules = checkout, attempts = 5 } = {}) {
  const root = path.resolve(checkout);
  for (let attempt = 1; ; attempt += 1) {
    const { moved, ...closure } = readClosure(root, path.resolve(modules));
    if (!moved.length) return closure;
    if (attempt >= attempts)
      throw new Error(
        `Sue's code in ${root} kept changing while it was read (${moved.slice(0, 3).join(", ")}${moved.length > 3 ? ", ..." : ""}): try again in a moment`,
      );
    sleepSync(100 * attempt);
  }
}

/** A file's size, last write and change time (ctime moves on any write, even one that puts mtime back), without reading it: "gone" when it is not there. */
function statLine(root, rel) {
  try {
    const st = fs.statSync(path.join(root, ...rel.split("/")));
    return `${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`;
  } catch {
    return "gone";
  }
}

/** One read of the closure, and `moved`: the files that changed while it was read (none: it is whole). */
/** Does the checkout's own .gitignore claim this absolute path? (`git check-ignore` exits 0 when it does.) */
function ignoredByGit(root, abs) {
  try {
    execFileSync("git", ["-C", root, "check-ignore", "-q", "--", toPosix(path.relative(root, abs))], {
      stdio: "ignore",
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readClosure(root, modules = root) {
  const contents = new Map();
  // Each file's size and last write when it was read; "torn" when the bytes read are not that size.
  const asRead = new Map();
  const read = (rel) => {
    if (!contents.has(rel)) {
      const file = path.join(root, ...rel.split("/"));
      present(file);
      try {
        const before = fs.statSync(file);
        const body = fs.readFileSync(file);
        contents.set(rel, body);
        asRead.set(rel, body.length === before.size ? `${before.size}\0${before.mtimeMs}\0${before.ctimeMs}` : "torn");
      } catch (err) {
        // Deleted since the walk listed it or an import named it: this read is not the code as it stands.
        if (err.code !== "ENOENT") throw err;
        contents.set(rel, Buffer.alloc(0));
        asRead.set(rel, "vanished");
      }
    }
    return contents.get(rel);
  };
  const inTree = sueFiles(root);
  const files = new Set(inTree);
  // A snapshot carries the selected-project configuration, not the target checkout itself.
  const bare = new Set();
  const unresolved = [];
  const unpinned = [];
  const queue = [...inTree];
  let sueDocs = null;
  // The tsconfig.json nearest each folder (bun reads the one closest to the importing file), or null.
  const tsconfigs = new Map();
  const nearestTsconfig = (abs) => {
    const trail = [];
    let found = null;
    for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
      if (tsconfigs.has(dir)) {
        found = tsconfigs.get(dir);
        break;
      }
      trail.push(dir);
      const file = path.join(dir, "tsconfig.json");
      if (isFile(file)) {
        found = readTsconfig(file);
        break;
      }
      if (norm(dir) === norm(root) || !isInside(dir, root)) break;
    }
    for (const dir of trail) tsconfigs.set(dir, found);
    return found;
  };
  // Files a closure file names by `new URL("./x.mjs", import.meta.url)`: a worker's entry is named that way.
  const urlNamed = new Set();
  const importedTs = new Set(inTree.filter((rel) => TS.test(rel)));
  const unwalkedTs = new Set();
  const accept = (abs, { imported = true } = {}) => {
    if (!isInside(abs, root)) return null;
    const rel = toPosix(path.relative(root, abs));
    if (rel.split("/").some((part) => part === "node_modules" || part === ".git")) return null;
    // Of sue, only what the walk found, and a doc it left out once code names it (a prompt kept as markdown).
    if (rel.startsWith("sue/") && !files.has(rel)) {
      sueDocs ??= new Set(sueFiles(root, { docs: true }).filter((file) => DOC.test(file)));
      if (!sueDocs.has(rel)) return null;
    }
    if (!files.has(rel)) {
      files.add(rel);
      queue.push(rel);
    }
    // TypeScript is walked once something imports it: a .ts a tool reads as text (the route table engine
    // parses services/main/web's routes.ts) is data there, and its own imports load nothing.
    if (imported && TS.test(rel) && !importedTs.has(rel)) {
      importedTs.add(rel);
      if (unwalkedTs.delete(rel)) queue.push(rel);
    }
    return rel;
  };
  // Snapshot the standalone package's module mode and its selected target configuration.
  if (isFile(path.join(root, "package.json"))) accept(path.join(root, "package.json"), DATA);
  const cotenants = path.join(root, "vendor", "infra", "shared", "aurora-cotenants.json");
  if (isFile(cotenants)) accept(cotenants, DATA);
  // The selected Architect helpers are relative-vendored, but the package boundary still
  // belongs in a staged engine (and participates in the snapshot id).
  const arkitectPackage = path.join(root, "vendor", "packages", "connections-arkitect", "package.json");
  if (isFile(arkitectPackage)) accept(arkitectPackage, DATA);
  const targetDir = path.join(root, "targets");
  if (isDir(targetDir)) {
    for (const name of fs.readdirSync(targetDir).filter((name) => name.endsWith(".json"))) {
      accept(path.join(targetDir, name), DATA);
    }
  }
  while (queue.length) {
    const rel = queue.shift();
    const abs = path.join(root, ...rel.split("/"));
    const body = read(rel);
    if (!CODE.test(rel)) continue;
    if (TS.test(rel) && !importedTs.has(rel)) {
      unwalkedTs.add(rel);
      continue;
    }
    const text = stripComments(body.toString("utf8"));
    for (const m of text.matchAll(NEW_URL)) {
      const hit = m[2].startsWith(".") && resolveRelative(abs, m[2]);
      if (hit && isInside(hit, root)) urlNamed.add(toPosix(path.relative(root, hit)));
    }
    for (const spec of importsOf(text)) {
      if (spec.startsWith("node:") || /^[a-z]+:\/\//i.test(spec)) continue;
      if (spec === "." || spec === ".." || spec.startsWith("./") || spec.startsWith("../")) {
        const hit = resolveRelative(abs, spec);
        if (hit) accept(hit);
        // A folder, not a module: `new URL("../..", import.meta.url)` naming the repo root carries no file.
        // Nor a path git ignores: a machine-local marker (dredd/boardroom.mjs reads the gitignored
        // `.claude/operator.local`, absent meaning the Chair) is this machine's state, never the engine's
        // code, so no snapshot could carry it and its reader already answers its absence.
        else if (
          !isDir(path.resolve(path.dirname(abs), spec)) &&
          !ignoredByGit(modules, path.join(modules, path.relative(root, path.resolve(path.dirname(abs), spec))))
        )
          unresolved.push({ from: rel, spec });
      } else if (!path.isAbsolute(spec)) {
        // A tsconfig alias (`@infra-shared/*` in a lambda's sources): the file it names and the tsconfig
        // that maps it are carried, so bun finds both in the snapshot. Bun reads the alias first in the
        // TypeScript it runs; in JavaScript it answers here only what no package of the repo does.
        const tsconfig = nearestTsconfig(abs);
        const aliased = tsconfig && aliasFile(tsconfig, spec);
        if (aliased && (TS.test(rel) || !repoPackageDir(root, abs, packageOf(spec), modules))) {
          if (accept(aliased)) accept(tsconfig.file);
          continue;
        }
        const name = packageOf(spec);
        bare.add(name);
        // This repo's own package, named: its file and its package.json are carried like any other.
        // From inside that package node resolves the name to the package itself, so the snapshot's copy
        // answers; from outside, node_modules answers, which is the checkout's live copy: `unpinned`.
        const pkgDir = repoPackageDir(root, abs, name, modules);
        if (!pkgDir) continue;
        const hit = packageFile(pkgDir, spec.slice(name.length));
        if (!hit || !accept(hit)) {
          unresolved.push({ from: rel, spec });
          continue;
        }
        accept(path.join(pkgDir, "package.json"));
        if (!isInside(abs, pkgDir)) unpinned.push({ from: rel, spec });
      }
    }
    // A data file the code opens by a path from its own folder, or from a root it computes from there
    // (mailroom.mjs: the repo root, then infra/shared/aurora-cotenants.json).
    // A literal that starts with ./ or ../ is relative to where the file sits; one that does not may be
    // relative to any folder above it.
    for (const literal of pathLiteralsOf(text)) {
      if (literal.startsWith(".")) {
        const candidate = path.resolve(path.dirname(abs), literal);
        if (isFile(candidate)) accept(candidate, DATA);
        continue;
      }
      for (let dir = path.dirname(abs); ; dir = path.dirname(dir)) {
        const candidate = path.resolve(dir, literal);
        if (isFile(candidate) && accept(candidate, DATA)) break;
        if (norm(dir) === norm(root) || !isInside(dir, root)) break;
      }
    }
  }
  const sorted = [...files].sort();
  for (const rel of sorted) read(rel);

  // Every node_modules a closure module would find walking up from its folder, as node does.
  const junctions = new Set();
  const seen = new Set();
  for (const rel of sorted.filter((file) => CODE.test(file))) {
    for (let dir = path.posix.dirname(rel); !seen.has(dir); dir = dir === "." ? null : path.posix.dirname(dir)) {
      if (dir === null) break;
      seen.add(dir);
      const candidate = dir === "." ? "node_modules" : `${dir}/node_modules`;
      try {
        if (fs.statSync(path.join(modules, ...candidate.split("/"))).isDirectory()) junctions.add(candidate);
      } catch {
        /* none here */
      }
      if (dir === ".") break;
    }
  }
  const bareInRepo = [];
  for (const name of [...bare].sort()) {
    try {
      const real = fs.realpathSync(path.join(modules, "node_modules", ...name.split("/")));
      if (isInside(real, modules) && !toPosix(path.relative(modules, real)).split("/").includes("node_modules")) bareInRepo.push(name);
    } catch {
      /* not installed at the root: resolved from a nested node_modules, or not at all */
    }
  }
  const hash = createHash("sha256");
  for (const rel of sorted) {
    const body = contents.get(rel);
    hash.update(`${rel}\0${body.length}\0`);
    hash.update(body);
  }
  for (const rel of [...junctions].sort()) hash.update(`junction\0${rel}\0`);
  // Whole only if nothing moved while it was read: every file the size it was and last written when it
  // was, and sue's list of files unchanged (a module that landed mid-read is on it now).
  const moved = sorted.filter((rel) => asRead.get(rel) !== statLine(root, rel));
  if (sueFiles(root).join("\n") !== inTree.join("\n")) moved.push("sue's list of files");
  // Size and last write can match across a rewrite (mtime moves in timer ticks on Windows, and a file
  // caught empty at both looks is still empty at both), so the bytes are read once more and must be the
  // bytes hashed; and a module read empty is taken for one caught mid-write (the engine has none).
  for (const rel of sorted) {
    if (moved.includes(rel) || asRead.get(rel) === "vanished") continue;
    const body = contents.get(rel);
    let again = null;
    try {
      again = fs.readFileSync(path.join(root, ...rel.split("/")));
    } catch {
      /* gone since: moved */
    }
    if (!again?.equals(body) || (CODE.test(rel) && body.length === 0)) moved.push(rel);
  }
  const outOfTree = sorted.filter((rel) => !rel.startsWith("sue/"));
  // A thread's entry: named by `new URL(..., import.meta.url)` and taking workerData or parentPort. It
  // runs only inside the Worker its namer starts, so it is carried but never a module to import alone.
  const workers = sorted.filter(
    (rel) => urlNamed.has(rel) && CODE.test(rel) && WORKER_SIDE.test(stripComments(contents.get(rel).toString("utf8"))),
  );
  // What the walk does not list: the files outside sue, and a doc code names.
  const walked = new Set(inTree);
  const extra = sorted.filter((rel) => !walked.has(rel));
  return {
    moved,
    extra,
    // What `fingerprint` says of the files as they were read (the same, once nothing moved).
    fingerprint: createHash("sha256")
      .update([...inTree, ...extra].map((rel) => `${rel}\0${asRead.get(rel)}`).join("\n"))
      .digest("hex"),
    id: hash.digest("hex").slice(0, 16),
    files: sorted,
    outOfTree,
    workers,
    junctions: [...junctions].sort(),
    bare: [...bare].sort(),
    bareInRepo,
    unresolved,
    unpinned,
    contents,
  };
}

/**
 * What a closure's files look like on disk right now, without reading them: every path, size and mtime
 * of the walk, and of `extra` (closure.extra: what it carries that the walk does not list).
 */
function fingerprint(root, extra) {
  const parts = [...sueFiles(root), ...extra].map((rel) => `${rel}\0${statLine(root, rel)}`);
  return createHash("sha256").update(parts.join("\n")).digest("hex");
}

const MEMO = new Map();

/**
 * The id a snapshot of `checkout` would have right now. Cheap when nothing changed: the files are only
 * read again when a path, size or modification time under the closure moved since the last answer.
 */
export function currentEngineId({ checkout = CHECKOUT } = {}) {
  const root = path.resolve(checkout);
  const last = MEMO.get(root);
  if (last && fingerprint(root, last.extra) === last.fingerprint) return last.id;
  const closure = computeClosure({ checkout: root });
  // Remembered with the fingerprint of the files as they were read, never as they are a moment later: a
  // write that lands after the read reads as changed next time, never as this id.
  MEMO.set(root, { id: closure.id, extra: closure.extra, fingerprint: closure.fingerprint });
  return closure.id;
}

// ── staging ─────────────────────────────────────────────────────────────────────────────────

const rand = () => randomBytes(4).toString("hex");
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

function linkDir(target, link) {
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
}

/** The checkout's commit, best effort: a manifest without one is still whole. */
function commitOf(checkout) {
  try {
    const out = execFileSync("git", ["-C", checkout, "rev-parse", "--short=10", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{7,40}$/.test(out) ? out : null;
  } catch {
    return null;
  }
}

/**
 * Mark the whole snapshot at `dir` used now, so the collector counts it young again; false when it is
 * gone (a collector moved it away this instant). Any other refusal leaves it where it is: still true.
 */
function markUsed(dir) {
  if (!readEngineManifest(dir)) return false;
  const now = new Date();
  try {
    fs.utimesSync(path.join(dir, ENGINE_MANIFEST), now, now);
    return true;
  } catch (err) {
    return err.code !== "ENOENT";
  }
}

/**
 * Move aside the id folder `dir` when it holds no manifest at all. That is never a snapshot (one is
 * renamed in whole, its manifest already inside): it is what an older writeLease left of a collected
 * one. True once it is out of the way.
 */
function clearHusk(dir, root) {
  if (!fs.existsSync(dir) || fs.existsSync(path.join(dir, ENGINE_MANIFEST))) return false;
  const trash = path.join(root, `.trash-${process.pid}-${rand()}`);
  try {
    fs.renameSync(dir, trash);
  } catch {
    return false;
  }
  try {
    removeTree(trash, { within: root });
  } catch {
    /* out of the id already; the collector finishes it */
  }
  return true;
}

/**
 * Make sure the store holds a snapshot of `checkout` as it is right now, and return it: `{ id, root,
 * exe, reused, ms }`. `sue` is the version stamp `sue run` read (lib/version.mjs), baked into a new
 * snapshot as sue/sue-version.json so the copy knows which SUE it is without git. A snapshot
 * found already whole is reused and marked used now, so the collector counts it as young again; one a
 * collector moves away as it is reused is staged again, never handed back gone.
 *
 * `source` and `commit` are stageEngineAt's: the folder the files are read from when it is not the
 * checkout, and the commit they are. The snapshot still names `checkout` and links its node_modules.
 */
export function stageEngine({ checkout = CHECKOUT, root = storeRoot({ checkout }), sue = null, source = checkout, commit = null } = {}) {
  const began = Date.now();
  const closure = computeClosure({ checkout: source, modules: checkout });
  if (source === checkout) {
    const rewound = rewoundFile(checkout, closure);
    if (rewound)
      throw new Error(
        `${rewound} on disk is an older commit's version of that file while ${ENGINE_REF} holds a newer one (a stash restore rewound it), so the engine would mix two days' code: run \`bun run git:stale -- --fix\` first`,
      );
  }
  const final = path.join(root, closure.id);
  const done = (reused) => ({
    id: closure.id,
    root: final,
    exe: process.execPath,
    reused,
    ms: Date.now() - began,
    files: closure.files.length,
  });
  if (markUsed(final)) return done(true);
  fs.mkdirSync(root, { recursive: true });
  const staging = path.join(root, `.staging-${process.pid}-${rand()}`);
  try {
    for (const rel of closure.files) {
      const to = path.join(staging, ...rel.split("/"));
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, closure.contents.get(rel));
    }
    for (const rel of closure.junctions) linkDir(path.join(checkout, ...rel.split("/")), path.join(staging, ...rel.split("/")));
    if (sue && /^\d+\.\d+$/.test(String(sue.version ?? "")))
      fs.writeFileSync(
        path.join(staging, "sue", "sue-version.json"),
        `${JSON.stringify({ sue: sue.version, commit: sue.commit ?? null, app: null }, null, 2)}\n`,
      );
    const manifest = {
      id: closure.id,
      commit: commit ?? sue?.commit ?? commitOf(checkout),
      checkout: path.resolve(checkout),
      files: closure.files.length,
      outOfTree: closure.outOfTree,
      junctions: closure.junctions,
      stagedAt: new Date().toISOString(),
      stageMs: Date.now() - began,
    };
    // Last: a manifest means the copy is whole.
    fs.writeFileSync(path.join(staging, ENGINE_MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
    for (let attempt = 1; ; attempt += 1) {
      try {
        fs.renameSync(staging, final);
        break;
      } catch (err) {
        // Another stager got there first (Windows says EPERM, POSIX ENOTEMPTY): theirs is the same code.
        if (markUsed(final)) {
          removeTree(staging, { within: root });
          return done(true);
        }
        // The id's folder with no manifest in it is in the way: moved aside, and this copy takes its place.
        if (attempt < 20 && clearHusk(final, root)) continue;
        // Defender opens each new file to scan it, and Windows will not move a folder while it does.
        if (attempt >= 20 || !["EPERM", "EBUSY", "EACCES"].includes(err.code)) throw err;
        sleepSync(Math.min(1000, 50 * attempt));
      }
    }
  } catch (err) {
    try {
      removeTree(staging, { within: root });
    } catch {
      /* a staging folder left behind is collected once it is an hour old */
    }
    if (markUsed(final)) return done(true);
    throw err;
  }
  return done(false);
}

// ── an engine as it was at a git ref ────────────────────────────────────────────────────────

/** What git prints for `args` in `checkout`; throws when git refuses. `input` is written to its stdin. */
function gitText(checkout, args, { env, input } = {}) {
  return execFileSync("git", ["-c", "core.longpaths=true", "-C", checkout, ...args], {
    encoding: "utf8",
    env,
    input,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 256 << 20,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
}

const ENGINE_REF = "origin/main";

/**
 * The first closure file whose disk bytes are an older commit's version of that path while ENGINE_REF holds a
 * different one (a stash restore rewinds files this way), or null. One batched `cat-file` per question; null too
 * when the checkout is not a git repo or names no ENGINE_REF, since there is nothing to compare against.
 */
function rewoundFile(checkout, closure) {
  let heads;
  try {
    heads = gitText(checkout, ["cat-file", "--batch-check=%(objectname)"], {
      input: closure.files.map((rel) => `${ENGINE_REF}:${rel}\n`).join(""),
    }).split("\n");
  } catch {
    return null;
  }
  for (let i = 0; i < closure.files.length; i += 1) {
    const rel = closure.files[i];
    const head = heads[i];
    if (!/^[0-9a-f]{40}$/.test(head ?? "")) continue;
    const bytes = Buffer.from(closure.contents.get(rel));
    const disk = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (disk === head) continue;
    const commits = gitText(checkout, ["log", "--format=%H", ENGINE_REF, "--", rel]).split("\n").filter(Boolean);
    if (!commits.length) continue;
    const older = gitText(checkout, ["cat-file", "--batch-check=%(objectname)"], {
      input: commits.map((sha) => `${sha}:${rel}\n`).join(""),
    }).split("\n");
    if (older.includes(disk)) return rel;
  }
  return null;
}

/** The full sha of the commit `ref` names in `checkout`, or null when it names none. */
function resolveCommit(checkout, ref) {
  try {
    const sha = gitText(checkout, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]).trim();
    return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * What today's front doors need of an engine they hand a wave to: `sue run --workspace <ws> --json-file
 * <args>` starts it, it pins itself and starts its own `_runner --spec`, chat brains think for its Sues,
 * and a command or a move for its live run is handed to it (engine-lease.mjs, hand-move.mjs `routed`).
 * Each file, and the text that says it knows that part.
 */
const RUN_PROTOCOL = [
  ["sue/sue.mjs", ['"_runner"', '"--spec"', '"--json-file"', '"--workspace"', "chatBrains"]],
  ["sue/lib/engine-lease.mjs", ["export function checkoutRoot", ".sue-engine.json"]],
  ["sue/lib/hand-move.mjs", ["export async function sendMove", "routed"]],
];

/** Every part of RUN_PROTOCOL the engine under `tree` does not have, in words; none means it can run a wave. */
function protocolGaps(tree) {
  const gaps = [];
  for (const [rel, needs] of RUN_PROTOCOL) {
    let text;
    try {
      text = fs.readFileSync(path.join(tree, ...rel.split("/")), "utf8");
    } catch {
      gaps.push(`${rel} is missing`);
      continue;
    }
    for (const need of needs) if (!text.includes(need)) gaps.push(`${rel} has no ${need}`);
  }
  return gaps;
}

/**
 * Make sure the store holds a snapshot of Sue's code as it was at the git ref `ref` (a sha, a tag, a
 * branch, `HEAD~5`), and return it: stageEngine's answer plus `ref` and `commit` (the commit's first 10
 * hex, which the snapshot's manifest names too). The id is the one a checkout at that commit gives, so
 * the same code staged either way is one snapshot. `sue` is the version stamp baked in; left out, it is
 * that commit's landed version.
 *
 * Nothing of the live checkout is written: git reads the commit into an index of its own inside the
 * store and writes the files the closure asks about into a staging folder there, which is removed
 * whether or not the snapshot was made. A ref naming no commit throws, and so does an engine that does
 * not know today's run protocol, naming every part it lacks: the current engine is never staged in its
 * place.
 */
export function stageEngineAt(ref, { checkout = CHECKOUT, root = storeRoot({ checkout }), sue } = {}) {
  const began = Date.now();
  const name = String(ref ?? "").trim();
  // A ref that starts with a dash would be read by git as an option.
  const sha = name && !name.startsWith("-") ? resolveCommit(checkout, name) : null;
  if (!sha)
    throw new Error(`engine ref "${name}" names no commit in ${checkout}: nothing was staged, and nothing fell back to the current engine`);
  const commit = sha.slice(0, 10);
  // The snapshot this commit became last time, while the store still holds it whole.
  const memo = path.join(root, REFS_DIR, `${sha}.json`);
  let known = null;
  try {
    known = JSON.parse(fs.readFileSync(memo, "utf8")).id;
  } catch {
    /* not staged before */
  }
  if (typeof known === "string" && ID.test(known) && markUsed(path.join(root, known))) {
    const at = path.join(root, known);
    return {
      id: known,
      root: at,
      exe: process.execPath,
      reused: true,
      ms: Date.now() - began,
      files: readEngineManifest(at)?.files,
      ref: name,
      commit,
    };
  }
  fs.mkdirSync(root, { recursive: true });
  const tmp = path.join(root, `.staging-${process.pid}-${rand()}`);
  const tree = path.join(tmp, "tree");
  let staged;
  try {
    fs.mkdirSync(tree, { recursive: true });
    // An index of its own: the checkout's index, and whatever a chat has staged in it, is never read or written.
    const env = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
    gitText(checkout, ["read-tree", sha], { env });
    const files = new Set();
    const dirs = new Set();
    const inDir = new Map();
    for (const line of gitText(checkout, ["ls-tree", "-r", "-z", "--full-tree", sha]).split("\0")) {
      const m = /^\d+ (\w+) [0-9a-f]+\t(.+)$/s.exec(line);
      if (!m || m[1] !== "blob") continue;
      files.add(m[2]);
      const parent = path.posix.dirname(m[2]);
      if (!inDir.has(parent)) inDir.set(parent, []);
      inDir.get(parent).push(m[2]);
      for (let dir = parent; dir !== "." && !dirs.has(dir); dir = path.posix.dirname(dir)) dirs.add(dir);
    }
    const written = new Set();
    const extract = (rels) => {
      const todo = rels.filter((rel) => !written.has(rel));
      if (!todo.length) return;
      gitText(checkout, ["checkout-index", `--prefix=${toPosix(tree)}/`, "--stdin", "-z"], {
        env,
        input: todo.map((rel) => `${rel}\0`).join(""),
      });
      for (const rel of todo) written.add(rel);
    };
    const write = (rel) => {
      if (written.has(rel)) return;
      const beside = inDir.get(path.posix.dirname(rel));
      extract(beside.length <= BESIDE_MAX ? beside : [rel]);
    };
    lazyTree = { root: tree, files, dirs, write };
    // sue is listed folder by folder (sueFiles), so all of it the walk enters is written now.
    extract([...files].filter((rel) => rel.startsWith("sue/") && !SKIP_TOP.has(rel.split("/")[2])));
    const gaps = protocolGaps(tree);
    if (gaps.length)
      throw new Error(
        `the engine at ${name} (${commit}) is too old for this SUE's run protocol: ${gaps.join("; ")}. Nothing ran on it, and nothing fell back to the current engine.`,
      );
    const stamp =
      sue !== undefined
        ? sue
        : readLandedVersion(sha, (args) => {
            try {
              return gitText(path.join(checkout, "sue"), args);
            } catch {
              return null;
            }
          });
    staged = stageEngine({ checkout, root, sue: stamp, source: tree, commit });
  } finally {
    lazyTree = null;
    try {
      removeTree(tmp, { within: root });
    } catch {
      /* a staging folder left behind is collected once it is an hour old */
    }
  }
  try {
    fs.mkdirSync(path.dirname(memo), { recursive: true });
    fs.writeFileSync(`${memo}.${process.pid}.tmp`, `${JSON.stringify({ id: staged.id })}\n`);
    fs.renameSync(`${memo}.${process.pid}.tmp`, memo);
  } catch {
    /* only a shortcut: the next stage of this commit reads it from git again */
  }
  return { ...staged, ref: name, commit };
}

// ── collecting ──────────────────────────────────────────────────────────────────────────────

function unlinkLink(p) {
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

/**
 * Delete `target`, which must be inside `within`, never following a link: a junction or symlink is
 * removed itself, and a folder whose real path is not where it sits (a reparse point lstat did not name)
 * is unlinked, never emptied. The checkout's node_modules sits behind every snapshot's junction.
 */
export function removeTree(target, { within }) {
  if (!isInside(target, within)) throw new Error(`${target} is not inside ${within}: nothing outside the store is ever deleted`);
  const realWithin = fs.realpathSync(within);
  (function rm(p) {
    let st;
    try {
      st = fs.lstatSync(p);
    } catch (err) {
      if (err.code === "ENOENT") return;
      throw err;
    }
    try {
      if (st.isSymbolicLink()) return unlinkLink(p);
      if (!st.isDirectory()) return fs.unlinkSync(p);
      if (!isInside(fs.realpathSync(p), realWithin)) return unlinkLink(p);
      for (const name of fs.readdirSync(p)) rm(path.join(p, name));
      fs.rmdirSync(p);
    } catch (err) {
      // Another collector (every `sue run` starts one) deleted it a moment before this one: gone is the aim.
      if (err.code !== "ENOENT") throw err;
    }
  })(target);
}

function powershell(command) {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { windowsHide: true, timeout: 120_000, maxBuffer: 16 << 20, encoding: "utf8" },
      (err, stdout, stderr) =>
        err ? reject(new Error(`the process list did not answer: ${String(stderr || err.message).trim()}`)) : resolve(stdout),
    );
  });
}

/**
 * `Map<pid, creation time in epoch ms>` for the live processes among `pids`, from ONE PowerShell
 * Get-CimInstance Win32_Process query (none for no pids). Off Windows a live pid maps to NaN: its
 * creation time is not knowable here, so a lease on it counts as live.
 */
export async function processTable(pids, { exec = powershell } = {}) {
  const list = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0);
  const table = new Map();
  if (!list.length) return table;
  if (process.platform !== "win32") {
    for (const pid of list) {
      try {
        process.kill(pid, 0);
        table.set(pid, Number.NaN);
      } catch (err) {
        if (err.code === "EPERM") table.set(pid, Number.NaN);
      }
    }
    return table;
  }
  const filter = list.length <= 64 ? ` -Filter "${list.map((pid) => `ProcessId=${pid}`).join(" OR ")}"` : "";
  const out = await exec(
    `Get-CimInstance -ClassName Win32_Process${filter} -Property ProcessId,CreationDate | ForEach-Object { ` +
      "if ($_.CreationDate) { '{0} {1}' -f $_.ProcessId, ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } }",
  );
  for (const line of String(out).split(/\r?\n/)) {
    const m = /^(\d+) (\d+)$/.exec(line.trim());
    if (m && list.includes(Number(m[1]))) table.set(Number(m[1]), Number(m[2]));
  }
  return table;
}

/** A lease is live when its pid exists and Windows created that process when the lease says (not a later one given the same pid). */
export function leaseLive(lease, table) {
  const created = table.get(lease.pid);
  if (created === undefined) return false;
  if (!Number.isFinite(created) || !Number.isFinite(lease.startedAtMs)) return true;
  return Math.abs(created - lease.startedAtMs) <= PID_MATCH_MS;
}

/** When a snapshot was last staged or reused: the later of its manifest's stagedAt and the manifest's mtime. */
function lastUsedMs(dir) {
  const manifest = readEngineManifest(dir);
  let mtime = 0;
  try {
    mtime = fs.statSync(path.join(dir, manifest ? ENGINE_MANIFEST : "")).mtimeMs;
  } catch {
    /* gone */
  }
  return Math.max(Date.parse(manifest?.stagedAt ?? "") || 0, mtime);
}

/**
 * Delete what no Sue runs on: every snapshot in `root` that is not in `keep` (the checkout's current
 * id), holds no live lease, and was not staged or reused in the last YOUNG_MS; staging folders older
 * than STAGING_STALE_MS; and trash an earlier collection could not finish. `listProcesses(pids)` is
 * processTable, asked once and only about pids a lease names. A folder Windows will not move (a
 * process's working folder or an open file is in it) is skipped and asked again next time. Returns
 * `{ removed, kept, skipped }`, each a list of `{ id, reason }`.
 */
export async function collectGarbage({ root = storeRoot(), keep = [], listProcesses = processTable, now = Date.now() } = {}) {
  const removed = [];
  const kept = [];
  const skipped = [];
  let names;
  try {
    names = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { removed, kept, skipped };
  }
  /** Delete `name`, which is no snapshot any more (trash, or a copy that never finished). */
  const clear = (name, reason) => {
    try {
      removeTree(path.join(root, name), { within: root });
    } catch (err) {
      skipped.push({ id: name, reason: `${reason}; part of it is left for next time (${err.code ?? err.message})` });
      return;
    }
    removed.push({ id: name, reason });
  };
  /**
   * Delete the snapshot `name`, judged unused on `judged` (its `look` then). A `sue run` may reuse it
   * (stageEngine marks it used) or lease it for a new runner at any moment, even while this collection
   * waits on the process list, so it is looked at again right before it is moved, and once more as soon
   * as it is out of its id: anything new since it was judged keeps it, or puts it straight back.
   */
  const drop = (name, judged, reason) => {
    const dir = path.join(root, name);
    if (changedSince(judged, look(dir))) return kept.push({ id: name, reason: "reused or leased while it was being collected" });
    // Renamed aside first, so the snapshot leaves its id in one step and nobody finds half of one.
    const trash = path.join(root, `.trash-${process.pid}-${rand()}`);
    try {
      fs.renameSync(dir, trash);
    } catch (err) {
      if (err.code !== "ENOENT") skipped.push({ id: name, reason: `${reason}, but Windows would not let it go (${err.code})` });
      return;
    }
    if (changedSince(judged, look(trash))) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          fs.renameSync(trash, dir);
          return kept.push({ id: name, reason: "reused or leased as it was being collected: put back" });
        } catch (err) {
          // Staged again meanwhile (the same code, whole), so this copy is spare; else the next stage makes it again.
          if (readEngineManifest(dir)) break;
          if (attempt < 10 && ["EPERM", "EBUSY", "EACCES"].includes(err.code)) {
            sleepSync(50 * attempt);
            continue;
          }
          skipped.push({ id: name, reason: `reused as it was being collected, and could not be put back (${err.code})` });
          return;
        }
      }
    }
    try {
      removeTree(trash, { within: root });
    } catch (err) {
      // Out of its id already, so it is no snapshot any more; the rest goes next time.
      skipped.push({ id: name, reason: `${reason}; part of it is left in ${path.basename(trash)} (${err.code ?? err.message})` });
      return;
    }
    removed.push({ id: name, reason });
  };
  const leased = [];
  for (const entry of names.sort(byName)) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const { name } = entry;
    const dir = path.join(root, name);
    if (TRASH.test(name)) clear(name, "left over from an earlier collection");
    else if (STAGING.test(name)) {
      let touched;
      try {
        touched = fs.statSync(dir).mtimeMs;
      } catch {
        continue; // renamed onto its id, or dropped by the stager that lost its race, since the store was listed
      }
      if (now - touched > STAGING_STALE_MS) clear(name, "a copy that never finished");
      else kept.push({ id: name, reason: "a copy in progress" });
    } else if (!ID.test(name)) kept.push({ id: name, reason: "not a snapshot: left alone" });
    else if (keep.includes(name)) kept.push({ id: name, reason: "the checkout's current code" });
    else {
      const judged = look(dir);
      if (now - judged.used < YOUNG_MS) kept.push({ id: name, reason: "staged or reused in the last ten minutes" });
      else if (judged.leases.length) leased.push({ name, judged });
      else drop(name, judged, "not current, not leased, not young");
    }
  }
  if (leased.length) {
    let table = null;
    try {
      table = await listProcesses(leased.flatMap((l) => l.judged.leases.map((lease) => lease.pid)));
    } catch (err) {
      for (const { name } of leased) kept.push({ id: name, reason: `its leases could not be checked: ${err.message}` });
    }
    if (table)
      for (const { name, judged } of leased) {
        const live = judged.leases.filter((lease) => leaseLive(lease, table));
        if (live.length)
          kept.push({ id: name, reason: `${live.length} live lease(s): ${live.map((l) => l.runId ?? l.role ?? l.pid).join(", ")}` });
        else drop(name, judged, "not current, and every lease on it is dead");
      }
  }
  return { removed, kept, skipped };
}

/** What the collector judges a snapshot on: when it was last staged or reused, and every lease on it. */
function look(dir) {
  return { used: lastUsedMs(dir), leases: readLeases(dir) };
}

/** Whether a snapshot was used or leased since `judged`: a later use, or a lease that was not there then. */
function changedSince(judged, now) {
  if (now.used > judged.used) return true;
  const known = new Set(judged.leases.map((lease) => `${lease.pid}\0${lease.startedAtMs}`));
  return now.leases.some((lease) => !known.has(`${lease.pid}\0${lease.startedAtMs}`));
}

/**
 * Collect the store in a process of its own, windowless and detached, so `sue run` answers at once and
 * the collection (one PowerShell query when anything is leased) outlives it. It keeps the checkout's
 * current code and whatever `keep` names. The checkout's own copy of this file does it.
 */
export function collectInBackground({ root = storeRoot(), keep = [], checkout = CHECKOUT } = {}) {
  fs.mkdirSync(root, { recursive: true });
  const log = fs.openSync(path.join(root, "gc.log"), "a");
  try {
    const script = path.join(checkout, "sue", "lib", "engine-store.mjs");
    const args = [script, "gc", "--store", root, ...keep.flatMap((id) => ["--keep", id])];
    spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
  } finally {
    fs.closeSync(log);
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  const flag = (name) => rest.flatMap((v, i) => (rest[i - 1] === name ? [v] : []));
  const root = flag("--store")[0] ? path.resolve(flag("--store")[0]) : storeRoot();
  if (command === "stage") {
    try {
      // `--ref` with nothing after it is a ref naming no commit, never a stage of the current engine.
      const staged = rest.includes("--ref") ? stageEngineAt(flag("--ref")[0] ?? "", { root }) : stageEngine({ root });
      process.stdout.write(`${JSON.stringify({ ...staged, manifestCommit: readEngineManifest(staged.root)?.commit ?? null })}\n`);
    } catch (err) {
      process.stderr.write(`${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }
  if (command === "gc") {
    const keep = [...flag("--keep"), currentEngineId()];
    const out = await collectGarbage({ root, keep });
    process.stdout.write(
      `${new Date().toISOString()} gc: removed ${JSON.stringify(out.removed)} kept ${out.kept.length} skipped ${JSON.stringify(out.skipped)}\n`,
    );
    return;
  }
  process.stderr.write("usage: node sue/lib/engine-store.mjs stage [--ref <git ref>]|gc [--store <dir>] [--keep <id> ...]\n");
  process.exitCode = 2;
}

if (isMainModule(import.meta.url)) await main(process.argv.slice(2));
