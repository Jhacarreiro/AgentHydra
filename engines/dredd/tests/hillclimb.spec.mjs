// The hillclimb rules (lib/hillclimb.mjs): the ladder, the headroom bar, the stall call and the miss buckets.
import assert from "node:assert/strict";
import { test } from "node:test";

import { bucketMisses, headroom, ladderReading, stalled } from "../lib/hillclimb.mjs";

test("a stronger model that does not score higher says the eval looks broken", () => {
  assert.equal(
    ladderReading([
      { model: "weak", score: 0.6 },
      { model: "strong", score: 0.8 },
    ]).ok,
    true,
  );
  const r = ladderReading([
    { model: "weak", score: 0.8 },
    { model: "strong", score: 0.8 },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.line, /eval itself looks broken/);
});

test("the objective turns to cost at 95% and not below", () => {
  assert.equal(headroom(0.95).objective, "cost");
  assert.equal(headroom(0.949).objective, "accuracy");
});

test("a stall needs a measured band and runs inside it", () => {
  assert.equal(stalled([50, 51, 50], 2), true);
  assert.equal(stalled([50, 56, 50], 2), false);
  assert.equal(stalled([50, 50], null), false);
});

test("trained misses bucket by cause and the noise flippers are marked", () => {
  const rows = [
    { id: "a", misses: [], convMisses: ["mustNot x convened"] },
    { id: "b", misses: [], convMisses: ["must y not convened"] },
    { id: "c", misses: [], convMisses: [] },
  ];
  const b = bucketMisses(rows, { unstable: new Set(["b"]) });
  assert.ok(b.some((x) => /^false positive/.test(x.cause) && x.ids.includes("a")));
  assert.ok(b.some((x) => /^noise/.test(x.cause) && x.ids.includes("b")));
  assert.ok(!b.some((x) => x.ids.includes("c")));
});
