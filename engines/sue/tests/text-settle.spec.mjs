// text-settle.spec.mjs - a look waits for a requestAnimationFrame count-up to finish (the stats band on
// the Example App home page counts for 1.8 s and no CSS animation covers it), and a static page is read at once.
// @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { settleInPage, trackTextChanges, waitForTextToSettle } from "../lib/text-settle.mjs";

const FINAL = "5700000";

const BLANK = `<!doctype html><title>blank</title><body style="margin:0"><span id="s">0</span> servers`;

const COUNT_UP = `<!doctype html><title>band</title><body style="margin:0">
<div id="counter" style="height:200px"><span id="s">0</span> servers</div>
<script>
  const to = ${FINAL}, ms = 1800, start = performance.now();
  const step = (now) => {
    const p = Math.min(1, (now - start) / ms);
    document.getElementById('s').textContent = String(p >= 1 ? to : Math.round(to * (1 - Math.pow(1 - p, 3))));
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
</script>`;

const STATIC = `<!doctype html><title>static</title><body style="margin:0">
<div id="counter" style="height:200px"><span id="s">${FINAL}</span> servers</div>`;

async function withPage(t, html, run) {
  const exe = resolveChromiumPath();
  if (!exe) return t.skip("no Chromium on this machine");
  const server = createServer((req, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const browser = await chromium.launch({ headless: true, executablePath: exe, args: browserArgsFor("headless") });
  try {
    const context = await browser.newContext();
    await context.addInitScript(trackTextChanges);
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: "load" });
    await run(page);
  } finally {
    await browser.close();
    server.close();
  }
}

const figure = (page) => page.textContent("#s");

test("a look waits for a count-up to finish before it reads the figure", async (t) => {
  await withPage(t, COUNT_UP, async (page) => {
    assert.notEqual(await figure(page), FINAL, "the count-up is still running when the look starts");
    const waited = await waitForTextToSettle(page);
    assert.equal(await figure(page), FINAL);
    assert.ok(waited >= 1000 && waited <= 3000, `waited ${waited} ms`);
  });
});

// The page has been quiet for longer than the window, and in one task a ticker is queued for its first frame and the
// wait starts. The frame cannot run between the two, so the wait must hold for the frame's change, not return on the
// quiet that was there before the ticker began (run under load, the old wait returned before the figure moved).
test("a wait does not take a page for settled before its queued ticker has drawn its first frame", async (t) => {
  await withPage(t, BLANK, async (page) => {
    const waited = await page.evaluate(`(() => {
      window.__sueTextChangedAt = performance.now() - 10000;
      requestAnimationFrame(() => { document.getElementById('s').textContent = ${JSON.stringify(FINAL)}; });
      return (${settleInPage.toString()})({ quietMs: 500, capMs: 3000 });
    })()`);
    assert.equal(await figure(page), FINAL, `the wait returned after ${waited} ms, before the first frame drew the figure`);
  });
});

test("a static page is read at once once its text has been quiet", async (t) => {
  await withPage(t, STATIC, async (page) => {
    await page.waitForTimeout(700);
    const waited = await waitForTextToSettle(page);
    assert.ok(waited < 100, `waited ${waited} ms on a page with no motion`);
    assert.equal(await figure(page), FINAL);
  });
});
