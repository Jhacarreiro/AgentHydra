// vendored from Connections packages/connections-arkitect/src/core/artifact-contracts.mjs @ dd3d47a7ad
// Versioned, dependency-free contracts for the artifacts that make an Architect
// run replayable.  These deliberately validate the durable boundary, not every
// implementation detail of a check result: checks evolve independently, while
// a reader must always be able to tell whether an artifact is safe to trust.

import { EVIDENCE_KINDS, EVIDENCE_RISKS, normalizeEvidenceContract } from "./evidence.mjs";
import { validatePersistedScan } from "./scan-contract.mjs";

export const ARTIFACT_SCHEMAS = Object.freeze({
  manifest: Object.freeze({ artifactType: "arkitect-manifest", currentVersion: 3, compatibleVersions: [2, 3] }),
  decisionBrief: Object.freeze({ artifactType: "arkitect-decision-brief", currentVersion: 3, compatibleVersions: [2, 3] }),
  runState: Object.freeze({ artifactType: "arkitect-run-state", currentVersion: 3, compatibleVersions: [1, 2, 3] }),
  evidenceEnvelope: Object.freeze({ artifactType: "arkitect-evidence-envelope", currentVersion: 1, compatibleVersions: [1] }),
});

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (artifact, message) => {
  throw new TypeError(`${artifact} artifact is invalid: ${message}`);
};
const HOSTED_STATES = new Set(["verified", "unavailable", "stale", "intentionally-unrun"]);
// These are the only durable result states a reader may have to interpret. Keep
// this list deliberately separate from hosted-evidence states: the latter say
// whether a probe ran, while this says what the check found.
const RESULT_STATUSES = new Set(["clean", "observed", "warned", "advisory", "failed", "crashed", "no-data", "skipped", "not-applicable"]);
const RESULT_TOTAL_FIELDS = ["totalErrors", "gatingErrors", "advisoryFindings", "warnings", "infos", "crashed", "noData"];
const nonNegativeSafeInteger = (value) => Number.isSafeInteger(value) && value >= 0;
const nonEmptyString = (value) => typeof value === "string" && value.length > 0;

function assertArtifactType(value, artifact, expected, { required = false } = {}) {
  if (!Object.hasOwn(value, "artifactType")) {
    if (required) fail(artifact, `artifactType must be ${expected}`);
    return;
  }
  if (value.artifactType !== expected) fail(artifact, `artifactType must be ${expected}, got ${String(value.artifactType)}`);
}

function normalizeHostedEvidence(value, checkId, { artifact = "manifest", path = `check ${checkId}.hostedEvidence` } = {}) {
  if (value == null) return null;
  if (!record(value)) fail(artifact, `${path} must be an object`);
  if (value.schemaVersion !== 1) fail(artifact, `${path}.schemaVersion must be 1`);
  if (typeof value.identity !== "string" || !value.identity) fail(artifact, `${path}.identity must be a non-empty string`);
  if (!HOSTED_STATES.has(value.status)) fail(artifact, `${path}.status is unsupported`);
  if (typeof value.complete !== "boolean") fail(artifact, `${path}.complete must be a boolean`);
  if (value.runnerStatus !== null && value.runnerStatus !== "no-data") fail(artifact, `${path}.runnerStatus must be null or no-data`);
  if (!record(value.components) || Object.keys(value.components).length === 0)
    fail(artifact, `${path}.components must be a non-empty object`);
  for (const [component, detail] of Object.entries(value.components)) {
    if (!record(detail) || !HOSTED_STATES.has(detail.state)) fail(artifact, `${path}.components.${component}.state is unsupported`);
    if (typeof detail.reason !== "string" || !detail.reason)
      fail(artifact, `${path}.components.${component}.reason must be a non-empty string`);
  }
  if (value.complete !== (value.status === "verified" && value.runnerStatus === null)) fail(artifact, `${path} completion fields disagree`);
  return value;
}

export function validateEvidenceEnvelope(value) {
  if (!record(value)) fail("evidence envelope", "must be an object");
  assertArtifactType(value, "evidence envelope", ARTIFACT_SCHEMAS.evidenceEnvelope.artifactType);
  if (!ARTIFACT_SCHEMAS.evidenceEnvelope.compatibleVersions.includes(value.schemaVersion))
    fail("evidence envelope", `unsupported schemaVersion ${String(value.schemaVersion)}`);
  if (typeof value.declared !== "boolean" || typeof value.valid !== "boolean")
    fail("evidence envelope", "declared and valid must be booleans");
  // Enforced against the same enums evidence.mjs's normalizeEvidenceContract already coerces
  // to on the raw-input path - an envelope that already carries declared/valid/issues (a
  // replayed run state, a persisted manifest row read back from disk) skips that coercion in
  // normalizeEvidenceEnvelope below, so this is the only gate a hostile `kind`/`risk` value
  // must still pass before it can reach a rendered report. Reject here, at the contract
  // boundary, rather than let an unrecognized value flow through to a template sink.
  if (!EVIDENCE_KINDS.includes(value.kind)) fail("evidence envelope", `kind must be one of: ${EVIDENCE_KINDS.join(", ")}`);
  if (!EVIDENCE_RISKS.includes(value.risk)) fail("evidence envelope", `risk must be one of: ${EVIDENCE_RISKS.join(", ")}`);
  if (!Array.isArray(value.prerequisites) || !Array.isArray(value.issues))
    fail("evidence envelope", "prerequisites and issues must be arrays");
  return value;
}

export function normalizeEvidenceEnvelope(value) {
  // Evidence contracts were already at v1 when replayability shipped.  Always
  // normalize raw declarations, but preserve an already-normalized envelope
  // byte-for-byte. Re-normalizing it would treat its bookkeeping fields as
  // unsupported check-author fields and corrupt valid historical state.
  if (record(value) && "declared" in value && "valid" in value && "issues" in value) return validateEvidenceEnvelope(value);
  return validateEvidenceEnvelope(normalizeEvidenceContract(value));
}

function normalizeCheck(row, { artifact = "manifest", strict = false, path = "check" } = {}) {
  if (!record(row)) fail(artifact, `${path} must be an object`);
  if (!nonEmptyString(row.id)) fail(artifact, `${path}.id must be a non-empty string`);
  if (strict) {
    for (const key of ["title", "status", "gating", "blocking", "errors", "warnings", "infos", "evidence"]) {
      if (!Object.hasOwn(row, key)) fail(artifact, `${path}.${key} is required`);
    }
    if (!nonEmptyString(row.title)) fail(artifact, `${path}.title must be a non-empty string`);
    if (typeof row.gating !== "boolean") fail(artifact, `${path}.gating must be a boolean`);
    if (typeof row.blocking !== "boolean") fail(artifact, `${path}.blocking must be a boolean`);
    if (!record(row.evidence)) fail(artifact, `${path}.evidence must be an object`);
  }
  if (!nonEmptyString(row.status)) fail(artifact, `${path}.status must be a non-empty string`);
  const numeric = ["errors", "warnings", "infos"];
  for (const key of numeric) {
    const metric = strict ? row[key] : (row[key] ?? 0);
    if (!nonNegativeSafeInteger(metric)) fail(artifact, `${path}.${key} must be a non-negative safe integer`);
  }
  const hostedEvidence = normalizeHostedEvidence(row.hostedEvidence, row.id, { artifact, path: `${path}.hostedEvidence` });
  const scan = validatePersistedScan(row.scan, { artifact, path: `${path}.scan` });
  const normalized = {
    ...row,
    title: typeof row.title === "string" && row.title ? row.title : row.id,
    gating: row.gating !== false,
    blocking: row.blocking === true,
    errors: row.errors ?? 0,
    warnings: row.warnings ?? 0,
    infos: row.infos ?? 0,
    evidence: normalizeEvidenceEnvelope(row.evidence),
  };
  if (!RESULT_STATUSES.has(normalized.status)) fail(artifact, `${path}.status must be one of ${[...RESULT_STATUSES].join(", ")}`);
  const { errors, warnings, infos } = normalized;
  if (["clean", "no-data", "skipped", "not-applicable"].includes(normalized.status) && (errors !== 0 || warnings !== 0 || infos !== 0))
    fail(artifact, `${path}.status ${normalized.status} requires errors, warnings, and infos to all be zero`);
  if (
    ["clean", "observed", "warned", "advisory", "no-data", "skipped", "not-applicable"].includes(normalized.status) &&
    normalized.blocking !== false
  )
    fail(artifact, `${path}.status ${normalized.status} requires blocking:false`);
  if (normalized.status === "observed" && (errors !== 0 || warnings !== 0 || infos < 1))
    fail(artifact, `${path}.status observed requires zero errors/warnings and at least one info`);
  if (normalized.status === "warned" && (errors !== 0 || warnings < 1))
    fail(artifact, `${path}.status warned requires zero errors and at least one warning`);
  if (normalized.status === "advisory" && errors < 1) fail(artifact, `${path}.status advisory requires at least one error`);
  if (normalized.status === "failed" && (errors < 1 || normalized.gating !== true || normalized.blocking !== true))
    fail(artifact, `${path}.status failed requires at least one error, gating:true, and blocking:true`);
  if (normalized.status === "crashed" && (errors < 1 || normalized.gating !== true || normalized.blocking !== true))
    fail(artifact, `${path}.status crashed requires at least one error, gating:true, and blocking:true`);
  if (hostedEvidence) {
    normalized.hostedEvidence = hostedEvidence;
    if (hostedEvidence.runnerStatus === "no-data" && !["no-data", "crashed"].includes(normalized.status))
      fail(artifact, `${path}.status must be no-data while hosted evidence is incomplete`);
  }
  if (scan) {
    // A completed source scan and a no-data primary artifact are compatible:
    // the scan may establish the source universe while a separate capture or
    // owner-custody record required for the judgment is absent.  Skipped still
    // means no audit ran, and crashed remains incompatible with valid proof.
    if (scan.evaluation.state === "complete" && ["skipped", "not-applicable", "crashed"].includes(normalized.status))
      fail(artifact, `${path}.status cannot be ${normalized.status} after a complete runner-observed scan`);
    if (scan.evaluation.state === "no-data" && normalized.status !== "no-data")
      fail(artifact, `${path}.status must be no-data when the runner-observed scan is no-data`);
    if (scan.evaluation.state === "invalid" && normalized.status !== "crashed")
      fail(artifact, `${path}.status must be crashed when the runner-observed scan is invalid`);
    if (["skipped", "not-applicable"].includes(normalized.status))
      fail(artifact, `${path}.scan must be absent when status is ${normalized.status}`);
  }
  if (scan) normalized.scan = scan;
  return normalized;
}

function normalizeGate(value, artifact, path, fallbackErrors = 0, { strict = false } = {}) {
  if (!record(value)) fail(artifact, `${path} must be an object`);
  if (strict) {
    for (const key of ["clean", "gatingErrors"]) if (!Object.hasOwn(value, key)) fail(artifact, `${path}.${key} is required`);
  }
  const gatingErrors = value.gatingErrors ?? fallbackErrors;
  if (!nonNegativeSafeInteger(gatingErrors)) fail(artifact, `${path}.gatingErrors must be a non-negative safe integer`);
  if (strict && typeof value.clean !== "boolean") fail(artifact, `${path}.clean must be a boolean`);
  const expectedClean = gatingErrors === 0;
  if (strict && value.clean !== expectedClean) fail(artifact, `${path}.clean must equal whether ${path}.gatingErrors is zero`);
  const clean = strict ? value.clean : expectedClean;
  return { ...value, clean, gatingErrors };
}

function normalizeCoverage(value, artifact, path, fallbackNoData = 0, { strict = false, fallbackSkipped = 0 } = {}) {
  if (!record(value)) fail(artifact, `${path} must be an object`);
  if (strict) {
    for (const key of ["complete", "noData"]) if (!Object.hasOwn(value, key)) fail(artifact, `${path}.${key} is required`);
  }
  const noData = value.noData ?? fallbackNoData;
  const skipped = value.skipped ?? fallbackSkipped;
  if (!nonNegativeSafeInteger(noData)) fail(artifact, `${path}.noData must be a non-negative safe integer`);
  if (!nonNegativeSafeInteger(skipped)) fail(artifact, `${path}.skipped must be a non-negative safe integer`);
  if (strict && typeof value.complete !== "boolean") fail(artifact, `${path}.complete must be a boolean`);
  const expectedComplete = noData === 0 && skipped === 0;
  if (strict && value.complete !== expectedComplete)
    fail(artifact, `${path}.complete must equal whether ${path}.noData and ${path}.skipped are zero`);
  const complete = strict ? value.complete : expectedComplete;
  return { ...value, complete, noData, skipped };
}

function normalizeAttention(value, artifact, path, fallbacks = {}, { strict = false } = {}) {
  if (!record(value)) fail(artifact, `${path} must be an object`);
  if (strict) {
    for (const key of ["findings", "advisories", "warnings", "infos"])
      if (!Object.hasOwn(value, key)) fail(artifact, `${path}.${key} is required`);
  }
  const normalized = {
    ...value,
    findings: value.findings ?? fallbacks.findings ?? 0,
    advisories: value.advisories ?? fallbacks.advisories ?? 0,
    warnings: value.warnings ?? fallbacks.warnings ?? 0,
    infos: value.infos ?? fallbacks.infos ?? 0,
  };
  for (const key of ["findings", "advisories", "warnings", "infos"])
    if (!nonNegativeSafeInteger(normalized[key])) fail(artifact, `${path}.${key} must be a non-negative safe integer`);
  return normalized;
}

function addCount(total, increment, artifact, path) {
  const next = total + increment;
  if (!nonNegativeSafeInteger(next)) fail(artifact, `${path} exceeds the safe-integer range`);
  return next;
}

function requiredArtifactFailureCount(value, run, { strict = false } = {}) {
  if (value == null) {
    if (strict && run.artifactsComplete === false) fail("manifest", "artifacts.failed is required when run.artifactsComplete is false");
    return 0;
  }
  if (!record(value)) fail("manifest", "artifacts must be an object");
  if (!Array.isArray(value.failed)) fail("manifest", "artifacts.failed must be an array");
  let required = 0;
  for (let index = 0; index < value.failed.length; index++) {
    const failure = value.failed[index];
    if (!record(failure) || typeof failure.required !== "boolean")
      fail("manifest", `artifacts.failed[${index}].required must be a boolean`);
    if (failure.required) required = addCount(required, 1, "manifest", "artifacts.failed required count");
  }
  if (run.artifactsComplete && required > 0) fail("manifest", "run.artifactsComplete true cannot include required artifact failures");
  if (!run.artifactsComplete && required === 0)
    fail("manifest", "run.artifactsComplete false requires at least one required artifact failure");
  return required;
}

function deriveCheckTotals(checks, { artifact = "manifest", artifactFailures = 0 } = {}) {
  const totals = { totalErrors: 0, gatingErrors: 0, advisoryFindings: 0, warnings: 0, infos: 0, crashed: 0, noData: 0, skipped: 0 };
  for (const check of checks) {
    if (check.status === "no-data") {
      totals.noData = addCount(totals.noData, 1, artifact, "derived noData");
      continue;
    }
    if (check.status === "skipped") {
      totals.skipped = addCount(totals.skipped, 1, artifact, "derived skipped");
      continue;
    }
    totals.totalErrors = addCount(totals.totalErrors, check.errors, artifact, "derived totalErrors");
    totals.warnings = addCount(totals.warnings, check.warnings, artifact, "derived warnings");
    totals.infos = addCount(totals.infos, check.infos, artifact, "derived infos");
    if (check.status === "crashed") totals.crashed = addCount(totals.crashed, 1, artifact, "derived crashed");
    if (check.blocking) totals.gatingErrors = addCount(totals.gatingErrors, check.errors, artifact, "derived gatingErrors");
    else totals.advisoryFindings = addCount(totals.advisoryFindings, check.errors, artifact, "derived advisoryFindings");
  }
  if (artifactFailures > 0) {
    totals.totalErrors = addCount(totals.totalErrors, artifactFailures, artifact, "derived totalErrors");
    totals.gatingErrors = addCount(totals.gatingErrors, artifactFailures, artifact, "derived gatingErrors");
  }
  return totals;
}

/**
 * The gate verdict derived from a manifest's own CHECK ROWS, never from its summary fields.
 *
 * ⛔ 2026-09-05: `bin/arkitect.mjs` decided a whole run's exit code from ONE mutable number -
 * `manifest.gatingErrors` - and nothing anywhere cross-checked that number against the rows it is
 * supposed to summarize. That is the shape a gate must never have: the single most damaging thing
 * this engine can emit is exit 0 over a red catalog, and with one witness there is nothing for a
 * wrong value to disagree with, so the failure is SILENT by construction. A filing that month
 * claimed exactly that had happened on a 1134-check sweep carrying 387 gating errors and 4 crashes.
 * The claim was investigated and did NOT reproduce (the shard round-trip preserves `blocking`, and
 * a sharded fixture with a failing or crashing gating check exits 1 under both bun and node - see
 * the SHARDED cases in `test/gate-flag-value-validation.mjs`, which is where they live because that
 * file is already in `scripts/test/bun-node-specs.txt` and a spec in no lane is not evidence); the
 * filing itself was retracted the same session it was written, and the retraction records the
 * mechanism: a backgrounded `audit:strict` reports the WRAPPER's exit code while the audit runs on,
 * and the 387/1134 manifest came from a different run (`.claude/rules/arkitect-burndown-execution-lessons.md`,
 * "a backgrounded long run detaches"). The reason it took a full investigation to answer is the
 * defect. Nothing in the artifacts could have said whether the exit code and the archived manifest
 * ever disagreed, because only one of them was ever computed.
 *
 * So the exit code now reads TWO independent witnesses over the same run and takes the RED of them.
 * This can only ever widen what is red: every condition below is a state the manifest contract
 * already defines as a gating failure (`normalizeCheck` requires `blocking:true` on both `failed`
 * and `crashed`, and forbids it on every other status), so a row that trips one of these was
 * already counted by `summarize()`. What it adds is that a summary field which has somehow LOST
 * that count can no longer green the run on its own, and the disagreement is printed instead of
 * being invisible.
 *
 * ⛔ An UNREADABLE manifest is RED, never clean. `-` means not measured, and a gate that cannot
 * read its own result has not measured anything - the one verdict it must not reach is "fine".
 *
 * @param {unknown} manifest a run manifest (summarize()'s output, or an archived one read back)
 * @returns {{ red: boolean, gatingErrors: number|null, reasons: string[] }}
 */
export function deriveGateVerdict(manifest) {
  const reasons = [];
  if (!record(manifest)) return { red: true, gatingErrors: null, reasons: ["manifest is not an object"] };
  if (!Array.isArray(manifest.checks)) return { red: true, gatingErrors: null, reasons: ["manifest.checks is not an array"] };
  let gatingErrors = 0;
  let blockingRows = 0;
  let crashedRows = 0;
  for (const row of manifest.checks) {
    if (!record(row)) return { red: true, gatingErrors: null, reasons: ["manifest.checks contains a non-object row"] };
    const crashed = row.status === "crashed";
    if (crashed) crashedRows += 1;
    if (row.blocking !== true && !crashed) continue;
    blockingRows += 1;
    // A blocking row with an unusable error count still gates. The contract requires errors >= 1
    // here, so a zero/absent/garbage value is corruption, and corruption must not subtract from the
    // gate - floor it at the one error the row's own status already asserts.
    gatingErrors += Number.isSafeInteger(row.errors) && row.errors > 0 ? row.errors : 1;
  }
  if (blockingRows > 0) reasons.push(`${blockingRows} blocking check row(s) totalling ${gatingErrors} gating error(s)`);
  if (crashedRows > 0) reasons.push(`${crashedRows} crashed check row(s)`);
  // A required artifact failure is a gating failure the check rows cannot express: the run computed
  // a verdict it then failed to persist, so the artifact a reader would consult does not exist.
  if (record(manifest.run) && manifest.run.artifactsComplete === false) reasons.push("run.artifactsComplete is false");
  // The manifest's own second opinion, written beside the totals by the same pass. Reading it here
  // costs nothing and catches a totals field that moved while `pass` did not.
  if (record(manifest.pass) && record(manifest.pass.gate) && manifest.pass.gate.clean === false) reasons.push("pass.gate.clean is false");
  return { red: reasons.length > 0, gatingErrors, reasons };
}

function attentionFromTotals(totals, { artifact = "artifact", path = "derived attention" } = {}) {
  return {
    findings: addCount(addCount(totals.advisoryFindings, totals.warnings, artifact, path), totals.infos, artifact, path),
    advisories: totals.advisoryFindings,
    warnings: totals.warnings,
    infos: totals.infos,
  };
}

function assertTotalsEqual(actual, expected, artifact, path, fields) {
  for (const field of fields) {
    if (actual[field] !== expected[field]) fail(artifact, `${path}.${field} must equal the total derived from check rows`);
  }
}

function reconcileManifestTotals(value, totals, { strict = false } = {}) {
  if (strict) {
    for (const field of RESULT_TOTAL_FIELDS) {
      if (!Object.hasOwn(value, field)) fail("manifest", `${field} is required`);
      if (!nonNegativeSafeInteger(value[field])) fail("manifest", `${field} must be a non-negative safe integer`);
    }
    assertTotalsEqual(value, totals, "manifest", "manifest", RESULT_TOTAL_FIELDS);
    // `skipped` was added to the v3 coverage model after reports already existed in the
    // wild. Validate it when a new writer emits it, while accepting older v3 archives that
    // did not carry the separate tally.
    if (Object.hasOwn(value, "skipped")) {
      if (!nonNegativeSafeInteger(value.skipped)) fail("manifest", "skipped must be a non-negative safe integer");
      if (value.skipped !== totals.skipped) fail("manifest", "skipped must equal the total derived from check rows");
    }
  }
  return totals;
}

function nextActionFor({ gate, coverage, attention, artifactsIncomplete = false }) {
  if (artifactsIncomplete) return "repair-artifacts";
  if (gate.gatingErrors > 0) return "fix-errors";
  if (coverage.noData > 0 || coverage.skipped > 0) return "supply-input";
  if (attention.advisories > 0) return "review-advisories";
  if (attention.warnings > 0) return "review-warnings";
  if (attention.infos > 0) return "review-observations";
  return "done";
}

function normalizePass(value, artifact, { strict = false, totals = {} } = {}) {
  if (!record(value)) fail(artifact, "pass must be an object");
  if (strict) {
    for (const key of ["clean", "complete", "nextAction", "gate", "coverage", "attention"])
      if (!Object.hasOwn(value, key)) fail(artifact, `pass.${key} is required`);
  }
  if (!nonEmptyString(value.nextAction)) fail(artifact, "pass.nextAction must be a non-empty string");
  const derivedGate = { clean: (totals.gatingErrors ?? 0) === 0, gatingErrors: totals.gatingErrors ?? 0 };
  const derivedCoverage = {
    complete: (totals.noData ?? 0) === 0 && (totals.skipped ?? 0) === 0,
    noData: totals.noData ?? 0,
    skipped: totals.skipped ?? 0,
  };
  const derivedAttention = attentionFromTotals(totals, { artifact, path: "pass.attention" });
  const gate = normalizeGate(strict ? (value.gate ?? {}) : derivedGate, artifact, "pass.gate", derivedGate.gatingErrors, { strict });
  const coverage = normalizeCoverage(strict ? (value.coverage ?? {}) : derivedCoverage, artifact, "pass.coverage", derivedCoverage.noData, {
    strict,
    fallbackSkipped: derivedCoverage.skipped,
  });
  const attention = normalizeAttention(strict ? (value.attention ?? {}) : derivedAttention, artifact, "pass.attention", derivedAttention, {
    strict,
  });
  const expectedClean = gate.clean;
  const expectedComplete = gate.clean && coverage.complete;
  const artifactsIncomplete = totals.run?.artifactsComplete === false;
  const expectedNextAction = nextActionFor({ gate, coverage, attention, artifactsIncomplete });
  if (strict && typeof value.clean !== "boolean") fail(artifact, "pass.clean must be a boolean");
  if (strict && typeof value.complete !== "boolean") fail(artifact, "pass.complete must be a boolean");
  if (strict) {
    assertTotalsEqual(gate, derivedGate, artifact, "pass.gate", ["gatingErrors"]);
    assertTotalsEqual(coverage, derivedCoverage, artifact, "pass.coverage", ["noData", "skipped"]);
    assertTotalsEqual(attention, derivedAttention, artifact, "pass.attention", ["findings", "advisories", "warnings", "infos"]);
  }
  if (strict && value.clean !== expectedClean) fail(artifact, "pass.clean must equal pass.gate.clean");
  if (strict && value.complete !== expectedComplete) fail(artifact, "pass.complete must equal pass.gate.clean && pass.coverage.complete");
  if (strict && artifactsIncomplete && gate.gatingErrors === 0)
    fail(artifact, "run.artifactsComplete false requires a gating artifact error");
  if (strict && value.nextAction !== expectedNextAction)
    fail(artifact, `pass.nextAction must be ${expectedNextAction} for the recorded run state`);
  return {
    ...value,
    clean: strict ? value.clean : expectedClean,
    complete: strict ? value.complete : expectedComplete,
    nextAction: strict ? value.nextAction : expectedNextAction,
    gate,
    coverage,
    attention,
  };
}

/**
 * Always strict, and the parameter that used to say otherwise is gone (2026-08-30,
 * `defeated-option-default`). It read `{ strict = false } = {}` beside two siblings that correctly
 * forward `migrateManifest`'s computed `strict`, which made it look like the same optional
 * validation - but its ONE caller hardcoded `{ strict: true }`, so the lenient branch never ran.
 * That hardcoding is right, not a bug: the caller passes `value.run` only when the manifest is
 * already at the current schema version, and otherwise passes `legacyRun()`, which is synthesized
 * here and carries every required key by construction. There is no input on either path that the
 * required-key sweep can reject, so there was never a second behaviour - only a second spelling.
 */
function normalizeRun(value, artifact) {
  if (!record(value)) fail(artifact, "run must be an object");
  const required = ["runId", "canonical", "completeFor", "workspaceStart", "workspaceEnd", "workspaceStable", "artifactsComplete"];
  for (const key of required) if (!Object.hasOwn(value, key)) fail(artifact, `run.${key} is required`);
  if (!nonEmptyString(value.runId)) fail(artifact, "run.runId must be a non-empty string");
  if (typeof value.canonical !== "boolean") fail(artifact, "run.canonical must be a boolean");
  if (!Array.isArray(value.completeFor) || value.completeFor.some((entry) => typeof entry !== "string"))
    fail(artifact, "run.completeFor must be an array of strings");
  if (!record(value.workspaceStart)) fail(artifact, "run.workspaceStart must be an object");
  if (!record(value.workspaceEnd)) fail(artifact, "run.workspaceEnd must be an object");
  if (value.workspaceStable !== null && typeof value.workspaceStable !== "boolean")
    fail(artifact, "run.workspaceStable must be a boolean or null");
  if (typeof value.artifactsComplete !== "boolean") fail(artifact, "run.artifactsComplete must be a boolean");
  return value;
}

function legacyRun() {
  return {
    runId: "legacy-v2-migration",
    canonical: false,
    completeFor: [],
    workspaceStart: {},
    workspaceEnd: {},
    workspaceStable: null,
    artifactsComplete: true,
    migratedFromSchemaVersion: 2,
  };
}

function normalizeFinding(finding, path) {
  if (!record(finding)) fail("decision brief", `${path} must be an object`);
  if (typeof finding.checkId !== "string" || !finding.checkId) fail("decision brief", `${path}.checkId must be a non-empty string`);
  if (typeof finding.id !== "string" || !finding.id) fail("decision brief", `${path}.id must be a non-empty string`);
  if (!["error", "warning", "info"].includes(finding.severity)) fail("decision brief", `${path}.severity must be error, warning, or info`);
  if (typeof finding.message !== "string" || !finding.message) fail("decision brief", `${path}.message must be a non-empty string`);
  return finding;
}

const DERIVED_FINDING_FIELDS = new Set([
  "baseFingerprint",
  "blocking",
  "checkStatus",
  "checkTitle",
  "evidence",
  "fingerprint",
  "identitySource",
  "lifecycle",
  "occurrence",
]);

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!record(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

function rawFindingKey(finding) {
  return JSON.stringify(stableValue(Object.fromEntries(Object.entries(finding).filter(([key]) => !DERIVED_FINDING_FIELDS.has(key)))));
}

function assertLosslessFindingParity(findings, details) {
  if (!details) return;
  const detailed = details.flatMap((detail) => detail.findings);
  if (detailed.length !== findings.length)
    fail("decision brief", `details findings must losslessly match findings (details=${detailed.length}, findings=${findings.length})`);
  const counts = new Map();
  for (const finding of findings) {
    const key = rawFindingKey(finding);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const finding of detailed) {
    const key = rawFindingKey(finding);
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) fail("decision brief", `details findings do not losslessly match findings at ${finding.checkId}:${finding.id}`);
    counts.set(key, remaining - 1);
  }
  if ([...counts.values()].some((count) => count !== 0)) fail("decision brief", "details findings do not losslessly match findings");
}

function assertFindingMultisetParity(expected, actual, label) {
  if (expected.length !== actual.length)
    fail("decision brief", `${label} must expand to every lifecycle finding (expected=${expected.length}, actual=${actual.length})`);
  const counts = new Map();
  for (const finding of expected) {
    const key = rawFindingKey(finding);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const finding of actual) {
    const key = rawFindingKey(finding);
    const remaining = counts.get(key) ?? 0;
    if (remaining === 0) fail("decision brief", `${label} contains a finding that is absent from lifecycle findings`);
    counts.set(key, remaining - 1);
  }
  if ([...counts.values()].some((count) => count !== 0)) fail("decision brief", `${label} omits a lifecycle finding`);
}

function normalizeLifecycle(value, currentFindings) {
  if (value == null) return null;
  if (!record(value)) fail("decision brief", "lifecycle must be an object");
  if (!record(value.summary)) fail("decision brief", "lifecycle.summary must be an object");
  for (const key of ["new", "unchanged", "resolved", "flapping"]) {
    if (!nonNegativeSafeInteger(value.summary[key])) fail("decision brief", `lifecycle.summary.${key} must be a non-negative safe integer`);
  }
  if (!Array.isArray(value.resolved)) fail("decision brief", "lifecycle.resolved must be an array");
  if (!Array.isArray(value.groups)) fail("decision brief", "lifecycle.groups must be an array");
  if (!Array.isArray(value.historyIssues)) fail("decision brief", "lifecycle.historyIssues must be an array");
  if (!nonNegativeSafeInteger(value.historyRuns)) fail("decision brief", "lifecycle.historyRuns must be a non-negative safe integer");
  const resolved = value.resolved.map((finding, index) => normalizeFinding(finding, `lifecycle.resolved[${index}]`));
  const lifecycleFindings = [...currentFindings, ...resolved];
  const lifecycleCounts = { new: 0, unchanged: 0, resolved: 0, flapping: 0 };
  for (let index = 0; index < lifecycleFindings.length; index++) {
    const status = lifecycleFindings[index].lifecycle;
    if (!Object.hasOwn(lifecycleCounts, status))
      fail("decision brief", `lifecycle finding ${index}.lifecycle must be new, unchanged, resolved, or flapping`);
    lifecycleCounts[status] += 1;
  }
  for (const key of Object.keys(lifecycleCounts)) {
    if (value.summary[key] !== lifecycleCounts[key]) fail("decision brief", `lifecycle.summary.${key} disagrees with lifecycle findings`);
  }
  const seenGroupKeys = new Set();
  const groups = value.groups.map((group, groupIndex) => {
    const path = `lifecycle.groups[${groupIndex}]`;
    if (!record(group)) fail("decision brief", `${path} must be an object`);
    for (const key of ["key", "checkId", "findingId", "severity"]) {
      if (typeof group[key] !== "string" || !group[key]) fail("decision brief", `${path}.${key} must be a non-empty string`);
    }
    if (group.key !== `${group.checkId}:${group.findingId}:${group.severity}`)
      fail("decision brief", `${path}.key must equal ${group.checkId}:${group.findingId}:${group.severity}`);
    if (seenGroupKeys.has(group.key)) fail("decision brief", `${path}.key duplicates ${group.key}`);
    seenGroupKeys.add(group.key);
    if (!["error", "warning", "info"].includes(group.severity)) fail("decision brief", `${path}.severity must be error, warning, or info`);
    if (!Array.isArray(group.findings)) fail("decision brief", `${path}.findings must be an array`);
    const groupFindings = group.findings.map((finding, findingIndex) => normalizeFinding(finding, `${path}.findings[${findingIndex}]`));
    if (groupFindings.length === 0) fail("decision brief", `${path}.findings must not be empty`);
    if (group.count !== groupFindings.length) fail("decision brief", `${path}.count must equal findings.length`);
    if (!record(group.lifecycle)) fail("decision brief", `${path}.lifecycle must be an object`);
    const groupCounts = { new: 0, unchanged: 0, resolved: 0, flapping: 0 };
    for (let findingIndex = 0; findingIndex < groupFindings.length; findingIndex++) {
      const finding = groupFindings[findingIndex];
      if (finding.checkId !== group.checkId || finding.id !== group.findingId || finding.severity !== group.severity)
        fail("decision brief", `${path}.findings[${findingIndex}] must match the group's check, finding id, and severity`);
      if (!Object.hasOwn(groupCounts, finding.lifecycle))
        fail("decision brief", `${path}.findings[${findingIndex}].lifecycle is unsupported`);
      groupCounts[finding.lifecycle] += 1;
    }
    for (const key of Object.keys(groupCounts)) {
      if (group.lifecycle[key] !== groupCounts[key]) fail("decision brief", `${path}.lifecycle.${key} disagrees with group findings`);
    }
    return { ...group, findings: groupFindings };
  });
  assertFindingMultisetParity(
    lifecycleFindings,
    groups.flatMap((group) => group.findings),
    "lifecycle.groups",
  );
  return { ...value, resolved, groups };
}

function synthesizeLegacyLifecycle(findings) {
  const migratedFindings = findings.map((finding) => ({ ...finding, lifecycle: "new" }));
  const grouped = new Map();
  for (const finding of migratedFindings) {
    const key = `${finding.checkId}:${finding.id}:${finding.severity}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(finding);
  }
  const groups = [...grouped.entries()].map(([key, rows]) => ({
    key,
    checkId: rows[0].checkId,
    findingId: rows[0].id,
    severity: rows[0].severity,
    count: rows.length,
    lifecycle: { new: rows.length, unchanged: 0, resolved: 0, flapping: 0 },
    findings: rows,
  }));
  return {
    findings: migratedFindings,
    lifecycle: {
      summary: { new: migratedFindings.length, unchanged: 0, resolved: 0, flapping: 0 },
      resolved: [],
      groups,
      historyRuns: 0,
      historyIssues: ["migrated from v2 without lifecycle history"],
    },
  };
}

function normalizeDecisionSummary(value, { strict = false, totals = null } = {}) {
  if (!record(value)) fail("decision brief", "summary must be an object");
  if (strict) {
    for (const key of ["nextAction", "gate", "coverage", "attention"])
      if (!Object.hasOwn(value, key)) fail("decision brief", `summary.${key} is required`);
  }
  if (!nonEmptyString(value.nextAction)) fail("decision brief", "summary.nextAction must be a non-empty string");
  const derivedGate = { clean: (totals?.gatingErrors ?? 0) === 0, gatingErrors: totals?.gatingErrors ?? 0 };
  const derivedCoverage = {
    complete: (totals?.noData ?? 0) === 0 && (totals?.skipped ?? 0) === 0,
    noData: totals?.noData ?? 0,
    skipped: totals?.skipped ?? 0,
  };
  const derivedAttention = totals ? attentionFromTotals(totals, { artifact: "decision brief", path: "summary.attention" }) : {};
  const gate = normalizeGate(strict ? (value.gate ?? {}) : derivedGate, "decision brief", "summary.gate", derivedGate.gatingErrors, {
    strict,
  });
  const coverage = normalizeCoverage(
    strict ? (value.coverage ?? {}) : derivedCoverage,
    "decision brief",
    "summary.coverage",
    derivedCoverage.noData,
    { strict, fallbackSkipped: derivedCoverage.skipped },
  );
  const attention = normalizeAttention(
    strict ? (value.attention ?? {}) : derivedAttention,
    "decision brief",
    "summary.attention",
    derivedAttention,
    { strict },
  );
  const expectedNextAction = nextActionFor({ gate, coverage, attention });
  const artifactRepair = value.nextAction === "repair-artifacts" && totals != null && gate.gatingErrors > totals.gatingErrors;
  if (strict && totals) {
    if (artifactRepair) {
      assertTotalsEqual(coverage, derivedCoverage, "decision brief", "summary.coverage", ["noData", "skipped"]);
      assertTotalsEqual(attention, derivedAttention, "decision brief", "summary.attention", [
        "findings",
        "advisories",
        "warnings",
        "infos",
      ]);
    } else {
      assertTotalsEqual(gate, derivedGate, "decision brief", "summary.gate", ["gatingErrors"]);
      assertTotalsEqual(coverage, derivedCoverage, "decision brief", "summary.coverage", ["noData", "skipped"]);
      assertTotalsEqual(attention, derivedAttention, "decision brief", "summary.attention", [
        "findings",
        "advisories",
        "warnings",
        "infos",
      ]);
    }
  }
  const validRepairAction = artifactRepair;
  if (strict && value.nextAction !== expectedNextAction && !validRepairAction)
    fail("decision brief", `summary.nextAction must be ${expectedNextAction} for the recorded summary`);
  return { ...value, nextAction: strict ? value.nextAction : expectedNextAction, gate, coverage, attention };
}

function normalizeDetails(value, { strict = false, checks } = {}) {
  if (value == null && !strict) return null;
  if (!Array.isArray(value)) fail("decision brief", "details must be an array");
  if (value.length !== checks.length) fail("decision brief", "details must contain exactly one row per check");
  const known = new Set(checks.map((check) => check.id));
  const seen = new Set();
  return value.map((detail, index) => {
    const path = `details[${index}]`;
    if (!record(detail)) fail("decision brief", `${path} must be an object`);
    if (typeof detail.id !== "string" || !detail.id) fail("decision brief", `${path}.id must be a non-empty string`);
    if (!known.has(detail.id)) fail("decision brief", `${path}.id names unknown check ${detail.id}`);
    if (seen.has(detail.id)) fail("decision brief", `${path}.id duplicates check ${detail.id}`);
    seen.add(detail.id);
    if (!Array.isArray(detail.findings)) fail("decision brief", `${path}.findings must be an array`);
    if (typeof detail.report !== "string") fail("decision brief", `${path}.report must be a string`);
    return {
      id: detail.id,
      findings: detail.findings.map((finding, findingIndex) => {
        const normalized = normalizeFinding(
          strict ? finding : { ...finding, checkId: finding.checkId ?? detail.id },
          `${path}.findings[${findingIndex}]`,
        );
        if (normalized.checkId !== detail.id) fail("decision brief", `${path}.findings[${findingIndex}].checkId must match ${detail.id}`);
        return normalized;
      }),
      report: detail.report,
    };
  });
}

function normalizePerformanceMeasurement(value) {
  if (value == null) return null;
  if (!record(value)) fail("manifest", "performance must be an object");
  if (value.schemaVersion !== 1) fail("manifest", "performance.schemaVersion must be 1");
  if (!record(value.compatibility)) fail("manifest", "performance.compatibility must be an object");
  for (const key of ["toolVersion", "catalogHash", "selectedIdsHash", "configHash"]) {
    if (typeof value.compatibility[key] !== "string" || !value.compatibility[key])
      fail("manifest", `performance.compatibility.${key} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(value.compatibility.workers) || value.compatibility.workers < 1)
    fail("manifest", "performance.compatibility.workers must be a positive safe integer");
  if (!["cold", "warm"].includes(value.compatibility.temperature))
    fail("manifest", "performance.compatibility.temperature must be cold or warm");
  if (!Array.isArray(value.checks)) fail("manifest", "performance.checks must be an array");
  const seen = new Set();
  for (let index = 0; index < value.checks.length; index++) {
    const check = value.checks[index];
    if (!record(check) || typeof check.id !== "string" || !check.id)
      fail("manifest", `performance.checks[${index}].id must be a non-empty string`);
    if (seen.has(check.id)) fail("manifest", `performance.checks[${index}].id duplicates ${check.id}`);
    seen.add(check.id);
    for (const [path, metric] of [
      [`performance.checks[${index}].durationMs`, check.durationMs],
      [`performance.checks[${index}].resources.sources.peakRetainedTextBytes`, check.resources?.sources?.peakRetainedTextBytes],
    ]) {
      if (metric !== null && (!Number.isFinite(metric) || metric < 0)) fail("manifest", `${path} must be null or a non-negative number`);
    }
  }
  return value;
}

export function migrateManifest(value) {
  if (!record(value)) fail("manifest", "must be an object");
  const version = value.schemaVersion ?? 2;
  if (!ARTIFACT_SCHEMAS.manifest.compatibleVersions.includes(version)) fail("manifest", `unsupported schemaVersion ${String(version)}`);
  const strict = version === ARTIFACT_SCHEMAS.manifest.currentVersion;
  assertArtifactType(value, "manifest", ARTIFACT_SCHEMAS.manifest.artifactType, { required: strict });
  if (strict) {
    for (const key of ["checks", "pass", "run"]) if (!Object.hasOwn(value, key)) fail("manifest", `${key} is required`);
  }
  if (!Array.isArray(value.checks) || !record(value.pass)) fail("manifest", "checks must be an array and pass must be an object");
  const performance = normalizePerformanceMeasurement(value.performance);
  const run = normalizeRun(strict ? value.run : legacyRun(), "manifest");
  const checks = value.checks.map((row, index) => normalizeCheck(row, { artifact: "manifest", strict, path: `checks[${index}]` }));
  // normalizeCheck validates each row in isolation; nothing above it catches two rows sharing an
  // id (a corrupted/hand-edited manifest, or a discovery bug producing the same check twice) -
  // both normalizeDetails (decision brief) and normalizePerformanceMeasurement already guard this
  // exact shape with their own `seen` set, but migrateManifest's own `checks` array had no
  // equivalent, so a duplicate silently passed through, doubling that check's contribution to the
  // derived totals below.
  const seenCheckIds = new Set();
  for (let index = 0; index < checks.length; index++) {
    if (seenCheckIds.has(checks[index].id)) fail("manifest", `checks[${index}].id duplicates ${checks[index].id}`);
    seenCheckIds.add(checks[index].id);
  }
  const artifactFailures = requiredArtifactFailureCount(value.artifacts, run, { strict });
  const totals = reconcileManifestTotals(value, deriveCheckTotals(checks, { artifactFailures }), { strict });
  const pass = normalizePass(value.pass, "manifest", { strict, totals: { ...totals, run } });
  return {
    ...value,
    artifactType: ARTIFACT_SCHEMAS.manifest.artifactType,
    schemaVersion: ARTIFACT_SCHEMAS.manifest.currentVersion,
    ...totals,
    checks,
    pass,
    run,
    ...(performance ? { performance } : {}),
  };
}

export function validateManifest(value) {
  return migrateManifest(value);
}

/**
 * A brief whose finding payload lives in a sidecar rather than inline.
 *
 * ⭐ DETECTED BY SHAPE, NEVER BY VERSION - the same rule `validatePersistedScan` already follows
 * for externalized scan observations, and for the same reason: the ordinary inline path below then
 * runs in the exact order it always has, so nothing about an existing artifact changes.
 *
 * ⛔ `findings` IS ABSENT, NOT EMPTY, AND THAT IS THE WHOLE DESIGN. An empty array would let a
 * reader that has not learned about the sidecar walk `brief.findings`, get `[]`, and conclude the run
 * was CLEAN - which is the single most expensive way this could go wrong, and a mistake already made
 * once in this repo's own notes about this artifact. Absent means such a reader gets `undefined` and
 * fails where it stands, which is the outcome we want from a stale reader.
 */
function isExternalizedBrief(value) {
  return record(value) && record(value.findingsRef) && !Object.hasOwn(value, "findings");
}

function migrateExternalizedBrief(value, { strict }) {
  for (const key of ["summary", "checks", "lifecycle"]) if (!Object.hasOwn(value, key)) fail("decision brief", `${key} is required`);
  if (!record(value.summary) || !Array.isArray(value.checks))
    fail("decision brief", "summary must be an object and checks must be an array");
  const ref = value.findingsRef;
  if (typeof ref.artifact !== "string" || !ref.artifact) fail("decision brief", "findingsRef.artifact must name the sidecar");
  if (!Number.isInteger(ref.findingCount) || ref.findingCount < 0) fail("decision brief", "findingsRef.findingCount must be a count");
  const checks = value.checks.map((row, index) => normalizeCheck(row, { artifact: "decision brief", strict, path: `checks[${index}]` }));
  return {
    ...value,
    artifactType: ARTIFACT_SCHEMAS.decisionBrief.artifactType,
    schemaVersion: ARTIFACT_SCHEMAS.decisionBrief.currentVersion,
    summary: normalizeDecisionSummary(value.summary, { strict, totals: deriveCheckTotals(checks, { artifact: "decision brief" }) }),
    checks,
  };
}

export function migrateDecisionBrief(value) {
  if (!record(value)) fail("decision brief", "must be an object");
  const version = value.schemaVersion ?? 2;
  if (!ARTIFACT_SCHEMAS.decisionBrief.compatibleVersions.includes(version))
    fail("decision brief", `unsupported schemaVersion ${String(version)}`);
  const strict = version === ARTIFACT_SCHEMAS.decisionBrief.currentVersion;
  assertArtifactType(value, "decision brief", ARTIFACT_SCHEMAS.decisionBrief.artifactType, { required: strict });
  // The externalized shape short-circuits BEFORE the inline requirements below, which demand a
  // `findings` array this shape deliberately does not have.
  if (isExternalizedBrief(value)) return migrateExternalizedBrief(value, { strict });
  if (strict) {
    for (const key of ["summary", "checks", "findings", "details", "lifecycle"])
      if (!Object.hasOwn(value, key)) fail("decision brief", `${key} is required`);
  }
  if (!record(value.summary) || !Array.isArray(value.checks) || !Array.isArray(value.findings))
    fail("decision brief", "summary must be an object; checks and findings must be arrays");
  const checks = value.checks.map((row, index) => normalizeCheck(row, { artifact: "decision brief", strict, path: `checks[${index}]` }));
  const summary = normalizeDecisionSummary(value.summary, { strict, totals: deriveCheckTotals(checks, { artifact: "decision brief" }) });
  let findings = value.findings.map((finding, index) => normalizeFinding(finding, `findings[${index}]`));
  let lifecycleValue = value.lifecycle;
  if (!strict) {
    const legacy = synthesizeLegacyLifecycle(findings);
    findings = legacy.findings;
    lifecycleValue = legacy.lifecycle;
  }
  if (strict && lifecycleValue == null) fail("decision brief", "lifecycle is required");
  const detailsValue =
    value.details ??
    (strict
      ? null
      : checks.map((check) => ({ id: check.id, findings: findings.filter((finding) => finding.checkId === check.id), report: "" })));
  const details = normalizeDetails(detailsValue, { strict, checks });
  assertLosslessFindingParity(findings, details);
  const lifecycle = normalizeLifecycle(lifecycleValue, findings);
  return {
    ...value,
    artifactType: ARTIFACT_SCHEMAS.decisionBrief.artifactType,
    schemaVersion: ARTIFACT_SCHEMAS.decisionBrief.currentVersion,
    summary,
    checks,
    findings,
    details,
    lifecycle,
  };
}

export const validateDecisionBrief = migrateDecisionBrief;

export function migrateRunState(value) {
  if (!record(value)) fail("run state", "must be an object");
  // v1 was an unwrapped snapshot; v2 wrapped it but had no artifact type.
  const wrapped =
    Object.hasOwn(value, "snapshot") ||
    Object.hasOwn(value, "artifactType") ||
    value.schemaVersion === 2 ||
    value.schemaVersion === ARTIFACT_SCHEMAS.runState.currentVersion;
  const wrapper = wrapped ? value : { schemaVersion: 1, id: value.id, snapshot: value };
  const version = wrapper.schemaVersion ?? 1;
  if (!ARTIFACT_SCHEMAS.runState.compatibleVersions.includes(version)) fail("run state", `unsupported schemaVersion ${String(version)}`);
  const strict = version === ARTIFACT_SCHEMAS.runState.currentVersion;
  assertArtifactType(wrapper, "run state", ARTIFACT_SCHEMAS.runState.artifactType, { required: strict });
  const snapshot = wrapper.snapshot;
  if (strict) {
    if (!Object.hasOwn(wrapper, "id")) fail("run state", "id is required");
    if (!Object.hasOwn(wrapper, "snapshot")) fail("run state", "snapshot is required");
    if (!record(snapshot)) fail("run state", "snapshot must be an object");
    if (!Object.hasOwn(snapshot, "id")) fail("run state", "snapshot.id is required");
    if (!Object.hasOwn(snapshot, "evidence")) fail("run state", "snapshot.evidence is required");
    if (!record(snapshot.evidence)) fail("run state", "snapshot.evidence must be an object");
  }
  if (!record(snapshot) || typeof (wrapper.id ?? snapshot.id) !== "string" || !(wrapper.id ?? snapshot.id))
    fail("run state", "id and snapshot are required");
  if (snapshot.id && snapshot.id !== (wrapper.id ?? snapshot.id)) fail("run state", "wrapper id must match snapshot id");
  return {
    artifactType: ARTIFACT_SCHEMAS.runState.artifactType,
    schemaVersion: ARTIFACT_SCHEMAS.runState.currentVersion,
    id: wrapper.id ?? snapshot.id,
    snapshot: { ...snapshot, id: snapshot.id ?? wrapper.id, evidence: normalizeEvidenceEnvelope(snapshot.evidence) },
  };
}

export const validateRunState = migrateRunState;

export function parseArtifactJson(text, kind, source = "artifact") {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TypeError(`${source} is not valid JSON: ${error?.message || error}`, { cause: error });
  }
  const validators = {
    manifest: validateManifest,
    decisionBrief: validateDecisionBrief,
    runState: validateRunState,
    evidenceEnvelope: validateEvidenceEnvelope,
  };
  const validator = validators[kind];
  if (!validator) throw new TypeError(`unknown artifact kind ${kind}`);
  return validator(parsed);
}

export function serializeArtifact(value, kind) {
  const validators = {
    manifest: validateManifest,
    decisionBrief: validateDecisionBrief,
    runState: validateRunState,
    evidenceEnvelope: validateEvidenceEnvelope,
  };
  const validator = validators[kind];
  if (!validator) throw new TypeError(`unknown artifact kind ${kind}`);
  return `${JSON.stringify(validator(value), null, 2)}\n`;
}
