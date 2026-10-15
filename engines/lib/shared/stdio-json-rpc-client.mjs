// vendored from Connections scripts/lib/stdio-json-rpc-client.mjs @ dd3d47a7ad
// stdio-json-rpc-client - drive a JSON-RPC 2.0 server (the local MCP loader) over a child's stdio.
//
// The local MCP speaks JSON-RPC over stdin/stdout, one JSON document per line, and every script
// that drives it by hand had rebuilt the same client: buffer stdout, split on newline, trim, skip
// blanks, JSON.parse, ignore a line that is not JSON (the server's own diagnostics share stdout),
// resolve the waiting promise by id, write `{ jsonrpc, id, method, params }` plus a newline. Three
// copies in scripts/ until 2026-09-22 (scripts/mcp/mcp-as.mjs, scripts/verify/team-board-live-proof.mjs,
// scripts/memory/lane-sync.mjs); one home now, so a framing fix (a CRLF, a split UTF-8 sequence, a
// stdin write error) lands in every driver at once. The wire bytes are unchanged: the request frame
// is serialised in the same key order the copies used.
//
// Nothing here spawns: the caller owns the child (its cwd, env and lifetime differ per script) and
// hands it in. What the client does own is noticing that child die: a request in flight when the
// server exits, fails to spawn or closes stdout is rejected with the exit code or signal, so a
// driver ends with a reason instead of hanging or draining its event loop and exiting 0 in silence
// (scripts/memory/lane-sync.mjs did both before 2026-09-22). Servers that speak this protocol live
// elsewhere (tools/sue/lib/mcp-stdio.mjs, services/studio/local-mcp); this is the client side only.

import { StringDecoder } from "node:string_decoder";

/** How long a reply the server wrote just before exiting gets to arrive before its waiter fails. */
const EXIT_DRAIN_MS = 250;

/**
 * Call `onMessage(msg)` for every complete JSON line the readable emits. A line that does not
 * parse is skipped - it is prose the server wrote to stdout, not a message. The caller owns the
 * stream's lifetime.
 */
export function forEachJsonLine(readable, onMessage) {
  let buf = "";
  // A child's stdout emits Buffers and a pipe read can end mid-character: decoding each chunk on
  // its own turns that character into U+FFFD. The decoder carries the partial bytes to the next
  // chunk, and leaves the caller's stream encoding alone.
  const decoder = new StringDecoder("utf8");
  readable.on("data", (chunk) => {
    buf += typeof chunk === "string" ? chunk : decoder.write(chunk);
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
}

/**
 * A JSON-RPC 2.0 client over an already-spawned child's stdin/stdout.
 *
 *   const rpc = stdioJsonRpcClient(child, { onNotification });
 *   const reply = await rpc.request("initialize", { ... });   // resolves with the whole response frame
 *   rpc.notify("notifications/initialized");                   // no id, nothing to wait for
 *
 * `request` resolves with the response frame (`{ jsonrpc, id, result }` or `{ ..., error }`) - it
 * never rejects on a JSON-RPC error, so a caller reads `reply.result` / `reply.error` itself, the
 * way every copy did. It rejects when the frame could not be WRITTEN (stdin gone), and when the
 * server is gone before it answers: the child exits, fails to spawn, or closes stdout. Either way a
 * request must not wait forever, and once the server is gone every later request rejects at once.
 * A reply already on its way when the child exits still resolves (stdout drains before the waiter
 * fails). A response for an id nobody is waiting on is dropped; a frame with a `method` and no
 * waiter is a server notification and goes to `onNotification` when one is given.
 */
export function stdioJsonRpcClient(child, { onNotification } = {}) {
  let next = 1;
  const pending = new Map();
  let gone = null; // the Error every waiter gets once the server is gone
  let exited = null; // "code 1" / "signal SIGKILL", once the child has said
  let deathTimer = null;
  const fail = (err) => {
    if (gone) return;
    gone = err;
    if (deathTimer) clearTimeout(deathTimer);
    for (const { reject } of pending.values()) reject(err);
    pending.clear();
  };
  // Every death signal waits a moment before failing the waiters: a reply already in the pipe still
  // resolves, the exit code arrives if stdout closed first, and a caller's own exit or error handler
  // (tools/dredd/lib/mcp.mjs races one carrying the loader's last words) settles before this does.
  // Not unref'd: while a request waits, this timer is what keeps the process alive to report it.
  const failSoon = (makeError) => {
    if (gone || deathTimer) return;
    deathTimer = setTimeout(() => fail(makeError()), EXIT_DRAIN_MS);
  };
  const exitedError = () =>
    new Error(`JSON-RPC server ${exited ? `exited (${exited})` : "closed its stdout"}; ${pending.size} request(s) were waiting on it`);
  forEachJsonLine(child.stdout, (msg) => {
    if (msg.id !== undefined && pending.has(msg.id)) {
      const { resolve } = pending.get(msg.id);
      pending.delete(msg.id);
      resolve(msg);
    } else if (msg.method && onNotification) {
      onNotification(msg);
    }
  });
  // Either one alone is enough: a grandchild holding stdout open keeps 'close' from ever firing, and
  // a loader killed through its own watchdog can close stdout before 'exit' arrives.
  child.stdout.once("close", () => failSoon(exitedError));
  child.once("exit", (code, signal) => {
    exited = signal ? `signal ${signal}` : `code ${code}`;
    failSoon(exitedError);
  });
  child.once("error", (err) => failSoon(() => new Error(`JSON-RPC server failed: ${err?.message || err}`, { cause: err })));
  const write = (frame) =>
    new Promise((resolve, reject) => {
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n", (err) => (err ? reject(err) : resolve()));
    });
  return {
    request(method, params) {
      if (gone) return Promise.reject(gone);
      const id = next++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        write({ id, method, params }).catch((err) => {
          pending.delete(id);
          reject(err);
        });
      });
    },
    notify(method, params) {
      return write({ method, params });
    },
    /**
     * Shut the server down the way a client closing its pipe does: end its stdin and wait for it to exit, killing it
     * only when it has not within `graceMs`. Resolves once it is gone. A kill first skips the server's own shutdown: a
     * stdio loader relaying to the shared local MCP host closes its chat there when its stdin ends, and every driver
     * that killed it left the chat open on the host for 24 hours (6,718 chats held at 405 MB, 2026-10-13).
     */
    end(graceMs = 5_000) {
      if (exited) return Promise.resolve();
      return new Promise((resolve) => {
        const killer = setTimeout(() => {
          child.kill();
          setTimeout(resolve, EXIT_DRAIN_MS); // a child that never spawned has no exit to wait for
        }, graceMs);
        child.once("exit", () => {
          clearTimeout(killer);
          resolve();
        });
        try {
          child.stdin.end();
        } catch {
          /* already closed */
        }
      });
    },
  };
}
