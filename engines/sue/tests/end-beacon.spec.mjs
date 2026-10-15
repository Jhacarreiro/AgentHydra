/**
 * end-beacon.spec - a visit's end events reach the server even when the network is slow at the moment she leaves:
 * run 20261011-133328-e6e0 lost one visitor's attention, user_engagement and web_vitals because the context was closed
 * 250 ms after pagehide, while the keepalive fetch was still on its way.
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { endVisit } from "../lib/reader-motion.mjs";

// The pixel keeps a batch the server did not accept and posts it again on the next pagehide (lastGasp).
const PAGE = `<!doctype html><title>x</title><p>hello there</p><script>
let held = true;
addEventListener("pagehide", () => {
  if (!held) return;
  fetch("/ingest", { method: "POST", body: "end", keepalive: true }).then((r) => { if (r.ok) held = false; }, () => {});
});
</script>`;

test("a visit whose end beacon the server refuses leaves again until it is accepted", { timeout: 60_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const answers = [];
  const server = http.createServer((req, res) => {
    if (req.url === "/ingest") {
      req.resume();
      req.on("end", () => {
        const status = answers.length === 0 ? 429 : 200;
        answers.push(status);
        res.writeHead(status);
        res.end("x");
      });
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end(PAGE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await endVisit(context);
    assert.deepEqual(answers, [429, 200], "the refused end beacon was sent again and accepted");
  } finally {
    await browser.close();
    server.close();
  }
});
