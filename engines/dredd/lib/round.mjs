// dredd/lib/round.mjs - a hearing over a SUE ROUND that already happened (sue/round.mjs), and the rule that
// sends a stalled rating to the design board instead of the copy drafter.
//
// the Chair, 2026-10-01: "Students and teachers say what they need; the boardroom's experts ... decide how, in a way the
// users didn't know they needed ... The stars are the target, and it should improve as it goes, every round." Lift's
// class unit sat at 3 stars for nine rounds with no table after round 9, and every hearing that did sit ended in the
// drafter's "exact copy change and nothing else" (lib/resolve.mjs): a design problem (students stop in parts 1 and 2)
// turned into a wording patch each time. So a round hearing reads the round's own numbers against its target, and when
// the trend says design (a stall, or most people stopping early) the design board sits after the review table and the
// resolution is a REDESIGN that board scores (lib/resolve.mjs draftRedesign), never a copy change.
import { writeFileSync } from "node:fs";
import path from "node:path";

import { DEFAULT_TARGET, STALL_BAND } from "../../sue/lib/rounds.mjs";

/** What a round hearing still convenes: the round brought the people, so only the page's own pulse runs (the room reads
 *  its words and rung one); SUE, the focus group, the critic's wave and the flow walk would send or wait on a field
 *  that has already landed. */
export const ROUND_KEEPS = new Set(["page-pulse"]);

const one = (n) => Math.round(n * 10) / 10;
const pct = (x) => `${Math.round(x * 100)}%`;

/** The round's numbers against its target, in one line: what the verdict and the evidence brief lead with. */
export function targetLine(round) {
  const t = round?.target || DEFAULT_TARGET;
  const r = round?.row || {};
  const tr = round?.trend || {};
  const need = r.people ? Math.ceil(t.finishShare * r.people - 1e-9) : null;
  return (
    `TARGET ${t.stars} stars and ${need !== null ? `${need} of ${r.people}` : pct(t.finishShare)} finishing, ${t.inARow} rounds running. ` +
    `THIS ROUND (${round?.series || "?"} round ${r.round ?? "?"}): ${r.stars ?? "-"} stars, ${r.finished ?? "-"} of ${r.people ?? "-"} finished` +
    `${tr.history?.length ? `; the series so far ${tr.history.join(", ")}` : ""}. ${String(tr.state || "").toUpperCase() || "-"}: ${tr.why || "-"}`
  );
}

/** What the room reads as the round's own evidence log (every .log in a docket is evidence): the target line, where
 *  each person stopped and why, and what the critics who walked beside them saw. */
export function renderRoundLog(round) {
  const r = round.row || {};
  const lines = [`$ the round (sue/round.mjs) - ${round.series}, round ${r.round ?? "?"}`, "", targetLine(round), ""];
  lines.push(
    `Where they stopped: ${
      Object.entries(r.reached || {})
        .map(([k, n]) => `${n} ${k}`)
        .join(", ") || "not measured"
    }`,
    "",
  );
  for (const e of r.each || [])
    lines.push(
      `- ${e.who}: ${e.stars ?? "-"} stars, ${e.finished ? "finished" : e.reached ? `stopped in part ${e.reached.at} of ${e.reached.of}` : "did not finish"}${e.whyStopped ? ` - "${String(e.whyStopped).replace(/\s+/g, " ").slice(0, 400)}"` : ""}`,
    );
  const critics = r.critics || [];
  if (critics.length) {
    lines.push("", "The critics who walked the same path (experts, not users; their stars are not counted):");
    for (const c of critics)
      for (const d of (c.drops || []).slice(0, 4))
        lines.push(`- ${c.who}, drop${d.severity ? ` ${d.severity}` : ""}: ${String(d.text).replace(/\s+/g, " ").slice(0, 400)}`);
  }
  lines.push("", "--- exit 0 ---");
  return `${lines.join("\n")}\n`;
}

/**
 * A docket built from a round (dredd.mjs --round-file): the round rides on the docket, its report is the docket's
 * sue-report.json (rung four, Grandma Sue, the drafter's screens), its log is evidence, and only ROUND_KEEPS convene.
 * Mutates `docket`; returns the instruments it dropped, by id.
 */
export function applyRound(docket, docketDir, round, file = null) {
  docket.round = {
    file,
    series: round.series,
    key: round.key || null,
    target: round.target || DEFAULT_TARGET,
    trend: round.trend || null,
    row: round.row || null,
  };
  const dropped = (docket.convene || []).filter((c) => !ROUND_KEEPS.has(c.id)).map((c) => c.id);
  docket.convene = (docket.convene || []).filter((c) => ROUND_KEEPS.has(c.id));
  if (dropped.length) docket.roundDropped = dropped;
  if (round.report) writeFileSync(path.join(docketDir, "sue-report.json"), JSON.stringify(round.report, null, 2));
  writeFileSync(path.join(docketDir, "round.log"), renderRoundLog(round));
  return dropped;
}

/**
 * The stars a page's visitors gave, build by build, from its SUE scoreboard row (sue/lib/workspace.mjs), in the
 * order the builds were first seen. Pure.
 */
export function scoreboardSeries(row) {
  if (!row?.byBuild) return [];
  return Object.entries(row.byBuild)
    .filter(([, b]) => b?.starsCounted)
    .map(([commit, b]) => ({ commit, stars: one(b.starsSummed / b.starsCounted), runs: b.runs }));
}

/**
 * Whether this hearing's resolution is the DESIGN BOARD's: a redesign, not a copy change. A round whose trend says so
 * (a stall or an early stop below the target), or a page whose SUE scoreboard shows two builds in a row in the same
 * STALL_BAND below the target with no new best. Pure. Returns { why, source } or null.
 */
export function designCall({ round = null, scoreboard = null, target = DEFAULT_TARGET } = {}) {
  if (round?.trend?.next === "design") return { why: round.trend.why, source: "round" };
  if (round) return null;
  const series = scoreboardSeries(scoreboard);
  if (series.length < 2) return null;
  const [prev, last] = series.slice(-2);
  const best = Math.max(...series.slice(0, -1).map((s) => s.stars));
  if (last.stars >= target.stars) return null;
  if (Math.abs(last.stars - prev.stars) <= STALL_BAND && last.stars <= best + 0.05)
    return {
      why: `SUE's visitors rated the last ${series.length} builds ${series.map((s) => s.stars).join(", ")} against a target of ${target.stars}: the rating has stalled, so the problem is design, not wording`,
      source: "scoreboard",
    };
  return null;
}

/** The design board's question: the users said what they need; the board decides how, as one redesign. */
export function designAsk({ docket, call }) {
  const lead = docket.round ? targetLine(docket.round) : call?.why || "";
  return [
    lead,
    `The users have said what they need: their words, where each of them stopped, and what the critics who walked beside them saw are in your material.`,
    `You are the design board. Decide HOW this should work and play so that they get to the end and want the next screen: one redesign of the experience, in a way they did not know to ask for (a mechanic, a structure, a feedback loop, a reason to keep going), never a wording patch or an answer-key fix.`,
    `Name the one redesign, what the person does differently on each screen it touches, what it keeps, and what the next round must show if it worked.`,
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 3000);
}

/** The member's line when a redesign is on the table: score whether it changes where people stop. */
export const DESIGN_PROPOSAL_SITTING =
  "A redesign is on the table, under 'The proposal' in your material. Will it change where these people stop and how they rate it - judged against their own words and where each one stopped? Is it buildable as written? Quote the line that is still wrong, if one is, and name the one change you would still make. Score the REDESIGN, not the product as it is.";
