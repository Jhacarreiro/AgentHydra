/**
 * runner-build.spec - a run's status record keeps the live build it measured (null when the page serves no stamp).
 * Plain node: `node --test sue/tests/runner-build.spec.mjs`. Nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import "./fixtures/people.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-build-home-"));
after(() => fs.rmSync(home, { recursive: true, force: true }));
process.env.SUE_HOME = home;
const { runner, statusFile } = await import("../sue.mjs");

test("a live-site run keeps the build it measured on its status record", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sue-build-ws-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const runId = "20261009-120000-b1d4";
  const specPath = path.join(home, `${runId}.spec.json`);
  fs.writeFileSync(specPath, JSON.stringify({ runId, url: "https://example.com/", ws, page: { key: "example" } }));
  const build = { commit: "0123abcd", builtAt: "2026-10-09T11:00:00.000Z" };

  await runner(specPath, async () => 0, async () => build);

  assert.deepEqual(JSON.parse(fs.readFileSync(statusFile(runId), "utf8")).build, build);
});

test("a page that serves no build stamp records null, never a guess", async (t) => {
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), "sue-build-ws-"));
  t.after(() => fs.rmSync(ws, { recursive: true, force: true }));
  const runId = "20261009-120100-c2e5";
  const specPath = path.join(home, `${runId}.spec.json`);
  fs.writeFileSync(specPath, JSON.stringify({ runId, url: "http://localhost:4173/", ws, page: { key: "local" } }));

  await runner(specPath, async () => 0, async () => null);

  assert.equal(JSON.parse(fs.readFileSync(statusFile(runId), "utf8")).build, null);
});
