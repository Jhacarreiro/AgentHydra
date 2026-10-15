// dredd/lib/hunt.mjs - Dredd's own ranked self-improvement queue (`node dredd/dredd.mjs --hunt`).
//
// Owner ask (the Chair, 2026-09-23): the Architect's RSI instructions integrated into Dredd; this is `arkitect:hunt`
// pointed at the judge. A self-improvement pass starts here and takes the top item, never a feeling about which part
// is weak. The loop and the A/B every decision change owes: .claude/rules/dredd-self-improvement.md.
//
// What it reads, all local, no model call: the doctor, the last dockets' convene records (an instrument that failed,
// refused or left no evidence), the newest eval runs (gold asks convened wrong, complaint units routed wrong), the A/B
// ledger against git (a decision change landed unmeasured), the gold set against the bench, and SUE's brain memo.
// `rankHunt` is pure; `gatherHunt` is the thin reader around it (tests/rsi.spec.mjs). It is also on the bench
// (`judge-hunt`): a docket about Dredd itself reads it, so its room argues over these measured failures.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { readConveneLog } from "./convene.mjs";
import { findDockets } from "./dockets.mjs";
import { ENGINE_DIR } from "./docket.mjs";
import { decisionHash, fullJevRuns, readNoise } from "./regularizers.mjs";
import { bucketMisses, headroom, renderBuckets, stalled } from "./hillclimb.mjs";
import { holdoutIds } from "./routing.mjs";

/**
 * The files that DECIDE what a docket convenes, which seats sit and when the hook fires: a change to any of them
 * changes every future docket, so it owes the A/B (dredd/ab.mjs) before it lands. Repository-relative globs:
 * a trailing `/` is a folder.
 */
export const DECISION_PATHS = [
  "dredd/bench.json",
  "dredd/lib/claim-routing.mjs",
  "dredd/lib/docket.mjs",
  "dredd/lib/ladder.mjs",
  "dredd/lib/pipeline.mjs",
  "dredd/lib/seats.mjs",
  "dredd/seats/",
];

/** When the A/B policy began: a decision commit before it was never owed a ledger row. */
export const AB_POLICY_SINCE = "2026-09-23T00:00:00Z";

/** Is this repository-relative path one of the decision files? */
export function isDecisionPath(p) {
  const rel = String(p || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "");
  return DECISION_PATHS.some((d) => (d.endsWith("/") ? rel.startsWith(d) : rel === d));
}

/** A convene row that is a failure of the instrument, not a decision: failed, a launch that did not happen, a non-zero
 *  exit. SUE sitting a hearing out by design (no chat, no pinned pool) and a skipped instrument (its `needs` unmet) are
 *  decisions, not defects. */
export function rowFailed(row) {
  const status = String(row?.status || "");
  const note = String(row?.note || "");
  if (/sits? (?:it|this one) out/i.test(note)) return false;
  if (/^skipped/i.test(status) || /^launching$/.test(status)) return false;
  return /^(?:failed|launch failed|launch refused|refused)|ran, exit (?:[1-9]\d*|-1)\b|no exit line/i.test(status);
}

/** The repository files a bench entry promises (`tmp/atlas/bill.md`), as repository-relative paths. */
export function repoEvidence(inst) {
  return [...String(inst?.evidence || "").matchAll(/(?:^|[\s,(])((?:tmp|docs)\/[\w./-]+\.\w+)/g)].map((m) => m[1]);
}

/**
 * The evidence tokens a bench entry promises inside the docket (`{docket}/x.log`), as docket-relative names. Two
 * names joined by a bare "or" are one promise either file keeps, returned as "a|b".
 */
export function docketEvidence(inst) {
  // Every `{docket}/...` token, however the entry joins them ("a, b", "a and b", "a (the log)") - a split on commas
  // alone missed every second file of an "and" list. Sentence punctuation after a name is not part of it: copy-audit's
  // "{docket}/copy-audit/manifest.json; the page's half in ..." had the hunt looking for "manifest.json;" and calling
  // every clean copy-audit run a silent no-op (2026-09-25). LilGranny over a page off the roster writes lilgranny.json
  // instead of the Architect manifest (convene.mjs), and the hunt called that clean run a silent no-op (2026-09-27).
  const text = String(inst?.evidence || "");
  const out = [];
  let end = -1;
  for (const m of text.matchAll(/\{docket\}\/([^\s,();]+)/g)) {
    const name = m[1].replace(/[.:]+$/, "");
    if (out.length && /^\s+or\s+$/.test(text.slice(end, m.index))) out[out.length - 1] += `|${name}`;
    else out.push(name);
    end = m.index + m[0].length;
  }
  return out;
}

const W = {
  doctor: 100,
  failing: 80,
  noEvidence: 72,
  dirtyDecision: 66,
  unmeasured: 65,
  overfit: 62,
  evalMiss: 60,
  staleEval: 58,
  headroom: 61,
  stalled: 59,
  heldOut: 56,
  noEval: 55,
  expertMiss: 52,
  fallback: 50,
  seatNoise: 45,
  noNoise: 40,
  untested: 30,
  idle: 20,
  brain: 10,
};

/**
 * The queue, pure. Every item: { weight, kind, subject, evidence, action } - the ONE action is the point; an item the
 * next reader cannot act on is a notification, not a queue entry. Heaviest first.
 *   doctorRows  - lib/doctor.mjs rows ({ name, ok, detail, needed })
 *   dockets     - [{ dir, rows: convene.jsonl rows, has(rel): does the docket hold that file }], newest first
 *   bench       - the loaded bench ({ instruments })
 *   gold        - eval/asks.json's asks
 *   evalRun     - { file, at (ms), results } of the newest eval run, or null
 *   measured    - Set of commit shas an A/B row covers, plus "parent:<sha>" for a row taken on the tree over <sha>
 *   decisionCommits - [{ sha, at (ms), files }] newest first, commits that touched a decision file
 *   dirtyDecision   - decision files that differ from HEAD in the working tree
 *   sueMemo     - tmp/dredd/sue-brains.json ({ <brain>: { kind, why, at } })
 *   noise       - eval/noise.json (lib/regularizers.mjs noiseBand), or null when the band was never measured
 *   overfitRows - A/B ledger rows of the last 14 days whose `overfit` screen named lines lifted from the gold
 *   keptLines   - "<item>:<phrase>" for every flagged line an A/B kept as the instrument's own vocabulary (ab.mjs --keep)
 *   rejectedRows - A/B ledger rows of changes measured and thrown away (ab.mjs --reject): { at, for: [ask ids], note }
 *   priorRuns   - the full Jev runs before evalRun, newest first ({ file, results }), for regressed / persistent
 *   expertRun   - { file, results } of the newest eval run that routed eval/experts.json through Jev, or null
 *   expertGold  - eval/experts.json's units (their `holdout` marks which are never named)
 */
export function rankHunt({
  doctorRows = [],
  dockets = [],
  bench = { instruments: [] },
  gold = [],
  evalRun = null,
  seatRun = null,
  measured = new Set(),
  decisionCommits = [],
  dirtyDecision = [],
  sueMemo = {},
  noise = null,
  overfitRows = [],
  keptLines = new Set(),
  rejectedRows = [],
  priorRuns = [],
  expertRun = null,
  expertGold = [],
  repoFileExists = () => true,
  now = Date.now(),
} = {}) {
  const items = [];
  const add = (weight, kind, subject, evidence, action) => items.push({ weight, kind, subject, evidence, action });

  for (const r of doctorRows)
    if (!r.ok && r.needed)
      add(
        W.doctor,
        "doctor",
        r.name,
        r.detail,
        "fix the prerequisite; when it is really there, the doctor is wrong - fix lib/doctor.mjs (a false MISSING is a bug in the check)",
      );

  const byId = new Map(bench.instruments.map((i) => [i.id, i]));
  const fails = new Map();
  const silent = new Map();
  const convened = new Map();
  for (const d of dockets) {
    for (const row of d.rows) {
      if (!row?.id) continue;
      convened.set(row.id, (convened.get(row.id) || 0) + 1);
      if (rowFailed(row)) {
        const f = fails.get(row.id) || { n: 0, last: null };
        f.n += 1;
        f.last ??= { dir: d.dir, status: row.status, note: row.note, log: row.log };
        fails.set(row.id, f);
        continue;
      }
      if (/^ran, exit 0\b/.test(String(row.status || ""))) {
        const missing = docketEvidence(byId.get(row.id))
          .filter((f) => !f.split("|").some((alt) => d.has(alt)))
          .map((f) => f.replaceAll("|", " or "));
        if (missing.length) {
          const s = silent.get(row.id) || { n: 0, last: null };
          s.n += 1;
          s.last ??= { dir: d.dir, missing };
          silent.set(row.id, s);
        }
      }
    }
  }
  // The newest run decides: a red in an old docket that a later docket ran clean is history, not a defect (the self-pass's
  // own hearing kept "code-gate failed" on the queue after the red it saw was fixed, 2026-09-23). Dockets are newest first.
  const newest = new Map();
  for (const d of dockets) for (const row of d.rows) if (row?.id && !newest.has(row.id)) newest.set(row.id, row);
  for (const [id, f] of fails) {
    if (!rowFailed(newest.get(id))) continue;
    add(
      W.failing + Math.min(f.n, 15),
      "instrument failed",
      id,
      `${f.n} docket(s); latest ${f.last.dir}: "${String(f.last.status).slice(0, 120)}"${f.last.note ? ` - ${String(f.last.note).slice(0, 160)}` : ""}`,
      `read ${f.last.log || `${f.last.dir}/${id}.log`}; fix the runner or its bench \`run\` line, or make a by-design refusal say so in its note`,
    );
  }
  // A repository file the bench promises that does not exist at all, from an instrument that has run clean: the bill's
  // runner never landed on trunk and `atlas:bill` printed the Atlas help and exited 0 (2026-09-23).
  for (const id of convened.keys()) {
    if (fails.has(id)) continue;
    const never = repoEvidence(byId.get(id)).filter((f) => !repoFileExists(f));
    const ranClean = dockets.some((d) => d.rows.some((r) => r.id === id && /^ran, exit 0\b/.test(String(r.status || ""))));
    if (ranClean && never.length) {
      const s = silent.get(id) || { n: 0, last: { dir: "every docket", missing: [] } };
      s.n = Math.max(s.n, 1);
      s.last.missing = [...new Set([...s.last.missing, ...never])];
      silent.set(id, s);
    }
  }
  for (const [id, s] of silent)
    add(
      W.noEvidence + Math.min(s.n, 10),
      "ran clean, left no evidence",
      id,
      `${s.n} docket(s) exited 0 without ${s.last.missing.join(", ")} (latest ${s.last.dir})`,
      "an exit 0 with no evidence is a silent no-op: make the runner write what bench.json promises, or fail loudly",
    );

  for (const f of dirtyDecision)
    add(
      W.dirtyDecision,
      "decision change in progress",
      f,
      "differs from HEAD in the working tree",
      "node dredd/ab.mjs --record, before it lands (the A/B policy)",
    );
  // One item, not one per commit: the A/B from the oldest unmeasured commit's parent measures them together, and a
  // queue of forty identical rows buries everything else (the first hunt, 2026-09-23). The policy starts the day it
  // was written; what landed before it was never owed a row.
  // Measured is a fact about GIT, not about clocks: a row recorded before landing (the policy's own order) is older than
  // the commit it measured, so "newer than the last row" called every properly measured change unmeasured (the first
  // checkpoint, 2026-09-23). `measured` holds the commits a retroactive row's base..head range covers, and "parent:<sha>"
  // for a row taken on the working tree over <sha> - the commit whose parent that is, is the change it measured.
  const since = Date.parse(AB_POLICY_SINCE);
  // ...and by BYTES: `bun run save` builds the commit on origin's tip, not on the HEAD the A/B measured, so neither the
  // sha nor the parent matches a properly measured change in this repo; a row that names the blobs it measured does.
  const sameBytes = (c) => c.blobs && c.files.length && c.files.every((f) => c.blobs[f] && measured.has(`blob:${f}@${c.blobs[f]}`));
  const unmeasured = decisionCommits.filter(
    (c) => c.at > since && !measured.has(c.sha) && !(c.parent && measured.has(`parent:${c.parent}`)) && !sameBytes(c),
  );
  if (unmeasured.length) {
    const oldest = unmeasured[unmeasured.length - 1];
    const files = [...new Set(unmeasured.flatMap((c) => c.files))];
    add(
      W.unmeasured,
      "decision change landed unmeasured",
      `${unmeasured.length} commit(s)`,
      `${unmeasured.map((c) => c.sha.slice(0, 10)).join(", ")} touched ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""} with no A/B row covering them`,
      `node dredd/ab.mjs --base ${oldest.sha.slice(0, 10)}~1 --record`,
    );
  }

  // A line an A/B saw lifted from the gold (lib/regularizers.mjs leakageSuspects, run by ab.mjs on every bench or seat
  // change): it scores the ask it copied and nothing like it, the loop the RRSI critic exists to stop. A flag is done
  // once the bench line no longer carries the phrase (rewritten), or once an A/B kept it as the instrument's own
  // vocabulary with a reason (ab.mjs --keep); until then it stays on the queue for its two weeks.
  const stillInBench = (s) => {
    if (!String(s.item).startsWith("bench/")) return true;
    const inst = (bench?.instruments || []).find((i) => i.id === String(s.item).slice("bench/".length));
    // The line of the flag's own kind: a flagged keyword is gone when the keyword is, even if its words are still in
    // the jev question (the Legal room's question names "privacy policy" as a thing a legal question can be about).
    const phrase = String(s.phrase).toLowerCase();
    if (s.kind === "jev")
      return String(inst?.jev || "")
        .toLowerCase()
        .includes(phrase);
    return (inst?.keywords || []).some((k) => String(k).toLowerCase() === phrase);
  };
  for (const row of overfitRows)
    for (const s of row.overfit || []) {
      if (keptLines.has(`${s.item}:${s.phrase}`) || !stillInBench(s)) continue;
      add(
        W.overfit + (s.heldOut?.length ? 3 : 0),
        s.heldOut?.length ? "line lifted from a HELD-OUT ask" : "line lifted from a gold ask",
        `${s.item} ${s.kind}`,
        `"${s.phrase}" is verbatim in ${s.gold.join(", ")} (A/B of ${String(row.at || "").slice(0, 10)})`,
        `say the mechanism instead of the ask's words (a line that only matches the ask it came from is memorized gold), then node dredd/ab.mjs --record${s.heldOut?.length ? "; a held-out ask's words in a line spoil the held-out check until the line is rewritten" : ""}; or, when the words are the instrument's own vocabulary, --keep "${s.item}:${s.phrase}" --note "<why>"`,
      );
    }

  // The band a full Jev eval is read through (eval.mjs prints every move against it). Without it, "compare the tally
  // with the last run's" cannot tell a result from a coin.
  const noiseAgeDays = noise?.at ? (now - Date.parse(noise.at)) / 86_400_000 : null;
  if (!noise || noiseAgeDays > 30)
    add(
      W.noNoise,
      noise ? "noise band stale" : "no noise band",
      "eval",
      noise
        ? `eval/noise.json was measured ${Math.round(noiseAgeDays)} day(s) ago`
        : "eval/noise.json is missing: the same two sentences scored 55/55 and 51/55 in two orders (2026-09-23), and nothing says how far a full eval moves on unchanged code",
      "node dredd/eval.mjs --noise 3 (three Jev runs of the unchanged judge over the asks, the seat pick and the expert routing, cents each), then land eval/noise.json",
    );

  if (!evalRun)
    add(
      W.noEval,
      "never measured here",
      "eval",
      "no tmp/dredd/eval-*/results.json on this machine",
      "node dredd/eval.mjs --heuristic-only (free), then the full run (cents)",
    );
  else {
    const newestDecision = Math.max(0, ...decisionCommits.map((c) => c.at));
    if (newestDecision > evalRun.at)
      add(
        W.staleEval,
        "eval older than the judge",
        "eval",
        `${evalRun.file} predates the last decision commit`,
        "re-run node dredd/eval.mjs (or --replay the saved answers)",
      );
    const arms = Object.keys(evalRun.results?.arms || {});
    const arm = arms.includes("jev") ? "jev" : arms[0];
    // The held-out quarter (lib/routing.mjs isHeldOut) is never named here. The queue is what a fixer tunes bench lines
    // against, so naming a held-out miss hands its words to the next rewrite and spoils the one check that can tell a
    // general fix from a memorized ask - the routing half already kept it blind; this queue did not (RRSI, 2026-09-27:
    // the unregularized loop scored best on its own set and +0.6 out of it). Its misses are counted, never listed.
    const held = holdoutIds(gold);
    const graded = (evalRun.results?.rows || []).filter((r) => r.arms?.[arm]?.s);
    const wrong = (r) => r.arms[arm].s.convMisses?.length;
    const rows = graded.filter((r) => wrong(r) && !held.has(r.id));
    const unstable = new Map((noise?.unstable || []).map((u) => [u.id, u]));
    // SkillOpt's slow update (2026-09-27): each miss read against the earlier full runs. An ask right last run and
    // wrong now REGRESSED - a change broke it, the most urgent kind. One wrong in every earlier run too is PERSISTENT -
    // wording rewrites have not moved it, so the cause is more likely a docket rule or the gold. And every change
    // already tried on it and thrown away is named, so the next fixer does not redraw it (RRSI's negative-result history,
    // SkillOpt's rejected-edit buffer).
    const priorFor = (id) =>
      arm === "jev" ? priorRuns.map((p) => (p.results?.rows || []).find((x) => x.id === id)?.arms?.jev?.s).filter(Boolean) : [];
    for (const r of rows.slice(0, 12)) {
      const u = unstable.get(r.id);
      const prior = priorFor(r.id);
      const regressed = prior.length > 0 && !prior[0].convMisses?.length;
      const persistent = prior.length >= 2 && prior.every((s) => s.convMisses?.length);
      const tried = rejectedRows.filter((x) => (x.for || []).includes(r.id)).slice(-2);
      add(
        W.evalMiss - (u ? 5 : 0) + (regressed ? 4 : 0) - (persistent ? 2 : 0),
        `gold ask convened wrong (${arm})${regressed ? ", REGRESSED" : persistent ? ", persistent" : ""}`,
        r.id,
        `${r.arms[arm].s.convMisses.join("; ")} - convened ${(r.arms[arm].convene || []).join(",") || "nothing"}${u ? ` (flipped between runs of unchanged code in ${u.flips} of ${u.pairs} calibration pair(s): maybe noise, not a rule)` : ""}${regressed ? " - right in the run before this one" : persistent ? ` - wrong in all ${prior.length} earlier runs too` : ""}${tried.map((t) => `; tried and rejected ${String(t.at || "").slice(0, 10)}: ${t.note}`).join("")}`,
        persistent
          ? "wording has not moved it: read decideDocket's rules for this ask (scope, the focused cap, the forced rungs) and the gold itself before another question rewrite"
          : "rewrite the bench question or keywords that misfired (or BARS) in general terms, never the ask's own words, then node dredd/ab.mjs --record",
      );
    }
    if (rows.length > 12)
      add(W.evalMiss - 1, "more gold misses", `${rows.length - 12} more`, evalRun.file, "work the ones above first; re-run the eval");
    const heldRows = graded.filter((r) => held.has(r.id));
    const heldWrong = heldRows.filter(wrong).length;
    if (heldWrong) {
      const share = (list) => `${list.filter((r) => !wrong(r)).length}/${list.length}`;
      add(
        W.heldOut,
        `held-out asks convened wrong (${arm})`,
        `${heldWrong} of ${heldRows.length}`,
        `not named: they are the overfitting check. Convened perfect, trained ${share(graded.filter((r) => !held.has(r.id)))} vs held-out ${share(heldRows)}`,
        "fix the trained misses above with lines that say the mechanism; a trained number that rises while the held-out one does not is the bench memorizing its gold",
      );
    }
    // The headroom rule (Anthropic, "Automating eval design and hillclimbing with Claude", 2026-09-28): at 95% convened
    // right there is nothing left to climb on accuracy, so the objective moves to cost at held-out parity.
    const jevTally = evalRun.results?.arms?.jev;
    const nAsks = (evalRun.results?.rows || []).length;
    const room = jevTally && nAsks ? headroom(jevTally.convPerfect / nAsks) : null;
    if (room?.headroom)
      add(
        W.headroom,
        "headroom: objective is cost",
        "eval",
        room.line,
        "hillclimb cost per docket (tokens, cents, wall time in eval-latest.json) at held-out parity; lib/hillclimb.mjs costVerdict keeps or drops an edit",
      );
    // A stall: two or three full runs within the noise band. More edits are coin flips; bucket the misses instead.
    const tallies = [evalRun, ...priorRuns].map((r) => r.results?.arms?.jev?.convPerfect).filter((n) => n != null);
    if (arm === "jev" && stalled(tallies, noise?.metrics?.convPerfect?.delta))
      add(
        W.stalled,
        "stalled: runs within the noise band",
        "eval",
        `the last ${Math.min(tallies.length, 3)} full Jev runs convened ${tallies.slice(0, 3).join(", ")} perfect, inside the band of ${noise.metrics.convPerfect.delta}`,
        "node dredd/dredd.mjs --hunt --bucket and make NO edit: bucket the remaining trained misses by root cause, then pick one cause",
      );
    if (evalRun.results?.jevFallbacks)
      add(
        W.fallback,
        "jev fell back",
        "eval",
        `${evalRun.results.jevFallbacks} item(s) graded the keywords, not Jev`,
        "fix Jev's reach (node dredd/dredd.mjs --doctor --live: the shared HSwarm server on 127.0.0.1:7793, its TypeSafe key pool) and re-run",
      );
  }

  // A room that seats more critics than the gold asked for, more than one per brief: every extra seat is a model call
  // and a voice the room has to talk over (the first A/B, 2026-09-23: the minds room, new that day, sat 28 extras on
  // 11 briefs while every other room held at 4).
  const seatArms = seatRun?.results?.seats?.arms || {};
  const seatArm = Object.keys(seatArms).some((k) => k.startsWith("jev:")) ? "jev" : "heuristic";
  // The seats a room CHOSE beyond its own two-seat minimum (`extraBeyondMin`, eval.mjs): every minds brief's gold seats
  // one mind, so a plain extra count reached one per brief by construction and the hunt flagged the minimum itself
  // (the Dredd self-pass, 2026-09-23). An older run without the field is read the old way.
  for (const [key, t] of Object.entries(seatArms)) {
    const room = key.startsWith(`${seatArm}:`) ? key.slice(seatArm.length + 1) : null;
    const chosen = t?.extraBeyondMin ?? t?.extra;
    if (!room || room === "holdout" || !t?.n || chosen / t.n < 1) continue;
    add(
      W.seatNoise,
      `room seats too many (${seatArm})`,
      room,
      `${chosen} seat(s) beyond the room's minimum over ${t.n} brief(s) in ${seatRun.file}`,
      `tighten that room's seat questions or SIT (lib/seats.mjs, dredd/seats/), then node dredd/ab.mjs --record`,
    );
  }

  // The expert homework's routing (lib/claim-routing.mjs) the same way as the asks: every trained gold unit Jev's routing
  // did not send exactly to the experts it wants, by name, with the misses the eval wrote; the held-out units counted
  // and never named, the asks' rule (RRSI, 2026-09-27). Who leads or who is missing is the seats' questions; extras and
  // the count are ROUTE_SIT and ROUTE_MAX, swept free on the run's saved answers.
  const expertRows = (expertRun?.results?.experts?.rows || []).filter((r) => r.arms?.jev?.s);
  if (expertRows.length) {
    const heldUnits = new Set(expertGold.filter((u) => u.holdout).map((u) => u.id));
    const off = (r) => !r.arms.jev.s.exact;
    const trainedOff = expertRows.filter((r) => off(r) && !heldUnits.has(r.id));
    for (const r of trainedOff.slice(0, 8)) {
      const { s, routed = [] } = r.arms.jev;
      const tried = rejectedRows.filter((x) => (x.for || []).includes(r.id)).slice(-2);
      add(
        W.expertMiss,
        "gold unit routed wrong (jev)",
        r.id,
        `${s.misses.length ? s.misses.join("; ") : `extra ${s.extra.join(", ")}`} - routed ${routed.join(",") || "nobody"}${tried.map((t) => `; tried and rejected ${String(t.at || "").slice(0, 10)}: ${t.note}`).join("")}`,
        `a wrong lead or a missing expert is the seat questions (dredd/seats/, one at a time, a full Jev eval each, read on the hearings' seat pick too: the same question seats them) or routeSeats' order; extras are ROUTE_SIT or ROUTE_MAX (lib/claim-routing.mjs): sweep node dredd/eval.mjs --experts-only --replay ${expertRun.file} (free), then node dredd/ab.mjs --record`,
      );
    }
    if (trainedOff.length > 8)
      add(W.expertMiss - 1, "more units routed wrong", `${trainedOff.length - 8} more`, expertRun.file, "work the ones above first");
    const heldRows = expertRows.filter((r) => heldUnits.has(r.id));
    const heldOff = heldRows.filter(off).length;
    if (heldOff) {
      const exact = (list) => `${list.filter((r) => !off(r)).length}/${list.length}`;
      add(
        W.expertMiss - 1,
        "held-out units routed wrong (jev)",
        `${heldOff} of ${heldRows.length}`,
        `not named: they are the overfitting check. Routed exactly, trained ${exact(expertRows.filter((r) => !heldUnits.has(r.id)))} vs held-out ${exact(heldRows)}`,
        "fix the trained misses above with lines that say the mechanism; trained units rising while the held-out ones stay put is the routing memorizing its gold",
      );
    }
  }

  const named = new Set(gold.flatMap((a) => [...(a.must || []), ...(a.anyOf || []), ...(a.mustNot || [])]));
  for (const inst of bench.instruments) {
    if (!inst.jev) continue;
    if (!named.has(inst.id))
      add(
        W.untested,
        "no gold ask names it",
        inst.id,
        "eval/asks.json never says it must or must not sit",
        "add a gold ask in the owners' register that names it, then run the eval",
      );
    if (dockets.length >= 20 && !convened.has(inst.id))
      add(
        W.idle,
        "never convened",
        inst.id,
        `0 of the last ${dockets.length} dockets`,
        "is its question wrong, or is it dead weight? read `bun run subtract` before keeping it",
      );
  }

  for (const [brain, m] of Object.entries(sueMemo || {}))
    if (m?.kind === "brain" && now - Date.parse(m.at || 0) < 24 * 3600 * 1000)
      add(
        W.brain,
        "SUE brain refused",
        brain,
        String(m.why || "").slice(0, 160),
        "a pinned key pool with no balance: unpin it (DREDD_SUE_BRAINS) or convene from a chat",
      );

  return items.sort((a, b) => b.weight - a.weight || String(a.subject).localeCompare(String(b.subject)));
}

function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return r.status === 0 ? String(r.stdout) : "";
}

/**
 * The newest eval run on disk: { file, at, results } or null. Stamps sort chronologically. With `hash` (the decision
 * files' decisionHash), the newest run OF THOSE FILES wins: a run measured on a change that was then thrown away is
 * not the judge (2026-09-27: the hunt read a rejected SUE rewrite's 53/59 as the judge's score). Any run when none is.
 */
export function newestEvalRun(root, need = "asks", { hash = null } = {}) {
  return (hash && newestEvalRunOf(root, need, hash)) || newestEvalRunOf(root, need, null);
}

function newestEvalRunOf(root, need, hash) {
  const dir = path.join(root, "tmp", "dredd");
  if (!existsSync(dir)) return null;
  const runs = readdirSync(dir)
    .filter((f) => /^eval-\d{8}T?\d+/.test(f) && existsSync(path.join(dir, f, "results.json")))
    .sort()
    .reverse();
  // The asks: the newest run that graded Jev (the judge a docket actually uses) wins over a newer keyword-only one - the
  // A/B writes keyword runs into this folder every time it measures, and the fallback's misses are not the judge's.
  // A partial run (--only, --limit, a replay that skipped asks it had no answers for) is a spot check, never the judge's
  // scorecard: the self-pass's own nine-ask --only check would have become the hunt's whole view of the gold (2026-09-23).
  // The seats the same way: Jev picks a hearing's seats, and a keyword-only run's seat picks are the fallback's (every A/B
  // wrote one, and the hunt read its heuristic minds room as the judge's noise the next minute - 2026-09-23).
  for (const r of runs) {
    const file = path.join(dir, r, "results.json");
    const results = readJsonSafe(file, null);
    if (results?.partial || (hash && results?.decisionHash !== hash)) continue;
    const graded =
      need === "asks"
        ? results?.rows?.length && results.rows[0]?.arms?.jev
        : need === "experts"
          ? results?.experts?.rows?.some((r) => r.arms?.jev?.s)
          : results?.seats?.rows?.length && Object.keys(results.seats.arms || {}).some((k) => k.startsWith("jev:"));
    if (graded) return { file: path.relative(root, file).replace(/\\/g, "/"), at: statSync(file).mtimeMs, results };
  }
  for (const r of runs) {
    const file = path.join(dir, r, "results.json");
    const results = readJsonSafe(file, null);
    // A --seats-only or --ballots-only run holds no asks: it says nothing about what a docket convenes (and an
    // --asks-only run says nothing about the seats).
    if (results?.partial || (hash && results?.decisionHash !== hash)) continue;
    // The experts are graded by Jev or not at all: a keyword-only routing is the fallback's, and the A/B writes one.
    if (need === "experts") continue;
    if (need === "seats" ? results?.seats?.rows?.length : results?.rows?.length)
      return { file: path.relative(root, file).replace(/\\/g, "/"), at: statSync(file).mtimeMs, results };
  }
  return null;
}

/** Commits that touched a decision file, newest first: [{ sha, at, parent, files, blobs }] from `--format=@@%H|%cI|%P`
 *  with `--name-only` (a bare path per line) or `--raw --no-abbrev` (`:mode mode old new M<TAB>path`, which also gives the
 *  blob each file landed as - the bytes an A/B row is matched on). */
export function decisionCommitsFrom(logText) {
  const out = [];
  let cur = null;
  for (const line of String(logText || "").split(/\r?\n/)) {
    const head = /^@@(\w+)\|([^|]+)(?:\|(\w*))?/.exec(line);
    if (head) {
      cur = { sha: head[1], at: Date.parse(head[2]), parent: head[3] || null, files: [], blobs: {} };
      out.push(cur);
      continue;
    }
    if (!cur || !line.trim()) continue;
    const raw = /^:\d+ \d+ \w+ (\w+) \w+\t(.+)$/.exec(line);
    const file = raw ? raw[2].trim() : line.trim();
    if (!isDecisionPath(file)) continue;
    cur.files.push(file);
    if (raw) cur.blobs[file] = raw[1];
  }
  return out.filter((c) => c.files.length);
}

export const AB_LEDGER = path.join(ENGINE_DIR, "eval", "ab-ledger.jsonl");
/** The noise band of record (eval.mjs --noise writes it; eval.mjs and the hunt read it). */
export const NOISE_FILE = path.join(ENGINE_DIR, "eval", "noise.json");

export function readLedger(file = AB_LEDGER) {
  try {
    return readFileSync(file, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

/** Read everything rankHunt needs from `root`. `doctorRows` is passed in (dredd.mjs already has the bench). */
export function gatherHunt(root, { bench, gold, doctorRows = [], limit = 60 } = {}) {
  const dockets = findDockets(root, { limit }).map((dir) => ({
    dir: path.relative(root, dir).replace(/\\/g, "/"),
    rows: readConveneLog(dir),
    has: (rel) => existsSync(path.join(dir, rel)),
  }));
  const log = git(root, ["log", "-n", "40", "--format=@@%H|%cI|%P", "--raw", "--no-abbrev", "--", ...DECISION_PATHS]);
  // What the ledger's rows cover, by git ancestry (see rankHunt): a range row covers base..head; a row taken on the
  // working tree over a commit (base == head) covers the commit that landed on top of it.
  const measured = new Set();
  const ledger = readLedger();
  const fortnight = Date.now() - 14 * 86_400_000;
  const overfitRows = ledger.filter((row) => row?.overfit?.length && Date.parse(row.at || 0) > fortnight);
  const keptLines = new Set(ledger.flatMap((row) => (row?.kept || []).map((k) => `${k.item}:${k.phrase}`)));
  const rejectedRows = ledger.filter((row) => row?.rejected);
  const hash = decisionHash(root, DECISION_PATHS);
  const evalRun = newestEvalRun(root, "asks", { hash });
  // Strictly older runs: a newer one exists when the newest of THESE decision files is not the newest run on disk (a
  // run of a thrown-away change), and "the run before" must mean before. Stamped folder names sort by time.
  const priorRuns = evalRun
    ? fullJevRuns(root, { limit: 12 })
        .filter((p) => p.file.replace(/\\/g, "/") < evalRun.file)
        .slice(0, 4)
    : [];
  for (const row of ledger) {
    if (row?.rejected) continue; // a thrown-away change measured nothing that landed
    for (const [f, blob] of Object.entries(row?.blobs || {})) if (blob) measured.add(`blob:${f}@${blob}`);
    if (!row?.base) continue;
    if (!row.head || row.head === row.base) measured.add(`parent:${row.base}`);
    else
      for (const sha of git(root, ["rev-list", `${row.base}..${row.head}`])
        .split(/\r?\n/)
        .filter(Boolean))
        measured.add(sha);
  }
  const dirty = git(root, ["status", "--porcelain", "--", ...DECISION_PATHS])
    .split(/\r?\n/)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);
  return {
    doctorRows,
    dockets: dockets.filter((d) => d.rows.length),
    bench,
    gold,
    evalRun,
    seatRun: newestEvalRun(root, "seats", { hash }),
    measured,
    decisionCommits: decisionCommitsFrom(log),
    dirtyDecision: dirty,
    sueMemo: readJsonSafe(path.join(root, "tmp", "dredd", "sue-brains.json"), {}),
    noise: readNoise(NOISE_FILE),
    overfitRows,
    keptLines,
    rejectedRows,
    priorRuns,
    expertRun: newestEvalRun(root, "experts", { hash }),
    expertGold: readJsonSafe(path.join(ENGINE_DIR, "eval", "experts.json"), { units: [] }).units || [],
    repoFileExists: (f) => existsSync(path.join(root, f)),
  };
}

export function renderHunt(items, { top = 25 } = {}) {
  if (!items.length) return "DREDD HUNT: nothing to improve that the judge can see - say so, that statement is itself the audit.";
  const lines = [`DREDD HUNT: ${items.length} item(s), heaviest first - take the top one (.claude/rules/dredd-self-improvement.md)`];
  for (const [i, it] of items.slice(0, top).entries()) {
    lines.push(`${String(i + 1).padStart(2)}. [${it.kind}] ${it.subject} - ${it.evidence}`);
    lines.push(`    -> ${it.action}`);
  }
  if (items.length > top) lines.push(`... and ${items.length - top} more (--json for all)`);
  return lines.join("\n");
}

/**
 * The stall mode of the hunt (`--hunt --bucket`): NO edit, no write. The newest full run's remaining TRAINED misses
 * (the held-out quarter is never bucketed: naming it is how it gets tuned to) by root cause, with the noise file's
 * flippers and the persistent misses marked. `gathered` is gatherHunt's return, `gold` the asks.
 */
export function huntBuckets(gathered, gold) {
  const { evalRun, priorRuns = [], noise } = gathered;
  if (!evalRun) return "DREDD HUNT (bucket mode): no eval run on this machine; run node dredd/eval.mjs first.";
  const arm = evalRun.results?.arms?.jev ? "jev" : Object.keys(evalRun.results?.arms || {})[0];
  const held = holdoutIds(gold);
  const sOf = (run, id) => (run.results?.rows || []).find((x) => x.id === id)?.arms?.[arm]?.s;
  const rows = (evalRun.results?.rows || [])
    .filter((r) => r.arms?.[arm]?.s && !held.has(r.id))
    .map((r) => ({ id: r.id, misses: r.arms[arm].s.misses || [], convMisses: r.arms[arm].s.convMisses || [] }));
  const persistent = new Set(
    arm === "jev" && priorRuns.length >= 2
      ? rows.filter((r) => priorRuns.every((p) => sOf(p, r.id)?.convMisses?.length)).map((r) => r.id)
      : [],
  );
  const unstable = new Set((noise?.unstable || []).map((u) => u.id));
  const counts = [evalRun, ...priorRuns].map((r) => r.results?.arms?.jev?.convPerfect).filter((n) => n != null);
  const note = stalled(counts, noise?.metrics?.convPerfect?.delta) ? ", stalled inside the noise band" : "";
  return renderBuckets(bucketMisses(rows, { unstable, persistent }), { stalledNote: note });
}
