/**
 * target-preflight.spec - a start page that does not answer refuses the run before any Sue is spent.
 * ===================================================================================================
 *
 * @node-runtime: it opens a real HTTP server on 127.0.0.1 and fetches it, which the bun lane's
 * default-deny fetch guard (scripts/test/unmocked-network-guard.mjs) refuses even for loopback.
 *
 * WHAT: `node --test sue/tests/target-preflight.spec.mjs`. `preflightTarget` against a port
 * nobody listens on is not ok and says why; against a live server it is ok whatever the status, since
 * a 404 or a redirect is still a server answering.
 *
 * WHY IT EXISTS: on 2026-09-24 the credit lab's localhost server died at about 18:35 and SUE went on
 * starting runs against it. 25 Opus-driven Sues each met ERR_CONNECTION_REFUSED, waited a minute, gave
 * up and sat an exit interview about a page they never saw, and those rows read like data.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import "./fixtures/people.mjs";
import { preflightTarget } from "../cannon.mjs";

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

test("a port nobody listens on refuses, and names the url", async () => {
  const server = await listen(() => {});
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  const reach = await preflightTarget(`http://127.0.0.1:${port}/go/33`);
  assert.equal(reach.ok, false);
  assert.match(reach.error, /ECONNREFUSED|refused|fetch failed/i);
});

test("a live server answers, a redirect or a 404 included", async () => {
  const server = await listen((req, res) => {
    if (req.url === "/go/33") res.writeHead(302, { location: "/v33/" }).end();
    else res.writeHead(404).end();
  });
  const { port } = server.address();
  try {
    assert.deepEqual(await preflightTarget(`http://127.0.0.1:${port}/go/33`), { ok: true, status: 302 });
    assert.deepEqual(await preflightTarget(`http://127.0.0.1:${port}/nothing`), { ok: true, status: 404 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
