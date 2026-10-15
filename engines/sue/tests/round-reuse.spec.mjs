// Identity reuse in rounds: a student whose visit would be decided by exactly what decided her last fresh visit is not
// sent again; the record says so, and a reused round can break a streak but never extend one.
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { argsOf, handsFiles, inputsHash } from "../lib/reuse.mjs";
import { readRounds, renderTrend, seriesKey, targetOf, trend } from "../lib/rounds.mjs";
import { pickArms, readSeriesRows, readVisits } from "../lib/sue-ab.mjs";
import { holderStateFile, warmDoor } from "../people-door.mjs";
import { report, start, stateFileOf } from "../round.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = mkdtempSync(path.join(tmpdir(), "sue-round-reuse-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const NAMES = ["a", "b", "c"];
const BUILDS = [{ url: "https://one.test/", header: "x-v" }];

/** A plan with reuse switched on, over a private folder holding the driver file and the runs folder. */
function setup() {
  const dir = mkdtempSync(path.join(ROOT, "plan-"));
  const driver = path.join(dir, "sue-driver.md");
  writeFileSync(driver, "driver v1");
  const plan = {
    file: path.join(dir, "plan.json"),
    series: "reuse",
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    demo: "http://localhost:1/",
    intent: "try it",
    doneWhen: ["Unit complete"],
    reset: null,
    reuse: { builds: BUILDS, driver },
    students: NAMES.map((persona) => ({ persona, seat: "" })),
  };
  return { dir, plan, runsDir: path.join(dir, "runs"), driver };
}

/** The injected world: build headers, person docs, the engine id, and a `run` that counts what it starts. */
function world({ version = "b1", docs = {}, engine = "e1", fail = false } = {}) {
  const w = {
    version,
    docs: {
      a: { id: "a", voice: "A" },
      b: { id: "b", voice: "B" },
      c: { id: "c", voice: "C" },
      doc: { id: "doc", voice: "D", critic: true },
      ...docs,
    },
    minds: { doc: "mind v1" },
    engine,
    fail,
    started: [],
    fetched: 0,
    calls: [],
  };
  w.fetch = async () => {
    w.fetched += 1;
    if (w.fail) throw new Error("connect refused");
    return { ok: true, status: 200, headers: { get: (h) => (h === "x-v" ? w.version : null) } };
  };
  // The Boardroom door: one list answers every person (built-ins too), one mind call per critic.
  w.people = async (tool, body) => {
    w.calls.push(tool);
    if (tool === "boardroom_personas_sue_list")
      return {
        ok: true,
        status: 200,
        body: { personas: Object.values(w.docs).map((doc) => ({ doc, updatedAt: "2026-01-01T00:00:00Z" })) },
      };
    if (tool === "boardroom_personas_sue_mind") return { ok: true, status: 200, body: { mind: w.minds[body.sueId] } };
    return { ok: false, status: 404, body: null, text: `no tool ${tool}` };
  };
  w.engineId = () => w.engine;
  w.run = async (_a, args) => {
    w.started.push(args.personas[0]);
    return { ok: true, runId: `run-${w.started.length}-${args.personas[0]}` };
  };
  return w;
}

async function quiet(fn) {
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  try {
    await fn();
  } finally {
    console.log = log;
  }
  return lines.join("\n");
}

// CliMayte is declared down: the real probe retries a silent AgentHydra for ~12 s per start.
const hooksOf = (w, runsDir) => ({
  run: w.run,
  fetch: w.fetch,
  people: w.people,
  engineId: w.engineId,
  runsDir,
  climayte: async () => ({ ready: false, why: "no AgentHydra in this spec" }),
});

function visit(sueDir, stars) {
  mkdirSync(sueDir, { recursive: true });
  writeFileSync(path.join(sueDir, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Unit complete" })}\n`);
  writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: stars }));
  return sueDir;
}
const stateOf = (env) => JSON.parse(readFileSync(stateFileOf(env.plan, {}), "utf8"));
const startOf = (env, w, opts = { critics: false }) => quiet(() => start(env.plan, opts, hooksOf(w, env.runsDir)));

/** A finished round: the first start, every student's visit written, and the report that records it and its reuse.json. */
async function firstRound(env, w) {
  await startOf(env, w);
  const state = stateOf(env);
  for (const r of state.runs) {
    visit(path.join(env.runsDir, r.runId, `sue-1-${r.name}`), 5);
  }
  return state;
}
async function finish(env, w) {
  await firstRound(env, w);
  await reportOf(env, w);
  w.started.length = 0;
}
const startWith = (env, w, extra) =>
  quiet(() => start(env.plan, { critics: false }, { run: w.run, fetch: w.fetch, engineId: w.engineId, runsDir: env.runsDir, ...extra }));
const pair = (opts) => ({ env: setup(), w: world(opts) });
async function settled(opts) {
  const { env, w } = pair(opts);
  await finish(env, w);
  return { env, w };
}
const reportOf = (env, w, opts = {}) =>
  quiet(() =>
    report(
      env.plan,
      { table: false, ...opts },
      { run: async () => ({ ok: true, complete: true }), runsDir: env.runsDir, fetch: w.fetch, people: w.people },
    ),
  );

test("every input and build equal: NOTHING CHANGED, nothing started, no state or row written, under a second", async () => {
  const { env, w } = pair();
  await firstRound(env, w);
  await reportOf(env, w);
  const before = readFileSync(stateFileOf(env.plan, {}), "utf8");
  w.started.length = 0;
  const t0 = Date.now();
  const out = await startOf(env, w);
  assert.ok(Date.now() - t0 < 1000);
  assert.match(out, /NOTHING CHANGED: every student's visit is the same as round 1/);
  assert.match(out, /so round 1 stands\. Use --fresh to measure again\./);
  assert.deepEqual(w.started, []);
  assert.equal(readFileSync(stateFileOf(env.plan, {}), "utf8"), before);
  assert.equal(readRounds(env.plan.workspace, seriesKey("reuse")).length, 1);
});

test("one build header differs: every run is fresh", async () => {
  const { env, w } = await settled();
  w.version = "b2";
  const out = await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  assert.doesNotMatch(out, /NOTHING CHANGED|reused from round/);
});

test("one persona doc differs: only she is fresh, the others reuse and the row lists them", async () => {
  const { env, w } = await settled();
  w.docs.b = { id: "b", voice: "B, edited" };
  const out = await startOf(env, w);
  assert.deepEqual(w.started, ["b"]);
  assert.match(out, /a: reused from round 1/);
  assert.match(out, /c: reused from round 1/);
  const state = stateOf(env);
  assert.deepEqual(
    state.runs.map((r) => [r.name, Boolean(r.reused)]),
    [
      ["a", true],
      ["b", false],
      ["c", true],
    ],
  );
  assert.match(state.runs[0].runId, /^run-1-a$/, "a reused student points at the fresh visit's own run");
  // Her visit is read from the old folder; the second round's row says who was reused.
  const sueDir = visit(path.join(env.runsDir, state.runs[1].runId, "sue-1-b"), 5);
  const printed = await reportOf(env, w);
  assert.match(printed, /a\s+5 stars\s+FINISHED\s+\(reused from round 1\)/);
  const rows = readRounds(env.plan.workspace, seriesKey("reuse"));
  assert.deepEqual(rows[1].reused, ["a", "c"]);
  assert.equal(rows[1].fresh, 1);
  // The chain points at real fresh visits: a reused visit gets no reuse.json of its own, the fresh one does.
  assert.ok(existsSync(path.join(sueDir, "reuse.json")));
  const third = world({ docs: w.docs });
  third.started = [];
  const out3 = await quiet(() => start(env.plan, { critics: false }, hooksOf(third, env.runsDir)));
  assert.match(out3, /NOTHING CHANGED: every student's visit is the same as round 2/);
  assert.deepEqual(third.started, []);
});

test("a changed engine or driver file is a change: everyone is fresh", async () => {
  const { env, w } = await settled();
  w.engine = "e2";
  await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
});

test("--fresh turns reuse off for one start", async () => {
  const { env, w } = await settled();
  await startOf(env, w, { critics: false, fresh: true });
  assert.deepEqual(w.started, NAMES);
});

// The A/B (lib/sue-ab.mjs) reads a visit only through its reuse.json `parts`, and its verdict needs two rounds of
// each arm on one build. The second such round is a `--fresh` one (an unchanged round otherwise stands on the first),
// so a fresh round that recorded no identity left the verdict unreachable (SUE rounds 10 and 11 of lift-v2, 2026-10-04).
test("a --fresh round reuses no visit but still records its identity, so the A/B can read it", async () => {
  const { env, w } = pair();
  const first = await firstRound(env, w);
  await reportOf(env, w);
  const partsOf = (runId, who) => JSON.parse(readFileSync(path.join(env.runsDir, runId, `sue-1-${who}`, "reuse.json"), "utf8")).parts;
  await startOf(env, w, { critics: false, fresh: true });
  const again = stateOf(env);
  assert.ok(
    again.runs.every((r) => !r.reused),
    "nobody is reused",
  );
  for (const r of again.runs) {
    visit(path.join(env.runsDir, r.runId, `sue-1-${r.name}`), 4);
  }
  await reportOf(env, w);
  for (const r of again.runs) {
    const before = first.runs.find((f) => f.name === r.name);
    assert.notEqual(r.runId, before.runId);
    assert.deepEqual(partsOf(r.runId, r.name), partsOf(before.runId, before.name), `${r.name}: the same arm as round 1`);
  }
});

// A change to Sue herself is A/B'd on an arm of her old code over the builds and people of the current arm: a round
// started with an engine ref has that commit's engine plan and run every visit (sue.mjs runOnEngineAt), keeps its rows
// out of the live series, and labels its visits with that engine's id, so ab.mjs finds the two arms side by side.
test("a round on Sue's code at a git ref is an arm of its own: every run handed to that engine, kept apart, and compared with the current arm on the same builds and people", async () => {
  const { env, w } = pair();
  await firstRound(env, w);
  await reportOf(env, w);
  const liveState = readFileSync(stateFileOf(env.plan, {}), "utf8");
  const pinned = { id: "0123456789abcdef", commit: "91cc835f5d" };
  // Staged as stageEngineAt stages: the hands MCP's files copied in, here the same as this checkout's.
  const engineRoot = path.join(env.dir, "engine");
  for (const name of Object.keys(handsFiles())) {
    mkdirSync(path.dirname(path.join(engineRoot, name)), { recursive: true });
    copyFileSync(path.join(REPO, name), path.join(engineRoot, name));
  }
  const staged = [];
  const stageAt = (ref) => {
    staged.push(ref);
    return { ...pinned, ref, root: engineRoot, reused: false };
  };
  // The hand-off answers with the engine that planned the wave; c's answers from one that is not the staged engine.
  const handed = [];
  const run = async (action, args) => {
    handed.push(args.engineRef);
    const r = await w.run(action, args);
    return { ...r, engine: { ref: args.engineRef, commit: pinned.commit, id: args.personas[0] === "c" ? "fedcba9876543210" : pinned.id } };
  };
  const opts = { critics: false, engineRef: "HEAD~5" };
  const out = await quiet(() => start(env.plan, opts, { ...hooksOf(w, env.runsDir), run, stageAt }));
  assert.deepEqual(staged, ["HEAD~5"], "the engine is staged once for the whole round");
  assert.match(out, /ENGINE HEAD~5 = 91cc835f5d: 0123456789abcdef/);
  assert.deepEqual(
    handed,
    NAMES.map(() => pinned.commit),
    "every run is handed the commit, never the ref, which moves",
  );
  const state = JSON.parse(readFileSync(stateFileOf(env.plan, opts), "utf8"));
  assert.equal(state.series, "reuse-engine");
  assert.deepEqual(state.engine, { ref: "HEAD~5", commit: pinned.commit, id: pinned.id });
  const c = state.runs.find((r) => r.name === "c");
  assert.equal(c.runId, null, "a run that answered from another engine is not counted in the arm");
  assert.match(c.error, /fedcba9876543210.*0123456789abcdef/);
  assert.equal(readFileSync(stateFileOf(env.plan, {}), "utf8"), liveState, "the live round's state is left alone");

  for (const r of state.runs.filter((x) => x.runId)) {
    visit(path.join(env.runsDir, r.runId, `sue-1-${r.name}`), 3);
  }
  await reportOf(env, w, { engineRef: "HEAD~5" });
  assert.equal(readRounds(env.plan.workspace, seriesKey("reuse")).length, 1, "the live series' trend is not moved");

  const roundsDir = path.join(env.plan.workspace, ".sue", "rounds");
  const rows = ["reuse", "reuse-engine"].flatMap((s) => readSeriesRows(roundsDir, s));
  const { head, base, why } = pickArms(readVisits({ rows, runsDir: env.runsDir }));
  assert.equal(why, null);
  assert.notEqual(head.parts.engine, base.parts.engine);
  assert.deepEqual([head.parts.driver, head.parts.hands], [base.parts.driver, base.parts.hands]);
  const people = (arm) => arm.visits.map((v) => `${v.series}:${v.who}`).sort();
  assert.deepEqual(people(head), ["reuse-engine:a", "reuse-engine:b"]);
  assert.deepEqual(people(base), ["reuse:a", "reuse:b", "reuse:c"]);
  assert.equal(new Set([...head.visits, ...base.visits].map((v) => JSON.stringify(v.builds))).size, 1, "one build set");
});

test("a round on a staged engine fingerprints that engine's hands files, never this checkout's (2026-10-07)", async () => {
  // A Sue on a staged engine runs that engine's own hands-mcp.mjs (cannon.mjs HANDS_MCP), so her identity's hands part
  // is those files. The radiologistbuddy model A/B read every new arm as hands apart from its base because body.mjs was
  // being edited in this checkout, though every arm ran the same staged hands.
  const engines = mkdtempSync(path.join(ROOT, "engines-"));
  const engineAt = (name, text) => {
    mkdirSync(path.join(engines, name, "sue"), { recursive: true });
    writeFileSync(path.join(engines, name, "sue", "hands-mcp.mjs"), text);
    return path.join(engines, name);
  };
  const handsOf = async (root) => {
    const { env, w } = pair();
    const pinned = { id: "0123456789abcdef", commit: "91cc835f5d" };
    const stageAt = (ref) => ({ ...pinned, ref, root, reused: false });
    const run = async (action, args) => ({ ...(await w.run(action, args)), engine: { ref: args.engineRef, ...pinned } });
    const opts = { critics: false, fresh: true, engineRef: "HEAD~5" };
    await quiet(() => start(env.plan, opts, { ...hooksOf(w, env.runsDir), run, stageAt }));
    return JSON.parse(readFileSync(stateFileOf(env.plan, opts), "utf8")).runs[0].parts.hands;
  };
  const one = await handsOf(engineAt("one", "hands v1"));
  assert.equal(await handsOf(engineAt("two", "hands v1")), one, "the same hands staged twice are one hands part");
  assert.notEqual(await handsOf(engineAt("three", "hands v2")), one, "an engine whose hands differ is a hands arm apart");
});

test("a plan with no reuse block never reuses", async () => {
  const env = setup();
  delete env.plan.reuse;
  const w = world();
  await finish(env, w);
  await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  assert.equal(w.fetched, 0);
});

test("a failing fetch or a missing header means no reuse, said in one line", async () => {
  const { env, w } = await settled();
  w.fail = true;
  const out = await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  const lines = out.split("\n").filter((l) => /^NO REUSE/.test(l));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /one\.test.*connect refused/);

  w.fail = false;
  w.started.length = 0;
  w.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null } });
  const out2 = await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  assert.match(out2, /NO REUSE: .*one\.test.*x-v/);
});

test("report writes reuse.json only for fresh visits, and only when the builds did not change during the round", async () => {
  const { env, w } = pair();
  await firstRound(env, w);
  await reportOf(env, w);
  const file = (who, n) => path.join(env.runsDir, `run-${n}-${who}`, `sue-1-${who}`, "reuse.json");
  const rec = JSON.parse(readFileSync(file("a", 1), "utf8"));
  assert.equal(rec.round, "" + stateOf(env).resetAt);
  assert.deepEqual(rec.builds, { "https://one.test/": "b1" });
  assert.match(rec.inputs, /^[0-9a-f]{64}$/);

  // A second environment where the build moved while the round ran: nothing is written.
  const env2 = setup();
  const w2 = world();
  await firstRound(env2, w2);
  w2.version = "b9";
  await reportOf(env2, w2);
  assert.equal(existsSync(file("a", 1).replace(env.runsDir, env2.runsDir)), false);
});

test("a visit that ended without an exit interview is recorded unrated and never written as reusable (2026-10-07)", async () => {
  // Rounds with such a visit used to wait for her stars forever; now they record, and her unrated visit must not stand
  // for her in a later round.
  const { env, w } = pair();
  await firstRound(env, w);
  const unrated = path.join(env.runsDir, "run-2-b", "sue-1-b");
  rmSync(path.join(unrated, "interview.json"));
  writeFileSync(path.join(unrated, "summary.json"), JSON.stringify({ endedAt: "2026-10-07T00:00:00.000Z", outcome: "no-interview" }));
  await reportOf(env, w);
  const [saved] = readRounds(env.plan.workspace, seriesKey("reuse"));
  assert.deepEqual(
    saved?.each.map((e) => [e.who, e.stars]),
    [
      ["a", 5],
      ["b", null],
      ["c", 5],
    ],
  );
  assert.deepEqual(
    ["a", "b", "c"].map((who, i) => existsSync(path.join(env.runsDir, `run-${i + 1}-${who}`, `sue-1-${who}`, "reuse.json"))),
    [true, false, true],
  );
});

const row = (n, stars, finished, reused = []) => ({
  round: n,
  id: `r${n}`,
  at: `2026-10-0${n}T00:00:00Z`,
  stars,
  finished,
  people: 6,
  reused,
});
const target = targetOf({});

test("a reused row at target does not extend the streak; a reused row under target breaks it", () => {
  const met = trend([row(1, 4.8, 6), row(2, 4.8, 6, ["a", "b", "c", "d", "e", "f"])], target);
  assert.equal(met.metRun, 1);
  assert.notEqual(met.state, "done");
  const brokenUnder = trend([row(1, 4.8, 6), row(2, 3, 2, ["a"])], target);
  assert.equal(brokenUnder.metRun, 0);
  const onlyReused = trend([row(1, 4.8, 6, ["a"])], target);
  assert.equal(onlyReused.metRun, 0);
  const lines = renderTrend(trend([row(1, 4.8, 6), row(2, 4.8, 6, ["a"])], target), target).join("\n");
  assert.match(lines, /reused/i);
  assert.match(lines, /never extend|only fresh/i);
});

test("a critic whose mind changed is fresh while everyone else is reused", async () => {
  const env = setup();
  env.plan.critics = [{ persona: "doc", seat: "" }];
  const w = world();
  await finish(env, w);
  w.minds.doc = "mind v2";
  const out = await startOf(env, w, { critics: true });
  assert.deepEqual(w.started, ["doc"]);
  assert.match(out, /a: reused from round 1/);
  assert.doesNotMatch(out, /doc: reused/);
});

test("a changed engine fetches no people at all and says the engine changed", async () => {
  const { env, w } = await settled();
  w.calls.length = 0;
  w.engine = "e2";
  const out = await startOf(env, w);
  assert.deepEqual(w.calls, []);
  assert.deepEqual(w.started, NAMES);
  assert.match(out, /NO REUSE: the engine changed/);
  assert.match(out, /\(\d+ ms: builds \d+, people 0, engine \d+/);
});

test("every part equal: NOTHING CHANGED, the people asked once, nothing started, no row written", async () => {
  const env = setup();
  env.plan.critics = [{ persona: "doc", seat: "" }];
  const w = world();
  await startOf(env, w, { critics: true });
  const state = stateOf(env);
  for (const r of state.runs) {
    visit(path.join(env.runsDir, r.runId, `sue-1-${r.name}`), 5);
  }
  await reportOf(env, w);
  const reuse = JSON.parse(readFileSync(path.join(env.runsDir, "run-1-a", "sue-1-a", "reuse.json"), "utf8"));
  assert.deepEqual(Object.keys(reuse.parts).sort(), ["args", "docs", "driver", "engine", "hands"]);
  for (const hash of Object.values(reuse.parts)) assert.match(hash, /^[0-9a-f]{64}$/);
  const before = readFileSync(stateFileOf(env.plan, {}), "utf8");
  w.started.length = 0;
  w.calls.length = 0;
  const out = await startOf(env, w, { critics: true });
  assert.match(out, /NOTHING CHANGED/);
  assert.match(out, /\(\d+ ms: builds \d+, people \d+, engine \d+/);
  assert.equal(w.calls.filter((c) => c === "boardroom_personas_sue_list").length, 1);
  assert.deepEqual(w.started, []);
  assert.equal(readFileSync(stateFileOf(env.plan, {}), "utf8"), before);
  assert.equal(readRounds(env.plan.workspace, seriesKey("reuse")).length, 1);
});

test("a reuse.json without parts never matches", async () => {
  const { env, w } = pair();
  await firstRound(env, w);
  await reportOf(env, w);
  for (const n of [1, 2, 3]) {
    const file = path.join(env.runsDir, `run-${n}-${NAMES[n - 1]}`, `sue-1-${NAMES[n - 1]}`, "reuse.json");
    const rec = JSON.parse(readFileSync(file, "utf8"));
    delete rec.parts;
    writeFileSync(file, JSON.stringify(rec));
  }
  w.started.length = 0;
  const out = await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  assert.doesNotMatch(out, /NOTHING CHANGED|reused from round/);
});

test("two runs equal but for expect hash differently; with no expect the args are what they were", () => {
  const run = { url: "https://one.test/", lang: "en", personas: ["a"] };
  const base = { intent: "try it", interview: null, tape: null };
  const today = {
    url: "https://one.test/",
    lang: "en",
    intent: "try it",
    interview: null,
    critic: false,
    room: false,
    personas: ["a"],
    tape: null,
  };
  assert.deepEqual(argsOf(run, base), today);
  assert.deepEqual(argsOf(run, { ...base, expect: undefined }), today);
  assert.deepEqual(argsOf(run, { ...base, expect: "" }), today);
  assert.equal(inputsHash(argsOf(run, base)), inputsHash(today));
  const lesson = argsOf(run, { ...base, expect: "a lesson on using AI safely" });
  const math = argsOf(run, { ...base, expect: "a math quiz" });
  assert.equal(lesson.expect, "a lesson on using AI safely");
  assert.notEqual(inputsHash(lesson), inputsHash(math));
  assert.notEqual(inputsHash(lesson), inputsHash(argsOf(run, base)));
});

test("a plan whose expect changed sends everyone fresh", async () => {
  const env = setup();
  env.plan.expect = "a lesson on using AI safely";
  const w = world();
  await finish(env, w);
  const same = await startOf(env, w);
  assert.match(same, /NOTHING CHANGED/);
  env.plan.expect = "a math quiz";
  const out = await startOf(env, w);
  assert.deepEqual(w.started, NAMES);
  assert.doesNotMatch(out, /NOTHING CHANGED|reused from round/);
});

/** A finished round whose second start must reach the people itself: the history is written through the injected door. */
async function historyThenSpies(env, w) {
  await finish(env, w);
  w.calls.length = 0;
}
const spy = () => {
  const s = { n: 0 };
  s.fn = async () => {
    s.n += 1;
    return null;
  };
  return s;
};

test("a live warm holder answers the people: no door is opened and the breakdown says warm", async () => {
  const { env, w } = pair();
  await historyThenSpies(env, w);
  let opened = 0;
  const asked = [];
  const holder = { door: (tool, body) => (asked.push(tool), w.people(tool, body)) };
  const out = await startWith(env, w, {
    warm: async () => holder,
    openDoor: async () => {
      opened += 1;
    },
  });
  assert.equal(opened, 0);
  assert.match(out, /NOTHING CHANGED/);
  assert.match(out, /people \d+ warm/);
  assert.equal(asked.filter((t) => t === "boardroom_personas_sue_list").length, 1);
  assert.deepEqual(w.started, []);
});

test("a state file naming a dead holder: the door is opened as before and the breakdown says cold", async () => {
  const { env, w } = pair();
  await historyThenSpies(env, w);
  const stateDir = mkdtempSync(path.join(ROOT, "state-"));
  writeFileSync(holderStateFile(env.plan.workspace, { stateDir }), JSON.stringify({ port: 1, token: "x", pid: 1 }));
  let opened = 0;
  let closed = 0;
  const out = await startWith(env, w, {
    warm: () => warmDoor({ root: env.plan.workspace, stateDir }),
    openDoor: async () => {
      opened += 1;
      return { door: w.people, close: async () => (closed += 1) };
    },
  });
  assert.equal(opened, 1);
  assert.equal(closed, 1);
  assert.match(out, /NOTHING CHANGED/);
  assert.match(out, /people \d+ cold/);
});

test("an injected door touches neither the holder nor openDoor, and the breakdown names neither", async () => {
  const { env, w } = pair();
  await historyThenSpies(env, w);
  const warm = spy();
  const open = spy();
  const out = await quiet(() => start(env.plan, { critics: false }, { ...hooksOf(w, env.runsDir), warm: warm.fn, openDoor: open.fn }));
  assert.equal(warm.n, 0);
  assert.equal(open.n, 0);
  assert.match(out, /NOTHING CHANGED/);
  assert.doesNotMatch(out, /people \d+ (warm|cold)/);
});

test("a changed engine: the holder is asked at most its one list while the engine is hashed, never a mind, and everyone is sent fresh", async () => {
  const { env, w } = pair();
  await historyThenSpies(env, w);
  const asked = [];
  w.engine = "e2";
  const out = await startWith(env, w, { warm: async () => ({ door: (tool, body) => (asked.push(tool), w.people(tool, body)) }) });
  assert.deepEqual(
    asked.filter((tool) => tool !== "boardroom_personas_sue_list"),
    [],
  );
  assert.ok(asked.length <= 1);
  assert.deepEqual(w.started, NAMES);
  assert.match(out, /NO REUSE: the engine changed/);
});

/** A fake warm holder that answers the one identity call from the world: builds, the list, the critics' minds, the engine. */
function identityHolder(w, { engine = null } = {}) {
  const h = { asked: [], door: [], builds: 0 };
  h.door = async () => {
    throw new Error("the separate door call is not used when the identity call answers");
  };
  h.builds = async () => {
    throw new Error("the separate builds call is not used when the identity call answers");
  };
  h.identity = async (request) => {
    h.asked.push(request);
    return {
      builds: { builds: { "https://one.test/": w.version } },
      engine,
      list: Object.values(w.docs).map((doc) => ({ doc, updatedAt: "2026-01-01T00:00:00Z" })),
      minds: w.minds,
      listWhy: null,
    };
  };
  return h;
}

test("a warm holder that offers the identity call answers builds, people and minds in that one call, and the engine when the default is used", async () => {
  const env = setup();
  env.plan.critics = [{ persona: "doc", seat: "" }];
  const w = world();
  await startOf(env, w, { critics: true });
  const state = stateOf(env);
  for (const r of state.runs) {
    const sueDir = path.join(env.runsDir, r.runId, `sue-1-${r.name}`);
    mkdirSync(sueDir, { recursive: true });
    writeFileSync(
      path.join(sueDir, "trace.jsonl"),
      `${JSON.stringify({ tool: "look", pageText: "Unit complete" })}
`,
    );
    writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 5 }));
  }
  await reportOf(env, w);
  w.started.length = 0;
  w.calls.length = 0;
  const h = identityHolder(w, { engine: "e1" });
  // The real fetch and the real engine id are in use: a start that did not take them from the holder would reach the
  // network and hash the real engine, and could not match this round's "e1".
  const out = await quiet(() =>
    start(env.plan, { critics: true }, { run: w.run, fetch: globalThis.fetch, runsDir: env.runsDir, warm: async () => h }),
  );
  assert.match(out, /NOTHING CHANGED/);
  assert.match(out, /people \d+ warm/);
  assert.equal(h.asked.length, 1, "one local call");
  const [ask] = h.asked;
  assert.deepEqual(ask.builds, BUILDS);
  assert.equal(typeof ask.engine.checkout, "string");
  assert.deepEqual([...ask.people.ids].sort(), ["a", "b", "c", "doc"]);
  assert.deepEqual(ask.people.critics, ["doc"], "the run's critic is asked for beside the list");
  assert.deepEqual(w.calls, [], "no door call of its own");
  assert.deepEqual(w.started, []);
});

test("an injected engine id is never replaced by the holder's: no engine is asked for", async () => {
  const { env, w } = await settled();
  const h = identityHolder(w, { engine: "someone else's" });
  const out = await quiet(() =>
    start(
      env.plan,
      { critics: false },
      { run: w.run, fetch: globalThis.fetch, engineId: w.engineId, runsDir: env.runsDir, warm: async () => h },
    ),
  );
  assert.match(out, /NOTHING CHANGED/);
  assert.equal(h.asked[0].engine, null);
});

test("a holder whose engine answer is null (its code moved): the client hashes the engine itself", async () => {
  const { env, w } = await settled();
  const h = identityHolder(w, { engine: null });
  // The default engine id: with no engine from the holder this process hashes the real one, which is not this round's "e1".
  const out = await quiet(() =>
    start(env.plan, { critics: false }, { run: w.run, fetch: globalThis.fetch, runsDir: env.runsDir, warm: async () => h }),
  );
  assert.match(out, /NO REUSE: the engine changed/);
  assert.deepEqual(w.started, NAMES);
});
