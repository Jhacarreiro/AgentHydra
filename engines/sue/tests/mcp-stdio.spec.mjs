/**
 * mcp-stdio.spec - proves lib/mcp-stdio.mjs against the pinned contract by actually speaking to it.
 * ===================================================================================================
 *
 * The only honest way to test a stdio JSON-RPC server is to spawn it as a real child process and
 * drive its real stdin/stdout, the way the Claude CLI brain will. So this spins up a throwaway
 * node child that calls createStdioMcpServer with two tools ('echo', which can also be told to
 * throw, and 'snapshot', which returns image content), then runs initialize, tools/list and
 * tools/call over the child's stdio, including the error-result case and the image-result case.
 *
 * Depends on: sue/lib/mcp-stdio.mjs (imported by the spawned child, not by this file
 * directly - the whole point is testing the real stdio wire, not calling the export in-process).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import readline from "node:readline";

const libUrl = new URL("../lib/mcp-stdio.mjs", import.meta.url).href;

const CHILD_SOURCE = `
import { createStdioMcpServer } from ${JSON.stringify(libUrl)};

const server = createStdioMcpServer({
  name: 'sue-test-server',
  version: '0.0.1',
  tools: [
    {
      name: 'echo',
      description: 'echoes back the given text, or throws when told to fail',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string' }, fail: { type: 'boolean' } },
        required: ['text'],
      },
      handler: async (args) => {
        if (args && args.fail) throw new Error('echo was told to fail');
        return { content: [{ type: 'text', text: String(args && args.text) }] };
      },
    },
    {
      name: 'snapshot',
      description: 'returns a tiny fake screenshot as image content',
      inputSchema: { type: 'object', properties: {} },
      handler: async () => ({
        content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
      }),
    },
  ],
  onClose: () => {
    console.error('[sue-test-server] onClose fired');
    process.exit(0);
  },
});

server.start();
`;

function startServer() {
  const child = spawn(process.execPath, ["--input-type=module", "-e", CHILD_SOURCE], { stdio: ["pipe", "pipe", "pipe"] });

  const stderrLines = [];
  child.stderr.on("data", (chunk) => {
    stderrLines.push(chunk.toString());
  });

  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message && Object.prototype.hasOwnProperty.call(message, "id") && pending.has(message.id)) {
      const { resolve } = pending.get(message.id);
      pending.delete(message.id);
      resolve(message);
    }
  });

  let nextId = 1;

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, { resolve });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  function notify(method, params) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  return { child, request, notify, stderrLines };
}

test("initialize, tools/list and tools/call drive the real stdio wire", async () => {
  const { child, request, notify } = startServer();

  const initResponse = await request("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "sue-test-client", version: "0.0.1" },
  });
  assert.equal(initResponse.result.protocolVersion, "2025-06-18");
  assert.deepEqual(initResponse.result.capabilities, { tools: {} });
  assert.equal(initResponse.result.serverInfo.name, "sue-test-server");

  notify("notifications/initialized", {});

  const pingResponse = await request("ping", {});
  assert.deepEqual(pingResponse.result, {});

  const listResponse = await request("tools/list", {});
  const names = listResponse.result.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, ["echo", "snapshot"]);
  const echoDeclared = listResponse.result.tools.find((tool) => tool.name === "echo");
  assert.equal(echoDeclared.inputSchema.type, "object");

  const okCall = await request("tools/call", { name: "echo", arguments: { text: "hello sue" } });
  assert.equal(okCall.result.isError, undefined);
  assert.deepEqual(okCall.result.content, [{ type: "text", text: "hello sue" }]);

  const errorCall = await request("tools/call", { name: "echo", arguments: { text: "x", fail: true } });
  assert.equal(errorCall.result.isError, true);
  assert.match(errorCall.result.content[0].text, /echo was told to fail/);

  const imageCall = await request("tools/call", { name: "snapshot", arguments: {} });
  assert.equal(imageCall.result.content[0].type, "image");
  assert.equal(imageCall.result.content[0].mimeType, "image/png");
  assert.equal(imageCall.result.content[0].data, "aGVsbG8=");

  const unknownToolCall = await request("tools/call", { name: "does-not-exist", arguments: {} });
  assert.ok(unknownToolCall.error, "an unknown tool must be a JSON-RPC error, not a result");
  assert.equal(unknownToolCall.result, undefined);

  const unknownMethodCall = await request("not/a/real/method", {});
  assert.ok(unknownMethodCall.error, "an unrecognized method must be a JSON-RPC error");

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 0);
});

test("ending stdin fires onClose exactly once", async () => {
  const { child, request, stderrLines } = startServer();

  await request("initialize", { protocolVersion: "2025-06-18" });

  child.stdin.end();
  const exitCode = await new Promise((resolve) => child.on("exit", resolve));
  assert.equal(exitCode, 0);

  const closeLines = stderrLines.join("").split("onClose fired").length - 1;
  assert.equal(closeLines, 1);
});
