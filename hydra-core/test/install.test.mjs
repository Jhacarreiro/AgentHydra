import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { defaultHookPath, install, status, uninstall } from "../install.mjs";

const INSTALL = path.resolve(import.meta.dirname, "..", "install.mjs");
const coreGroup = { hooks: [{ type: "command", command: `node "${defaultHookPath()}"` }] };
const extraHook = { type: "command", command: 'node "C:/example/extra.mjs"' };
const extraGroup = { hooks: [extraHook] };
const otherHook = { type: "command", command: "node C:/Example/other-hook.mjs" };

const STUB_ENTRY = String.raw`
const EXTRA = /[\\/]example[\\/]extra\.mjs"?\s*$/;
export const SAVED_FILE = "extra-entry.json";
export const matches = (hook) => typeof hook?.command === "string" && EXTRA.test(hook.command);
const hasMatch = (group) => Array.isArray(group?.hooks) && group.hooks.some(matches);
export function detach(groups) {
  const records = [];
  groups.forEach((group, index) => {
    if (!hasMatch(group)) return;
    const rest = group.hooks.filter((hook) => !matches(hook));
    records.push({ index, original: group, trimmed: rest.length ? { ...group, hooks: rest } : null });
  });
  return records;
}
export function reattach(groups, records) {
  const list = [...groups];
  for (const { index, original, trimmed } of records) {
    const at = trimmed ? list.findIndex((group) => JSON.stringify(group) === JSON.stringify(trimmed)) : -1;
    if (at >= 0) {
      list[at] = original;
      continue;
    }
    list.splice(Math.min(index, list.length), 0, { ...original, hooks: original.hooks.filter(matches) });
  }
  return list;
}
`;

async function withTemp(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-install-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function addonHome(dir) {
  const home = path.join(dir, "addon");
  mkdirSync(path.join(home, "people", "router"), { recursive: true });
  writeFileSync(path.join(home, "people", "router", "entry.mjs"), STUB_ENTRY);
  return home;
}

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));

test("install adds the core hook to both events, keeps other hooks, and is a no-op the second time", () =>
  withTemp(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const env = { SUE_DREDD_HOME: addonHome(dir) };
    const other = { hooks: [otherHook] };
    writeFileSync(
      settingsPath,
      JSON.stringify({ theme: "dark", hooks: { PreToolUse: [other], UserPromptSubmit: [other] } }, null, 2),
    );

    const first = await install({ settingsPath, coreDir, env });
    assert.equal(first.changed, true);
    assert.ok(first.backup && existsSync(first.backup), "a backup is written before a change");
    const after = readJson(settingsPath);
    assert.equal(after.theme, "dark");
    assert.deepStrictEqual(after.hooks.PreToolUse, [other]);
    assert.deepStrictEqual(after.hooks.UserPromptSubmit, [other, coreGroup]);
    assert.deepStrictEqual(after.hooks.SessionStart, [coreGroup]);

    const second = await install({ settingsPath, coreDir, env });
    assert.equal(second.changed, false);
    assert.equal(second.backup, null);
    assert.deepStrictEqual(readJson(settingsPath), after);
    assert.equal(readdirSync(dir).filter((f) => f.includes(".bak-")).length, 1);
  }));

test("install takes out the add-on's hook, and uninstall puts it back exactly", () =>
  withTemp(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const env = { SUE_DREDD_HOME: addonHome(dir) };
    const original = { theme: "dark", hooks: { UserPromptSubmit: [extraGroup] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const installed = await install({ settingsPath, coreDir, env });
    assert.equal(installed.addonRemoved, 1);
    assert.equal((await status({ settingsPath, coreDir, env })).addon, false);
    assert.equal((await status({ settingsPath, coreDir, env })).core, true);
    assert.equal((await status({ settingsPath, coreDir, env })).addonSaved, true);

    const removed = await uninstall({ settingsPath, coreDir, env });
    assert.equal(removed.addonRestored, 1);
    assert.deepStrictEqual(readJson(settingsPath), original);
    assert.equal((await status({ settingsPath, coreDir, env })).core, false);
    assert.equal((await status({ settingsPath, coreDir, env })).addonSaved, false);
  }));

test("without the add-on, install and uninstall touch no add-on hook", () =>
  withTemp(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const env = { SUE_DREDD_HOME: path.join(dir, "none") };
    const original = { hooks: { UserPromptSubmit: [extraGroup] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    const installed = await install({ settingsPath, coreDir, env });
    assert.equal(installed.addonRemoved, 0);
    assert.deepStrictEqual(readJson(settingsPath).hooks.UserPromptSubmit, [extraGroup, coreGroup]);

    const removed = await uninstall({ settingsPath, coreDir, env });
    assert.equal(removed.addonRestored, 0);
    assert.deepStrictEqual(readJson(settingsPath).hooks.UserPromptSubmit, [extraGroup]);
  }));

test("uninstall restores an add-on hook that shared a group with another hook", () =>
  withTemp(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const env = { SUE_DREDD_HOME: addonHome(dir) };
    const mixed = { hooks: [otherHook, extraHook] };
    const original = { hooks: { UserPromptSubmit: [mixed] } };
    writeFileSync(settingsPath, JSON.stringify(original, null, 2));

    await install({ settingsPath, coreDir, env });
    assert.deepStrictEqual(readJson(settingsPath).hooks.UserPromptSubmit, [{ hooks: [otherHook] }, coreGroup]);

    await uninstall({ settingsPath, coreDir, env });
    assert.deepStrictEqual(readJson(settingsPath), original);
  }));

test("install creates a missing settings file, and uninstall on a missing file changes nothing", () =>
  withTemp(async (dir) => {
    const coreDir = path.join(dir, "core");
    const env = { SUE_DREDD_HOME: addonHome(dir) };
    const settingsPath = path.join(dir, "fresh", "settings.json");
    const made = await install({ settingsPath, coreDir, env });
    assert.equal(made.changed, true);
    assert.equal(made.backup, null);
    assert.deepStrictEqual(readJson(settingsPath).hooks.SessionStart, [coreGroup]);

    const missing = path.join(dir, "none.json");
    const result = await uninstall({ settingsPath: missing, coreDir, env });
    assert.equal(result.changed, false);
    assert.equal(existsSync(missing), false);
  }));

// Real subprocesses: a cold runner can take longer than bun's 5 s default.
test("the CLI works on a --settings file and --status reports both entries", { timeout: 20_000 }, () =>
  withTemp((dir) => {
    const settingsPath = path.join(dir, "custom", "settings.json");
    const env = { ...process.env, AGENTHYDRA_CORE_DIR: path.join(dir, "core"), SUE_DREDD_HOME: addonHome(dir) };
    const cli = (...args) => spawnSync(process.execPath, [INSTALL, ...args], { env, encoding: "utf8" });

    let r = cli("--status", "--settings", settingsPath);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /core: not installed/);

    r = cli("--settings", settingsPath);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /install: updated/);

    r = cli("--status", "--settings", settingsPath);
    assert.match(r.stdout, /core: installed/);

    r = cli("--uninstall", "--settings", settingsPath);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /uninstall: updated/);

    r = cli("--status", "--settings", settingsPath);
    assert.match(r.stdout, /core: not installed/);
  }));
