/**
 * The shared browser's host must outlive the process tree (and Windows job) of the run that started it.
 * 2026-10-11: hosts vanished with no closing line the moment the run that started them finished, taking
 * every other run's Chrome with them; the host was inside that run's KILL_ON_JOB_CLOSE job.
 * @node-runtime: drives playwright-core's Chromium, which hangs under bun on Windows instead of launching.
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { acquireSharedBrowser, pidAlive } from "../lib/shared-browser.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";

const executablePath = resolveChromiumPath();
const fixture = (name) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FAST = { idleMs: 1_500, tickMs: 200, heartbeatMs: 500, leaseStaleMs: 5_000, startTimeoutMs: 60_000, probeTimeoutMs: 10_000 };

let dir;
let hostPid;
after(() => {
  if (hostPid && pidAlive(hostPid)) process.kill(hostPid);
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
});

test(
  "closing the job of the run that started the host does not take the host or its Chrome down",
  { skip: (process.platform !== "win32" && "Windows jobs only") || (!executablePath && "no Chromium") },
  async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-shared-browser-job-"));
    const outFile = path.join(dir, "starter.json");
    const killFile = path.join(dir, "kill");
    const sharedDir = path.join(dir, "browser");
    const job = spawn(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixture("job-runner.ps1"),
        process.execPath, fixture("job-starter.mjs"), outFile, sharedDir, killFile],
      { stdio: "ignore", windowsHide: true },
    );
    const deadline = Date.now() + 90_000;
    while (!fs.existsSync(outFile) && Date.now() < deadline) await sleep(200);
    assert.ok(fs.existsSync(outFile), "the starter run joined the browser");
    const starter = JSON.parse(fs.readFileSync(outFile, "utf8"));
    hostPid = starter.hostPid;

    // A second run (another process, outside the job) holds a lease on the same host.
    const holder = await acquireSharedBrowser({
      runId: "job-holder", mode: "headless", executablePath, args: browserArgsFor("headless"), dir: sharedDir, options: FAST,
    });
    assert.equal(holder.hostPid, starter.hostPid, "it joined the starter's host");
    const client = await chromium.connect(holder.wsEndpoint);
    const page = await (await client.newContext()).newPage();
    await page.setContent("<p id=x>alive</p>");

    // End the starter's tree the way the OS does: close its job.
    fs.writeFileSync(killFile, "");
    await new Promise((resolve) => job.once("exit", resolve));
    const deadStart = Date.now() + 15_000;
    while (pidAlive(starter.pid) && Date.now() < deadStart) await sleep(100);
    assert.equal(pidAlive(starter.pid), false, "the starter run died with its job");
    await sleep(3_000);

    assert.equal(pidAlive(starter.hostPid), true, "the host is still up");
    assert.equal(pidAlive(starter.browserPid), true, "Chrome is still up");
    assert.equal(page.isClosed(), false, "the lease holder's page is still open");
    assert.equal(await page.textContent("#x"), "alive", "and she can still drive it");
    await client.close();
    holder.release();
  },
);
