/**
 * activity - what one Sue is doing this moment, in the few words the page shows under her.
 * ==========================================================================================
 *
 * WHY: Owner, 2026-09-24, watching a wave in the Sue Manager: "I would love at the bottom if it said
 * like working or finished or something, but the AI is just sitting there" and "little words that are
 * like thinking, working, or something at the bottom of their chat". Her trace says what she did, only
 * after each move ends, so nothing said whether she was mid-move, waiting on her brain, or long gone.
 *
 * Her body (body.mjs `wrap`, the one door every brain's moves go through) writes `<her folder>/now.json`
 * as each move starts (`{ kind: "working", move, since }`) and ends (`{ kind: "thinking", since }`):
 * two tiny atomic writes a move, never a throw into the move. The Manager (manager.mjs `sueState`)
 * reads it through its state cache and says, with `activityOf`:
 *   finished  her visit is written up (her summary.json, whatever its outcome);
 *   stopped   her wave is over (stopped, failed, refused, its runner gone) and she has none;
 *   working   a move of hers is running, with `doing` in plain words ("Tapping", "Typing");
 *   thinking  between moves, and before her first.
 *
 * DEPENDED ON BY: body.mjs (`moveStarted`, `moveEnded`), manager.mjs (`activityOf`). Spec:
 * tests/activity.spec.mjs.
 */
import fs from "node:fs";
import path from "node:path";

export const NOW_FILE = "now.json";

/** Each move in the words the page shows under her; a move not named here is "Working". */
const DOING = {
  look: "Looking",
  click: "Tapping",
  point: "Tapping",
  type: "Typing",
  press: "Typing",
  attach: "Adding a file",
  scroll: "Scrolling",
  go_back: "Going back",
  go_forward: "Going forward",
  go_to: "Opening a page",
  reload: "Opening a page",
  tabs: "Switching tabs",
  rotate: "Turning her phone",
  wait: "Waiting",
  check_email: "Checking her email",
  open_email: "Checking her email",
  judge_email: "Checking her email",
  note: "Writing a note",
  done: "Wrapping up",
  give_up: "Wrapping up",
  exit_interview: "Answering questions",
  room: "Talking to the group",
  say: "Talking to the group",
  vote: "Talking to the group",
};

export function doingWords(move) {
  return Object.hasOwn(DOING, move) ? DOING[move] : "Working";
}

/** Written whole or not at all: the Manager polls this file while she writes it. Never throws. */
function writeNow(sueDir, value) {
  const file = path.join(sueDir, NOW_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value), "utf8");
    fs.renameSync(tmp, file);
  } catch {
    // A Manager reading it right now can make Windows refuse the rename; her next move writes it again.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // nothing left to tidy
    }
  }
}

export function moveStarted(sueDir, move, at = new Date()) {
  writeNow(sueDir, { kind: "working", move, since: at.toISOString() });
}

export function moveEnded(sueDir, at = new Date()) {
  writeNow(sueDir, { kind: "thinking", since: at.toISOString() });
}

/**
 * Her state as the page shows it (infra/shared/sue/sue-engine-client.ts `SueActivity`).
 * `now` is her now.json as read, `summary` her summary.json, `run` her wave's summary (`state`,
 * `finishedAt`) from the Manager.
 */
export function activityOf({ now = null, summary = null, run = null } = {}) {
  if (summary) return { kind: "finished", doing: null, since: stringOrNull(summary.endedAt) };
  const runOver = Boolean(run) && (run.finishedAt != null || (run.state != null && run.state !== "starting" && run.state !== "running"));
  if (runOver) return { kind: "stopped", doing: null, since: stringOrNull(run.finishedAt) };
  if (now?.kind === "working") return { kind: "working", doing: doingWords(now.move), since: stringOrNull(now.since) };
  return { kind: "thinking", doing: null, since: stringOrNull(now?.since) };
}

function stringOrNull(v) {
  return typeof v === "string" ? v : null;
}
