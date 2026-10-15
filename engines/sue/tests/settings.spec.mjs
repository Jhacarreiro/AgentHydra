/**
 * settings.spec - how Sue's window behaves on this computer (lib/settings.mjs): the toolbar is the
 * default for closing her window (Owner, 2026-09-23), a file that says anything else reads as the default,
 * and a change that names an unknown setting or choice is refused before anything is written.
 *
 * Plain node (`node --test sue/tests/settings.spec.mjs`). SUE_HOME points the state folder at
 * a throwaway directory, so the real settings are never touched.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(tmpdir(), "sue-settings-"));
process.env.SUE_HOME = home;
const { DEFAULT_SETTINGS, readSettings, saveSettings } = await import("../lib/settings.mjs");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

const file = path.join(home, "state", "manager", "settings.json");

test("never saved: closing her window leaves her in the toolbar, and pictures are kept", () => {
  assert.deepEqual(readSettings(), { whenClosed: "toolbar", keepPictures: "forever" });
  assert.deepEqual(DEFAULT_SETTINGS, { whenClosed: "toolbar", keepPictures: "forever" });
});

test("a wave an AI starts has no setting: the window stays a person's choice (sue watch)", () => {
  assert.equal("whenAiStarts" in DEFAULT_SETTINGS, false);
  assert.throws(() => saveSettings({ whenAiStarts: "window" }), /whenAiStarts is not a setting/);
});

test("a change is saved and read back whole", () => {
  assert.deepEqual(saveSettings({ whenClosed: "quit" }), { whenClosed: "quit", keepPictures: "forever" });
  assert.deepEqual(readSettings(), { whenClosed: "quit", keepPictures: "forever" });
  assert.deepEqual(
    saveSettings({ keepPictures: "30" }),
    { whenClosed: "quit", keepPictures: "30" },
    "one change keeps the other",
  );
});

test("an unknown setting or choice is refused and nothing is written", () => {
  const before = fs.readFileSync(file, "utf8");
  assert.throws(() => saveSettings({ whenClosed: "explode" }), /whenClosed is toolbar or quit/);
  assert.throws(() => saveSettings({ keepPictures: "3" }), /keepPictures is forever or 7 or 14 or 30 or 90/);
  assert.throws(() => saveSettings({ whenClosed: "quit", colour: "blue" }), /colour is not a setting/);
  assert.throws(() => saveSettings(null), /object/);
  assert.throws(() => saveSettings(["quit"]), /object/);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("a file that says anything else reads as the defaults, key by key", () => {
  fs.writeFileSync(file, JSON.stringify({ whenClosed: "burn it", keepPictures: "7" }));
  assert.deepEqual(readSettings(), { whenClosed: "toolbar", keepPictures: "7" });
  fs.writeFileSync(file, "{ half a file");
  assert.deepEqual(readSettings(), DEFAULT_SETTINGS);
});

test("a setting or a choice this engine does not know survives its save: an older Sue never drops a newer one's", () => {
  fs.writeFileSync(file, JSON.stringify({ whenAiStarts: "window", whenClosed: "toolbar", keepPictures: "365", dock: "left" }));
  assert.deepEqual(
    saveSettings({ whenClosed: "quit" }),
    { whenClosed: "quit", keepPictures: "forever" },
    "answered as this engine reads them",
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), {
    whenAiStarts: "window",
    whenClosed: "quit",
    keepPictures: "365",
    dock: "left",
  });
});
