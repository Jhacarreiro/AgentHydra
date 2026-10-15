/**
 * engine-route.spec - a command that acts on a LIVE run is carried out by the engine that run was
 * started on, never by whichever engine the caller happens to be (sue.mjs routeLiveRun, lib/hand-move.mjs).
 * ==========================================================================================
 *
 * WHAT: a fake OLD snapshot in a temp engine store, whose `sue.mjs` and `lib/hand-move.mjs` are stubs that
 * write down how they were called. A live run started on it is stopped, spoken to (the CLI and the Sue
 * Manager's room) and moved through that snapshot; a run on this same snapshot, a dead one, one whose
 * snapshot is gone and one from before snapshots (no engine on its record) are handled here, as they
 * always were; and a command a snapshot was handed is never handed on again.
 *
 * WHY IT EXISTS: Owner, 2026-09-25: "someone starts a Sue on 1.14, you push 1.15, all the Sues keep
 * running on 1.14". A 1.15 CLI writing into a 1.14 run's room, or signalling its runner, would speak
 * 1.15's format to 1.14's code.
 *
 * Plain node (`node --test sue/tests/engine-route.spec.mjs`). SUE_HOME is a temp dir, and the
 * only processes started are node sleepers this spec kills itself.
 */
import "./fixtures/people.mjs";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-engine-route-"));
process.env.SUE_HOME = home;
const { dispatch, Refusal, routeLiveRun } = await import("../sue.mjs");
const { createManager, MANAGER_ORIGINS } = await import("../manager.mjs");
const { sendMove } = await import("../lib/hand-move.mjs");
const { openRoom, roomSnapshot } = await import("../lib/room.mjs");

const RUN = "20260925-090000-0114";
const ws = path.join(home, "workspace");
fs.mkdirSync(ws, { recursive: true });
const record = path.join(home, "old-engine-calls.jsonl");
/** The 1.14 CLI, told "wait for go", answers once this file exists, and refuses after 8 s without it. */
const go = path.join(home, "go");

/** The 1.14 snapshot as the store holds it, its CLI and its hands both stubs that say who answered. */
const OLD_ID = "0114011401140114";
const oldRoot = path.join(home, "store", OLD_ID);
fs.mkdirSync(path.join(oldRoot, "sue", "lib"), { recursive: true });
fs.writeFileSync(path.join(oldRoot, ".sue-engine.json"), JSON.stringify({ id: OLD_ID, checkout: home }));
fs.writeFileSync(
  path.join(oldRoot, "sue", "sue.mjs"),
  [
    'import fs from "node:fs";',
    `fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ argv: process.argv.slice(2), routed: process.env.SUE_ENGINE_ROUTED ?? null }) + "\\n");`,
    'const args = JSON.parse(process.argv[process.argv.indexOf("--json") + 1]);',
    'process.stderr.write("the 1.14 engine was here\\n");',
    'if (args.text === "refuse me") { process.stdout.write(JSON.stringify({ ok: false, error: "1.14 refused" }) + "\\n"); process.exit(1); }',
    `if (args.text === "wait for go") { const until = Date.now() + 8000; while (!fs.existsSync(${JSON.stringify(go)}) && Date.now() < until) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);`,
    "  if (!fs.existsSync(" +
      JSON.stringify(go) +
      ')) { process.stdout.write(JSON.stringify({ ok: false, error: "nobody said go" }) + "\\n"); process.exit(1); } }',
    'process.stdout.write(JSON.stringify({ ok: true, answeredBy: "1.14", runId: args.runId, line: { by: "host", text: args.text ?? null } }, null, 2) + "\\n");',
  ].join("\n"),
);
fs.writeFileSync(
  path.join(oldRoot, "sue", "lib", "hand-move.mjs"),
  [
    'import fs from "node:fs";',
    "export async function sendMove(move, options = {}) {",
    `  fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ move, routed: options.routed === true }) + "\\n");`,
    "  return { reached: true, text: `1.14 moved ${move.sueId}: ${move.tool}` };",
    "}",
  ].join("\n"),
);
const OLD = { id: OLD_ID, root: oldRoot, exe: process.execPath };

const sleepers = [];
/** A process that stays up, so a run's runner pid is a live one. */
function sleeper() {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 600000)"], { windowsHide: true, stdio: "ignore" });
  sleepers.push(child);
  return child;
}

after(() => {
  for (const child of sleepers) if (child.exitCode === null) child.kill();
  fs.rmSync(home, { recursive: true, force: true });
});

function writeStatus(status) {
  const dir = path.join(home, "state", "mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${RUN}.status.json`), JSON.stringify({ runId: RUN, startedAt: new Date().toISOString(), ...status }));
}

function calls() {
  try {
    return fs
      .readFileSync(record, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

const runDir = path.join(home, "runs", RUN);
openRoom(runDir, { url: "https://shop.example.test/", intent: "A friend sent the link in the family group." });

test("a live run on another engine is stopped by that engine, which kills nothing here", () => {
  const runner = sleeper();
  writeStatus({ state: "running", pid: runner.pid, engine: OLD });
  const before = calls().length;
  const out = dispatch("stop", { workspace: ws, runId: RUN });
  assert.equal(out.answeredBy, "1.14");
  const call = calls().slice(before);
  assert.equal(call.length, 1, "the old engine's CLI ran once");
  assert.equal(call[0].argv[0], "stop");
  assert.equal(call[0].argv[call[0].argv.indexOf("--workspace") + 1], ws);
  assert.equal(JSON.parse(call[0].argv[call[0].argv.indexOf("--json") + 1]).runId, RUN);
  assert.equal(call[0].routed, "1", "the snapshot is told it was handed the command, so it never hands it on");
  assert.equal(runner.exitCode, null, "this engine never signalled the runner itself");
  assert.doesNotThrow(() => process.kill(runner.pid, 0));
});

test("the host's words reach a live focus group through its own engine, and its refusal is the caller's", () => {
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  const before = calls().length;
  const out = dispatch("room_say", { workspace: ws, runId: RUN, text: "Is the price the problem?" });
  assert.equal(out.answeredBy, "1.14");
  assert.equal(JSON.parse(calls()[before].argv.at(-1)).text, "Is the price the problem?");
  assert.equal(
    roomSnapshot(runDir).lines.some((l) => l.text === "Is the price the problem?"),
    false,
    "nothing was written into the 1.14 room by this engine",
  );
  assert.throws(
    () => dispatch("room_say", { workspace: ws, runId: RUN, text: "refuse me" }),
    (err) => err instanceof Refusal && /1\.14 refused/.test(err.message),
  );
});

test("the Sue Manager's room speaks through the run's own engine too", async () => {
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  const server = createManager({ port: 0, runsDir: path.join(home, "runs"), workspaces: () => [], tray: () => false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    const before = calls().length;
    const answer = await new Promise((resolve, reject) => {
      const body = JSON.stringify({ text: "What would make you stay?" });
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method: "POST",
          path: `/api/runs/${RUN}/room`,
          headers: { host: `127.0.0.1:${port}`, origin: MANAGER_ORIGINS[0], "content-type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw || "null") }));
        },
      );
      req.on("error", reject);
      req.end(body);
    });
    assert.equal(answer.status, 200);
    assert.equal(answer.json.line.text, "What would make you stay?");
    assert.equal(calls()[before]?.argv[0], "room_say", "the 1.14 engine's own sue room_say carried it");
    assert.equal(
      roomSnapshot(runDir).lines.some((l) => l.text === "What would make you stay?"),
      false,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// A node start takes seconds on the owner's loaded PC: a Manager that waited for the run's own snapshot
// in-line would stop answering its page for that long.
test("the Sue Manager keeps answering while a run's own engine carries the host's words", async () => {
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  const server = createManager({ port: 0, runsDir: path.join(home, "runs"), workspaces: () => [], tray: () => false });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const ask = (method, pathname, body) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: "127.0.0.1",
          port,
          method,
          path: pathname,
          headers: { host: `127.0.0.1:${port}`, origin: MANAGER_ORIGINS[0], "content-type": "application/json" },
        },
        (res) => {
          let raw = "";
          res.on("data", (c) => (raw += c));
          res.on("end", () => resolve({ status: res.statusCode, json: JSON.parse(raw || "null") }));
        },
      );
      req.on("error", reject);
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  try {
    fs.rmSync(go, { force: true });
    const before = calls().length;
    const said = ask("POST", `/api/runs/${RUN}/room`, { text: "wait for go" });
    while (calls().length === before) await new Promise((resolve) => setTimeout(resolve, 50));
    // The 1.14 engine is working on it now: the Manager still answers anything else at once.
    const asked = Date.now();
    assert.equal((await ask("GET", "/api/no-such-thing")).status, 404);
    assert.ok(Date.now() - asked < 2000, `the Manager answered after ${Date.now() - asked} ms`);
    fs.writeFileSync(go, "");
    const answer = await said;
    assert.equal(answer.status, 200, JSON.stringify(answer.json));
    assert.equal(answer.json.line.text, "wait for go");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a move for a live run goes through that run's own hands", async () => {
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  const before = calls().length;
  const out = await sendMove({ runId: RUN, sueId: "sue-1117-dana", tool: "look", args: {}, raw: true }, { home });
  assert.deepEqual(out, { reached: true, text: "1.14 moved sue-1117-dana: look" });
  assert.equal(calls()[before].routed, true, "the old engine's hands are told not to route it again");
});

test("same engine, dead, gone and pre-store runs are handled here, as they always were", async () => {
  // The same engine as the caller: nothing to route.
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  assert.equal(routeLiveRun("stop", { workspace: ws, runId: RUN }, { self: OLD }), null);
  // Its snapshot is gone (the store collected it): there is nothing left to run it with.
  writeStatus({ state: "running", pid: sleeper().pid, engine: { ...OLD, root: path.join(home, "store", "0000000000000000") } });
  assert.equal(routeLiveRun("stop", { workspace: ws, runId: RUN }), null);
  // A command that only reads is never routed.
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  assert.equal(routeLiveRun("status", { workspace: ws, runId: RUN }), null);

  const before = calls().length;
  // Dead: its runner's pid is no process any more.
  const gone = spawn(process.execPath, ["-e", ""], { windowsHide: true, stdio: "ignore" });
  await new Promise((resolve) => gone.once("exit", resolve));
  writeStatus({ state: "running", pid: gone.pid, engine: OLD });
  assert.deepEqual(dispatch("stop", { workspace: ws, runId: RUN }), {
    ok: true,
    runId: RUN,
    stopped: false,
    why: "that run is not running",
  });
  // Finished: its record says so.
  writeStatus({ state: "finished", pid: sleeper().pid, engine: OLD });
  assert.equal(dispatch("stop", { workspace: ws, runId: RUN }).stopped, false);
  // From before the store: no engine on its record, so the host's words are written here.
  writeStatus({ state: "running", pid: sleeper().pid });
  const said = dispatch("room_say", { workspace: ws, runId: RUN, text: "Thanks, everyone." });
  assert.equal(said.line.text, "Thanks, everyone.");
  assert.ok(roomSnapshot(runDir).lines.some((l) => l.text === "Thanks, everyone."));
  const moved = await sendMove({ runId: RUN, sueId: "sue-1117-dana", tool: "look", args: {}, raw: true }, { home });
  assert.equal(moved.reached, false, "no relay here, and none asked of another engine");
  assert.equal(calls().length, before, "the 1.14 engine was never asked");
});

test("a command a snapshot was handed is carried out there, never handed on again", () => {
  writeStatus({ state: "running", pid: sleeper().pid, engine: OLD });
  const before = calls().length;
  process.env.SUE_ENGINE_ROUTED = "1";
  try {
    assert.equal(routeLiveRun("stop", { workspace: ws, runId: RUN }), null, "no route out of a routed command");
    const said = dispatch("room_say", { workspace: ws, runId: RUN, text: "Said where it was handed." });
    assert.equal(said.line.text, "Said where it was handed.");
  } finally {
    delete process.env.SUE_ENGINE_ROUTED;
  }
  assert.equal(calls().length, before, "the 1.14 snapshot was never asked");
});
