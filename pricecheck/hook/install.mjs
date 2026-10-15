#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EVENT = "PostToolUse";
const MATCHER = "Edit|Write|MultiEdit";
const TIMEOUT_SECONDS = 8;
const OWN_COMMAND = /[\\/]pricecheck[\\/]hook[\\/]price-tag\.mjs"?\s*$/;

export function defaultSettingsPath(env = process.env) {
  return env.AGENTHYDRA_CLAUDE_SETTINGS || path.join(os.homedir(), ".claude", "settings.json");
}

export function defaultHookPath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "price-tag.mjs");
}

const isOwn = (hook) => typeof hook?.command === "string" && OWN_COMMAND.test(hook.command);
const listOf = (value) => (Array.isArray(value) ? value : []);
const hasOwn = (group) => listOf(group?.hooks).some(isOwn);

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

export function install({ settingsPath = defaultSettingsPath(), hookPath = defaultHookPath() } = {}) {
  const file = path.resolve(settingsPath);
  const settings = readSettings(file);
  const hooks = { ...(settings.data.hooks ?? {}) };
  const entry = { type: "command", command: `node "${hookPath}"`, timeout: TIMEOUT_SECONDS };
  const groups = listOf(hooks[EVENT]);
  const next = groups.some(hasOwn)
    ? groups.map((group) => (hasOwn(group) ? { ...group, hooks: group.hooks.map((hook) => (isOwn(hook) ? entry : hook)) } : group))
    : [...groups, { matcher: MATCHER, hooks: [entry] }];
  const write = writeSettings(file, settings, { ...settings.data, hooks: { ...hooks, [EVENT]: next } });
  return { settingsPath: file, ...write };
}

export function uninstall({ settingsPath = defaultSettingsPath() } = {}) {
  const file = path.resolve(settingsPath);
  const settings = readSettings(file);
  const hooks = { ...(settings.data.hooks ?? {}) };
  const groups = listOf(hooks[EVENT]);
  if (!groups.some(hasOwn)) return { settingsPath: file, changed: false, backup: null };
  const kept = [];
  for (const group of groups) {
    if (!hasOwn(group)) {
      kept.push(group);
      continue;
    }
    const rest = group.hooks.filter((hook) => !isOwn(hook));
    if (rest.length) kept.push({ ...group, hooks: rest });
  }
  if (kept.length) hooks[EVENT] = kept;
  else delete hooks[EVENT];
  const next = { ...settings.data };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  const write = writeSettings(file, settings, next);
  return { settingsPath: file, ...write };
}

export function status({ settingsPath = defaultSettingsPath() } = {}) {
  const file = path.resolve(settingsPath);
  const hooks = readSettings(file).data.hooks ?? {};
  return { settingsPath: file, installed: listOf(hooks[EVENT]).some(hasOwn) };
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
      const s = status({ settingsPath });
      console.log(`price tag hook: ${s.installed ? "installed" : "not installed"} (${settingsPath})`);
    } else if (argv.includes("--uninstall")) {
      const r = uninstall({ settingsPath });
      const state = r.changed ? "updated" : "already clean";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      console.log(`uninstall: ${state} ${settingsPath}${backup}`);
    } else {
      const r = install({ settingsPath });
      const state = r.changed ? "updated" : "already up to date";
      const backup = r.backup ? ` (backup ${r.backup})` : "";
      console.log(`install: ${state} ${settingsPath}${backup}`);
    }
  } catch (error) {
    console.error(`price tag install: ${error.message}`);
    process.exitCode = 1;
  }
}
