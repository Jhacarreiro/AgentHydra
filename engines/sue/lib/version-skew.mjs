/**
 * version-skew - the SUE a long-lived Sue Manager is RUNNING, against the SUE now on this disk.
 * ==============================================================================================
 *
 * 2026-09-22 (ARGUS: 884 answers of HTTP 500 from 127.0.0.1:47470/api/workspaces/<id>): a Manager
 * started before commit 3320ad1582 still ran the persona loader it had loaded, which required `model`,
 * while the roster files on disk no longer carried one, so every workspace view failed until somebody
 * restarted it. Its hello named the disk's version all along (lib/version.mjs is read afresh every
 * minute), so nothing on the page could tell that the code answering was older than the code on disk.
 *
 * So the Manager knows the SUE it started on (`runningSue`): the commit is read off .git the moment it
 * starts, and its landed number is counted for THAT commit, asked again until git answers (2026-09-25:
 * a first count that timed out was kept for good, so the live Manager's hello said `SUE 1.?` and
 * `sueStale: false` all day). Its hello says whether the disk's landed number has moved past it
 * (`sueReport`), and says `null` while either number is unknown, never "current". Unlanded files are not
 * compared: on a shared tree they change with every edit a peer makes.
 *
 * Moving onto new code is lib/manager-refresh.mjs's watch, which hands the port over with `handOver`
 * below once nothing would be cut short (`countingLogins` counts the sign-in windows). A Manager is
 * started from the checkout by `sue run` when nothing listens on the port (lib/watch-window.mjs
 * startManager), so the old Manager starts its successor itself and quits only once the successor
 * answers the page's hello, and still does a moment later; one that never does (it never binds, fails
 * every request, or dies) is ended and the old one listens again. The desktop app that ran
 * a Manager as its child and respawned it on exit (sue/desktop, with its engine store) was retired
 * from the tree in 0ab95ba535. A Manager another process still runs that way (`supervisedManager`)
 * never hands its port over, since its supervisor would respawn it onto the port its successor holds:
 * it only reports that it is stale.
 */
import { spawn as spawnProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { stateRoot } from "./run-dir.mjs";
import { readHeadCommit, readLandedVersionAsync, readStamp, readUnlandedAsync, stampFrom } from "./version.mjs";
import { managerListening } from "./watch-window.mjs";

/** A version git counted: `1.57`. `1.?` (git did not answer) is no version to compare. */
const LANDED = /^\d+\.\d+$/;

/** true: the landed SUE on disk is the one running; false: the disk has moved on; null: either is unknown. */
export function sameLandedSue(running, disk) {
  const was = String(running?.version ?? "");
  const now = String(disk?.version ?? "");
  if (!LANDED.test(was) || !LANDED.test(now)) return null;
  return was === now;
}

/**
 * Hello's version fields: `sue` is the SUE this Manager runs (what the page and a wave it starts get),
 * `sueOnDisk` the one on disk, and `sueStale` whether the disk has moved on from it: null while either
 * number is unknown (git has not counted it yet), never a guessed "current".
 */
export function sueReport(running, disk) {
  const same = sameLandedSue(running, disk);
  return { sue: running ?? null, sueOnDisk: disk ?? null, sueStale: same === null ? null : !same };
}

/** How long a count git did not answer waits before it is asked again. */
const RECOUNT_MS = 30_000;

/**
 * The SUE a process started on, as `running()`, which resolves its stamp. The commit is taken at once
 * (`head`, off the .git files), so what it runs is known however slow git is; its landed number is
 * counted for that commit (`landed`), and a count git did not answer (`SUE 1.?`) is asked again every
 * `retryMs` until it is a real number, so a late count still describes the code this process loaded,
 * never a commit that landed after it. The unlanded files are the ones listed as it started. The first
 * ask waits for the first count; later ones get the last stamp at once while a recount runs behind them.
 * An installer's stamp (`stamp`) is the answer from the start.
 */
export function runningSueTracker({
  stamp = readStamp,
  head = readHeadCommit,
  unlanded = readUnlandedAsync,
  landed = readLandedVersionAsync,
  retryMs = RECOUNT_MS,
  now = Date.now,
} = {}) {
  const baked = stamp();
  if (baked) return async () => baked;
  const sha = head();
  if (!sha) {
    const unknown = stampFrom({ count: null, commit: null, status: null });
    return async () => unknown;
  }
  const status = unlanded();
  let last = null;
  let reading = null;
  let askedAt = 0;
  function count() {
    askedAt = now();
    reading = (async () => {
      try {
        const counted = await landed(sha, await status);
        last = { ...counted, commit: counted.commit ?? sha.slice(0, 10) };
        return last;
      } finally {
        reading = null;
      }
    })();
    return reading;
  }
  return function running() {
    if (LANDED.test(String(last?.version ?? ""))) return Promise.resolve(last);
    if (!last) return reading ?? count();
    if (!reading && now() - askedAt >= retryMs) void count();
    return Promise.resolve(last);
  };
}

let tracker = null;

/** The SUE this process started on (`runningSueTracker`): the Manager asks first as it starts. */
export function runningSue() {
  tracker ??= runningSueTracker();
  return tracker();
}

/**
 * Whether another process runs this Manager as its child and restarts it when it exits: forked with a
 * channel to its parent (`send`), or started with SUE_MANAGER_SUPERVISED=1.
 */
export function supervisedManager({ send = process.send, env = process.env } = {}) {
  return typeof send === "function" || env.SUE_MANAGER_SUPERVISED === "1";
}

/**
 * The successor's flags: this Manager's own, never a second window (hers is open already, or was never
 * wanted), and --handover, so it takes the toolbar without greeting anyone: a code change is not news.
 */
export function successorArgs(argv) {
  const args = [...argv];
  for (const flag of ["--no-open", "--handover"]) if (!args.includes(flag)) args.push(flag);
  return args;
}

/**
 * Start a Manager like this one on the code now on disk, hidden, logging where `sue run`'s Managers log.
 * Returns its process, so a hand-over it fails can end it.
 */
export function startSuccessor(argv, { script = process.argv[1], spawn = spawnProcess } = {}) {
  const dir = path.join(stateRoot(), "manager");
  fs.mkdirSync(dir, { recursive: true });
  const log = fs.openSync(path.join(dir, "manager.log"), "a");
  try {
    const child = spawn(process.execPath, [...process.execArgv, script, ...successorArgs(argv)], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
    });
    child.unref();
    return child;
  } finally {
    fs.closeSync(log);
  }
}

/** Marks the hand-over's own question, so the Manager answering it does not count it as a page looking. */
export const HANDOVER_HEADER = "x-sue-handover";

/**
 * Whether a Manager on `port` answers the page: its hello (GET /api/hello, the page's own first question,
 * from `origin`, the page's origin, which the Manager requires) answered 200. A bare TCP accept proved
 * nothing: the kernel accepts into the backlog before the new code has run a line of a request.
 */
export function managerAnswers(port, { origin = null, timeoutMs = 2_000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        host: "127.0.0.1",
        port,
        path: "/api/hello",
        timeout: timeoutMs,
        headers: { [HANDOVER_HEADER]: "1", ...(origin ? { origin } : {}) },
      },
      (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      },
    );
    req.once("timeout", () => req.destroy());
    req.once("error", () => resolve(false));
  });
}

/**
 * Give this Manager's port to a successor: stop listening (dropping the page's open connections, which
 * would hold the port), start it, and wait for it to answer the page (`answers`, managerAnswers), and
 * still answer a moment later (`confirmMs`): "handed-over". When it does not, it is ended (`start`
 * returns its process) and this Manager listens again: "kept". A successor that cannot start, or starts
 * and then fails every request or dies (a file half-edited on this shared tree), must not leave the page
 * with no working Manager at all. A supervised Manager (`supervisedManager`) keeps its port and starts
 * nothing: "supervised".
 */
export async function handOver({
  server,
  port,
  start,
  supervised = supervisedManager(),
  answers = (at) => managerAnswers(at),
  waitMs = 15_000,
  stepMs = 250,
  confirmMs = 2_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (supervised) return "supervised";
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  });
  let answered = false;
  let successor = null;
  try {
    successor = start();
    // By the clock, not by steps: a hello that hangs takes its own timeout on every try.
    for (const by = Date.now() + waitMs; !answered && Date.now() < by;) {
      await sleep(stepMs);
      answered = await answers(port);
    }
    if (answered) {
      await sleep(confirmMs);
      answered = await answers(port);
    }
  } finally {
    if (!answered) {
      // A successor that holds the port without answering the page is ended first, so the port is free.
      try {
        successor?.kill?.();
      } catch {
        /* already gone */
      }
      for (let waited = 0; waited < 5_000 && (await managerListening(port)); waited += stepMs) await sleep(stepMs);
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
    }
  }
  return answered ? "handed-over" : "kept";
}

/**
 * `open` (manager.mjs startLoginWindow) as it was, counting the sign-in windows it opened that have not
 * closed yet: a restart would lose how each one ends, so an open one keeps the Manager as it is.
 */
export function countingLogins(open) {
  let count = 0;
  return {
    open(login, options = {}) {
      const onExit = options.onExit ?? (() => {});
      count += 1;
      try {
        return open(login, {
          ...options,
          onExit: (code) => {
            count -= 1;
            onExit(code);
          },
        });
      } catch (err) {
        count -= 1;
        throw err;
      }
    },
    count: () => count,
  };
}
