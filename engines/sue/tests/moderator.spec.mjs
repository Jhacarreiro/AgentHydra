/**
 * moderator.spec - the focus group moderator's hands (moderator.mjs): what it can do, what it is
 * refused, and that it rides the same relay a chat-driven Sue does.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { startBody } from "../lib/body-relay.mjs";
import { appendLine, openRoom, readLines, readVerdict, writeRoster } from "../lib/room.mjs";
import { createModerator, moderatorToolSpecs } from "../moderator.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MODERATOR = path.join(HERE, "..", "moderator.mjs");

const scratch = [];
const closers = [];
afterEach(async () => {
  while (closers.length) await closers.pop()();
  for (const d of scratch.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const GRANDMA = { id: "sue-1117-grandma", name: "Grandma Sue 1117", persona: "grandma" };
const TIKTOK = { id: "sue-1118-tiktok", name: "TikTok Sue 1118", persona: "tiktok" };

function freshRun({ suggestions = [] } = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "sue-mod-"));
  scratch.push(runDir);
  openRoom(runDir, { url: "https://example.test", intent: "a friend sent this; you want to know what it is", suggestions });
  writeRoster(runDir, [GRANDMA, TIKTOK]);
  const dir = path.join(runDir, "moderator");
  fs.mkdirSync(dir, { recursive: true });
  return { runDir, dir, hands: createModerator({ runDir, dir, sleep: async () => {} }) };
}

const words = (result) => result.content.map((c) => c.text).join("\n");

test("the moderator has exactly five hands and none of them touches the website", () => {
  assert.deepEqual(
    moderatorToolSpecs().map(([name]) => name),
    ["room", "ask", "propose", "gather", "conclude"],
  );
  for (const [, , schema] of moderatorToolSpecs()) assert.equal(schema.type, "object");
});

test("room tells the moderator what it has not heard, once", async () => {
  const { runDir, hands } = freshRun();
  appendLine(runDir, GRANDMA.id, { kind: "journal", name: GRANDMA.name, text: "I cannot find the price", noteKind: "confusion" });
  const first = words(await hands.room({}));
  assert.match(first, /Grandma Sue 1117 wrote in her diary \(confusion\): "I cannot find the price"/);
  assert.match(first, /Phase: they are still on the website/);
  const second = words(await hands.room({}));
  assert.match(second, /Nothing new has been said/);
});

test("ask, propose and gather speak in the moderator's voice; an empty one is refused", async () => {
  const { runDir, hands } = freshRun();
  assert.equal((await hands.ask({ text: "  " })).isError, true);
  await hands.ask({ text: "What felt off?", to: "Grandma Sue 1117" });
  const proposed = words(await hands.propose({ problem: "the price is hidden" }));
  assert.match(proposed, /on the table as number 1/);
  await hands.gather({});
  const lines = readLines(runDir);
  assert.deepEqual(
    lines.map((l) => [l.from, l.kind]),
    [
      ["moderator", "ask"],
      ["moderator", "propose"],
      ["moderator", "gather"],
    ],
  );
  assert.equal(lines[0].to, "Grandma Sue 1117");
  assert.match(lines[2].text, /come to the table/);
});

test("conclude needs a summary and a problem, refuses an empty table, and closes the room once", async () => {
  const { runDir, hands } = freshRun();
  assert.match(words(await hands.conclude({ proposal: 1 })), /summary/);
  assert.match(words(await hands.conclude({ summary: "they agreed" })), /Name the problem/);
  assert.match(words(await hands.conclude({ proposal: 1, summary: "they agreed" })), /no problem number 1/);
  const p = appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price anywhere" });
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, ref: p.id, text: "" });
  const closed = words(await hands.conclude({ proposal: 1, summary: "Both never found a price.", lastProblemStillThere: "unclear" }));
  assert.match(closed, /The room agreed: "no price anywhere"\. You are finished/);
  const verdict = readVerdict(runDir);
  assert.equal(verdict.decidedBy, "moderator");
  assert.equal(verdict.summary, "Both never found a price.");
  assert.deepEqual(verdict.agreedBy, ["Grandma Sue 1117", "TikTok Sue 1118"]);
  // After the verdict every hand says so and writes nothing.
  assert.match(words(await hands.ask({ text: "one more thing" })), /already agreed/);
  assert.equal(readLines(runDir).filter((l) => l.kind === "ask").length, 0);
});

// Runs 20260924-185310-a67e and 20260925-074931-2d5f: the room closed on the Sues' own vote before
// they answered the builders' guesses, the one part of a focus group its runner writes.
test("conclude waits until every Sue at the table has answered the builders' guesses", async () => {
  const { runDir, hands } = freshRun({ suggestions: ["we think the price is hidden"] });
  for (const s of [GRANDMA, TIKTOK]) appendLine(runDir, s.id, { kind: "left-page", name: s.name, text: "" });
  const p = appendLine(runDir, GRANDMA.id, { kind: "vote", name: GRANDMA.name, text: "no price anywhere" });
  appendLine(runDir, TIKTOK.id, { kind: "vote", name: TIKTOK.name, ref: p.id, text: "" });
  const agreed = { proposal: 1, summary: "Both never found a price." };
  assert.match(words(await hands.conclude(agreed)), /guesses=true/, "the guesses were never put");
  await hands.ask({ text: "We think the price is hidden. What do you think?", guesses: true });
  appendLine(runDir, GRANDMA.id, { kind: "say", name: GRANDMA.name, text: "Yes, that is it." });
  assert.match(words(await hands.conclude(agreed)), /TikTok Sue 1118 has not answered/);
  assert.equal(readVerdict(runDir), null, "the room is still open");
  appendLine(runDir, TIKTOK.id, { kind: "say", name: TIKTOK.name, text: "Agreed." });
  assert.match(words(await hands.conclude(agreed)), /The room agreed: "no price anywhere"/);
});

test("every move leaves a trace row", async () => {
  const { dir, hands } = freshRun();
  await hands.room({});
  await hands.ask({ text: "hello?" });
  const rows = fs
    .readFileSync(path.join(dir, "trace.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));
  assert.deepEqual(
    rows.map((r) => r.tool),
    ["room", "ask"],
  );
});

test("the moderator is a body the chat relay can start: MCP over stdio, the same --sue flag", async () => {
  const { runDir, dir } = freshRun();
  const body = await startBody({ bodyFile: MODERATOR, sueDir: dir });
  closers.push(() => body.close());
  assert.deepEqual(
    body.tools.map((t) => t.name),
    ["room", "ask", "propose", "gather", "conclude"],
  );
  const asked = await body.call("ask", { text: "What did you come here to do?" });
  assert.match(asked.content[0].text, /Asked/);
  assert.equal(readLines(runDir)[0].text, "What did you come here to do?");
});
