// round.mjs start: runs start in a bounded wave (SUE_START_PARALLEL, default 4), and the saved round keeps the plan's order.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { start, stateFileOf } from "../round.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "sue-round-start-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

// No AgentHydra here: CliMayte is declared down, so start() does not spend its 12 s of readiness retries per call.
const noClimayte = async () => ({ ready: false, why: "no AgentHydra in this spec" });

const NAMES = ["a", "b", "c", "d", "e", "f", "g", "h"];

function planOf() {
  const dir = mkdtempSync(path.join(ROOT, "plan-"));
  return {
    file: path.join(dir, "plan.json"),
    series: "wave",
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    demo: "http://localhost:1/",
    intent: "try it",
    students: NAMES.map((persona) => ({ persona, seat: "" })),
  };
}

/** A stand-in for `sue` that answers after `ms`, counts how many are in flight, and fails the personas in `fail`. */
function standIn({ ms = 30, fail = [] } = {}) {
  const seen = { inFlight: 0, most: 0 };
  const run = async (_action, args) => {
    seen.inFlight += 1;
    seen.most = Math.max(seen.most, seen.inFlight);
    await new Promise((r) => setTimeout(r, ms));
    seen.inFlight -= 1;
    const who = args.personas[0];
    return fail.includes(who) ? { ok: false, error: `no body for ${who}` } : { ok: true, runId: `run-${who}` };
  };
  return { run, seen };
}

async function started(env, stub) {
  const old = process.env.SUE_START_PARALLEL;
  if (env === undefined) delete process.env.SUE_START_PARALLEL;
  else process.env.SUE_START_PARALLEL = env;
  const plan = planOf();
  const log = console.log;
  console.log = () => {};
  try {
    await start(plan, { critics: false }, { run: stub.run, climayte: noClimayte });
  } finally {
    console.log = log;
    if (old === undefined) delete process.env.SUE_START_PARALLEL;
    else process.env.SUE_START_PARALLEL = old;
  }
  return JSON.parse(readFileSync(stateFileOf(plan, {}), "utf8"));
}

test("eight runs start four at a time, and the saved round keeps the plan's order", async () => {
  const stub = standIn();
  const state = await started(undefined, stub);
  assert.equal(stub.seen.most, 4);
  assert.deepEqual(
    state.runs.map((r) => [r.name, r.runId]),
    NAMES.map((n) => [n, `run-${n}`]),
  );
});

test("SUE_START_PARALLEL=1 starts them one at a time", async () => {
  const stub = standIn({ ms: 5 });
  await started("1", stub);
  assert.equal(stub.seen.most, 1);
});

test("a run that fails to start carries its error and the others still start", async () => {
  const stub = standIn({ fail: ["c"] });
  const state = await started(undefined, stub);
  assert.equal(state.runs.length, 8);
  assert.equal(state.runs[2].runId, undefined);
  assert.match(state.runs[2].error, /no body for c/);
  assert.deepEqual(
    state.runs.filter((r) => r.runId).map((r) => r.name),
    NAMES.filter((n) => n !== "c"),
  );
});

/** A stand-in whose runs answer with a brain-list path; `files` says what each run's runner does about it. */
async function withBrains(files, { n = 2 } = {}) {
  const home = mkdtempSync(path.join(ROOT, "home-"));
  const oldHome = process.env.SUE_HOME;
  process.env.SUE_HOME = home;
  const names = NAMES.slice(0, n);
  const plan = { ...planOf(), students: names.map((persona) => ({ persona, seat: "" })) };
  const run = async (_action, args) => {
    const who = args.personas[0];
    const chatBrains = path.join(home, `${who}.chat-brains.json`);
    const how = files[who];
    if (how?.refused) {
      mkdirSync(path.join(home, "state", "mcp"), { recursive: true });
      writeFileSync(
        path.join(home, "state", "mcp", `run-${who}.status.json`),
        JSON.stringify({ state: "refused", why: ["[cannon] REFUSING to start: no room", "second line"], cannonExit: 2 }),
      );
    } else if (how?.afterMs) {
      setTimeout(
        () => writeFileSync(chatBrains, JSON.stringify([{ id: `s-${who}`, role: "student", persona: who, brief: `b-${who}` }])),
        how.afterMs,
      );
    }
    return { ok: true, runId: `run-${who}`, chatBrains };
  };
  const log = console.log;
  const lines = [];
  console.log = (...a) => lines.push(a.join(" "));
  const t0 = Date.now();
  try {
    await start(plan, { critics: false }, { run, climayte: noClimayte });
  } finally {
    console.log = log;
    if (oldHome === undefined) delete process.env.SUE_HOME;
    else process.env.SUE_HOME = oldHome;
  }
  const state = JSON.parse(readFileSync(stateFileOf(plan, {}), "utf8"));
  return { state, lines: lines.join("\n"), ms: Date.now() - t0 };
}

test("a run whose cannon refused is reported FAILED with its reason at once, and is not counted as started", async () => {
  const { state, lines, ms } = await withBrains({ a: { afterMs: 50 }, b: { refused: true } });
  assert.ok(ms < 20000, `took ${ms} ms`);
  assert.match(state.runs[1].error, /REFUSING to start: no room; second line/);
  assert.deepEqual(
    state.runs[0].briefs.map((b) => b.brief),
    ["b-a"],
  );
  assert.match(lines, /FAILED b: \[cannon\] REFUSING to start: no room; second line/);
  assert.match(lines, /1 of 2 runs started/);
});

test("the briefs of all runs are awaited side by side, in plan order", async () => {
  // Two runners that never write a list: waited on one after another the round costs two waits, side by side one.
  const old = process.env.SUE_BRIEFS_WAIT_MS;
  process.env.SUE_BRIEFS_WAIT_MS = "1500";
  try {
    const { ms } = await withBrains({});
    assert.ok(ms < 2400, `took ${ms} ms: the runs were waited on one after another`);
    const slow = await withBrains({ a: { afterMs: 700 }, b: { afterMs: 300 } });
    assert.deepEqual(
      slow.state.runs.map((r) => r.briefs[0].brief),
      ["b-a", "b-b"],
    );
  } finally {
    if (old === undefined) delete process.env.SUE_BRIEFS_WAIT_MS;
    else process.env.SUE_BRIEFS_WAIT_MS = old;
  }
});

/** The specs a stand-in `sue` is handed, by persona, for a plan. */
async function specsFor(plan, opts = { critics: false }) {
  const specs = {};
  const run = async (_action, args) => {
    specs[args.personas[0]] = args;
    return { ok: true, runId: `run-${args.personas[0]}` };
  };
  const log = console.log;
  console.log = () => {};
  try {
    await start(plan, opts, { run, climayte: noClimayte });
  } finally {
    console.log = log;
  }
  return specs;
}

test("a plan's expect reaches each run's spec in that run's language", async () => {
  const plan = {
    ...planOf(),
    expect: { en: "a lesson on using AI safely", es: "una leccion sobre usar la IA con seguridad" },
    students: [
      { persona: "a", seat: "" },
      { persona: "b", seat: "", lang: "es" },
    ],
  };
  const specs = await specsFor(plan);
  assert.equal(specs.a.expect, "a lesson on using AI safely");
  assert.equal(specs.b.expect, "una leccion sobre usar la IA con seguridad");
  const one = await specsFor({ ...planOf(), expect: "a five-question lesson", students: [{ persona: "a", seat: "" }] });
  assert.equal(one.a.expect, "a five-question lesson");
});

test("a plan without an expect sends no expect key at all", async () => {
  const specs = await specsFor({ ...planOf(), students: [{ persona: "a", seat: "" }] });
  assert.equal("expect" in specs.a, false);
});

// A round whose visitors make no account needs no mailroom: without the plan's word every run was sent as making one,
// and a PC whose AWS sign-in had lapsed refused all twelve runs of the Reel Buddy wait A/B (2026-10-09).
test("a plan's createAccounts false reaches every run, and a plan without it sends no key", async () => {
  const off = await specsFor({ ...planOf(), createAccounts: false, students: [{ persona: "a", seat: "" }] });
  assert.equal(off.a.createAccounts, false);
  const plain = await specsFor({ ...planOf(), students: [{ persona: "a", seat: "" }] });
  assert.equal("createAccounts" in plain.a, false);
});

test("a reference round carries the reference block's own expect, and teachers their own", async () => {
  const base = { ...planOf(), expect: "the plan-level line", students: [{ persona: "a", seat: "" }] };
  const ref = await specsFor(
    { ...base, reference: { url: "http://localhost:1/ref", series: "ref", intent: "try it", expect: "a word puzzle game" } },
    { critics: false, reference: true },
  );
  assert.equal(ref.a.expect, "a word puzzle game");
  const teachers = await specsFor(
    { ...base, teachers: { seat: "", personas: ["t"], intent: "check the class page" } },
    { critics: false, teachers: true },
  );
  assert.equal(teachers.t.expect, "the plan-level line");
});
