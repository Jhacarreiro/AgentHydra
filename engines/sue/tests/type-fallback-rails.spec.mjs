/**
 * type-fallback-rails.spec - type's last-resort tap meets the rails a click meets.
 * ==================================================================================================
 *
 * WHAT: `node --test sue/tests/type-fallback-rails.spec.mjs`. `typeTapRail` is the rail `type`
 * runs when `fill()` will not take the words and it would otherwise tap the element. The tap only
 * puts the keyboard in a text box, so any other role (a button, a link, a checkbox, a drop-down, or
 * an input[type=submit|button|reset|image], which still wears role `input`) is refused as
 * `not-a-text-box`, a robot check as `captcha`, and a control that leaves the site as `off-host`.
 * Everything else is null, so a plain text box, textarea or search box is still typeable.
 *
 * WHY IT EXISTS: finding `sue-body-type-fallback-click-bypasses-rails` (review 2026-09-22). When
 * `fill()` threw - which it always does on a button, link or checkbox - the catch block clicked the
 * element with no rail at all, so a mistyped `[n]` or a by-words match on a "Delete server" button
 * pressed it. `typeTapRail` is the refusal that stands in for the click rails a tap never runs.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { notABoxSaid, typeTapRail } from "../body.mjs";

test("a drop-down drawn from a button is named as a list, not refused as a mystery", () => {
  // Run 20260922-224205-261f: old-sue aimed her birthday at the kit's Month picker, was told it was
  // "not a box to type in", and filed the form as broken.
  const month = { role: "button", name: "Month", listTrigger: true };
  assert.equal(typeTapRail(month), "not-a-text-box", "still never tapped by type");
  assert.match(notABoxSaid(month, "[2]"), /is a drop-down list, not a box to type in\. Click it to open its choices/);
  assert.match(notABoxSaid({ role: "button", name: "Save" }, "[3]"), /is not a box to type in, so a click there is refused/);
});

test("a tap may land only on a box that takes words", () => {
  assert.equal(typeTapRail({ role: "textarea" }), null, "a textarea is a box for her keys");
  assert.equal(typeTapRail({ role: "input" }), null, "an input with no type is a plain text box");
  for (const inputType of ["text", "search", "email", "url", "tel", "password", "number", "date", "time"]) {
    assert.equal(typeTapRail({ role: "input", inputType }), null, inputType);
  }
  for (const role of ["button", "link", "checkbox", "radio", "select", "option", "switch", "menuitem"]) {
    assert.equal(typeTapRail({ role }), "not-a-text-box", role);
  }
});

test("an input that presses rather than takes words is refused, whatever it is named", () => {
  for (const inputType of ["submit", "button", "reset", "image"]) {
    assert.equal(typeTapRail({ role: "input", inputType }), "not-a-text-box", inputType);
  }
  assert.equal(typeTapRail({ role: "input", inputType: "SUBMIT" }), "not-a-text-box", "case ignored");
});

test("a robot check is refused even in a text box, and so is a control that leaves the site", () => {
  assert.equal(typeTapRail({ role: "input", name: "Enter the captcha" }), "captcha");
  assert.equal(typeTapRail({ role: "textarea", labelText: "I am human" }), "captcha");
  assert.equal(typeTapRail({ role: "input" }, { href: "https://evil.example/steal", allowedHosts: ["example.com"] }), "off-host");
  assert.equal(typeTapRail({ role: "input" }, { href: "", allowedHosts: ["example.com"] }), null, "no address, no trip");
  assert.equal(typeTapRail({ role: "input" }, { href: "https://example.com/next", allowedHosts: ["example.com"] }), null);
});

test("the refusals keep their order: a non-box is refused before its captcha name or address is read", () => {
  assert.equal(typeTapRail({ role: "button", name: "captcha" }), "not-a-text-box");
  assert.equal(typeTapRail({ role: "link" }, { href: "https://evil.example/x", allowedHosts: ["example.com"] }), "not-a-text-box");
  assert.equal(
    typeTapRail({ role: "input", name: "captcha" }, { href: "https://evil.example/x", allowedHosts: ["example.com"] }),
    "captcha",
  );
});
