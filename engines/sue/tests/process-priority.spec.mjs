/**
 * process-priority.spec - on Windows the shared browser's host lowers its own priority; elsewhere nothing is set.
 * Plain node: `node --test sue/tests/process-priority.spec.mjs`. Nothing imports it.
 */
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";

import { lowerOwnPriority } from "../lib/process-priority.mjs";

test("on Windows the calling process drops to BELOW_NORMAL, and only itself", () => {
  const calls = [];
  const lowered = lowerOwnPriority({ platform: "win32", setPriority: (pid, level) => calls.push({ pid, level }) });
  assert.equal(lowered, true);
  assert.deepEqual(calls, [{ pid: process.pid, level: os.constants.priority.PRIORITY_BELOW_NORMAL }]);
});

test("off Windows nothing is set", () => {
  const calls = [];
  assert.equal(lowerOwnPriority({ platform: "linux", setPriority: () => calls.push(1) }), false);
  assert.deepEqual(calls, []);
});
