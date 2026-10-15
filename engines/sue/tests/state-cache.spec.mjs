/**
 * state-cache.spec - the Manager's poll answers exactly what a fresh read of every Sue's files would,
 * while reading only what changed since the last poll.
 * ==================================================================================================
 *
 * WHAT: `bun test ./sue/tests/state-cache.spec.mjs` (or `node --test`). Builds a run folder on
 * disk, asks `sueState` through a cache the way the Manager's 2 s poll does, changes the Sues' files
 * (a trace grows, a line lands half-written and is then finished, a picture and a letter arrive, a
 * summary is written, a trace is cut short or rewritten) and after every change compares the cached
 * answer with the same question put through `freshReads`, the uncached reads the Manager used to do.
 *
 * WHY IT EXISTS: the Studio page polls every 2 s while a run is live, and every poll used to re-read
 * each Sue's sue.json, summary, interview, pictures folder and her WHOLE trace.jsonl. With hundreds of
 * Sues and long traces the Manager itself became the hog (Sue at scale, fix 5, 2026-09-24). Caching is
 * only safe if it never changes an answer, so every case here is checked against the uncached one.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createStateCache, freshReads } from "../lib/state-cache.mjs";
import { sueState } from "../manager.mjs";

const made = [];
afterEach(() => {
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A clock well past every file's own time, so a hit is decided by the file's key alone. */
const LATER = () => Date.now() + 60_000;

function runFolder(sues = ["sue-1-ann", "sue-2-bob", "sue-3-cy"]) {
  const runDir = fs.mkdtempSync(path.join(tmpdir(), "sue-state-cache-"));
  made.push(runDir);
  sues.forEach((id, i) => {
    const dir = path.join(runDir, id);
    fs.mkdirSync(path.join(dir, "shots"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "sue.json"),
      JSON.stringify({
        persona: { id: `p${i}`, displayName: `Person ${i}`, dials: { device: i ? "desktop" : "phone" } },
        errand: "sign up",
        identity: { email: `${id}@mail.test` },
      }),
    );
    fs.writeFileSync(path.join(dir, "shots", "look-0001.jpg"), "jpeg");
    fs.writeFileSync(path.join(dir, "trace.jsonl"), traceLines(i * 3, 5));
    fs.writeFileSync(path.join(dir, "findings.jsonl"), `${JSON.stringify({ kind: "note", text: "hm" })}\n`);
  });
  return { runDir, sues };
}

function traceLines(from, n) {
  let out = "";
  for (let k = from; k < from + n; k++) out += `${JSON.stringify({ tool: `tool-${k}`, url: `https://site.test/page/${k}`, ok: true })}\n`;
  return out;
}

function poll(runDir, sues, reads) {
  return sues.map((id) => sueState(runDir, id, reads));
}

function assertSame(cache, runDir, sues, why) {
  assert.deepEqual(poll(runDir, sues, cache.reads(runDir)), poll(runDir, sues, freshReads), why);
}

// The real clock: these changes land milliseconds apart, often inside one tick of the file clock, where
// only the cache's racy-file rule (lib/state-cache.mjs) keeps the answers right.
test("every poll answers what a fresh read would, as the Sues keep writing", () => {
  const { runDir, sues } = runFolder();
  const cache = createStateCache();
  const trace = path.join(runDir, sues[0], "trace.jsonl");
  assertSame(cache, runDir, sues, "the first poll");
  assertSame(cache, runDir, sues, "a poll with nothing changed");

  fs.appendFileSync(trace, traceLines(100, 3));
  assertSame(cache, runDir, sues, "her trace grew");

  // A line being appended right now: half of it, then the rest.
  const line = JSON.stringify({ tool: "click", url: "https://site.test/half" });
  fs.appendFileSync(trace, line.slice(0, 12));
  assertSame(cache, runDir, sues, "half a line is not her last step yet");
  fs.appendFileSync(trace, `${line.slice(12)}\n`);
  assertSame(cache, runDir, sues, "the line finished");
  // A whole line that has not got its newline yet already counts, as it always did.
  fs.appendFileSync(trace, JSON.stringify({ tool: "type", url: "https://site.test/typed" }));
  assertSame(cache, runDir, sues, "a whole last line with no newline");
  fs.appendFileSync(trace, "\n\n  \n");
  assertSame(cache, runDir, sues, "blank lines");

  fs.writeFileSync(path.join(runDir, sues[1], "shots", "look-0002.jpg"), "jpeg");
  fs.writeFileSync(path.join(runDir, sues[1], "shots", "notes.txt"), "not a picture");
  fs.appendFileSync(path.join(runDir, sues[1], "findings.jsonl"), `${JSON.stringify({ kind: "note", text: "again" })}\n{"half`);
  fs.mkdirSync(path.join(runDir, "mail", `${sues[2]}@mail.test`), { recursive: true });
  fs.writeFileSync(path.join(runDir, "mail", `${sues[2]}@mail.test`, "m1.json"), "{}");
  assertSame(cache, runDir, sues, "a picture, a note and a letter arrived");
  fs.writeFileSync(path.join(runDir, "mail", `${sues[2]}@mail.test`, "m2.json"), "{}");
  assertSame(cache, runDir, sues, "a second letter");

  fs.writeFileSync(path.join(runDir, sues[2], "summary.json"), JSON.stringify({ outcome: "done", madeAccount: true, totalCostUsd: 0.12 }));
  fs.writeFileSync(path.join(runDir, sues[2], "interview.json"), JSON.stringify({ starsOutOfFive: 4, threeWords: "fine enough really" }));
  assertSame(cache, runDir, sues, "she finished and was interviewed");
  fs.writeFileSync(path.join(runDir, sues[2], "summary.json"), "{ not json");
  assertSame(cache, runDir, sues, "a summary being rewritten reads as absent");

  fs.rmSync(path.join(runDir, sues[1], "shots"), { recursive: true });
  fs.rmSync(path.join(runDir, sues[0], "trace.jsonl"));
  assertSame(cache, runDir, sues, "files gone");
  fs.writeFileSync(path.join(runDir, sues[0], "trace.jsonl"), traceLines(500, 2));
  assertSame(cache, runDir, sues, "a new trace where the old one was");
});

test("a trace cut short, or rewritten under the same length or longer, is read again in full", () => {
  const { runDir, sues } = runFolder(["sue-7-dee"]);
  const cache = createStateCache({ now: LATER });
  const trace = path.join(runDir, sues[0], "trace.jsonl");
  fs.writeFileSync(trace, traceLines(0, 40));
  assertSame(cache, runDir, sues, "the first poll");

  fs.truncateSync(trace, fs.statSync(trace).size - 70);
  assertSame(cache, runDir, sues, "cut mid-line");
  fs.writeFileSync(trace, traceLines(0, 3));
  assertSame(cache, runDir, sues, "rewritten shorter");

  // The same length, other steps: its mtime moved, and only the bytes already read can tell it grew
  // no further. (Written inside the same clock tick, the key would not move at all: the next test.)
  const size = fs.statSync(trace).size;
  const other = traceLines(0, 3).replaceAll("tool-", "TOOL-");
  assert.equal(Buffer.byteLength(other), size);
  const { mtime } = fs.statSync(trace);
  fs.writeFileSync(trace, other);
  fs.utimesSync(trace, mtime, new Date(mtime.getTime() + 1000));
  assertSame(cache, runDir, sues, "rewritten at the same length");
  fs.writeFileSync(trace, traceLines(900, 60));
  assertSame(cache, runDir, sues, "rewritten longer");
  assert.equal(sueState(runDir, sues[0], cache.reads(runDir)).lastTool, "tool-959");
});

test("a file rewritten inside the clock tick it was read in is not trusted on its key", () => {
  const { runDir, sues } = runFolder(["sue-9-fay"]);
  const cache = createStateCache();
  const dir = path.join(runDir, sues[0]);
  const trace = path.join(dir, "trace.jsonl");
  const summary = path.join(dir, "summary.json");
  fs.writeFileSync(summary, JSON.stringify({ outcome: "done" }));
  // A whole second, so setting it again lands on exactly the same mtime.
  const tick = Math.floor(Date.now() / 1000);
  for (const file of [trace, summary]) fs.utimesSync(file, tick, tick);
  assertSame(cache, runDir, sues, "the first poll");

  // Same size, same mtime, same inode: nothing in the key moved, and the answers still must.
  const pin = (file, write) => {
    write();
    fs.utimesSync(file, tick, tick);
  };
  pin(trace, () => fs.writeFileSync(trace, fs.readFileSync(trace, "utf8").replaceAll("tool-", "TOOL-")));
  pin(summary, () => fs.writeFileSync(summary, JSON.stringify({ outcome: "gone" })));
  assertSame(cache, runDir, sues, "rewritten in the same tick");
  assert.equal(sueState(runDir, sues[0], cache.reads(runDir)).outcome, "gone");
});

test("a poll reads only what was appended since the last one", () => {
  const { runDir, sues } = runFolder(["sue-8-eve"]);
  const cache = createStateCache({ now: LATER });
  const trace = path.join(runDir, sues[0], "trace.jsonl");
  fs.writeFileSync(trace, traceLines(0, 5000));
  const size = fs.statSync(trace).size;
  poll(runDir, sues, cache.reads(runDir));
  const first = cache.stats.bytesRead;
  assert.ok(first >= size, "the first poll reads the whole trace");

  poll(runDir, sues, cache.reads(runDir));
  assert.equal(cache.stats.bytesRead, first, "nothing changed, nothing read");
  const listed = cache.stats.listings;

  const more = traceLines(5000, 2);
  fs.appendFileSync(trace, more);
  const [state] = poll(runDir, sues, cache.reads(runDir));
  assert.equal(state.lastTool, "tool-5001");
  const grew = cache.stats.bytesRead - first;
  assert.ok(
    grew >= Buffer.byteLength(more) && grew < 4096,
    `read ${grew} bytes for a ${Buffer.byteLength(more)}-byte append of a ${size}-byte trace`,
  );
  assert.equal(cache.stats.listings, listed, "an unchanged pictures folder is not listed again");

  // A picture arriving moves its folder's own mtime, on this disk's file clock (a tick or so later).
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  fs.writeFileSync(path.join(runDir, sues[0], "shots", "look-0002.jpg"), "jpeg");
  assert.equal(poll(runDir, sues, cache.reads(runDir))[0].lastShot, "look-0002.jpg");
  assert.equal(cache.stats.listings, listed + 1, "a folder that changed is listed again");
});

test("the cache keeps only the runs most recently asked about", () => {
  const cache = createStateCache({ runs: 2, now: LATER });
  const folders = [runFolder(["sue-1-a"]), runFolder(["sue-2-b"]), runFolder(["sue-3-c"])];
  for (const { runDir, sues } of folders) poll(runDir, sues, cache.reads(runDir));
  assert.deepEqual(cache.runsHeld(), [folders[1].runDir, folders[2].runDir]);
  poll(folders[1].runDir, folders[1].sues, cache.reads(folders[1].runDir));
  poll(folders[0].runDir, folders[0].sues, cache.reads(folders[0].runDir));
  assert.deepEqual(cache.runsHeld(), [folders[1].runDir, folders[0].runDir], "asking again keeps a run");
});
