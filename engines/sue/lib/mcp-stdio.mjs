/**
 * mcp-stdio - hand-rolled MCP JSON-RPC 2.0 server over stdin/stdout, no SDK dependency.
 * =========================================================================================
 *
 * SUE's body (`body.mjs`) has to speak MCP to the sealed Claude CLI brain, but the repo takes no
 * new npm dependencies and the protocol surface a body actually needs is small: initialize,
 * notifications/initialized, ping, tools/list, tools/call. `services/studio/local-mcp` proved
 * this is hand-rollable at this size; this is SUE's own copy, pinned to the signature in
 * `sue/SPEC.md` so the other modules being built against it right now can code to the
 * contract without waiting on this file to land.
 *
 * Framing is newline-delimited JSON on stdin/stdout - one JSON-RPC object per line, no
 * Content-Length headers. Logging goes to stderr ONLY: stdout is the wire, and a stray
 * console.log there is a protocol violation the client will fail to parse.
 *
 * `initialize` echoes back whatever `protocolVersion` the client sent, or "2025-06-18" when it
 * sent none. A `tools/call` naming a tool that is not on the table is a JSON-RPC level error
 * (the call itself was malformed); a tool `handler` that throws is NOT a JSON-RPC error, it is a
 * normal result with `isError: true` and the thrown message as the text content, exactly the way
 * a real MCP client expects to show the brain what went wrong without killing the session.
 *
 * Depended on by: sue/body.mjs, which is the only module that should import this file's
 * export surface (createStdioMcpServer). Everything else in SUE talks to the body over MCP, not
 * to this file directly.
 */

import readline from "node:readline";

const DEFAULT_PROTOCOL_VERSION = "2025-06-18";

export function createStdioMcpServer({ name, version, tools, onClose }) {
  const toolTable = Array.isArray(tools) ? tools : [];
  const toolsByName = new Map(toolTable.map((tool) => [tool.name, tool]));

  let rl = null;
  let started = false;
  let closed = false;

  function log(...args) {
    console.error(`[mcp-stdio:${name}]`, ...args);
  }

  function writeMessage(message) {
    process.stdout.write(`${JSON.stringify(message)}\n`);
  }

  function replyResult(id, result) {
    writeMessage({ jsonrpc: "2.0", id, result });
  }

  function replyError(id, code, message) {
    writeMessage({ jsonrpc: "2.0", id, error: { code, message } });
  }

  async function handleToolsCall(id, params) {
    const requestedName = params && params.name;
    const tool = toolsByName.get(requestedName);
    if (!tool) {
      replyError(id, -32601, `Unknown tool: ${requestedName}`);
      return;
    }
    try {
      const result = await tool.handler((params && params.arguments) || {});
      replyResult(id, result);
    } catch (err) {
      replyResult(id, { content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }], isError: true });
    }
  }

  async function handleMessage(message) {
    const hasId = Object.prototype.hasOwnProperty.call(message, "id");
    const { id, method, params } = message;

    switch (method) {
      case "initialize": {
        const protocolVersion = (params && params.protocolVersion) || DEFAULT_PROTOCOL_VERSION;
        replyResult(id, { protocolVersion, capabilities: { tools: {} }, serverInfo: { name, version } });
        return;
      }
      case "notifications/initialized":
        log("client initialized");
        return;
      case "ping":
        if (hasId) replyResult(id, {});
        return;
      case "tools/list":
        replyResult(id, {
          tools: toolTable.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
        });
        return;
      case "tools/call":
        await handleToolsCall(id, params);
        return;
      default:
        if (hasId) {
          replyError(id, -32601, `Method not found: ${method}`);
        } else {
          log("unhandled notification", method);
        }
    }
  }

  function fireOnClose() {
    if (closed) return;
    closed = true;
    if (typeof onClose === "function") onClose();
  }

  return {
    start() {
      if (started) return;
      started = true;
      rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const trimmed = line.trim();
        if (!trimmed) return;
        let message;
        try {
          message = JSON.parse(trimmed);
        } catch (err) {
          log("dropped a non-JSON line", err.message);
          return;
        }
        handleMessage(message).catch((err) => {
          log("handler crashed", err);
        });
      });
      process.stdin.on("end", fireOnClose);
      log("started");
    },
    async close() {
      if (rl) rl.close();
      closed = true;
    },
  };
}
