// Sittings number themselves from the docket, and every SUE status reader shares one rule for "over".
//
//   node --test dredd/tests/sitting.spec.mjs
//
// The Opus 5.5 review (2026-09-22) found a re-run hearing and a second --collect both seating "sitting 2" into the
// live boardroom/ folder and overwriting its logs, and three SUE status readers with three ideas of done.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { scoreText } from "../lib/ballot.mjs";
import { configureWorker } from "../lib/brain.mjs";
import { nextSitting, sit } from "../lib/collect.mjs";
import { parseSueJson, sueOver, sueProgress } from "../lib/sue-status.mjs";
import { reapAfterEach } from "./_scratch.mjs";

const scratchDirs = reapAfterEach([]);
// The sittings below never read this machine's real hswarm pools: a resting machine would hold them for its key.
const unread = () => ({ error: "pools not read in this spec" });

function docketWith(dirs) {
  const d = mkdtempSync(path.join(os.tmpdir(), "dredd-sitting-"));
  scratchDirs.push(d);
  for (const x of dirs) mkdirSync(path.join(d, x));
  return d;
}

test("the next sitting is one past the highest held, the live boardroom/ counting as the newest", () => {
  const cases = [
    [[], 1],
    [["boardroom"], 2],
    [["boardroom-1", "boardroom"], 3],
    [["boardroom-1", "boardroom-2", "boardroom"], 4],
    // A gap: a count would say 4 and archive boardroom/ onto boardroom-3, which already holds a sitting.
    [["boardroom-1", "boardroom-3", "boardroom"], 5],
    [["boardroom-1", "boardroom-2"], 3],
  ];
  for (const [dirs, want] of cases) {
    const d = docketWith(dirs);
    try {
      assert.equal(nextSitting(d), want, dirs.join(",") || "(empty)");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }
});

test("sit archives the live sitting under its own number and never writes over a held one (a re-run hearing)", () => {
  // A stand-in room: writes minutes naming the sitting it was told, the way boardroom.mjs does.
  const engine = mkdtempSync(path.join(os.tmpdir(), "dredd-engine-"));
  scratchDirs.push(engine);
  writeFileSync(
    path.join(engine, "boardroom.mjs"),
    [
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import path from "node:path";',
      "const a = process.argv.slice(2);",
      'const docket = a[a.indexOf("--docket") + 1];',
      'const sitting = Number(a[a.indexOf("--sitting") + 1]);',
      'mkdirSync(path.join(docket, "boardroom"), { recursive: true });',
      'writeFileSync(path.join(docket, "boardroom", "minutes.json"), JSON.stringify({ sitting, verdict: sitting }));',
    ].join("\n"),
  );
  const d = docketWith([]);
  try {
    // A first hearing's sittings: 1 (convene), 2 (evidence), 3 (a proposal)...
    for (const want of [1, 2, 3]) {
      const s = sit({ root: d, engineDir: engine, docketDir: d, capacity: unread });
      assert.equal(s.sitting, want);
      assert.equal(s.minutes.verdict, want);
      assert.ok(existsSync(s.log), `boardroom-${want}.log`);
    }
    // ...then the hearing is run again on the same docket: it sits 4, and 1-3 are exactly as they were.
    const again = sit({ root: d, engineDir: engine, docketDir: d, capacity: unread });
    assert.equal(again.sitting, 4);
    for (const n of [1, 2, 3]) assert.equal(JSON.parse(readFileSync(path.join(d, `boardroom-${n}`, "minutes.json"), "utf8")).sitting, n);
    assert.equal(JSON.parse(readFileSync(path.join(d, "boardroom", "minutes.json"), "utf8")).sitting, 4);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(engine, { recursive: true, force: true });
  }
});

test("a room that wrote no minutes, or a failure record, is a failure with its reason - never minutes", () => {
  const engine = mkdtempSync(path.join(os.tmpdir(), "dredd-engine-"));
  scratchDirs.push(engine);
  const d = docketWith([]);
  try {
    writeFileSync(path.join(engine, "boardroom.mjs"), "process.exit(1);\n");
    const none = sit({ root: d, engineDir: engine, docketDir: d, capacity: unread });
    assert.equal(none.minutes, null);
    assert.match(none.failure, /no minutes/);
    writeFileSync(
      path.join(engine, "boardroom.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'import path from "node:path";',
        'const docket = process.argv[process.argv.indexOf("--docket") + 1];',
        'mkdirSync(path.join(docket, "boardroom"), { recursive: true });',
        'writeFileSync(path.join(docket, "boardroom", "minutes.json"), JSON.stringify({ failed: true, error: "no seat answered" }));',
        "process.exit(1);",
      ].join("\n"),
    );
    const failed = sit({ root: d, engineDir: engine, docketDir: d, capacity: unread });
    assert.equal(failed.minutes, null);
    assert.equal(failed.failure, "no seat answered");
    // The first room died before it made its folder; it still keeps its number, so the second never writes over its log.
    assert.equal(failed.sitting, none.sitting + 1);
  } finally {
    rmSync(d, { recursive: true, force: true });
    rmSync(engine, { recursive: true, force: true });
  }
});

test("a room whose every hswarm route is resting on a rate limit files a capacity verdict, never 'no ballots' (board #7040)", () => {
  // Lift's round 25 table: every key at its rate limit, the room asleep in the queue for 900 s, filed as "-/10 (no ballots)".
  const engine = mkdtempSync(path.join(os.tmpdir(), "dredd-engine-"));
  scratchDirs.push(engine);
  writeFileSync(path.join(engine, "boardroom.mjs"), "process.exit(1);\n");
  // The HSwarm door (ask.py) stood in at the worker seam: its capacity answer says every route rests.
  const fake = path.join(engine, "fake-ask.cjs");
  const resting = { status: "ok", profile: "routine", ready: [], resting: { anthropic: 45, gemini: 600 }, disabled: [] };
  writeFileSync(
    fake,
    `if (process.argv.includes("--capacity")) process.stdout.write(JSON.stringify(${JSON.stringify({ ...resting, all_resting: true, soonest_s: 45 })}) + "\\n");\n`,
  );
  const d = docketWith([]);
  configureWorker({ command: [process.execPath, fake] });
  try {
    const s = sit({ root: d, engineDir: engine, docketDir: d, waitCapS: 0 });
    assert.equal(s.minutes, null);
    assert.equal(s.capacity?.all_resting, true);
    assert.match(s.failure, /^capacity: every route was rate-limited \(anthropic 45 s, gemini 10 min\), the soonest free at \d\d:\d\d UTC/);
    assert.doesNotMatch(scoreText({ verdict: null, capacity: s.failure }), /\/10|no ballots/);
  } finally {
    configureWorker();
    rmSync(d, { recursive: true, force: true });
    rmSync(engine, { recursive: true, force: true });
  }
});

test("a SUE run is over when its state ends it or every expected Sue finished - one rule for every reader", () => {
  assert.equal(sueOver(null), false, "an unreadable status is not over");
  assert.equal(sueOver({ state: "running", expected: 5, finished: 2 }), false);
  assert.equal(sueOver({ state: "running", expected: 5, finished: 5 }), true);
  for (const state of ["finished", "refused", "stopped", "failed"]) assert.equal(sueOver({ state }), true, state);
  // "stopped" is sue.mjs's word for a run whose process died: the hearing used to wait its whole budget on one.
  assert.equal(sueOver({ state: "stopped", expected: 5, finished: 1 }), true);
  assert.equal(sueProgress({ state: "running", expected: 5, finished: 2 }), "running 2/5");
  assert.equal(sueProgress(null), "no status 0/?");
});

test("a sue.mjs answer is read from the first line that opens a brace, past an echoed command", () => {
  const out = ['$ node sue/sue.mjs status --json "{\\"runId\\":\\"r1\\"}"', '{ "ok": true,', '  "state": "finished" }'].join("\n");
  assert.deepEqual(parseSueJson(out), { ok: true, state: "finished" });
  assert.equal(parseSueJson("no json here"), null);
  assert.equal(parseSueJson("{ torn"), null);
});
