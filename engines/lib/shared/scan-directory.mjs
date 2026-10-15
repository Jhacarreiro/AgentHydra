// vendored from Connections packages/connections-arkitect/src/core/scan-directory.mjs @ dd3d47a7ad
/**
 * Runner-owned directory enumeration seams.
 *
 * Audits that need a direct directory roster use these wrappers instead of
 * importing node:fs themselves.  The wrappers deliberately preserve the
 * native result shapes and overloads; they add only runner-private evidence
 * after a successful enumeration has produced its complete entry array.
 */
import { readdir as nativeReaddir, readdirSync as nativeReaddirSync } from "node:fs";
import { readdir as nativeReaddirPromise } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { docsSnapshotPath, withDocsEntries } from "./docs-home.mjs";
import { hasScanExcludes, isScanExcluded } from "./scan-excludes.mjs";
import { createScanObserverSlot } from "./scan-observer-slot.mjs";

const scanObserverSlot = createScanObserverSlot("scan directory");
export const installScanObserver = scanObserverSlot.install;
function observeScanEvidence(...args) {
  return scanObserverSlot.observe(...args);
}

function absoluteDirectoryPath(directory) {
  if (directory instanceof URL) return path.resolve(fileURLToPath(directory));
  // Node accepts raw Buffer paths. Valid UTF-8 paths share the same canonical
  // identity as their string form; non-UTF-8 bytes keep a lossless identity so
  // two different native paths cannot collapse through replacement characters.
  if (Buffer.isBuffer(directory)) {
    const decoded = directory.toString("utf8");
    if (Buffer.from(decoded, "utf8").equals(directory)) return path.resolve(decoded);
    return { kind: "buffer-path", cwd: path.resolve("."), base64: directory.toString("base64") };
  }
  return path.resolve(String(directory));
}

function stableValue(value) {
  if (Buffer.isBuffer(value)) return { type: "buffer", base64: value.toString("base64") };
  if (value instanceof URL) return { type: "url", href: value.href };
  if (value === undefined) return null;
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
  return String(value);
}

function normalizedOptions(options) {
  const source = typeof options === "string" ? { encoding: options } : options && typeof options === "object" ? options : {};
  return {
    encoding: stableValue(source.encoding === undefined ? "utf8" : source.encoding),
    recursive: source.recursive === true,
    withFileTypes: source.withFileTypes === true,
  };
}

/**
 * A file EXTENSION, in the only spelling the observed-input contract can reason about: a leading
 * dot and then no dot, separator or glob metacharacter. `.ts` qualifies; `.spec.ts` does not, and
 * neither does a bare `Engine.mjs` suffix.
 *
 * The reader (`scopeExtensions` in `core/incremental-plan.mjs`) enforces the identical shape and
 * is the authority; this is the writer refusing to emit what the reader would reject anyway, so a
 * malformed filter is dropped where it is written rather than travelling through an artifact.
 */
const OBSERVED_EXTENSION = /^\.[^./\\*?]+$/;

/**
 * The walker's OWN file-extension filter, when it has one, normalized for the observation subject.
 *
 * ⛔ ALL OR NOTHING, DELIBERATELY. A partial extension list is the false-green shape this whole
 * field exists to avoid: the comparator reads `extensions` as "these are the ONLY extensions this
 * walk could have read", and answers `covered` when the declaration matches every file under the
 * directory carrying one of them. Emitting three of a walker's four extensions would therefore
 * license a pass over a family the check really does read. So a set containing ANY entry the
 * contract cannot parse yields `null` - no field, and the scope stays UNMEASURED exactly as it was
 * before this parameter existed, which is the honest answer rather than a narrower-looking one.
 *
 * ⛔ ANNOTATE PER CALL SITE, NEVER BLANKET - and know the ceiling (A02, closed 2026-09-07). Ten
 * shared walkers pass their filter (collectVueFiles*, walkSourceFiles, walkRelative, walkBySuffix,
 * walkSearchDirsByExtension, both collectTsFiles, comment-line-scan's walk, collect-sql-sources'
 * two one-level scans, infra-contract-scan-helpers' walkSourceTree); the generic walkers in
 * collect-files.mjs deliberately pass nothing because their predicate is arbitrary. Three
 * candidates were audited and REFUSED, each for a reason that will recur: vue-sfc-block-scan's
 * walk has a live caller passing .html and .ts beyond the .vue/.css it looks like it reads;
 * cli-source-walk-helpers' walkSourceTree has a caller that appends package.json to the walk's
 * own output; and scanned-repo-roots' containsSource/discoverSourceRoots return a DIRECTORY
 * ROSTER, where the entry list IS the data - annotating that with an extension filter is a false
 * green (pinned by walker-scan-ledger.test.mjs: an unannotated safeReaddirSync stays unmeasured
 * against a same-shaped declaration). Measured by replaying a whole-catalog ledger through the
 * real comparator: of the 111 audits blocked only by readdir scopes, a filter fully decides 36,
 * partly 37, and none of the remaining 38, because those audits walk directories their own
 * declaration does not cover at all (spec-fixture-loose-types declares services/**\/*.spec.ts
 * and descends into a cdk.out dir; supply-chain-posture-declared declares four exact paths and
 * walks the whole tree). No observation grammar can turn that into a pass or a violation, so
 * `unmeasured` is their correct and FINAL answer - do not "fix" it by widening the reader's
 * guesses, and do not reach for a per-check subject dedupe either: 265,590 of 265,590 observed
 * (seam, subject) pairs were distinct within their own check, so caching buys exactly zero.
 *
 * ⛔ THE OBJECTION FOUR REVIEWERS RAISED AGAINST THIS SEAM, AND WHY IT IS FALSE - settled by
 * experiment on 2026-09-07, recorded here so it is not re-argued a fifth time. The objection: "a
 * walker prunes subdirectories by NAME (a skip set, `isGeneratedDir`), so renaming a source dir to
 * `dist` changes what it yields with no file's extension changing - therefore the extension claim
 * is incomplete." It does not hold, because **git has no directory objects**: a directory rename is
 * reported per FILE (`R src/foo/a.ts -> src/dist/a.ts`, and `--name-only` yields `src/dist/a.ts`),
 * so every file a name-prune removes still reaches the incremental planner as its own changed path,
 * carrying an extension the declaration must already match. No selection gap. The sibling objection
 * - a file literally named `.sql`, whose `path.extname` is `""`, escaping an `endsWith` filter - was
 * measured and is empty here (zero tracked files have a bare dot-extension basename) and moot
 * anyway (`isIncrementalPathMatch("services/**\/*.sql", "services/foo/.sql")` matches). The rule
 * both share: an objection about what a TOOL REPORTS (git, a parser, the filesystem) is decidable -
 * reproduce it in a scratch directory that imports none of this repo, and read the output.
 *
 * @param {unknown} walkScope `{ extensions }` supplied by the walker that owns the readdir call
 * @returns {string[] | null} sorted, deduped extensions, or null when there is nothing sound to say
 */
function normalizedWalkExtensions(walkScope) {
  const raw = walkScope?.extensions;
  const list = raw instanceof Set ? [...raw] : raw;
  if (!Array.isArray(list) || list.length === 0) return null;
  if (!list.every((entry) => typeof entry === "string" && OBSERVED_EXTENSION.test(entry))) return null;
  return [...new Set(list)].sort();
}

function scanSubject(directory, options, walkScope) {
  const extensions = normalizedWalkExtensions(walkScope);
  const subject = { directory: absoluteDirectoryPath(directory), options: normalizedOptions(options) };
  // Absent rather than null when there is no filter: the ledger dedupes by `[seam, subject]`, and
  // an unannotated call must keep producing the exact bytes it produced before this field existed
  // (see `replayReaddirObservation` below, whose whole contract is subject equality with the real
  // call it replays).
  if (extensions) subject.extensions = extensions;
  return JSON.stringify(subject);
}

function observe(directory, options, entries, walkScope) {
  // Native readdir always resolves/callbacks with an array. Keeping this
  // guard turns a future wrapper regression into a loud contract failure.
  if (!Array.isArray(entries)) throw new TypeError("scan directory adapter expected node:fs.readdir to return an array");
  observeScanEvidence({ seam: "scan-directory.readdir", count: entries.length, subject: scanSubject(directory, options, walkScope) });
}

/**
 * Re-attribute a readdir enumeration THIS PROCESS already performed (and cached) to the
 * CURRENT check's scan ledger, without touching the filesystem again.
 *
 * ⛔ EXISTS TO KILL A FALSE SCAN-REACH COLLAPSE (2026-09-05, `declared-intent-adoption`):
 * `scanned-repo-roots.mjs`'s per-run `**\/pattern` expansion cache returns early on a cache
 * hit with NO observation at all, so whichever check happens to trigger the (expensive) real
 * walk FIRST in a given `--all` run gets credited with the entire directory tree it touched -
 * every later check asking for the SAME pattern reads a cache hit and reports zero reach for
 * it. Measured: `declared-intent-adoption`'s own `buildImportGraph` count (the check's real
 * semantic reach) stayed IDENTICAL at 5105 across every run; only its `scan-directory.readdir`
 * total swung 114 <-> 18125 purely by run-order luck, which `scan-reach-collapse` correctly
 * read as a 76% collapse. `buildImportGraph` itself never has this bug - see its own
 * `observeScanEvidence` call in `agnostic/src/core/import-graph.mjs`, placed OUTSIDE the
 * cache-hit branch so every caller reports the same reach regardless of who warmed the cache.
 * This is the same fix, applied here because a directory walk's per-directory observations
 * cannot be replayed as one summary count without losing the per-subject shape `observe`
 * above already commits to.
 *
 * The ledger dedupes by `[seam, subject]` (`scan-observer-internal.mjs`), and every check gets
 * a FRESH ledger (`runWithScanLedger` wraps each `audit.run()` individually) - so replaying the
 * exact `(directory, options, count)` a real call would have produced is safe to call
 * UNCONDITIONALLY, on both a cache hit and a cache miss: on a miss the real call already
 * recorded the identical subject/count and this is a no-op; on a hit it is the only record.
 *
 * @param {string} directory - the SAME directory the original (real) readdir call enumerated
 * @param {object} options - the SAME options the original call used (subject encodes both)
 * @param {number} count - the entry count the original call observed
 * @param {object} [walkScope] - the SAME `{ extensions }` the original call passed, or nothing when
 *   it passed nothing. The dedup this function relies on is subject EQUALITY, so a replay that
 *   annotates what the real call did not (or the reverse) stops deduping and files a second,
 *   contradictory observation for one enumeration.
 */
export function replayReaddirObservation(directory, options, count, walkScope) {
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new TypeError("replayReaddirObservation: count must be a non-negative safe integer");
  }
  observeScanEvidence({ seam: "scan-directory.readdir", count, subject: scanSubject(directory, options, walkScope) });
}

/**
 * Bun's fs.readdir/readdirSync (buffer encoding) hand back plain Uint8Array
 * entries instead of real node:fs Buffer instances - a Bun/Node engine
 * divergence, not an option this seam was asked for. Repair it here so
 * callers see the same `Buffer.isBuffer(...) === true` result native Node
 * gives, matching this module's exact-native-wrapper contract. (Carried over
 * from the agnostic twin when the two scan-directory modules were reconciled
 * to this one canonical home, 2026-08-24 - Architect rebuild Phase 1b.)
 */
function toNativeEntries(entries) {
  if (!Array.isArray(entries)) return entries;
  let copy = entries;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry instanceof Uint8Array && !Buffer.isBuffer(entry)) {
      if (copy === entries) copy = entries.slice();
      copy[index] = Buffer.from(entry);
    }
  }
  return copy;
}

/**
 * ⛔ THE ONE DEVIATION FROM THE NATIVE RESULT: A LISTING NEVER NAMES WHAT THE WORKSPACE CALLS
 * NOT-SOURCE (2026-09-27). `scan-excludes.mjs` exists so "a new walker cannot be born blind" to
 * `scan.excludeDirs`, `.arkitect/ignore` and, on a foreign scan, the target's git ignores - but it
 * only worked for walkers that remembered to ask. A census the same day found 114 recursive walkers
 * that never did (every walker in `collect-files.mjs`, a private one in `human-handoff-readiness`,
 * and so on), so Odin's board graded the GP repositories' gitignored `red/private/` copies of their
 * sibling repos: ~100 phantom gating errors (GP DB 70, GP SupaSecret 28, ...) in files git calls
 * ignored.
 *
 * So the prune happens HERE, once, at the BOUNDARY: listing a directory that is not itself excluded
 * drops the children that are, and no walker can descend into them. A read that deliberately
 * targets a path INSIDE an excluded tree - the runner reading its own state directory, a check
 * whose declared root is an ignored folder it exists to inspect - is returned whole, because that
 * caller named the directory itself rather than wandering into it. Buffer-encoded names are left
 * alone (nothing enumerates the tree that way).
 */
function withoutExcludedChildren(directory, entries) {
  if (!hasScanExcludes() || !Array.isArray(entries) || entries.length === 0) return entries;
  const dir = absoluteDirectoryPath(directory);
  if (typeof dir !== "string" || isScanExcluded(dir)) return entries;
  let kept = null;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    // A string entry is relative to the directory read (a recursive listing's `sub/file` too). A
    // Dirent names its own parent, spelled as the caller passed it - possibly relative to the cwd,
    // which is exactly what `absoluteDirectoryPath` resolved `directory` against.
    let full = null;
    if (typeof entry === "string") full = path.resolve(dir, entry);
    else if (typeof entry?.name === "string") {
      const parent = typeof entry.parentPath === "string" ? entry.parentPath : typeof entry.path === "string" ? entry.path : dir;
      full = path.resolve(parent, entry.name);
    }
    const excluded = full !== null && isScanExcluded(full);
    if (excluded && kept === null) kept = entries.slice(0, index);
    else if (!excluded && kept !== null) kept.push(entry);
  }
  return kept ?? entries;
}

/**
 * Same result shape and overload behavior as node:fs.readdirSync (minus excluded children, above).
 *
 * ⭐ THE THIRD PARAMETER IS EVIDENCE, NOT AN OPTION - it is never forwarded to node, which reads
 * two arguments, so the native contract this module promises is untouched. It exists because a
 * readdir names its directory PRECISELY and says nothing about the filter the WALKER applies right
 * after it: `collectVueFilesAsync` keeps only `.vue`, `walkSourceFiles` only its own `extensions`
 * set, and the ledger recorded neither. Measured 2026-09-07 against a whole-catalog run's ledger,
 * that missing field is the sole blocker on 111 of the 239 audits the observed-input comparator
 * cannot decide (A02 section 4).
 *
 * ⛔ PASS IT ONLY FROM A CALL SITE WHOSE READDIR IS USED FOR NOTHING BUT (a) descending into
 * subdirectories and (b) keeping files of those extensions. A walk whose OUTPUT IS THE ENTRY LIST
 * - `root-entry-allowlist` judging the names it found, `discoverSourceRoots` deciding which
 * directories hold source, a plane roster taken from `readdir("services")` - genuinely depends on
 * every name it saw, and annotating it would license a pass over a change the check really does
 * react to. That is a FALSE GREEN on a selection gate, which is worse than the unmeasured row it
 * replaces. There is deliberately no blanket default and no inference from the options bag.
 */
export function readdirSync(directory, options, walkScope) {
  // A cloud-home docs root is read from the CrAInium snapshot under its repo path (docs-home.mjs);
  // the observation below still names the directory the caller asked for.
  const listed = withDocsEntries(directory, toNativeEntries(nativeReaddirSync(docsSnapshotPath(directory), options)), options);
  const entries = withoutExcludedChildren(directory, listed);
  observe(directory, options, entries, walkScope);
  return entries;
}

/** Same result shape and overload behavior as node:fs/promises.readdir. `walkScope` as above. */
export async function readdir(directory, options, walkScope) {
  const listed = withDocsEntries(directory, toNativeEntries(await nativeReaddirPromise(docsSnapshotPath(directory), options)), options);
  const entries = withoutExcludedChildren(directory, listed);
  observe(directory, options, entries, walkScope);
  return entries;
}

/** Same callback overload behavior as node:fs.readdir. `walkScope` as on `readdirSync` above. */
export function readdirCallback(directory, options, callback, walkScope) {
  const effectiveOptions = typeof options === "function" ? undefined : options;
  const effectiveCallback = typeof options === "function" ? options : callback;
  const effectiveWalkScope = typeof options === "function" ? callback : walkScope;
  if (typeof effectiveCallback !== "function") throw new TypeError("readdirCallback requires a callback");
  const wrapped = function (error, rawEntries, ...rest) {
    if (error) return effectiveCallback.call(this, error, rawEntries, ...rest);
    const entries = withoutExcludedChildren(directory, withDocsEntries(directory, toNativeEntries(rawEntries), effectiveOptions));
    observe(directory, effectiveOptions, entries, effectiveWalkScope);
    return effectiveCallback.call(this, error, entries, ...rest);
  };
  const physical = docsSnapshotPath(directory);
  return effectiveOptions === undefined ? nativeReaddir(physical, wrapped) : nativeReaddir(physical, effectiveOptions, wrapped);
}
