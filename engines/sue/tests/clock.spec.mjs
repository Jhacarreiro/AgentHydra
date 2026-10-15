// clock.spec.mjs - spec for lib/clock.mjs (see that file's header for why it exists).
// Drives the two budgets (attention, patience) with a fixed persona dial set and asserts the
// state machine, the mood wording, and newPage()'s attention reset.
import assert from "node:assert/strict";
import { test } from "node:test";

import { createClock } from "../lib/clock.mjs";

const dials = { wordsPerMinute: 200, attentionSeconds: 10, patienceSeconds: 20, temperature: 0.2 };

test("charge() spends both budgets in real seconds", () => {
  const clock = createClock({ dials: { ...dials } });
  clock.charge({ words: 200 }); // 200 words / 200 wpm * 60s = 60s
  assert.equal(clock.elapsedSeconds(), 60);
  assert.equal(clock.attentionLeft(), 0); // clamped, budget was only 10s
  assert.equal(clock.patienceLeft(), 0); // clamped, budget was only 20s
});

test("attention running out reads bored, patience still fine", () => {
  const clock = createClock({ dials: { ...dials } });
  clock.charge({ actions: 8 }); // 8 * 1.5s = 12s: exceeds attention(10), not patience(20)
  assert.equal(clock.state(), "bored");
  assert.match(clock.mood(), /bored/i);
});

test("patience running out reads exhausted", () => {
  const clock = createClock({ dials: { ...dials } });
  clock.charge({ actions: 8 }); // 12s -> bored
  assert.equal(clock.state(), "bored");
  clock.charge({ actions: 8 }); // +12s = 24s total -> patience(20) also gone
  assert.equal(clock.state(), "exhausted");
});

test("newPage() resets attention but not patience", () => {
  const clock = createClock({ dials: { ...dials } });
  clock.charge({ actions: 8 }); // 12s -> attention gone
  assert.equal(clock.state(), "bored");
  clock.newPage();
  assert.equal(clock.attentionLeft(), dials.attentionSeconds);
  assert.equal(clock.state(), "fine");
  assert.ok(clock.patienceLeft() < dials.patienceSeconds, "patience should not have reset");
});

test("temperature changes the mood wording, mild vs furious", () => {
  const mild = createClock({ dials: { ...dials, temperature: 0.2 } });
  const furious = createClock({ dials: { ...dials, temperature: 0.9 } });
  // Drive both all the way to exhausted.
  mild.charge({ actions: 20 });
  furious.charge({ actions: 20 });
  assert.equal(mild.state(), "exhausted");
  assert.equal(furious.state(), "exhausted");
  assert.notEqual(mild.mood(), furious.mood());
});

test("createClock also accepts a bare dials object (no persona wrapper)", () => {
  const clock = createClock({ ...dials });
  assert.equal(clock.attentionLeft(), dials.attentionSeconds);
  assert.equal(clock.state(), "fine");
});

test("read() charges one sitting at most one attention span, so a long page bores her without ending the visit", () => {
  // Dev Dan's dials, 2026-09-21: 300 wpm, 60 s attention, 300 s patience. A 2,000-word homepage is
  // 400 s of reading; charged whole, one look ended his visit.
  const clock = createClock({ wordsPerMinute: 300, attentionSeconds: 60, patienceSeconds: 300 });
  clock.read(2000);
  assert.equal(clock.attentionLeft(), 0);
  assert.equal(clock.patienceLeft(), 240);
  assert.equal(clock.state(), "bored");
  clock.read(0);
  assert.equal(clock.patienceLeft(), 240, "nothing new to read costs nothing");
  clock.newPage();
  clock.read(100);
  assert.equal(clock.attentionLeft(), 40, "a short page is charged in full: 100 words at 300 wpm is 20 s");
});

test("legs give a visit that many legs of patience, attention stays per page", async () => {
  const { legsOf } = await import("../lib/clock.mjs");
  assert.equal(legsOf({ legs: 5 }), 5);
  assert.equal(legsOf({ legs: 1 }), 1);
  assert.equal(legsOf({}), 1);
  assert.equal(legsOf(null), 1);
  // Tavern Bag wave 11 (2026-09-23): a five-leg errand still ran on one leg of patience.
  const clock = createClock({ dials: { ...dials } }, { legs: 5 });
  assert.equal(clock.patienceLeft(), 100);
  assert.equal(clock.attentionLeft(), 10);
  clock.charge({ actions: 16 }); // 24 s: one leg's patience (20) is gone, five legs' is not
  assert.equal(clock.state(), "bored");
  assert.equal(createClock({ dials: { ...dials } }).patienceLeft(), 20, "no legs is one leg");
});

test("on a canvas game, a hand that changed the picture refills attention; waiting never does", () => {
  // NexusCode-2D, run 20260921-152735-8bbc: one URL for the whole match, so every wait for her fleet
  // read as boredom and "You are bored and irritated with this page" coloured her verdict.
  const clock = createClock({ dials: { ...dials } });
  clock.picture("a", { canvas: true });
  clock.charge({ waitMs: 10_000 });
  assert.equal(clock.picture("b", { canvas: true }), false, "the picture moved while she only waited");
  assert.equal(clock.state(), "bored");
  clock.handsMoved();
  assert.equal(clock.picture("b", { canvas: true }), false, "her hand changed nothing on screen");
  clock.handsMoved();
  assert.equal(clock.picture("c", { canvas: true }), true);
  assert.equal(clock.attentionLeft(), dials.attentionSeconds);
  assert.equal(clock.patienceLeft(), 10, "patience is the whole visit and never refills");

  const page = createClock({ dials: { ...dials } });
  page.picture("a", { canvas: false });
  page.charge({ waitMs: 10_000 });
  page.handsMoved();
  assert.equal(page.picture("b", { canvas: false }), false, "an ordinary page refills on a new page only");
  assert.equal(page.state(), "bored");
});

test("every mood line is marked as her own state, never something the page says", () => {
  for (const temperature of [0.2, 0.9]) {
    const clock = createClock({ dials: { ...dials, temperature } });
    clock.charge({ actions: 20 });
    assert.match(clock.mood(), /^\[Your own mood, not on the page: .*\]$/);
  }
});

test("rested time passes on the clock and wears patience, never attention", () => {
  const c = createClock({ dials: { attentionSeconds: 30, patienceSeconds: 100, wordsPerMinute: 200 } });
  c.rested(5);
  assert.equal(c.elapsedSeconds(), 5);
  assert.equal(c.attentionLeft(), 30);
  assert.equal(c.patienceLeft(), 95);
  c.rested(0);
  assert.equal(c.elapsedSeconds(), 5);
});
