/**
 * recall-bench.spec - the recall benchmark's grading and its checked-in question set, with no network.
 * =================================================================================================
 *
 * WHAT: `node --test dredd/tests/recall-bench.spec.mjs`. Drives lib/recall-bench.mjs's runBench and summarize
 * over fake paths, and reads eval/recall-bench/{questions,memories}.json.
 *
 * WHY: a recall that FAILED returns no rows, and the first build graded it anyway, so a broken path scored a correct
 * "nothing found" on every absent-answer question (review of the salvaged build, 2026-10-05). And a question whose
 * answer slug the fixture does not hold can never be a hit, which would read as a weak path, not a broken set. And a
 * --live run once called the query paths, each hit recording a read in the owner's real store; --live is read-only.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { benchPaths, fixtureLane, PATHS, runBench, summarize } from "../lib/recall-bench.mjs";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "eval", "recall-bench");
const read = (name) => JSON.parse(readFileSync(path.join(FIXTURE, name), "utf8"));

test("runBench: a failed run is never graded, so a broken path cannot score an absent answer as correct", async () => {
  const questions = [
    { id: "a", ask: "where is the thing", answer: null },
    { id: "b", ask: "where is the other thing", answer: "other-thing" },
  ];
  const broken = { id: "broken", what: "always fails", run: async () => ({ ok: false, rows: [], text: "", error: "down" }) };
  const results = await runBench(questions, fixtureLane([]), { paths: [broken], now: () => 0 });
  assert.ok(results.every((r) => r.grade.scored === false));
  const [s] = summarize(results);
  assert.equal(s.failed, 2);
  assert.equal(s.empty, 0, "a failure is not an empty answer");
  assert.equal(s.absent, 0);
  assert.equal(s.answerable, 0);
});

test("runBench: a successful empty run on an absent-answer question is graded correct", async () => {
  const questions = [{ id: "a", ask: "where is the thing", answer: null }];
  const quiet = { id: "quiet", what: "returns nothing", run: async () => ({ ok: true, rows: [], text: "" }) };
  const [s] = summarize(await runBench(questions, fixtureLane([]), { paths: [quiet], now: () => 0 }));
  assert.deepEqual([s.empty, s.absent, s.failed], [1, 1, 0]);
});

test("the question set: 30 to 60 questions, unique ids, every non-null answer a slug the synthetic fixture holds", () => {
  const { questions } = read("questions.json");
  const { memories } = read("memories.json");
  const slugs = new Set(memories.map((m) => m.slug));
  assert.ok(questions.length >= 30 && questions.length <= 60, questions.length);
  assert.equal(new Set(questions.map((q) => q.id)).size, questions.length);
  assert.ok(
    questions.some((q) => q.answer === null),
    "the set carries questions no memory answers",
  );
  for (const q of questions) if (q.answer !== null) assert.ok(slugs.has(q.answer), `${q.id} names ${q.answer}`);
});

test("benchPaths: --live without --record-reads runs only paths that record no read, and names the rest", () => {
  const { run, skipped } = benchPaths({ live: true, recordReads: false });
  assert.ok(run.length > 0 && run.every((p) => p.recordsReads === false));
  assert.deepEqual(
    skipped.map((p) => p.id).sort(),
    PATHS.filter((p) => p.recordsReads !== false)
      .map((p) => p.id)
      .sort(),
  );
  assert.equal(benchPaths({ live: true, recordReads: true }).run.length, PATHS.length);
  assert.equal(benchPaths({ live: false }).run.length, PATHS.length, "the fixture records nothing, so every path runs");
});
