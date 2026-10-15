/**
 * retention.spec - a finished run older than the chosen window loses its pictures and brain streams,
 * and nothing else (lib/retention.mjs). Plain node (`node --test sue/tests/retention.spec.mjs`).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { keepDaysOf, pruneRuns, pruneSummary } from "../lib/retention.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-09-25T00:00:00Z");

function write(file, text = "x") {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function run(runs, runId, finished) {
  const dir = path.join(runs, runId);
  write(path.join(dir, "manifest.json"), JSON.stringify({ runId, finished }));
  write(path.join(dir, "report.json"), "{}");
  write(path.join(dir, "mail", "inbox.jsonl"), "{}");
  const sue = path.join(dir, "sue-1-grandma");
  for (const f of ["shots/look-001.jpg", "eyes/001.png", "brain.jsonl", "summary.json", "interview.json", "findings.jsonl", "trace.jsonl"])
    write(path.join(sue, f), "0123456789");
  return sue;
}

test("keepPictures: pictures and brain streams of a run finished before the window go; what people read stays", () => {
  const runs = fs.mkdtempSync(path.join(tmpdir(), "sue-retention-"));
  try {
    const old = run(runs, "20260801-100000-aaaa", new Date(NOW - 40 * DAY).toISOString());
    const recent = run(runs, "20260920-100000-bbbb", new Date(NOW - 5 * DAY).toISOString());
    const live = run(runs, "20260801-110000-cccc", null);

    assert.deepEqual(
      pruneRuns(runs, { keepDays: keepDaysOf("forever"), now: NOW }),
      { runs: 0, bytes: 0, errors: [] },
      "forever deletes nothing",
    );
    assert.deepEqual(pruneRuns(runs, { keepDays: keepDaysOf("30"), now: NOW }), { runs: 1, bytes: 30, errors: [] });
    for (const gone of ["shots", "eyes", "brain.jsonl"]) assert.equal(fs.existsSync(path.join(old, gone)), false, `${gone} went`);
    for (const kept of ["summary.json", "interview.json", "findings.jsonl", "trace.jsonl", "../report.json", "../mail/inbox.jsonl"])
      assert.equal(fs.existsSync(path.join(old, kept)), true, `${kept} stays`);
    for (const untouched of [recent, live]) assert.equal(fs.existsSync(path.join(untouched, "shots", "look-001.jpg")), true);
    assert.deepEqual(pruneRuns(runs, { keepDays: 30, now: NOW }), { runs: 0, bytes: 0, errors: [] }, "a pruned run is not walked again");
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
  }
});

// The panel the owner delegated to (decide-48, 2026-09-24) ruled Option 2: the window is forever, 7, 14,
// 30 or 90 days, off until the person picks, and a prune never fails silently - a file it could not
// delete comes back in the result (the Manager says so in a toast), and that run is walked again.
test("keepPictures: 14 days is a choice, and forever or nonsense keeps everything", () => {
  assert.equal(keepDaysOf("14"), 14);
  assert.equal(keepDaysOf("forever"), null);
  assert.equal(keepDaysOf("-3"), null);
});

test("a file it cannot delete comes back in the result, is not thrown, and its run is tried again", () => {
  const runs = fs.mkdtempSync(path.join(tmpdir(), "sue-retention-"));
  try {
    const old = run(runs, "20260801-100000-aaaa", new Date(NOW - 40 * DAY).toISOString());
    write(path.join(runs, "state", "accounts.jsonl"), "ledger");
    const stuck = (target, opts) => {
      if (target.endsWith("brain.jsonl")) throw new Error("EBUSY: resource busy or locked");
      fs.rmSync(target, opts);
    };
    const first = pruneRuns(runs, { keepDays: 7, now: NOW, rm: stuck });
    assert.equal(first.runs, 0, "a run with a file left is not counted as pruned");
    assert.equal(first.bytes, 20, "what did go is still counted");
    assert.equal(first.errors.length, 1);
    assert.match(first.errors[0], /20260801-100000-aaaa.*brain\.jsonl.*EBUSY/);
    assert.equal(fs.existsSync(path.join(old, "brain.jsonl")), true);
    assert.equal(fs.existsSync(path.join(runs, "state", "accounts.jsonl")), true, "a folder that is not a run is never touched");
    assert.deepEqual(pruneRuns(runs, { keepDays: 7, now: NOW }), { runs: 1, bytes: 10, errors: [] }, "the next pass finishes it");
  } finally {
    fs.rmSync(runs, { recursive: true, force: true });
  }
});

test("pruneSummary is the one line a log and a toast print: what was freed, or what failed", () => {
  assert.equal(pruneSummary({ runs: 0, bytes: 0, errors: [] }), null, "nothing to say");
  assert.equal(pruneSummary({ runs: 2, bytes: 1.5e9, errors: [] }), "freed 1.5 GB from 2 runs");
  assert.equal(pruneSummary({ runs: 1, bytes: 42e6, errors: [] }), "freed 42 MB from 1 run");
  assert.equal(
    pruneSummary({ runs: 0, bytes: 0, errors: ["run 1 brain.jsonl: EBUSY", "run 2 shots: EPERM"] }),
    "could not delete 2 old run files (first: run 1 brain.jsonl: EBUSY)",
  );
});
