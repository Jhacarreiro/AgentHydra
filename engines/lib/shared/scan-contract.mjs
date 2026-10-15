// vendored from Connections packages/connections-arkitect/src/core/scan-contract.mjs @ dd3d47a7ad
// A clean search is evidence, not an absence of evidence. Canonical walkers
// record their measured cardinality in the runner-owned AsyncLocalStorage
// ledger; checks never self-attest with a hand-authored count. One semantic
// scope (`seam` + canonical `subject`) appears at most once per audit, so
// `totalUnitsScanned` is a sum of distinct searched universes rather than a
// cache/retrieval event counter.

const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => typeof value === "string" && value.trim().length > 0;
const nonNegativeCount = (value) => Number.isSafeInteger(value) && value >= 0;

/** Normalize the only supported declaration: this check expects runtime observations. */
export function normalizeScanDeclaration(value) {
  if (value == null) return { declared: false, valid: true, mode: null, issues: [] };
  if (!record(value)) return { declared: true, valid: false, mode: null, issues: ["scan must be an object"] };
  const issues = [];
  if (value.mode !== "runtime") issues.push('scan.mode must be "runtime"; check-reported scan counts are unsupported');
  for (const key of Object.keys(value))
    if (key !== "mode") issues.push(`scan.${key} is unsupported; runtime observations are runner-owned`);
  return { declared: true, valid: issues.length === 0, mode: value.mode === "runtime" ? "runtime" : null, issues };
}

function normalizeObservations(value) {
  if (!Array.isArray(value)) return { valid: false, issues: ["runtime scan observations must be an array"], observations: [] };
  const issues = [];
  const observations = [];
  const semanticScopes = new Map();
  for (const [index, observation] of value.entries()) {
    if (!record(observation)) {
      issues.push(`runtime scan observation ${index} must be an object`);
      continue;
    }
    if (!nonEmptyString(observation.seam)) issues.push(`runtime scan observation ${index}.seam must be a non-empty string`);
    if (!nonNegativeCount(observation.count)) issues.push(`runtime scan observation ${index}.count must be a non-negative safe integer`);
    if (!nonEmptyString(observation.subject)) issues.push(`runtime scan observation ${index}.subject must be a non-empty string`);
    if (nonEmptyString(observation.seam) && nonNegativeCount(observation.count)) {
      if (nonEmptyString(observation.subject)) {
        const scopeKey = JSON.stringify([observation.seam, observation.subject]);
        if (semanticScopes.has(scopeKey)) {
          const previousCount = semanticScopes.get(scopeKey);
          issues.push(
            previousCount === observation.count
              ? `runtime scan observation ${index} duplicates semantic scope ${observation.seam} (${observation.subject})`
              : `runtime scan observation ${index} changes semantic scope ${observation.seam} (${observation.subject}) from ${previousCount} to ${observation.count}`,
          );
          continue;
        }
        semanticScopes.set(scopeKey, observation.count);
      }
      observations.push({ seam: observation.seam, count: observation.count, subject: observation.subject });
    }
  }
  return { valid: issues.length === 0, issues, observations };
}

function aggregateObservations(observations, issues) {
  const unitsScanned = {};
  let totalUnitsScanned = 0;
  for (const observation of observations) {
    const next = (unitsScanned[observation.seam] ?? 0) + observation.count;
    if (!Number.isSafeInteger(next)) issues.push(`runtime scan aggregate for ${observation.seam} exceeds a safe integer`);
    else {
      unitsScanned[observation.seam] = next;
      const nextTotal = totalUnitsScanned + observation.count;
      if (!Number.isSafeInteger(nextTotal)) issues.push("runtime scan aggregate total exceeds a safe integer");
      else totalUnitsScanned = nextTotal;
    }
  }
  return { unitsScanned, totalUnitsScanned };
}

function sameCounts(left, right) {
  if (!record(left) || !record(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && left[key] === right[key]);
}

function evidence(declaration, state, reason, observations, unitsScanned, totalUnitsScanned = null) {
  return {
    declaration,
    evaluation: { state, reason },
    unitsScanned,
    totalUnitsScanned,
    provenance: { kind: "runner-observed", observations },
  };
}

/**
 * Evaluate the runner ledger for one audit.
 *
 * A check with findings does not need a completed clean-scan proof: it already
 * produced a concrete result and may have stopped its iterator early. Once the
 * finding is fixed, the same runtime declaration forces the clean path to
 * exhaust an observable seam or crash instead of passing vacuously.
 */
export function evaluateScanContract({ declaration, output, observations = [], findingsCount = 0, declaredRootsAbsent = null }) {
  if (output?.scan !== undefined) {
    const issue = "top-level output.scan is unsupported; scan cardinality must come from the runner-owned runtime ledger";
    return {
      kind: "invalid",
      issues: [issue],
      scan: evidence(declaration?.valid && declaration.mode === "runtime" ? { mode: "runtime" } : null, "invalid", issue, [], null),
    };
  }
  if (declaration?.declared && !declaration.valid) {
    return { kind: "invalid", issues: declaration.issues, scan: evidence(null, "invalid", declaration.issues.join("; "), [], null) };
  }
  const normalized = normalizeObservations(observations);
  if (!normalized.valid) {
    return {
      kind: "invalid",
      issues: normalized.issues,
      scan: evidence(declaration?.mode === "runtime" ? { mode: "runtime" } : null, "invalid", normalized.issues.join("; "), [], null),
    };
  }
  if (normalized.observations.length > 0 && declaration?.mode !== "runtime") {
    const issue = 'runner-observed scan evidence requires an explicit audit.scan declaration of { mode: "runtime" }';
    return { kind: "invalid", issues: [issue], scan: evidence(null, "invalid", issue, normalized.observations, null) };
  }
  // Findings are already durable evidence that the check executed and found
  // something actionable. They may also stop an iterator before exhaustion,
  // or deliberately report that the expected candidate universe is absent.
  // Persist scan proof only for finding-free results; once the finding is
  // fixed, the clean path must complete a positive scan or become no-data.
  if (findingsCount > 0) return { kind: "not-applicable", scan: null };
  if (normalized.observations.length === 0) {
    // A deliberately skipped audit made no assertion about its candidate
    // universe.  It differs from a clean result: requiring a completed
    // enumeration here would turn suite-only umbrella de-duplication into a
    // false crash.  Do not persist a scan claim for a path that did not run.
    if (output?.status === "skipped" || output?.status === "not-applicable") return { kind: "not-applicable", scan: null };
    if (output?.status === "no-data" && declaration?.mode !== "runtime") {
      return { kind: "no-data", scan: null, reason: output.reason ?? "Audit explicitly returned no-data without a runtime enumeration." };
    }
    if (declaration?.mode === "runtime") {
      // A runtime-declared audit can honestly have no enumerator to invoke on
      // an explicit no-data path (for example, an absent capture or an
      // optional package-owned catalog).  Preserve that absence as a measured
      // zero universe.  Any other finding-free result remains invalid: a
      // clean/warned/failed audit must prove the scan it declared.
      if (output?.status === "no-data") {
        const reason = "Audit explicitly returned no-data before a runtime enumeration was applicable.";
        return { kind: "no-data", scan: evidence({ mode: "runtime" }, "no-data", reason, [], {}, 0), reason };
      }
      // ⛔ "IT HAD NOTHING HERE TO READ" IS NOT THE SAME DEFECT AS "IT DECLARED A SCAN AND DID NOT
      // TAKE ONE" (2026-09-16). The refusal below is right whenever the check COULD have scanned and
      // silently did not - that is the false-clean this whole module exists to kill. But when the
      // runner has already resolved every scan root this check declares and found all of them absent
      // from the scanned repository, there was never a directory for it to enumerate: it is blind
      // here by the tree's shape, not by its own bug. Crashing it says the check is broken and puts
      // one gating error on the repository's account for a defect the repository does not have.
      //
      // Measured on Odin's fleet, 2026-09-16: 27 portable checks crashed this exact way on 32 of ~67
      // repositories - 406 crashes, every one counted as a gating error, so a static marketing site
      // read 31 gating errors for one real finding. This is the Unified Filter's sixth property
      // (arkitect-globality.md: "NO-DATA, NEVER CLEAN, when the input class is absent") arriving at
      // the one place that can apply it for every check at once instead of 27 checks each
      // remembering; `spec-fetch-mock-unreachable` already hand-rolls exactly this verdict.
      //
      // It cannot become a false green: `no-data` is not `clean`, it carries its own reason, and the
      // branch is reachable only when the check ALSO produced zero observations - a check that scans
      // through any other seam never arrives here. See `beginResolvedDefaultRoots` in runner.mjs for
      // the other half, and note the condition there is `resolveScannedRoots`'s own `empty` flag,
      // which is false the moment one declared root is present or discovery finds a source tree.
      if (declaredRootsAbsent) {
        const reason = `Audit declared a runtime scan, but ${declaredRootsAbsent}.`;
        return { kind: "no-data", scan: evidence({ mode: "runtime" }, "no-data", reason, [], {}, 0), reason };
      }
      const issue = "audit declared a runtime scan but no observable enumeration seam completed";
      return { kind: "invalid", issues: [issue], scan: evidence({ mode: "runtime" }, "invalid", issue, [], null) };
    }
    return { kind: "not-applicable", scan: null };
  }

  const aggregateIssues = [];
  const { unitsScanned, totalUnitsScanned } = aggregateObservations(normalized.observations, aggregateIssues);
  if (aggregateIssues.length) {
    return {
      kind: "invalid",
      issues: aggregateIssues,
      scan: evidence({ mode: "runtime" }, "invalid", aggregateIssues.join("; "), normalized.observations, null),
    };
  }
  if (totalUnitsScanned > 0)
    return {
      kind: "complete",
      scan: evidence({ mode: "runtime" }, "complete", null, normalized.observations, unitsScanned, totalUnitsScanned),
    };
  const reason = `Every observed scan seam enumerated zero units: ${Object.keys(unitsScanned).join(", ")}.`;
  return { kind: "no-data", scan: evidence({ mode: "runtime" }, "no-data", reason, normalized.observations, unitsScanned, 0), reason };
}

/**
 * OBSERVE-ONLY reach measurement (queue 4391e55c, 2026-08-14) - a purely additive companion to
 * `evaluateScanContract`, never a replacement. It answers exactly one question - "how many units
 * did this runtime-declared check actually scan this run" - independent of `findingsCount`.
 *
 * THE GAP THIS CLOSES: `evaluateScanContract`'s `if (findingsCount > 0) return { kind:
 * "not-applicable", scan: null }` above means a check that reports at least one finding on every
 * run never gets `scan` persisted, so its reach can collapse to a fraction of its own history and
 * no detector (`scan-reach-collapse`) can ever see it - confirmed 2026-08-14 ("fourteen checks
 * green while blind in one day"; the retention gate that printed a fleet-wide all-clear over 80
 * tables it never saw is exactly this shape, since it always reports findings).
 *
 * WHY A SEPARATE FUNCTION INSTEAD OF EDITING THE `findingsCount > 0` BRANCH ABOVE: `scan` is a
 * load-bearing CONTRACT value - validated by `validatePersistedScan`, gated by
 * `check-scan-coverage`/`incremental-input-declarations`/`check-proof-coverage`, and read by
 * `statusContractError` in runner.mjs to decide whether a check's run is even valid. Changing what
 * it means for a finding-bearing run would touch every one of those at once, on ~643 gating
 * checks, in a single step - exactly the "naive fix turns the fleet red" failure this queue item
 * exists to avoid. `observeScanReach` shares none of that: its result is never assigned to `scan`,
 * never validated by `validatePersistedScan`, and consumed by nothing that gates. Its only reader
 * is the reach-collapse detector's history extraction, and that detector is permanently advisory.
 */
export function observeScanReach({ declaration, observations = [] }) {
  if (declaration?.mode !== "runtime") return null;
  const normalized = normalizeObservations(observations);
  if (!normalized.valid || normalized.observations.length === 0) return null;
  const issues = [];
  const { unitsScanned, totalUnitsScanned } = aggregateObservations(normalized.observations, issues);
  if (issues.length > 0) return null;
  return { unitsScanned, totalUnitsScanned };
}

/** A contradictory audit result turns otherwise-valid scan evidence into a failed contract. */
export function invalidateScanEvidence(scan, reason) {
  if (scan == null) return null;
  return { ...scan, evaluation: { state: "invalid", reason }, unitsScanned: null, totalUnitsScanned: null };
}

/**
 * Compact provenance for a scan whose full per-(seam,subject) observation list has been written
 * once to a sibling artifact instead of inline (ENG-06: that array measured 51.8MB of a 70.5MB
 * manifest.json, and the SAME array was independently inlined again into DECISION_BRIEF.json and
 * telemetry.json - three copies of one evidence trail). `unitsScanned`/`totalUnitsScanned` - the
 * only part any consumer actually reads - are unaffected; only the per-scope detail moves out.
 */
export function externalizedProvenance(observationsRef, observationsCount) {
  return { kind: "runner-observed", observationsRef, observationsCount };
}

/** Validate durable runner-observed scan evidence carried by an artifact row. */
export function validatePersistedScan(value, { artifact = "manifest", path = "check.scan" } = {}) {
  if (value == null) return null;
  const fail = (message) => {
    throw new TypeError(`${artifact} artifact is invalid: ${path} ${message}`);
  };
  if (!record(value) || !Object.hasOwn(value, "declaration") || !record(value.evaluation) || !record(value.provenance))
    fail("must contain declaration, evaluation, and provenance");
  const declaration = normalizeScanDeclaration(value.declaration);
  if (value.provenance.kind !== "runner-observed") fail('provenance.kind must be "runner-observed"');
  // Detected by SHAPE alone, never by state, so the ordinary inline path below runs in the exact
  // same order it always has - nothing about existing (small, inline) artifacts changes.
  const isExternalized = !Object.hasOwn(value.provenance, "observations") && Object.hasOwn(value.provenance, "observationsRef");
  const normalized = isExternalized ? null : normalizeObservations(value.provenance.observations);
  if (normalized && !normalized.valid) fail(normalized.issues.join("; "));
  const state = value.evaluation.state;
  const reason = value.evaluation.reason;
  if (!new Set(["complete", "no-data", "invalid"]).has(state)) fail("evaluation.state is unsupported");
  if (state === "complete" && reason !== null) fail("evaluation.reason must be null for a complete scan");
  if (state !== "complete" && !nonEmptyString(reason)) fail("evaluation.reason must explain a non-complete scan");
  if (state === "invalid") {
    // An invalid scan's aggregate is always null (see the `unitsScanned must be null` check just
    // below) - there is nothing to externalize, so this shape can never legitimately appear here.
    if (isExternalized) fail("an invalid scan cannot carry externalized provenance");
    if (value.declaration !== null && (!declaration.declared || !declaration.valid))
      fail("declaration must be null or require runtime observations");
    if (value.unitsScanned !== null) fail("unitsScanned must be null for an invalid scan");
    if (value.totalUnitsScanned !== null) fail("totalUnitsScanned must be null for an invalid scan");
    return evidence(value.declaration === null ? null : { mode: "runtime" }, state, reason, normalized.observations, null);
  }
  if (!declaration.declared || !declaration.valid) fail("declaration must require runtime observations");
  if (!record(value.unitsScanned) || (state === "complete" && Object.keys(value.unitsScanned).length === 0))
    fail("unitsScanned must be a non-empty object for a complete scan");
  if (isExternalized) {
    if (!nonEmptyString(value.provenance.observationsRef)) fail("provenance.observationsRef must be a non-empty string");
    if (!nonNegativeCount(value.provenance.observationsCount)) fail("provenance.observationsCount must be a non-negative safe integer");
    let total = 0;
    for (const [seam, count] of Object.entries(value.unitsScanned)) {
      if (!nonNegativeCount(count)) fail(`unitsScanned.${seam} must be a non-negative safe integer`);
      total += count;
    }
    if (!Number.isSafeInteger(total)) fail("unitsScanned values exceed a safe integer total");
    // The per-observation array is gone; the ONE cross-check still possible without it is that the
    // declared total agrees with the (still-inline, still tiny) per-seam aggregate - the same
    // invariant the non-externalized path proves against the full array, one level up.
    if (value.totalUnitsScanned !== total) fail("totalUnitsScanned must equal the sum of unitsScanned values");
    if (state === "complete" && total === 0) fail("cannot be complete with zero scanned units");
    if (state === "no-data" && total !== 0) fail("no-data must have zero scanned units");
    return {
      declaration: { mode: "runtime" },
      evaluation: { state, reason },
      unitsScanned: value.unitsScanned,
      totalUnitsScanned: value.totalUnitsScanned,
      provenance: externalizedProvenance(value.provenance.observationsRef, value.provenance.observationsCount),
    };
  }
  const aggregateIssues = [];
  const { unitsScanned: derived, totalUnitsScanned: total } = aggregateObservations(normalized.observations, aggregateIssues);
  if (aggregateIssues.length) fail(aggregateIssues.join("; "));
  if (!sameCounts(value.unitsScanned, derived)) fail("unitsScanned must exactly equal the runner observation aggregate");
  if (value.totalUnitsScanned !== total) fail("totalUnitsScanned must exactly equal the runner observation aggregate total");
  if (state === "complete" && total === 0) fail("cannot be complete with zero scanned units");
  if (state === "no-data" && total !== 0) fail("no-data must have zero scanned units");
  return evidence({ mode: "runtime" }, state, reason, normalized.observations, derived, total);
}
