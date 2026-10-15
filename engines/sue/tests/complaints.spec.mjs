// complaints.spec.mjs - pins sue/complaints.mjs: the --since run filter and the theme bucket.
//
// Why it exists: --since used to be compared as a raw string against run ids, so a dashed calendar
// date ('2026-09-21') let every 2026 run through because '0' > '-'. These are the browser-free
// assertions that keep the dated filter honest and keep a matched quote grouped under its theme.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { bucket, collectQuotes, themesOf } from "../complaints.mjs";

/** A run dir with one visited Sue and the given diary findings. */
function makeRun(runsDir, runId, findings = []) {
  const dir = path.join(runsDir, runId, "sue-0001-rust-owner");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ persona: "rust-owner" }));
  writeFileSync(path.join(dir, "findings.jsonl"), findings.map((f) => JSON.stringify(f)).join("\n"));
}

describe("collectQuotes --since", () => {
  it("accepts a dashed calendar date and keeps runs on or after it", () => {
    const runsDir = mkdtempSync(path.join(tmpdir(), "sue-complaints-"));
    try {
      makeRun(runsDir, "20260815-000000-aaaa", [{ source: "brain", kind: "annoyance", text: "too many steps" }]);
      makeRun(runsDir, "20260921-000000-bbbb", [{ source: "brain", kind: "confusion", text: "a captcha blocked me" }]);
      makeRun(runsDir, "20260922-000000-cccc", [{ source: "brain", kind: "broken", text: "the price is hidden" }]);
      const { runs } = collectQuotes(runsDir, { since: "2026-09-21" });
      assert.deepEqual(
        runs.map((r) => r.runId),
        ["20260921-000000-bbbb", "20260922-000000-cccc"],
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  it("still accepts an undashed date", () => {
    const runsDir = mkdtempSync(path.join(tmpdir(), "sue-complaints-"));
    try {
      makeRun(runsDir, "20260815-000000-aaaa", [{ source: "brain", kind: "annoyance", text: "too many steps" }]);
      makeRun(runsDir, "20260922-000000-cccc", [{ source: "brain", kind: "broken", text: "the price is hidden" }]);
      const { runs } = collectQuotes(runsDir, { since: "20260921" });
      assert.deepEqual(
        runs.map((r) => r.runId),
        ["20260922-000000-cccc"],
      );
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

// On 2026-09-22 every "Unable to process this request" was our own Sue sign-up door's daily cap, and
// this list ranked those lines as the site's email code being broken. report.mjs's rule decides.
describe("collectQuotes and SUE's own doing", () => {
  it("keeps the lines our door caused out of the themes and lists them as SUE-side", () => {
    const runsDir = mkdtempSync(path.join(tmpdir(), "sue-complaints-"));
    try {
      makeRun(runsDir, "20260922-000000-dddd", [
        { source: "brain", kind: "broken", text: "the price is hidden", at: "2026-09-22T10:00:00.000Z" },
        { source: "body", kind: "sue-door-refused", text: "our door refused her", at: "2026-09-22T10:01:00.000Z" },
        {
          source: "brain",
          kind: "broken",
          text: "Email me a code says Unable to process this request, no code came",
          at: "2026-09-22T10:01:05.000Z",
        },
      ]);
      const { quotes, sueSide } = collectQuotes(runsDir);
      assert.deepEqual(
        quotes.map((q) => q.said),
        ["the price is hidden"],
      );
      assert.equal(sueSide.length, 1);
      assert.match(sueSide[0].said, /Unable to process/);
      assert.match(sueSide[0].why, /sign-up door/);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });

  // 2026-09-28: report.md already moved these to SUE-side; this ranking still counted them as the site's.
  it("keeps a line blaming the site after her patience ran out out of the themes", () => {
    const runsDir = mkdtempSync(path.join(tmpdir(), "sue-complaints-"));
    try {
      makeRun(runsDir, "20260928-000000-eeee", [
        { source: "brain", kind: "confusion", text: "none of the plans says which one is for me", at: "2026-09-28T10:00:05.000Z" },
        { source: "body", kind: "patience-exhausted", text: "patience gone", at: "2026-09-28T10:02:00.000Z" },
        { source: "brain", kind: "broken", text: "the site stopped responding to clicks", at: "2026-09-28T10:02:05.000Z" },
      ]);
      const { quotes, sueSide } = collectQuotes(runsDir);
      assert.deepEqual(
        quotes.map((q) => q.said),
        ["none of the plans says which one is for me"],
      );
      assert.equal(sueSide.length, 1);
      assert.match(sueSide[0].why, /patience ran out/);
    } finally {
      rmSync(runsDir, { recursive: true, force: true });
    }
  });
});

describe("bucket", () => {
  it("counts a Sue once even when she names a theme twice", () => {
    const quotes = [
      { runId: "r1", sueId: "sue-1", persona: "p", stars: 2, from: "diary:confusion", said: "a captcha blocked me" },
      { runId: "r1", sueId: "sue-1", persona: "p", stars: 2, from: "diary:broken", said: "captcha again" },
    ];
    const robot = bucket(quotes).ranked.find((r) => r.theme === "robot-check");
    assert.equal(robot.sues, 1);
    assert.equal(robot.mentions, 2);
  });

  it("keeps a sentence no theme matched in unbucketed", () => {
    const quotes = [{ runId: "r1", sueId: "sue-1", persona: "p", from: "toAFriend", said: "lovely weather" }];
    assert.deepEqual(themesOf(quotes[0].said), []);
    assert.equal(bucket(quotes).unbucketed.length, 1);
  });
});
