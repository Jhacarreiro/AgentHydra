/**
 * page-trace.spec - what a Sue's page logged and failed on, and what started each document load.
 * Run 20261012-174851-fc73 (sue-10379-game-designer): a tap made a full reload and her trace could not say
 * why. These drive lib/page-trace.mjs against a broken page and a clean one in a real Chromium, then the
 * cap and the harness-blocked skip against a fake CDP session.
 * @node-runtime: launches playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import http from "node:http";
import { test } from "node:test";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { createPageTrace } from "../lib/page-trace.mjs";

const APP_JS = `function again() {
  console.warn("about to reload");
  location.reload();
}
`;

const BROKEN = `<!doctype html><title>broken</title>
<script>console.error("fixture boom")</script>
<script src="/missing.js"></script>
<script src="/ads.js"></script>
<script>fetch("/drop").catch(() => {});</script>
<script>setTimeout(function () { return null.x; }, 0);</script>
<button id="again" onclick="again()">Again</button>
<script src="/app.js"></script>
`;

const CLEAN = `<!doctype html><title>clean</title><link rel="icon" href="data:,"><p>nothing is wrong here</p>
<script>const answer = 42;</script>
`;

/** 1-based line of the first line of `text` that holds `needle`. */
const lineOf = (text, needle) => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

async function until(check, ms = 5_000) {
  const stop = Date.now() + ms;
  while (!check() && Date.now() < stop) await new Promise((resolve) => setTimeout(resolve, 50));
}

function fixtureServer() {
  const server = http.createServer((req, res) => {
    const path = new URL(req.url, "http://fixture.invalid").pathname;
    if (path === "/drop") return req.socket.destroy();
    if (path === "/app.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      return res.end(APP_JS);
    }
    if (path === "/broken" || path === "/clean") {
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(path === "/broken" ? BROKEN : CLEAN);
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("missing");
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

test(
  "the trace names the console error, the 404, the dropped request and the reload's own script line",
  { timeout: 150_000 },
  async (t) => {
    if (!resolveChromiumPath()) {
      t.skip("no Chromium on this machine");
      return;
    }
    const server = await fixtureServer();
    const base = `http://127.0.0.1:${server.address().port}`;
    const blocked = new Set();
    const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
    try {
      const context = await browser.newContext();
      await context.route("**/ads.js", (route) => {
        blocked.add(route.request().url());
        return route.abort();
      });
      const page = await context.newPage();
      const rows = [];
      const trace = createPageTrace({ write: (row) => rows.push(row), cdpFor: (p) => p.context().newCDPSession(p), blockedUrls: blocked });
      await trace.watch(page);
      await page.goto(`${base}/broken?code=SECRET123`);
      await until(
        () => rows.some((r) => r.kind === "failed") && rows.some((r) => r.kind === "http") && rows.some((r) => r.kind === "exception"),
      );
      await Promise.all([page.waitForEvent("load"), page.click("#again")]);
      await until(() => rows.filter((r) => r.kind === "navigation").length >= 2 && rows.some((r) => r.level === "warning"));
      trace.finish();

      const error = rows.find((r) => r.kind === "console" && r.level === "error");
      assert.equal(error?.text, "fixture boom");
      assert.equal(error?.where, `${base}/broken?code:${lineOf(BROKEN, "fixture boom")}`);

      const warning = rows.find((r) => r.kind === "console" && r.level === "warning");
      assert.equal(warning?.text, "about to reload");
      assert.equal(warning?.where, `${base}/app.js:${lineOf(APP_JS, "console.warn")}`);

      assert.ok(
        rows.some((r) => r.kind === "exception" && /null/.test(r.text)),
        "the uncaught TypeError is an exception line",
      );

      const missing = rows.find((r) => r.kind === "http" && r.status === 404);
      assert.equal(missing?.url, `${base}/missing.js`);
      assert.equal(missing?.resource, "Script");

      const dropped = rows.find((r) => r.kind === "failed" && String(r.url).endsWith("/drop"));
      assert.equal(dropped?.url, `${base}/drop`);
      assert.equal(dropped?.resource, "Fetch");

      assert.ok(!rows.some((r) => r.kind === "failed" && String(r.url).endsWith("/ads.js")), "a request the harness aborted gets no line");

      const navigations = rows.filter((r) => r.kind === "navigation");
      assert.equal(navigations.length, 2, "the first load and the reload");
      const reload = navigations[1];
      assert.equal(reload.url, `${base}/broken?code`);
      assert.equal(reload.initiator.type, "script");
      assert.equal(reload.initiator.where, `${base}/app.js:${lineOf(APP_JS, "location.reload()")}`);

      const end = rows.at(-1);
      assert.equal(end.kind, "page-trace");
      assert.equal(end.harnessBlocked, 2, "ads.js is blocked on the first load and again on the reload");
      assert.equal(end.dropped, 0);
      assert.ok(!JSON.stringify(rows).includes("SECRET123"), "a query value never reaches the trace");
    } finally {
      await browser.close();
      server.close();
    }
  },
);

test("a clean page writes no console, failure or http line, only its one load", { timeout: 150_000 }, async (t) => {
  if (!resolveChromiumPath()) {
    t.skip("no Chromium on this machine");
    return;
  }
  const server = await fixtureServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, executablePath: resolveChromiumPath(), args: browserArgsFor("headless") });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const rows = [];
    const trace = createPageTrace({ write: (row) => rows.push(row), cdpFor: (p) => p.context().newCDPSession(p), blockedUrls: new Set() });
    await trace.watch(page);
    await page.goto(`${base}/clean`);
    await until(() => rows.some((r) => r.kind === "navigation"));
    await new Promise((resolve) => setTimeout(resolve, 300));
    trace.finish();

    const noise = rows.filter((r) => !["navigation", "page-trace"].includes(r.kind));
    assert.deepEqual(noise, []);
    const navigations = rows.filter((r) => r.kind === "navigation");
    assert.equal(navigations.length, 1);
    assert.equal(navigations[0].url, `${base}/clean`);
  } finally {
    await browser.close();
    server.close();
  }
});

test("the trace stops at its cap, counts what it dropped, and writes no line for a request the harness blocked", async () => {
  const session = new EventEmitter();
  session.send = async (method) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F" } } } : {});
  const rows = [];
  const trace = createPageTrace({
    write: (row) => rows.push(row),
    cdpFor: async () => session,
    blockedUrls: new Set(["http://a.test/ads.js?x=1"]),
    cap: 3,
  });
  await trace.watch({});
  for (let i = 0; i < 5; i += 1) {
    session.emit("Runtime.consoleAPICalled", {
      type: "error",
      args: [{ value: `n${i}` }],
      stackTrace: { callFrames: [{ url: "http://a.test/x.js", lineNumber: 4 }] },
    });
  }
  session.emit("Network.requestWillBeSent", {
    requestId: "r1",
    request: { url: "http://a.test/ads.js?x=1" },
    type: "Script",
    frameId: "F",
    initiator: { type: "parser" },
  });
  session.emit("Network.loadingFailed", { requestId: "r1", type: "Script", errorText: "net::ERR_FAILED" });
  trace.finish();

  assert.deepEqual(
    rows.filter((r) => r.kind === "console").map((r) => r.text),
    ["n0", "n1", "n2"],
  );
  assert.equal(rows.find((r) => r.kind === "console").where, "http://a.test/x.js:5");
  assert.ok(!rows.some((r) => r.kind === "failed"));
  assert.deepEqual(
    { kind: rows.at(-1).kind, lines: rows.at(-1).lines, dropped: rows.at(-1).dropped, harnessBlocked: rows.at(-1).harnessBlocked },
    { kind: "page-trace", lines: 3, dropped: 2, harnessBlocked: 1 },
  );
});

test("a navigation to a URL with a fragment keeps its reason and disposition", async () => {
  const session = new EventEmitter();
  session.send = async (method) => (method === "Page.getFrameTree" ? { frameTree: { frame: { id: "F" } } } : {});
  const rows = [];
  const trace = createPageTrace({ write: (row) => rows.push(row), cdpFor: async () => session });
  await trace.watch({});
  session.emit("Page.frameRequestedNavigation", {
    frameId: "F",
    url: "http://a.test/landed#top",
    reason: "scriptInitiated",
    disposition: "currentTab",
  });
  session.emit("Network.requestWillBeSent", {
    requestId: "d1",
    request: { url: "http://a.test/landed" },
    type: "Document",
    frameId: "F",
    initiator: { type: "script", stack: { callFrames: [{ url: "http://a.test/app.js", lineNumber: 9 }] } },
  });
  const nav = rows.find((r) => r.kind === "navigation");
  assert.deepEqual(
    { reason: nav.reason, disposition: nav.disposition, initiator: nav.initiator },
    { reason: "scriptInitiated", disposition: "currentTab", initiator: { type: "script", where: "http://a.test/app.js:10" } },
  );
});
