/**
 * hillclimb.mjs - four things a hillclimb on an eval needs that Dredd's loop lacked, from Anthropic's "Automating eval
 * design and hillclimbing with Claude" (claude.dev, 2026-09-28). Pure functions: eval.mjs runs the models, the hunt
 * reads the files, this module only reads the numbers.
 *
 *   1. GRADER STABILITY  - the judge (Jev) asked the same questions of the same ask twice: how often does it agree
 *      with itself? Judges are where long jobs spend, so it is a SAMPLE, once per suite (`stabilityDue`), never per run.
 *   2. THE MODEL LADDER  - a stronger model must score higher on the gold than a weaker one; when it does not, the
 *      eval is the broken thing, not the models (`ladderReading`).
 *   3. THE HEADROOM RULE - a baseline at or above 95% has nothing left to hillclimb on accuracy: the objective
 *      becomes cost per docket at held-out parity (`headroom`, `costVerdict`).
 *   4. THE STALL MODE    - two or three runs inside the noise band mean the loop is guessing: a mode that makes NO
 *      edit and only buckets the remaining trained misses by root cause (`stalled`, `bucketMisses`).
 */
import { createHash } from "node:crypto";

/** At or above this share of the gold convened right, accuracy is not the objective any more. */
export const HEADROOM_BAR = 0.95;
/** How many asks the grader-stability sample re-asks. */
export const STABILITY_SAMPLE = 12;
/** Under this agreement a judge is too noisy to hillclimb against: the eval says so. */
export const STABILITY_FLOOR = 0.9;
/** The runs a stall is read over: the newest this many, all inside the band of one another. */
export const STALL_RUNS = 3;

/** A deterministic sample: the `n` asks whose id hashes lowest, so the same suite always re-asks the same asks. */
export function sampleAsks(asks, n = STABILITY_SAMPLE) {
  const key = (a) => createHash("sha1").update(String(a.id)).digest("hex");
  return [...asks].sort((a, b) => key(a).localeCompare(key(b))).slice(0, n);
}

/** The suite a stability record belongs to: the decision files and the gold. A new hash makes a new record due. */
export function suiteHash(decisionHash, goldText) {
  return createHash("sha1").update(String(decisionHash)).update(String(goldText)).digest("hex").slice(0, 16);
}

/** Is a grader-stability record owed? Once per suite: no record, or one taken on another suite. */
export function stabilityDue(record, hash) {
  return !record || record.suite !== hash;
}

/**
 * Two gradings of the same saved ask. `pairs` is [{ id, first, second }] of Jev answer maps ({ [questionId]: { answer } }).
 * Agreement is per question (the unit Jev answers) and per ask (every question the same: the number that decides a docket).
 */
export function graderAgreement(pairs) {
  let questions = 0;
  let same = 0;
  let asksSame = 0;
  const flipped = [];
  for (const { id, first, second } of pairs) {
    let askSame = true;
    for (const [q, a] of Object.entries(second || {})) {
      if (!first?.[q] || a?.answer == null) continue;
      questions += 1;
      if (String(first[q].answer) === String(a.answer)) same += 1;
      else {
        askSame = false;
        flipped.push(`${id}:${q}`);
      }
    }
    if (askSame) asksSame += 1;
  }
  const rate = questions ? same / questions : null;
  return {
    asks: pairs.length,
    asksSame,
    questions,
    same,
    rate: rate == null ? null : Math.round(rate * 1000) / 1000,
    flipped: flipped.slice(0, 20),
  };
}

export function stabilityLine(rec) {
  if (!rec || rec.rate == null) return "grader agreement: not measured (eval.mjs --stability)";
  const pct = Math.round(rec.rate * 1000) / 10;
  const verdict =
    rec.rate < STABILITY_FLOOR
      ? ` - UNDER ${STABILITY_FLOOR * 100}%: the judge disagrees with itself, so a move smaller than that is not a result`
      : "";
  return `grader agreement: ${pct}% of ${rec.questions} answers, ${rec.asksSame}/${rec.asks} sampled asks identical twice (taken ${String(rec.at || "").slice(0, 10)})${verdict}`;
}

/**
 * The model ladder. `rungs` is [{ model, score }] ordered weakest first (score = the share of the gold convened right).
 * Every rung must beat the one below it; an equal score is not a separation, so the eval cannot tell the two apart.
 */
export function ladderReading(rungs) {
  const broken = [];
  for (let i = 1; i < rungs.length; i += 1)
    if (!(rungs[i].score > rungs[i - 1].score))
      broken.push(`${rungs[i].model} (${pct(rungs[i].score)}) does not beat ${rungs[i - 1].model} (${pct(rungs[i - 1].score)})`);
  const ladder = rungs.map((r) => `${r.model} ${pct(r.score)}`).join(" < ");
  return broken.length
    ? {
        ok: false,
        line: `model ladder: BROKEN - ${broken.join("; ")}. The eval itself looks broken (a stronger model must score higher on the gold): fix the gold or the grading before trusting any number from it.`,
      }
    : { ok: true, line: `model ladder: ok, ${ladder}` };
}

const pct = (x) => `${Math.round(x * 1000) / 10}%`;

/**
 * The headroom rule. At or above the bar the hunt's objective is cost per docket at held-out parity, and it says so.
 * `baseline` is the share convened right (0..1).
 */
export function headroom(baseline, bar = HEADROOM_BAR) {
  if (baseline == null) return { headroom: false, objective: "accuracy", line: "objective: accuracy (no baseline yet)" };
  if (baseline >= bar)
    return {
      headroom: true,
      objective: "cost",
      line: `objective: COST - the baseline is ${pct(baseline)} (>= ${pct(bar)}), accuracy has no headroom. Hillclimb tokens, cents and wall time per docket at held-out parity; an edit that costs held-out accuracy is dropped.`,
    };
  return {
    headroom: false,
    objective: "accuracy",
    line: `objective: accuracy - the baseline is ${pct(baseline)} (< ${pct(bar)}), there is headroom.`,
  };
}

/**
 * Cost per docket from one run: cents, wall milliseconds and (when the summaries carried them) tokens, over the asks
 * Jev answered. Wall time is the run's own, divided by asks, so a parallel run reads as its throughput cost.
 */
export function costPerDocket({ costUsd = 0, wallMs = 0, tokens = null, asks = 0 }) {
  if (!asks) return { cents: null, wallMs: null, tokens: null };
  return {
    cents: Math.round((costUsd * 100 * 1e4) / asks) / 1e4,
    wallMs: Math.round(wallMs / asks),
    tokens: tokens == null ? null : Math.round(tokens / asks),
  };
}

/**
 * A cost change at held-out parity: kept only when held-out accuracy did not fall (past the noise delta, in asks) and a
 * cost axis fell. `before` and `after` are { heldOut: perfect count, cents, wallMs, tokens }.
 */
export function costVerdict({ before, after, delta = 0 }) {
  if (after.heldOut < before.heldOut - delta)
    return { keep: false, why: `held-out accuracy fell ${before.heldOut} -> ${after.heldOut} asks (band ${delta}): not parity` };
  const axes = ["cents", "wallMs", "tokens"].filter((k) => before[k] != null && after[k] != null);
  const cheaper = axes.filter((k) => after[k] < before[k]);
  const dearer = axes.filter((k) => after[k] > before[k]);
  if (!cheaper.length)
    return { keep: false, why: `no cost axis fell (${axes.map((k) => `${k} ${before[k]} -> ${after[k]}`).join(", ") || "none measured"})` };
  return {
    keep: true,
    why: `held-out parity, cheaper on ${cheaper.join(", ")}${dearer.length ? ` (dearer on ${dearer.join(", ")})` : ""}`,
  };
}

/**
 * A stall: the newest runs' convened-perfect counts all within `delta` of each other (two or three runs). With no band
 * measured a stall cannot be called. `counts` is newest first.
 */
export function stalled(counts, delta, runs = STALL_RUNS) {
  if (delta == null) return false;
  const recent = counts.slice(0, runs);
  if (recent.length < 2) return false;
  return Math.max(...recent) - Math.min(...recent) <= delta;
}

/**
 * The remaining trained misses by root cause, no edit. `rows` is [{ id, misses: [string], convMisses: [string] }] of the
 * TRAINED asks (the held-out quarter is never bucketed: naming it is how it gets tuned to). `unstable` is the noise
 * file's flipped ids, `persistent` the ids wrong in every earlier run.
 */
export function bucketMisses(rows, { unstable = new Set(), persistent = new Set() } = {}) {
  const buckets = new Map();
  const put = (cause, id) => {
    if (!buckets.has(cause)) buckets.set(cause, new Set());
    buckets.get(cause).add(id);
  };
  for (const r of rows) {
    if (!r.convMisses.length) continue;
    if (unstable.has(r.id)) put("noise: flips between runs of unchanged code (not a rule to fix)", r.id);
    for (const m of r.convMisses) {
      if (/^mustNot .* convened/.test(m))
        put("false positive: a question or keyword says yes where the gold says no (bench line too loose)", r.id);
      else if (/^must .* not convened \(p=(0\.[5-9]|1)/.test(m))
        put("docket rule: the question said yes but a threshold, cap or veto kept it out (lib/docket.mjs)", r.id);
      else if (/^must .* not convened/.test(m)) put("recall: the question said no where the gold says yes (bench line too narrow)", r.id);
      else if (/^anyOf/.test(m)) put("recall: none of the acceptable instruments said yes", r.id);
      else put(`other: ${m.split(" ")[0]}`, r.id);
    }
    for (const m of r.misses)
      if (/^(class|domain|scope|delegation) /.test(m))
        put(`classifier: ${m.split(" ")[0]} answered wrong (ask_class/domain/scope/delegation question)`, r.id);
    if (persistent.has(r.id)) put("persistent: wrong in every earlier run (wording has not moved it; read the docket's rules)", r.id);
  }
  return [...buckets.entries()]
    .map(([cause, ids]) => ({ cause, ids: [...ids].sort() }))
    .sort((a, b) => b.ids.length - a.ids.length || a.cause.localeCompare(b.cause));
}

export function renderBuckets(buckets, { stalledNote = "" } = {}) {
  if (!buckets.length) return "DREDD HUNT (bucket mode): no trained misses remain - say so, that is the audit.";
  const lines = [
    `DREDD HUNT (bucket mode${stalledNote}): make NO edit; the remaining trained misses by root cause, biggest first. Pick one cause, read its asks' dockets, then change one thing and A/B it.`,
  ];
  for (const b of buckets) lines.push(`  ${String(b.ids.length).padStart(2)}  ${b.cause}\n      ${b.ids.join(", ")}`);
  return lines.join("\n");
}
