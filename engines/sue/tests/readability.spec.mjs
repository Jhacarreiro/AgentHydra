// readability.spec.mjs - spec for lib/readability.mjs (see that file's header for why it exists).
// Asserts the syllable heuristic against known words and the grade formula against a plain
// sentence, a Dr.-Seuss-simple one, and the legalese fixture shared with perception.spec.mjs -
// the gap between "plain" and "legalese" is what perception.mjs's readingGrade dial leans on.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { countSyllables, fleschKincaidGrade } from "../lib/readability.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

test("countSyllables matches known words", () => {
  assert.equal(countSyllables("cat"), 1);
  assert.equal(countSyllables("banana"), 3);
  assert.equal(countSyllables("table"), 2);
  assert.equal(countSyllables("like"), 1);
  assert.equal(countSyllables("beautiful"), 3);
  assert.equal(countSyllables(""), 0);
});

test("fleschKincaidGrade reads a plain sentence as low grade", () => {
  const grade = fleschKincaidGrade("The cat sat on the mat. It was a sunny day.");
  assert.ok(grade < 5, `expected a low grade, got ${grade}`);
});

test("fleschKincaidGrade reads empty text as grade 0", () => {
  assert.equal(fleschKincaidGrade(""), 0);
  assert.equal(fleschKincaidGrade("   "), 0);
});

test("fleschKincaidGrade reads the legalese fixture as grade 14 or higher", async () => {
  const html = await readFile(path.join(here, "fixtures", "pages", "legalese.html"), "utf8");
  const paragraphs = [...html.matchAll(/<p>([\s\S]*?)<\/p>/g)].map((m) => m[1].replace(/\s+/g, " ").trim());
  assert.ok(paragraphs.length >= 2, "fixture should have at least two paragraphs");
  for (const paragraph of paragraphs) {
    const grade = fleschKincaidGrade(paragraph);
    assert.ok(grade >= 14, `expected legalese paragraph to grade >= 14, got ${grade}: ${paragraph}`);
  }
});
