// vendored from Connections packages/connections-arkitect/src/core/run-artifacts.mjs @ dd3d47a7ad
// Race-safe storage for Architect artifacts.
//
// Every invocation writes to its own UUID directory. The mutable tmp/arkitect
// view is only an atomic latest mirror; archives are finalized by directory
// rename and therefore can never contain files from two different runs.
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, normalize, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gunzipSync } from "node:zlib";
import { atomicWriteFile } from "./atomic-io.mjs";
import { parseArtifactJson } from "./artifact-contracts.mjs";
import { readdirSync as scanReaddirSync } from "./scan-directory.mjs";

// Re-exported for every existing caller that imports `atomicWriteFile` from this module (bin/arkitect.mjs,
// runner.mjs, readiness.mjs, report-state.mjs, replay.mjs, and their tests) - the shared implementation now
// lives in ./atomic-io.mjs, alongside its `atomicWriteJson` sibling.
export { atomicWriteFile };

// The run-scoped sidecar every check's full runtime-scan evidence trail moves into (ENG-06). It
// lives HERE, with the artifact list that must contain it, rather than in runner.mjs which used to
// own it - runner.mjs already imports from this module, so this is the direction that lets both
// sides read one constant instead of the literal being written out twice.
//
// Named with a `.gz` extension because it is written pre-compressed. Nothing existing reads this
// file, so unlike manifest.json/DECISION_BRIEF.json/telemetry.json (whose plain-JSON shape is
// load-bearing for the burn-down workflow, `arkitect.mjs`, `arkitect-performance.mjs`, and
// `finding-lifecycle.mjs`, all of which `readFileSync(..., "utf8")` the archive directly - gzip-ing
// THOSE would be a breaking format change for every one of those readers) it can start compressed.
export const SCAN_OBSERVATIONS_ARTIFACT = "scan-observations.json.gz";

/**
 * The decision brief's finding payload, moved out of the brief itself.
 *
 * ⭐ WHY A SECOND SIDECAR RATHER THAN A BIGGER BUDGET (measured 2026-08-26). One real
 * `audit:strict` brief was **470 MB - 92% of a 509 MB run** - holding 118,100 finding objects for
 * 39,301 unique findings, each stored about three times (the flat lifecycle list, `details[]`, and
 * the lifecycle resolved/groups sets), plus 1,063 fully-rendered check reports inlined beside the
 * sibling `.md` files that already hold them.
 *
 * That single number is why `.arkitect/reports/` could never hold its 512 MB budget: retention
 * protects up to `keepCanonical` runs PER LANE across two lanes, so ~6 runs are untouchable, and six
 * half-gigabyte runs is ~3 GB of evidence the framework is right to refuse to delete. The budget was
 * unmeetable by arithmetic, not by a bug - so the artifact had to shrink rather than the ceiling
 * grow. Same conclusion, same shape, and the same reasoning as ENG-06's scan-observation sidecar
 * above; this is the second payload that outgrew being inline, not a new idea.
 */
export const BRIEF_FINDINGS_ARTIFACT = "decision-brief-findings.json.gz";

/**
 * A brief's findings, from wherever that brief put them - THE one accessor, for every consumer.
 *
 * ⭐ IT IS EXPORTED FROM HERE, NOT COPIED, because the alternative was measured and rejected: the
 * payload moved out of the brief on 2026-08-26 and five separate places read `brief.findings` off
 * disk (the history loader, the scan product command, the scan report runner, the runtime-scan
 * codemod, and the runner's own truth test). Five inline `?? []` fallbacks would have been five
 * chances to answer "no findings" for a run that had thousands.
 *
 * ⛔ A POINTER WE CANNOT FOLLOW THROWS. It never degrades to `[]` - a false "clean" is the one
 * outcome worse than a crash here, and every caller either records the throw as an issue or is a
 * developer at a terminal who needs to see it.
 *
 * `runDir` is the archive directory the brief was read from; pass it even for an inline brief, since
 * that branch never touches the filesystem.
 */
export function readBriefPayload(runDir, brief) {
  // Inline - every brief archived before 2026-08-26, and the shape a caller may still be handed.
  if (Array.isArray(brief?.findings))
    return {
      findings: brief.findings,
      details: brief.details ?? [],
      resolved: brief.lifecycle?.resolved ?? [],
      groups: brief.lifecycle?.groups ?? [],
    };
  const ref = brief?.findingsRef;
  if (!ref?.artifact) return { findings: [], details: [], resolved: [], groups: [] };
  const payload = JSON.parse(gunzipSync(readFileSync(join(runDir, BRIEF_FINDINGS_ARTIFACT))).toString("utf8"));
  if (!Array.isArray(payload?.findings)) throw new TypeError(`${BRIEF_FINDINGS_ARTIFACT} has no findings array`);
  // The count is stamped on the pointer precisely so a truncated or half-written sidecar is caught
  // here rather than quietly narrowing whatever the caller is about to compute.
  if (Number.isInteger(ref.findingCount) && payload.findings.length !== ref.findingCount)
    throw new TypeError(`${BRIEF_FINDINGS_ARTIFACT} holds ${payload.findings.length} findings, pointer claims ${ref.findingCount}`);
  return {
    findings: payload.findings,
    details: payload.details ?? [],
    resolved: payload.resolved ?? [],
    groups: resolveRefRows(payload.groups, payload.findings),
  };
}

/**
 * Turn a v2 payload's fingerprint references back into the finding objects a caller expects.
 *
 * ⛔ THIS IS WHY THE DEDUPE IS SAFE. Every consumer of `groups[]` reads finding OBJECTS, and they
 * all come through this one accessor - the module header above says so, and says why: the payload
 * moved once already and five separate places were reading `brief.findings` off disk, so five
 * inline fallbacks would have been five chances to answer "no findings" for a run that had
 * thousands. Rehydrating HERE means the storage shape changed and not one caller did.
 *
 * ⛔ THE REFERENCE IS A `fingerprint`, NEVER AN `id`. `id` is the RULE id - a whole-catalog run had
 * 198 distinct ids across 36,747 findings - so an id-keyed lookup silently resolves to a DIFFERENT
 * finding of the same rule. That was the first cut of this, and only a byte-for-byte round-trip
 * against a real payload caught it.
 *
 * ⛔ AN UNRESOLVABLE REFERENCE THROWS. It never degrades to a dropped row: a group that quietly
 * loses its findings reads as a group with nothing wrong, which is the same false-clean the
 * pointer's own count guard exists to prevent one level up.
 *
 * v1 payloads embedded the objects directly, so a non-string row passes through untouched and an
 * archive written before this change reads exactly as it always did.
 */
function resolveRefRows(rows, findings) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  let byFingerprint = null;
  return rows.map((row) => {
    if (!Array.isArray(row?.findings)) return row;
    if (!row.findings.some((entry) => typeof entry === "string")) return row; // v1 - already objects
    if (byFingerprint === null) {
      byFingerprint = new Map();
      for (const finding of findings) if (finding?.fingerprint) byFingerprint.set(finding.fingerprint, finding);
    }
    return {
      ...row,
      findings: row.findings.map((entry) => {
        if (typeof entry !== "string") return entry;
        const finding = byFingerprint.get(entry);
        if (!finding) throw new TypeError(`${BRIEF_FINDINGS_ARTIFACT} references fingerprint ${entry}, which is not in its findings array`);
        return finding;
      }),
    };
  });
}

/** The findings alone - the shape most callers want. Same guarantees as `readBriefPayload`. */
export function readBriefFindings(runDir, brief) {
  return readBriefPayload(runDir, brief).findings;
}

/**
 * The brief as it would have looked inline - findings, details AND the lifecycle rows.
 *
 * ⛔ EXISTS BECAUSE A HALF-RESTORE IS SILENT. Rehydrating `findings` and `details` but leaving
 * `lifecycle.resolved` / `lifecycle.groups` behind produced a replayed HTML report that differed
 * from the original in a way no count disagreed about - the gate, the totals and the fix queue all
 * matched, and only a byte comparison of the rendered page caught it. Any consumer that wants the
 * whole brief must get the whole brief from ONE call, so there is no per-caller list of fields to
 * forget.
 */
export function rehydrateBrief(runDir, brief) {
  if (Array.isArray(brief?.findings)) return brief; // already inline - nothing to restore
  const { findings, details, resolved, groups } = readBriefPayload(runDir, brief);
  const rest = { ...brief };
  delete rest.findingsRef;
  return { ...rest, findings, details, lifecycle: { ...brief.lifecycle, resolved, groups } };
}

export const PRIMARY_ARTIFACTS = [
  "manifest.json",
  "FIX_QUEUE.md",
  "telemetry.json",
  "findings.sarif",
  "DECISION_BRIEF.json",
  "report.html",
  "READINESS.md",
  "readiness.json",
  "BURN_LIST.md",
  // Absent when a run externalized nothing; every reader here already tolerates that.
  SCAN_OBSERVATIONS_ARTIFACT,
  // Absent on a run with no findings at all, and on every run archived before 2026-08-26.
  BRIEF_FINDINGS_ARTIFACT,
];

/**
 * The mutable mirror's GENERATION LEDGER - which run each file sitting in `outDir` came from, and
 * the exact bytes that run published, so a reader can prove the bundle it is holding is ONE run's
 * output rather than a mix of two.
 *
 * ⛔ WHY THIS EXISTS (A05, confirmed 2026-09-05 against the real publisher, not a theory). The
 * archive is coherent by construction - it is finalized by directory rename, so it can never contain
 * two runs' files. The MIRROR is not: `publishLatestMirror` copies each companion INDIVIDUALLY, and
 * the runner publishes companions and `manifest.json` in SEPARATE calls (run-summarize.mjs writes
 * FIX_QUEUE/telemetry/report.html/the brief, then serializes the manifest, then mirrors it; the
 * greenlight path in bin/arkitect.mjs does the same, with an archive and a retention prune in the
 * gap). The reviewer's probe drove exactly that order and observed the mirror holding
 * `manifest.generation === "A"` beside `report.html === "report-B"` - deterministically, with no
 * scheduler luck required. Every single file was individually valid and correctly parsed, which is
 * precisely why nothing caught it: coherence is a property of the SET, and nothing recorded the set.
 *
 * ⛔ SO THE LEDGER RECORDS IDENTITY PER FILE, NOT PER PUBLICATION. Each row names the generation that
 * wrote that file and the sha256 of the bytes it wrote, and rows a later publication did not touch
 * KEEP their older generation - the ledger is a truthful account of a mixed mirror rather than a
 * claim that the mirror is clean. That is the whole difference between this and a bare "last run id"
 * stamp, which would have relabelled the mixed window as coherent instead of exposing it.
 *
 * ⛔ AND THE DIGEST IS LOAD-BEARING, NOT DECORATION. The ledger is written last and non-atomically
 * with respect to the files it describes, so on a ~20-agent tree a peer's publication can land
 * between a reader's ledger read and its file read. Re-hashing what was actually read is what turns
 * that into an explicit `superseded` retry instead of a silently mixed answer - the same "verify,
 * never trust" contract `readTypedArchivePointer` applies to the archive pointer one layer down.
 *
 * Immutable per-run custody is untouched by all of this: nothing here writes into a run directory or
 * an archive, and the ledger never travels into one (it is written into the MIRROR, and
 * `archiveRunArtifacts` copies the run directory).
 */
export const MIRROR_GENERATION_FILE = "mirror-generation.json";

/**
 * Files the Architect itself may create while it is observing a workspace.
 *
 * Keep this list path-exact: source identity must ignore executor-owned
 * evidence churn without turning an arbitrary `--out` parent into a blind
 * spot. Directory entries name owned subtrees; file entries name only the
 * mutable mirrors the runner writes.
 */
export function architectOwnedWorkspacePaths(root, outDir) {
  return [
    join(outDir, "runs"),
    join(outDir, "shard-runs"),
    ...PRIMARY_ARTIFACTS.map((name) => join(outDir, name)),
    // The mirror's own generation ledger (see MIRROR_GENERATION_FILE below). It is written into
    // outDir by publishLatestMirror exactly like the PRIMARY_ARTIFACTS beside it, so it is the tool's
    // own exhaust for the same reason they are - omitting it would make the Architect's bookkeeping
    // read as the workspace moving on any `--out` directory that lives inside the scanned tree.
    join(outDir, MIRROR_GENERATION_FILE),
    join(root, "tmp", "arkitect"),
    join(root, "tmp", "report.html"),
    // ★ EVERY CHECK'S OWN REPORT LANDS HERE, which is why omitting it produced a false red rather
    // than a small gap: `run-workspace-stability` watched the directory the run was writing into
    // and correctly reported it moving. Measured 2026-08-17 across ten checkouts - six failed and
    // four passed, separated only by whether their .gitignore happened to carry a `tmp` line, so
    // it fires hardest on the repos the Architect has never been pointed at before. Deliberately
    // `tmp/audits` and not `tmp`: this list is a BLIND SPOT by construction, and owning the whole
    // tree would hide a repo that genuinely keeps source there.
    join(root, "tmp", "audits"),
    join(root, ".arkitect", "reports"),
  ];
}

function assertChild(parent, target) {
  const base = `${resolve(parent)}${sep}`.toLowerCase();
  const candidate = resolve(target).toLowerCase();
  if (!candidate.startsWith(base)) throw new Error(`refusing artifact operation outside ${parent}: ${target}`);
}

/**
 * Boolean sibling of assertChild for callers that refuse rather than throw: is `candidate` the
 * root itself, or a path inside it? The naive `relative(root, x).startsWith("..")` idiom is NOT
 * this predicate on Windows: across drive letters `path.relative` returns an ABSOLUTE path with
 * no ".." prefix, so a --root on D: with --out on C: read as "inside" and the corpus-mount guard
 * refused every cross-drive portable scan with exit 2 (found 2026-08-17, twice, independently).
 * `isAbsolute` on the relative result is the missing half; the exact `..`/`..<sep>` test (rather
 * than a bare ".." prefix) keeps a child literally named "..something" classified as inside.
 */
export function pathIsInsideRoot(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * Return a collision-resistant file name for arbitrary external identifiers.
 * Check ids are data, not path segments: an id can legally contain punctuation
 * (the corpus itself uses colon-bearing synthetic ids), so a sanitizer alone
 * would both collide and invite traversal bugs.
 */
export function artifactFileName(id, extension = ".md") {
  if (typeof extension !== "string" || !/^\.[a-z0-9]+$/i.test(extension)) throw new Error(`invalid artifact extension: ${extension}`);
  const value = String(id);
  const slug =
    value
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/^[._-]+|[._-]+$/g, "")
      .slice(0, 48) || "unnamed";
  const digest = createHash("sha256").update(value).digest("hex").slice(0, 32);
  return `check-${slug}-${digest}${extension}`;
}

/** A strict, normalized relative child path - no absolute, dot, or traversal aliases. */
export function strictArtifactChild(parent, name) {
  if (typeof name !== "string" || !name || name.includes("\0") || isAbsolute(name))
    throw new Error(`invalid artifact child path: ${String(name)}`);
  const normalized = normalize(name);
  if (normalized !== name || normalized === "." || normalized === ".." || normalized.startsWith(`..${sep}`))
    throw new Error(`artifact child path must be normalized: ${name}`);
  const target = resolve(parent, normalized);
  assertChild(parent, target);
  const rel = relative(resolve(parent), target);
  if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new Error(`refusing artifact operation outside ${parent}: ${name}`);
  return target;
}

/** The canonical directory a check's own report lands in, relative to the scan root. */
export const CHECK_REPORT_DIR = "audits";

/**
 * Resolve a check's declared `outputPath` to an absolute file, anchored to the SCAN ROOT.
 *
 * ★ A DECLARATION WITH NO DIRECTORY COMPONENT IS ANCHORED INTO tmp/audits, not the repo root.
 * `outputPath` is a root-relative scratch path, so a bare `"my-check.md"` used to resolve to a
 * stray markdown file in the repository root - untracked, un-ignored, and therefore itself enough
 * to trip `run-workspace-stability` on a repo whose operator did nothing wrong. Two checks in this
 * corpus declared exactly that shape and nothing detected it, because the resolution was spread
 * across the runner rather than living in one named function. Normalizing the bare shape here
 * removes the failure mode; detecting it later would only have named it.
 *
 * Everything else is unchanged: a path that already names a directory goes exactly where it asked,
 * and an absolute path or a `..` traversal still THROWS rather than being quietly relocated - the
 * containment rule is a refusal, and turning a refusal into a silent move is how a guard stops
 * being one.
 */
export function checkReportPath(root, outputPath) {
  const declared = String(outputPath)
    .split(/[\\/]+/)
    .join(sep);
  const anchored = declared.includes(sep) ? declared : join("tmp", CHECK_REPORT_DIR, declared);
  return strictArtifactChild(root, anchored);
}

export function createRunArtifactDirectory(outDir, { runId = randomUUID() } = {}) {
  const runsDir = join(outDir, "runs");
  const dir = strictArtifactChild(runsDir, String(runId));
  mkdirSync(dir, { recursive: true });
  return { runId, dir };
}

function artifactDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Which run a source directory's artifacts belong to.
 *
 * The manifest's own `run.runId` is asked FIRST because that is the identity every reader already
 * compares against (`readTypedArchivePointer` verifies the same field), and run-summarize.mjs writes
 * the manifest into the run directory before it mirrors anything, so it is present at both
 * publication phases. The directory name is the fallback rather than the primary: it is the runId for
 * every directory `createRunArtifactDirectory` makes, but an `--out` destination is named by the
 * operator and cannot be assumed to carry one.
 */
function sourceGenerationOf(runDir) {
  try {
    const runId = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"))?.run?.runId;
    if (typeof runId === "string" && runId) return runId;
  } catch {
    /* an unwritten/unreadable manifest is normal on an early publish - fall through to the name */
  }
  return basename(resolve(runDir)) || "unidentified-generation";
}

function readMirrorLedger(outDir) {
  try {
    const ledger = JSON.parse(readFileSync(join(outDir, MIRROR_GENERATION_FILE), "utf8"));
    if (!ledger || typeof ledger.generation !== "string" || !ledger.generation) return null;
    return { ...ledger, files: ledger.files && typeof ledger.files === "object" ? ledger.files : {} };
  } catch {
    return null; // absent, or written by a build that predates the ledger - never invented
  }
}

export function publishLatestMirror(runDir, outDir, names = PRIMARY_ARTIFACTS) {
  const written = [];
  const failed = [];
  const generation = sourceGenerationOf(runDir);
  // Carried forward, not reset: a file this call does not republish is still sitting in the mirror,
  // and the honest record of it is the generation that DID write it. Resetting here would erase the
  // evidence of a mixed mirror, which is the exact failure this ledger exists to expose.
  const files = { ...(readMirrorLedger(outDir)?.files ?? {}) };
  // ⛔ WHAT THIS GENERATION OWES THE MIRROR, derived from the RUN DIRECTORY rather than accumulated
  // across calls - and the difference is a false clean, caught by the batched test run on 2026-09-05.
  // A publication is two calls (companions, then the manifest), so an accumulated set has to be read
  // back out of the ledger, and on a shared tree a peer's publish lands between the read and the
  // write: run A's manifest call then re-wrote the ledger as "generation A owes only manifest.json",
  // with B's companions sitting under it. The reader dutifully found generation A complete for the
  // one file it claimed to owe and called a manifest-A/report-B mirror COHERENT. Reading the run
  // directory instead cannot lose that race - the run's own artifacts are still on disk at both
  // calls, so both write the same set, and a companion that has drifted to another generation is a
  // `mixed` verdict rather than a name quietly dropped from the bundle.
  const expected = [...new Set([...PRIMARY_ARTIFACTS, ...names])].filter((name) => {
    try {
      return existsSync(strictArtifactChild(runDir, name));
    } catch {
      return false; // a name that cannot even resolve inside the run dir is not something it owes
    }
  });
  for (const name of names) {
    const source = strictArtifactChild(runDir, name);
    if (!existsSync(source)) continue;
    try {
      const bytes = readFileSync(source);
      atomicWriteFile(strictArtifactChild(outDir, name), bytes);
      files[name] = { generation, sha256: artifactDigest(bytes), byteLength: bytes.length };
      written.push(name);
    } catch (error) {
      // ⛔ A failed publish must not leave a row from an OLDER generation standing under this
      // generation's ledger - a reader would then certify a stale file as part of this bundle. A
      // same-generation row is kept: the mirror still holds those bytes, and atomicWriteFile either
      // replaces the file or leaves the previous one, so the row remains true (and if its fallback
      // removed the destination outright, the reader's own existence check catches that).
      if (files[name] && files[name].generation !== generation) delete files[name];
      failed.push({ name, error: String(error?.message || error) });
    }
  }
  try {
    atomicWriteFile(
      join(outDir, MIRROR_GENERATION_FILE),
      `${JSON.stringify({ schemaVersion: 1, generation, publishedAt: new Date().toISOString(), expected, files }, null, 2)}\n`,
    );
  } catch (error) {
    // Counted as a failed artifact rather than swallowed: without the ledger the mirror is
    // unverifiable, and `readCoherentLatestMirror` reports that as `unledgered` rather than clean.
    failed.push({ name: MIRROR_GENERATION_FILE, error: String(error?.message || error) });
  }
  return { written, failed, complete: failed.length === 0, generation };
}

/**
 * Re-stamp ledger rows for files a caller rewrote IN PLACE in the mirror, keeping the generation
 * each row already names and correcting only its digest.
 *
 * ⛔ THIS EXISTS FOR `--reuse`, WHICH HAS NO RUN DIRECTORY TO PUBLISH FROM. A greenlight re-grade
 * re-renders READINESS.md, readiness.json, BURN_LIST.md and report.html from a manifest it read out
 * of the mirror, and writes them straight back over the mirror - there is no run dir, so
 * `publishLatestMirror` cannot be the path. Without this, those four files keep ledger rows whose
 * sha256 describes the PREVIOUS render, and since `readCoherentLatestMirror` deliberately re-hashes
 * what it actually read, every subsequent read of that mirror reports `superseded` forever. The
 * mirror fails CLOSED, which is the right direction, but it is permanently unreadable rather than
 * momentarily so - a re-grade would have quietly cost the mirror its whole purpose.
 *
 * ⛔ IT NEVER INVENTS AN IDENTITY. The generation is carried from the row that is already there, so
 * this cannot be used to claim a file belongs to a run that did not write it; a file with no row,
 * and a mirror with no readable ledger at all, are both left exactly as they were - an unledgered
 * mirror stays unledgered and says so on every read, which is the contract above.
 */
export function recordMirrorRewrite(outDir, rewritten) {
  const ledger = readMirrorLedger(outDir);
  if (!ledger) return { updated: [], skipped: Object.keys(rewritten), ledgered: false };
  const files = { ...ledger.files };
  const updated = [];
  const skipped = [];
  for (const [name, bytes] of Object.entries(rewritten)) {
    const existing = files[name];
    if (!existing?.generation) {
      skipped.push(name);
      continue;
    }
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes));
    files[name] = { generation: existing.generation, sha256: artifactDigest(buffer), byteLength: buffer.length };
    updated.push(name);
  }
  try {
    atomicWriteFile(
      join(outDir, MIRROR_GENERATION_FILE),
      `${JSON.stringify({ ...ledger, publishedAt: new Date().toISOString(), files }, null, 2)}\n`,
    );
  } catch (error) {
    return { updated: [], skipped: Object.keys(rewritten), ledgered: true, error: String(error?.message || error) };
  }
  return { updated, skipped, ledgered: true };
}

/**
 * Read the mutable mirror as ONE generation, or refuse - the consumer half of the ledger above.
 *
 * ⛔ IT NEVER DEGRADES TO "CLEAN". Five verdicts, and only the first one licenses using the files:
 *
 * - `coherent`   - every requested file was published by the same run the mirrored manifest declares
 *                  itself to be, and still holds the bytes that run wrote.
 * - `mixed`      - the publication window this whole mechanism exists to expose: the manifest and a
 *                  companion belong to different runs. Retryable; the publisher is between phases.
 * - `superseded` - a file's bytes moved while this read was in flight. Retryable.
 * - `incomplete` - a requested file, the manifest included, is absent from the mirror or from the
 *                  ledger. Retryable.
 * - `unledgered` - no readable ledger, so coherence cannot be verified. Retryable, because a publish
 *                  that has not happened yet writes one; a mirror from a build older than the ledger
 *                  simply never becomes verifiable, and says so on every read rather than passing.
 * - `unidentified` - the manifest parses and names no run. The ONLY refusal that is not retryable:
 *                  re-reading the same bytes can never grow an identity to corroborate against.
 *
 * ⛔ None of the four refusals ever degrades to "coherent". An unverifiable bundle answering "yes"
 * is exactly the false-clean this whole mechanism replaces, and the retryable flag is a statement
 * about whether a LATER read could differ - never a hint that the current one was probably fine.
 *
 * `names` defaults to the manifest plus every artifact the publishing run OWED the mirror - the
 * PRIMARY_ARTIFACTS its own run directory actually held. A row left over from an earlier run that
 * this run never had is reported as `stale` rather than as an error, because a greenlight run
 * publishing READINESS.md that a later plain run does not republish is a legitimately stale file in
 * the mirror, not a broken bundle; a file the run DID hold and that has drifted to another
 * generation is the mixed window, and fails the bundle.
 * Pass `content: true` to receive the verified bytes; without it the caller gets metadata and must
 * re-verify a re-read against the returned `sha256`, since the mirror is mutable shared state.
 */
export function readCoherentLatestMirror(outDir, { names = null, content = false } = {}) {
  const refuse = (status, reason, extra = {}) => ({ status, reason, retryable: status !== "unidentified", files: {}, stale: [], ...extra });
  const ledger = readMirrorLedger(outDir);
  if (!ledger)
    return refuse(
      "unledgered",
      `${MIRROR_GENERATION_FILE} is absent or unreadable - this mirror's cross-file coherence cannot be verified`,
      { generation: null },
    );
  const generation = ledger.generation;
  const stale = Object.keys(ledger.files)
    .filter((name) => ledger.files[name]?.generation !== generation)
    .sort();
  // ⛔ A MANIFEST THAT IS NOT THERE YET AND ONE THAT HAS NO NAME ARE DIFFERENT ANSWERS, and the
  // stress run is what forced the split: during the very first generation's phase-one window the
  // mirror holds companions and no manifest at all, which is the ordinary transient state every
  // other refusal here calls retryable. Collapsing both into a permanent verdict would have told a
  // consumer to give up on a bundle that was one publish away from settling.
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(outDir, "manifest.json"), "utf8"));
  } catch (error) {
    return refuse("incomplete", `manifest.json could not be read from the mirror: ${String(error?.message || error)}`, {
      generation,
      stale,
    });
  }
  const manifestRunId = manifest?.run?.runId ?? null;
  if (typeof manifestRunId !== "string" || !manifestRunId)
    return refuse(
      "unidentified",
      "the mirrored manifest.json declares no run.runId, so the ledger's generation cannot be corroborated against it",
      { generation, stale },
    );
  // ★ CORROBORATION AGAINST A VALUE THE LEDGER DID NOT WRITE - the manifest's own account of which
  // run it is. ⚠ Measured 2026-09-05 by disabling this line in place: the artifact-concurrency suite
  // still passed, because `sourceGenerationOf` prefers the manifest's runId, so in every reachable
  // publication the two agree by construction and the per-file rows below are what actually catch the
  // window. It is kept, and described honestly rather than as the load-bearing check it is not: it is
  // the one line that stops the ledger from being self-referential, and it goes live the moment
  // generation identity is ever derived from anything but the manifest. Pinned directly by a
  // hand-built ledger in the test, since no publication path can produce the divergence today.
  if (manifestRunId !== generation)
    return refuse("mixed", `manifest.json belongs to run ${manifestRunId} while ${MIRROR_GENERATION_FILE} names generation ${generation}`, {
      generation,
      stale,
    });
  // The default bundle is everything the publishing run OWED the mirror (`expected`, taken from its
  // own run directory), never merely the rows that happen to carry the current generation - the
  // latter lets a companion left behind by another run silently drop out of the bundle instead of
  // failing it. A ledger without the field is read the old way rather than being trusted blindly.
  const owed = Array.isArray(ledger.expected)
    ? ledger.expected
    : Object.keys(ledger.files).filter((name) => ledger.files[name]?.generation === generation);
  const wanted = names ?? ["manifest.json", ...owed];
  const files = {};
  for (const name of [...new Set(wanted)]) {
    const row = ledger.files[name];
    if (!row) return refuse("incomplete", `${name} is not recorded in ${MIRROR_GENERATION_FILE}`, { generation, stale });
    if (row.generation !== generation)
      return refuse("mixed", `${name} was published by generation ${row.generation}, not ${generation}`, { generation, stale });
    let bytes;
    try {
      bytes = readFileSync(strictArtifactChild(outDir, name));
    } catch (error) {
      return refuse("incomplete", `${name} is named by the ledger but could not be read: ${String(error?.message || error)}`, {
        generation,
        stale,
      });
    }
    const sha256 = artifactDigest(bytes);
    if (sha256 !== row.sha256)
      return refuse(
        "superseded",
        `${name} no longer holds the bytes generation ${generation} published - a newer publication landed mid-read`,
        { generation, stale },
      );
    files[name] = content ? { generation, sha256, byteLength: bytes.length, bytes } : { generation, sha256, byteLength: bytes.length };
  }
  return { status: "coherent", reason: null, retryable: false, generation, publishedAt: ledger.publishedAt ?? null, files, stale };
}

function archiveDirectories(reportsDir) {
  if (!existsSync(reportsDir)) return [];
  return scanReaddirSync(reportsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith(".pending-"))
    .map((entry) => entry.name)
    .sort();
}

function archiveManifest(reportsDir, name) {
  try {
    const path = join(reportsDir, name, "manifest.json");
    return parseArtifactJson(readFileSync(path, "utf8"), "manifest", path);
  } catch {
    return null;
  }
}

// ── The archive summary: what retention needs from an archive, computed once ─────────────────────
//
// Retention asks three things of every archive on EVERY run: how many checks it covered (breadth),
// whether it completed a lane, and how many bytes it holds. Answering them meant parsing each archived
// manifest twice (26 archives, 25 MB of JSON, ~4 MB for each broad run) and stat-walking every file
// under them (7,349 files): measured 2026-09-24 on a copy of this repo's reports dir, ~1.0-1.35 s and
// +62-66 MB peak RSS per run - paid by a one-check run exactly as by a full one (JE-ARKITECT-049). An
// archive is immutable once `archiveRunArtifacts` renames it into place, so the answers never change:
// the first pass that needs them writes `archive-summary.json` into the archive and every later pass
// reads 200 bytes. `bytes` excludes the summary file itself; the reader adds that file's own size, so
// the byte total is exactly what the walk returns. Nothing is cached for an archive whose manifest
// did not parse - that archive is re-read every pass, as before.
const ARCHIVE_SUMMARY_FILE = "archive-summary.json";
const ARCHIVE_SUMMARY_VERSION = 1;

function readArchiveSummary(archiveDir) {
  try {
    const path = join(archiveDir, ARCHIVE_SUMMARY_FILE);
    const summary = JSON.parse(readFileSync(path, "utf8"));
    const counts = [summary?.checks, summary?.completeFor, summary?.bytes];
    if (summary?.schemaVersion !== ARCHIVE_SUMMARY_VERSION || !counts.every((n) => Number.isSafeInteger(n) && n >= 0)) return null;
    return { checks: summary.checks, completeFor: summary.completeFor, bytes: summary.bytes + statSync(path).size };
  } catch {
    return null;
  }
}

// Written with no mkdir: a pass that races a peer's eviction of this archive must fail to write,
// never recreate the directory with only a summary in it.
function writeArchiveSummary(archiveDir, summary) {
  const path = join(archiveDir, ARCHIVE_SUMMARY_FILE);
  const temp = join(archiveDir, `.${ARCHIVE_SUMMARY_FILE}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(temp, `${JSON.stringify({ schemaVersion: ARCHIVE_SUMMARY_VERSION, ...summary })}\n`);
    renameSync(temp, path);
  } catch {
    try {
      rmSync(temp, { force: true });
    } catch {
      /* a cache that failed to land is recomputed next pass */
    }
  }
}

/**
 * Per-pass reader over the archives: `counts(name)` -> `{ checks, completeFor }` and `bytes(name)`,
 * each from the archive's summary when it has one, else computed at most once this pass. The summary
 * is written once both halves are known from a manifest that parsed.
 */
function archiveFactsReader(reportsDir) {
  const summaries = new Map();
  const counted = new Map();
  const sized = new Map();
  const summaryOf = (name) => {
    if (!summaries.has(name)) summaries.set(name, readArchiveSummary(join(reportsDir, name)));
    return summaries.get(name);
  };
  const persistIfKnown = (name) => {
    const counts = counted.get(name);
    if (!counts?.parsed || !sized.has(name)) return;
    const archiveDir = join(reportsDir, name);
    let invalidSummaryBytes = 0;
    try {
      invalidSummaryBytes = statSync(join(archiveDir, ARCHIVE_SUMMARY_FILE)).size;
    } catch {
      /* none - the usual case */
    }
    writeArchiveSummary(archiveDir, {
      checks: counts.checks,
      completeFor: counts.completeFor,
      bytes: sized.get(name) - invalidSummaryBytes,
    });
  };
  const counts = (name) => {
    const summary = summaryOf(name);
    if (summary) return summary;
    if (!counted.has(name)) {
      const manifest = archiveManifest(reportsDir, name);
      counted.set(name, {
        checks: manifest?.checks?.length ?? 0,
        completeFor: manifest?.run?.completeFor?.length ?? 0,
        parsed: Boolean(manifest),
      });
      persistIfKnown(name);
    }
    return counted.get(name);
  };
  const bytes = (name) => {
    const summary = summaryOf(name);
    if (summary) return summary.bytes;
    if (!sized.has(name)) {
      sized.set(name, directoryBytes(join(reportsDir, name)));
      persistIfKnown(name);
    }
    return sized.get(name);
  };
  return { counts, bytes };
}

/**
 * A run worth protecting from rotation, by BREADTH rather than by a flag it cannot control.
 *
 * `completeFor` was the only protection until 2026-08-02, and on a shared tree it is exactly the
 * wrong key: `finalizeRunEnvelope` empties `completeFor` whenever `workspaceStable === false`, which
 * is the normal state of a repo ~20 agents are editing. So a full 790-check `--all` run archived
 * during a burn-down is born unprotected, and the burn-down's own follow-up `--check <id>` runs -
 * dozens of them, one per fixer - evict it inside the 20-slot window. The campaign then loses the
 * report that named its remaining work, mid-campaign. That happened, which is why this exists.
 *
 * Breadth is self-calibrating: a run counts as broad if it covered at least half as many checks as
 * the widest run on disk. No corpus-size constant to go stale, and a stream of single-check runs can
 * never qualify no matter how many of them land.
 */
function broadRunNames(facts, runs) {
  const widths = new Map(runs.map((name) => [name, facts.counts(name).checks]));
  const widest = Math.max(0, ...widths.values());
  if (widest <= 1) return [];
  return runs.filter((name) => widths.get(name) >= widest / 2);
}

/**
 * Total bytes under `dir`, recursively. Best-effort: a file that vanishes mid-walk (a concurrent
 * run finalizing) is skipped rather than crashing the prune - the count-based ceiling above has
 * the same "another run is touching this" tolerance via `rmSync({ force: true })`.
 */
function directoryBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = scanReaddirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += directoryBytes(target);
      continue;
    }
    try {
      total += statSync(target).size;
    } catch {
      /* file removed mid-walk - best-effort, matches the tolerance above */
    }
  }
  return total;
}

// Measured 2026-08-06: .arkitect/reports/ grew from 3,202 files / 839 MB to 4,813 files / 1,202 MB
// WITHIN A SINGLE SESSION under the count-only ceiling (keep:20, keepCanonical:3) - a full run
// archived ~770 files, so "20 runs" was a wildly different disk amount depending on run mix. That
// 1.2 GB was mostly one thing: manifest.json/DECISION_BRIEF.json/telemetry.json each independently
// inlining the SAME per-check runtime-scan observation array (ENG-06). Re-deriving the exact bytes
// of a real 927-check archived run (2026-08-14T04-06-53Z) with run-summarize.mjs's `externalizeScanObservations`
// transform applied - the array written once to a sibling gzip sidecar instead of three times inline
// - took that one run's manifest+DECISION_BRIEF+telemetry from 210.7 MB to 17.4 MB (91.7% smaller;
// exact reconstruction, not an estimate). A single-session growth pattern that hit 1.2 GB under the
// old shape lands well under ~150 MB under this one. 512 MiB keeps a >3x margin above that while
// still bounding runaway growth across many sessions on a ~20-agent shared tree - a real reduction
// from the old 2 GiB ceiling, not just a smaller number for its own sake.
export const DEFAULT_REPORTS_MAX_BYTES = 512 * 1024 ** 2;

// ── Live-run claim - a directory a run just printed as ITS OWN must never be reaped ──────────────
//
// Confirmed first-hand 2026-08-14: a run finished, printed `.arkitect/reports/<stamp>--<uuid>` as
// its own report location, and the directory was gone before it could be read - plus a bare
// `ls -td .arkitect/reports/ | head -1` resolving to a directory that no longer existed one command
// later. Neither is the documented "reports rotate, resolve the newest stamp at use time" staleness
// (that is about a path going stale BETWEEN steps); this is a run's OWN just-announced directory
// being unreadable IMMEDIATELY. Mechanism: `stamp` is captured from `now` at the *start* of
// archiving, before `cpSync` copies the run's files - on a slow/large copy under ~20-agent
// contention, many OTHER concurrent runs can finish and archive with LATER stamps in that window.
// By the time this run's `renameSync` completes and its own `pruneArchives` pass runs, its
// captured-at-start stamp can already sort as one of the OLDEST names on disk even though the
// directory itself was created moments ago - so the count/byte ceiling (which sorts by NAME, i.e.
// by when archiving STARTED) evicts it, on this run's own trailing prune call or a concurrent
// peer's.
//
// The fix is a CLAIM, not a wider ceiling: a plain timestamped marker written INSIDE the archive
// the instant it is finalized (`renameSync` succeeds), checked by every eviction pass - this run's
// own and any concurrent peer's - before that peer ever deletes anything. A directory carrying a
// live claim is skipped exactly like a canonical (`protectedCanonical`) one, regardless of where it
// sorts by name or how full the byte budget is. Living inside the archive means eviction of an
// expired/unclaimed directory removes the marker with it - nothing to separately garbage-collect.
//
// ★ Liveness is decided by the claiming PROCESS, not by elapsed time - measured, not assumed.
// A naive "protect for N seconds" cannot work here: this package's OWN smoke test runs two real,
// fully-sequential CLI invocations under `reports.keep: 1` and asserts the FIRST archive is pruned
// once the second lands - and measured back-to-back, those two claims land only ~280ms apart. Any
// threshold long enough to matter for a genuine concurrent race (many peers finishing within the
// same second or two on a ~20-agent tree, or one run's `cpSync` still copying while a faster peer's
// prune runs) is long enough to also protect run #1 in that sequential test, silently softening a
// deliberately tight `reports.keep` config. The one question that actually distinguishes the two
// cases is "is the run that claimed this directory still running" - while it is, it might still be
// mid-copy or about to read the path it just printed, no timing guess required; once it has exited,
// there is nothing left in that process for the directory to be waiting on. `process.kill(pid, 0)`
// (a documented, no-op existence probe, verified on this platform: ESRCH once the child has exited,
// success on a live PID including the current process checking itself) makes that a fact rather
// than a guess.
//
// The grace window below is the crash-safety BACKSTOP for the one case liveness cannot decide: a
// missing/corrupt pid, or a permission/platform error other than "gone". Same staleness-grace shape
// as `acquireAttestationLock`'s stale-lock reclaim above, so an abandoned claim still ages out
// rather than being trusted forever, and it doubles as an absolute ceiling against the theoretical
// case of the OS recycling a dead run's pid onto an unrelated live process before this checks it -
// a claim past the ceiling is never live, alive-looking pid or not.
const ARCHIVE_CLAIM_FILE = ".claim.json";
export const ARCHIVE_CLAIM_GRACE_MS = 10 * 60 * 1000;

/** Best-effort - a failed claim only means normal retention math applies sooner than ideal for this
 *  one directory, never a crash of the run that just finished archiving. */
export function claimArchiveDirectory(archiveDir, { now = new Date() } = {}) {
  try {
    writeFileSync(join(archiveDir, ARCHIVE_CLAIM_FILE), `${JSON.stringify({ claimedAt: now.toISOString(), pid: process.pid })}\n`);
  } catch {
    /* best-effort, see doc comment above */
  }
}

/** true = confirmed running, false = confirmed gone, null = could not be determined (missing pid,
 *  or a platform/permission error other than "no such process") - the caller falls back to the
 *  staleness grace only for the null case. Exported so full-sweep-contention.mjs's machine-wide
 *  sweep lock can reuse the same liveness probe instead of a second copy - see that module's
 *  isHolderLive for why a live pid is authoritative there regardless of elapsed time. */
export function pidIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    process.kill(pid, 0); // signal 0: existence probe only, never delivered
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false; // no such process - confirmed gone
    if (error?.code === "EPERM") return true; // exists, just not signalable by this process/user
    return null; // some other platform quirk - treat as undeterminable, not as alive
  }
}

export function isArchiveClaimLive(reportsDir, name, { now = Date.now(), graceMs = ARCHIVE_CLAIM_GRACE_MS } = {}) {
  try {
    const claim = JSON.parse(readFileSync(join(reportsDir, name, ARCHIVE_CLAIM_FILE), "utf8"));
    const claimedAt = Date.parse(claim?.claimedAt);
    if (!Number.isFinite(claimedAt) || now - claimedAt >= graceMs) return false; // past the absolute ceiling regardless of pid
    return pidIsAlive(claim?.pid) !== false; // confirmed-dead -> not live; alive or undeterminable -> live
  } catch {
    return false; // no claim, or an unreadable/corrupt one - never treated as live
  }
}

// A standing, always-current record of whether retention is actually holding the budget - never
// only a console line. `pruneArchives` overwrites this on EVERY pass (this run's own and any
// concurrent peer's), so "over budget" can never be true on disk with nothing durable to show it,
// and the moment the folder is back under budget the next pass overwrites this with the clean
// state in the same motion - it cannot get stuck reporting stale doom either. A one-time stderr
// line is easy for a busy ~20-agent tree to lose; a file any future session can read with one
// `readFileSync` is not.
export const RETENTION_STATUS_FILE = "retention-status.json";

function pruneArchives(reportsDir, { keep = 20, keepCanonical = 3, maxBytes = null, now = Date.now() } = {}) {
  const runs = archiveDirectories(reportsDir);
  const facts = archiveFactsReader(reportsDir);
  const laneComplete = runs.filter((name) => facts.counts(name).completeFor > 0);
  const broad = broadRunNames(facts, runs);
  const tail = (list) => list.slice(Math.max(0, list.length - Math.max(0, keepCanonical)));
  const protectedCanonical = new Set([...tail(laneComplete), ...tail(broad)]);
  const isProtected = (name) => protectedCanonical.has(name) || isArchiveClaimLive(reportsDir, name, { now });
  const remaining = new Set(runs);
  const evicted = [];
  const evict = (name) => {
    const target = join(reportsDir, name);
    assertChild(reportsDir, target);
    rmSync(target, { recursive: true, force: true });
    remaining.delete(name);
    evicted.push(name);
  };
  for (const old of runs.slice(0, Math.max(0, runs.length - Math.max(0, keep)))) {
    if (isProtected(old)) continue;
    evict(old);
  }
  // A run that survives the count ceiling only because it is protected is the SAME "budget vs
  // reality disagree" shape the byte ceiling below reports - count it the same way instead of
  // saying nothing, which is exactly how a folder held together entirely by protected runs used
  // to look identical to one that was never over its count ceiling at all.
  const overCount = remaining.size > Math.max(0, keep);
  // ⛔ The byte ceiling is a SECOND, independent eviction pass - canonical/claim protection applies
  // here exactly as it does above. A protected run must never be evicted for budget alone: if the
  // budget cannot be met without eating one, stop at the last unprotected run and say so rather
  // than deleting the evidence the framework depends on (see canonical-protection doc comment above
  // `broadRunNames`).
  let bytes = null;
  if (Number.isFinite(maxBytes) && maxBytes > 0) {
    const ordered = [...remaining].sort(); // oldest-first - archive names are stamp-prefixed
    const sizes = new Map(ordered.map((name) => [name, facts.bytes(name)]));
    let total = [...sizes.values()].reduce((sum, bytes) => sum + bytes, 0);
    for (const name of ordered) {
      if (total <= maxBytes) break;
      if (isProtected(name)) continue;
      total -= sizes.get(name);
      evict(name);
    }
    const overBudget = total > maxBytes;
    bytes = {
      totalBytes: total,
      maxBytes,
      overBudget,
      protectedRemaining: overBudget ? [...remaining].filter((name) => isProtected(name)).sort() : [],
    };
    if (overBudget) {
      const mb = (b) => Math.round(b / (1024 * 1024));
      // ⛔ error, not warn - this is a budget the framework claims to enforce, silently failing to.
      console.error(
        `[arkitect] ${reportsDir} is ${mb(total)}MB, over its ${mb(maxBytes)}MB budget, but every remaining run is ` +
          "canonical or claimed by a live run (protected) - stopping eviction rather than deleting the evidence the framework depends on. " +
          `See ${RETENTION_STATUS_FILE} for the standing record.`,
      );
    }
  }
  const retention = {
    schemaVersion: 1,
    checkedAt: new Date(now).toISOString(),
    runCount: remaining.size,
    keep,
    keepCanonical,
    overCount,
    bytes,
  };
  try {
    // Best-effort: losing this status write loses only the standing record, never a real archive -
    // the console.error above already fired synchronously for the case that matters most.
    atomicWriteFile(join(reportsDir, RETENTION_STATUS_FILE), `${JSON.stringify(retention, null, 2)}\n`);
  } catch {
    /* best-effort, see above */
  }
  return { evicted, remaining: [...remaining], retention };
}

function pointerName(lane) {
  return `latest-${String(lane).replace(/[^a-zA-Z0-9._-]/g, "_")}.json`;
}

/**
 * Finalize one immutable archive. `runDir` must already contain this run's
 * complete artifacts; it is never the shared latest mirror.
 */
export function archiveRunArtifacts({
  root,
  runDir,
  run,
  extraFiles = {},
  keep = 20,
  keepCanonical = 3,
  maxBytes = DEFAULT_REPORTS_MAX_BYTES,
  now = new Date(),
} = {}) {
  // `root` here is the ARTIFACT root, which equals the scan root on every internal run and differs
  // only when the runner is scanning a tree it does not own. The `.arkitect` existence guard is what
  // keeps this honest for a non-workspace destination: an `--out` directory has no `.arkitect`, so
  // rather than manufacturing one inside somebody's upload the archive is simply skipped and the
  // caller reads its result from the mirror it asked for.
  if (!root || !existsSync(join(root, ".arkitect"))) return { archiveDir: null, written: [], failed: [], complete: true };
  const reportsDir = join(root, ".arkitect", "reports");
  mkdirSync(reportsDir, { recursive: true });
  const runId = run?.runId || randomUUID();
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const name = `${stamp}--${runId}`;
  const pending = strictArtifactChild(reportsDir, `.pending-${runId}`);
  const final = strictArtifactChild(reportsDir, name);
  rmSync(pending, { recursive: true, force: true });
  const written = [];
  const failed = [];
  try {
    cpSync(runDir, pending, { recursive: true });
    for (const [file, value] of Object.entries(extraFiles)) {
      try {
        atomicWriteFile(strictArtifactChild(pending, file), value);
        written.push(file);
      } catch (error) {
        failed.push({ name: file, error: String(error?.message || error) });
      }
    }
    if (failed.length) throw new Error(`failed to write ${failed.length} archive artifact(s)`);
    // ⛔ Claim into `pending`, BEFORE the rename, not into `final` after it. Claiming afterwards
    // leaves a window between `renameSync` and the claim in which the directory exists under its
    // final name carrying NO claim - this run's own `pruneArchives` below cannot land there, but a
    // CONCURRENT peer's pass can, which is the exact race this whole mechanism exists to close.
    // `pruneArchives` skips `.pending-*` by name (see its readdir filter), so the claim is safe
    // sitting there, and `renameSync` is atomic - so the directory becomes visible under its final
    // name and already claimed, in one step, with no window at all.
    claimArchiveDirectory(pending, { now });
    renameSync(pending, final);
    for (const lane of run?.completeFor ?? []) {
      // The pointer carries the run's own identity (catalog hash + counts) so a reader can verify
      // the archive it lands on is the run the pointer was minted for - an archive dir name is
      // reusable state on a shared tree, and "the pointer resolved" was never proof of anything.
      atomicWriteFile(
        join(reportsDir, pointerName(lane)),
        `${JSON.stringify(
          {
            schemaVersion: 2,
            lane,
            runId,
            archive: name,
            finalizedAt: new Date().toISOString(),
            catalog: run?.catalog ?? null,
            completeFor: run?.completeFor ?? [],
          },
          null,
          2,
        )}\n`,
      );
    }
    const { retention } = pruneArchives(reportsDir, { keep, keepCanonical, maxBytes, now: now.getTime() });
    return { archiveDir: final, written, failed, complete: true, retention };
  } catch (error) {
    failed.push({ name: "archive", error: String(error?.message || error) });
    rmSync(pending, { recursive: true, force: true });
    return { archiveDir: null, written, failed, complete: false };
  }
}

export function removeRunArtifactDirectory(outDir, runDir) {
  assertChild(join(outDir, "runs"), runDir);
  rmSync(runDir, { recursive: true, force: true });
}

/**
 * Remove completed UUID workspaces and abandoned intermediates without ever
 * touching a plausibly-live run. A run with no manifest may still be active, so
 * it receives a full-day grace period; legacy shard directories receive one
 * hour (normal suite runs finish in minutes).
 */
export function pruneArtifactWorkspaces(
  outDir,
  { now = Date.now(), incompleteMaxAgeMs = 24 * 60 * 60 * 1000, legacyShardMaxAgeMs = 60 * 60 * 1000 } = {},
) {
  const removed = [];
  const pruneChildren = (parent, shouldRemove) => {
    if (!existsSync(parent)) return;
    for (const entry of scanReaddirSync(parent, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const target = join(parent, entry.name);
      assertChild(parent, target);
      let ageMs;
      try {
        ageMs = Math.max(0, now - statSync(target).mtimeMs);
      } catch {
        continue;
      }
      if (!shouldRemove(target, ageMs)) continue;
      rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  };
  const finalized = (target) => {
    try {
      const path = join(target, "manifest.json");
      const manifest = parseArtifactJson(readFileSync(path, "utf8"), "manifest", path);
      return manifest?.artifacts?.mirror?.complete === true && manifest?.artifacts?.archive?.complete === true;
    } catch {
      return false;
    }
  };
  pruneChildren(join(outDir, "runs"), (target, ageMs) => finalized(target) || ageMs > incompleteMaxAgeMs);
  pruneChildren(join(outDir, "shard-runs"), (_target, ageMs) => ageMs > legacyShardMaxAgeMs);
  return removed;
}

/**
 * Resolve a lane pointer to its archive - VERIFYING, not trusting. The pointer is last-writer-wins
 * shared state and the archive it names rotates, so before any consumer treats the pointed-at run
 * as canonical this re-derives identity from the archive's own manifest: the runId must match, the
 * catalog hash/counts must match what the pointer was minted with (schemaVersion 2+), and the
 * archived run must itself claim completeness for the requested lane. Any mismatch returns null -
 * "no trustworthy pointer" - with a loud warn naming the mismatch, never a silently-wrong archive.
 */
export function readTypedArchivePointer(root, lane) {
  const reportsDir = join(root, ".arkitect", "reports");
  const path = join(reportsDir, pointerName(lane));
  try {
    const pointer = JSON.parse(readFileSync(path, "utf8"));
    const archiveDir = join(reportsDir, pointer.archive);
    assertChild(reportsDir, archiveDir);
    const manifestPath = join(archiveDir, "manifest.json");
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const mismatch =
      manifest?.run?.runId !== pointer.runId
        ? `archived runId ${manifest?.run?.runId ?? "<none>"} != pointer runId ${pointer.runId}`
        : !(manifest?.run?.completeFor ?? []).includes(lane)
          ? `archived run does not claim lane "${lane}" complete`
          : // ★ 2026-08-14: this pointer's own "verify, don't trust" contract omitted workspace
            // stability - runId/lane/catalog could all agree while the archived run itself observed
            // its source state change mid-run (`workspaceStable !== true`), which every OTHER reuse
            // path in this file already treats as disqualifying (see `reusableRunMismatch` above:
            // `actual.workspaceStable !== true` is checked before tool/catalog/config at all).
            manifest?.run?.workspaceStable !== true
            ? `archived run's workspace was not stable (workspaceStable: ${String(manifest?.run?.workspaceStable)})`
            : pointer.catalog &&
                (manifest?.run?.catalog?.catalogHash !== pointer.catalog.catalogHash ||
                  manifest?.run?.catalog?.selectedCount !== pointer.catalog.selectedCount)
              ? "archived catalog hash/count differ from the pointer's minted identity"
              : null;
    if (mismatch) {
      console.warn(`[arkitect] ${pointerName(lane)} rejected: ${mismatch} - treat as no canonical ${lane} run.`);
      return null;
    }
    return { ...pointer, archiveDir };
  } catch {
    return null;
  }
}
