/**
 * hand-move - one move of one Sue's hands, sent to her run's relay (lib/body-relay.mjs), and her
 * answer as text. The one copy of that both doors to her hands share:
 *
 *   - hand.mjs, a shell command: for any AI with a shell and nothing else (Codex, ChatGPT, a plain
 *     terminal). Its words go through `parseMove`.
 *   - the Connections MCP's `sue` door, action 'move' (services/studio/local-mcp/src-impl/
 *     26b-tools-sue.mjs), which imports THIS file from the Sue engine on the machine. Its params go
 *     through `moveFromParams`.
 *
 * WHY TWO DOORS (2026-09-24, Sue at scale): on the owner's PC every Sue's brain is an agent of the chat
 * that started the run, and every move was `node hand.mjs ...` through that chat's Bash tool: a bash
 * and a node started per move (~63 ms CPU, ~48 MB), and every Bash hook the chat carries fired around
 * it. With hundreds of Sues that was where the CPU went. The Connections MCP is already running in
 * that chat, so a move through it starts nothing. Both doors forward the same move to the same relay
 * and read its answer the same way, so a Sue cannot tell which one moved her.
 *
 * The MCP loads this into its own long-lived process. Beyond Node builtins it imports run-dir.mjs,
 * engine-lease.mjs and body-relay.mjs (for RELAY_FILE), which in turn loads body-host.mjs and room.mjs:
 * nothing starts on import, it only costs load time once.
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RELAY_FILE } from "./body-relay.mjs";
import { otherEngine } from "./engine-lease.mjs";
import { runDir, stateRoot } from "./run-dir.mjs";
import { whyNoRelay } from "./run-start.mjs";

export const HAND_USAGE = "usage: node sue/hand.mjs <runId> <sueId> <move> [name=value ... | one JSON object]";

/** Shell words to one move. `name=value` words stay strings; the relay types them by the body's schema. */
export function parseMove(words) {
  const [runId, sueId, tool, ...rest] = words;
  if (!runId || !sueId || !tool) throw new Error(HAND_USAGE);
  const joined = rest.join(" ").trim();
  if (joined.startsWith("{")) return { runId, sueId, tool, args: JSON.parse(joined), raw: false };
  const args = {};
  for (const word of rest) {
    const at = word.indexOf("=");
    if (at < 1) throw new Error(`"${word}" is not name=value; quote a value with spaces as a whole, like "text=two words"`);
    args[word.slice(0, at)] = word.slice(at + 1);
  }
  return { runId, sueId, tool, args, raw: true };
}

/**
 * The MCP door's params to one move: `{ runId, sue, move, args }`. `args` is one object (or that
 * object as JSON text). It is sent `raw`, typed by her body's schema like shell words: an MCP client
 * sends `target: "3"` as readily as `target: 3`, and coerceArgs leaves a value that is already typed
 * alone.
 */
export function moveFromParams({ runId, sue, move, args } = {}) {
  const missing = [!runId && "runId", !sue && "sue", !move && "move"].filter(Boolean);
  if (missing.length)
    throw new Error(`a move needs ${missing.join(", ")}: which run, which Sue (her id, e.g. sue-1117-dana) and which move`);
  let given = args ?? {};
  if (typeof given === "string") {
    try {
      given = given.trim() ? JSON.parse(given) : {};
    } catch {
      given = null;
    }
  }
  if (!given || typeof given !== "object" || Array.isArray(given))
    throw new Error(`args must be one object of the move's own names, e.g. { "target": 3 }`);
  return { runId: String(runId), sueId: String(sue), tool: String(move), args: given, raw: true };
}

function describeProp(name, schema, required) {
  const type = schema?.enum ? `one of ${schema.enum.join("|")}` : [schema?.type].flat().filter(Boolean).join(" or ");
  return `${name}${required ? "" : "?"}${type ? ` (${type})` : ""}`;
}

/** What her hands said, as text a shell prints. */
export function render(body) {
  if (Array.isArray(body?.tools)) {
    return body.tools
      .map((t) => {
        const required = new Set(t.inputSchema?.required ?? []);
        const props = Object.entries(t.inputSchema?.properties ?? {}).map(([k, v]) => describeProp(k, v, required.has(k)));
        return `${t.name}${props.length ? ` ${props.join(", ")}` : ""}\n    ${t.description}`;
      })
      .join("\n");
  }
  const said = (body?.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return said || body?.error || "";
}

/**
 * One connection per move, never the process-wide pool. Since Node 19 `http.globalAgent` keeps sockets alive, and
 * hands-mcp / the MCP door are long processes, so a move rode the socket the move before it left open. The relay
 * lives in the cannon, whose event loop is blocked for seconds while it launches the next Sue; its idle timer for
 * that kept-alive socket runs out during the block and, when the loop is free, fires before the waiting request is
 * read: the socket is destroyed with the request unread and the client gets `read ECONNRESET`, which sendMove
 * reports as "the run is over" (run 20261009-204651-017b: two Sues, second move, 9 s after sending it; the relay
 * was alive and a fresh `node hand.mjs` reached it). `agent: false` sends `Connection: close`, so there is no idle
 * socket to expire: a move that waits through a busy relay is answered when the relay is free.
 */
function post({ port, token }, move) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(move);
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: "/move",
        method: "POST",
        agent: false,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), "x-sue-token": token },
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") });
          } catch {
            resolve({ status: res.statusCode, body: { error: raw } });
          }
        });
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/**
 * The run's relay.json. `home` is the SUE_HOME the run was started under, for a caller whose own
 * environment has another: the MCP door, where the installed Sue app names its home in its marker
 * rather than in the MCP's environment. It is run-dir.mjs's layout (`<home>/runs/<runId>`) with that
 * home in place of this process's.
 */
export function relayFileOf(runId, { home } = {}) {
  return path.join(home ? path.join(path.resolve(home), "runs", runId) : runDir(runId), RELAY_FILE);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

/**
 * The snapshot a move for this run must go through instead of this code: the run's own, while its
 * runner is alive and the snapshot is not the one this code runs from (lib/engine-lease.mjs
 * otherEngine), else null. Same layout as run-start.mjs: `<home>/state/mcp/<runId>.status.json`.
 *
 * WHY A MOVE IS ROUTED rather than trusted to a stable relay protocol (Owner, 2026-09-25: "all the Sues
 * keep running on 1.14"): nothing about the relay is versioned. A move is `{ sue, tool, args, raw }` to
 * POST /move, typed by her body's schema at the relay, and its answer is read by `render` here; the
 * MCP's params-to-move shape was added on 2026-09-24, a day before this. So there is no evidence the
 * two ends will keep agreeing, only that they have not been changed apart yet. Instead the run's OWN
 * copy of this file, from its snapshot (lib/engine-store.mjs), sends the move: imported, not spawned,
 * so a routed move still starts no process (the reason the MCP door exists, at hundreds of moves a
 * wave). It runs on this process's node, and its runner's lease keeps the snapshot while the run lives.
 */
function runEngineFor(runId, home) {
  const state = home ? path.join(path.resolve(home), "state", "mcp") : path.join(stateRoot(), "mcp");
  let status;
  try {
    status = JSON.parse(fs.readFileSync(path.join(state, `${runId}.status.json`), "utf8"));
  } catch {
    return null;
  }
  if (status?.state !== "running" || !processAlive(status.pid)) return null;
  return otherEngine(status.engine);
}

/**
 * One move, sent, and what came back as text. `reached` is false when it never reached her (no such
 * run, the relay is closed, or her visit is over). A refusal did reach her: it is `reached` like any
 * other answer, because to her it is simply what happened. A live run on another snapshot is moved by
 * that snapshot's own copy of this function (`runEngineFor`); `routed` is how it knows it was handed one.
 */
export async function sendMove({ runId, sueId, tool, args, raw }, { home, routed = false } = {}) {
  const engine = routed ? null : runEngineFor(runId, home);
  if (engine) {
    const theirs = await import(pathToFileURL(path.join(engine.root, "sue", "lib", "hand-move.mjs")).href);
    return theirs.sendMove({ runId, sueId, tool, args, raw }, { home, routed: true });
  }
  let relay;
  try {
    relay = JSON.parse(fs.readFileSync(relayFileOf(runId, { home }), "utf8"));
  } catch {
    // A run that was stopped says so, with its own reason (lib/run-start.mjs): the generic line sent five
    // agents polling a dead run for up to 12 minutes on 2026-09-24.
    const why = whyNoRelay(runId, { home });
    return { reached: false, text: why ?? `Run ${runId} has no open relay: it has not started yet, or it is over.` };
  }
  let answer;
  try {
    answer = await post(relay, { sue: sueId, tool, args, raw });
  } catch (err) {
    return { reached: false, text: `The relay for run ${runId} did not answer (${err.message}): the run is over.` };
  }
  return { reached: answer.status === 200, text: render(answer.body) };
}
