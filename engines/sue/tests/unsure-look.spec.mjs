import { test } from "node:test";
import assert from "node:assert/strict";
import { DO_TOOL, planBatch } from "../lib/move-batch.mjs";
import { matchThought, restPlan, unsureOnScreen } from "../lib/rest-on-text.mjs";

const SCREEN = "Free account\nEverything in Standard, plus:\nStart free trial";
const candidates = [
  { i: 0, text: "Free account", link: false, above: false },
  { i: 1, text: "Everything in Standard, plus:", link: false, above: false },
  { i: 2, text: "Start free trial", link: true, above: false },
];

test("the do move takes an optional unsure phrase and only a phrase quoted from the screen counts", () => {
  assert.equal(DO_TOOL.inputSchema.properties.unsure.type, "string");
  const plan = planBatch({ moves: [{ move: "click", target: 3 }], unsure: "Everything in Standard, plus:" });
  assert.deepEqual(plan.moves[0], { tool: "note", args: { kind: "unsure", text: "Everything in Standard, plus:" } });
  assert.equal(plan.moves[1].tool, "click");
  assert.equal(planBatch({ moves: [{ move: "click", target: 3 }] }).moves.length, 1, "no unsure field, no unsure note");
  assert.equal(planBatch({ moves: [{ move: "click", target: 3 }], unsure: "   " }).moves.length, 1, "a blank phrase is none");
  assert.equal(
    unsureOnScreen("everything in  standard, PLUS:", SCREEN),
    "everything in standard, PLUS:",
    "case and spacing may differ, the words are kept",
  );
  assert.equal(unsureOnScreen("Premium includes unlimited bots", SCREEN), null, "a phrase not on this screen is never invented");
  assert.equal(unsureOnScreen("x".repeat(121), "x".repeat(121)), null, "an over-long phrase is refused");
  assert.equal(unsureOnScreen(42, SCREEN), null, "a non-text phrase is refused");
});

test("the hands rest on an unsure phrase that names an element, scrolling and hovering a link without a click", () => {
  const match = matchThought("Everything in Standard, plus:", candidates);
  assert.equal(match?.index, 1, "the element the phrase quotes is the one she rests on");
  const steps = restPlan(match, { thinkMs: 4000 });
  assert.deepEqual(steps.at(-1), { do: "rest", index: 1, ms: 4000 });
  const link = restPlan(matchThought("Start free trial", candidates), { thinkMs: 2000 });
  assert.equal(link[0].on, "link", "a link is hovered, never clicked");
  assert.deepEqual(
    restPlan(matchThought("Premium includes unlimited bots", candidates), { thinkMs: 4000 }),
    [],
    "a phrase naming nothing on the page rests nowhere",
  );
});

test("only a thought or unsure phrase rests long on one piece of text", () => {
  const thought = restPlan(matchThought("Everything in Standard, plus:", candidates), { thinkMs: 8000 });
  assert.equal(thought.at(-1).ms, 8000, "a thought may rest longer, and only a thought or unsure phrase may");
});
