/**
 * inbox-door-start.spec - the inbox_test door starts a test the way the test is defined, and reads it back.
 *
 * WHAT: `node --test --test-concurrency=1 sue/tests/inbox-door-start.spec.mjs`. The run is stubbed, so
 * nothing here stages an engine, spawns a Sue or touches the network.
 * WHY: a start that drops the decoys, the audience's intent or the count would bill Sues for a verdict that
 * means nothing, and a report that does not book its line would leave no record of the test.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { ARRIVAL_ID } from "../lib/findings.mjs";
import { contentHashOf, intentFor } from "../lib/inbox-test.mjs";
import { mailDir } from "../lib/run-dir.mjs";
import { storeDir } from "../lib/workspace.mjs";
import { dispatch, inboxTest } from "../sue.mjs";

const RUN = "20261008-120000-abcd";
const EMAIL = {
  from: "Connections <news@api.example.com>",
  subject: "This week",
  html: '<p>Hi</p><a href="https://api.example.com/home">home</a><a href="https://api.example.com/unsub?t=abc">unsubscribe</a>',
  headers: { "List-Unsubscribe": "<https://api.example.com/unsub?t=abc>" },
};

const made = [];
function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  made.push(dir);
  return dir;
}
afterEach(() => {
  while (made.length) fs.rmSync(made.pop(), { recursive: true, force: true });
});

function useHome(home) {
  const prior = process.env.SUE_HOME;
  process.env.SUE_HOME = home;
  return () => {
    if (prior === undefined) delete process.env.SUE_HOME;
    else process.env.SUE_HOME = prior;
  };
}

function writeMail(sueId, events) {
  const dir = path.join(mailDir(RUN), sueId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${ARRIVAL_ID}.events.jsonl`), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

function recordRun(seen) {
  return {
    run: (args) => {
      seen.push(args);
      return { ok: true, runId: RUN };
    },
  };
}

test("the inbox test starts one run in every inbox among decoys, on the email's own first link, with the audience's intent", () => {
  const ws = tempDir("sue-ws-");
  const seen = [];
  const out = inboxTest({ workspace: ws, email: EMAIL, audience: "cold" }, recordRun(seen));
  assert.equal(seen.length, 1);
  const [args] = seen;
  assert.equal(args.start, "inbox");
  assert.equal(args.decoys, true);
  assert.equal(args.count, 100, "one hundred Sues is the default: the bar is zero spam in a hundred");
  assert.equal(
    args.url,
    "https://api.example.com/home",
    "the Sues start on a page the email links to, never on its unsubscribe address",
  );
  assert.equal(args.intent, intentFor("cold"));
  assert.deepEqual(args.arrival, { ...EMAIL, audience: "cold" });
  assert.equal(out.runId, RUN);
  assert.deepEqual(out.inboxTest, { key: contentHashOf(EMAIL), audience: "cold", count: 100 });
});

test("a plain-text email with no link starts the Sues from the page the caller names, in their inbox", () => {
  const ws = tempDir("sue-ws-");
  const seen = [];
  const TEXT_ONLY = {
    from: "the owner at Connections <owner@example.com>",
    subject: "your Spring Gala guest list",
    text: "Hi Sam, we are hosting a Spring Gala. Reply no to opt out.",
    headers: {
      "List-Unsubscribe": "<https://example.com/unsubscribe?t=inbox-test>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
  inboxTest({ workspace: ws, email: TEXT_ONLY, audience: "cold", count: 10, url: "https://example.com/" }, recordRun(seen));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, "https://example.com/", "the page the caller names is where the Sues start");
  assert.equal(seen[0].start, "inbox");
});

test("the inbox test takes a count, and an audience of known gets the known intent", () => {
  const ws = tempDir("sue-ws-");
  const seen = [];
  inboxTest({ workspace: ws, email: EMAIL, audience: "known", count: 10 }, recordRun(seen));
  assert.equal(seen[0].count, 10);
  assert.equal(seen[0].intent, intentFor("known"));
});

test("the report reads each Sue's presses back, books one verdict line keyed by the email, and says FAIL past the bar", () => {
  const ws = tempDir("sue-ws-");
  const home = tempDir("sue-home-");
  const restore = useHome(home);
  try {
    writeMail("sue-a", [{ kind: "open" }, { kind: "report-spam", quote: "This is spam, I never signed up." }]);
    writeMail("sue-b", [{ kind: "open" }]);
    const out = dispatch("inbox_test_report", { workspace: ws, runId: RUN, email: EMAIL, audience: "cold" });
    assert.equal(out.ok, true);
    assert.equal(out.runId, RUN);
    assert.equal(out.count, 2);
    assert.equal(out.spamRate, 0.5);
    assert.deepEqual(out.spamQuotes, ["This is spam, I never signed up."]);
    assert.equal(out.verdict.pass, false);
    assert.match(out.line, /^FAIL: 1 spam report\(s\) in 2 Sues; 95% upper bound \d+\.\d%; 0 replied$/);
    const booked = fs
      .readFileSync(path.join(storeDir(ws), "inbox-tests.jsonl"), "utf8")
      .trim()
      .split("\n");
    assert.equal(booked.length, 1);
    const line = JSON.parse(booked[0]);
    assert.equal(line.runId, RUN);
    assert.equal(line.key, contentHashOf(EMAIL));
    assert.equal(line.audience, "cold");
    assert.equal(line.verdict.pass, false);
    assert.equal("dispositions" in line, false, "the per-Sue dispositions stay in the run's own folder");
  } finally {
    restore();
  }
});

const HOST_EMAIL = {
  from: "the owner at Connections <owner@example.com>",
  subject: "your {event_name} guest list",
  text: "Hi {first_name}, I saw your {event_name} on {where_found}.",
  headers: { "List-Unsubscribe": "<https://app.example.com/unsubscribe?t=inbox-test>" },
};

test("a run is refused before any Sue starts when a named Sue has no true fact for a merge field", () => {
  const ws = tempDir("sue-ws-");
  let started = 0;
  assert.throws(
    () =>
      inboxTest(
        {
          workspace: ws,
          email: HOST_EMAIL,
          audience: "cold",
          count: 2,
          url: "https://example.com/",
          personas: ["brewery-sam", "grandma"],
        },
        { run: () => (started += 1) },
      ),
    /grandma: \{event_name\}.*grandma: \{where_found\}/,
    "the refusal names the Sue and the field",
  );
  assert.equal(started, 0, "no Sue started");
});

test("an email with merge fields goes only to personas that have a fact for each, and the run still has the count asked for", () => {
  const ws = tempDir("sue-ws-");
  const seen = [];
  inboxTest({ workspace: ws, email: HOST_EMAIL, audience: "cold", count: 10, url: "https://example.com/" }, recordRun(seen));
  assert.equal(seen[0].personas.length, 10);
  assert.equal(new Set(seen[0].personas).size, 10);
  assert.throws(
    () =>
      inboxTest({ workspace: ws, email: HOST_EMAIL, audience: "cold", count: 500, url: "https://example.com/" }, { run: () => ({}) }),
    /only \d+ personas/,
  );
});
