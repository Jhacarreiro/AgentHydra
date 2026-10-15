/**
 * board-cap.spec - the focused cap never cuts the Boardroom (lib/docket.mjs, 2026-10-09).
 * ======================================================================================
 *
 * `bun scripts/test/bun-node-specs.mjs dredd/tests/board-cap.spec.mjs`. A focused review seats at most four field
 * instruments. ART's arrival (p 0.73) took the fourth seat on review-landing and cut the Boardroom (p 0.61), though the
 * room argues over the facts the others gather and must be in that docket (the A/B's must-convene). No model is called.
 */
import assert from "node:assert/strict";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { decideDocket, loadBench } from "../lib/docket.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const bench = loadBench(ROOT);

/** A Jev-shaped answer set: each instrument's yes probability, and a focused review of visual copy. */
function answersWith(yes) {
  const answers = {
    ask_class: { answer: "review", confidence: 0.9, probabilities: {} },
    domain: { answer: "visual", confidence: 0.9, probabilities: {} },
    scope: { answer: 1, confidence: 0.9, probabilities: {} },
    delegation: { answer: "mixed", confidence: 0.9, probabilities: {} },
  };
  for (const [id, p] of Object.entries(yes)) {
    answers[`inst:${id}`] = { answer: p >= 0.5 ? "yes" : "no", confidence: Math.abs(p - 0.5) * 2, probabilities: { yes: p, no: 1 - p }, source: "jev" };
  }
  return answers;
}

test("a focused review with five field seats still convenes the Boardroom beside the four it keeps", () => {
  const ask = "review the landing page and tell me what you think";
  const answers = answersWith({ "design-critic": 0.91, sue: 0.76, art: 0.73, "focus-group": 0.65, boardroom: 0.61 });
  const docket = decideDocket({ bench, ask, answers, source: "jev" });
  const ids = docket.convene.map((c) => c.id);
  assert.ok(ids.includes("boardroom"), `the board went home: convened ${ids.join(", ")}`);
  assert.equal(ids.filter((id) => id !== "boardroom").length, 4, `a focused review seats four field instruments: ${ids.join(", ")}`);
  assert.ok(ids.includes("art"), "the new seat still convenes (ART gained its place)");
});
