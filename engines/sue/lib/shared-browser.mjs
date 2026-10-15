/**
 * shared-browser - ONE Sue browser for the whole machine, shared by every run, closed once nobody uses it.
 * ======================================================================================================
 *
 * Owner ask (Owner, 2026-09-25, with six headless Chromes open from six Sue runs): every Sue run in one
 * Chrome, the way the installed app looked, not a new Chrome per run. The 2026-09-21 fix (cannon.mjs
 * `startBrowserServer`) already put every Sue of ONE run in one browser; a second run, or a stuck one
 * nobody stopped, still opened its own. This is the step after it (Owner, 2026-09-24: "hundreds of Sues
 * from one Chrome, as cheaply as possible").
 *
 * HOW. The browser is owned by a small host process (../browser-host.mjs), never by a run: a run's
 * browser server dies with the run, and `sue stop` ends a run with `taskkill /T`, which would take a
 * shared browser in that run's process tree down under every other run. So the host is started through
 * a hop that exits at once, which leaves it outside every run's tree. Everything lives in
 * `<stateRoot>/browser/`, one set of files per browser KEY (mode + Chrome + flags, so a headed wave and
 * a headless one never share, and neither does a GPU and a CPU one):
 *
 *   <key>.json            { wsEndpoint, pid, browserPid, ... } - written by the host once Chrome is up
 *   <key>.lock            held while a run joins or starts the host, and while the host decides to close
 *   <key>.leases/<run>.json  one per run using it, rewritten every heartbeat
 *   <key>.log             the host's own lines
 *
 * THE LOCK IS WHAT MAKES CLOSING SAFE. A run takes it, reads the endpoint, writes its lease, and only then
 * lets go; the host takes it, looks for a live lease, and only then takes its endpoint away and closes.
 * Either the run's lease is down before the host looks (the host stays), or the endpoint is gone before
 * the run reads it (the run starts a new host). There is no third order.
 *
 * A LIVE HOST IS NEVER REPLACED (review of the first cut, 2026-09-25). A host whose process is alive but
 * does not answer a connect - a loaded box, or a playwright-core the run cannot speak to - is left alone:
 * the run throws and opens its own Chrome, and the host keeps serving the runs already on it. Replacing
 * it would close Chrome under every one of them. Each lease names the host it was taken on, and a host
 * counts only its own, so even a second host for one key (a lock broken in a race) closes only once the
 * runs on it are done. The playwright-core version is part of the key, so an upgrade starts a new host
 * instead of probing an old one it cannot talk to.
 *
 * A LEASE IS LIVE while its run's process is alive AND it was rewritten inside `leaseStaleMs`: a run
 * killed outright never removes its lease, and a reused pid alone must not keep a browser up forever.
 * A run that cannot reach or start the shared browser gets an error, and cannon.mjs falls back to a
 * browser of the run's own (the pre-2026-09-25 behaviour), so this is never a new way for a wave to fail.
 * `SUE_SHARED_BROWSER=0` turns it off.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { stateRoot } from "./run-dir.mjs";

/** Bumped when the files above change shape, so an older host is never joined by newer code. */
export const SHARED_BROWSER_PROTOCOL = 2;

/** A connect across playwright-core versions is refused, so runs share a browser only within one. */
export const PLAYWRIGHT_VERSION = (() => {
  try {
    return createRequire(import.meta.url)("playwright-core/package.json").version;
  } catch {
    return "unknown";
  }
})();

export const SHARED_BROWSER_DEFAULTS = {
  heartbeatMs: 30_000,
  leaseStaleMs: 120_000,
  // A run that starts right after another ends reuses the browser instead of paying a Chrome start.
  idleMs: 90_000,
  tickMs: 5_000,
  // Chrome's own start is capped at 60 s (launchServer's timeout); this is that plus the two spawns.
  startTimeoutMs: 75_000,
  // A lock older than this belongs to a process that died holding it (a dead holder is broken at once);
  // the longest a live one holds it is a probe plus a Chrome start. A waiting run waits this long too.
  lockStaleMs: 150_000,
  // A lock file with no readable holder is one whose writer died between creating and writing it.
  lockGraceMs: 5_000,
  // A loaded machine can take seconds to answer a connect; a live host that misses it is left alone.
  probeTimeoutMs: 15_000,
};

const HOST_SCRIPT = fileURLToPath(new URL("../browser-host.mjs", import.meta.url));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function sharedBrowserDir(root = stateRoot()) {
  return path.join(root, "browser");
}

/** One line into every shared-browser host log: who did something that can end a host, and why. */
export function noteHostLogs(dir, line) {
  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.endsWith(".log"))
        fs.appendFileSync(
          path.join(dir, name),
          `${new Date().toISOString()} ${line}
`,
        );
    }
  } catch {
    // no shared-browser folder yet: nobody to tell
  }
}

/** How many browser contexts (one per Sue) the Chrome at `wsEndpoint` has open, or "unknown". */
export async function openContextCount(wsEndpoint, timeoutMs = 3000) {
  let client;
  let timer;
  try {
    const work = (async () => {
      client = await chromium.connect(wsEndpoint, { timeout: timeoutMs });
      const session = await client.newBrowserCDPSession();
      const { browserContextIds } = await session.send("Target.getBrowserContexts");
      return browserContextIds.length;
    })();
    work.catch(() => {});
    return await Promise.race([work, new Promise((resolve) => (timer = setTimeout(() => resolve("unknown"), timeoutMs)))]);
  } catch {
    return "unknown";
  } finally {
    clearTimeout(timer);
    await client?.close().catch(() => {});
  }
}

/** The browser a run may share: same mode, same Chrome binary, same flags, same playwright-core. */
export function browserKey({ mode, executablePath, args, playwright = PLAYWRIGHT_VERSION }) {
  const hash = createHash("sha256")
    .update(JSON.stringify({ protocol: SHARED_BROWSER_PROTOCOL, mode, executablePath, args, playwright }))
    .digest("hex")
    .slice(0, 12);
  return `${mode}-${hash}`;
}

export function sharedBrowserPaths(dir, key) {
  return {
    state: path.join(dir, `${key}.json`),
    lock: path.join(dir, `${key}.lock`),
    leases: path.join(dir, `${key}.leases`),
    log: path.join(dir, `${key}.log`),
    config: path.join(dir, `${key}.config.json`),
  };
}

export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

export function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Written whole or not at all: a reader never sees half a file. */
export function writeJsonAtomic(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

/**
 * The leases that still hold the browser open: rewritten inside `staleMs` by a process that is alive.
 * `tidy` deletes the rest, which only the host does.
 */
export function liveLeases(
  leasesDir,
  { now = Date.now(), staleMs = SHARED_BROWSER_DEFAULTS.leaseStaleMs, alive = pidAlive, tidy = false } = {},
) {
  let names;
  try {
    names = fs.readdirSync(leasesDir);
  } catch {
    return [];
  }
  const live = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(leasesDir, name);
    let lease;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(file).mtimeMs;
      lease = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      // half-written by a heartbeat this instant, or removed under us: the next tick reads it again
      continue;
    }
    if (now - mtimeMs <= staleMs && alive(lease?.pid)) live.push({ file, ...lease });
    else if (tidy) fs.rmSync(file, { force: true });
  }
  return live;
}

/** Creates `file` for this process, or returns false when it exists. */
function createLockFile(file, now) {
  try {
    const fd = fs.openSync(file, "wx");
    try {
      fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: new Date(now).toISOString() }));
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    return false;
  }
}

/** What a lock file says right now: its bytes, its mtime and its holder (null when unreadable). */
function inspectLock(file) {
  let mtimeMs;
  let raw;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null; // removed under us
  }
  let holder = null;
  try {
    holder = JSON.parse(raw);
  } catch {
    // empty or half-written: its writer died between creating it and writing it, or is writing now
  }
  return { mtimeMs, raw, holder };
}

function abandonedLock(seen, { now, staleMs, graceMs, alive }) {
  const age = now - seen.mtimeMs;
  if (age > staleMs) return true;
  return seen.holder ? !alive(seen.holder.pid) : age > graceMs;
}

/**
 * Removes `seen` only if it is STILL the lock on disk, under a short breaker lock of its own, so two runs
 * breaking the same dead lock cannot both end up holding the new one (the second would otherwise remove
 * the first one's fresh lock). A breaker whose holder died is itself broken.
 */
function breakLock(lockFile, seen, { now, graceMs, alive }) {
  const breaker = `${lockFile}.break`;
  if (!createLockFile(breaker, now)) {
    const other = inspectLock(breaker);
    if (other && abandonedLock(other, { now, staleMs: 10_000, graceMs, alive })) fs.rmSync(breaker, { force: true });
    return;
  }
  try {
    const again = inspectLock(lockFile);
    if (again && again.raw === seen.raw && again.mtimeMs === seen.mtimeMs) fs.rmSync(lockFile, { force: true });
  } finally {
    fs.rmSync(breaker, { force: true });
  }
}

/**
 * Takes the lock, or returns false. A lock whose holder is dead, that nobody could read for longer than
 * `graceMs`, or that is older than `staleMs`, is broken first: nobody holds it longer than a Chrome start.
 */
export function tryLock(
  lockFile,
  { staleMs = SHARED_BROWSER_DEFAULTS.lockStaleMs, graceMs = SHARED_BROWSER_DEFAULTS.lockGraceMs, now = Date.now(), alive = pidAlive } = {},
) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (createLockFile(lockFile, now)) return true;
    const seen = inspectLock(lockFile);
    if (!seen) continue; // let go of just now: try again
    if (!abandonedLock(seen, { now, staleMs, graceMs, alive })) return false;
    breakLock(lockFile, seen, { now, graceMs, alive });
  }
  return false;
}

export function unlock(lockFile) {
  const holder = readJsonFile(lockFile);
  if (holder?.pid === process.pid) fs.rmSync(lockFile, { force: true });
}

/** Waits for the lock, up to `timeoutMs`. */
async function takeLock(lockFile, { timeoutMs, staleMs, graceMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (tryLock(lockFile, { staleMs, graceMs })) return true;
    await sleep(100);
  }
  return false;
}

async function reachable(wsEndpoint, timeout) {
  try {
    const browser = await chromium.connect(wsEndpoint, { timeout });
    await browser.close(); // on a connected browser this only hangs up; the server keeps running
    return true;
  } catch {
    return false;
  }
}

/** The published host when its process is alive (answering or not); otherwise null. */
function liveHost(stateFile) {
  const state = readJsonFile(stateFile);
  if (!state?.wsEndpoint || state.protocol !== SHARED_BROWSER_PROTOCOL || !pidAlive(state.pid)) return null;
  return state;
}

/**
 * Runs the launch hop OUTSIDE this process's Windows job. `detached: true` does not leave a job: when the
 * run (or the MCP server / CLI it runs under) sits in a KILL_ON_JOB_CLOSE job, the host and its Chrome
 * died with that tree whoever still held a lease (2026-10-11, runs f289 and 183910-dc2e: the host
 * vanished with no closing line the moment the run that started it finished). A process made by WMI
 * (Win32_Process.Create) is a child of the WMI service, in no job of ours. Returns how it was started.
 */
function launchHop({ configFile, env }) {
  if (process.platform === "win32" && !env.SUE_HOST_NO_WMI) {
    const psScript = [
      "$ErrorActionPreference='Stop'",
      "$e=[Environment]::GetEnvironmentVariables(); $lines=@(); foreach($k in $e.Keys){ if($k -ne 'SUE_HOP_CMD'){ $lines+=\"$k=$($e[$k])\" } }",
      "$su=New-CimInstance -ClassName Win32_ProcessStartup -ClientOnly -Property @{ShowWindow=[uint16]0; EnvironmentVariables=[string[]]$lines}",
      "$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine=$env:SUE_HOP_CMD; CurrentDirectory=(Get-Location).Path; ProcessStartupInformation=$su}",
      "if($r.ReturnValue -ne 0){ exit 3 }",
    ].join(";");
    const out = spawnSync(
      "powershell",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", psScript],
      {
        env: { ...env, SUE_HOP_CMD: `"${process.execPath}" "${HOST_SCRIPT}" launch "${configFile}"` },
        windowsHide: true,
        timeout: 30_000,
      },
    );
    if (out.status === 0) return "WMI (outside this process's job)";
  }
  const hop = spawn(process.execPath, [HOST_SCRIPT, "launch", configFile], { detached: true, stdio: "ignore", windowsHide: true, env });
  hop.unref();
  return "a detached child (still inside this process's job, if it has one)";
}

/** Starts a host (two hops, so it is nobody's child) and waits for its Chrome to answer. */
async function startHost({ paths, config, env, timeoutMs, probeTimeoutMs }) {
  fs.rmSync(paths.state, { force: true });
  writeJsonAtomic(paths.config, config);
  const how = launchHop({ configFile: paths.config, env });
  try {
    fs.appendFileSync(paths.log, `${new Date().toISOString()} [run pid ${process.pid}] started the host through ${how}
`);
  } catch {
    // the log is for the next post-mortem only
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = liveHost(paths.state);
    if (state && (await reachable(state.wsEndpoint, probeTimeoutMs))) return state;
    const failed = readJsonFile(`${paths.state}.failed`);
    if (failed && Date.parse(failed.at) >= Date.parse(config.requestedAt))
      throw new Error(`the shared browser did not start: ${failed.why}`);
    await sleep(200);
  }
  throw new Error(`the shared browser did not answer within ${Math.round(timeoutMs / 1000)} s (its log: ${paths.log})`);
}

/**
 * Joins the machine's shared Sue browser for `runId`, starting it if nobody has. Returns
 * `{ wsEndpoint, hostPid, browserPid, started, key, release() }`; `release()` takes this run's lease away
 * (the host closes the browser once no lease is left). Throws when it can neither join nor start one.
 */
export async function acquireSharedBrowser({
  runId,
  mode,
  executablePath,
  args,
  dir = sharedBrowserDir(),
  env = process.env,
  options = {},
}) {
  const o = { ...SHARED_BROWSER_DEFAULTS, ...options };
  const key = browserKey({ mode, executablePath, args });
  const paths = sharedBrowserPaths(dir, key);
  fs.mkdirSync(paths.leases, { recursive: true });
  const leaseFile = path.join(paths.leases, `${runId}.json`);
  let hostPid = null;
  const writeLease = () => writeJsonAtomic(leaseFile, { runId, pid: process.pid, hostPid, at: new Date().toISOString() });

  // As long as a live holder may keep it (a probe plus a Chrome start); past that it is broken anyway.
  if (!(await takeLock(paths.lock, { timeoutMs: o.lockStaleMs, staleMs: o.lockStaleMs, graceMs: o.lockGraceMs })))
    throw new Error(`the shared browser's lock stayed taken for ${Math.round(o.lockStaleMs / 1000)} s`);
  let state;
  let started = false;
  try {
    state = liveHost(paths.state);
    if (state) {
      // A live host that does not answer is never replaced (A LIVE HOST IS NEVER REPLACED, above).
      if (!(await reachable(state.wsEndpoint, o.probeTimeoutMs)) && !(await reachable(state.wsEndpoint, o.probeTimeoutMs)))
        throw new Error(`the shared browser's host (pid ${state.pid}) is running but did not answer`);
    } else {
      started = true;
      state = await startHost({
        paths,
        env,
        timeoutMs: o.startTimeoutMs,
        probeTimeoutMs: o.probeTimeoutMs,
        config: {
          protocol: SHARED_BROWSER_PROTOCOL,
          key,
          dir,
          mode,
          executablePath,
          args,
          idleMs: o.idleMs,
          tickMs: o.tickMs,
          leaseStaleMs: o.leaseStaleMs,
          lockStaleMs: o.lockStaleMs,
          lockGraceMs: o.lockGraceMs,
          requestedAt: new Date().toISOString(),
        },
      });
    }
    hostPid = state.pid;
    writeLease(); // still under the lock: the host cannot close between our read and this lease
  } catch (err) {
    fs.rmSync(leaseFile, { force: true });
    throw err;
  } finally {
    unlock(paths.lock);
  }

  const heartbeat = setInterval(() => {
    try {
      writeLease();
    } catch {
      // a full disk or a folder somebody removed: the lease goes stale and the host closes when idle
    }
  }, o.heartbeatMs);
  heartbeat.unref?.();
  let released = false;
  return {
    key,
    wsEndpoint: state.wsEndpoint,
    hostPid: state.pid,
    browserPid: state.browserPid,
    started,
    release() {
      if (released) return;
      released = true;
      clearInterval(heartbeat);
      fs.rmSync(leaseFile, { force: true });
      try {
        fs.appendFileSync(
          paths.log,
          `${new Date().toISOString()} [run ${runId} pid ${process.pid}] released its lease on host ${state.pid}
`,
        );
      } catch {
        // the log is for the next post-mortem only
      }
    },
  };
}
