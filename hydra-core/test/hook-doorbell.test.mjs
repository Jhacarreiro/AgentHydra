import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { run } from "../hook.mjs";

// `<core>/DOORBELL` holding `crainium`: the flowchart lives in the CrAInium, so the hook only tells the chat to walk it
// through connections_core, and keeps nothing on this PC. A PC without the file keeps the local tree (hook.test.mjs).

const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT", "AGENTHYDRA_ROLE"];
const FOLDER = "C:\\Users\\me\\project";

async function withDoorbell(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-doorbell-"));
  try {
    writeFileSync(path.join(dir, "ON"), "");
    writeFileSync(path.join(dir, "DOORBELL"), "crainium\n");
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function envFor(dir, extra = {}) {
  const env = { ...process.env, AGENTHYDRA_CORE_DIR: dir };
  for (const key of CLEARED) delete env[key];
  return { ...env, ...extra };
}

const turn = (prompt) => ({ hook_event_name: "UserPromptSubmit", session_id: "sess-1", prompt, cwd: FOLDER });
const told = (result) => result?.hookSpecificOutput?.additionalContext ?? null;

test("an owner message is told to walk the CrAInium flowchart for its chat and folder, and nothing is kept here", () =>
  withDoorbell(async (dir) => {
    const before = readdirSync(dir).sort();
    const text = told(await run(turn("ship the tray fix"), envFor(dir)));
    assert.match(text, /connections_core \{ action: "run", chat: "sess-1"/);
    assert.ok(text.includes(`folderPath: ${JSON.stringify(FOLDER)}`), text);
    assert.match(text, /answers/);
    assert.deepEqual(readdirSync(dir).sort(), before);
  }));

test("a command or a ping that is not the owner's rings nothing", () =>
  withDoorbell(async (dir) => {
    assert.equal(await run(turn("/compact"), envFor(dir)), null);
    assert.equal(await run(turn("<task-notification>done</task-notification>"), envFor(dir)), null);
  }));

test("after a compact the chat is told how to get its delegate brief back; a fresh start gets nothing", () =>
  withDoorbell(async (dir) => {
    const start = (source) => ({ hook_event_name: "SessionStart", session_id: "sess-1", source, cwd: FOLDER });
    assert.match(told(await run(start("compact"), envFor(dir))), /connections_core \{ action: "brief", chat: "sess-1"/);
    assert.equal(await run(start("startup"), envFor(dir)), null);
  }));

test("the local president rule stays out of it: a question at Stop is not blocked", () =>
  withDoorbell(async (dir) => {
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
  withDoorbell(async (dir) => {
    const before = readdirSync(dir).sort();
    assert.equal(await run(turn("move notes"), envFor(dir, { AGENTHYDRA_ROLE: "drone" })), null);
    assert.equal(await run(turn("what do you think?"), envFor(dir, { AGENTHYDRA_ROLE: "seat" })), null);
    assert.deepEqual(readdirSync(dir).sort(), before);
  }));
