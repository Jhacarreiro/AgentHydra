#!/usr/bin/env bun
// bun, not node: this script's import chain reaches a .ts module, which plain node cannot load.
/**
 * dredd/eval.mjs - does the judge judge right? Every ask in eval/asks.json through Jev (the measured
 * cascade) AND the keyword heuristic, scored against the hand-written gold; then every evidence brief in
 * eval/seats.json through the seat pick, both arms, scored the same way.
 *
 * Owner ask (the Chair, 2026-09-21): "run the entirety of Dredd against itself ... tear itself apart."
 * A judge that is never measured is a vibe. This is the instrument: class accuracy, domain accuracy,
 * delegation agreement where the gold names a tier, and the gold instruments graded twice per arm - once on
 * the classifier's raw yes (p >= 0.5, the number a bench question or keyword is tuned against) and once on
 * what the docket actually CONVENES (decideDocket: the scope thresholds, the focused cap, the boardroom veto
 * and the forced rungs), because the first number alone graded something Dredd never does (Opus 5.5 review,
 * 2026-09-22: 38/44 must by p against 28/44 convened). Every miss is named so it can be fixed.
 * The seat half (2026-09-22, after the first unattended hearing seated all six product critics on one brief):
 * must-sit recall counting only the seats a judgment put in (a seat the hearing forces is not scored, and one
 * topped up to the minimum is counted apart), must-not precision, extras and exact rosters, per arm, per room
 * and over the held-out briefs, so a seat's question or SIT (lib/seats.mjs) is tuned against a number.
 * Results land in tmp/dredd/eval-<stamp>/results.json; the summary prints.
 *
 *   bun dredd/eval.mjs                  all three parts, both arms: every ask x (4 standing questions + one per
 *                                             bench instrument with a jev line) and every brief x the seats of its room
 *                                             go to Jev (the run prints the count; cents, not dollars); the ballot's void
 *                                             rule over eval/ballots.json is pure and free, and the member goals run
 *                                             beside them (their Jev arm adds the roster's questions per goal)
 *   bun dredd/eval.mjs --heuristic-only
 *   bun dredd/eval.mjs --asks-only | --seats-only | --ballots-only | --claims-only | --dismissals-only | --members-only
 *     | --experts-only
 *                                             one or more: two together run just those two parts
 *                                             --claims-only: the claims check against eval/claims.json, the proposals a
 *                                             page's own recorded rulings refuse (lib/rulings.mjs); pure and free
 *                                             --dismissals-only: the code review's disproof rules against
 *                                             eval/dismissals.json, the dismissals a person would take or refuse
 *                                             (lib/review.mjs); pure and free, and part of every default eval
 *                                             --members-only: the member roster (member-bench.json) against
 *                                             eval/member-goals.json, each goal through the keywords
 *                                             (memberHeuristicAnswers, pure and free) and, unless --heuristic-only,
 *                                             through Jev over the roster's questions the way dredd.mjs --member asks
 *                                             them; must recall, mustNot precision, exact goals, every miss named
 *                                             --experts-only: the expert-homework routing (lib/claim-routing.mjs) against
 *                                             eval/experts.json, each complaint unit through every seat's Jev question
 *                                             the way a docket routes it (answerUnit, routeSeats) and through the
 *                                             keywords: the wanted experts routed, the first one routed wanted, the
 *                                             must-nots kept out, extras and exact units. Every seat's p is saved, so
 *                                             `--experts-only --replay <run>` re-routes from them for free: a change to
 *                                             ROUTE_SIT, ROUTE_MAX or routeSeats is measured on the same answers (ab.mjs's
 *                                             "experts replayed" arm)
 *   bun dredd/eval.mjs --limit 8 --only pricing-copy,ugly-button
 *   bun dredd/eval.mjs --ratings         looking back, no Jev: every docket this machine filed, how many the chats
 *                                             that received them rated, and per instrument right / unneeded / wrong /
 *                                             not-run / missed, with what to fix (lib/ratings.mjs)
 *   bun dredd/eval.mjs --verdicts        the asks half over eval/verdicts/ instead of asks.json: the dockets chats
 *                                             rated wrong, as test cases. Chat-labelled, so a column of its own - never
 *                                             merged into the hand-written gold set (dredd.mjs --rate writes them)
 *   bun dredd/eval.mjs --asks-only --replay tmp/dredd/eval-<stamp>/results.json
 *                                             re-score the asks from that run's saved Jev answers: free, and the same
 *                                             classifier answers, so only decideDocket's rules can move the number
 *   bun dredd/eval.mjs --routing-only [--min-rank1 0.8]
 *                                             the bench's own words with no model (lib/routing.mjs): any two instruments
 *                                             whose lines collide fail the run, each gold ask is ranked against every
 *                                             instrument's lines, and --min-rank1 is the ratchet the rank-1 ratio may
 *                                             not fall below. Runs free inside every full eval too
 *   bun dredd/eval.mjs --routing-brief  the blinded rewrite brief: the training asks each instrument lost or stole,
 *                                             never the held-out quarter or its score
 *   bun dredd/eval.mjs --routing-against <candidate-bench.json>
 *                                             a rewritten bench judged on the held-out asks the brief never showed: keep
 *                                             or discard, with only the training numbers printed, so the next rewrite
 *                                             is still blind to the holdout
 *   bun dredd/eval.mjs --noise [N]      the noise band (lib/regularizers.mjs, RRSI's calibration): N fresh Jev runs of
 *                                             the UNCHANGED judge over the asks, the seat pick and the expert routing
 *                                             (cents each), then a band per half from every saved Jev run of these exact
 *                                             decision files that graded it (the seats per room, the routing per unit),
 *                                             written to eval/noise.json. Every Jev run after it prints each half's move
 *                                             from the last run and its gap to the best run on record against that band:
 *                                             a move inside it is not a result.
 *
 *   bun dredd/eval.mjs --stability     grader stability, forced: a SAMPLE of asks re-asked of Jev, the agreement with its
 *                                             first answers written to eval/noise.json (lib/hillclimb.mjs). A full Jev eval
 *                                             does it by itself once per suite (decision files + gold), never every run
 *   bun dredd/eval.mjs --ladder weak,strong
 *                                             the model-ladder sanity check: the gold through two typed models
 *                                             (DREDD_JEV_MODEL), weakest first; the stronger must score higher or the eval
 *                                             itself looks broken (exit 1). Recorded in eval/noise.json
 *
 * Every full Jev eval also prints the headroom rule (baseline >= 95% convened right: the objective becomes cost per docket
 * at held-out parity) and the cost per docket, and writes tmp/dredd/eval-latest.json for .rsi/rsi.yaml.
 *
 * The held-out quarter of the asks (lib/routing.mjs isHeldOut) is graded and saved like every ask, but its rows are
 * never printed: the fixer reads this output, and a held-out miss it can read is a held-out ask it will tune a line
 * to (RRSI, 2026-09-27). Its tally prints beside the trained asks' - the gap between the two is the overfitting.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { groundedIn } from "./lib/ballot.mjs";
import { checkClaims } from "./lib/claims.mjs";
import { pageRulings } from "./lib/rulings.mjs";
import { closeBrain } from "./lib/brain.mjs";
import {
  BARS,
  buildMemberQuestions,
  buildQuestions,
  decideDocket,
  extractUrl,
  heuristicAnswers,
  loadBench,
  loadMemberBench,
  memberHeuristicAnswers,
  mergeAnswers,
  pYes,
} from "./lib/docket.mjs";
import {
  STABILITY_SAMPLE,
  costPerDocket,
  graderAgreement,
  headroom,
  ladderReading,
  sampleAsks,
  stabilityDue,
  stabilityLine,
  suiteHash,
} from "./lib/hillclimb.mjs";
import { answerUnit, ROUTE_MAX, ROUTE_SIT, routeSeats, unitBrief } from "./lib/claim-routing.mjs";
import { DECISION_PATHS, NOISE_FILE } from "./lib/hunt.mjs";
import { mapWithConcurrency } from "../lib/shared/map-with-concurrency.ts";
import { askWithRetry } from "./lib/jev-retry.mjs";
import { askJev } from "./lib/jev.mjs";
import { readDockets, readVerdictRows, renderRatings } from "./lib/ratings.mjs";
import {
  NOISE_PARTS,
  againstNoise,
  decisionHash,
  fullJevRuns,
  noiseBand,
  partAgainstNoise,
  partBand,
  readNoise,
} from "./lib/regularizers.mjs";
import { disproofRecord, normalizeFindings, parseDisproof, refuseDismissal, verifyCitation } from "./lib/review.mjs";
import { loadEscalation, repoIo } from "./review.mjs";
import { TOP_K, holdoutIds, judgeRewrite, rewriteBrief, routable, routingGate, routingReport } from "./lib/routing.mjs";
import {
  JUDGED_IN,
  SIT,
  absentFor,
  buildSeatQuestions,
  chairsFor,
  decideSeats,
  fillMinds,
  heardFor,
  heuristicSeatAnswers,
  inRoom as seatInRoom,
  loadSeatRoster,
  sitFor,
} from "./lib/seats.mjs";
import { isMainModule } from "../lib/shared/is-main.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const USAGE =
  "usage: bun dredd/eval.mjs [--heuristic-only] [--asks-only | --seats-only | --ballots-only | --claims-only | --dismissals-only | --members-only | --experts-only | --routing-only, one or more] [--limit N] [--only id,id] [--min-rank1 R] [--routing-brief] [--routing-against bench.json] [--noise N] [--stability] [--ladder weak,strong] [--escalate R]";
/** The one-part flags: each runs its own part alone. */
const ONLY_FLAGS = [
  "--asks-only",
  "--seats-only",
  "--ballots-only",
  "--claims-only",
  "--dismissals-only",
  "--members-only",
  "--experts-only",
  "--routing-only",
];
/** The --noise runs: the three halves Jev answers, each a sample of its own band, and none of the pure ones. */
const NOISE_RUN_FLAGS = ["--asks-only", "--seats-only", "--experts-only"];
/**
 * How many asks (or briefs) are with Jev at once. One after another, a run was as slow as the sum of its asks: 81
 * asks behind a slow escalation leg made a three-run calibration 3.5 hours (2026-09-27). In parallel it is as slow
 * as the slowest wave. Each ask is one Python bridge process, so this is also the process count.
 */
const JEV_CONCURRENCY = Number(process.env.DREDD_EVAL_CONCURRENCY) || 32;
/** A Jev call that timed out is asked again this many at a time, for this many rounds (lib/jev-retry.mjs). */
const JEV_RETRY_CONCURRENCY = 4;
const JEV_RETRIES = 2;

/**
 * One gold ask against one arm's answers and the ids the docket convened from them. The classifier half reads
 * the raw p (pYes, the same read decideDocket makes); the convened half reads what would actually run.
 */
/** This run's own folder, claimed, never shared: two evals started in the same second (a parallel A/B sweep over saved
 *  answer sets) wrote one eval-<stamp> folder and each A/B graded the other's answers - a "regression" in one set was
 *  another set's answers (2026-09-23). The second run takes eval-<stamp>-2, which still sorts after the first. */
export function claimEvalDir(parent, stamp, prefix = "eval") {
  mkdirSync(parent, { recursive: true });
  for (let n = 1; n < 100; n += 1) {
    const dir = path.join(parent, n === 1 ? `${prefix}-${stamp}` : `${prefix}-${stamp}-${n}`);
    try {
      mkdirSync(dir);
      return dir;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
    }
  }
  throw new Error(`99 evals already hold ${prefix}-${stamp}* in ${parent}`);
}

/**
 * The rulings gold (eval/claims.json) through the claims check: each case's page rulings are read from `root`'s live
 * source (lib/rulings.mjs pageRulings), and only ruling:* findings are graded against the case's `refused` kinds. A
 * page whose rulings cannot be found, or whose kept element the component no longer renders, is a miss with the
 * reason: the gold is only as good as the declarations it reads. Pure over the file system; no model.
 */
export function scoreClaimsGold(gold, root) {
  return gold.cases.map((c) => {
    const rulings = pageRulings(root, c.url);
    const want = [...new Set(c.refused)].sort();
    if (!rulings.component) return { id: c.id, want, got: [], ok: false, note: rulings.why };
    if (rulings.stale.length)
      return {
        id: c.id,
        want,
        got: [],
        ok: false,
        note: `${rulings.component} declares kept what it no longer renders: ${rulings.stale.join(", ")}`,
      };
    const { findings } = checkClaims({ proposal: c.proposal, pageText: c.pageText || "", rulings });
    const got = [...new Set(findings.map((f) => f.kind).filter((k) => k.startsWith("ruling:")))].sort();
    return { id: c.id, want, got, ok: got.join() === want.join() };
  });
}

/**
 * The dismissal gold (eval/dismissals.json) through the code review's own rules (lib/review.mjs): each case's finding
 * file must be in `root`'s live tree (else the case is stale, a miss), its dismissal is parsed, its citation checked
 * against `root`'s live files (the case's `facts` stand in for git history, so a shallow clone grades the same), its
 * finding normalized and classed by the SHIPPED reviewers/escalate.json, and the dismissal judged. A row is right
 * when every field of `want` (dismissed + kind, or refused + code, + class) matches. Pure over the file system; no model.
 */
export function scoreDismissalGold(gold, root) {
  const { classes } = loadEscalation(path.join(HERE, "reviewers"));
  const live = repoIo(root);
  return gold.cases.map((c) => {
    const facts = c.facts || {};
    const row = (got, note = "") => ({
      id: c.id,
      want: c.want,
      got,
      ok: Object.entries(c.want).every(([k, v]) => got[k] === v),
      ...(note ? { note } : {}),
    });
    // The finding's own file is read live as well: a moved auth, SDK or migration file is a miss, never a stale path that
    // a class glob still matches after the live tree has left it.
    if (live.read(c.finding.file) == null) return row({ stale: "finding-missing" }, `${c.finding.file} is not in the tree`);
    let d;
    try {
      d = parseDisproof(c.dismissal);
    } catch (err) {
      return row({ refused: "parse" }, err.message);
    }
    const io = {
      ...live,
      from: "the reviewed base",
      fromLabel: "the reviewed base",
      commit: (sha) => facts.commits?.[sha] ?? null,
      isAncestor: () => facts.beforeRange === true,
    };
    const why = verifyCitation(d, io);
    if (why) return row({ refused: "citation" }, why);
    const seat = { id: "gold", axis: "standards", security: c.finding.seat === "security" };
    const [f] = normalizeFindings(seat, { findings: [{ title: c.id, ...c.finding }] }, [c.finding.file], classes);
    const added = new Map(Object.entries(facts.added || {}).map(([file, lines]) => [file, new Map(lines.map((n) => [n, ""]))]));
    const blame = (file, line) => facts.blame?.[`${file}:${line}`] ?? null;
    const no = refuseDismissal(d, f, { added, blame }, classes);
    if (no) return row({ refused: no.code, ...(no.escalates ? { escalates: no.escalates } : {}) }, no.why);
    return row({ dismissed: d.kind, checked: disproofRecord(d).checked });
  });
}

/**
 * One member goal (eval/member-goals.json) against one arm's answers over the roster. Both arms answer every
 * `member:<id>` the roster has (memberHeuristicAnswers fills all of them, and mergeAnswers fills Jev's gaps from the
 * keywords), so the yes set is read off the answers themselves. The goal's `must` rows must answer yes and its
 * `mustNot` rows must answer no; `exact` additionally wants the yes set to be exactly the `must` set.
 */
export function scoreMemberGoal(goal, answers) {
  const yes = Object.keys(answers)
    .filter((k) => k.startsWith("member:") && pYes(answers[k]) >= 0.5)
    .map((k) => k.slice("member:".length));
  const yesSet = new Set(yes);
  const missed = goal.must.filter((id) => !yesSet.has(id));
  const wrongly = goal.mustNot.filter((id) => yesSet.has(id));
  return {
    id: goal.id,
    must: goal.must,
    mustNot: goal.mustNot,
    missed,
    wrongly,
    ok: !missed.length && !wrongly.length,
    exact: [...yes].sort().join() === [...goal.must].sort().join(),
  };
}

/** One dismissal outcome in words, for a MISS line. */
function outcomeText(o) {
  if (o.stale) return `a stale case (${o.stale})`;
  if (o.refused) return `refused (${[o.refused, o.escalates].filter(Boolean).join(", ")})`;
  return `dismissed as ${o.dismissed}${o.checked ? ` (${o.checked})` : ""}`;
}

export function scoreAsk(item, answers, convened) {
  const misses = [];
  const convMisses = [];
  const cls = answers.ask_class?.answer;
  const dom = answers.domain?.answer;
  const del = answers.delegation?.answer;
  const scope = Number(answers.scope?.answer);
  const classOk = item.class == null ? null : cls === item.class;
  const domainOk = item.domain == null ? null : dom === item.domain;
  const scopeOk = item.scope == null ? null : scope === item.scope;
  const delOk = item.delegation ? item.delegation.includes(del) : null;
  if (classOk === false) misses.push(`class ${cls} (gold ${item.class})`);
  if (domainOk === false) misses.push(`domain ${dom} (gold ${item.domain})`);
  if (scopeOk === false) misses.push(`scope ${scope} (gold ${item.scope})`);
  if (delOk === false) misses.push(`delegation ${del} (gold ${item.delegation.join("|")})`);
  const p = (id) => pYes(answers[`inst:${id}`]);
  const ran = new Set(convened);
  let mustHit = 0;
  let convMustHit = 0;
  for (const id of item.must || []) {
    if (p(id) >= 0.5) mustHit += 1;
    else misses.push(`must ${id} p=${p(id).toFixed(2)}`);
    if (ran.has(id)) convMustHit += 1;
    else convMisses.push(`must ${id} not convened (p=${p(id).toFixed(2)})`);
  }
  let anyOk = null;
  let convAnyOk = null;
  if (item.anyOf?.length) {
    anyOk = item.anyOf.some((id) => p(id) >= 0.5);
    if (!anyOk) misses.push(`anyOf ${item.anyOf.join("|")} all < 0.5`);
    convAnyOk = item.anyOf.some((id) => ran.has(id));
    if (!convAnyOk) convMisses.push(`anyOf ${item.anyOf.join("|")} none convened`);
  }
  let notHit = 0;
  let convNotHit = 0;
  for (const id of item.mustNot || []) {
    if (p(id) < 0.5) notHit += 1;
    else misses.push(`mustNot ${id} p=${p(id).toFixed(2)}`);
    if (!ran.has(id)) convNotHit += 1;
    else convMisses.push(`mustNot ${id} convened (p=${p(id).toFixed(2)})`);
  }
  return {
    classOk,
    domainOk,
    scopeOk,
    delegationOk: delOk,
    mustHit,
    mustN: (item.must || []).length,
    anyOk,
    notHit,
    notN: (item.mustNot || []).length,
    misses,
    convMustHit,
    convAnyOk,
    convNotHit,
    convMisses,
  };
}

export function tally(rows) {
  const t = {
    class: [0, 0],
    domain: [0, 0],
    scope: [0, 0],
    delegation: [0, 0],
    must: [0, 0],
    anyOf: [0, 0],
    mustNot: [0, 0],
    perfect: 0,
    convMust: [0, 0],
    convAnyOf: [0, 0],
    convMustNot: [0, 0],
    convPerfect: 0,
  };
  for (const r of rows) {
    for (const k of ["class", "domain", "scope", "delegation"]) {
      const v = r.s[`${k}Ok`];
      if (v === null) continue;
      t[k][1] += 1;
      if (v) t[k][0] += 1;
    }
    t.must[0] += r.s.mustHit;
    t.must[1] += r.s.mustN;
    t.mustNot[0] += r.s.notHit;
    t.mustNot[1] += r.s.notN;
    t.convMust[0] += r.s.convMustHit;
    t.convMust[1] += r.s.mustN;
    t.convMustNot[0] += r.s.convNotHit;
    t.convMustNot[1] += r.s.notN;
    if (r.s.anyOk !== null) {
      t.anyOf[1] += 1;
      if (r.s.anyOk) t.anyOf[0] += 1;
      t.convAnyOf[1] += 1;
      if (r.s.convAnyOk) t.convAnyOf[0] += 1;
    }
    if (!r.s.misses.length) t.perfect += 1;
    if (!r.s.convMisses.length) t.convPerfect += 1;
  }
  return t;
}

/**
 * The seat half: a brief's decided roster (decideSeats' picked and rows) against the gold. A seat in `always` is
 * forced by the hearing, so it is left out of must-sit entirely: counting it credited 7 of 38 must-sit rows to no
 * judgment at all (Opus 5.5 review, 2026-09-22). A must-sit seat that is on the roster only because the minimum
 * topped it up is not a judgment either - with every p tied the top-up picks in seat-file order - so it is a miss
 * and is counted in `topped`. A chair the ask is owed (lib/seats.mjs chairsFor: a curriculum question's learning minds)
 * is the ask's judgment, not seat-file order, so it counts as sat. The roster itself is still exact when it matches the
 * gold, however it got there.
 */
export function scoreSeats(item, { picked, rows, min = 2 }) {
  const always = new Set(item.always || []);
  const rowOf = (id) => rows.find((r) => r.id === id);
  const pTxt = (id) => (rowOf(id) ? `p=${rowOf(id).p.toFixed(2)}` : "not in the room");
  const misses = [];
  const topped = [];
  const judged = (item.sit || []).filter((id) => !always.has(id));
  let sitHit = 0;
  for (const id of judged) {
    if (!picked.includes(id)) misses.push(`sit ${id} ${pTxt(id)}`);
    else if (rowOf(id)?.why === JUDGED_IN || rowOf(id)?.chair) sitHit += 1;
    else {
      topped.push(id);
      misses.push(`sit ${id} only topped up to the minimum (${pTxt(id)})`);
    }
  }
  let notHit = 0;
  for (const id of item.mustNot || []) {
    if (!picked.includes(id)) notHit += 1;
    else misses.push(`mustNot ${id} ${pTxt(id)}`);
  }
  const extra = picked.filter((id) => !(item.sit || []).includes(id) && !always.has(id));
  // The seats the room CHOSE past what the gold and its own minimum required: a brief whose gold seats one in a room of
  // at least two carries one extra by construction, and that one is the minimum, not noise (lib/hunt.mjs reads this).
  const beyondMin = Math.max(0, picked.length - Math.max(min, new Set([...(item.sit || []), ...always]).size));
  const exact =
    (item.sit || []).every((id) => picked.includes(id)) && !(item.mustNot || []).some((id) => picked.includes(id)) && !extra.length;
  return { sitHit, sitN: judged.length, topped, notHit, notN: (item.mustNot || []).length, extra, beyondMin, exact, misses };
}

export function tallySeats(rows) {
  const t = { n: rows.length, sit: [0, 0], topped: 0, mustNot: [0, 0], exact: 0, extra: 0, extraBeyondMin: 0 };
  for (const r of rows) {
    t.sit[0] += r.s.sitHit;
    t.sit[1] += r.s.sitN;
    t.topped += r.s.topped.length;
    t.mustNot[0] += r.s.notHit;
    t.mustNot[1] += r.s.notN;
    t.extra += r.s.extra.length;
    t.extraBeyondMin += r.s.beyondMin ?? 0;
    if (r.s.exact) t.exact += 1;
  }
  return t;
}

/**
 * The routing half (lib/claim-routing.mjs): the experts routeSeats sent one complaint unit to, against the gold's `want`,
 * `ok` and `mustNot`. The first one routed sits first when the allowance runs short (the homework's breadth-first order),
 * so a first expert the unit does not want is a miss even when the wanted ones follow. An `ok` expert is neither credited
 * nor charged; any other is an extra, and an exact unit has none. `p` is every seat's p, for the miss lines.
 */
export function scoreExperts(item, seats, p = {}) {
  const routed = seats.map((s) => s.id);
  const pTxt = (id) => (typeof p[id] === "number" ? `p=${p[id].toFixed(2)}` : "no answer");
  const want = item.want || [];
  const mustNot = new Set(item.mustNot || []);
  const fair = new Set([...want, ...(item.ok || [])]);
  const misses = [];
  let wantHit = 0;
  for (const id of want) {
    if (routed.includes(id)) wantHit += 1;
    else misses.push(`want ${id} not routed (${pTxt(id)})`);
  }
  const lead = routed[0] ?? null;
  const leadHit = lead !== null && want.includes(lead);
  if (lead !== null && !leadHit) misses.push(`first routed ${lead} (${pTxt(lead)}) is not one the unit wants`);
  let notHit = 0;
  for (const id of mustNot) {
    if (!routed.includes(id)) notHit += 1;
    else misses.push(`mustNot ${id} routed (${pTxt(id)})`);
  }
  const extra = routed.filter((id) => !fair.has(id) && !mustNot.has(id));
  return {
    wantHit,
    wantN: want.length,
    lead,
    leadHit,
    notHit,
    notN: mustNot.size,
    extra,
    seats: routed.length,
    exact: !misses.length && !extra.length,
    misses,
  };
}

export function tallyExperts(rows) {
  const t = { n: rows.length, want: [0, 0], lead: [0, 0], mustNot: [0, 0], extra: 0, seats: 0, exact: 0 };
  for (const r of rows) {
    t.want[0] += r.s.wantHit;
    t.want[1] += r.s.wantN;
    t.lead[0] += r.s.leadHit ? 1 : 0;
    t.lead[1] += 1;
    t.mustNot[0] += r.s.notHit;
    t.mustNot[1] += r.s.notN;
    t.extra += r.s.extra.length;
    t.seats += r.s.seats;
    if (r.s.exact) t.exact += 1;
  }
  return t;
}

const pct = ([a, b]) => (b ? `${Math.round((100 * a) / b)}% (${a}/${b})` : "-");

function usage(why) {
  process.stderr.write(`eval: ${why}\n${USAGE}\n`);
  process.exit(2);
}

function parseArgs(args) {
  const flag = (f) => args.includes(f);
  // A value flag with nothing after it used to read undefined and crash at load with a bare TypeError (2026-09-22).
  const opt = (f, d) => {
    const i = args.indexOf(f);
    if (i < 0) return d;
    const v = args[i + 1];
    if (v === undefined || v.startsWith("--")) usage(`${f} needs a value`);
    return v;
  };
  const limitRaw = opt("--limit", "0");
  const limit = Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 0) usage(`--limit takes a whole number, not ${limitRaw}`);
  const only = opt("--only", "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  // --replay <results.json>: re-score the asks from a prior run's saved Jev answers instead of asking Jev again, so a
  // change to decideDocket's rules is measured for free and against the SAME classifier answers (2026-09-23).
  const replay = opt("--replay", null);
  // --bars focused=0.55,focusedField=0.7: try a bar setting against the gold without editing BARS (pairs with --replay).
  const barsRaw = opt("--bars", "");
  const bars = { ...BARS };
  for (const pair of barsRaw.split(",").filter(Boolean)) {
    const [k, v] = pair.split("=");
    if (!(k in BARS) || !Number.isFinite(Number(v)))
      usage(`--bars takes name=number pairs over ${Object.keys(BARS).join(", ")}, not ${pair}`);
    bars[k] = Number(v);
  }
  // --min-rank1 0.8: the routing ratchet - the share of gold asks whose top-ranked instrument is an owner may not fall
  // below it, so a bench line reworded for one ask cannot quietly lose others (the upstream gate's --min-rank1).
  const minRaw = opt("--min-rank1", null);
  const minRank1 = minRaw === null ? null : Number(minRaw);
  if (minRaw !== null && !(minRank1 >= 0 && minRank1 <= 1)) usage(`--min-rank1 takes a ratio from 0 to 1, not ${minRaw}`);
  const routingAgainst = opt("--routing-against", null);
  // --escalate 0.42: the cascade threshold for this run (default 0.7, the one tuned on Jev's probabilities). An A/B on
  // another typed model (DREDD_JEV_MODEL) whose confidence runs on its own scale sets the threshold that escalates the
  // same share of choices as Jev does at 0.7 (zswarm bench/typed_ab.py prints it).
  const escRaw = opt("--escalate", "0.7");
  const escalate = Number(escRaw);
  if (!(escalate >= 0 && escalate <= 1)) usage(`--escalate takes a ratio from 0 to 1, not ${escRaw}`);
  const ladderRaw = opt("--ladder", null);
  const ladder =
    ladderRaw === null
      ? null
      : ladderRaw
          .split(",")
          .map((m) => m.trim())
          .filter(Boolean);
  if (ladder && ladder.length < 2) usage(`--ladder takes two or more models, weakest first, not ${ladderRaw}`);
  return {
    flag,
    limit,
    only,
    replay,
    bars,
    minRank1,
    routingAgainst,
    escalate,
    ladder,
    // Two or more run just those parts: the noise band's runs are --asks-only --seats-only --experts-only, the three
    // halves Jev answers, without the pure ones whose gold another session may have left red.
    onlyParts: ONLY_FLAGS.filter(flag).map((f) => f.slice(2, -"-only".length)),
  };
}

/** Add to eval/noise.json without touching the band (or anything else) already in it. */
function patchNoise(patch) {
  const cur = readNoise(NOISE_FILE) || {
    $doc: "Dredd's noise band and what else says how far to trust a number (eval.mjs --noise, --stability, --ladder; lib/regularizers.mjs, lib/hillclimb.mjs).",
  };
  writeFileSync(NOISE_FILE, `${JSON.stringify({ ...cur, ...patch }, null, 2)}\n`);
}

/** One metric's move through its band (lib/regularizers.mjs againstNoise / partAgainstNoise), as the eval prints it. */
function noiseLine(label, r, unit) {
  const last = r.last
    ? `${r.last.before} -> ${r.last.after} (${r.last.move >= 0 ? "+" : ""}${r.last.move} over ${r.last.items} ${unit})`
    : "-";
  const band = r.delta == null ? "" : `, delta ${r.delta}`;
  const floor = r.floor
    ? `; best on record ${r.floor.gap >= 0 ? "+" : ""}${r.floor.gap}${r.floor.below ? " BELOW THE FLOOR (best - delta): a walk downhill" : ""}`
    : "";
  return `  ${label.padEnd(12)} ${last}: ${r.reading}${band}${floor}\n`;
}

/**
 * The seat pick's or the routing's move from the last run Jev graded it in, and its gap to the best of the last eight,
 * through its band on record (eval/noise.json `seats` / `experts`, lib/regularizers.mjs partBand). A seat question moves
 * both and the A/B's replayed arms cannot see it, so this is where its full eval is read (2026-10-10: two rewrites of
 * Grandma Sue's moved the seat pick's exact 18 -> 14 and 18 -> 15 with nothing to read them through). Only a run that is
 * itself a sample of the part: Jev graded all of it, nothing replayed, nothing fell back.
 */
function printPartNoise(part, results, { replay, outDir }) {
  if (!results[part].arms.jev || results.partial || replay || results.jevFallbacks) return;
  const prior = fullJevRuns(ROOT, { limit: 8, exclude: outDir, part });
  if (!prior.length) return;
  const file = readNoise(NOISE_FILE);
  const noise = file?.[part] ?? null;
  const reads = partAgainstNoise({ part, before: prior[0].results, history: prior.map((p) => p.results), after: results, noise });
  const fewer = new Set(NOISE_PARTS[part].fewer);
  process.stdout.write(
    `\n${part === "seats" ? "the seat pick" : "the expert routing"} against the last Jev run that graded it (${prior[0].file}) and the best of the last ${prior.length}, ${noise ? `${part} band of ${noise.runs} runs, ${String(file.at).slice(0, 10)}` : `NO ${part} band measured (eval.mjs --noise 3): every move below may be a coin`}\n`,
  );
  for (const r of reads)
    process.stdout.write(
      noiseLine(
        `${r.group} ${r.metric}${fewer.has(r.metric) ? " (fewer is better)" : ""}`.padEnd(30),
        r,
        part === "seats" ? "briefs" : "units",
      ),
    );
}

/** The tokens a Jev call's summary reports, when it does; null otherwise (never a guess). */
function tokensOf(summary) {
  const t = Number(summary?.tokens ?? 0) || Number(summary?.input_tokens || 0) + Number(summary?.output_tokens || 0);
  return t > 0 ? t : null;
}

/**
 * Grader stability: the sampled asks re-asked of Jev, compared with the answers this run saved for them. A sample, because
 * a judge is where a long job spends; once per suite, because the number only moves when the suite does.
 */
async function measureStability({ rows, bench, escalate, spend }) {
  const sample = sampleAsks(
    rows.filter((r) => r.arms.jev?.answers && !r.arms.jev.note),
    STABILITY_SAMPLE,
  );
  const again = await mapWithConcurrency(sample, JEV_CONCURRENCY, (r) =>
    askJev(buildQuestions(bench, r.ask, { url: extractUrl(r.ask) }), { escalate, timeoutMs: 60_000 }),
  );
  const pairs = [];
  for (const [i, r] of sample.entries()) {
    if (!again[i].answers) continue;
    spend(again[i]);
    pairs.push({ id: r.id, first: r.arms.jev.answers, second: again[i].answers });
  }
  return graderAgreement(pairs);
}

async function main() {
  const { flag, limit, only, replay, bars, minRank1, routingAgainst, escalate, ladder, onlyParts } = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const part = (p) => !onlyParts.length || onlyParts.includes(p);
  const saved = replay ? JSON.parse(readFileSync(replay, "utf8")) : null;
  const replayed = saved ? new Map(saved.rows.map((r) => [r.id, r.arms?.jev?.answers])) : null;
  // The experts' half of a saved run: every seat's p per unit, from Jev only (a unit whose Jev fell back is not replayed).
  const replayedExperts = saved
    ? new Map(
        (saved.experts?.rows || [])
          .filter((r) => r.arms?.jev?.p && !r.arms.jev.note?.startsWith("jev unavailable"))
          .map((r) => [r.id, r.arms.jev.p]),
      )
    : null;
  const bench = loadBench(ROOT);
  const verdictsDir = process.env.DREDD_VERDICTS_DIR || path.join(HERE, "eval", "verdicts");
  if (flag("--ratings")) {
    process.stdout.write(`${renderRatings(readDockets(ROOT), readVerdictRows(verdictsDir))}\n`);
    return;
  }
  // The noise band: runs of the same decision files differ only by Jev's own spread, so their paired difference IS
  // the noise (lib/regularizers.mjs noiseBand). A run that fell back to the keywords exits 1 and is not a sample
  // (fullJevRuns skips it). A burst of Jev timeouts is weather, not a broken reach (2026-09-27: 11 asks in a row timed
  // out mid-run), so each run asked for gets one retry before the calibration calls Jev's reach broken.
  if (flag("--noise")) {
    const n = Number(process.argv[process.argv.indexOf("--noise") + 1]);
    const fresh = Number.isInteger(n) && n > 0 ? n : 0;
    let clean = 0;
    for (let tries = 0; clean < fresh; tries += 1) {
      if (tries >= fresh * 2)
        usage(
          `--noise: ${tries - clean} of ${tries} runs fell back to the keywords (a Jev fallback grades the keywords, not Jev) - fix Jev's reach and run again`,
        );
      process.stdout.write(
        `noise: Jev run ${clean + 1} of ${fresh} (the asks, the seat pick, the expert routing)${tries > clean ? ` (attempt ${tries + 1})` : ""}\n`,
      );
      const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...NOISE_RUN_FLAGS], {
        cwd: ROOT,
        stdio: "inherit",
        windowsHide: true,
      });
      if (r.status === 0) clean += 1;
      else process.stdout.write(`noise: that run exited ${r.status} and is not a sample; retrying\n`);
    }
    const hash = decisionHash(ROOT, DECISION_PATHS);
    // Each half is banded from the runs that graded it: an --experts-only run of these files is a sample of the routing.
    const sameOf = (part) => fullJevRuns(ROOT, { limit: 12, part }).filter((r) => r.results.decisionHash === hash);
    const same = sameOf("asks");
    if (same.length < 2)
      usage(`--noise: ${same.length} saved full Jev run(s) of the current decision files (${hash}) - run --noise 3 (cents each)`);
    const band = noiseBand(same.map((r) => r.results));
    const parts = {};
    for (const part of Object.keys(NOISE_PARTS)) {
      const runs = sameOf(part);
      const b = partBand(
        runs.map((r) => r.results),
        part,
      );
      if (b) parts[part] = { files: runs.map((r) => r.file), ...b };
    }
    // The band is rewritten whole; what else the file records (grader stability, the ladder) is not the band's to drop.
    const prev = readNoise(NOISE_FILE) || {};
    const out = {
      $doc: "Dredd's noise band: how far a full Jev eval moves on UNCHANGED decision files (eval.mjs --noise; lib/regularizers.mjs). A move inside `delta` is not a result.",
      at: new Date().toISOString(),
      decisionHash: hash,
      files: same.map((r) => r.file),
      ...band,
      ...parts,
      ...(prev.graderStability ? { graderStability: prev.graderStability } : {}),
      ...(prev.ladder ? { ladder: prev.ladder } : {}),
    };
    writeFileSync(NOISE_FILE, `${JSON.stringify(out, null, 2)}\n`);
    process.stdout.write(`noise band from ${band.runs} run(s), ${band.pairs} pair(s), z ${band.z}:\n`);
    for (const [m, v] of Object.entries(band.metrics)) process.stdout.write(`  ${m.padEnd(12)} delta ${v.delta} (sd ${v.sd})\n`);
    process.stdout.write(`  ${band.unstable.length} ask(s) flipped between runs of the same code\n`);
    for (const part of Object.keys(NOISE_PARTS)) {
      const b = parts[part];
      if (!b) {
        process.stdout.write(`${part}: under two Jev runs of these files graded it - no band\n`);
        continue;
      }
      process.stdout.write(`${part} band from ${b.runs} run(s), ${b.pairs} pair(s):\n`);
      for (const [g, v] of Object.entries(b.groups))
        process.stdout.write(
          `  ${g.padEnd(9)} ${Object.entries(v.metrics)
            .map(([m, x]) => `${m} delta ${x.delta}`)
            .join(
              ", ",
            )}; ${v.unstable.length} of ${v.items} flipped exact${v.unstable.length ? ` (${v.unstable.map((u) => u.id).join(", ")})` : ""}\n`,
        );
    }
    process.stdout.write(`→ ${path.relative(ROOT, NOISE_FILE)}\n`);
    return;
  }
  // The routing rewrite loop's two free steps (lib/routing.mjs): the blinded brief, then a rewritten bench judged on the
  // held-out asks the brief never showed. Both read the hand-written gold only, never the chat-labelled verdict rows.
  if (flag("--routing-brief") || routingAgainst) {
    const goldAsks = JSON.parse(readFileSync(path.join(HERE, "eval", "asks.json"), "utf8")).asks;
    const current = routingReport(bench, goldAsks);
    if (!routingAgainst) {
      process.stdout.write(`${rewriteBrief(current, goldAsks)}\n`);
      return;
    }
    const candidate = routingReport(JSON.parse(readFileSync(path.resolve(routingAgainst), "utf8")), goldAsks);
    const verdict = judgeRewrite(current, candidate);
    process.stdout.write(
      `training asks, current -> candidate: rank-1 ${pct(current.train.rank1)} -> ${pct(candidate.train.rank1)}, top-${TOP_K} ${pct(current.train.topK)} -> ${pct(candidate.train.topK)}, mustNot pairs ${pct(current.train.pairs)} -> ${pct(candidate.train.pairs)}\n` +
        `collisions: ${current.collisions.length} -> ${candidate.collisions.length}\n` +
        `${verdict.keep ? "KEEP" : "DISCARD"}: ${verdict.why} (held-out numbers are not printed, so the next rewrite stays blind to them)\n`,
    );
    if (!verdict.keep) process.exitCode = 1;
    return;
  }
  // --verdicts grades the asks half against the rows chats wrote when a docket was wrong; the seats and ballots have
  // no verdict rows, so they sit this one out.
  const verdictsOnly = flag("--verdicts");
  if (verdictsOnly && !readVerdictRows(verdictsDir).length)
    usage(`--verdicts: no verdict rows in ${verdictsDir} yet - they come from dredd.mjs --rate`);
  const gold = (
    verdictsOnly ? readVerdictRows(verdictsDir) : JSON.parse(readFileSync(path.join(HERE, "eval", "asks.json"), "utf8")).asks
  ).filter((a) => !only.length || only.includes(a.id));
  // A replay grades the asks its saved run holds and names the rest: a gold ask lands WITH the change it measures (the
  // A/B policy's own order), so the newest saved run never holds it, and dying on it left the A/B nothing to replay.
  const unsaved = replayed && part("asks") ? gold.filter((a) => !replayed.get(a.id)).map((a) => a.id) : [];
  if (unsaved.length)
    process.stdout.write(
      `replay: ${unsaved.length} gold ask(s) have no saved Jev answers in ${replay} and are not graded here (newer than that run): ${unsaved.join(", ")}\n`,
    );
  const graded = unsaved.length ? gold.filter((a) => !unsaved.includes(a.id)) : gold;
  const asks = limit ? graded.slice(0, limit) : graded;
  const seatGold = JSON.parse(readFileSync(path.join(HERE, "eval", "seats.json"), "utf8")).briefs.filter(
    (b) => !only.length || only.includes(b.id),
  );
  const briefs = limit ? seatGold.slice(0, limit) : seatGold;
  const expertGold = JSON.parse(readFileSync(path.join(HERE, "eval", "experts.json"), "utf8")).units.filter(
    (u) => !only.length || only.includes(u.id),
  );
  // A unit newer than the replayed run has no saved answers: named and left out, the way the asks are.
  const expertsUnsaved = replayedExperts && part("experts") ? expertGold.filter((u) => !replayedExperts.has(u.id)).map((u) => u.id) : [];
  if (expertsUnsaved.length)
    process.stdout.write(
      `replay: ${expertsUnsaved.length} gold unit(s) have no saved Jev answers in ${replay} and are not graded here: ${expertsUnsaved.join(", ")}\n`,
    );
  const routedGold = expertGold.filter((u) => !expertsUnsaved.includes(u.id));
  const units = limit ? routedGold.slice(0, limit) : routedGold;

  // The model ladder (lib/hillclimb.mjs): the same gold through each model, weakest first. The score is the share of asks
  // the docket convenes exactly right, so it is the number a fix is measured by; held-out asks count (nothing is printed per ask).
  if (ladder) {
    const rungs = [];
    for (const model of ladder) {
      const res = await mapWithConcurrency(asks, JEV_CONCURRENCY, (item) =>
        askJev(buildQuestions(bench, item.ask, { url: item.url || extractUrl(item.ask) }), {
          escalate,
          timeoutMs: 60_000,
          model,
        }),
      );
      const down = res.filter((r) => !r.answers).length;
      if (down === asks.length) usage(`--ladder: ${model} answered nothing (${res[0]?.reason}) - a rung that did not run is not a score`);
      let right = 0;
      for (const [i, item] of asks.entries()) {
        if (!res[i].answers) continue;
        const url = item.url || extractUrl(item.ask);
        const { answers } = mergeAnswers(res[i].answers, heuristicAnswers(bench, item.ask, { url }));
        const convened = decideDocket({ bench, ask: item.ask, url, answers, source: "jev", bars }).convene.map((c) => c.id);
        if (!scoreAsk(item, answers, convened).convMisses.length) right += 1;
      }
      rungs.push({ model, score: right / (asks.length - down), asks: asks.length - down });
      process.stdout.write(
        `ladder: ${model} ${right}/${asks.length - down} convened right${down ? ` (${down} unanswered, not scored)` : ""}\n`,
      );
    }
    const reading = ladderReading(rungs);
    process.stdout.write(`${reading.line}\n`);
    patchNoise({ ladder: { at: new Date().toISOString(), ok: reading.ok, rungs } });
    if (!reading.ok) process.exitCode = 1;
    return;
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15);
  // A --verdicts run grades chat-labelled rows, not the gold: its own folder name keeps it out of the hunt's newest run
  // and the A/B's replay source (both match eval-<digits>), and it says partial besides.
  const outDir = claimEvalDir(path.join(ROOT, "tmp", "dredd"), stamp, verdictsOnly ? "verdicts-eval" : "eval");
  const arms = flag("--heuristic-only") ? ["heuristic"] : ["jev", "heuristic"];
  const results = {
    asks: asks.length,
    briefs: briefs.length,
    // A spot check: the hunt never reads it as the judge's scorecard (lib/hunt.mjs newestEvalRun).
    partial: Boolean(verdictsOnly || only.length || limit || unsaved.length || expertsUnsaved.length),
    ...(verdictsOnly ? { gold: "verdicts" } : {}),
    // Which decision files this run measured and whose answers it graded: two runs with one hash and no replay are
    // two samples of the same judge, which is what the noise band is made of.
    decisionHash: decisionHash(ROOT, DECISION_PATHS),
    replay: replay ? path.relative(ROOT, path.resolve(replay)).replace(/\\/g, "/") : null,
    arms: {},
    holdout: {},
    trials: {},
    rows: [],
    seats: { arms: {}, rows: [] },
    experts: { arms: {}, rows: [] },
    jevFallbacks: 0,
    jevUngraded: 0,
  };
  let jevCost = 0;
  let jevTokens = 0;
  let tokensKnown = true;
  const spend = (res) => {
    jevCost += Number(res.summary?.jev_cost_usd || 0) + Number(res.summary?.fallback_cost_usd || 0);
    const t = tokensOf(res.summary);
    if (t == null) tokensKnown = false;
    else jevTokens += t;
  };

  // The chat-labelled verdict rows are not the hand-written gold and have no held-out quarter.
  const held = verdictsOnly ? new Set() : holdoutIds(asks);
  if (part("asks")) {
    const questions = asks.reduce((n, item) => n + buildQuestions(bench, item.ask, { url: item.url || extractUrl(item.ask) }).length, 0);
    const heldNote = held.size ? `; ${held.size} held-out ask(s) graded but not shown` : "";
    process.stdout.write(`-- the asks (${asks.length} asks, ${questions} questions per arm${heldNote}) --\n`);
    // Every ask's Jev answers first, JEV_CONCURRENCY at a time; the grading below reads them in the gold's order.
    // A Jev call that timed out under load is asked again at low concurrency (lib/jev-retry.mjs); one still unanswered
    // after that is not graded on the keywords either: its row says so and the run is invalid.
    const jevPass =
      arms.includes("jev") && !replayed
        ? await askWithRetry(
            asks,
            (item) =>
              askJev(buildQuestions(bench, item.ask, { url: item.url || extractUrl(item.ask) }), {
                escalate,
                timeoutMs: 60_000,
              }),
            { concurrency: JEV_CONCURRENCY, retryConcurrency: JEV_RETRY_CONCURRENCY, retries: JEV_RETRIES },
          )
        : { results: [], retried: 0, failed: 0 };
    const jevAnswers = jevPass.results;
    if (jevPass.retried)
      process.stdout.write(`jev retry: ${jevPass.retried} timed-out ask(s) asked again at concurrency ${JEV_RETRY_CONCURRENCY}\n`);
    if (jevPass.failed)
      process.stdout.write(`jev retry: ${jevPass.failed} ask(s) still unanswered after ${JEV_RETRIES} retries - not graded\n`);
    for (const [index, item] of asks.entries()) {
      const url = item.url || extractUrl(item.ask);
      const row = { id: item.id, ask: item.ask, arms: {} };
      for (const arm of arms) {
        let answers;
        let note = "";
        if (arm === "jev" && replayed) {
          answers = replayed.get(item.id);
          if (!answers) usage(`--replay ${replay} holds no saved Jev answers for ${item.id} - run the eval once without --replay`);
          note = "replayed";
        } else if (arm === "jev") {
          const res = jevAnswers[index];
          if (!res.answers) {
            // Not graded: no fallback row to tally, and the run cannot pass as a full Jev eval.
            results.jevUngraded += 1;
            row.arms.jev = { ungraded: true, note: `jev not graded: ${res.reason}`, convene: [], trials: {}, s: null };
            process.stdout.write(`jev        ${item.id.padEnd(20)} NOT GRADED  [jev not graded: ${res.reason}]\n`);
            continue;
          } else {
            // The door's own rule (dredd.mjs): an id Jev left unanswered is filled from the keywords, and named.
            const { answers: merged, filled } = mergeAnswers(res.answers, heuristicAnswers(bench, item.ask, { url }));
            answers = merged;
            if (filled.length) note = `jev left ${filled.length} unanswered, the keywords filled: ${filled.join(", ")}`;
            spend(res);
          }
        } else answers = heuristicAnswers(bench, item.ask, { url });
        const docket = decideDocket({ bench, ask: item.ask, url, answers, source: arm, bars });
        const convene = docket.convene.map((c) => c.id);
        const s = scoreAsk(item, answers, convene);
        // A signal on trial is graded on what the docket WOULD convene if it voted (lib/docket.mjs TRIAL_SIGNALS).
        const trials = Object.fromEntries(
          Object.entries(docket.votes?.trial || {}).map(([signal, t]) => [
            signal,
            { s: scoreAsk(item, answers, t.convene), convene: t.convene },
          ]),
        );
        row.arms[arm] = {
          s,
          note,
          convene,
          trials,
          class: answers.ask_class?.answer,
          domain: answers.domain?.answer,
          scope: answers.scope?.answer,
          docketScope: docket.scope,
          delegation: answers.delegation?.answer,
          answers,
        };
        const classifier = s.misses.length ? `MISS  ${s.misses.join("; ")}` : "ok";
        const convened = s.convMisses.length ? `MISS  ${s.convMisses.join("; ")}` : "ok";
        if (!held.has(item.id))
          process.stdout.write(
            `${arm.padEnd(9)} ${item.id.padEnd(20)} p: ${classifier} | convened: ${convened}  → ${convene.join(",") || "(nothing)"}${note ? `  [${note}]` : ""}\n`,
          );
      }
      results.rows.push(row);
    }
    for (const arm of arms) {
      // An ask the arm never graded (lib/jev-retry.mjs: still unanswered after the retries) is left out of its tallies.
      const graded = results.rows.filter((r) => !r.arms[arm].ungraded);
      const rows = graded.map((r) => ({ id: r.id, s: r.arms[arm].s }));
      results.arms[arm] = tally(rows);
      // Beside `arms`, never inside it: the A/B decides on `arms` over every gold ask, and a held-out regression is a
      // regression. This pair is the overfitting read - trained asks rising while the held-out ones stay put.
      if (held.size)
        results.holdout[arm] = { trained: tally(rows.filter((r) => !held.has(r.id))), heldOut: tally(rows.filter((r) => held.has(r.id))) };
      // An ask the trial did not vote on (the whole arm answered by the keywords) convenes what the arm did.
      const signals = new Set(results.rows.flatMap((r) => Object.keys(r.arms[arm].trials || {})));
      for (const signal of signals)
        results.trials[`${arm}+${signal}`] = tally(graded.map((r) => ({ id: r.id, s: (r.arms[arm].trials?.[signal] || r.arms[arm]).s })));
    }
  }

  if (!verdictsOnly && part("seats")) {
    const roster = loadSeatRoster();
    process.stdout.write(`\n-- the seat pick (${briefs.length} briefs, SIT ${SIT}) --\n`);
    // The rooms a hearing asks Jev about: the brief's own, and the minds beside a page when its complaint is about attention.
    const heardOf = (item) => heardFor(item.brief, item.room || "product");
    const roomOf = (item) => roster.filter((s) => seatInRoom(s, heardOf(item)));
    const seatAnswers = arms.includes("jev")
      ? await mapWithConcurrency(briefs, JEV_CONCURRENCY, (item) =>
          askJev(buildSeatQuestions(roomOf(item), item.brief), { escalate, timeoutMs: 60_000 }),
        )
      : [];
    for (const [index, item] of briefs.entries()) {
      const room = item.room || "product";
      const inRoom = roomOf(item);
      const row = { id: item.id, room, arms: {} };
      for (const arm of arms) {
        let answers;
        let note = "";
        if (arm === "jev") {
          const res = seatAnswers[index];
          if (!res.answers) {
            note = `jev unavailable: ${res.reason}`;
            results.jevFallbacks += 1;
            answers = heuristicSeatAnswers(roster, item.brief);
          } else {
            answers = res.answers;
            spend(res);
          }
        } else answers = heuristicSeatAnswers(roster, item.brief);
        const byJev = arm === "jev" && !note.startsWith("jev unavailable");
        // A minds sitting is filled the way boardroom.mjs fills it (pickMinds -> fillMinds): grading decideSeats here
        // graded a rule the minds room no longer sits by (2026-10-01).
        const decision =
          room === "minds"
            ? fillMinds({ seats: inRoom, answers, sit: sitFor(room, byJev ? "jev" : "heuristic"), chairs: chairsFor(item.brief) })
            : decideSeats({
                seats: roster,
                answers,
                room,
                heard: byJev ? heardOf(item) : [room],
                always: item.always || [],
                absent: absentFor(item.brief, room),
                sit: sitFor(room, byJev ? "jev" : "heuristic"),
              });
        const s = scoreSeats(item, decision);
        // Every seat's p is kept, so SIT can be re-chosen from the data without another paid run; a seat the arm did
        // not answer is null, not 0, so "no answer" stays apart from a firm no.
        const p = Object.fromEntries(
          inRoom.map((seat) => {
            const a = answers[`seat:${seat.id}`];
            return [seat.id, typeof a?.probabilities?.yes === "number" ? Math.round(a.probabilities.yes * 100) / 100 : null];
          }),
        );
        row.arms[arm] = { s, note, picked: decision.picked, p };
        process.stdout.write(
          `${arm.padEnd(9)} ${item.id.padEnd(30)} ${s.misses.length ? `MISS  ${s.misses.join("; ")}` : s.extra.length ? `ok, extra ${s.extra.join(",")}` : "exact"}  → ${decision.picked.join(",")}${note ? `  [${note}]` : ""}\n`,
        );
      }
      results.seats.rows.push(row);
    }
    for (const arm of arms) {
      const rows = results.seats.rows.map((r) => ({ id: r.id, room: r.room, s: r.arms[arm].s }));
      results.seats.arms[arm] = tallySeats(rows);
      // The keyword arm is tuned on the briefs not marked `holdout`, so its number over them is a floor check. The
      // held-out briefs were written after that tuning and never used to change a keyword: that tally is the keyword
      // arm's honest number (and Jev's second look, since its questions were sharpened on the rest too).
      const held = new Set(briefs.filter((b) => b.holdout).map((b) => b.id));
      if (held.size) results.seats.arms[`${arm}:holdout`] = tallySeats(rows.filter((r) => held.has(r.id)));
      // The tooling room (every code matter, Dredd's own hearings included) seats a different roster, so it is
      // tallied on its own: a product-room number says nothing about the Adversary or the Quota Keeper.
      for (const room of [...new Set(rows.map((r) => r.room))].sort())
        results.seats.arms[`${arm}:${room}`] = tallySeats(rows.filter((r) => r.room === room));
    }
  }

  // The routing half: every gold complaint unit through the door a docket's homework is routed by (answerUnit, then
  // routeSeats), so the eval grades the rule the stage runs. Held-out units are graded and tallied, never printed.
  if (!verdictsOnly && part("experts")) {
    const roster = loadSeatRoster();
    const asUnit = (u) => ({ ...u, claims: u.complaints.map((text, i) => ({ id: `C${i + 1}`, text })) });
    const heldUnits = new Set(units.filter((u) => u.holdout).map((u) => u.id));
    process.stdout.write(
      `\n-- the expert routing (${units.length} complaint units, Jev's bar ${ROUTE_SIT} and the keywords' ${SIT}, at most ${ROUTE_MAX}${heldUnits.size ? `; ${heldUnits.size} held-out unit(s) graded but not shown` : ""}${replayedExperts ? `; Jev's answers replayed from ${replay}` : ""}) --\n`,
    );
    const answered =
      arms.includes("jev") && !replayedExperts
        ? await mapWithConcurrency(units, JEV_CONCURRENCY, (u) => answerUnit(asUnit(u), { roster, url: u.url || null }))
        : [];
    for (const [index, item] of units.entries()) {
      const unit = asUnit(item);
      const row = { id: item.id, arms: {} };
      for (const arm of arms) {
        let answers;
        let note = "";
        // Who answered decides the bar (routeSeats): Jev's ROUTE_SIT, or SIT for the keywords, a fallback included.
        let source = arm === "jev" ? "jev" : "keywords";
        if (arm === "jev" && replayedExperts)
          answers = Object.fromEntries(
            Object.entries(replayedExperts.get(item.id))
              .filter(([, p]) => typeof p === "number")
              .map(([id, p]) => [`seat:${id}`, { probabilities: { yes: p } }]),
          );
        else if (arm === "jev") {
          const a = answered[index];
          answers = a.answers;
          if (!a.jev) {
            note = `jev unavailable: ${a.by}`;
            source = "keywords";
            results.jevFallbacks += 1;
          } else {
            spend(a.r);
            if (a.by !== "jev") note = a.by;
          }
        } else answers = heuristicSeatAnswers(roster, unitBrief(unit, { url: item.url || null }));
        const seats = routeSeats(roster, answers, { source });
        // Every seat's p as Jev gave it (null when unanswered), so the next routing change replays these answers free.
        const p = Object.fromEntries(
          roster.filter((x) => x.jev).map((x) => [x.id, answers[`seat:${x.id}`] ? pYes(answers[`seat:${x.id}`]) : null]),
        );
        const s = scoreExperts(item, seats, p);
        row.arms[arm] = { s, note, routed: seats.map((x) => x.id), ...(arm === "jev" ? { p } : {}) };
        if (!heldUnits.has(item.id))
          process.stdout.write(
            `${arm.padEnd(9)} ${item.id.padEnd(30)} ${s.misses.length ? `MISS  ${s.misses.join("; ")}` : s.extra.length ? `ok, extra ${s.extra.join(",")}` : "exact"}  → ${seats.map((x) => `${x.id}:${x.p.toFixed(2)}`).join(",")}${note ? `  [${note}]` : ""}\n`,
          );
      }
      results.experts.rows.push(row);
    }
    for (const arm of arms) {
      const rows = results.experts.rows.map((r) => ({ id: r.id, s: r.arms[arm].s }));
      results.experts.arms[arm] = tallyExperts(rows);
      if (heldUnits.size) results.experts.arms[`${arm}:holdout`] = tallyExperts(rows.filter((r) => heldUnits.has(r.id)));
    }
  }

  // The ballot half: the void rule (lib/ballot.mjs groundedIn) against eval/ballots.json - a paraphrase, an invented
  // number or another page's line must be void; an honest verbatim quote with a trimmed edge, curly quotes or a
  // dropped full stop must count. Pure, so it costs nothing and runs with every eval.
  if (!verdictsOnly && part("ballots")) {
    const ballots = JSON.parse(readFileSync(path.join(HERE, "eval", "ballots.json"), "utf8"));
    const rows = ballots.cases.map((c) => {
      const got = groundedIn(c.quote, ballots.materials[c.material]);
      return { id: c.id, want: c.grounded, got, ok: got === c.grounded };
    });
    const wrong = rows.filter((r) => !r.ok);
    results.ballots = { cases: rows.length, right: rows.length - wrong.length, wrong: wrong.map((r) => r.id) };
    process.stdout.write(`\n-- the void rule (${rows.length} ballots) --\n`);
    for (const r of wrong)
      process.stdout.write(`MISS  ${r.id}: ${r.got ? "counted" : "voided"} a quote a person would have ${r.want ? "counted" : "voided"}\n`);
    process.stdout.write(`void rule: ${results.ballots.right}/${rows.length} right\n`);
    if (wrong.length) process.exitCode = 1;
  }

  // The rulings half: the claims check against eval/claims.json - a proposal the page's own source already ruled out
  // (a name a ruling retires, an element a ruling keeps) must be refused, read through the live router and component.
  if (!verdictsOnly && part("claims")) {
    const rows = scoreClaimsGold(JSON.parse(readFileSync(path.join(HERE, "eval", "claims.json"), "utf8")), ROOT);
    const wrong = rows.filter((r) => !r.ok);
    results.claims = { cases: rows.length, right: rows.length - wrong.length, wrong: wrong.map((r) => r.id) };
    process.stdout.write(`\n-- the recorded rulings (${rows.length} proposals) --\n`);
    for (const r of wrong)
      process.stdout.write(
        `MISS  ${r.id}: refused [${r.got.join(", ")}], a person would refuse [${r.want.join(", ")}]${r.note ? ` - ${r.note}` : ""}\n`,
      );
    process.stdout.write(`rulings: ${results.claims.right}/${rows.length} right\n`);
    if (wrong.length) process.exitCode = 1;
  }

  // The dismissals half: the code review's disproof rules against eval/dismissals.json - a dismissal a person would take
  // must stand, and one that cites no checkable fact, the wrong kind for the facts, or an escalating or critical finding
  // must be refused, read through the live tree and the shipped escalation classes. Pure, so it runs with every eval.
  if (!verdictsOnly && part("dismissals")) {
    const rows = scoreDismissalGold(JSON.parse(readFileSync(path.join(HERE, "eval", "dismissals.json"), "utf8")), ROOT);
    const wrong = rows.filter((r) => !r.ok);
    results.dismissals = { cases: rows.length, right: rows.length - wrong.length, wrong: wrong.map((r) => r.id) };
    process.stdout.write(`\n-- the dismissals (${rows.length} cases) --\n`);
    for (const r of wrong)
      process.stdout.write(
        `MISS  ${r.id}: got ${outcomeText(r.got)}, a person would have ${outcomeText(r.want)}${r.note ? ` - ${r.note}` : ""}\n`,
      );
    process.stdout.write(`dismissals: ${results.dismissals.right}/${rows.length} right\n`);
    if (wrong.length) process.exitCode = 1;
  }

  // The member half: the member roster against eval/member-goals.json - a member's goal read from their own words, the
  // gold naming the rows it is about (judged on each row's jev question, never its keywords). The keyword arm is pure
  // and free; the Jev arm asks the roster's questions exactly as dredd.mjs --member does (buildMemberQuestions, the
  // keywords filling the gaps), and its fallbacks count like every other Jev arm's.
  if (!verdictsOnly && part("members")) {
    const roster = loadMemberBench(ROOT);
    const goals = JSON.parse(readFileSync(path.join(HERE, "eval", "member-goals.json"), "utf8")).goals;
    const memberAnswers = arms.includes("jev")
      ? await mapWithConcurrency(goals, JEV_CONCURRENCY, (g) =>
          askJev(buildMemberQuestions(roster, g.ask), { escalate, timeoutMs: 60_000 }),
        )
      : [];
    const rows = goals.map((g, index) => {
      const armRows = {};
      for (const arm of arms) {
        let answers;
        let note = "";
        if (arm === "jev") {
          const res = memberAnswers[index];
          const heuristic = memberHeuristicAnswers(roster, g.ask);
          if (!res.answers) {
            note = `jev unavailable: ${res.reason}`;
            results.jevFallbacks += 1;
            answers = heuristic;
          } else {
            const merged = mergeAnswers(res.answers, heuristic);
            answers = merged.answers;
            if (merged.filled.length)
              note = `jev left ${merged.filled.length} unanswered, the keywords filled: ${merged.filled.join(", ")}`;
            spend(res);
          }
        } else answers = memberHeuristicAnswers(roster, g.ask);
        armRows[arm] = { s: scoreMemberGoal(g, answers), note };
      }
      return { id: g.id, ask: g.ask, must: g.must, mustNot: g.mustNot, arms: armRows };
    });
    const tally = {};
    for (const arm of arms) {
      const rs = rows.map((r) => r.arms[arm].s);
      tally[arm] = {
        must: [rs.reduce((n, s) => n + s.must.length - s.missed.length, 0), rs.reduce((n, s) => n + s.must.length, 0)],
        mustNot: [rs.reduce((n, s) => n + s.mustNot.length - s.wrongly.length, 0), rs.reduce((n, s) => n + s.mustNot.length, 0)],
        exact: rs.filter((s) => s.exact).length,
        n: rows.length,
        misses: rs.flatMap((s) => [...s.missed.map((id) => `${s.id}: missed ${id}`), ...s.wrongly.map((id) => `${s.id}: wrongly ${id}`)]),
      };
    }
    results.members = { goals: rows.length, arms: tally, rows };
    process.stdout.write(`\n-- the member goals (${rows.length} goals) --\n`);
    for (const arm of arms) for (const m of tally[arm].misses) process.stdout.write(`MISS  ${m} (${arm})\n`);
    process.stdout.write(`${"member goals".padEnd(18)}${"must recall".padEnd(14)}${"mustNot prec".padEnd(14)}exact\n`);
    for (const [arm, t] of Object.entries(tally))
      process.stdout.write(`${arm.padEnd(18)}${pct(t.must).padEnd(14)}${pct(t.mustNot).padEnd(14)}${t.exact}/${t.n}\n`);
  }

  // The routing half (lib/routing.mjs): the bench's own lines, no model - a collision between two instruments' lines
  // fails the run, and so does a training rank-1 ratio under --min-rank1. Only the training asks' misses and tallies
  // are printed and saved: the rewriter reads this output in the loop, so a held-out (or all-asks) score here would
  // let the next rewrite see what it is judged on.
  if (!verdictsOnly && part("routing")) {
    const report = routingReport(bench, asks);
    const gate = routingGate(report, { minRank1 });
    const trainMisses = report.rows.filter((r) => !r.holdout && r.s.misses.length).map((r) => ({ id: r.id, misses: r.s.misses }));
    results.routing = { threshold: report.threshold, collisions: report.collisions, train: report.train, trainMisses, gate };
    process.stdout.write(
      `\n-- the routing (${routable(bench).length} instruments by their own lines, ${report.train.n} training asks, collision bar ${report.threshold}) --\n`,
    );
    for (const m of trainMisses) process.stdout.write(`MISS  ${m.id}: ${m.misses.join("; ")}\n`);
    for (const f of gate.failures) process.stdout.write(`FAIL  ${f}\n`);
    const t = report.train;
    process.stdout.write(
      `routing training  rank-1 ${pct(t.rank1).padEnd(14)}top-${TOP_K} ${pct(t.topK).padEnd(14)}mustNot pairs ${pct(t.pairs)}\n`,
    );
    process.stdout.write(`routing: ${report.collisions.length} collision(s), ${gate.ok ? "gate ok" : "gate FAILED"}\n`);
    if (!gate.ok) process.exitCode = 1;
  }

  // A full, unreplayed Jev run is a sample of the judge: the only kind that can speak for its stability or its cost.
  const fullJev = Boolean(
    results.arms.jev && !results.partial && !replay && !results.jevFallbacks && !results.jevUngraded && !verdictsOnly && part("asks"),
  );
  let stability = readNoise(NOISE_FILE)?.graderStability ?? null;
  const suite = suiteHash(results.decisionHash, readFileSync(path.join(HERE, "eval", "asks.json"), "utf8"));
  if (flag("--stability") || (fullJev && stabilityDue(stability, suite))) {
    if (!fullJev) usage("--stability needs a full Jev run (no --only, --limit, --replay, --heuristic-only or --verdicts)");
    const rec = await measureStability({ rows: results.rows, bench, escalate, spend });
    if (rec.questions) {
      stability = { at: new Date().toISOString(), suite, ...rec };
      patchNoise({ graderStability: stability });
    }
  }
  results.graderStability = stability;
  results.jevCostUsd = Math.round(jevCost * 1e5) / 1e5;
  results.cost = costPerDocket({
    costUsd: results.jevCostUsd,
    wallMs: Date.now() - startedAt,
    tokens: tokensKnown && jevTokens ? jevTokens : null,
    asks: asks.length,
  });
  writeFileSync(path.join(outDir, "results.json"), JSON.stringify(results, null, 2));
  if (Object.keys(results.arms).length) {
    process.stdout.write(
      `\nclassifier p >= 0.5 (what a bench question or keyword is tuned against)\n${"arm".padEnd(10)}${"class".padEnd(14)}${"domain".padEnd(14)}${"scope".padEnd(12)}${"deleg".padEnd(12)}${"must".padEnd(14)}${"anyOf".padEnd(12)}${"mustNot".padEnd(14)}perfect\n`,
    );
    for (const [arm, t] of Object.entries(results.arms)) {
      process.stdout.write(
        `${arm.padEnd(10)}${pct(t.class).padEnd(14)}${pct(t.domain).padEnd(14)}${pct(t.scope).padEnd(12)}${pct(t.delegation).padEnd(12)}${pct(t.must).padEnd(14)}${pct(t.anyOf).padEnd(12)}${pct(t.mustNot).padEnd(14)}${t.perfect}/${asks.length}\n`,
      );
    }
    process.stdout.write(
      `\nconvened (what the docket actually runs)\n${"arm".padEnd(10)}${"must".padEnd(14)}${"anyOf".padEnd(12)}${"mustNot".padEnd(14)}perfect\n`,
    );
    for (const [arm, t] of Object.entries(results.arms)) {
      process.stdout.write(
        `${arm.padEnd(10)}${pct(t.convMust).padEnd(14)}${pct(t.convAnyOf).padEnd(12)}${pct(t.convMustNot).padEnd(14)}${t.convPerfect}/${asks.length}\n`,
      );
    }
    if (Object.keys(results.holdout).length) {
      const nHeld = results.rows.filter((r) => held.has(r.id)).length;
      const share = (k, size) => `${k}/${size} (${size ? Math.round((100 * k) / size) : 0}%)`;
      process.stdout.write(`\nheld out (never shown to a fixer) against trained: convened perfect\n`);
      for (const [arm, h] of Object.entries(results.holdout))
        process.stdout.write(
          `${arm.padEnd(10)}trained ${share(h.trained.convPerfect, results.rows.length - nHeld).padEnd(16)}held out ${share(h.heldOut.convPerfect, nHeld)}\n`,
        );
    }
    // The headroom rule: past 95% convened right there is nothing left to hillclimb on accuracy, so the objective is cost.
    const baselineArm = results.arms.jev ? "jev" : Object.keys(results.arms)[0];
    const baseline = asks.length ? results.arms[baselineArm].convPerfect / asks.length : null;
    const room = headroom(baseline);
    process.stdout.write(`\n${room.line}\n`);
    results.objective = room.objective;
    if (results.cost.cents != null)
      process.stdout.write(
        `cost per docket: ${results.cost.cents} cents, ${results.cost.wallMs} ms wall${results.cost.tokens != null ? `, ${results.cost.tokens} tokens` : ", tokens not reported by Jev"}\n`,
      );
    process.stdout.write(`${stabilityLine(results.graderStability)}\n`);
    const ladderRec = readNoise(NOISE_FILE)?.ladder;
    process.stdout.write(
      ladderRec
        ? `model ladder (recorded ${String(ladderRec.at).slice(0, 10)}): ${ladderRec.ok ? "ok" : "BROKEN - the eval itself looks broken"}, ${ladderRec.rungs.map((r) => `${r.model} ${Math.round(r.score * 1000) / 10}%`).join(" < ")}\n`
        : "model ladder: not checked (eval.mjs --ladder <weak>,<strong>)\n",
    );
    // Against the last full Jev run and the best on record, through the measured noise band (lib/regularizers.mjs):
    // the rule's "compare its tally with the last run's" as numbers, so a coin flip is never read as a fix.
    if (results.arms.jev && !results.partial && !replay && !results.jevFallbacks && !results.jevUngraded) {
      const prior = fullJevRuns(ROOT, { limit: 8, exclude: outDir });
      if (prior.length) {
        const noise = readNoise(NOISE_FILE);
        const reads = againstNoise({ before: prior[0].results, history: prior.map((p) => p.results), after: results, noise });
        process.stdout.write(
          `\nagainst the last full Jev run (${prior[0].file}) and the best of the last ${prior.length}, ${noise ? `noise band of ${noise.runs} runs, ${String(noise.at).slice(0, 10)}` : "NO noise band measured (eval.mjs --noise 3): every move below may be a coin"}\n`,
        );
        for (const r of reads) process.stdout.write(noiseLine(r.metric, r, "asks"));
      }
    }
    if (Object.keys(results.trials).length) {
      process.stdout.write(
        `\ntrial signals, convened AS IF they voted (they do not until they beat their arm above)\n${"arm+signal".padEnd(20)}${"must".padEnd(14)}${"anyOf".padEnd(12)}${"mustNot".padEnd(14)}perfect\n`,
      );
      for (const [label, t] of Object.entries(results.trials)) {
        process.stdout.write(
          `${label.padEnd(20)}${pct(t.convMust).padEnd(14)}${pct(t.convAnyOf).padEnd(12)}${pct(t.convMustNot).padEnd(14)}${t.convPerfect}/${asks.length}\n`,
        );
      }
    }
  }
  if (Object.keys(results.seats.arms).length) {
    process.stdout.write(
      `\n${"seats".padEnd(18)}${"must sit".padEnd(14)}${"topped".padEnd(8)}${"must not".padEnd(14)}${"extra".padEnd(8)}exact rosters\n`,
    );
    for (const [arm, t] of Object.entries(results.seats.arms)) {
      process.stdout.write(
        `${arm.padEnd(18)}${pct(t.sit).padEnd(14)}${String(t.topped).padEnd(8)}${pct(t.mustNot).padEnd(14)}${String(t.extra).padEnd(8)}${t.exact}/${t.n}\n`,
      );
    }
    printPartNoise("seats", results, { replay, outDir });
  }
  if (Object.keys(results.experts.arms).length) {
    process.stdout.write(
      `\n${"experts".padEnd(18)}${"wanted".padEnd(14)}${"first wanted".padEnd(16)}${"must not".padEnd(14)}${"extra".padEnd(8)}${"seats".padEnd(8)}exact units\n`,
    );
    for (const [arm, t] of Object.entries(results.experts.arms)) {
      process.stdout.write(
        `${arm.padEnd(18)}${pct(t.want).padEnd(14)}${pct(t.lead).padEnd(16)}${pct(t.mustNot).padEnd(14)}${String(t.extra).padEnd(8)}${String(t.seats).padEnd(8)}${t.exact}/${t.n}\n`,
      );
    }
    printPartNoise("experts", results, { replay, outDir });
  }
  // A Jev arm that silently ran on keywords would grade the fallback and call it Jev - a false green over the
  // wrong judge. Every fallback is counted, and the run exits non-zero when any happened, so a tally is never
  // read as Jev's unless it was.
  if (results.jevUngraded) {
    process.stdout.write(`
⚠ the jev arm left ${results.jevUngraded} ask(s) NOT GRADED (still unanswered after the retries) - the tallies above cover the rest, and this is not a full Jev eval.
`);
  }
  if (results.jevFallbacks) {
    process.stdout.write(
      `\n⚠ the jev arm fell back to keywords on ${results.jevFallbacks} item(s) (see [jev unavailable] above) - those rows grade the fallback, not Jev.\n`,
    );
  }
  process.stdout.write(`Jev spend this run: $${results.jevCostUsd}  → ${outDir}\n`);
  if ((results.jevFallbacks || results.jevUngraded) && !flag("--heuristic-only")) process.exitCode = 1;
}

// Run only when invoked as a script: the scorers above are imported by tests/eval-gate.spec.mjs, and importing
// must never start a paid Jev run.
if (isMainModule(import.meta.url)) {
  main()
    .catch((err) => {
      process.stderr.write(`eval: ${err?.stack || err}\n`);
      process.exitCode = 1;
    })
    .finally(closeBrain);
}
