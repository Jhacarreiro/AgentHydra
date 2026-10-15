import { test } from "node:test";
import assert from "node:assert/strict";
import { matchThought, restPlan, thinkRestMs, REST_MAX_MS, REST_MIN_MS } from "../lib/rest-on-text.mjs";

const candidates = [
  { i: 0, text: "Free account", link: false, above: false },
  { i: 1, text: "Pricing plans for small teams", link: false, above: true },
  { i: 2, text: "Start free trial", link: true, above: false },
  { i: 3, text: "Ticket", link: false, above: false },
  { i: 4, text: "Under a minute", link: false, above: false },
];

test("a thought that names on-page text matches that element", () => {
  const m = matchThought("I can't tell whether the free account needs a credit card", candidates);
  assert.equal(m?.index, 0);
});

test("fuzzy word forms still match (minute / minutes)", () => {
  const m = matchThought("it says under a minutes, is that real", candidates);
  assert.equal(m?.index, 4);
});

test("a thought that shares only common words does not match", () => {
  assert.equal(matchThought("I want to know what this is about", candidates), null);
});

test("a one-word element never matches on its own", () => {
  assert.equal(matchThought("the ticket looks odd", candidates), null);
});

test("an empty or unrelated thought matches nothing", () => {
  assert.equal(matchThought("", candidates), null);
  assert.equal(matchThought("bananas orbit saturn", candidates), null);
});

test("a match reports whether the element is a link and whether it is above the fold", () => {
  assert.deepEqual(matchThought("start free trial is where?", candidates), {
    index: 2,
    link: true,
    above: false,
    text: "Start free trial",
  });
  assert.equal(matchThought("pricing plans for small teams cost what", candidates).above, true);
});

test("the plan rests on the matched element for the think time", () => {
  const match = matchThought("is the free account really free", candidates);
  const steps = restPlan(match, { thinkMs: 6_000 });
  assert.deepEqual(steps, [
    { do: "point", index: 0, on: "text" },
    { do: "rest", index: 0, ms: 6_000 },
  ]);
});

test("an element above the viewport is scrolled back to before the pointer moves", () => {
  const match = matchThought("what do the pricing plans for small teams include", candidates);
  const steps = restPlan(match, { thinkMs: 4_000 });
  assert.deepEqual(
    steps.map((s) => s.do),
    ["scroll-up", "point", "rest"],
  );
  assert.equal(steps[2].index, 1);
});

test("a link is hovered, not clicked, and rested on", () => {
  const match = matchThought("what does start free trial do", candidates);
  const steps = restPlan(match, { thinkMs: 3_000 });
  assert.deepEqual(steps[0], { do: "point", index: 2, on: "link" });
  assert.equal(
    steps.some((s) => s.do === "click"),
    false,
  );
});

test("no match means no moves", () => {
  assert.deepEqual(restPlan(null, { thinkMs: 5_000 }), []);
});

test("think time follows the thought's length at the persona's pace, clamped 2-20 s", () => {
  assert.equal(thinkRestMs("ok", { wordsPerMinute: 200 }), REST_MIN_MS);
  const long = Array.from({ length: 200 }, () => "word").join(" ");
  assert.equal(thinkRestMs(long, { wordsPerMinute: 200 }), REST_MAX_MS);
  assert.equal(thinkRestMs("one two three four five six", { wordsPerMinute: 60 }), 6_000);
});
