/**
 * rest-under-fixed-header.spec - an unsure phrase that is a part of a longer line, with a button just below it, and a
 * fixed header that covers the top 70 px. The scroll-back stops with that line's top under the header; the rest must
 * still land the pointer on the line's own text, not give up.
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { restOnPhrase } from "../lib/rest-on-text.mjs";

const PHRASE = "Premium from $7.99 a month per server";
const LINE = "Free on every server. Premium from $7.99 a month per server, with a 7-day free trial.";
const PAGE = `<!doctype html><html><head><title>Pricing</title></head><body style="margin:0">
<div style="position:fixed;top:0;left:0;right:0;height:70px;background:#222"></div>
<div style="height:1000px"></div>
<p id="blk" style="margin:0;font-size:16px;line-height:21px">${LINE}</p>
<button id="buy" style="display:block">Get Premium</button>
<div style="height:900px"></div>
</body></html>`;

test("an unsure phrase under a fixed header is rested on, with the pointer on its own line", { timeout: 120_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath() });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.setContent(PAGE);
    await page.evaluate(() => {
      window.hovered = [];
      document.addEventListener("mouseover", (e) => window.hovered.push(e.target.id || e.target.tagName));
      const blk = document.getElementById("blk");
      window.scrollTo(0, blk.getBoundingClientRect().top + window.scrollY - 30);
    });
    await page.waitForTimeout(300);
    const rested = await restOnPhrase(page, PHRASE, { wordsPerMinute: 200, pauseMs: 2000 });
    const hovered = await page.evaluate(() => window.hovered);
    assert.ok(rested >= 2000, `rested ${rested} ms, expected at least the pause`);
    assert.ok(hovered.includes("blk"), `pointer never rested on the line, saw ${JSON.stringify(hovered)}`);
  } finally {
    await browser.close();
  }
});
