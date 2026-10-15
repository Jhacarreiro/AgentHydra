/**
 * body-relay.spec - the relay a chat's own subagents drive Sues through (`--brain chat`), and
 * hand.mjs, the shell command they drive it with. The body is tests/fixtures/fake-body.mjs: the same
 * MCP surface as body.mjs over real stdio, no browser. The Connections MCP's `sue` door sends the same
 * move without a shell (lib/hand-move.mjs); its spec is services/studio/local-mcp/sue-move.spec.ts.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildChatBrief,
  CHAT_BRAINS_FILE,
  coerceArgs,
  createBodyRelay,
  FOCUS_GROUP_ARRIVE_MS,
  FOCUS_GROUP_IDLE_MS,
  RELAY_FILE,
} from "../lib/body-relay.mjs";
import { TABLE_MAX_MS } from "../lib/room.mjs";
import { parseMove, render } from "../hand.mjs";
import { moveFromParams, render as handRender } from "../lib/hand-move.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE_BODY = path.join(HERE, "fixtures", "fake-body.mjs");
const HAND = path.join(HERE, "..", "hand.mjs");

const cleanups = [];
const scratchDirs = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
  for (const d of scratchDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function freshRun() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-relay-"));
  scratchDirs.push(home);
  const runId = "20260922-000000-test";
  const runDir = path.join(home, "runs", runId);
  const sueDir = path.join(runDir, "sue-1-tt-veteran");
  fs.mkdirSync(sueDir, { recursive: true });
  return { home, runId, runDir, sueDir, sueId: "sue-1-tt-veteran" };
}

async function openRelay(run, opts = {}) {
  const relay = createBodyRelay({ runDir: run.runDir, bodyFile: FAKE_BODY, ...opts });
  const port = await relay.listen();
  cleanups.push(() => relay.close());
  return { relay, port };
}

function post(port, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request(
      { host: "127.0.0.1", port, path: "/move", method: "POST", headers: { "content-type": "application/json", ...headers } },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }));
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

function runHand(run, words) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HAND, ...words], { env: { ...process.env, SUE_HOME: run.home }, windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.on("exit", (code) => resolve({ code, out }));
  });
}

const calls = (sueDir) =>
  fs
    .readFileSync(path.join(sueDir, "calls.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("coerceArgs types shell words by the body's own schema and leaves text as text", () => {
  const schema = {
    properties: { target: { type: ["number", "string"] }, text: { type: "string" }, seconds: { type: "number" }, on: { type: "boolean" } },
  };
  assert.deepEqual(coerceArgs({ target: "3", text: "12345", seconds: "2.5", on: "true" }, schema), {
    target: 3,
    text: "12345",
    seconds: 2.5,
    on: true,
  });
  assert.deepEqual(coerceArgs({ target: "Sign in" }, schema), { target: "Sign in" });
});

test("the relay refuses a move without the token, and any move that comes from a page", async () => {
  const run = freshRun();
  const { relay, port } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  assert.equal((await post(port, { sue: run.sueId, tool: "look" })).status, 401);
  assert.equal((await post(port, { sue: run.sueId, tool: "look" }, { "x-sue-token": "nope" })).status, 401);
  const fromPage = await post(
    port,
    { sue: run.sueId, tool: "look" },
    { "x-sue-token": relay.token, origin: "https://development.tickettool.xyz" },
  );
  assert.equal(fromPage.status, 403);
  assert.equal(fs.existsSync(path.join(run.sueDir, "calls.jsonl")), false, "no refused move reached her body");
  // The positive on the same relay: the right token and no Origin reaches her.
  assert.equal((await post(port, { sue: run.sueId, tool: "look" }, { "x-sue-token": relay.token })).status, 200);
  assert.equal(calls(run.sueDir).length, 1);
});

test("her body opens on her first move, not before, and relay.json names the port hand.mjs needs", async () => {
  const run = freshRun();
  const { relay, port } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  assert.equal(JSON.parse(fs.readFileSync(path.join(run.runDir, RELAY_FILE), "utf8")).port, port);
  const index = JSON.parse(fs.readFileSync(path.join(run.runDir, CHAT_BRAINS_FILE), "utf8"));
  assert.deepEqual(
    index.sues.map((s) => [s.sueId, s.state]),
    [[run.sueId, "waiting for her brain"]],
  );
  assert.equal(fs.existsSync(path.join(run.sueDir, "body.stderr.log")), false, "no body before a move");
  const listed = await relay.move({ sue: run.sueId, tool: "tools" });
  assert.deepEqual(
    listed.body.tools.map((t) => t.name),
    ["look", "click", "type", "exit_interview", "do"],
  );
});

test("a picture becomes a file she is told to Read, and shell words arrive typed", async () => {
  const run = freshRun();
  const { relay } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  const look = await relay.move({ sue: run.sueId, tool: "look" });
  const said = look.body.content.map((c) => c.text).join("\n");
  assert.ok(!look.body.content.some((c) => c.type === "image"), "no image rides back through a shell");
  const shot = path.join(run.sueDir, "eyes", "001.jpg");
  assert.ok(said.includes(shot.replace(/\\/g, "/")), said);
  assert.equal(fs.readFileSync(shot, "utf8"), "fake-jpeg");
  await relay.move({ sue: run.sueId, tool: "click", args: { target: "3" }, raw: true });
  await relay.move({ sue: run.sueId, tool: "type", args: { target: "4", text: "12345" }, raw: true });
  assert.deepEqual(
    calls(run.sueDir)
      .filter((c) => c.name !== "look") // a move that changes the screen is answered with the look after it
      .map((c) => c.args),
    [{ target: 3 }, { target: 4, text: "12345" }],
  );
});

test("moves fired together reach her hands one at a time, in the order they came", async () => {
  const run = freshRun();
  const { relay } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  await Promise.all([1, 2, 3].map((n) => relay.move({ sue: run.sueId, tool: "click", args: { target: n } })));
  assert.deepEqual(
    calls(run.sueDir)
      .filter((c) => c.name === "click")
      .map((c) => c.args.target),
    [1, 2, 3],
  );
});

test("a written exit interview ends her visit, closes her body and reports her moves", async () => {
  const run = freshRun();
  const { relay } = await openRelay(run);
  const ended = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  await relay.move({ sue: run.sueId, tool: "look" });
  const missing = await relay.move({ sue: run.sueId, tool: "exit_interview", args: {} });
  assert.equal(missing.body.isError, true, "an incomplete interview does not end her");
  await relay.move({ sue: run.sueId, tool: "exit_interview", args: { verdict: "clear enough" } });
  assert.deepEqual(await ended, { calls: 3, why: "interviewed" });
  const after = await relay.move({ sue: run.sueId, tool: "look" });
  assert.equal(after.status, 410);
});

test("a Sue no brain ever drove is let go with zero moves, so the cannon can refuse to count her", async () => {
  const run = freshRun();
  let clock = 0;
  const { relay } = await openRelay(run, { now: () => clock, arriveMs: 1000, idleMs: 500, sweepMs: 60_000 });
  const ended = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  clock = 999;
  relay.sweep();
  clock = 1001;
  relay.sweep();
  assert.deepEqual(await ended, { calls: 0, why: "no brain arrived" });
});

test("a Sue whose brain goes quiet is let go where she stands", async () => {
  const run = freshRun();
  let clock = 0;
  const { relay } = await openRelay(run, { now: () => clock, arriveMs: 1_000_000, idleMs: 500, sweepMs: 60_000 });
  const ended = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  await relay.move({ sue: run.sueId, tool: "look" });
  clock = 400;
  relay.sweep();
  clock = 600;
  relay.sweep();
  assert.deepEqual(await ended, { calls: 1, why: "her brain went quiet" });
});

test("a Sue whose hands stop answering is let go at her idle limit, and the relay still closes", { timeout: 10_000 }, async () => {
  // Run 20260929-142612-0269 (board #7303): a Print button's preview never closed, three Sues' moves never
  // answered, the sweep skipped every Sue with a move in flight, and the cannon waited four days for them.
  // One click that never answers and one body that never finishes starting; neither body will close.
  const run = freshRun();
  const starting = { sueId: "sue-2-starting", sueDir: path.join(run.runDir, "sue-2-starting") };
  fs.mkdirSync(starting.sueDir, { recursive: true });
  const never = new Promise(() => {});
  const { promise: reached, resolve: reach } = Promise.withResolvers();
  const stuck = {
    tools: [{ name: "click", inputSchema: { type: "object" } }],
    call: () => (reach(), never),
    exited: never,
    close: () => never,
  };
  let clock = 0;
  const { relay, port } = await openRelay(run, {
    now: () => clock,
    arriveMs: 1_000_000,
    idleMs: 500,
    sweepMs: 60_000,
    closeMs: 20,
    startBodyImpl: ({ sueId }) => (sueId === run.sueId ? Promise.resolve(stuck) : never),
  });
  const clicked = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  const started = relay.register({ ...starting, brief: "b.md", persona: "tt-veteran" });
  const answer = post(port, { sue: run.sueId, tool: "click", args: {} }, { "x-sue-token": relay.token });
  relay.move({ sue: starting.sueId, tool: "look" });
  await reached;
  clock = 400;
  relay.sweep();
  clock = 600;
  relay.sweep();
  assert.deepEqual(await clicked, { calls: 1, why: "her hands stopped answering" });
  assert.deepEqual(await started, { calls: 0, why: "her hands stopped answering" });
  const { status, body } = await answer;
  assert.deepEqual([status, body.why], [410, "her hands stopped answering"], "her driver is told she is over, not left waiting");
  await relay.close();
});

test("a Sue registered late gets her whole wait from her own registration, not from when the relay opened", async () => {
  // A wave under a concurrency cap registers its later Sues as earlier ones finish; timed from the
  // relay's opening, a Sue registered 50 minutes in had 10 minutes to arrive (2026-09-23 review).
  const run = freshRun();
  const late = { sueId: "sue-2-late", sueDir: path.join(run.runDir, "sue-2-late") };
  fs.mkdirSync(late.sueDir, { recursive: true });
  let clock = 0;
  const { relay } = await openRelay(run, { now: () => clock, arriveMs: 1000, idleMs: 1_000_000, sweepMs: 60_000 });
  const first = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  clock = 900;
  let lateOver = false;
  const second = relay.register({ ...late, brief: "b.md", persona: "tt-veteran" }).then((r) => ((lateOver = true), r));
  clock = 1001;
  relay.sweep();
  assert.deepEqual(await first, { calls: 0, why: "no brain arrived" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lateOver, false, "the late Sue still has 899 ms of her own wait");
  clock = 1901;
  relay.sweep();
  assert.deepEqual(await second, { calls: 0, why: "no brain arrived" });
});

test("in a focus group a silent Sue is let go at the room's limit, while the moderator keeps the ordinary one", async () => {
  const run = freshRun();
  const modDir = path.join(run.runDir, "moderator");
  fs.mkdirSync(modDir, { recursive: true });
  let clock = 0;
  const { relay } = await openRelay(run, { now: () => clock, focusGroupSeats: true, sweepMs: 60_000 });
  const sue = relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  let moderatorOver = false;
  relay.register({ sueId: "moderator", sueDir: modDir, brief: "m.md", persona: "moderator" }).then(() => (moderatorOver = true));
  await relay.move({ sue: run.sueId, tool: "look" });
  await relay.move({ sue: "moderator", tool: "look" });
  clock = FOCUS_GROUP_IDLE_MS + 1;
  relay.sweep();
  assert.deepEqual(await sue, { calls: 1, why: "her brain went quiet" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(moderatorOver, false, "the moderator waits through the whole visit by design");
});

test("hand.mjs drives her through the relay end to end, and says so when the run is gone", async () => {
  const run = freshRun();
  const { relay } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  const tools = await runHand(run, [run.runId, run.sueId, "tools"]);
  assert.equal(tools.code, 0);
  assert.match(tools.out, /^click target \(number or string\), how\? \(string\)$/m);
  const click = await runHand(run, [run.runId, run.sueId, "click", "target=2", "how=hover"]);
  assert.equal(click.code, 0);
  assert.match(click.out, /clicked \{"target":2,"how":"hover"\}/);
  const json = await runHand(run, [run.runId, run.sueId, "exit_interview", '{"verdict":"fine"}']);
  assert.match(json.out, /Thank you/);
  const over = await runHand(run, [run.runId, run.sueId, "look"]);
  assert.equal(over.code, 2);
  const noRun = await runHand(run, ["no-such-run", run.sueId, "look"]);
  assert.equal(noRun.code, 2);
  assert.match(noRun.out, /no open relay/);
});

test("parseMove and render: name=value words, one JSON object, and the words a refusal carries", () => {
  assert.deepEqual(parseMove(["r", "s", "type", "target=5", "text=two words"]), {
    runId: "r",
    sueId: "s",
    tool: "type",
    args: { target: "5", text: "two words" },
    raw: true,
  });
  assert.deepEqual(parseMove(["r", "s", "exit_interview", '{"a":', "1}"]).args, { a: 1 });
  assert.throws(() => parseMove(["r", "s", "click", "3"]), /name=value/);
  assert.throws(() => parseMove(["r", "s"]), /usage/);
  assert.equal(render({ content: [{ type: "text", text: "No." }], isError: true }), "No.");
});

// 2026-09-24: a chat drives hundreds of Sues, and every shell move started bash + node and fired the
// chat's Bash hooks. The Connections MCP (already running in the chat) takes the same move as one call;
// hand.mjs stays for any AI without it. Both read one parse/render (lib/hand-move.mjs).
test("moveFromParams shapes an MCP move like a shell one, and says what is missing", () => {
  assert.deepEqual(moveFromParams({ runId: "r", sue: "s", move: "type", args: { target: 5, text: "two words" } }), {
    runId: "r",
    sueId: "s",
    tool: "type",
    args: { target: 5, text: "two words" },
    raw: true,
  });
  assert.deepEqual(moveFromParams({ runId: "r", sue: "s", move: "look" }).args, {});
  assert.deepEqual(moveFromParams({ runId: "r", sue: "s", move: "exit_interview", args: '{"a":1}' }).args, { a: 1 });
  assert.throws(() => moveFromParams({ runId: "r", move: "look" }), /sue/);
  assert.throws(() => moveFromParams({ runId: "r", sue: "s", move: "click", args: "target=3" }), /args/);
  assert.equal(handRender, render);
});

test("the brief gives an agent with the Connections MCP one call per move, and any other agent the shell", () => {
  const brief = buildChatBrief({
    systemPrompt: "You are Dana.",
    scenarioPrompt: "Find the ticket settings.",
    runId: "20260922-1",
    sueId: "sue-9-dana",
    handFile: "C:\\x\\sue\\hand.mjs",
  });
  assert.ok(
    brief.includes(
      'connections_execute { local: true, tool_name: "sue", params: { action: "move", runId: "20260922-1", sue: "sue-9-dana", move: "tools" } }',
    ),
  );
  assert.match(brief, /move: "click", args: \{ target: 3 \}/);
  assert.match(brief, /Without the Connections MCP/);
  assert.ok(brief.includes('node "C:/x/sue/hand.mjs" 20260922-1 sue-9-dana tools'));
  // A refusal and "never reached her" must not read alike, or an agent retries a refused payment.
  assert.match(brief, /error result means the move never reached her/);
});

test("the brief carries who she is, why she came, her hands by run and Sue, and how the visit ends", () => {
  const brief = buildChatBrief({
    systemPrompt: "You are Dana, who runs a Discord server.",
    scenarioPrompt: "Find the ticket settings.",
    runId: "20260922-1",
    sueId: "sue-9-dana",
    handFile: "C:\\x\\sue\\hand.mjs",
  });
  assert.ok(brief.includes("You are Dana, who runs a Discord server."));
  assert.ok(brief.includes("Find the ticket settings."));
  assert.ok(brief.includes('node "C:/x/sue/hand.mjs" 20260922-1 sue-9-dana tools'));
  assert.match(brief, /exit_interview/);
  assert.match(brief, /Do not open a browser/);
  // A chat brain once read "nothing she does saves or contacts anyone" as a rule to obey, which
  // forbade the very errands scenarios hand her (save her character, write to support). The
  // rails decide what is refused; the brief only says to accept a refusal.
  assert.doesNotMatch(brief, /Nothing she does sends, saves/);
  assert.match(brief, /never look for another way around it/);
});

test("the brief tells a driver with the move tool the picture comes with the answer, and a lone note costs a turn", () => {
  const brief = buildChatBrief({
    systemPrompt: "x",
    scenarioPrompt: "y",
    runId: "20260922-1",
    sueId: "sue-9-dana",
    handFile: "C:\\x\\hand.mjs",
  });
  assert.match(brief, /picture together, in the one answer/);
  assert.match(brief, /never need `move: "see"` after a move/);
  assert.doesNotMatch(brief, /make `move: "see"` and look/);
  assert.match(brief, /A lone `note` costs a whole turn/);
  assert.match(brief, /every time/);
  assert.match(brief, /Not connected/);
  assert.match(brief, /Connection closed/);
  assert.doesNotMatch(brief, /brings the picture inside/);
});

// A focus group on chat brains waits on every seat: a Sue whose agent never came or died holds the vote
// open until the relay lets her go. The ordinary limits (an hour to arrive, 15 minutes quiet) are longer
// than a Sue will sit at the table, so the others used to give up and go home before any verdict
// (2026-09-23 review). The room's limits must be shorter than the table's.
test("a focus group lets a no-show or silent Sue go before the others give up at the table", () => {
  assert.ok(FOCUS_GROUP_ARRIVE_MS < TABLE_MAX_MS, `arrive ${FOCUS_GROUP_ARRIVE_MS} >= table ${TABLE_MAX_MS}`);
  assert.ok(FOCUS_GROUP_IDLE_MS < TABLE_MAX_MS, `idle ${FOCUS_GROUP_IDLE_MS} >= table ${TABLE_MAX_MS}`);
});

test("a brief built from a scenario with an expect shows the line under Why you are here, and only there", () => {
  const scenarioPrompt =
    "Open the page and try to do what you came here for. Take as long as you really would. You were told this is a math quiz. If what you find is not that, say so in a note. When you have done it, or when you have had enough, stop.";
  const brief = buildChatBrief({
    systemPrompt: "You are Dana.",
    scenarioPrompt,
    runId: "20260922-1",
    sueId: "sue-9-dana",
    handFile: "C:\\x\\hand.mjs",
  });
  const at = brief.indexOf("## Why you are here");
  assert.ok(at >= 0);
  assert.equal(brief.split("You were told this is a math quiz.").length, 2, "said once in the whole brief");
  assert.ok(brief.indexOf("You were told this is a math quiz.") > at);
  const withoutScenario = brief.replace(scenarioPrompt, "");
  assert.doesNotMatch(withoutScenario, /You were told this is/);
});

test("a do's lingered and unsure ride on its move, so the body can answer the screen's question with it", async () => {
  const run = freshRun();
  process.env.FAKE_BODY_NOTE = "1";
  const { relay } = await openRelay(run);
  relay.register({ sueId: run.sueId, sueDir: run.sueDir, brief: "b.md", persona: "tt-veteran" });
  try {
    await relay.move({ sue: run.sueId, tool: "look" });
    await relay.move({ sue: run.sueId, tool: "do", args: { lingered: "Pick a plan", unsure: "none", moves: [{ move: "click", target: 3 }] } });
    await relay.move({ sue: run.sueId, tool: "do", args: { moves: [{ move: "click", target: 4 }] } });
  } finally {
    delete process.env.FAKE_BODY_NOTE;
  }
  const clicks = calls(run.sueDir).filter((c) => c.name === "click");
  assert.deepEqual(
    clicks.map(({ args: { _batch, ...rest } }) => rest),
    [{ target: 3, lingered: "Pick a plan", unsure: "none" }, { target: 4 }],
  );
});
