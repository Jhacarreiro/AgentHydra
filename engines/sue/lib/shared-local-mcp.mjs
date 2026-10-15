/**
 * shared-local-mcp - SUE's way into the Connections MCP: the ONE shared host every session on this PC uses, never a
 * stdio loader of her own.
 *
 * WHY: `localMcpFor` (scripts/lib/local-mcp-driver.mjs) spawns a whole `loader.mjs` over stdio for the one call
 * SUE's brief makes (memory_open): 71 MB of resident process for a read that takes a second. Since 2026-10-06 every
 * Claude Code session registers the shared host instead (`node loader.mjs --http`, 127.0.0.1:7791), started on
 * demand by the loader's own `--connect` helper. This is that registration done by a script: run the helper (it
 * brings the host up when nothing answers and prints the headers naming THIS folder), open a session with them,
 * call local tools through `connections_execute`, close the session.
 *
 * Same shape as localMcpFor's return (`call`, `callResult`, `close`) so a caller swaps one line. A host that cannot
 * be reached THROWS with the helper's own words - a brief that silently ran without the owner's rulings would read
 * as complete, so there is no stdio fallback here.
 *
 * `port` and `loader` exist for specs that run their own host on a spare port; production passes neither.
 * DEPENDS ON: services/studio/local-mcp/loader.mjs (--connect, POST /mcp). DEPENDED ON BY: you/brief.mjs.
 */
import { spawnSync } from "node:child_process";

import { LOCAL_MCP_LOADER } from "../../lib/shared/local-mcp-driver.mjs";

const HOST = "127.0.0.1";
const DEFAULT_PORT = 7791;

/** The headers the loader's --connect helper prints for `folder`; starts the shared host first when it is down. */
function connectHeaders({ loader, folder, port, env }) {
  const args = [loader, "--connect", "--elicitation", "off"]; // the same flags the registration passes, so a host this starts matches the others
  if (port !== DEFAULT_PORT) args.push("--port", String(port));
  const helper = spawnSync(process.execPath, args, {
    cwd: folder,
    env: { ...env, CLAUDE_PROJECT_DIR: folder },
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  if (helper.status !== 0)
    throw new Error(
      `the shared Connections MCP host is not reachable: ${String(helper.stderr || helper.error?.message || `exit ${helper.status}`)
        .trim()
        .slice(0, 400)}`,
    );
  return JSON.parse(helper.stdout);
}

/**
 * @param {{ folder: string, env?: Record<string, string | undefined>, clientName: string, port?: number, loader?: string }} options
 */
export function sharedLocalMcpFor({ folder, env = process.env, clientName, port = DEFAULT_PORT, loader = LOCAL_MCP_LOADER }) {
  const url = `http://${HOST}:${port}/mcp`;
  let sessionHeaders = null;
  let nextId = 1;
  const post = async (body, headers) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...headers },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`the shared host answered HTTP ${res.status}: ${text.slice(0, 300)}`);
    return { res, json: text ? JSON.parse(text) : null };
  };
  const open = async () => {
    if (sessionHeaders) return sessionHeaders;
    const headers = Object.fromEntries(Object.entries(connectHeaders({ loader, folder, port, env })).map(([k, v]) => [k.toLowerCase(), v]));
    const { res } = await post(
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } },
      },
      headers,
    );
    const session = res.headers.get("mcp-session-id");
    if (!session) throw new Error("the shared host opened no session");
    sessionHeaders = { ...headers, "mcp-session-id": session };
    await post({ jsonrpc: "2.0", method: "notifications/initialized" }, sessionHeaders).catch(() => {});
    return sessionHeaders;
  };
  const run = async (tool_name, params) => {
    const headers = await open();
    const { json } = await post(
      {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: { name: "connections_execute", arguments: { local: true, tool_name, params } },
      },
      headers,
    );
    return json;
  };
  return {
    /** Runs a local tool and returns its text - or the raw error frame when there is no text. */
    async call(tool_name, params = {}) {
      const out = await run(tool_name, params);
      return (out.result?.content || []).map((c) => c.text).join("\n") || JSON.stringify(out.error || out);
    },
    /** The same call, unjoined: each content block and the tool's isError flag. A JSON-RPC error throws. */
    async callResult(tool_name, params = {}) {
      const out = await run(tool_name, params);
      if (out.error) throw new Error(`${tool_name}: ${out.error.message || JSON.stringify(out.error)}`);
      return { blocks: (out.result?.content || []).map((c) => c.text || ""), isError: Boolean(out.result?.isError) };
    },
    /** Ends this session on the host (the host itself keeps running for every other session). Never throws. */
    async close() {
      if (!sessionHeaders) return;
      const headers = sessionHeaders;
      sessionHeaders = null;
      await fetch(url, { method: "DELETE", headers: { "mcp-session-id": headers["mcp-session-id"] } }).catch(() => {});
    },
  };
}
