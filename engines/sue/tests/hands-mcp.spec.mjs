/**
 * hands-mcp.spec - hands-mcp.mjs, the driver's hands as a stdio MCP server, driven over its real stdio
 * against a stub relay (a local HTTP server standing in for the run's relay, the approach of
 * services/studio/local-mcp/sue-move.spec.ts). No browser, no real run: a temp SUE_HOME holds one relay.json.
 *
 * What a driver depends on: the tool is there, a look's answer carries the picture it names as the same
 * bytes in the same result (so there is no `see` and nothing to Read), a picture too big to carry never breaks
 * the move, a refusal is an ordinary answer, and a move that never reached her is an error result.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const HANDS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "hands-mcp.mjs");
const RUN = "20261003-000000-hand";
const TOKEN = "t".repeat(32);

let home;
let relay;
let child;
let small;
let mid;
let big;
let nextId = 1;
const relayCalls = [];
const pending = new Map();

const jpeg = (size) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(Array.from({ length: size - 4 }, (_, i) => (i * 7 + 13) % 256))]);
const seen = (file) =>
  `Looked.\n[what you see: ${file.replace(/\\/g, "/")} - Read it before her next move: the words below leave out every picture and colour on her screen]\nYou are on page 1`;

before(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-hands-mcp-"));
  small = path.join(home, "small.jpg");
  mid = path.join(home, "mid.jpg");
  big = path.join(home, "big.jpg");
  fs.writeFileSync(small, jpeg(2000));
  fs.writeFileSync(mid, jpeg(69000));
  // 76000 bytes is 101336 base64 characters, just over the 100000 default.
  fs.writeFileSync(big, jpeg(76000));

  relay = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const { sue, tool } = JSON.parse(raw);
      relayCalls.push(`${sue}:${tool}`);
      const reply = (status, body) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
      if (req.headers["x-sue-token"] !== TOKEN) return reply(403, { error: "bad token" });
      if (sue === "sue-over") return reply(409, { error: "Her visit is over (concluded)." });
      if (tool === "pay") return reply(200, { content: [{ type: "text", text: "Her hands will not pay on this visit." }], isError: true });
      // A look writes its picture into her own eyes folder and names it, the way the relay's withPictures does.
      const shoot = (from) => {
        const dir = path.join(home, "runs", RUN, sue, "eyes");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${String(fs.readdirSync(dir).length + 1).padStart(3, "0")}.jpg`);
        fs.copyFileSync(from, file);
        return seen(file);
      };
      const said = tool === "look" ? shoot(small) : tool === "biglook" ? shoot(big) : tool === "strangelook" ? seen(small) : `${tool} done`;
      reply(200, { content: [{ type: "text", text: said }] });
    });
  });
  await new Promise((resolve) => relay.listen(0, "127.0.0.1", resolve));
  fs.mkdirSync(path.join(home, "runs", RUN), { recursive: true });
  fs.writeFileSync(path.join(home, "runs", RUN, "relay.json"), JSON.stringify({ port: relay.address().port, token: TOKEN }));

  child = spawn(process.execPath, [HANDS], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, SUE_HOME: home } });
  child.stderr.resume();
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
});

after(async () => {
  child.kill();
  await new Promise((resolve) => relay.close(resolve));
  fs.rmSync(home, { recursive: true, force: true });
});

const rpc = (method, params) =>
  new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  });
const move = async (params) => (await rpc("tools/call", { name: "move", arguments: { runId: RUN, ...params } })).result;

test("the server offers one tool, move", async () => {
  const { result } = await rpc("tools/list", {});
  assert.deepEqual(
    result.tools.map((t) => t.name),
    ["move"],
  );
});

const seesOf = (runId, sue) => {
  const file = path.join(home, "runs", runId, sue, "sees.jsonl");
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line))
    : null;
};

const eyes = (sue) => path.join(home, "runs", RUN, sue, "eyes");
const putEyes = (sue, name, bytes) => {
  fs.mkdirSync(eyes(sue), { recursive: true });
  fs.writeFileSync(path.join(eyes(sue), name), bytes);
};

test("a look answers its words and her picture in ONE result: the same bytes, no `see` needed, and the gate stays open", async () => {
  const result = await move({ sue: "sue-1", move: "look" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.content.map((c) => c.type),
    ["text", "image"],
  );
  assert.equal(
    result.content[0].text,
    "Looked.\n[what you see: her screen's picture comes with this answer - look at it before her next move: the words below leave out every picture and colour on her screen]\nYou are on page 1",
  );
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.ok(Buffer.from(result.content[1].data, "base64").equals(fs.readFileSync(small)));
  // Carried with the move, it counts as seen: her next screen-changing move goes straight through.
  assert.deepEqual(
    seesOf(RUN, "sue-1").map((r) => [r.picture, r.answered]),
    [["001.jpg", "move"]],
  );
  assert.equal((await move({ sue: "sue-1", move: "click", args: { target: 2 } })).content[0].text, "click done");
});

test("a picture too big to carry leaves the move's line naming its path; one outside her eyes folder is never read", async () => {
  const bigLook = await move({ sue: "sue-bl", move: "biglook" });
  assert.deepEqual(
    bigLook.content.map((c) => c.type),
    ["text"],
  );
  assert.match(bigLook.content[0].text, /Read it before her next move/);
  const strange = await move({ sue: "sue-bl", move: "strangelook" });
  assert.deepEqual(
    strange.content.map((c) => c.type),
    ["text"],
  );
  assert.ok(strange.content[0].text.includes("small.jpg"));
});

test("`see` answers the newest picture of her own eyes folder, the same bytes, after one text line", async () => {
  putEyes("sue-1", "001.jpg", jpeg(3000));
  putEyes("sue-1", "002.jpg", fs.readFileSync(small));
  putEyes("sue-1", "010.jpg", jpeg(2500));
  putEyes("sue-1", "009.jpg", jpeg(2400));
  const result = await move({ sue: "sue-1", move: "see" });
  assert.equal(result.isError, undefined);
  assert.deepEqual(
    result.content.map((c) => c.type),
    ["text", "image"],
  );
  assert.ok(result.content[0].text.length < 200);
  assert.equal(result.content[1].mimeType, "image/jpeg");
  assert.ok(Buffer.from(result.content[1].data, "base64").equals(jpeg(2500)));
});

test("`see` for one Sue never answers another Sue's picture of the same run", async () => {
  putEyes("sue-a", "001.jpg", jpeg(2100));
  putEyes("sue-b", "001.jpg", jpeg(2200));
  const a = await move({ sue: "sue-a", move: "see" });
  const b = await move({ sue: "sue-b", move: "see" });
  assert.ok(Buffer.from(a.content[1].data, "base64").equals(jpeg(2100)));
  assert.ok(Buffer.from(b.content[1].data, "base64").equals(jpeg(2200)));
  const none = await move({ sue: "sue-c", move: "see" });
  assert.deepEqual(
    none.content.map((c) => c.type),
    ["text"],
  );
});

test("a 69,000-byte picture (the largest measured in a live round) is carried by `see` at the default limit", async () => {
  putEyes("sue-mid", "001.jpg", fs.readFileSync(mid));
  const result = await move({ sue: "sue-mid", move: "see" });
  assert.deepEqual(
    result.content.map((c) => c.type),
    ["text", "image"],
  );
  assert.ok(Buffer.from(result.content[1].data, "base64").equals(fs.readFileSync(mid)));
});

test("a picture over the limit is answered as its path for the driver to Read, `see` still works", async () => {
  putEyes("sue-big", "001.jpg", fs.readFileSync(big));
  const result = await move({ sue: "sue-big", move: "see" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content.length, 1);
  assert.ok(result.content[0].text.includes(path.join(eyes("sue-big"), "001.jpg").replace(/\\/g, "/")));
  assert.match(result.content[0].text, /Read it/);
});

test("`see` with no picture yet, an unknown run or an odd Sue is an ordinary answer, never an error", async () => {
  fs.mkdirSync(eyes("sue-blind"), { recursive: true });
  for (const params of [
    { sue: "sue-blind", move: "see" },
    { sue: "sue-nobody", move: "see" },
    { runId: "20261003-000000-gone", sue: "sue-1", move: "see" },
    { sue: "../sue-1", move: "see" },
  ]) {
    const result = await move(params);
    assert.equal(result.isError, undefined, JSON.stringify(params));
    assert.deepEqual(
      result.content.map((c) => c.type),
      ["text"],
    );
  }
});

test("every `see` is one row of her sees.jsonl (which picture, how it was answered), and never a row of her trace", async () => {
  putEyes("sue-log", "001.jpg", jpeg(2600));
  await move({ sue: "sue-log", move: "see" });
  putEyes("sue-log", "002.jpg", fs.readFileSync(big));
  await move({ sue: "sue-log", move: "see" });
  const rows = seesOf(RUN, "sue-log");
  assert.deepEqual(
    rows.map((r) => [r.picture, r.answered]),
    [
      ["001.jpg", "image"],
      ["002.jpg", "path"],
    ],
  );
  assert.ok(rows.every((r) => !Number.isNaN(Date.parse(r.at))));
  // Her trace is her moves (report.mjs counts its rows); a `see` is not one of them.
  assert.equal(fs.existsSync(path.join(home, "runs", RUN, "sue-log", "trace.jsonl")), false);
});

test("a `see` with no picture yet is recorded; one for an unknown run or an odd Sue writes nothing anywhere", async () => {
  fs.mkdirSync(eyes("sue-dark"), { recursive: true });
  await move({ sue: "sue-dark", move: "see" });
  assert.deepEqual(
    seesOf(RUN, "sue-dark").map((r) => [r.picture, r.answered]),
    [[null, "none"]],
  );
  await move({ sue: "sue-ghost", move: "see" });
  await move({ runId: "20261003-000000-lost", sue: "sue-1", move: "see" });
  await move({ sue: "../sue-1", move: "see" });
  assert.equal(fs.existsSync(path.join(home, "runs", RUN, "sue-ghost")), false);
  assert.equal(fs.existsSync(path.join(home, "runs", "20261003-000000-lost")), false);
  assert.equal(fs.existsSync(path.join(home, "runs", "sue-1", "sees.jsonl")), false);
});

test("`see` is never sent to her relay: it works for a Sue whose visit is over", async () => {
  putEyes("sue-over", "001.jpg", jpeg(2300));
  const result = await move({ sue: "sue-over", move: "see" });
  assert.equal(result.isError, undefined);
  assert.equal(result.content[1].type, "image");
});

test("a move with no picture is text alone; a refusal is an ordinary answer", async () => {
  const click = await move({ sue: "sue-1", move: "click", args: { target: 3 } });
  assert.deepEqual(click.content, [{ type: "text", text: "click done" }]);
  const refused = await move({ sue: "sue-1", move: "pay" });
  assert.equal(refused.isError, undefined);
  assert.equal(refused.content[0].text, "Her hands will not pay on this visit.");
});

test("a move that never reached her is an error result: her visit is over, or there is no run", async () => {
  const over = await move({ sue: "sue-over", move: "look" });
  assert.equal(over.isError, true);
  assert.match(over.content[0].text, /Her visit is over/);
  const gone = await move({ runId: "20261003-000000-gone", sue: "sue-1", move: "look" });
  assert.equal(gone.isError, true);
  assert.match(gone.content[0].text, /no open relay/);
});

// The `see` gate (2026-10-04): the SUE hunt found drivers made 22 `see`s over 227 moves, so a move that changes
// the screen is answered, not sent, while her eyes folder holds a picture her sees.jsonl has not recorded.
const SCREEN_MOVE_ARGS = {
  click: { target: 3 },
  type: { target: 5, text: "hi" },
  scroll: { direction: "down" },
  go_to: { url: "https://example.test/" },
  press: { key: "Enter" },
  go_back: {},
  tabs: { action: "switch" },
};
const sentTo = (sue) => relayCalls.filter((c) => c.startsWith(`${sue}:`)).map((c) => c.slice(sue.length + 1));

test("a screen-changing move on a picture she has not seen is answered with an order to `see`, never sent to her relay", async () => {
  putEyes("sue-gate", "001.jpg", jpeg(2000));
  for (const [name, args] of Object.entries(SCREEN_MOVE_ARGS)) {
    const result = await move({ sue: "sue-gate", move: name, args });
    assert.equal(result.isError, undefined, name);
    assert.deepEqual(
      result.content.map((c) => c.type),
      ["text"],
      name,
    );
    assert.match(result.content[0].text, /move: "see"/, name);
  }
  assert.deepEqual(sentTo("sue-gate"), []);
  // A refused move costs her nothing: it never reached her body, so her trace has no row.
  assert.equal(fs.existsSync(path.join(home, "runs", RUN, "sue-gate", "trace.jsonl")), false);
});

test("a `do` with a screen-changing step is refused the same way, a `do` of notes alone goes through", async () => {
  putEyes("sue-do", "001.jpg", jpeg(2000));
  const note = { move: "note", kind: "thought", text: "hm" };
  const refused = await move({ sue: "sue-do", move: "do", args: { moves: [note, { move: "click", target: 3 }] } });
  assert.match(refused.content[0].text, /move: "see"/);
  const asJson = await move({ sue: "sue-do", move: "do", args: { moves: JSON.stringify([note, { move: "scroll", direction: "down" }]) } });
  assert.match(asJson.content[0].text, /move: "see"/);
  assert.deepEqual(sentTo("sue-do"), []);
  const notesOnly = await move({ sue: "sue-do", move: "do", args: { moves: [note] } });
  assert.equal(notesOnly.content[0].text, "do done");
  assert.deepEqual(sentTo("sue-do"), ["do"]);
});

test("note, look, tools, done, exit_interview and a tabs list always go through, whatever she has not seen", async () => {
  putEyes("sue-free", "001.jpg", jpeg(2000));
  const moves = [
    ["note", { kind: "thought", text: "hm" }],
    ["look", {}],
    ["tools", {}],
    ["tabs", { action: "list" }],
    ["done", {}],
    ["exit_interview", {}],
  ];
  for (const [name, args] of moves) {
    const result = await move({ sue: "sue-free", move: name, args });
    assert.doesNotMatch(result.content[0].text, /make `?move: "see"`? first/, name);
  }
  assert.deepEqual(
    sentTo("sue-free"),
    moves.map(([name]) => name),
  );
});

test("after a `see` the same move goes through; the next new picture shuts the gate again", async () => {
  putEyes("sue-open", "001.jpg", jpeg(2000));
  assert.match((await move({ sue: "sue-open", move: "click", args: { target: 1 } })).content[0].text, /move: "see"/);
  await move({ sue: "sue-open", move: "see" });
  const through = await move({ sue: "sue-open", move: "click", args: { target: 1 } });
  assert.equal(through.content[0].text, "click done");
  putEyes("sue-open", "002.jpg", jpeg(2100));
  assert.match((await move({ sue: "sue-open", move: "type", args: { target: 1, text: "a" } })).content[0].text, /move: "see"/);
  assert.deepEqual(sentTo("sue-open"), ["click"]);
});

test("a `see` whose row could not be written still opens the gate: a disk that refuses never strands her", async () => {
  putEyes("sue-nodisk", "001.jpg", jpeg(2000));
  // her sees.jsonl is a folder, so the row's append fails the way a full or locked disk would
  fs.mkdirSync(path.join(home, "runs", RUN, "sue-nodisk", "sees.jsonl"), { recursive: true });
  const seen = await move({ sue: "sue-nodisk", move: "see" });
  assert.equal(seen.content[1]?.type, "image", "the `see` answers her picture all the same");
  assert.equal((await move({ sue: "sue-nodisk", move: "click", args: { target: 1 } })).content[0].text, "click done");
  assert.deepEqual(sentTo("sue-nodisk"), ["click"]);
});

test("a Sue with no picture yet is never held; a picture too big to carry counts as seen once `see` answered its path", async () => {
  fs.mkdirSync(eyes("sue-nopic"), { recursive: true });
  const free = await move({ sue: "sue-nopic", move: "click", args: { target: 1 } });
  assert.equal(free.content[0].text, "click done");
  putEyes("sue-bigpic", "001.jpg", fs.readFileSync(big));
  assert.match((await move({ sue: "sue-bigpic", move: "click", args: { target: 1 } })).content[0].text, /move: "see"/);
  await move({ sue: "sue-bigpic", move: "see" });
  assert.equal((await move({ sue: "sue-bigpic", move: "click", args: { target: 1 } })).content[0].text, "click done");
});

test("a bound server (the sealed launch) needs no runId or sue, fills them in, and refuses any other Sue", async () => {
  const bound = spawn(process.execPath, [HANDS], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, SUE_HOME: home, SUE_HANDS_RUN_ID: RUN, SUE_HANDS_SUE: "sue-bound" },
  });
  bound.stderr.resume();
  const waiting = new Map();
  readline.createInterface({ input: bound.stdout, crlfDelay: Infinity }).on("line", (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message.result);
  });
  let id = 0;
  const call = (method, params) =>
    new Promise((resolve) => {
      waiting.set(++id, resolve);
      bound.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  try {
    const { tools: listed } = await call("tools/list", {});
    assert.deepEqual(listed[0].inputSchema.required, ["move"]);
    const look = await call("tools/call", { name: "move", arguments: { move: "look" } });
    assert.deepEqual(
      look.content.map((c) => c.type),
      ["text", "image"],
    );
    assert.deepEqual(sentTo("sue-bound"), ["look"]);
    const other = await call("tools/call", { name: "move", arguments: { sue: "sue-1", move: "look" } });
    assert.match(other.content[0].text, /only/);
    assert.deepEqual(sentTo("sue-bound"), ["look"]);
    // No Read tool behind a bound server: a picture over the unbound limit still rides as an image, never a path.
    const heavy = await call("tools/call", { name: "move", arguments: { move: "biglook" } });
    assert.deepEqual(
      heavy.content.map((c) => c.type),
      ["text", "image"],
    );
    assert.equal(Buffer.from(heavy.content[1].data, "base64").length, 76000);
    const again = await call("tools/call", { name: "move", arguments: { move: "see" } });
    assert.equal(again.content[1]?.type, "image");
  } finally {
    bound.kill();
  }
});
