#!/usr/bin/env node
/**
 * hands-mcp - one driver's hands as a stdio MCP server: a single tool, `move`.
 *
 * The driver of a chat-brain Sue (the `sue-driver` agent) has Read, Write and Bash and not the
 * Connections MCP, so every move was a Bash call (`node hand.mjs ...`) and every picture a second
 * call (Read). Measured 2026-10-03 (round 4, 14 drivers at once): ~11 s a Bash move, ~5 s a Read,
 * against ~0.25 s for an MCP call. This server gives the driver the Connections MCP's `sue` move as
 * its own tool, `mcp__sue-hands__move`, and answers the picture through its own move, `see`.
 *
 * Params are the Connections MCP's `sue` move, `{ runId, sue, move, args }`, and it goes through the
 * same lib/hand-move.mjs (moveFromParams + sendMove) as hand.mjs and that door, so a Sue cannot tell
 * which one moved her. sendMove itself hands a live run on another engine snapshot to that
 * snapshot's own copy of hand-move.mjs, so a newer checkout never speaks to an older run's relay in
 * a new way. A refusal is an ordinary answer; a move that never reached her is an error result.
 *
 * The picture rides with the move again (Owner, 2026-10-05). History: the first version of this door attached
 * the picture to the move's answer; measured 2026-10-03 on Lift's class unit (old door vs that one, three rounds
 * each) the drivers wrote fewer notes (11.0 vs 9.8 a student) and raised fewer problems (1.5 vs 1.0), because
 * they lost the separate turn in which they looked before writing; so the picture moved to its own move, `see`,
 * and a gate refused a screen-changing move until it was made (2026-10-04). That doubled the requests: one visit
 * of run 20261005-194035-d16a made 98 Opus requests, every screen two of them (a move, then `see` or a Read).
 * Now a move whose answer names a look file (`[what you see: <path> - Read it ...]`, written by
 * lib/body-relay.mjs withPictures) answers its words AND that picture, byte for byte, in one result, and the
 * look-before-writing turn is kept by the brief instead: a screen's notes ride in the `do` that makes her next
 * move, written after she has seen the picture this answer carried.
 *
 * - The picture is the one the answer names, read only from HER OWN eyes folder (runs/<runId>/<sue>/eyes/),
 *   never resized or re-encoded (its size encodes her eyesight). Past the limit (default 100000 base64
 *   characters, SUE_HANDS_MAX_IMAGE_B64) the line keeps naming the path for the driver to Read instead; a BOUND
 *   server (sealed Sue, no Read) has no limit.
 * - Each carried picture is one row of her sees.jsonl (answered `move`), the same as a `see`, so the gate below
 *   stays open and the SUE hunt still tells a driver who was shown her screen from one who was not.
 * - `see` still works and costs nothing: it is answered here and never sent to her relay, changes nothing and
 *   costs her no time on SUE's clock. It answers the newest picture in her eyes folder from the folder alone
 *   (Claude Code restarts a shared stdio server when any of its subagents ends, so a `see` after a restart still
 *   works). No picture yet or an unknown run or Sue is an ordinary answer, not an error (an error result means
 *   her visit is over).
 *
 * The gate (2026-10-04, the SUE hunt: in run 20261003-205818-39b9 drivers made 22 `see`s over 227 moves, one made
 * 29 moves and never one): a move that changes the screen (lib/move-batch.mjs changesScreen: click, type, scroll,
 * go_to..., and a `do` holding one) is answered here, not sent to her relay, while her eyes folder holds a picture
 * newer than the newest one her sees.jsonl names. With the picture riding on the move it fires only when a picture
 * never reached this door's driver (another door made the move, or the picture was too big to carry). `note`,
 * `look`, `tools`, `done`, `exit_interview` and `see` always go through, and a Sue with no picture yet is never
 * held. Both files are read each time, so a restarted server gates the same; the one thing held in memory is the
 * newest picture each answer carried, so a sees.jsonl row the disk refused to write never shuts her out of her
 * next move (the background review, 2026-10-04).
 *
 * A BOUND server (the sealed launch, lib/body-relay.mjs buildSealedSystem; SUE_HANDS_RUN_ID and SUE_HANDS_SUE in
 * its env) moves one Sue only: runId and sue may be left out and are filled in, and any other run or Sue is
 * refused as an ordinary answer.
 *
 * Why not Read: a Read of a picture is 4.66 s median plus a 1.9 s turn; an MCP call 1.43 s (2026-10-03).
 */

import fs from "node:fs";
import path from "node:path";

import { moveFromParams, sendMove } from "./lib/hand-move.mjs";
import { changesScreen } from "./lib/move-batch.mjs";
import { createStdioMcpServer } from "./lib/mcp-stdio.mjs";
import { runDir } from "./lib/run-dir.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

// 100000 base64 characters carry 75,000 bytes: above the largest look file measured (69 KB, round 4,
// 2026-10-03; 48 of 101 were over 45 KB). SUE_HANDS_MAX_IMAGE_B64 overrides it (a positive integer).
export const DEFAULT_MAX_IMAGE_BASE64 = 100000;

// A BOUND (sealed) Sue's driver has no Read tool, so a path is blindness: it carries every picture whatever its
// size (run 20261006-222433-74fc: 28 of 41 looks answered a path, all 12 Sues clicked blind). Only an explicit
// SUE_HANDS_MAX_IMAGE_B64 caps it.
const maxImageBase64 = () => {
  const set = Number(process.env.SUE_HANDS_MAX_IMAGE_B64);
  if (Number.isInteger(set) && set > 0) return set;
  return boundTo() ? Infinity : DEFAULT_MAX_IMAGE_BASE64;
};

const PATH_OF = /\[what you see: (.+?) - Read it before her next move: /g;
const CARRIED_LINE = "[what you see: her screen's picture comes with this answer - look at it before her next move: ";
const MIME = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const said = (text) => ({ content: [{ type: "text", text }] });

// The newest picture number each `see` answered in this process, by "<runId>/<sue>": the gate's fallback when her
// sees.jsonl row could not be written. Lost on a restart, when sees.jsonl answers alone.
const seenHere = new Map();

const plainIds = (runId, sue) => PLAIN_NAME.test(runId) && PLAIN_NAME.test(sue) && !runId.includes("..") && !sue.includes("..");

/** Her newest picture's file: the highest-numbered file in her eyes folder (names are 001.jpg, 002.jpg ...), or null. */
function newestEyes(runId, sue) {
  if (!plainIds(runId, sue)) return null;
  const dir = path.join(runDir(runId), sue, "eyes");
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const numbered = names
    .filter((name) => MIME[path.extname(name).toLowerCase()])
    .map((name) => ({ name, n: Number.parseInt(name, 10) }))
    .filter((f) => Number.isInteger(f.n))
    .sort((a, b) => b.n - a.n);
  return numbered.length ? path.join(dir, numbered[0].name) : null;
}

/**
 * One row of her sees.jsonl for each `see` (runs/<runId>/<sue>/sees.jsonl): when, which picture, and how it was
 * answered (image, path, none, unreadable). Not her trace.jsonl, which is her moves (report.mjs counts its rows,
 * and a `see` is not a move of hers), so the SUE hunt can tell a driver who looked from one who moved on words
 * alone. Written only into a Sue folder that already exists, and a failed write never fails the `see`.
 */
function recordSee(runId, sue, file, answered) {
  if (!PLAIN_NAME.test(runId) || !PLAIN_NAME.test(sue) || runId.includes("..") || sue.includes("..")) return;
  const dir = path.join(runDir(runId), sue);
  try {
    if (!fs.statSync(dir).isDirectory()) return;
    const row = { at: new Date().toISOString(), picture: file ? path.basename(file) : null, answered };
    fs.appendFileSync(path.join(dir, "sees.jsonl"), `${JSON.stringify(row)}\n`);
  } catch {
    // no folder for her (an unknown run or Sue), or the disk refused: the `see` answers all the same
  }
}

function noteSeen(runId, sue, file) {
  const number = Number.parseInt(path.basename(file), 10);
  if (Number.isInteger(number)) seenHere.set(`${runId}/${sue}`, Math.max(number, seenHere.get(`${runId}/${sue}`) ?? 0));
}

/** One picture file as `{ image }` (an MCP image block), `{ tooBig }` past the limit, or `{ unreadable }`. */
function pictureOf(file) {
  let bytes;
  try {
    bytes = fs.readFileSync(file);
  } catch {
    return { unreadable: true };
  }
  if (Math.ceil(bytes.length / 3) * 4 > maxImageBase64()) return { tooBig: true };
  return { image: { type: "image", data: bytes.toString("base64"), mimeType: MIME[path.extname(file).toLowerCase()] } };
}

/**
 * `see`: her newest picture as an image block. Answered here, never sent to her relay (it changes nothing
 * and costs her no time), and from the folder alone so a restarted server answers it the same.
 */
export async function see(params) {
  const runId = String(params.runId ?? "");
  const sue = String(params.sue ?? "");
  const file = newestEyes(runId, sue);
  if (!file) {
    recordSee(runId, sue, null, "none");
    return said("She has no picture yet: nothing to see. Carry on with her next move.");
  }
  noteSeen(runId, sue, file);
  const picture = pictureOf(file);
  if (picture.unreadable) {
    recordSee(runId, sue, file, "unreadable");
    return said('Her latest picture could not be opened just now: make `move: "see"` once more, or carry on with her next move.');
  }
  if (picture.tooBig) {
    recordSee(runId, sue, file, "path");
    return said(`Her picture is too big to carry here: Read it at ${file.replace(/\\/g, "/")} before her next move.`);
  }
  recordSee(runId, sue, file, "image");
  return { content: [{ type: "text", text: "What she sees now (her screen as a picture):" }, picture.image] };
}

/**
 * A move's answer with the picture it names carried in the same result: the line naming the file says the
 * picture comes with the answer, and the picture follows the words. Only a file in her own eyes folder is
 * read; an answer naming more than one (a move whose own result and the look after it both took one) carries
 * the last, her screen now. A picture that cannot be carried leaves its line naming the path to Read.
 */
function withPicture(runId, sue, text) {
  const named = [...text.matchAll(PATH_OF)].map((m) => m[1]);
  if (!named.length || !plainIds(runId, sue)) return said(text);
  const file = path.resolve(named.at(-1));
  const eyes = path.resolve(runDir(runId), sue, "eyes");
  if (path.relative(eyes, path.dirname(file)) !== "") return said(text);
  noteSeen(runId, sue, file);
  const picture = pictureOf(file);
  if (!picture.image) {
    recordSee(runId, sue, file, picture.tooBig ? "path" : "unreadable");
    return said(text);
  }
  recordSee(runId, sue, file, "move");
  return { content: [{ type: "text", text: text.replace(PATH_OF, CARRIED_LINE) }, picture.image] };
}

/** The number of the newest picture her sees.jsonl names (any answer: image, path, unreadable), or 0. */
function lastSeenNumber(runId, sue) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(runDir(runId), sue, "sees.jsonl"), "utf8");
  } catch {
    return 0;
  }
  let last = 0;
  for (const line of raw.split("\n")) {
    try {
      const n = Number.parseInt(JSON.parse(line)?.picture, 10);
      if (Number.isInteger(n) && n > last) last = n;
    } catch {
      // a torn or blank line names no picture
    }
  }
  return last;
}

/** Does this move (a `do` by its steps) change her screen? */
function screenMove(params) {
  let args = params.args;
  if (typeof args === "string") {
    try {
      args = JSON.parse(args);
    } catch {
      return false;
    }
  }
  if (params.move !== "do") return changesScreen(String(params.move), args);
  let steps = args?.moves;
  if (typeof steps === "string") {
    try {
      steps = JSON.parse(steps);
    } catch {
      return false;
    }
  }
  return Array.isArray(steps) && steps.some((step) => step && changesScreen(String(step.move ?? step.tool), step));
}

/** The order to `see` when she has a picture her driver has not looked at and this move would change her screen; else null. */
function unseenOrder(params) {
  const runId = String(params.runId ?? "");
  const sue = String(params.sue ?? "");
  if (!plainIds(runId, sue) || !screenMove(params)) return null;
  const newest = newestEyes(runId, sue);
  const seen = Math.max(lastSeenNumber(runId, sue), seenHere.get(`${runId}/${sue}`) ?? 0);
  if (!newest || Number.parseInt(path.basename(newest), 10) <= seen) return null;
  return 'Not sent: you have not seen her screen yet. Make `move: "see"` first (same runId and sue, no args; it changes nothing and costs her no time), look at the picture, then make this move again.';
}

/** The run and Sue a bound server moves (the sealed launch), or null for an unbound one. */
function boundTo() {
  const runId = process.env.SUE_HANDS_RUN_ID;
  const sue = process.env.SUE_HANDS_SUE;
  return runId && sue ? { runId, sue } : null;
}

export async function move(given) {
  const bound = boundTo();
  const params = bound ? { ...given, runId: given?.runId ?? bound.runId, sue: given?.sue ?? bound.sue } : given;
  if (bound && (params.runId !== bound.runId || params.sue !== bound.sue))
    return said(`These hands move ${bound.sue} of run ${bound.runId} only: leave runId and sue out.`);
  if (params?.move === "see") return see(params);
  const order = unseenOrder(params ?? {});
  if (order) return said(order);
  const { reached, text } = await sendMove(moveFromParams(params));
  // Never reached her: thrown, so the stdio server answers it as an error result.
  if (!reached) throw new Error(text);
  return withPicture(String(params.runId), String(params.sue), text);
}

export const tools = [
  {
    name: "move",
    description:
      "One move of one Sue's hands. runId and sue (her id) come from her brief; move is one of her hands' moves ('tools' lists every one and what it takes): look, click, type, scroll, note, do, done, exit_interview, or `see`. A move that shows the page answers its words and her screen's picture together: look at the picture before you decide her next move, every time (`see` answers it again, changes nothing and costs her no time; never needed after a move). A lone `note` costs a whole turn: put a screen's notes in the `do` that makes her next move. A refused move is an ordinary answer; an error from this server means her visit is over, but a client error `Not connected` or `Connection closed` is the connection resetting: look once, then carry on.",
    inputSchema: {
      type: "object",
      properties: {
        runId: { type: "string", description: "Which run (named in her brief)." },
        sue: { type: "string", description: "Her id, e.g. sue-1117-dana (named in her brief)." },
        move: { type: "string", description: "The move: look, click, type, scroll, note, do, done, exit_interview, see, tools..." },
        args: {
          type: "object",
          description: "The move's own values, e.g. { target: 3 } or { target: 5, text: 'hello there' }. Omit for a move that takes none.",
        },
      },
      // A bound server fills both in, so a sealed driver never spends tokens repeating them.
      required: boundTo() ? ["move"] : ["runId", "sue", "move"],
    },
    handler: move,
  },
];

if (isMainModule(import.meta.main, import.meta.url)) {
  createStdioMcpServer({ name: "sue-hands", version: "1.0.0", tools, onClose: () => process.exit(0) }).start();
}
