/**
 * unsure-rest.spec - a phrase she is unsure about is rested on in its own words, wherever it sits in a longer
 * paragraph below the fold, for 3x its reading time (5 s at least), and the pointer then leaves the text.
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import {
  matchThoughtInView,
  quotesRun,
  restOnPhrase,
  restOnThought,
  UNSURE_REST_MAX_MS,
  UNSURE_REST_MIN_MS,
  unsureRestMs,
} from "../lib/rest-on-text.mjs";

const PHRASE = "Premium from $7.99 a month per server";

test("unsureRestMs is the reading time plus a pause of 4 s at most, kept between 1.5 s and 12 s", () => {
  assert.equal(unsureRestMs("two", { wordsPerMinute: 200, pauseMs: 0 }), UNSURE_REST_MIN_MS);
  assert.equal(unsureRestMs(new Array(12).fill("word").join(" "), { wordsPerMinute: 200 }), 4_600);
  assert.equal(
    unsureRestMs(new Array(12).fill("word").join(" "), { wordsPerMinute: 200, pauseMs: 9_000 }),
    7_600,
    "the pause is held to 4 s",
  );
  assert.equal(unsureRestMs(new Array(60).fill("word").join(" "), { wordsPerMinute: 200 }), UNSURE_REST_MAX_MS);
});

test("a thought rests in view first and goes back up only on a three-word quote", () => {
  const above = { i: 0, above: true, text: "Our pricing explained for every server owner" };
  const seen = { i: 1, above: false, text: "Pricing explained for every server owner today" };
  assert.equal(quotesRun("pricing for owners", above.text), false);
  assert.equal(quotesRun("what is pricing explained for", above.text), true);
  assert.equal(matchThoughtInView("pricing explained for every server owner", [above, seen])?.index, 1);
  assert.equal(matchThoughtInView("pricing for owners is vague", [above]), null);
  assert.equal(matchThoughtInView("our pricing explained for every server owner", [above])?.index, 0);
});

test(
  "an unsure phrase inside a long paragraph below the fold gets a rest on the words as long as it takes to read plus a pause, then the pointer leaves",
  { timeout: 60_000 },
  async (t) => {
    if (!resolveChromiumPath()) {
      t.skip("no Chromium on this machine");
      return;
    }
    const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
    try {
      const page = await browser.newPage({ viewport: { width: 1000, height: 600 } });
      const filler = `<div style="height:1800px">filler</div>`;
      await page.setContent(
        `<body style="margin:0">${filler}<p style="width:600px;font-size:16px">Example App has a free plan for small servers and a paid tier for larger communities that want more. ${PHRASE}, billed yearly, so check what your members need before you commit to anything at all.</p></body>`,
      );
      const old = await restOnThought(page, PHRASE, { wordsPerMinute: 200, maxMs: 1000 });
      assert.equal(old, 1000, "a thought that quotes nothing rests on no text: its time passes with the pointer parked off it");
      await page.evaluate(() => {
        window.__m = [];
        addEventListener("mousemove", (e) => window.__m.push([e.clientX, e.clientY]));
      });
      const started = Date.now();
      const rested = await restOnPhrase(page, PHRASE, { wordsPerMinute: 200 });
      const real = Date.now() - started;
      assert.ok(rested >= 3000 && real >= 3000, `rested ${rested} ms (real ${real})`);
      assert.ok((await page.evaluate(() => window.scrollY)) > 1000, "scrolled the phrase into view");
      const path = await page.evaluate(() => window.__m);
      assert.ok(
        path.some(([, y]) => y > 50),
        "the pointer went to the words",
      );
      assert.equal(path.at(-1)[1], 4, "then left the text");
      assert.equal(await restOnPhrase(page, "words that are not on this page at all", {}), 0);
    } finally {
      await browser.close();
    }
  },
);
