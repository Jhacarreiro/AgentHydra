// dredd/lib/mcp.mjs - ONE local-MCP process for a whole docket.
//
// The Connections local MCP (services/studio/local-mcp/loader.mjs) is how Dredd reaches the memory
// lane (memory_search), the team board (board_who / board_read), this folder's mail (board_read { box })
// and SUE. Spawning it costs about five seconds (measured 2026-09-21: loader + initialize + one
// call = 5.3 s), so a docket opens it ONCE, makes every call it needs, and closes it - never one
// spawn per call. The auth path is the real one: this machine's signed-in session, its company
// binding, its token refresh, exactly what Claude Code uses - nothing re-implemented here
// (scripts/lib/memory-mcp-client.mjs makes the same choice for the same reason).
//
// The wire client is the shared one (scripts/lib/stdio-json-rpc-client.mjs); this file only owns
// the child's lifetime and the connections_execute envelope. Every call has a timeout, and a
// failure comes back as { ok: false, text } - a docket with no lane is still a docket.
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { stdioJsonRpcClient } from "../../lib/shared/stdio-json-rpc-client.mjs";

function withTimeout(promise, ms, what) {
  let timer;
  const gate = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, gate]).finally(() => clearTimeout(timer));
}

/**
 * Open the local MCP for `root` (the workspace folder). Resolves to { call, close } or throws when the
 * loader is missing or would not initialize within `timeoutMs`.
 *
 * A repository judged with --root has its own workspace binding, often one the loader made by itself
 * ("assignmentSource": "auto", a "Default project" company), and that company holds none of the vault
 * instances the instruments lease: SUE's and the focus group's Root/Connections came back
 * "service_not_connected" on the VectorMagik site's hearing (2026-09-24), so the visitors never walked. The
 * docket keeps `root`'s binding for the memory lane and the board, and a vault call refused that way is made
 * again through an MCP bound to `loaderRoot`, the engine's own checkout, whose company holds them; the
 * instrument still runs with `cwd: root`, so it judges the right repository.
 */
export async function openLocalMcp({ root = targetRoot(), loaderRoot = targetRoot(), timeoutMs = 20_000, clientName = "dredd", pin = null } = {}) {
  const mcp = await openFor(root, { loaderRoot, timeoutMs, clientName, pin });
  if (!loaderRoot || path.resolve(loaderRoot) === path.resolve(root)) return mcp;
  let engine = null;
  // The engine checkout's own binding, opened once on first need: the vault calls below, and the board reading home's
  // seats when home refuses this workspace (lib/connections-board.mjs homeRoster). Null when it would not open.
  mcp.engine = () => (engine ??= openFor(loaderRoot, { loaderRoot, timeoutMs, clientName }).catch(() => null));
  const call = mcp.call;
  mcp.call = async (toolName, params = {}, ms = timeoutMs) => {
    const res = await call(toolName, params, ms);
    if (!params?.instance || !refusedByWorkspace(res.text)) return res;
    const other = await mcp.engine();
    return other ? other.call(toolName, params, ms) : res;
  };
  const execute = mcp.execute;
  mcp.execute = async (args, ms) => {
    const res = await execute(args, ms);
    if (!args?.instance || !refusedByWorkspace(res.text)) return res;
    const other = await mcp.engine();
    return other ? other.execute(args, ms) : res;
  };
  const close = mcp.close;
  mcp.close = () => Promise.all([close(), engine?.then((other) => other?.close())]).then(() => {});
  return mcp;
}

/** Whether a vault call was refused because this workspace's company holds no such instance. */
export function refusedByWorkspace(text) {
  return /service_not_connected/.test(text);
}

/**
 * The child's environment. `pin` is the workspace folder the MCP registers and binds as ITS workspace; it defaults to
 * `root`. A SUE round passes the folder that launched it: a scratch folder registered here would be auto-bound to the
 * account's default workspace (4Man 16ecd6a5). `cwd` stays `root`.
 */
export function mcpEnv(root, { pin = null, base = process.env, sessionId = `dredd-${process.pid}` } = {}) {
  const workspace = pin || root;
  return {
    ...base,
    CONNECTIONS_WORKSPACE: workspace,
    CLAUDE_PROJECT_DIR: workspace,
    // Its OWN session id, never the parent's: the id names the notice files (mailseen-, inbox-), and a
    // docket sharing the parent's would use up the notices meant for the person's own session.
    CLAUDE_CODE_SESSION_ID: sessionId,
  };
}

async function openFor(root, { loaderRoot, timeoutMs, clientName, pin = null }) {
  // The loader is Connections' own file; `loaderRoot` names that checkout when `root` is another repository judged with --root.
  const loader = process.env.CX_LOADER || targetPath(loadTarget().localMcpLoader);
  if (!existsSync(loader)) throw new Error(`local MCP loader not found: ${loader}`);
  const child = spawn(process.execPath, [loader], {
    cwd: root,
    env: mcpEnv(root, { pin }),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  // The last few KB of the loader's stderr: the reason it died, when it dies. Drained to nothing, a loader that threw
  // on import cost the full timeout and said only "initialize timed out" (2026-09-22).
  let stderrTail = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrTail = (stderrTail + chunk).slice(-4_096);
  });
  const lastWords = () => stderrTail.trim().split(/\r?\n/).slice(-3).join(" | ").slice(-400);
  // A spawn failure or a write into a dead pipe is an 'error' event; unheard, either one crashes the whole docket.
  const failed = new Promise((_, reject) => {
    child.once("error", (err) => reject(new Error(`local MCP failed: ${err.message}${lastWords() ? ` - ${lastWords()}` : ""}`)));
    child.stdin.on("error", (err) => reject(new Error(`local MCP stdin: ${err.message}${lastWords() ? ` - ${lastWords()}` : ""}`)));
  });
  failed.catch(() => {}); // after initialize the race below is over; a late error is the call's own timeout to report
  const rpc = stdioJsonRpcClient(child);
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const diedEarly = exited.then((code) => {
    throw new Error(`local MCP exited ${code} before initialize${lastWords() ? `: ${lastWords()}` : ""}`);
  });
  diedEarly.catch(() => {}); // the exit at close() rejects it too, and nobody waits on it by then
  try {
    await withTimeout(
      Promise.race([
        rpc.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } }),
        diedEarly,
        failed,
      ]),
      timeoutMs,
      "initialize",
    );
    await rpc.notify("notifications/initialized");
  } catch (err) {
    child.kill();
    const words = lastWords();
    throw words && /timed out/.test(err.message) ? new Error(`${err.message}: ${words}`) : err;
  }
  return {
    /** Run one local tool. Never throws: { ok, text }. */
    async call(toolName, params = {}, ms = timeoutMs) {
      try {
        const out = await withTimeout(
          rpc.request("tools/call", { name: "connections_execute", arguments: { local: true, tool_name: toolName, params } }),
          ms,
          toolName,
        );
        if (out?.error) return { ok: false, text: JSON.stringify(out.error) };
        return localAnswer(out);
      } catch (err) {
        return { ok: false, text: err?.message || String(err) };
      }
    },
    /** Ask the catalog one plain-English query (connections_search_catalog: local tools, vault scripts, endpoints and
     *  connectors in one answer). Never throws: { ok, text }. */
    async search(query, ms = timeoutMs) {
      try {
        const out = await withTimeout(
          rpc.request("tools/call", { name: "connections_search_catalog", arguments: { query } }),
          ms,
          "search",
        );
        if (out?.error) return { ok: false, text: JSON.stringify(out.error) };
        return localAnswer(out);
      } catch (err) {
        return { ok: false, text: err?.message || String(err) };
      }
    },
    /**
     * Call one Connections API endpoint as this machine's signed-in account - `connections_execute { service,
     * tool_name, params: { body } }`, the same first-party door every agent uses. Never throws:
     * { ok, status, body, text }. `ok` is a 2xx; an answer the MCP cut to fit its 200,000-character cap is read
     * whole from the original it saved on this machine, else comes back with `truncated` and body null (`apiAnswer`)
     * - never a half-read object. `jmespath` asks the MCP for a projection of the answer instead of all of it: keep
     * `status` and `body` in the projection (`{status: status, body: {...}}`) and the envelope reads the same way, while a
     * roster too long for the cap (the Boardroom's personas list, 2026-09-30) arrives whole because only its ids travel.
     * `routing` holds the endpoint's path parameters (the Companies plane's `company_id`): the executor reads those off
     * the top of `params`, never out of its body, so they ride beside it.
     */
    async api(service, toolName, body = {}, ms = 120_000, jmespath = null, routing = null) {
      try {
        const args = { service, tool_name: toolName, params: { ...routing, body }, ...(jmespath ? { jmespath } : {}) };
        const out = await withTimeout(rpc.request("tools/call", { name: "connections_execute", arguments: args }), ms, toolName);
        if (out?.error) return { ok: false, status: null, body: null, text: JSON.stringify(out.error) };
        return apiAnswer(out?.result?.content?.[0]?.text || "", toolName);
      } catch (err) {
        return { ok: false, status: null, body: null, text: err?.message || String(err) };
      }
    },
    /**
     * One `connections_execute` with its arguments exactly as given, a top-level `instance` included: a vault call
     * (`aws_call` on a connected account, sue/lib/mailroom-lease.mjs). Never throws: { ok, text }, `text` the answer's
     * leading JSON whole and never logged here, because a caller may read a credential out of it.
     */
    async execute(args, ms = 120_000) {
      try {
        const out = await withTimeout(rpc.request("tools/call", { name: "connections_execute", arguments: args }), ms, args?.tool_name || "execute");
        if (out?.error) return { ok: false, text: JSON.stringify(out.error) };
        return { ok: !out?.result?.isError, text: leadingJson(String(out?.result?.content?.[0]?.text ?? "")) };
      } catch (err) {
        return { ok: false, text: err?.message || String(err) };
      }
    },
    close() {
      return rpc.end();
    },
  };
}

/**
 * A local tool's reply as { ok, text }. The MCP answers a call it could not run for want of this machine's sign-in with
 * its sign-in prompt (every one opens with 🔐, services/studio/local-mcp src-impl 02-auth-device-flow.mjs) and no
 * isError, so it is read here as not run: Lift's deploy printed that prompt and passed as deployed (2026-10-04).
 */
export function localAnswer(out) {
  const text = (out?.result?.content || []).map((c) => c.text).join("\n");
  return { ok: !out?.result?.isError && !text.trimStart().startsWith("🔐"), text };
}

/**
 * The JSON value an answer opens with, without what the MCP appends after it: a projected (`jmespath`) answer arrives
 * as the JSON followed by a license notice (2026-09-30), which made the whole text unreadable to JSON.parse. Brackets
 * are counted outside strings; text that does not open with an object or array comes back as it was.
 */
export function leadingJson(text) {
  const s = String(text);
  const start = s.search(/\S/);
  if (start < 0 || (s[start] !== "{" && s[start] !== "[")) return s;
  let depth = 0;
  let inString = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (c === "\\") i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return s;
}

/**
 * One `connections_execute` answer as { ok, status, body, text }. The MCP caps an answer at 200,000 characters. When it
 * can, it keeps the answer JSON by cutting each long string to its head ("…[+N characters]") and saves the WHOLE
 * original on this machine (`savedTo`): that original is read back here, so a caller never mistakes a cut playbook for
 * the whole one (2026-09-28: a 323,853-character adviser playbook arrived as its first 20,000 with ok: true). A cut
 * answer with no saved original has no body. Either way the status stays readable, so a 2xx write whose echo was too
 * long is still a success the caller does not retry into a duplicate.
 */
export function apiAnswer(text, toolName, read = (file) => readFileSync(file, "utf8")) {
  let envelope;
  try {
    envelope = JSON.parse(leadingJson(text));
  } catch {
    // Cut mid-string with no JSON phase that fit: when it still OPENS with its status, the call itself is readable
    // (a board member created with a 270k playbook, 2026-09-23, is a success with no body).
    const cut = /^\s*\{\s*"status":\s*(\d{3})/.exec(text);
    if (cut && text.length >= 190_000) {
      const status = Number(cut[1]);
      // Past every JSON phase the MCP ends the cut text with the handle of the whole original it saved on this
      // machine (~/.connections/tool-results/<handle>.txt): read that, or a big adviser's read-back has no body
      // (skill-advisers.mjs, 2026-09-30: a 330k playbook).
      const handle = /handle:"(out-[0-9a-f]{16})"/.exec(text.slice(-2000))?.[1];
      if (handle) {
        try {
          const whole = JSON.parse(leadingJson(read(path.join(homedir(), ".connections", "tool-results", `${handle}.txt`))));
          if (whole && typeof whole === "object" && Number(whole.status) === status) {
            return { ok: status >= 200 && status < 300, status, body: whole.body ?? null, text: text.slice(0, 600) };
          }
        } catch {
          /* no saved original readable here: the cut answer below */
        }
      }
      return {
        ok: status >= 200 && status < 300,
        status,
        body: null,
        truncated: true,
        head: text.slice(0, 4000),
        text: text.slice(0, 600),
      };
    }
    return {
      ok: false,
      status: null,
      body: null,
      text: `${toolName}: unreadable answer (${text.length} characters): ${text.slice(0, 300)}`,
    };
  }
  if (envelope?.truncated === true) {
    let whole;
    try {
      whole = envelope.savedTo ? JSON.parse(leadingJson(read(envelope.savedTo))) : null;
    } catch {
      whole = null;
    }
    if (whole && typeof whole === "object") envelope = whole;
    else {
      const status = Number(envelope?.status) || null;
      return { ok: status !== null && status >= 200 && status < 300, status, body: null, truncated: true, text: text.slice(0, 600) };
    }
  }
  const status = Number(envelope?.status) || null;
  return { ok: status !== null && status >= 200 && status < 300, status, body: envelope?.body ?? null, text: text.slice(0, 600) };
}
