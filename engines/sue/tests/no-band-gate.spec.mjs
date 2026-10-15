// An A/B read that cannot decide yet decides nothing: an unresolved read (once "no band") whose stop line still owes a
// round is refused by ab.mjs --record until that round runs; at the budget, and on every resolved read, it records.
import assert from "node:assert/strict";
import { test } from "node:test";

import { noBandGate } from "../lib/sue-rsi.mjs";

test("an unresolved read that owes a round blocks a record; at the budget, and on every resolved verdict, it passes", () => {
  const owed = { round: true, arm: "head", why: "one round per arm cannot tell the change from that round's weather" };
  const blocked = noBandGate({ verdict: "unresolved", another: owed });
  assert.equal(blocked.ok, false);
  assert.match(blocked.why, /two same-arm rounds/);
  assert.match(blocked.why, /round of the head arm/);
  const spent = { round: false, arm: null, why: "three rounds of each arm: the budget is spent" };
  assert.equal(noBandGate({ verdict: "unresolved", another: spent }).ok, true, "at the budget it records as unresolved");
  for (const verdict of ["better", "worse", "same"]) assert.equal(noBandGate({ verdict, another: { round: false } }).ok, true);
});
