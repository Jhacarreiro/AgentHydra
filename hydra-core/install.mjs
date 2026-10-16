#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAddon } from "./addon.mjs";

export const EVENTS = ["UserPromptSubmit", "SessionStart", "Stop"];
const CORE_COMMAND = /[\\/]hydra-core[\\/]hook\.mjs"?\s*$/;
const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY_MODULE = path.join("people", "router", "entry.mjs");
const NO_ADDON = { matches: () => false, detach: () => [], reattach: (groups) => groups, SAVED_FILE: null };

export function defaultSettingsPath(env = process.env) {
  return env.AGENTHYDRA_CLAUDE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultCoreDir(env = process.env) {
  return env.AGENTHYDRA_CORE_DIR || path.join(os.homedir(), ".agenthydra", "core");
}

export function defaultHookPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "hook.mjs");
}

const isCore = (hook) => typeof hook?.command === "string" && CORE_COMMAND.test(hook.command);
const listOf = (value) => (Array.isArray(value) ? value : []);
const hasHook = (group, test) => Array.isArray(group?.hooks) && group.hooks.some(test);

async function loadEntry(env) {
  return (await loadAddon(ENTRY_MODULE, APP_ROOT, env)) ?? NO_ADDON;
}

function removeHooks(groups, test) {
  const kept = [];
  for (const group of groups) {
    if (!hasHook(group, test)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((hook) => !test(hook));
    if (rest.length) kept.push({ ...group, hooks: rest });
  }
  return kept;
}

function upsertCore(groups, command) {
  if (!groups.some((group) => hasHook(group, isCore))) return [...groups, { hooks: [{ type: "command", command }] }];
  return groups.map((group) =>
    hasHook(group, isCore)
      ? { ...group, hooks: group.hooks.map((hook) => (isCore(hook) ? { ...hook, command } : hook)) }
      : group,
  );
}

function readSettings(file) {
  if (!existsSync(file)) return { existed: false, data: {} };
  const text = readFileSync(file, "utf8");
  let data;
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${error.message}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error(`${file} is not a JSON object`);
  return { existed: true, data };
}

function writeSettings(file, { existed, data }, next) {
  if (existed && JSON.stringify(data) === JSON.stringify(next)) return { changed: false, backup: null };
  let backup = null;
  if (existed) {
    backup = `${file}.bak-${Date.now()}`;
    copyFileSync(file, backup);
  }
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
  return { changed: true, backup };
}

function savedFile(coreDir, addon) {
  return addon.SAVED_FILE ? path.join(coreDir, addon.SAVED_FILE) : null;
}

function readRecords(file) {
  return file && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
}

function writeRecords(file, records) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(records, null, 2)}\n`);
}

export async function install({
  settingsPath = defaultSettingsPath(),
  coreDir = defaultCoreDir(),
  hookPath = defaultHookPath(),
  env = process.env,
} = {}) {
  const file = path.resolve(settingsPath);
  const addon = await loadEntry(env);
  const settings = readSettings(file);
  const hooks = { ...(settings.data.hooks ?? {}) };
  const command = `node "${hookPath}"`;
  const recordFile = savedFile(coreDir, addon);
  const saved = readRecords(recordFile);
  const found = {};
  for (const event of EVENTS) {
    const groups = listOf(hooks[event]);
    const detached = addon.detach(groups);
    if (detached.length) found[event] = detached;
    hooks[event] = upsertCore(removeHooks(groups, addon.matches), command);
  }
  const addonRemoved = Object.values(found).reduce((count, records) => count + records.length, 0);
  const write = writeSettings(file, settings, { ...settings.data, hooks });
  if (addonRemoved) writeRecords(recordFile, { ...saved, [file]: { ...(saved[file] ?? {}), ...found } });
  return { settingsPath: file, ...write, addonRemoved };
}

export async function uninstall({
  settingsPath = defaultSettingsPath(),
  coreDir = defaultCoreDir(),
  env = process.env,
} = {}) {
  const file = path.resolve(settingsPath);
  const settings = readSettings(file);
  if (!settings.existed) return { settingsPath: file, changed: false, backup: null, addonRestored: 0 };
  const addon = await loadEntry(env);
  const hooks = { ...(settings.data.hooks ?? {}) };
  const recordFile = savedFile(coreDir, addon);
  const saved = readRecords(recordFile);
  const records = saved[file] ?? {};
  let addonRestored = 0;
  for (const event of EVENTS) {
    if (!Array.isArray(hooks[event]) && !records[event]) continue;
    const before = listOf(hooks[event]);
    const entries = listOf(records[event]);
    addonRestored += entries.length;
    const groups = addon.reattach(removeHooks(before, isCore), entries);
    if (groups.length || !before.length) hooks[event] = groups;
    else delete hooks[event];
  }
  const next = { ...settings.data };
  if (Object.keys(hooks).length || settings.data.hooks !== undefined) next.hooks = hooks;
  else delete next.hooks;
  const write = writeSettings(file, settings, next);
  if (recordFile && saved[file]) {
    delete saved[file];
    writeRecords(recordFile, saved);
  }
  return { settingsPath: file, ...write, addonRestored };
}

export async function status({
  settingsPath = defaultSettingsPath(),
  coreDir = defaultCoreDir(),
  env = process.env,
} = {}) {
  const file = path.resolve(settingsPath);
  const addon = await loadEntry(env);
  const hooks = readSettings(file).data.hooks ?? {};
  const core = EVENTS.every((event) => listOf(hooks[event]).some((group) => hasHook(group, isCore)));
  const addonInstalled = EVENTS.some((event) => listOf(hooks[event]).some((group) => hasHook(group, addon.matches)));
  const addonSaved = Boolean(readRecords(savedFile(coreDir, addon))[file]);
  return { settingsPath: file, core, addon: addonInstalled, addonSaved };
}

const isMain = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    const argv = process.argv.slice(2);
    const flag = (name) => {
      const at = argv.indexOf(name);
      if (at < 0) return null;
      if (!argv[at + 1]) throw new Error(`${name} needs a value`);
      return argv[at + 1];
    };
    const given = flag("--settings");
    const settingsPath = given ? path.resolve(given) : defaultSettingsPath();
    if (argv.includes("--status")) {
      const s = await status({ settingsPath });
      console.log(`core: ${s.core ? "installed" : "not installed"}`);
      const saved = s.addonSaved ? " (entry saved, --uninstall puts it back)" : "";
      console.log(`add-on: ${s.addon ? "installed" : "not installed"}${saved}`);
    } else if (argv.includes("--uninstall")) {
      const r = await uninstall({ settingsPath });
      const state = r.changed ? "updated" : "already clean";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      console.log(`uninstall: ${state} ${settingsPath}${backup}; add-on entries restored: ${r.addonRestored}`);
    } else {
      const r = await install({ settingsPath });
      const state = r.changed ? "updated" : "already up to date";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      const removed = r.addonRemoved ? `; add-on entries removed: ${r.addonRemoved}` : "";
      console.log(`install: ${state} ${settingsPath}${backup}${removed}`);
    }
  } catch (error) {
    console.error(`hydra-core install: ${error.message}`);
    process.exitCode = 1;
  }
}
