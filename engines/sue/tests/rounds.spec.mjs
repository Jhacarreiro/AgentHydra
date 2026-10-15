// A round scored against its target, and the trend that names the next round's work (lib/rounds.mjs, round.mjs).
// The regression: Lift's class unit sat at 3 stars for nine rounds (2026-09-30 to 2026-10-01) and nothing said the
// problem had become design; the trend must say so by the second flat round.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, test } from "node:test";

import { roundAsk, roundRow, visitOf } from "../round.mjs";
import { readRounds, seriesKey, targetOf, trend, writeRound } from "../lib/rounds.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "sue-rounds-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const round = (stars, finished, people = 6) => ({ stars, finished, people });

test("a rating that does not move is a design problem by the second round, and the trend says so", () => {
  // Four of six finishing keeps it off the early-stop rule, so the stall alone decides.
  const flat = [3, 3, 3, 3.3, 3].map((s) => round(s, 4));
  assert.equal(trend(flat.slice(0, 1)).next, "fix", "one round under the target: fix its biggest problem");
  const t = trend(flat.slice(0, 2));
  assert.equal(t.state, "stalled");
  assert.equal(t.next, "design");
  assert.equal(trend(flat).next, "design", "and every flat round after it");
  // Lift's real rounds 10 to 18: 3 stars, one or two of six finishing - the design board's from the first of them.
  const lift = [3, 3, 3, 3, 3, 3, 3.3, 3].map((s, i) => round(s, i === 6 ? 1 : 2));
  assert.equal(trend(lift.slice(0, 1)).next, "design");
  assert.equal(trend(lift).state, "stalled");
});

test("most people stopping early goes to the design board even on a first round", () => {
  const t = trend([round(3.5, 1)]);
  assert.equal(t.state, "early");
  assert.equal(t.next, "design");
});

test("a new best under the target is improving; the target held twice running is done", () => {
  assert.equal(trend([round(3, 4), round(3.8, 4)]).state, "improving");
  const target = targetOf({ target: { stars: 4.5, finished: 5, of: 6, inARow: 2 } });
  assert.equal(trend([round(3.8, 4), round(4.6, 5)], target).next, "confirm");
  assert.equal(trend([round(3.8, 4), round(4.6, 5), round(4.5, 6)], target).next, "done");
  assert.equal(trend([round(4.7, 4), round(4.8, 4)], target).next === "done", false, "the stars alone do not end it: 4 of 6 finished");
});

test("rounds are kept per series and kind, a re-reported round replaces its own row and keeps its number", () => {
  const ws = mkdtempSync(path.join(ROOT, "rounds-"));
  const key = seriesKey("Lift class unit", "people");
  assert.equal(key, "lift-class-unit");
  assert.equal(seriesKey("Lift class unit", "teachers"), "lift-class-unit.teachers");
  writeRound(ws, key, { id: "a", at: "2026-10-01T01:00:00Z", ...round(3, 1) });
  writeRound(ws, key, { id: "b", at: "2026-10-01T02:00:00Z", ...round(3, 2) });
  writeRound(ws, key, { id: "a", at: "2026-10-01T01:00:00Z", ...round(3.2, 2) });
  const rows = readRounds(ws, key);
  assert.deepEqual(
    rows.map((r) => [r.id, r.round, r.stars]),
    [
      ["a", 1, 3.2],
      ["b", 2, 3],
    ],
  );
});

test("a visit is finished when a screen shows the plan's done text; how far it got is the furthest progress mark", () => {
  const dir = mkdtempSync(path.join(ROOT, "visit-"));
  const sue = path.join(dir, "sue-12-kid-jo");
  mkdirSync(sue);
  const look = (pageText) => JSON.stringify({ at: "2026-10-01T01:00:00Z", tool: "look", pageText });
  const plan = { doneWhen: ["Lesson done!", "¡Lección terminada!"], progress: "(?:Part|Parte) (\\d+) (?:of|de) (\\d+)" };
  writeFileSync(path.join(sue, "trace.jsonl"), [look("PART 1 OF 4 · step 1 of 3"), look("Part 2 of 4"), ""].join("\n"));
  writeFileSync(path.join(sue, "interview.json"), JSON.stringify({ starsOutOfFive: 3, whyStopped: "too long" }));
  const stopped = visitOf(sue, plan);
  assert.equal(stopped.finished, false);
  assert.deepEqual(stopped.reached, { at: 2, of: 4 });
  assert.equal(stopped.who, "kid-jo");
  writeFileSync(path.join(sue, "trace.jsonl"), [look("Part 4 of 4"), look("¡Lección terminada! +40 XP")].join("\n"));
  const done = visitOf(sue, plan);
  assert.equal(done.finished, true);
  const row = roundRow(
    { resetAt: "x", kind: "people", runs: [] },
    [stopped, { ...done, who: "marisol" }, { ...done, who: "critic", critic: true, stars: 1 }],
    { series: "s" },
  );
  assert.equal(row.people, 2, "a critic is an expert, not a user");
  assert.equal(row.stars, 3, "and a critic's stars are never the users' rating");
  assert.equal(row.finished, 1);
});

// lift-v2 round 14: three finishers' "i finished" took three of the ask's four places ahead of the one student who
// quit before the last question, and Dredd's room argued the finished screen, which that student never reached.
test("the round's ask quotes the students who did not finish first, each marked, so a finisher's words never crowd out a stop", () => {
  const each = [
    { who: "a", finished: true, whyStopped: "i finished" },
    { who: "b", finished: true, whyStopped: "done for the night" },
    { who: "c", finished: true, whyStopped: "it said lesson done" },
    { who: "d", finished: true, whyStopped: "i finished it" },
    { who: "e", finished: false, whyStopped: "ran out of patience before the last question" },
  ];
  const row = { round: 14, series: "s", people: 5, stars: 3.8, finished: 4, reached: { finished: 4, "did not finish": 1 }, each };
  const ask = roundAsk({}, row, { next: "polish", history: [] }, { stars: 3.6, finishShare: 0.8 });
  assert.match(
    ask,
    /Why they stopped, in their words: e \(did not finish\): "ran out of patience before the last question" a \(finished\): "i finished"/,
  );
});

test("rounds several processes save to one series at the same moment are all kept", async () => {
  // Two arms of one A/B reporting in the same second each read N rows and wrote N+1: rb-edge-ab2 lost two of four rounds.
  const workspace = path.join(ROOT, "same-moment");
  mkdirSync(workspace, { recursive: true });
  const rounds = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "lib", "rounds.mjs")).href;
  const writers = Array.from({ length: 6 }, (_, w) => {
    const code = `import { writeRound } from ${JSON.stringify(rounds)};
for (let i = 0; i < 8; i += 1) writeRound(${JSON.stringify(workspace)}, "ab", { id: "w${w}-" + i, at: "2026-10-12T22:30:0${w}." + i + "Z" });`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: "inherit" });
    return new Promise((resolve) => child.on("exit", resolve));
  });
  assert.deepEqual(await Promise.all(writers), [0, 0, 0, 0, 0, 0]);
  assert.equal(readRounds(workspace, "ab").length, 48);
});
