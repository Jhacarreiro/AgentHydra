#!/usr/bin/env node
/**
 * tape.mjs - SUE's tape: record a site's screens once, headless, so students walk the recording with no browser
 * (Lift/docs/TAPE-PANEL.md, step 1). The on-disk shape is tape/FORMAT.md.
 *
 *   node sue/tape.mjs record --url <start> --devices phone,chromebook,desktop --out <dir>
 *        [--config <module>] [--max-screens N] [--max-depth N] [--concurrency N]
 *   node sue/tape.mjs selftest [--keep <dir>]
 *   node sue/tape.mjs lint <tape> [--rules <module>] [--personas a,b] [--json]
 *   node sue/tape.mjs coverage <tape> [--round N]
 *
 * The tape fills as Sues reach it: a move the tape has no edge for, or a screen whose stamp changed, is played live by the
 * tape's recorder and saved (tape/FORMAT.md, "Read-through"; Lift/docs/TAPE-PANEL.md section 1, 2026-10-03). `record` is
 * only for the selftest and an explicit, bounded crawl; a tape is never crawled up front.
 *
 * `selftest` records SUE's fixture and the tape's own quiz fixture at all three sizes and checks every screen's
 * tape inventory, and perceive() on it for three personas, against SUE's live body on the same screen. It exits 0
 * only with zero differences.
 *
 * `lint` runs mechanical checks over every screen of a recorded tape: font size, tap targets, layout, reading
 * level. Custom site-specific checks come from --rules module (e.g. sue/tape/examples/lift-rules.mjs).
 * Exit 1 if any error-level finding. Exit 0 if only warnings or no issues.
 *
 * `coverage` folds <tape>/visits.jsonl (every Sue's arrivals, tape/visits.mjs): screens on the tape, screens visited
 * (in --round N), misses by reason, screens never visited.
 *
 * Run record/selftest through `~/.claude/tools/fairjob.cmd -Weight 3 -Run "..."`.
 */
import { existsSync } from "node:fs";
import path from "node:path";

import { loadConfig, recordTape } from "./tape/record.mjs";
import { lint } from "./tape/lint.mjs";
import { foldCoverage } from "./tape/visits.mjs";

const USAGE = `usage:
  (the tape fills as Sues reach it; record is only for the selftest and an explicit, bounded crawl)
  node sue/tape.mjs record --url <start> --devices phone,chromebook,desktop --out <dir>
       [--config <module>] [--max-screens N] [--max-depth N] [--concurrency N]
  node sue/tape.mjs selftest [--keep <dir>]
  node sue/tape.mjs lint <tape> [--rules <module>] [--personas a,b] [--json]
  node sue/tape.mjs coverage <tape> [--round N]`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) out._.push(arg);
    else out[arg.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[++i] : true;
  }
  return out;
}

const count = (value, name) => {
  if (value == null) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} wants a whole number above 0, not "${value}"`);
  return n;
};

function coverage(args) {
  const tapeDir = args._[1] ? path.resolve(args._[1]) : null;
  if (!tapeDir)
    throw new Error(`coverage needs a tape directory
${USAGE}`);
  if (!existsSync(path.join(tapeDir, "manifest.json"))) throw new Error(`not a tape (no manifest.json): ${tapeDir}`);
  const round = args.round == null ? null : count(args.round, "round");
  const c = foldCoverage(tapeDir, { round });
  console.log(`Screens on the tape: ${c.onTape.length}`);
  console.log(`Screens visited${round == null ? "" : ` in round ${round}`}: ${c.visited.length} (${c.visits} arrivals)`);
  console.log(`Misses by reason: no-edge ${c.misses["no-edge"]}, stale ${c.misses.stale}; recorded live ${c.misses.recorded ?? 0}`);
  console.log(`Screens never visited: ${c.neverVisited.length}${c.neverVisited.length ? `: ${c.neverVisited.join(", ")}` : ""}`);
}

async function record(args) {
  if (!args.out) throw new Error(`record needs --out\n${USAGE}`);
  const { config, file } = await loadConfig(args.config);
  const devices = String(args.devices ?? "phone,chromebook,desktop")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const manifest = await recordTape({
    url: args.url,
    devices,
    out: path.resolve(args.out),
    config,
    configFile: file,
    maxScreens: count(args["max-screens"], "max-screens"),
    maxDepth: count(args["max-depth"], "max-depth"),
    concurrency: count(args.concurrency, "concurrency"),
    log: (line) => console.error(line),
  });
  console.log(JSON.stringify({ out: path.resolve(args.out), stats: manifest.stats }, null, 1));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (command === "record") return record(args);
  if (command === "selftest") {
    const { selftest } = await import("./tape/selftest.mjs");
    process.exitCode = (await selftest({ keep: typeof args.keep === "string" ? path.resolve(args.keep) : null })) ? 0 : 1;
    return;
  }
  if (command === "lint") {
    const tapeDir = args._[1] ? path.resolve(args._[1]) : null;
    if (!tapeDir) throw new Error(`lint needs a tape directory\n${USAGE}`);
    process.exitCode = await lint(tapeDir, {
      rulesPath: typeof args.rules === "string" ? args.rules : null,
      personas: typeof args.personas === "string" ? args.personas : null,
      json: args.json === true,
    });
    return;
  }
  if (command === "coverage") {
    coverage(args);
    return;
  }
  console.error(USAGE);
  process.exitCode = 2;
}

main().catch((err) => {
  console.error(err?.stack ?? err);
  process.exitCode = 1;
});
