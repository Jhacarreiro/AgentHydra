// text-box-not-a-press.spec.mjs - spec for finding
// `sue-body-rails-text-input-treated-as-press` (review 2026-09-22, section "MEDIUM - NOT_A_PRESS
// omits role 'input'"). `NOT_A_PRESS` in rails.mjs lacked "input", so a borrowed account refused a
// press on a box to type in ("Invite by email") as a real change - it only takes focus. The same fix
// also taught the inventory that a native input which DOES act when pressed (submit, button, image,
// reset) is a press, read as role "button", so its words still meet the rail.
//
// No browser, no Claude CLI, no network: `refusedBy` is pure, and the inventory script (a string) is
// run against a jsdom DOM.
//
// WHAT: `node --test sue/tests/text-box-not-a-press.spec.mjs`. A press on
// role "input" is not a press; a press on a submit input still is.
//
// WHY IT EXISTS: `lib/rails.mjs`' header - the borrowed real-change rail names what a hand presses,
// and a box to type in is not one.
//
// WHO DEPENDS ON IT: nothing imports it.
import assert from "node:assert/strict";
import { test } from "node:test";

import { JSDOM } from "jsdom";

import { INVENTORY_SCRIPT } from "../lib/perception.mjs";
import { railsFor, refusedBy } from "../lib/rails.mjs";

test("a borrowed account refuses a press on a button but not on a box to type in", () => {
  const rails = railsFor({ borrowed: true });
  assert.equal(
    refusedBy(rails, "Invite by email", { role: "input" }),
    null,
    "a press on a box to type in only focuses it; it changes nothing until something is saved",
  );
  assert.equal(
    refusedBy(rails, "Invite by email", { role: "button" }),
    "real-change",
    "the submit it focuses is still a press and still meets the borrowed rail",
  );
});

test("the inventory reads a submit input as a button and a text input as a box, and the rails follow", () => {
  const dom = new JSDOM(
    "<!doctype html><html><body><form>" +
      '<input type="submit" aria-label="Invite by email" value="Invite">' +
      '<input type="text" aria-label="Invite by email">' +
      "</form></body></html>",
    { runScripts: "outside-only" },
  );
  const { window } = dom;
  // The page's own DOM in jsdom reports a 0x0 rect for everything, which the inventory reads as
  // invisible; give every control a face, and let hit-testing answer null (nothing covers it).
  window.Element.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 100, height: 30, top: 0, left: 0, right: 100, bottom: 30 });
  window.document.elementFromPoint = () => null;

  const elements = window.eval(INVENTORY_SCRIPT).elements;
  const submit = elements.find((el) => el.inputType === "submit");
  const box = elements.find((el) => el.inputType === "text");
  assert.ok(submit, "the submit input must be numbered");
  assert.ok(box, "the text input must be numbered");

  assert.equal(submit.role, "button", "an input that acts when pressed reads like a button");
  assert.equal(box.role, "input", "a box to type in reads as a box");

  const rails = railsFor({ borrowed: true });
  assert.equal(refusedBy(rails, submit.name, { role: submit.role }), "real-change", "the submit's words are refused");
  assert.equal(refusedBy(rails, box.name, { role: box.role }), null, "the box's words, though identical, are not");
});
