import { targetRoot } from "../../lib/target.mjs";
// dredd/lib/hearing.mjs - the whole hearing, unattended.
//
// the Chair, 2026-09-22: "Dredd will run Sue, Sue will give her complaint, then the boardroom, which will
// determine who in the boardroom should be in this conversation using Jev, will run a boardroom session
// over the findings of Sue to resolve Sue's findings ... and then we review changes with the boardroom
// until we're happy." So, after --convene has launched the field:
//
//   1. wait   - poll until SUE's run is finished (or refused) and the critic's capture has landed;
//   2. collect - SUE's report, the capture, LilGranny, the flow walk, into the docket (lib/collect.mjs);
//   3. ladder - the five rungs read from the evidence (lib/ladder.mjs);
//   4. seats  - Jev reads the evidence brief and says which seats sit (lib/seats.mjs);
//   5. sit    - the room sits over the evidence, those seats only (numbered after any sitting already held);
//   6. resolve - drafter -> the claims check -> Humanizer -> the room scores the proposal (the marketing
//                minds seated for it), until happy or out of rounds;
//   7. file   - hearing.json, verdict.md, one log per step.
//
// `--resolve` re-enters at step 6 on a docket whose evidence and seats already exist: the drafter, the claims
// check and the room are cents, SUE is a dollar, so the loop is tuned without re-sending people.
//
// Every wait is bounded, every step is logged to <docket>/hearing.log, and what did not land is said
// plainly with the command to run again. Nothing here touches the repo.
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkClaims, renderClaims, trimClaims } from "./claims.mjs";
import { captureCovers, collect, criticPaths, flowWalkArtifactState, runAsync, sit } from "./collect.mjs";
import { ENGINE_DIR, ENGINE_ROOT } from "./docket.mjs";
import { openLocalMcp } from "./mcp.mjs";
import { fieldFacets, mergeMemories, recallFacets } from "./recall.mjs";
import { askJev } from "./jev.mjs";
import { renderTally, scoreText } from "./ballot.mjs";
import { ladderState, renderLadder, scoreCovers } from "./ladder.mjs";
import {
  drafterModel,
  draftProposal,
  draftRedesign,
  humanize,
  mergeHumanized,
  renderProposal,
  renderRedesign,
  roomHappy,
  shouldStop,
} from "./resolve.mjs";
import { DESIGN_PROPOSAL_SITTING, designAsk, designCall, targetLine } from "./round.mjs";
import { pageRulings, renderRulingsLine } from "./rulings.mjs";
import { readRulings, realClaims, realClaimsText, renderCountsLine, ruleFieldClaims, rulingSeats } from "./claim-rulings.mjs";
import { diagnoseFieldClaims } from "./claim-diagnosis.mjs";
import { pageKey, readScoreboard } from "../../sue/lib/workspace.mjs";
import { sueOver, sueProgress, sueStatus } from "./sue-status.mjs";
import {
  buildSeatQuestions,
  chairsFor,
  decideSeats,
  docketAbsent,
  evidenceBrief,
  fillMinds,
  heuristicSeatAnswers,
  houseFor,
  inRoom,
  loadSeatRoster,
  pickMinds,
  roomForDomain,
  roomsHeard,
  sitFor,
} from "./seats.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The flags of a sitting's tally (lib/ballot.mjs tallyBallots) the stop rule reads, in its own names. A sitting with no
 *  tally (it could not sit) is conclusive by default: it has no verdict, and the resolution already says why. */
export function standingOf(tally) {
  return {
    split: Boolean(tally?.split),
    allVoid: Boolean(tally?.allUngrounded),
    principleOnly: Boolean(tally?.principleOnly),
    conclusive: tally?.conclusive !== false,
  };
}
/** A sitting's hearing.json record. One that could not sit for capacity (lib/collect.mjs sit) carries that line in
 *  place of a tally, so no reader prints it as a room that sat and cast no ballot (board #7040). */
function sittingRecord(s, standing, extra = {}) {
  return {
    sitting: s.sitting,
    verdict: s.minutes?.verdict ?? null,
    conclusive: standing.conclusive,
    fix_first: s.minutes?.fix_first || "",
    exit: s.status,
    ...extra,
    ...(s.capacity ? { capacity: s.failure, tally: null } : { tally: renderTally(s.minutes?.tally) }),
    // What the sitting waited for, and a sitting before it that failed and sat again: without it the record reads 1, 2, 4.
    ...(s.notes?.length ? { notes: s.notes } : {}),
  };
}

/** What the hearing's log says a sitting decided: its score, tally and fix, or the capacity line it could not sit for. */
function sittingHeard(s, standing, { tally = true } = {}) {
  if (s.capacity) return s.failure;
  const score = scoreText({ verdict: s.minutes?.verdict ?? null, ...standing });
  return `${score}${tally ? ` (${renderTally(s.minutes?.tally)})` : ""} - ${s.minutes?.fix_first || "(no minutes)"}`;
}

/** Why the room reached no ruling, for H.resolution: a capacity failure says to sit again once the soonest key is free. */
function couldNotSit(s, what, docketDir) {
  return s.capacity
    ? `the room could not sit${what} for capacity: ${s.failure} - see boardroom-${s.sitting}.log; sit it again once the soonest key is free (node dredd/dredd.mjs --hearing --docket ${docketDir})`
    : `the room could not sit${what} (exit ${s.status}${s.failure ? `: ${s.failure}` : ""}) - see boardroom-${s.sitting}.log`;
}

/**
 * How a hearing over a question with no page ends: the minds room's ruling IS the answer (its verdict, fix first and
 * plan), so nothing is drafted. The drafter wants a page or a file to change; asked whether Lift's curriculum was
 * comprehensive enough to sell, it "drafted nothing, no change, cut or headline" twice, and verdict.md read "the drafter
 * failed in round 1" over a room that had answered 4/10 with a five-step plan (docket 20261003-195820-67df). Null when
 * a draft is owed: another room, a design board that sat (it drafts a redesign), or no ruling to answer with.
 */
export function noPageResolution({ room, design = null, minutes = null }) {
  if (room !== "minds" || !minutes || (design && !design.failed && design.seats?.length)) return null;
  const plan = String(minutes.plan || "").trim();
  const score = scoreText({ verdict: minutes.verdict ?? null, conclusive: minutes.tally?.conclusive });
  return [
    `the room answered ${score} (a question with no page, so nothing was drafted): fix first - ${minutes.fix_first || "-"}`,
    ...(plan ? ["", "The plan:", plan] : []),
  ].join("\n");
}

/** The seat that reviews every PROPOSAL in the product room, whatever Jev said over the evidence. */
export const PROPOSAL_SEAT = "the-marketing-minds";

export function readJson(p, fallback = null) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

/** The hearing's own steps, in order, "step n of 8" as the async status door names them (P1). `field`
 *  through `resolve` are P9's own step names, verbatim - `sitting` and `resolve` carry a round number
 *  in the live record ("resolve round 2") but collapse to these bare names for the count. */
export const HEARING_STEPS = ["convene", "field", "collect", "ladder", "seats", "sitting", "resolve", "file"];

/** `H.step` as recorded ("resolve round 2", "sitting") mapped to its 1-based place in HEARING_STEPS,
 *  or null for a step the catalog does not know (never blocks anything - status just omits the count). */
export function stepIndex(step) {
  const base = String(step || "").replace(/^resolve round \d+$/, "resolve");
  const i = HEARING_STEPS.indexOf(base);
  return i < 0 ? null : i + 1;
}

/** Whether the pid a hearing.json record names is still a real, running process ON THIS MACHINE.
 *  Windows freely reuses pids, so a bare pid match is not evidence of anything (P9's RISK) - the host
 *  must match too, and only then is `process.kill(pid, 0)` (a pure existence probe, no signal sent)
 *  worth asking. */
export function lockAlive(record, { hostname = os.hostname() } = {}) {
  if (!record || !Number.isFinite(Number(record.pid)) || record.pid <= 0) return false;
  if (record.host && record.host !== hostname) return false;
  try {
    process.kill(Number(record.pid), 0);
    return true;
  } catch {
    return false;
  }
}

/** The one gate every re-entry action (--hearing, --resolve, --collect, --convene) checks before it
 *  touches a docket: `{ record, live }`. `record` is null on a docket with no hearing yet (a brand new
 *  docket, or one that was only ever `--convene`d) - never a refusal, by construction (P9's RISK: this
 *  must never block --doctor or a new docket, and it never even runs for either - see dredd.mjs's one
 *  call site). A dead record (`live: false` but `record` truthy) is not a refusal either: it is taken
 *  over, and the caller says so once. */
export function liveHearingLock(docketDir) {
  const record = readJson(path.join(docketDir, "hearing.json"));
  if (!record || record.state !== "running") return { record, live: false };
  return { record, live: lockAlive(record) };
}

/** Whether a `--hearing` resume may skip straight to the resolution loop (step 6) instead of re-running
 *  wait, collect, the ladder and a second Jev seat pick over the same evidence (P2's GAP: each resume
 *  used to book another Jev call and another sitting over evidence nobody added to). Only when the field
 *  had already finished landing last time - renderVerdict's own promise is to "sit again over what
 *  arrives", so a resume must never skip the wait while SUE was still running (P2's RISK) - and a seat
 *  pick plus a first evidence sitting already happened. */
export function mayResumeAtResolve(prior) {
  if (!prior || !prior.field?.sueDone || !prior.field?.criticDone) return false;
  const done = new Set(prior.stepsDone || []);
  return done.has("seats") && done.has("sitting");
}

/** The Design Critic wave's own refusals, each printed once before it exits 2 and before any capture
 *  (scripts/audit/design-critic-wave.mjs). */
const CRITIC_REFUSAL =
  /\[dc-wave\] (?:unusable --adhoc|policy will not load|unknown surface id|no surfaces on plane|nothing in scope|--adhoc is its own scope|--public selected none|--degraded needs|--with-planes names|DESIGN_CRITIC_FIXTURE_DRIVERS is missing)[^\n]*/;

/** Pure: the line where the critic's wave refused to start, or null. A launch that succeeded can still end in a refusal
 *  (the wave exits 2 on a spec it cannot shoot), and the Deal Flow invite hearing (2026-09-25) waited twenty minutes for
 *  the capture of a wave that had refused `pass:` in its first second. */
export function criticRefusal(logText) {
  return CRITIC_REFUSAL.exec(String(logText || ""))?.[0] ?? null;
}

export async function awaitField({ root, docket, waitMs, log }) {
  const t0 = Date.now();
  const results = docket.results || [];
  const sueRow = results.find((r) => r.id === "sue" && r.runId);
  // Every SUE-family run on the docket is waited on (her focus group records a runId too; nothing else does).
  const runRows = results.filter((r) => r.runId);
  // Only a critic that really started is waited on: "launch failed - ..." matched a bare /launch/ and the hearing
  // idled the whole wait for a capture that could not come (Opus 5.5 review, 2026-09-22).
  const criticRow = results.find((r) => r.id === "design-critic" && /^launched\b/.test(r.status || ""));
  const capture = criticPaths(root, results).capture;
  const created = Date.parse(docket.created || 0);
  // The walk launched with this docket is waited on the same way: until it has written a finished artifact that started
  // after the launch, so the collect reads this docket's walk and not an older one.
  const walkRow = results.find((r) => r.id === "flow-walk" && /^launched\b/.test(r.status || ""));
  const walkArtifact = path.join(root, "tmp", "design-critic", "flow-walk.json");
  const runDone = new Set();
  let sueDone = !runRows.length;
  let criticDone = !criticRow;
  let walkDone = !walkRow;
  const last = new Map();
  while (Date.now() - t0 < waitMs && !(sueDone && criticDone && walkDone)) {
    for (const row of runRows.filter((r) => !runDone.has(r.runId))) {
      const st = sueStatus(root, row.runId);
      if (sueOver(st)) runDone.add(row.runId);
      const line = `${row.id} ${row.runId}: ${sueProgress(st)}`;
      if (line !== last.get(row.id)) log(line);
      last.set(row.id, line);
    }
    sueDone = runRows.every((r) => runDone.has(r.runId));
    if (!criticDone && existsSync(capture) && statSync(capture).mtimeMs >= created) {
      // Newer is not enough: it must cover THIS docket's surfaces since the docket opened (a peer's wave rewrote it).
      if (captureCovers(readJson(capture), docket.surfaces, created)) {
        criticDone = true;
        log("design-critic: the capture landed");
      }
    }
    const refused = !criticDone && criticRow?.log && existsSync(criticRow.log) ? criticRefusal(readFileSync(criticRow.log, "utf8")) : null;
    if (refused) {
      criticDone = true;
      log(`design-critic: the wave refused to start, so nothing will land - ${refused}`);
    }
    if (!walkDone && flowWalkArtifactState(readJson(walkArtifact), walkRow.at || docket.created).ok) {
      walkDone = true;
      log("flow-walk: the walk finished");
    }
    if (!(sueDone && criticDone && walkDone)) await sleep(20_000);
  }
  return { sueDone, criticDone, walkDone, waitedMs: Date.now() - t0, sueRunId: sueRow?.runId || null };
}

/**
 * A booked price, or null when the call carried none. A missing price is unknown, never free (paperclip's eval rule,
 * doc/evals.md, 2026-09-27): brain.mjs books `cost_usd: null` for a leg that reports no price, and summing that as
 * 0 made a dearer hearing read as a cheap one.
 */
export function bookedUsd(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The bill's line for Jev's seat pick, from askJev's summary: the cascade books Jev's own calls and the fallback's
 * separately (jev_cost_usd, fallback_cost_usd), the brain path books one call (cost_usd). Null with no summary;
 * `cost_usd` is null when nothing in the summary was priced.
 */
export function jevCallRow(summary) {
  if (!summary) return null;
  let cost;
  if (summary.cost_usd !== undefined) cost = bookedUsd(summary.cost_usd);
  else {
    const parts = [bookedUsd(summary.jev_cost_usd), bookedUsd(summary.fallback_cost_usd)].filter((n) => n !== null);
    cost = parts.length ? parts.reduce((a, b) => a + b, 0) : null;
  }
  return {
    what: "seat pick",
    model: summary.jev_route
      ? `${summary.jev_route} (${summary.model || summary.jev_model || "jev"})`
      : summary.model || summary.jev_model || "jev",
    cost_usd: cost === null ? null : Math.round(cost * 1e6) / 1e6,
    seconds: Number(summary.seconds) || 0,
  };
}

/**
 * What this hearing cost, from its own docket: every model call the room, the drafter, the vision score and Jev's
 * seat pick booked (calls.jsonl under each sitting, resolve-calls.jsonl, vision-calls.jsonl, jev-calls.jsonl), the
 * visitors' cast (cast-calls.jsonl, lib/visitors.mjs), SUE's
 * spend as her status reported it, and the wall-clock from `openedAt` (the docket's opening; a --resolve passes its
 * own start, or a re-entry days later billed days of wall). The bill is on every verdict so a hearing that got dearer
 * is seen the day it happens (overnight, 2026-09-22: five Sues on OpenRouter were $2.72 of a $2.77 hearing).
 * A call that booked no price is counted in `unpriced` and left out of `modelUsd`, so the figure says it is partial.
 */
export function hearingBill({ docketDir, docket, openedAt = docket?.created, finishedAt = null, now = Date.now() }) {
  let calls = 0;
  let unpriced = 0;
  let modelUsd = 0;
  let modelSeconds = 0;
  const files = [];
  try {
    for (const f of readdirSync(docketDir)) {
      const p = path.join(docketDir, f);
      if (/^boardroom(-\d+)?$/.test(f) && existsSync(path.join(p, "calls.jsonl"))) files.push(path.join(p, "calls.jsonl"));
      else if (["resolve-calls.jsonl", "vision-calls.jsonl", "jev-calls.jsonl", "cast-calls.jsonl"].includes(f)) files.push(p);
    }
  } catch {
    /* no docket dir: an empty bill */
  }
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").trim().split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        calls += 1;
        const usd = bookedUsd(r.cost_usd);
        if (usd === null) unpriced += 1;
        else modelUsd += usd;
        modelSeconds += Number(r.seconds) || 0;
      } catch {
        /* a torn line */
      }
    }
  }
  // SUE and her focus group: each run's spend so far, summed (the collect rows carry it).
  const runRows = (docket?.results || []).filter((r) => r.id === "sue" || r.id === "focus-group" || r.id === "ape" || r.id === "art");
  const spent = runRows.filter((r) => r.costUsd !== null && r.costUsd !== undefined && Number.isFinite(Number(r.costUsd)));
  const sueUsd = spent.length ? Math.round(spent.reduce((n, r) => n + Number(r.costUsd), 0) * 1e4) / 1e4 : null;
  // A run that outlasted the wait has spent money and is still spending: the figure is a floor, and says so.
  const sueRunning = runRows.some((r) => /^still running/.test(String(r.status || "")));
  const opened = openedAt ? Date.parse(openedAt) : NaN;
  const closed = finishedAt ? Date.parse(finishedAt) : now;
  const wallMs = Number.isFinite(opened) && opened > 0 ? Math.max(0, closed - opened) : null;
  return {
    calls,
    unpriced,
    modelUsd: Math.round(modelUsd * 1e4) / 1e4,
    modelSeconds: Math.round(modelSeconds),
    sueUsd,
    sueRunning,
    wallMs,
  };
}

export function renderBill(b) {
  const wall = b.wallMs === null ? "-" : `${Math.floor(b.wallMs / 60000)} min ${Math.round((b.wallMs % 60000) / 1000)} s`;
  const sue = b.sueUsd === null ? " · SUE nothing" : ` · SUE $${b.sueUsd.toFixed(2)}${b.sueRunning ? " so far (still running)" : ""}`;
  const unpriced = b.unpriced ? `, ${b.unpriced} with no price (not in that figure, so it is a floor)` : "";
  return `${b.calls} model call(s), $${b.modelUsd.toFixed(4)} booked at list price${unpriced} (${b.modelSeconds} model-seconds)${sue} · wall ${wall}`;
}

/**
 * The async door's answer to "how far along is it" (P1): the docket's ask/url, the step (named and
 * numbered out of HEARING_STEPS), whether the recorded pid is still alive, hearing.log from `fromLine`
 * with a total and `hasMore` (the same cursor shape MF's report.py answers agent-log with), SUE's own
 * progress line when a run is on the docket, the sittings so far, a live bill (the same pure
 * `hearingBill` a finished hearing bills with), and verdict.md's text once it exists. Reads the docket
 * fresh every call; never caches, so two callers polling at once never disagree.
 */
export function hearingStatus({ root, docketDir, fromLine = 0 }) {
  const docket = readJson(path.join(docketDir, "docket.json")) || {};
  const H = readJson(path.join(docketDir, "hearing.json"));
  const logPath = path.join(docketDir, "hearing.log");
  const allLines = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split(/\r?\n/).filter(Boolean) : [];
  const from = Math.max(0, Math.min(fromLine, allLines.length));
  const slice = allLines.slice(from);
  const sueRow = (docket.results || []).find((r) => r.id === "sue" && r.runId);
  const sueSt = sueRow ? sueStatus(root, sueRow.runId) : null;
  const verdictPath = path.join(docketDir, "verdict.md");
  // A detached hearing convenes its instruments before hearing.json exists: that is under way, not "not started"
  // (the sullivanfantastic.com hearing read "not started" for minutes while page-pulse, odin and the room ran, 2026-09-25).
  const conveneLog = path.join(docketDir, "convene.jsonl");
  const rows = (existsSync(conveneLog) ? readFileSync(conveneLog, "utf8").trim().split(/\r?\n/).filter(Boolean) : []).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return { id: "?", status: "unreadable row" };
    }
  });
  const died = H ? null : diedBeforeFirstStep(docketDir, docket);
  const convening = !H && !died && existsSync(path.join(docketDir, "detached.out")) ? rows.map((r) => `${r.id} ${r.status}`) : null;
  // A hearing launched --chat waits for the chat's own agents to drive its visitors: say who is waiting and how, until
  // that run is over (a finished run still read "waiting on this chat", 2026-09-25).
  const runOver = (r) => sueOver(r.runId === sueRow?.runId ? sueSt : r.runId ? sueStatus(root, r.runId) : null);
  const chatWaiting = existsSync(verdictPath)
    ? []
    : rows
        .filter((r) => r.brain === "chat" && /^launched/.test(String(r.status || "")) && r.note && !runOver(r))
        .map((r) => `${r.id}: ${r.note}`);
  return {
    docket: { ask: docket.ask || null, url: docket.url || null },
    started: Boolean(H),
    convening,
    chatWaiting,
    state: H?.state || (died ? died.state : convening ? "convening" : "not started"),
    step: H?.step || null,
    stepNumber: H ? stepIndex(H.step) : null,
    // The room's why-we-stopped (a timeout lives here via couldNotSit) - surfaced in --status's first lines so it
    // does not have to be dug out of the tail of hearing.log and boardroom-1.log (2026-10-09).
    resolution: H?.resolution || null,
    stepsOfEight: HEARING_STEPS.length,
    alive: H ? lockAlive(H) : false,
    died: died ? died.text : null,
    error: H?.error || died?.error || null,
    log: { fromLine: from, lines: slice, total: allLines.length, hasMore: from + slice.length < allLines.length },
    sueProgress: sueSt ? sueProgress(sueSt) : null,
    sittings: H?.sittings || [],
    // The room's rulings on the field's claims (lib/claim-rulings.mjs), once the room has ruled.
    rulings: H?.rulings ? renderCountsLine(readRulings(docketDir)?.counts ?? {}, H.rulings.claims) : null,
    bill: H?.bill || (H ? hearingBill({ docketDir, docket, openedAt: docket.created }) : null),
    verdict: existsSync(verdictPath) ? readFileSync(verdictPath, "utf8") : null,
  };
}

/**
 * What a docket folder with no docket.json says: its hearing died before the docket was written, which before
 * 2026-09-28 was the preflight (dredd.mjs now writes the docket, marked, before it). Nothing convened, so there is
 * nothing to resume. The resume door (`--hearing --docket <dir>`) says this instead of an ENOENT stack.
 */
export function diedBeforeDocketText(docketDir) {
  const asked = existsSync(path.join(docketDir, "ask.txt")) ? " (the ask is in its ask.txt)" : "";
  return `${docketDir} has no docket.json: the hearing died before its docket was written, most likely at the preflight (no model answered with structure). Nothing convened, so there is nothing to resume: check the brain (node dredd/dredd.mjs --doctor) and relaunch with the same ask${asked}.`;
}

/**
 * A hearing that died before its first step, or null: `docket.preflight.ok === false` (dredd.mjs marks it before the
 * call and records the failure), a mark still unset whose process is gone (killed mid-preflight), or no docket.json at
 * all once the detached launcher's pid is gone. Each used to read "convening" for good on --status, and a resume died
 * ENOENT on docket.json (2026-09-28).
 */
export function diedBeforeFirstStep(docketDir, docket) {
  const pf = docket?.preflight;
  if (pf && pf.ok == null && pf.pid && !lockAlive(pf)) {
    return {
      state: "died at the preflight",
      error: "the hearing stopped during the preflight, before any model answered",
      text: `died at the preflight: the hearing stopped before any model answered, so nothing convened and nothing was spent. Resume it with node dredd/dredd.mjs --hearing --docket ${docketDir} (it keeps the ask, the page and the cast), or relaunch with the same ask.`,
    };
  }
  if (pf && pf.ok === false) {
    const why = `${pf.error || "no answer"}${pf.model ? `, ${pf.model}` : ""}`;
    return {
      state: "died at the preflight",
      error: `no model answered with structure (${why})`,
      text: `died at the preflight: no model answered with structure (${why}), so nothing convened and nothing was spent. Check the brain (node dredd/dredd.mjs --doctor), then resume it with node dredd/dredd.mjs --hearing --docket ${docketDir} (it keeps the ask, the page and the cast), or relaunch with the same ask.`,
    };
  }
  // Only a detached launch leaves a folder before its docket; a folder with neither file is simply "not started".
  if (existsSync(path.join(docketDir, "docket.json"))) return null;
  const launched = readJson(path.join(docketDir, "detached.json"));
  if (!launched?.pid || lockAlive(launched)) return null;
  return { state: "died before its docket", error: null, text: diedBeforeDocketText(docketDir) };
}

/** status, as text, for a human at the CLI (`--status`, no `--json`). */
export function renderStatus(st) {
  const lines = [
    `DREDD HEARING STATUS`,
    st.docket.ask ? `Ask: ${st.docket.ask}${st.docket.url ? ` (${st.docket.url})` : ""}` : null,
    st.started
      ? `Step ${st.stepNumber ?? "?"} of ${st.stepsOfEight}: ${st.step} (${st.state}${st.alive ? "" : ", not running"})`
      : st.died
        ? st.died
        : st.convening
          ? `convening the instruments before the first step: ${st.convening.length ? st.convening.join(", ") : "none back yet"}`
          : "not started",
    st.resolution ? `Resolution: ${st.resolution}` : null,
    ...(st.chatWaiting || []).map((w) => `WAITING ON THIS CHAT - ${w}`),
    st.error ? `Error: ${st.error}` : null,
    st.sueProgress ? `SUE: ${st.sueProgress}` : null,
    st.rulings ? `Rulings: ${st.rulings}` : null,
    ...st.sittings.map((s) => `Sitting ${s.sitting}: ${scoreText(s)}${s.tally ? ` (${s.tally})` : ""} - ${s.fix_first || "-"}`),
    st.bill ? renderBill(st.bill) : null,
    `hearing.log ${st.log.total ? `${st.log.fromLine + 1}-${st.log.fromLine + st.log.lines.length} of ${st.log.total}` : "(empty)"}${st.log.hasMore ? ", more" : ""}:`,
    ...st.log.lines,
    st.verdict ? `\n--- verdict.md ---\n${st.verdict}` : null,
  ];
  return `${lines.filter((l) => l !== null).join("\n")}\n`;
}

/**
 * Kill the hearing this docket's lock names, through its recorded pid (the tree, the same way collect.mjs's
 * runLine bounds an instrument): `taskkill /T /F` on Windows, the process group elsewhere. Records the
 * step it stopped at so the docket's history (lib/dockets.mjs) reads `stopped`, never a silent `running`
 * that never finishes. `{ stopped, step?, why? }` - never throws.
 */
export function stopHearing(docketDir) {
  const p = path.join(docketDir, "hearing.json");
  const H = readJson(p);
  if (!H) {
    // A detached hearing still convening has no hearing.json yet; its launcher wrote the pid (dredd.mjs --detach).
    const launched = readJson(path.join(docketDir, "detached.json"));
    if (!launched?.pid) return { stopped: false, why: "no hearing.json on this docket - nothing has run" };
    try {
      if (process.platform === "win32")
        spawnSync("taskkill", ["/PID", String(launched.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else process.kill(-Number(launched.pid), "SIGKILL");
    } catch (err) {
      return { stopped: false, why: `kill failed: ${err.message}` };
    }
    writeFileSync(
      p,
      JSON.stringify({ state: "stopped", step: "convene", pid: launched.pid, finishedAt: new Date().toISOString() }, null, 2),
    );
    return { stopped: true, step: "convene" };
  }
  if (!lockAlive(H)) return { stopped: false, why: `no live hearing on this docket (last state "${H.state}" at "${H.step || "?"}")` };
  try {
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(H.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else process.kill(-Number(H.pid), "SIGKILL");
  } catch (err) {
    return { stopped: false, why: `kill failed: ${err.message}` };
  }
  H.state = "stopped";
  H.finishedAt = new Date().toISOString();
  writeFileSync(p, JSON.stringify(H, null, 2));
  return { stopped: true, step: H.step };
}

/** The last proposal the room actually scored, its words inline beside its score: the owner decides from verdict.md
 *  alone. Copied from the proposal's own record by code, so nothing here can be invented; a refused proposal never
 *  shows, because the room never saw it. */
export function renderTheChange(H) {
  const scored = (H.proposals || []).filter((p) => !p.rejected && Array.isArray(p.changes));
  const sitting = (p) => (H.sittings || []).find((s) => s.proposal === p.file && s.verdict != null);
  const last = [...scored].reverse().find(sitting);
  if (!last) return [];
  const s = sitting(last);
  const out = last.design
    ? [`## The redesign (redesign ${last.round}, the design board's ${s.verdict}/10${s.tally ? `, ${s.tally}` : ""})`, ``]
    : [`## The change (proposal ${last.round}, the room's ${s.verdict}/10${s.tally ? `, ${s.tally}` : ""})`, ``];
  if (last.idea) out.push(`**The idea:** ${last.idea}`, ``);
  if (last.headline) out.push(`**Headline:** ${last.headline}`, ``);
  for (const c of last.changes.slice(0, 8)) {
    out.push(`- **${c.where || "somewhere"}**`);
    if (c.before) out.push(`  - before: ${c.before}`);
    out.push(`  - after: ${c.after || "(cut)"}`);
  }
  if (last.changes.length > 8) out.push(`- ...and ${last.changes.length - 8} more in ${path.basename(last.file)}`);
  if (last.measure) out.push(``, `**What the next round must show:** ${last.measure}`);
  out.push(``, `The room's fix first for it: ${s.fix_first || "-"}`, ``);
  return out;
}

/** Up to five visitors' own lines, copied verbatim from SUE's report (the ones never coming back first), each with
 *  who said it; or a plain line when no SUE words landed. Never a model's summary of them. */
export function renderTheirWords(docketDir) {
  const sue = docketDir ? readJson(path.join(docketDir, "sue-report.json")) : null;
  if (!sue) return [];
  const gone = (sue.verdict?.neverComingBackWhys || [])
    .filter((r) => r?.why)
    .map((r) => ({ who: r.persona || r.sueId || "a visitor", said: r.why, tag: "never coming back" }));
  const said = (sue.theirWords || [])
    .filter((w) => w?.said)
    .map((w) => ({ who: w.sueId || "a visitor", said: w.said, tag: w.where ? `on ${w.where}` : w.kind || "" }));
  const picked = [...gone, ...said].slice(0, 5);
  if (!picked.length) return [`## In their words`, ``, `No SUE words landed in this docket.`, ``];
  return [
    `## In their words`,
    ``,
    ...picked.flatMap((q) => [`> ${String(q.said).replace(/\s+/g, " ").trim()}`, `> - ${q.who}${q.tag ? `, ${q.tag}` : ""}`, ``]),
  ];
}

/** verdict.md for a hearing a crash cut short (P2): headed with the step it died on and the error,
 *  loud that this is NOT a ruling (a partial verdict must never be read as one - P2's RISK), then
 *  whatever landed before the crash - the ladder, who sat, the sittings so far, the bill - and the one
 *  command that resumes. Pure over `H` (whatever hearing() had written to hearing.json before it threw)
 *  and `err`; never throws on a sparse H (a crash before the field even finished leaves H.ladder unset). */
export function renderFailureVerdict(docket, H, err) {
  const lines = [
    `# The hearing stopped at step ${H?.step || "?"}: ${err?.message || err}`,
    ``,
    `**This is a partial record, not a ruling.** The room did not reach a verdict; what follows is what`,
    `landed before the crash.`,
    ``,
    `**The complaint:** ${docket.ask}`,
    docket.url ? `**The page:** ${docket.url}` : "",
    ``,
  ];
  if (H?.ladder?.length) lines.push(`## The ladder`, "```", ...renderLadder(H.ladder), "```", ``);
  if (H?.seats) {
    lines.push(`## Who sat (decided by ${H.seats.decidedBy}, ${H.seats.room} room${H.seats.heard ? " with the minds" : ""})`);
    for (const r of H.seats.rows) lines.push(`- ${H.seats.picked.includes(r.id) ? "sat" : "   "} ${r.name} p=${r.p} (${r.why})`);
    lines.push(``);
  }
  if (H?.sittings?.length) {
    lines.push(`## The sittings so far`);
    for (const s of H.sittings)
      lines.push(
        `- sitting ${s.sitting}${s.proposal ? ` over ${path.basename(s.proposal)}` : " over the evidence"}: ${scoreText(s)}${s.tally ? ` (${s.tally})` : ""} - ${s.fix_first || "-"}`,
      );
    lines.push(``);
  }
  if (H?.bill) lines.push(`## The bill so far`, renderBill(H.bill), ``);
  lines.push(`Resume with: \`node dredd/dredd.mjs --hearing --docket ${H?.docketDir || docket.docketDir || "<dir>"}\``);
  return lines.filter((l) => l !== null).join("\n");
}

function renderVerdict(docket, H) {
  const lines = [`# Dredd's verdict`, ``, `**The complaint:** ${docket.ask}`, docket.url ? `**The page:** ${docket.url}` : "", ``];
  // A round is judged against its target first: the users' stars decide when it is done, never the room's score.
  if (docket.round) lines.push(`**${targetLine(docket.round)}**`, ``);
  lines.push(`## The ladder`, "```", ...renderLadder(H.ladder || []), "```", ``);
  const looks = (H.ladder || []).find((r) => r.id === "looks");
  if (looks?.state === "yours")
    lines.push(
      `Rung two is yours: the capture landed unattended, and the PNGs are scored by the session, never a subprocess (owner directive 2026-08-08) - ${looks.evidence}`,
      ``,
    );
  if (H.seats) {
    lines.push(`## Who sat (decided by ${H.seats.decidedBy}, ${H.seats.room} room${H.seats.heard ? " with the minds" : ""})`);
    for (const r of H.seats.rows) lines.push(`- ${H.seats.picked.includes(r.id) ? "sat" : "   "} ${r.name} p=${r.p} (${r.why})`);
    if (H.proposalSeats?.some((s) => !H.seats.picked.includes(s)))
      lines.push(`- sat, for the proposals only: ${H.proposalSeats.filter((s) => !H.seats.picked.includes(s)).join(", ")}`);
    lines.push(``);
  }
  if (H.design?.seats?.length) {
    lines.push(`## The design board (${H.design.decidedBy || "?"}): ${H.design.why}`);
    for (const r of [...(H.design.rows || [])].sort((a, b) => b.p - a.p).slice(0, 10))
      lines.push(`- ${H.design.seats.includes(r.id) ? "sat" : "   "} ${r.name}${r.field ? ` (${r.field})` : ""} p=${r.p} (${r.why})`);
    if (H.reviewFix) lines.push(`- the review table's own fix first, kept beside the redesign: ${H.reviewFix}`);
    lines.push(``);
  } else if (H.design?.failed)
    lines.push(
      `## The design board could not sit: ${H.design.failed}; ${H.design.capacity ? "nothing was drafted" : "the copy loop resolved instead"}`,
      ``,
    );
  if (H.bill) lines.push(`## The bill`, renderBill(H.bill), ``);
  lines.push(`## The sittings`);
  // What the scores below are a verdict on, when a rung of a page hearing was NOT CHECKED (lib/ladder.mjs scoreCovers).
  const covers = scoreCovers(H.ladder || []);
  if (covers) lines.push(`**${covers}**`, ``);
  for (const s of H.sittings)
    lines.push(
      `- sitting ${s.sitting}${s.proposal ? ` over ${path.basename(s.proposal)}` : s.design ? " (the design board) over the evidence" : " over the evidence"}: ${scoreText(s)}${s.tally ? ` (${s.tally})` : ""} - ${s.fix_first || "-"}`,
      ...(s.notes || []).map((n) => `  - ${n}`),
    );
  const rejected = H.proposals.filter((p) => p.rejected);
  if (rejected.length) {
    lines.push(``, `## Proposals the claims check refused (the room never saw them)`);
    for (const p of rejected) lines.push(`- proposal ${p.round}: ${p.rejected.map((f) => `${f.kind} "${f.text}"`).join(", ")}`);
  }
  lines.push(``, `## Resolution`, H.resolution || "-", ``);
  lines.push(...renderTheChange(H), ...renderTheirWords(H.docketDir));
  if (H.proposals.length) {
    const last = H.proposals[H.proposals.length - 1];
    lines.push(
      `The last proposal: ${last.file}${last.humanized ? " (humanized)" : " (the Humanizer pass did not run)"}${last.rejected ? " (REJECTED by the claims check)" : ""}. Drafted by ${last.drafter || H.drafter}.`,
      ``,
    );
  }
  lines.push(
    H.answered
      ? `The room's answer above is the outcome: the question named no page, so no change was drafted and nothing was applied to the repository.`
      : H.design && !H.design.failed
        ? `The redesign is a file in this docket, a brief for the builder; nothing was applied to the repository. The next round says whether it worked.`
        : `Proposals are files in this docket; nothing was applied to the repository. The front door's words are the owner's to land, with the room's score next to them.`,
  );
  if (!H.field.sueDone || !H.field.criticDone)
    lines.push(
      ``,
      `Not every field instrument landed inside the wait: run \`node dredd/dredd.mjs --hearing --docket ${H.docketDir}\` to sit again over what arrives.`,
    );
  return lines.filter((l) => l !== null).join("\n");
}

/**
 * A redesign from the design board's ruling (lib/resolve.mjs draftRedesign), in the proposal's shape the verdict and
 * the next round's prior read: each change's `now` is its before. No claims check and no Humanizer: a redesign is a
 * brief for the builder, not copy for strangers. `draft` is the model call, handed in so it is testable without one.
 */
export async function draftDesigned({ round, base, callsLog, log = () => {}, draft = draftRedesign }) {
  const d = await draft({ ...base, callsLog });
  if (!d.data) return { error: `the redesign drafter failed in round ${round}: ${d.error}` };
  const drafter = d.model || base?.model || null;
  if (d.fellBackFrom?.length) log(`redesign ${round} fell back to ${drafter} after ${d.fellBackFrom.join("; ")}`);
  const redesign = d.data;
  const proposal = {
    headline: null,
    changes: (redesign.changes || []).map((c) => ({ where: c.where, before: c.now || "", after: c.after, why: c.why })),
  };
  return { redesign, proposal, humanized: false, rejected: null, cut: [], claims: null, drafter };
}

/**
 * Draft and check the claims; one redraft when the check refuses, then the stamp cuts what it still refuses. Only a
 * draft that PASSES is humanized, so a refused draft never pays for a Humanizer call (it used to, 2026-09-22), and the
 * humanized text is checked again, because the Humanizer can add a claim of its own: if it did, the checked draft goes
 * to the room unhumanized. The Humanizer may change only the afters and the headline (resolve.mjs mergeHumanized).
 * `draft` and `humanizer` are the model calls, handed in so the order is testable without a model.
 * Returns { proposal, humanized, rejected, cut, claims, drafter } - `rejected` only when nothing survived the cut, and
 * `drafter` the model that answered the draft that stands (the drafter falls back to another model, lib/resolve.mjs).
 */
export async function draftChecked({
  round,
  base,
  callsLog,
  pageText,
  inventory,
  log,
  matter = "opinion",
  exists = null,
  rulings = null,
  draft = draftProposal,
  humanizer = humanize,
}) {
  let claims = null;
  // What a why may quote besides the page: the visitors' own lines and stop words, the complaint, and the ruling. The
  // drafter is shown all of them; with none passed here, round 12 of lift-v2 had crazygames-kid's own words refused as
  // "nobody said it", twice, and the hearing ended with no proposal (docket round-20261004-031251-2f1d, 2026-10-04).
  const sueWords = [...(base?.sue?.theirWords || []), ...(base?.sue?.whyTheyStopped || [])].map((w) => w?.said).filter(Boolean);
  if (base?.ask) sueWords.push(String(base.ask));
  const ruling = [base?.minutes?.fix_first, base?.minutes?.plan].filter(Boolean).join("\n");
  for (let attempt = 1; ; attempt += 1) {
    const d = await draft({ ...base, claims, callsLog });
    if (!d.data) return { error: `the drafter failed in round ${round}: ${d.error}` };
    const drafter = d.model || base?.model || null;
    if (d.fellBackFrom?.length) log(`draft ${attempt} of round ${round} fell back to ${drafter} after ${d.fellBackFrom.join("; ")}`);
    const c = checkClaims({ proposal: d.data, pageText, inventory, matter, exists, rulings, sueWords, ruling });
    if (c.offPage.length)
      log(`draft ${attempt} of round ${round} quotes a before the page does not carry (${c.offPage.join(", ")}); it counts as nothing`);
    let passing = d.data;
    let cut = [];
    if (!c.ok) {
      claims = renderClaims(c.findings);
      log(`claims check refused draft ${attempt} of round ${round}: ${c.findings.map((f) => `${f.kind} "${f.text}"`).join(", ")}`);
      if (attempt === 1) continue;
      const t = trimClaims(d.data, c.findings);
      if (!t.proposal) return { proposal: d.data, humanized: false, rejected: c.findings, cut: t.cut, claims, drafter };
      log(`claims check cut ${t.cut.length} place(s) from the redraft; ${t.proposal.changes.length} change(s) go to the room`);
      passing = t.proposal;
      cut = t.cut;
    }
    // The Humanizer rewrites copy for strangers; a code change is not copy (Dredd's self-hearing humanized an import
    // line, 2026-09-23).
    if (matter === "code") return { proposal: passing, humanized: false, rejected: null, cut, claims, drafter };
    const h = await humanizer({ proposal: passing, callsLog });
    const merged = mergeHumanized(passing, h.data, h.error || h.status);
    if (!merged.humanized) {
      log(`humanizer: ${merged.why}`);
      return { proposal: passing, humanized: false, rejected: null, cut, claims, drafter };
    }
    const again = checkClaims({ proposal: merged.proposal, pageText, inventory, exists, rulings, sueWords, ruling });
    if (!again.ok) {
      log(
        `the Humanizer added what the page does not carry (${again.findings.map((f) => `${f.kind} "${f.text}"`).join(", ")}); the checked draft goes to the room unhumanized`,
      );
      return { proposal: passing, humanized: false, rejected: null, cut, claims, drafter };
    }
    return { proposal: merged.proposal, humanized: true, rejected: null, cut, claims, drafter };
  }
}

/**
 * The ruling a --resolve drafts against: the live sitting's minutes, unless that sitting failed. A failure record
 * ({ failed, error, verdict: null }, boardroom.mjs) is not a ruling - --resolve used to draft against it as
 * "verdict -/10; fix first: -" and pay the drafter, the Humanizer and the room for a room that never sat (Opus 5.5
 * review, 2026-09-22). Returns { minutes, why } - `why` is set exactly when there is nothing to draft against.
 */
export function lastRuling(docketDir) {
  const file = path.join(docketDir, "boardroom", "minutes.json");
  const minutes = readJson(file);
  if (!minutes) return { minutes: null, why: "no minutes on the docket to draft against - run --hearing first" };
  if (minutes.failed)
    return {
      minutes: null,
      why: `the last sitting failed (${minutes.error || "no reason recorded"}), so there is no ruling to draft against - run --hearing first`,
    };
  return { minutes, why: null };
}

/**
 * P17: one line on how this page's visitors have rated it, split by the build that served them - the build THIS
 * run just measured against ("served build") against every earlier build the scoreboard has seen, so the owner
 * can tell whether the last shipped fix moved visitors apart from an all-time blend. Pure over one page's
 * scoreboard row (sue/lib/workspace.mjs's `readScoreboard(root).pages[pageKey(url)]`, read by the one call
 * site below - this function never opens a file itself). A page with no `byBuild` (no scoreboard row yet, or one
 * written before this landed) says nothing; a page with no build stamp on its served run (localhost, a stranger's
 * site) reads "unknown build" - never a guess.
 */
export function renderScoreboardLine(row) {
  if (!row?.byBuild) return null;
  const avg = (b) => (b.starsCounted ? Math.round((b.starsSummed / b.starsCounted) * 10) / 10 : null);
  const runWord = (n) => (n === 1 ? "run" : "runs");
  const served = row.last?.build?.commit || null;
  const servedBucket = served ? row.byBuild[served] : null;
  if (servedBucket && avg(servedBucket) != null) {
    const rest = Object.entries(row.byBuild).filter(([commit]) => commit !== served);
    const restRuns = rest.reduce((n, [, b]) => n + b.runs, 0);
    const restCounted = rest.reduce((n, [, b]) => n + b.starsCounted, 0);
    const restSummed = rest.reduce((n, [, b]) => n + b.starsSummed, 0);
    const servedLine = `${avg(servedBucket)} stars over ${servedBucket.runs} ${runWord(servedBucket.runs)} on served build ${served.slice(0, 7)}`;
    const restLine = restCounted
      ? `; ${Math.round((restSummed / restCounted) * 10) / 10} over ${restRuns} ${runWord(restRuns)} on earlier builds`
      : "";
    return `SUE on this page: ${servedLine}${restLine}`;
  }
  const unknown = row.byBuild.unknown;
  if (unknown && avg(unknown) != null)
    return `SUE on this page: ${avg(unknown)} stars over ${unknown.runs} ${runWord(unknown.runs)} (unknown build)`;
  return null;
}

export async function hearing({
  root,
  engineDir = ENGINE_DIR,
  seatsDir = null,
  inventory = null,
  docket,
  docketDir,
  waitMs = 25 * 60_000,
  untilHappy = 2,
  happyAt = 7,
  jev = true,
  resolveOnly = false,
  say = () => {},
}) {
  const logPath = path.join(docketDir, "hearing.log");
  const log = (line) => {
    appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`);
    say(`  hearing: ${line}`);
  };
  const H = {
    docketDir,
    startedAt: new Date().toISOString(),
    sittings: [],
    proposals: [],
    happyAt,
    untilHappy,
    drafter: drafterModel(),
    // The lock (P9): pid paired with host and startedAt (Windows reuses pids, so a bare pid is not
    // evidence of anything - lib's own lockAlive checks both), plus the per-step progress (P2) so a
    // crash mid-hearing leaves the owner more than hearing.log to read. `finishedAt` stays null while
    // this process is the one running the hearing; --hearing/--resolve/--collect/--convene on this
    // docket are refused while it is (dredd.mjs's one call site to liveHearingLock).
    pid: process.pid,
    host: os.hostname(),
    url: docket.url || null,
    state: "running",
    step: resolveOnly ? "resolve" : "field",
    stepsDone: [],
    finishedAt: null,
  };
  // `advance` marks a step done and names the next one, saving hearing.json after every step (P2's
  // CHANGE) - so a resume (mayResumeAtResolve) can tell a hearing that reached the sitting from one that
  // crashed waiting on the field, and a live-lock check (liveHearingLock) always reads a fresh step.
  const advance = (doneStep, nextStep) => {
    if (doneStep) H.stepsDone.push(doneStep);
    if (nextStep) H.step = nextStep;
    writeFileSync(path.join(docketDir, "hearing.json"), JSON.stringify(H, null, 2));
  };
  advance(null, H.step);
  const roster = loadSeatRoster(seatsDir || undefined);
  const room = roomForDomain(docket.domain, { url: docket.url });
  const heard = roomsHeard(room, docket.ask);
  const sue = readJson(path.join(docketDir, "sue-report.json"));
  const pulse = readJson(path.join(docketDir, "page-pulse.json"));
  let s;
  let sitting;
  let verdict = null;
  // What the last sitting's tally says beside its number, every flag of which keeps a hearing from ending happy
  // (resolve.mjs roomHappy): split, every ballot void, grounded only in principle, not conclusive. principleOnly was
  // computed by the tally and printed "never happy" but never reached the stop rule until 2026-09-24.
  let standing = standingOf(null);

  if (resolveOnly) {
    // Re-enter at the resolution loop: the evidence, the ladder and the seats are already on the docket
    // (either --resolve was asked for outright, or mayResumeAtResolve found a crashed hearing that had
    // already got through field, collect, the ladder, the seat pick and a first sitting - so the field
    // is treated as landed and no step here is re-run).
    const prior = readJson(path.join(docketDir, "hearing.json"));
    H.field = prior?.field || { sueDone: Boolean(sue), criticDone: true, waitedMs: 0 };
    H.ladder = prior?.ladder || ladderState({ docket, results: docket.results, pulse, sue });
    if (!existsSync(path.join(docketDir, "ladder.json")))
      writeFileSync(path.join(docketDir, "ladder.json"), JSON.stringify(H.ladder, null, 2));
    H.seats = readJson(path.join(docketDir, "seats.json"));
    if (!H.seats) throw new Error(`--resolve needs ${docketDir}/seats.json - run --hearing first`);
    H.resumedFrom = prior?.finishedAt || null;
    // A redesign hearing resumes as one: the design board drafts against its own ruling (lib/round.mjs).
    H.design = prior?.design || null;
    H.stepsDone = ["field", "collect", "ladder", "seats", "sitting"];
    const ruling = lastRuling(docketDir);
    s = { minutes: ruling.minutes, status: ruling.minutes ? 0 : null }; // the loop drafts against the last ruling; the score starts fresh
    log(
      `resolve only: ${H.seats.picked.length} seat(s) from seats.json, the last ruling ${scoreText({ verdict: ruling.minutes?.verdict, conclusive: ruling.minutes?.tally?.conclusive })}, drafter ${H.drafter}`,
    );
    if (ruling.why) H.resolution = ruling.why;
    advance(null, "resolve round 1");
  } else {
    // 1. wait for the field
    H.field = await awaitField({ root, docket, waitMs, log });
    log(
      `field: sue ${H.field.sueDone ? "done" : "NOT done"}, critic ${H.field.criticDone ? "done" : "NOT done"}, after ${Math.round(H.field.waitedMs / 1000)} s`,
    );
    advance("field", "collect");

    // 2. collect, without the board (the board sits below, with Jev's seats)
    const collected = await collect({ root, engineDir, docket, docketDir, board: false });
    docket.results = [...(docket.results || []).filter((r) => !collected.some((c) => c.id === r.id)), ...collected];
    for (const c of collected) log(`collected ${c.id}: ${c.status}`);
    advance("collect", "ladder");

    // 3. the evidence, and the ladder
    const sueNow = readJson(path.join(docketDir, "sue-report.json"));
    const logs = {};
    for (const id of ["lilgranny", "copy-audit"]) {
      const p = path.join(docketDir, `${id}.log`);
      if (existsSync(p)) logs[id] = readFileSync(p, "utf8");
    }
    const first =
      readJson(path.join(docketDir, "boardroom", "minutes.json")) || readJson(path.join(docketDir, "boardroom-1", "minutes.json"));
    const manifests = {};
    for (const id of ["lilgranny", "copy-audit"]) {
      // LilGranny over an off-roster page writes lilgranny.json (convene.mjs lilgrannyOverPulse), its `checks` row in
      // the manifest's shape, where her Architect run over the roster capture writes lilgranny/manifest.json.
      const m =
        readJson(path.join(docketDir, id, "manifest.json")) ||
        (id === "lilgranny" ? readJson(path.join(docketDir, "lilgranny.json")) : null);
      if (m) manifests[id] = m;
    }
    H.ladder = ladderState({ docket, results: docket.results, logs, pulse, sue: sueNow, manifests });
    // The room reads the ladder from the docket: its measured failures cap the ballots' verdict (lib/ballot.mjs).
    writeFileSync(path.join(docketDir, "ladder.json"), JSON.stringify(H.ladder, null, 2));
    for (const line of renderLadder(H.ladder)) log(`ladder ${line.trim()}`);
    // Recall again, on what the field found: where the visitors stopped, the rung that failed, a broken page. The room
    // reads docket.memories, so the rows it gains are on disk before the seat pick and the sitting.
    const facets = fieldFacets({ sue: sueNow, ladder: H.ladder, pulse });
    if (facets.length && docket.memories !== undefined) {
      let mcp = null;
      try {
        mcp = await openLocalMcp({ root, loaderRoot: targetRoot(), timeoutMs: 25_000 });
        const found = await recallFacets(mcp, facets);
        const before = (docket.memories || []).length;
        docket.memories = mergeMemories(docket.memories, found);
        writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
        log(`recall after the field: ${docket.memories.length - before} new memory(ies) from ${facets.map((f) => f.label).join("; ")}`);
      } catch (err) {
        log(`recall after the field could not run: ${String(err?.message || err).slice(0, 160)}`);
      } finally {
        if (mcp) await mcp.close();
      }
    }
    advance("ladder", "seats");

    // 4. Jev picks the seats from the evidence
    let board = null;
    if (docket.url) {
      try {
        board = readScoreboard(root).pages?.[pageKey(docket.url)] ?? null;
      } catch {
        board = null; // an unparsable url names no scoreboard row
      }
    }
    const brief = evidenceBrief({
      ask: docket.ask,
      url: docket.url,
      sueReport: sueNow,
      pulse,
      minutes: first,
      ladder: H.ladder,
      scoreboard: renderScoreboardLine(board),
      round: docket.round ? targetLine(docket.round) : null,
      results: docket.results,
    });
    writeFileSync(path.join(docketDir, "evidence-brief.md"), `${brief}\n`);
    let answers = null;
    let decidedBy = "heuristic";
    if (jev) {
      const res = await askJev(
        buildSeatQuestions(
          roster.filter((x) => inRoom(x, heard)),
          brief,
        ),
        { escalate: 0.7, timeoutMs: 60_000 },
      );
      // The seat pick is a model call like any other, so it is on the bill (it was not, 2026-09-22).
      const jevRow = jevCallRow(res.summary);
      if (jevRow) appendFileSync(path.join(docketDir, "jev-calls.jsonl"), `${JSON.stringify(jevRow)}\n`);
      if (res.answers) {
        answers = res.answers;
        decidedBy = "jev";
      } else log(`jev could not pick the seats (${res.reason}); the seat keywords did`);
    }
    if (!answers) answers = heuristicSeatAnswers(roster, brief);
    // The minds room fills its chairs the way boardroom.mjs and the eval do (fillMinds); topped up to two by
    // decideSeats, the hearing sat two minds of thirty-five on Lift's curriculum (docket 20261003-195820-67df).
    H.seats = {
      ...(room === "minds"
        ? fillMinds({
            seats: roster.filter((x) => inRoom(x, "minds")),
            answers,
            sit: sitFor(room, decidedBy),
            chairs: chairsFor(docket.ask),
          })
        : decideSeats({
            seats: roster,
            answers,
            room,
            heard: decidedBy === "jev" ? heard : [room],
            always: sueNow ? ["grandma-sue"] : [],
            absent: docketAbsent(docketDir),
            sit: sitFor(room, decidedBy),
          })),
      decidedBy,
    };
    writeFileSync(path.join(docketDir, "seats.json"), JSON.stringify(H.seats, null, 2));
    log(`seats (${decidedBy}, ${room} room${H.seats.heard ? " with the minds" : ""}): ${H.seats.picked.join(", ")}`);
    advance("seats", "sitting");

    // 5. the sitting over the evidence
    s = sit({ root, engineDir, docketDir, seats: H.seats.picked });
    sitting = s.sitting;
    verdict = s.minutes?.verdict ?? null;
    standing = standingOf(s.minutes?.tally);
    for (const n of s.notes || []) log(`sitting ${sitting}: ${n}`);
    H.sittings.push(sittingRecord(s, standing));
    log(`sitting ${sitting}: ${sittingHeard(s, standing)}`);
    if (!s.minutes) H.resolution = `${couldNotSit(s, "", docketDir)}; nothing was drafted against no ruling`;
    else if (s.minutes.failedSeats?.length)
      log(
        `sitting ${sitting}: ${s.minutes.failedSeats.length} seat turn(s) did not answer (${[...new Set(s.minutes.failedSeats.map((f) => f.seat))].join(", ")})`,
      );
    // 5b. The design board, when the evidence says the problem is design (lib/round.mjs designCall): a round below its
    // target that stalled or where most stopped early, or a page whose SUE rating stalled build over build. The users said
    // what they need; five minds (games, product design, attention, psychology) decide how, and the resolution below is
    // their REDESIGN, never a copy change (the Chair, 2026-10-01).
    H.design = designCall({ round: docket.round, scoreboard: board, target: docket.round?.target });
    // The design board was called for and the room never sat: the verdict says why, not that the board was never called.
    if (H.design && s.capacity) H.design = { ...H.design, failed: s.failure, capacity: true };
    if (H.design && s.minutes) {
      const ask = designAsk({ docket, call: H.design });
      const pick = await pickMinds({
        ask,
        evidence: brief,
        max: 5,
        cwd: root,
        board: "design",
        ...(jev ? {} : { askJevFn: async () => ({ answers: null }) }),
      });
      H.design = { ...H.design, ask, seats: pick.picked, decidedBy: pick.decidedBy, rows: pick.rows };
      writeFileSync(path.join(docketDir, "design-seats.json"), JSON.stringify(pick, null, 2));
      log(`design: ${H.design.why}; the design board (${pick.decidedBy}): ${pick.picked.join(", ")}`);
      const review = s;
      const ds = sit({ root, engineDir, docketDir, seats: pick.picked, room: "minds", ask });
      sitting = ds.sitting;
      const dStanding = standingOf(ds.minutes?.tally);
      for (const n of ds.notes || []) log(`sitting ${sitting} (the design board): ${n}`);
      H.sittings.push(sittingRecord(ds, dStanding, { design: true }));
      log(`sitting ${sitting} (the design board): ${sittingHeard(ds, dStanding, { tally: false })}`);
      if (ds.minutes) {
        // The redesign is drafted against the design board's ruling; the review table's own fix stays on the record.
        H.reviewFix = review.minutes?.fix_first || null;
        s = ds;
        verdict = ds.minutes.verdict ?? null;
        standing = dStanding;
        H.resolution = null;
      } else {
        log(`the design board could not sit (${ds.failure || `exit ${ds.status}`}); the copy loop resolves instead`);
        H.design = { ...H.design, failed: ds.failure || `exit ${ds.status}` };
      }
    }
    advance("sitting", "resolve round 1");
  }

  // 5c. The field's claims go to the room before anything is repaired (lib/claim-rulings.mjs): every SUE/APE problem note
  // and ART's fix-first item is ruled REAL, NOT REAL or UNPROVEN by the seats on the Connections Boardroom. Only REAL ones
  // reach the drafter. A resumed hearing reads the rulings it already holds; a room that cannot be reached ends it here.
  let ruled = resolveOnly ? readRulings(docketDir) : null;
  if (!ruled && !H.resolution) {
    try {
      // The ruling panel sits, not only the seats the question picked (lib/claim-rulings.mjs RULING_PANEL).
      const panel = rulingSeats(
        H.seats.picked,
        roster.map((x) => x.id),
      );
      log(`rulings: the room that rules on the field's claims: ${panel.join(", ")}`);
      ruled = await ruleFieldClaims({ root, docketDir, seats: panel, seatsDir, run: runAsync, log });
    } catch (err) {
      H.resolution = `the rulings did not sit: ${err.message}; nothing was drafted`;
      log(H.resolution);
    }
  }
  // No claim ruled real: nothing is drafted, and the verdict says so (the no-page answer below still stands, it drafts nothing).
  let nothingReal = null;
  if (ruled) {
    H.rulings = { counts: ruled.counts, claims: ruled.rulings.length, real: realClaims(ruled).length, file: "rulings.md" };
    if (!realClaims(ruled).length)
      nothingReal = `the room ruled none of the field's ${ruled.rulings.length} claim(s) real (${renderCountsLine(ruled.counts, ruled.rulings.length)}): nothing was drafted`;
  }
  const realText = ruled ? realClaimsText(ruled) : "";

  // 5d. The experts' homework on what the room ruled REAL (lib/claim-diagnosis.mjs): Jev routes each screen's claims to
  // the seats of the whole bench whose field bears on them, each expert answers its homework (right or a misread, the
  // problem, the fix, done when, what must not change) on a strong vision route, and one synthesis writes the ordered
  // burn-down (burndown.md). A resumed hearing keeps what already answered. A failure is logged; nothing below reads it.
  if (ruled && realClaims(ruled).length && !H.resolution) {
    try {
      const decided = (docket.matter?.kind || "opinion") === "code" ? "" : pageRulings(root, docket.url)?.text || "";
      const burn = await diagnoseFieldClaims({
        root,
        docketDir,
        seatsDir,
        roster,
        run: runAsync,
        url: docket.url,
        job: docket.ask,
        decisions: decided,
        // A hearing on another repository (`--root`) knows the product's checkout: the experts read what it landed since the visits.
        repo: docket.root || null,
        log,
        ...(jev ? {} : { askJevFn: async () => ({ answers: null, reason: "jev off for this hearing" }) }),
      });
      H.burndown = {
        items: burn.items.length,
        wrong: burn.wrong_claims.length,
        experts: [...new Set(burn.routing.flatMap((r) => r.seats.map((s) => s.id)))],
        models: burn.models,
        cost_usd: burn.cost_usd,
        seconds: burn.seconds,
        file: "burndown.md",
      };
    } catch (err) {
      H.burndown = { error: String(err?.message || err) };
      log(`burn-down: ${H.burndown.error}`);
    }
  }

  // 6. the resolution loop - the marketing minds review every proposal in the product room
  const sueForDraft = readJson(path.join(docketDir, "sue-report.json")) || sue;
  // Named in priority order, since the plane seats five and benches the last one named (lib/seats.mjs capSeats): the
  // seats that always sit, the proposal's reviewer, then Jev's picks by his rating.
  const rowOf = (id) => (H.seats.rows || []).find((r) => r.id === id);
  const mustSit = H.seats.picked.filter((id) => rowOf(id)?.why === "always sits");
  const byRank = H.seats.picked.filter((id) => !mustSit.includes(id)).sort((a, b) => (rowOf(b)?.p ?? 0) - (rowOf(a)?.p ?? 0));
  H.proposalSeats =
    room === "product" && roster.some((x) => x.id === PROPOSAL_SEAT) && !H.seats.picked.includes(PROPOSAL_SEAT)
      ? [...mustSit, PROPOSAL_SEAT, ...byRank]
      : H.seats.picked;
  const callsLog = path.join(docketDir, "resolve-calls.jsonl");
  const pageText = pulse?.text || "";
  // The screens SUE's visitors saw past the page (sue.mjs screensSeen): the drafter reads them, and a before quoted from
  // one counts as on the page. With the pulse alone, a hearing about Lift's lesson player drafted against the front
  // door's 65 words and quoted screens that do not exist (2026-09-29).
  const screens = (sueForDraft?.screensSeen || []).map((s) => s.text).join("\n\n");
  const seenText = [pageText, screens].filter(Boolean).join("\n\n");
  // The drafter reads the house of the repository judged - its stack and files, not Connections' (lib/seats.mjs houseFor).
  const house = houseFor(root, { url: docket.url });
  // The page's recorded rulings (lib/rulings.mjs): the drafter reads the ⛔ paragraphs, the claims check enforces the
  // @ruling lines. A code matter has no page.
  const rulings = (docket.matter?.kind || "opinion") === "code" ? null : pageRulings(root, docket.url);
  if (rulings) log(renderRulingsLine(rulings));
  let prior = null;
  let refused = 0;
  const answered = H.resolution ? null : noPageResolution({ room, design: H.design, minutes: s.minutes });
  if (answered) {
    H.resolution = answered;
    H.answered = true;
    log(answered.split("\n")[0]);
  }
  for (let round = 1; round <= untilHappy && !H.resolution && !nothingReal; round += 1) {
    advance(round > 1 ? `resolve round ${round - 1}` : null, `resolve round ${round}`);
    const before = shouldStop({ verdict, happyAt, round: round - 1, maxRounds: untilHappy, ...standing });
    if (before.stop) {
      H.resolution = before.why;
      break;
    }
    const designing = Boolean(H.design && !H.design.failed && H.design.seats?.length);
    const d = designing
      ? await draftDesigned({
          round,
          base: {
            ask: H.design.ask || docket.ask,
            url: docket.url,
            screens,
            sue: sueForDraft,
            minutes: s.minutes,
            prior,
            house,
            model: H.drafter,
            rulings: rulings?.text || "",
            realClaims: realText,
            root,
          },
          callsLog,
          log,
        })
      : await draftChecked({
          round,
          base: {
            ask: docket.ask,
            url: docket.url,
            pageText,
            screens,
            sue: sueForDraft,
            minutes: s.minutes,
            prior,
            house,
            model: H.drafter,
            // Files the ruling names that the repository does not have (boardroom.mjs): the drafter is told, never left to find them.
            missingFiles: s.minutes?.unfoundedCitations || [],
            rulings: rulings?.text || "",
            realClaims: realText,
            // The judged repository: the drafter reads the files the ruling names from it (lib/resolve.mjs namedFiles).
            root,
          },
          callsLog,
          pageText: seenText,
          inventory,
          log,
          matter: docket.matter?.kind || "opinion",
          exists: (p) => existsSync(path.join(root, p)),
          rulings: rulings?.component ? rulings : null,
        });
    if (d.error) {
      H.resolution = d.error;
      log(H.resolution);
      break;
    }
    const file = path.join(docketDir, designing ? `redesign-${round}.md` : `proposal-${round}.md`);
    const text = designing
      ? renderRedesign(d.redesign, { round, url: docket.url, model: d.drafter || H.drafter })
      : renderProposal(d.proposal, {
          round,
          url: docket.url,
          model: d.drafter || H.drafter,
          rejected: d.rejected ? d.claims : null,
          cut: d.cut?.length && !d.rejected ? d.cut : null,
        });
    writeFileSync(file, `${text}\n`);
    H.proposals.push({
      round,
      file,
      drafter: d.drafter || H.drafter,
      humanized: d.humanized,
      ...(designing ? { design: true, idea: d.redesign?.idea || null, measure: d.redesign?.measure || null } : {}),
      rejected: d.rejected,
      cut: d.cut || [],
      // The words to land, kept on the record so verdict.md can carry them: a caller on another machine gets the
      // verdict's text, never a path it can open. A refused proposal keeps none; it never reached the room.
      ...(d.rejected
        ? {}
        : {
            headline: d.proposal?.headline || null,
            changes: (d.proposal?.changes || []).map((c) => ({ where: c.where, before: c.before, after: c.after })),
          }),
    });
    if (d.rejected) {
      refused += 1;
      log(`proposal ${round} REFUSED by the claims check after a redraft; the room did not sit: ${file}`);
      // The next draft learns from the findings, never from the refused text (which re-seeds the invention).
      prior = `The claims check refused the whole previous proposal. Its findings:\n${d.claims}\nNothing it named may return.`.slice(
        0,
        5000,
      );
      continue;
    }
    log(
      designing
        ? `redesign ${round} drafted from the design board's ruling: ${file}`
        : `proposal ${round} drafted${d.humanized ? " and humanized" : ""}, claims check ${d.cut?.length ? `cut ${d.cut.length} place(s)` : "passed"}: ${file}`,
    );
    s = designing
      ? sit({ root, engineDir, docketDir, seats: H.design.seats, proposal: file, room: "minds", ask: DESIGN_PROPOSAL_SITTING })
      : sit({ root, engineDir, docketDir, seats: H.proposalSeats, proposal: file });
    sitting = s.sitting;
    verdict = s.minutes?.verdict ?? null;
    standing = standingOf(s.minutes?.tally);
    for (const n of s.notes || []) log(`sitting ${sitting} over proposal ${round}: ${n}`);
    H.sittings.push(sittingRecord(s, standing, { proposal: file }));
    log(`sitting ${sitting} over proposal ${round}: ${sittingHeard(s, standing)}`);
    if (!s.minutes) {
      H.resolution = couldNotSit(s, ` over proposal ${round}`, docketDir);
      break;
    }
    prior =
      `${text}\n\nThe room scored it ${scoreText({ verdict, ...standing })}. Fix first: ${s.minutes?.fix_first || "-"}\n${s.minutes?.minutes || ""}`.slice(
        0,
        5000,
      );
    const after = shouldStop({ verdict, happyAt, round, maxRounds: untilHappy, ...standing });
    if (after.stop) {
      H.resolution = after.why;
      break;
    }
  }
  if (!H.resolution)
    H.resolution = nothingReal || shouldStop({ verdict, happyAt, round: untilHappy, maxRounds: untilHappy, ...standing }).why;
  if (refused) H.resolution += `; ${refused} proposal(s) failed the claims check and never reached the room`;
  H.happy = roomHappy({ verdict, happyAt, ...standing });
  H.finalVerdict = verdict;
  H.conclusive = standing.conclusive;
  H.finishedAt = new Date().toISOString();
  H.bill = hearingBill({ docketDir, docket, openedAt: resolveOnly ? H.startedAt : docket.created, finishedAt: H.finishedAt });
  log(`bill: ${renderBill(H.bill)}`);
  // A normal return (no throw) is a finished hearing whatever the room decided - a poor verdict is still
  // a ruling; only an exception (caught at dredd.mjs's one call site) is `failed`, and only --stop is
  // `stopped`. The last step's own name lands in stepsDone too, so status/dockets read a complete list.
  if (H.step && !H.stepsDone.includes(H.step)) H.stepsDone.push(H.step);
  H.state = "finished";
  H.step = "file";
  writeFileSync(path.join(docketDir, "hearing.json"), JSON.stringify(H, null, 2));
  writeFileSync(path.join(docketDir, "verdict.md"), `${renderVerdict(docket, H)}\n`);
  log(`done: ${H.resolution}`);
  return H;
}
