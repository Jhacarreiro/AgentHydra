/**
 * rest-on-split-price.spec - a price drawn as "$9.99" plus <small>/month</small> (two text nodes, one word) is found by
 * restOnPhrase, so her pointer rests on it; and the look ask tells her to quote earlier words that this screen contradicts.
 * (Run 20261011-225427-a4cc: her lingered "$9.99/month" rested 18 ms, nothing for ARGUS to see.)
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import "./fixtures/people.mjs";
import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { UNSURE_OWED } from "../body.mjs";
import { restOnPhrase } from "../lib/rest-on-text.mjs";

test("restOnPhrase rests on a price split across an inline <small>", { timeout: 60_000 }, async (t) => {
  const executablePath = resolveChromiumPath();
  if (!executablePath) return t.skip("no Chromium on this machine");
  const browser = await chromium.launch({ headless: true, executablePath });
  try {
    const page = await browser.newPage();
    await page.setContent(
      `<body style="margin:40px"><div class="hp-priceblock"><span class="hp-price" style="font-size:40px">$9.99<small>/month</small></span><span> per server</span></div></body>`,
    );
    const rested = await restOnPhrase(page, "$9.99/month", { pauseMs: 0 });
    assert.ok(rested >= 1500, `she rested on the price (${rested} ms)`);
  } finally {
    await browser.close();
  }
});

test("the ask names a contradiction with earlier words as an unsure", () => {
  assert.match(UNSURE_OWED, /contradicts something you read earlier on this page, quote the earlier words as unsure/);
});
