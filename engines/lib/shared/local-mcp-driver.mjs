// vendored from Connections scripts/lib/local-mcp-driver.mjs @ dd3d47a7ad
// local-mcp-driver - one long-lived local MCP for one workspace folder, driven the way Claude Code
// drives it: spawn the loader in that folder, initialize, then run LOCAL tools through
// `connections_execute`. Plus the PASS/FAIL tally every live proof reports through.
//
// WHY IT EXISTS: folder-mail-live-proof and memory-lane-live-proof each carried a byte-identical
// forty-line copy of this driver - including a hand-rolled JSON-RPC framer, when
// `stdio-json-rpc-client.mjs` beside this file had been the one home for that since 2026-09-22
// (`scripts-dir-duplication` measured the pair at 217 merged windows). The only things that differ
// per proof are the child's ENV (which impl, which session id, which config dir) and the client
// name, so those are the parameters and nothing else is.
//
// Nothing here decides what the child may touch: the caller builds the env, because what a proof
// must isolate (the operator's session notices, a throwaway CLAUDE_CONFIG_DIR) is the proof's own
// business.
import { loadTarget, targetPath, targetRoot } from "../target.mjs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stdioJsonRpcClient } from "./stdio-json-rpc-client.mjs";

const REPO = targetRoot();
/** This checkout's local-MCP loader - what Claude Code spawns. */
export const LOCAL_MCP_LOADER = targetPath(loadTarget().localMcpLoader);
/** The impl under test: this checkout's, unless CONNECTIONS_IMPL_FILE names another, so a pinned install on the machine is never touched. */
export const LOCAL_MCP_IMPL = process.env.CONNECTIONS_IMPL_FILE || targetPath(loadTarget().localMcpImpl);

/**
 * @param {{ loader?: string, folder: string, env: Record<string, string | undefined>, clientName: string }} options
 * @returns {{ child: import("node:child_process").ChildProcess, call: (tool_name: string, params?: object) => Promise<string>, close: () => Promise<void> }}
 */
export function localMcpFor({ loader = LOCAL_MCP_LOADER, folder, env, clientName }) {
  // One-shot: the child skips the session boot (workspace report, team board, lane start, heartbeat,
  // goodbye beacon), which it would otherwise pay against the account's MCP call window on every spawn.
  // Each tool still does its own work (board and lane tools start what they need), so a proof loses nothing.
  const childEnv = { ...env, CONNECTIONS_MCP_ONESHOT: "1" };
  const child = spawn(process.execPath, [loader], { cwd: folder, env: childEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  child.stderr.on("data", () => {});
  const rpc = stdioJsonRpcClient(child);
  const ready = rpc
    .request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: clientName, version: "1" } })
    .then(() => rpc.notify("notifications/initialized"));
  return {
    child,
    /** Runs a local tool and returns its text - or the raw error frame when there is no text. */
    async call(tool_name, params = {}) {
      await ready;
      const out = await rpc.request("tools/call", { name: "connections_execute", arguments: { local: true, tool_name, params } });
      return (out.result?.content || []).map((c) => c.text).join("\n") || JSON.stringify(out.error || out);
    },
    /** The same call, unjoined: each content block and the tool's isError flag, for a caller that reads only the answer's own block (the later ones are the account line and the licence notice). A JSON-RPC error throws. */
    async callResult(tool_name, params = {}) {
      await ready;
      const out = await rpc.request("tools/call", { name: "connections_execute", arguments: { local: true, tool_name, params } });
      if (out.error) throw new Error(`${tool_name}: ${out.error.message || JSON.stringify(out.error)}`);
      return { blocks: (out.result?.content || []).map((c) => c.text || ""), isError: Boolean(out.result?.isError) };
    },
    close: () => rpc.end(),
  };
}

/**
 * Re-run THIS script through the local MCP's `shell` under a vault instance, and return its exit code.
 *
 * An evidence producer that needs one account's credentials used to be runnable only by a person who
 * knew to wrap it in `shell { instance }`, so the Architect's advanced run (which runs each no-data
 * check's declared producer) could never refresh it and the check sat at no-data. A producer that
 * finds no credentials in its env calls this instead of failing: the vault mints them value-blind in
 * the child, exactly as a hand-run `shell { instance }` would. Credentials already in the env win, so
 * a caller that chose an instance is never second-guessed.
 */
export async function rerunUnderVaultInstance({ instance, clientName, argv = process.argv.slice(1), timeoutMs = 600000 }) {
  const mcp = localMcpFor({ folder: REPO, env: { ...process.env }, clientName });
  try {
    const command = ["node", ...argv.map((a) => JSON.stringify(a))].join(" ");
    const text = await mcp.call("shell", { command, instance, cwd: REPO, timeoutMs });
    console.log(text);
    const exit = /^exit (\d+)/m.exec(text);
    return exit ? Number(exit[1]) : 1;
  } finally {
    mcp.close();
  }
}

/** A PASS/FAIL line per check, the failing detail indented under it; `results` is what a proof exits on. */
export function proofChecks({ detailChars = 500 } = {}) {
  const results = [];
  return {
    results,
    check(name, ok, detail = "") {
      results.push(ok);
      console.log(
        `${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `\n      ${String(detail).slice(0, detailChars).replace(/\n/g, "\n      ")}`}`,
      );
    },
  };
}
