// The stall alarm in trend() (lib/rounds.mjs): a series under target with STUCK_THRESHOLD rounds after its best and no
// new best is "stuck". It counts the rounds AFTER the best, a finishing climb is a new best, and a stuck series still
// gets the design board (next "design"), never "stop".
import assert from "node:assert/strict";
import { test } from "node:test";

import { STUCK_THRESHOLD, trend } from "../lib/rounds.mjs";

const target = { stars: 4.5, finishShare: 5 / 6, inARow: 2 };
const rounds = (...rs) => rs.map(([stars, finished], i) => ({ round: i + 1, stars, finished, people: 6 }));

test("roundsSinceBest counts the rounds after the best, not the best itself", () => {
  assert.equal(trend(rounds([3, 4]), target).roundsSinceBest, 0);
  assert.equal(trend(rounds([3, 4], [3, 4], [3, 4]), target).roundsSinceBest, 2);
});

test("the alarm fires on the third round without a new best, not the second", () => {
  const two = trend(rounds([3, 4], [3, 4], [3, 4]), target);
  assert.notEqual(two.state, "stuck");
  const three = trend(rounds([3, 4], [3, 4], [3, 4], [3, 4]), target);
  assert.equal(three.state, "stuck");
  assert.equal(three.roundsSinceBest, STUCK_THRESHOLD);
});

test("a finishing climb is a new best even when the stars are flat", () => {
  const t = trend(rounds([4.8, 3], [4.8, 3], [4.8, 4], [4.8, 4]), target);
  assert.equal(t.roundsSinceBest, 1);
  assert.notEqual(t.state, "stuck");
  assert.equal(trend(rounds([4.8, 3], [4.8, 3], [4.8, 3], [4.8, 3]), target).state, "stuck");
});

test("a star gain of 0.05 or less is a tie and does not reset the count", () => {
  assert.equal(trend(rounds([3, 4], [3.05, 4], [3, 4], [3.05, 4]), target).state, "stuck");
});

test("a stuck series gets the design board and names the ceiling check", () => {
  const t = trend(rounds([3, 4], [3, 4], [3, 4], [3, 4]), target);
  assert.equal(t.next, "design");
  assert.equal(t.stuck, true);
  assert.match(t.why, /ceiling check/);
});

test("a series that meets the target is never stuck", () => {
  const t = trend(rounds([4.6, 5], [4.6, 5], [4.6, 5], [4.6, 5]), target);
  assert.equal(t.state, "done");
  assert.notEqual(t.stuck, true);
});
