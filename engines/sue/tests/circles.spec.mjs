// circles.spec.mjs - spec for lib/circles.mjs (see that file's header for why it exists).
// Pins when a Sue is told she is going round in circles: the same move on one page at the 5th, 8th
// and 12th time, a page that stays the same across her moves, and the reads that must NOT count
// (a renumbered control is the same control, looks with no move between, scrolling, a page that moved,
// a form filled field by field), and a back-and-forth between 2 to 4 moves repeated whole.
import assert from "node:assert/strict";
import { test } from "node:test";

import { circleWatch, moveKey, moveLabel, pageFingerprint } from "../lib/circles.mjs";

const page = (words) => pageFingerprint("https://site.test/signup", 12, words);

test("the same click on one page nudges at 5, 8 and 12, firmer each time, and never before", () => {
  const watch = circleWatch();
  watch.page(page("Sign up"));
  const fired = [];
  for (let i = 1; i <= 12; i += 1) {
    const circled = watch.move(moveKey("click", { target: "Continue" }));
    if (circled) fired.push([i, circled.why, circled.nudge]);
  }
  assert.deepEqual(
    fired.map(([i, why]) => [i, why]),
    [
      [5, "same-move"],
      [8, "same-move"],
      [12, "same-move"],
    ],
  );
  assert.notEqual(fired[0][2], fired[2][2], "the nudge grows firmer");
  assert.match(fired[2][2], /give_up/);
});

test("a control renumbered by a new look is still the same control", () => {
  const before = moveKey("click", { target: 3 }, new Map([[3, "Continue"]]));
  const after = moveKey("click", { target: "[7]" }, new Map([[7, "Continue"]]));
  assert.equal(before, after);
  assert.equal(moveKey("type", { target: 2, text: "red shoes" }), moveKey("type", { target: "2", text: "Shoes  RED" }));
});

test("the same button through pages that change is moving on, not circling", () => {
  const watch = circleWatch();
  for (let step = 1; step <= 12; step += 1) {
    watch.page(page(`Step ${step} of 12`));
    assert.equal(watch.move(moveKey("click", { target: "Next" })), null);
  }
});

test("scrolling down a long page is reading, never a repeat", () => {
  const watch = circleWatch();
  watch.page(page("A long page"));
  for (let i = 0; i < 12; i += 1) assert.equal(watch.move(moveKey("scroll", { direction: "down" })), null);
});

test("a page that stays the same after she types and presses Continue is flagged at the 5th unchanged look", () => {
  const watch = circleWatch();
  assert.equal(watch.page(page("Email: [ ] Continue")), null);
  const seen = [];
  for (let i = 1; i <= 5; i += 1) {
    watch.move(moveKey("type", { target: 1, text: `try ${i}` }));
    watch.move(moveKey("click", { target: "Continue" }));
    seen.push(watch.page(page("Email: [ ] Continue")));
  }
  assert.deepEqual(
    seen.map((c) => c?.why ?? null),
    [null, null, null, null, "page-unchanged"],
  );
  assert.equal(seen[4].times, 5);
});

test("filling a form field by field, looking after each, is not an unchanged page", () => {
  // A typed value is not in the words her look reads, so every look shows the same fingerprint.
  const watch = circleWatch();
  assert.equal(watch.page(page("Name [ ] Email [ ] Phone [ ] City [ ] Zip [ ] Continue")), null);
  for (const [field, text] of [
    ["Name", "Sue Smith"],
    ["Email", "sue@site.test"],
    ["Phone", "555 0100"],
    ["City", "Springfield"],
    ["Zip", "12345"],
  ]) {
    assert.equal(watch.move(moveKey("type", { target: field, text })), null);
    assert.equal(watch.page(page("Name [ ] Email [ ] Phone [ ] City [ ] Zip [ ] Continue")), null);
  }
});

test("scrolling a page that cannot scroll, looking after each, is not an unchanged page", () => {
  const watch = circleWatch();
  watch.page(page("A short page"));
  for (let i = 0; i < 12; i += 1) {
    watch.move(moveKey("scroll", { direction: "down" }));
    assert.equal(watch.page(page("A short page")), null);
  }
});

test("looking again without doing anything is not an unchanged page", () => {
  const watch = circleWatch();
  for (let i = 0; i < 12; i += 1) assert.equal(watch.page(page("Welcome")), null);
});

test("the finding's label drops her typed words and an address's query", () => {
  assert.equal(moveLabel(moveKey("type", { target: "Email", text: "me@example.test" })), "type|email");
  assert.equal(moveLabel(moveKey("go_to", { address: "https://site.test/in?token=abc" })), "go_to|https://site.test/in");
  assert.equal(moveKey("look", {}), null);
  assert.equal(moveKey("note", { kind: "thought", text: "hm" }), null);
});

const press = (name) => moveKey("click", { target: name });

/** Every [move number, why, times, cycle] a watch on one page answers for these clicks. */
function answersFor(names) {
  const watch = circleWatch();
  watch.page(page("Settings"));
  const fired = [];
  names.forEach((name, i) => {
    const circled = watch.move(press(name));
    if (circled) fired.push([i + 1, circled.why, circled.times, circled.cycle, circled.nudge]);
  });
  return fired;
}

test("going back and forth between two controls is a cycle at her 4th move, then at the 6th and 8th, firmer each time", () => {
  const fired = answersFor(["Light", "Dark", "Light", "Dark", "Light", "Dark", "Light", "Dark"]);
  assert.deepEqual(
    fired.map(([i, why, times, cycle]) => [i, why, times, cycle]),
    [
      [4, "cycle", 2, [press("Light"), press("Dark")]],
      [6, "cycle", 3, [press("Light"), press("Dark")]],
      [8, "cycle", 4, [press("Light"), press("Dark")]],
    ],
  );
  assert.notEqual(fired[0][4], fired[1][4], "the nudge grows firmer");
  assert.match(fired[2][4], /give_up/);
});

test("a round of three controls repeated whole is a cycle at her 6th move, and never before", () => {
  const fired = answersFor(["Back", "Edit", "Save", "Back", "Edit", "Save"]);
  assert.deepEqual(
    fired.map(([i, why, times, cycle]) => [i, why, times, cycle]),
    [[6, "cycle", 2, [press("Back"), press("Edit"), press("Save")]]],
  );
});

test("when the same move and a back-and-forth land on one move, the same move is the answer and no cycle comes earlier", () => {
  // "Next" pressed between other controls, then twice against "Prev": the 10th move is both the 5th
  // "Next" and the 2nd round of Prev/Next.
  const fired = answersFor(["Next", "Help", "Next", "Home", "Next", "Menu", "Prev", "Next", "Prev", "Next"]);
  assert.deepEqual(
    fired.map(([i, why, times]) => [i, why, times]),
    [[10, "same-move", 5]],
  );
});
