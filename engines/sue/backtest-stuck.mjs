#!/usr/bin/env node
// Backtest the stall alarm on the real series in <workspace>/.sue/rounds/ (default D:/NEWProjects).
// Usage: node sue/backtest-stuck.mjs [workspace]
// For each series it replays the rounds one at a time through trend() and prints the round the alarm first fires on.
import { readdirSync } from "node:fs";
import path from "node:path";

import { isMainModule } from "../lib/shared/is-main-module.mjs";
import { DEFAULT_TARGET, readRounds, trend } from "./lib/rounds.mjs";

// Only when run: the engine's closure check imports every module, and a backtest that ran on import printed into it.
if (isMainModule(import.meta.main, import.meta.url)) backtest(process.argv[2] || "D:/NEWProjects");

function backtest(workspace) {
  const dir = path.join(workspace, ".sue", "rounds");
  const series = readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => f.slice(0, -".jsonl".length));
  for (const key of series) report(workspace, key);
}

function report(workspace, key) {
  const rows = readRounds(workspace, key);
  let fired = null;
  for (let i = 1; i <= rows.length && !fired; i += 1) {
    const t = trend(rows.slice(0, i), DEFAULT_TARGET);
    if (t.state === "stuck") fired = { round: rows[i - 1].round, t };
  }
  if (fired) {
    console.log(
      `${key}: ${rows.length} rounds; STUCK first fires at round ${fired.round} (${rows.length - fired.round} rounds after it); ${fired.t.roundsSinceBest} rounds since the best (best ${fired.t.best} stars, target ${DEFAULT_TARGET.stars})`,
    );
  } else {
    console.log(`${key}: ${rows.length} rounds; stuck never fires`);
  }
}
