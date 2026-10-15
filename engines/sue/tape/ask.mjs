/**
 * tape/ask.mjs - how a tape body asks the tape's recorder to play a missed move live. No browser and no playwright
 * here: a Sue's process only talks to the recorder (tape/recorder.mjs), which owns the browsers and is the one writer
 * of the tape. The first miss starts it (this file claims `recorder.lock`, tape/lock.mjs, then spawns it detached and
 * headless); every other Sue of the round finds it through `recorder.json` and connects over loopback TCP.
 *
 * The wire is one JSON line each way, with the token the recorder wrote in `recorder.json`:
 *   { op: "ping" | "quit" | "play", ...request }  ->  { ok, ... }
 * A play's reply is `{ ok: true, recorded, from, to }` or `{ ok: false, reason, detail? }`; the reasons are
 * `unreachable` (the Sue's screen could not be reached by replaying her path), `start-failed`, `timeout`, `no-browser`, and, from
 * this file, `no-recorder`.
 */
import { spawn } from "node:child_process";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { claimLock, handOver, hasLock, infoPath, pidAlive, readInfo, readLock, releaseLock } from "./lock.mjs";

const RECORDER = path.join(path.dirname(fileURLToPath(import.meta.url)), "recorder.mjs");
/** How long a miss waits for a recorder to come up (a cold start imports playwright and loads the site's config). */
const START_WAIT_MS = 30_000;
const PING_TIMEOUT_MS = 3_000;
/** A play is a whole walk of the Sue's path, behind the plays already queued for its device. */
const PLAY_TIMEOUT_MS = Number(process.env.SUE_TAPE_ASK_TIMEOUT_MS) || 180_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request to the recorder named by `info`; rejects with `{ code: "refused" | "closed" | "timeout" }`. */
function rpc(info, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: info.port });
    let buffer = "";
    let done = false;
    const finish = (fn, value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error("the recorder did not answer"), { code: "timeout" })), timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify({ token: info.token, ...message })}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(resolve, JSON.parse(buffer.slice(0, end)));
      } catch (err) {
        finish(reject, Object.assign(err, { code: "closed" }));
      }
    });
    socket.on("error", (err) => finish(reject, Object.assign(err, { code: err?.code === "ECONNREFUSED" ? "refused" : "closed" })));
    socket.on("close", () => finish(reject, Object.assign(new Error("the recorder closed the connection"), { code: "closed" })));
  });
}

/** Does the recorder of this tape answer a ping now? */
export async function recorderAnswers(tapeDir) {
  const info = readInfo(tapeDir);
  if (!info || !pidAlive(info.pid)) return false;
  try {
    return (await rpc(info, { op: "ping" }, PING_TIMEOUT_MS))?.ok === true;
  } catch {
    return false;
  }
}

/** `node` for the recorder: this process's own when it is node (bun hangs on playwright's browser launch on Windows). */
const nodeBinary = () => (path.basename(process.execPath).toLowerCase().startsWith("node") ? process.execPath : "node");

/** Start the recorder detached and headless; the lock (claimed by this process) is handed to it. False when it did not start. */
function startRecorder(tapeDir) {
  const child = spawn(nodeBinary(), [RECORDER, "--tape", tapeDir], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: process.env,
  });
  child.on("error", () => {}); // a node that cannot start is seen below as no pid
  child.unref();
  if (!Number.isInteger(child.pid)) {
    releaseLock(tapeDir);
    return false;
  }
  handOver(tapeDir, child.pid);
  return true;
}

/** The recorder's address, starting the recorder when nobody owns the tape's lock. Null when none came up. */
async function ensureRecorder(tapeDir) {
  const deadline = Date.now() + START_WAIT_MS;
  while (Date.now() < deadline) {
    const info = readInfo(tapeDir);
    if (info && pidAlive(info.pid) && (await recorderAnswers(tapeDir))) return info;
    if (await claimLock(tapeDir, { answers: () => recorderAnswers(tapeDir) })) {
      if (!startRecorder(tapeDir)) return null;
    }
    await sleep(100);
  }
  return null;
}

/**
 * Ask the tape's recorder to play a missed move (`request` is `{ device, from, fromPath, control, fills, checks,
 * reason, round, sueId, runId }`). Resolves to the recorder's reply; `{ ok: false, reason: "no-recorder" }` when none
 * could be reached.
 */
export async function askRecorder(tapeDir, request) {
  let detail = "no recorder came up";
  for (let attempt = 0; attempt < 2; attempt++) {
    const info = await ensureRecorder(tapeDir);
    if (!info) break;
    try {
      return await rpc(info, { op: "play", ...request }, PLAY_TIMEOUT_MS);
    } catch (err) {
      detail = String(err?.message ?? err);
      if (err?.code === "timeout") break; // a recorder busy for minutes is not asked twice
    }
  }
  return { ok: false, reason: "no-recorder", detail };
}

/** Is the site a tape was recorded from answering at `url`? A TCP connect, `timeoutMs` at most. */
export function siteReachable(url, timeoutMs = 2_000) {
  return new Promise((resolve) => {
    let target;
    try {
      target = new URL(url);
    } catch {
      return resolve(false);
    }
    const socket = net.connect({
      host: target.hostname.replace(/^\[|\]$/g, ""),
      port: Number(target.port) || (target.protocol === "https:" ? 443 : 80),
    });
    const finish = (up) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(up);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    socket.on("connect", () => finish(true));
    socket.on("error", () => finish(false));
  });
}

/**
 * Ask a tape's recorder to finish and wait until it has (its lock gone). Only a recorder that answers a ping carrying
 * the token of `recorder.json` is this tape's recorder: that one is asked to quit and, if it will not leave, ended.
 * A `recorder.json` whose process does not answer with the token (a stale file, a pid some other program reused) is
 * only removed with the lock that names it; its pid is never signalled.
 */
export async function stopRecorder(tapeDir, { waitMs = 10_000 } = {}) {
  const info = readInfo(tapeDir);
  const mine = Boolean(info?.token) && Number.isInteger(info.pid) && (await recorderAnswers(tapeDir));
  if (mine) await rpc(info, { op: "quit" }, PING_TIMEOUT_MS).catch(() => {});
  const deadline = Date.now() + waitMs;
  while (mine && Date.now() < deadline && (hasLock(tapeDir) || pidAlive(info.pid))) await sleep(100);
  if (mine && pidAlive(info.pid)) {
    try {
      process.kill(info.pid); // answered with this tape's token; it had its chance to leave
    } catch {
      // it went by itself
    }
  }
  if (!mine && info) {
    rmSync(infoPath(tapeDir), { force: true });
    const held = readLock(tapeDir);
    if (held && !held.unreadable && (held.pid === info.pid || !pidAlive(held.pid))) releaseLock(tapeDir, held.pid);
  }
  return !hasLock(tapeDir) && !(mine && pidAlive(info.pid)) && !readInfo(tapeDir);
}
