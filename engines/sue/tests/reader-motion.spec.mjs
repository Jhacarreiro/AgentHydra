// reader-motion.spec.mjs - a Sue who reads moves the viewport (so the ARGUS pixel's scroll milestones fire) and a
// visit ends with pagehide + a beacon before the context goes (so engagement time is flushed).
// @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { endVisit, scrollLikeAReader } from "../lib/reader-motion.mjs";

const PAGE = `<!doctype html><title>t</title><body style="margin:0">
<div style="height:6000px">long page</div>
<script>
  window.__y = [0]; window.__hide = [];
  addEventListener('scroll', () => window.__y.push(Math.round(scrollY)));
  const beacon = (k) => navigator.sendBeacon('/beacon?k=' + k, '1');
  addEventListener('pagehide', () => { window.__hide.push('pagehide'); beacon('pagehide'); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { window.__hide.push('hidden'); beacon('hidden'); } });
  if (location.search.includes('hang')) addEventListener('beforeunload', (e) => { e.preventDefault(); e.returnValue = ''; for (const end = Date.now() + 20000; Date.now() < end; ); });
</script>`;

async function withBrowser(t, run) {
  const exe = resolveChromiumPath();
  if (!exe) return t.skip("no Chromium on this machine");
  const beacons = [];
  const server = createServer((req, res) => {
    if (req.url.startsWith("/beacon")) {
      beacons.push(req.url);
      res.writeHead(204).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ executablePath: exe, headless: true });
  try {
    await run({ origin: `http://127.0.0.1:${server.address().port}`, browser, beacons });
  } finally {
    await browser.close().catch(() => {});
    server.close();
  }
}

test("reading the whole page scrolls to the bottom in steps; reading the first screen does not scroll", async (t) => {
  await withBrowser(t, async ({ origin, browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 800, height: 600 } });
    const page = await ctx.newPage();
    await page.goto(origin);
    const max = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
    // Each step's position comes from the reader's own hook, not from scroll events: a browser under load coalesces
    // scroll events between frames, so counting them raced the 20 ms steps and missed some positions.
    const stepped = [];
    const reached = await scrollLikeAReader(page, 1, { steps: 5, stepMs: 20, onStep: (y) => stepped.push(Math.round(y)) });
    assert.equal(reached, max, "a full read reaches the bottom");
    assert.equal(stepped.length, 5, `one position per step: ${stepped}`);
    assert.ok(stepped.filter((y) => y > 0 && y < max).length >= 3, `intermediate positions seen: ${stepped}`);
    assert.equal(await page.evaluate(() => scrollY), 0, "she is put back where she was");

    const page2 = await ctx.newPage();
    await page2.goto(origin);
    assert.equal(await scrollLikeAReader(page2, 0.02, { steps: 5, stepMs: 20 }), 0);
    assert.deepEqual(await page2.evaluate(() => window.__y), [0], "first-screen read never scrolls");
    await ctx.close();
  });
});

test("ending a visit fires pagehide and a beacon lands before the context closes", async (t) => {
  await withBrowser(t, async ({ origin, browser, beacons }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(origin);
    await endVisit(ctx);
    assert.ok(
      beacons.some((b) => b.includes("k=hidden")),
      `visibilitychange beacon: ${beacons}`,
    );
    assert.ok(
      beacons.some((b) => b.includes("k=pagehide")),
      `pagehide beacon: ${beacons}`,
    );
  });
});

test("a page that hangs on beforeunload cannot hold teardown past the bound", async (t) => {
  await withBrowser(t, async ({ origin, browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${origin}/?hang`);
    await page.click("body"); // beforeunload only arms after a user gesture
    const took = await endVisit(ctx, { boundMs: 1_500 });
    assert.ok(took < 5_000, `teardown took ${took} ms`);
  });
});
