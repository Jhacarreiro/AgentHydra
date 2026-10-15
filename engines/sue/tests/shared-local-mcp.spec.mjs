// shared-local-mcp.spec.mjs - SUE reads the Connections MCP through the ONE shared host, never a loader of her own.
//
// WHAT: `node --test sue/tests/shared-local-mcp.spec.mjs`. Runs the real loader's `--connect` helper and a real host
// on a spare port under a scratch home (never port 7791, never a host this spec did not start).
//
// WHY IT EXISTS: SUE's brief (you/brief.mjs readStoreRulings) used to spawn a whole stdio `loader.mjs` - 71 MB resident -
// for one memory_open. The client must reach the host the helper brings up on demand, run its tool in a session of its
// own on that host, and leave the host running for everyone else when it closes.
//
// WHO DEPENDS ON IT: nothing imports it.
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { sharedLocalMcpFor } from "../lib/shared-local-mcp.mjs";

const REPO = targetRoot();
const LOADER = targetPath(loadTarget().localMcpLoader);
const IMPL = targetPath(loadTarget().localMcpImpl);
const SCRATCH = mkdtempSync(join(tmpdir(), "sue-shared-local-mcp-spec-"));
const port = 20_000 + Math.floor(Math.random() * 20_000);
const health = () => fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2000) }).then((r) => r.json());
let hostPid = null;
let portWasFree = false;

// The bun lane replaces `fetch` with a default-deny guard (scripts/test/unmocked-network-guard.mjs), loopback included,
// so the helper's calls to the host this spec starts never left the process: the spec failed on every lane run AFTER
// the helper had brought the host up, and each run left a ~200 MB host behind (nine of them on 2026-10-11, the oldest
// 53 h). This fetch reaches only that host, over node:http; every other URL still goes to the guard.
const guardedFetch = globalThis.fetch;
globalThis.fetch = (input, init = {}) => {
  const target = new URL(String(input?.url ?? input));
  if (target.hostname !== "127.0.0.1" || Number(target.port) !== port) return guardedFetch(input, init);
  const body = init.body == null ? null : String(init.body);
  return new Promise((resolve, reject) => {
    const headers = { ...init.headers, ...(body ? { "content-length": Buffer.byteLength(body) } : {}) };
    const req = http.request(target, { method: init.method ?? "GET", headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("error", reject);
      res.on("end", () => {
        const answer = new Headers();
        for (let i = 0; i < res.rawHeaders.length; i += 2) answer.append(res.rawHeaders[i], res.rawHeaders[i + 1]);
        const empty = [204, 205, 304].includes(res.statusCode);
        resolve(new Response(empty ? null : Buffer.concat(chunks), { status: res.statusCode, headers: answer }));
      });
    });
    init.signal?.addEventListener("abort", () => req.destroy(init.signal.reason), { once: true });
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
};

after(async () => {
  // The host THIS spec's helper started. Nothing listened on this spare port when the test began (its first
  // assertion), so whatever answers /health here now is ours, also when the test failed before it read the pid.
  const pid = hostPid ?? (portWasFree ? (await health().catch(() => null))?.pid : null);
  if (pid) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
  globalThis.fetch = guardedFetch;
  await new Promise((r) => setTimeout(r, 500));
  try {
    rmSync(SCRATCH, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  } catch {
    /* the OS temp sweep gets it */
  }
});

// connections-only: starts the target checkout's real shared MCP host; keep the offline extraction suite service-free.
test.skip("a call brings the shared host up on demand, runs in a session on it, and leaves the host running", async () => {
  const home = join(SCRATCH, "home");
  const folder = join(SCRATCH, "folder");
  mkdirSync(home, { recursive: true });
  mkdirSync(folder, { recursive: true });
  await assert.rejects(health(), "no host listens yet");
  portWasFree = true;

  const mcp = sharedLocalMcpFor({
    folder,
    port,
    loader: LOADER,
    clientName: "sue-spec",
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      CONNECTIONS_IMPL_FILE: IMPL,
      CONNECTIONS_MCP_ONESHOT: "1",
      CONNECTIONS_LEAN: "1",
    },
  });
  const { blocks, isError } = await mcp.callResult("connections_health");
  assert.equal(isError, false);
  const report = JSON.parse(blocks[0]);
  hostPid = report.pid;
  assert.match(report.mode, /shared server/); // answered by the host, not by a stdio loader of its own
  assert.equal(report.implDispatcher.issuedBy.chatSummary.count, 1);
  assert.equal((await health()).chats, 1);

  await mcp.close();
  const after = await health(); // the session ended; the host is still there for every other session
  assert.equal(after.chats, 0);
  assert.equal(after.pid, hostPid);
});
