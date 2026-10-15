// visitors.spec.mjs - the docket's page read never follows a remote redirect onto this machine or a private network.
//
// WHAT: `node --test dredd/tests/visitors.spec.mjs`. Pure: no network.
//
// WHY IT EXISTS: lib/visitors.mjs readPage puts a page's words into a model prompt. A public page that redirects to
// 169.254.169.254, 127.0.0.1 or a 10.x host would have had that internal reply sent out (background review,
// 2026-09-25); every hop is now checked with isInternalAddress, so the table below is the whole refusal.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isInternalAddress, readyCastBodies } from "../lib/visitors.mjs";
import { listPersonas } from "../../sue/lib/personas.mjs";

test("internal addresses are refused as redirect targets, public ones are not", () => {
  for (const ip of [
    "127.0.0.1",
    "10.2.3.4",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "::1",
    "fe80::1",
    "fd00::1",
    "::ffff:127.0.0.1",
    // What the URL parser turns [::ffff:127.0.0.1] into, and NAT64's 169.254.169.254.
    "::ffff:7f00:1",
    "[::ffff:7f00:1]",
    "64:ff9b::a9fe:a9fe",
  ])
    assert.equal(isInternalAddress(ip), true, ip);
  for (const ip of ["8.8.8.8", "172.32.0.1", "104.21.4.9", "100.128.0.1", "2606:4700::1111", "::ffff:808:808"])
    assert.equal(isInternalAddress(ip), false, ip);
});

test("a docket casts visitors on SUE's built-in bodies read from Connections, and says why when it cannot", async () => {
  assert.deepEqual(await readyCastBodies(null), { ok: false, why: "no Connections MCP to read SUE's people through" });
  const bob = { doc: { id: "bob", displayName: "Bob", voice: "You are Bob.", dials: { device: "desktop" } }, builtIn: true };
  const asked = [];
  const mcp = { api: async (service, tool, body) => (asked.push([service, tool, body]), { ok: true, body: { personas: [bob] } }) };
  assert.deepEqual(await readyCastBodies(mcp), { ok: true, people: 1 });
  assert.deepEqual(asked, [["boardroom", "boardroom_personas_sue_list", { builtIns: true }]]);
  assert.deepEqual(listPersonas(), ["bob"], "installed in this process, where the cast reads its bodies");
  const down = { api: async () => ({ ok: false, status: 503, text: "down" }) };
  assert.equal((await readyCastBodies(down)).ok, false);
});
