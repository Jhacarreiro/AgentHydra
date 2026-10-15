/**
 * tray.spec - Sue's toolbar icon (lib/tray.mjs) speaks one JSON line per message to lib/tray.ps1 and
 * hears one word per line back, however the pipe splits them; and the icon going away is noticed.
 *
 * Plain node (`node --test sue/tests/tray.spec.mjs`). A fake process stands in for PowerShell,
 * so no icon ever appears on the machine running it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { startTray, trayAvailable } from "../lib/tray.mjs";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.written = "";
  child.stdin.on("data", (chunk) => (child.written += chunk));
  return child;
}

// The icon is a TRACKED file (services/studio/web/public/sue-favicon-32x32.png). Loaded by path, GDI+
// held it open for the tray's whole life, so while Sue ran no checkout could fast-forward past a commit
// that changed it: "unable to unlink ... Invalid argument" (2026-09-27; the old script measured EBUSY
// on a rename, the byte-loaded one renamed cleanly). Read from the source so no icon has to appear.
test("the tray reads its icon from bytes, so a running Sue never locks a file git must replace", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../lib/tray.ps1", import.meta.url), "utf8");
  const code = source
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.doesNotMatch(code, /(Bitmap|Icon|Image)\(\s*\$Icon\s*\)|::FromFile\(/, "a path-loaded image keeps the file open");
  assert.match(code, /ReadAllBytes\(\$Icon\)/);
});

test("the toolbar is Windows'", () => {
  assert.equal(trayAvailable("win32"), true);
  assert.equal(trayAvailable("darwin"), false);
  assert.equal(trayAvailable("linux"), false);
});

test("the icon starts hidden, hears ready/open/quit however the lines arrive, and is told what to say", async () => {
  const child = fakeProcess();
  const calls = [];
  const icon = startTray({
    onOpen: () => calls.push("open"),
    onQuit: () => calls.push("quit"),
    spawnImpl: (command, args, options) => {
      calls.push({ command, hidden: options.windowsHide === true && args.includes("Hidden") });
      return child;
    },
  });
  assert.deepEqual(calls.shift(), { command: "powershell.exe", hidden: true }, "never a console on the person's screen");

  child.stdout.write("rea");
  child.stdout.write("dy\r\nop");
  assert.equal(await icon.ready, true);
  child.stdout.write("en\r\nsomething else\nquit\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["open", "quit"], "a word split across two reads is still one word; an unknown one is ignored");

  icon.say("Sue shrunk to the toolbar", "Click her icon to open her again.");
  icon.tip("Sue: example.com");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    child.written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [{ say: { title: "Sue shrunk to the toolbar", text: "Click her icon to open her again." } }, { tip: "Sue: example.com" }],
  );
});

test("the menu lists the running waves, and a wave's row opens Sue at that run", async () => {
  const child = fakeProcess();
  const opened = [];
  const shown = [];
  const icon = startTray({
    onOpen: (runId) => opened.push(runId),
    onShow: (runId) => shown.push(runId),
    onQuit: () => {},
    spawnImpl: () => child,
  });
  child.stdout.write("ready\nopen\nopen 20260923-101242-8907\nopen ../../etc\nshow 20260923-094310-c0b1\nshow x\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(opened, [null, "20260923-101242-8907"], "Open Sue carries no run; a run row names one; anything else is ignored");
  assert.deepEqual(shown, ["20260923-094310-c0b1"], "a raised window is turned to the run chosen, and only to a run id");

  icon.runs([{ runId: "20260923-101242-8907", host: "discord.com", done: 3, total: 5 }], 18);
  icon.runs([]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    child.written
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
    [
      { runs: [{ runId: "20260923-101242-8907", host: "discord.com", done: 3, total: 5 }], more: 18 },
      { runs: [], more: 0 },
    ],
  );
});

test("an icon that ends on its own is noticed, and nothing more is written to it", async () => {
  const child = fakeProcess();
  const gone = [];
  const icon = startTray({ spawnImpl: () => child, onGone: (code) => gone.push(code) });
  assert.equal(icon.alive, true);
  child.emit("exit", 1);
  assert.equal(await icon.ready, false, "an icon that never said ready did not start");
  assert.equal(icon.alive, false);
  assert.deepEqual(gone, [1]);
  icon.say("Sue", "into the void");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.written, "");
});

test("closing the icon ends its input, which is how it knows to clear itself and exit", () => {
  const child = fakeProcess();
  const icon = startTray({ spawnImpl: () => child });
  let ended = false;
  child.stdin.on("finish", () => (ended = true));
  icon.close();
  return new Promise((resolve) => setImmediate(() => resolve(assert.equal(ended, true))));
});
