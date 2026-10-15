/**
 * inbox-test.spec - the inbox test's pure rules: which controls an email shows, what one Sue's
 * actions finally mean, the spam and unsubscribe rates, the one-sided 95% bound and the PASS rule,
 * and the content hash an email is booked under.
 *
 * WHAT: `node --test sue/tests/inbox-test.spec.mjs`. Pure functions only; the live inbox is
 * proven end to end in inbox-page.spec.mjs and by a real `inbox_test` run.
 * WHY: a bulk email goes to people's real inboxes only when no simulated person presses "Report
 * spam" (up to 100 Sues; above 100, at most 1 in 1000), and the rest who want out can use the
 * native unsubscribe.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { removeTreeNoFollow } from "../../lib/shared/scratch-tree.mjs";
import { ARRIVAL_ID } from "../lib/findings.mjs";
import { INBOX_FACTS, eventHostsFor, inboxFactsFor, unfilledMerge } from "../lib/inbox-facts.mjs";
import { inboxTestRecord } from "../lib/inbox-run.mjs";
import {
  clopperPearsonUpper,
  contentHashOf,
  controlsFor,
  dispositionOf,
  fillMerge,
  mergeTokensOf,
  rates,
  unsubscribeUrlOf,
  verdictOf,
} from "../lib/inbox-test.mjs";

const plain = { from: "Connections <news@api.example.com>", subject: "This week", html: "<p>Hi</p>" };
const withHeader = {
  ...plain,
  headers: { "List-Unsubscribe": "<https://api.example.com/unsub?t=abc>, <mailto:unsub@api.example.com>" },
};

test("the native Unsubscribe control appears only when the email carries List-Unsubscribe", () => {
  assert.equal(controlsFor(plain).includes("unsubscribe"), false, "no header, no native unsubscribe");
  assert.equal(controlsFor(withHeader).includes("unsubscribe"), true, "a List-Unsubscribe header shows it");
  for (const control of ["report_spam", "delete", "archive", "reply"]) {
    assert.equal(controlsFor(plain).includes(control), true, `${control} is on every email`);
  }
});

test("the unsubscribe URL is the https entry of List-Unsubscribe, and nothing else", () => {
  assert.equal(unsubscribeUrlOf(withHeader), "https://api.example.com/unsub?t=abc");
  assert.equal(unsubscribeUrlOf(plain), null);
  const onlyMailto = { ...plain, headers: { "list-unsubscribe": "<mailto:unsub@api.example.com>" } };
  assert.equal(unsubscribeUrlOf(onlyMailto), null, "a mailto alone has no page a Sue can press");
});

test("one Sue's final disposition is the most severe thing she did", () => {
  assert.equal(dispositionOf([]).outcome, "ignored");
  assert.equal(dispositionOf([{ kind: "open" }]).outcome, "read-and-left");
  assert.equal(dispositionOf([{ kind: "open" }, { kind: "click-through" }]).outcome, "clicked-through");
  const native = dispositionOf([{ kind: "open" }, { kind: "unsubscribe", via: "native" }]);
  assert.deepEqual([native.outcome, native.via], ["unsubscribed", "native"]);
  assert.equal(dispositionOf([{ kind: "unsubscribe", via: "body-link" }]).via, "body-link");
  assert.equal(dispositionOf([{ kind: "unsubscribe", via: "reply" }]).via, "reply");
  assert.equal(dispositionOf([{ kind: "unsubscribe", via: "native" }, { kind: "report-spam" }]).outcome, "reported-spam");
  assert.equal(dispositionOf([{ kind: "report-spam" }, { kind: "delete" }]).outcome, "reported-spam");
  assert.equal(dispositionOf([{ kind: "delete" }]).outcome, "deleted");
});

test("a Sue's own words are kept with a spam report and with a reply that says no", () => {
  const spam = dispositionOf([{ kind: "report-spam", quote: "I never signed up for this." }]);
  assert.equal(spam.why, "I never signed up for this.");
  const no = dispositionOf([{ kind: "unsubscribe", via: "reply", quote: "Please stop emailing me." }]);
  assert.equal(no.why, "Please stop emailing me.");
});

test("rates are counted over every Sue, not only the ones who acted", () => {
  const dispositions = [
    dispositionOf([{ kind: "report-spam", quote: "spam" }]),
    dispositionOf([{ kind: "unsubscribe", via: "native" }]),
    dispositionOf([{ kind: "unsubscribe", via: "body-link" }]),
    dispositionOf([{ kind: "unsubscribe", via: "reply" }]),
    dispositionOf([{ kind: "open" }]),
    dispositionOf([]),
    dispositionOf([]),
    dispositionOf([]),
    dispositionOf([{ kind: "click-through" }]),
    dispositionOf([{ kind: "delete" }]),
  ];
  const r = rates(dispositions);
  assert.equal(r.count, 10);
  assert.equal(r.spamRate, 0.1);
  assert.equal(r.unsubscribeRate.native, 0.1);
  assert.equal(r.unsubscribeRate.body_link, 0.1);
  assert.equal(r.unsubscribeRate.reply, 0.1);
  assert.equal(r.ignoredRate, 0.3);
  assert.deepEqual(r.spamQuotes, ["spam"]);
});

test("the one-sided 95% upper bound: zero in 100 is about 3%, and it never sits below the point rate", () => {
  assert.ok(Math.abs(clopperPearsonUpper(0, 100) - 0.0295) < 0.0005, `got ${clopperPearsonUpper(0, 100)}`);
  assert.equal(clopperPearsonUpper(0, 10) > 0.25 && clopperPearsonUpper(0, 10) < 0.3, true);
  assert.equal(clopperPearsonUpper(1, 100) > 0.01, true);
  assert.equal(clopperPearsonUpper(100, 100), 1);
});

test("PASS only with zero spam reports up to 100 Sues, and at most 1 per 1000 above 100", () => {
  assert.equal(verdictOf({ spam: 0, count: 100 }).pass, true);
  assert.equal(verdictOf({ spam: 1, count: 100 }).pass, false, "1 in 100 is past the bar");
  assert.equal(verdictOf({ spam: 1, count: 10 }).pass, false, "1 in 10 is far past the bar");
  assert.equal(verdictOf({ spam: 0, count: 10 }).pass, true);
  assert.equal(verdictOf({ spam: 0, count: 101 }).pass, true);
  assert.equal(verdictOf({ spam: 1, count: 300 }).pass, false, "1 in 300 is past Gmail's 0.3% cap");
  assert.equal(verdictOf({ spam: 1, count: 999 }).pass, false, "1 in 999 is past 1 in 1000");
  assert.equal(verdictOf({ spam: 1, count: 1000 }).pass, true, "1 in 1000 is exactly the bar above 100");
  assert.equal(verdictOf({ spam: 2, count: 1500 }).pass, false, "2 in 1500 is past 1 in 1000");
  assert.equal(verdictOf({ spam: 0, count: 10 }).upperBound > 0.25, true, "a small test still reports its bound");
});

test("a Sue who sent a reply is replied, unless that reply opted out; no events is not replied", () => {
  assert.equal(dispositionOf([{ kind: "open" }, { kind: "reply", quote: "Sounds good, send the deck." }]).replied, true);
  assert.equal(dispositionOf([{ kind: "reply", quote: "No thanks" }, { kind: "unsubscribe", via: "reply", quote: "No thanks" }]).replied, false);
  assert.equal(dispositionOf([{ kind: "open" }]).replied, false);
  assert.equal(dispositionOf([]).replied, false);
});

test("the reply rate counts every Sue and quotes the replies that were not opt-outs", () => {
  const r = rates([
    dispositionOf([{ kind: "reply", quote: "Tell me more." }]),
    dispositionOf([{ kind: "reply", quote: "No" }, { kind: "unsubscribe", via: "reply", quote: "No" }]),
    dispositionOf([{ kind: "open" }]),
    dispositionOf([]),
  ]);
  assert.equal(r.replyRate, 0.25);
  assert.deepEqual(r.replyQuotes, ["Tell me more."]);
});

test("the content hash is stable for the same email and changes when any part of it changes", () => {
  const a = contentHashOf(withHeader);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.equal(contentHashOf({ ...withHeader, headers: { ...withHeader.headers } }), a, "same content, same key");
  assert.notEqual(contentHashOf({ ...withHeader, subject: "Other" }), a, "a new subject is a new test");
  assert.notEqual(contentHashOf({ ...withHeader, html: "<p>Bye</p>" }), a, "a new body is a new test");
  assert.notEqual(contentHashOf({ ...withHeader, headers: {} }), a, "a new header is a new test");
});

const TEMPLATE = {
  from: "the owner at Connections <owner@example.com>",
  subject: "your {event_name} guest list",
  text: "Hi {first_name},\n\nI saw your {event_name} on {where_found}.",
};

test("each Sue's merge tokens are filled from her own facts", () => {
  const sam = fillMerge(TEMPLATE, { first_name: "Sam", event_name: "Tuesday trivia", where_found: "Facebook" });
  assert.equal(sam.email.text, "Hi Sam,\n\nI saw your Tuesday trivia on Facebook.");
  assert.equal(sam.email.subject, "your Tuesday trivia guest list");
  assert.deepEqual(sam.filled.sort(), ["event_name", "first_name", "where_found"]);
  assert.equal(TEMPLATE.text.includes("{first_name}"), true, "the template itself is not changed");
  assert.deepEqual(mergeTokensOf(TEMPLATE), ["event_name", "first_name", "where_found"]);
});

test("a token with no fact for a Sue is an error, and no generic word is put in its place", () => {
  assert.throws(
    () => fillMerge(TEMPLATE, { first_name: "Sam" }),
    (err) => err.token === "event_name" && /\{event_name\}/.test(err.message),
    "a missing fact refuses and names the token",
  );
  for (const blank of [undefined, null, "", "   "]) {
    assert.throws(() => fillMerge(TEMPLATE, { first_name: "Sam", event_name: blank, where_found: "Facebook" }), /event_name/);
  }
});

test("two Sues get different event facts, each true to her persona", () => {
  const sam = inboxFactsFor("brewery-sam");
  const mateo = inboxFactsFor("band-mateo");
  assert.notEqual(sam.event_name, mateo.event_name, "two hosts never share an event");
  const copyOf = (facts, first_name) => fillMerge(TEMPLATE, { first_name, ...facts }).email.text;
  assert.match(copyOf(sam, "Sam"), /Tuesday trivia on Facebook/, "Sam runs Tuesday trivia and keeps a Facebook page");
  assert.match(copyOf(mateo, "Mateo"), /on Eventbrite/, "Mateo sells his band's tickets through Eventbrite");
  const names = Object.values(INBOX_FACTS)
    .map((f) => f.event_name)
    .filter(Boolean);
  assert.equal(new Set(names).size, names.length, "no event name is shared across personas");
  for (const fact of Object.values(INBOX_FACTS)) assert.ok(fact.because, "every fact says which line of her persona it comes from");
  assert.deepEqual(inboxFactsFor("grandma"), {}, "a persona with no event of her own has no event facts");
});

test("a run is refused before any Sue starts when a Sue has no fact for a token, naming her and the token", () => {
  assert.deepEqual(unfilledMerge(TEMPLATE, ["brewery-sam", "band-mateo"]), []);
  assert.deepEqual(unfilledMerge(TEMPLATE, ["brewery-sam", "grandma"]), [
    { persona: "grandma", token: "event_name" },
    { persona: "grandma", token: "where_found" },
  ]);
  assert.deepEqual(
    unfilledMerge({ ...TEMPLATE, text: "Hi {first_name}", subject: "Hello" }, ["grandma"]),
    [],
    "a name needs no table: every Sue has one",
  );
  assert.deepEqual(
    eventHostsFor(TEMPLATE, 3),
    ["assoc-gary", "band-mateo", "bookstore-owen"],
    "the audience is only personas with facts for every token",
  );
  assert.throws(() => eventHostsFor(TEMPLATE, 500), /only \d+ personas/);
});

test("the booked line says the merge was complete only when no Sue's copy kept a token", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "inbox-merge-"));
  try {
    const sue = (name, email) => {
      const dir = path.join(root, name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, `${ARRIVAL_ID}.json`), JSON.stringify(email));
    };
    sue("sue-a", fillMerge(TEMPLATE, { first_name: "Sam", event_name: "Tuesday trivia", where_found: "Facebook" }).email);
    sue("sue-b", fillMerge(TEMPLATE, { first_name: "Mateo", event_name: "cumbia band show", where_found: "Eventbrite" }).email);
    const done = inboxTestRecord(root, TEMPLATE, { runId: "r1", audience: "cold" });
    assert.equal(done.record.mergeComplete, true);
    assert.equal(done.record.perSueMerge, true);
    sue("sue-c", { ...TEMPLATE });
    assert.equal(inboxTestRecord(root, TEMPLATE, { runId: "r1", audience: "cold" }).record.mergeComplete, false, "one Sue kept a {token}");
    assert.equal(
      inboxTestRecord(root, { ...TEMPLATE, subject: "Hello", text: "Hello" }, { runId: "r2", audience: "cold" }).record.mergeComplete,
      false,
      "no token, nothing was merged",
    );
  } finally {
    removeTreeNoFollow(root);
  }
});
