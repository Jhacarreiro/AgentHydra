/**
 * sue-door.spec - the server's `sue` tool before and around the engine, against a stand-in engine that echoes what it
 * was handed (ported from Connections' sue-launch-env.spec, sue-material-door.spec and sue-save-persona-registers.spec).
 *   - the run's child env names the calling chat, the mcp route and its session, and nothing overrides that;
 *   - a relative `file` reaches the engine absolute, in the chat's own folder;
 *   - a Sue source older than the material store is told to update, and nothing runs;
 *   - ape and art are actions, not unknowns;
 *   - save_persona and edit_persona reach the engine with their fields, and its answer comes back as it said it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { handle } from "../server.mjs";
import { runSue, sueLaunchEnv } from "../sue-tool.mjs";

const SAVED = ["SUE_ENGINE_DIR", "SUE_HOME", "CLAUDE_CODE_SESSION_ID", "SUE_LAUNCHED_CHAT"];
const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));
let home;
let engine;

const call = async (args) => (await handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "sue", arguments: args } })).result;
const text = (r) => r.content[0].text;

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "sue-door-"));
  engine = join(home, "engine");
  mkdirSync(join(engine, "lib"), { recursive: true });
  // The stand-in engine answers with the action, the params and the launch env it was handed, as one JSON object.
  writeFileSync(
    join(engine, "sue.mjs"),
    [
      'const i = process.argv.indexOf("--json");',
      'const w = process.argv.indexOf("--workspace");',
      "const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('SUE_LAUNCHED')));",
      "process.stdout.write(JSON.stringify({ ok: true, action: process.argv[2], workspace: w > 0 ? process.argv[w + 1] : null, args: JSON.parse(process.argv[i + 1]), env }));",
    ].join("\n"),
  );
  process.env.SUE_ENGINE_DIR = engine;
  process.env.SUE_HOME = home;
  delete process.env.SUE_LAUNCHED_CHAT;
});

afterAll(() => {
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

describe("a Sue run's child env", () => {
  it("carries the calling chat's session id, the mcp route and the chat id", () => {
    const env = sueLaunchEnv({ id: "chat-abc-7", env: { CLAUDE_CODE_SESSION_ID: "session-xyz-9" } });
    expect(env).toEqual({ SUE_LAUNCHED_SESSION: "session-xyz-9", SUE_LAUNCHED_VIA: "mcp", SUE_LAUNCHED_CHAT: "chat-abc-7" });
  });

  it("leaves the session id out when the chat names none, rather than sending an empty one", () => {
    const env = sueLaunchEnv({ id: "chat-abc-7", env: {} });
    expect("SUE_LAUNCHED_SESSION" in env).toBe(false);
    expect("CLAUDE_CODE_SESSION_ID" in env).toBe(false);
    expect(env.SUE_LAUNCHED_VIA).toBe("mcp");
  });

  it("reaches the engine, spread last, so no engine value can override it", async () => {
    process.env.CLAUDE_CODE_SESSION_ID = "session-real-1";
    const stub = { engineDir: engine, exe: process.execPath, env: { SUE_LAUNCHED_VIA: "cli" } };
    const answer = JSON.parse(await runSue({ action: "status" }, { engine: stub }));
    expect(answer.env).toEqual({ SUE_LAUNCHED_VIA: "mcp", SUE_LAUNCHED_SESSION: "session-real-1" });
  });
});

describe("the sue tool's file and idea", () => {
  it("⛔ a Sue source with no material store is told to update, and nothing runs", async () => {
    for (const shown of [{ file: "deck.pdf" }, { idea: "A tip jar for podcasts", title: "Tip jar" }]) {
      const r = await call({ action: "focus_group", ...shown });
      expect(r.isError).toBe(true);
      const body = JSON.parse(text(r));
      expect(body.error).toBe("sue_update_needed");
      expect(body.detail).toContain("nothing ran");
    }
  });

  it("knows the ape and art actions, and does not refuse them as unknown", async () => {
    for (const action of ["ape", "art"]) {
      const r = await call({ action, url: "https://example.test", intent: "a power user's daily flow" });
      expect(text(r)).not.toContain("sue_unknown_action");
      expect(JSON.parse(text(r)).action).toBe(action);
    }
  });

  it("refuses an unknown action by name, and runs nothing", async () => {
    const r = await call({ action: "launch" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error).toBe("sue_unknown_action");
  });

  it("a relative file reaches the engine as a path in the chat's own folder", async () => {
    writeFileSync(join(engine, "lib", "material.mjs"), "export {};\n");
    const stub = { engineDir: engine, exe: process.execPath, env: {} };
    const { args, workspace } = JSON.parse(await runSue({ action: "status", file: "out/deck.pdf" }, { engine: stub, cwd: home }));
    expect(isAbsolute(args.file)).toBe(true);
    expect(args.file.replace(/\\/g, "/")).toBe(`${home.replace(/\\/g, "/")}/out/deck.pdf`);
    expect(workspace).toBe(home);
    const absolute = join(home, "deck.pdf");
    expect(JSON.parse(text(await call({ action: "status", file: absolute }))).args.file).toBe(absolute);
  });
});

describe("save_persona and edit_persona go to the engine as they came", () => {
  it("hands the person's fields to the engine and answers what it said, with nothing added", async () => {
    const ray = { id: "broker-ray", like: "bob", voice: "You are Ray, 54, a commercial real estate broker.", complains: false };
    const answer = JSON.parse(text(await call({ action: "save_persona", ...ray })));
    expect(answer).toEqual({ ok: true, action: "save_persona", workspace: process.cwd(), args: ray, env: expect.any(Object) });
    const edit = JSON.parse(text(await call({ action: "edit_persona", id: "broker-ray", set: { languages: ["en", "es"] }, builtIn: true })));
    expect(edit.args).toEqual({ id: "broker-ray", set: { languages: ["en", "es"] }, builtIn: true });
    expect("inConnections" in edit).toBe(false);
  });

  it("sends a large call in a file, so a Windows command line never cuts it", async () => {
    let argv = [];
    const run = async (_exe, a) => ((argv = a), { code: 0, stdout: '{"ok":true}', stderr: "" });
    const stub = { engineDir: engine, exe: process.execPath, env: {} };
    await runSue({ action: "save_persona", id: "long", voice: "x".repeat(9000) }, { engine: stub, run });
    expect(argv).toContain("--json-file");
    expect(argv).not.toContain("--json");
  });

  it("a blind round runs in the folder its project names, never the chat's", async () => {
    let argv = [];
    const run = async (_exe, a) => ((argv = a), { code: 0, stdout: '{"ok":true}', stderr: "" });
    const stub = { engineDir: engine, exe: process.execPath, env: {} };
    await runSue({ action: "blind_round" }, { engine: stub, run, cwd: home });
    expect(argv).not.toContain("--workspace");
    await runSue({ action: "blind_round", workspace: "ExampleApp" }, { engine: stub, run, cwd: home });
    expect(argv.slice(argv.indexOf("--workspace"), argv.indexOf("--workspace") + 2)).toEqual(["--workspace", "ExampleApp"]);
  });

  it("an engine that crashed before answering comes back as its exit and its words", async () => {
    const run = async () => ({ code: 3, stdout: "", stderr: "TypeError: boom" });
    const out = await runSue({ action: "status" }, { engine: { engineDir: engine, exe: process.execPath, env: {} }, run });
    expect(out).toContain("$ sue status");
    expect(out).toContain("exit 3");
    expect(out).toContain("TypeError: boom");
  });
});
