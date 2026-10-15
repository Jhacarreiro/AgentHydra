/**
 * launched-by.spec - every run records who started it (its spec and first log line), a launch that is
 * answered with a run already going says who repeated it on that run's log, and a session id the environment
 * does not give is left out rather than guessed. Run: `node --test sue/tests/launched-by.spec.mjs`.
 * The runner is stubbed; nothing spawns a browser or a brain.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { startRun } from "../sue.mjs";
import { stateRoot } from "../lib/run-dir.mjs";
import { installPeople } from "../lib/personas.mjs";

delete process.env.FAIRJOB_DIES_WITH_LAUNCHER;
installPeople([
  { doc: { id: "launcher-one", displayName: "Launcher One" }, builtIn: true },
  { doc: { id: "launcher-two", displayName: "Launcher Two" }, builtIn: true },
]);

const here = path.dirname(fileURLToPath(import.meta.url));
// A run records the folder it was started from, so each launch here starts from its own workspace: the expected
// cwd is that fixture folder, whatever folder the runner was started in. The runner's folder comes back after.
function startingIn(dir, launch) {
  process.chdir(dir);
  try {
    return launch();
  } finally {
    process.chdir(here);
  }
}

const INTENT = "a friend posted this link in his WhatsApp deal group; you want to post your deals there";
const URL_ = "https://example.com/trial/launched-by";

const made = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

function withStores() {
  const home = tempDir("sue-home-");
  const store = tempDir("sue-store-");
  const prior = { home: process.env.SUE_HOME, store: process.env.SUE_ENGINE_STORE };
  process.env.SUE_HOME = home;
  process.env.SUE_ENGINE_STORE = store;
  return () => {
    if (prior.home === undefined) delete process.env.SUE_HOME;
    else process.env.SUE_HOME = prior.home;
    if (prior.store === undefined) delete process.env.SUE_ENGINE_STORE;
    else process.env.SUE_ENGINE_STORE = prior.store;
  };
}

function spawnCounter() {
  const spawned = [];
  return {
    spawned,
    spawnRunner: (exe, argv, options) => {
      spawned.push({ exe, argv, options });
      return { pid: 424242, unref() {} };
    },
    collect: () => {},
  };
}

const mcpFile = (runId, ext) => path.join(stateRoot(), "mcp", `${runId}.${ext}`);
const readSpec = (runId) => JSON.parse(fs.readFileSync(mcpFile(runId, "spec.json"), "utf8"));
const logLines = (runId) => fs.readFileSync(mcpFile(runId, "log"), "utf8").split("\n").filter(Boolean);

test("a run records its launcher on the spec and as its first log line", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const out = startingIn(ws, () =>
      startRun(
        { workspace: ws, url: URL_, intent: INTENT, count: 1 },
        { ...spawnCounter(), env: { CLAUDE_CODE_SESSION_ID: "launch-session-01" } },
      ),
    );
    assert.equal(out.ok, true);
    const cwd = fs.realpathSync.native(ws);
    const { launchedBy } = readSpec(out.runId);
    assert.deepEqual(launchedBy, { pid: process.pid, ppid: process.ppid, cwd, sessionId: "launch-session-01", via: "cli" });
    assert.equal(
      logLines(out.runId)[0],
      `[sue] launched by pid ${process.pid}, parent pid ${process.ppid}, session launch-session-01, via cli, in ${cwd}`,
    );
  } finally {
    undo();
  }
});

test("a launch with no session id in its environment records no session id", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const out = startRun({ workspace: ws, url: URL_, intent: INTENT, count: 1 }, { ...spawnCounter(), env: {} });
    const { launchedBy } = readSpec(out.runId);
    assert.equal("sessionId" in launchedBy, false, "no session id is guessed when the environment names none");
    assert.equal(launchedBy.pid, process.pid);
  } finally {
    undo();
  }
});

test("a repeated launch leaves who repeated it on the twin run's log, and the twin keeps its first launcher", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const counter = spawnCounter();
    const first = startRun(
      { workspace: ws, url: URL_, intent: INTENT, count: 1 },
      { ...counter, env: { CLAUDE_CODE_SESSION_ID: "first-session-01" } },
    );
    const again = startRun(
      { workspace: ws, url: URL_, intent: INTENT, count: 1 },
      { ...counter, env: { CLAUDE_CODE_SESSION_ID: "repeat-session-02" } },
    );
    assert.equal(again.reused, true);
    assert.equal(again.runId, first.runId);
    assert.equal(counter.spawned.length, 1, "the repeat started no second runner");
    assert.equal(readSpec(first.runId).launchedBy.sessionId, "first-session-01", "the twin keeps its first launcher");
    const last = logLines(first.runId).at(-1);
    assert.match(
      last,
      /^\[sue\] launch repeated by pid \d+, parent pid \d+, session repeat-session-02, via cli, in .+ at \d{4}-\d{2}-\d{2}T/,
    );
    assert.match(last, /nothing new started$/);
  } finally {
    undo();
  }
});

test("a launch through the MCP door records its route and chat beside the session", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const out = startingIn(ws, () =>
      startRun(
        { workspace: ws, url: URL_, intent: INTENT, count: 1 },
        {
          ...spawnCounter(),
          env: {
            CLAUDE_CODE_SESSION_ID: "shared-host-session-99",
            SUE_LAUNCHED_VIA: "mcp",
            SUE_LAUNCHED_SESSION: "mcp-session-01",
            SUE_LAUNCHED_CHAT: "chat-abc-7",
          },
        },
      ),
    );
    const cwd = fs.realpathSync.native(ws);
    const { launchedBy } = readSpec(out.runId);
    assert.deepEqual(launchedBy, {
      pid: process.pid,
      ppid: process.ppid,
      cwd,
      sessionId: "mcp-session-01",
      via: "mcp",
      chat: "chat-abc-7",
    });
    assert.match(logLines(out.runId)[0], /, session mcp-session-01, via mcp, chat chat-abc-7, in /);
  } finally {
    undo();
  }
});
