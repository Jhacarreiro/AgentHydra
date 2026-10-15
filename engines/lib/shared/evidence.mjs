// vendored from Connections packages/connections-arkitect/src/core/evidence.mjs @ dd3d47a7ad
// Machine-readable evidence contracts for Architect checks.
//
// A no-data result is not actionable until the runner knows what evidence was
// absent, how to produce it, how fresh it must be, and whether producing it has
// side effects. Checks declare that once on `audit.evidence`; every output
// surface receives the same normalized contract.

export const EVIDENCE_KINDS = Object.freeze(["static", "artifact", "live", "hosted", "attestation", "unspecified"]);
export const EVIDENCE_RISKS = Object.freeze(["read-only", "disposable-write", "external-side-effect", "manual", "unspecified"]);
export const EVIDENCE_FRESHNESS_MODES = Object.freeze(["workspace", "per-run", "max-age", "manual", "unspecified"]);

const TOP_LEVEL_KEYS = new Set(["kind", "producer", "freshness", "prerequisites", "risk", "account"]);
const ACCOUNT_KEYS = new Set(["accepts", "derivedFrom", "appliesTo"]);
/**
 * WHO needs the identity: the check's own live run, or the separate command that produces its
 * artifact. Both are real in this corpus - `aws-atlas-drift` reads a captured snapshot (so its own
 * `--live` run needs no credentials at all) while its producer scan must run in the prod account.
 * Declaring the producer's identity is still worth doing: it answers "where do I run this from?",
 * which was previously only in prose. Only `run` is preflight-enforced, because only `run` is a
 * decision the runner is in a position to make.
 */
const ACCOUNT_SCOPES = Object.freeze(["run", "producer"]);
const ACCOUNT_ENTRY_KEYS = new Set(["id", "name"]);
/** The one string form: this evidence needs NO cloud-account credentials at all. */
export const EVIDENCE_ACCOUNT_NONE = "none";
const PRODUCER_STRING_KEYS = new Set(["command", "artifactPath", "description"]);
// `servers` names dev-server prerequisites the producer's `command` needs running before it can
// succeed - a check declares WHAT it needs, never how to boot it, so the declaration stays a
// plain JSON-safe array of names (round-trips through the manifest) and the actual boot spec
// (port/cwd/args) lives in exactly one place: the runner-side registry a caller resolves names
// against (Connections: dev-server-lifecycle.mjs's DEV_SERVER_REGISTRY). This is the tier-3
// declaration for server prerequisites the same way `command`/`artifactPath` already are for the
// evidence itself - see produce-evidence.mjs, which unions every planned producer's `servers`
// into its boot plan instead of carrying a hand-maintained server list.
//
// `regenerates` (optional boolean, added 2026-08) is the SAFETY DECLARATION that lets a producer
// run UNCONDITIONALLY, with no prior audit and no manifest to plan from - this is the whole story,
// so it is written here rather than only in the runner that reads it:
//
//   `regenerates: true` asserts the command is a PURE DERIVATION of committed source - running it
//   recomputes a generated artifact and nothing else. It is therefore idempotent and safe to run
//   unconditionally (see scripts/arkitect/sync-generated.mjs, which discovers every check carrying
//   this flag and runs each declared command once, sequentially, with no gating implication).
//
//   ⛔ A RATCHET OR BASELINE SEEDER MUST NEVER CARRY THIS FLAG. `travel-time-budgets --seed`,
//   `complexity-ratchet` baselines, mutation floors and friends BANK A MEASUREMENT as a new
//   permanent floor. That is a judgment, not a derivation - this repo has already been bitten once
//   by a fixer path that absorbed a peer's in-flight sites permanently (see
//   arkitect-burndown-lessons.md). Derivation recomputes; banking decides. Only the first may be
//   automated. When in doubt whether a producer derives or decides, leave the flag off.
//
// Deliberately NOT gated: omitting it changes nothing about a check's evidence contract, its
// no-data status, or check-evidence-contract's verdict - it is pure additive metadata a runner may
// read, never an obligation `check-evidence-contract` enforces.
//
// `attended` (optional boolean, added 2026-09-14, incident: the advanced run launched an
// unattended full design-critic re-capture that would have discarded 248 already-judged scores)
// is the mirror-image safety declaration: `attended: true` asserts this producer CANNOT complete
// without an in-session agent - here, scoring the judge's emitted worklist (--emit -> --ingest;
// the `claude` CLI subprocess step was retired 2026-08-08) - so an unattended run can START it but
// never FINISH it, and would only discard whatever judged state it was about to overwrite.
// `produce-evidence.mjs`'s `planFrom` reads this and routes the check to its `attended` list,
// never to `produce` - unlike `regenerates`, this DOES change runner behaviour, so declare it
// deliberately, not defensively: most producers are unattended and need no such flag.
const PRODUCER_BOOLEAN_KEYS = new Set(["regenerates", "attended"]);
const PRODUCER_KEYS = new Set([...PRODUCER_STRING_KEYS, "servers", ...PRODUCER_BOOLEAN_KEYS]);
const FRESHNESS_KEYS = new Set(["mode", "maxAgeMs", "configKey"]);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const nonEmptyString = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

function unknownKeys(value, allowed, prefix, issues) {
  if (!isRecord(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push(`${prefix}.${key} is not a supported evidence field`);
  }
}

function normalizeProducer(value, issues) {
  if (value == null) return null;
  if (!isRecord(value)) {
    issues.push("evidence.producer must be an object");
    return null;
  }
  unknownKeys(value, PRODUCER_KEYS, "evidence.producer", issues);
  const producer = {};
  for (const key of PRODUCER_STRING_KEYS) {
    const normalized = nonEmptyString(value[key]);
    if (normalized) producer[key] = normalized;
    else if (value[key] != null) issues.push(`evidence.producer.${key} must be a non-empty string`);
  }
  if (value.servers != null) {
    if (!Array.isArray(value.servers) || !value.servers.length) {
      issues.push("evidence.producer.servers must be a non-empty array of server names");
    } else {
      const servers = [];
      for (const entry of value.servers) {
        const normalized = nonEmptyString(entry);
        if (normalized) servers.push(normalized);
        else issues.push("evidence.producer.servers entries must be non-empty strings");
      }
      if (servers.length) producer.servers = [...new Set(servers)].sort();
    }
  }
  if (value.regenerates != null) {
    if (typeof value.regenerates === "boolean") producer.regenerates = value.regenerates;
    else issues.push("evidence.producer.regenerates must be a boolean");
  }
  if (value.attended != null) {
    if (typeof value.attended === "boolean") producer.attended = value.attended;
    else issues.push("evidence.producer.attended must be a boolean");
  }
  if (!Object.keys(producer).length) {
    issues.push("evidence.producer must declare command, artifactPath, or description");
    return null;
  }
  return producer;
}

/**
 * WHICH CLOUD IDENTITY THE EVIDENCE NEEDS - the declaration that turns a silent no-data into a
 * refusal by name.
 *
 * ⛔ WHY (measured 2026-09-16, first-hand, after it invalidated a whole lane of live results). A
 * `--live` check pointed at the WRONG account does not FAIL - it degrades to `no-data`, because
 * every honest check answers "I could not read anything" when its reads are denied. Same check,
 * same minute: `infra-deploy-freshness` under the org-management credential reported `no-data`
 * ("not authorized to perform: lambda:GetFunction"), and under the prod credential reported 22
 * GATING ERRORS. Pointing four checks at their correct identity that day converted silence into 25
 * gating errors and 33 warnings, two of which were live user-facing defects. Nothing in the corpus
 * declared which identity any check needed, so the operator guessed, and a wrong guess is
 * indistinguishable from a clean lane.
 *
 * The shape:
 *
 *   account: "none"                                  // needs no cloud credentials (HTTP-only probe)
 *   account: { accepts: [{ id, name }, ...],         // every identity this evidence can be produced
 *              derivedFrom: "<basis>" }              // under; the FIRST is the preferred one
 *
 * `accepts` is a LIST rather than one id because the honest answer often is one: a probe that reads
 * a resource directly OR assumes an org role into it works from the resource's own account and from
 * the org-management account, and refusing the second would be a false refusal.
 *
 * `derivedFrom` names the basis a workspace resolver computed the list from (e.g. a plane's own
 * account, the account holding that plane's database after co-tenancy). It is deliberately opaque
 * to the core: the core compares ids, and the workspace's own oracle re-derives the list so a
 * hand-edited literal cannot drift from the registries it was supposed to come from.
 */
function normalizeAccount(value, issues) {
  if (value == null) return null;
  if (typeof value === "string") {
    const normalized = nonEmptyString(value);
    if (normalized === EVIDENCE_ACCOUNT_NONE) return EVIDENCE_ACCOUNT_NONE;
    issues.push(`evidence.account must be "${EVIDENCE_ACCOUNT_NONE}" or an object with an accepts list`);
    return null;
  }
  if (!isRecord(value)) {
    issues.push(`evidence.account must be "${EVIDENCE_ACCOUNT_NONE}" or an object with an accepts list`);
    return null;
  }
  unknownKeys(value, ACCOUNT_KEYS, "evidence.account", issues);
  const accepts = [];
  if (!Array.isArray(value.accepts) || !value.accepts.length) {
    issues.push("evidence.account.accepts must be a non-empty array of { id, name } identities");
  } else {
    for (const entry of value.accepts) {
      if (!isRecord(entry)) {
        issues.push("evidence.account.accepts entries must be objects with id and name");
        continue;
      }
      unknownKeys(entry, ACCOUNT_ENTRY_KEYS, "evidence.account.accepts[]", issues);
      const id = nonEmptyString(entry.id);
      const name = nonEmptyString(entry.name);
      if (!id || !name) {
        issues.push("evidence.account.accepts entries must carry a non-empty id and name");
        continue;
      }
      accepts.push({ id, name });
    }
  }
  const account = {};
  if (accepts.length) account.accepts = accepts;
  const requestedScope = nonEmptyString(value.appliesTo);
  if (requestedScope && !ACCOUNT_SCOPES.includes(requestedScope)) {
    issues.push(`evidence.account.appliesTo must be one of: ${ACCOUNT_SCOPES.join(", ")}`);
  } else if (value.appliesTo != null && !requestedScope) {
    issues.push("evidence.account.appliesTo must be a non-empty string");
  }
  account.appliesTo = requestedScope && ACCOUNT_SCOPES.includes(requestedScope) ? requestedScope : "run";
  const derivedFrom = nonEmptyString(value.derivedFrom);
  if (derivedFrom) account.derivedFrom = derivedFrom;
  else if (value.derivedFrom != null) issues.push("evidence.account.derivedFrom must be a non-empty string");
  return accepts.length ? account : null;
}

function normalizeFreshness(value, issues) {
  if (value == null) return null;
  if (!isRecord(value)) {
    issues.push("evidence.freshness must be an object");
    return null;
  }
  unknownKeys(value, FRESHNESS_KEYS, "evidence.freshness", issues);
  const requestedMode = nonEmptyString(value.mode);
  const mode = EVIDENCE_FRESHNESS_MODES.includes(requestedMode) ? requestedMode : "unspecified";
  if (!requestedMode || mode === "unspecified") {
    issues.push(
      `evidence.freshness.mode must be one of: ${EVIDENCE_FRESHNESS_MODES.filter((entry) => entry !== "unspecified").join(", ")}`,
    );
  }
  const freshness = { mode };
  if (value.maxAgeMs != null) {
    const maxAgeMs = Number(value.maxAgeMs);
    if (Number.isFinite(maxAgeMs) && maxAgeMs > 0) freshness.maxAgeMs = Math.round(maxAgeMs);
    else issues.push("evidence.freshness.maxAgeMs must be a positive finite number");
  }
  const configKey = nonEmptyString(value.configKey);
  if (configKey) freshness.configKey = configKey;
  else if (value.configKey != null) issues.push("evidence.freshness.configKey must be a non-empty string");
  if (mode === "max-age" && freshness.maxAgeMs == null && !freshness.configKey) {
    issues.push("max-age evidence freshness must declare maxAgeMs or configKey");
  }
  if (mode !== "max-age" && (freshness.maxAgeMs != null || freshness.configKey)) {
    issues.push("maxAgeMs/configKey are only valid when evidence.freshness.mode is max-age");
  }
  return freshness;
}

/**
 * Normalize an optional `audit.evidence` declaration without letting malformed
 * metadata crash the audit run. `valid:false` is deliberately visible so the
 * Architect-health oracle can fail on the declaration defect.
 */
export function normalizeEvidenceContract(value) {
  const declared = value != null;
  const issues = [];
  if (declared && !isRecord(value)) issues.push("evidence must be an object");
  const source = isRecord(value) ? value : {};
  unknownKeys(source, TOP_LEVEL_KEYS, "evidence", issues);

  const requestedKind = nonEmptyString(source.kind);
  const kind = EVIDENCE_KINDS.includes(requestedKind) ? requestedKind : "unspecified";
  if (declared && (!requestedKind || kind === "unspecified")) {
    issues.push(`evidence.kind must be one of: ${EVIDENCE_KINDS.filter((entry) => entry !== "unspecified").join(", ")}`);
  }

  const requestedRisk = nonEmptyString(source.risk);
  const risk = EVIDENCE_RISKS.includes(requestedRisk) ? requestedRisk : "unspecified";
  if (declared && (!requestedRisk || risk === "unspecified")) {
    issues.push(`evidence.risk must be one of: ${EVIDENCE_RISKS.filter((entry) => entry !== "unspecified").join(", ")}`);
  }

  const prerequisites = [];
  if (source.prerequisites != null && !Array.isArray(source.prerequisites)) {
    issues.push("evidence.prerequisites must be an array of non-empty strings");
  } else {
    for (const entry of source.prerequisites ?? []) {
      const normalized = nonEmptyString(entry);
      if (normalized) prerequisites.push(normalized);
      else issues.push("evidence.prerequisites entries must be non-empty strings");
    }
  }

  const producer = normalizeProducer(source.producer, issues);
  const freshness = normalizeFreshness(source.freshness, issues);
  const account = normalizeAccount(source.account, issues);
  return {
    schemaVersion: 1,
    declared,
    // The declaration is optional for checks that cannot produce an evidence
    // gap. Absence is a valid fallback state; the evidence-contract oracle
    // separately decides which checks are obligated to declare one.
    valid: issues.length === 0,
    kind,
    producer,
    freshness,
    prerequisites: [...new Set(prerequisites)].sort(),
    risk,
    // `null` when undeclared - the obligation to declare one belongs to the workspace's own
    // evidence oracle (it knows which kinds reach a cloud), never to this normalizer.
    account,
    issues,
  };
}
