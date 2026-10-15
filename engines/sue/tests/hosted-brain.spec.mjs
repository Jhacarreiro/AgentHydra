/**
 * hosted-brain.spec - a CLI brain whose body lives in one of the run's body hosts.
 *
 * Pins the two halves the cannon adds for the CLI tiers (Owner, 2026-09-24: hundreds of Sues from
 * one Chrome): her `mcp.json` still names ONE server, `sue`, now over HTTP on her own path with her
 * own bearer, so `--strict-mcp-config` keeps the seal (claude-cli.mjs `sueMcpConfig`); and
 * cannon.mjs `withHostedBody` starts her brain only once her body is up, ends the visit as a brain
 * error (brain killed, never a hung wave) when her host dies under her, and closes her body before
 * the cannon reads what it wrote. No CLI, no browser: the pool and the brain are stand-ins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import "./fixtures/people.mjs";
import { mcpServerFor } from "../lib/body-host.mjs";
import { BODY_TOOL_PATTERN, buildClaudeArgs, sueMcpConfig } from "../lib/claude-cli.mjs";

const { withHostedBody } = await import("../cannon.mjs");

test("her mcp.json is one server named sue: her own body over stdio, or her hosted path over HTTP", () => {
  const stdio = sueMcpConfig({ bodyFile: "C:/sue/body.mjs", sueDir: "C:/r/s" });
  assert.deepEqual(
    stdio,
    { mcpServers: { sue: { command: "node", args: ["C:/sue/body.mjs", "--sue", "C:/r/s"] } } },
    "the standalone body is exactly as before",
  );
  const hosted = sueMcpConfig({ hosted: mcpServerFor({ port: 4100, secret: "s3cret", sueId: "sue-7-dan" }) });
  assert.deepEqual(Object.keys(hosted.mcpServers), ["sue"], "one server, the one name BODY_TOOL_PATTERN lets through");
  assert.equal(BODY_TOOL_PATTERN, "mcp__sue__*");
  assert.equal(hosted.mcpServers.sue.type, "http");
  assert.equal(hosted.mcpServers.sue.url, "http://127.0.0.1:4100/sue/sue-7-dan/mcp");
  assert.match(hosted.mcpServers.sue.headers.Authorization, /^Bearer [0-9a-f]{64}$/);
  assert.throws(
    () => sueMcpConfig({ hosted: { type: "http", url: "https://example.com/mcp", headers: {} } }),
    /loopback/,
    "a hosted body is on this machine or nowhere",
  );
  const argv = buildClaudeArgs({ scenarioPrompt: "Go.", systemPromptFile: "s.md", mcpConfigFile: "mcp.json" });
  assert.ok(argv.includes("--strict-mcp-config"), "the brain still loads that file and nothing else");
});

// ONE scratch root for the file, removed at process exit whatever the outcome; each case nests inside it.
const SCRATCH_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "sue-hosted-"));
process.on("exit", () => {
  try {
    fs.rmSync(SCRATCH_ROOT, { recursive: true, force: true });
  } catch {
    // still held by a stand-in child: the OS temp sweep takes it
  }
});

function scratch() {
  const dir = fs.mkdtempSync(path.join(SCRATCH_ROOT, "case-"));
  const mcpConfigFile = path.join(dir, "mcp.json");
  fs.writeFileSync(mcpConfigFile, "{}");
  return { dir, mcpConfigFile };
}

/** A pool with one Sue in it; `lose()` is her host dying under her. */
function fakePool({ fails = null } = {}) {
  const seen = { closed: 0 };
  let lose;
  const exited = new Promise((resolve) => (lose = (why) => resolve({ code: 1, lost: why })));
  return {
    seen,
    lose: (why) => lose(why),
    pool: {
      async open({ sueId }) {
        if (fails) throw new Error(fails);
        return {
          sueId,
          mcpServer: mcpServerFor({ port: 4200, secret: "k", sueId }),
          exited,
          async close() {
            seen.closed += 1;
          },
        };
      },
    },
  };
}

test("withHostedBody: her brain starts only once her body is up, reads the hosted mcp.json, and her body is closed before the answer", async () => {
  const { dir, mcpConfigFile } = scratch();
  try {
    const { pool, seen } = fakePool();
    let sawConfig = null;
    const out = await withHostedBody({
      bodyHosts: pool,
      sueId: "sue-1-dan",
      sueDir: dir,
      mcpConfigFile,
      startBrain: () => {
        sawConfig = JSON.parse(fs.readFileSync(mcpConfigFile, "utf8"));
        return { child: { pid: 1 }, done: Promise.resolve({ code: 0, result: { subtype: "success", num_turns: 9 } }) };
      },
    });
    assert.equal(sawConfig.mcpServers.sue.url, "http://127.0.0.1:4200/sue/sue-1-dan/mcp", "the brain was pointed at her hosted path");
    assert.deepEqual(out.result, { subtype: "success", num_turns: 9 });
    assert.equal(seen.closed, 1, "her body was shut down (body.json written) before the cannon reads it");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withHostedBody: a body that will not start spends no brain at all, and reads as a brain error", async () => {
  const { dir, mcpConfigFile } = scratch();
  try {
    let started = false;
    const out = await withHostedBody({
      bodyHosts: fakePool({ fails: "no browser" }).pool,
      sueId: "sue-2-dan",
      sueDir: dir,
      mcpConfigFile,
      startBrain: () => {
        started = true;
      },
    });
    assert.equal(started, false);
    assert.equal(out.code, 1);
    assert.equal(out.result.is_error, true);
    assert.match(out.result.result, /her body did not start: no browser/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("withHostedBody: her host dying under her kills her brain and ends her visit as an error, never a hung wave", async () => {
  const { dir, mcpConfigFile } = scratch();
  try {
    const { pool, lose, seen } = fakePool();
    const killed = [];
    let finish;
    const out = withHostedBody({
      bodyHosts: pool,
      sueId: "sue-3-dan",
      sueDir: dir,
      mcpConfigFile,
      kill: (child) => {
        killed.push(child.pid);
        finish({ code: null, signal: "SIGKILL", result: null });
      },
      startBrain: () => ({ child: { pid: 42 }, done: new Promise((resolve) => (finish = resolve)) }),
    });
    await new Promise((resolve) => setImmediate(resolve));
    lose("her body's host process ended (3221225477)");
    const settled = await out;
    assert.deepEqual(killed, [42], "her brain is killed, not left talking to a dead body");
    assert.equal(settled.result.is_error, true);
    assert.match(settled.result.result, /host process ended/);
    assert.equal(seen.closed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
