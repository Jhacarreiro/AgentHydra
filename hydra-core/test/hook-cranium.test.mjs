import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { folderKey, run } from "../hook.mjs";

// A `<core>/CRANIUM` file: the flowchart lives in the CrAInium, so the hook only tells the chat to walk it through
// connections_core, and keeps nothing on this PC. It needs no `<core>/ON`: ON also turns on the daemon's local core
// mode (core chat prompt, CLAUDE.md excludes, manager tools refused), which a CRANIUM PC must not get. A PC without
// the file keeps the local tree (hook.test.mjs).

const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT", "AGENTHYDRA_ROLE"];
const FOLDER = "C:\\Users\\me\\project";

async function withCranium(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-cranium-"));
  try {
    writeFileSync(path.join(dir, "CRANIUM"), "");
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The cache and outbox default to files under the test's folder that are never created, so no test reads the real home.
function envFor(dir, extra = {}) {
  const env = {
    ...process.env,
    AGENTHYDRA_CORE_DIR: dir,
    AGENTHYDRA_CRANIUM_HEAD_FILE: path.join(dir, "io", "core-head.json"),
    AGENTHYDRA_CRANIUM_OUTBOX_FILE: path.join(dir, "io", "core-outbox.jsonl"),
  };
  for (const key of CLEARED) delete env[key];
  return { ...env, ...extra };
}

const turn = (prompt, cwd = FOLDER) => ({ hook_event_name: "UserPromptSubmit", session_id: "sess-1", prompt, cwd });
const told = (result) => result?.hookSpecificOutput?.additionalContext ?? null;
const fresh = () => new Date().toISOString();
const OK = {
  status: "ok",
  flow: "ship",
  version: 3,
  asks: [{ id: "tests", text: "Did the tests run?", answers: ["yes", "no"] }],
  exits: [{ answers: { tests: "yes" }, outcome: "Report and stop", say: "Tests passed." }],
};

// Writes a head file with the given folders and returns its path, for AGENTHYDRA_CRANIUM_HEAD_FILE.
function headOf(dir, folders) {
  const file = path.join(dir, "head.json");
  writeFileSync(file, JSON.stringify({ v: 1, folders }));
  return file;
}

test("an owner message is told to walk the CrAInium flowchart for its chat and folder, and nothing is kept here", () =>
  withCranium(async (dir) => {
    const before = readdirSync(dir).sort();
    const text = told(await run(turn("ship the tray fix"), envFor(dir)));
    assert.match(text, /connections_core \{ action: "run", chat: "sess-1"/);
    assert.ok(text.includes(`folderPath: ${JSON.stringify(FOLDER)}`), text);
    assert.match(text, /answers/);
    assert.deepEqual(readdirSync(dir).sort(), before);
  }));

test("a command or a ping that is not the owner's gets nothing", () =>
  withCranium(async (dir) => {
    assert.equal(await run(turn("/compact"), envFor(dir)), null);
    assert.equal(await run(turn("<task-notification>done</task-notification>"), envFor(dir)), null);
  }));

test("after a compact the chat is told how to get its delegate brief back; a fresh start gets nothing", () =>
  withCranium(async (dir) => {
    const start = (source) => ({ hook_event_name: "SessionStart", session_id: "sess-1", source, cwd: FOLDER });
    assert.match(told(await run(start("compact"), envFor(dir))), /connections_core \{ action: "brief", chat: "sess-1"/);
    assert.equal(await run(start("startup"), envFor(dir)), null);
  }));

test("the local president rule stays out of it: a question at Stop is not blocked", () =>
  withCranium(async (dir) => {
    mkdirSync(path.join(dir, "catalog"));
    writeFileSync(
      path.join(dir, "catalog", "hand-people.json"),
      JSON.stringify([{ kind: "person", tier: "owner", id: "person:owner-1" }]),
    );
    const transcript = path.join(dir, "t.jsonl");
    writeFileSync(
      transcript,
      [
        { message: { role: "user", content: "go" } },
        { message: { role: "assistant", content: [{ type: "text", text: "Which one should I ship?" }] } },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    const stop = { hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript, cwd: FOLDER };
    assert.equal(await run(stop, envFor(dir)), null);
  }));

test("a drone or a seat still gets nothing, and its skip is not kept here either", () =>
  withCranium(async (dir) => {
    const before = readdirSync(dir).sort();
    assert.equal(await run(turn("move notes"), envFor(dir, { AGENTHYDRA_ROLE: "drone" })), null);
    assert.equal(await run(turn("what do you think?"), envFor(dir, { AGENTHYDRA_ROLE: "seat" })), null);
    assert.deepEqual(readdirSync(dir).sort(), before);
  }));

test("a fresh ok entry for the folder is answered in the chat, with the walk only for the rest", () =>
  withCranium(async (dir) => {
    const head = headOf(dir, { [folderKey(FOLDER)]: { ...OK, readAt: fresh() } });
    const text = told(await run(turn("ship the tray fix"), envFor(dir, { AGENTHYDRA_CRANIUM_HEAD_FILE: head })));
    assert.match(text, /^Hydra Core \(flowchart v3\): answer these yourself/);
    assert.ok(text.includes("- tests: Did the tests run? (yes | no)"), text);
    assert.ok(text.includes("If your answers are tests yes: Report and stop. Tests passed."), text);
    assert.ok(text.includes(`connections_core { action: "run", chat: "sess-1", folderPath: ${JSON.stringify(FOLDER)}`), text);
    assert.ok(!text.includes("walk the workspace flowchart"), text);
  }));

test("a folder the workspace has no flowchart for gets nothing", () =>
  withCranium(async (dir) => {
    const head = headOf(dir, { [folderKey(FOLDER)]: { status: "none", flow: "ship", readAt: fresh() } });
    assert.equal(await run(turn("ship the tray fix"), envFor(dir, { AGENTHYDRA_CRANIUM_HEAD_FILE: head })), null);
  }));

test("an entry older than a day, or a malformed head file, gets the walk line", () =>
  withCranium(async (dir) => {
    const old = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const stale = headOf(dir, { [folderKey(FOLDER)]: { ...OK, readAt: old } });
    assert.match(told(await run(turn("ship"), envFor(dir, { AGENTHYDRA_CRANIUM_HEAD_FILE: stale }))), /walk the workspace flowchart/);
    const broken = path.join(dir, "broken.json");
    writeFileSync(broken, "{not json");
    assert.match(told(await run(turn("ship"), envFor(dir, { AGENTHYDRA_CRANIUM_HEAD_FILE: broken }))), /walk the workspace flowchart/);
  }));

test("folder keys match across backslashes, a trailing slash and a lowercased drive letter", () => {
  assert.equal(folderKey("C:\\Users\\Me\\Project\\"), "c:/users/me/project");
  assert.equal(folderKey("/home/me/project/"), "/home/me/project");
  return withCranium(async (dir) => {
    const head = headOf(dir, { "c:/users/me/project": { ...OK, readAt: fresh() } });
    const env = envFor(dir, { AGENTHYDRA_CRANIUM_HEAD_FILE: head });
    const text = told(await run(turn("ship", "C:/Users/me/project/"), env));
    assert.match(text, /^Hydra Core \(flowchart v3\)/);
  });
});

// A Stop whose last turn made one tool call of the given name and input.
function stopWith(dir, name, toolInput, extra = {}) {
  const transcript = path.join(dir, "t.jsonl");
  writeFileSync(
    transcript,
    [
      { message: { role: "user", content: "go" } },
      { message: { role: "assistant", content: [{ type: "tool_use", id: "t1", name, input: toolInput }] } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n"),
  );
  return { hook_event_name: "Stop", session_id: "sess-1", transcript_path: transcript, cwd: FOLDER, ...extra };
}

test("Stop keeps one outbox line per turn: a core walk, and a turn that handed work to a delegate", () =>
  withCranium(async (dir) => {
    const outbox = path.join(dir, "io", "core-outbox.jsonl");
    const walk = { tool_name: "connections_core", params: { action: "run" } };
    assert.equal(await run(stopWith(dir, "mcp__connections__connections_execute", walk), envFor(dir)), null);
    assert.equal(await run(stopWith(dir, "Agent", { prompt: "sweep" }), envFor(dir)), null);
    const [walked, delegated] = readFileSync(outbox, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(walked.called, true);
    assert.equal(walked.delegated, false);
    assert.equal(walked.chat, "sess-1");
    assert.equal(walked.folder, folderKey(FOLDER));
    assert.equal(delegated.called, false);
    assert.equal(delegated.delegated, true);
  }));

test("Stop with stop_hook_active true keeps no line", () =>
  withCranium(async (dir) => {
    await run(stopWith(dir, "Agent", {}, { stop_hook_active: true }), envFor(dir));
    assert.equal(existsSync(path.join(dir, "io", "core-outbox.jsonl")), false);
  }));
