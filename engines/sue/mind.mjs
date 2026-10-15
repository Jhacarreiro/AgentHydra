#!/usr/bin/env node
/**
 * mind.mjs - a critic's mind, sent up to Connections or brought down from it.
 * ============================================================================
 *
 * WHAT: `node sue/mind.mjs push <personaId> <file.md>` saves the markdown as that Sue person's mind in
 * Connections (her Boardroom row's playbook), and `node sue/mind.mjs pull <personaId> <out.md>` brings it back
 * down into `out.md` to edit. No copy is kept anywhere else: a run fetches the mind with its people when it starts
 * (lib/people.mjs). `--workspace <folder>` names the folder whose people she is (default: the current one). It
 * prints one status line, never the mind.
 *
 * WHY: Owner, 2026-09-28, asked why the two critics' minds (150 KB and 143 KB of markdown) lived in the GitHub repo.
 * A mind is what the person knows, so it lives with the person, in Connections: the critic is a workspace Sue person
 * and her mind is that row's playbook. A run only ever brings minds down, so this is the one way a mind goes up, and
 * editing one is: pull, edit, push.
 *
 * THE DOOR: the Boardroom, as this machine's signed-in account, through the Connections local MCP
 * (dredd/lib/mcp.mjs `openLocalMcp`, then `api("boardroom", ...)`, the call Dredd's boardroom already makes).
 * `pushMind` and `pullMind` take the door as an argument, `door(tool, body)` answering `{ ok, status, body, text }`.
 */
import { targetRoot } from "../lib/target.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isMainModule } from "../lib/shared/is-main-module.mjs";
import { openLocalMcp } from "../dredd/lib/mcp.mjs";
import { fetchPeopleList } from "./lib/people.mjs";
import { MIND_MAX_BYTES } from "./lib/personas.mjs";
import { workspaceRoot } from "./lib/workspace.mjs";

/** The Connections checkout this engine lives in: its local MCP loader serves a workspace in any other folder too. */
const CHECKOUT = targetRoot();
const PERSON_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function wordsOf(answer) {
  const body = answer?.body;
  if (body?.error) return `${body.error}${body.message ? `: ${body.message}` : ""}`;
  if (answer?.truncated) return "the answer was cut off by the MCP's answer cap";
  return String(answer?.text || "no answer").slice(0, 300);
}

/**
 * The most a mind's JSON-escaped text may run: the mind door answers it inside `{ sueId, mind, chars, updatedAt }`,
 * and the MCP cuts any answer past 200,000 characters (dredd/lib/mcp.mjs then gives `truncated: true` and no
 * body), so a mind under MIND_MAX_BYTES but heavy in quotes and newlines could go up and never come back down.
 */
export const MIND_MAX_ANSWER_CHARS = 190_000;

/** Characters as Postgres `char_length` counts them (code points), the unit the Boardroom's `mindChars` is in. */
const codePoints = (text) => [...text].length;

/**
 * Save `file` as person `id`'s mind. Her doc is read from Connections first, so the mind rides on the copy that is
 * there and no edit made in Studio or on another computer is rolled back. Then her doc and the mind go up stamped now,
 * and the push counts as done only when Connections answers her copy holding exactly that many characters: a copy
 * that lost newer-wins answers ok with the old mind. Refuses an empty file, one over MIND_MAX_BYTES or
 * MIND_MAX_ANSWER_CHARS, and a person this folder's workspace does not have. Returns { id, chars }.
 */
export async function pushMind({ id, file, door, now = new Date() }) {
  if (!PERSON_ID.test(String(id ?? ""))) throw new Error(`"${id}" is not a person id (a short slug like retention-doctor)`);
  const mindText = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  if (!mindText.trim()) throw new Error(`${file} is empty: a mind is the markdown she is handed whole`);
  const bytes = Buffer.byteLength(mindText, "utf8");
  if (bytes > MIND_MAX_BYTES) throw new Error(`${file} is ${bytes} bytes, over ${MIND_MAX_BYTES}: cut it, she carries it whole`);
  const escaped = JSON.stringify(mindText).length;
  if (escaped > MIND_MAX_ANSWER_CHARS)
    throw new Error(
      `${file} runs ${escaped} characters once escaped, over ${MIND_MAX_ANSWER_CHARS}: it could go up but never come back down`,
    );
  // Her doc as Connections holds it, so the mind rides on the copy that is there and nothing else about her changes.
  const own = (await fetchPeopleList(door)).find((p) => p?.builtIn !== true && p?.doc?.id === id);
  if (!own) throw new Error(`this folder's workspace in Connections has no person "${id}": a mind belongs to a Sue person`);
  const updatedAt = now.toISOString();
  // The mind rides inside her doc (boardroom-contract.ts SuePersonaFileDoc.mindText): one beside it is never read.
  const answer = await door("boardroom_personas_sue_save", { personas: [{ doc: { ...own.doc, mindText }, updatedAt }] });
  if (!answer?.ok) throw new Error(`the Boardroom did not save her mind: ${wordsOf(answer)}`);
  const refused = (Array.isArray(answer.body?.refused) ? answer.body.refused : []).find((r) => r?.id === id);
  if (refused) throw new Error(`the Boardroom refused ${id}: ${refused.why}`);
  const chars = codePoints(mindText);
  const saved = (Array.isArray(answer.body?.personas) ? answer.body.personas : []).find((p) => p?.doc?.id === id);
  if (saved?.mindChars !== chars)
    throw new Error(
      `Connections kept a newer copy of ${id}, so her mind did not land (it holds ${saved?.mindChars ?? "no"} characters, this file ${chars}): check this computer's clock and push again`,
    );
  return { id, chars };
}

/** Bring person `id`'s mind down from Connections into `out`, to edit and push back. An empty mind is refused. Returns { id, chars, out }. */
export async function pullMind({ id, out, door }) {
  if (!out) throw new Error("pull writes her mind to a file you name: node sue/mind.mjs pull <personaId> <out.md>");
  if (!PERSON_ID.test(String(id ?? ""))) throw new Error(`"${id}" is not a person id (a short slug like retention-doctor)`);
  const answer = await door("boardroom_personas_sue_mind", { sueId: id });
  if (answer?.status === 404) throw new Error(`Connections has no Sue person "${id}" in this folder's workspace`);
  const mind = answer?.ok && typeof answer.body?.mind === "string" ? answer.body.mind : null;
  if (mind === null) throw new Error(`the Boardroom did not answer with ${id}'s mind: ${wordsOf(answer)}`);
  if (!mind.trim()) throw new Error(`Connections holds no mind for ${id}`);
  fs.writeFileSync(out, mind, "utf8");
  return { id, chars: codePoints(mind), out };
}

const USAGE = "usage: node sue/mind.mjs push <personaId> <file.md> | pull <personaId> <out.md>  [--workspace <folder>]";

async function main(argv) {
  const args = [...argv];
  const at = args.indexOf("--workspace");
  const ws = workspaceRoot(at >= 0 ? args.splice(at, 2)[1] : undefined);
  const [verb, id, file] = args;
  if (!["push", "pull"].includes(verb) || !id || !file) {
    process.stderr.write(`${USAGE}\n`);
    return 2;
  }
  let mcp;
  try {
    mcp = await openLocalMcp({ root: ws, loaderRoot: CHECKOUT, clientName: "sue-mind" });
  } catch (err) {
    process.stderr.write(`mind ${verb}: the Connections local MCP would not start: ${err?.message ?? err}\n`);
    return 1;
  }
  const door = (tool, body) => mcp.api("boardroom", tool, body);
  try {
    if (verb === "push") {
      const done = await pushMind({ id, file: path.resolve(file), door });
      process.stdout.write(`pushed ${done.id}'s mind to Connections: ${done.chars} characters\n`);
    } else {
      const done = await pullMind({ id, out: path.resolve(file), door });
      process.stdout.write(`pulled ${done.id}'s mind from Connections: ${done.chars} characters, written to ${done.out}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`mind ${verb}: ${err?.message ?? err}\n`);
    return 1;
  } finally {
    await mcp.close();
  }
}

if (isMainModule(import.meta.main, import.meta.url)) process.exitCode = await main(process.argv.slice(2));
