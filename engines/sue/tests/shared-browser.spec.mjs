// @node-runtime: it starts a real Chromium through playwright-core in a host process, which hangs under bun on Windows instead of launching.
/**
 * shared-browser.spec - every Sue run on the machine shares ONE browser (lib/shared-browser.mjs and
 * browser-host.mjs), and nothing keeps it open once no run holds it.
 *
 * Plain node (`node --test sue/tests/shared-browser.spec.mjs`). The first tests drive the lease
 * and lock rules on a temp folder with no browser. The rest start a real headless Chromium through the
 * real host on a temp folder, with the host's clock turned down to seconds: three runs joining at once
 * get one browser, the host belongs to no run's process tree (so stopping one run cannot close the
 * others' browser), it closes once the last run lets go, and a host that is no longer the published one
 * serves the runs already on it before it goes.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium } from "playwright-core";

import {
  acquireSharedBrowser,
  browserKey,
  liveLeases,
  openContextCount,
  pidAlive,
  SHARED_BROWSER_PROTOCOL,
  sharedBrowserPaths,
  tryLock,
  unlock,
} from "../lib/shared-browser.mjs";
import "./fixtures/people.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { watchSharedBrowser } from "../cannon.mjs";
import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";

const temps = [];
const hosts = new Set();
function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-shared-browser-"));
  temps.push(dir);
  return dir;
}
after(() => {
  for (const pid of hosts) if (pidAlive(pid)) process.kill(pid);
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await sleep(100);
  }
  assert.fail(`timed out waiting for ${what}`);
}

test("a lease counts only while it is fresh and its process is alive; the host tidies the rest", () => {
  const dir = tempDir();
  const now = Date.now();
  const write = (name, pid, ageMs) => {
    const file = path.join(dir, `${name}.json`);
    fs.writeFileSync(file, JSON.stringify({ runId: name, pid }));
    const t = new Date(now - ageMs);
    fs.utimesSync(file, t, t);
  };
  write("fresh", 101, 1_000);
  write("stale", 102, 10 * 60_000);
  write("dead", 103, 1_000);
  const alive = (pid) => pid !== 103;
  assert.deepEqual(
    liveLeases(dir, { now, staleMs: 120_000, alive }).map((l) => l.runId),
    ["fresh"],
  );
  liveLeases(dir, { now, staleMs: 120_000, alive, tidy: true });
  assert.deepEqual(fs.readdirSync(dir), ["fresh.json"]);
  assert.deepEqual(liveLeases(path.join(dir, "missing")), [], "no leases folder is no leases");
});

test("the lock is taken once, and a dead or abandoned holder's lock is broken", () => {
  const dir = tempDir();
  const lock = path.join(dir, "k.lock");
  assert.equal(tryLock(lock), true);
  assert.equal(tryLock(lock), false, "held by a live process (this one)");
  unlock(lock);
  assert.equal(fs.existsSync(lock), false);

  fs.writeFileSync(lock, JSON.stringify({ pid: 424242 }));
  assert.equal(tryLock(lock, { alive: () => false }), true, "its holder is dead");
  unlock(lock);

  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid }));
  const old = new Date(Date.now() - 10 * 60_000);
  fs.utimesSync(lock, old, old);
  assert.equal(tryLock(lock, { staleMs: 60_000 }), true, "older than any Chrome start");
  unlock(lock);

  // Review of the first cut, 2026-09-25: a holder killed between creating the lock and writing its pid
  // left an empty file that no rule could break, so every later run waited out its timeout.
  fs.writeFileSync(lock, "");
  assert.equal(tryLock(lock), false, "an empty lock this fresh may still be being written");
  const aMinuteAgo = new Date(Date.now() - 60_000);
  fs.utimesSync(lock, aMinuteAgo, aMinuteAgo);
  assert.equal(tryLock(lock), true, "an empty lock past the grace is its dead writer's");
  unlock(lock);
});

test("runs share a browser only when mode, Chrome and flags all match", () => {
  const base = { mode: "headless", executablePath: "C:/chrome.exe", args: ["--a"] };
  assert.equal(browserKey(base), browserKey({ ...base }));
  assert.notEqual(browserKey(base), browserKey({ ...base, mode: "headed-offscreen" }));
  assert.notEqual(browserKey(base), browserKey({ ...base, args: ["--disable-gpu"] }));
  assert.notEqual(browserKey(base), browserKey({ ...base, executablePath: "D:/chrome.exe" }));
  assert.notEqual(browserKey(base), browserKey({ ...base, playwright: "0.0.1" }), "a connect across playwright versions is refused");
});

test("a host that is alive but does not answer is never replaced: the run throws and opens its own", async () => {
  // Review of the first cut, 2026-09-25: a missed probe started a second host, and the first then closed
  // Chrome under every run still on it.
  const dir = tempDir();
  const args = ["--a"];
  const key = browserKey({ mode: "headless", executablePath: "C:/chrome.exe", args });
  const { state, leases } = sharedBrowserPaths(dir, key);
  fs.mkdirSync(leases, { recursive: true });
  const record = JSON.stringify({ protocol: SHARED_BROWSER_PROTOCOL, key, wsEndpoint: "ws://127.0.0.1:9/nobody", pid: process.pid });
  fs.writeFileSync(state, record);
  await assert.rejects(
    acquireSharedBrowser({
      runId: "run-x",
      mode: "headless",
      executablePath: "C:/chrome.exe",
      args,
      dir,
      options: { probeTimeoutMs: 2_000 },
    }),
    /is running but did not answer/,
  );
  assert.equal(fs.readFileSync(state, "utf8"), record, "the live host's endpoint is left where it was");
  assert.deepEqual(fs.readdirSync(leases), [], "and the run leaves no lease behind");
});

const executablePath = resolveChromiumPath();
const FAST = { idleMs: 1_500, tickMs: 200, heartbeatMs: 500, leaseStaleMs: 5_000, startTimeoutMs: 60_000, probeTimeoutMs: 10_000 };
const join = (dir, runId) =>
  acquireSharedBrowser({ runId, mode: "headless", executablePath, args: browserArgsFor("headless"), dir, options: FAST });

test(
  "three runs joining at once get ONE browser, and a Sue's context works on it",
  { skip: !executablePath && "no Chromium" },
  async () => {
    const dir = tempDir();
    const runs = await Promise.all([join(dir, "run-a"), join(dir, "run-b"), join(dir, "run-c")]);
    for (const run of runs) hosts.add(run.hostPid);
    assert.equal(new Set(runs.map((r) => r.wsEndpoint)).size, 1, "one endpoint");
    assert.equal(new Set(runs.map((r) => r.hostPid)).size, 1, "one host");
    assert.equal(runs.filter((r) => r.started).length, 1, "exactly one run started it");

    const browser = await chromium.connect(runs[1].wsEndpoint);
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.setContent("<p id=x>shared</p>");
    assert.equal(await page.textContent("#x"), "shared");
    await browser.close();

    if (process.platform === "win32") {
      // The host must be nobody's child: `sue stop` ends a run with taskkill /T, and a browser in that
      // run's tree would go down under every other run.
      const out = spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-CimInstance Win32_Process -Filter "ProcessId=${runs[0].hostPid}").ParentProcessId`,
        ],
        { encoding: "utf8", windowsHide: true },
      );
      const parent = Number(out.stdout.trim());
      assert.notEqual(parent, process.pid, "the host is not this process's child");
      assert.equal(pidAlive(parent), false, "its parent (the launch hop) has already exited");
    }

    const { state } = sharedBrowserPaths(dir, runs[0].key);
    runs[0].release();
    runs[1].release();
    await sleep(FAST.idleMs + 3 * FAST.tickMs);
    assert.equal(pidAlive(runs[0].hostPid), true, "one run still holds it");
    runs[2].release();
    await waitFor(() => !pidAlive(runs[0].hostPid), 15_000, "the host to close once the last run let go");
    assert.equal(fs.existsSync(state), false, "its endpoint is taken away");
    assert.equal(pidAlive(runs[0].browserPid), false, "and Chrome with it");

    const again = await join(dir, "run-d");
    hosts.add(again.hostPid);
    assert.equal(again.started, true, "the next run starts a fresh one");
    assert.notEqual(again.hostPid, runs[0].hostPid);
    again.release();
  },
);

test(
  "one Sue ending leaves another Sue's page alive and working, and the host log says who let go",
  { skip: !executablePath && "no Chromium" },
  async () => {
    const dir = tempDir();
    const [a, b] = await Promise.all([join(dir, "run-first"), join(dir, "run-second")]);
    hosts.add(a.hostPid);
    const clientA = await chromium.connect(a.wsEndpoint);
    const clientB = await chromium.connect(b.wsEndpoint);
    await (await clientA.newContext()).newPage();
    const pageB = await (await clientB.newContext()).newPage();
    await pageB.setContent("<button id=go onclick=\"document.title='clicked'\">go</button>");
    assert.equal(await openContextCount(b.wsEndpoint), 2, "both Sues' contexts are open");

    // The first Sue ends the way a run ends: hang up, then let go of the lease.
    await clientA.close();
    a.release();
    await sleep(FAST.idleMs + 5 * FAST.tickMs);

    assert.equal(pidAlive(a.hostPid), true, "the host is still up");
    assert.equal(pidAlive(a.browserPid), true, "Chrome is still up");
    assert.equal(pageB.isClosed(), false, "the second Sue's page is still open");
    await pageB.click("#go");
    assert.equal(await pageB.title(), "clicked", "and she can still act on it");
    assert.equal(await openContextCount(b.wsEndpoint), 1, "only her context is left");

    const { log } = sharedBrowserPaths(dir, a.key);
    const text = fs.readFileSync(log, "utf8");
    assert.match(text, /\[run run-first pid \d+\] released its lease on host/);
    assert.doesNotMatch(text, /closing|Chrome closed under/);

    await clientB.close();
    b.release();
    await waitFor(() => !pidAlive(a.hostPid), 15_000, "the host to close once the last Sue let go");
    assert.match(fs.readFileSync(log, "utf8"), /no run has used the browser.*open leases on this host: 0, open contexts: (\d+|unknown)/);
  },
);

test(
  "a host that is no longer the published one serves the runs already on it, then goes",
  { skip: !executablePath && "no Chromium" },
  async () => {
    const dir = tempDir();
    const run = await join(dir, "run-e");
    hosts.add(run.hostPid);
    const { state } = sharedBrowserPaths(dir, run.key);
    const record = JSON.parse(fs.readFileSync(state, "utf8"));
    fs.writeFileSync(state, JSON.stringify({ ...record, pid: 424242 }));
    await sleep(FAST.idleMs + 5 * FAST.tickMs);
    assert.equal(pidAlive(run.hostPid), true, "Chrome is not closed under the run still on it");
    run.release();
    await waitFor(() => !pidAlive(run.hostPid), 15_000, "the unpublished host to close once its run let go");
    assert.equal(pidAlive(run.browserPid), false);
  },
);

test("a run hands the shared browser back without a word, and says when it went under the run", async () => {
  const fakeBrowser = () => Object.assign(new EventEmitter(), { close: async () => {} });
  const lines = [];
  let released = 0;
  const shared = { wsEndpoint: "ws://x", browserPid: 7, release: () => (released += 1) };

  let watcher;
  const quiet = await watchSharedBrowser(
    shared,
    (l) => lines.push(l),
    () => "T",
    async () => (watcher = fakeBrowser()),
  );
  assert.equal(quiet.wsEndpoint(), "ws://x");
  assert.equal(quiet.process().pid, 7);
  await quiet.close();
  watcher.emit("disconnected");
  assert.equal(released, 1, "close() lets go of this run's lease");
  assert.deepEqual(lines, [], "letting go is not the browser going under the run");

  const lost = await watchSharedBrowser(
    shared,
    (l) => lines.push(l),
    () => "T",
    async () => (watcher = fakeBrowser()),
  );
  watcher.emit("disconnected");
  assert.match(lines[0], /shared Sue browser closed under the run at T/);
  await lost.close();

  const blind = await watchSharedBrowser(
    shared,
    (l) => lines.push(l),
    () => "T",
    async () => {
      throw new Error("no answer");
    },
  );
  await blind.close();
  assert.equal(released, 3, "a run that could not watch still lets go");
});
