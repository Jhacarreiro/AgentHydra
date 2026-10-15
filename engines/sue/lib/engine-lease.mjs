/**
 * engine-lease - which snapshot of Sue's code this process runs, and the lease it keeps in that snapshot
 * while it runs.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-25): "someone starts a Sue on 1.14, you push 1.15, all the Sues keep
 * running on 1.14, all new Sues start on 1.15, we never stop the current Sues." Sue runs from source
 * only (the Chair, 2026-09-25), so `sue run` copies the code it is about to run into a snapshot and starts
 * the wave from there (lib/engine-store.mjs):
 *
 *   <store>/<id>/sue/...            this code
 *   <store>/<id>/.sue-engine.json         { id, commit, checkout, files, stagedAt }, written last
 *   <store>/<id>/.leases/<pid>.json       { pid, startedAtMs, role, runId?, at }
 *
 * The store deletes a snapshot only once no live process leases it. So every long-lived process that
 * runs a snapshot's code (a run's detached runner, a CLI while it works) takes a lease the moment it
 * starts and drops it on exit. A process killed outright leaves its lease behind; the collector reads
 * that as dead because the pid is gone, or now names a later process whose creation time is not the
 * `startedAtMs` written here (within 10 s).
 *
 * In the checkout itself there is no manifest two folders up, so there is no engine and nothing is
 * written: the checkout's code is not a snapshot, it is the thing snapshots are taken of.
 *
 * DEPENDED ON BY: lib/run-dir.mjs and lib/workspaces.mjs (a snapshot's state and workspace are the
 * checkout's), sue.mjs (the runner's and the CLI's leases, the engine on a run's record, routing a
 * command to a live run's own snapshot), lib/hand-move.mjs (a move for a live run on another snapshot),
 * lib/engine-store.mjs (staging and collecting). Node built-ins only: run-dir.mjs imports this, and
 * everything imports run-dir.mjs. Spec: tests/engine-lease.spec.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** This code's sue folder. */
const SUE_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const ENGINE_MANIFEST = ".sue-engine.json";
export const LEASES_DIR = ".leases";
/**
 * Set on a command one snapshot hands to another (sue.mjs routeLiveRun): the snapshot that receives it
 * carries it out itself, whatever it finds, so two snapshots can never hand one command back and forth.
 */
export const ROUTED_ENV = "SUE_ENGINE_ROUTED";

/** A snapshot's manifest, or null for a folder that is not a whole snapshot (the manifest is written last). */
export function readEngineManifest(root) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, ENGINE_MANIFEST), "utf8"));
    return typeof manifest?.id === "string" && manifest.id ? manifest : null;
  } catch {
    return null;
  }
}

/**
 * The snapshot whose sue folder is `sueDir` (this code's by default): `{ id, root, exe }`, where
 * `root` is the snapshot's folder and `exe` the node running it. null in the checkout itself.
 */
export function engineInfo(sueDir = SUE_DIR) {
  const root = path.resolve(sueDir, "..");
  const manifest = readEngineManifest(root);
  return manifest ? { id: manifest.id, root, exe: process.execPath } : null;
}

/**
 * The checkout this code came from: the one a snapshot's manifest names, else the repo this file sits
 * in. A snapshot keeps its state, its runs and its default workspace in the checkout, never beside its
 * own copy of the code, which the store deletes once no run needs it.
 */
export function checkoutRoot(sueDir = SUE_DIR) {
  const here = path.resolve(sueDir, "..");
  const checkout = readEngineManifest(here)?.checkout;
  return typeof checkout === "string" && checkout ? path.resolve(checkout) : here;
}

/** This process's start as Windows recorded it, once `pinProcessStart` was told it. */
let pinnedStart = null;

/**
 * When this process started, in epoch ms: what the store's collector compares with the OS's creation
 * time of the pid (within 10 s). The OS's own time once pinned, else node's estimate, which runs late by
 * however long node took to start; a long-lived process on a loaded box pins it.
 */
export function processStartedAtMs() {
  return pinnedStart ?? Math.round(Date.now() - process.uptime() * 1000);
}

/**
 * Use the OS's own creation time of this process (epoch ms; the runner reads it once, as sue.mjs
 * pidCreatedAt) as its start from now on; null leaves node's estimate.
 */
export function pinProcessStart(ms) {
  if (Number.isFinite(ms) && ms > 0) pinnedStart = Math.round(ms);
  return processStartedAtMs();
}

/**
 * Write the lease `pid` holds on the snapshot at `root`, whole or not at all: written aside and renamed
 * in, so the collector never reads half a lease. Returns the lease file. Throws when `root` is not a
 * whole snapshot any more, and never makes its folder: a lease written just after the store collected
 * it used to make the id's folder again with nothing in it but .leases, and every later stage of that
 * id found its name taken (2026-09-25).
 */
export function writeLease(root, { pid, startedAtMs, role, ...extra }) {
  if (!fs.existsSync(path.join(root, ENGINE_MANIFEST)))
    throw new Error(`${root} is not a whole snapshot of Sue's code (the store may have just collected it): no lease written`);
  const dir = path.join(root, LEASES_DIR);
  try {
    fs.mkdirSync(dir);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const file = path.join(dir, `${pid}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ pid, startedAtMs, role, ...extra, at: new Date().toISOString() })}\n`);
  fs.renameSync(tmp, file);
  return file;
}

/**
 * The leases on the snapshot at `root`. A lease written badly keeps its pid from the file name and no
 * start time, so it counts as live while that pid exists: never drop a snapshot on a lease nobody
 * could read.
 */
export function readLeases(root) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, LEASES_DIR));
  } catch {
    return [];
  }
  const leases = [];
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    let body = null;
    try {
      body = JSON.parse(fs.readFileSync(path.join(root, LEASES_DIR, name), "utf8"));
    } catch {
      /* unreadable: the pid from its name, no start time */
    }
    leases.push({
      pid: Number(match[1]),
      startedAtMs: Number.isFinite(body?.startedAtMs) ? body.startedAtMs : null,
      role: body?.role ?? null,
      runId: body?.runId ?? null,
    });
  }
  return leases;
}

/**
 * Lease this process's snapshot for as long as it runs, removed when the process exits. `role` says
 * what it is ("runner", "cli") and `extra` is written beside it (a runner's `runId`). Returns the lease
 * file, or null in the checkout. A lease that cannot be written throws: a snapshot with a live process
 * and no lease is one the next collection deletes.
 */
export function takeLease(role, extra = {}, { engine = engineInfo() } = {}) {
  if (!engine) return null;
  const file = writeLease(engine.root, { pid: process.pid, startedAtMs: processStartedAtMs(), role, ...extra });
  process.once("exit", () => {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // Windows refused this once: the pid is dead from now on, and the collector reads a dead pid as no lease.
    }
  });
  return file;
}

const norm = (p) => {
  const resolved = path.resolve(p);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};

/**
 * The snapshot a command about a LIVE run must be carried out by instead of this code: the run's own
 * (`engine` off its record), when there is one, it is not the snapshot this process runs, and it is
 * still whole in the store. null means: do it here, as always (the same snapshot, a run from before
 * snapshots, or one the store has since collected, which it only does once none of its runs is alive).
 * A process that was itself handed a command (ROUTED_ENV) never hands it on.
 */
export function otherEngine(engine, self = engineInfo()) {
  if (process.env[ROUTED_ENV] === "1") return null;
  if (!engine || typeof engine.root !== "string" || !engine.root) return null;
  if (self && norm(self.root) === norm(engine.root)) return null;
  if (!readEngineManifest(engine.root) || !fs.existsSync(path.join(engine.root, "sue", "sue.mjs"))) return null;
  // The node that started the run, while it is still on this machine; else this one.
  const exe = typeof engine.exe === "string" && engine.exe && fs.existsSync(engine.exe) ? engine.exe : process.execPath;
  return { ...engine, exe };
}
