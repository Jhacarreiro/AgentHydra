// vendored from Connections packages/connections-arkitect/src/core/read-path-recorder.mjs @ dd3d47a7ad
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { maskLiteralsAndComments } from "./js-lexical-scan.mjs";

// Records what a check DEPENDS ON, per check, so a later run can judge "did anything this check looked
// at move" instead of re-running it. Three kinds: files read, directories listed, paths probed (exists,
// stat, access, realpath). `readPaths` is the original read-only list and keeps its own 5,000 cap; the
// dependency record has no per-kind cap, only an overall bound that sets `overflow`.
//
// Attribution is by AsyncLocalStorage, so concurrent checks in one process each fill only their own
// record. Node: each entry point is wrapped once and `syncBuiltinESMExports` propagates it to named imports.
// Bun ignores that propagation, so under Bun every module loaded after installReadRecorder() has its node:fs
// specifiers rewritten to a wrapper (read-path-fs-wrapper.mjs) that notes each call before delegating.
const MAX_RECORDED_PATHS = 5000;
const MAX_DEPENDENCY_ENTRIES = 200_000;
const store = new AsyncLocalStorage();
const readSourceUnrecorded = fs.readFileSync;
let installed = false;
let bunLoadRewriteInstalled = false;

const READ_LEGACY = "read-legacy";
const READ = "read";
const LIST = "list";
const PROBE = "probe";
const DEPENDENCY_KINDS = new Set([READ_LEGACY, READ, LIST, PROBE]);
const FS_WRAPPER = fileURLToPath(new URL("./read-path-fs-wrapper.mjs", import.meta.url)).replaceAll("\\", "/");
const FS_PROMISES_WRAPPER = fileURLToPath(new URL("./read-path-fs-promises-wrapper.mjs", import.meta.url)).replaceAll("\\", "/");
const WRAPPERS = new Set([FS_WRAPPER, FS_PROMISES_WRAPPER]);
// Group 1 is the import/require/from lead, group 2 the quote, group 3 the builtin name. Only literal specifiers match.
const BUILTIN_SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+|\brequire\s*\(\s*)(["'])(node:fs\/promises|fs\/promises|node:fs|fs)\2/g;
const LOADERS = { ".ts": "ts", ".mts": "ts", ".cts": "ts", ".tsx": "tsx", ".jsx": "jsx" };

function newRecording(parent = null) {
  return { parent, paths: new Set(), files: new Set(), dirs: new Set(), probes: new Set(), spawned: false, overflow: false };
}

function normalize(target) {
  if (typeof target === "string" || target instanceof URL || Buffer.isBuffer(target)) {
    const raw = target instanceof URL ? target.pathname.replace(/^\/(?=[A-Za-z]:)/, "") : String(target);
    return (isAbsolute(raw) ? raw : resolve(raw)).replaceAll("\\", "/");
  }
  return null;
}

function addTo(recording, kind, path) {
  if (kind === READ_LEGACY) {
    if (recording.paths.size < MAX_RECORDED_PATHS) recording.paths.add(path);
  }
  if (recording.overflow) return;
  const total = recording.files.size + recording.dirs.size + recording.probes.size;
  if (total >= MAX_DEPENDENCY_ENTRIES) {
    recording.overflow = true;
    return;
  }
  if (kind === READ_LEGACY || kind === READ) recording.files.add(path);
  else if (kind === LIST) recording.dirs.add(path);
  else recording.probes.add(path);
}

// A nested recording (recordedMemo) notes into itself AND every enclosing recording, so the caller
// that triggered a memo miss still sees everything the memoised computation touched.
function note(kind, target) {
  const recording = store.getStore();
  if (!recording) return;
  const path = normalize(target);
  if (path === null) return;
  for (let r = recording; r; r = r.parent) addTo(r, kind, path);
}

/**
 * Note a dependency the caller already knows it took without an fs call of its own: a cached answer being
 * served (source-catalog), or a directory a walker listed through a module that is not rewritten. `kind` is
 * one of read, read-legacy (also feeds readPaths), list or probe.
 */
export function noteDependency(kind, target) {
  if (!DEPENDENCY_KINDS.has(kind)) throw new TypeError(`noteDependency: unknown kind ${kind}`);
  note(kind, target);
}

function wrap(owner, name, kind) {
  const original = owner[name];
  if (typeof original !== "function") return;
  const wrapped = function recordedFsCall(target, ...rest) {
    note(kind, target);
    return original.call(this, target, ...rest);
  };
  Object.assign(wrapped, original);
  owner[name] = wrapped;
}

// Bun: the load rewrite reaches modules loaded after installReadRecorder() only. It is registered there and
// nowhere else, so a process that merely runs runRecordingReads keeps the real node:fs for its imports.
// A module under node_modules, or a wrapper, is left alone. The callback is synchronous: Bun marks a module
// whose onLoad is async as an async module, and `require()` of one throws (scenarios.generated.mjs reaching
// db-gateway-transport.mjs, 2026-10-14). Module source is read through the unwrapped readFileSync, so loading
// code is never recorded as a check's dependency.
// The filter takes ES module extensions only. Bun's onLoad cannot hand a file back to its own loader, and
// contents it returns load as ESM, so a CommonJS `.js` (typescript.js) would lose its default export.
// Measured 2026-10-14 (tmp/speed/vc/js-named-fs.mjs): every named node:fs import in a check closure sits
// in a `.mjs` (994) or `.ts` (1) file; a CommonJS require reads the patched module object at call time.
const ESM_SOURCE_FILTER = /\.(?:mjs|mts|ts|tsx)$/;
// Only a specifier whose `from`/`import`/`require` sits in code is rewritten: a scenario module carries fixture
// source as string literals (`'import { readFileSync } from "node:fs"'`), and rewriting that text would erase
// the import the fixture's check looks for (blocking-call-in-async, bun-fs-fanout-grows-pool, check-scan-coverage).
function rewriteBuiltinSpecifiers(source) {
  let code = null;
  return source.replace(BUILTIN_SPECIFIER, (match, lead, quote, name, offset) => {
    code ??= maskLiteralsAndComments(source);
    if (!code.startsWith(lead, offset)) return match;
    const wrapper = name.endsWith("fs/promises") ? FS_PROMISES_WRAPPER : FS_WRAPPER;
    // require() takes a path, not a file URL; import takes the URL.
    const target = lead.startsWith("require") ? wrapper : pathToFileURL(wrapper).href;
    return `${lead}${quote}${target}${quote}`;
  });
}

function installBunLoadRewrite() {
  Bun.plugin({
    name: "read-path-recorder-builtins",
    setup(build) {
      build.onLoad({ filter: ESM_SOURCE_FILTER }, ({ path: file }) => {
        const loader = LOADERS[extname(file)] ?? "js";
        const normalized = file.replaceAll("\\", "/");
        const source = readSourceUnrecorded(file, "utf8");
        if (WRAPPERS.has(normalized) || /\/node_modules\//.test(normalized) || !source.includes("fs")) return { contents: source, loader };
        return { contents: rewriteBuiltinSpecifiers(source), loader };
      });
    },
  });
}

function install() {
  if (installed) return;
  installed = true;
  wrap(fs, "readFileSync", READ_LEGACY);
  wrap(fs, "readFile", READ_LEGACY);
  wrap(fs.promises, "readFile", READ_LEGACY);
  wrap(fs, "openSync", READ);
  wrap(fs, "open", READ);
  wrap(fs.promises, "open", READ);
  wrap(fs, "createReadStream", READ);
  wrap(fs, "readdirSync", LIST);
  wrap(fs, "readdir", LIST);
  wrap(fs.promises, "readdir", LIST);
  wrap(fs, "opendirSync", LIST);
  wrap(fs, "opendir", LIST);
  wrap(fs.promises, "opendir", LIST);
  wrap(fs, "existsSync", PROBE);
  wrap(fs, "statSync", PROBE);
  wrap(fs, "lstatSync", PROBE);
  wrap(fs, "stat", PROBE);
  wrap(fs, "lstat", PROBE);
  wrap(fs, "accessSync", PROBE);
  wrap(fs, "access", PROBE);
  wrap(fs, "realpathSync", PROBE);
  for (const name of ["stat", "lstat", "access", "realpath"]) wrap(fs.promises, name, PROBE);
  syncBuiltinESMExports();
}

function snapshot(recording) {
  return {
    files: [...recording.files].sort(),
    dirs: [...recording.dirs].sort(),
    probes: [...recording.probes].sort(),
    spawned: recording.spawned,
    overflow: recording.overflow,
  };
}

/**
 * Install the recorder for this process. Call it before the first check module is imported: under Bun only
 * modules loaded after this call have their node:fs imports rewritten, so an earlier import stays unrecorded.
 */
export function installReadRecorder() {
  install();
  if (typeof Bun !== "undefined" && !bunLoadRewriteInstalled) {
    bunLoadRewriteInstalled = true;
    installBunLoadRewrite();
  }
}

/** Run `callback`, returning `{ value, readPaths, deps }`; `deps` holds the sorted files, dirs and probes it touched. */
export async function runRecordingReads(callback) {
  install();
  const recording = newRecording();
  const value = await store.run(recording, callback);
  return { value, readPaths: [...recording.paths].sort(), deps: snapshot(recording) };
}

/** Read paths of the recording active in this async context, or null outside one. */
export function activeReadPaths() {
  const recording = store.getStore();
  return recording ? [...recording.paths].sort() : null;
}

/** Mark the active recording as having started a subprocess (called from the execution gateway). */
export function noteSpawn() {
  const recording = store.getStore();
  for (let r = recording; r; r = r.parent) r.spawned = true;
}

// Writes into the target recording and its enclosing chain directly, so a Promise hit replays into the
// caller that awaited it, whatever the ambient async context is when the stored promise settles.
function replay(target, deps) {
  for (let r = target; r; r = r.parent) {
    for (const file of deps.files) addTo(r, READ, file);
    for (const dir of deps.dirs) addTo(r, LIST, dir);
    for (const probe of deps.probes) addTo(r, PROBE, probe);
    if (deps.spawned) r.spawned = true;
    if (deps.overflow) r.overflow = true;
  }
}

/**
 * Memoise `compute()` under `key` in `map` (a Map or WeakMap), keeping the dependencies it touched.
 * Synchronous `compute` returns its value; asynchronous `compute` returns a Promise of its value. Either
 * way a hit returns the same shape: a Promise hit waits for the stored computation to settle first, so
 * its dependencies are re-noted before the caller's recording finishes. A rejected computation is not
 * stored, so the next call recomputes.
 */
export function recordedMemo(map, key, compute) {
  const caller = store.getStore();
  if (map.has(key)) {
    const entry = map.get(key);
    if (entry instanceof Promise) {
      return entry.then((stored) => {
        replay(caller, stored.deps);
        return stored.value;
      });
    }
    replay(caller, entry.deps);
    return entry.value;
  }
  const nested = newRecording(caller ?? null);
  const computed = store.run(nested, compute);
  if (computed instanceof Promise) {
    const settled = computed.then(
      (value) => {
        const entry = { value, deps: snapshot(nested) };
        map.set(key, entry);
        return entry;
      },
      (error) => {
        map.delete(key);
        throw error;
      },
    );
    map.set(key, settled);
    return settled.then((entry) => entry.value);
  }
  const entry = { value: computed, deps: snapshot(nested) };
  map.set(key, entry);
  return entry.value;
}
