/**
 * tape/visits.mjs - the tape's visits log: `<tape>/visits.jsonl`, one row per arrival on a screen, written by every
 * Sue of a round into the ONE folder they share (tape/FORMAT.md "visits.jsonl"), and folded by `tape.mjs coverage`.
 *
 * Each row is a single `appendFileSync` of one line, so Sues running at once never interleave a row.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/** `recorded`: the move was a miss, played live by the tape's recorder and saved, and she was answered from the new screen. */
export const VISIT_HOWS = ["tape", "no-edge", "stale", "recorded"];

export const visitsPath = (tapeDir) => path.join(tapeDir, "visits.jsonl");

/** Appends one row `{ round, sueId, device, at, screen, how, runId }` (`at` is now when the row has none). */
export function appendVisit(tapeDir, row) {
  if (!VISIT_HOWS.includes(row.how)) throw new Error(`visits row: how must be one of ${VISIT_HOWS.join(", ")}, not "${row.how}"`);
  appendFileSync(visitsPath(tapeDir), `${JSON.stringify({ at: new Date().toISOString(), ...row })}\n`);
}

/** Every row of the log, in order; a line that is not JSON is an error, never skipped. */
export function readVisits(tapeDir) {
  const file = visitsPath(tapeDir);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line, i) => {
      try {
        return JSON.parse(line);
      } catch {
        throw new Error(`${file} line ${i + 1} is not JSON`);
      }
    });
}

/**
 * The log folded: the screens on the tape, the screens visited (in `round` when given), the misses by reason, and
 * the screens nobody visited. A round-less row (round null) is counted only when no round is asked for.
 */
export function foldCoverage(tapeDir, { round = null } = {}) {
  const dir = path.join(tapeDir, "screens");
  const onTape = existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.slice(0, -5))
        .sort()
    : [];
  const rows = readVisits(tapeDir).filter((r) => round == null || r.round === round);
  const visited = [...new Set(rows.map((r) => r.screen))].sort();
  const misses = { "no-edge": 0, stale: 0 };
  for (const r of rows) if (r.how !== "tape") misses[r.how] = (misses[r.how] ?? 0) + 1;
  return { round, visits: rows.length, onTape, visited, misses, neverVisited: onTape.filter((id) => !visited.includes(id)) };
}
