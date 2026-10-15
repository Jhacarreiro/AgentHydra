// sue/lib/rounds.mjs - a ROUND is several SUE runs sent at the same product at once (a class of students, a panel of
// donors), scored against a TARGET, and kept as a series so each round is read against the ones before it.
//
// the Chair, 2026-10-01: "The stars are the target, and it should improve as it goes, every round. The class unit sat at
// 3 stars for nine rounds." Nothing in SUE or Dredd set a target, noticed a stall, or sent a stalled rating to the
// designers, so nine rounds of local fixes (wording, answer keys, screens) went by while students kept stopping in parts
// 1 and 2. This file is that memory and that rule: `trend` says met, improving, or STALLED, and a stalled or early-stop
// round's next work is the design board's (Dredd's round hearing, `dredd.mjs --round-file`), never another patch.
//
// One row per round in <workspace>/.sue/rounds/<series>.jsonl (a round re-reported replaces its own row). Pure but
// for the two file functions at the bottom.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { withFileLock } from "./run-dir.mjs";

/** The bar a series is held to unless its plan says otherwise (Lift's SOP, "When a lesson is done", 2026-10-01): 4.5
 *  stars or more and five of six finishing, two rounds running. */
export const DEFAULT_TARGET = Object.freeze({ stars: 4.5, finishShare: 5 / 6, inARow: 2 });
/** Two rounds this close in stars, with no new best, are the same rating: the problem is design, not wording. */
export const STALL_BAND = 0.3;
/** Fewer than this share finishing is an early stop: people leave before the end, which no wording fix reaches. */
export const EARLY_STOP_SHARE = 0.5;
/** Rounds under target with no new best (best within 5%): after this many, the series is stuck and won't continue. */
export const STUCK_THRESHOLD = 3;

/** The target a plan asks for, every field defaulted, a "5 of 6" finish written either way.
 *  If target.starsVs is set and a reference round exists, use reference stars minus within as the bar. */
export function targetOf(plan = {}, workspace = null) {
  const t = plan.target || {};
  const finishShare =
    typeof t.finishShare === "number" ? t.finishShare : t.finished && t.of ? t.finished / t.of : DEFAULT_TARGET.finishShare;
  let stars = typeof t.stars === "number" ? t.stars : DEFAULT_TARGET.stars;
  let reference = null;

  // If starsVs is set, try to use the reference series' latest stars
  if (t.starsVs && workspace && typeof t.starsVs === "object") {
    const refSeries = t.starsVs.series;
    const within = typeof t.starsVs.within === "number" ? t.starsVs.within : 0.2;
    if (refSeries) {
      const refKey = seriesKey(refSeries, "people");
      const refRounds = readRounds(workspace, refKey);
      if (refRounds.length > 0) {
        const latestRef = refRounds[refRounds.length - 1];
        if (typeof latestRef.stars === "number") {
          stars = Math.max(1, Math.round((latestRef.stars - within) * 100) / 100);
          reference = { stars: latestRef.stars, within };
        }
      }
    }
  }

  const inARow = Number.isInteger(t.inARow) && t.inARow > 0 ? t.inARow : DEFAULT_TARGET.inARow;
  return { stars, finishShare, inARow, ...(reference ? { reference } : {}), ...(t.starsVs ? { starsVs: t.starsVs.series } : {}) };
}

/** A round meets the target: its people's stars and the share who finished both clear it. A round with no stars or
 *  no people never does. */
export function meetsTarget(row, target = DEFAULT_TARGET) {
  if (typeof row?.stars !== "number" || !row.people) return false;
  return row.stars >= target.stars && row.finished / row.people >= target.finishShare - 1e-9;
}

const one = (n) => Math.round(n * 10) / 10;

/**
 * What the rounds so far say the next round's work is. `rows` are a series' COMPLETE rounds in order.
 *   done      the last `inARow` rounds all met the target
 *   met       the last round met it; the next round confirms it
 *   ceiling   (needs `referenceAt`) STUCK_THRESHOLD rounds after the ceiling check, none a new best, under target: the series is over until the build or plan changes
 *   stuck     under target and STUCK_THRESHOLD rounds since the best with no new best (stars or finishing): the design board takes it and `start` waits for a ceiling check
 *   stalled   two rounds in the same STALL_BAND with no new best: the design board takes it
 *   early     under EARLY_STOP_SHARE finished: people leave before the end, so the design board takes it
 *   improving a new best, still under the target: fix the round's biggest problem and send the next round
 *   first     one round, under the target: fix its biggest problem
 * `next` is "done", "confirm", "design" or "fix".
 */
export function trend(rows, target = DEFAULT_TARGET, { referenceAt = null } = {}) {
  const done = (rows || []).filter((r) => r && typeof r.stars === "number");
  if (!done.length) return { state: "none", next: "fix", why: "no complete round yet", rounds: 0 };
  const last = done.at(-1);
  const prev = done.length > 1 ? done.at(-2) : null;
  const earlier = done.slice(0, -1);
  const bestBefore = earlier.length ? Math.max(...earlier.map((r) => r.stars)) : null;
  const best = Math.max(...done.map((r) => r.stars));
  // "Held N rounds running" is only ever earned by fresh measurements: a reused round (its visits are an earlier
  // round's, said in its `reused` list) at target neither adds to the run nor ends it; under target it ends it.
  const reusedRow = (r) => Array.isArray(r?.reused) && r.reused.length > 0;
  let metRun = 0;
  for (let i = done.length - 1; i >= 0 && meetsTarget(done[i], target); i -= 1) if (!reusedRow(done[i])) metRun += 1;
  let under = 0;
  for (let i = done.length - 1; i >= 0 && !meetsTarget(done[i], target); i -= 1) under += 1;
  // A round is a new best when its stars beat the best by more than 0.05 OR its finishing share beats the best share;
  // a tie resets nothing. roundsSinceBest counts the rounds AFTER the latest new best.
  let bestStars = -Infinity;
  let bestShare = -Infinity;
  let lastBestIndex = 0;
  done.forEach((r, i) => {
    const s = r.people ? r.finished / r.people : 0;
    if (i === 0 || r.stars > bestStars + 0.05 || s > bestShare + 1e-9) {
      lastBestIndex = i;
    }
    bestStars = Math.max(bestStars, r.stars);
    bestShare = Math.max(bestShare, s);
  });
  const roundsSinceBest = done.length - 1 - lastBestIndex;
  const share = last.people ? last.finished / last.people : 0;
  const base = {
    rounds: done.length,
    last: {
      round: last.round ?? done.length,
      stars: last.stars,
      finished: last.finished,
      people: last.people,
      ...(reusedRow(last) ? { reused: last.reused } : {}),
    },
    prev: prev ? { stars: prev.stars, finished: prev.finished, people: prev.people } : null,
    best,
    metRun,
    roundsUnder: under,
    roundsSinceBest,
    history: done.slice(-8).map((r) => r.stars),
  };
  if (metRun >= target.inARow) return { ...base, state: "done", next: "done", why: `the target held ${metRun} round(s) running` };
  if (metRun > 0)
    return { ...base, state: "met", next: "confirm", why: `the target was met once; it is done after ${target.inARow} rounds running` };
  if (reusedRow(last) && meetsTarget(last, target))
    return {
      ...base,
      state: "reused",
      next: "fresh",
      why: "the last round reached the target only on reused visits, which earn no streak: measure it fresh",
    };
  const noNewBest = bestBefore !== null && last.stars <= bestBefore + 0.05;
  const stalled = Boolean(prev) && Math.abs(last.stars - prev.stars) <= STALL_BAND && noNewBest;
  const stuck = !meetsTarget(last, target) && roundsSinceBest >= STUCK_THRESHOLD;
  const early = share < EARLY_STOP_SHARE;
  const gap = one(target.stars - last.stars);
  // AT CEILING: the ceiling check was run (a reference round exists), STUCK_THRESHOLD complete rounds came after it, and
  // none of them is a new best. It outranks stuck and stalled; the series is over until the build or the plan changes.
  if (referenceAt) {
    // Rounds after BOTH the ceiling check and the latest new best (the best round itself, round 1 included, is not one).
    const afterIdx = done.map((r, i) => i).filter((i) => i > lastBestIndex && String(done[i].at || "") > String(referenceAt));
    if (afterIdx.length >= STUCK_THRESHOLD) {
      const shareOf = (r) => (r.people ? r.finished / r.people : 0);
      const top = done.reduce((a, r) =>
        r.stars > a.stars + 0.05 || (r.stars >= a.stars - 0.05 && shareOf(r) > shareOf(a) + 1e-9) ? r : a,
      );
      const topRow = { round: top.round ?? done.indexOf(top) + 1, stars: top.stars, finished: top.finished, people: top.people };
      return {
        ...base,
        state: "ceiling",
        ceiling: true,
        best: top.stars,
        bestRound: topRow,
        roundsSinceCeilingCheck: afterIdx.length,
        next: "ceiling",
        why: `this panel's best for this page is ${topRow.stars} stars, ${topRow.finished} of ${topRow.people} finished (round ${topRow.round}); ${afterIdx.length} rounds since the ceiling check with no new best`,
      };
    }
  }
  if (stuck)
    return {
      ...base,
      state: "stuck",
      stuck: true,
      next: "design",
      why: `${roundsSinceBest} round(s) since the best with no new best in stars or finishing (${base.history.join(", ")}): the series is stuck, so the design board takes it and a new round starts only after a ceiling check`,
    };
  if (stalled)
    return {
      ...base,
      state: "stalled",
      stalled: true,
      early,
      next: "design",
      why: `${under} round(s) under the target and no new best (${base.history.join(", ")}): the problem is design, not wording, so the design board takes the round's biggest problem`,
    };
  if (early)
    return {
      ...base,
      state: "early",
      early: true,
      next: "design",
      why: `only ${last.finished} of ${last.people} finished: people leave before the end, which no wording fix reaches, so the design board takes where they stop`,
    };
  if (bestBefore !== null && last.stars > bestBefore + 0.05)
    return { ...base, state: "improving", next: "fix", why: `a new best (${last.stars}), still ${gap} under the target` };
  return { ...base, state: done.length === 1 ? "first" : "flat", next: "fix", why: `${gap} under the target` };
}

/** The lines a person reads first: the target, this round, the trend, and the next work.
 *  If target is a relative bar from a reference round, show it as "X stars vs the reference's Y (bar Z)". */
export function renderTrend(t, target = DEFAULT_TARGET, { tape = false } = {}) {
  const pct = (x) => `${Math.round(x * 100)}%`;
  const bar = target.reference
    ? `${target.stars} stars (the reference's ${target.reference.stars} minus ${target.reference.within})`
    : target.starsVs
      ? `${target.stars} stars (no reference round of ${target.starsVs} yet, so the fixed bar)`
      : `${target.stars} stars`;
  const targetLine = `TARGET   ${bar} and ${pct(target.finishShare)} finishing, ${target.inARow} rounds running`;
  const lines = [targetLine];
  if (!t?.last) return [...lines, "NO ROUND YET"];
  const vs = target.reference ? ` vs the reference's ${target.reference.stars} (bar ${target.stars})` : "";
  lines.push(
    `ROUND    ${tape ? "TAPE " : ""}${t.last.stars} stars${vs}, ${t.last.finished} of ${t.last.people} finished${t.prev ? ` (last round ${t.prev.stars}, ${t.prev.finished} of ${t.prev.people})` : ""}; the series so far: ${t.history.join(", ")}`,
  );
  lines.push(`STATE    ${t.state === "ceiling" ? "AT CEILING" : t.state.toUpperCase()}: ${t.why}`);
  const next = {
    done: "nothing: the target held. Ship it.",
    confirm: "send the next round unchanged but for its concrete findings; two rounds running ends it.",
    stop: `STUCK: the series has ${t.roundsSinceBest} round(s) since its best with no improvement. Run the ceiling check (round.mjs start --reference: how does this same panel rate a product it already knows?) and planted-bug check (does the panel notice deliberate defects?) before more rounds.`,
    ceiling:
      'the series is over: ship the best build, or change the page (a new build) or the plan before another round. `start` refuses until one changes (--despite-ceiling "<reason>" overrides).',
    design:
      "the design board (games, product design, attention, psychology) redesigns where people stop; build it, then the next round. The round's review table and the board run with `round.mjs table` (report starts it by itself).",
    fresh: "send the round again with --fresh: only fresh measurements count toward the target held.",
    fix: "fix the round's biggest problem (its review table names it), then the next round.",
  }[t.next];
  if (t.last.reused)
    lines.push(
      `REUSED   round ${t.last.round} reused ${t.last.reused.length} student visit(s) from earlier rounds (${t.last.reused.join(", ")}): a reused round can break a streak but never extend one, so "target held N rounds running" counts fresh measurements only`,
    );
  lines.push(`NEXT     ${next}`);
  return lines;
}

/** When the plan's ceiling check last ran (its latest reference round's `at`), or null: what `trend` needs for `ceiling`. */
export function referenceAtOf(plan, workspace) {
  if (!plan?.reference?.series || !workspace) return null;
  const rows = readRounds(workspace, seriesKey(plan.reference.series, "people")).filter((r) => typeof r.stars === "number");
  return rows.length ? String(rows.at(-1).at || rows.at(-1).id) : null;
}

/** The series a round kind is kept under: plain rounds, focus groups and teacher rounds are not the same instrument,
 *  so each is read only against its own kind. */
export function seriesKey(series, kind = "people") {
  const base = String(series || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!base) throw new Error("a round plan needs a `series` name (the product and unit it tests)");
  return kind && kind !== "people" ? `${base}.${kind}` : base;
}

export function roundsFile(workspace, key) {
  return path.join(workspace, ".sue", "rounds", `${key}.jsonl`);
}

/** Every round of a series, in order, the last copy of each round id winning. */
export function readRounds(workspace, key) {
  const file = roundsFile(workspace, key);
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row?.id) byId.set(row.id, row);
    } catch {
      /* a half-written last line is skipped, never the whole series */
    }
  }
  return [...byId.values()].sort((a, b) => String(a.at || a.id).localeCompare(String(b.at || b.id)));
}

/** Saves a round, replacing its own earlier row (a report re-read while the round was still running). Numbers the
 *  round within its series. A rewrite never erases a stopwatch mark: the earlier row's marks and the new row's are
 *  merged. Returns the saved row. The read and the rewrite hold the series file's lock: two arms of one A/B reporting
 *  in the same second each read N rows and wrote N+1, so one round vanished (Raise Buddy rb-edge-ab2, 2026-10-12: two of
 *  four rounds lost). */
export function writeRound(workspace, key, row) {
  return withFileLock(roundsFile(workspace, key), () => writeRoundLocked(workspace, key, row));
}

function writeRoundLocked(workspace, key, row) {
  const before = readRounds(workspace, key);
  const own = before.find((r) => r.id === row.id);
  const rows = before.filter((r) => r.id !== row.id);
  const marks = mergeMarks(own?.marks, row.marks);
  // A new round counts on from the highest number kept, so a series seeded from an older record (Lift's rounds 10 to
  // 18, from its kids' ledger) keeps that record's numbers.
  const saved = {
    ...row,
    ...(marks.length ? { marks } : {}),
    round: row.round ?? own?.round ?? Math.max(0, ...rows.map((r) => Number(r.round) || 0)) + 1,
  };
  const all = [...rows, saved].sort((a, b) => String(a.at || a.id).localeCompare(String(b.at || b.id)));
  const file = roundsFile(workspace, key);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${all.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return saved;
}

/** Stopwatch marks ({step, at, event: "start" | "end"}) from any number of lists, each kept once and in time order:
 *  a mark saved both in the round's state and in its row is one mark, and a retried step keeps every start and end. */
export function mergeMarks(...lists) {
  const byKey = new Map();
  for (const m of lists.flat()) if (m?.step && m.at && m.event) byKey.set(`${m.step}|${m.event}|${m.at}`, m);
  return [...byKey.values()].sort((a, b) => String(a.at).localeCompare(String(b.at)));
}

/** Adds a stopwatch mark to a round's row. A round with no row yet (its report writes the row only once every user has
 *  rated) returns false: the caller keeps the mark in the round's saved state, and the report merges it in. */
export function markRound(workspace, key, roundId, mark) {
  const own = readRounds(workspace, key).find((r) => r.id === roundId);
  if (!own) return false;
  writeRound(workspace, key, { ...own, marks: mergeMarks(own.marks, [mark]) });
  return true;
}
