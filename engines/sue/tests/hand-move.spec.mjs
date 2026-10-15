/**
 * hand-move.spec - sendMove (lib/hand-move.mjs) against a relay whose event loop goes busy, the way the cannon's does
 * while it launches the next Sue (run 20261009-204651-017b: two Sues' second move came back "read ECONNRESET: the run
 * is over" while the relay was alive). A long hands-mcp process rode the first move's kept-alive socket, and the
 * relay's idle timer destroyed it with the second move unread.
 *
 * @node-runtime: the fault is Node's own http server closing an idle keep-alive socket, and the sealed hands-mcp that
 * hit it runs on `node`; bun's node:http is a different implementation and would prove nothing.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import { sendMove } from "../lib/hand-move.mjs";

const RELAY = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "busy-relay.mjs");
const RUN = "20261010-000000-busy";
// Node tells a client to keep a socket 1 s less than the server's window, and a window under 2 s tells it to keep none.
const KEEP_ALIVE_MS = 2000;
// Past the window and Node's 1 s buffer on top of it.
const BUSY_MS = KEEP_ALIVE_MS + 1500;

test("a move sent right after a move whose relay then goes busy past its keep-alive window is still answered", { timeout: 30_000 }, async (t) => {
  const worker = new Worker(RELAY, { workerData: { keepAliveMs: KEEP_ALIVE_MS } });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-hand-move-"));
  t.after(async () => {
    await worker.terminate();
    fs.rmSync(home, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    worker.once("message", resolve);
    worker.once("error", reject);
  });
  fs.mkdirSync(path.join(home, "runs", RUN), { recursive: true });
  fs.writeFileSync(path.join(home, "runs", RUN, "relay.json"), JSON.stringify({ port, token: "t".repeat(32) }));
  const move = (args) => sendMove({ runId: RUN, sueId: "sue-1117-dana", tool: "look", args, raw: true }, { home });

  const first = await move({ say: "first", busyMs: BUSY_MS });
  const second = await move({ say: "second" });

  assert.deepEqual({ reached: first.reached, text: first.text }, { reached: true, text: "first" });
  assert.deepEqual({ reached: second.reached, text: second.text }, { reached: true, text: "second" });
});
