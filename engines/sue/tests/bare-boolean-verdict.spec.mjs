/**
 * sue-report-bare-boolean-verdict-dropped - a bare true/false answer to everComingBack /
 * isThisTrash / endedUpWhereExpected must reach the verdict, the journal and the scoreboard.
 * =============================================================================================
 *
 * WHAT: `node --test sue/tests/bare-boolean-verdict.spec.mjs`.
 *
 * WHY IT EXISTS: `personas.mjs` and `SPEC.md` ask the brain for "true or false, and why", but the
 * prompt's `{yes, why}` shape means `shapeInterview` only wrapped object and JSON-string answers. A
 * real run left `everComingBack: false` bare, every reader's `.yes` was undefined, and the Sue who
 * said she was done with the site for good was counted as never having answered at all. These tests
 * pin the wrap at the one shaping seam and on the two reads that bypass it (the journal builder and
 * `sue report` on a still-running run).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { shapeInterview } from "../lib/findings.mjs";
import { journalEntryFromSue, scoreRun } from "../lib/workspace.mjs";
import { buildVerdict } from "../report.mjs";

const made = [];
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-bare-bool-spec-"));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

test("shapeInterview wraps a bare boolean for the {yes, ...} answers as {yes}", () => {
  const shaped = shapeInterview({ everComingBack: false, isThisTrash: true, endedUpWhereExpected: false });
  assert.deepEqual(shaped.everComingBack, { yes: false });
  assert.deepEqual(shaped.isThisTrash, { yes: true });
  assert.deepEqual(shaped.endedUpWhereExpected, { yes: false });
});

test("shapeInterview wraps a bare 'true'/'false' string the same way", () => {
  const shaped = shapeInterview({ everComingBack: "false", isThisTrash: "true" });
  assert.equal(shaped.everComingBack.yes, false);
  assert.equal(shaped.isThisTrash.yes, true);
});

test("shapeInterview leaves object, prose and unreadable answers exactly as they came", () => {
  const shaped = shapeInterview({
    everComingBack: { yes: false, why: "nothing to do afterwards" },
    isThisTrash: "{broken",
    endedUpWhereExpected: "not sure really",
  });
  assert.deepEqual(shaped.everComingBack, { yes: false, why: "nothing to do afterwards" });
  assert.equal(shaped.isThisTrash, "{broken");
  assert.equal(shaped.endedUpWhereExpected, "not sure really");
  assert.equal(shapeInterview({}).everComingBack, null, "a skipped question stays null, never false");
});

test("shapeInterview reads a {value} or {answer} yes/no as {yes}, keeping why and where", () => {
  // The exact shapes both critic brains wrote on 2026-09-28 (runs 20260928-133054-5e00 and -9af5):
  // every reader wants `.yes`, so "Ended where expected" read 0 and the verdict read her as unasked.
  const shaped = shapeInterview({
    everComingBack: { value: true, why: "a friend vouched for it" },
    endedUpWhereExpected: { value: false, where: "on the pricing section" },
    isThisTrash: { answer: "false", why: "thin, not trash" },
  });
  assert.deepEqual(shaped.everComingBack, { yes: true, why: "a friend vouched for it" });
  assert.deepEqual(shaped.endedUpWhereExpected, { yes: false, where: "on the pricing section" });
  assert.deepEqual(shaped.isThisTrash, { yes: false, why: "thin, not trash" });
  const verdict = buildVerdict([{ sueId: "sue-5782-retention-doctor", interview: shaped }]);
  assert.equal(verdict.neverComingBackAnswered, 1);
  assert.equal(verdict.neverComingBackShare, 0);
  assert.deepEqual(
    shapeInterview({ everComingBack: { value: "maybe", why: "unsure" } }).everComingBack,
    { value: "maybe", why: "unsure" },
    "an unreadable value is left exactly as it came",
  );
});

test("a bare false reaches the verdict instead of being counted as unanswered", () => {
  // The exact shape a real run wrote: a 1-star Sue, `everComingBack: false` bare.
  const interview = shapeInterview({ starsOutOfFive: 1, everComingBack: false, isThisTrash: true });
  const verdict = buildVerdict([{ sueId: "sue-1130-retired-gary", interview }]);
  assert.equal(verdict.neverComingBackAnswered, 1);
  assert.equal(verdict.neverComingBackCount, 1);
  assert.equal(verdict.neverComingBackShare, 1);
});

test("journalEntryFromSue shapes interview.json on read, so the scoreboard counts her", () => {
  const ws = tempDir();
  const sueDir = path.join(ws, "sue-1130-retired-gary");
  fs.mkdirSync(sueDir, { recursive: true });
  fs.writeFileSync(path.join(sueDir, "summary.json"), JSON.stringify({ persona: "retired-gary", outcome: "gave-up" }));
  fs.writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 1, everComingBack: false }));
  const entry = journalEntryFromSue({ sueDir, report: null, page: { url: "https://example.test" }, intent: "buy", runId: "r1" });
  assert.equal(entry.everComingBack?.yes, false, "a bare false in a historical file must not read as unanswered");
  assert.equal(scoreRun([entry]).neverComingBackShare, 1);
});
