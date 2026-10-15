/**
 * sue-stop.spec - `sue stop` may only kill a run that still says it is RUNNING.
 * ==========================================================================================
 *
 * WHAT: writes a status file whose state is `finished` (and `stopped`) but whose pid is THIS process
 * - a pid that is very much alive - then calls `dispatch("stop")` and asserts it refused, wrote no
 * kill, and left the process running. Also: a status with no pid at all is still "not running".
 *
 * WHY IT EXISTS: found 2026-09-22. `stopRun` checked only that status.pid was alive and never
 * checked status.state. A finished run keeps its runner's pid in the status file, so once Windows
 * reused that number, `sue stop` (or the Manager's Stop button, manager.mjs) ran taskkill /T /F on
 * whatever process now owned it, and its whole tree.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "./fixtures/people.mjs";
import { dispatch } from "../sue.mjs";

const RUN_ID = "20260922-120000-beef";

/** A throwaway SUE_HOME, so a stop never reads or writes the real state root. */
function withHome(fn) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-stop-"));
  const prior = process.env.SUE_HOME;
  process.env.SUE_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prior === undefined) delete process.env.SUE_HOME;
    else process.env.SUE_HOME = prior;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function writeStatus(home, status) {
  const dir = path.join(home, "state", "mcp");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${RUN_ID}.status.json`), `${JSON.stringify(status, null, 2)}\n`, "utf8");
}

describe("sue stop", () => {
  it("refuses to kill a finished run whose pid is alive again", () => {
    withHome((home) => {
      writeStatus(home, { runId: RUN_ID, state: "finished", pid: process.pid, startedAt: new Date().toISOString() });
      const out = dispatch("stop", { workspace: home, runId: RUN_ID });
      assert.equal(out.stopped, false);
      assert.ok(out.why.includes("finished"), out.why);
      assert.doesNotThrow(() => process.kill(process.pid, 0));
    });
  });

  it("refuses a stopped run too", () => {
    withHome((home) => {
      writeStatus(home, { runId: RUN_ID, state: "stopped", pid: process.pid, startedAt: new Date().toISOString() });
      const out = dispatch("stop", { workspace: home, runId: RUN_ID });
      assert.equal(out.stopped, false);
      assert.ok(out.why.includes("stopped"), out.why);
    });
  });

  it("says plainly that a running status with no pid is not running", () => {
    withHome((home) => {
      writeStatus(home, { runId: RUN_ID, state: "running", startedAt: new Date().toISOString() });
      const out = dispatch("stop", { workspace: home, runId: RUN_ID });
      assert.equal(out.stopped, false);
      assert.equal(out.why, "that run is not running");
    });
  });

  it("has no status file at all for an unknown run and still refuses", () => {
    withHome((home) => {
      const out = dispatch("stop", { workspace: home, runId: RUN_ID });
      assert.equal(out.stopped, false);
      assert.equal(out.why, "that run is not running");
    });
  });
});
