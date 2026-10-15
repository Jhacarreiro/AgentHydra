// round.mjs report and mark on a saved round: every command after `start` reads the round's series from the state it
// saved (a plan moved on to a new series must not take the old round as its round 1), and stopwatch marks are kept
// from the moment they are made, through every re-report.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { hunt, mark, report, stateFileOf, stepSpans, times } from "../round.mjs";
import { readRounds, seriesKey, writeRound } from "../lib/rounds.mjs";

const ROUND = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "round.mjs");
const ROOT = mkdtempSync(path.join(tmpdir(), "sue-round-report-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

/** A plan whose series has moved on ("lift-v2") over a saved round of the old series ("lift-class-unit"). */
function savedRound() {
  const dir = mkdtempSync(path.join(ROOT, "plan-"));
  const plan = {
    file: path.join(dir, "plan.json"),
    series: "lift-v2",
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    doneWhen: ["Unit complete"],
  };
  const resetAt = "2026-10-03T10:00:00.000Z";
  mkdirSync(plan.state, { recursive: true });
  writeFileSync(
    path.join(plan.state, "last.json"),
    JSON.stringify({ series: "lift-class-unit", kind: "people", resetAt, runs: [{ name: "kid-a", runId: "r1" }] }),
  );
  const runsDir = path.join(dir, "runs");
  const sueDir = path.join(runsDir, "r1", "sue-1-kid-a");
  mkdirSync(sueDir, { recursive: true });
  writeFileSync(path.join(sueDir, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Unit complete" })}\n`);
  writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 3 }));
  const tables = [];
  const hooks = { run: async () => ({ ok: true, complete: true }), runsDir, startTable: async (_p, given) => tables.push(given.key) };
  return { plan, resetAt, hooks, tables };
}

test("report writes the round into the series its state saved, never the plan's newer one", async () => {
  const { plan, resetAt, hooks, tables } = savedRound();
  await report(plan, { table: true }, hooks);
  const rows = readRounds(plan.workspace, seriesKey("lift-class-unit"));
  assert.deepEqual(
    rows.map((r) => [r.id, r.series]),
    [[resetAt, "lift-class-unit"]],
  );
  assert.deepEqual(readRounds(plan.workspace, seriesKey("lift-v2")), []);
  assert.deepEqual(tables, ["lift-class-unit"]);
});

test("a mark made before the round's row exists survives, and every re-report keeps the marks", async () => {
  const { plan, hooks } = savedRound();
  mark(plan, { step: "build", event: "start" });
  assert.deepEqual(readRounds(plan.workspace, seriesKey("lift-class-unit")), [], "no row yet");
  const state = JSON.parse(readFileSync(path.join(plan.state, "last.json"), "utf8"));
  assert.deepEqual(
    state.marks.map((m) => [m.step, m.event]),
    [["build", "start"]],
  );

  await report(plan, { table: false }, hooks);
  const steps = () => readRounds(plan.workspace, seriesKey("lift-class-unit"))[0].marks.map((m) => `${m.step} ${m.event}`);
  assert.deepEqual(steps(), ["build start"]);

  await new Promise((r) => setTimeout(r, 5));
  mark(plan, { step: "build", event: "end" });
  await report(plan, { table: false }, hooks);
  await report(plan, { table: false }, hooks);
  assert.deepEqual(steps(), ["build start", "build end"]);
});

test("the hunt reads the saved round's series too, so a SUE fault in that round is named (2026-10-07)", async () => {
  // An engine round's rows go to "<series>-engine"; the hunt read the plan's live series and said nothing was wrong
  // while SUE's own code guard had stopped every Sue of the round at the first box.
  const { plan, hooks } = savedRound();
  const refused = {
    at: "2026-10-03T10:01:00.000Z",
    tool: "type",
    args: { target: 1, text: "[six-digit code redacted]" },
    result: "Do not type the code yourself. Use field: the-code-from-my-email and the body will read it out of your inbox.",
    isError: true,
  };
  writeFileSync(path.join(hooks.runsDir, "r1", "sue-1-kid-a", "trace.jsonl"), `${JSON.stringify(refused)}\n`);
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await report(plan, { table: false }, hooks);
    lines.push("-- hunt --");
    hunt(plan, { json: true, runs: hooks.runsDir });
  } finally {
    console.log = log;
  }
  const [reported, hunted] = lines.join("\n").split("-- hunt --");
  assert.match(reported, /\[code-refused\] r1\/sue-1-kid-a/);
  assert.ok(
    JSON.parse(hunted).some((item) => item.kind === "code-refused" && item.subject === "r1/sue-1-kid-a"),
    hunted,
  );
});

test("an A/B arm's report reads its trend from its own engine's rounds, never the other arm's (2026-10-07)", async () => {
  // Both arms of an A/B keep their rounds in one "<series>-engine". The low-effort arm's report printed the default arm's
  // newer round as its own ROUND (4.25 stars, 2 of 4 finished) while every one of its own four Sues had not finished.
  const { plan, resetAt, hooks } = savedRound();
  const mine = { ref: "aaaa111", commit: "aaaa111", id: "a1a1a1a1a1a1a1a1" };
  writeFileSync(
    stateFileOf(plan, { engineRef: mine.ref }),
    JSON.stringify({ series: "lift-v2-engine", kind: "people", resetAt, engine: mine, runs: [{ name: "kid-a", runId: "r1" }] }),
  );
  writeRound(plan.workspace, seriesKey("lift-v2-engine"), {
    id: "2026-10-03T10:05:00.000Z",
    at: "2026-10-03T10:05:00.000Z",
    stars: 5,
    finished: 0,
    people: 1,
    engine: { ref: "bbbb222", commit: "bbbb222", id: "b2b2b2b2b2b2b2b2" },
  });
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await report(plan, { table: false, engineRef: mine.ref }, hooks);
  } finally {
    console.log = log;
  }
  assert.match(lines.join("\n"), /^ROUND {4}3 stars, 1 of 1 finished; the series so far: 3$/m);
});

test("a Sue whose visit ended without an exit interview leaves her unrated, and the round is still recorded (2026-10-07)", async () => {
  // A Haiku 5.5 Sue's brain went quiet before her exit interview; the relay ended her visit ("no-interview"), and the
  // round waited for stars that could never come, so neither the round nor its A/B could ever be read.
  const { plan, resetAt, hooks } = savedRound();
  const state = JSON.parse(readFileSync(path.join(plan.state, "last.json"), "utf8"));
  state.runs.push({ name: "kid-b", runId: "r2" });
  writeFileSync(path.join(plan.state, "last.json"), JSON.stringify(state));
  const quiet = path.join(hooks.runsDir, "r2", "sue-2-kid-b");
  mkdirSync(quiet, { recursive: true });
  writeFileSync(path.join(quiet, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Part one" })}\n`);
  writeFileSync(
    path.join(quiet, "summary.json"),
    JSON.stringify({ endedAt: "2026-10-03T10:16:00.000Z", interviewed: false, outcome: "no-interview" }),
  );
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await report(plan, { table: false }, hooks);
  } finally {
    console.log = log;
  }
  const [row] = readRounds(plan.workspace, seriesKey("lift-class-unit"));
  assert.deepEqual(
    [row?.id, row?.people, row?.stars, row?.finished, row?.each.map((e) => [e.who, e.stars])],
    [
      resetAt,
      2,
      3,
      1,
      [
        ["kid-a", 3],
        ["kid-b", null],
      ],
    ],
    lines.join("\n"),
  );
  assert.match(lines.join("\n"), /kid-b\s+- stars {2}did not finish {2}\(her visit ended without an exit interview\)/);
});

test("times reads the runs folder it is given and prints a line for each Sue that moved", () => {
  const { plan, hooks } = savedRound();
  const lines = [];
  const log = console.log;
  console.log = (...a) => lines.push(a.join(" "));
  try {
    times(plan, { runs: hooks.runsDir });
  } finally {
    console.log = log;
  }
  assert.match(lines.join("\n"), /kid-a\s+first move .* 1 moves/);
});

test("a retried step keeps both spans", () => {
  const at = (s) => `2026-10-03T10:00:${String(s).padStart(2, "0")}.000Z`;
  const spans = stepSpans([
    { step: "deploy", event: "start", at: at(0) },
    { step: "deploy", event: "end", at: at(10) },
    { step: "deploy", event: "start", at: at(20) },
    { step: "deploy", event: "end", at: at(25) },
  ]);
  assert.deepEqual(spans.deploy.spans, [10_000, 5_000]);
});

test("mark without --plan is a usage error, not a crash", () => {
  const r = spawnSync(process.execPath, [ROUND, "mark", "build", "start"], { encoding: "utf8", windowsHide: true });
  assert.equal(r.status, 2);
  assert.match(r.stdout, /--plan <plan\.json> is required/);
  assert.doesNotMatch(r.stderr, /TypeError/);
});

/** A plan with a live round, a tape round and a reference round saved the way `start` saves them (stateFileOf), each
 *  with one run of its own that said a different star count. */
function threeRounds() {
  const dir = mkdtempSync(path.join(ROOT, "plan-"));
  const plan = {
    file: path.join(dir, "plan.json"),
    series: "lift-unit",
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    doneWhen: ["Unit complete"],
    reference: { url: "https://ref.example", series: "lift-ref", doneWhen: ["Unit complete"] },
  };
  const runsDir = path.join(dir, "runs");
  mkdirSync(plan.state, { recursive: true });
  const rounds = [
    { opts: {}, series: "lift-unit", runId: "live-run", stars: 2, resetAt: "2026-10-03T10:00:00.000Z", extra: {} },
    {
      opts: { tape: "tapes/unit" },
      series: "lift-unit-tape",
      runId: "tape-run",
      stars: 4,
      resetAt: "2026-10-03T11:00:00.000Z",
      extra: { tape: "tapes/unit" },
    },
    {
      opts: { reference: true },
      series: "lift-ref",
      runId: "ref-run",
      stars: 5,
      resetAt: "2026-10-03T12:00:00.000Z",
      extra: { reference: true },
    },
  ];
  for (const r of rounds) {
    writeFileSync(
      stateFileOf(plan, r.opts),
      JSON.stringify({ series: r.series, kind: "people", resetAt: r.resetAt, runs: [{ name: "kid", runId: r.runId }], ...r.extra }),
    );
    const sueDir = path.join(runsDir, r.runId, "sue-1-kid");
    mkdirSync(sueDir, { recursive: true });
    writeFileSync(path.join(sueDir, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Unit complete" })}\n`);
    writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: r.stars }));
  }
  const hooks = { run: async () => ({ ok: true, complete: true }), runsDir, startTable: async () => {} };
  return { plan, hooks, rounds };
}

test("a live, a tape and a reference round each keep their own state file, and report reads the one its flags name", async () => {
  const { plan, hooks, rounds } = threeRounds();
  assert.deepEqual(
    ["last.json", "last-tape.json", "last-reference.json"].map((f) => existsSync(path.join(plan.state, f))),
    [true, true, true],
    "starting one kind of round left the others' files alone",
  );
  const live = JSON.parse(readFileSync(path.join(plan.state, "last.json"), "utf8"));
  assert.equal(live.runs[0].runId, "live-run", "the tape and reference rounds did not overwrite the live round");

  await report(plan, { table: false }, hooks);
  await report(plan, { table: false, tape: "tapes/unit" }, hooks);
  await report(plan, { table: false, reference: true }, hooks);
  for (const r of rounds) {
    const [row] = readRounds(plan.workspace, seriesKey(r.series));
    assert.deepEqual([row.id, row.runIds, row.stars], [r.resetAt, [r.runId], r.stars], `${r.series} reported its own round`);
  }
});

test("the two pinned arms of an A/B keep two states, so both start from one plan side by side", () => {
  // One "last-engine.json" had the second arm's start overwrite the first's (Raise Buddy, 2026-10-12).
  const { plan } = threeRounds();
  const base = stateFileOf(plan, { engineRef: "95d6f4602d~1" });
  const head = stateFileOf(plan, { engineRef: "95d6f4602d" });
  assert.notEqual(base, head);
  assert.equal(path.basename(head), "last-engine-95d6f4602d.json");
});

test("a reference round's state goes to last-reference.json and leaves last.json untouched", () => {
  const { plan } = threeRounds();
  const liveBefore = readFileSync(path.join(plan.state, "last.json"), "utf8");
  assert.equal(path.basename(stateFileOf(plan, { reference: true })), "last-reference.json");
  mark(plan, { step: "build", event: "start", reference: true });
  assert.equal(readFileSync(path.join(plan.state, "last.json"), "utf8"), liveBefore);
  const ref = JSON.parse(readFileSync(path.join(plan.state, "last-reference.json"), "utf8"));
  assert.deepEqual(
    ref.marks.map((m) => m.step),
    ["build"],
  );
});
