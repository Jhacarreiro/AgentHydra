// round.mjs agree: does a recorded tape agree with the live site? Run through the real entry on rounds written into a
// temp workspace, and a tape round's report landing in "<series>-tape" and nowhere else.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { report, resetsDemo } from "../round.mjs";
import { readRounds, roundsFile, seriesKey, writeRound } from "../lib/rounds.mjs";

const ROUND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "round.mjs");
const ROOT = mkdtempSync(path.join(tmpdir(), "sue-round-agree-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const NAMES = ["ana", "ben", "cy", "dee", "eli", "fay"];

/** A temp workspace with one live round and one tape round (numbers given), their students, and each run's findings. */
function setup({ live, tape, liveRound = 1, tapeRound = 1, liveNotes, tapeNotes, liveCritics, tapeCritics }) {
  const dir = mkdtempSync(path.join(ROOT, "case-"));
  const workspace = path.join(dir, "ws");
  const runsDir = path.join(dir, "runs");
  const file = path.join(dir, "plan.json");
  writeFileSync(file, JSON.stringify({ series: "lift-unit", doneWhen: ["Unit complete"] }));
  const add = (series, round, students, notes, critics = []) => {
    const runId = `run-${series}-${round}`;
    mkdirSync(path.join(runsDir, runId), { recursive: true });
    const sueDir = path.join(runsDir, runId, "sue-1-ana");
    mkdirSync(sueDir, { recursive: true });
    writeFileSync(path.join(sueDir, "findings.jsonl"), notes.map((n) => JSON.stringify(n)).join("\n"));
    for (const critic of critics) {
      const criticDir = path.join(runsDir, runId, `sue-2-${critic.who}`);
      mkdirSync(criticDir, { recursive: true });
      writeFileSync(path.join(criticDir, "findings.jsonl"), (critic.notes || []).map((n) => JSON.stringify(n)).join("\n"));
    }
    writeRound(workspace, seriesKey(series), {
      id: `2026-10-0${round}T10:00:00.000Z`,
      at: `2026-10-0${round}T10:00:00.000Z`,
      series,
      kind: "people",
      round,
      runIds: [runId],
      people: students.length,
      each: students.map(([who, stars, finished]) => ({ who, stars, finished })),
      critics: critics.map((c) => ({ who: c.who })),
    });
  };
  add("lift-unit", liveRound, live, liveNotes, liveCritics || []);
  add("lift-unit-tape", tapeRound, tape, tapeNotes, tapeCritics || []);
  return { dir, workspace, runsDir, file, add };
}

const panel = (stars, finished = NAMES.map(() => true)) => NAMES.map((n, i) => [n, stars[i], finished[i]]);
const NOTES = [
  { kind: "confusion", text: "The fraction picture does not match the number I was asked to type" },
  { kind: "annoyance", text: "Hint button hides behind the keyboard on my tablet" },
  { kind: "note", text: "I liked the colours" },
];
const SAME_NOTES = [
  { kind: "confusion", text: "fraction picture and the number typed do not match" },
  { kind: "annoyance", text: "The hint button is hidden behind the tablet keyboard" },
];

const agree = (c, extra = []) =>
  spawnSync(process.execPath, [ROUND, "agree", "--plan", c.file, "--workspace", c.workspace, "--runs", c.runsDir, ...extra], {
    encoding: "utf8",
  });

test("an agreeing pair exits 0 and the verdict says every part held", () => {
  const c = setup({ live: panel([4, 4, 5, 3, 4, 4]), tape: panel([4, 5, 5, 3, 3, 4]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(c);
  console.log(r.stdout);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /VERDICT\s+AGREE: held stars, finished, findings; failed nothing/);
  assert.match(r.stdout, /2 of 2 live findings raised again/);
});

test("a student two stars apart fails the check and is named", () => {
  const c = setup({ live: panel([4, 4, 5, 3, 4, 4]), tape: panel([4, 4, 5, 3, 2, 4]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(c);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /eli\s+stars live 4, tape 2\s+NOT within one/);
  assert.match(r.stdout, /failed stars\b/);
});

test("finishing that differs for two students fails; for one it still holds", () => {
  const stars = [4, 4, 4, 4, 4, 4];
  const live = panel(stars);
  const one = setup({ live, tape: panel(stars, [true, true, true, true, true, false]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  assert.equal(agree(one).status, 0);
  const two = setup({ live, tape: panel(stars, [true, true, true, true, false, false]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(two);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /FINISHED\s+4 of 6 finished the same \(need 5\): FAILED/);
  assert.match(r.stdout, /failed finished\b/);
});

test("a student missing from the tape, or with no stars, is neither within one nor the same", () => {
  const live = panel([4, 4, 4, 4, 4, 4]);
  const missing = setup({ live, tape: live.slice(0, 5), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  assert.equal(agree(missing).status, 1);
  const noStars = setup({ live, tape: panel([4, 4, 4, 4, 4, null]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(noStars);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /fay\s+stars live 4, tape -\s+NOT within one/);
});

test("findings the tape never raised again fail the check", () => {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveNotes: NOTES,
    tapeNotes: [{ kind: "broken", text: "Sound plays twice on the finish screen" }],
  });
  const r = agree(c);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /0 of 2 live findings raised again/);
  assert.match(r.stdout, /failed findings\b/);
});

test("rounds are picked by their round number, and a missing one is a usage error", () => {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveRound: 10,
    tapeRound: 3,
    liveNotes: NOTES,
    tapeNotes: SAME_NOTES,
  });
  assert.equal(agree(c).status, 0, "the only rounds are 10 and 3: the latest of each");
  assert.equal(agree(c, ["--live-round", "10", "--tape-round", "3"]).status, 0);
  const none = agree(c, ["--live-round", "1"]);
  assert.equal(none.status, 2);
  assert.match(none.stdout, /no live round 1/);
  assert.equal(agree(c, ["--tape-round", "2"]).status, 2);
});

test("a round number that is not a whole number is a usage error", () => {
  const c = setup({ live: panel([4, 4, 4, 4, 4, 4]), tape: panel([4, 4, 4, 4, 4, 4]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(c, ["--tape-round", "abc"]);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /--tape-round needs a round number, not abc/);
  assert.equal(agree(c, ["--live-round", "1.5"]).status, 2);
});

test("--live-round and --tape-round compare exactly those rounds, not the latest", () => {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveRound: 3,
    tapeRound: 1,
    liveNotes: NOTES,
    tapeNotes: SAME_NOTES,
  });
  // Later rounds that disagree with everything: the default pick (the latest of each) must fail on them.
  c.add("lift-unit", 5, panel([1, 1, 1, 1, 1, 1]), NOTES);
  c.add("lift-unit-tape", 2, panel([5, 5, 5, 5, 5, 5]), SAME_NOTES);
  assert.equal(agree(c).status, 1);
  const r = agree(c, ["--live-round", "3", "--tape-round", "1"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /LIVE round 3 of lift-unit .* against TAPE round 1 of lift-unit-tape/);
});

test("the count of students is the live round's: one live-only and one tape-only student are named and not the same", () => {
  const live = panel([4, 4, 4, 4, 4, 4]);
  const tape = [...live.slice(0, 5), ["gus", 4, true]];
  const c = setup({ live, tape, liveNotes: NOTES, tapeNotes: SAME_NOTES });
  const r = agree(c);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /STARS\s+5 of 6 students within one star/);
  assert.match(r.stdout, /FINISHED\s+5 of 6 finished the same \(need 5\): held/);
  assert.match(r.stdout, /fay\s+stars live 4, tape -\s+NOT within one/);
  assert.match(r.stdout, /gus\s+stars live -, tape 4\s+NOT within one/);
  assert.match(r.stdout, /failed stars\b/);
});

test("a plan with no series is a usage error, not a crash", () => {
  const c = setup({ live: panel([4, 4, 4, 4, 4, 4]), tape: panel([4, 4, 4, 4, 4, 4]), liveNotes: NOTES, tapeNotes: SAME_NOTES });
  writeFileSync(c.file, JSON.stringify({ doneWhen: ["Unit complete"] }));
  const r = agree(c);
  assert.equal(r.status, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /agree needs plan\.series \(the live series a tape round is compared with\)/);
});

test("a live critic's finding is not counted when the tape round has no critics (fix a)", () => {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveNotes: NOTES,
    tapeNotes: SAME_NOTES,
    liveCritics: [{ who: "retention-doctor", notes: [{ kind: "drop", text: "Student gave up at the midpoint" }] }],
  });
  const r = agree(c);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /2 of 2 live findings raised again/, "only student findings counted, critic drop ignored");
});

const F = {
  a: { kind: "confusion", text: "fraction picture mismatch number typed" },
  b: { kind: "annoyance", text: "hint button hidden behind tablet keyboard" },
  c: { kind: "broken", text: "confetti keeps falling after wrong answer" },
  d: { kind: "broken", text: "sound plays twice finish screen" },
  e: { kind: "question", text: "pencil tool vanishes whenever zooming canvas" },
};

/** Live round 2 says d-or-so; round 1 (the previous live round) raises `prevRaises` of them; the tape raises `tapeRaises`. */
function floorCase(prevNotes, tapeNotes) {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveRound: 2,
    tapeRound: 1,
    liveNotes: [F.a, F.b, F.c, F.d],
    tapeNotes,
  });
  c.add("lift-unit", 1, panel([4, 4, 4, 4, 4, 4]), prevNotes);
  return agree(c, ["--live-round", "2", "--tape-round", "1"]);
}

test("floor 3: a tape that raises floor-1 (2) passes; floor-2 (1) fails", () => {
  const prev = [F.a, F.b, F.c, F.e];
  const pass = floorCase(prev, [F.a, F.b]);
  assert.equal(pass.status, 0, pass.stdout);
  assert.match(pass.stdout, /FLOOR\s+live round 1 raised 3 of live round 2's 4 findings: the tape needs 2/);
  assert.match(pass.stdout, /2 of 4 live findings raised again \(2 needed\): held/);
  const fail = floorCase(prev, [F.a]);
  assert.equal(fail.status, 1, fail.stdout);
  assert.match(fail.stdout, /1 of 4 live findings raised again \(2 needed\): FAILED/);
});

test("floor 2: raising floor-1 (1) passes where over half (3 of 4) would have failed it", () => {
  const r = floorCase([F.a, F.b, F.e], [F.a]);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /live round 1 raised 2 of live round 2's 4 findings: the tape needs 1/);
});

test("floor 0 or 1 still needs one raised finding", () => {
  const r = floorCase([F.e], [F.e]);
  assert.equal(r.status, 1, r.stdout);
  assert.match(r.stdout, /raised 0 of live round 2's 4 findings: the tape needs 1/);
  assert.match(r.stdout, /0 of 4 live findings raised again \(1 needed\): FAILED/);
});

test("no previous live round falls back to over half", () => {
  const c = setup({
    live: panel([4, 4, 4, 4, 4, 4]),
    tape: panel([4, 4, 4, 4, 4, 4]),
    liveRound: 1,
    tapeRound: 1,
    liveNotes: NOTES,
    tapeNotes: SAME_NOTES,
  });
  const r = agree(c);
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.stdout, /FINDINGS\s+2 of 2 live findings raised again \(over half needed\)/);
});

/** A started tape round: its saved state names the tape and the "-tape" series, as `start --tape` writes it. */
function tapeState() {
  const dir = mkdtempSync(path.join(ROOT, "tape-"));
  const plan = {
    file: path.join(dir, "plan.json"),
    series: "lift-unit",
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    doneWhen: ["Unit complete"],
  };
  const resetAt = "2026-10-03T10:00:00.000Z";
  mkdirSync(plan.state, { recursive: true });
  writeFileSync(
    path.join(plan.state, "last-tape.json"),
    JSON.stringify({ series: "lift-unit-tape", kind: "people", tape: "tapes/unit", resetAt, runs: [{ name: "kid-a", runId: "r1" }] }),
  );
  const runsDir = path.join(dir, "runs");
  const sueDir = path.join(runsDir, "r1", "sue-1-kid-a");
  mkdirSync(sueDir, { recursive: true });
  writeFileSync(path.join(sueDir, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Unit complete" })}\n`);
  writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 3 }));
  // A live round already in the live series, which a tape round must leave exactly as it was.
  writeRound(plan.workspace, seriesKey("lift-unit"), {
    id: "2026-09-30T10:00:00.000Z",
    at: "2026-09-30T10:00:00.000Z",
    series: "lift-unit",
    kind: "people",
    people: 1,
    stars: 4,
    finished: 1,
    each: [],
    critics: [],
  });
  const liveBefore = readFileSync(roundsFile(plan.workspace, seriesKey("lift-unit")), "utf8");
  const tables = [];
  const hooks = { run: async () => ({ ok: true, complete: true }), runsDir, startTable: async () => tables.push("table") };
  return { plan, hooks, tables, liveBefore, resetAt };
}

test("a tape round's report lands in the -tape series, leaves the live series alone, says TAPE and starts no table", async () => {
  const { plan, hooks, tables, liveBefore, resetAt } = tapeState();
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await report(plan, { table: true, tape: "tapes/unit" }, hooks);
  } finally {
    console.log = log;
  }
  assert.deepEqual(
    readRounds(plan.workspace, seriesKey("lift-unit-tape")).map((r) => [r.id, r.series]),
    [[resetAt, "lift-unit-tape"]],
  );
  assert.equal(readFileSync(roundsFile(plan.workspace, seriesKey("lift-unit")), "utf8"), liveBefore);
  assert.deepEqual(tables, []);
  assert.match(lines.join("\n"), /ROUND\s+TAPE 3 stars/);
});

test("a tape round and a reference round leave the live demo alone; only a live round resets it", () => {
  assert.equal(resetsDemo({}, null), true);
  assert.equal(resetsDemo({}, "tapes/unit"), false, "a tape round must not wipe a live round's students");
  assert.equal(resetsDemo({ reference: true }, null), false);
});
