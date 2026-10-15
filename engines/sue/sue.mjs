#!/usr/bin/env node
/**
 * sue - the one door to SUE: point it at a page, say why people are there, and read what happened.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-21): "all you have to do is point it at the page and say run Sue. And
 * then Sue will go from a blank browser, try getting there ... Sue's should never, ever, ever be able
 * to skip a step." And the product ruling the same day: "No AI. We provide no AI for Sue. Sue is
 * entirely on you to run. However, we provide you the tooling." So every Sue thinks with a brain
 * this file never signs in for: by default the calling chat's own agents (`brain: "chat"`), or, when
 * named, the real Claude Code CLI driven by a `deepseek`/`openrouter` API key (`lib/claude-cli.mjs`) -
 * never a subscription login (the Chair, 2026-09-23: no CLI logins).
 *
 * The Connections MCP's `sue` tool is a thin door onto this file (services/studio/local-mcp,
 * `src-impl/26b-tools-sue.mjs`), the same shape as its `ci` tool: the logic lives on the machine, so
 * it also runs from a terminal, a hook or a script without the MCP.
 *
 *   node sue/sue.mjs run        --json '{"url":"https://…","intent":"…","count":5}'
 *   node sue/sue.mjs run        --json-file <path>      (the same object from a file - no shell quoting)
 *   (`expect`, optional, 300 characters at most: one line on what the page is MEANT to be. Every Sue is told it and says
 *   so in a note if she finds something else; lib/workspace.mjs intentScenario.)
 *   (`engineRef`, optional, on run and focus_group: a git ref. Sue's code as it was at that commit plans and runs the
 *   wave, for an A/B of a change to Sue itself; `runOnEngineAt` below, lib/engine-store.mjs stageEngineAt.)
 *   node sue/sue.mjs status    [--json '{"runId":"…"}']      latest run in this workspace by default
 *   node sue/sue.mjs report     [--json '{"runId":"…"}']
 *   node sue/sue.mjs stop       --json '{"runId":"…"}'
 *   (`presue: false`, on run and focus_group: skip pre-sue. A link run that names nobody and carries no cast is
 *   pre-sued first: Jev asks who of SUE's people really visit this page, the brain drafts the kinds still missing,
 *   and those go and are saved to the workspace for the next run; lib/presue.mjs.)
 *   node sue/sue.mjs presue     --json '{"url":"https://…","intent":"…"}'   who fits, and onboard who is missing
 *   (`save: false` drafts and checks but saves nobody)
 *   node sue/sue.mjs personas
 *   node sue/sue.mjs people     [--json '{"ids":["reddit-troll"]}']   whole docs, exactly as a run sends them
 *   node sue/sue.mjs save_persona --json '{"id":"broker-ray","like":"bob","voice":"You are Ray, …"}'
 *   node sue/sue.mjs edit_persona --json '{"id":"broker-ray","dials":{"patienceSeconds":90},"set":{"anyField":"…"}}'
 *   node sue/sue.mjs journal    --json '{"persona":"broker-ray"}'
 *   node sue/sue.mjs scoreboard
 *   node sue/sue.mjs ape --json-file <path>   (exactly run with ape: true: a familiar power user, not a stranger; APE, sue/README.md#ape)
 *   node sue/sue.mjs art --json-file <path>   (exactly run with art: true: the design team walks it on a phone and a computer; ART, sue/README.md#art)
 *   node sue/sue.mjs field --json-file <path> [--json '{"dryRun":true}']   the owner's whole field, one door: Jev names the
 *        product's scope, pre-sue picks SUE's visitors for it, SUE goes first, ART when Jev reads design trouble in her
 *        claims, APE on a written rule, then ONE docket before the Boardroom (lib/field.mjs; README "Field"). dryRun
 *        prints every decision and launches nobody (`sueRun` reads an earlier SUE run's claims for the ART decision);
 *        `{"fieldId":"…"}` reads a field run back. Headless: the waves run hidden, nothing opens a window.
  node sue/sue.mjs focus_group --json '{"url":"https://…","intent":"…","count":4,"suggestions":["we think …"]}'
 *   node sue/sue.mjs focus_group --json '{"file":"plan.pdf"}'   or {"idea":"…"}: a PDF, picture, text or idea instead of a url
 *   node sue/sue.mjs room       --json '{"runId":"…"}'       a focus group's table: seats, problems, every line
 *   node sue/sue.mjs room_say   --json '{"runId":"…","text":"…"}'   the host (you) speaks into the room
 *   (every command takes --workspace <dir>; default: the current directory)
 *
 * A FOCUS GROUP (Owner, 2026-09-23) is a run whose Sues sit in one room (lib/room.mjs): they visit the
 * page together, hear each other's diaries and words, and a moderator gets them to agree on the ONE
 * biggest problem. `focus_group` (or `run` with focusGroup: true) opens that room before the runner
 * starts; the verdict is booked per page, and the next group's moderator is told the last one.
 *
 * Every command prints ONE JSON object on stdout and exits 0 when it did what was asked; a refusal
 * is `{ ok: false, error }` with exit 1, in words a caller can act on.
 *
 * ⛔ WHAT A RUN NEVER DOES: borrow a session, reuse an account, pre-fill a code, or start anywhere
 * but a fresh, empty browser at the page's own link (its front door with start:"home", or the
 * caller's own email or post that sent her, `arrival`, with start:"inbox"). The
 * body's rails (lib/rails.mjs, lib/findings.mjs) refuse CAPTCHAs, payment fields and hidden fields,
 * and her sign-in code only ever comes out of her own inbox. That is the whole point of SUE.
 */
import { targetRoot } from "../lib/target.mjs";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { parseShippedStamp } from "../lib/shared/shipped-build-stamp.mjs";
import { assertBrain, SUE_BRAIN_REASON, SUE_DEFAULT_MODEL, sueBrainPolicy } from "./lib/claude-cli.mjs";
import { climayteReady, climayteRunCall } from "./lib/climayte-dispatch.mjs";
import { readingModeOf } from "./lib/reading-pace.mjs";
import { noteHostLogs, sharedBrowserDir } from "./lib/shared-browser.mjs";
import { engineInfo, otherEngine, pinProcessStart, ROUTED_ENV, takeLease, writeLease } from "./lib/engine-lease.mjs";
import { collectInBackground, stageEngine, stageEngineAt } from "./lib/engine-store.mjs";
import { ARRIVAL_ID, hostAllowed, shapeInterview } from "./lib/findings.mjs";
import { messageUrl } from "./lib/inbox-page.mjs";
import { AUDIENCES, contentHashOf, intentFor, mergeTokensOf, unsubscribeUrlOf } from "./lib/inbox-test.mjs";
import { eventHostsFor, unfilledMerge } from "./lib/inbox-facts.mjs";
import { bookInboxTest, inboxTestRecord } from "./lib/inbox-run.mjs";
import { doorEnv, runStateDir } from "./lib/door.mjs";
import { ownedSitesDoorOf, ownedSitesForRun } from "./lib/owned-sites.mjs";
import { adoptFolderPeople, fetchPeople, openPeopleDoor, savePersonaAnswer, scratchWorkspaceRefusal } from "./lib/people.mjs";
import { castBoardroomPeople } from "./lib/boardroom-cast.mjs";
import { mintMailroomLease, needsMailroomLease } from "./lib/mailroom-lease.mjs";
import { workspaceProject } from "./lib/workspaces.mjs";
import {
  ART_TEAM,
  installedPeople,
  installPeople,
  isArtPersonaId,
  isCriticPersona,
  listPersonas,
  loadPersona,
  loadScenario,
  loadTarget,
  mindText,
  pinCriticMinds,
  sentPeople,
  techProwessOf,
} from "./lib/personas.mjs";
import { assertProfileName, listProfiles, readProfile } from "./lib/profiles.mjs";
import {
  appendLine,
  FOCUS_GROUP_DEFAULT,
  FOCUS_GROUP_MAX,
  HOST_ID,
  isFocusGroup,
  lastVerdictFor,
  openRoom,
  phaseOf,
  readVerdict,
  recordVerdict,
  roomSnapshot,
} from "./lib/room.mjs";
import { writeJsonAtomic } from "./lib/atomic-json.mjs";
import { mailDir, newRunId, runDir, runsRoot, stateRoot } from "./lib/run-dir.mjs";
import { keepDaysOf, pruneRuns, pruneSummary } from "./lib/retention.mjs";
import { readSettings } from "./lib/settings.mjs";
import { awaitRunStart } from "./lib/run-start.mjs";
import { handFieldToTheRoom, handToTheRoom } from "./lib/hand-to-room.mjs";
import { FIELD_LEDGER, fieldLines, planField, runField } from "./lib/field.mjs";
import { buildConfusion, buildSupport, filedList, loadSue } from "./report.mjs";
import { analyticsView, asciiJson, blindView, savedSummary } from "./analytics-view.mjs";
import { blindRoundMain } from "./blind-round.mjs";
import { readSueVersion } from "./lib/version.mjs";
import { MANAGER_PORT, managerListening, noteFocus, showWatcher, startHeadlessManager } from "./lib/watch-window.mjs";
import {
  MATERIAL_INTENT,
  MATERIAL_PAGES,
  MaterialRefusal,
  materialFromDisk,
  materialMayRunToSeveralPages,
  storeMaterial,
} from "./lib/material.mjs";
import { materialIdFrom } from "./lib/material-address.mjs";
import {
  appendJournal,
  buildPersona,
  editPersona,
  deriveTarget,
  ensureStore,
  expectOf,
  intentScenario,
  journalEntryFromSue,
  listRosterPersonas,
  listWorkspacePersonas,
  MIN_ERRAND_CHARS,
  pageKey,
  pageRunLine,
  pageRunTally,
  readJournal,
  readRunsLog,
  readScoreboard,
  storeDir,
  updateScoreboard,
  workspaceRoot,
  writtenFor,
} from "./lib/workspace.mjs";
import { APE_MIN_TECH, castFromAsk, CAST_MAX } from "./lib/cast.mjs";
import { loadedContextTokens, promptTokenEstimate, seatWithinContext } from "./lib/context-fit.mjs";
import { runPresue, saveOnboarded, withPresue } from "./lib/presue.mjs";
import { isOwnedSite, onConnectionsSite, onListedSite } from "./lib/site-owner.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
/** The roster mix a workspace with no people of its own gets: one of each kind of visitor. */
export const DEFAULT_ROSTER_MIX = ["grandma", "tiktok", "bob", "elaine", "low-attention", "dev-dan", "esl-maria", "karen"];
const MAX_COUNT = 500;

/** A request refused in words its caller can act on (the Manager answers these as 400s, not 500s). */
export class Refusal extends Error {}

function refuse(message) {
  throw new Refusal(message);
}

function mcpDir() {
  const dir = runStateDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const specFile = (runId) => path.join(mcpDir(), `${runId}.spec.json`);
/** The people a run sends, handed to its cannon while it runs and deleted when it ends (`runner`): they live in Connections. */
const peopleFile = (runId) => path.join(mcpDir(), `${runId}.people.json`);
export const statusFile = (runId) => path.join(mcpDir(), `${runId}.status.json`);
const logFile = (runId) => path.join(mcpDir(), `${runId}.log`);

/**
 * What this machine knows about a run started through `sue run`: where it stands (starting, running,
 * refused and why, finished, stopped, failed) and the reason these people were sent. A run started
 * straight through the cannon has neither, and reads as `{ state: null, intent: null }`.
 */
export function runRecord(runId) {
  const status = readJson(statusFile(runId)) ?? {};
  const spec = readJson(specFile(runId)) ?? {};
  return {
    state: typeof status.state === "string" ? status.state : null,
    why: Array.isArray(status.why) ? status.why.map(String) : status.error ? [String(status.error)] : [],
    intent: typeof spec.intent === "string" ? spec.intent : null,
    // The SUE version the wave ran on (lib/version.mjs); null for one started before versions.
    sue: typeof spec.sue?.version === "string" ? spec.sue.version : null,
    // The snapshot of Sue's code it runs on (lib/engine-store.mjs), { id, root, exe }; null for a run from before snapshots.
    engine: engineOf(status, spec),
    finishedAt: typeof status.finishedAt === "string" ? status.finishedAt : null,
  };
}

/** Whether a run's Sues are reading a file or an idea this computer's Sue Manager serves (lib/material.mjs). */
export function runServedByManager(runId) {
  return materialIdFrom(readJson(specFile(runId))?.url) !== null;
}

/** The engine a run's record names: its status's (the runner writes it), else its spec's, else null. */
function engineOf(status, spec) {
  const engine = status?.engine ?? spec?.engine;
  return engine && typeof engine === "object" && typeof engine.root === "string" ? engine : null;
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

const writeJson = writeJsonAtomic;

function runsFile(ws) {
  return path.join(storeDir(ws), "runs.jsonl");
}

function resolveRunId(ws, runId) {
  if (runId) {
    if (!RUN_ID.test(runId)) refuse(`runId "${runId}" is not a SUE run id (YYYYMMDD-HHMMSS-xxxx)`);
    return runId;
  }
  const last = readRunsLog(ws).at(-1);
  if (!last) refuse(`no SUE run has been started from ${workspaceRoot(ws)} yet - start one with action "run"`);
  return last.runId;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

/** A nonstop wave is looked for this long after it started; anything older is not listed as running. */
const LIVE_LOOKBACK_MS = 48 * 60 * 60 * 1000;
/** A run still "starting" after this long never got its runner going. */
const STARTING_STALE_MS = 10 * 60 * 1000;

/** When a run started, read off its id (`YYYYMMDD-HHMMSS-xxxx`, this computer's local time). */
function runStartedAt(runId) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(runId);
  return m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : 0;
}

/**
 * The runs `sue run` started that are running right now, newest first, with their planned size:
 * `[{ runId, count }]`. Read from the run records alone, and only for runs started in the last two
 * days (the id is the start time), so hundreds of finished runs cost one directory listing. The Sue
 * Manager's toolbar menu lists these (Owner, 2026-09-23: "you can see active running sessions").
 */
export function liveRuns(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(mcpDir());
  } catch {
    return [];
  }
  const live = new Map();
  for (const name of names) {
    const runId = /^(\d{8}-\d{6}-[0-9a-f]{4})\.status\.json$/.exec(name)?.[1];
    if (!runId || SETTLED.has(runId) || runStartedAt(runId) < now - LIVE_LOOKBACK_MS) continue;
    const status = readJson(statusFile(runId)) ?? {};
    if ((status.state === "running" || status.state === "starting") && !runnerGone(runId, status, now)) live.set(runId, status);
    // Finished, stopped, refused, or a runner that died: it never runs again, so it is never read again. A run whose
    // runner is gone still says "running" on disk; it is recorded as abandoned so nothing reads it as live.
    else {
      if (status.state === "running" || status.state === "starting")
        writeJson(statusFile(runId), { ...status, state: "abandoned", abandonedAt: new Date(now).toISOString() });
      SETTLED.add(runId);
    }
  }
  // Each with its runner's pid and the creation time the runner recorded beside it, so the Manager can
  // catch a pid Windows handed to another process after the runner died without saying so.
  return [...live.keys()]
    .sort((a, b) => b.localeCompare(a))
    .map((runId) => {
      const status = live.get(runId);
      return {
        runId,
        count: Number(readJson(specFile(runId))?.count) || null,
        pid: Number.isInteger(status.pid) ? status.pid : null,
        pidCreatedAt: typeof status.pidCreatedAt === "number" ? status.pidCreatedAt : null,
        // Written by the runner once it exists, so it also settles a pid whose creation time went unread.
        startedAt: Date.parse(status.startedAt ?? "") || null,
      };
    });
}
/** Runs `liveRuns` has seen end, in this process. */
const SETTLED = new Set();

/**
 * A run `liveRuns` never lists again: its runner died without saying so and its pid now belongs to
 * another process (the Manager asks the OS; see `checkRunnerPids` in manager.mjs).
 */
export function settleRun(runId) {
  SETTLED.add(runId);
  PID_NOT_ITS_RUNNER.add(runId);
}
/**
 * Runs whose pid the OS proved is another process now (`settleRun`), kept apart from SETTLED: a status
 * file `liveRuns` could not read mid-write is settled there too, and that is no proof its runner is gone.
 */
const PID_NOT_ITS_RUNNER = new Set();

/** Why a wave whose runner went without saying so reads as stopped (the Manager, `sue status`, the tray). */
export const RUNNER_GONE_WHY = "Sue closed before this wave finished.";

/**
 * Whether a run whose record still says "starting" or "running" has no runner any more: its pid is no
 * process (or none at all), the Manager caught that pid handed to another process (`settleRun`), or it
 * never got past "starting". The one answer `liveRuns` gives, for any one run and however old it is.
 */
export function runnerGone(runId, status = readJson(statusFile(runId)) ?? {}, now = Date.now()) {
  if (status.state === "running") return PID_NOT_ITS_RUNNER.has(runId) || !pidAlive(status.pid);
  if (status.state === "starting") return !(now - Date.parse(status.at ?? "") < STARTING_STALE_MS);
  return false;
}

/**
 * Every run's people file whose run is no longer alive, deleted: the runner deletes its own when the run ends, but a stop
 * kills it before its `finally`, and a crash or a reboot never reaches one. Swept whenever a run starts and whenever one
 * is stopped, so no person outlives the run that sent her on this disk (Owner, 2026-09-28: every person lives in
 * Connections). A file with no status yet is a run between writing it and recording that it is starting, and is kept
 * while its id is younger than STARTING_STALE_MS. Returns the run ids swept.
 */
export function sweepPeopleFiles(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(mcpDir());
  } catch {
    return [];
  }
  const swept = [];
  const targetDirs = new Set();
  for (const name of names) {
    const runId = /^(\d{8}-\d{6}-[0-9a-f]{4})\.(people|spec)\.json$/.exec(name)?.[1];
    if (!runId) continue;
    if (name.endsWith(".spec.json")) {
      const copy = readJson(path.join(mcpDir(), name))?.runTargetFile;
      if (typeof copy === "string") targetDirs.add(path.dirname(copy));
      continue;
    }
    if (runIsAlive(runId, now)) continue;
    fs.rmSync(path.join(mcpDir(), name), { force: true });
    swept.push(runId);
  }
  for (const dir of targetDirs) sweepTargetLeftovers(dir, now);
  return swept;
}

/** Whether a run still has a runner, or is between writing its files and recording that it is starting. */
function runIsAlive(runId, now) {
  const status = readJson(statusFile(runId));
  return status
    ? (status.state === "running" || status.state === "starting") && !runnerGone(runId, status, now)
    : now - runStartedAt(runId) < STARTING_STALE_MS;
}

/** A `<file>.<pid>.tmp` is a writer's own temp, gone when its pid is dead or when it is older than an hour. */
const TEMP_STALE_MS = 60 * 60 * 1000;

/**
 * In a folder holding page targets: the `run.<runId>.target.json` copies of runs that are no longer running (a stop kills
 * the runner before its `finally`) and the `<file>.<pid>.tmp` files a writer died holding.
 */
function sweepTargetLeftovers(dir, now) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    const file = path.join(dir, name);
    const copyOf = /^run\.(\d{8}-\d{6}-[0-9a-f]{4})\.target\.json$/.exec(name)?.[1];
    if (copyOf) {
      if (!runIsAlive(copyOf, now)) fs.rmSync(file, { force: true });
      continue;
    }
    const pid = /\.json\.(\d+)\.tmp$/.exec(name)?.[1];
    if (!pid) continue;
    let age;
    try {
      age = now - fs.statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (!pidAlive(Number(pid)) || age > TEMP_STALE_MS) fs.rmSync(file, { force: true });
  }
}

/**
 * A "running" record whose runner is provably gone (its pid dead, or its pid's creation time not the
 * runner's: `runnerGone`) is written down as stopped, so every reader agrees it ended: `sue status`,
 * the tray, the Manager after a restart. A "starting" record has no pid to prove anything by and is
 * left as it is. Best-effort: a write Windows refuses is tried again the next time. Returns whether it wrote.
 */
export function endGoneRun(runId, finishedAt = new Date().toISOString()) {
  const status = readJson(statusFile(runId));
  if (status?.state !== "running" || !status.pid || !runnerGone(runId, status)) return false;
  try {
    writeJson(statusFile(runId), { ...status, state: "stopped", why: [RUNNER_GONE_WHY], finishedAt });
    return true;
  } catch {
    return false;
  }
}

/**
 * Windows reuses pids, so `pidAlive` alone cannot say that the process holding a run's pid IS that
 * run: a finished run keeps its runner's pid in the status file, and once the OS hands that number
 * to somebody else, taskkill /T /F would take out a stranger's whole tree (2026-09-22 review). So
 * the runner records its OWN process creation time (Win32_Process CreationDate, as filetime ticks)
 * beside the pid, and `stopRun` refuses a pid whose creation time no longer matches. null means
 * "not knowable here" (any non-Windows platform), and then that check is simply skipped.
 */
function pidCreatedAt(pid, timeoutMs = 5000) {
  const n = Number(pid);
  if (process.platform !== "win32" || !Number.isInteger(n) || n <= 0) return null;
  try {
    const out = spawnSync(
      "powershell",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `(Get-CimInstance Win32_Process -Filter "ProcessId=${n}").CreationDate.ToFileTimeUtc()`,
      ],
      { windowsHide: true, encoding: "utf8", timeout: timeoutMs },
    );
    const ticks = Number(String(out.stdout ?? "").trim());
    return Number.isFinite(ticks) && ticks > 0 ? ticks : null;
  } catch {
    return null;
  }
}

/** 1601-01-01 (a Windows file time's zero) in epoch ms: file-time ticks / 10 000 - this = epoch ms. */
const FILETIME_EPOCH_MS = 11_644_473_600_000;

// ── run ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Which people go, the first of these that has anyone:
 * - the ones named (`requested`);
 * - a cast (`cast`: whole persona documents, lib/cast.mjs; Dredd casts one from the ask and the page);
 * - the visitor the intent names ("I'm a party planner looking for ..."), cast from its own words
 *   (castFromAsk): an ask that says who the visitor is gets that visitor, never the workspace's
 *   saved people (a party-planner hearing on sullivanfantastic.com sent this workspace's WhatsApp
 *   deal-group broker and wholesaler, runs 20260925-185445-29ca and 20260925-185450-21ed);
 * - this workspace's own that were written for `url`'s site (lib/workspace.mjs `writtenFor`: a saved
 *   persona's `for` hosts); on somebody else's live site (`live`) only one whose `for` names it;
 * - else one of each roster kind.
 * `cast` in the answer is the persona documents a run carries inline (target.cast), `skipped` names
 * the saved people left home, and `said` is the one line the run reply carries about where the
 * people came from.
 */
export function pickPersonas(ws, requested, url = null, { cast = null, intent = "", live = false, count = CAST_MAX, ape = false } = {}) {
  const everyone = listWorkspacePersonas(ws);
  const own = everyone.map((p) => p.id);
  // A workspace's copy of a built-in (edit_persona) is that built-in with a change: she goes where the built-in goes
  // (the roster mix, or by name), never as one of the folder's own people in place of the whole mix.
  const saved = everyone.filter((p) => !p.builtInCopy);
  const roster = listPersonas();
  const named = namedPersonas(requested);
  if (named) {
    // A named person may also be a cast visitor the caller sent whole: a Boardroom person the `sue` door found
    // by her name (lib/boardroom-cast.mjs) rides the run inline beside this folder's people and the roster's.
    const docs = cast != null ? castDocs(cast, roster) : [];
    const castIds = docs.map((p) => p.id);
    const unknown = named.filter((id) => !own.includes(id) && !roster.includes(id) && !castIds.includes(id));
    if (ape) {
      const low = named.filter((id) => (techProwessOf(id, docs) ?? 0) < APE_MIN_TECH);
      if (low.length)
        refuse(
          `${low.map((id) => `${id} (comfort with computers ${techProwessOf(id, docs) ?? "unknown"}/5)`).join(", ")}: an APE run seats power users only, comfort with computers 4 or 5. Name a power user, or name nobody and the run casts them`,
        );
    }
    if (unknown.length)
      refuse(
        `no persona named ${unknown.join(", ")}. This workspace has: ${own.join(", ") || "none yet"}; the roster has: ${roster.join(", ")}; ` +
          `a person in the workspace's Boardroom is found by her name too, when this run fetched its own people`,
      );
    const riding = docs.filter((p) => named.includes(p.id));
    return riding.length ? { ids: named, source: "named", cast: riding } : { ids: named, source: "named" };
  }
  if (cast != null) {
    let docs = castDocs(cast, roster);
    if (ape) {
      const low = docs.filter((p) => (techProwessOf(p.id, docs) ?? 0) < APE_MIN_TECH);
      if (low.length)
        refuse(
          `cast: ${low.map((p) => `${p.id} is not a power user (comfort with computers ${techProwessOf(p.id, docs) ?? "unknown"}/5)`).join("; ")}; an APE run seats comfort 4 or 5 only`,
        );
    }
    return {
      ids: docs.map((p) => p.id),
      source: "cast",
      cast: docs,
      said: `Cast for this page from the ask: ${docs.map((p) => `${p.id} ("${p.voice.slice(0, 90)}...")`).join("; ")}.`,
    };
  }
  let fromAsk;
  try {
    fromAsk = castFromAsk(intent, { url, count: Math.min(count, CAST_MAX), ape });
  } catch (err) {
    refuse(`the visitor this intent names could not be cast: ${String(err?.message ?? err)}`);
  }
  if (fromAsk?.length)
    return {
      ids: fromAsk.map((p) => p.id),
      source: "ask",
      cast: fromAsk,
      said: `The intent says who the visitor is, so every Sue is that person: "${fromAsk[0].voice.slice(0, 120)}..."`,
    };
  const isPower = (id) => !ape || (techProwessOf(id) ?? 0) >= APE_MIN_TECH;
  const fits = (url ? saved.filter((p) => writtenFor(p, url) && (!live || p.for)) : saved).filter((p) => isPower(p.id));
  const skipped = saved.filter((p) => !fits.includes(p));
  // A person who names no site is left home only on somebody else's live site, so her line says that instead of a
  // host list she does not have (NEWProjects' docket on mail.example.net, 2026-09-29: `p.for.join` on null).
  const whyHome = (p) =>
    !isPower(p.id)
      ? `not a power user, comfort with computers ${techProwessOf(p.id) ?? "unknown"}/5`
      : p.for
        ? `written for ${[p.for].flat().join(", ")}`
        : "written for no site, and this is someone else's live site";
  const leftHome = skipped.length ? ` Left home: ${skipped.map((p) => `${p.id} (${whyHome(p)})`).join(", ")}.` : "";
  if (fits.length)
    return {
      ids: fits.map((p) => p.id),
      source: "workspace",
      ...(skipped.length ? { skipped: skipped.map((p) => p.id) } : {}),
      said:
        `These are this folder's saved people, each with the story in her own voice (e.g. ${fits[0].id}: "${fits[0].voice.slice(0, 120)}..."). ` +
        `If that story is not why someone visits this page, name people with personas instead.${leftHome}`,
    };
  // An APE run casts its roster mix from the power users only: the mix's own when it has any, else the roster's.
  const mix = DEFAULT_ROSTER_MIX.filter((id) => roster.includes(id) && isPower(id));
  return {
    ids: ape && !mix.length ? roster.filter((id) => isPower(id)).slice(0, CAST_MAX) : mix,
    source: "roster",
    ...(skipped.length ? { skipped: skipped.map((p) => p.id), said: `One of each roster kind.${leftHome}` } : {}),
  };
}

/**
 * The people a caller named, as a list, or null when nobody was named. The cannon's
 * `--personas a,b` string and the MCP's array are the same request: run 20260926-090226-fa73 was
 * asked for "grandma,low-attention" and sent the roster mix, because a string fell through as
 * "nobody named". Anything that is neither is refused rather than read as nobody.
 */
function namedPersonas(requested) {
  if (requested == null) return null;
  if (typeof requested === "string") requested = requested.split(",");
  if (!Array.isArray(requested))
    refuse(`personas is a list of persona ids, or one comma-separated string of them (got ${typeof requested})`);
  const ids = requested.map((id) => String(id).trim()).filter(Boolean);
  return ids.length ? ids : null;
}

/**
 * `art: true` (the design review, sue/README.md#art) or not set. It is another instrument from APE and from an ad viewer,
 * so a run that says both is refused, and so is a run whose `art` is anything but a boolean.
 */
function artOf(args) {
  const art = args.art ?? null;
  if (art != null && art !== true && art !== false) refuse(`art is true or not set (got ${JSON.stringify(art)})`);
  if (art === true && args.ape != null && args.ape !== false)
    refuse(
      "art and ape are different instruments: an art run is a design review, an ape run is a power user's visit. Send one or the other",
    );
  if (art === true && args.watches === "ad")
    refuse('an art run is a design review of the product, not an ad viewer: watches "ad" cannot be art');
  if (art === true && args.cast != null)
    refuse(
      "art and a cast are different instruments: an art run seats the design team only, a cast visitor is not a designer. Send the cast in its own run",
    );
  return art === true;
}

/**
 * The design team an art run seats: the people the caller named, else ART_TEAM. Each must be an ART designer (a critic whose
 * studio is "art"), refused by name otherwise; an art run never seats anyone else.
 */
export function artSeats(requested) {
  const ids = namedPersonas(requested) ?? [...ART_TEAM];
  const notArt = ids.filter((id) => !isArtPersonaId(id));
  if (notArt.length)
    refuse(
      `${notArt.join(", ")}: not an ART designer (a critic whose studio is "art"). An art run seats the design team only: name designers, or name nobody and it seats ${ART_TEAM.join(", ")}`,
    );
  return ids;
}

/** An art run's count: one visit per designer it seats (the whole team by default); a count above that is refused. */
export function artCount(requested, seated) {
  if (requested == null) return seated;
  const count = Math.trunc(Number(requested));
  if (!Number.isFinite(count) || count < 1) refuse(`count must be 1 or more for an art run (got ${JSON.stringify(requested)})`);
  if (count > seated)
    refuse(
      `count ${count} is above the ${seated} designer${seated === 1 ? "" : "s"} this art run seats (the team is ${ART_TEAM.length}); send the rest in another run`,
    );
  return count;
}

/**
 * A caller's cast, checked: 1 to CAST_MAX persona documents with their own slug ids, none of them a
 * roster persona's id (her journal and the report would mix the two people). Whether each one LOADS is
 * checked in planRun, through the same loader the cannon uses, once the target carries them.
 */
function castDocs(cast, roster) {
  if (!Array.isArray(cast) || !cast.length || cast.length > CAST_MAX)
    refuse(`cast is a list of 1 to ${CAST_MAX} visitors, each a whole persona ({ id, displayName, extends, voice, errands })`);
  const seen = new Set();
  for (const p of cast) {
    const id = String(p?.id ?? "");
    if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) refuse(`cast: "${id}" is not a short slug like party-planner-dana`);
    if (roster.includes(id)) refuse(`cast: "${id}" is a roster persona's id; a cast visitor needs her own`);
    if (seen.has(id)) refuse(`cast: "${id}" is in the cast twice`);
    seen.add(id);
  }
  return cast.map((p) => ({ ...p }));
}

/**
 * Which people a ROSTER ERRAND sends: the ones named, else the target's own (a product folder like
 * targets/deal-flow keeps its people beside its target.json), else one of each roster kind. Never
 * this workspace's saved people: they load only through a target that lives in this workspace's
 * store, and a roster target cannot see them (2026-09-24: every errand on "connections" from a
 * folder holding the Deal Flow seven died in the cannon on `no persona "angel-priya"`).
 */
export function pickErrandPersonas(target, requested) {
  // A target names the people it was written for (`people`, their ids in Connections), never a folder of them.
  const own = Array.isArray(target?.people) ? target.people.filter((id) => typeof id === "string").sort() : [];
  const roster = listPersonas();
  const named = namedPersonas(requested);
  if (named) {
    const unknown = named.filter((id) => !own.includes(id) && !roster.includes(id));
    if (unknown.length)
      refuse(
        `no persona named ${unknown.join(", ")} that target "${target?.id}" can send. Its own: ${own.join(", ") || "none"}; the built-ins are: ${roster.join(", ")}`,
      );
    return { ids: named, source: "named" };
  }
  if (own.length) return { ids: own, source: "target" };
  return { ids: DEFAULT_ROSTER_MIX.filter((id) => roster.includes(id)), source: "roster" };
}

export function planRun(args) {
  const art = artOf(args);
  if (args.target || args.scenario) {
    // A roster errand's fixed personas cannot honour APE's cast rule (comfort with computers 4-5), so an ape run never takes one.
    if (args.ape != null && args.ape !== false) refuse("ape runs take a url and an intent, not a roster errand (target/scenario)");
    return planErrand({ ...args, art });
  }
  const ws = workspaceRoot(args.workspace);
  const url = String(args.url ?? "").trim();
  if (!url) refuse("url is required: the page these people are trying to use");
  try {
    new URL(url);
  } catch {
    refuse(`url "${url}" is not a web address`);
  }
  // Something a person gave the group (lib/material.mjs) is a document she was sent to look at: no
  // account to make and no company to write to unless the caller says so, and opened as it is.
  const material = materialIdFrom(url) !== null;
  if (material && args.start === "home") refuse('start: a file or an idea has no front page; leave start as "link"');
  const givenIntent = String(args.intent ?? "").trim() || (material ? MATERIAL_INTENT : "");
  const intent = material && args.materialSeveralPages !== false ? `${givenIntent} ${MATERIAL_PAGES}` : givenIntent;
  if (intent.length < MIN_ERRAND_CHARS)
    refuse(
      `intent is required: one whole sentence (${MIN_ERRAND_CHARS}+ characters) on why these people are here, e.g. "a friend posted this link in his WhatsApp group; you want to post your deals there"`,
    );
  // `expect`: one short line on what the page is meant to be; every Sue is told it (lib/workspace.mjs intentScenario).
  let expect = "";
  try {
    expect = expectOf(args.expect);
  } catch (err) {
    refuse(String(err?.message ?? err));
  }
  // `watches: "ad"`: an ad viewer, asked the ad questions instead of the website's (lib/findings.mjs AD_QUESTIONS).
  const watches = args.watches ?? null;
  if (watches != null && watches !== "ad") refuse(`watches is "ad" or not set (got ${JSON.stringify(watches)})`);
  // `ape: true`: a familiar power user, not a stranger (lib/findings.mjs APE_QUESTIONS). Seated only from comfort with computers 4 or 5.
  const ape = args.ape ?? null;
  if (ape != null && ape !== true && ape !== false) refuse(`ape is true or not set (got ${JSON.stringify(ape)})`);
  // An art run seats its designers from ART_TEAM (or the names given), one visit each by default (artSeats, artCount).
  const seats = art ? artSeats(args.personas) : null;
  const count = art ? artCount(args.count, seats.length) : runCount(args);
  ensureStore(ws);
  // `owned`: the caller says whose site this is; the page's target file keeps it, and an owned site's
  // hosts carry the Connections sign-in and checkout it hands off to (lib/workspace.mjs allowedHostsFor).
  if (args.owned != null && typeof args.owned !== "boolean")
    refuse("owned is true (this website is yours) or false (it is somebody else's live website)");
  // This workspace's own websites came with the args, read once for the whole run (lib/owned-sites.mjs). A site on
  // them gets the owned site's hosts too, unless the page's own target says otherwise.
  const ownedSites = Array.isArray(args.ownedSites) ? args.ownedSites : [];
  const { file: targetFile, target } = deriveTarget({
    ws,
    url,
    start: args.start ?? "link",
    groundTruth: args.groundTruth ?? null,
    arrival: args.arrival ?? null,
    decoys: args.decoys === true,
    owned: args.owned ?? null,
    listed: onListedSite(url, ownedSites),
  });
  // Somebody else's live website (lib/site-owner.mjs): a sent form reaches a real person there, so no
  // Sue makes an account or writes to them, and asking for either is refused rather than ignored. A
  // login a human lent for the run (`profile`, `as`) is theirs to act in, under the borrowed rails.
  const live = !args.profile && !args.as && !isOwnedSite(url, target, ownedSites);
  if (live) target.liveSite = true;
  else delete target.liveSite;
  if (live && (args.createAccounts === true || args.contactSupport === true))
    refuse(
      `${new URL(url).hostname} is somebody else's live website, so no Sue makes an account or contacts them there: a sent form reaches a real person. If this website is yours, say owned: true, and it is added to this workspace's websites, so every later run knows`,
    );
  // An owned site that is live all the same (nexascode.com, the owner's own game, 2026-09-28) says `createAccounts: false`
  // on its target: free hands in it, and no account made on it, whoever asks.
  const noAccountsHere = target.createAccounts === false;
  if (noAccountsHere && args.createAccounts === true)
    refuse(`${new URL(url).hostname}: its target says createAccounts false, so a Sue makes no account there`);
  const createAccounts = !live && !noAccountsHere && (material ? args.createAccounts === true : args.createAccounts !== false);
  // Support is OPT-IN on Connections' own sites (Owner, 2026-09-30, the flat $200 AWS bill): our bubble and
  // the account assistant answer on GLM 5 at our cost, and SUE runs were nearly all of that bill (2026-09-28:
  // 632 model steps, about $3 in a day; the day with no SUE run on our sites, $0). A run that is testing
  // support says `contactSupport: true`; every other Sue there is told not to contact us.
  const supportOptIn = material || onConnectionsSite(url);
  const contactSupport = !live && (supportOptIn ? args.contactSupport === true : args.contactSupport !== false);
  // No pre-sue cast for a design review: its seats are the designers, and nobody is cast from the ask (wantsPresue).
  let personas = art
    ? { ids: seats, source: "art" }
    : pickPersonas(ws, args.personas, url, { cast: args.cast ?? null, intent, live, count, ape: ape === true });
  // A local brain answers a prompt longer than its loaded context with a 500, so a persona whose prompt would not fit
  // is replaced by the next cast visitor who does (lib/context-fit.mjs), and the skip is kept on the run.
  const contextSkips = [];
  if (Number.isFinite(args.brainContextTokens)) {
    const minds = pinCriticMinds({ ...target }, personas.ids).minds ?? {};
    const mindBytesOf = (id) => Buffer.byteLength(mindText({ id }, { minds }) ?? "", "utf8");
    // An art run never swaps a designer for a cast visitor (a non-designer): a designer who does not fit is refused by name.
    if (art) {
      const overflow = personas.ids
        .map((id) => ({ id, tokens: promptTokenEstimate(mindBytesOf(id)) }))
        .filter((p) => p.tokens > args.brainContextTokens);
      if (overflow.length)
        refuse(
          overflow
            .map((p) => `${p.id}: her prompt is about ${p.tokens} tokens and the local brain has ${args.brainContextTokens} loaded`)
            .join("; ") +
            ". An art run seats designers only, so it is refused rather than seated with a non-designer in her place; load a larger context",
        );
    }
    const castCandidates = art ? [] : (castFromAsk(intent, { url, count: CAST_MAX }) ?? []);
    const seated = seatWithinContext({ ids: personas.ids, castCandidates, mindBytesOf, contextTokens: args.brainContextTokens });
    if (seated.skips.length) {
      contextSkips.push(...seated.skips);
      const cast = seated.ids
        .map((id) => personas.cast?.find((p) => p.id === id) ?? castCandidates.find((p) => p.id === id))
        .filter(Boolean);
      personas = { ...personas, ids: seated.ids, cast: cast.length ? cast : null };
    }
  }
  // A cast rides inline on this page's target (lib/personas.mjs loadPersona reads `target.cast`), never
  // in the workspace's personas folder: it was written for one ask on one page.
  if (personas.cast) target.cast = Object.fromEntries(personas.cast.map((p) => [p.id, p]));
  else delete target.cast;
  // Every person in this run is here for THIS reason, a cast visitor for her own. The target carries
  // it too, because a workspace persona saved without errands of her own is only loadable once
  // somebody says why she came (lib/personas.mjs loadPersona validates before the scenario's errands apply).
  const errandOfId = (id) => personas.cast?.find((p) => p.id === id)?.errands ?? [intent];
  target.errands = Object.fromEntries(personas.ids.map((id) => [id, errandOfId(id)]));
  // Only a cast visitor is checked here: she lives on the target. A named run may carry this folder's people
  // and the roster's beside her, and those load from their own files when the run starts.
  for (const id of (personas.cast ?? []).map((p) => p.id)) {
    try {
      loadPersona(id, { target });
    } catch (err) {
      refuse(`cast: ${String(err?.message ?? err)}`);
    }
  }
  // A critic's mind lives in Connections and came down with this process's people; the cannon pins it on the run's
  // target when it starts (lib/personas.mjs pinCriticMinds). A critic with no mind, or one over the cap, is refused
  // now, before a Sue number is spent. The text never goes into the page's target file: a mind lives in Connections.
  const pinned = pinCriticMinds({ ...target }, personas.ids);
  for (const id of personas.ids.filter((id) => isCriticPersona(id, pinned))) {
    try {
      loadPersona(id, { target: pinned });
    } catch (err) {
      refuse(String(err?.message ?? err));
    }
  }
  writeJson(targetFile, target);
  // The page's file is shared by every run on its page section, so a run planned a second later rewrites this run's
  // errands and cast before its detached cannon reads them back (2026-10-03: two of eight side-by-side runs refused,
  // "errands missing"). The cannon reads THIS run's own copy, beside the page's file so `home` and `extends` resolve
  // the same; its `pageFile` points write-backs at the page's file. The runner deletes it when the run ends.
  const runId = args.runId ?? newRunId();
  const runTargetFile = path.join(path.dirname(targetFile), `run.${runId}.target.json`);
  writeJson(runTargetFile, { ...target, pageFile: targetFile });
  const { id: scenarioId } = intentScenario({
    ws,
    intent,
    createAccounts,
    contactSupport,
    inbox: args.inbox === true,
    goal: args.goal ?? null,
    liveSite: live,
    errands: personas.cast ? Object.fromEntries(personas.ids.map((id) => [id, errandOfId(id)])) : null,
    legs: args.legs ?? 1,
    interview: args.interview ?? null,
    expect,
    watches,
    ape,
    art,
  });
  const maxAccounts = createAccounts ? Math.max(Number(args.maxAccounts ?? 0) || 0, count) : 0;
  return {
    ws,
    runId,
    url,
    intent,
    ...(expect ? { expect } : {}),
    ...(args.arrival ? { arrivalKey: `${contentHashOf(args.arrival)}:${args.arrival.audience ?? ""}` } : {}),
    count,
    personas: personas.ids,
    personaSource: personas.source,
    ...(personas.said ? { personaSaid: personas.said } : {}),
    ...(Number.isFinite(args.brainContextTokens) ? { brainContextTokens: args.brainContextTokens } : {}),
    ...(contextSkips.length ? { contextSkips } : {}),
    ...(live
      ? {
          siteSaid: `${new URL(url).hostname} is somebody else's live website: no Sue makes an account or contacts them, every Sue stops at the Send button and says in her exit interview what she would have sent. If it is yours, say owned: true, and it is added to this workspace's websites, so every later run knows.`,
        }
      : {}),
    targetFile,
    runTargetFile,
    // Where THIS run starts. The page's target file is shared by every link on its first path segment
    // (lib/workspace.mjs pageKey), so parallel runs on /go/22 and /go/33 rewrite one file and the cannon
    // must not read its start back from it: all three of 2026-09-25's make-up visits opened /go/33.
    startUrl: target.startUrl,
    page: target.page,
    scenarioId,
    createAccounts,
    maxAccounts,
    ...runDials(args, url),
  };
}

/** How many Sues, 1 to MAX_COUNT (default 5); a focus group seats 1 to FOCUS_GROUP_MAX (default FOCUS_GROUP_DEFAULT). */
function runCount(args) {
  if (args.focusGroup === true) {
    const seats = Math.trunc(Number(args.count ?? FOCUS_GROUP_DEFAULT));
    if (!Number.isFinite(seats) || seats < 1 || seats > FOCUS_GROUP_MAX)
      refuse(`a focus group seats 1 to ${FOCUS_GROUP_MAX} people at one table (count ${args.count}): send the rest in the next group`);
    return seats;
  }
  const count = Math.trunc(Number(args.count ?? 5));
  if (!Number.isFinite(count) || count < 1 || count > MAX_COUNT) refuse(`count must be 1 to ${MAX_COUNT}`);
  return count;
}

/**
 * A ROSTER ERRAND, `{ target, scenario, personas }`: a hand-written target (a roster slug like
 * "connections" or a target file) and one of its scenarios, used as written - the multi-leg errands
 * launch-waves.ps1 sends. It goes through the same run record as a link-and-sentence run, so the Sue
 * Manager, status, report and stop see it (lib/door.mjs: the cannon starts no other way).
 */
/**
 * Where a roster errand starts: the target's own start page, or `startUrl` when the errand names one (a Dredd charter
 * opens on the route its branch changed, dredd/lib/charters.mjs). A named one is a whole http(s) address on a host
 * the target allows, else it is refused: a Sue never starts somewhere her rails would not let her walk to.
 */
function errandStartUrl(target, startUrl) {
  if (startUrl == null || startUrl === "") return target.startUrl;
  let parsed;
  try {
    parsed = new URL(String(startUrl));
  } catch {
    refuse(`startUrl "${startUrl}" is not a web address`);
  }
  if (!/^https?:$/.test(parsed.protocol) || !hostAllowed(parsed.hostname, target.allowedHosts ?? []))
    refuse(`startUrl ${parsed.href} is not on a host target "${target.id}" allows: ${(target.allowedHosts ?? []).join(", ")}`);
  return parsed.href;
}

function planErrand(args) {
  if (!args.target || !args.scenario)
    refuse("a roster errand names both target (a roster slug or a target file) and scenario (one of its errands)");
  const ws = workspaceRoot(args.workspace);
  let target;
  let scenario;
  try {
    target = loadTarget(String(args.target));
    scenario = loadScenario(String(args.scenario), { target });
  } catch (err) {
    refuse(String(err?.message ?? err));
  }
  ensureStore(ws);
  // An art errand seats the design team (artSeats), one visit each by default; a roster errand's own people otherwise.
  const art = args.art === true;
  const personas = art ? { ids: artSeats(args.personas) } : pickErrandPersonas(target, args.personas);
  const count = art
    ? artCount(args.count, personas.ids.length)
    : runCount({
        count: args.count ?? (args.focusGroup === true ? undefined : personas.ids.length + sampledCount(args)),
        focusGroup: args.focusGroup,
      });
  const url = errandStartUrl(target, args.startUrl);
  return {
    ws,
    runId: args.runId ?? newRunId(),
    url,
    // Named only when the errand starts somewhere of its own (a Dredd charter's route), so the cannon is told it.
    ...(url !== target.startUrl ? { startUrl: url } : {}),
    intent: String(scenario.title ?? scenario.id ?? args.scenario),
    count,
    personas: personas.ids,
    personaSource: personas.source,
    targetFile: target.file ?? String(args.target),
    page: { url, key: pageKey(url), start: "link" },
    scenarioId: String(args.scenario),
    createAccounts: scenario.createsAccount === true,
    // The cannon's own cap unless the caller names one: a nonstop wave is not capped at one round.
    maxAccounts: Number(args.maxAccounts) > 0 ? Number(args.maxAccounts) : null,
    ...runDials(args, url),
  };
}

/** How many sampled visitors, 0 (default) to MAX_COUNT; refused by name rather than clamped. */
function sampledCount(args) {
  if (args.sampled == null) return 0;
  const n = Math.trunc(Number(args.sampled));
  if (!Number.isFinite(n) || n < 0 || n > MAX_COUNT) refuse(`sampled must be 0 to ${MAX_COUNT}`);
  return n;
}

/** A saved login's name, refused here (not later in the runner's log) when there is none or the page is ours. */
function savedLoginName(args, url) {
  if (!args.profile) return null;
  if (args.as) refuse("as and profile each name a sign-in; a wave arrives with one");
  if (onConnectionsSite(url))
    refuse("a saved login is never used on Connections' own sites: every Sue there makes her own account through the real sign-up");
  let name;
  try {
    name = assertProfileName(args.profile);
  } catch (err) {
    refuse(String(err?.message ?? err));
  }
  if (!readProfile(name))
    refuse(
      `no saved login named "${name}" on this computer. Add it under Logins in Sue's Settings (the gear beside your picture), then name it here (action "profiles" lists them)`,
    );
  return name;
}

/**
 * A focus group's own dials, only on a focus group (a plain run's spec is unchanged): the caller's
 * guesses the moderator puts to the table after the room has spoken, and whether there is a moderator
 * at all ("none": the vote decides). One room agrees once, so it is never a nonstop wave.
 */
function focusDials(args) {
  if (args.focusGroup !== true) return {};
  if (args.forever === true)
    refuse("a focus group is one room that agrees on one problem: drop forever and send the next group after you fix it");
  const moderator = args.moderator ?? "ai";
  if (!["ai", "none"].includes(moderator))
    refuse(`moderator is "ai" (an AI runs the room, the default) or "none" (the vote decides), not "${moderator}"`);
  const raw = args.suggestions ?? [];
  if (!Array.isArray(raw) && typeof raw !== "string") refuse("suggestions is a list of your own guesses, each one sentence");
  const suggestions = (Array.isArray(raw) ? raw : [raw]).map((s) => String(s ?? "").trim()).filter(Boolean);
  return { focusGroup: true, suggestions, moderator };
}

function maxMinutesOf(raw) {
  if (raw == null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) refuse("maxMinutes must be a whole number of minutes (0 = no cap)");
  return n;
}

/** What both kinds of run share: the wave's size, brain and sign-in. */
function runDials(args, url) {
  return {
    ...focusDials(args),
    concurrency: args.concurrency ?? "auto",
    // `forever`: a nonstop wave (the cannon's --forever), batch after batch until stopped.
    forever: args.forever === true,
    // `maxMinutes`: no Sue starts after this many minutes (the cannon's --max-minutes; 0 = no cap).
    // Unset keeps the cannon's own cap (cannon.mjs runMaxMinutes).
    maxMinutes: maxMinutesOf(args.maxMinutes),
    // `sampled`: how many visitors the cannon DRAWS from word lists (its --sampled, lib/personas.mjs
    // synthesizePersona) beside the named personas, so a wave meets more than the roster's 20 people.
    sampled: sampledCount(args),
    // A saved login from the Sue Manager's Logins tab (the cannon's --profile, lib/profiles.mjs):
    // every Sue arrives signed in to that site, Discord for an app that signs in with it.
    profile: savedLoginName(args, url),
    // Which model thinks for every Sue in the run (the cannon's --model; it refuses a Haiku brain).
    // Unset keeps the cannon's default, so a caller that never names one sees no change.
    model: args.model ? String(args.model).trim() : null,
    // A session a human saved once with login.mjs or login-chrome.mjs (the cannon's --as): every Sue
    // in the run arrives signed in with it. The cannon refuses it on a site she can sign up to herself.
    as: args.as ? String(args.as).trim() : null,
    // The workspace (project) the run was launched from, recorded in the manifest so `sue analytics` reads its ARGUS site.
    projectId: args.project ? String(args.project).trim() : null,
    // "chat" (the DEFAULT): no CLI brain and no login of the tool's; the AI that asked (Claude, Codex,
    // ChatGPT, anything with a shell) drives every Sue with its own agents through hand.mjs, so the run
    // spends that AI's usage and nobody else's. Owner, 2026-09-22: Sue must not be "CLI dependent nor
    // even CLI preferred". the Chair, 2026-09-23: no CLI logins either - the CLI brain runs only on an
    // API key pool ("deepseek" or "openrouter", never a subscription login), named explicitly or set
    // through SUE_BRAIN, which is how DREDD's unattended hearings, with no chat to drive them, keep it.
    // A machine that names its brains (lib/claude-cli.mjs sueBrainPolicy) refuses any other here, before a run exists.
    brain: allowedBrain(args.brain ? String(args.brain).trim() : process.env.SUE_BRAIN?.trim() || "chat"),
    // A recorded tape folder (tape/FORMAT.md) the Sues visit with no browser (the cannon's --tape). An empty or missing
    // folder is allowed (owner, 2026-10-03: the tape fills as students reach screens, never crawled up front), so it is made.
    tape: tapeFolder(args),
    // "climayte": SUE sends each chat-brain Sue to AgentHydra's CliMayte as ONE sealed task itself (the cannon's
    // --dispatch, lib/climayte-dispatch.mjs), so one call gets driven visitors. Unset, the run's `next` tells the caller
    // the same sealed task to send (Owner, 2026-10-06: no chat runs a Sue the expensive way again).
    dispatch: dispatchOf(args),
    reading: readingOf(args),
  };
}

function readingOf(args) {
  try {
    return readingModeOf(args.reading);
  } catch (err) {
    refuse(err.message);
  }
}

/** The brain a run's args ask for, as runDials resolves it: "chat" unless named or set through SUE_BRAIN. */
function chatBrainAsked(args) {
  return (args.brain ? String(args.brain).trim() : process.env.SUE_BRAIN?.trim() || "chat") === "chat";
}

function dispatchOf(args) {
  if (args.dispatch == null || args.dispatch === "" || args.dispatch === false) return null;
  if (args.dispatch !== "climayte")
    refuse(`dispatch is "climayte" (SUE sends each Sue to CliMayte sealed), got ${JSON.stringify(args.dispatch)}`);
  if (!chatBrainAsked(args)) refuse(`dispatch "climayte" sends chat-brain Sues; a key-pool brain has its own brains`);
  return "climayte";
}

/** The tape folder as an absolute path, made if it is not there yet; null when the run is live. */
function tapeFolder(args) {
  if (args.tape == null || args.tape === "") return null;
  const dir = path.resolve(String(args.tape));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function allowedBrain(brain) {
  try {
    return assertBrain(brain);
  } catch (err) {
    refuse(err.message);
  }
}

/** What a chat must do to drive a chat-brain run: the machine's pinned model, else Sonnet 5.5 - every Sue runs on it
 *  on every machine (Owner, 2026-10-05, replacing the 2026-09-23 Opus 5.5 ruling). The routing gate refuses a prompt that is
 *  only a brief path, so each agent's prompt carries SUE_BRAIN_REASON beside it (measured 2026-09-27). */
// 2026-09-26: an onboarding wave driven from one Workflow script handed every Sue the owner's memo ("every signup
// should end up paying"), because the Workflow harness gives each agent the user's latest message as its request.
const NOT_A_WORKFLOW =
  "Start them with the Agent tool, never from a Workflow script: a Workflow hands every agent your user's latest message, and a Sue who has read what the operator wants is no longer a stranger to the site.";

// Owner, 2026-09-28: the chat's own agents are preferred "if there's space" (Opus then, Sonnet 5.5 since 2026-10-05), and the zswarm may run them when there is not.
// A Postal Buddy focus group (2026-10-01) sent five Sues that way while the zswarm's Anthropic pool was saturated: none
// moved for 13 minutes and the run let them all go. So the fallback is checked, and has a fallback of its own.
const OUT_OF_SPACE =
  'Sonnet 5.5 agents of your own are preferred while your account has room: when agenthydra check_my_usage says safeToFanOut false, run the same briefs through hswarm_run instead (one task per Sue, tools "all", your absolute cwd, profile "critical", wait false) rather than spending the last of the account. Check it two minutes in: if hswarm_status shows waiting_on_rate_limited_pool or the Sues under quiet_running, or action "status" shows no Sue has made a first move, cancel that job (hswarm_cancel) and drive fewer Sues on your own agents instead (two or three, never Haiku or a pool model): a pool that never answers lets every Sue go after fifteen quiet minutes.';

// Run 20260928-133054-5e00: a critic's brief (her whole mind in it) was 167 KB, over what one Read returns, and her brain
// judged from its headings and one entry. Every brain reads all of it, in parts when one Read will not hold it.
const READ_WHOLE =
  "whole, to its last line, before her first move (a brief too long for one Read is read in parts, with offset and limit, until nothing is left)";

/** Hands a running chat-brain wave to SUE's own CliMayte dispatch (dispatch.mjs), written with forward slashes for any shell. */
const DISPATCH_CLI = path.join(HERE, "dispatch.mjs").split(path.sep).join("/");

/**
 * What a chat must do to drive a chat-brain run. Every Sue is ONE sealed CliMayte task (Owner, 2026-10-06): her brain
 * holds her system prompt and her hands and nothing else. `dispatched`: SUE already sends them (`dispatch: "climayte"`),
 * so the caller starts nothing. Else, while AgentHydra answers (`climayte.ready`), the caller sends them with
 * climayte_run, or hands the run to SUE with dispatch.mjs. Only when CliMayte is unavailable does the old path stand:
 * an agent of the caller's own per Sue reading her brief (6x the context and 5x the re-read tokens, measured 2026-10-06).
 */
export function chatBrainNext(
  policy = sueBrainPolicy(),
  { focusGroup = false, seats = null, runId = "<runId>", chatBrains = "chatBrains", climayte = null, dispatched = false } = {},
) {
  const room = focusGroup
    ? `${seats ?? "Every seat"} (every Sue, and the moderator, whose role says so) must be in the room together, so send them in one go once chatBrains lists all of them (the moderator has no \`sealed\` field: it goes as one ordinary task told to read its brief file whole and do what it says); `
    : "";
  const after = focusGroup
    ? 'Ask action "room" to hear them while they talk, and action "report" once they are done.'
    : 'Then ask action "report".';
  if (dispatched)
    return `SUE is sending every ${focusGroup ? "seat" : "Sue"} to CliMayte itself, each as ONE sealed task (group sue-${runId}) as she arrives: start no agent of your own for them. Each entry of chatBrains gains a \`climayte\` field naming her worker (climayte_status { group: "sue-${runId}" } shows them), or a \`dispatchError\` saying why she was not sent. A Sue nobody drives within an hour is let go and not counted. ${after}`;
  if (climayte?.ready)
    return `Nobody thinks for these Sues until you send them. ${room}Send each one to CliMayte as ONE sealed task, never as an agent of your own: \`node ${DISPATCH_CLI} ${runId}\` hands the run to SUE, which sends every Sue listed in chatBrains now and each later one as she arrives; or send them yourself, ${climayteRunCall({ runId, chatBrains })}. A sealed Sue's brain holds her system prompt and her hands and nothing else (6,000 tokens before her first move, against 38,700 for a brief-reading worker). A Sue nobody drives within an hour is let go and not counted. ${after}`;
  return `${climayte?.why ? `CliMayte is unavailable (${climayte.why}), so these Sues are driven the old way. ` : ""}${legacyChatBrainNext(policy, { focusGroup, seats })}`;
}

/** The brief-reading agents a chat sends when CliMayte cannot take its Sues: the machine's pinned model, else Sonnet 5.5. */
function legacyChatBrainNext(policy, { focusGroup, seats }) {
  // The Agent tool names a tier ("opus"), not a model id; a pinned id that names no tier is passed through as written.
  const model = policy?.model || SUE_DEFAULT_MODEL;
  const agentModel = ["opus", "fable", "sonnet"].find((t) => model.includes(t)) ?? model;
  // A focus group is a room: its people must be in it together, so the chat sends every agent in one
  // go, the moderator included, instead of pacing them five at a time.
  if (focusGroup)
    return `Nobody thinks for this focus group until you send them. Once chatBrains lists all ${seats ?? "of them"} (every Sue, and the moderator, whose role says so), start one agent of your own per entry there, the moderator included, ALL AT ONCE in one message: they must be in the room together. Tell each one only to read its brief file (by its full path) ${READ_WHOLE} and do what it says (each on ${model} (Agent model "${agentModel}"), preferred while there is room), with this line in its prompt, since the routing gate refuses a bare brief: ${SUE_BRAIN_REASON} ${NOT_A_WORKFLOW} ${OUT_OF_SPACE} A Sue nobody drives within an hour is let go and not counted. Ask action "room" to hear them while they talk, and action "report" once they are done.`;
  const tier = `each on ${model} (Agent model "${agentModel}"), preferred while there is room, at most five at a time`;
  return `Nobody thinks for these Sues until you send them. Once chatBrains exists, start one agent of your own per Sue listed there, each told only to read its brief file (by its full path) ${READ_WHOLE} and do what it says (${tier}), with this line in its prompt, since the routing gate refuses a bare brief: ${SUE_BRAIN_REASON} ${NOT_A_WORKFLOW} ${OUT_OF_SPACE} A Sue nobody drives within an hour is let go and not counted. Then ask action "report".`;
}

export function cannonArgs(spec) {
  const argv = [
    path.join(HERE, "cannon.mjs"),
    "--target",
    spec.runTargetFile ?? spec.targetFile,
    "--scenario",
    spec.scenarioId,
    "--personas",
    spec.personas.join(","),
    "--count",
    String(spec.count),
    "--run-id",
    spec.runId,
    "--concurrency",
    String(spec.concurrency),
  ];
  if (spec.startUrl) argv.push("--start-url", spec.startUrl);
  if (spec.peopleFile) argv.push("--people", spec.peopleFile);
  if (spec.maxAccounts) argv.push("--max-accounts", String(spec.maxAccounts));
  if (Number.isInteger(spec.maxMinutes)) argv.push("--max-minutes", String(spec.maxMinutes));
  if (spec.model) argv.push("--model", spec.model);
  if (spec.as) argv.push("--as", spec.as);
  if (spec.projectId) argv.push("--project-id", spec.projectId);
  if (spec.profile) argv.push("--profile", spec.profile);
  if (spec.forever) argv.push("--forever");
  if (spec.sampled) argv.push("--sampled", String(spec.sampled));
  if (spec.brain) argv.push("--brain", spec.brain);
  if (spec.focusGroup) argv.push("--focus-group");
  if (spec.tape) argv.push("--tape", spec.tape);
  if (spec.dispatch) argv.push("--dispatch", spec.dispatch);
  if (spec.reading) argv.push("--reading", spec.reading);
  return argv;
}

/**
 * Opens a focus group's room (lib/room.mjs) before a single Sue starts: the page, why they came, the
 * caller's guesses, whether there is a moderator, and the LAST verdict a focus group reached on this
 * same page, which the new moderator checks without telling the room (the fix loop).
 */
export function openFocusGroupRoom(spec) {
  const pageKey = spec.page?.key ?? null;
  return openRoom(runDir(spec.runId), {
    url: spec.url,
    page: pageKey,
    intent: spec.intent,
    suggestions: spec.suggestions ?? [],
    previous: pageKey ? lastVerdictFor(storeDir(spec.ws), pageKey) : null,
    moderator: spec.moderator,
  });
}

/**
 * Start a wave. `stage`, `collect` and `spawnRunner` are lib/engine-store.mjs's stageEngine and
 * collectInBackground and child_process's spawn, injectable so a spec starts nothing.
 */
const MAX_LIVE_RUNS_PER_PAGE = 3;

// The email or post that sends her is part of the launch: an A/B of two emails on one page is two runs, not a repeat.
const launchKey = (s) =>
  JSON.stringify([s.ws, s.url, s.intent, s.count, [...(s.personas ?? [])].sort(), s.arrivalKey ?? null]);

/** The live run this spec repeats (or null), and how many live runs already sit on its page. */
function liveLaunches(spec) {
  const key = launchKey(spec);
  let twin = null;
  let livePage = 0;
  for (const { runId, count } of liveRuns()) {
    const other = readJson(specFile(runId));
    if (!other || other.ws !== spec.ws || other.url !== spec.url) continue;
    livePage += 1;
    if (!twin && launchKey(other) === key) twin = { runId, count, personas: other.personas };
  }
  return { twin, livePage };
}

/** Who started a run: this process, its parent, and the chat that asked for it when the environment names one. */
function launchedBy(env, { pid = process.pid, ppid = process.ppid, cwd = process.cwd() } = {}) {
  const word = (value) => String(value || "").replace(/[^A-Za-z0-9_-]/g, "");
  const via = word(env.SUE_LAUNCHED_VIA) || "cli";
  const sessionId = word(via === "cli" ? env.CLAUDE_CODE_SESSION_ID : env.SUE_LAUNCHED_SESSION);
  const chat = word(env.SUE_LAUNCHED_CHAT);
  return {
    pid,
    ...(ppid != null ? { ppid } : {}),
    cwd,
    ...(sessionId ? { sessionId } : {}),
    ...(via ? { via } : {}),
    ...(chat ? { chat } : {}),
  };
}

function launcherLine(who) {
  const parent = who.ppid != null ? `, parent pid ${who.ppid}` : "";
  const session = who.sessionId ? `, session ${who.sessionId}` : "";
  const route = who.via ? `, via ${who.via}` : "";
  const chat = who.chat ? `, chat ${who.chat}` : "";
  return `pid ${who.pid}${parent}${session}${route}${chat}, in ${who.cwd}`;
}

export function startRun(
  args,
  { stage = stageEngine, collect = collectInBackground, spawnRunner = spawn, env = process.env, climayte = null } = {},
) {
  // A run outlives the call that starts it, and its runner is spawned detached; under a fairjob wrapper that dies with
  // its launcher (no -Detach, stdout a pipe) the runner is still inside that job and dies with it, so a focus group's
  // relay vanished mid-run and every Sue got ECONNREFUSED (a Postal Buddy hearing, 2026-10-01). Refused up front instead.
  if (env.FAIRJOB_DIES_WITH_LAUNCHER === "1")
    refuse(
      "this run would die with the fairjob wrapper above it (it has no -Detach and its output is a pipe), so its Sues would lose their relay mid-run: start it outside fairjob, or under fairjob -Detach wrap a command that waits for the run (a dredd hearing does). `sue run` and `sue field` themselves return at once, and fairjob kills what they leave running the moment they do, -Detach or not",
    );
  // A wave asked for on Sue's code at a git ref is handed to that commit's snapshot before anything is planned
  // (runOnEngineAt). One that reaches this door would start on the current code and be measured as the old.
  if (args.engineRef != null)
    refuse(
      `engineRef "${args.engineRef}" asks for this wave on Sue's code as it was at that commit, and this door starts a wave on the current code only: start it with \`node sue/sue.mjs run\` or \`node sue/round.mjs start --engine-ref\`, which hand it to that engine. Nothing was started.`,
    );
  const spec = planRun(args);
  const launcher = launchedBy(env);
  // A caller that repeats a launch while its first run is still going (a slow start reads as a failure, so it is sent
  // again) gets the run that is already there: 128 identical waves on one page in 30 minutes, 2026-10-13.
  const { twin, livePage } = liveLaunches(spec);
  if (twin) {
    fs.appendFileSync(
      logFile(twin.runId),
      `[sue] launch repeated by ${launcherLine(launcher)} at ${new Date().toISOString()}; nothing new started\n`,
      "utf8",
    );
    return {
      ok: true,
      reused: true,
      runId: twin.runId,
      count: twin.count,
      personas: twin.personas,
      workspace: spec.ws,
      url: spec.url,
      intent: spec.intent,
    };
  }
  if (livePage >= MAX_LIVE_RUNS_PER_PAGE)
    refuse(
      `${livePage} runs are already going on ${spec.url}, the most one page can have at once (MAX_LIVE_RUNS_PER_PAGE). Wait for one to finish or stop one (\`sue stop\`), then start this again. Nothing was started.`,
    );
  // Its findings go before the Boardroom when it finishes, unless a hearing or a round started it (lib/hand-to-room.mjs).
  spec.hearing = args.hearing !== false;
  // Which SUE this wave is (lib/version.mjs): on the run record, its runs.jsonl line and the page's scoreboard row.
  spec.sue = readSueVersion();
  spec.launchedBy = launcher;
  // PINNED (Owner, 2026-09-25: "all the Sues keep running on 1.14, all new Sues start on 1.15"): the
  // runner below is a snapshot's own sue.mjs (lib/engine-store.mjs), and everything it starts runs from
  // beside it, so a land into the checkout mid-wave never reaches this wave; a stop or a word to its room
  // is carried out by that same snapshot whoever asks (routeLiveRun). Code already running from a
  // snapshot starts the wave on itself.
  const self = engineInfo();
  let pinned = self ? { ...self, reused: true, ms: 0 } : stage({ sue: spec.sue });
  // A target that lives in this code's own folder (a roster errand's targets/deal-flow/target.json) is
  // read from the snapshot too, with the scenarios and personas beside it, never from the checkout.
  const plannedTarget = spec.targetFile;
  const inCode = typeof plannedTarget === "string" && path.isAbsolute(plannedTarget) ? path.relative(HERE, plannedTarget) : null;
  // The run's people, from this process's copy of Connections', for its cannon (deleted by the runner when the run ends).
  spec.peopleFile = peopleFile(spec.runId);
  sweepPeopleFiles();
  writeJson(spec.peopleFile, installedPeople(spec.personas));
  const pin = () => {
    spec.engine = { id: pinned.id, root: pinned.root, exe: pinned.exe };
    if (inCode && !inCode.startsWith("..") && !path.isAbsolute(inCode)) spec.targetFile = path.join(pinned.root, "sue", inCode);
    writeJson(specFile(spec.runId), spec);
    writeJson(statusFile(spec.runId), { runId: spec.runId, state: "starting", at: new Date().toISOString(), engine: spec.engine });
  };
  pin();
  if (spec.focusGroup) openFocusGroupRoom(spec);
  const out = fs.openSync(logFile(spec.runId), "a");
  fs.writeSync(out, `[sue] launched by ${launcherLine(launcher)}\n`);
  for (let attempt = 1; ; attempt += 1) {
    fs.writeSync(
      out,
      `[sue] engine ${spec.engine.id}: ${self ? "this snapshot" : pinned.reused ? "reused" : `staged (${pinned.files} files)`} in ${pinned.ms} ms\n`,
    );
    // Detached and windowless: the MCP call returns in a second, the run takes as long as it takes,
    // and nothing opens a console on the owner's screen (global rule: never a visible console).
    const child = spawnRunner(
      process.execPath,
      [path.join(spec.engine.root, "sue", "sue.mjs"), "_runner", "--spec", specFile(spec.runId)],
      {
        cwd: spec.ws,
        detached: true,
        windowsHide: true,
        stdio: ["ignore", out, out],
        // A vault lease (the env's, or the one doorDuties took for this wave) rides through untouched; only when there
        // is neither a profile nor a lease does "main" stay the default (the SDK prefers a named profile, 2026-09-22).
        env: runnerEnv(process.env, WAVE_LEASE.env),
      },
    );
    child.unref();
    try {
      // The runner leases its snapshot as it starts (runner below); until it has, this lease in its name
      // keeps the store's collector off it, and dies with it (a pid that is gone is no lease).
      if (child.pid) writeLease(spec.engine.root, { pid: child.pid, startedAtMs: Date.now(), role: "runner", runId: spec.runId });
      break;
    } catch (err) {
      // The store collected the snapshot in the instant between staging it and this lease (its collector
      // puts back one it finds reused, so this is all but never): the runner may already have found its
      // code gone. It is ended, the code staged again, and the runner started again on it.
      try {
        child.kill?.();
      } catch {
        /* already gone */
      }
      if (self || attempt >= 3) throw err;
      fs.writeSync(out, `[sue] engine ${spec.engine.id} was collected as the runner started: staging it again\n`);
      pinned = stage({ sue: spec.sue });
      pin();
    }
  }
  if (!self) collect({ keep: [spec.engine.id] });
  fs.appendFileSync(
    runsFile(spec.ws),
    `${JSON.stringify({ runId: spec.runId, at: new Date().toISOString(), url: spec.url, intent: spec.intent, count: spec.count, personas: spec.personas, sue: spec.sue.version, ...(spec.focusGroup ? { focusGroup: true } : {}) })}\n`,
    "utf8",
  );
  // How many waves this page has had, this one included: only tracked, so a page Sues are sent at
  // over and over is seen (lib/workspace.mjs pageRunTally), never refused.
  const pageRuns = pageRunTally(readRunsLog(spec.ws), spec.page?.key ?? pageKey(spec.url));
  const seats = spec.count + (spec.moderator === "none" ? 0 : 1);
  return {
    ok: true,
    runId: spec.runId,
    sue: spec.sue,
    pageRuns: { ...pageRuns, said: pageRunLine(pageRuns) },
    workspace: spec.ws,
    url: spec.url,
    intent: spec.intent,
    count: spec.count,
    personas: spec.personas,
    personasFrom: spec.personaSource,
    ...(spec.personaSaid ? { personasSaid: spec.personaSaid } : {}),
    ...(spec.siteSaid ? { siteSaid: spec.siteSaid } : {}),
    concurrency: spec.concurrency,
    ...(spec.profile ? { profile: spec.profile } : {}),
    ...(spec.focusGroup ? { focusGroup: true, moderator: spec.moderator, room: path.join(runDir(spec.runId), "room") } : {}),
    target: spec.targetFile,
    log: logFile(spec.runId),
    ...(spec.brain === "chat"
      ? {
          chatBrains: path.join(runDir(spec.runId), "chat-brains.json"),
          ...(spec.dispatch ? { dispatch: spec.dispatch } : {}),
          next: chatBrainNext(undefined, {
            ...(spec.focusGroup ? { focusGroup: true, seats } : {}),
            runId: spec.runId,
            chatBrains: path.join(runDir(spec.runId), "chat-brains.json"),
            climayte: climayte ?? null,
            dispatched: spec.dispatch === "climayte",
          }),
        }
      : spec.focusGroup
        ? {
            next: `The focus group is on its way${spec.moderator === "none" ? " (no moderator: the vote decides)" : ", its moderator with it"}. Ask action "room" to hear them talk (action "room_say" to speak to them yourself), action "status" for where the room stands, and action "report" once they agree.`,
          }
        : {
            next: 'Sues are on their way. Ask action "status" for progress and action "report" for what they said - a Sue takes about two minutes.',
          }),
  };
}

/** How long the harness waits on the page's own build-stamp.json before giving up on it. */
const BUILD_STAMP_TIMEOUT_MS = 2000;

/**
 * What this page is serving right now, read ONCE by the harness (never by a Sue - her own look
 * still starts cold) before a single Sue opens her browser. `<origin>/build-stamp.json` is
 * deploy-plane-web.mjs's own no-cache marker (scripts/deploy/shipped-build-stamp.mjs); a page with
 * none (localhost, a stranger's site) or one that does not answer inside the timeout reads null -
 * the scoreboard's "unknown build" bucket, never a guess. `fetchImpl` is injectable so a test never
 * touches the network.
 */
export async function fetchBuildStamp(url, { timeoutMs = BUILD_STAMP_TIMEOUT_MS, fetchImpl = fetch } = {}) {
  let origin;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(`${origin}/build-stamp.json`, { signal: controller.signal });
    if (!res.ok) return null;
    const stamp = parseShippedStamp(await res.text());
    return stamp ? { commit: stamp.sha, builtAt: stamp.at || null } : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── the detached runner ─────────────────────────────────────────────────────────────────────

function runChild(argv, spec) {
  return new Promise((resolve) => {
    // The door (lib/door.mjs): the one way the cannon agrees to start a wave.
    const child = spawn(process.execPath, argv, { cwd: spec.ws, windowsHide: true, stdio: "inherit", env: doorEnv(spec.runId) });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

/**
 * A cannon that exits non-zero without making a single Sue dir REFUSED, it did not run: the reason is
 * in its own log (a dead brain login, a dead mailroom, bad arguments) or in the code itself - 75 is
 * the account cap or the fairjob memory gate, neither of which says anything in the run's words.
 * `why` is what `runRecord` and the Manager show, so a refusal never reads as finished-with-errors.
 */
export function refusalFromExit(code, log) {
  const lines = String(log ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const said = lines.filter((l) => /REFUSING|refusing|sign .* back in/.test(l)).slice(-2);
  const harvested = said.length ? said : lines.slice(-2);
  const why = code === 75 ? ["not started (cap or memory)"] : [];
  why.push(...(harvested.length ? harvested : [`cannon exited ${code} without starting a Sue`]));
  return { state: "refused", why };
}

export async function runner(specPath, run = runChild, fetchBuild = fetchBuildStamp, toTheRoom = handToTheRoom) {
  const spec = readJson(specPath);
  if (!spec) throw new Error(`no run spec at ${specPath}`);
  // Windows' own record of when this runner started, read once: beside its pid for stopRun's reuse
  // check, and as the start its lease names, so the store keeps this run's snapshot for as long as this
  // runner lives, whatever lands after it (lib/engine-lease.mjs). Given longer than a stop's read: this
  // runner's own start is worth waiting for on a loaded box, and nobody waits on it.
  const createdTicks = pidCreatedAt(process.pid, 15_000);
  pinProcessStart(createdTicks === null ? null : createdTicks / 10_000 - FILETIME_EPOCH_MS);
  takeLease("runner", { runId: spec.runId });
  const status = {
    runId: spec.runId,
    state: "running",
    pid: process.pid,
    pidCreatedAt: createdTicks,
    startedAt: new Date().toISOString(),
    engine: spec.engine ?? null,
  };
  writeJson(statusFile(spec.runId), status);
  // Once per run, before a single Sue starts: which build this page is serving right now.
  spec.page = { ...spec.page, build: await fetchBuild(spec.url) };
  // The live build this run measured (null when the page serves no stamp), kept on the run's own record.
  status.build = spec.page.build;
  writeJson(statusFile(spec.runId), status);
  try {
    const code = await run(cannonArgs(spec), spec);
    status.cannonExit = code;
    // A non-zero exit with no Sue dir is the cannon REFUSING, not a run: a dead brain login, a dead
    // mailroom login, the account cap (75), bad arguments (64) or the fairjob memory gate. Say so in
    // its own words instead of booking an empty run onto the scoreboard as finished-with-errors.
    if (code !== 0 && sueDirs(spec.runId).length === 0) {
      const log = fs.existsSync(logFile(spec.runId)) ? fs.readFileSync(logFile(spec.runId), "utf8") : "";
      Object.assign(status, refusalFromExit(code, log), { finishedAt: new Date().toISOString() });
      writeJson(statusFile(spec.runId), status);
      return;
    }
    const reportFile = path.join(runDir(spec.runId), "report.json");
    if (!fs.existsSync(reportFile) && fs.existsSync(runDir(spec.runId)))
      await run([path.join(HERE, "report.mjs"), "--run", spec.runId], spec);
    const booked = bookRun(spec);
    Object.assign(status, { state: code === 0 ? "finished" : "finished-with-errors", finishedAt: new Date().toISOString(), ...booked });
  } catch (err) {
    Object.assign(status, { state: "failed", error: String(err?.message ?? err), finishedAt: new Date().toISOString() });
  } finally {
    // A run holds its people only while it runs: they live in Connections.
    if (spec.peopleFile) fs.rmSync(spec.peopleFile, { force: true });
    if (spec.runTargetFile) fs.rmSync(spec.runTargetFile, { force: true });
  }
  writeJson(statusFile(spec.runId), status);
  // What the wave found are claims (the owner, 2026-10-09): a finished wave an AI started goes before the Boardroom,
  // which rules each one before anything is repaired (lib/hand-to-room.mjs). A focus group is a room already, and a wave
  // a hearing or a round started (`hearing: false`) is before the room already.
  if (spec.hearing === true && /^finished/.test(status.state) && !isFocusGroup(runDir(spec.runId))) {
    status.hearing = toTheRoom(spec);
    writeJson(statusFile(spec.runId), status);
  }
  tidyOldRuns();
}

/**
 * After every wave: the Settings tab's keepPictures (lib/retention.mjs), off (`forever`) unless this
 * computer's person picked a number of days (decide-48, 2026-09-24). One log line when it freed
 * something or could not delete something, so it never fails silently; it never throws into the wave.
 */
function tidyOldRuns() {
  const keepDays = keepDaysOf(readSettings().keepPictures);
  if (!keepDays) return;
  let result;
  try {
    result = pruneRuns(runsRoot(), { keepDays });
  } catch (err) {
    result = { runs: 0, bytes: 0, errors: [String(err?.message ?? err)] };
  }
  const line = pruneSummary(result);
  if (line) (result.errors.length ? console.error : console.log)(`Keeping ${keepDays} days of pictures: ${line}.`);
}

/** Every finished Sue goes into her persona's journal, and the run goes onto the page's scoreboard. */
export function bookRun(spec) {
  const dir = runDir(spec.runId);
  if (!fs.existsSync(dir)) return { sues: 0 };
  // A run the apparatus poisoned (the mailroom died, the Sue door shut) says so in its manifest, and
  // report.mjs carries the same banner. Those verdicts are about THIS TOOL, not the page, so the run
  // is booked as void: nothing of it reaches a persona's journal or the page's all-time stars.
  const manifest = readJson(path.join(dir, "manifest.json"));
  const report = readJson(path.join(dir, "report.json"));
  const toolFailure = manifest?.toolFailure ?? report?.toolFailure;
  if (toolFailure) return { sues: 0, void: true, toolFailure };
  // A focus group's agreed problem is booked for its page, with the build it was reached on: the next
  // group's moderator reads it (openFocusGroupRoom) to learn whether the fix landed.
  const roomVerdict = isFocusGroup(dir) ? readVerdict(dir) : null;
  if (roomVerdict && spec.page?.key)
    recordVerdict(storeDir(spec.ws), {
      runId: spec.runId,
      pageKey: spec.page.key,
      url: spec.url ?? spec.page.url ?? null,
      build: spec.page?.build ?? null,
      verdict: roomVerdict,
    });
  const entries = [];
  for (const name of fs.readdirSync(dir)) {
    const sueDir = path.join(dir, name);
    if (!name.startsWith("sue-") || !fs.existsSync(path.join(sueDir, "summary.json"))) continue;
    // A brain-error Sue never saw the page - the cannon (cannon.mjs:163) and report.mjs (report.mjs:717)
    // both refuse to count her - so her silence is not an opinion and must not become a review here.
    const summary = readJson(path.join(sueDir, "summary.json"));
    if (summary?.outcome === "brain-error") continue;
    const entry = journalEntryFromSue({
      sueDir,
      report,
      page: spec.page,
      intent: spec.intent,
      runId: spec.runId,
      build: spec.page?.build ?? null,
    });
    if (entry.persona) appendJournal(spec.ws, entry.persona, entry);
    entries.push(entry);
  }
  const row = updateScoreboard(spec.ws, {
    page: spec.page,
    runId: spec.runId,
    intent: spec.intent,
    at: new Date().toISOString(),
    entries,
    build: spec.page?.build ?? null,
    sueVersion: spec.sue?.version ?? null,
  });
  return {
    sues: entries.length,
    averageStars: row.last?.averageStars ?? null,
    ...(isFocusGroup(dir) ? { roomVerdict: roomVerdict?.problem ?? null } : {}),
  };
}

// ── status / report / stop ──────────────────────────────────────────────────────────────────

function sueDirs(runId) {
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((n) => n.startsWith("sue-"))
    .map((n) => path.join(dir, n));
}

// The screens the Sues saw, each once, in the order first seen: each look's page text from their traces (`pageText`,
// the body's record; an older trace has only the 200-character `result`, notes and all), without her eyesight notes
// or the control numbers. Of two looks where one's text starts the other's, the longer stays. A hearing's drafter
// could read only the front door's text, so on a complaint about a flow past it (Lift's lesson player, 2026-09-29) it
// quoted screens that do not exist.
function screensSeen(runId, cap = 16000) {
  const kept = [];
  for (const d of sueDirs(runId)) {
    let lines;
    try {
      lines = fs.readFileSync(path.join(d, "trace.jsonl"), "utf8").split("\n");
    } catch {
      continue;
    }
    for (const line of lines) {
      let t;
      try {
        t = JSON.parse(line);
      } catch {
        continue;
      }
      const raw = typeof t?.pageText === "string" ? t.pageText : t?.result;
      if (t?.tool !== "look" || typeof raw !== "string") continue;
      const text = screenText(raw);
      if (!text) continue;
      const i = kept.findIndex((k) => k.text.startsWith(text) || text.startsWith(k.text));
      if (i < 0) kept.push({ url: t.url || null, text });
      else if (text.length > kept[i].text.length) kept[i] = { ...kept[i], text };
    }
  }
  const out = [];
  let size = 0;
  for (const k of kept) {
    if (size + k.text.length > cap) break;
    out.push(k);
    size += k.text.length;
  }
  return out;
}

function screenText(result) {
  const paras = result.split(/\n\s*Your picture is /)[0].split(/\n\s*\n/);
  // "You are getting a little bored with this page ..." is her state, not the page's.
  if (paras.length > 1 && /^(You |\[Your own (mood|state))/.test(paras[0]) && !/^\[\d+\]/m.test(paras[0])) paras.shift();
  return (
    paras
      .join("\n")
      .split("\n")
      // "[3] Student" is a control's number; "[tiny print you can barely make out]" is her eyesight (lib/perception.mjs).
      .map((l) =>
        l
          .replace(/^\[\d+\]\s*/, "")
          .replace(/\s*\[[a-z][^\]\n]*\]/g, "")
          .trim(),
      )
      .filter((l) => l && !/^Your keyboard is up\b/.test(l))
      .join("\n")
  );
}

function runStatus(args) {
  const ws = workspaceRoot(args.workspace);
  const runId = resolveRunId(ws, args.runId);
  const status = readJson(statusFile(runId)) ?? { runId, state: "unknown" };
  const spec = readJson(specFile(runId)) ?? {};
  const dirs = sueDirs(runId);
  const summaries = dirs.map((d) => readJson(path.join(d, "summary.json"))).filter(Boolean);
  const alive = status.state === "running" && pidAlive(status.pid);
  const state = status.state === "running" && !alive ? "stopped" : status.state;
  const stars = summaries
    .map((s) => readJson(path.join(runDir(runId), s.sueId, "interview.json"))?.starsOutOfFive)
    .filter((n) => typeof n === "number");
  const tail = fs.existsSync(logFile(runId)) ? fs.readFileSync(logFile(runId), "utf8").trimEnd().split("\n").slice(-40) : [];
  const log = tail.slice(-3);
  // A focus group also says where its room stands: visiting, at the table, or closed on a problem.
  const room = isFocusGroup(runDir(runId))
    ? { focusGroup: true, room: { phase: phaseOf(runDir(runId)), problem: readVerdict(runDir(runId))?.problem ?? null } }
    : {};
  return {
    ok: true,
    runId,
    state,
    ...room,
    // Which SUE ran it (null for a wave started before versions), and how many waves its page has had so far.
    sue: spec.sue?.version ?? null,
    pageRuns: spec.url ? pageRunTally(readRunsLog(ws), spec.page?.key ?? pageKey(spec.url)) : null,
    url: spec.url,
    intent: spec.intent,
    expected: spec.count ?? null,
    launched: dirs.length,
    finished: summaries.length,
    averageStarsSoFar: stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 100) / 100 : null,
    costUsdSoFar: Math.round(summaries.reduce((a, s) => a + (s.totalCostUsd ?? 0), 0) * 100) / 100,
    startedAt: status.startedAt ?? null,
    finishedAt: status.finishedAt ?? null,
    // A run that ended without finishing says why, not only the stack frames its log ends on.
    ...(state === "refused" || state === "stopped" ? { error: runLogError(tail) } : {}),
    lastLog: log,
  };
}

/**
 * The line that says WHY a run died: the last `...Error:` line in its log, never the stack frames
 * under it (2026-09-24: a run refused on `no persona "angel-priya"` reported three
 * `at ModuleJob.run` frames and no reason). null when the log names no error.
 */
export function runLogError(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s+at\s/.test(lines[i])) continue;
    if (/\b[A-Za-z]*Error:/.test(lines[i])) return lines[i].trim();
  }
  return null;
}

const pick = (xs, n) => (Array.isArray(xs) ? xs.slice(0, n) : []);

/** The first `n` lines taken one visitor at a time, in turn: every Sue's first line, then every Sue's second. The
 *  diary is written one Sue after another, so the first `n` in order were often one talkative visitor, and that one
 *  visitor was the whole "in their words" block Dredd's seat pick and room read. */
export function inTurns(xs, n, key = "sueId") {
  const queues = new Map();
  for (const x of Array.isArray(xs) ? xs : []) {
    const k = x?.[key] ?? "";
    if (!queues.has(k)) queues.set(k, []);
    queues.get(k).push(x);
  }
  const out = [];
  for (let depth = 0; out.length < n; depth += 1) {
    const before = out.length;
    for (const q of queues.values()) if (depth < q.length && out.length < n) out.push(q[depth]);
    if (out.length === before) break;
  }
  return out;
}

function runReport(args) {
  const ws = workspaceRoot(args.workspace);
  const runId = resolveRunId(ws, args.runId);
  const n = Math.max(1, Math.min(40, Number(args.quotes ?? 8)));
  const dir = runDir(runId);
  const report = readJson(path.join(dir, "report.json"));
  const sue = readJson(specFile(runId))?.sue?.version ?? null;
  const interviews = sueDirs(runId)
    .map((d) => ({ sueId: path.basename(d), iv: readJson(path.join(d, "interview.json")) }))
    .filter((x) => x.iv)
    // Shaped on the way IN, like report.mjs's `loadSue`: a historical file holds bare
    // `everComingBack: false` and JSON-string answers, and reading those raw counted her silence.
    .map((x) => ({ ...x, iv: shapeInterview(x.iv) }));
  // Why each one stopped, in her own words, with her three words: the complaint the board is convened to hear. Her
  // diary lines are her first looks, so on Lift (2026-09-29) five kids' "it just says Loading" reached Jev's seat pick
  // and none of "the bucket sorting round felt endless" did.
  const whyTheyStopped = interviews
    .filter((x) => typeof x.iv.whyStopped === "string" && x.iv.whyStopped.trim())
    .map((x) => ({ sueId: x.sueId, said: x.iv.whyStopped.trim(), ...(x.iv.threeWords ? { threeWords: String(x.iv.threeWords) } : {}) }));
  // The support rule each Sue was under (the cannon records it in sue.json): "nobody contacted
  // support" means nobody wanted to, everybody was forbidden, or nothing was said, and only the
  // first is a finding about the site (Example App, 2026-09-22).
  // Every Sue is listed with her rule, contacted or not (board #95): the counts alone cannot say
  // WHICH silent Sue was forbidden and which was never told. report.mjs's buildSupport is the one
  // reader, so report.md, report.json and this door cannot disagree.
  const supportRoster = buildSupport(
    sueDirs(runId).map((d) => ({
      sueId: path.basename(d),
      sue: readJson(path.join(d, "sue.json")),
      interview: interviews.find((x) => x.sueId === path.basename(d))?.iv ?? null,
    })),
  );
  const ruleOf = new Map(supportRoster.perSue.map((row) => [row.sueId, row.rule]));
  const supportRules = supportRoster.rules;
  const supportBySue = supportRoster.perSue;
  const support = interviews
    .filter((x) => x.iv.contactedSupport && (x.iv.contactedSupport.did ?? x.iv.contactedSupport.yes))
    .map((x) => ({ sueId: x.sueId, rule: ruleOf.get(x.sueId) ?? "unmentioned", ...x.iv.contactedSupport }));
  // What each Sue thought of each email. Her diary FIRST (judge_email writes a `kind: "email"` line
  // the moment she says it, after she opened the email and looked at it); the exit interview's
  // `emailsReceived` only for a Sue whose diary has none. Interview-only lost every opinion on
  // 2026-09-21: the turn budget cut both Sues off before the interview, and three real emails each
  // went unjudged. Her opinion of the message that SENT her (`start: "inbox"`) is marked `arrival`:
  // it is the caller's own email, never counted as one the product sent.
  const arrivalUrl = messageUrl(ARRIVAL_ID);
  const judgedInDiary = (d) => {
    try {
      return fs
        .readFileSync(path.join(d, "findings.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((f) => f.kind === "email")
        .map((f) => ({
          from: f.from ?? "",
          subject: f.subject ?? "",
          whatIThought: f.text,
          opened: true,
          ...(f.url === arrivalUrl ? { arrival: true } : {}),
        }));
    } catch {
      return [];
    }
  };
  const emails = sueDirs(runId).flatMap((d) => {
    const sueId = path.basename(d);
    const diary = judgedInDiary(d);
    if (diary.length) return diary.map((e) => ({ sueId, ...e }));
    const iv = readJson(path.join(d, "interview.json"));
    return Array.isArray(iv?.emailsReceived) ? iv.emailsReceived.map((e) => ({ sueId, ...e, opened: false })) : [];
  });
  if (!report) {
    // Still running: what the Sues who have finished said, straight from their own interviews.
    const stars = interviews
      .filter((x) => !x.iv.unseen)
      .map((x) => x.iv.starsOutOfFive)
      .filter((s) => typeof s === "number");
    return {
      ok: true,
      runId,
      sue,
      complete: false,
      interviewed: interviews.length,
      averageStars: stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 100) / 100 : null,
      neverComingBack: interviews.filter((x) => x.iv.everComingBack?.yes === false).length,
      // Her diary exists before any interview does. Run 20260926-122301-d589: both brains stopped
      // short of the exit interview, and this answer quoted nothing while each Sue had left seven or
      // more notes. Read through report.mjs's buildConfusion, so it quotes what report.md would.
      theirWords: inTurns(buildConfusion(sueDirs(runId).map((d) => loadSue(dir, path.basename(d)))).diary, n).map((d) => ({
        sueId: d.sueId,
        kind: d.kind,
        where: d.where,
        said: d.said,
      })),
      whyTheyStopped,
      screensSeen: screensSeen(runId),
      mostConfusing: pick(
        interviews.map((x) => ({ sueId: x.sueId, said: x.iv.mostConfusing })).filter((x) => x.said),
        n,
      ),
      whyStopped: pick(
        interviews.map((x) => ({ sueId: x.sueId, said: x.iv.whyStopped })).filter((x) => x.said),
        n,
      ),
      contactedSupport: support,
      supportRules,
      supportBySue,
      emailsReceived: pick(emails, n),
    };
  }
  const diedAt = {};
  for (const f of report.funnel?.perSue ?? []) diedAt[f.diedAt ?? "finished"] = (diedAt[f.diedAt ?? "finished"] ?? 0) + 1;
  const buckets = {};
  for (const c of report.comprehension?.perSue ?? []) buckets[c.bucket] = (buckets[c.bucket] ?? 0) + 1;
  return {
    ok: true,
    runId,
    sue,
    complete: true,
    sues: report.sueCount,
    // The design review (report.mjs buildArt): null when no designer ran, as the report itself says.
    art: report.art ?? null,
    verdict: {
      averageStars: report.verdict?.averageStars ?? null,
      starHistogram: report.verdict?.starHistogram ?? null,
      neverComingBackShare: report.verdict?.neverComingBackShare ?? null,
      neverComingBackWhys: pick(report.verdict?.neverComingBackWhys, n),
    },
    theirWords: inTurns(report.confusion?.diary, n).map((d) => ({ sueId: d.sueId, kind: d.kind, where: d.where, said: d.said })),
    whyTheyStopped,
    screensSeen: screensSeen(runId),
    understoodIt: buckets,
    whereTheyStopped: diedAt,
    emailCode: { p50Ms: report.otp?.p50Ms ?? null, neverFound: report.otp?.neverFoundCount ?? 0 },
    problemsFound: (report.findings?.kinds ?? []).map((k) => ({ kind: k.kind, count: k.count })).slice(0, 12),
    // The problems they typed, worst first, for Dredd to route (dredd/lib/bug.mjs filedLines); only when one was typed.
    ...(report.filed ? { problemsFiled: filedList(report.filed) } : {}),
    contactedSupport: support,
    supportRules,
    supportBySue,
    emailsReceived: pick(emails, n),
    reportMarkdown: path.join(dir, "report.md"),
    // "What analytics saw": the saved analytics-view.json's lines, written by action "analytics" (or report with analytics:true).
    ...(savedSummary(dir) ? { analyticsView: savedSummary(dir) } : {}),
  };
}

// Could analytics alone have inferred what each Sue said? Writes runs/<runId>/analytics-view.json, returns its summary.
async function analyticsAction(args) {
  const ws = workspaceRoot(args.workspace);
  const runId = resolveRunId(ws, args.runId);
  if (args.blind) {
    const blind = await blindView({
      runId,
      dir: runDir(runId),
      site: args.site ?? null,
      project: args.project ?? null,
      defaultProject: workspaceProject(ws),
    });
    return { ok: true, file: path.join(runDir(runId), "blind-view.json"), ...blind };
  }
  const view = await analyticsView({
    runId,
    dir: runDir(runId),
    site: args.site ?? null,
    project: args.project ?? null,
    defaultProject: workspaceProject(ws),
  });
  return {
    ok: true,
    runId,
    agreement: view.agreement,
    seen: view.seen,
    sues: view.sueCount,
    summary: view.lines,
    file: path.join(runDir(runId), "analytics-view.json"),
  };
}

function stopRun(args) {
  const ws = workspaceRoot(args.workspace);
  const runId = resolveRunId(ws, args.runId);
  const status = readJson(statusFile(runId));
  // ⛔ Only a run that still SAYS it is running may be killed. A finished (or refused, or stopped)
  // run keeps its runner's pid in the status file; Windows hands that number to somebody else sooner
  // or later, and taskkill /T /F would then take out that process and its whole tree (2026-09-22).
  if (status?.state !== "running")
    return { ok: true, runId, stopped: false, why: status?.state ? `that run is ${status.state}, not running` : "that run is not running" };
  if (!status.pid || !pidAlive(status.pid)) return { ok: true, runId, stopped: false, why: "that run is not running" };
  // A pid that is alive is still not proof it is the same process: the runner's recorded creation
  // time must match the one the OS reports now, or this is a reused number and nobody may be killed.
  const createdAt = pidCreatedAt(status.pid);
  if (status.pidCreatedAt && createdAt && createdAt !== status.pidCreatedAt)
    return { ok: true, runId, stopped: false, why: "that pid belongs to another process now (the number was reused); left alone" };
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(status.pid), "/T", "/F"], { windowsHide: true });
  else process.kill(-status.pid, "SIGTERM");
  noteHostLogs(
    sharedBrowserDir(),
    `[sue stop] killed run ${runId} runner pid ${status.pid} (taskkill /T /F); a shared-browser host is detached and not in that tree`,
  );
  writeJson(statusFile(runId), { ...status, state: "stopped", finishedAt: new Date().toISOString(), killedPid: status.pid });
  // Its runner was killed before its `finally` could delete the run's own target copy and people file.
  const copy = readJson(specFile(runId))?.runTargetFile;
  if (typeof copy === "string") fs.rmSync(copy, { force: true });
  sweepPeopleFiles();
  return { ok: true, runId, stopped: true, note: "Sues already interviewed are kept; their accounts stay until the reaper runs." };
}

// ── a focus group's room ────────────────────────────────────────────────────────────────────

/** The run's room directory, refused in words when the run is not a focus group. */
function focusRunDir(args) {
  const runId = resolveRunId(workspaceRoot(args.workspace), args.runId);
  const dir = runDir(runId);
  if (!isFocusGroup(dir)) refuse(`run ${runId} is not a focus group: it has no room (start one with action "focus_group")`);
  return { runId, dir };
}

/** The whole table as it stands: meta, phase, seats, the problems and who backs each, every line, the verdict. */
function roomOf(args) {
  const { runId, dir } = focusRunDir(args);
  return { ok: true, runId, ...roomSnapshot(dir) };
}

/**
 * The host (the human watching, through the Sue Manager or Boardroom's Focus Group) says something
 * to the room. Every Sue and the moderator hear it as "The host"; `to` names one of them.
 */
function sayToRoom(args) {
  const { runId, dir } = focusRunDir(args);
  const text = String(args.text ?? "").trim();
  if (!text) refuse("say what you want to tell the room: text");
  const line = appendLine(dir, HOST_ID, { kind: "say", name: "The host", text, ...(args.to ? { to: String(args.to).trim() } : {}) });
  return { ok: true, runId, line };
}

/**
 * `file` (a path on this computer, from the workspace) or `idea` (typed words) instead of `url`:
 * stored in the workspace's `.sue/material/` (lib/material.mjs) and visited at the Sue Manager's
 * address for it, exactly like any other page. `title` names an idea.
 */
/** A run on the local brain carries the context length its model has loaded, read before anybody is seated. */
export async function withBrainFit(args) {
  if ((args.brain ? String(args.brain).trim() : process.env.SUE_BRAIN?.trim() || "chat") !== "local") return args;
  const model = process.env.SUE_LOCAL_MODEL?.trim();
  if (!model) refuse("--brain local: name the model with SUE_LOCAL_MODEL, so its loaded context can be checked before a Sue is seated");
  const baseUrl = String(process.env.SUE_LOCAL_URL || "http://127.0.0.1:1234").replace(/\/$/, "");
  try {
    return { ...args, brainContextTokens: await loadedContextTokens({ baseUrl, model }) };
  } catch (err) {
    refuse(String(err?.message ?? err));
  }
}

export function withMaterial(args, { port = MANAGER_PORT } = {}) {
  if (args.file == null && args.idea == null) return args;
  const given = ["url", "target", "file", "idea"].filter((k) => args[k] != null && String(args[k]).trim() !== "");
  if (given.length !== 1) refuse("give the group one thing to look at: url, file or idea");
  const { file, idea, title, ...rest } = args;
  const ws = workspaceRoot(args.workspace);
  try {
    const input = file != null ? materialFromDisk(path.resolve(ws, String(file))) : { idea: String(idea), title };
    return { ...rest, url: storeMaterial(ws, input, { port }).url };
  } catch (err) {
    if (err instanceof MaterialRefusal) refuse(err.message);
    throw err;
  }
}

/** The run's material as its page is read for whether it may run to several pages: planRun is synchronous, so this is asked first. */
export async function withMaterialPages(args) {
  const id = materialIdFrom(args.url);
  if (id === null) return args;
  return { ...args, materialSeveralPages: await materialMayRunToSeveralPages(workspaceRoot(args.workspace), id) };
}

/** The HTTP status a plain GET of `url` gets (what a Sue's Chrome would), or null when nothing answers. */
export function addressAnswers(url, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      res.resume();
      resolve(res.statusCode ?? null);
    });
    req.setTimeout(timeoutMs, () => req.destroy());
    req.on("error", () => resolve(null));
  });
}

// ── a live run's own snapshot ───────────────────────────────────────────────────────────────

/**
 * The commands that write into a run, or signal its runner, while it runs. Newer code's words in an
 * older run's room, or its idea of how to stop an older runner, are a format that run's code never
 * agreed to, so these are carried out by the run's own snapshot (Owner, 2026-09-25: "all the Sues keep
 * running on 1.14"). Reading a run (status, report, room) needs no routing: every version reads files.
 * A move of one Sue's hands is routed the same way, in lib/hand-move.mjs.
 */
const LIVE_RUN_COMMANDS = new Set(["stop", "room_say"]);
/** A routed command is a stop or one line in a room: a minute is far longer than either takes. */
const ROUTE_TIMEOUT_MS = 60_000;

/**
 * Where `command` must be carried out instead of here: `{ engine, runId, argv }` for the snapshot a LIVE
 * run was started on, when that is not this code (`self`, null in the checkout) and the store still
 * holds it; null when the command is not about a live run, or the run is this snapshot's, dead, or from
 * before snapshots, or this process was itself handed the command: the caller then does it here.
 */
function liveRunRoute(command, args, self) {
  if (!LIVE_RUN_COMMANDS.has(command)) return null;
  const ws = workspaceRoot(args.workspace);
  const runId = resolveRunId(ws, args.runId);
  const status = readJson(statusFile(runId)) ?? {};
  if (!["running", "starting"].includes(status.state) || runnerGone(runId, status)) return null;
  const engine = otherEngine(engineOf(status, readJson(specFile(runId))), self);
  if (!engine) return null;
  const { workspace: _workspace, ...rest } = args;
  const argv = [
    path.join(engine.root, "sue", "sue.mjs"),
    command,
    "--workspace",
    ws,
    "--json",
    JSON.stringify({ ...rest, runId }),
  ];
  return { engine, runId, argv };
}

/** The snapshot is told it was handed the command, so it carries it out itself and never hands it on. */
const routedEnv = () => ({ ...process.env, [ROUTED_ENV]: "1" });

/**
 * The routed engine's one JSON answer, its stderr relayed here, and its refusal thrown as this engine's own.
 * `handed` says in words why that engine was asked.
 */
function routedAnswer({ engine, runId, handed = `run ${runId} runs on Sue engine ${engine.id}` }, { stdout, stderr, status, error }) {
  if (stderr) process.stderr.write(stderr);
  let answer;
  try {
    answer = JSON.parse(String(stdout ?? "").trim());
  } catch {
    answer = null;
  }
  if (!answer || typeof answer !== "object") {
    const why = error?.message ?? (status === null ? "it did not finish in time" : `exit ${status}`);
    refuse(
      `${handed}, and that engine did not answer (${why}): ${
        String(stdout ?? "")
          .trim()
          .slice(-300) || "nothing on stdout"
      }`,
    );
  }
  if (status !== 0 || answer.ok === false) refuse(String(answer.error ?? `Sue engine ${engine.id} refused (exit ${status})`));
  return answer;
}

/**
 * `command` carried out by the snapshot a LIVE run was started on (`liveRunRoute`): that snapshot's own
 * sue.mjs on the node that started the run, with the same arguments. Returns its answer, or null to do
 * it here. `self` is injectable so a spec can be the run's own snapshot.
 */
export function routeLiveRun(command, args, { self = engineInfo() } = {}) {
  const route = liveRunRoute(command, args, self);
  if (!route) return null;
  const cli = spawnSync(route.engine.exe, route.argv, {
    env: routedEnv(),
    windowsHide: true,
    encoding: "utf8",
    timeout: ROUTE_TIMEOUT_MS,
    maxBuffer: 16 << 20,
  });
  return routedAnswer(route, { ...cli, status: cli.error ? null : cli.status });
}

/**
 * `routeLiveRun` for a server (the Sue Manager), without holding its event loop while the snapshot's
 * node starts: seconds on the owner's loaded PC, and the page, the toolbar menu and every other request
 * would have waited that long.
 */
export async function routeLiveRunAsync(command, args, { self = engineInfo() } = {}) {
  const route = liveRunRoute(command, args, self);
  if (!route) return null;
  return routedAnswer(route, await engineCli(route.engine.exe, route.argv, { env: routedEnv() }));
}

/** What another engine's CLI printed and how it ended, without holding this event loop; ended after `timeoutMs`. */
function engineCli(exe, argv, { env = process.env, timeoutMs = ROUTE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    const child = spawn(exe, argv, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const done = (status, error) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, status, error });
    };
    child.once("error", (error) => done(null, error));
    child.once("close", (code) => done(code, null));
  });
}

/** How long an older engine has to plan a wave and see its runner up: it reads its own people first. */
const ENGINE_REF_TIMEOUT_MS = 300_000;

/**
 * `run` or `focus_group` on Sue's code as it was at the git ref `args.engineRef`, so a change to Sue
 * itself is A/B'd on today's builds and people (ab.mjs): that commit's snapshot (lib/engine-store.mjs
 * stageEngineAt) is handed the same arguments without the ref, plans the wave and starts it on itself,
 * and its one JSON answer comes back with `engine: { ref, commit, id }`. A ref naming no commit, an
 * engine too old for today's run protocol, or one that does not answer is a refusal: nothing here plans
 * the wave, so it can never start on the current code instead. `stageAt` is injectable so a spec stages
 * a stub.
 */
export async function runOnEngineAt(command, args, { stageAt = stageEngineAt } = {}) {
  const { engineRef, workspace, ...rest } = args;
  let engine;
  try {
    engine = stageAt(engineRef);
  } catch (err) {
    refuse(String(err?.message ?? err));
  }
  // Its arguments from a file, as every front door hands them (parseCli `--json-file`), gone once it answered.
  const file = path.join(mcpDir(), `engine-ref-${process.pid}-${Date.now().toString(36)}.args.json`);
  writeJson(file, rest);
  try {
    const argv = [path.join(engine.root, "sue", "sue.mjs"), command, "--workspace", workspaceRoot(workspace), "--json-file", file];
    const handed = `this wave was handed to Sue engine ${engine.id}, her code at ${engine.ref} (${engine.commit})`;
    const answer = routedAnswer({ engine, handed }, await engineCli(process.execPath, argv, { timeoutMs: ENGINE_REF_TIMEOUT_MS }));
    return { ...answer, engine: { ref: engine.ref, commit: engine.commit, id: engine.id } };
  } finally {
    fs.rmSync(file, { force: true });
  }
}

// ── the CLI ─────────────────────────────────────────────────────────────────────────────────

// The inbox test (lib/inbox-test.mjs): one email in every simulated inbox among decoys, read back from the presses.
function inboxTestEmail(args) {
  const email = args.email && typeof args.email === "object" ? args.email : null;
  if (!email || !String(email.from ?? "").trim() || !String(email.subject ?? "").trim() || !(email.html || email.text))
    refuse("email needs from, subject, and html or text: the email exactly as it is sent");
  return email;
}

function inboxTestAudience(args) {
  if (!AUDIENCES.includes(args.audience))
    refuse('audience is "cold" (an address the Sue has never dealt with) or "known" (one she signed up to)');
  return args.audience;
}

function inboxTestUrl(email, named) {
  if (named != null) return named;
  const unsubscribe = unsubscribeUrlOf(email);
  for (const match of String(email.html ?? "").matchAll(/href=["'](https?:\/\/[^"']+)["']/gi))
    if (match[1] !== unsubscribe) return match[1];
  refuse("the email has no link to a page other than its unsubscribe address: name the page the Sues start from as url");
}

/**
 * The Sues an email with merge fields goes to: each one's own true facts must cover every field, or the run is
 * refused before any Sue starts (naming her and the field). Named personas are checked as named; unnamed, the
 * audience is the personas that have facts, like a cleaned list.
 */
function inboxAudience(args, email, count) {
  const needsFacts = mergeTokensOf(email).some((token) => token !== "first_name");
  if (!needsFacts) return args.personas;
  if (args.sampled) refuse("a sampled Sue has no facts of her own to fill this email's merge fields: name personas that have them");
  const named = namedPersonas(args.personas);
  if (!named) {
    try {
      return eventHostsFor(email, count);
    } catch (err) {
      refuse(err.message);
    }
  }
  const missing = unfilledMerge(email, named);
  if (missing.length)
    refuse(
      `no merge fact for ${missing.map(({ persona, token }) => `${persona}: {${token}}`).join(", ")}; ` +
        "an inbox test never fills a field with a generic word, so leave that Sue out or give her the fact",
    );
  return named;
}

export function inboxTest(args, { climayte = null, run = startRun } = {}) {
  const email = inboxTestEmail(args);
  const audience = inboxTestAudience(args);
  const count = args.count ?? 100;
  const personas = inboxAudience(args, email, count);
  const started = run(
    {
      ...args,
      ...(personas == null ? {} : { personas }),
      url: inboxTestUrl(email, args.url ?? null),
      start: "inbox",
      arrival: { ...email, audience },
      inbox: true,
      decoys: true,
      intent: intentFor(audience),
      count,
    },
    { climayte },
  );
  return { ...started, inboxTest: { key: contentHashOf(email), audience, count } };
}

export function inboxTestReport(args) {
  const email = inboxTestEmail(args);
  const audience = inboxTestAudience(args);
  const runId = resolveRunId(args.workspace, args.runId);
  const { result, record } = inboxTestRecord(mailDir(runId), email, { runId, audience });
  bookInboxTest(path.join(storeDir(args.workspace), "inbox-tests.jsonl"), record);
  const bound = (result.verdict.upperBound * 100).toFixed(1);
  const replied = result.dispositions.filter((d) => d.replied).length;
  const line = `${result.verdict.pass ? "PASS" : "FAIL"}: ${result.verdict.spam} spam report(s) in ${result.count} Sues; 95% upper bound ${bound}%; ${replied} replied`;
  return { ok: true, runId, line, audience, ...result };
}

export function dispatch(command, args, { climayte = null } = {}) {
  const routed = routeLiveRun(command, args);
  if (routed) return routed;
  const ws = args.workspace;
  switch (command) {
    case "run":
      if (args.workspace) {
        const why = scratchWorkspaceRefusal(args.workspace);
        if (why) refuse(why);
      }
      return startRun(withMaterial(args), { climayte });
    case "ape":
      // A run whose Sues are familiar power users (APE): the same wave as `run`, with the power-user flag set here.
      return dispatch("run", { ...args, ape: true }, { climayte });
    case "art":
      // A run whose Sues are the design team (ART): the same wave as `run`, with the design flag set here.
      return dispatch("run", { ...args, art: true }, { climayte });
    case "focus_group":
      // A run whose Sues sit in one room; everything else about it is an ordinary run.
      return startRun(withMaterial({ ...args, focusGroup: true }), { climayte });
    case "inbox_test":
      return inboxTest(args, { climayte });
    case "inbox_test_report":
      return inboxTestReport(args);
    case "room":
      return roomOf(args);
    case "room_say":
      return sayToRoom(args);
    case "status":
      return runStatus(args);
    case "report":
      // analytics:true fetches the run's ARGUS rows first (network), then reports with the section in it.
      return args.analytics ? analyticsAction(args).then(() => runReport(args)) : runReport(args);
    case "analytics":
      return analyticsAction(args);
    case "stop":
      return stopRun(args);
    case "personas":
      return { ok: true, workspace: workspaceRoot(ws), workspacePersonas: listWorkspacePersonas(ws), roster: listRosterPersonas() };
    case "people":
      // Whole docs, each the copy a run would send: for a caller that binds a record to exactly who it sends
      // (MonkeyWerx's panel freezes hash them). A name nobody answers to comes back in `missing`.
      return { ok: true, workspace: workspaceRoot(ws), ...sentPeople(Array.isArray(args.ids) ? args.ids.map(String) : null) };
    case "save_persona": {
      // Made and checked here; saved to Connections by whoever holds the door (`main`, or the sue door's MCP).
      const { persona } = buildPersona(args);
      return { ok: true, persona };
    }
    case "edit_persona": {
      // Only the named fields change; saved to Connections the same way as a new person.
      const { persona, changed, builtIn } = editPersona(args);
      return { ok: true, persona, changed, ...(builtIn ? { builtIn } : {}) };
    }
    case "journal": {
      if (!args.persona) refuse("persona is required: whose journal");
      return { ok: true, persona: args.persona, entries: readJournal(ws, args.persona, Number(args.limit ?? 10)) };
    }
    case "scoreboard":
      return { ok: true, workspace: workspaceRoot(ws), ...readScoreboard(ws) };
    case "profiles":
      // Saved logins on this computer, described: site, counts, hosts, dates. Never a cookie or storage value.
      return { ok: true, profiles: listProfiles() };
    default:
      refuse(
        `unknown command "${command}". Use run, ape, art, field, focus_group, room, room_say, status, report, stop, personas, people, presue, save_persona, edit_persona, journal, scoreboard or profiles`,
      );
  }
  return null;
}

export function parseCli(argv) {
  const [command, ...rest] = argv;
  const out = { command, args: {} };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = rest[i + 1];
    if (flag === "--json") {
      try {
        Object.assign(out.args, JSON.parse(value ?? "{}"));
      } catch (err) {
        throw new Refusal(`--json is not valid JSON: ${err.message}`);
      }
      i += 1;
    } else if (flag === "--json-file") {
      // The same object, read from a file: a caller that spawns this through a shell it does not control
      // (cmd, PowerShell 5.1, sh each quote JSON differently, and two of them broke it on 2026-09-22) writes
      // the arguments to disk and names the path. Nothing else changes. PowerShell 5.1's
      // `Set-Content -Encoding utf8` opens the file with a byte-order mark, which JSON.parse refuses.
      try {
        Object.assign(out.args, JSON.parse(fs.readFileSync(String(value), "utf8").replace(/^\uFEFF/, "")));
      } catch (err) {
        throw new Refusal(`--json-file could not be read as JSON: ${err.message}`);
      }
      i += 1;
    } else if (flag === "--blind") {
      out.args.blind = true;
    } else if (flag === "--workspace") {
      out.args.workspace = value;
      i += 1;
    } else if (flag === "--spec") {
      out.spec = value;
      i += 1;
    } else if (/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(flag)) {
      // `report <runId>` once dropped the id and answered the latest run instead (2026-09-26).
      out.args.runId = flag;
    } else {
      throw new Refusal(`"${flag}" is not an argument sue understands: pass a run id bare or in --json '{"runId":"…"}'`);
    }
  }
  // `ape` is `run` with the power-user flag set (the way `focus_group` is `run` with a room).
  if (command === "ape") out.args = { ...out.args, ape: true };
  // `art` is `run` with the design flag set (the same way).
  if (command === "art") out.args = { ...out.args, art: true };
  return out;
}

/** The commands that send, list, judge or make people, so need them from Connections first. */
const PEOPLE_COMMANDS = new Set([
  "run",
  "ape",
  "art",
  "_start",
  "focus_group",
  "inbox_test",
  "personas",
  "people",
  "presue",
  "field",
  "save_persona",
  "edit_persona",
]);
/** The commands that only read people, so fetch no critic's mind. */
const LISTS_PEOPLE = new Set(["personas", "people", "presue", "field"]);

/**
 * Whether a wave is pre-sued before it is planned (lib/presue.mjs): a link run or focus group that names nobody, carries
 * no cast and shows no file or idea, with its reason to visit given. `presue: false` skips it; the Manager page's own
 * `_start` never waits on it. Everything else (a roster errand, named people, a material run) is the caller's choice.
 */
export function wantsPresue(command, args) {
  if (!RUN_COMMANDS.has(command)) return false;
  // A design review seats its designers and never pre-sues a cast from the ask.
  if (
    args.presue === false ||
    args.art === true ||
    args.target ||
    args.scenario ||
    args.file != null ||
    args.idea != null ||
    args.cast != null
  )
    return false;
  if (namedPersonas(args.personas)) return false;
  const url = String(args.url ?? "").trim();
  if (!/^https?:\/\//i.test(url) || materialIdFrom(url) !== null) return false;
  return String(args.intent ?? "").trim().length >= MIN_ERRAND_CHARS;
}

/**
 * Pre-sue `args`' page with the doors that live beside SUE in Dredd's lib: Jev, the HSwarm brain and the page reader.
 * A copy of SUE without them (an engine snapshot, another product's checkout) pre-sues on the floor and says so.
 */
async function presueOf(args) {
  const [jev, brain, visitors] = await Promise.all([dreddLib("jev.mjs"), dreddLib("brain.mjs"), dreddLib("visitors.mjs")]);
  return runPresue({
    ape: args.ape === true,
    url: String(args.url ?? "").trim(),
    intent: args.intent,
    expect: typeof args.expect === "string" ? args.expect : null,
    count: Number.isInteger(args.count) ? args.count : null,
    // A field run's scope (lib/field.mjs), and the page it already read, so pre-sue does not read it twice.
    scope: typeof args.scope === "string" ? args.scope : null,
    jev: jev ? (items) => jev.askJev(items, { escalate: 0, timeoutMs: 30_000 }) : null,
    brain: brain ? (spec) => brain.askBrainHedged(spec) : null,
    readPage: args.page ? () => args.page : visitors ? (url) => visitors.readPage(url) : null,
  });
}

/** One of the doors beside SUE in Dredd's lib, or null in a copy of SUE with no Dredd beside it. */
function dreddLib(file) {
  // Only a door that is not there is a missing door; a door that is there and broken throws, and the run says why.
  return import(pathToFileURL(path.join(HERE, "..", "dredd", "lib", file)).href).catch((err) => {
    if (err?.code === "ERR_MODULE_NOT_FOUND" && String(err.message).includes(file)) return null;
    throw err;
  });
}

/** Where field runs keep their records and the APE rule's ledger: SUE's state folder, never the repository. */
const fieldRoot = () => path.join(stateRoot(), "field");
const fieldFile = (fieldId) => path.join(fieldRoot(), fieldId, "field.json");

/** The field ledger's rows (lib/field.mjs FIELD_LEDGER): one per field run that started a wave. */
function fieldLedger() {
  const file = path.join(fieldRoot(), FIELD_LEDGER);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
}

/** Jev for the field's own questions (the scope, the repeat use, the design claims): Jev alone, one call each. */
async function fieldJev() {
  const jev = await dreddLib("jev.mjs");
  return jev ? (items) => jev.askJev(items, { escalate: 0, timeoutMs: 60_000 }) : null;
}

/** The claims one finished run filed, exactly as the room will read them (dredd/lib/claim-rulings.mjs fieldClaims). */
async function fieldClaimsOf(runId) {
  const rulings = await dreddLib("claim-rulings.mjs");
  if (!rulings) throw new Error("the claims are read by Dredd's claim-rulings, and this copy of SUE has no Dredd beside it");
  // The checkout whose sue/runs/ holds the run, the root Dredd's adoptRuns reads it from.
  return rulings.fieldClaims({ "sue.log": `SUE run ${runId}\n` }, { runsRoot: targetRoot() });
}

/** A record written with its readable lines, atomically: field.json is what `--field` hands the room. */
function saveField(record) {
  fs.mkdirSync(path.dirname(fieldFile(record.fieldId)), { recursive: true });
  writeJsonAtomic(fieldFile(record.fieldId), { ...record, lines: fieldLines(record) });
}

/**
 * `sue field` (lib/field.mjs): every decision made here, in the foreground (the scope, SUE's visitors, APE), with the
 * people pre-sue onboarded saved through this process's door; then, unless `dryRun`, the waves go to a hidden detached
 * runner (`_field`) that waits on them and hands one docket to the room. `fieldId` reads a field run back.
 */
async function fieldCommand(args, door) {
  if (args.fieldId) {
    const record = readJson(fieldFile(String(args.fieldId)));
    if (!record) refuse(`no field run ${args.fieldId} on this computer (${fieldRoot()})`);
    return { ok: true, fieldId: record.fieldId, state: record.state, lines: fieldLines(record), record: fieldFile(record.fieldId) };
  }
  const dry = args.dryRun === true;
  const brain = args.brain ? String(args.brain) : "chat";
  const dispatchTo = args.dispatch === undefined ? (brain === "chat" ? "climayte" : null) : args.dispatch || null;
  if (!dry && dispatchTo === "climayte") {
    const ready = await climayteReady();
    if (!ready?.ready)
      refuse(
        `a field run's waves go to AgentHydra's CliMayte sealed, and ${ready?.why ?? "it did not answer"}: start AgentHydra, then run this again`,
      );
  }
  const [jev, visitors] = await Promise.all([fieldJev(), dreddLib("visitors.mjs")]);
  const fieldId = dry ? null : newRunId();
  const record = await planField(args, {
    id: fieldId,
    jev,
    readPage: visitors ? (url) => visitors.readPage(url) : null,
    presue: (spec) => presueOf(spec),
    history: (host) => fieldLedger().filter((r) => r.host === host),
    claimsOf: fieldClaimsOf,
  });
  const onboarded = [...(record.sue.cast ?? []), ...(record.ape.cast ?? [])];
  if (dry) record.saved = onboarded.length ? "not saved: dry run" : null;
  else if (door && onboarded.length) record.inConnections = await saveOnboarded(door, onboarded);
  if (dry) return { ok: true, dryRun: true, lines: fieldLines(record), record };
  record.workspace = workspaceRoot(args.workspace);
  record.waves = { brain, dispatch: dispatchTo };
  saveField(record);
  const log = path.join(fieldRoot(), fieldId, "field.log");
  const out = fs.openSync(log, "a");
  // Detached and windowless, like a wave's runner: this call answers in seconds, the field takes as long as its waves.
  const child = spawn(process.execPath, [path.join(HERE, "sue.mjs"), "_field", "--spec", fieldFile(fieldId)], {
    cwd: record.workspace,
    detached: true,
    windowsHide: true,
    stdio: ["ignore", out, out],
  });
  child.unref();
  return {
    ok: true,
    fieldId,
    lines: fieldLines(record),
    record: fieldFile(fieldId),
    log,
    next: `The field runs hidden: SUE first, then ART and APE as decided, then one docket for the Boardroom. Read it back with: node sue/sue.mjs field --json '{"fieldId":"${fieldId}"}'`,
  };
}

/** One wave started the way an AI starts any wave (`sue run`, answered once it is up or dead): `{ runId }` or `{ error }`. */
function startFieldWave(record, args) {
  const kind = args.art ? "art" : args.ape ? "ape" : "sue";
  const file = path.join(fieldRoot(), record.fieldId, `${kind}.args.json`);
  writeJsonAtomic(file, args);
  const r = spawnSync(process.execPath, [path.join(HERE, "sue.mjs"), "run", "--json-file", file], {
    cwd: record.workspace,
    encoding: "utf8",
    windowsHide: true,
    timeout: 8 * 60_000,
  });
  // The answer is the last top-level object printed (`main` writes it indented, so only its own brace starts a line).
  const text = String(r.stdout ?? "");
  const at = text.lastIndexOf("\n{\n");
  let answer;
  try {
    answer = JSON.parse((at >= 0 ? text.slice(at + 1) : text).trim());
  } catch {
    answer = null;
  }
  if (answer?.ok && answer.runId) return { runId: answer.runId };
  return {
    error: String(answer?.error || r.stderr || r.error?.message || `exit ${r.status}`)
      .trim()
      .slice(-300),
  };
}

/** Wait for a wave to end (finished, refused, stopped, failed); a runner that died is ended as gone. Three hours at most. */
async function waitFieldWave(runId, { pollMs = 20_000, maxMs = 3 * 60 * 60_000 } = {}) {
  const until = Date.now() + maxMs;
  for (;;) {
    if (runnerGone(runId)) endGoneRun(runId);
    const rec = runRecord(runId);
    if (rec.state && rec.state !== "starting" && rec.state !== "running") return { state: rec.state, why: rec.why };
    if (Date.now() > until)
      return { state: "timed out", why: [`still ${rec.state ?? "unknown"} after ${Math.round(maxMs / 60_000)} minutes`] };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/** The room the newest ruling panel sat in (a rulings answers file under tmp/dredd), or null when none ever sat here. */
function lastRulingRoom(root) {
  const base = path.join(root, "tmp", "dredd");
  let best = null;
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    let names;
    try {
      names = fs.readdirSync(path.join(base, d));
    } catch {
      continue;
    }
    for (const n of names.filter((x) => /^rulings-batch-.*\.answers\.json$/.test(x))) {
      const file = path.join(base, d, n);
      const t = fs.statSync(file).mtimeMs;
      if (!best || t > best.t) best = { file, t };
    }
  }
  return best ? (readJson(best.file)?.room ?? null) : null;
}

/** One cheap meeting-open in that room (lib/field.mjs waitForRoom's probe): open, refused (allowance or credit), or an error. */
async function probeFieldRoom() {
  const root = targetRoot();
  const room = lastRulingRoom(root);
  if (!room) return { error: "no ruling room on record under tmp/dredd to probe" };
  const [mcpLib, board] = await Promise.all([dreddLib("mcp.mjs"), dreddLib("connections-board.mjs")]);
  if (!mcpLib || !board) return { error: "no Dredd beside this SUE to probe the room with" };
  let mcp = null;
  try {
    mcp = await mcpLib.openLocalMcp({ root, loaderRoot: root, timeoutMs: 30_000 });
    const { res, id } = await board.openMeeting(mcp, room);
    if (res.ok) return { open: true, meeting: id };
    const why = board.refusalText(res).slice(0, 200);
    return /allowance|credit|paced/i.test(`${why} ${JSON.stringify(res.body ?? "")}`) ? { refused: true, why } : { error: why };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 200) };
  } finally {
    await mcp?.close?.();
  }
}

/** `_field`: the hidden runner of one field run, resumable from its field.json at any step (lib/field.mjs runField). */
async function fieldRunner(specPath) {
  const record = readJson(specPath);
  if (!record?.fieldId) throw new Error(`no field run at ${specPath}`);
  const ledger = path.join(fieldRoot(), FIELD_LEDGER);
  await runField(
    record,
    {
      startWave: async (args) => startFieldWave(record, args),
      waitWave: (runId) => waitFieldWave(runId),
      claimsOf: fieldClaimsOf,
      jev: await fieldJev(),
      probeRoom: probeFieldRoom,
      hand: async ({ runs, ask }) => handFieldToTheRoom({ url: record.errand.url, runs, ask, fieldFile: fieldFile(record.fieldId) }),
      save: async (r) => saveField(r),
      appendLedger: async (row) => fs.appendFileSync(ledger, `${JSON.stringify(row)}\n`),
    },
    { brain: record.waves?.brain ?? "chat", dispatch: record.waves?.dispatch ?? "climayte", workspace: record.workspace },
  );
  process.stdout.write(`${fieldLines(record).join("\n")}\n`);
}
/** The commands that make or change a person, whose answer is saved to Connections. */
const SAVES_PERSON = new Set(["save_persona", "edit_persona"]);
/** The commands that start a wave, so read this workspace's own websites once before it is planned (lib/owned-sites.mjs). */
const STARTS_WAVE = new Set(["run", "ape", "art", "_start", "focus_group", "inbox_test"]);
/**
 * The mailroom's vault lease this process took for its wave (doorDuties). It goes to the wave's runner only, never into
 * this process's env: a Sue Manager this process starts for a material run outlives the hour the lease lasts, and with
 * the keys in its env every wave it later started would skip its own lease and run on dead ones.
 */
const WAVE_LEASE = { env: null };

/** The env a wave's runner starts with: `base`, the wave's `lease` over it, and "main" only when neither holds credentials. */
export function runnerEnv(base, lease = null) {
  const env = lease ? { ...base, ...lease } : { ...base };
  return env.AWS_PROFILE || !(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) ? { ...env, AWS_PROFILE: env.AWS_PROFILE || "main" } : env;
}
/** The commands that plan a wave of Sues: `ape` is `run` with the power-user flag (parseCli). */
const RUN_COMMANDS = new Set(["run", "ape", "art", "focus_group"]);

/**
 * Install this process's people before it plans (lib/personas.mjs `installPeople`): the ones its caller handed over
 * (`args.people`, `args.minds`: the sue door and Dredd fetch them on the member's key), else the ones fetched here
 * through a local MCP. Returns the args without them, and the door when this process opened one.
 */
export async function readyPeople(command, args) {
  const { people, minds, ...rest } = args;
  if (!PEOPLE_COMMANDS.has(command)) return { args: rest, door: null };
  if (Array.isArray(people)) {
    installPeople(people, { minds: minds ?? {} });
    return { args: rest, door: null };
  }
  const opened = await openPeopleDoor({ root: workspaceRoot(args.workspace) });
  try {
    // A folder an older SUE wrote people into has them moved into Connections first (lib/people.mjs adoptFolderPeople).
    await adoptFolderPeople(workspaceRoot(args.workspace), opened.door);
    const sends = !LISTS_PEOPLE.has(command) && !SAVES_PERSON.has(command);
    const got = await fetchPeople(opened.door, { ids: namedPersonas(args.personas), minds: sends });
    installPeople(got.people, { minds: got.minds });
  } catch (err) {
    await opened.close();
    throw err;
  }
  return { args: rest, door: opened };
}

/**
 * What the Connections MCP's sue door did for a wave before it reached this engine, done here now that AgentHydra starts
 * the engine directly (`node sue/sue.mjs <action>`, SUE_LAUNCHED_VIA=mcp, 2026-10-15; the door was
 * services/studio/local-mcp/src-impl/26b-tools-sue.mjs). For a command that starts a wave:
 *   - `project`, when the caller gave none, is the workspace's (lib/workspaces.mjs workspaceProject), recorded in the
 *     run's manifest so a later `analytics` reads that workspace's ARGUS site;
 *   - a name in `personas` that is neither this folder's person nor a roster kind is looked up in the workspace's
 *     Boardroom and sent as a cast visitor (lib/boardroom-cast.mjs), through `door`, the people door this process opened;
 *   - a process with no AWS credentials of its own (no AWS_PROFILE, no keys in `env`) leases `Root/Connections` from the
 *     vault through `mcp` (lib/mailroom-lease.mjs) into `held` (WAVE_LEASE), which only the wave's detached runner and its
 *     mailroom get (runnerEnv); without a lease the run keeps the "main" profile as before, and the answer says so.
 * Returns `{ args, notes }`: `notes` ride on the answer as the door's did (`fromBoardroom`, `mailroomCredentials`).
 */
export async function doorDuties(
  command,
  args,
  {
    ws,
    door = null,
    mcp = null,
    env = process.env,
    held = WAVE_LEASE,
    cast = castBoardroomPeople,
    lease = mintMailroomLease,
    project = workspaceProject,
  } = {},
) {
  if (!STARTS_WAVE.has(command)) return { args, notes: {} };
  let next = args;
  const notes = {};
  if (!next.project) {
    const own = project(ws);
    if (own) next = { ...next, project: own };
  }
  if (door && namedPersonas(next.personas)) {
    const found = await cast(ws, next.personas, { door, like: typeof next.like === "string" ? next.like : undefined });
    if (found.cast?.length)
      next = { ...next, personas: found.personas, cast: [...(Array.isArray(next.cast) ? next.cast : []), ...found.cast] };
    if (found.found?.length || found.why) notes.fromBoardroom = { found: found.found, ...(found.why ? { why: found.why } : {}) };
  }
  if (needsMailroomLease(env)) {
    const got = mcp ? await lease(mcp) : { error: "no local MCP was open to reach the vault through" };
    if (got.env) held.env = got.env;
    notes.mailroomCredentials = got.env
      ? `a vault lease for "${got.instance}" until ${new Date(got.expiresAt).toISOString()} (the one the sue door took)`
      : `none: ${got.error} - a run whose Sues make accounts is refused unless the "main" AWS profile is signed in here, any other runs without a mailroom`;
  } else
    notes.mailroomCredentials = env.AWS_PROFILE
      ? `this process's AWS profile "${env.AWS_PROFILE}"`
      : "the AWS keys in this process's environment";
  return { args: next, notes };
}

async function main() {
  if (["blind-round", "blind_round"].includes(process.argv[2])) {
    process.stdout.write(`${JSON.stringify(await blindRoundMain(process.argv.slice(3)), null, 2)}\n`);
    return null;
  }
  const parsed = parseCli(process.argv.slice(2));
  const { command, spec } = parsed;
  if (command === "_runner") return runner(spec);
  if (command === "_field") return fieldRunner(spec);
  let opened = null;
  let sites = null;
  try {
    // A wave asked for on Sue's code at a git ref is planned by that commit's own snapshot, which reads its own people.
    if (RUN_COMMANDS.has(command) && parsed.args.engineRef != null) {
      process.stdout.write(`${JSON.stringify(await runOnEngineAt(command, parsed.args), null, 2)}\n`);
      return null;
    }
    const ready = await readyPeople(command, parsed.args);
    opened = ready.door;
    // This workspace's own websites, read ONCE for the wave before it is planned, never by a Sue (lib/owned-sites.mjs):
    // the ones a caller handed over (`ownedSites`), else through the people's door when this process opened one, else
    // through a door of its own. A wave the sue door starts hands over its people, so it is read here for that folder.
    if (STARTS_WAVE.has(command))
      sites = await ownedSitesForRun(ready.args, {
        root: workspaceRoot(ready.args.workspace),
        reuse: opened?.mcp ? ownedSitesDoorOf(opened.mcp) : null,
      });
    // The sue door's duties for a wave (its project, its Boardroom people, its mailroom's vault lease), done here.
    const duties = await doorDuties(command, sites?.args ?? ready.args, {
      ws: workspaceRoot(ready.args.workspace),
      door: opened?.door ?? null,
      mcp: opened?.mcp ?? null,
    });
    const args = duties.args;
    // A command running from a snapshot (a stop or a word to a room, handed over by routeLiveRun) keeps
    // that snapshot in the store while it works (lib/engine-lease.mjs); from the checkout, nothing to keep.
    takeLease("cli", { command });
    // `_start`: what the Sue Manager's page runs to start a wave (manager.mjs startWaveFromCheckout), so
    // the checkout's code as it is now plans it: `run` exactly as the page asks, answered the moment
    // the runner is spawned. The page watches the run and is itself the window: no wait, no window.
    if (command === "_start") {
      const started = await sites.settle(dispatch("run", await withMaterialPages(args)));
      process.stdout.write(`${JSON.stringify(started && typeof started === "object" ? { ...started, ...duties.notes } : started, null, 2)}\n`);
      return null;
    }
    // `presue`: who of SUE's people really visit this page, and the kinds still missing drafted, checked and saved
    // (lib/presue.mjs). People handed over by the sue door are saved by that door, which holds the Boardroom's.
    if (command === "presue") {
      const report = await presueOf(args);
      if (args.save === false) report.saved = "not saved: save false";
      else if (opened && report.onboarded.length) report.inConnections = await saveOnboarded(opened.door, report.onboarded);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return null;
    }
    // `field`: the owner's whole field through one door (lib/field.mjs): scope, visitors, SUE, ART, APE, one docket.
    if (command === "field") {
      process.stdout.write(`${JSON.stringify(await fieldCommand(args, opened?.door ?? null), null, 2)}\n`);
      return null;
    }
    // `watch`: open Sue's window (or find the one already open) without sending anyone. The one way the
    // window opens: a wave an AI starts runs headless (the owner, 2026-10-09).
    if (command === "watch") {
      process.stdout.write(`${JSON.stringify({ ok: true, window: await showWatcher() }, null, 2)}\n`);
      return null;
    }
    // A file or an idea is served to her by the Sue Manager (lib/material.mjs). A run that shows one starts that
    // Manager for it with no toolbar icon and no window, and refuses with the command to start it by hand if it does not come up.
    const material = RUN_COMMANDS.has(command) && (args.file != null || args.idea != null);
    if (material && !(await managerListening(MANAGER_PORT)) && !(await startHeadlessManager()))
      refuse(
        "a file or an idea is shown to the group by the Sue Manager on this computer, and it did not start: run `node sue/manager.mjs --no-open --no-tray`, then run this again",
      );
    // Any Manager answering the port is not enough: the installed Sue app runs its own copy, and one
    // from before material answers /material/<id> with its "only Connections' own pages" refusal, which
    // every Sue then reads as the thing she was sent to look at (found 2026-09-24, run 20260924-175142-65f6).
    // Its manager.json cannot say so either: the app keeps it under its OWN Sue home. So the stored item
    // is asked for at the very address the Sues will open, before any Sue is reserved. A Manager that
    // serves material answers 200, or 404 while the folder is new to it (it finds the folder once this
    // run's manifest exists); one from before material answers its 403 refusal.
    let given = await withMaterialPages(material ? withMaterial(args) : args);
    // A link run that names nobody is pre-sued first: the people who fit go, the missing kinds are drafted, sent
    // inline and saved for the next run (lib/presue.mjs). A pre-sue that cannot run leaves the run as it was, and says why.
    let presue = null;
    if (wantsPresue(command, given)) {
      presue = await presueOf(given).catch((err) => ({ ok: false, error: String(err?.message ?? err).slice(0, 300) }));
      if (presue.ok) {
        given = withPresue(given, presue);
        if (opened && presue.onboarded.length) presue.inConnections = await saveOnboarded(opened.door, presue.onboarded);
      }
    }
    if (material && (await managerListening(MANAGER_PORT))) {
      const answered = await addressAnswers(given.url);
      if (answered !== 200 && answered !== 404)
        refuse(
          `the Sue Manager running on this computer cannot show a file or an idea to the group (${given.url} answered ${answered ?? "nothing"}), so every Sue would open an error page; ` +
            "update the Sue app (or quit it and run `node sue/sue.mjs watch` from this checkout), or give the group a url instead",
        );
    }
    // A chat-brain wave asks AgentHydra once whether CliMayte can take its Sues sealed (lib/climayte-dispatch.mjs):
    // its answer decides the run's `next`, and a wave that asked SUE to send them is refused before it exists without it.
    const climayte = RUN_COMMANDS.has(command) && chatBrainAsked(given) ? await climayteReady() : null;
    if (given.dispatch === "climayte" && climayte && !climayte.ready)
      refuse(
        `dispatch "climayte" needs AgentHydra's CliMayte, and ${climayte.why}: start AgentHydra, or leave dispatch out and send the Sues the way the run's next says`,
      );
    const fitted = RUN_COMMANDS.has(command) ? await withBrainFit(given) : given;
    let answer = await dispatch(command, fitted, { climayte });
    if (presue && answer && typeof answer === "object") answer.presue = presue;
    if (answer && typeof answer === "object") Object.assign(answer, duties.notes);
    // A planned wave on a site the human called theirs (`owned: true`) puts it on this workspace's websites, and the
    // answer names it (`registeredSite`) and any source of the list that could not be read (`ownedSitesNote`).
    if (sites) answer = await sites.settle(answer);
    // A person made in a terminal is saved to Connections through its own door; the sue door's MCP saves the ones
    // it asked for itself (services/studio/local-mcp/src-impl/26b-tools-sue.mjs registerSuePersona).
    if (SAVES_PERSON.has(command) && opened && answer?.ok) {
      answer = await savePersonaAnswer(opened.door, answer);
      if (!answer.ok) process.exitCode = 1;
    }
    // A wave an AI starts (the MCP door, Dredd, a terminal) is answered once it is UP or DEAD, never the
    // moment its runner spawns: an `ok:true` about a run whose mailroom already stopped it sent five Opus
    // agents at a relay that never opened on 2026-09-24 (lib/run-start.mjs). The Manager page starts
    // its waves through `_start` above and watches the run itself, so it does not wait here.
    if (RUN_COMMANDS.has(command)) answer = await awaitRunStart(answer);
    // A wave an AI starts runs headless (the owner, 2026-10-09): no Manager for its window, no toolbar icon, no
    // window. It only notes itself as the latest wave, so `sue watch` lands on it (lib/watch-window.mjs).
    if (RUN_COMMANDS.has(command) && answer?.ok && answer.workspace && answer.runId)
      noteFocus({ folder: answer.workspace, runId: answer.runId });
    process.stdout.write(`${command === "analytics" && parsed.args.blind ? asciiJson(answer) : JSON.stringify(answer, null, 2)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: err.message })}\n`);
    process.exitCode = 1;
  } finally {
    await sites?.close();
    await opened?.close();
  }
  return null;
}

if (isMainModule(import.meta.main, import.meta.url)) await main();
