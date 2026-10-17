import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { handle } from "../hook.mjs";
import { defaultHookPath, install, uninstall } from "../install.mjs";

const CLEARED = ["HYDRA_DESK_CHAT_ID", "AGENTHYDRA_ROLE", "AGENTHYDRA_CLIMAYTE_WORKER", "AGENTHYDRA_CLIMAYTE_CHAT"];

async function withCore(fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "hydra-core-stop-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function envFor(dir, extra = {}) {
  const env = { ...process.env, AGENTHYDRA_CORE_DIR: dir };
  for (const key of CLEARED) delete env[key];
  return { ...env, ...extra };
}

const prompt = (text) => ({ type: "user", message: { role: "user", content: text } });
const says = (text) => ({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });

function stop(dir, entries) {
  const transcript = path.join(dir, "transcript.jsonl");
  writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join("\n"));
  return { hook_event_name: "Stop", session_id: "sess-stop", stop_hook_active: false, transcript_path: transcript };
}

function turnOn(dir) {
  writeFileSync(path.join(dir, "ON"), "");
}

function seamHome(dir, president) {
  const home = path.join(dir, "sue-dredd");
  mkdirSync(path.join(home, "people", "router"), { recursive: true });
  writeFileSync(path.join(home, "people", "router", "president.mjs"), president);
  return home;
}

const fire = async (input, env) => (await handle(JSON.stringify(input), env)) ?? null;

test("a Stop is decided by the people add-on's president module when the checkout is present", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const home = seamHome(dir, 'export function stop() { return { decision: "block", reason: "from the add-on" }; }\n');
    const input = stop(dir, [prompt("fix it"), says("Done.")]);
    assert.deepEqual(await fire(input, envFor(dir, { SUE_DREDD_HOME: home })), {
      decision: "block",
      reason: "from the add-on",
    });
  }));

test("a president module that fails to load lets the Stop through", () =>
  withCore(async (dir) => {
    turnOn(dir);
    const home = seamHome(dir, 'throw new Error("broken add-on");\n');
    const input = stop(dir, [prompt("fix it"), says("Should I delete the old folder?")]);
    assert.equal(await fire(input, envFor(dir, { SUE_DREDD_HOME: home })), null);
  }));

test("install adds Stop beside an existing Stop hook and uninstall removes only ours", () =>
  withCore(async (dir) => {
    const settingsPath = path.join(dir, "settings.json");
    const coreDir = path.join(dir, "core");
    const other = { hooks: [{ type: "command", command: "node C:/Example/other-stop.mjs" }] };
    writeFileSync(settingsPath, JSON.stringify({ hooks: { Stop: [other] } }));
    await install({ settingsPath, coreDir, hookPath: defaultHookPath() });
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    assert.equal(installed.hooks.Stop.length, 2);
    assert.deepEqual(installed.hooks.Stop[0], other);
    assert.match(installed.hooks.Stop[1].hooks[0].command, /hook\.mjs"$/);
    await uninstall({ settingsPath, coreDir });
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { hooks: { Stop: [other] } });
  }));
