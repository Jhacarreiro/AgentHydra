/**
 * ask-bridge.spec - the Python half of the HSwarm door (lib/ask.py), driven from the lane that runs.
 *
 * `node --test dredd/tests/ask-bridge.spec.mjs`. `test_ask_bridge.py` pins how ask.py turns a
 * spec into hswarm kwargs (a profile only with AUTO, an explicit pin and effort kept), and nothing ran
 * it: this repo has no Python lane, so a Python suite is reached from a spec the node lane collects,
 * the way services/email/sdk-python/python-sdk.spec.mjs reaches its unittest suite. A missing
 * interpreter fails here rather than skipping - `bun run save` is itself a Python script.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PYTHON = process.platform === "win32" ? "python" : "python3";

test("ask.py's kwargs bridge passes its own unittest suite", () => {
  // Both streams: unittest writes its whole transcript, the `Ran N tests` line included, to stderr.
  const run = spawnSync(PYTHON, ["-m", "unittest", "test_ask_bridge", "-v"], { cwd: HERE, encoding: "utf8", windowsHide: true });
  const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
  assert.equal(run.status, 0, `python unittest failed (exit ${run.status}):\n${output}`);
  // The count, not only the exit code: a suite whose cases vanished must not pass as green.
  const ran = /Ran (\d+) tests?/.exec(output);
  assert.ok(ran && Number(ran[1]) >= 2, `expected at least 2 cases to run:\n${output}`);
});
