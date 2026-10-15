// dredd/lib/lane-record.mjs - every docket and every rating of one, recorded in the Connections scoring lane.
//
// Owner, 2026-09-23: "every single call with Dredd tracked and analyzed". The lane already scores the prompts that
// are injected into a chat, keyed `<workspace>|<kind>|<event>|<name>` (services/notes/lambda/src/
// agent-lane-scoring-injection.ts), with a `run` event for each use and a `score` event for each chat's rating. A
// Dredd instrument is the same kind of thing - something handed to a chat that the chat can judge afterwards - so each
// one is its own row there, `<connections workspace>|dredd|docket|<instrument id>`, plus one row for the docket as a
// whole, `...|dredd|docket|the docket`. That is ~30 rows for the whole bench, not one per docket: the lane-state cache
// every prompt hook reads stays small, Studio lists the bench beside the hooks, and an instrument the chats keep
// rating badly is quoted to the next chats of the workspace by the lane's own rule, exactly as a bad hook is.
//
// HOW IT SHIPS. Appended to ~/.connections/lane/outbox.jsonl, the file the lane's own Stop hook writes to, which the
// Connections MCP flushes on its pulse (flushLaneOutbox). No socket and no MCP spawn, so the prompt hook's docket can
// be recorded inside its 7.5 s budget. Ids are client uuids; the plane stores a flushed line once.
//
// WHAT IT CARRIES. The decision, never the ask: class, domain, scope, who decided, what was convened with its p, the
// tier. The ask can be private dictation; it stays in docket.json on the machine that ran it.
//
// A per-chat run count REPLACES on the plane (a reflection re-reads the same transcript), so the number sent is this
// session's running total, kept in ~/.connections/lane/dredd/<session>.json - which is also how the lane's Stop hook
// finds the dockets this chat received, to ask for their rating.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { instrumentScore } from "./verdict.mjs";

export const DOCKET_ROW = "the docket";

/** The lane's directory on this machine, or null when this machine has no Connections lane. */
export function laneDir({ env = process.env } = {}) {
  const dir = env.CONNECTIONS_LANE_DIR || path.join(os.homedir(), ".connections", "lane");
  return existsSync(dir) ? dir : null;
}

/** Why nothing is recorded, or null when it is. A test run (node --test sets NODE_TEST_CONTEXT in every process it
 *  starts, and a spawned dredd.mjs inherits it) records only into a lane the test named: door.spec and its siblings
 *  file real dockets, and they must never land in the owner's lane as runs. */
function notRecorded(env) {
  if (env.DREDD_NO_RECORD === "1") return "not recorded: DREDD_NO_RECORD";
  // node --test sets NODE_TEST_CONTEXT in what it spawns and bun test sets NODE_ENV=test (both measured 2026-09-24):
  // door.spec runs the real prompt hook under both lanes, and its dockets are never the owner's traffic.
  if ((env.NODE_TEST_CONTEXT || env.NODE_ENV === "test") && !env.CONNECTIONS_LANE_DIR) return "not recorded: a test run";
  return laneDir({ env }) ? null : "no lane on this machine";
}

/** The lane's workspace spelling of a repo root (26-tools-rules-lane.mjs laneSlugOf + laneRootSlug). */
export function workspaceHome(root) {
  return String(path.resolve(String(root)))
    .replace(/[^A-Za-z0-9]/g, "-")
    .replace(/--claude-worktrees-.*$/i, "")
    .replace(/^[a-z](?=--)/, (d) => d.toUpperCase());
}

/** The row key of one instrument, or of the docket as a whole (DOCKET_ROW). Local keys carry the home lower-cased,
 *  as the lane hook's own inventory writes them. */
export function rowKey(engineHome, name) {
  return `${String(engineHome).toLowerCase()}|dredd|docket|${name}`;
}

/** The session a docket belongs to: the prompt hook passes it, a chat's shell carries it, anything else has none. */
/**
 * The chat a docket with no session is filed under: one per docket. The lane keys runs and scores by a session's first
 * eight characters, so a shared prefix ("dredd-20...") would fold every session-less docket into one chat.
 */
export function fallbackSession(docketId) {
  return `${createHash("sha1").update(`dredd-docket:${docketId}`).digest("hex").slice(0, 8)}-dredd-docket`;
}

export function sessionOf(env = process.env) {
  return String(env.DREDD_SESSION || env.CLAUDE_CODE_SESSION_ID || "").replace(/[^A-Za-z0-9_-]/g, "");
}

function readJsonFile(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** This session's ledger: the dockets it received and how many times each row ran. */
export function sessionLedgerPath(dir, session) {
  return path.join(dir, "dredd", `${session}.json`);
}

/** A session's first docket clears ledgers a month old, the way the lane hook clears its shown/ and rated/ files. */
function sweepLedgers(folder, ttlMs = 30 * 24 * 3600 * 1000) {
  try {
    for (const f of readdirSync(folder)) {
      const p = path.join(folder, f);
      if (Date.now() - statSync(p).mtimeMs > ttlMs) rmSync(p, { force: true });
    }
  } catch {
    // A sweep that cannot read the folder leaves it for the next session's first docket; recording goes on.
  }
}

function bumpLedger(dir, session, docket, docketDir, names) {
  const file = sessionLedgerPath(dir, session);
  if (!existsSync(file)) sweepLedgers(path.dirname(file));
  const led = readJsonFile(file, { dockets: [], runs: {} });
  if (!led.dockets.some((d) => d.dir === docketDir))
    led.dockets.push({ id: docket.id, dir: docketDir, at: docket.created || new Date().toISOString() });
  for (const n of names) led.runs[n] = (led.runs[n] || 0) + 1;
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(led));
  return led.runs;
}

function queue(dir, events) {
  appendFileSync(path.join(dir, "outbox.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

const meta = (engineHome, name, sample) => ({
  layer: "local",
  workspace: String(engineHome).toLowerCase(),
  kind: "dredd",
  event: "docket",
  name,
  sample: String(sample || "").slice(0, 240),
});

/** One docket's decision, the lane payload's shape: no ask. */
export function decisionOf(docket, mode) {
  return {
    id: docket.id,
    mode,
    class: docket.class,
    domain: docket.domain,
    scope: docket.scope,
    decidedBy: docket.decidedBy,
    convened: (docket.convene || []).map((c) => ({ id: c.id, p: c.p })),
    tier: docket.delegation?.tier ?? null,
  };
}

/**
 * The run events for one docket: the docket row and one per convened instrument, each carrying this session's running
 * count. Pure apart from `runs` (the ledger's counts after this docket), so the spec checks the events exactly.
 */
export function runEvents(docket, { mode, session, home, engineHome, runs, now = new Date().toISOString(), bench = null }) {
  const label = (id) => bench?.instruments?.find((i) => i.id === id)?.name || id;
  const convened = (docket.convene || []).map((c) => c.id);
  const sample = `${docket.class} · ${docket.domain} · convened ${convened.join(", ") || "nothing"}`;
  const base = { kind: "run", session, home, occurred_at: now };
  return [
    {
      id: randomUUID(),
      ...base,
      target: { kind: "injection", id: rowKey(engineHome, DOCKET_ROW) },
      payload: { runs: runs[DOCKET_ROW] || 1, chats: 1, ...meta(engineHome, DOCKET_ROW, sample), docket: decisionOf(docket, mode) },
    },
    ...convened.map((id) => ({
      id: randomUUID(),
      ...base,
      target: { kind: "injection", id: rowKey(engineHome, id) },
      payload: { runs: runs[id] || 1, chats: 1, ...meta(engineHome, id, label(id)), docket: docket.id },
    })),
  ];
}

/**
 * Records one docket: the session ledger and the run events. Never throws - the prompt hook must print its docket
 * whatever happens here - and says what happened: "queued", "no lane on this machine", "not recorded: <why>" or
 * "failed: <why>".
 */
export function recordDocket(docket, docketDir, { mode, engineRoot, root, env = process.env, bench = null } = {}) {
  try {
    const skip = notRecorded(env);
    if (skip) return skip;
    const dir = laneDir({ env });
    const session = sessionOf(env) || fallbackSession(docket.id);
    const convened = (docket.convene || []).map((c) => c.id);
    const runs = bumpLedger(dir, session, docket, docketDir, [DOCKET_ROW, ...convened]);
    queue(
      dir,
      runEvents(docket, { mode, session, home: workspaceHome(root || engineRoot), engineHome: workspaceHome(engineRoot), runs, bench }),
    );
    return "queued";
  } catch (err) {
    return `failed: ${err?.message || err}`;
  }
}

/** The score events for one rating: the docket row with the chat's own score and note, and one per judged instrument. */
export function scoreEvents(docket, rating, { session, home, engineHome, now = new Date().toISOString() }) {
  const base = { kind: "score", session, home, occurred_at: now, situation: `Dredd docket: ${docket.class} ${docket.domain}`.slice(0, 60) };
  const events = [
    {
      id: randomUUID(),
      ...base,
      target: { kind: "injection", id: rowKey(engineHome, DOCKET_ROW) },
      rating: rating.score,
      verdict: rating.verdict,
      ...(rating.note ? { note: rating.note } : {}),
      payload: {
        docket: docket.id,
        choices: rating.choices,
        missed: rating.missed,
        ...(rating.missingTool ? { missing_tool: rating.missingTool } : {}),
        ...(rating.class ? { class_was: docket.class, class_is: rating.class } : {}),
        ...(rating.domain ? { domain_was: docket.domain, domain_is: rating.domain } : {}),
      },
    },
  ];
  for (const [id, choice] of Object.entries(rating.choices)) {
    const s = instrumentScore(choice, rating.score);
    if (!s) continue;
    events.push({
      id: randomUUID(),
      ...base,
      target: { kind: "injection", id: rowKey(engineHome, id) },
      rating: s.rating,
      verdict: s.verdict,
      note: `${choice} for a ${docket.class} about ${docket.domain}${rating.note ? `: ${rating.note}` : ""}`.slice(0, 400),
      payload: { docket: docket.id, choice },
    });
  }
  return events;
}

/** Queues one rating's score events. Returns "queued", "no lane on this machine", "not recorded: <why>" or "failed: <why>". */
export function recordRating(docket, rating, { engineRoot, root, env = process.env } = {}) {
  try {
    const skip = notRecorded(env);
    if (skip) return skip;
    const dir = laneDir({ env });
    const session = sessionOf(env) || fallbackSession(docket.id);
    queue(dir, scoreEvents(docket, rating, { session, home: workspaceHome(root || engineRoot), engineHome: workspaceHome(engineRoot) }));
    return "queued";
  } catch (err) {
    return `failed: ${err?.message || err}`;
  }
}
