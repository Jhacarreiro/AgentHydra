/**
 * window-lock-race.spec - the 'one window' lock is claimed in one step, not read-then-written
 * (lib/watch-window.mjs, finding sue-run-window-lock-race).
 *
 * The lock IS window-opened.json: claimWindowOpened() creates it with fs.openSync(..., "wx"), so
 * two `sue run` calls racing in the gap before a window opens cannot both read "no window" and both
 * open one. Freshness is the file's mtime, not its contents, and a claim older than WINDOW_OPENED_MS
 * is taken over. Plain node, no browser, no server, no network:
 * `node --test sue/tests/window-lock-race.spec.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(tmpdir(), "sue-window-lock-"));
process.env.SUE_HOME = home;
const { WINDOW_OPENED_MS, claimWindowOpened, windowOpen } = await import("../lib/watch-window.mjs");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const openedFile = path.join(home, "state", "manager", "window-opened.json");

test("the claim is one synchronous step: the first caller wins, the second is refused", () => {
  fs.rmSync(openedFile, { force: true });
  const first = claimWindowOpened();
  assert.equal(typeof first, "boolean", "the claim answers in one step, with no promise to resolve");
  assert.equal(first, true, "an unclaimed lock is claimed");
  assert.equal(claimWindowOpened(), false, "a second claim against a live window opens nothing");
  const written = JSON.parse(fs.readFileSync(openedFile, "utf8"));
  assert.equal(typeof written.at, "number", "the claim writes the window's time");
  assert.equal(windowOpen(), true, "the claimed file is the window the old reader looked for");
});

test("a claim created but not yet written still holds the lock: freshness is the file, not its contents", () => {
  fs.rmSync(openedFile, { force: true });
  fs.mkdirSync(path.dirname(openedFile), { recursive: true });
  // A racing claimer that has created the lock (openSync's 'wx') but not written it yet: an empty
  // file with a fresh mtime. Reading its contents as windowOpen() would say "no window"; the lock
  // must not, or the two callers both open one.
  fs.writeFileSync(openedFile, "");
  assert.equal(windowOpen(), false, "an unwritten claim has no readable time");
  assert.equal(claimWindowOpened(), false, "a fresh, unwritten claim still holds the lock");
});

test("a claim older than the window is a window long gone and is taken over", () => {
  fs.rmSync(openedFile, { force: true });
  fs.mkdirSync(path.dirname(openedFile), { recursive: true });
  fs.writeFileSync(openedFile, JSON.stringify({ at: Date.now() - WINDOW_OPENED_MS - 1 }));
  const stale = new Date(Date.now() - WINDOW_OPENED_MS - 1);
  fs.utimesSync(openedFile, stale, stale);
  assert.equal(windowOpen(), false, "a window from long ago is not on screen");
  assert.equal(claimWindowOpened(), true, "a stale lock is broken and claimed");
  assert.equal(claimWindowOpened(), false, "the takeover then holds the lock against the next caller");
});
