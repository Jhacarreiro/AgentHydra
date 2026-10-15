// fk-grade-short-blocks.spec.mjs - pins the fix for finding
// `sue-body-fk-grade-short-blocks` (docs/todo/improvements/tooling/sue-opus55-review-findings-
// 2026-09-22.md, "HIGH - Flesch-Kincaid applied to one- and two-word blocks marks ordinary headings
// hard to read for every persona").
//
// The fix exported `isGradeable(text)` from lib/readability.mjs and made perceive() treat an
// ungradeable block as grade 0, so a short heading, label, list item or cell can never trip a
// persona's `readingGrade` dial. Reverting the fix either removes the export (this file fails to
// import) or restores the old `grade = fleschKincaidGrade(block.text)` line, which grades
// "Notifications" at 43.8 and tags it `[this is hard to read - ...]` for every Sue - both asserted
// against below. No browser, no CLI, no network: isGradeable and perceive are pure.
import assert from "node:assert/strict";
import { test } from "node:test";

import { perceive } from "../lib/perception.mjs";
import { isGradeable } from "../lib/readability.mjs";

// A wall of legalese: one long sentence, above grade 14, so it stays hard for any persona.
const LEGALESE =
  "Notwithstanding anything to the contrary contained herein, the aforementioned indemnification " +
  "obligations shall survive termination of this agreement indefinitely, and the parties " +
  "acknowledge that any purported waiver of the foregoing provisions must be evidenced by a " +
  "written instrument executed by an authorized representative of each respective party.";

test("isGradeable refuses short headings and labels", () => {
  assert.equal(isGradeable("Notifications"), false, "one word is never gradeable");
  assert.equal(isGradeable("Community events"), false, "two words are never gradeable");
  assert.equal(isGradeable("Sign in"), false);
  assert.equal(isGradeable("Adivina primero. No cuenta para tu calificación."), false, "two sentences of seven words are a chip, not prose");
  assert.equal(isGradeable(""), false);
  assert.equal(isGradeable("   "), false);
});

test("isGradeable accepts a long block and a two-sentence block", () => {
  assert.equal(isGradeable(LEGALESE), true, "a twelve-plus-word block is gradeable");
  assert.equal(isGradeable("The cat sat on the mat. It was a sunny day."), true, "two sentences are gradeable");
  // One long word cannot reach the word-count threshold, so a single short sentence stays out.
  assert.equal(isGradeable("Supercalifragilisticexpialidocious"), false);
});

test("perceive(): a short heading is never marked hard to read, for any persona", () => {
  const inventory = {
    url: "http://localhost/",
    title: "t",
    scroll: { y: 0, max: 0 },
    blocks: [
      { id: "1", kind: "heading", level: 1, text: "Notifications", fontPx: 40, wordCount: 1 },
      { id: "2", kind: "heading", level: 2, text: "Community events", fontPx: 30, wordCount: 2 },
      { id: "3", kind: "paragraph", text: LEGALESE, fontPx: 16, wordCount: 46 },
    ],
    elements: [],
  };
  // The lowest readingGrade in the persona set (Child Sue, 3): even she must not choke on a heading.
  const view = perceive(inventory, { dials: { readingGrade: 3, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } });

  const lines = view.text.split("\n");
  const headingLines = lines.filter((line) => line.includes("Notifications") || line.includes("Community events"));
  assert.deepEqual(headingLines, ["Notifications", "Community events"], "each heading is read as its own words, untagged");
  assert.equal(view.stats.overHead, 1, "only the long block counts against the dial, not the headings");
  // The long legalese block is still graded and still tripped: the fix narrows by length, not stops grading.
  const legalLine = lines.find((line) => line.includes("Notwithstanding"));
  assert.match(legalLine, /hard to read/, "a long block above her grade is still tagged");
  assert.equal(view.stats.overHead, 1, "exactly the long block is over head");
});
