/**
 * inbox-page.spec - a Sue's inbox, opened as a real page: what she sees, and that a hostile email
 * cannot write into the header the body puts above it.
 *
 * WHAT: `node --test sue/tests/inbox-page.spec.mjs`. Pure functions only; the live route is
 * proven end to end in hands.spec.mjs (open_email, look, judge_email in a real browser).
 * WHY: until 2026-09-22 she only ever got an email as tag-stripped text, so nobody could say what
 * she thought of the email a person actually receives.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { INBOX_HOST, isInboxUrl, messageIdOf, messageUrl, phoneBuzz, renderMessagePage } from "../lib/inbox-page.mjs";

test("an HTML email is served as its sender wrote it, with a mail client's header inside its body", () => {
  const page = renderMessagePage(
    {
      from: "Connections <noreply@api.example.com>",
      subject: "Your code",
      html: '<html><body class="x"><h1>Hi Karen</h1></body></html>',
    },
    { receivedLabel: "8 seconds ago" },
  );
  assert.match(page, /<body class="x"><header data-sue-inbox-header/, "the header sits just inside the email's own body");
  assert.match(page, /<h1>Hi Karen<\/h1>/, "the email itself is untouched");
  assert.match(page, /8 seconds ago/);
});

test("a text-only email is shown as its text, never as markup", () => {
  const page = renderMessagePage({ from: "a@b.c", subject: "Plain", text: "Enter 123456 <b>now</b>" });
  assert.match(page, /<pre[^>]*>Enter 123456 &lt;b&gt;now&lt;\/b&gt;<\/pre>/);
});

test("the sender and subject are escaped, so an email cannot forge the header above it", () => {
  const page = renderMessagePage({ from: '"><script>alert(1)</script>', subject: "<img src=x onerror=alert(1)>", text: "x" });
  assert.doesNotMatch(page, /<script>alert/);
  assert.doesNotMatch(page, /<img src=x/);
});

test("the page lives on a reserved name that can never be anybody's real server", () => {
  assert.ok(INBOX_HOST.endsWith(".invalid"), "RFC 2606 reserves .invalid");
  assert.equal(isInboxUrl(messageUrl("abc")), true);
  assert.equal(isInboxUrl("https://example.com/"), false);
  assert.equal(isInboxUrl("not a url"), false);
});

test("a message is addressed by its own file id, on either path separator", () => {
  assert.equal(messageIdOf({ _file: "C:\\runs\\mail\\sue@x\\2gff218o6ija.json" }), "2gff218o6ija");
  assert.equal(messageIdOf({ _file: "/runs/mail/sue@x/0001.json" }), "0001");
  assert.equal(messageUrl("a b"), `https://${INBOX_HOST}/message/a%20b`);
});

test("her phone buzzes once for each email she has not been told about, and names it", () => {
  const announced = new Set();
  const code = { _file: "/m/0001.json", from: "Connections <noreply@api.example.com>", subject: "Your code" };
  const welcome = { _file: "/m/0002.json", from: "Connections", subject: "Welcome" };
  assert.equal(phoneBuzz([], announced), "", "no mail, no buzz");
  assert.equal(
    phoneBuzz([code], announced),
    'Your phone buzzed: a new email - "Your code" from Connections <noreply@api.example.com>. check_email shows your inbox.',
  );
  assert.equal(phoneBuzz([code], announced), "", "the same email never buzzes twice");
  assert.match(phoneBuzz([welcome, code], announced), /a new email - "Welcome"/, "only the new one");
  announced.clear();
  assert.match(phoneBuzz([welcome, code], announced), /^Your phone buzzed: 2 new emails - "Welcome" from Connections, "Your code"/);
});

test("her phone never buzzes for the message that sent her: it is already on her screen", () => {
  const announced = new Set();
  const seeded = { _file: "mail/sue@x/seeded-arrival.json", subject: "our group", from: "Dan", seeded: true };
  assert.equal(phoneBuzz([seeded], announced), "");
  const real = { _file: "mail/sue@x/abc.json", subject: "Your code", from: "Connections" };
  assert.match(phoneBuzz([real, seeded], announced), /a new email - "Your code"/);
});
