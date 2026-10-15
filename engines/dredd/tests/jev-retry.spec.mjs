/**
 * jev-retry.spec - the eval's retry for Jev calls that timed out under load (lib/jev-retry.mjs, 2026-10-09).
 * ==========================================================================================================
 *
 * `bun scripts/test/bun-node-specs.mjs dredd/tests/jev-retry.spec.mjs`. A bridge that hits its wall answers
 * ETIMEDOUT; the eval must ask those items again, at low concurrency, and an item still unanswered afterwards must come
 * back with no answers (so the eval grades it as not graded, never on the keyword fallback). The bridge is stubbed:
 * no network, no python, no model.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { askWithRetry, timedOut } from "../lib/jev-retry.mjs";

const answered = (id) => ({ answers: { ask_class: { answer: "complaint", confidence: 0.9 }, id }, reason: null });
const timeout = { answers: null, reason: "jev.py: ETIMEDOUT" };
const noKey = { answers: null, reason: "jev.py exit 1: no key" };

test("a timed-out ask is asked again and graded on the retry answer", async () => {
  const calls = new Map();
  const ask = async (item) => {
    const n = (calls.get(item) || 0) + 1;
    calls.set(item, n);
    return item === "slow" && n === 1 ? timeout : answered(item);
  };
  const out = await askWithRetry(["fast", "slow"], ask, { concurrency: 2 });
  assert.equal(out.retried, 1, "only the timed-out ask is retried");
  assert.equal(out.failed, 0);
  assert.deepEqual(out.failedIndexes, []);
  assert.equal(out.results[1].answers.id, "slow", "the retry's answer replaces the timeout");
  assert.equal(calls.get("fast"), 1, "an answered ask is never asked again");
  assert.equal(calls.get("slow"), 2);
});

test("an ask that still times out after the retries is not graded: no answers, reported as failed", async () => {
  const calls = new Map();
  const ask = async (item) => {
    calls.set(item, (calls.get(item) || 0) + 1);
    return item === "stuck" ? timeout : answered(item);
  };
  const out = await askWithRetry(["ok", "stuck"], ask, { concurrency: 2, retries: 2 });
  assert.equal(calls.get("stuck"), 3, "the first call plus two retries");
  assert.equal(out.retried, 1);
  assert.equal(out.failed, 1);
  assert.deepEqual(out.failedIndexes, [1]);
  assert.equal(out.results[1].answers, null, "a still-failing ask carries no answers, so nothing grades it on the fallback");
});

test("a failure that is not a timeout is never retried, and is still reported as not graded", async () => {
  const calls = new Map();
  const ask = async (item) => {
    calls.set(item, (calls.get(item) || 0) + 1);
    return item === "nokey" ? noKey : answered(item);
  };
  const out = await askWithRetry(["nokey", "ok"], ask, { concurrency: 2 });
  assert.equal(calls.get("nokey"), 1, "no key is not load, so it is not asked again");
  assert.equal(out.retried, 0);
  assert.deepEqual(out.failedIndexes, [0]);
});

test("the retry pass runs at its own low concurrency", async () => {
  const items = Array.from({ length: 12 }, (_, i) => `t${i}`);
  // The first 12 calls are the first pass and time out; every call after them is a retry, held open so the pool fills.
  let calls = 0;
  let inFlight = 0;
  let peakRetry = 0;
  const ask = async (item) => {
    calls += 1;
    if (calls <= 12) return timeout;
    inFlight += 1;
    peakRetry = Math.max(peakRetry, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight -= 1;
    return answered(item);
  };
  const out = await askWithRetry(items, ask, { concurrency: 12, retryConcurrency: 4, retries: 1 });
  assert.equal(out.retried, 12);
  assert.equal(out.failed, 0);
  assert.equal(peakRetry, 4, "the retry pass fills its cap of 4 and no further");
});

test("timedOut reads only a wall-clock failure, never an answered or keyless call", () => {
  assert.equal(timedOut(timeout), true);
  assert.equal(timedOut({ answers: null, reason: "jev.py: timed out" }), true);
  assert.equal(timedOut(noKey), false);
  assert.equal(timedOut(answered("x")), false);
});
