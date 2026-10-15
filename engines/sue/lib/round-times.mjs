// sue/lib/round-times.mjs - how long each Sue's visit took, read from her trace. `round.mjs times` prints it and the
// SUE hunt (sue-hunt.mjs) ranks its outliers, so there is one reading.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

/** A Sue folder's trace.jsonl rows. Line by line: a Sue still moving can leave a half-written last line, which must
 *  not erase the rest. */
export const traceOf = (dir) => {
  let text;
  try {
    text = readFileSync(path.join(dir, "trace.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
};

/**
 * One row per Sue of a round: `{ who, moves: 0 }` for one who never started or never moved, else
 * `{ who, moves, firstS, endS, visitS, perMove, bodyS }` (seconds, from `t0` for firstS and endS).
 * `runs` are the round's saved runs: `{ name, runId, critic }`.
 */
export function timeRows(runs, runsDir, t0) {
  const rows = [];
  for (const r of runs.filter((x) => !x.runId)) rows.push({ who: `${r.name} (did not start)`, moves: 0 });
  for (const r of runs.filter((x) => x.runId)) {
    const dir = path.join(runsDir, r.runId);
    if (!existsSync(dir)) {
      rows.push({ who: `${r.name} (run folder gone)`, moves: 0 });
      continue;
    }
    for (const s of readdirSync(dir).filter((d) => d.startsWith("sue-"))) {
      const trace = traceOf(path.join(dir, s)).filter((t) => t.tool);
      if (!trace.length) {
        rows.push({ who: s.replace(/^sue-\d+-/, ""), moves: 0 });
        continue;
      }
      const first = Date.parse(trace[0].at);
      const lastAt = Date.parse(trace[trace.length - 1].at);
      const body = trace.reduce((a, t) => a + (t.ms || 0), 0);
      rows.push({
        who: `${s.replace(/^sue-\d+-/, "")}${r.critic ? " (critic)" : ""}`,
        moves: trace.length,
        firstS: (first - t0) / 1000,
        endS: (lastAt - t0) / 1000,
        visitS: (lastAt - first) / 1000,
        perMove: (lastAt - first) / 1000 / Math.max(1, trace.length - 1),
        bodyS: body / 1000,
      });
    }
  }
  return rows;
}
