/**
 * busy-relay - a stand-in for a run's relay, run as a worker thread by hand-move.spec.mjs. It answers every
 * move with `args.say`; a move with `args.busyMs` is answered and then the worker's event loop is blocked
 * for that long, the way the real relay's is while the cannon it lives in does synchronous work.
 * The server is a plain `http.createServer`, as the real relay's is, so what it does to an idle
 * connection once its loop is free again is Node's own.
 */
import http from "node:http";
import { parentPort, workerData } from "node:worker_threads";

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => {
    raw += chunk;
  });
  req.on("end", () => {
    const { args } = JSON.parse(raw);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ content: [{ type: "text", text: args.say }] }));
    if (args.busyMs) setImmediate(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, args.busyMs));
  });
});
server.keepAliveTimeout = workerData.keepAliveMs;
server.listen(0, "127.0.0.1", () => parentPort.postMessage(server.address().port));
