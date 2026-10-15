/**
 * reading-dwell.spec - plain paced reading follows the words: each piece of text on screen is stayed on for its own
 * reading time with a seeded spread, so two Sues dwell differently and a longer text is stayed on longer (run
 * 20261011-133328-e6e0: fifteen dwells all between 2,516 and 2,557 ms, the same three snippets for every visitor).
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { planReadingStays, restWhileReading, seededRandom } from "../lib/reading-pace.mjs";

const items = [{ words: 3 }, { words: 20 }, { words: 80 }, { words: 12 }, { words: 6 }];

test("stays follow each item's own reading time, differ per Sue, are reproducible and fill the wait", () => {
  const a = planReadingStays(items, 20_000, { random: seededRandom("sue-a"), wordsPerMinute: 200 });
  const b = planReadingStays(items, 20_000, { random: seededRandom("sue-b"), wordsPerMinute: 200 });
  assert.notDeepEqual(
    a.map((s) => s.ms),
    b.map((s) => s.ms),
    "two Sues dwell differently",
  );
  assert.deepEqual(a, planReadingStays(items, 20_000, { random: seededRandom("sue-a"), wordsPerMinute: 200 }), "one Sue is reproducible");
  for (const plan of [a, b]) {
    assert.equal(
      plan.reduce((n, s) => n + s.ms, 0),
      20_000,
      "the whole paced wait is spent",
    );
    assert.ok(plan[0].ms < 1500, `a 3-word item gets a short stay (${plan[0].ms} ms)`);
    assert.ok(plan[2].ms > plan[1].ms && plan[1].ms > plan[0].ms, "a longer text is stayed on longer");
  }
  assert.equal(new Set(a.map((s) => s.ms)).size, a.length, "no two stays are the same");
  const cut = planReadingStays(items, 1000, { random: seededRandom("sue-a") });
  assert.equal(cut.reduce((n, s) => n + s.ms, 0), 1000, "a short wait is only spent, never exceeded");
});

test("in a real page the pointer goes through the text in reading order and leaves at the end", { timeout: 60_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
    await page.setContent(
      `<body><h1>Plans for every server</h1><p>${"free ".repeat(4)}</p><p>${"wide ".repeat(40)}</p><p>${"deep ".repeat(15)}</p></body>`,
    );
    await page.evaluate(() => {
      window.__m = [];
      addEventListener("mousemove", (e) => window.__m.push([Math.round(e.clientY), Date.now()]));
    });
    const started = Date.now();
    await restWhileReading(page, 6000, { random: seededRandom("sue-a"), wordsPerMinute: 200 });
    assert.ok(Date.now() - started >= 5900, "the wait is kept");
    const moves = await page.evaluate(() => window.__m);
    const ys = [...new Set(moves.map(([y]) => y))];
    assert.ok(ys.length >= 4, `the pointer visited the text pieces and left (${ys})`);
    assert.equal(moves.at(-1)[0], 4, "then it left the text");
    const down = ys.slice(0, ys.indexOf(Math.max(...ys)) + 1);
    assert.deepEqual(down, [...down].sort((p, q) => p - q), "top to bottom, in reading order");
  } finally {
    await browser.close();
  }
});
