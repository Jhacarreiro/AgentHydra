/**
 * run-start.spec - `sue run` never answers ok:true about a run its own records say is dead.
 * =========================================================================================
 *
 * WHAT: `node --test sue/tests/run-start.spec.mjs`. `awaitRunStart` reads the run's records (the
 * runner's status, the cannon's log, the mailroom's log, the relay) through an injected reader, so no
 * process, browser or network is involved.
 *
 * WHY IT EXISTS: on 2026-09-24 (run 20260924-185204-fcc0) the MCP door answered ok:true about a chat
 * run whose mailroom had already died and stopped it; five Opus agents polled a relay that never opened.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { awaitRunStart } from "../lib/run-start.mjs";

test("a chat run stopped by its mailroom answers ok:false with the reason; one whose mailroom serves answers as it came", async () => {
  const answer = { ok: true, runId: "r1", chatBrains: "C:/runs/r1/chat-brains.json" };
  const stopped = 'the mailroom exited with code 1 while the run was still going (its last words: "boom")';
  const dead = await awaitRunStart(answer, {
    pollMs: 1,
    read: () => ({
      status: { state: "running" },
      log: `[cannon] mailroom started (pid 7), log x\n[cannon] STOPPING: ${stopped}\n`,
      mailroomLog: "",
      relayOpen: false,
      suesStarted: false,
    }),
  });
  assert.equal(dead.ok, false);
  assert.match(dead.error, /did not come up: the mailroom exited with code 1/);

  // The relay being open is not enough while a started mailroom has not said it is serving: that is the
  // window in which it dies on start. Once it serves, the original answer comes back untouched.
  let reads = 0;
  const up = await awaitRunStart(answer, {
    pollMs: 1,
    read: () => ({
      status: { state: "running" },
      log: "[cannon] mailroom started (pid 7), log x\n",
      mailroomLog: ++reads < 3 ? "" : "[mailroom] serving run r1 every 5s\n",
      relayOpen: true,
      suesStarted: false,
    }),
  });
  assert.equal(reads, 3);
  assert.deepEqual(up, answer);
});
