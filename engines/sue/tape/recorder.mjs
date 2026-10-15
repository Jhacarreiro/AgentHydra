/**
 * tape/recorder.mjs - a tape's recorder process: `node tape/recorder.mjs --tape <dir>`. The first miss of a round
 * starts it (tape/ask.mjs claims `recorder.lock` and spawns this detached and headless, never a window); every other
 * Sue of the round connects to it, so a tape has ONE writer and one browser per device however many Sues miss at once.
 *
 * It listens on loopback TCP (port 0), writes where into `recorder.json` (`{ pid, port, token, startedAt }`), and
 * answers one JSON line per connection: `{ token, op: "ping" | "quit" | "play", ...request }`. A play is
 * tape/read-through.mjs. It writes what it does into `recorder.log` (tape/lock.mjs) and exits after a minute with no
 * request (`SUE_TAPE_RECORDER_IDLE_MS`), when its lock is no longer its own, on a quit, or on a browser that cannot start.
 *
 * Runs under node: bun hangs on a browser launch on Windows.
 */
import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { isMainModule } from "../../lib/shared/is-main-module.mjs";
import { writeAtomic } from "./atomic.mjs";
import { infoPath, logEvent, readLock, releaseLock } from "./lock.mjs";
import { createReadThrough } from "./read-through.mjs";

const IDLE_MS = Number(process.env.SUE_TAPE_RECORDER_IDLE_MS) || 60_000;
const LOCK_WAIT_MS = 5_000;
const TICK_MS = 250;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ownsLock = (tapeDir) => readLock(tapeDir)?.pid === process.pid;

/**
 * Run the recorder for `tapeDir` until it is done; resolves when it has cleaned up (the caller then exits).
 * `idleMs` is the quiet time before it exits; `playDeadlineMs` is how long one play may take (tape/read-through.mjs).
 */
export async function runRecorder(tapeDir, { idleMs = IDLE_MS, playDeadlineMs } = {}) {
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (!ownsLock(tapeDir) && Date.now() < deadline) await sleep(50); // the client that spawned this hands the lock over
  if (!ownsLock(tapeDir)) return;

  const token = randomBytes(16).toString("hex");
  const through = createReadThrough({
    tapeDir,
    ...(playDeadlineMs ? { deadlineMs: playDeadlineMs } : {}),
    log: (...parts) => process.stderr.write(`[sue-tape-recorder] ${parts.join(" ")}\n`),
  });
  let inFlight = 0;
  let lastRequestAt = Date.now();
  let leaving = false;
  let finish;
  const done = new Promise((resolve) => (finish = resolve));

  const server = net.createServer((socket) => {
    let buffer = "";
    let answered = false;
    let counted = false;
    // A request counts as in flight until it is answered or its client is gone, so a play whose Sue hung up never keeps
    // the recorder from its idle exit.
    const release = () => {
      if (!counted) return;
      counted = false;
      inFlight -= 1;
      lastRequestAt = Date.now();
    };
    socket.on("error", () => {});
    socket.on("close", release);
    socket.on("data", async (chunk) => {
      buffer += chunk.toString("utf8");
      const end = buffer.indexOf("\n");
      if (end < 0 || answered) return;
      answered = true;
      counted = true;
      inFlight += 1;
      lastRequestAt = Date.now();
      let reply;
      try {
        const { token: given, op, ...request } = JSON.parse(buffer.slice(0, end));
        if (given !== token) reply = { ok: false, reason: "bad-token" };
        else if (op === "ping") reply = { ok: true };
        else if (op === "quit") {
          reply = { ok: true };
          setTimeout(leave, 50, "quit");
        } else if (op === "play") {
          reply = await through.play(request);
          if (reply.reason === "no-browser") setTimeout(leave, 200, "no-browser"); // nothing to record with: do not linger
        } else reply = { ok: false, reason: "bad-op" };
      } catch (err) {
        reply = { ok: false, reason: "recorder-error", detail: String(err?.message ?? err).split("\n")[0] };
      }
      release();
      socket.end(`${JSON.stringify(reply)}\n`);
    });
  });

  async function leave(why) {
    if (leaving) return;
    leaving = true;
    clearInterval(tick);
    server.close();
    await through.close().catch(() => {});
    rmSync(infoPath(tapeDir), { force: true });
    releaseLock(tapeDir);
    logEvent(tapeDir, "exit", { why });
    unhook();
    finish();
  }

  const tick = setInterval(() => {
    if (!ownsLock(tapeDir)) leave("lock-lost");
    else if (inFlight === 0 && Date.now() - lastRequestAt > idleMs) leave("idle");
  }, TICK_MS);

  const onSignal = (signal) => leave(signal);
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, onSignal);
  const fatal = (err) => {
    try {
      logEvent(tapeDir, "fatal", {
        detail: String(err?.stack ?? err)
          .split("\n")
          .slice(0, 3)
          .join(" | "),
      });
    } catch {
      // the tape folder is gone; nothing to log into
    }
    leave("fatal");
  };
  const unhook = () => {
    for (const signal of ["SIGINT", "SIGTERM"]) process.off(signal, onSignal);
    process.off("uncaughtException", fatal);
    process.off("unhandledRejection", fatal);
  };
  process.on("uncaughtException", fatal);
  process.on("unhandledRejection", fatal);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  writeAtomic(
    infoPath(tapeDir),
    `${JSON.stringify({ pid: process.pid, port: server.address().port, token, startedAt: new Date().toISOString() })}\n`,
  );
  logEvent(tapeDir, "started", { port: server.address().port });
  await done;
}

if (isMainModule(import.meta.main, import.meta.url)) {
  const at = process.argv.indexOf("--tape");
  const tapeDir = at >= 0 && process.argv[at + 1] ? path.resolve(process.argv[at + 1]) : null;
  if (!tapeDir) {
    process.stderr.write("usage: node tape/recorder.mjs --tape <dir>\n");
    process.exit(2);
  }
  runRecorder(tapeDir).then(
    () => process.exit(0),
    (err) => {
      process.stderr.write(`[sue-tape-recorder] fatal: ${err?.stack ?? err}\n`);
      process.exit(1);
    },
  );
}
