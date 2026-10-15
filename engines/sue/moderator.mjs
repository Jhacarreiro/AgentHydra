#!/usr/bin/env node
/**
 * moderator - the focus group moderator's hands: ONE MCP stdio server per focus group, the way
 * body.mjs is one per Sue. It never sees the website; it hears the room, asks the table, puts a
 * problem to the vote, calls everyone in, and concludes once the room agrees.
 *
 *   node sue/moderator.mjs --sue <runDir>/moderator
 *
 * The flag is `--sue` on purpose: the chat relay (lib/body-relay.mjs startBody) and the sealed CLI's
 * mcp.json start every body with it, so the moderator rides both brain tiers with no second launcher.
 * Every word it says goes through lib/room.mjs as a `moderator` line; the verdict is written once.
 *
 * Owner ask (Owner, 2026-09-23): "the AI can make suggestions to Sues, similar to the boardroom, but
 * literally imagine the AI is managing the group ... we think this is the problem. It's like, okay,
 * what do you think about this?" The caller's suggestions ride in room.json and the moderator's
 * brief (lib/room.mjs moderatorBrief) tells it to put them to the room after the room has spoken.
 *
 * Spec: tests/moderator.spec.mjs.
 */
import fs from "node:fs";
import path from "node:path";

import { isMainModule } from "../lib/shared/is-main-module.mjs";
import { createStdioMcpServer } from "./lib/mcp-stdio.mjs";
import {
  appendLine,
  conclude,
  guessesBlockConclude,
  HEARD_FILE,
  MODERATOR_ID,
  readHeard,
  readLines,
  readVerdict,
  renderRoomForModerator,
  ROOM_WAIT_MAX_SECONDS,
  tally,
  readRoster,
  waitForNews,
  writeHeard,
} from "./lib/room.mjs";

export const MODERATOR_NAME = "The moderator";
const FINISHED = "You are finished: reply with the single word finished.";

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const refusal = (value) => ({ content: [{ type: "text", text: String(value) }], isError: true });
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });

/** THE moderator's tool table, `[name, description, inputSchema]`, exported so a spec reads the one list. */
export function moderatorToolSpecs() {
  return [
    [
      "room",
      `Hear the room: where everyone is, the problems on the table and who backs each, and everything said since you last listened. wait: seconds to wait for someone to speak (at most ${ROOM_WAIT_MAX_SECONDS}).`,
      obj({ wait: { type: "number" } }),
    ],
    [
      "ask",
      "Ask the table a question or put an idea to them (\"We think the problem might be X. What do you think?\"). to: one person's name, or leave it out for everyone. guesses: true when this ask puts the builders' guesses to the room.",
      obj({ text: { type: "string" }, to: { type: "string" }, guesses: { type: "boolean" } }, ["text"]),
    ],
    ["propose", "Put a problem on the table in words the room already used, so they can vote for it by its number.", obj({ problem: { type: "string" }, why: { type: "string" } }, ["problem"])],
    ["gather", "Call everyone still on the website to the table now.", obj({ text: { type: "string" } })],
    [
      "conclude",
      "Close the room once most of them back one problem: proposal is its number on the table (or problem, the agreed words), summary is two sentences on why they agreed, lastProblemStillThere is yes, no or unclear when you were told what the last group agreed.",
      obj(
        {
          proposal: { type: "number" },
          problem: { type: "string" },
          summary: { type: "string" },
          lastProblemStillThere: { type: "string", enum: ["yes", "no", "unclear"] },
        },
        ["summary"],
      ),
    ],
  ];
}

/**
 * The handlers over one run directory, separate from the stdio server so a spec drives them
 * directly. `sleep` is injectable so `room wait=30` never waits in a test.
 */
export function createModerator({ runDir, dir, sleep }) {
  const heardFile = path.join(dir, HEARD_FILE);
  const trace = (tool, args, result) =>
    fs.appendFileSync(
      path.join(dir, "trace.jsonl"),
      `${JSON.stringify({ at: new Date().toISOString(), tool, args, result: String(result?.content?.[0]?.text ?? "").slice(0, 200), isError: Boolean(result?.isError) })}\n`,
    );
  const closedAnswer = () => {
    const verdict = readVerdict(runDir);
    return verdict ? text(`The room already agreed: "${verdict.problem}" (decided by ${verdict.decidedBy}). ${FINISHED}`) : null;
  };
  const say = (kind, words, extra = {}) => appendLine(runDir, MODERATOR_ID, { kind, name: MODERATOR_NAME, text: words, ...extra });

  const handlers = {
    async room({ wait } = {}) {
      const heard = readHeard(heardFile);
      const news = Number(wait) > 0 ? await waitForNews(runDir, { heard, listener: MODERATOR_ID, seconds: wait, sleep }) : readLines(runDir).filter((l) => l.from !== MODERATOR_ID && !heard.has(l.id));
      for (const line of news) heard.add(line.id);
      writeHeard(heardFile, heard);
      return text(renderRoomForModerator({ runDir, news }));
    },
    async ask({ text: words, to, guesses } = {}) {
      const closed = closedAnswer();
      if (closed) return closed;
      const said = String(words ?? "").trim();
      if (!said) return refusal("Say what you want to ask them.");
      say("ask", said, { ...(to ? { to: String(to).trim() } : {}), ...(guesses === true || guesses === "true" ? { guesses: true } : {}) });
      return text("Asked. Use room with wait=30 to hear their answers.");
    },
    async propose({ problem, why } = {}) {
      const closed = closedAnswer();
      if (closed) return closed;
      const words = String(problem ?? "").trim();
      if (!words) return refusal("Say the problem you are putting on the table.");
      say("propose", words, why ? { why: String(why) } : {});
      const n = tally(readLines(runDir), readRoster(runDir)).length;
      return text(`It is on the table as number ${n}. They vote for it with vote proposal=${n}.`);
    },
    async gather({ text: words } = {}) {
      const closed = closedAnswer();
      if (closed) return closed;
      say("gather", String(words ?? "").trim() || "Time is up on the website: please come to the table.");
      return text("Everyone still on the website is told to come to the table.");
    },
    async conclude({ proposal, problem, summary, lastProblemStillThere } = {}) {
      const closed = closedAnswer();
      if (closed) return closed;
      if (!String(summary ?? "").trim()) return refusal("Give a two-sentence summary of why the room agreed.");
      if ((proposal === undefined || proposal === null || proposal === "") && !String(problem ?? "").trim())
        return refusal("Name the problem the room agreed on: its number on the table (proposal) or its words (problem).");
      const held = guessesBlockConclude(runDir);
      if (held) return refusal(held);
      let outcome;
      try {
        outcome = conclude(runDir, { by: "moderator", proposal: proposal ?? null, problem: problem ?? null, summary, lastProblemStillThere });
      } catch (err) {
        return refusal(String(err?.message ?? err));
      }
      if (!outcome.verdict) return refusal("Nobody has voted for anything yet: ask them to vote first.");
      return text(`Thank you. The room agreed: "${outcome.verdict.problem}". ${FINISHED}`);
    },
  };

  const wrapped = {};
  for (const [name, run] of Object.entries(handlers)) {
    wrapped[name] = async (args = {}) => {
      let result;
      try {
        result = await run(args ?? {});
      } catch (err) {
        result = refusal(`Something went wrong in your hands (${String(err?.message ?? err).split("\n")[0]}).`);
      }
      trace(name, args, result);
      return result;
    };
  }
  return wrapped;
}

function argValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at >= 0 ? argv[at + 1] : undefined;
}

export function main(argv = process.argv.slice(2)) {
  const dir = argValue(argv, "--sue");
  if (!dir) {
    process.stderr.write("usage: node sue/moderator.mjs --sue <runDir>/moderator\n");
    process.exit(2);
  }
  const moderatorDir = path.resolve(dir);
  const runDir = path.dirname(moderatorDir);
  fs.mkdirSync(moderatorDir, { recursive: true });
  const handlers = createModerator({ runDir, dir: moderatorDir });
  const tools = moderatorToolSpecs().map(([name, description, inputSchema]) => ({ name, description, inputSchema, handler: handlers[name] }));
  const server = createStdioMcpServer({
    name: "sue",
    version: "1.0.0",
    tools,
    onClose: () => process.exit(0),
  });
  server.start();
  fs.writeFileSync(path.join(moderatorDir, "ready"), `${new Date().toISOString()}\n`, "utf8");
}

if (isMainModule(import.meta.main, import.meta.url)) main();
