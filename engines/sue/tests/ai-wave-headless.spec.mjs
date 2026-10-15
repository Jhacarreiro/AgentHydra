/**
 * ai-wave-headless.spec - a wave an AI starts runs headless (2026-10-09, the owner): it starts no Sue Manager
 * for its window, no toolbar icon and no window. Only `sue watch` opens the window. A run that shows a file or an
 * idea starts the Manager for it with no tray and no window (lib/material.mjs needs it to serve the file).
 *
 * Plain node (`node --test sue/tests/ai-wave-headless.spec.mjs`). SUE_HOME points the state folder at a
 * throwaway directory, and every Manager is injected, so no server, icon or window is started.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(tmpdir(), "sue-headless-"));
process.env.SUE_HOME = home;
const { startHeadlessManager, showWatcher } = await import("../lib/watch-window.mjs");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const sueCli = fs.readFileSync(path.join(import.meta.dirname, "..", "sue.mjs"), "utf8");

test("a file or an idea starts the Manager with no window and no toolbar icon, and waits until it listens", async () => {
  const server = net.createServer();
  const starts = [];
  const port = await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
  try {
    const started = await startHeadlessManager({
      port,
      start: (args) => starts.push(args),
      waitMs: 2_000,
    });
    assert.equal(started, true, "the Manager is listening");
    assert.equal(starts.length, 1, "one Manager is started");
    assert.equal(starts[0].open, false, "no window");
    assert.equal(starts[0].tray, false, "no toolbar icon");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("a Manager that never listens is not reported as started", async () => {
  const started = await startHeadlessManager({ port: 1, start: () => {}, waitMs: 300 });
  assert.equal(started, false);
});

test("sue watch is the only way the window opens: the run path never calls showWatcher", async () => {
  const calls = sueCli.match(/showWatcher\(/g) ?? [];
  assert.equal(calls.length, 1, "one call, in the `watch` command");
  assert.match(sueCli, /command === "watch"[\s\S]*?showWatcher\(\)/);
});

test("the window setting and SUE_NO_WINDOW are gone: a headless default needs no switch", () => {
  assert.equal(sueCli.includes("SUE_NO_WINDOW"), false);
  assert.equal(sueCli.includes("whenAiStarts"), false);
  assert.equal(sueCli.includes("args.window"), false);
  assert.equal(typeof showWatcher, "function");
});
