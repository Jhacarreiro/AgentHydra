/**
 * run-end.spec - a wave whose runner is gone reads as stopped, on the page's list, on its own page and
 * in its run record; a wave whose runner is still running never does.
 * ================================================================================================
 *
 * WHAT: `node --test sue/tests/run-end.spec.mjs` (or `bun test`). A throwaway SUE_HOME holds run
 * records the way `sue run` writes them; the Manager answers over HTTP, as the page asks.
 *
 * WHY IT EXISTS: run 20260923-190151-aaff (5 phone Sues) lost its runner without a word; its record
 * said "running" beside a dead pid for a whole day, so the Manager showed "Running", a loading bar with
 * no end and every Sue "still going". Owner, 2026-09-24: "that loading bar stays there forever. It
 * doesn't have an endpoint."
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { createManager, MANAGER_ORIGINS } from "../manager.mjs";
import { discoverWorkspaces, workspaceId } from "../lib/workspaces.mjs";
import { runRecord, settleRun } from "../sue.mjs";

const GONE = "20260923-190151-aaff";
const GOING = "20260924-090000-beef";
const REUSED = "20260924-091000-cafe";
const SUE = "sue-6001-tiktok";

const made = [];
let priorHome;
afterEach(() => {
  if (priorHome === undefined) delete process.env.SUE_HOME;
  else process.env.SUE_HOME = priorHome;
  for (const dir of made.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

/** A pid that was a process a moment ago and is none now. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

/** A SUE_HOME with one page, and a run on it for each runner given: `{ runId: pid }`. */
function fixture(runners) {
  const root = fs.mkdtempSync(path.join(tmpdir(), "sue-run-end-"));
  made.push(root);
  priorHome = process.env.SUE_HOME;
  process.env.SUE_HOME = root;
  const ws = path.join(root, "shop");
  const runsDir = path.join(root, "runs");
  fs.mkdirSync(path.join(ws, ".git"), { recursive: true });
  const targetFile = path.join(ws, ".sue", "target.page.json");
  write(targetFile, { id: "page", startUrl: "https://shop.example.test/", allowedHosts: ["shop.example.test"] });
  for (const [runId, pid] of Object.entries(runners)) {
    const run = path.join(runsDir, runId);
    write(path.join(run, "manifest.json"), { runId, target: "page", targetFile, startUrl: "https://shop.example.test/", started: runId });
    write(path.join(run, SUE, "sue.json"), { sueId: SUE, persona: { id: "tiktok", dials: { device: "phone" } } });
    write(path.join(root, "state", "mcp", `${runId}.status.json`), {
      runId,
      state: "running",
      pid,
      pidCreatedAt: 133000000000000000,
      startedAt: "2026-09-24T00:01:53.000Z",
    });
  }
  return { root, ws, runsDir };
}

async function withManager({ ws, runsDir }, fn) {
  const server = createManager({
    port: 0,
    runsDir,
    workspaces: () => discoverWorkspaces({ runsDir, bindings: new Map(), engineFolder: ws }),
    focus: () => null,
    pageSeen: () => {},
    pageGone: () => {},
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const get = (pathname) =>
    new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: pathname, headers: { host: `127.0.0.1:${port}`, origin: MANAGER_ORIGINS[0] } },
        (res) => {
          const chunks = [];
          res.on("data", (c) => chunks.push(c));
          res.on("end", () => resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
        },
      );
      req.on("error", reject);
      req.end();
    });
  try {
    await fn(get, workspaceId(ws));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const statusOf = (root, runId) => JSON.parse(fs.readFileSync(path.join(root, "state", "mcp", `${runId}.status.json`), "utf8"));

test("a wave whose runner died reads as stopped everywhere; one whose runner runs still reads as running", async () => {
  const fx = fixture({ [GONE]: deadPid(), [GOING]: process.pid });
  const going = statusOf(fx.root, GOING);
  await withManager(fx, async (get, id) => {
    const listed = new Map((await get(`/api/workspaces/${id}/runs`)).runs.map((r) => [r.runId, r]));
    const gone = await get(`/api/runs/${GONE}`);

    assert.equal(gone.state, "stopped");
    assert.deepEqual(gone.why, ["Sue closed before this wave finished."]);
    assert.ok(Date.parse(gone.finishedAt), "it has an end");
    for (const key of ["state", "why", "finishedAt"])
      assert.deepEqual(listed.get(GONE)[key], gone[key], `the list and its page agree on ${key}`);
    assert.equal(gone.sues[0].activity.kind, "stopped", "her Sues stop with it, never still going");

    const status = statusOf(fx.root, GONE);
    assert.equal(status.state, "stopped", "written down, so sue status and the tray agree");
    assert.deepEqual(status.why, ["Sue closed before this wave finished."]);
    assert.equal(status.finishedAt, gone.finishedAt);
    assert.equal(runRecord(GONE).state, "stopped");

    const running = await get(`/api/runs/${GOING}`);
    assert.equal(running.state, "running");
    assert.equal(running.finishedAt, null);
    assert.equal(listed.get(GOING).state, "running");
    assert.equal(running.sues[0].activity.kind, "thinking");
    assert.deepEqual(statusOf(fx.root, GOING), going, "a live wave's record is never touched");
  });
});

test("a wave whose pid Windows handed to another process reads as stopped once the Manager has caught it", async () => {
  // The pid is alive (this very process) but the minute check proved it is not the runner (checkRunnerPids).
  const fx = fixture({ [REUSED]: process.pid });
  await withManager(fx, async (get) => {
    assert.equal((await get(`/api/runs/${REUSED}`)).state, "running", "alive and not yet disproved: running");
    settleRun(REUSED);
    await new Promise((resolve) => setTimeout(resolve, 2_100)); // past the live summary's 2 s reuse
    const run = await get(`/api/runs/${REUSED}`);
    assert.equal(run.state, "stopped");
    assert.equal(statusOf(fx.root, REUSED).state, "stopped");
  });
});
