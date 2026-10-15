#!/usr/bin/env node
/**
 * browser-host - the process that owns the machine's one shared Sue browser (lib/shared-browser.mjs).
 * ==================================================================================================
 *
 *   node browser-host.mjs launch <config.json>   the hop: starts `serve` detached and exits at once, so
 *                                                 the host belongs to no run's process tree
 *   node browser-host.mjs serve <config.json>    starts Chrome, publishes its endpoint, and closes it
 *                                                 once no run has held a lease for `idleMs`
 *
 * Only lib/shared-browser.mjs starts it. A headed browser's windows are parked off-screen and kept out
 * of the taskbar by the window hider over THIS process's tree, since the runs' own hiders cannot see a
 * browser that is not theirs. The host leases its engine snapshot like a runner does, so the collector
 * never deletes the code it is running.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { takeLease } from "./lib/engine-lease.mjs";
import {
  liveLeases,
  openContextCount,
  readJsonFile,
  SHARED_BROWSER_PROTOCOL,
  sharedBrowserPaths,
  tryLock,
  unlock,
  writeJsonAtomic,
} from "./lib/shared-browser.mjs";
import { lowerOwnPriority } from "./lib/process-priority.mjs";
import { createWindowHiderHold } from "./lib/window-hider.mjs";

const HERE = fileURLToPath(import.meta.url);
const [verb, configFile] = process.argv.slice(2);
const config = readJsonFile(configFile);
if (!config?.key || !config?.dir) {
  console.error(`browser-host: no usable config at ${configFile}`);
  process.exit(2);
}
const paths = sharedBrowserPaths(config.dir, config.key);
const say = (line) => console.log(`${new Date().toISOString()} [browser-host ${process.pid}] ${line}`);

if (verb === "launch") {
  const out = fs.openSync(paths.log, "a");
  const host = spawn(process.execPath, [HERE, "serve", configFile], {
    detached: true,
    stdio: ["ignore", out, out],
    windowsHide: true,
    env: process.env,
  });
  host.unref();
  process.exit(0);
} else if (verb === "serve") {
  await serve();
} else {
  console.error("usage: node browser-host.mjs launch|serve <config.json>");
  process.exit(2);
}

async function serve() {
  const { mode, executablePath, args, idleMs, tickMs, leaseStaleMs, lockStaleMs, lockGraceMs } = config;
  takeLease("browser-host", { key: config.key });
  // Before Chrome starts: Chrome and its renderers inherit this host's priority class.
  lowerOwnPriority();
  let server;
  try {
    server = await chromium.launchServer({ headless: mode === "headless", executablePath, args, timeout: 60_000 });
  } catch (err) {
    say(`Chrome did not start: ${err?.message ?? err}`);
    writeJsonAtomic(`${paths.state}.failed`, { at: new Date().toISOString(), why: String(err?.message ?? err).slice(0, 300) });
    process.exit(1);
  }
  const releaseHider = createWindowHiderHold({ onError: (line) => say(`window hider: ${line}`) })(mode);
  const browserPid = server.process()?.pid ?? null;
  writeJsonAtomic(paths.state, {
    protocol: SHARED_BROWSER_PROTOCOL,
    key: config.key,
    mode,
    wsEndpoint: server.wsEndpoint(),
    pid: process.pid,
    browserPid,
    startedAt: new Date().toISOString(),
  });
  say(`Chrome up (${mode}), pid ${browserPid}`);

  // Only the runs that joined THIS host keep it open: each lease names the host it was taken on.
  const mine = () => liveLeases(paths.leases, { staleMs: leaseStaleMs }).filter((lease) => lease.hostPid === process.pid);
  let closing = false;
  const finish = async (why, code, { chromeGone = false } = {}) => {
    if (closing) return;
    closing = true;
    clearInterval(timer);
    // Who closes the shared Chrome, why, and what was still open: the next death explains itself.
    const contexts = chromeGone ? "n/a" : await openContextCount(server.wsEndpoint());
    say(`${why} [open leases on this host: ${mine().length}, open contexts: ${contexts}]`);
    // Only our own state file is taken away: a newer host may already have written its own.
    if (readJsonFile(paths.state)?.pid === process.pid) fs.rmSync(paths.state, { force: true });
    // A Chrome that will not close gracefully is killed: a host must never outlive its reason to exist.
    const closed = await Promise.race([
      server.close().then(
        () => true,
        () => true, // Chrome is already gone
      ),
      new Promise((resolve) => setTimeout(() => resolve(false), 10_000)),
    ]);
    if (!closed) await server.kill().catch(() => {});
    releaseHider();
    process.exit(code);
  };
  server.on("close", () => finish("Chrome closed under the host; the runs using it each open their own", 1, { chromeGone: true }));
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP", "SIGBREAK"]) {
    try {
      process.on(sig, () => void finish(`received ${sig}; closing`, 1));
    } catch {
      // not a signal this platform has
    }
  }
  // An exit line with no finish line before it is an exit nobody asked for.
  process.on("exit", (code) => say(`host process exiting with code ${code}`));

  let idleSince = null;
  const timer = setInterval(() => {
    if (closing) return;
    liveLeases(paths.leases, { staleMs: leaseStaleMs, tidy: true }); // clears the leases of runs that died
    // A lease is unreadable for an instant while its run's heartbeat renames the new copy over it, so one
    // empty tick proves nothing: the host closes only after `idleMs` of them in a row.
    if (mine().length) {
      idleSince = null;
      return;
    }
    idleSince ??= Date.now();
    if (Date.now() - idleSince < idleMs) return;
    // Another host is published for this key (a lock broken in a race, or this one's file removed by
    // hand): no new run can join this one, so it served the runs already on it and now goes. It never
    // closes Chrome under them (lib/shared-browser.mjs, A LIVE HOST IS NEVER REPLACED).
    if (readJsonFile(paths.state)?.pid !== process.pid) {
      void finish("another host is published for this browser's key and no run is on this one; closing", 0);
      return;
    }
    // Decide under the lock (lib/shared-browser.mjs, THE LOCK IS WHAT MAKES CLOSING SAFE): a run joining
    // right now either has its lease down already, or finds no endpoint and starts a new host.
    if (!tryLock(paths.lock, { staleMs: lockStaleMs, graceMs: lockGraceMs })) return;
    try {
      if (mine().length) {
        idleSince = null;
        return;
      }
      if (readJsonFile(paths.state)?.pid === process.pid) fs.rmSync(paths.state, { force: true });
    } finally {
      unlock(paths.lock);
    }
    void finish(`no run has used the browser for ${Math.round(idleMs / 1000)} s; closing`, 0);
  }, tickMs);
}
