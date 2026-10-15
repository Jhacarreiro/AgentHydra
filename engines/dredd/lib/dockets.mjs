// dredd/lib/dockets.mjs - the docket history door: find, reopen and resume past hearings (P4).
//
// `node dredd/dredd.mjs --dockets [--limit N] [--url <url>]` and the MCP door's
// `dredd { action:"dockets", limit, url? }` both read this file's `listDockets`. Every row comes from
// docket.json and hearing.json ONLY - never a log - so a listing stays cheap on a root that has held
// hundreds of hearings (the RISK: tmp/dredd grows without bound, so the reader is bounded instead of
// the directory). A hearing lost to an MCP timeout (proposal 1) or a crash (proposal 2, proposal 9) is
// findable again by this door even when its own docket path was never written down.
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

import { scoreText } from "./ballot.mjs";
import { lockAlive, readJson } from "./hearing.mjs";

/** Every `<root>/tmp/dredd/<stamp>` directory that holds a docket.json, newest first (the stamp sorts
 *  lexicographically the same as chronologically - dredd.mjs's own `stamp()`). Reads only directory
 *  names and one existence check per entry - never a docket's own files - so the sort is cheap even
 *  before `limit` narrows it. */
export function findDockets(root, { limit = 20 } = {}) {
  const dir = path.join(root, "tmp", "dredd");
  if (!existsSync(dir)) return [];
  const stamps = readdirSync(dir)
    .filter((f) => existsSync(path.join(dir, f, "docket.json")))
    .sort()
    .reverse();
  return stamps.slice(0, limit).map((stamp) => path.join(dir, stamp));
}

/** The command that moves this docket forward, or null once nothing more is owed: a live hearing needs
 *  no command (it is already moving), and a finished one is done. */
export function nextCommand(dir, state) {
  if (state === "running") return null;
  if (state === "docketed") return `node dredd/dredd.mjs --docket ${dir} --convene`;
  if (state === "convened") return `node dredd/dredd.mjs --hearing --docket ${dir}`;
  if (state === "failed" || state === "stopped" || state === "died") return `node dredd/dredd.mjs --hearing --docket ${dir}`;
  if (state === "finished") return null;
  return `node dredd/dredd.mjs --collect --docket ${dir}`;
}

/**
 * One row for one docket directory, read from docket.json and hearing.json's content ONLY - both may be
 * passed in directly (the tests' fixtures; findDockets' own callers read them off disk). `state` is
 * `docketed` (decided, never convened), `convened` (the field is out, no hearing has run), `running` (a
 * live lock), `died` (hearing.json says running but its pid is not - P9's dead record, read here rather
 * than trusted), `finished`, `failed` or `stopped`. Pure over its inputs.
 */
export function docketRow(dir, { docket, hearing } = {}) {
  const d = docket !== undefined ? docket : readJson(path.join(dir, "docket.json")) || {};
  const H = hearing !== undefined ? hearing : readJson(path.join(dir, "hearing.json"));
  const rawState = H?.state || (d.results?.length ? "convened" : "docketed");
  const state = rawState === "running" && !lockAlive(H) ? "died" : rawState;
  const notLanded = !H
    ? null
    : [!H.field?.sueDone && "SUE", !H.field?.criticDone && "the design critic"].filter(Boolean).join(", ") || null;
  return {
    dir,
    when: d.created || null,
    ask: String(d.ask || "").slice(0, 80),
    url: d.url || null,
    state,
    verdict: H?.finalVerdict ?? null,
    // false when the last sitting had fewer than two valid ballots (lib/ballot.mjs MIN_BALLOTS); null before it was kept.
    conclusive: H?.conclusive ?? null,
    happy: H?.happy ?? null,
    notLanded,
    bill: H?.bill || null,
    next: nextCommand(dir, state),
  };
}

/**
 * Every docket under root, newest first, as rows (P4's CHANGE). `url` narrows to dockets naming that
 * exact page - the caller normalizes it the same way the door does (dredd.mjs's own `normalizeUrl`);
 * this module stays a leaf and does no normalizing of its own. A url filter reads more rows than
 * `limit` before narrowing (bounded at 200), so a page with hearings scattered further back than the
 * newest `limit` dockets is still found.
 */
export function listDockets(root, { limit = 20, url = null } = {}) {
  const dirs = findDockets(root, { limit: url ? Math.max(limit, 200) : limit });
  const rows = dirs.map((dir) => docketRow(dir));
  const filtered = url ? rows.filter((r) => r.url === url) : rows;
  return filtered.slice(0, limit);
}

/**
 * A hearing already convened whose fix is meant to land: `hearing on a url whose hearing finished
 * within the last N hours` (P4's CHANGE). Notice only - the caller still runs a fresh hearing; this is
 * never a reuse the way a live lock is. Rows are assumed already filtered to one url and already sorted
 * newest first (listDockets' own contract).
 */
export function recentFinished(rows, { withinMs = 6 * 60 * 60 * 1000, now = Date.now() } = {}) {
  return rows.find((r) => r.state === "finished" && r.when && now - Date.parse(r.when) < withinMs) || null;
}

/** The one line the CLI's `--dockets` prints per row (and what a caller reading `--json` sees rendered
 *  as text with no flag). */
export function renderDocketsTable(rows) {
  if (!rows.length) return "no dockets found";
  return rows
    .map((r) => {
      const score = r.conclusive === false ? scoreText(r) : r.verdict != null ? `${r.verdict}/10` : "-";
      const happy = r.happy === true ? " happy" : r.happy === false ? " not happy" : "";
      const not = r.notLanded ? ` (not landed: ${r.notLanded})` : "";
      const next = r.next ? `  -> ${r.next}` : "";
      return `${r.when || "-"}  ${r.state.padEnd(9)}  ${score}${happy}${not}  ${r.url || "-"}  ${r.ask}${next}`;
    })
    .join("\n");
}
