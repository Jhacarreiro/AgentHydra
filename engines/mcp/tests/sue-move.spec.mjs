/**
 * sue-move.spec - one move of one Sue's hands through the server's `sue` tool (action 'move'), with no shell
 * (ported from Connections' sue-move.spec). A move is forwarded to the run's relay exactly as hand.mjs forwards it
 * (sue/lib/hand-move.mjs, which both import). Pinned against a stub relay: what the relay is sent, that a refusal is an
 * ordinary answer, and that a move that never reached her is an error result.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";

import { handle } from "../server.mjs";
import { ROOT } from "../proc.mjs";
import { resolveSueEngine, sueMove } from "../sue-tool.mjs";

const ENGINE = join(ROOT, "sue");
const TOKEN = "t".repeat(32);
const RUN = "20260924-000000-move";
const sent = [];
let server;
let home;
const SAVED = ["SUE_ENGINE_DIR", "SUE_HOME"];
const saved = Object.fromEntries(SAVED.map((k) => [k, process.env[k]]));

// The relay's answers, by move: the shapes body-relay.mjs `move()` gives back.
function answer(tool, sue) {
  if (sue === "sue-over") return [409, { error: "Her visit is over (concluded)." }];
  if (tool === "tools")
    return [200, { tools: [{ name: "click", description: "Click a thing.", inputSchema: { properties: { target: { type: "number" } }, required: ["target"] } }] }];
  if (tool === "pay") return [200, { content: [{ type: "text", text: "Her hands will not pay on this visit." }], isError: true }];
  return [200, { content: [{ type: "text", text: `${tool} done` }] }];
}

const read = (req) =>
  new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => resolve(raw));
  });

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "sue-move-"));
  server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req));
    sent.push({ token: req.headers["x-sue-token"], body });
    const [status, reply] = answer(body.tool, body.sue);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(reply));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  mkdirSync(join(home, "runs", RUN), { recursive: true });
  writeFileSync(join(home, "runs", RUN, "relay.json"), JSON.stringify({ port, token: TOKEN }));
  process.env.SUE_ENGINE_DIR = ENGINE;
  process.env.SUE_HOME = home;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  for (const key of SAVED) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(home, { recursive: true, force: true });
});

// Exactly the call a Sue's brief names (sue/lib/body-relay.mjs buildChatBrief), sent to this server.
const call = async (params) =>
  (await handle({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "sue", arguments: { action: "move", runId: RUN, ...params } } })).result;
const text = (r) => (typeof r === "string" ? r : r.content[0].text);

describe("the sue tool's 'move' action", () => {
  it("is on the tool's schema, with its params beside the others", async () => {
    const { result } = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const sue = result.tools.find((t) => t.name === "sue");
    expect(Object.keys(sue.inputSchema.properties).slice(0, 4)).toEqual(["action", "sue", "move", "args"]);
    expect(sue.inputSchema.properties.action.enum[0]).toBe("move");
    expect(sue.description).toContain("Each move is one call: action:'move'");
  });

  it("sends the move to the run's relay with its token, typed by her body like a shell word", async () => {
    sent.length = 0;
    const r = await call({ sue: "sue-1", move: "click", args: { target: "2" } });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("click done");
    expect(sent).toEqual([{ token: TOKEN, body: { sue: "sue-1", tool: "click", args: { target: "2" }, raw: true } }]);
  });

  it("renders 'tools' the way hand.mjs prints it", async () => {
    expect(text(await call({ sue: "sue-1", move: "tools" }))).toBe("click target (number)\n    Click a thing.");
  });

  it("a refusal is an ordinary answer: to her it is simply what happened", async () => {
    const r = await call({ sue: "sue-1", move: "pay" });
    expect(r.isError).toBeFalsy();
    expect(text(r)).toBe("Her hands will not pay on this visit.");
  });

  it("⛔ a move that never reached her is an error result: her visit is over, or there is no run", async () => {
    const over = await call({ sue: "sue-over", move: "look" });
    expect(over.isError).toBe(true);
    expect(text(over)).toContain("Her visit is over");
    const gone = await call({ runId: "20260924-000000-gone", sue: "sue-1", move: "look" });
    expect(gone.isError).toBe(true);
    expect(text(gone)).toContain("no open relay");
  });

  it("⛔ a move with no Sue named is refused before anything is sent", async () => {
    sent.length = 0;
    const r = await call({ move: "look" });
    expect(r.isError).toBe(true);
    expect(JSON.parse(text(r)).error).toBe("sue_move_invalid");
    expect(sent).toEqual([]);
  });

  it("the resolved engine carries the SUE_HOME it was given, so the move hands it on", () => {
    expect(resolveSueEngine({ env: { SUE_ENGINE_DIR: ENGINE, SUE_HOME: home } })?.env).toEqual({ SUE_HOME: home });
  });

  it("with no override, the engine is this checkout's own sue/ folder", () => {
    expect(resolveSueEngine({ env: {} })?.engineDir).toBe(ENGINE);
  });

  it("a run under another SUE_HOME is not found under this one", async () => {
    expect(await sueMove({ runId: RUN, sue: "sue-1", move: "look" }, { engine: { engineDir: ENGINE, env: { SUE_HOME: home } } })).toBe("look done");
    const elsewhere = mkdtempSync(join(tmpdir(), "sue-move-other-"));
    try {
      const miss = await sueMove({ runId: RUN, sue: "sue-1", move: "look" }, { engine: { engineDir: ENGINE, env: { SUE_HOME: elsewhere } } });
      expect(miss.isError).toBe(true);
    } finally {
      rmSync(elsewhere, { recursive: true, force: true });
    }
  });

  it("an engine too old to have the move says so and names the shell fallback", async () => {
    const old = mkdtempSync(join(tmpdir(), "sue-move-old-"));
    try {
      writeFileSync(join(old, "sue.mjs"), "// engine\n");
      const r = await sueMove({ runId: RUN, sue: "sue-1", move: "look" }, { engine: { engineDir: old, env: {} } });
      expect(r.isError).toBe(true);
      expect(text(r)).toContain("hand.mjs");
    } finally {
      rmSync(old, { recursive: true, force: true });
    }
  });
});
