/**
 * manager-refresh.spec - when the Sue Manager hands its port to a Manager on the checkout's new code
 * (lib/manager-refresh.mjs).
 * ==========================================================================================
 *
 * WHAT: the decision is pure: the same code stays; new code is handed over once it has held still for
 * one look and nothing the Manager alone carries is in flight; a hand-over that failed is not tried again
 * on the same code, and one that worked ends this Manager. The watcher asks the decision on every tick
 * and only hands over when it says so.
 *
 * WHY IT EXISTS: 2026-09-22 (ARGUS, 884 answers of HTTP 500): a Manager kept serving code the disk had
 * moved past until somebody restarted it. Waves no longer need the Manager to stay put (each runs on its
 * own snapshot, lib/engine-store.mjs), so it refreshes itself; a refresh that loops, or leaves the page
 * with no Manager, would be worse than a stale one.
 *
 * Plain node (`node --test sue/tests/manager-refresh.spec.mjs`). Nothing is spawned.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { codeKey, refreshDecision, watchCode } from "../lib/manager-refresh.mjs";

test("the same code stays; new code waits one look, then is handed over; a failed hand-over keeps the old Manager", () => {
  const boot = "aaaaaaaaaaaaaaaa";
  const next = "bbbbbbbbbbbbbbbb";
  assert.equal(refreshDecision({ boot, now: boot, previous: boot }), "stay");
  assert.equal(refreshDecision({ boot, now: null, previous: boot }), "stay", "a code id nobody could read changes nothing");
  assert.equal(
    refreshDecision({ boot, now: next, previous: boot }),
    "wait",
    "first seen: a change landing over several files settles first",
  );
  assert.equal(refreshDecision({ boot, now: next, previous: next }), "refresh");
  assert.equal(refreshDecision({ boot, now: next, previous: next, busy: true }), "wait", "a sign-in window or a served file is in flight");
  assert.equal(
    refreshDecision({ boot, now: next, previous: next, failed: next }),
    "stay",
    "a Manager on this code never answered: no loop",
  );
  assert.equal(
    refreshDecision({ boot, now: "cccccccccccccccc", previous: "cccccccccccccccc", failed: next }),
    "refresh",
    "newer code tries again",
  );
});

test("the key is the code, and the landed version only once it moved", () => {
  const running = { version: "1.57" };
  assert.equal(codeKey("aaaaaaaaaaaaaaaa", running, { version: "1.57" }), "aaaaaaaaaaaaaaaa");
  assert.equal(codeKey("aaaaaaaaaaaaaaaa", running, { version: "1.?" }), "aaaaaaaaaaaaaaaa", "git did not answer: nothing moved");
  assert.equal(codeKey("aaaaaaaaaaaaaaaa", running, { version: "1.58" }), "aaaaaaaaaaaaaaaa 1.58", "same bytes, a newer landed number");
});

test("the watcher hands over only on a settled change, ends this Manager when it worked, and keeps serving when it did not", async () => {
  const keys = ["a", "b", "b", "b", "c", "c"];
  const handed = [];
  const logs = [];
  let ended = 0;
  let outcome = "kept";
  const watch = watchCode({
    bootKey: "a",
    currentKey: async () => keys.shift(),
    busy: () => 0,
    handOver: async () => {
      handed.push("go");
      return outcome;
    },
    done: () => (ended += 1),
    everyMs: 3_600_000,
    log: { log: (m) => logs.push(m), error: (m) => logs.push(m) },
  });
  try {
    assert.equal(await watch.check(), "stay");
    assert.equal(await watch.check(), "wait");
    assert.equal(await watch.check(), "kept", "the successor never answered");
    assert.equal(ended, 0, "so this Manager carries on");
    assert.equal(await watch.check(), "stay", "and does not try the same code again");
    outcome = "handed-over";
    assert.equal(await watch.check(), "wait");
    assert.equal(await watch.check(), "handed-over");
    assert.equal(ended, 1, "a Manager on the newer code answered: this one ends");
    assert.equal(handed.length, 2);
    assert.ok(
      logs.some((m) => /never answered|did not answer|No Manager/.test(m)),
      "the failed hand-over is said, in the log",
    );
  } finally {
    watch.stop();
  }
});
