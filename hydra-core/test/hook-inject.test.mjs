import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { PACK_TIMEOUT_MS, run } from "../hook.mjs";

const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT"];
const UNREACHABLE = "http://127.0.0.1:1";

async function withCore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-inject-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function withDaemon(reply, fn) {
  const calls = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      calls.push({ url: req.url, method: req.method, body: JSON.parse(body) });
      reply(res);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await fn(`http://127.0.0.1:${server.address().port}`, calls);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function envFor(dir, daemon, extra = {}) {
  const env = { ...process.env, AGENTHYDRA_CORE_DIR: dir, AGENTHYDRA_DAEMON_URL: daemon };
  for (const key of CLEARED) delete env[key];
  return { ...env, ...extra };
}

const json = (status, body) => (res) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const turn = (prompt, extra = {}) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: "sess-1",
  prompt,
  cwd: "C:/Users/me/project",
  ...extra,
});

function switchOn(dir, inject = "ON") {
  writeFileSync(path.join(dir, "ON"), "");
  writeFileSync(path.join(dir, "INJECT"), inject);
}

test("INJECT on: the first message gets the daemon's pack and no core_scope line", () =>
  withCore((dir) =>
    withDaemon(json(200, { mode: "first", text: "Hydra Core attached for this chat and message:\n\nRULE TEXT", ids: ["knowledge:x"], bytes: 60, ms: 4 }), async (daemon, calls) => {
      switchOn(dir);
      const out = await run(turn("hello there"), envFor(dir, daemon));
      assert.equal(out.hookSpecificOutput.hookEventName, "UserPromptSubmit");
      assert.equal(out.hookSpecificOutput.additionalContext, "Hydra Core attached for this chat and message:\n\nRULE TEXT");
      assert.doesNotMatch(out.hookSpecificOutput.additionalContext, /core_scope/);
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, "/api/core/pack");
      assert.equal(calls[0].method, "POST");
      assert.deepEqual(calls[0].body, { chat: "sess-1", session: "sess-1", cwd: "C:/Users/me/project", prompt: "hello there" });
      assert.equal(readFileSync(path.join(dir, "chats", "sess-1", "prompt.txt"), "utf8"), "hello there");
    }),
  ));

test("INJECT on: an empty pack for a repeated message injects nothing and still writes the chat files", () =>
  withCore((dir) =>
    withDaemon(json(200, { mode: "delta", text: "", ids: [], bytes: 0, ms: 2 }), async (daemon, calls) => {
      switchOn(dir);
      assert.equal(await run(turn("again"), envFor(dir, daemon)), null);
      assert.equal(calls.length, 1);
      assert.equal(existsSync(path.join(dir, "chats", "sess-1", "cwd.txt")), true);
    }),
  ));

test("INJECT on: a slash command asks the daemon for nothing", () =>
  withCore((dir) =>
    withDaemon(json(200, { text: "x" }), async (daemon, calls) => {
      switchOn(dir);
      assert.equal(await run(turn("  /clear"), envFor(dir, daemon)), null);
      assert.equal(calls.length, 0);
    }),
  ));

test("INJECT on: when the daemon is down the message gets today's core_scope line and the error", () =>
  withCore(async (dir) => {
    switchOn(dir);
    const text = (await run(turn("hello"), envFor(dir, UNREACHABLE))).hookSpecificOutput.additionalContext;
    assert.match(text, /core_scope \{ chat: "sess-1" \}/);
    assert.match(text, /Hydra Core pack unavailable: /);
  }));

test("INJECT on: a daemon error reply falls back to the core_scope line and names the error", () =>
  withCore((dir) =>
    withDaemon(json(500, { error: "boom" }), async (daemon) => {
      switchOn(dir);
      const text = (await run(turn("hello"), envFor(dir, daemon))).hookSpecificOutput.additionalContext;
      assert.match(text, /core_scope \{ chat: "sess-1" \}/);
      assert.match(text, /Hydra Core pack unavailable: boom/);
    }),
  ));

test("INJECT on: a pack slower than the timeout falls back instead of blocking the message", { timeout: 20_000 }, () =>
  withCore((dir) =>
    withDaemon(() => {}, async (daemon) => {
      switchOn(dir);
      const started = Date.now();
      const text = (await run(turn("hello"), envFor(dir, daemon))).hookSpecificOutput.additionalContext;
      const took = Date.now() - started;
      assert.match(text, /core_scope \{ chat: "sess-1" \}/);
      assert.match(text, /Hydra Core pack unavailable: /);
      assert.ok(took < PACK_TIMEOUT_MS + 2000, `took ${took} ms`);
    }),
  ));

test("INJECT on: SessionStart after a compact asks for the full pack", () =>
  withCore((dir) =>
    withDaemon(json(200, { mode: "full", text: "Hydra Core attached: FULL", ids: [], bytes: 25, ms: 3 }), async (daemon, calls) => {
      switchOn(dir);
      const out = await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "compact", cwd: "C:/Users/me/project" }, envFor(dir, daemon));
      assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
      assert.equal(out.hookSpecificOutput.additionalContext, "Hydra Core attached: FULL");
      assert.equal(calls[0].body.full, true);
    }),
  ));

test("INJECT on: a SessionStart on a fresh startup injects nothing and asks nothing", () =>
  withCore((dir) =>
    withDaemon(json(200, { text: "x" }), async (daemon, calls) => {
      switchOn(dir);
      assert.equal(await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "startup" }, envFor(dir, daemon)), null);
      assert.equal(calls.length, 0);
    }),
  ));

test("INJECT on: a SessionStart resume injects nothing and asks nothing (the session still holds its packs)", () =>
  withCore((dir) =>
    withDaemon(json(200, { text: "x" }), async (daemon, calls) => {
      switchOn(dir);
      assert.equal(await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "resume" }, envFor(dir, daemon)), null);
      assert.equal(calls.length, 0);
    }),
  ));

test("INJECT on: a failed SessionStart compact keeps hydra.md and names the error", () =>
  withCore(async (dir) => {
    switchOn(dir);
    const chat = path.join(dir, "chats", "sess-1");
    mkdirSync(chat, { recursive: true });
    writeFileSync(path.join(chat, "hydra.md"), "# hydra.md\nUpdated: x  Tier: 2\n## Lead (become)\nnone\n## Plan\nKEEP THIS PLAN\n");
    const text = (await run({ hook_event_name: "SessionStart", session_id: "sess-1", source: "compact" }, envFor(dir, UNREACHABLE))).hookSpecificOutput.additionalContext;
    assert.match(text, /KEEP THIS PLAN/);
    assert.match(text, /Hydra Core pack unavailable: /);
  }));

test("INJECT file not containing ON leaves today's behaviour and asks the daemon nothing", () =>
  withCore((dir) =>
    withDaemon(json(200, { text: "x" }), async (daemon, calls) => {
      switchOn(dir, "OFF");
      const text = (await run(turn("hello"), envFor(dir, daemon))).hookSpecificOutput.additionalContext;
      assert.match(text, /core_scope \{ chat: "sess-1" \}/);
      assert.equal(calls.length, 0);
    }),
  ));

test("no INJECT file leaves today's behaviour and asks the daemon nothing", () =>
  withCore((dir) =>
    withDaemon(json(200, { text: "x" }), async (daemon, calls) => {
      writeFileSync(path.join(dir, "ON"), "");
      const text = (await run(turn("hello"), envFor(dir, daemon))).hookSpecificOutput.additionalContext;
      assert.match(text, /core_scope \{ chat: "sess-1" \}/);
      assert.equal(calls.length, 0);
    }),
  ));
