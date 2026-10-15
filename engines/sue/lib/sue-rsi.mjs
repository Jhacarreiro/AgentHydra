/**
 * SUE's recursive self-improvement: the contract the hunt (lib/sue-hunt.mjs) and the A/B (ab.mjs) share.
 *
 * Owner, 2026-10-04: "RRSI, or RSI, whichever you want to call it, needs to always be implemented during sue, dread,
 * et cetera." The model is Dredd's loop (.claude/rules/dredd-self-improvement.md): every round is also a run on SUE.
 * The hunt ranks SUE's own faults from the rounds on disk; a change to a decision file below is measured old vs new
 * over the same build and people (ab.mjs) and the measurement is a row in the ledger, which the hunt reads back.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { checkoutRoot } from "./engine-lease.mjs";

/**
 * The files that change what every Sue perceives, is told, can do or is scored on. A change to one owes an A/B row.
 * The driver agent (claude-memory home/agents/sue-driver.md) lives outside this repo: each visit's `reuse.json`
 * carries its hash as `parts.driver`, so a driver change shows as a new driver hash on the same build.
 */
export const SUE_DECISION_PATHS = [
  "sue/body.mjs",
  "sue/lib/perception.mjs",
  "sue/lib/looks.mjs",
  "sue/lib/workspace.mjs",
  "sue/hands-mcp.mjs",
  "sue/lib/hand-move.mjs",
  "sue/lib/focus-hands.mjs",
  "sue/lib/rounds.mjs",
  // It writes the sealed system prompt and the chat brief every chat-brain Sue reads (buildSealedSystem, buildChatBrief).
  "sue/lib/body-relay.mjs",
];

/** A decision change landed before this owes no row: the policy's first day. */
export const SUE_AB_POLICY_SINCE = "2026-10-04T00:00:00Z";

/**
 * One JSON row per measured or thrown-away SUE change, appended by `ab.mjs --record` / `--reject`:
 *   { at, kind: "measured" | "rejected", base: { engine, driver, hands }, head: { engine, driver, hands },
 *     commits: [decision commit shas it covers], builds, series, visits: { base, head }, rounds: { base, head },
 *     diverged: [{ who, kind: "changed" | "unstable", side?, variants? }],
 *     metrics: { <name>: { base, head, estimate, low, high, people, deadZone, verdict } },
 *     verdict, resolved, another: { round, arm, why }, stat, accept?, note? }
 * `verdict` is "better", "worse", "same" or "unresolved" (lib/sue-ab.mjs compareArms); a metric's is one of those, or
 * "unread" (read over fewer than two people, its numbers null) or "shown" (characters, typed). Rows before 2026-10-07 stay as
 * written: their verdict is "improvement", "neutral", "regression", "within noise" or "no band", with
 * `metrics[m].diff/delta` from the old noise band. The hunt reads only `commits`, `base` and `head`, so both read.
 * It is the checkout's record, named through checkoutRoot() so no snapshot carries it: as a file beside the code it was
 * part of the engine's id, and each row recorded made the next round a new engine and a new A/B arm (2026-10-04).
 */
export const SUE_AB_LEDGER = path.join(checkoutRoot(), "sue", "eval", "ab-ledger.jsonl");

/**
 * Whether `ab.mjs --record` may write a measured row. An unresolved read whose stop line still owes a round decides
 * nothing yet (it was "no band" before 2026-10-07), so it is refused until that round has run; at the round budget it
 * records as unresolved, and every resolved read records. A `--reject` row is written whatever the read.
 */
export function noBandGate(report) {
  if (report?.verdict !== "unresolved" || !report.another?.round) return { ok: true };
  return {
    ok: false,
    why: `not recorded: an unresolved read decides nothing until each arm has its two same-arm rounds and the stop line is satisfied (${report.another.why}); run the round of the ${report.another.arm} arm, then record`,
  };
}

/** The ledger's rows, oldest first; a missing file or a torn line reads as nothing. */
export function readSueLedger(file = SUE_AB_LEDGER) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* a torn last line from a crashed append: the rows before it stand */
    }
  }
  return rows;
}
