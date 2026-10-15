#!/usr/bin/env node
/**
 * hand - one move of one Sue's hands, for a brain the cannon did not spawn (`--brain chat`).
 *
 *   node sue/hand.mjs <runId> <sueId> <move> [name=value ... | one JSON object]
 *
 * `tools` lists every move her body serves; anything else is sent to her body through the run's
 * relay (lib/body-relay.mjs), which holds every rail. The port and token come from the run's
 * `relay.json`, so the agent driving her never handles either.
 *
 * A refusal prints like any other answer and exits 0, because to her it is simply what happened.
 * Exit 2 means the move never reached her: no such run, the relay is closed, or her visit is over.
 *
 * The shell door, for any AI without the Connections MCP (2026-09-24). A chat that has it makes the
 * same move as one MCP call (the `sue` door's action 'move'), which starts no process at all; both
 * doors share lib/hand-move.mjs, so they parse, send and print a move one way.
 */

import { HAND_USAGE, parseMove, render, sendMove } from "./lib/hand-move.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

export { HAND_USAGE, parseMove, render };

export async function main(words = process.argv.slice(2), out = process.stdout) {
  let move;
  try {
    move = parseMove(words);
  } catch (err) {
    out.write(`${err.message}\n`);
    return 2;
  }
  const { reached, text } = await sendMove(move);
  out.write(`${text}\n`);
  return reached ? 0 : 2;
}

const invokedDirectly = isMainModule(import.meta.main, import.meta.url);
if (invokedDirectly) main().then((code) => process.exit(code));
