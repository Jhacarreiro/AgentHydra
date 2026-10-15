#!/usr/bin/env node
// mcp/server.mjs - sue-dredd's own MCP server over stdio: the `sue`, `dredd` and `dredd_hook` tools, with no Connections
// and no AgentHydra. One JSON-RPC 2.0 message per line in, one per line out; logs go to stderr only.
//
//   claude mcp add sue-dredd -- node <checkout>/mcp/server.mjs
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

import { dreddHookTool, dreddTool } from "./dredd-tool.mjs";
import { sueTool } from "./sue-tool.mjs";

const PROTOCOL_VERSION = "2025-06-18";
export const TOOLS = [sueTool, dreddTool, dreddHookTool];

const SERVER_VERSION = "1.0.0";

/** A tool's answer as an MCP result: a result object passes through, anything else becomes its text. */
const asResult = (value) =>
  value && typeof value === "object" && Array.isArray(value.content)
    ? value
    : { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };

/** One JSON-RPC request's answer, or undefined for a notification. Exported so a spec can call the server in-process. */
export async function handle({ id, method, params } = {}, { tools = TOOLS } = {}) {
  if (id === undefined || id === null) return undefined;
  const reply = (result) => ({ jsonrpc: "2.0", id, result });
  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "sue-dredd", version: SERVER_VERSION },
    });
  }
  if (method === "ping") return reply({});
  if (method === "tools/list") return reply({ tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
  if (method === "tools/call") {
    const tool = tools.find((t) => t.name === params?.name);
    if (!tool) return reply({ isError: true, content: [{ type: "text", text: `unknown tool: ${params?.name}` }] });
    try {
      return reply(asResult(await tool.run(params.arguments ?? {})));
    } catch (error) {
      process.stderr.write(`${params.name}: ${error?.stack || error}\n`);
      return reply({ isError: true, content: [{ type: "text", text: String(error?.message || error) }] });
    }
  }
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
}

/** Serves `input` until it closes. Calls run concurrently: a Sue's moves must not queue behind a wave's start. */
export function serve({ input = process.stdin, output = process.stdout, tools = TOOLS } = {}) {
  const send = (message) => message && output.write(`${JSON.stringify(message)}\n`);
  const pending = new Set();
  const rl = createInterface({ input });
  return new Promise((done) => {
    rl.on("line", (line) => {
      if (!line.trim()) return;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
        return;
      }
      const job = handle(message, { tools }).then(send, (e) => process.stderr.write(`${e?.stack || e}\n`));
      pending.add(job);
      job.finally(() => pending.delete(job));
    });
    rl.on("close", () => Promise.all(pending).then(done));
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await serve();
