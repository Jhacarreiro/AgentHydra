/**
 * inbox-door.spec - the inbox_test door refuses a request it cannot test, before any Sue is started.
 *
 * WHAT: `node --test --test-concurrency=1 sue/tests/inbox-door.spec.mjs`. Each refusal is checked
 * through dispatch(), the same door the CLI and the MCP call.
 * WHY: a test that starts with no unsubscribe-free link, or an audience nobody chose, would bill Sues for a
 * verdict that means nothing.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Refusal, dispatch } from "../sue.mjs";

const EMAIL = {
  from: "Connections <news@api.example.com>",
  subject: "This week",
  html: '<p>Hi</p><a href="https://api.example.com/unsub?t=abc">unsubscribe</a>',
  headers: { "List-Unsubscribe": "<https://api.example.com/unsub?t=abc>" },
};

test("the inbox test refuses an email with no link to anywhere but its unsubscribe address", () => {
  assert.throws(
    () => dispatch("inbox_test", { audience: "cold", email: EMAIL }),
    (error) => error instanceof Refusal && /no link/.test(error.message),
  );
});

test("the inbox test refuses an audience that is neither cold nor known", () => {
  const email = { ...EMAIL, html: '<a href="https://api.example.com/home">home</a>' };
  assert.throws(
    () => dispatch("inbox_test", { audience: "vip", email }),
    (error) => error instanceof Refusal && /audience/.test(error.message),
  );
});

test("the inbox test refuses an email without a sender, subject or body", () => {
  assert.throws(
    () => dispatch("inbox_test", { audience: "cold", email: { subject: "Hi", html: "<p>x</p>" } }),
    (error) => error instanceof Refusal && /from, subject/.test(error.message),
  );
});
