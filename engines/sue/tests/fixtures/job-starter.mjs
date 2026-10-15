// The "run that starts the shared browser": joins it, reports where it is, then idles until its job is closed.
import fs from "node:fs";

import { acquireSharedBrowser } from "../../lib/shared-browser.mjs";
import { browserArgsFor } from "../../lib/findings.mjs";
import { resolveChromiumPath } from "../../../lib/shared/browser-launch.mjs";

const [outFile, dir] = process.argv.slice(2);
const FAST = { idleMs: 1_500, tickMs: 200, heartbeatMs: 500, leaseStaleMs: 5_000, startTimeoutMs: 60_000, probeTimeoutMs: 10_000 };
const run = await acquireSharedBrowser({
  runId: "job-starter",
  mode: "headless",
  executablePath: resolveChromiumPath(),
  args: browserArgsFor("headless"),
  dir,
  options: FAST,
});
fs.writeFileSync(outFile, JSON.stringify({ pid: process.pid, hostPid: run.hostPid, browserPid: run.browserPid, ws: run.wsEndpoint }));
setInterval(() => {}, 1000);
