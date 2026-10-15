/**
 * parking-spot.spec - after a rest or a reading her pointer parks on empty page space, never on a link or button:
 * a pointer left on "See pricing" read as "hovered, did not click" (run 20261011-135200-ca7a: link_hover of 3.7 s on a
 * call to action she clicked a moment later).
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { restWhileReading, seededRandom } from "../lib/reading-pace.mjs";
import { restOnPhrase } from "../lib/rest-on-text.mjs";

const CONTROL = "a, button, [role=button], input, select, textarea, label, summary, [onclick], [tabindex]";
// A nav link fills the top strip (where the old parking point, the top middle, sat); a link follows the words; a second
// paragraph is covered edge to edge by a link, so the pointer has nowhere on it that is not the link.
const PAGE = `<body style="margin:0"><a href="#top" style="position:fixed;top:0;left:0;width:100%;height:30px;background:#eee">Menu</a>
<div style="padding:60px 40px"><p id="hero" style="width:500px">Free on every server. Premium from $7.99 a month per server, with a 7-day free trial. <a href="#p">See pricing</a></p>
<p style="position:relative;width:500px">Covered words that a link sits over completely.<a href="#c" style="position:absolute;inset:0">Cover</a></p></div></body>`;

// Passing over a control on the way is a flick, not a hover: only a point the pointer then stayed on for 300 ms counts.
const sat = (seen) => seen.filter((p, i) => (seen[i + 1] ? seen[i + 1].at - p.at : 1000) >= 300);

async function trackedPage(browser) {
  const page = await browser.newPage({ viewport: { width: 900, height: 600 } });
  await page.setContent(PAGE);
  await page.evaluate((control) => {
    window.__over = [];
    addEventListener("mousemove", (e) => {
      const el = document.elementFromPoint(e.clientX, e.clientY);
      window.__over.push({ x: e.clientX, y: e.clientY, at: Date.now(), control: Boolean(el && el.closest(control)) });
    });
  }, CONTROL);
  return page;
}

test("a rest on words parks on empty space, and a reading parks there too, never on a link", { timeout: 60_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
  try {
    const page = await trackedPage(browser);
    const rested = await restOnPhrase(page, "Premium from $7.99 a month per server, with a 7-day free trial.", { wordsPerMinute: 200 });
    assert.ok(rested >= 5000, `the words were rested on (${rested} ms)`);
    let seen = await page.evaluate(() => window.__over);
    assert.ok(seen.length > 0, "the pointer moved");
    const last = seen.at(-1);
    assert.equal(last.control, false, "it parked on empty space");
    assert.ok(last.y > 4 || last.x !== 450, "and not on the top-middle spot the nav link covers");
    const onWords = seen.filter((p) => p.y > 60);
    assert.ok(onWords.length > 0 && onWords.every((p) => p.control === false || p.y > 0), "it went to the words");

    await page.evaluate(() => (window.__over = []));
    await restWhileReading(page, 3000, { random: seededRandom("x"), wordsPerMinute: 200 });
    seen = await page.evaluate(() => window.__over);
    assert.ok(seen.length > 0, "the reading moved the pointer");
    assert.equal(seen.at(-1).control, false, "and left it on empty space");

    await page.evaluate(() => (window.__over = []));
    const covered = await restOnPhrase(page, "Covered words that a link sits over", { wordsPerMinute: 200 });
    assert.equal(covered, 0, "words wholly under a link are not rested on");
    assert.ok(
      (await page.evaluate(() => window.__over)).every((p) => p.control === false),
      "and the pointer never sat on that link",
    );
  } finally {
    await browser.close();
  }
});

test("a thought that names a link's text rests on the paragraph, never on the link", { timeout: 60_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const { restOnThought } = await import("../lib/rest-on-text.mjs");
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
  try {
    const page = await trackedPage(browser);
    await page.evaluate(() => (window.__over = []));
    const rested = await restOnThought(page, "Let me see pricing", { wordsPerMinute: 200 });
    const seen = await page.evaluate(() => window.__over);
    assert.ok(
      seen.every((p) => p.control === false),
      "the pointer never sat on a control",
    );
    if (rested > 0)
      assert.ok(
        seen.some((p) => p.y > 60),
        "a rest that happened was on non-control text",
      );
    const hero = await restOnThought(
      page,
      '"Free on every server. Premium from $7.99 a month per server, with a 7-day free trial." See pricing',
      { wordsPerMinute: 200 },
    );
    assert.ok(hero > 0, "a thought quoting the paragraph rests on it");
    assert.ok(
      sat(await page.evaluate(() => window.__over)).every((p) => p.control === false),
      "and still never on a control",
    );
  } finally {
    await browser.close();
  }
});
