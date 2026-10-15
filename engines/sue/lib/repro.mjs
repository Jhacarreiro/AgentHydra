/**
 * repro - a SUE finding is a claim until a repro test proves it: the pure rules and the run's repro.json.
 * ======================================================================================================
 *
 * WHAT: the rules sue/repro.mjs runs on, kept apart so the report, 4man's SUE scout and the tests read
 * one copy. A repro is an ESM node script that drives the page (playwright-core) and asserts the CORRECT
 * behaviour with node:assert. Its run is classified three ways:
 *   still        it threw an AssertionError: the assertion that encodes the bug failed, the bug reproduces
 *   broken-test  any other ending: a missing control, a timeout, a crash, a repro that ended the process itself
 *   gone         it passed: every assertion held, the symptom did not show
 * A finding is CONFIRMED only on `still`; `gone` rejects it as not-reproduced and `broken-test` rejects it until
 * the repro is fixed and run again. Before any repro, a finding can be triaged into a reject bucket: environment
 * (a key or service only production has), design (the code or copy says it is intended), fixture (seed data),
 * sue-side (SUE's own artifact, the explorer-artifact bucket). Every decision lands in
 * sue/runs/<run id>/repro.json, one entry per finding (`<sue folder>:<line>`, the 1-based line of her
 * findings.jsonl), the latest decision winning and the earlier ones kept in `history`.
 *
 * WHY: an AI visitor's complaint read as a bug wastes a fix on something that was never broken, and one read as
 * noise loses a real bug. A failing assertion is the only mechanical line between the two, and the same test
 * passing later is the only mechanical "fixed". The idea - a finding becomes a bug when a repro asserting the
 * correct behaviour fails on that assertion, after the explorer-artifact, environment, design and fixture
 * buckets are ruled out - is tester-army/e2e's bug-bash reference (Apache-2.0), steps 5 and 6. Written fresh
 * for SUE; nothing of theirs is copied.
 *
 * Nothing here launches a browser or a process: sue/repro.mjs does that and hands the outcome here.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

/** The three results a repro run can have. */
export const RESULTS = ["still", "broken-test", "gone"];

/** The reject buckets a finding can be triaged into before any repro, and what each means. */
export const BUCKETS = {
  environment: "it fails on a key, a service or a limit only production has",
  design: "the code, its tests or its copy say the behaviour is intended",
  fixture: "the seed data lacks what real records always have",
  "sue-side": "SUE's own artifact: her browser, her perception or her door, not the site",
};

/** Why a repro run rejects a finding. */
export const REPRO_REJECTS = {
  "not-reproduced": "the repro passed: the symptom did not show",
  "broken-test": "the repro failed on something other than its assertion: fix the repro and confirm again",
};

/** Every reject group the report lists, in its order: the buckets first, then the two repro outcomes. */
export const REJECT_GROUPS = [...Object.keys(BUCKETS), ...Object.keys(REPRO_REJECTS)];

/** What a reject group is called in a report or a summary. */
export const GROUP_LABEL = {
  environment: "Environment",
  design: "Design",
  fixture: "Fixture",
  "sue-side": "SUE-side",
  "not-reproduced": "Did not reproduce",
  "broken-test": "Broken repro",
};

export const LEDGER_FILE = "repro.json";

/** `sue-1117-grandma:4` -> { sue, line }; throws on anything else. */
export function parseFindingRef(ref) {
  const text = String(ref ?? "").trim();
  const at = text.lastIndexOf(":");
  const sue = at > 0 ? text.slice(0, at) : "";
  const line = Number(text.slice(at + 1));
  if (!sue || /[\\/]/.test(sue) || sue.includes("..") || !Number.isInteger(line) || line < 1)
    throw new Error(`a finding is <sue folder>:<line>, the 1-based line of her findings.jsonl (sue-1117-grandma:4), not "${text}"`);
  return { sue, line };
}

/** Is a thrown error, as the child described it, an assertion? node:assert sets code ERR_ASSERTION. */
export function isAssertion(thrown) {
  return thrown?.code === "ERR_ASSERTION" || /^AssertionError/.test(String(thrown?.name ?? ""));
}

// The message on one line, short: node:assert's own ("Expected values to be strictly equal:\n\n1 !== 2") keeps its values.
const firstLine = (s) =>
  String(s ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ")
    .slice(0, 300);

/**
 * Classify one run. `outcome`: { timedOut, timeoutS, exitCode, record } - `record` is what the child wrote
 * ({ outcome: "passed" } or { outcome: "threw", name, code, message }), null when it wrote nothing.
 * @returns {{ result: "still"|"broken-test"|"gone", why: string }}
 */
export function classifyRun({ timedOut = false, timeoutS = null, exitCode = null, record = null } = {}) {
  if (timedOut)
    return {
      result: "broken-test",
      why: `timed out after ${timeoutS ?? "?"} s: a repro that hangs is waiting on a control that is not there, or never closed its browser`,
    };
  if (record?.outcome === "passed") return { result: "gone", why: "every assertion held: the symptom did not show" };
  if (record?.outcome === "threw" && isAssertion(record))
    return { result: "still", why: `the assertion failed: ${firstLine(record.message) || "(no message)"}` };
  if (record?.outcome === "threw")
    return {
      result: "broken-test",
      why: `${record.name || "Error"}: ${firstLine(record.message) || "(no message)"} - not an assertion, so the repro itself is wrong (a missing control, a timeout, a crash)`,
    };
  return {
    result: "broken-test",
    why: `the repro ended the process itself (exit ${exitCode ?? "?"}) before it finished; a repro throws, it never calls process.exit`,
  };
}

/** The entry `confirm` records for a run's result. */
export function confirmEntry({ finding, repro, run, page = null, said = null, problem = null, at = new Date().toISOString() }) {
  const base = {
    finding,
    repro,
    result: run.result,
    why: run.why,
    ...(page ? { page } : {}),
    ...(said ? { said } : {}),
    ...(problem ? { problem } : {}),
  };
  if (run.result === "still") return { ...base, status: "confirmed", at };
  return { ...base, status: "rejected", reason: run.result === "gone" ? "not-reproduced" : "broken-test", at };
}

/** The entry `triage` records. Throws when the bucket is unknown or the reason is not said. */
export function triageEntry({ finding, bucket, why, page = null, said = null, problem = null, at = new Date().toISOString() }) {
  if (!Object.hasOwn(BUCKETS, bucket)) throw new Error(`--bucket is one of ${Object.keys(BUCKETS).join(", ")}, not "${bucket}"`);
  const reason = String(why ?? "").trim();
  if (reason.split(/\s+/).filter(Boolean).length < 3)
    throw new Error(`--why says what settled it, three words at least (the variable, the file or the seed field), not "${reason}"`);
  return {
    finding,
    status: "rejected",
    bucket,
    why: reason,
    ...(page ? { page } : {}),
    ...(said ? { said } : {}),
    ...(problem ? { problem } : {}),
    at,
  };
}

/** The group a rejected entry belongs to: its bucket, else its repro reason. null for a confirmed one. */
export const groupOf = (entry) => (entry?.status === "rejected" ? entry.bucket || entry.reason || null : null);

/** A run's repro.json, as { entries: [...] }; an absent or unreadable file is null. */
export function readLedger(runDir) {
  const file = path.join(runDir, LEDGER_FILE);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return { entries: Array.isArray(parsed?.entries) ? parsed.entries.filter((e) => e && typeof e.finding === "string") : [] };
  } catch {
    return null;
  }
}

/** The latest entry per finding, keyed `<sue folder>:<line>`. An empty map when the run has no repro.json. */
export function ledgerByFinding(runDir) {
  return new Map((readLedger(runDir)?.entries ?? []).map((e) => [e.finding, e]));
}

/** Put one entry into the run's repro.json, replacing that finding's earlier one (kept in its `history`). */
export function recordEntry(runDir, entry) {
  const ledger = readLedger(runDir) ?? { entries: [] };
  const before = ledger.entries.find((e) => e.finding === entry.finding);
  const history = before ? [...(before.history ?? []), { status: before.status, group: groupOf(before), at: before.at }] : [];
  const next = { ...entry, ...(history.length ? { history } : {}) };
  ledger.entries = [...ledger.entries.filter((e) => e.finding !== entry.finding), next];
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, LEDGER_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
  return next;
}

/** The finding a ref names in a run, as the parsed findings.jsonl row; null when that line is absent or not JSON. */
export function findingAt(runDir, ref) {
  const { sue, line } = parseFindingRef(ref);
  let text;
  try {
    text = readFileSync(path.join(runDir, sue, "findings.jsonl"), "utf8");
  } catch {
    return null;
  }
  const raw = text.split(/\r?\n/)[line - 1];
  try {
    const row = JSON.parse(raw);
    return row && typeof row === "object" ? row : null;
  } catch {
    return null;
  }
}

/**
 * The page and words a finding row carries, cut short enough for a ledger entry, plus the typed claim when the
 * row carries one (lib/findings.mjs problemNote), so repro.json and the report name what was proved or rejected.
 */
export function findingFacts(row) {
  const said = String(row?.text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  const facts = { page: typeof row?.url === "string" && row.url.trim() ? row.url.trim() : null, said: said ? said.slice(0, 300) : null };
  const p = row?.problem;
  if (!p || typeof p !== "object") return facts;
  const { title, defect, severity, expected, actual, steps, look } = p;
  return { ...facts, problem: { title, defect, severity, expected, actual, steps, look: look ?? null } };
}

/**
 * What a report shows from a run's repro.json, or null when the run has none: the confirmed findings, and the
 * rejected ones grouped in REJECT_GROUPS order (empty groups left out).
 */
export function reproSections(runDir) {
  const ledger = readLedger(runDir);
  if (!ledger) return null;
  const confirmed = ledger.entries.filter((e) => e.status === "confirmed");
  const rejected = REJECT_GROUPS.map((group) => ({
    group,
    label: GROUP_LABEL[group],
    entries: ledger.entries.filter((e) => groupOf(e) === group),
  })).filter((g) => g.entries.length);
  return { confirmed, rejected };
}
