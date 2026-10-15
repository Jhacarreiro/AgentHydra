/**
 * inbox-run.spec - the inbox test's collect step: each Sue's events for the arrival are read back from her
 * own mailbox, turned into one final disposition, rated over the run, given a PASS verdict, and booked.
 *
 * WHAT: `node --test --test-concurrency=1 sue/tests/inbox-run.spec.mjs`. Writes the events the way
 * body.mjs does (`<mailbox>/seeded-arrival.events.jsonl`) and reads them back through lib/inbox-run.mjs.
 * WHY: the verdict is only worth booking if it is read from what each Sue actually pressed.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { removeTreeNoFollow } from "../../lib/shared/scratch-tree.mjs";
import { bookInboxTest, inboxRunResult, readRunDispositions } from "../lib/inbox-run.mjs";
import { ARRIVAL_ID } from "../lib/findings.mjs";

const EMAIL = {
  from: "Connections <news@api.example.com>",
  subject: "This week",
  html: "<p>Hi</p>",
  headers: { "List-Unsubscribe": "<https://api.example.com/unsub?t=abc>" },
};

const SCRATCH = mkdtempSync(path.join(os.tmpdir(), "inbox-run-"));
after(() => removeTreeNoFollow(SCRATCH));
let scratchCount = 0;

function mailboxes(events) {
  const root = path.join(SCRATCH, `mailboxes-${(scratchCount += 1)}`);
  for (const [sue, list] of Object.entries(events)) {
    const dir = path.join(root, sue);
    mkdirSync(dir, { recursive: true });
    if (list === null) continue;
    writeFileSync(path.join(dir, `${ARRIVAL_ID}.events.jsonl`), list.map((e) => `${JSON.stringify(e)}\n`).join(""));
  }
  return root;
}

test("each Sue's arrival events become one disposition, and a Sue who wrote nothing is ignored", () => {
  const root = mailboxes({
    "sue-a@x.example": [{ kind: "open" }, { kind: "report-spam", quote: "I never asked for this." }],
    "sue-b@x.example": [{ kind: "open" }, { kind: "unsubscribe", via: "native" }],
    "sue-c@x.example": null,
  });
  const dispositions = readRunDispositions(root);
  assert.equal(dispositions.length, 3);
  const byOutcome = Object.fromEntries(dispositions.map((d) => [d.sue, d.outcome]));
  assert.deepEqual(byOutcome, { "sue-a@x.example": "reported-spam", "sue-b@x.example": "unsubscribed", "sue-c@x.example": "ignored" });
});

test("the run's result rates every Sue, quotes the spam reporters and gives the verdict", () => {
  const root = mailboxes({
    "sue-a@x.example": [{ kind: "report-spam", quote: "Spam." }],
    "sue-b@x.example": [{ kind: "unsubscribe", via: "body-link" }],
    "sue-c@x.example": [{ kind: "open" }],
  });
  const result = inboxRunResult(root, EMAIL);
  assert.equal(result.count, 3);
  assert.equal(result.spamRate, 1 / 3);
  assert.equal(result.unsubscribeRate.body_link, 1 / 3);
  assert.deepEqual(result.spamQuotes, ["Spam."]);
  assert.equal(result.verdict.pass, false, "1 spam in 3 is far past the bar");
  assert.match(result.key, /^[0-9a-f]{64}$/, "booked under the content hash");
});

test("a run with no spam passes, and a booking appends one line keyed by the content hash", () => {
  const root = mailboxes({ "sue-a@x.example": [{ kind: "open" }], "sue-b@x.example": [] });
  const result = inboxRunResult(root, EMAIL);
  assert.equal(result.verdict.pass, true);
  mkdirSync(path.join(SCRATCH, "book"), { recursive: true });
  const file = path.join(SCRATCH, "book", "inbox-tests.jsonl");
  bookInboxTest(file, { runId: "run-1", audience: "cold", ...result });
  bookInboxTest(file, { runId: "run-2", audience: "known", ...result });
  const lines = readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.equal(lines.length, 2, "each run is its own line");
  assert.equal(lines[0].key, result.key);
  assert.equal(lines[1].audience, "known");
  assert.equal(lines[0].verdict.pass, true);
});
