#!/usr/bin/env node
/**
 * people-door - one warm people door, held open between rounds.
 * =============================================================
 *
 * WHY: a round whose every visit is unchanged starts nothing (lib/reuse.mjs), yet it still opened a local Connections MCP
 * (2.6-5.4 s) and made a first people call (1.2 s) it had opened a minute before. This is a small long-lived local
 * process that keeps ONE open door (lib/people.mjs `openPeopleDoor`) and answers the calls `findReuse` makes through it.
 * Every answer is a LIVE call through the held door at the moment it is asked; nothing is remembered between requests.
 *
 *   node sue/people-door.mjs --root <workspace>
 *
 * It listens on 127.0.0.1 only, on a port and a random token it writes to `<root>/.sue/people-door.json` (one per
 * workspace root), and refuses any request without the token. It answers three things, nothing else:
 *   POST /ping                 { ok: true }
 *   POST /door  { tool, body } the held door's own answer, for the two reads (the Sue list, one critic's mind), which
 *                              the door reads from the persona store (lib/people-store.mjs) in the Boardroom's shapes
 *   POST /builds { entries }   lib/reuse.mjs `fetchBuilds`, over this process's own kept-alive connections
 *   POST /identity { builds, engine, people } all of the above in ONE local call, side by side inside the holder:
 *                              the builds' HEADs, the engine id (lib/engine-store.mjs `currentEngineId`: a stat of every file
 *                              of the closure, a full hash only when one changed), the Sue list and the critics' minds
 * Its HEAD connections are kept open (one undici Agent) and re-warmed by one more live HEAD at most once a minute while it
 * lives; that never resets the idle exit. If its own code (this file, engine-store, engine-lease) changed on disk since it
 * started it answers engine: null (the client hashes for itself) and exits after answering.
 * The MCP child keeps the credentials; none is ever read, logged or returned here. A held door that dies is reopened once
 * and the call is answered; the holder exits by itself after 30 minutes with no request and removes its state file. A
 * second holder started for a root that already has a live one exits at once.
 *
 * Started, detached and hidden, by `round.mjs report` (at its end) and by a `start` that had to open a door itself;
 * asked by `findReuse` (`warmDoor`), which falls back to opening a door when no holder answers.
 */
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Quiet this long and the holder lets go of its door and exits. */
export const IDLE_MS = 30 * 60_000;
/** How long a caller waits for a holder to say it is alive before it opens a door itself. */
export const PING_MS = 100;
/** A call through the door is as slow as the door is (a cold list is over a second), so its wait is long. */
const CALL_MS = 120_000;
/** The far end of a HEAD connection may close it when idle; one more live HEAD this often keeps it open (never resets the idle exit). */
export const REWARM_MS = 60_000;
/** How long the holder's own HEAD connections are allowed to sit idle on its side. */
const KEEP_MS = 10 * 60_000;
/** The holder's own code: if any of it changes on disk after the holder started, its engine answer is no longer trusted. */
const CODE_FILES = [
  fileURLToPath(import.meta.url),
  ...["engine-store.mjs", "engine-lease.mjs"].map((f) => fileURLToPath(new URL(`./lib/${f}`, import.meta.url))),
];
/** The only tools the holder will pass on: the two reads `findReuse` makes. Never a save. */
const READS = new Set(["boardroom_personas_sue_list", "boardroom_personas_sue_mind"]);

/** Where a root's holder writes its port and token. A root with no `.sue` folder yet gets one made. */
export function holderStateFile(root, { stateDir } = {}) {
  if (stateDir) return path.join(stateDir, `people-door-${createHash("sha256").update(String(root)).digest("hex").slice(0, 12)}.json`);
  return path.join(root, ".sue", "people-door.json");
}

/** A file's size, write time and change time, without reading it (ctime moves on every write, even one that restores mtime). */
const statLine = (file) => {
  try {
    const st = fs.statSync(file);
    return `${st.size}\0${st.mtimeMs}\0${st.ctimeMs}`;
  } catch {
    return "gone";
  }
};

/** undici's fetch over one Agent whose connections stay open for minutes; null (the global fetch) when undici is not there. */
async function keptFetch() {
  try {
    const { Agent, fetch: undiciFetch } = await import("undici");
    const agent = new Agent({ keepAliveTimeout: KEEP_MS, keepAliveMaxTimeout: KEEP_MS });
    return (url, init) => undiciFetch(url, { ...init, dispatcher: agent });
  } catch {
    return null;
  }
}

const readState = (file) => {
  try {
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    return Number.isInteger(s?.port) && typeof s?.token === "string" ? s : null;
  } catch {
    return null;
  }
};

// node:http, not fetch: a fresh process's first fetch loads undici first (about 30-40 ms measured here, against 7 ms).
function post(state, route, payload, ms) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port: state.port,
        path: route,
        method: "POST",
        headers: { "x-sue-token": state.token, "content-type": "application/json" },
        signal: AbortSignal.timeout(ms),
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("error", reject);
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode > 299) return reject(new Error(`the people holder answered HTTP ${res.statusCode}`));
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on("error", reject);
    req.end(JSON.stringify(payload ?? {}));
  });
}

/**
 * The warm holder for `root`, or null when none answers within `pingMs`: `{ door, builds }`. `door(tool, body)` answers
 * what the held door answers (`{ ok, status, body, text }`), `builds(entries)` what `fetchBuilds` answers. Never throws.
 */
export async function warmDoor({ root, stateDir, pingMs = PING_MS }) {
  const state = readState(holderStateFile(root, { stateDir }));
  if (!state) return null;
  try {
    const pong = await post(state, "/ping", {}, pingMs);
    if (!pong?.ok) return null;
  } catch {
    return null;
  }
  return {
    door: async (tool, body) => {
      try {
        return await post(state, "/door", { tool, body }, CALL_MS);
      } catch (err) {
        return { ok: false, status: null, body: null, text: String(err?.message ?? err).slice(0, 200) };
      }
    },
    builds: (entries) => post(state, "/builds", { entries }, CALL_MS),
    /** `{ builds, engine, list, minds }` in one local call; each part null when it was not asked for or did not answer. */
    identity: (request) => post(state, "/identity", request, CALL_MS),
  };
}

const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error("too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });

/**
 * Start a holder for `root`. Answers `{ port, close }`, or null when a live holder for the root exists already.
 * Injected for the specs: `openDoor({ root })` (default `openPeopleDoor`), `fetchFn`, `engineId({ checkout })` (default
 * `currentEngineId`), `codeFiles`, `now`, `timers` ({ set, clear }, the idle and re-warm clock), `onExit` (what the idle end does; the CLI's is `process.exit`), `stateDir`. `prime` (the CLI sets it) opens the
 * door and makes one list call at once, so the first real request finds both warm.
 */
export async function startHolder({
  root,
  stateDir,
  openDoor,
  fetchFn,
  engineId,
  codeFiles = CODE_FILES,
  now = Date.now,
  idleMs = IDLE_MS,
  timers,
  onExit = () => process.exit(0),
  prime = false,
}) {
  const file = holderStateFile(root, { stateDir });
  if (await warmDoor({ root, stateDir })) return null;
  const open = openDoor ?? (await import("./lib/people.mjs")).openPeopleDoor;
  const { fetchBuilds } = await import("./lib/reuse.mjs");
  const { fetchMinds, fetchPeopleList } = await import("./lib/people.mjs");
  const engineOf = engineId ?? (await import("./lib/engine-store.mjs")).currentEngineId;
  const headFetch = fetchFn ?? (await keptFetch()) ?? undefined;
  const codeAtStart = codeFiles.map(statLine);
  const clock = timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t) };
  const token = randomBytes(24).toString("hex");
  let held = null;
  let timer = null;
  let closed = false;

  const opened = () => (held ??= Promise.resolve(open({ root })));
  const dropDoor = async () => {
    const dead = held;
    held = null;
    await Promise.resolve(dead)
      .then((d) => d?.close?.())
      .catch(() => {});
  };
  /** One live call through the held door; a door that fails is reopened once and the call is made again. */
  const through = async (tool, body) => {
    const attempt = async () => (await opened()).door(tool, body);
    try {
      return await attempt();
    } catch {
      await dropDoor();
    }
    try {
      return await attempt();
    } catch (err) {
      await dropDoor();
      return { ok: false, status: null, body: null, text: `the people door did not answer (${String(err?.message ?? err).slice(0, 120)})` };
    }
  };

  // Re-warm: the connections the last builds ask used get one more live HEAD when a minute has passed with none, so the far
  // end never sees them idle long. Its own timer; the idle clock is only ever reset by a real request.
  let warmEntries = null;
  let lastTouch = -Infinity;
  let rewarmTimer = null;
  const scheduleRewarm = () => {
    rewarmTimer = clock.set(rewarm, REWARM_MS);
    rewarmTimer?.unref?.();
  };
  async function rewarm() {
    rewarmTimer = null;
    if (closed || !warmEntries) return;
    if (now() - lastTouch >= REWARM_MS) {
      lastTouch = now();
      await fetchBuilds(warmEntries, headFetch).catch(() => {});
    }
    if (!closed) scheduleRewarm();
  }
  const builds = (entries) => {
    warmEntries = entries;
    lastTouch = now();
    if (rewarmTimer === null && !closed && entries.length) scheduleRewarm();
    return fetchBuilds(entries, headFetch);
  };
  const codeMoved = () => codeFiles.some((f, i) => statLine(f) !== codeAtStart[i]);

  /** The minds of the critics named in `critics` are asked beside the list; any other critic in `ids` once the list shows her. */
  const peopleOf = async ({ ids, critics }) => {
    const guessed = new Map(critics.map((id) => [id, through("boardroom_personas_sue_mind", { sueId: id })]));
    const list = await fetchPeopleList(through);
    const door = (tool, body) =>
      tool === "boardroom_personas_sue_mind" && guessed.has(body?.sueId) ? guessed.get(body.sueId) : through(tool, body);
    const { minds } = await fetchMinds(door, list, ids);
    return { list, minds };
  };
  const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);

  /** The whole identity ask, every part live now. A part not asked for is null. */
  const identity = async (payload) => {
    const out = { builds: null, engine: null, list: null, minds: {}, listWhy: null, stale: false };
    const jobs = [];
    if (Array.isArray(payload.builds)) jobs.push(builds(payload.builds).then((b) => (out.builds = b)));
    if (payload.people)
      jobs.push(
        peopleOf({ ids: strings(payload.people.ids), critics: strings(payload.people.critics) })
          .then((p) => Object.assign(out, p))
          .catch((err) => (out.listWhy = String(err?.message ?? err).slice(0, 200))),
      );
    if (payload.engine) {
      if (codeMoved()) out.stale = true;
      else
        try {
          out.engine = String(engineOf({ checkout: String(payload.engine.checkout) }));
        } catch {
          out.engine = null;
        }
    }
    await Promise.all(jobs);
    return out;
  };

  const idle = () => {
    if (timer !== null) clock.clear(timer);
    timer = clock.set(shutdown, idleMs);
    timer?.unref?.();
  };
  async function shutdown() {
    await close();
    onExit();
  }
  async function close() {
    if (closed) return;
    closed = true;
    if (timer !== null) clock.clear(timer);
    if (rewarmTimer !== null) clock.clear(rewarmTimer);
    rewarmTimer = null;
    try {
      if (readState(file)?.token === token) fs.rmSync(file, { force: true });
    } catch {
      /* already gone */
    }
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections?.();
    await stopped;
    await dropDoor();
  }

  const server = http.createServer(async (req, res) => {
    const send = (status, json) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(json));
    };
    if (req.method !== "POST" || req.headers["x-sue-token"] !== token) return send(401, { ok: false });
    idle();
    try {
      const payload = JSON.parse((await readBody(req)) || "{}");
      if (req.url === "/ping") return send(200, { ok: true });
      if (req.url === "/door") {
        if (!READS.has(payload.tool))
          return send(200, {
            ok: false,
            status: 403,
            body: null,
            text: `the holder does not pass on ${String(payload.tool).slice(0, 60)}`,
          });
        return send(200, await through(payload.tool, payload.body ?? {}));
      }
      if (req.url === "/builds") return send(200, await builds(Array.isArray(payload.entries) ? payload.entries : []));
      if (req.url === "/identity") {
        const { stale, ...answer } = await identity(payload);
        // Its own code moved since it started: it answered without the engine and lets go once the answer is out.
        if (stale) res.once("close", () => shutdown());
        return send(200, answer);
      }
      return send(404, { ok: false });
    } catch (err) {
      return send(500, { ok: false, text: String(err?.message ?? err).slice(0, 200) });
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  // Two holders started at once: whoever finds a live one after listening steps aside.
  if (await warmDoor({ root, stateDir })) {
    await new Promise((resolve) => server.close(resolve));
    return null;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ port, token, pid: process.pid, root, at: new Date().toISOString() }), { mode: 0o600 });
  idle();
  // Warm the door now, not at the first request: opening the MCP is seconds, and its first list over a second more. This
  // priming list is a call whose answer nobody keeps; it only makes the first real one a warm call.
  if (prime) {
    through("boardroom_personas_sue_list", { builtIns: true }).catch(() => {});
    setImmediate(() => {
      try {
        engineOf({});
      } catch {
        /* the first real ask says so */
      }
    });
  }
  return { port, close };
}

/**
 * Start a holder for `root` as a detached, hidden process, unless one already answers. Nothing waits for it. Never
 * throws: a holder that cannot start only means the next start opens its own door.
 */
export async function ensureHolder({ root, stateDir, spawnFn, warm = warmDoor }) {
  try {
    if (await warm({ root, stateDir })) return false;
    const { spawn } = spawnFn ? { spawn: spawnFn } : await import("node:child_process");
    const dir = path.join(root, ".sue");
    fs.mkdirSync(dir, { recursive: true });
    const log = fs.openSync(path.join(dir, "people-door.log"), "a");
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--root", root], {
      detached: true,
      windowsHide: true,
      stdio: ["ignore", log, log],
      env: stateDir ? { ...process.env, SUE_PEOPLE_DOOR_DIR: stateDir } : process.env,
    });
    child.unref?.();
    fs.closeSync(log);
    return true;
  } catch {
    return false;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf("--root");
  const root = at > 0 ? path.resolve(process.argv[at + 1]) : null;
  if (!root) {
    console.error("usage: node people-door.mjs --root <workspace>");
    process.exit(2);
  }
  const holder = await startHolder({ root, stateDir: process.env.SUE_PEOPLE_DOOR_DIR || undefined, prime: true }).catch((err) => {
    console.error(`people door did not start: ${String(err?.message ?? err).slice(0, 200)}`);
    return null;
  });
  if (!holder) process.exit(0);
  const stop = () => holder.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
