/**
 * retention - a finished run's pictures and brain streams go once they are older than the person chose.
 * ======================================================================================================
 *
 * Nothing in sue ever removed a run: on 2026-09-23 the owner's PC held 519 runs, about 110,000 files
 * and 9.0 GB, and he asked "who is paying to store every single result ever?". Almost all of it is
 * each Sue's screenshots (`shots/`, `eyes/`) and her brain's stream (`brain.jsonl`); what a person reads
 * later (the run's report, each Sue's summary, findings, interview, trace, and the workspace's journals
 * and scoreboard) is small and stays for good.
 *
 * The Settings tab's `keepPictures` (lib/settings.mjs) is the only switch, and it is `forever` until
 * the person picks a number of days: this deletes his data, so the choice is his. A run is touched
 * only once its manifest says it finished, and only when that was longer ago than the window; a
 * `pruned.json` beside its manifest says what went and when, so the next pass skips it.
 *
 * The panel the owner delegated to (decide-48, 2026-09-24) ruled this shape, Option 2: the window is
 * forever (the default), 7, 14, 30 or 90 days, because Sue runs on customers' computers too and a
 * default that deletes would destroy other people's data without their choice. It runs after every
 * wave as well as on the Manager's own schedule, and it never fails silently: a file it could not
 * delete comes back in `errors` (the Manager shows it in a toast, `sue run` logs it), and that run is
 * not marked pruned, so the next pass tries again. It walks only run folders under the runs root, so
 * the committed `.sue/` journals and `sue/state/` (the append-only accounts ledger among them)
 * are out of its reach; inside a run it touches nothing but the three names below - the run's mail,
 * report, findings and each Sue's `trace.jsonl` (her step log) stay. A run folder holds no Playwright
 * trace archive (nothing in sue calls `tracing.start`), so there is none to prune. The same
 * ruling left two other ideas out of this change: moving the journals out of the committed `.sue/`
 * folder, and syncing each run's report to Connections for a second computer.
 */
import fs from "node:fs";
import path from "node:path";

import { RUN_ID_PATTERN } from "./run-dir.mjs";

/** What goes, inside each Sue's folder: her pictures and her brain's stream. */
export const PRUNED_IN_SUE = Object.freeze(["shots", "eyes", "brain.jsonl"]);
export const PRUNED_FILE = "pruned.json";
const DAY_MS = 24 * 60 * 60 * 1000;
const SUE_DIR = /^sue-/;

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function sizeOf(target) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return 0;
  }
  if (!stat.isDirectory()) return stat.size;
  let total = 0;
  for (const name of fs.readdirSync(target)) total += sizeOf(path.join(target, name));
  return total;
}

/** The days a `keepPictures` setting keeps, or null for `forever` (and anything that is not a day count). */
export function keepDaysOf(keepPictures) {
  const n = Number(keepPictures);
  return Number.isInteger(n) && n > 0 ? n : null;
}

/**
 * Removes the pictures and brain streams of every run under `runsDir` that finished more than
 * `keepDays` days before `now`. Returns `{ runs, bytes, errors }`: how many runs lost them, how much
 * went, and one line per file it could not delete (never thrown). `rm` is injected by the spec.
 */
export function pruneRuns(runsDir, { keepDays, now = Date.now(), rm = fs.rmSync } = {}) {
  const out = { runs: 0, bytes: 0, errors: [] };
  if (!keepDays) return out;
  let names;
  try {
    names = fs.readdirSync(runsDir);
  } catch (err) {
    if (err?.code !== "ENOENT") out.errors.push(`${runsDir}: ${err?.message ?? err}`);
    return out;
  }
  for (const runId of names) {
    if (!RUN_ID_PATTERN.test(runId)) continue;
    const dir = path.join(runsDir, runId);
    if (fs.existsSync(path.join(dir, PRUNED_FILE))) continue;
    const finished = Date.parse(readJson(path.join(dir, "manifest.json"))?.finished ?? "");
    if (!Number.isFinite(finished) || now - finished < keepDays * DAY_MS) continue;
    let bytes = 0;
    let failed = 0;
    let sues;
    try {
      sues = fs.readdirSync(dir).filter((n) => SUE_DIR.test(n));
    } catch (err) {
      out.errors.push(`${runId}: ${err?.message ?? err}`);
      continue;
    }
    for (const sue of sues) {
      for (const name of PRUNED_IN_SUE) {
        const target = path.join(dir, sue, name);
        const size = sizeOf(target);
        if (!size && !fs.existsSync(target)) continue;
        try {
          rm(target, { recursive: true, force: true });
          bytes += size;
        } catch (err) {
          failed += 1;
          out.errors.push(`${runId}/${sue}/${name}: ${err?.message ?? err}`);
        }
      }
    }
    out.bytes += bytes;
    // A run with a file left behind is not marked, so the next pass finishes it.
    if (failed) continue;
    fs.writeFileSync(path.join(dir, PRUNED_FILE), `${JSON.stringify({ at: new Date(now).toISOString(), keepDays, bytes })}\n`);
    out.runs += 1;
  }
  return out;
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return `${Math.round(bytes / 1e8) / 10} GB`;
  return `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

/**
 * The one line a log and the Manager's toast print about a prune: what it freed, what it could not
 * delete, or null when there is nothing to say (the window is forever, or nothing was old enough).
 */
export function pruneSummary({ runs, bytes, errors }) {
  const parts = [];
  if (runs) parts.push(`freed ${formatBytes(bytes)} from ${runs} run${runs === 1 ? "" : "s"}`);
  if (errors?.length) parts.push(`could not delete ${errors.length} old run file${errors.length === 1 ? "" : "s"} (first: ${errors[0]})`);
  return parts.length ? parts.join("; ") : null;
}
