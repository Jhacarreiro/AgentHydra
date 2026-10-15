/**
 * The report action on a run nobody finished still says what the Sues said.
 *
 * Run 20260926-122301-d589: both brains stopped before their exit interviews, so no report.json was
 * written and `action: "report"` answered from interviews alone - `mostConfusing: []`, no quotes at
 * all - while each Sue had left seven or more diary notes ("Full name is required" before she typed,
 * the note sitting on the label, the surprise account page). The diary is the part of a visit that
 * exists before any interview does, so the interim answer carries it too, read through report.mjs's
 * own buildConfusion so the finished and unfinished answers quote the same lines.
 *
 * SUE_HOME points the runs root at a temp dir, so nothing here reads or writes this checkout's runs.
 */
import "./fixtures/people.mjs";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-interim-diary-"));
process.env.SUE_HOME = home;
after(() => fs.rmSync(home, { recursive: true, force: true }));

const { dispatch } = await import("../sue.mjs");

test("an unfinished run's report quotes the diary notes, not just interviews", () => {
  const runId = "20260926-122301-abcd";
  const sueDir = path.join(home, "runs", runId, "sue-5392-grandma");
  fs.mkdirSync(sueDir, { recursive: true });
  fs.writeFileSync(path.join(sueDir, "sue.json"), JSON.stringify({ sueId: "sue-5392-grandma", persona: "grandma" }));
  const notes = [
    {
      source: "brain",
      kind: "confusion",
      text: "It says Your answers are saved. Come back from where?",
      url: "https://example.com/dy28zz",
    },
    { source: "body", kind: "http-error", text: "401 POST https://app.example.com/auth/refresh" },
  ];
  fs.writeFileSync(path.join(sueDir, "findings.jsonl"), notes.map((n) => JSON.stringify(n)).join("\n") + "\n");

  const answer = dispatch("report", { runId, workspace: home });

  assert.equal(answer.complete, false);
  assert.deepEqual(
    answer.theirWords.map((w) => [w.sueId, w.kind, w.said]),
    [["sue-5392-grandma", "confusion", "It says Your answers are saved. Come back from where?"]],
  );
});

// Lift, 2026-09-29: a hearing's drafter saw only the front door's text and quoted lesson screens that do not exist. The
// report hands it each screen the Sues saw, once and whole: the body's pageText over the trace's 200-character result,
// the longer of two looks where one starts the other, without her eyesight notes or the control numbers.
test("the report lists each screen the Sues saw, once and whole", () => {
  const runId = "20260929-042934-abcd";
  const sueDir = path.join(home, "runs", runId, "sue-1604-child");
  fs.mkdirSync(sueDir, { recursive: true });
  fs.writeFileSync(path.join(sueDir, "sue.json"), JSON.stringify({ sueId: "sue-1604-child", persona: "child" }));
  const look = (fields) => JSON.stringify({ tool: "look", url: "https://lift.test/student/#/play/b", ...fields });
  const sort = "[1] Lift\n[2] Overview [tiny print you can barely make out]\nPART 2 OF 3\nFact or idea? Tap a button for each card.\n[3] Fact or health: check it";
  fs.writeFileSync(
    path.join(sueDir, "trace.jsonl"),
    [
      look({ result: "You are getting a little bored with this page and your eyes are wandering.\n\n[1] Lift\n[2] Overview\nPART 2 OF 3\nFact or" }),
      look({ result: sort.slice(0, 200), pageText: sort }),
      look({ result: "[1] Lift\nPart 2 of 3 done!", pageText: "[1] Lift\nPart 2 of 3 done!" }),
    ].join("\n") + "\n",
  );

  const answer = dispatch("report", { runId, workspace: home });

  assert.deepEqual(
    answer.screensSeen.map((s) => s.text),
    ["Lift\nOverview\nPART 2 OF 3\nFact or idea? Tap a button for each card.\nFact or health: check it", "Lift\nPart 2 of 3 done!"],
  );
});
