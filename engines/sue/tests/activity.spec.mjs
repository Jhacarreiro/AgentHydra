/**
 * activity.spec - the few words under each Sue on the page say what she is doing this moment:
 * working (and at what) while a move runs, thinking between moves, finished once her visit is written
 * up, stopped once her wave is over without her.
 * ================================================================================================
 *
 * WHAT: `node --test sue/tests/activity.spec.mjs` (or `bun test`). Her body's two writes a move
 * (lib/activity.mjs `moveStarted` / `moveEnded`, called from body.mjs `wrap`) go to a real folder,
 * and the Manager's `sueState` reads them back the way the page's poll does.
 *
 * WHY IT EXISTS: Owner, 2026-09-24: "I would love at the bottom if it said like working or finished
 * or something, but the AI is just sitting there."
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { doingWords, moveEnded, moveStarted } from "../lib/activity.mjs";
import { freshReads } from "../lib/state-cache.mjs";
import { sueState } from "../manager.mjs";

const SUE = "sue-5003-grandma";
const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function runDir() {
  const dir = fs.mkdtempSync(path.join(tmpdir(), "sue-activity-"));
  made.push(dir);
  fs.mkdirSync(path.join(dir, SUE));
  fs.writeFileSync(path.join(dir, SUE, "sue.json"), JSON.stringify({ sueId: SUE, persona: { id: "grandma" } }));
  return dir;
}

const running = { state: "running", finishedAt: null };
const activity = (dir, run = running) => sueState(dir, SUE, freshReads, run).activity;

test("across a move she reads working, at what in plain words, then thinking once it ends", () => {
  const dir = runDir();
  assert.deepEqual(activity(dir), { kind: "thinking", doing: null, since: null }, "before her first move she is thinking");

  moveStarted(path.join(dir, SUE), "click", new Date("2026-09-24T10:00:00.000Z"));
  assert.deepEqual(activity(dir), { kind: "working", doing: "Tapping", since: "2026-09-24T10:00:00.000Z" });

  moveEnded(path.join(dir, SUE), new Date("2026-09-24T10:00:03.000Z"));
  assert.deepEqual(activity(dir), { kind: "thinking", doing: null, since: "2026-09-24T10:00:03.000Z" });

  assert.deepEqual(
    fs.readdirSync(path.join(dir, SUE)).filter((n) => n.endsWith(".tmp")),
    [],
    "written whole: no half-file left beside it",
  );
});

test("her moves in plain words, and any other move is Working", () => {
  assert.equal(doingWords("type"), "Typing");
  assert.equal(doingWords("scroll"), "Scrolling");
  assert.equal(doingWords("look"), "Looking");
  assert.equal(doingWords("go_back"), "Going back");
  assert.equal(doingWords("go_to"), "Opening a page");
  assert.equal(doingWords("check_email"), "Checking her email");
  assert.equal(doingWords("say"), "Talking to the group");
  assert.equal(doingWords("something_new"), "Working");
  assert.equal(doingWords("constructor"), "Working", "never a word off the prototype");
});

test("finished once her visit is written up, whatever her last move said", () => {
  const dir = runDir();
  moveStarted(path.join(dir, SUE), "done");
  fs.writeFileSync(path.join(dir, SUE, "summary.json"), JSON.stringify({ outcome: "done", endedAt: "2026-09-24T10:05:00.000Z" }));
  assert.deepEqual(activity(dir), { kind: "finished", doing: null, since: "2026-09-24T10:05:00.000Z" });
  assert.equal(
    activity(dir, { state: "stopped", finishedAt: "2026-09-24T11:00:00.000Z" }).kind,
    "finished",
    "a finished Sue stays finished",
  );
});

test("stopped once her wave is over without her, and never while it runs", () => {
  const dir = runDir();
  moveStarted(path.join(dir, SUE), "type");
  const over = "2026-09-24T11:00:00.000Z";
  for (const state of ["stopped", "failed", "refused"])
    assert.deepEqual(activity(dir, { state, finishedAt: over }), { kind: "stopped", doing: null, since: over }, state);
  assert.equal(activity(dir, { state: null, finishedAt: over }).kind, "stopped", "a wave the cannon ran straight, finished");
  assert.equal(activity(dir, { state: "starting", finishedAt: null }).kind, "working");
  assert.equal(activity(dir).kind, "working");
});

test("her body's writes never throw into her move, even with nowhere to write", () => {
  const gone = path.join(tmpdir(), "sue-activity-never-made", SUE);
  assert.doesNotThrow(() => moveStarted(gone, "look"));
  assert.doesNotThrow(() => moveEnded(gone));
});
