// Spec for the people hunt: pure ranking of personas from round signals.
import assert from "node:assert/strict";
import { test } from "node:test";

import { rankPeopleHunt, renderPeopleHunt } from "../lib/people-hunt.mjs";

const sig = (persona, kind, runId = "r1") => ({ persona, kind, runId, series: "s" });

test("no signals rank to nothing", () => {
  assert.deepEqual(rankPeopleHunt([]), []);
});

test("a persona caught mid-motion outranks one that is only slow", () => {
  const rows = rankPeopleHunt([sig("ray", "midMotion", "a"), sig("kai", "slow", "a")]);
  assert.deepEqual(
    rows.map((r) => r.persona),
    ["ray", "kai"],
  );
  assert.ok(rows[0].score > rows[1].score);
});

test("sue-side signals are not the persona's fault and are not ranked", () => {
  assert.deepEqual(rankPeopleHunt([sig("ray", "sueSide")]), []);
});

test("the same kind for the same persona in the same run counts once", () => {
  const once = rankPeopleHunt([sig("ray", "midMotion", "a")]);
  const twice = rankPeopleHunt([sig("ray", "midMotion", "a"), sig("ray", "midMotion", "a")]);
  assert.equal(twice[0].score, once[0].score);
});

test("unstable flips are ranked as their own kind", () => {
  const rows = rankPeopleHunt([sig("ray", "unstable")]);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].score > 0);
});

test("each row names evidence and one rewrite direction", () => {
  const [row] = rankPeopleHunt([sig("ray", "midMotion", "a"), sig("ray", "offProtocol", "b")]);
  assert.equal(row.persona, "ray");
  assert.ok(Array.isArray(row.evidence) && row.evidence.length > 0);
  assert.equal(typeof row.direction, "string");
  assert.ok(row.direction.length > 0);
});

test("rows are sorted by score, ties by persona id, and capped by top", () => {
  const rows = rankPeopleHunt([sig("b", "slow"), sig("a", "slow"), sig("c", "midMotion"), sig("d", "unstable")], { top: 3 });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].persona, "c");
  assert.deepEqual(
    rows.slice(1).map((r) => r.persona),
    ["a", "b"],
  );
});

test("the rendered hunt shows each persona id and its direction", () => {
  const rows = rankPeopleHunt([sig("ray", "midMotion")]);
  const text = renderPeopleHunt(rows);
  assert.match(text, /ray/);
  assert.ok(text.includes(rows[0].direction));
});

test("rendering nothing says so", () => {
  assert.match(renderPeopleHunt([]), /no persona/i);
});
