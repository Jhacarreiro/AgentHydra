/**
 * run-dedupe.spec - a repeated launch returns the run already going, a page's live runs are capped, and a run whose
 * launcher is gone is recorded as abandoned (2026-10-13: 128 identical chat-brain waves on one page in 30 minutes).
 * Run: `node --test sue/tests/run-dedupe.spec.mjs`. The runner is stubbed; nothing spawns a browser or a brain.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { liveRuns, startRun } from "../sue.mjs";
import { stateRoot } from "../lib/run-dir.mjs";
import { installPeople } from "../lib/personas.mjs";

delete process.env.FAIRJOB_DIES_WITH_LAUNCHER;
installPeople([
  { doc: { id: "dedupe-one", displayName: "Dedupe One" }, builtIn: true },
  { doc: { id: "dedupe-two", displayName: "Dedupe Two" }, builtIn: true },
]);

const INTENT = "a friend posted this link in his WhatsApp deal group; you want to post your deals there";
const URL_ = "https://example.com/trial/dedupe";

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

test("a launch repeated while its run is still going returns that run and starts no second runner", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const counter = spawnCounter();
    const first = startRun({ workspace: ws, url: URL_, intent: INTENT, count: 1 }, counter);
    assert.equal(first.ok, true);
    const again = startRun({ workspace: ws, url: URL_, intent: INTENT, count: 1 }, counter);
    assert.equal(again.reused, true, "the repeat is marked as the run already going");
    assert.equal(again.runId, first.runId);
    assert.equal(counter.spawned.length, 1, "exactly one runner was spawned for two identical launches");
  } finally {
    undo();
  }
});

test("two inbox tests of different emails on the same page are two runs, not a repeat (2026-10-14: an A/B's variant 2 got variant 1's run)", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const counter = spawnCounter();
    const email = (subject) => ({ from: "Acme <news@acme.example>", subject, text: "Our autumn range is in.", audience: "cold" });
    const launch = (subject) =>
      startRun({ workspace: ws, url: URL_, intent: INTENT, count: 1, start: "inbox", arrival: email(subject) }, counter);
    const a = launch("Variant A");
    const b = launch("Variant B");
    assert.notEqual(b.reused, true, "a different email is a new run");
    assert.notEqual(b.runId, a.runId);
    assert.equal(launch("Variant A").reused, true, "the same email again is still the run already going");
    assert.equal(counter.spawned.length, 2);
  } finally {
    undo();
  }
});

test("a page can have only a few live runs at once, so a caller cannot queue an unbounded number on it", () => {
  const ws = tempDir("sue-ws-");
  const undo = withStores();
  try {
    const counter = spawnCounter();
    for (let n = 1; n <= 3; n += 1) {
      const out = startRun({ workspace: ws, url: URL_, intent: `${INTENT} (${n})`, count: 1 }, counter);
      assert.equal(out.ok, true);
    }
    assert.throws(() => startRun({ workspace: ws, url: URL_, intent: `${INTENT} (4)`, count: 1 }, counter), /already going on/);
    assert.equal(counter.spawned.length, 3, "the refused fourth launch spawned nothing");
  } finally {
    undo();
  }
});

test("a run whose launcher is gone is recorded as abandoned, not left running", () => {
  const undo = withStores();
  try {
    const runId = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 8) + "-120000-dead";
    const statusFile = path.join(stateRoot(), "mcp", `${runId}.status.json`);
    fs.mkdirSync(path.dirname(statusFile), { recursive: true });
    fs.writeFileSync(statusFile, JSON.stringify({ runId, state: "running", pid: 4000000 }));
    liveRuns();
    const status = JSON.parse(fs.readFileSync(statusFile, "utf8"));
    assert.equal(status.state, "abandoned");
    assert.ok(status.abandonedAt, "the abandonment is stamped");
  } finally {
    undo();
  }
});
