/**
 * pipeline.spec - the filter and score stages every instrument passes on its way onto a docket.
 * ==============================================================================================
 *
 * WHAT: `node --test dredd/tests/pipeline.spec.mjs`. Drives lib/pipeline.mjs's pure stages on made-up
 * instruments, then decideDocket's `home` and the render's KEPT HOME block on a real bench.
 *
 * WHY: the vetoes were anonymous lines inside decideDocket, so a docket could not say which rule kept an instrument
 * home and a rule could only be tested through a whole docket. Each filter is now named; these pin that every rule
 * that fires is reported (not only the first), that a bar miss names its bar, and that the docket carries the stage
 * and the scorer (Jev or the keywords) for every instrument it left home.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { BARS, decideDocket, heuristicAnswers, loadBench, renderDocket } from "../lib/docket.mjs";
import { FILTERS, filtersKeepingHome, homeLine, scoreStage } from "../lib/pipeline.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bench = loadBench(ROOT);
const ctx = (over = {}) => ({ grievance: true, subjects: [], askClass: "review", url: null, codeKind: false, roomAsked: false, ...over });

test("every filter has a unique id and a reason the docket can print", () => {
  const ids = FILTERS.map((f) => f.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const f of FILTERS) assert.ok(f.why.length > 10 && typeof f.keepsHome === "function", f.id);
});

test("a filtered instrument is told EVERY rule that kept it home, in order, and a feasible one none", () => {
  const visitor = { id: "critic", phase: 3, domains: ["visual"] };
  const home = filtersKeepingHome(visitor, 0.9, ctx({ grievance: false, codeKind: true }));
  assert.deepEqual(
    home.map((f) => f.id),
    ["no-grievance-no-visit", "code-matter-no-visit", "code-matter-page-only-judge"],
  );
  assert.ok(home.every((f) => f.why));
  // A named page makes it a page matter: the same visitor on a complaint is feasible.
  assert.deepEqual(filtersKeepingHome(visitor, 0.9, ctx({ url: "https://example.com/", codeKind: true })), []);
  // The room: unasked on a code matter it stays home whatever its p; asked, it may sit.
  const room = { id: "boardroom", phase: 2, domains: ["product"] };
  assert.deepEqual(
    filtersKeepingHome(room, 0.99, ctx({ codeKind: true })).map((f) => f.id),
    ["code-matter-room-unasked", "code-matter-page-only-judge"],
  );
  assert.deepEqual(filtersKeepingHome(room, 0.99, ctx({ codeKind: false, roomAsked: true })), []);
});

test("the score stage names the bar it measured against, and who holds a quick look's one slot", () => {
  const tool = { id: "copy-audit", phase: 1, domains: ["copy"] };
  const field = { id: "sue", phase: 3, domains: ["flow"] };
  assert.deepEqual(scoreStage(tool, 0.6, 2, BARS), { take: true, why: "p 0.6 clears the full bar 0.5" });
  assert.equal(scoreStage(field, 0.6, 1, BARS).why, "p 0.6 is under the focusedField bar 0.65");
  const seated = [{ id: "design-critic", phase: 3 }];
  assert.deepEqual(scoreStage(tool, 0.99, 0, BARS, seated), {
    take: false,
    why: "a quick look seats one instrument, and design-critic has the slot",
  });
  // A session skill costs nothing to name: it may sit beside the one.
  assert.equal(scoreStage({ id: "humanizer", phase: 4, domains: ["copy"] }, 0.87, 0, BARS, seated).take, true);
});

test("the docket's home says which stage kept each instrument home and whether Jev or the keywords scored it", () => {
  const ask = "tear dredd apart - have the room argue what the judge gets wrong, what should go and what is missing";
  const answers = heuristicAnswers(bench, ask);
  const yes = (p) => ({ answer: p >= 0.5 ? "yes" : "no", probabilities: { yes: p, no: 1 - p }, source: "test" });
  answers.ask_class = { answer: "review", confidence: 0.9, probabilities: {}, source: "test" };
  answers.domain = { answer: "code", confidence: 0.9, probabilities: {}, source: "test" };
  answers.scope = { answer: "2", confidence: 0.9, probabilities: {}, source: "test" };
  answers["inst:lilgranny"] = yes(0.5);
  const docket = decideDocket({ bench, ask, answers, source: "jev", paths: ["dredd"] });
  const seated = new Set(docket.convene.map((c) => c.id));
  assert.ok(docket.home.length > 0);
  for (const h of docket.home) {
    assert.ok(!seated.has(h.id), `${h.id} is both seated and home`);
    assert.ok(["filter", "bar", "cap", "bill"].includes(h.stage), `${h.id}: stage ${h.stage}`);
  }
  const granny = docket.home.find((h) => h.id === "lilgranny");
  assert.equal(granny.stage, "filter");
  assert.equal(granny.scoredBy, "jev");
  assert.ok(
    granny.filters.some((f) => f.id === "code-matter-no-visit"),
    JSON.stringify(granny),
  );
  // The instruments Jev left unanswered were scored by the keywords, and the docket says so.
  assert.ok(
    docket.home.some((h) => h.scoredBy === "heuristic"),
    JSON.stringify(docket.home),
  );
  // The render names the rule; the hook's compact render stays inside its budget and leaves it out.
  const text = renderDocket(docket, bench);
  assert.ok(text.includes("KEPT HOME:"), text);
  assert.ok(text.includes(homeLine(granny)), text);
  assert.ok(!renderDocket(docket, bench, { compact: true }).includes("KEPT HOME:"));
});

// Production dockets carry a compound source ("jev+cascade+heuristic" when Jev left items unanswered): a row Jev
// scored must still say `jev`, never the whole compound that names the keywords as its scorer.
test("a home row names one clean scorer under a compound docket source", () => {
  const ask = "tear dredd apart - have the room argue what the judge gets wrong, what should go and what is missing";
  const answers = heuristicAnswers(bench, ask);
  answers.ask_class = { answer: "review", confidence: 0.9, probabilities: {}, source: "test" };
  answers.domain = { answer: "code", confidence: 0.9, probabilities: {}, source: "test" };
  answers.scope = { answer: "2", confidence: 0.9, probabilities: {}, source: "test" };
  answers["inst:lilgranny"] = { answer: "yes", probabilities: { yes: 0.5, no: 0.5 }, source: "test" };
  const docket = decideDocket({ bench, ask, answers, source: "jev+cascade+heuristic", paths: ["dredd"] });
  for (const h of docket.home) assert.ok(["jev", "heuristic"].includes(h.scoredBy), JSON.stringify(h));
  assert.equal(docket.home.find((h) => h.id === "lilgranny").scoredBy, "jev");
});

// scopeFor clamps a forced --scope without rounding it, so a quick look below 1 keeps its one-slot limit too.
test("a fractional quick scope still seats one instrument", () => {
  const seated = [{ id: "copy-checks", phase: 2 }];
  assert.equal(scoreStage({ id: "design-critic", phase: 2, domains: ["visual"] }, 0.99, 0.5, BARS, seated).take, false);
});
