#!/usr/bin/env node
/**
 * body-host - many Sues' bodies in one node process, one browser context each.
 * ============================================================================
 *
 * WHY THIS EXISTS: Owner, 2026-09-24: hundreds of Sues at once from one Chrome, as cheaply as
 * possible. Measured that day on his box: every Sue on the wave's shared browser cost 208.5 MB of
 * private memory, and 137 MB of it was her own `node body.mjs` - bare node is 48 MB and
 * playwright-core loading again is 71 MB, per Sue, before she has looked at anything. The body's
 * per-Sue logic is a factory now (body.mjs `createSueBody`), so one process can hold many of them:
 * each Sue still has her own browser context (her cookies, storage and cache, nothing shared with a
 * sibling), her own rails, clock and diary; only node and the Playwright code are shared.
 *
 * Two ways in, one host:
 *   - IN PROCESS (`createLocalHost`): the chat relay (lib/body-relay.mjs) calls her tools directly.
 *   - OVER HTTP (`node lib/body-host.mjs`, started by `createHostPool`): a CLI brain reaches her
 *     through MCP's HTTP transport. Her `mcp.json` names ONE server, `sue`, at her own path
 *     (`/sue/<sueId>/mcp`) with her own bearer, so `--strict-mcp-config` still hands her brain her
 *     body and nothing else. The bearer is an HMAC of the run's secret and her id: one Sue's token
 *     never opens another Sue's path. A request carrying an Origin (a page) or a Host that is not
 *     this loopback port (DNS rebinding) is refused before the token is compared.
 *
 * SHARDS: at most `SUES_PER_HOST` Sues per process; `createHostPool` starts another host beyond
 * that. A host that dies ends ITS Sues' visits (their `exited` settles, their callers end them as
 * errors) and nobody else's; its bodies' browser connections die with it, so their contexts close in
 * the shared browser, and a host is a child of the cannon, so a tree kill of the cannon finds it.
 * A host whose parent goes (its stdin closes) shuts every Sue down and exits. On Windows a parent
 * killed with taskkill /F takes the host down with it before that runs (measured 2026-09-24: gone in
 * ~0.5 s, no body.json or storage-state.json written); nothing is left running either way.
 *
 * DEPENDS ON: body.mjs (`createSueBody`). DEPENDED ON BY: lib/body-relay.mjs (chat tier, in process),
 * cannon.mjs (CLI tiers, over HTTP). Spec: tests/body-host.spec.mjs.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../../lib/shared/is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The one body file a host can hold in process; any other `bodyFile` (the moderator, a test's fake) is still spawned. */
export const BODY_FILE = path.join(HERE, "..", "body.mjs");
export const HOST_FILE = fileURLToPath(import.meta.url);
/** The run's secret reaches a host process through its env (never its argv, which any process can list). */
export const HOST_SECRET_ENV = "SUE_HOST_SECRET";
/**
 * Sues per host process. One node thread runs every hosted Sue's perception and picture work, so a
 * host holds what one thread answers without a Sue waiting on her siblings' looks. Measured
 * 2026-09-24 (real body code, one shared headless browser, a local page, 50 Sues in 2 hosts): all
 * 25 of a host looking, clicking and looking at once took it 6.4 s for 75 moves, the same wall time
 * as 50 bodies of their own (6.0 s); moving every 2.5-8.5 s each host sat at ~0.55 of a core; a
 * host with 25 Sues is ~210 MB, where 25 bodies of their own were ~3.4 GB.
 */
export const SUES_PER_HOST = 25;
const DEFAULT_PROTOCOL_VERSION = "2025-06-18";
/** A host that has not exited this long after it was told to close is killed. */
const HOST_EXIT_GRACE_MS = 30_000;
/** A host that does not say its port this long after it started is taken as dead. */
const HOST_START_MS = 60_000;

/** Her bearer on her own path: the run's secret and her id, so it opens hers and no one else's. */
export function sueBearer(secret, sueId) {
  return crypto.createHmac("sha256", String(secret)).update(`sue:${sueId}`).digest("hex");
}

/** The `mcpServers.sue` entry a CLI brain's `mcp.json` gets for a hosted body (Claude Code's HTTP MCP shape). */
export function mcpServerFor({ port, secret, sueId }) {
  return {
    type: "http",
    url: `http://127.0.0.1:${port}/sue/${encodeURIComponent(sueId)}/mcp`,
    headers: { Authorization: `Bearer ${sueBearer(secret, sueId)}` },
  };
}

/**
 * One JSON-RPC message to one body's tools, the same answers lib/mcp-stdio.mjs gives over stdio: a
 * handler that throws is an `isError` result, never a protocol error. Resolves to the reply, or
 * null for a notification (nothing to answer).
 */
export async function answerMcp(message, { tools, name = "sue", version = "1.0.0" }) {
  const hasId = message && Object.prototype.hasOwnProperty.call(message, "id");
  const { id, method, params } = message ?? {};
  const result = (value) => ({ jsonrpc: "2.0", id, result: value });
  const error = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return result({
        protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name, version },
      });
    case "ping":
      return hasId ? result({}) : null;
    case "tools/list":
      return result({ tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
    case "tools/call": {
      const tool = tools.find((t) => t.name === params?.name);
      if (!tool) return error(-32601, `Unknown tool: ${params?.name}`);
      try {
        return result(await tool.handler(params?.arguments || {}));
      } catch (err) {
        return result({ content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
      }
    }
    default:
      return hasId ? error(-32601, `Method not found: ${method}`) : null;
  }
}

/** Her lines to her own `body.stderr.log`, the file a spawned body's stderr always went to. */
function fileLog(sueDir) {
  const file = path.join(sueDir, "body.stderr.log");
  return (...parts) => {
    try {
      fs.appendFileSync(file, `[sue-body] ${parts.join(" ")}\n`);
    } catch {
      /* a Sue folder already cleared away takes no more lines */
    }
  };
}

/**
 * Many bodies in THIS process. `open` resolves once her browser is up, to a handle shaped like the
 * relay's spawned body: `{ sueId, tools, call(name, args), exited, close() }` (`call` answers the
 * MCP result; `exited` settles when she is closed).
 */
export function createLocalHost({ createBody = null, logFor = fileLog } = {}) {
  const sues = new Map();
  let server = null;

  async function open({ sueId, sueDir }) {
    if (sues.has(sueId)) throw new Error(`${sueId} is already in this host`);
    const { promise: exited, resolve: resolveExited } = Promise.withResolvers();
    const entry = { sueId, body: null, exited, closing: null };
    sues.set(sueId, entry);
    try {
      const make = createBody ?? (await import("../body.mjs")).createSueBody;
      entry.body = await make({ sueDir, log: logFor(sueDir) });
    } catch (err) {
      sues.delete(sueId);
      // Her folder is the one place a session looks: the relay only says "her body failed to start".
      logFor(sueDir)(`her body failed to start: ${err?.stack ?? err}`);
      resolveExited({ code: 1, error: err });
      throw err;
    }
    entry.close = () =>
      (entry.closing ??= (async () => {
        try {
          await entry.body.shutdown();
        } finally {
          sues.delete(sueId);
          resolveExited({ code: 0 });
        }
      })());
    return {
      sueId,
      tools: entry.body.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
      async call(name, args) {
        const reply = await answerMcp(
          { jsonrpc: "2.0", id: 0, method: "tools/call", params: { name, arguments: args } },
          { tools: entry.body.tools },
        );
        if (reply.error) throw new Error(reply.error.message);
        return reply.result;
      },
      exited,
      close: () => entry.close(),
    };
  }

  function refuse(res, status, body) {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  function sameToken(given, want) {
    const a = Buffer.from(String(given ?? ""));
    const b = Buffer.from(String(want));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  async function readJson(req) {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  }

  /** MCP for her path, and the pool's control calls; everything else is refused. */
  function handler(secret, port) {
    return async (req, res) => {
      try {
        if (req.headers.origin) return refuse(res, 403, { error: "not from a page" });
        const host = String(req.headers.host ?? "");
        if (host !== `127.0.0.1:${port()}` && host !== `localhost:${port()}`) return refuse(res, 403, { error: "not this host" });
        const url = new URL(req.url, "http://127.0.0.1");
        const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        const mcp = url.pathname.match(/^\/sue\/([^/]+)\/mcp$/);
        if (mcp) {
          const sueId = decodeURIComponent(mcp[1]);
          if (!sameToken(bearer, sueBearer(secret, sueId))) return refuse(res, 401, { error: "wrong token" });
          // No server-to-client stream and no sessions: every answer rides its own POST.
          if (req.method !== "POST") return res.writeHead(405, { allow: "POST" }).end();
          const entry = sues.get(sueId);
          if (!entry?.body)
            return refuse(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: `no Sue ${sueId} in this host` } });
          let input;
          try {
            input = await readJson(req);
          } catch {
            return refuse(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
          }
          const batch = Array.isArray(input);
          const replies = (await Promise.all((batch ? input : [input]).map((m) => answerMcp(m, { tools: entry.body.tools })))).filter(
            Boolean,
          );
          if (!replies.length) return res.writeHead(202).end();
          return refuse(res, 200, batch ? replies : replies[0]);
        }
        if (!sameToken(bearer, secret)) return refuse(res, 401, { error: "wrong token" });
        if (req.method === "GET" && url.pathname === "/control/health") return refuse(res, 200, { sues: sues.size, pid: process.pid });
        if (req.method !== "POST") return refuse(res, 404, { error: "no such door" });
        const input = await readJson(req);
        if (url.pathname === "/control/open") {
          try {
            const handle = await open({ sueId: String(input.sueId), sueDir: String(input.sueDir) });
            return refuse(res, 200, { tools: handle.tools });
          } catch (err) {
            return refuse(res, 500, { error: String(err?.message ?? err).split("\n")[0] });
          }
        }
        if (url.pathname === "/control/close") {
          await sues.get(String(input.sueId))?.close?.();
          return refuse(res, 200, { closed: true });
        }
        return refuse(res, 404, { error: "no such door" });
      } catch (err) {
        if (!res.headersSent) refuse(res, 500, { error: String(err?.message ?? err) });
      }
    };
  }

  return {
    open,
    get size() {
      return sues.size;
    },
    /** Serves MCP (per Sue) and the pool's control calls on 127.0.0.1; resolves to the port. */
    async listen({ secret, port = 0 }) {
      let bound = 0;
      server = http.createServer(handler(secret, () => bound));
      // A move can run long (her `wait`, a slow page); the brain's own MCP timeout decides, not node's.
      server.requestTimeout = 0;
      await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
      bound = server.address().port;
      return bound;
    },
    /** Every Sue shut down properly (her body.json and storage-state.json written), then the port closed. */
    async closeAll() {
      await Promise.allSettled([...sues.values()].map((s) => s.close?.()));
      if (server) await new Promise((resolve) => server.close(resolve));
      server = null;
    },
  };
}

let guarded = false;
/**
 * One hosted Sue's stray rejection must not end every other Sue in the process (a body of her own
 * took only herself down with it): logged, never fatal. Installed once, by the first host in a process.
 */
function guardRejections(say) {
  if (guarded) return;
  guarded = true;
  process.on("unhandledRejection", (err) => say(`a hosted body's stray rejection (logged, not fatal): ${err?.stack ?? err}`));
}

/** A POST to a host's control door; resolves to its JSON. */
async function control(port, secret, door, body) {
  const res = await fetch(`http://127.0.0.1:${port}/control/${door}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `the body host answered ${res.status}`);
  return json;
}

/** One MCP request to her hosted path, the way her CLI brain sends it. */
async function mcpCall(port, secret, sueId, method, params) {
  const res = await fetch(`http://127.0.0.1:${port}/sue/${encodeURIComponent(sueId)}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${sueBearer(secret, sueId)}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const reply = await res.json();
  if (reply.error) throw new Error(reply.error.message);
  return reply.result;
}

/**
 * A host PROCESS (`node lib/body-host.mjs`), its stderr to `logFile`. Resolves once it has said its
 * port: `{ pid, port, exited, kill() }`; `exited` settles however it ends.
 */
export async function spawnHost({ secret, logFile, nodeBin = process.execPath, env = process.env }) {
  const child = spawn(nodeBin, [HOST_FILE], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: { ...env, [HOST_SECRET_ENV]: secret },
  });
  if (logFile) child.stderr.pipe(fs.createWriteStream(logFile, { flags: "a" }));
  else child.stderr.resume();
  const exited = new Promise((resolve) => {
    child.on("exit", (code, signal) => resolve({ code, signal }));
    child.on("error", (error) => resolve({ code: null, signal: null, error }));
  });
  const port = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("the body host never said its port")), HOST_START_MS);
    readline.createInterface({ input: child.stdout }).once("line", (line) => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(line).port);
      } catch {
        reject(new Error(`the body host said something else: ${line.slice(0, 120)}`));
      }
    });
    exited.then(({ code, signal }) => {
      clearTimeout(timer);
      reject(new Error(`the body host exited before it listened (${signal ?? code})`));
    });
  });
  return {
    pid: child.pid,
    port,
    exited,
    /** Asked to go (stdin closed: it shuts its Sues down), then killed if it has not within the grace. */
    async stop(graceMs = HOST_EXIT_GRACE_MS) {
      child.stdin.end();
      const timer = setTimeout(() => child.kill(), graceMs);
      await exited;
      clearTimeout(timer);
    },
    kill: () => child.kill(),
  };
}

/**
 * The run's hosts. `open({ sueId, sueDir })` puts her in a host with room (starting one when none
 * has), and resolves to a handle like `createLocalHost`'s plus `mcpServer` (her `mcp.json` entry;
 * null for a Sue in THIS process). `local: true` (the chat relay) makes this process the first
 * host; the rest are child processes. `close()` ends every Sue and every host.
 */
export function createHostPool({
  perHost = SUES_PER_HOST,
  local = false,
  secret = crypto.randomBytes(24).toString("hex"),
  logDir = null,
  spawnHostImpl = spawnHost,
  createBody = null,
  say = () => {},
}) {
  const hosts = [];
  let started = 0;
  let closed = false;

  /** A host with room, her place in it held at once (synchronously), so Sues opened together never overfill one. */
  function hostWithRoom() {
    const room = hosts.find((h) => !h.dead && h.sues.size + h.opening < perHost);
    if (room) {
      room.opening += 1;
      return room;
    }
    const n = ++started;
    if (local && n === 1) {
      guardRejections(say);
      const host = { n, local: createLocalHost({ createBody }), sues: new Set(), opening: 1, dead: false };
      hosts.push(host);
      return host;
    }
    const host = { n, sues: new Set(), opening: 1, dead: false, process: null, ready: null };
    hosts.push(host);
    host.ready = spawnHostImpl({ secret, logFile: logDir ? path.join(logDir, `body-host-${n}.log`) : null }).then((proc) => {
      host.process = proc;
      say(`body host ${n} up (pid ${proc.pid}, port ${proc.port}, up to ${perHost} Sues)`);
      proc.exited.then(({ code, signal }) => {
        host.dead = true;
        if (!closed) say(`body host ${n} (pid ${proc.pid}) ended (${signal ?? code}); its ${host.sues.size} Sues end with it`);
        for (const lost of host.sues) lost.lose(`her body's host process ended (${signal ?? code})`);
      });
      return proc;
    });
    host.ready.catch(() => {
      host.dead = true;
    });
    return host;
  }

  async function open({ sueId, sueDir }) {
    if (closed) throw new Error("the run's body hosts are closed");
    const host = hostWithRoom();
    try {
      if (host.local) {
        const handle = await host.local.open({ sueId, sueDir });
        const seat = { lose: () => {} };
        host.sues.add(seat);
        handle.exited.then(() => host.sues.delete(seat));
        return { ...handle, mcpServer: null, host: "local" };
      }
      const proc = await host.ready;
      const { tools } = await control(proc.port, secret, "open", { sueId, sueDir });
      const { promise: exited, resolve } = Promise.withResolvers();
      const seat = {
        lose: (why) => {
          host.sues.delete(seat);
          resolve({ code: 1, lost: why });
        },
      };
      host.sues.add(seat);
      return {
        sueId,
        tools,
        mcpServer: mcpServerFor({ port: proc.port, secret, sueId }),
        host: proc.pid,
        call: (name, args) => mcpCall(proc.port, secret, sueId, "tools/call", { name, arguments: args }),
        exited,
        async close() {
          if (!host.sues.has(seat)) return;
          try {
            await control(proc.port, secret, "close", { sueId });
          } catch {
            /* a host that went already took her with it */
          }
          host.sues.delete(seat);
          resolve({ code: 0 });
        },
      };
    } finally {
      host.opening -= 1;
    }
  }

  return {
    open,
    secret,
    /** `{ n, pid, sues }` per host: what the cannon logs, and what a spec counts. */
    hosts: () => hosts.map((h) => ({ n: h.n, pid: h.local ? process.pid : (h.process?.pid ?? null), sues: h.sues.size, dead: h.dead })),
    async close() {
      closed = true;
      await Promise.allSettled(
        hosts.map(async (h) => {
          if (h.local) return h.local.closeAll();
          const proc = await h.ready.catch(() => null);
          if (proc && !h.dead) await proc.stop();
        }),
      );
    },
  };
}

/** The host process: its secret from the env, its port on stdout, everything shut down when its parent goes. */
async function main() {
  const secret = process.env[HOST_SECRET_ENV];
  if (!secret) throw new Error(`a body host needs ${HOST_SECRET_ENV}`);
  // Her page's scripts never see our env, but nothing a Sue runs needs the secret either.
  delete process.env[HOST_SECRET_ENV];
  const host = createLocalHost();
  const say = (...parts) => process.stderr.write(`[sue-host ${process.pid}] ${parts.join(" ")}\n`);
  guardRejections(say);
  let ending = null;
  const end = () =>
    (ending ??= host.closeAll().finally(() => {
      say("closed");
      process.exit(0);
    }));
  process.stdin.on("end", end);
  process.stdin.resume();
  for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, end);
  const port = await host.listen({ secret });
  process.stdout.write(`${JSON.stringify({ port })}\n`);
  say(`listening on 127.0.0.1:${port}`);
}

if (isMainModule(import.meta.main, import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`[sue-host] fatal: ${err?.stack ?? err}\n`);
    process.exit(1);
  });
}
