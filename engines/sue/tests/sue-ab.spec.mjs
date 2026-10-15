// The A/B a SUE change owes (lib/sue-ab.mjs, ab.mjs): old arm against new arm over the same people and builds, read as
// better, worse, same or unresolved, behaviour first. Fixtures are run folders in a temp dir; no SUE round is run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";

import { armKey, comparePersonaDocs, compareArms, ledgerRow, overfitSuspects, pickArms, readVisits, seriesRows } from "../lib/sue-ab.mjs";
import { loadTarget, targetPath } from "../../lib/target.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "sue-ab-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));
const AB = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "ab.mjs");

const PEOPLE = ["kid-jo", "teen-emily", "teen-deshawn"];
const OLD = { engine: "e1".padEnd(64, "0"), driver: "d1".padEnd(64, "0"), hands: "h1".padEnd(64, "0") };
const NEW = { ...OLD, hands: "h2".padEnd(64, "0") };
const BUILDS = { "https://x.test/": "b1" };

let counter = 0;
/**
 * A world: run folders under `dir/runs`, rows in `dir/rounds/<series>.jsonl`. Rounds are { arm, builds, visits: {who: spec} }.
 * A spec's `routes` (urls) become the visit's trace.jsonl hops; without them no trace is written, so every persona's
 * path is "(no trace)" on both sides and reads as the same path.
 */
function world(name, rounds, series = "s1") {
  const dir = path.join(ROOT, name);
  const rows = [];
  rounds.forEach((rd, n) => {
    const id = new Date(Date.UTC(2026, 9, 3, 10, n)).toISOString();
    const row = { id, at: id, series, round: n + 1, runIds: [], each: [], critics: [] };
    for (const [who, v] of Object.entries(rd.visits)) {
      counter += 1;
      const runId = `20261003-1${String(n).padStart(2, "0")}000-${counter.toString(16).padStart(4, "0")}`;
      const sue = path.join(dir, "runs", runId, `sue-${2000 + counter}-${who}`);
      mkdirSync(sue, { recursive: true });
      row.runIds.push(runId);
      row.each.push({ who, stars: v.stars ?? 4, finished: v.finished ?? true });
      writeFileSync(
        path.join(sue, "reuse.json"),
        JSON.stringify({ parts: { ...rd.arm, docs: rd.docs ?? "d", args: "a" }, builds: rd.builds || BUILDS, round: id, at: id }),
      );
      writeFileSync(path.join(sue, "summary.json"), JSON.stringify({ persona: who }));
      writeFileSync(
        path.join(sue, "findings.jsonl"),
        (v.notes || []).map((n) => JSON.stringify(typeof n === "string" ? { kind: "thought", text: n } : n)).join("\n"),
      );
      writeFileSync(path.join(dir, "runs", runId, "manifest.json"), JSON.stringify({ groundTruth: { oneLiner: v.expect || "" } }));
      if (v.routes)
        writeFileSync(path.join(sue, "trace.jsonl"), v.routes.map((url) => JSON.stringify({ kind: "hop", url })).join("\n") + "\n");
    }
    rows.push(row);
  });
  mkdirSync(path.join(dir, "rounds"), { recursive: true });
  writeFileSync(path.join(dir, "rounds", `${series}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return { dir, runsDir: path.join(dir, "runs"), roundsDir: path.join(dir, "rounds"), rows };
}

const notes = (n, kind = "thought") => Array.from({ length: n }, (_, i) => ({ kind, text: `note number ${i} about the page` }));
// Problem notes carrying a typed claim (lib/findings.mjs problemNote), as a Sue on the typed ledger files them.
const typedProblems = (n) => notes(n, "confusion").map((x) => ({ ...x, problem: { title: x.text, severity: "minor" } }));
const everyone = (spec) => Object.fromEntries(PEOPLE.map((p) => [p, typeof spec === "function" ? spec(p) : spec]));
const arm = (parts, visits) => ({ arm: parts, visits });
const START = "https://x.test/start";
const lesson = (name) => `https://x.test/lesson#/play/${name}?step=2`;

function run(w, opts = {}) {
  const visits = readVisits({ rows: w.rows, runsDir: w.runsDir });
  const picked = pickArms(visits, opts);
  return { visits, picked, report: picked.base ? compareArms(picked) : null };
}

test("an arm that finds more problems on the same build, past the dead zone over two rounds of each arm, reads better and stops", () => {
  const w = world("improve", [
    arm(OLD, everyone({ notes: notes(4) })),
    arm(OLD, everyone({ notes: notes(4) })),
    arm(NEW, everyone({ notes: [...notes(4), ...typedProblems(3)] })),
    arm(NEW, everyone({ notes: [...notes(4), ...typedProblems(3)] })),
  ]);
  const { picked, report } = run(w);
  assert.equal(picked.head.key.includes(NEW.hands.slice(0, 8)), true, "head is the newest arm");
  assert.equal(report.metrics.problems.verdict, "better");
  assert.equal(report.metrics.typed.verdict, "shown", "typed claims are shown, never judged: the old arm had none to type");
  assert.deepEqual([report.metrics.typed.base, report.metrics.typed.head], [0, 3]);
  assert.equal(report.metrics.notes.verdict, "better");
  assert.equal(report.verdict, "better");
  assert.equal(report.resolved, true);
  assert.equal(report.another.round, false, "a resolved verdict owes no round");
  assert.equal(report.sameBuild, true);
  assert.deepEqual(report.personas.sort(), [...PEOPLE].sort());
});

test("fewer notes and every Sue stopping short of the finish, past the dead zone, reads worse", () => {
  const w = world("regress", [
    arm(OLD, everyone({ notes: notes(6) })),
    arm(OLD, everyone({ notes: notes(6) })),
    arm(NEW, everyone({ notes: notes(2), finished: false })),
    arm(NEW, everyone({ notes: notes(2), finished: false })),
  ]);
  const { report } = run(w);
  assert.equal(report.metrics.notes.verdict, "worse");
  assert.equal(report.metrics.finished.verdict, "worse");
  assert.equal(report.verdict, "worse");
});

test("a move inside the dead zone, over two rounds of each arm, reads the same: the mean of each persona's change per visit", () => {
  // Per persona, head minus base per visit: kid-jo 6 - 6.5, teen-emily 5 - 3.5, teen-deshawn 0; their mean is +1/3 note,
  // and no resample of three can leave the +-2 zone.
  const w = world("noise", [
    arm(OLD, { "kid-jo": { notes: notes(5) }, "teen-emily": { notes: notes(5) }, "teen-deshawn": { notes: notes(5) } }),
    arm(OLD, { "kid-jo": { notes: notes(8) }, "teen-emily": { notes: notes(2) }, "teen-deshawn": { notes: notes(5) } }),
    arm(NEW, { "kid-jo": { notes: notes(6) }, "teen-emily": { notes: notes(5) }, "teen-deshawn": { notes: notes(5) } }),
    arm(NEW, { "kid-jo": { notes: notes(6) }, "teen-emily": { notes: notes(5) }, "teen-deshawn": { notes: notes(5) } }),
  ]);
  const { report } = run(w);
  assert.equal(report.metrics.notes.estimate, 0.333);
  assert.equal(report.metrics.notes.verdict, "same");
  assert.equal(report.verdict, "same");
  assert.equal(report.resolved, true);
});

test("one round per arm is unresolved whatever its interval says, and the stop line asks for a round of the head", () => {
  const w = world("one-round", [arm(OLD, everyone({ notes: notes(2) })), arm(NEW, everyone({ notes: notes(9) }))]);
  const { report } = run(w);
  assert.equal(report.metrics.notes.verdict, "better", "the metric's own read");
  assert.equal(report.verdict, "unresolved", "one round of each arm cannot tell the change from that round's weather");
  assert.equal(report.resolved, false);
  assert.deepEqual([report.another.round, report.another.arm], [true, "head"]);
  assert.match(report.another.why, /the head arm has 1 round/);
});

test("behaviour first: a Sue whose path changed between the arms is named with both paths and left out of what she perceived; finished counts her", () => {
  // Everyone's head visits hop to the start twice in a row (one route) and keep the lesson's query (dropped); only
  // kid-jo plays another lesson, and her +5 notes measure that lesson, not the change.
  const w = world("changed-path", [
    arm(OLD, everyone({ notes: notes(4), routes: [START, lesson("one")] })),
    arm(OLD, everyone({ notes: notes(4), routes: [START, lesson("one")] })),
    arm(
      NEW,
      everyone((p) => ({ notes: notes(p === "kid-jo" ? 9 : 4), routes: [START, START, lesson(p === "kid-jo" ? "two" : "one")] })),
    ),
    arm(
      NEW,
      everyone((p) => ({ notes: notes(p === "kid-jo" ? 9 : 4), routes: [START, START, lesson(p === "kid-jo" ? "two" : "one")] })),
    ),
  ]);
  const { report } = run(w);
  assert.deepEqual(report.diverged, [
    {
      who: "kid-jo",
      kind: "changed",
      base: ["x.test/start", "x.test/lesson#/play/one"],
      head: ["x.test/start", "x.test/lesson#/play/two"],
    },
  ]);
  assert.equal(report.metrics.notes.people, 2);
  assert.equal(report.metrics.notes.verdict, "same");
  assert.equal(report.metrics.finished.people, 3);
});

test("behaviour first: a Sue whose path varied between two rounds of one arm is unstable on that side and left out", () => {
  const w = world("unstable-path", [
    arm(
      OLD,
      everyone((p) => ({ notes: notes(4), routes: p === "teen-emily" ? [START] : [START, lesson("one")] })),
    ),
    arm(OLD, everyone({ notes: notes(4), routes: [START, lesson("one")] })),
    arm(NEW, everyone({ notes: notes(4), routes: [START, lesson("one")] })),
    arm(NEW, everyone({ notes: notes(4), routes: [START, lesson("one")] })),
  ]);
  const { report } = run(w);
  assert.deepEqual(report.diverged, [{ who: "teen-emily", kind: "unstable", side: "base", variants: 2 }]);
  assert.equal(report.metrics.notes.people, 2);
});

test("behaviour first: with fewer than two Sues left on their path, what they perceived is not read and owes no round", () => {
  // The head adds a hop for every Sue (an arrival page before the start) and her notes fall from 6 to 2. Nobody kept her
  // path, so there are no notes to compare: not a mean of 0 against 0, and not a change too small for the panel.
  const was = { notes: notes(6), routes: [START, lesson("one")] };
  const now = { notes: notes(2), routes: ["https://x.test/arrive", START, lesson("one")] };
  const twice = (inBase, inHead) => [arm(OLD, inBase), arm(OLD, inBase), arm(NEW, inHead), arm(NEW, inHead)];
  const r = run(world("all-diverged", twice(everyone(was), everyone(now)))).report;
  assert.equal(r.diverged.length, 3);
  assert.deepEqual(r.metrics.notes, {
    base: null,
    head: null,
    estimate: null,
    low: null,
    high: null,
    level: 0.95,
    people: 0,
    deadZone: 2,
    verdict: "unread",
  });
  assert.equal(r.metrics.finished.verdict, "same", "finishing is still read over everyone");
  assert.equal(r.verdict, "unresolved");
  assert.deepEqual([r.another.round, r.another.arm], [false, null], "a round adds visits, never a Sue back to her path");
  assert.match(r.another.why, /every one of the 3 took another path/);
  assert.doesNotMatch(r.another.why, /smaller than this panel can see/);
  // One Sue left on her path is anecdote too: still unread, and still no round for it.
  const one = run(
    world(
      "one-kept",
      twice(
        everyone(was),
        everyone((p) => (p === "kid-jo" ? was : now)),
      ),
    ),
  ).report;
  assert.deepEqual([one.metrics.notes.people, one.metrics.notes.verdict, one.metrics.notes.base], [1, "unread", null]);
  assert.equal(one.another.round, false);
  assert.match(one.another.why, /only 1 of the 3 kept her path/);
});

// The 8-person panel of lift-v2. Decided 2026-10-07: one Sue who stops finishing no longer fails the A/B by herself
// (finishing never moved between two rounds of one arm, so the old band of 0 read her flip as beyond noise); she is
// listed first, and three of eight one way read worse.
const PANEL = "crazygames-kid game-designer kid-jo phone-kid-upright retention-doctor teen-deshawn teen-emily teen-marisol-es".split(" ");

test("one Sue in eight who stops finishing reads unresolved and is listed first; three in eight read worse", () => {
  // A finisher returns to the start after the lesson; a Sue who stops does not. crazygames-kid re-enters the lesson in
  // the head, a changed path with no change in finishing, and sorts after the Sue who stopped.
  const finisher = { notes: notes(4), routes: [START, lesson("one"), START] };
  const visits = (quit) =>
    Object.fromEntries(
      PANEL.map((p) => [
        p,
        quit.includes(p)
          ? { notes: notes(4), finished: false, routes: [START, lesson("one")] }
          : p === "crazygames-kid"
            ? { notes: notes(4), routes: [START, lesson("one"), START, lesson("one"), START] }
            : finisher,
      ]),
    );
  const before = Object.fromEntries(PANEL.map((p) => [p, finisher]));
  const rounds = (quit) => [arm(OLD, before), arm(OLD, before), arm(NEW, visits(quit)), arm(NEW, visits(quit))];
  const one = run(world("one-quits", rounds(["teen-emily"]))).report;
  assert.equal(one.metrics.finished.verdict, "unresolved");
  assert.equal(one.verdict, "unresolved");
  assert.deepEqual(
    one.diverged.map((d) => [d.who, d.outcomes]),
    [
      ["teen-emily", { finished: { base: 1, head: 0 } }],
      ["crazygames-kid", undefined],
    ],
  );
  const three = run(world("three-quit", rounds(["kid-jo", "teen-deshawn", "teen-emily"]))).report;
  assert.equal(three.metrics.finished.verdict, "worse");
  assert.equal(three.verdict, "worse");
});

test("the stop rule: a straddling read asks for a round of the arm with fewer rounds, and at three rounds of each says the budget is spent", () => {
  // Notes up 3 for two of three people: the mean change, +2, sits on the edge of its dead zone, so the interval straddles it.
  const base = arm(OLD, everyone({ notes: notes(4) }));
  const head = arm(
    NEW,
    everyone((p) => ({ notes: notes(p === "kid-jo" ? 4 : 7) })),
  );
  const pick = { base: "h1", head: "h2" };
  const short = run(world("stop-short", [base, base, head, head, head]), pick).report;
  assert.deepEqual(short.rounds, { base: 2, head: 3 });
  assert.equal(short.metrics.notes.verdict, "unresolved");
  assert.equal(short.verdict, "unresolved");
  assert.deepEqual([short.another.round, short.another.arm], [true, "base"]);
  assert.match(short.another.why, /notes straddles its dead zone/);
  const spent = run(world("stop-spent", [base, base, head, head, head, base]), pick).report;
  assert.deepEqual(spent.rounds, { base: 3, head: 3 });
  assert.equal(spent.verdict, "unresolved");
  assert.deepEqual([spent.another.round, spent.another.arm], [false, null]);
  assert.match(spent.another.why, /3 rounds of each arm are spent/);
});

test("the base is the newest older arm that shares a build and two people; an arm on another build is skipped, or named when forced", () => {
  const w = world("pick", [
    arm(OLD, everyone({ notes: notes(2) })),
    arm({ ...OLD, driver: "d0".padEnd(64, "0") }, everyone({ notes: notes(3) })),
    arm(NEW, everyone({ notes: notes(4) })),
  ]);
  // the middle arm sits on another build: it cannot be the default base
  const moved = readVisits({ rows: w.rows, runsDir: w.runsDir }).map((v) =>
    v.arm.driver.startsWith("d0") ? { ...v, builds: { "https://x.test/": "b2" } } : v,
  );
  const picked = pickArms(moved, {});
  assert.equal(picked.base.parts.driver.startsWith("d1"), true);
  const forced = pickArms(moved, { base: "d0" });
  assert.equal(compareArms({ visits: moved, ...forced }).sameBuild, false, "different builds are said, not hidden");
});

test("a four-word run the head added that sits in one or two measured visits is flagged; ordinary reuse is not", () => {
  const gold = [
    { id: "kid-jo", text: "the purple banner covers the start button on my phone and I gave up" },
    { id: "teen-emily", text: "it was fine" },
  ];
  const out = overfitSuspects({
    baseText: "Say what you notice.",
    headText: "Say what you notice. Mention that the purple banner covers the start button if you see it.",
    gold,
  });
  assert.equal(out.length > 0, true);
  assert.equal(out[0].gold.includes("kid-jo"), true);
  assert.deepEqual(overfitSuspects({ baseText: "Say what you notice.", headText: "Say what you notice, then say it again.", gold }), []);
});

test("the ledger row carries the documented shape and worse owes an accept", () => {
  const w = world("ledger", [
    arm(OLD, everyone({ notes: notes(6) })),
    arm(OLD, everyone({ notes: notes(6) })),
    arm(NEW, everyone({ notes: notes(1) })),
    arm(NEW, everyone({ notes: notes(1) })),
  ]);
  const { report } = run(w);
  const row = ledgerRow(report, { at: "2026-10-04T01:00:00Z", commits: ["abc123"], series: ["s1"] });
  assert.equal(row.kind, "measured");
  for (const k of "at base head commits builds series visits rounds diverged metrics verdict resolved another stat".split(" "))
    assert.ok(k in row, k);
  assert.deepEqual(Object.keys(row.head).sort(), ["driver", "engine", "hands"]);
  assert.deepEqual(Object.keys(row.metrics.notes).sort(), ["base", "deadZone", "estimate", "head", "high", "low", "people", "verdict"]);
  assert.deepEqual(row.rounds, { base: 2, head: 2 });
  assert.equal(row.verdict, "worse");
  assert.equal(row.resolved, true);
  assert.deepEqual(row.commits, ["abc123"]);
  assert.equal(ledgerRow(report, { kind: "rejected", note: "worse" }).kind, "rejected");
  assert.equal(ledgerRow(report, { accept: "owner wants it" }).accept, "owner wants it");
});

// lift-v2-engine, 2026-10-04: rounds on the engine before 7aff174ca5 against rounds on ad61087d9c. The arms' newest
// visits were an hour apart, and the only SUE commit landed in that hour was 3ed18664e8, in neither arm: the row would
// have named it, and left the two commits it measured (the keyed question, the sound) unmeasured in the hunt.
// lift-v2-engine, 2026-10-07: rounds alternate arms, and a round of the old engine run last made it the head, so the
// next-round line asked for the wrong engine and the commits between them read as none.
test("an A/B between two pinned engines names the decision commits between them, never what landed while the rounds ran, whichever arm ran last", (t) => {
  const git = (...args) => spawnSync("git", args, { cwd: path.dirname(AB), encoding: "utf8" });
  const [base, head] = ["7aff174ca5~1", "ad61087d9c"].map((ref) =>
    git("rev-parse", "--verify", "--quiet", `${ref}^{commit}`).stdout.trim(),
  );
  if (!base || !head) {
    t.skip("this checkout's history does not reach lift-v2-engine's two engines");
    return;
  }
  for (const order of [
    [OLD, OLD, NEW, NEW],
    [OLD, NEW, NEW, OLD],
  ]) {
    const w = world(
      `pinned-${order.indexOf(NEW)}`,
      order.map((parts) => arm(parts, everyone({ notes: notes(4) }))),
    );
    const pinned = w.rows.map((row, n) => ({
      ...row,
      engine: order[n] === OLD ? { ref: "7aff174ca5~1", commit: base } : { ref: "ad61087d9c", commit: head },
    }));
    writeFileSync(path.join(w.roundsDir, "s1.jsonl"), pinned.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const out = spawnSync(process.execPath, [AB, "--series", "s1", "--rounds-dir", w.roundsDir, "--runs-dir", w.runsDir, "--json"], {
      encoding: "utf8",
    });
    const report = JSON.parse(out.stdout);
    assert.deepEqual([report.base.commit, report.head.commit], [base, head], "the head is the newer engine, not the arm that ran last");
    const commits = report.commits.map((c) => c.slice(0, 10));
    assert.ok(commits.includes("7aff174ca5") && commits.includes("9a9dfa1f93"), `the keyed question and the sound: ${commits}`);
    assert.ok(!commits.includes("3ed18664e8"), `the look fix landed later, in neither engine: ${commits}`);
  }
});

test("ab.mjs --record writes the row and exits 1 on worse, 0 with --accept; the old band's --z is refused", () => {
  const w = world("cli", [
    arm(OLD, everyone({ notes: notes(6) })),
    arm(OLD, everyone({ notes: notes(6) })),
    arm(NEW, everyone({ notes: notes(1) })),
    arm(NEW, everyone({ notes: notes(1) })),
  ]);
  const ledger = path.join(w.dir, "ledger.jsonl");
  const base = [AB, "--series", "s1", "--rounds-dir", w.roundsDir, "--runs-dir", w.runsDir, "--ledger", ledger, "--no-git", "--record"];
  const a = spawnSync(process.execPath, [...base, "--json"], { encoding: "utf8" });
  assert.equal(a.status, 1, a.stderr);
  assert.equal(JSON.parse(a.stdout).verdict, "worse");
  const b = spawnSync(process.execPath, [...base, "--accept", "the owner wants fewer notes"], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  const rows = readFileSync(ledger, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.equal(rows[1].accept, "the owner wants fewer notes");
  const c = spawnSync(
    process.execPath,
    [AB, "--series", "s1", "--rounds-dir", w.roundsDir, "--runs-dir", w.runsDir, "--ledger", ledger, "--no-git", "--reject"],
    { encoding: "utf8" },
  );
  assert.notEqual(c.status, 0, "--reject without --note is refused");
  const z = spawnSync(process.execPath, [AB, "--series", "s1", "--rounds-dir", w.roundsDir, "--runs-dir", w.runsDir, "--z", "3"], {
    encoding: "utf8",
  });
  assert.equal(z.status, 2);
  assert.match(z.stderr, /unknown argument --z/);
});

// newtab-ab2, 2026-10-07: round.mjs keeps a series in <workspace>/.sue/rounds, but ab.mjs looked two folders above the
// repo, so a plain `ab.mjs --series <name>` read no rows and every A/B here had to pass --rounds-dir by hand.
test("ab.mjs without --rounds-dir reads the series round.mjs wrote in the repo's .sue/rounds", () => {
  const w = world("default-rounds", [
    arm(OLD, everyone({ notes: notes(4) })),
    arm(OLD, everyone({ notes: notes(4) })),
    arm(NEW, everyone({ notes: notes(4) })),
    arm(NEW, everyone({ notes: notes(4) })),
  ]);
  const series = `sue-ab-default-${process.pid}`;
  const repoRounds = targetPath(loadTarget().sueStore, "rounds");
  mkdirSync(repoRounds, { recursive: true });
  const file = path.join(repoRounds, `${series}.jsonl`);
  writeFileSync(file, readFileSync(path.join(w.roundsDir, "s1.jsonl")));
  try {
    const out = spawnSync(process.execPath, [AB, "--series", series, "--runs-dir", w.runsDir, "--no-git", "--json"], { encoding: "utf8" });
    const report = JSON.parse(out.stdout);
    assert.notEqual(report.verdict, "no comparison", `ab.mjs found no rounds for ${series}: ${out.stdout}`);
    assert.deepEqual(report.rounds, { base: 2, head: 2 });
  } finally {
    rmSync(file, { force: true });
  }
});

test("a series is read with its pinned-arm sibling, and no rounds at all says where it looked", () => {
  const dir = path.join(ROOT, "series-rows");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "ab-engine.jsonl"),
    `${JSON.stringify({ id: "r1", runs: [] })}
`,
  );
  writeFileSync(
    path.join(dir, "ab-engine.focus.jsonl"),
    `${JSON.stringify({ id: "r2", runs: [] })}
`,
  );
  assert.deepEqual(
    seriesRows(dir, ["ab"]).map((r) => r.id),
    ["r1"],
  );
  assert.deepEqual(
    seriesRows(dir, ["ab.focus"]).map((r) => r.id),
    ["r2"],
  );
  assert.throws(() => seriesRows(dir, ["other"]), /no rounds for other, other-engine in .*series-rows.*--rounds-dir/);
});

// One persona's docs against her previous docs (comparePersonaDocs): her visits only, grouped by the docs part hash.
const hour = (n) => new Date(Date.UTC(2026, 9, 10, n)).toISOString();
const pv = (rowId, n, o = {}) => ({
  who: "kid-jo",
  rowId,
  at: hour(n),
  arm: o.arm ?? OLD,
  builds: o.builds ?? BUILDS,
  docs: o.docs ?? "old",
  routes: o.routes ?? null,
  notes: o.notes ?? 1,
  characters: o.characters ?? 10,
  problems: 0,
  typed: 0,
  stars: 4,
  finished: o.finished ?? 1,
  text: "",
  expect: "",
});
const NEWER = [pv("r3", 3, { docs: "new" }), pv("r4", 4, { docs: "new" })];
const OLDER = [pv("r1", 1), pv("r2", 2)];

test("one persona's newest docs against her previous docs, on the same arm and builds: more notes past the dead zone reads better", () => {
  const c = comparePersonaDocs([...OLDER, ...NEWER.map((v) => ({ ...v, notes: 5 }))], "kid-jo");
  assert.equal(c.verdict, "better", c.why);
  assert.equal(c.head.docs, "new");
  assert.equal(c.base.docs, "old");
  assert.equal(c.metrics.notes.verdict, "better");
});

test("the same persona's docs with fewer notes past the dead zone reads worse", () => {
  const older = OLDER.map((v) => ({ ...v, notes: 5 }));
  const c = comparePersonaDocs([...older, ...NEWER.map((v) => ({ ...v, notes: 0 }))], "kid-jo");
  assert.equal(c.verdict, "worse", c.why);
});

test("a docs version with one round is unresolved whatever its numbers: one round is the weather", () => {
  const c = comparePersonaDocs([...OLDER, pv("r3", 3, { docs: "new", notes: 9 })], "kid-jo");
  assert.equal(c.verdict, "unresolved");
  assert.match(c.why, /round/);
});

test("a persona whose visits all carry one docs version has nothing to compare against", () => {
  const c = comparePersonaDocs([pv("r1", 1), pv("r2", 2), pv("r3", 3)], "kid-jo");
  assert.equal(c.verdict, "unresolved");
  assert.equal(c.base, null);
  assert.match(c.why, /one docs version|nothing to compare/);
});

test("the previous docs must have run on the newest docs' builds, or there is no previous version on them", () => {
  const onB2 = { "https://x.test/": "b2" };
  const c = comparePersonaDocs(
    [...OLDER, pv("r3", 3, { docs: "new", builds: onB2 }), pv("r4", 4, { docs: "new", builds: onB2 })],
    "kid-jo",
  );
  assert.equal(c.verdict, "unresolved");
  assert.match(c.why, /build/);
});

test("the arm read is the newest arm with two docs versions, so a single visit on another arm does not hide the comparison", () => {
  const c = comparePersonaDocs([...OLDER, ...NEWER.map((v) => ({ ...v, notes: 5 })), pv("r5", 5, { arm: NEW, docs: "other" })], "kid-jo");
  assert.equal(c.verdict, "better", c.why);
  assert.equal(c.arm.key, armKey(OLD));
});

test("a Sue whose path changed is behaviour first: her notes are unread, so the read is unresolved, while finishing is read", () => {
  const moved = NEWER.map((v) => ({ ...v, notes: 5, routes: [START] }));
  const c = comparePersonaDocs([...OLDER, ...moved], "kid-jo");
  assert.equal(c.diverged.length, 1);
  assert.equal(c.metrics.notes.verdict, "unread");
  assert.equal(c.metrics.finished.verdict, "same");
  assert.equal(c.verdict, "unresolved");
});

test("a Sue who stops finishing on a changed path reads worse, even with her path moved", () => {
  const moved = NEWER.map((v) => ({ ...v, finished: 0, routes: [START] }));
  assert.equal(comparePersonaDocs([...OLDER, ...moved], "kid-jo").verdict, "worse");
});

test("characters are shown, never judged: a longer text on the newest docs reads same", () => {
  const c = comparePersonaDocs([...OLDER, ...NEWER.map((v) => ({ ...v, characters: 900 }))], "kid-jo");
  assert.equal(c.verdict, "same", c.why);
  assert.equal(c.metrics.characters.verdict, "shown");
});

test("readVisits carries each visit's docs part, which is what one persona's docs are grouped by", () => {
  const w = world("docs-part", [
    { arm: OLD, docs: "old", visits: { "kid-jo": {} } },
    { arm: OLD, docs: "new", visits: { "kid-jo": {} } },
  ]);
  assert.deepEqual(
    readVisits({ rows: w.rows, runsDir: w.runsDir }).map((v) => v.docs),
    ["old", "new"],
  );
});

test("ab.mjs --persona <id> reads that persona's docs against her previous docs, and only hers", () => {
  const w = world("persona-cli", [
    { arm: OLD, docs: "old", visits: everyone({ notes: notes(1) }) },
    { arm: OLD, docs: "old", visits: everyone({ notes: notes(1) }) },
    { arm: OLD, docs: "new", visits: everyone({ notes: notes(6) }) },
    { arm: OLD, docs: "new", visits: everyone({ notes: notes(6) }) },
  ]);
  const r = spawnSync(
    process.execPath,
    [AB, "--series", "s1", "--persona", "kid-jo", "--json", "--rounds-dir", w.roundsDir, "--runs-dir", w.runsDir, "--no-git"],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.persona, "kid-jo");
  assert.equal(out.verdict, "better", out.why);
});
