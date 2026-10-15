#!/usr/bin/env node
/**
 * manager.mjs - the Sue Manager's LOCAL half: the one door between the Sue Manager page and the
 * Sues running on this computer.
 * ==========================================================================================
 *
 * Owner ask (Owner, 2026-09-22): "go build me the manager" - a window onto every Sue, hosted on OUR
 * site so it feels like a product and so Connections sees how it is used ("I want to track what they
 * do with it via analytics"), while Sue herself stays what he ruled she is: "only built for people
 * with AIs. On their computer." So the page is a Studio lens (app.example.com/sue, with
 * app.example.com as its short address), and this file is the small local server it talks to.
 * Nobody goes looking for it (the owner: "Sue shouldn't ever really be a page a human goes to"): when an
 * AI starts a wave, `sue run` starts this server if it is not running (lib/watch-window.mjs).
 *
 * THE TOOLBAR (Owner, 2026-09-23: "Whenever an AI starts it, it shouldn't open it up. It should be
 * able to stay collapsed to the toolbar ... if I close Sue, it should say shrunk to the toolbar").
 * On Windows this server keeps Sue's icon in the toolbar for as long as it runs (lib/tray.mjs). A
 * wave an AI starts leaves the window closed; the icon opens it (the page as an app window in the
 * person's own Chrome, pointed at the latest run). Closing the window leaves Sue in the toolbar and
 * the icon says so. Both are this computer's settings (lib/settings.mjs), changed on the page's
 * Settings tab: an AI's wave may open the window instead, and closing it may quit Sue instead.
 *
 * WORKSPACES (Owner, the same day: "the SU manager should probably have the ability to change
 * workspaces because maybe different workspaces have different SUs"). Every project folder with a
 * `.sue/` is its own Sue workspace, with its own people, pages, journals and scoreboard, and the
 * Connections MCP has already bound most of them to a Studio workspace (lib/workspaces.mjs). So the
 * page's own workspace switcher picks which folder it is looking at, and every read and every wave
 * below is scoped to one workspace id. A wave goes through `sue run` (sue.mjs), the same one door the
 * MCP and a terminal use, so it lands in that workspace's journals and scoreboard like any other.
 *
 * It serves what the Sues already write to disk - each Sue's latest picture, her journal, her inbox,
 * her exit interview, the run's report, each person's visits, each page's scores - and starts and
 * stops waves. It never holds a credential, never reads outside the runs folder, the workspaces'
 * own `.sue/` stores and this person's own Sues (`~/.connections/you-sue`, you/sues.mjs: which one is
 * active, which kinds are armed, the day's held reserved calls), never hands the page a path of this
 * computer, and never sends anything anywhere: the PAGE fetches from here, in the person's own browser.
 *
 * WHO MAY ASK. It listens on 127.0.0.1 only, and answers a request only when:
 *   - its Host is this machine's own address and port (a DNS-rebinding page arrives with its own name), and
 *   - its Origin is one of MANAGER_ORIGINS (Connections' own pages; the dev server with --dev).
 * A browser sets Origin itself and no page can forge it, so another website open in the same
 * browser can never read a Sue's screen or start a wave. Nothing secret rides in the page's URL
 * (Studio's analytics records full addresses, so a pairing key there would be a key in a log).
 *
 * Usage: node sue/manager.mjs [--port 47470] [--no-open] [--no-tray] [--dev] [--page <url>]
 *   Opens the page in the person's own Chrome (else Edge) as an app window: no tabs, no address bar.
 *   --no-open starts in the toolbar instead. `sue run` does this by itself; running it by hand is
 *   for a developer.
 */
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { findMaterial, MATERIAL_MAX_BYTES, MaterialRefusal, pdfViewerPage, storeMaterial } from "./lib/material.mjs";
import { materialIdOfPath } from "./lib/material-address.mjs";
import { renderPdfPages } from "./lib/pdf-pages.mjs";

import { assertProfileName, forgetProfile, listProfiles, profileSite } from "./lib/profiles.mjs";
import { RUN_ID_PATTERN, runsRoot, stateRoot } from "./lib/run-dir.mjs";
import { lookTimes } from "./lib/looks.mjs";
import { readSettings, saveSettings } from "./lib/settings.mjs";
import { keepDaysOf, pruneRuns, pruneSummary } from "./lib/retention.mjs";
import { activityOf, NOW_FILE } from "./lib/activity.mjs";
import { createStateCache, listDir, readJson, readJsonl } from "./lib/state-cache.mjs";
import { startTray, trayAvailable } from "./lib/tray.mjs";
import { readSueVersionAsync } from "./lib/version.mjs";
import { countingLogins, HANDOVER_HEADER, handOver, managerAnswers, runningSue, startSuccessor, sueReport } from "./lib/version-skew.mjs";
import { CHECKOUT, collectGarbage, currentEngineId } from "./lib/engine-store.mjs";
import { codeKey, watchCode } from "./lib/manager-refresh.mjs";
import { MIN_ERRAND_CHARS, checkPersonaDoc, ownPersonPortraitFile } from "./lib/workspace.mjs";
import { installPeople, personPortraitFile } from "./lib/personas.mjs";
import { keptCopy, peopleOfFolder, saveFolderPeople } from "./lib/people.mjs";
import {
  discoverWorkspaces,
  logRosterProblems,
  personVisits,
  runFolder,
  runsByFolder,
  workspacePages,
  workspacePeople,
  WORKSPACE_ID_PATTERN,
  workspaceId,
  workspaceStartUrls,
} from "./lib/workspaces.mjs";
import {
  MANAGER_PAGE,
  MANAGER_PORT,
  noteManagerDown,
  noteFocus,
  noteManagerUp,
  noteTrayGone,
  notePageGone,
  notePageSeen,
  noteWindowOpened,
  openWindow,
  readFocus,
} from "./lib/watch-window.mjs";
import { BRAINS, sueBrainPolicy } from "./lib/claude-cli.mjs";
import { CAST_MAX } from "./lib/cast.mjs";
import { appendLine, FOCUS_GROUP_MAX, HOST_ID, isFocusGroup, LINE_MAX_CHARS, roomSnapshot } from "./lib/room.mjs";
import {
  dispatch,
  endGoneRun,
  liveRuns,
  Refusal,
  routeLiveRunAsync,
  runnerGone,
  RUNNER_GONE_WHY,
  runRecord,
  runServedByManager,
  settleRun,
  withMaterialPages,
} from "./sue.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";
import { HEARING_ID, SEAT_ID, hearingShotFile, listHearings, portraitFile, readHearing, readRoster } from "./lib/dredd-view.mjs";

const pdfViewers = new Map();

/**
 * 3: the toolbar and the settings (hello's `tray` and `settings`, POST /api/settings).
 * 4: saved logins (GET/POST /api/profiles, POST /api/profiles/<name>/forget) and a wave's `profile`.
 * 5: focus groups: a run's room (GET/POST /api/runs/<runId>/room), a wave's `focusGroup`,
 *    `suggestions`, `moderator` and `brain`, `focusGroup` on every run summary, and Boardroom's origins.
 * 6: material: POST /api/material stores a file or an idea for a group to look at (lib/material.mjs),
 *    GET /material/<id> serves it to a Sue's own Chrome, and hello's `material` says so.
 * 7: Dredd (lib/dredd-view.mjs): GET /api/workspaces/<id>/hearings, .../hearings/<hearingId>, its
 *    .../shots/<name>, GET .../boardroom and .../boardroom/<seatId>/portrait; hello's `dredd` says so.
 * 8: portraits: each seat's `portraitCredit` (a photo's author, licence and source), each roster person's
 *    `portrait`, and GET /api/workspaces/<id>/people/<personId>/portrait (her painted card: the folder's own
 *    person's from its .sue store, else the roster's).
 * 9: a wave's `cast`: up to CAST_MAX whole visitors the page sends for that run, a Boardroom person with no Sue
 *    body among them (lib/boardroom-cast.mjs's shape), and hello's `cast` says so.
 * 10: your own Sues (you/sues.mjs): GET /api/you (every Sue built from this person's record, which is active,
 *    each kind's blind score and arm, and a day's held reserved calls), POST /api/you/active { id } and
 *    POST /api/you/<id>/arm { kind, armed }; hello's `you` says so.
 */
export const MANAGER_VERSION = 10;
/**
 * The pages that may talk to this computer's Sues: Sue's own address, Studio's, and Boardroom's,
 * estate and mirror, nothing else.
 */
export const MANAGER_ORIGINS = [
  "https://app.example.com",
  "https://example.org",
  "https://app.example.com",
  "https://example.org",
  // Boardroom's Focus Group page: each Sue at the table with a face and a voice, and the host talking to them.
  "https://app.example.com",
  "https://example.org",
];
/** Sue's own address: the page her window shows. Studio's /sue is a tab inside Studio, not her window. */
export const WINDOW_ORIGINS = MANAGER_ORIGINS.filter((origin) => new URL(origin).hostname.startsWith("sue."));
/** The Studio and Boardroom dev servers (`studio-claude`, `boardroom-claude` in .claude/launch.json), allowed only with --dev. */
// Studio (4382) and Boardroom (4312) Claude dev servers, and Boardroom's own `bun run dev` (4212).
export const DEV_ORIGINS = [
  "http://localhost:4382",
  "http://127.0.0.1:4382",
  "http://localhost:4312",
  "http://127.0.0.1:4312",
  "http://localhost:4212",
  "http://127.0.0.1:4212",
];
/**
 * A goodbye followed by nothing from her window for this long is a window closed. A reload says
 * goodbye too, then asks again once the page is back, and is not one. Measured 2026-09-23: a cold
 * reload on the Studio dev server took longer than 4 s and read as a close, which with "Quit when you
 * close her" on would have quit her under a page that was only reloading.
 */
export const WINDOW_CLOSE_GRACE_MS = 6_000;
/** Two clicks on the icon in this long are one: a double click never opens two windows. */
const OPEN_CLICK_MS = 4_000;

const RUN_ID = RUN_ID_PATTERN;
const SUE_ID = /^sue-\d+-[a-z0-9-]+$/;
const SHOT = /^look-\d{4}\.jpg$/;
const MAIL_FILE = /^[A-Za-z0-9._-]+\.json$/;
const WORKSPACE_ID = WORKSPACE_ID_PATTERN;
const PERSON_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Owner, 2026-09-22: "the goal is maybe to spin up 30, 40 SUS at a time". `sue run` spreads them over this machine. */
export const WAVE_MAX = 40;
const RUNS_LISTED = 30;
const INTENT_MAX = 600;
/** A cast visitor's voice is a Boardroom brief, which can run to pages; three of them fit one wave's body. */
const CAST_VOICE_MAX = 16_000;
/** A Sue page's save of the folder's people (up to PERSONAS_PER_WRITE whole persons) is bigger than readBody's default. */
const PERSONAS_BODY_MAX = 512 * 1024;
const PERSONAS_PER_WRITE = 100;
/** A wave's body: its fields plus up to CAST_MAX voices. Every other request keeps readBody's own limit. */
export const WAVE_BODY_MAX = 65_536;
/** Past this many characters a wave's arguments go to `sue run` in a file: a Windows command line holds ~32k. */
const WAVE_ARGS_INLINE_MAX = 8000;
/** Every request resolves a workspace id; one discovery serves a burst of them (a poll asks several at once). */
const DISCOVERY_TTL_MS = 3000;
/** How often a page asking something is noted for `sue run` (lib/watch-window.mjs). */
const PAGE_SEEN_EVERY_MS = 5_000;
/** A file arrives as base64 (4 characters for every 3 bytes) inside a little JSON. */
const MATERIAL_BODY_MAX = Math.ceil(MATERIAL_MAX_BYTES / 3) * 4 + 64 * 1024;

// ---------------------------------------------------------------------------------------------
// Reading what the Sues wrote
// ---------------------------------------------------------------------------------------------

// A run that has finished never changes again, so its summary is worked out once (the list of a
// busy workspace's runs used to stat every Sue folder of every run on each poll). A running one is
// read at most every LIVE_SUMMARY_MS, so the toolbar's menu and the page polling together read twenty
// live waves of twenty Sues once, not twice.
const SETTLED_SUMMARIES = new Map();
const LIVE_SUMMARIES = new Map();
const LIVE_SUMMARY_MS = 2_000;
const LIVE_STATES = new Set(["starting", "running"]);

function runSummary(root, runId, manifest, now = Date.now()) {
  const key = path.join(root, runId);
  const settled = SETTLED_SUMMARIES.get(key);
  if (settled) return settled;
  const recent = LIVE_SUMMARIES.get(key);
  if (recent && now - recent.at < LIVE_SUMMARY_MS) return recent.summary;
  const summary = summarizeRun(root, runId, manifest ?? readJson(path.join(root, runId, "manifest.json")) ?? {});
  if (summary.finishedAt && !LIVE_STATES.has(summary.state)) {
    SETTLED_SUMMARIES.set(key, summary);
    LIVE_SUMMARIES.delete(key);
  } else LIVE_SUMMARIES.set(key, { at: now, summary });
  return summary;
}

/** Old runs' pictures are tidied this long after the Manager starts (after its first page), then this often. */
const PRUNE_FIRST_MS = 60_000;
const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000;

/** How often the OS is asked whether each running wave's pid is still its runner. */
const PID_CHECK_EVERY_MS = 60_000;

/**
 * Windows reuses pids: a runner that dies without writing an end leaves its run "running" beside a pid
 * the OS may hand to another process, and the run would then read as live for good. Each runner
 * records its own process creation time beside its pid (sue.mjs), so once a minute ONE query asks the
 * OS when each live run's pid was created, off the event loop; a pid created at another time is not
 * that run, and the run is settled. A runner whose own creation-time query failed (a busy box times it
 * out) recorded only `startedAt`, which it writes once it exists, so a pid created after that is not it
 * either. Off Windows, like `stopRun`'s own check, it is skipped.
 */
export function checkRunnerPids({ live = liveRuns(), settle = settleRun, run = execFile, platform = process.platform } = {}) {
  if (platform !== "win32") return;
  const known = live.filter(
    (r) => Number.isInteger(r.pid) && r.pid > 0 && (typeof r.pidCreatedAt === "number" || typeof r.startedAt === "number"),
  );
  if (!known.length) return;
  const filter = known.map((r) => `ProcessId=${r.pid}`).join(" OR ");
  run(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-CimInstance Win32_Process -Filter "${filter}" | ForEach-Object { "$($_.ProcessId) $($_.CreationDate.ToFileTimeUtc())" }`,
    ],
    { windowsHide: true, timeout: 20_000 },
    (err, stdout) => {
      if (err) return; // the next minute asks again
      const created = new Map();
      for (const line of String(stdout).split(/\r?\n/)) {
        const [pid, ticks] = line.trim().split(/\s+/).map(Number);
        if (Number.isInteger(pid) && Number.isFinite(ticks)) created.set(pid, ticks);
      }
      for (const r of known) {
        const now = created.get(r.pid);
        if (!now) continue;
        // Filetime ticks are 100 ns since 1601.
        const notItsRunner = typeof r.pidCreatedAt === "number" ? now !== r.pidCreatedAt : now / 10_000 - 11_644_473_600_000 > r.startedAt;
        if (notItsRunner) settle(r.runId);
      }
    },
  );
}

/** The newest write among a run's files and its Sues' files: when a wave that died quietly last did anything. */
function lastWriteAt(dir, sues) {
  let newest = 0;
  for (const folder of [dir, ...sues.map((n) => path.join(dir, n))])
    for (const name of listDir(folder)) {
      try {
        newest = Math.max(newest, fs.statSync(path.join(folder, name)).mtimeMs);
      } catch {
        // gone between the listing and the look
      }
    }
  return new Date(newest || Date.now()).toISOString();
}

export function summarizeRun(root, runId, manifest = readJson(path.join(root, runId, "manifest.json")) ?? {}) {
  const dir = path.join(root, runId);
  const sues = listDir(dir).filter((n) => SUE_ID.test(n));
  const done = sues.filter((n) => fs.existsSync(path.join(dir, n, "summary.json"))).length;
  let record = runRecord(runId);
  // A wave whose runner went without a word (sue.mjs `runnerGone`, the answer `liveRuns` gives) never
  // ends by itself: run 20260923-190151-aaff read "running", a bar with no end and every Sue "still
  // going" for a day after its runner died (Owner, 2026-09-24: "It doesn't have an endpoint"). It is
  // stopped here, and written down as stopped where its pid proves the runner gone (`endGoneRun`).
  if (LIVE_STATES.has(record.state) && runnerGone(runId)) {
    const finishedAt = lastWriteAt(dir, sues);
    endGoneRun(runId, finishedAt);
    record = { ...record, state: "stopped", why: [RUNNER_GONE_WHY], finishedAt };
  }
  return {
    runId,
    targetId: manifest.target ?? null,
    startUrl: manifest.startUrl ?? null,
    startedAt: manifest.started ?? null,
    finishedAt: manifest.finished ?? record.finishedAt ?? null,
    intent: record.intent,
    sue: record.sue,
    state: record.state,
    why: record.why,
    sues: sues.length,
    done,
    // A focus group's run has a room (lib/room.mjs); the page shows its table beside the Sues.
    focusGroup: isFocusGroup(dir),
  };
}

/** A workspace as the page may see it: never its folder. */
function publicWorkspace(w) {
  return { id: w.id, name: w.name, projectId: w.projectId, isEngine: w.isEngine, runs: w.runs, lastRunAt: w.lastRunAt };
}

// The page polls a live run every 2 s, and a run can hold hundreds of Sues with traces megabytes long,
// so what each Sue's files say is kept (lib/state-cache.mjs) and read again only where a file changed:
// a trace only the lines appended since the last poll (Sue at scale, fix 5, 2026-09-24).
const STATE_CACHE = createStateCache();

/**
 * One Sue as the page sees her. `read` is shaped like lib/state-cache.mjs's `freshReads`; `run` is her
 * wave's summary (its `state` and `finishedAt`), so a Sue whose wave is over reads as stopped.
 */
export function sueState(runDir, sueId, read = STATE_CACHE.reads(runDir), run = null) {
  const dir = path.join(runDir, sueId);
  const sue = read.json(path.join(dir, "sue.json")) ?? {};
  const summary = read.json(path.join(dir, "summary.json"));
  const interview = read.json(path.join(dir, "interview.json"));
  const shots = read.names(path.join(dir, "shots"), SHOT);
  const { last } = read.jsonl(path.join(dir, "trace.jsonl"));
  const email = sue.identity?.email ?? null;
  const persona = sue.persona ?? {};
  return {
    sueId,
    persona: {
      id: persona.id ?? summary?.persona ?? null,
      displayName: persona.displayName ?? persona.id ?? sueId,
      device: persona.dials?.device === "phone" ? "phone" : "desktop",
    },
    errand: typeof sue.errand === "string" ? sue.errand : null,
    outcome: summary?.outcome ?? null,
    madeAccount: typeof summary?.madeAccount === "boolean" ? summary.madeAccount : null,
    stars: typeof interview?.starsOutOfFive === "number" ? interview.starsOutOfFive : null,
    threeWords: interview?.threeWords == null ? null : String(interview.threeWords),
    looks: shots.length,
    lastShot: shots.at(-1) ?? null,
    lastUrl: typeof last?.url === "string" ? last.url : null,
    lastTool: typeof last?.tool === "string" ? last.tool : null,
    notes: read.jsonl(path.join(dir, "findings.jsonl")).count,
    mail: email ? read.names(path.join(runDir, "mail", email), MAIL_FILE).length : 0,
    costUsd: typeof summary?.totalCostUsd === "number" ? summary.totalCostUsd : null,
    // What she is doing this moment, off the file her body writes around each move (lib/activity.mjs).
    activity: activityOf({ now: read.json(path.join(dir, NOW_FILE)), summary, run }),
    email,
  };
}

// ---------------------------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------------------------

function send(res, status, body, headers = {}) {
  const isBuffer = Buffer.isBuffer(body);
  res.writeHead(status, {
    "content-type": isBuffer ? "image/jpeg" : "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(isBuffer ? body : JSON.stringify(body));
}

/** A portrait file, typed by its extension. */
function sendImage(res, file, headers) {
  const type = file.endsWith(".png") ? "image/png" : file.endsWith(".jpg") ? "image/jpeg" : "image/webp";
  return send(res, 200, fs.readFileSync(file), { ...headers, "content-type": type });
}

/**
 * Who may ask (see the header): this machine's own Host, and one of Connections' own Origins.
 * Returns the CORS headers for an allowed request, or null for a refused one.
 */
export function allowedHeaders(req, { port, origins }) {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return null;
  const origin = String(req.headers.origin ?? "");
  if (!origins.includes(origin)) return null;
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    // Chrome's older Private Network Access preflight asks this of a loopback server; its Local
    // Network Access prompt (Chrome 142+) is the person's own one-time "allow", not ours.
    "access-control-allow-private-network": "true",
    "access-control-max-age": "600",
  };
}

function readBody(req, limit = 16_384) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      // Over the limit: stop keeping it and answer 400 (the caller's catch); the rest drains unread.
      // Destroying the socket here would tear it down before that answer could be sent.
      if (size > limit) reject(new Error("body too large"));
      else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** Every wave field the page may send, checked before `sue run` sees it (which checks the rest). */
function waveArgs(body) {
  const url = String(body?.url ?? "").trim();
  if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2048) throw new Refusal("url: the web address these people are trying to use");
  const intent = String(body?.intent ?? "").trim();
  if (intent.length > INTENT_MAX) throw new Refusal(`intent: keep why they came under ${INTENT_MAX} characters`);
  const personas = Array.isArray(body?.personas) ? [...new Set(body.personas.map(String))] : [];
  if (!personas.length || personas.length > 50 || personas.some((p) => !PERSON_ID.test(p)))
    throw new Refusal("personas: pick at least one person");
  const count = Number(body?.count ?? personas.length);
  if (!Number.isInteger(count) || count < 1 || count > WAVE_MAX) throw new Refusal(`count is 1 to ${WAVE_MAX}`);
  const start = body?.start === "home" ? "home" : "link";
  const wave = { url, intent, personas, count, start };
  if (body?.profile) {
    try {
      wave.profile = assertProfileName(body.profile);
    } catch (err) {
      throw new Refusal(`profile: ${err.message}`);
    }
  }
  Object.assign(wave, focusGroupArgs(body, count));
  if (body?.brain != null) {
    // Its shape only: `sue run` holds this machine's own rule on which brains it runs (lib/claude-cli.mjs).
    const brain = String(body.brain).trim();
    if (!BRAINS.includes(brain)) throw new Refusal(`brain is one of ${BRAINS.join(", ")}`);
    wave.brain = brain;
  }
  if (body?.cast != null) wave.cast = castArgs(body.cast, personas);
  return wave;
}

/**
 * A wave's `cast`: the whole visitors the page sends for this run only (Owner, 2026-09-26: everywhere personas
 * are used pulls from yours), each a person from the member's Boardroom with no Sue body, in the shape
 * lib/boardroom-cast.mjs builds: her brief is her voice and she borrows a roster body with `extends`. Each one
 * must be among the wave's `personas`, the way `sue run` pairs them; it checks the rest (a roster id, a clash).
 */
function castArgs(cast, personas) {
  if (!Array.isArray(cast) || !cast.length || cast.length > CAST_MAX)
    throw new Refusal(`cast: send 1 to ${CAST_MAX} visitors, each { id, displayName, extends, voice }`);
  return cast.map((p) => {
    const id = String(p?.id ?? "");
    const displayName = String(p?.displayName ?? "").trim();
    const like = String(p?.extends ?? "");
    const voice = String(p?.voice ?? "").trim();
    if (!PERSON_ID.test(id) || !personas.includes(id)) throw new Refusal(`cast: "${id}" is not one of the people picked`);
    if (!displayName || displayName.length > 80) throw new Refusal(`cast: "${id}" needs a name of up to 80 characters`);
    if (!PERSON_ID.test(like)) throw new Refusal(`cast: "${id}" borrows a body with extends, a roster id`);
    if (voice.length < 40 || voice.length > CAST_VOICE_MAX)
      throw new Refusal(`cast: "${id}" needs a voice of 40 to ${CAST_VOICE_MAX} characters`);
    return { id, displayName, extends: like, voice };
  });
}

/** A focus group's guesses are sentences, as many as a moderator can put to one room. */
const SUGGESTIONS_MAX = 10;
const SUGGESTION_MAX_CHARS = 400;

/**
 * A focus-group wave's own fields (lib/room.mjs): `focusGroup`, the builders' `suggestions` for the
 * moderator to put to the room, and `moderator` ("ai", or "none" for a room the vote alone closes).
 * An ordinary wave adds none of them, so it reaches `sue run` exactly as it did; guesses or a
 * moderator on a wave that is not a focus group are refused rather than quietly dropped.
 */
function focusGroupArgs(body, count) {
  if (body?.focusGroup != null && typeof body.focusGroup !== "boolean") throw new Refusal("focusGroup is true or false");
  const suggestions = body?.suggestions ?? [];
  if (!Array.isArray(suggestions) || suggestions.some((s) => typeof s !== "string"))
    throw new Refusal("suggestions: a list of your guesses, each in words");
  const guesses = suggestions.map((s) => s.trim()).filter(Boolean);
  if (guesses.length > SUGGESTIONS_MAX) throw new Refusal(`suggestions: at most ${SUGGESTIONS_MAX} guesses for one room`);
  if (guesses.some((s) => s.length > SUGGESTION_MAX_CHARS))
    throw new Refusal(`suggestions: keep each guess under ${SUGGESTION_MAX_CHARS} characters`);
  const moderator = body?.moderator ?? null;
  if (moderator !== null && moderator !== "ai" && moderator !== "none") throw new Refusal('moderator is "ai" or "none"');
  if (body?.focusGroup !== true) {
    if (guesses.length || moderator !== null) throw new Refusal("suggestions and moderator are for a focus group (focusGroup: true)");
    return {};
  }
  if (count > FOCUS_GROUP_MAX) throw new Refusal(`a focus group seats 1 to ${FOCUS_GROUP_MAX} people`);
  return { focusGroup: true, ...(guesses.length ? { suggestions: guesses } : {}), ...(moderator ? { moderator } : {}) };
}

/** A saved login to make, as the Logins tab sends it: `{ name, site, freeHands }`. */
export function loginArgs(body) {
  try {
    return { name: assertProfileName(body?.name), site: profileSite(body?.site).url, freeHands: body?.freeHands === true };
  } catch (err) {
    throw new Refusal(String(err?.message ?? err));
  }
}

/**
 * Opens his own Chrome on the site for a saved login (`login-chrome.mjs --profile`): a real browser
 * window he signs in to and closes, and no console. `onExit(code)` is 0 when a login was saved, 3 when
 * the site had set nothing to save. Its log (counts and hosts only, never a value) sits beside the
 * Manager's own.
 */
export function startLoginWindow({ name, site, freeHands }, { onExit = () => {}, spawnImpl = spawn } = {}) {
  const dir = path.join(stateRoot(), "manager");
  fs.mkdirSync(dir, { recursive: true });
  const out = fs.openSync(path.join(dir, `login-${name}.log`), "a");
  const argv = [path.join(path.dirname(fileURLToPath(import.meta.url)), "login-chrome.mjs"), "--profile", name, "--site", site];
  if (freeHands) argv.push("--free-hands");
  const child = spawnImpl(process.execPath, argv, { windowsHide: true, stdio: ["ignore", out, out] });
  let done = false;
  const finish = (code) => {
    if (done) return;
    done = true;
    fs.closeSync(out);
    onExit(code ?? 1);
  };
  child.on("exit", finish);
  child.on("error", () => finish(1));
  return child;
}

/** The checkout's own sue.mjs: what plans a wave started from the page. */
const CHECKOUT_SUE = path.join(CHECKOUT, "sue", "sue.mjs");
/** Staging a snapshot and spawning its runner takes seconds; far longer than that is a stuck `sue`. */
const START_TIMEOUT_MS = 120_000;

/**
 * Commands this Manager is carrying out in child processes (a wave's start, a stop or a word to a room
 * handed to a run's own snapshot). They die with it, so its hand-over to new code waits for them.
 */
let inFlight = 0;
export const commandsInFlight = () => inFlight;
async function inChild(work) {
  inFlight += 1;
  try {
    return await work();
  } finally {
    inFlight -= 1;
  }
}

/**
 * Start a wave from the page the way a terminal's `sue run` does: the checkout's sue.mjs as it is on
 * disk now (`sue _start`), in a process of its own, so the wave's plan and the snapshot it runs on come
 * from the same code. This Manager keeps the code it booted on until it moves onto new code (a minute
 * or more), and a wave planned in here was the old code's plan carried out by the new code's runner
 * (2026-09-25). Off the event loop too: staging can wait seconds on a file a scanner holds. Answers
 * `sue run`'s answer; its refusal is thrown as a Refusal, in its own words.
 */
export function startWaveFromCheckout(args, { script = CHECKOUT_SUE, env = process.env } = {}) {
  return inChild(() => startWave(args, { script, env }));
}

function startWave(args, { script, env }) {
  return new Promise((resolve, reject) => {
    // A cast visitor's voice can run to pages: a long wave goes to `sue run` in a file (parseCli's --json-file).
    const json = JSON.stringify(args);
    const argsFile = json.length > WAVE_ARGS_INLINE_MAX ? path.join(tmpdir(), `sue-wave-${randomUUID()}.json`) : null;
    if (argsFile) fs.writeFileSync(argsFile, json);
    const forgetArgs = () => argsFile && fs.rmSync(argsFile, { force: true });
    const child = spawn(process.execPath, [script, "_start", ...(argsFile ? ["--json-file", argsFile] : ["--json", json])], {
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill(), START_TIMEOUT_MS);
    child.once("error", (err) => {
      clearTimeout(timer);
      forgetArgs();
      reject(new Error(`sue run could not be started: ${err.message}`));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      forgetArgs();
      if (stderr.trim()) process.stderr.write(stderr);
      let answer;
      try {
        answer = JSON.parse(stdout.trim());
      } catch {
        answer = null;
      }
      if (!answer || typeof answer !== "object")
        return reject(
          new Error(`sue run did not answer (exit ${code}): ${(stdout.trim() || stderr.trim()).slice(-300) || "nothing said"}`),
        );
      if (code !== 0 || answer.ok === false) return reject(new Refusal(String(answer.error ?? `sue run refused (exit ${code})`)));
      return resolve(answer);
    });
  });
}

/**
 * The Manager's server. Every run it reads is under `runsDir`, by ids that must match the shapes the
 * cannon writes, and every workspace is one `discoverWorkspaces` found, by the id it gave it, so no
 * request can name a path of its own. `startRun`/`stopRun` are `sue run`/`sue stop`, injected so a
 * spec can start a wave without launching one. `windowClosed` runs when Sue's own window has closed
 * (not reloaded); `tray` says whether her toolbar icon is up; `settings`/`saveSettings` are this
 * computer's window settings, injected so a spec never touches the real ones.
 */
export function createManager({
  port = MANAGER_PORT,
  origins = MANAGER_ORIGINS,
  windowOrigins = WINDOW_ORIGINS,
  runsDir = runsRoot(),
  workspaces = () => discoverWorkspaces({ runsDir }),
  startRun = (args) => startWaveFromCheckout(args),
  // A live run on another engine is stopped by that engine (sue.mjs routeLiveRunAsync), off the event loop.
  stopRun = async (args) => (await inChild(() => routeLiveRunAsync("stop", args))) ?? dispatch("stop", args),
  pageSeen = notePageSeen,
  pageGone = notePageGone,
  focus = readFocus,
  tray = () => false,
  live = () => liveRuns(),
  settings = readSettings,
  saveSettings: writeSettings = saveSettings,
  windowClosed = () => {},
  closeGraceMs = WINDOW_CLOSE_GRACE_MS,
  profiles = listProfiles,
  openLoginWindow = startLoginWindow,
  forgetLogin = forgetProfile,
  // The SUE this Manager started on, and the one on disk (lib/version-skew.mjs).
  sueVersion = () => runningSue(),
  sueOnDisk = () => currentSueVersion(),
  // A folder's people, from Connections through that folder's own binding (lib/people.mjs); a spec hands in its own.
  peopleOf = peopleOfFolder,
  // Where Studio's Sue page saves a person: Connections, through the folder's own binding (lib/people.mjs).
  savePeopleOf = saveFolderPeople,
} = {}) {
  let known = null;
  // Saved logins being made right now, and how the last try at each ended ("saved", "nothing-saved", "failed").
  const signingIn = new Set();
  const lastSignIn = new Map();
  // A page on screen asks something every few seconds; noting it at most this often is plenty for
  // `sue run` to tell that a window is already watching (lib/watch-window.mjs).
  let seenAt = 0;
  const notePage = () => {
    if (Date.now() - seenAt < PAGE_SEEN_EVERY_MS) return;
    seenAt = Date.now();
    pageSeen();
  };
  // Her window said goodbye and has not asked anything since: closed once the grace runs out.
  let closing = null;
  const cancelClosing = () => {
    if (closing) clearTimeout(closing);
    closing = null;
  };
  const allWorkspaces = () => {
    if (!known || Date.now() - known.at > DISCOVERY_TTL_MS) known = { at: Date.now(), list: workspaces() };
    return known.list;
  };
  // The first look reads every run's manifest once; done as she starts, not while her page waits.
  const warm = setTimeout(() => {
    try {
      allWorkspaces();
    } catch {
      /* the page's own first request says what is wrong */
    }
  }, 0);
  warm.unref?.();
  const server = http.createServer(async (req, res) => {
    // A Sue's own Chrome opening something a person gave her group arrives as a plain navigation,
    // which carries no Origin: this one read is answered on the Host check alone, by an id nobody
    // can guess, and only ever a file inside a workspace's material folder.
    const materialPath = (req.url ?? "").split("?")[0];
    const materialId = req.method === "GET" ? materialIdOfPath(materialPath) : undefined;
    if (materialId !== undefined) return serveMaterial(req, res, materialId, materialPath.endsWith("/view"));
    // The port it is actually listening on (a spec listens on 0 and is handed a free one).
    const cors = allowedHeaders(req, { port: server.address()?.port ?? port, origins });
    if (!cors) return send(res, 403, { error: "This Sue Manager answers only Connections' own pages, on this computer." });
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    const fromWindow = windowOrigins.includes(String(req.headers.origin ?? ""));
    // A window closing says so (the page's pagehide), so the next wave opens one at once rather than
    // waiting out the page-seen window and the open-window lock.
    if (req.method === "POST" && (req.url ?? "").split("?")[0] === "/api/bye") {
      seenAt = 0;
      pageGone();
      if (fromWindow) {
        cancelClosing();
        closing = setTimeout(() => {
          closing = null;
          windowClosed();
        }, closeGraceMs);
        closing.unref?.();
      }
      res.writeHead(204, cors);
      return res.end();
    }
    // Anything else from her window means it is still there (a reload asks again at once). The hello a
    // Manager handing its port over asks (lib/version-skew.mjs managerAnswers) is not a page.
    const handover = req.headers[HANDOVER_HEADER] === "1";
    if (fromWindow && !handover) cancelClosing();
    if (!handover) notePage();
    let url;
    try {
      url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
    } catch {
      return send(res, 400, { error: "bad address" }, cors);
    }
    const parts = url.pathname.split("/").filter(Boolean);
    try {
      if (parts[0] !== "api") return send(res, 404, { error: "not found" }, cors);
      if (req.method === "GET" && parts.length === 2 && parts[1] === "hello") {
        known = null; // a fresh look: the page asks this when it connects and after it starts a wave
        return send(
          res,
          200,
          {
            engine: "sue-manager",
            version: MANAGER_VERSION,
            // SUE's own version (lib/version.mjs), not this page protocol's `version` above: `sue` is the
            // SUE this Manager runs, `sueOnDisk` the one on disk, `sueStale` whether that has moved on.
            ...sueReport(await sueVersion(), await sueOnDisk()),
            waveMax: WAVE_MAX,
            intentMin: MIN_ERRAND_CHARS,
            workspaces: allWorkspaces().map(publicWorkspace),
            focus: focus(),
            tray: tray(),
            settings: settings(),
            running: live().length,
            // Who may think for a wave on THIS computer (lib/claude-cli.mjs sueBrainPolicy): a page that
            // starts one offers only these, so it never picks a tier `sue run` will refuse.
            brains: sueBrainPolicy()?.brains ?? BRAINS,
            // This Manager stores a file or an idea for a group (POST /api/material); an older one
            // says nothing, and a page hides its upload rather than failing on it.
            material: true,
            // A wave carries whole visitors (`cast`), a Boardroom person among them; an older one says nothing.
            cast: true,
            // Dredd's hearings and Boardroom (lib/dredd-view.mjs); an older Manager says nothing and the page hides those tabs.
            dredd: true,
            you: false,
          },
          cors,
        );
      }
      if (req.method === "POST" && parts.length === 2 && parts[1] === "settings") {
        let patch;
        try {
          patch = JSON.parse(await readBody(req));
        } catch {
          return send(res, 400, { error: 'send JSON: { "whenClosed": "toolbar" | "quit" }' }, cors);
        }
        let saved;
        try {
          saved = writeSettings(patch);
        } catch (err) {
          throw new Refusal(String(err?.message ?? err));
        }
        return send(res, 200, { settings: saved }, cors);
      }
      if (req.method === "POST" && parts.length === 2 && parts[1] === "material") return await materialRoute(req, res, cors);
      if (parts[1] === "profiles") return await profileRoute(req, res, parts.slice(2), cors);
      if (parts[1] === "workspaces") return await workspaceRoute(req, res, parts.slice(2), cors);
      if (parts[1] === "you") return await youRoute(req, res, parts.slice(2), url, cors);
      if (parts[1] === "runs" && RUN_ID.test(parts[2] ?? "")) return await runRoute(req, res, parts.slice(2), url, cors);
      return send(res, 404, { error: "not found" }, cors);
    } catch (err) {
      if (err instanceof Refusal) return send(res, 400, { error: err.message }, cors);
      // The page gets the first line; this Manager's own log keeps the whole failure.
      console.error(`${req.method} ${url.pathname} answered 500: ${err?.stack ?? err}`);
      return send(res, 500, { error: String(err?.message ?? err).split("\n")[0] }, cors);
    }
  });

  /** A person's own Sues are people: they live in the people store, not behind this Manager. */
  async function youRoute(req, res, rest, url, cors) {
    return send(res, 404, { error: "not found" }, cors);
  }

  /**
   * Something for a group to look at (lib/material.mjs): `{ name, type, base64 }` for a file or
   * `{ idea, title? }` for a typed idea, stored in the engine's own workspace and answered as
   * `{ id, url, kind, name }`. A wave is then started on `url` like on any other page.
   */
  async function materialRoute(req, res, cors) {
    let body;
    try {
      body = JSON.parse(await readBody(req, MATERIAL_BODY_MAX));
    } catch (err) {
      if (err?.message === "body too large")
        throw new Refusal(`That file is over ${MATERIAL_MAX_BYTES / 1024 / 1024} MB; a focus group takes files up to that size.`);
      return send(res, 400, { error: 'send JSON: { "name", "type", "base64" } for a file, or { "idea", "title" } for an idea' }, cors);
    }
    const home = allWorkspaces().find((w) => w.isEngine);
    if (!home) return send(res, 500, { error: "Sue has no workspace of her own on this computer to keep it in." }, cors);
    try {
      const input = typeof body?.idea === "string" ? { idea: body.idea, title: body.title } : body;
      const stored = storeMaterial(home.folder, input, { port: server.address()?.port ?? port });
      return send(res, 200, stored, cors);
    } catch (err) {
      if (err instanceof MaterialRefusal) throw new Refusal(err.message);
      throw err;
    }
  }

  /**
   * GET /material/<id> for a Sue's own Chrome: the file as it was given (a PDF, a picture) or the
   * readable page a text or an idea became. Looked for in every workspace's material folder; a run
   * started from a linked worktree is not a workspace the page lists, so its folder is asked too.
   */
  async function serveMaterial(req, res, id, view) {
    const host = String(req.headers.host ?? "").toLowerCase();
    const here = server.address()?.port ?? port;
    if (host !== `127.0.0.1:${here}` && host !== `localhost:${here}`) return send(res, 403, { error: "not here" });
    let found = id
      ? findMaterial(
          id,
          allWorkspaces().map((w) => w.folder),
        )
      : null;
    if (id && !found) {
      known = null;
      found = findMaterial(id, [...allWorkspaces().map((w) => w.folder), ...runsByFolder(runsDir).map((r) => r.folder)]);
    }
    if (!found) return send(res, 404, { error: "Nothing was given to the group under that address." });
    if (view && found.kind === "pdf") return servePdfViewer(res, id, found);
    let bytes;
    try {
      bytes = fs.readFileSync(found.file);
    } catch {
      return send(res, 404, { error: "Nothing was given to the group under that address." });
    }
    res.writeHead(200, {
      "content-type": found.type,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      // The readable page is our own escaped HTML: nothing in it may run or load. A PDF keeps no
      // such header, which would stop Chrome's own viewer from showing it.
      ...(found.kind === "text" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}),
    });
    return res.end(bytes);
  }

  async function servePdfViewer(res, id, found) {
    let html = pdfViewers.get(id);
    if (html === undefined) {
      try {
        const pages = await renderPdfPages(fs.readFileSync(found.file));
        html = pdfViewerPage({ title: path.basename(found.file), pages });
      } catch (err) {
        return send(res, 500, { error: `The pages of this PDF could not be drawn: ${String(err?.message ?? err)}` });
      }
      pdfViewers.set(id, html);
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src data:; style-src 'unsafe-inline'",
    });
    return res.end(html);
  }

  /**
   * Saved logins (lib/profiles.mjs): every one on this computer, described (never a cookie); a new one
   * or a fresh sign-in to an old one opens his own Chrome on the site; forgetting one deletes it.
   */
  async function profileRoute(req, res, [name, what, ...rest], cors) {
    const listing = () => ({ profiles: profiles(), signingIn: [...signingIn], lastSignIn: Object.fromEntries(lastSignIn) });
    if (rest.length) return send(res, 404, { error: "not found" }, cors);
    if (req.method === "GET" && name === undefined) return send(res, 200, listing(), cors);
    if (req.method === "POST" && name === undefined) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return send(
          res,
          400,
          { error: 'send JSON: { "name": "discord-owner", "site": "https://discord.com/login", "freeHands": false }' },
          cors,
        );
      }
      const login = loginArgs(body);
      if (signingIn.has(login.name)) throw new Refusal(`a Chrome window for "${login.name}" is already open: sign in there and close it`);
      signingIn.add(login.name);
      lastSignIn.delete(login.name);
      openLoginWindow(login, {
        onExit: (code) => {
          signingIn.delete(login.name);
          lastSignIn.set(login.name, code === 0 ? "saved" : code === 3 ? "nothing-saved" : "failed");
        },
      });
      return send(res, 200, listing(), cors);
    }
    if (req.method === "POST" && what === "forget") {
      let id;
      try {
        id = assertProfileName(name);
      } catch (err) {
        throw new Refusal(err.message);
      }
      if (signingIn.has(id)) throw new Refusal(`"${id}" is signing in right now; close its Chrome window first`);
      const forgotten = forgetLogin(id);
      lastSignIn.delete(id);
      return send(res, 200, { forgotten, ...listing() }, cors);
    }
    return send(res, 404, { error: "not found" }, cors);
  }

  async function workspaceRoute(req, res, [id, what, personId, ...rest], cors) {
    if (!WORKSPACE_ID.test(id ?? "")) return send(res, 404, { error: "not found" }, cors);
    const ws = allWorkspaces().find((w) => w.id === id);
    if (!ws) return send(res, 404, { error: "no such workspace on this computer" }, cors);
    if (req.method === "GET" && what === undefined) {
      // The folder's people come from Connections (lib/people.mjs), installed just before they are read.
      try {
        installPeople(await peopleOf(ws.folder));
      } catch (err) {
        return send(res, 502, { error: `this folder's people could not come from Connections: ${String(err?.message ?? err)}` }, cors);
      }
      // A person the loader refuses is listed with her `problem` and cannot be sent; this log names her once.
      const people = logRosterProblems(workspacePeople(ws));
      return send(res, 200, { workspace: publicWorkspace(ws), people, pages: workspacePages(ws), startUrls: workspaceStartUrls(ws) }, cors);
    }
    if (req.method === "GET" && what === "runs" && personId === undefined) {
      const liveNow = live();
      const liveIds = new Set(liveNow.map((r) => r.runId));
      const mine = runsByFolder(runsDir).filter((r) => workspaceId(r.folder) === ws.id);
      // A running wave is always listed, however many newer runs the folder has; the newest of the
      // rest fill the list.
      const runs = [...mine.filter((r) => liveIds.has(r.runId)), ...mine.filter((r) => !liveIds.has(r.runId)).slice(0, RUNS_LISTED)]
        .sort((a, b) => b.runId.localeCompare(a.runId))
        .map((r) => runSummary(runsDir, r.runId, r.manifest));
      // The latest wave rides on the page's poll, so a window already open jumps to a wave an AI
      // just started, in this folder or another.
      return send(res, 200, { runs, focus: focus(), running: liveNow.length }, cors);
    }
    if (req.method === "GET" && what === "people" && PERSON_ID.test(personId ?? "") && !rest.length)
      return send(res, 200, { visits: personVisits(ws, personId) }, cors);
    if (req.method === "GET" && what === "people" && PERSON_ID.test(personId ?? "") && rest.length === 1 && rest[0] === "portrait") {
      const file = ownPersonPortraitFile(ws.folder, personId) ?? personPortraitFile(personId);
      return file ? sendImage(res, file, cors) : send(res, 404, { error: "no portrait" }, cors);
    }
    // Dredd's hearings and Boardroom in this folder (lib/dredd-view.mjs): every file by an id of the shape Dredd writes.
    if (req.method === "GET" && what === "hearings") {
      const hearingId = personId;
      if (hearingId === undefined) return send(res, 200, { hearings: listHearings(ws.folder) }, cors);
      if (!HEARING_ID.test(hearingId)) return send(res, 404, { error: "not found" }, cors);
      if (!rest.length) {
        const hearing = readHearing(ws.folder, hearingId);
        return hearing ? send(res, 200, { hearing }, cors) : send(res, 404, { error: "no such hearing" }, cors);
      }
      if (rest[0] === "shots" && rest.length === 2) {
        const file = hearingShotFile(ws.folder, hearingId, rest[1]);
        if (!file) return send(res, 404, { error: "no such picture" }, cors);
        return send(res, 200, fs.readFileSync(file), { ...cors, "content-type": "image/png" });
      }
      return send(res, 404, { error: "not found" }, cors);
    }
    if (req.method === "GET" && what === "boardroom") {
      const seatId = personId;
      if (seatId === undefined) return send(res, 200, { seats: readRoster(ws.folder) }, cors);
      if (SEAT_ID.test(seatId) && rest.length === 1 && rest[0] === "portrait") {
        const file = portraitFile(seatId);
        return file ? sendImage(res, file, cors) : send(res, 404, { error: "no portrait" }, cors);
      }
      return send(res, 404, { error: "not found" }, cors);
    }
    // This folder's own people, as Connections holds them (lib/people.mjs): the Sue page compares them with the
    // workspace's copy it reads itself, and the two are one. Nothing is written here: a person lives in Connections.
    if (req.method === "GET" && what === "personas" && personId === undefined) {
      try {
        const own = (await peopleOf(ws.folder)).filter((p) => p?.builtIn !== true).map(({ doc, updatedAt }) => ({ doc, updatedAt }));
        return send(res, 200, { personas: own }, cors);
      } catch (err) {
        return send(res, 502, { error: `this folder's people could not come from Connections: ${String(err?.message ?? err)}` }, cors);
      }
    }
    // A person edited on Studio's Sue page: checked by the loader a run uses (lib/workspace.mjs checkPersonaDoc), then
    // saved to Connections through this folder's own binding. Nothing is written in the folder: she lives in Connections
    // (Owner, 2026-09-28), and `saved` names only the copies Connections kept (a newer one there wins).
    if (req.method === "POST" && what === "personas" && personId === undefined) {
      let body;
      try {
        body = JSON.parse(await readBody(req, PERSONAS_BODY_MAX));
      } catch {
        return send(
          res,
          400,
          { error: "send JSON: { personas: [ { doc: { id, displayName, extends, voice, errands, dials }, updatedAt } ] }" },
          cors,
        );
      }
      const list = Array.isArray(body?.personas) ? body.personas : [];
      if (!list.length || list.length > PERSONAS_PER_WRITE) throw new Refusal(`personas: 1 to ${PERSONAS_PER_WRITE} at a time`);
      try {
        installPeople(await peopleOf(ws.folder));
      } catch (err) {
        return send(res, 502, { error: `this folder's people could not come from Connections: ${String(err?.message ?? err)}` }, cors);
      }
      const checked = [];
      const refused = [];
      for (const item of list) {
        try {
          const updatedAt = Number.isFinite(Date.parse(item?.updatedAt))
            ? new Date(item.updatedAt).toISOString()
            : new Date().toISOString();
          checked.push({ doc: checkPersonaDoc(item?.doc), updatedAt });
        } catch (err) {
          refused.push({ id: String(item?.doc?.id ?? ""), why: String(err?.message ?? err).split("\n")[0] });
        }
      }
      const saved = [];
      if (checked.length) {
        let answer;
        try {
          answer = await savePeopleOf(ws.folder, checked);
        } catch (err) {
          return send(res, 502, { error: `Connections did not save them: ${String(err?.message ?? err)}`, refused }, cors);
        }
        for (const copy of checked) {
          const no = answer.refused.find((r) => r?.id === copy.doc.id);
          const kept = no ? { saved: false, why: no.why } : keptCopy(answer.people, copy);
          if (kept.saved) saved.push(copy);
          else refused.push({ id: copy.doc.id, why: kept.why });
        }
      }
      known = null;
      return send(res, 200, { saved, refused }, cors);
    }
    if (req.method === "POST" && what === "waves" && personId === undefined) {
      let body;
      try {
        body = JSON.parse(await readBody(req, WAVE_BODY_MAX));
      } catch {
        return send(res, 400, { error: "send JSON: { url, intent, personas, count }" }, cors);
      }
      const started = await startRun(await withMaterialPages({ ...waveArgs(body), workspace: ws.folder }));
      known = null; // the new run belongs to this workspace from its first second
      return send(
        res,
        200,
        { ok: true, runId: started.runId, count: started.count, personas: started.personas, profile: started.profile ?? null },
        cors,
      );
    }
    return send(res, 404, { error: "not found" }, cors);
  }

  /**
   * A focus group's room (lib/room.mjs): GET is the whole table as it stands (`roomSnapshot`: who
   * sits there and where each one is, every line said, the problems on the table and the verdict);
   * POST `{ text }` is the host, the person on the page, saying something to the room. Every Sue and
   * the moderator hear it next time they listen. A run that is not a focus group has no room, and
   * speaking to it never opens one.
   */
  async function roomRoute(req, res, runDir, cors) {
    if (!isFocusGroup(runDir)) return send(res, 404, { error: "this run is not a focus group" }, cors);
    if (req.method === "GET") return send(res, 200, roomSnapshot(runDir), cors);
    if (req.method !== "POST") return send(res, 404, { error: "not found" }, cors);
    let body;
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return send(res, 400, { error: 'send JSON: { "text": "what you want to say to the room" }' }, cors);
    }
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    if (!text) throw new Refusal("text: say something to the room");
    // Refused, never cut: a host's words reach the room whole or not at all.
    if (text.length > LINE_MAX_CHARS) throw new Refusal(`text: keep it under ${LINE_MAX_CHARS} characters`);
    // A room still in session on another snapshot of Sue's code (started before the checkout moved on,
    // lib/engine-store.mjs) hears the host through that snapshot's own `sue room_say`, which writes the
    // line the way its Sues read it.
    const routed = await inChild(() => routeLiveRunAsync("room_say", { runId: path.basename(runDir), text }));
    if (routed) return send(res, 200, { line: routed.line }, cors);
    const line = appendLine(runDir, HOST_ID, { kind: "say", name: "The host", text });
    return send(res, 200, { line }, cors);
  }

  async function runRoute(req, res, [runId, what, sueId, leaf, ...rest], url, cors) {
    const runDir = path.join(runsDir, runId);
    // A focus group's room is opened by `sue run` before the cannon writes the manifest, and a page
    // that just started one asks for it at once: the room answers from its own files.
    if (what === "room" && sueId === undefined && isFocusGroup(runDir)) return await roomRoute(req, res, runDir, cors);
    const manifest = readJson(path.join(runDir, "manifest.json"));
    if (!manifest) return send(res, 404, { error: "no such run" }, cors);
    if (req.method === "POST" && what === "stop" && sueId === undefined) {
      const out = await stopRun({ runId, workspace: runFolder(manifest) });
      return send(res, 200, { ok: true, stopped: Boolean(out?.stopped), why: out?.why ?? null }, cors);
    }
    if (what === "room" && sueId === undefined) return await roomRoute(req, res, runDir, cors);
    if (req.method !== "GET" || rest.length) return send(res, 404, { error: "not found" }, cors);
    if (what === undefined) {
      const read = STATE_CACHE.reads(runDir);
      const run = runSummary(runsDir, runId, manifest);
      const sues = listDir(runDir)
        .filter((n) => SUE_ID.test(n))
        .sort()
        .map((n) => {
          const { email: _email, ...state } = sueState(runDir, n, read, run);
          return state;
        });
      return send(res, 200, { ...run, sues }, cors);
    }
    if (what === "report" && sueId === undefined) {
      let markdown;
      try {
        markdown = fs.readFileSync(path.join(runDir, "report.md"), "utf8");
      } catch {
        return send(res, 404, { error: "no report yet" }, cors);
      }
      return send(res, 200, { markdown }, cors);
    }
    if (what !== "sues" || !SUE_ID.test(sueId ?? "") || !leaf) return send(res, 404, { error: "not found" }, cors);
    const dir = path.join(runDir, sueId);
    if (!fs.existsSync(dir)) return send(res, 404, { error: "no such Sue" }, cors);

    switch (leaf) {
      case "shot": {
        const named = url.searchParams.get("name");
        if (named != null && !SHOT.test(named)) return send(res, 400, { error: "bad picture name" }, cors);
        const name = named ?? sueState(runDir, sueId).lastShot;
        if (!name) return send(res, 404, { error: "no picture yet" }, cors);
        let jpeg;
        try {
          jpeg = fs.readFileSync(path.join(dir, "shots", name));
        } catch {
          return send(res, 404, { error: "no such picture" }, cors);
        }
        return send(res, 200, jpeg, cors);
      }
      case "journal":
        return send(
          res,
          200,
          {
            lines: readJsonl(path.join(dir, "findings.jsonl")).map((r) => ({
              at: r.at ?? null,
              source: r.source === "brain" ? "brain" : "body",
              kind: r.kind ?? null,
              text: r.text == null ? "" : String(r.text),
              url: typeof r.url === "string" ? r.url : null,
            })),
          },
          cors,
        );
      case "looks":
        // When she took each look, so the page can put each journal line beside the look it followed.
        return send(res, 200, { looks: lookTimes(readJsonl(path.join(dir, "trace.jsonl"))) }, cors);
      case "inbox": {
        const { email } = sueState(runDir, sueId);
        const box = email ? path.join(runDir, "mail", email) : null;
        const messages = (box ? listDir(box) : [])
          .filter((n) => MAIL_FILE.test(n))
          .map((n) => {
            const m = readJson(path.join(box, n)) ?? {};
            // Text only: an email's HTML is somebody else's page and is never handed to ours.
            return {
              id: n.slice(0, -5),
              from: m.from == null ? "" : String(m.from),
              subject: m.subject == null ? "" : String(m.subject),
              receivedAt: m.receivedAt ?? m.deliveredAt ?? null,
              preview: String(m.text ?? "")
                .replace(/\s+/g, " ")
                .trim()
                .slice(0, 400),
            };
          })
          .sort((a, b) => String(b.receivedAt ?? "").localeCompare(String(a.receivedAt ?? "")));
        return send(res, 200, { messages }, cors);
      }
      case "interview": {
        const interview = readJson(path.join(dir, "interview.json"));
        return interview ? send(res, 200, interview, cors) : send(res, 404, { error: "she has not finished" }, cors);
      }
      default:
        return send(res, 404, { error: "not found" }, cors);
    }
  }

  server.on("close", cancelClosing);
  return server;
}

function parseArgs(argv) {
  const o = { port: MANAGER_PORT, open: true, tray: true, dev: false, page: MANAGER_PAGE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--port") o.port = Number.parseInt(argv[++i], 10);
    else if (a === "--no-open") o.open = false;
    else if (a === "--no-tray") o.tray = false;
    else if (a === "--dev") o.dev = true;
    else if (a === "--page") o.page = argv[++i];
    else if (a === "--handover") o.handover = true;
    else throw new Error(`unknown flag ${a} (usage: node sue/manager.mjs [--port N] [--no-open] [--no-tray] [--dev] [--page URL])`);
  }
  if (!Number.isInteger(o.port) || o.port < 1024 || o.port > 65535) throw new Error("--port wants a number from 1024 to 65535");
  return o;
}

/** How often the toolbar's menu and hover text look at what is running. */
const MENU_EVERY_MS = 3_000;
/** Running waves the menu gives a row each; the rest are one "N more running" row (tray.ps1 draws it). */
const MENU_ROWS = 5;

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null; // a run whose start address is not one yet (its cannon is still starting)
  }
}

/**
 * The waves running now as the toolbar's menu lists them: the newest `rows` as `{ runId, host, done,
 * total }` (done = Sues who finished, total = the wave's planned size), and how many more are running
 * beyond them. Only the listed ones are read, so twenty waves at once cost what five do. `live` is
 * `liveRuns` from sue.mjs, newest first.
 */
export function menuWaves(runsDir, live = liveRuns(), rows = MENU_ROWS) {
  const waves = live.slice(0, rows).map(({ runId, count }) => {
    const s = runSummary(runsDir, runId);
    return { runId, host: hostOf(s.startUrl) ?? "starting", done: s.done, total: count ?? s.sues };
  });
  return { waves, more: Math.max(0, live.length - waves.length) };
}

/** The icon's hover text: the one wave running, how many are, or just her name. */
export function menuTip({ waves, more }, version = null) {
  const total = waves.length + more;
  // Her version leads, so hovering the icon says which SUE is installed (lib/version.mjs).
  const sue = version ? `Sue ${version}` : "Sue";
  if (!total) return sue;
  if (total === 1) return `${sue}: ${waves[0].host}, ${waves[0].done} of ${waves[0].total} done`;
  return `${sue}: ${total} waves running`;
}

/** How often the Manager asks git which SUE is on this disk, and whether the checkout's code changed. */
const SUE_VERSION_EVERY_MS = 60_000;
/** How often the Manager collects snapshots no wave runs on (lib/engine-store.mjs). */
const COLLECT_EVERY_MS = 60 * 60_000;
/** How long a starting Manager keeps trying for a port the Manager it replaces is still letting go of. */
const BIND_RETRY_MS = 15_000;
let sueStamp = null;
let sueStampAt = 0;
let sueStampReading = null;

/**
 * SUE's version ON THIS DISK (lib/version.mjs), for hello's `sueOnDisk` and the Manager's version watch
 * (lib/version-skew.mjs; what it runs is `runningSue`): read off the event loop at most once a minute.
 * The first ask waits for the read (about a second); every later one gets the last stamp at once while
 * a fresh read runs behind it.
 */
export function currentSueVersion(read = readSueVersionAsync, now = Date.now()) {
  if (!sueStampReading && now - sueStampAt >= SUE_VERSION_EVERY_MS) {
    sueStampReading = read()
      .then((stamp) => {
        sueStamp = stamp;
        sueStampAt = now;
        return stamp;
      })
      .finally(() => {
        sueStampReading = null;
      });
  }
  return sueStamp ?? sueStampReading;
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  // The code this Manager runs (lib/engine-store.mjs): the checkout's, as it stood now. Every wave it
  // starts runs on a snapshot of the checkout instead, so a refresh of this process (below) never moves one.
  // Only code that kept changing through every read has no id yet: this Manager then moves onto the
  // code once it has settled (lib/manager-refresh.mjs), which costs one restart.
  let bootCode = null;
  try {
    bootCode = currentEngineId();
  } catch (err) {
    console.error(`Sue's code could not be read whole at start: ${err?.message ?? err}`);
  }
  const origins = o.dev ? [...MANAGER_ORIGINS, ...DEV_ORIGINS] : MANAGER_ORIGINS;
  const windowOrigins = o.dev ? [...WINDOW_ORIGINS, ...DEV_ORIGINS] : WINDOW_ORIGINS;
  const runsDir = runsRoot();
  let icon = null;
  let server = null;

  // A running wave's row in the menu: her window follows the focus to that run (lib/watch-window.mjs).
  const focusRun = (runId) => {
    const manifest = readJson(path.join(runsDir, runId, "manifest.json"));
    if (manifest) noteFocus({ folder: runFolder(manifest), runId, picked: true });
  };
  // The icon's click, when no window of hers is on screen to bring back (lib/tray.ps1 tries that first).
  let openedAt = 0;
  const openFromToolbar = (runId = null) => {
    if (runId) focusRun(runId);
    if (Date.now() - openedAt < OPEN_CLICK_MS) return;
    openedAt = Date.now();
    noteWindowOpened();
    if (!openWindow(o.page)) icon?.say("Sue", `No Chrome or Edge found. Open ${o.page} in a Chromium browser.`);
  };
  const quit = () => {
    icon?.close();
    noteManagerDown();
    server?.close();
    // The icon's input has ended; give it a moment to clear itself from the toolbar.
    setTimeout(() => process.exit(0), 300).unref();
  };
  const windowClosed = () => {
    if (readSettings().whenClosed === "quit") {
      console.log("Her window closed: quitting (Settings, Quit when you close her).");
      return quit();
    }
    console.log("Her window closed: shrunk to the toolbar.");
    icon?.say("Sue shrunk to the toolbar", "She keeps watching your runs. Click her icon to open her again.");
  };

  // The Settings tab's keepPictures (lib/retention.mjs): off (`forever`) unless the person picked days.
  // Once shortly after start, after every save, after every wave ends, and every PRUNE_EVERY_MS. Every
  // prune that freed or failed writes one log line and a toast (decide-48: never fails silently).
  const prune = () => {
    const keepDays = keepDaysOf(readSettings().keepPictures);
    if (!keepDays) return;
    let result;
    try {
      result = pruneRuns(runsDir, { keepDays });
    } catch (err) {
      result = { runs: 0, bytes: 0, errors: [String(err?.message ?? err)] };
    }
    const line = pruneSummary(result);
    if (!line) return;
    if (result.errors.length) console.error(`Keeping ${keepDays} days of pictures: ${line}.`);
    else console.log(`Keeping ${keepDays} days of pictures: ${line}.`);
    icon?.say(result.errors.length ? "Sue could not tidy old runs" : "Sue tidied old runs", `${line[0].toUpperCase()}${line.slice(1)}.`);
  };
  // A wave that was live a minute ago and is not now has ended: tidy after it.
  let liveBefore = new Set(liveRuns().map((r) => r.runId));
  const pruneAfterWaves = () => {
    const liveNow = new Set(liveRuns().map((r) => r.runId));
    const ended = [...liveBefore].some((id) => !liveNow.has(id));
    liveBefore = liveNow;
    if (ended) prune();
  };
  const saveAndPrune = (patch) => {
    const saved = saveSettings(patch);
    setImmediate(prune);
    return saved;
  };
  const logins = countingLogins(startLoginWindow);
  server = createManager({
    port: o.port,
    origins,
    windowOrigins,
    runsDir,
    tray: () => Boolean(icon?.alive),
    windowClosed,
    saveSettings: saveAndPrune,
    openLoginWindow: logins.open,
  });
  setTimeout(prune, PRUNE_FIRST_MS).unref();
  setInterval(prune, PRUNE_EVERY_MS).unref();
  setInterval(pruneAfterWaves, PID_CHECK_EVERY_MS).unref();
  // This process keeps the code it started with. When the checkout's code changes (or a newer SUE number
  // lands) it hands the port to a Manager on the new code, running waves or not: each wave runs on its
  // own snapshot. It waits only for what this process alone carries: a sign-in window it is watching,
  // and a wave whose Sues read a file or an idea it serves (lib/manager-refresh.mjs; 2026-09-22's 884
  // answers of 500 came from a Manager that never moved on). Its hello says it is stale until then.
  runningSue();
  watchCode({
    bootKey: bootCode,
    currentKey: async () => codeKey(currentEngineId(), await runningSue(), await currentSueVersion()),
    busy: () => logins.count() + commandsInFlight() + liveRuns().filter((run) => runServedByManager(run.runId)).length,
    // Handed over once the successor answers the page's own hello, as the page would ask it.
    handOver: () =>
      handOver({
        server,
        port: o.port,
        start: () => startSuccessor(process.argv.slice(2)),
        answers: (at) => managerAnswers(at, { origin: origins[0] }),
      }),
    done: quit,
    everyMs: SUE_VERSION_EVERY_MS,
  });
  // Snapshots no wave runs on any more (lib/engine-store.mjs); `sue run` also collects after each start.
  const collect = () =>
    Promise.resolve()
      .then(() => collectGarbage({ keep: [currentEngineId()] }))
      .then(({ removed, skipped }) => {
        if (removed.length) console.log(`Sue's engine store: removed ${removed.map((r) => r.id).join(", ")}.`);
        for (const s of skipped) console.error(`Sue's engine store: ${s.id} left for next time: ${s.reason}.`);
      })
      .catch((err) => console.error(`Sue's engine store could not be collected: ${err?.message ?? err}`));
  setTimeout(collect, PRUNE_FIRST_MS).unref();
  setInterval(collect, COLLECT_EVERY_MS).unref();
  // A Manager handing this port over closes it a moment before it starts this one; one that finds the
  // port still held tries again for BIND_RETRY_MS before it gives up.
  const bindBy = Date.now() + BIND_RETRY_MS;
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE" && Date.now() < bindBy) {
      setTimeout(() => server.listen(o.port, "127.0.0.1"), 500);
      return;
    }
    if (err.code === "EADDRINUSE") {
      console.error(`Port ${o.port} is taken: a Sue Manager may already be running. Open ${o.page}, or pass --port.`);
    } else console.error(err);
    process.exit(1);
  });
  server.listen(o.port, "127.0.0.1", async () => {
    console.log(`Sue Manager is listening on 127.0.0.1:${o.port} for ${origins.join(", ")}.`);
    const withIcon = o.tray && trayAvailable();
    // Said before the icon is up (it takes a second or two), so a `sue watch` started meanwhile finds this
    // Manager and opens no second window (lib/watch-window.mjs showWatcher).
    noteManagerUp({ port: o.port, version: MANAGER_VERSION, tray: withIcon });
    if (!o.open) console.log(`Open ${o.page} to see your Sues.`);
    else if (openWindow(o.page)) {
      noteWindowOpened();
      console.log(`Opened ${o.page} in your own browser.`);
    } else console.log(`No Chrome or Edge found. Open ${o.page} in a Chromium browser.`);
    if (!withIcon) return;
    const iconGone = () => noteTrayGone();
    icon = startTray({
      onOpen: openFromToolbar,
      onShow: focusRun,
      onQuit: quit,
      onGone: (code) => {
        console.error(`The toolbar icon ended (exit ${code}); the window still works at ${o.page}.`);
        iconGone();
      },
    });
    const up = await icon.ready;
    console.log(up ? "Sue is in the toolbar." : "The toolbar icon did not start.");
    if (!up) return iconGone();
    // A Manager taking over on new code greets nobody (lib/version-skew.mjs successorArgs).
    if (!o.open && !o.handover) icon.say("Sue is in the toolbar", "Click her icon to watch your runs.");
    // The menu lists the waves running now, like a list of live sessions, and the hover text says so.
    let shown = null;
    const feedMenu = async () => {
      const menu = menuWaves(runsDir);
      const version = (await runningSue())?.version ?? null;
      const key = JSON.stringify({ menu, version });
      if (key === shown) return;
      shown = key;
      icon?.runs(menu.waves, menu.more);
      icon?.tip(menuTip(menu, version));
    };
    feedMenu();
    setInterval(feedMenu, MENU_EVERY_MS).unref();
  });
  // A wave whose runner died and whose pid was reused stops reading as running (the menu, the page's
  // list and its glow all ask liveRuns).
  checkRunnerPids();
  setInterval(() => checkRunnerPids(), PID_CHECK_EVERY_MS).unref();
  // Wrapped: "exit" passes its code, which as a pid would never match this Manager's record.
  process.on("exit", () => noteManagerDown());
}

if (isMainModule(import.meta.main, import.meta.url)) {
  main().catch((err) => {
    console.error(err?.message ?? err);
    process.exit(1);
  });
}
