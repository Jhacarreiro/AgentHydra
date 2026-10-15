// words-target-behind-overlay.spec.mjs - spec for pickByWords (review finding
// sue-body-words-target-behind-overlay). Targeting by words used to take the FIRST element whose
// accessible name merely CONTAINED the words - so "delete" landed on an earlier "Delete account" -
// and it walked the whole visible inventory, so it could pick a control perception.mjs had withheld
// for standing behind a dialog (`behindOverlay`); the click then hit the scrim and handOn's retries
// filed the button as broken. The fix matches exactly first, never returns a control behind an
// overlay, and names that overlay as `{ blocked }`. No browser needed: pickByWords is a pure
// function over plain element records (seenWords, perception.mjs).
import assert from "node:assert/strict";
import { test } from "node:test";

import { numberBlocked, pickByWords } from "../body.mjs";

const button = (id, seenText, extra = {}) => ({ id, role: "button", hasVisibleText: true, seenText, ...extra });

test("an exact name beats an earlier one that merely contains the words", () => {
  const elements = [button(1, "Delete account"), button(2, "Delete")];
  assert.equal(pickByWords(elements, "delete").el.id, 2, '"delete" is the button that SAYS it, not "Delete account"');
});

test("when only a containing name exists, that one is still picked", () => {
  const elements = [button(1, "Delete account")];
  assert.equal(pickByWords(elements, "delete").el.id, 1);
});

test("a control behind a dialog or scrim is never picked, and its overlay is named", () => {
  const elements = [button(7, "Delete", { behindOverlay: "Are you sure you want to delete?" })];
  const pick = pickByWords(elements, "delete");
  assert.equal(pick.el, undefined, "the click would hit the scrim, not the withheld button");
  assert.deepEqual(pick, { blocked: "Are you sure you want to delete?" });
});

test("a hidden control is never picked and is not reported as blocked", () => {
  const elements = [button(7, "Delete", { hidden: true })];
  assert.equal(pickByWords(elements, "delete"), null, "a hidden label never matches (seenWords)");
});

test("a reachable partial match wins over an exact one withheld behind an overlay", () => {
  const elements = [button(1, "Delete account"), button(7, "Delete", { behindOverlay: "Confirm" })];
  assert.equal(pickByWords(elements, "delete").el.id, 1);
});

test("nothing saying the words returns null", () => {
  assert.equal(pickByWords([button(1, "Save")], "delete"), null);
  assert.equal(pickByWords([], "delete"), null);
  assert.equal(pickByWords(undefined, "delete"), null);
});

test("a choice card whose words carry a hint line is still found by its label", () => {
  // Run 20260923-060828-9797: "Memoir" on a card that reads "Memoir Your own life".
  const card = { id: 9, role: "radio", hasVisibleText: true, seenText: "Memoir Your own life" };
  assert.equal(pickByWords([card], "memoir").el.id, 9);
});

test("a number from before a dialog opened is refused at once, naming the dialog in front of it", () => {
  // Run 20260922-224205-261f: elaine typed into [63] "Ends" while the Starts date picker she had just
  // opened stood over it; the hand waited 8 s on the scrim and she filed "the date picker ate my input".
  const ends = button(63, "Ends", { behindOverlay: "Pick a date October 2026 Cancel OK" });
  assert.match(numberBlocked(ends, 63), /^\[63\] "Ends" is behind "Pick a date October 2026 Cancel OK" now - deal with that first/);
  assert.equal(numberBlocked(button(63, "Ends"), 63), null, "nothing in front of it: the hand goes ahead");
  assert.equal(numberBlocked(null, 63), null);
});
