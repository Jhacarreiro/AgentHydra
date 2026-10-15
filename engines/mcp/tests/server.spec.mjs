/**
 * server.spec - the stdio wire: the real server process, spoken to the way a chat speaks to it, one JSON object a line.
 * Only read-only calls: no engine runs a wave, a hearing or a network call here.
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { ROOT } from "../proc.mjs";

let child;
const waiting = new Map();
let nextId = 1;

function ask(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve) => waiting.set(id, resolve));
}

beforeAll(() => {
  child = spawn(process.execPath, [join(ROOT, "mcp", "server.mjs")], { cwd: ROOT, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
});

afterAll(() => child.stdin.end());

describe("the sue-dredd MCP server over stdio", () => {
  it("initializes as sue-dredd with tools", async () => {
    const { result } = await ask("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "spec", version: "0" } });
    expect(result.serverInfo.name).toBe("sue-dredd");
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities).toEqual({ tools: {} });
  });

  it("lists sue, dredd and dredd_hook, each with an object input schema", async () => {
    const { result } = await ask("tools/list", {});
    expect(result.tools.map((t) => t.name)).toEqual(["sue", "dredd", "dredd_hook"]);
    for (const t of result.tools) expect(t.inputSchema.type).toBe("object");
  });

  it("answers a read-only call: Dredd's bench", async () => {
    const { result } = await ask("tools/call", { name: "dredd", arguments: { action: "bench" } });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toStartWith("DREDD'S BENCH - ");
  });

  it("an unknown tool is an error result, an unknown method a JSON-RPC error, and the server keeps serving", async () => {
    expect((await ask("tools/call", { name: "nope", arguments: {} })).result.isError).toBe(true);
    expect((await ask("resources/list", {})).error.code).toBe(-32601);
    expect((await ask("ping", {})).result).toEqual({});
  });
});
