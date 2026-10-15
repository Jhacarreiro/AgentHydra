#!/usr/bin/env node
/**
 * cannon - the launcher: N Sues, M at a time, forever if asked. Owns the run dir and the ledger.
 * ============================================================================================
 *
 * WHAT: started by `sue run` only (lib/door.mjs; by hand it does `--dry-run` and nothing else), whose
 * runner passes `--target connections --scenario first-visit --personas grandma,tiktok --count 12
 * --run-id <id> --concurrency 6 [--forever] [--stampede] [--max-accounts N] [--no-fairjob]
 * [--no-mailroom] [--model <model>] [--brain chat|deepseek|openrouter] [--as <name> | --profile <name>]`. For every Sue
 * it makes a dir, writes `sue.json` (the body's whole world), `brain-system.md` (who she is, in
 * words) and `mcp.json` (the CLI's pointer at her body), spawns a sealed Claude CLI session
 * through `lib/claude-cli.mjs`, waits, and writes `summary.json` from the final result event.
 * One mailroom per run is started as a hidden child when the target's mailbox is SES inbound.
 * At the end (and every 60s under `--forever`) `report.mjs` aggregates the run.
 *
 * WHY IT EXISTS: the owner's ask in `sue/SPEC.md`: "a cannon shooting little people out,
 * and they're going to be hitting the wall and splatting nonstop". The cannon is the only process
 * that hands out Sue numbers and the only one that appends to the account ledger, because those
 * two counters are what keep a stampede of real sign-ups on a real identity store accounted for:
 * `--max-accounts` per run (default 25) refuses to launch past it and says so. There is NO daily
 * ceiling on Sues, here or on the server (Owner, 2026-09-23: credits meter Sue, not a day count).
 *
 * `--stampede`: every Sue in a wave is spawned, the cannon waits for each body to touch
 * `<sueDir>/ready` (its browser is up), then writes `<sueDir>/go` for all of them in the same
 * second. The body, when `sue.json` says `stampede: true`, holds its first tool call until `go`
 * exists. Load findings are only meaningful when the wall is hit at once.
 *
 * `--focus-group` (Owner, 2026-09-23: "tons of Sues go into a room ... the Sues can see and talk to
 * each other ... they all agree and they give you literally what their biggest problem is"): the
 * run's room (lib/room.mjs, opened by `sue run` before this starts) seats every Sue at once, one wave
 * the size of the table. The cannon writes the roster, hands each Sue the table on top of her errand,
 * starts the moderator beside them (a chat agent through the relay, or a sealed CLI brain on
 * moderator.mjs), keeps the vote watchdog, and closes the room by vote when every Sue is done and
 * nobody concluded.
 *
 * `--concurrency` above 8 re-executes this same command line under
 * `%USERPROFILE%/.claude/tools/fairjob.cmd -Weight 3` unless `--no-fairjob`: nine browsers plus
 * nine CLI sessions is a load generator, and this is a shared box (owner rule).
 *
 * Runtime is plain `node` v22, never bun: bun hangs Playwright's chromium launch on this box
 * (`.arkitect/runners/flow-walk.mjs` header), and the bodies this spawns launch chromium.
 *
 * WHO DEPENDS ON IT: the operator; `reap.mjs` imports `runSue` to send a janitor Sue back into
 * each account; `tests/cannon.spec.mjs` drives `--dry-run --json`.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import { argusSidsIn } from "./lib/argus-ids.mjs";

import { resolveChromiumPath } from "../lib/shared/browser-launch.mjs";
import { SUES_PER_HOST, createHostPool } from "./lib/body-host.mjs";
import { acquireSharedBrowser } from "./lib/shared-browser.mjs";
import { buildChatBrief, buildModeratorChatBrief, createBodyRelay, writeSealedLaunch } from "./lib/body-relay.mjs";
import { createSealedDispatcher } from "./lib/climayte-dispatch.mjs";
import { readingModeOf } from "./lib/reading-pace.mjs";
import {
  BRAINS,
  SUE_DEFAULT_MODEL,
  assertBrain,
  brainEnv,
  buildClaudeArgs,
  buildPreflightArgs,
  cliRefusalAdvice,
  describeClaudeCli,
  killBrainTree,
  modelForBrain,
  resolveClaudeCli,
  spawnBrain,
  sueMcpConfig,
} from "./lib/claude-cli.mjs";
import {
  conclude,
  FOCUS_GROUP_MAX,
  focusGroupBrief,
  isFocusGroup,
  markGone,
  MODERATOR_ID,
  moderatorBrief,
  phaseOf,
  readMeta,
  readRoster,
  readVerdict,
  ROOM_DIR,
  ROOM_META_FILE,
  TABLE_MAX_MS,
  VOTE_GRACE_MS,
  voteShouldClose,
  writeRoster,
} from "./lib/room.mjs";
import { brainErrorFrom, browserArgsFor, browserModeFor, idleEndFrom, judgesScreens } from "./lib/findings.mjs";
import { createWindowHiderHold } from "./lib/window-hider.mjs";
import { legsOf } from "./lib/clock.mjs";
import { describeSession, mustSignUpForReal, probeSession, readSession, sessionFile } from "./lib/sessions.mjs";
import { cameThroughSueRun, DOOR_REFUSAL } from "./lib/door.mjs";
import { describeProfile, readProfile } from "./lib/profiles.mjs";
import { onConnectionsSite } from "./lib/site-owner.mjs";
import {
  applyScenarioErrands,
  buildScenarioPrompt,
  errandOf,
  installPeople,
  knownAddressesOf,
  loadPersona,
  loadScenario,
  loadTarget,
  mintIdentity,
  pinCriticMinds,
  scenarioFiles,
  supportRule,
  synthesizePersona,
  withPersonaQuestions,
} from "./lib/personas.mjs";
import { readyPeople } from "./lib/people.mjs";
import { bringHerFiles } from "./lib/sample-files.mjs";
import {
  accountsToday,
  appendAccountLedger,
  mailDir,
  newRunId,
  nextSueNumber,
  peekSueNumber,
  readManifest,
  runDir,
  runsRoot,
  stateRoot,
  sueDir as sueDirOf,
  writeManifest,
} from "./lib/run-dir.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BODY = path.join(HERE, "body.mjs");
/** Under `--tape` her body is the browserless one that answers from a recorded tape folder (tape/body.mjs). */
const TAPE_BODY = path.join(HERE, "tape", "body.mjs");
const PERSONAS = path.join(HERE, "lib", "personas.mjs");

/**
 * Her system prompt, rendered by a fresh node from the files on disk NOW, the way her body is a
 * fresh node. Built in-process, a `--forever` cannon kept serving the prompt of the modules it
 * imported at startup while every body edit went live, so one run held Sues asked for
 * starsOutOfFive by their tools whose prompts never mentioned it (2026-09-21). Fails loudly: a Sue
 * with no prompt is not a Sue.
 */
export function renderBrainSystemPrompt(args) {
  const r = spawnSync(process.execPath, [PERSONAS, "--brain-prompt"], {
    input: JSON.stringify(args),
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.status !== 0 || !r.stdout)
    throw new Error(`rendering her system prompt failed: ${String(r.stderr || r.error || "no output").slice(0, 500)}`);
  return r.stdout;
}
const HAND = path.join(HERE, "hand.mjs");
/** Her hands as an MCP server, the one tool of a sealed chat brain (lib/body-relay.mjs writeSealedLaunch). */
const HANDS_MCP = path.join(HERE, "hands-mcp.mjs");
const MODERATOR = path.join(HERE, "moderator.mjs");
const MAILROOM = path.join(HERE, "mailroom.mjs");
const REPORT = path.join(HERE, "report.mjs");
/**
 * One turn with no tools: a healthy login answers it in seconds. A hung CLI must not hold the run
 * before a Sue number or an address is spent, so the preflight gets a bound of its own.
 */
const PREFLIGHT_TIMEOUT_MS = 120_000;

export const DEFAULTS = {
  target: "connections",
  scenario: "first-visit",
  personas: ["grandma"],
  /** `--sampled N`: N more visitors drawn from word lists by the run id (lib/personas.mjs synthesizePersona). */
  sampled: 0,
  count: 1,
  /** `"auto"` sizes the wave from this machine's FREE memory - see `waveCeiling`. A number pins it. */
  concurrency: "auto",
  forever: false,
  stampede: false,
  maxAccounts: 25,
  /** `--max-minutes <n>`: no Sue STARTS after this many minutes (runMaxMinutes; 0 = no cap). */
  maxMinutes: null,
  dryRun: false,
  json: false,
  fairjob: true,
  mailroom: true,
  /** `--no-preflight` skips the one-turn login probe. Only for a test that must not spend a turn. */
  skipPreflight: false,
  /** `--run-id <id>`: the caller already told somebody this id (sue.mjs returns it before the run starts). */
  runId: null,
  model: null,
  /** `--as <name>`: a session saved by login.mjs that every Sue arrives signed in with. Never on a site she can sign up to herself (`mustSignUpForReal`). */
  as: null,
  /** `--profile <name>`: a saved login (lib/profiles.mjs, the Sue Manager's Logins tab) every Sue arrives signed in with, on any site. Same rails as `--as`. */
  profile: null,
  /** Which tier thinks for her: `chat` (the calling chat's own agents, default), `deepseek` (the HSwarm
   *  recipe) or `openrouter` (the same over OpenRouter's key pool) - the last two still spawn the real
   *  Claude Code CLI, just driven by that key instead of a login (the Chair, 2026-09-23: no CLI logins). */
  brain: process.env.SUE_BRAIN || "chat",
  /** `--dispatch climayte`: a chat-brain run sends each Sue to CliMayte as one sealed task itself (lib/climayte-dispatch.mjs). */
  dispatch: null,
  /** `--reading paced`: each Sue reads one screen at a time and waits the real seconds it takes (lib/reading-pace.mjs). */
  reading: null,
  /** `--tape <dir>`: every Sue visits this recorded tape (tape/FORMAT.md) with no browser; null = the live site. */
  tape: null,
  /** `--focus-group`: the run's room is open (lib/room.mjs) and every Sue sits at its table. */
  focusGroup: false,
  readyTimeoutMs: 120_000,
  reportEveryMs: 60_000,
};

const FAIRJOB_ABOVE = 8;

/**
 * ⛔ THE WAVE SIZES ITSELF, AND THE DEFAULT PROTECTS THE MACHINE (owner directive, the owner,
 * 2026-09-21: "you are killin my pc ... find a better cleaner way").
 *
 * Measured that day on his 20-core / 48 GB box: a 25-wide wave took FREE memory from 14.4 GB to
 * 6.9 GB and the desktop became unusable while it ran. Nobody should have to know that, or remember
 * to pass `--concurrency`, so the cannon reads free memory and decides.
 *
 * The constants are MEASURED, not guessed. 2026-09-21, after the shared browser landed: the wave's
 * ONE browser is a ~1 GB FIXED cost however many Sues run (9 processes, measured 0.99 GB).
 *
 * RE-MEASURED 2026-09-24, after her body moved into shared host processes (lib/body-host.mjs), her
 * tab started resting while she thinks (lib/rest.mjs) and her pictures shrank (body.mjs
 * PICTURE_JPEG), with real body code on one shared headless browser and a local page (scratchpad
 * sue-scale/bodies2.mjs, the owner's 20-core box). Private memory of the browser and the bodies:
 *   - 10 Sues 2276 MB -> 1046 MB, 50 Sues 10274 MB -> 3858 MB; each extra Sue 200 MB -> 70 MB (75 MB
 *     on a page with a spinner, a pulsing banner and a poll). The 50 bodies' node went 6774 -> 420 MB.
 *   - a CLI brain (claude.exe, sealed, pointed at a model that never answers): 316 MB, 1.1 s of CPU
 *     to start. So a CLI Sue is 75 + 316 = ~390 MB: `PER_SUE_MB`. (A chat-tier Sue has no brain on
 *     this machine and is ~75 MB; that tier sizes its own wave, see main().)
 *   - CPU: 50 Sues moving every 2.5-8.5 s (faster than any real brain) kept 5.81 cores busy, 0.12
 *     of a core each; with the brain's own start that is 0.2 of a core, five Sues a core
 *     (`SUES_PER_CORE`). Idle between moves the same 50 took 0.54 cores (5.73 before the rest),
 *     and no move failed in 1150 either way.
 * So the old fixed ceiling of 8 is gone: the wave is what free memory and cores allow, less
 * `RESERVE_MB` and `RESERVE_CORES` left alone for whatever the human is doing, and never more than
 * `HARD_CEILING` (four full body hosts) on the cannon's own say-so. On the owner's box on a normal day
 * (~25 GB free) memory binds at ~47.
 *
 * An explicit `--concurrency N` always wins: this is a floor on care, never a cap on intent.
 */
const PER_SUE_MB = 390;
const FIXED_BROWSER_MB = 1_024;
const RESERVE_MB = 6_144;
const SUES_PER_CORE = 5;
const RESERVE_CORES = 2;
const HARD_CEILING = 4 * SUES_PER_HOST;

export function waveCeiling({ freeMB = os.freemem() / (1024 * 1024), cores = os.cpus().length } = {}) {
  const byMemory = Math.floor((freeMB - RESERVE_MB - FIXED_BROWSER_MB) / PER_SUE_MB);
  const byCores = Math.max(0, cores - RESERVE_CORES) * SUES_PER_CORE;
  return Math.max(1, Math.min(HARD_CEILING, byCores, byMemory));
}

/**
 * Did an ENTIRE wave die before seeing anything? Returns the shared reason, else null.
 *
 * A whole wave of dead brains is never the site's fault and never a coincidence - it is one broken
 * login or one exhausted quota. One wave is enough evidence to stop: on 2026-09-21 nothing checked,
 * so the loop ran 40 more waves and 400 more Sues against an expired OAuth session. A wave with even
 * one real visitor keeps going, because that is a run with data in it.
 */
export function waveAllDead(results = []) {
  if (!results.length) return null;
  const dead = results.filter((r) => r?.summary?.outcome === "brain-error");
  if (dead.length !== results.length) return null;
  return dead[0].summary.brainError || "the brains failed before they spoke";
}

/**
 * ⛔ A SUE REFUSED AT THE SIGN-UP DOOR IS A VERDICT ABOUT THIS TOOL, NOT ABOUT THE SITE. Sues skip
 * signup Turnstile through the accounts plane's keyed Sue door (turnstile-gate.ts). When the door
 * refuses her (a wrong or missing key, a non-Sue address), request-otp answers with the generic 400
 * every bot gets, which a Sue reads as the site's sign-up failing. On 2026-09-22 the door's old daily
 * cap (deleted 2026-09-23, there is no daily cap now) turned into a column of one-star "your sign-up
 * is broken" reviews from ~12:40 on - real humans were never affected. Same rule as the mailroom and
 * dead-brain stops: one confirmed refusal ends the run and the report says why.
 */
export function sueDoorRefusedFrom(findingsText) {
  return String(findingsText ?? "")
    .split("\n")
    .some((raw) => {
      if (!raw.trim()) return false;
      try {
        const f = JSON.parse(raw);
        return f.kind === "http-error" && f.status === 400 && /\/auth\/request-otp$/.test(String(f.request ?? ""));
      } catch {
        return false;
      }
    });
}

/** The stop verdict for a wave: a Sue the door refused who never got in on a retry, else null. */
export function sueDoorShut(results = []) {
  const shut = results.find((r) => r?.summary?.sueDoorRefused && !r.summary.madeAccount);
  if (!shut) return null;
  return `the accounts Sue door refused ${shut.sueId}'s sign-up code (request-otp 400): the door key is wrong or missing on this machine, so every later Sue would fail sign-up and blame the site`;
}

/**
 * How many Sues one `--forever` batch holds. A batch is `--count` long (default 1) and the waves are
 * cut from it, so a batch shorter than `--concurrency` can never fill a wave: `--concurrency 3
 * --forever` ran one Sue at a time all day on 2026-09-22. Outside `--forever`, `--count` is exact.
 */
export function foreverBatchCount(opts) {
  return opts.forever ? Math.max(opts.count, opts.concurrency) : opts.count;
}

/** `--concurrency` as a number: an explicit value verbatim, `"auto"` sized to the machine and the count. */
export function resolveConcurrency(opts) {
  if (typeof opts.concurrency === "number" && opts.concurrency > 0) return opts.concurrency;
  return Math.max(1, Math.min(opts.count, waveCeiling()));
}

/**
 * ONE browser for the whole run; each Sue takes her own isolated context off it (body.mjs's
 * `launchBrowser`). This is the other half of the memory fix above - 25 browsers were 25 process
 * TREES, and the OS started killing their tabs, which two Sues then reported as the page having
 * "vanished". Headed-vs-headless follows the TARGET exactly as a per-Sue launch did (Cloudflare
 * 403s headless Chrome on every `*.example.com` host), and the window is parked off-screen.
 *
 * ONE BROWSER FOR THE MACHINE, when the run names itself (Owner, 2026-09-25: six runs had six Chromes
 * open, "not in one Chrome profile like the exe did"): the run joins the shared Sue browser
 * (lib/shared-browser.mjs), started by whichever run needed it first and closed by its host once no run
 * holds it. A run that cannot join gets a browser of its own, as before; SUE_SHARED_BROWSER=0 skips
 * the shared one. Without a `runId` (a spec, a hand call) it is always the run's own.
 *
 * Returns `null` when a browser cannot be started at all; the bodies then each launch their own,
 * which is the pre-2026-09-21 behaviour and still correct, just heavier.
 */
export async function startBrowserServer(target, { runId = null } = {}) {
  const executablePath = resolveChromiumPath();
  if (!executablePath) {
    log("no Chromium found; each Sue will try to launch her own");
    return null;
  }
  const mode = browserModeFor(target);
  const headless = mode === "headless";
  if (runId && process.env.SUE_SHARED_BROWSER !== "0") {
    try {
      const shared = await acquireSharedBrowser({ runId, mode, executablePath, args: browserArgsFor(mode) });
      log(
        `the machine's one Sue browser (${headless ? "headless" : "headed, parked off-screen"}), pid ${shared.browserPid}: ` +
          (shared.started ? "started for this run" : "already open, shared with the runs using it"),
      );
      return await watchSharedBrowser(shared);
    } catch (err) {
      log(`the shared Sue browser was not available (${err && err.message}); this run opens its own`);
    }
  }
  try {
    const server = await chromium.launchServer({ headless, executablePath, args: browserArgsFor(mode), timeout: 60_000 });
    log(`one browser for the run (${headless ? "headless" : "headed, parked off-screen"}), pid ${server.process().pid}`);
    return watchWaveBrowser(server);
  } catch (err) {
    log(`shared browser did not start (${err && err.message}); each Sue will launch her own`);
    return null;
  }
}

/**
 * Puts it in the run's log, with the time and how it went, when the wave's shared browser goes before
 * the run is done with it. On 2026-09-23 run 20260923-170338-2077's headless browser went at
 * 22:57:38 UTC under four Sues and nothing recorded how: an exit code says killed (1), crashed
 * (0xC...) or closed (0). The run's own `server.close()` marks itself on the way, which is no loss.
 * startBrowserServer watches every server it starts, so no caller has to remember. Returns `server`.
 */
export function watchWaveBrowser(server, say = log, now = () => new Date().toISOString()) {
  let ours = false;
  const close = server.close.bind(server);
  server.close = () => {
    ours = true;
    return close();
  };
  server.on("close", (exitCode, signal) => {
    if (ours) return;
    say(
      `the wave's browser closed under the run at ${now()} (exit ${exitCode ?? "unknown"}, signal ${signal ?? "none"}); each Sue opens her own on her next move`,
    );
  });
  return server;
}

/**
 * The shared browser in the shape the run already uses for its own server (`wsEndpoint()`, `close()`),
 * where `close()` only lets go of this run's lease: the host closes Chrome once no run holds one. A
 * watching connection puts it in the run's log, with the time, if the shared browser goes under the run.
 */
export async function watchSharedBrowser(shared, say = log, now = () => new Date().toISOString(), connect = (ws) => chromium.connect(ws)) {
  let letGo = false;
  let watcher = null;
  try {
    watcher = await connect(shared.wsEndpoint);
    watcher.on("disconnected", () => {
      if (!letGo) say(`the shared Sue browser closed under the run at ${now()}; each Sue opens her own on her next move`);
    });
  } catch {
    // nothing to watch with; the bodies still report a lost browser themselves
  }
  return {
    shared: true,
    wsEndpoint: () => shared.wsEndpoint,
    process: () => ({ pid: shared.browserPid }),
    async close() {
      letGo = true;
      try {
        await watcher?.close();
      } catch {
        /* the shared browser is already down */
      }
      shared.release();
    },
  };
}

/**
 * The window hider (lib/window-hider.mjs) over this process's own tree, held by runSue while a Sue
 * whose browser draws windows is out: a headed wave's parked windows were closed from the Windows
 * taskbar under its Sues on 2026-09-23, and a hidden taskbar button is one nobody can close. Held in
 * runSue, not in main(), because reap.mjs runs its janitors through runSue with no cannon around
 * them, and her own parked window is just as closable. One helper serves every Sue in the process.
 */
const holdWindowHider = createWindowHiderHold({ onError: (line) => log(`window hider: ${line}`) });

/**
 * Turns the SIGN-UP LEG costs, on top of whatever the persona's own patience is worth.
 *
 * `dials.maxTurns` is a character trait - how long this person keeps poking at a page before they
 * are done with it. Making an account is not poking: typing an address, waiting, opening the mail,
 * reading six digits, typing them back is a fixed toll every persona pays identically, and it says
 * nothing about her patience. Charging it to the same budget is what cut two Sues off ONE action
 * after they typed their codes on 2026-09-21 - both accounts were created and live in AEGIS, and
 * neither Sue ever reached the exit interview to say so.
 *
 * 14 covered the code alone. Since 2026-09-22 she also OPENS and JUDGES every email the site sends
 * (open_email, look, judge_email: three turns each), and a sign-up sends about three - the code,
 * the welcome, the product's own welcome - so the leg is 14 + 10.
 */
const SIGNUP_LEG_TURNS = 24;

/**
 * `scenario.legs`: an errand made of several separate jobs (explore every part, run a whole week)
 * gives her her own patience on EACH job. One budget for four jobs cut every Sue off inside the
 * first one; four times a flat number would make tiktok as patient as grandma. The sign-up toll is
 * still paid once.
 */
export function turnsFor(persona, scenario) {
  const own = persona?.dials?.maxTurns;
  const base = Number.isInteger(own) && own > 0 ? own : 60;
  const visit = base * legsOf(scenario);
  return scenario?.createsAccount ? visit + SIGNUP_LEG_TURNS : visit;
}

/**
 * The WALL-CLOCK bound on one Sue's brain, alongside her turn budget. `--max-turns` caps how many
 * times the CLI may speak, not how long it may sit silent: a stuck CLI holds its wave, and under
 * `--forever` the whole run, while its status still reads "running". Three times her patience (per
 * leg, the same way `turnsFor` gives her turns per leg) is far above any healthy visit - a 60s
 * TikTok Sue is cut off at 3 minutes, a 420s grandma at 21 - and only ever fires on a hang.
 */
export function brainDeadlineMs(persona, scenario) {
  const patience = Number(persona?.dials?.patienceSeconds) || 0;
  const base = patience > 0 ? patience : 120;
  return base * legsOf(scenario) * 3 * 1000;
}

/**
 * Turns a focus-group Sue spends AT THE TABLE, on top of her visit: hearing the room (`room`), talking
 * (`say`), voting and changing her vote, and waiting out a moderator who is still asking. Like the
 * sign-up leg it is a toll every persona pays alike, never a measure of her patience with the page;
 * forty is a dozen rounds of listen-and-answer with room to vote twice.
 */
export const FOCUS_TABLE_TURNS = 40;
/**
 * The moderator's CLI turn budget. It listens (`room wait=30`) the whole time the Sues are on the
 * website, one turn per half minute, so its budget is set by the longest visit, not by how much it says.
 */
export const MODERATOR_MAX_TURNS = 300;
/** How long the moderator may still talk after every Sue is done before it is ended. */
export const MODERATOR_GRACE_MS = 60_000;
/** How often the vote watchdog asks whether the vote should close the room. */
export const VOTE_WATCH_MS = 15_000;

/** Her turn budget: her own patience, plus the table's toll when she sits in a focus group. */
export function seatTurns(persona, scenario, focusGroup = false) {
  return turnsFor(persona, scenario) + (focusGroup ? FOCUS_TABLE_TURNS : 0);
}

/** Her brain's wall-clock bound, plus the longest a focus group keeps her at the table. */
export function seatDeadlineMs(persona, scenario, focusGroup = false) {
  return brainDeadlineMs(persona, scenario) + (focusGroup ? TABLE_MAX_MS + VOTE_GRACE_MS : 0);
}

function log(msg) {
  process.stderr.write(`[cannon] ${msg}\n`);
}

export function parseArgs(argv) {
  const o = { ...DEFAULTS, personas: [...DEFAULTS.personas] };
  const rest = [...argv];
  const takeValue = (flag) => {
    const v = rest.shift();
    if (v === undefined || v.startsWith("--")) throw new Error(`${flag} needs a value`);
    return v;
  };
  const takeInt = (flag) => {
    const n = Number.parseInt(takeValue(flag), 10);
    if (!Number.isInteger(n) || n < 0) throw new Error(`${flag} must be a non-negative integer`);
    return n;
  };
  while (rest.length) {
    const a = rest.shift();
    switch (a) {
      case "--target":
        o.target = takeValue(a);
        break;
      case "--scenario":
        o.scenario = takeValue(a);
        break;
      case "--personas":
        o.personas = takeValue(a)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        break;
      case "--sampled":
        o.sampled = takeInt(a);
        break;
      case "--count":
        o.count = takeInt(a);
        break;
      case "--concurrency": {
        const raw = takeValue(a);
        o.concurrency = raw === "auto" ? "auto" : Math.max(1, Number.parseInt(raw, 10));
        if (o.concurrency !== "auto" && !Number.isFinite(o.concurrency))
          throw new Error(`--concurrency wants a number or "auto", got ${raw}`);
        break;
      }
      case "--forever":
        o.forever = true;
        break;
      case "--stampede":
        o.stampede = true;
        break;
      case "--max-accounts":
        o.maxAccounts = takeInt(a);
        break;
      case "--max-minutes":
        o.maxMinutes = takeInt(a);
        break;
      case "--people":
        o.people = takeValue(a);
        break;
      case "--start-url": {
        const raw = takeValue(a);
        if (!/^https?:\/\//.test(raw)) throw new Error(`--start-url must be http(s), got ${raw}`);
        o.startUrl = raw;
        break;
      }
      case "--dry-run":
        o.dryRun = true;
        break;
      case "--json":
        o.json = true;
        break;
      case "--no-fairjob":
        o.fairjob = false;
        break;
      case "--no-preflight":
        o.skipPreflight = true;
        break;
      case "--run-id": {
        const id = takeValue(a);
        if (!/^\d{8}-\d{6}-[0-9a-f]{4}$/.test(id)) throw new Error(`--run-id "${id}" is not a run id (YYYYMMDD-HHMMSS-xxxx)`);
        o.runId = id;
        break;
      }
      case "--no-mailroom":
        o.mailroom = false;
        break;
      case "--tape":
        o.tape = path.resolve(takeValue(a));
        break;
      case "--model":
        o.model = takeValue(a);
        break;
      case "--as":
        o.as = takeValue(a);
        break;
      case "--profile":
        o.profile = takeValue(a);
        break;
      case "--project-id":
        o.projectId = takeValue(a);
        break;
      case "--brain":
        o.brain = takeValue(a);
        break;
      case "--focus-group":
        o.focusGroup = true;
        break;
      case "--dispatch":
        o.dispatch = takeValue(a);
        if (o.dispatch !== "climayte") throw new Error(`--dispatch takes climayte (AgentHydra's CliMayte), got ${o.dispatch}`);
        break;
      case "--reading":
        o.reading = readingModeOf(takeValue(a));
        break;
      case "--help":
      case "-h":
        o.help = true;
        break;
      default:
        throw new Error(`unknown flag ${a}`);
    }
  }
  if (!o.personas.length) throw new Error("--personas needs at least one id");
  if (o.as && o.profile) throw new Error("--as and --profile each name a sign-in; a wave arrives with one");
  if (o.model && /haiku/i.test(o.model)) throw new Error("never a Haiku brain (owner rule)");
  // A focus group is ONE room that agrees on ONE problem; a nonstop wave has no table to come back to.
  if (o.focusGroup && o.forever) throw new Error("--focus-group seats one room that agrees once: drop --forever");
  // A tape body is a chat-relay body only: the CLI brains reach theirs through body hosts (lib/body-host.mjs), which run body.mjs alone.
  if (o.tape && o.brain !== "chat")
    throw new Error(
      `--tape needs the chat brain (got ${o.brain}): a CLI brain's body runs in a body host, and body hosts only run the browser body`,
    );
  if (o.dispatch && o.brain !== "chat")
    throw new Error(`--dispatch sends chat-brain Sues to CliMayte; --brain ${o.brain} has its own brains`);
  // After the loop, so SUE_BRAIN (the default's source) is held to the same spellings as --brain.
  assertBrain(o.brain);
  return o;
}

export function usage() {
  return [
    "usage: node sue/cannon.mjs --target <id|path/to/target.json> --scenario <id> --personas a,b,c [--sampled N] [--count N] [--concurrency M]",
    "       [--forever] [--stampede] [--max-accounts N] [--dry-run [--json]] [--focus-group (the run's room is open: all at once, one table)]",
    `       [--no-fairjob] [--no-mailroom] [--tape <dir>] [--model ${SUE_DEFAULT_MODEL}] [--brain ${BRAINS.join("|")}] [--dispatch climayte (chat brain: SUE sends each Sue to CliMayte sealed)] [--as <session saved by login.mjs, never on a site she can sign up to>] [--profile <saved login>]`,
    "       Started by `sue run` only (its runner passes --run-id and the door); by hand, --dry-run is all this does.",
  ].join("\n");
}

/** Resolves `{{target.expectedLandingAfterSignup}}` in a scenario against the target. */
export function resolveScenario(scenario, target) {
  const pattern = scenario.expectedLandingPattern;
  const resolved =
    typeof pattern === "string"
      ? pattern.replace(/\{\{\s*target\.expectedLandingAfterSignup\s*\}\}/g, target.expectedLandingAfterSignup || "")
      : null;
  return { ...scenario, expectedLandingPattern: resolved || null };
}

/**
 * The plan: one entry per Sue, personas round-robin, Sue numbers consumed from the counter (or
 * only peeked when `reserve` is false, for a dry run).
 *
 * `offset` is how many Sues this run has already planned. A `--forever` run builds one plan per
 * batch, and without it every batch restarted the round-robin at the FIRST persona: on 2026-09-22
 * `--personas grandma,esl-maria,low-attention` ran 25 Sues and every one of them was Grandma.
 */
export function buildPlan({ runId, opts, target, scenario, personas, reserve, offset = 0 }) {
  const plan = [];
  let peek = peekSueNumber();
  for (let i = 0; i < opts.count; i++) {
    const persona = personas[(offset + i) % personas.length];
    const sueNumber = reserve ? nextSueNumber() : peek++;
    const identity = mintIdentity(persona, { sueNumber, runId, target });
    const sueId = `sue-${sueNumber}-${persona.id}`;
    plan.push({
      index: i,
      sueId,
      sueNumber,
      personaId: persona.id,
      model: modelForBrain(opts.brain, { model: opts.model, personaModel: persona.model }),
      maxTurns: seatTurns(persona, scenario, opts.focusGroup === true),
      identity,
      address: identity.email,
      sueDir: sueDirOf(runId, sueId),
      scenarioId: scenario.id,
    });
  }
  return plan;
}

/**
 * The cap verdict for a wave: null when it may start, else the sentence the cannon says.
 *
 * IT COUNTS ACCOUNTS THAT EXIST, NEVER SUES THAT MIGHT MAKE ONE (corrected 2026-09-21, measured).
 * It used to refuse when `alreadyThisRun + count > maxAccounts`, i.e. it treated every PLANNED Sue
 * as an account already created. On a scenario where signing up is optional that is wrong by two
 * orders of magnitude: across 24 runs and 695 Sues who actually visited, `state/accounts-ledger.jsonl`
 * holds THREE accounts. So `--count 40 --scenario first-visit` was refused outright ("this run has 0
 * accounts and --max-accounts is 25") and a nonstop wave could never be larger than the cap, which
 * is the opposite of what the cap is for: it guards the identity store, not the visitor count.
 *
 * The cap is a HEADROOM question asked BETWEEN WAVES rather than once per batch, so the most it can
 * be overshot by is one wave (at most `--concurrency` Sues, see waveCeiling) instead of one whole `--count`.
 * It is the per-run cap only: there is no daily cap anywhere since 2026-09-23 (run-dir.mjs says
 * why).
 */
/**
 * THE RUN'S WALL-CLOCK CAP. Runs are detached on purpose (a chat-brain run outlives its launching
 * shell), so nothing tied a run's life to the chat that started it: on 2026-09-23 four runs whose chats
 * were gone kept 58 browsers busy on the owner's PC, the oldest for 1.5 h. So after this many minutes no
 * new Sue STARTS; the ones in flight finish inside their own deadlines (`brainDeadlineMs`, the relay's
 * idle limit) and the run ends with its report like any stopped run. A counted run gets
 * RUN_MAX_MINUTES unless the caller names more (`--max-minutes`, `maxMinutes` on `sue run`; 0 = none).
 * A `--forever` run is uncapped unless named: "until stop" is what it was asked for.
 */
export const RUN_MAX_MINUTES = 45;

export function runMaxMinutes({ maxMinutes = null, forever = false } = {}) {
  if (Number.isInteger(maxMinutes)) return maxMinutes > 0 ? maxMinutes : null;
  return forever ? null : RUN_MAX_MINUTES;
}

/** The line that stops the run once it is past its cap, else null. */
export function wallClockVerdict({ startedAtMs, maxMinutes, now = Date.now() }) {
  if (!maxMinutes || now - startedAtMs < maxMinutes * 60_000) return null;
  return `refusing to start more Sues: this run is past its ${maxMinutes}-minute wall-clock cap (--max-minutes); the Sues in flight finish`;
}

export function capVerdict({ scenario, maxAccounts, alreadyThisRun }) {
  if (!scenario.createsAccount) return null;
  if (alreadyThisRun >= maxAccounts) {
    return `refusing to start more "${scenario.id}" Sues: this run has made ${alreadyThisRun} account(s) and --max-accounts is ${maxAccounts}`;
  }
  return null;
}

/** Her whole world on disk before her brain starts: `sue.json`, her system prompt, her MCP pointer
 *  and her own files. Exported so `tests/cannon.spec.mjs` can pin what she is handed. */
export function writeSueFiles({
  runId,
  sueId,
  sueNumber,
  persona,
  target,
  scenario,
  identity,
  sueDir,
  browserProfileDir,
  browserWsEndpoint,
  stampede,
  session,
  restoreState,
  focusGroup = false,
  tape = null,
  brain = null,
  reading = null,
}) {
  fs.mkdirSync(sueDir, { recursive: true });
  fs.mkdirSync(browserProfileDir, { recursive: true });
  // A critic persona's own exit questions join her scenario's here, once, so her body's tools, her
  // prompt and the report all read the same list off `sue.json` (lib/personas.mjs withPersonaQuestions).
  scenario = withPersonaQuestions(scenario, persona);
  // Her reason for being here, rotated by Sue number, recorded so the report can group by it.
  const errand = errandOf(persona, scenario, sueNumber);
  // Her own files (the shared sample folder, then this scenario's own), copied into HER folder
  // so the body's attach hand only ever reaches a file she was given, never the product repo's tree.
  const files = { names: bringHerFiles(target, scenario, sueDir) };
  const sue = {
    sueId,
    sueNumber,
    persona,
    errand,
    target,
    scenario,
    identity,
    runId,
    runDir: runDir(runId),
    mailDir: path.join(mailDir(runId), identity.email),
    browserProfileDir,
    browserWsEndpoint: browserWsEndpoint ?? null,
    stampede: Boolean(stampede),
    /** The recorded tape she visits instead of the live site (an absolute folder), or absent on a live visit. */
    ...(tape ? { tape } : {}),
    /** The brain's turn budget (the same number `--max-turns` gets), so the body can warn her before it ends. */
    maxTurns: seatTurns(persona, scenario, focusGroup),
    /** Who drives her ("chat": the calling chat's agents, whose turns nothing caps but her wrap-up line). */
    ...(brain ? { brain } : {}),
    /** She sits in a focus group: her body finds the room at her run dir (lib/room.mjs). Absent on a plain run. */
    ...(focusGroup ? { focusGroup: true } : {}),
    /**
     * The saved session (`--as`) she arrives signed in with, or null: one file's path, or one per
     * site for a target with `sessionParts` (the body carries them all). Paths, never the cookies.
     */
    session: session ?? null,
    /** A saved state (`storage-state.json` from another Sue's body) her context is restored from,
     * WITHOUT the borrowed-account rails `session` sets - a reaper hands a janitor the account she
     * came to delete this way. */
    restoreState: restoreState ?? null,
    /** Her own files by name, in `<sueDir>/files/` (the attach hand's whole reach). */
    files: files.names,
    /** May she contact the company: encouraged, forbidden or unmentioned, so the report can say which applied. */
    supportRule: supportRule(persona, scenario),
    reading,
    createdAt: new Date().toISOString(),
  };
  fs.mkdirSync(sue.mailDir, { recursive: true });
  fs.writeFileSync(path.join(sueDir, "sue.json"), JSON.stringify(sue, null, 2) + "\n");
  const systemPromptFile = path.join(sueDir, "brain-system.md");
  fs.writeFileSync(systemPromptFile, renderBrainSystemPrompt({ persona, target, scenario, identity, errand, files: files.names, brain }));
  const mcpConfigFile = path.join(sueDir, "mcp.json");
  fs.writeFileSync(mcpConfigFile, JSON.stringify(sueMcpConfig({ bodyFile: tape ? TAPE_BODY : BODY, sueDir }), null, 2) + "\n");
  return { systemPromptFile, mcpConfigFile, errand };
}

/**
 * A CLI brain whose body lives in one of the run's body hosts (lib/body-host.mjs; Owner, 2026-09-24:
 * hundreds of Sues from one Chrome). Her body is opened FIRST, so a body that cannot start spends no
 * brain at all; her `mcp.json` is then pointed at her own hosted path (still one server, `sue`, so
 * `--strict-mcp-config` keeps the seal) and `startBrain()` spawns her brain (spawnBrain's
 * `{ child, done }`). If her host dies under her, her brain is killed there and then and the visit
 * ends as a brain error - a wave never waits on a Sue whose hands are gone. Her body is closed (her
 * body.json and storage-state.json written) before this resolves, so the summary reads them whole.
 * Resolves to spawnBrain's answer, or `{ code: 1, result: <a brain-error result> }`.
 */
export async function withHostedBody({ bodyHosts, sueId, sueDir, mcpConfigFile, startBrain, kill = killBrainTree }) {
  let hosted;
  try {
    hosted = await bodyHosts.open({ sueId, sueDir });
  } catch (err) {
    return {
      code: 1,
      result: { is_error: true, subtype: "error_body", result: `her body did not start: ${String(err?.message ?? err).split("\n")[0]}` },
    };
  }
  try {
    fs.writeFileSync(mcpConfigFile, JSON.stringify(sueMcpConfig({ hosted: hosted.mcpServer }), null, 2) + "\n");
    const { child, done } = startBrain();
    let lost = null;
    hosted.exited.then((ended) => {
      if (!ended?.lost) return;
      lost = ended.lost;
      kill(child);
    });
    const spoke = await done;
    return lost ? { ...spoke, code: spoke.code ?? 1, result: { is_error: true, subtype: "error_body", result: lost } } : spoke;
  } finally {
    await hosted.close();
  }
}

export function summarize({
  sueId,
  personaId,
  scenarioId,
  model,
  brain,
  code,
  result,
  startedAt,
  sueDir,
  borrowed = false,
  createsAccount = false,
}) {
  let interview = null;
  try {
    interview = JSON.parse(fs.readFileSync(path.join(sueDir, "interview.json"), "utf8"));
  } catch {
    /* she never got to the interview: the summary says so */
  }
  let bodyRecord = null;
  try {
    bodyRecord = JSON.parse(fs.readFileSync(path.join(sueDir, "body.json"), "utf8"));
  } catch {
    /* the body writes it on shutdown; a body that crashed leaves none */
  }
  let findingsText = "";
  try {
    findingsText = fs.readFileSync(path.join(sueDir, "findings.jsonl"), "utf8");
  } catch {
    /* no findings file: she recorded nothing, so nothing refused her either */
  }
  const r = result || {};
  // A brain that could not authenticate did not visit anything, so her silence is NOT an opinion
  // about the page: `brain-error` is a THIRD outcome beside signed-up and left, and report.mjs
  // refuses to count it. See brainErrorFrom's header for the 400-Sue run that made this necessary.
  const brainError = brainErrorFrom(result) ?? (interview ? null : idleEndFrom(result));
  const tracePath = sueDir ? path.join(sueDir, "trace.jsonl") : null;
  const argusSids = tracePath && fs.existsSync(tracePath) ? argusSidsIn(fs.readFileSync(tracePath, "utf8")) : [];
  return {
    sueId,
    persona: personaId,
    argusSids,
    scenario: scenarioId,
    model,
    brain,
    startedAt,
    endedAt: new Date().toISOString(),
    exitCode: code,
    resultSubtype: r.subtype ?? null,
    isError: Boolean(r.is_error),
    totalCostUsd: r.total_cost_usd ?? null,
    durationMs: r.duration_ms ?? null,
    numTurns: r.num_turns ?? null,
    brainError: brainError ? `${brainError.kind}: ${brainError.message}` : null,
    interviewed: Boolean(interview),
    // `=== true`, never `Boolean(...)`: `shapeInterview` now hands over a real boolean or `null`.
    // A Sue on a BORROWED session (`--as`) made no account, whatever she answers: she was signed in
    // before she arrived. Counting her "yes" put two phantom accounts on the first signed-in run.
    //
    // ⛔ THE INTERVIEW IS A SELF-REPORT AND A CUT-OFF SUE NEVER GIVES ONE. On 2026-09-21 two Sues
    // typed their codes, AEGIS wrote two live `identities` rows, and both were cut off by the turn
    // budget one action later - so the run reported "0 accounts" and "stopped before sign-in" over
    // real accounts, and the account ledger (which records these rows) undercounted by two.
    // `codeSubmittedAt` is the body's own hard fact: a code mailed to an address only she can read
    // went back into the page. `madeAccountEvidence` says WHICH of the two answered, so a report
    // never has to guess - and THIS is the only place that decides, so nothing downstream re-derives it.
    //
    // ⛔ A CODE IS ONLY A SIGN-UP ON A SIGN-UP SCENARIO. AEGIS mails the same six digits to sign an
    // EXISTING account IN (the reaper's janitor signing back in to delete one), so without the
    // `createsAccount` gate a sign-in would be reported as a brand-new account. Caught by a skeptic.
    madeAccount: !borrowed && (interview?.madeAccount === true || (createsAccount && typeof bodyRecord?.codeSubmittedAt === "string")),
    sueDoorRefused: sueDoorRefusedFrom(findingsText),
    madeAccountEvidence: borrowed
      ? null
      : interview?.madeAccount === true
        ? "interview"
        : createsAccount && typeof bodyRecord?.codeSubmittedAt === "string"
          ? "code-submitted"
          : null,
    codeSubmittedAt: bodyRecord?.codeSubmittedAt ?? null,
    borrowedSession: borrowed,
    outcome: brainError ? "brain-error" : interview ? (!borrowed && interview.madeAccount === true ? "signed-up" : "left") : "no-interview",
  };
}

let scratchRoot = null;

/**
 * A fresh scratch folder for one brain process's working directory. Every one this process makes
 * lives under ONE temp root, removed when the process exits whatever happened, so a brain that
 * crashes or times out never leaves its folder behind (each call site still removes its own as soon
 * as it is done).
 */
function scratchDir(prefix) {
  if (!scratchRoot) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sue-cannon-"));
    scratchRoot = root;
    process.on("exit", () => {
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        /* the OS temp folder is reaped by the OS eventually; a failed cleanup must not fail the exit */
      }
    });
  }
  return fs.mkdtempSync(path.join(scratchRoot, prefix));
}

/**
 * Proves the chosen key pool can still talk BEFORE the run spends a Sue number, a mail address or a
 * browser. One turn, no tools, no MCP, no persona. Resolves null when the brain is healthy, else
 * `{ kind, message }` from brainErrorFrom - or, when the key pool itself has nothing usable
 * (`deepseekEnv`/`openrouterEnv` throw before a process is ever spawned), an `auth`-kind failure
 * whose message already names the key pool (never a CLI login: there is none to sign back into).
 * Costs one trivial turn and saves a five-hour dead run. Never called for `chat` (no CLI, no key).
 */
export async function preflightBrain({ brain, model = SUE_DEFAULT_MODEL, env = process.env, bin } = {}) {
  let probeEnv;
  try {
    probeEnv = await brainEnv(brain, env, { model });
  } catch (err) {
    return { kind: "auth", message: err && err.message };
  }
  const cwd = scratchDir("preflight-");
  try {
    const { done } = spawnBrain({ args: buildPreflightArgs({ model }), env: probeEnv, cwd, bin, timeoutMs: PREFLIGHT_TIMEOUT_MS });
    const { result, stderr } = await done;
    const failure = brainErrorFrom(result);
    if (failure) return failure;
    // No result event at all means the CLI died before it spoke - also not a healthy brain.
    if (!result) return { kind: "api", message: (stderr || "").trim().slice(0, 300) || "the brain exited without a result" };
    return null;
  } finally {
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is not worth failing the preflight over */
    }
  }
}

/**
 * Runs ONE Sue end to end and resolves `{ sueId, sueDir, result }`. The pinned contract that
 * `reap.mjs` reuses. `sueNumber`/`sueId` are optional: absent, a fresh number is consumed.
 */
export async function runSue({
  runId,
  persona,
  scenario,
  target,
  identity,
  browserProfileDir,
  browserWsEndpoint,
  model,
  brain = process.env.SUE_BRAIN || "chat",
  sueNumber,
  sueId,
  stampede,
  session,
  restoreState,
  onEvent,
  claudeBin,
  relay,
  bodyHosts = null,
  focusGroup = false,
  tape = null,
  reading = null,
  holdWindowHider: hold = holdWindowHider,
}) {
  if (!runId) throw new Error("runSue: runId");
  if (brain === "chat" && !relay) throw new Error("runSue: a chat brain drives her through the run's relay, and there is none");
  const number = Number.isInteger(sueNumber) ? sueNumber : nextSueNumber();
  const id = sueId || `sue-${number}-${persona.id}`;
  const dir = sueDirOf(runId, id);
  const who = identity || mintIdentity(persona, { sueNumber: number, runId, target });
  const profile = browserProfileDir || path.join(dir, "profile");
  const resolvedScenario = resolveScenario(scenario, target);
  const { systemPromptFile, mcpConfigFile, errand } = writeSueFiles({
    runId,
    sueId: id,
    sueNumber: number,
    persona,
    target,
    scenario: resolvedScenario,
    identity: who,
    sueDir: dir,
    browserProfileDir: profile,
    browserWsEndpoint,
    stampede,
    session,
    restoreState,
    focusGroup,
    tape,
    brain,
    reading,
  });
  const brainModel = modelForBrain(brain, { model, personaModel: persona.model });
  // A focus-group Sue is told the table on top of her errand: who else is there, by name, and how to talk to them.
  const errandPrompt = buildScenarioPrompt({ scenario: resolvedScenario, identity: who, errand, persona });
  const scenarioPrompt = focusGroup ? withFocusBrief(errandPrompt, id, readRoster(runDir(runId))) : errandPrompt;
  const args = buildClaudeArgs({
    scenarioPrompt,
    systemPromptFile,
    mcpConfigFile,
    model: brainModel,
    maxTurns: seatTurns(persona, resolvedScenario, focusGroup),
  });
  const deadlineMs = seatDeadlineMs(persona, resolvedScenario, focusGroup);
  const cwd = scratchDir("brain-");
  // Her browser opens under her body while she is out, so her windows leave the taskbar from here on.
  const releaseWindows = hold(browserModeFor(target));
  try {
    const startedAt = new Date().toISOString();
    let code;
    let result;
    if (brain === "chat") {
      // Her brain is an agent of whichever chat started the run, driving her through hand.mjs; the
      // brief is the same system prompt and first message a CLI brain gets, plus how her hands work.
      const brief = path.join(dir, "brief.md");
      const systemPrompt = fs.readFileSync(systemPromptFile, "utf8");
      fs.writeFileSync(
        brief,
        buildChatBrief({
          systemPrompt,
          scenarioPrompt,
          runId,
          sueId: id,
          handFile: HAND,
          reading,
          ...(focusGroup ? { focusGroup: true } : {}),
        }),
      );
      // The same Sue for a launcher that starts her brain sealed: her hands its only tool, nothing else in its context.
      const sealed = writeSealedLaunch({
        sueDir: dir,
        systemPrompt,
        scenarioPrompt,
        focusGroup: Boolean(focusGroup),
        reading,
        handsFile: HANDS_MCP,
        runId,
        sueId: id,
        home: path.dirname(runsRoot()),
      });
      const { calls, why } = await relay.register({ sueId: id, sueDir: dir, brief, persona: persona.id, sealed });
      code = 0;
      // A Sue no agent ever moved saw nothing, so she is a brain-error row the report refuses to count.
      result = calls ? { subtype: "chat", num_turns: calls } : { is_error: true, result: `no chat agent ever drove her (${why})` };
    } else {
      const env = await brainEnv(brain, process.env, {
        model: brainModel,
        proxyLog: { logFile: path.join(runDir(runId), "local-proxy.jsonl"), tag: id },
      });
      const startBrain = () =>
        spawnBrain({ args, env, cwd, stdoutFile: path.join(dir, "brain.jsonl"), onEvent, bin: claudeBin, timeoutMs: deadlineMs });
      // The cannon's CLI waves hold her body in one of the run's host processes; a caller with no
      // hosts (reap.mjs's janitor, one Sue) still gives her a body process of her own over stdio.
      const spoke = bodyHosts
        ? await withHostedBody({ bodyHosts, sueId: id, sueDir: dir, mcpConfigFile, startBrain })
        : await startBrain().done;
      ({ code, result } = spoke);
      // A hung CLI is killed at the deadline (spawnBrain) and named here: the summary must read as a
      // brain-error, not as a Sue who visited and had no opinion.
      if (spoke.timedOut) result = { is_error: true, subtype: "error_timeout", result: `the brain did not answer within ${deadlineMs}ms` };
      if (spoke.stderr && spoke.stderr.trim()) fs.writeFileSync(path.join(dir, "brain.stderr.log"), spoke.stderr);
    }
    const summary = summarize({
      sueId: id,
      personaId: persona.id,
      scenarioId: scenario.id,
      model: brainModel,
      brain,
      code,
      result,
      startedAt,
      sueDir: dir,
      borrowed: Boolean(session),
      createsAccount: Boolean(resolvedScenario.createsAccount),
    });
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
    if (resolvedScenario.createsAccount && summary.madeAccount) {
      appendAccountLedger({ address: who.email, sueId: id, runId, createdAt: summary.endedAt, deletedAt: null });
    }
    return { sueId: id, sueDir: dir, result, summary };
  } finally {
    releaseWindows();
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is not worth failing a Sue over */
    }
  }
}

/** The mailroom's own `--probe`, run BEFORE a Sue number is reserved: the same env it will run with,
 *  one JSON line back. A crash with no line is itself the answer (`ok:false`). On 2026-09-21 an
 *  expired login let a 100-Sue wave run with every inbox empty, and every Sue blamed the site. */
/** The env the mailroom runs with. A named profile wins when the caller set one; otherwise a vault lease in the env
 *  (AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY) is used AS IS - naming "main" on top of it would make the SDK prefer
 *  a profile that may not exist on this machine (2026-09-22); only with neither does "main" stay the default. */
export function mailroomEnv(base = process.env) {
  const hasEnvCredentials = Boolean(base.AWS_ACCESS_KEY_ID && base.AWS_SECRET_ACCESS_KEY);
  const profile = base.AWS_PROFILE || (hasEnvCredentials ? "" : "main");
  return profile ? { ...base, AWS_PROFILE: profile } : { ...base };
}

/**
 * Does the start page answer at all? Any HTTP status counts (a redirect or a 404 is a server
 * answering); only a network failure or the timeout refuses. Redirects are not followed, so the
 * probe sets no cookie a Sue's own first visit depends on - but it does GET the page, so a start
 * URL whose GET changes state is hit once more than the run's Sues.
 */
export async function preflightTarget(url, { timeoutMs = 10_000 } = {}) {
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
    await res.body?.cancel();
    return { ok: true, status: res.status };
  } catch (err) {
    return { ok: false, error: String(err?.cause?.code || err?.cause?.message || err?.message || err) };
  }
}

export function preflightMailroom({ env = process.env } = {}) {
  const profile = mailroomEnv(env).AWS_PROFILE || "(a vault lease in the env, no named profile)";
  const r = spawnSync(process.execPath, [MAILROOM, "--probe"], {
    windowsHide: true,
    encoding: "utf8",
    timeout: 60_000,
    env: mailroomEnv(env),
  });
  const line = String(r.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .pop();
  try {
    const parsed = JSON.parse(line);
    return { ok: parsed.ok === true, profile, error: parsed.error };
  } catch {
    return {
      ok: false,
      profile,
      error:
        r.error?.message ||
        String(r.stderr || "")
          .trim()
          .slice(0, 300) ||
        `exit ${r.status}`,
    };
  }
}

/**
 * What a mailroom exit MEANS for the run: a sentence to put in front of whoever reads the report, or
 * null when the run was already ending and this is just the `finally` block's own kill landing.
 *
 * Separated from the handler so the judgment is testable without a real child process - the handler
 * itself is three lines of wiring, and this is the part that was wrong (nothing at all) on 2026-09-22.
 */
export function mailroomDeathVerdict({ code, signal, logFile, alreadyStopping, lastWords }) {
  if (alreadyStopping) return null;
  const said = String(lastWords ?? "")
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-2)
    .join(" | ");
  return (
    `the mailroom exited ${signal ? `on signal ${signal}` : `with code ${code}`} while the run was still going, so no ` +
    `signup code could be fetched after that moment (` +
    (said
      ? `its last words: "${said.slice(-400)}"; its log: ${logFile})`
      : `it said nothing on stderr before exiting; its log: ${logFile})`)
  );
}

/** `onDeath({ code, signal, logFile, lastWords })` fires when the mailroom exits on its own - see its caller
 * for why that has to end the run rather than be logged and survived. Its stderr comes through THIS process
 * (appended to its log and kept as `lastWords`) rather than straight onto the log's fd: on 2026-09-24 a
 * mailroom under the installed Sue app exited 1 with a 0-byte log, so the verdict's "its own log says why"
 * pointed at nothing. Now the reason rides in the verdict itself. */
export function startMailroom(runId, onDeath) {
  const logFile = path.join(runDir(runId), "mailroom.log");
  const out = fs.openSync(logFile, "a");
  const env = mailroomEnv(process.env);
  const child = spawn(process.execPath, [MAILROOM, "--run", runId], { windowsHide: true, stdio: ["ignore", out, "pipe"], env });
  let lastWords = "";
  child.stderr.on("data", (chunk) => {
    fs.appendFileSync(logFile, chunk);
    lastWords = (lastWords + chunk.toString("utf8")).slice(-2000);
  });
  child.on("error", (err) => log(`mailroom failed to start: ${err.message}`));
  // `close`, not `exit`: it fires once stderr has drained, so the last words are all in.
  child.on("close", (code, signal) => onDeath?.({ code, signal, logFile, lastWords }));
  log(`mailroom started (pid ${child.pid}), log ${logFile}`);
  return child;
}

function runReport(runId) {
  if (!fs.existsSync(REPORT)) {
    log(`report.mjs is not here yet; skipping the report for ${runId}`);
    return;
  }
  const r = spawnSync(process.execPath, [REPORT, "--run", runId], { windowsHide: true, encoding: "utf8" });
  if (r.status !== 0) log(`report.mjs exited ${r.status}: ${(r.stderr || "").trim().slice(0, 500)}`);
  else log(`report written for ${runId}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForReady(entries, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  const pending = new Set(entries.map((e) => e.sueDir));
  while (pending.size && Date.now() < deadline) {
    for (const dir of [...pending]) {
      if (fs.existsSync(path.join(dir, "ready"))) pending.delete(dir);
    }
    if (pending.size) await sleep(500);
  }
  return [...pending];
}

/** The re-exec under the fair-job wrapper, when the concurrency says this is a load generator. */
function reexecUnderFairjob(argv) {
  const fairjob = path.join(process.env.USERPROFILE || os.homedir(), ".claude", "tools", "fairjob.cmd");
  if (process.platform !== "win32" || !fs.existsSync(fairjob)) {
    log(`fairjob wrapper not found at ${fairjob}; running unwrapped (pass --no-fairjob to silence this)`);
    return null;
  }
  const parts = ["node", path.join(HERE, "cannon.mjs"), ...argv, "--no-fairjob"];
  if (parts.some((p) => /[\s"']/.test(p))) {
    throw new Error("cannot re-exec under fairjob: an argument contains whitespace or quotes; pass --no-fairjob or simplify the arguments");
  }
  const cmdline = parts.join(" ");
  log(`concurrency > ${FAIRJOB_ABOVE}: re-executing under fairjob -Weight 3`);
  const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `""${fairjob}" -Weight 3 -Run "${cmdline}""`], {
    stdio: "inherit",
    windowsHide: true,
    windowsVerbatimArguments: true,
    env: { ...process.env, SUE_UNDER_FAIRJOB: "1" },
  });
  return r.status ?? 1;
}

/**
 * A target whose Sues share one signed-in account (`--as`) can name a step that clears what the last
 * Sue left behind: `betweenSues`, a node script beside the target file. On Discord every Sue is the
 * same member, so the next one would otherwise arrive with the last one's tickets open and be
 * refused by the one-per-member limit (Example App Next run 20260922-103543-925c: one star for a
 * refusal no real first-time member meets). It runs before each wave, so Sues in the same wave share
 * whatever they make; run a shared account at --concurrency 1. It gets SUE_SESSIONS_DIR to find a
 * saved session of its own. A failure is logged, never fatal. Returns whether it succeeded.
 */
export function runBetweenSues(target, { run = spawnSync, sessionsDir = path.join(stateRoot(), "sessions") } = {}) {
  const script = path.resolve(target.home ?? process.cwd(), String(target.betweenSues));
  const r = run(process.execPath, [script], {
    cwd: target.home ?? process.cwd(),
    windowsHide: true,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, SUE_SESSIONS_DIR: sessionsDir },
  });
  const said = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" | ");
  if (r.status === 0) {
    log(`between Sues: ${said || `${path.basename(script)} done`}`);
    return true;
  }
  log(
    `between Sues: ${path.basename(script)} failed (exit ${r.status ?? r.error?.message ?? "unknown"}): ${said}; the next Sue meets whatever the last one left`,
  );
  return false;
}

/**
 * The sites a signed-in Sue's session is made of: the target itself, or, for a target whose visit
 * crosses sites (`sessionParts`), one entry per site - `{ id, target }`, `id` the session folder
 * (`state/sessions/<id>/`) and `target` that site's own target file, loaded, so each part is proven
 * against its own `signIn`. Example App Next's AI scenario is one part, Discord's sign-in: she signs
 * in to the dashboard herself during the visit, through Discord's authorize page.
 */
export function sessionPartsOf(target) {
  const parts = Array.isArray(target?.sessionParts) ? target.sessionParts : [];
  if (!parts.length) return [{ id: target.id, target }];
  const base = target.home ?? path.join(HERE, "targets");
  return parts.map((part) => {
    const file = path.resolve(base, String(part.target));
    try {
      const loaded = loadTarget(file);
      // The session is read under the part's id and saved by login under the part target's own id,
      // so two different ids would leave a refusal that signing in again never cures.
      if (part.id && part.id !== loaded.id) throw new Error(`its id "${part.id}" must be the id of ${part.target} ("${loaded.id}")`);
      return { id: loaded.id, target: loaded };
    } catch (err) {
      throw new Error(`session part "${part.id}" of ${target.id}: ${err.message}`, { cause: err });
    }
  });
}

/**
 * `--as <name>` made real: every part's saved session read (`sessionPartsOf`) and, unless `probe` is
 * false (a dry run), proven live against that part's own `signIn`. Resolves `{ ok: true, files,
 * freeHands, parts }` - `files` the session files the body loads together, `freeHands` only when EVERY
 * part was saved as a throwaway, `parts` what may be said about each (counts, hosts, names; never a
 * value) - or `{ ok: false, part, message }` naming the part that is missing or no longer signs in.
 */
export async function borrowSession({ target, as, probe = true, fetchImpl } = {}) {
  const parts = sessionPartsOf(target);
  const split = parts.length > 1 || parts[0].id !== target.id;
  const kept = [];
  for (const part of parts) {
    const file = sessionFile(part.id, as);
    const which = split ? `${part.id} (part of ${target.id}'s session)` : part.id;
    const signInWith = `node sue/login.mjs (or login-chrome.mjs) --target ${part.target.file ?? part.target.id} --as ${as}`;
    const saved = readSession(file);
    if (!saved) return { ok: false, part: part.id, message: `no saved session "${as}" for ${which}; sign in once with: ${signInWith}` };
    let account = null;
    if (probe) {
      const probed = await probeSession(part.target, saved, fetchImpl ? { fetchImpl } : undefined);
      if (!probed.ok)
        return {
          ok: false,
          part: part.id,
          message: `the saved "${as}" session no longer signs in to ${which} (probe ${probed.status ?? probed.error}); sign in again with: ${signInWith}`,
        };
      account = probed.account ?? null;
    }
    kept.push({ id: part.id, file, saved, account });
  }
  return {
    ok: true,
    files: kept.map((p) => p.file),
    // A split session's free hands are the combined target's decision (`freeHands: true` on it), not
    // something inherited from one part that was granted them for a narrower site.
    freeHands: kept.every((p) => p.saved.freeHands === true) && (!split || target.freeHands === true),
    parts: kept.map(({ id, file, saved, account }) => ({ id, file, account, ...describeSession(saved) })),
  };
}

// ── the focus group's table ─────────────────────────────────────────────────────────────────────

/**
 * Who sits at the table, in plan order: each Sue by the first name her brief gives her (her minted
 * identity) and her own number. The persona's display name was used once, so the table called a Sue
 * "Bob" whose brief said "Your name is Dale", and a Sue corrected the moderator at the table ("Alan,
 * not Marcus", runs 20260924-175142-65f6 and 20260924-185310-a67e).
 */
export function rosterOf(plan, personasById) {
  return plan.map((entry) => {
    const persona = personasById.get(entry.personaId);
    const device = persona?.dials?.device;
    return {
      id: entry.sueId,
      name: `${entry.identity?.firstName ?? persona?.displayName ?? entry.personaId} ${entry.sueNumber}`,
      persona: entry.personaId,
      ...(device ? { device } : {}),
    };
  });
}

/** Her errand, then the table: the same words on a CLI brain and a chat brain. */
function withFocusBrief(prompt, sueId, roster) {
  return `${String(prompt).trimEnd()}\n\n${focusGroupBrief({ me: sueId, roster })}`;
}

/** Short on purpose: the moderator's whole job is its first message (lib/room.mjs moderatorBrief). */
export const MODERATOR_SYSTEM_PROMPT = [
  "You are the moderator of a focus group about a website. You never use the website yourself and you never answer for the people at the table:",
  "you listen, ask open questions, test ideas without leading anyone, and help the room agree on the ONE biggest problem, in its own words.",
  "Every move you make goes through your hands (room, ask, propose, gather, conclude). Be brief, warm and neutral.",
  "When conclude thanks you, or the room tells you it has already agreed, you are finished: reply with the single word finished.",
].join(" ");

/** The moderator's own folder in the run, beside the Sues': `<runDir>/moderator`. */
export function moderatorFiles(dir) {
  return {
    dir,
    systemPromptFile: path.join(dir, "brain-system.md"),
    mcpConfigFile: path.join(dir, "mcp.json"),
    brief: path.join(dir, "brief.md"),
  };
}

/** The moderator's sealed CLI argv: the same seal as a Sue's (`--tools ""`, only its own MCP hands). Pure. */
export function buildModeratorArgs({ dir, meta, roster, model = SUE_DEFAULT_MODEL }) {
  const { systemPromptFile, mcpConfigFile } = moderatorFiles(dir);
  return buildClaudeArgs({
    scenarioPrompt: moderatorBrief({ meta, roster }),
    systemPromptFile,
    mcpConfigFile,
    model,
    maxTurns: MODERATOR_MAX_TURNS,
  });
}

/** Its world on disk, the way writeSueFiles lays out a Sue's: system prompt, MCP pointer, and a chat brief. */
function writeModeratorFiles({ runId, meta, roster, brain }) {
  const files = moderatorFiles(path.join(runDir(runId), MODERATOR_ID));
  fs.mkdirSync(files.dir, { recursive: true });
  fs.writeFileSync(files.systemPromptFile, `${MODERATOR_SYSTEM_PROMPT}\n`);
  // Server name "sue" like a Sue's, so the one `--allowedTools mcp__sue__*` seal covers its hands too.
  fs.writeFileSync(
    files.mcpConfigFile,
    JSON.stringify({ mcpServers: { sue: { command: "node", args: [MODERATOR, "--sue", files.dir] } } }, null, 2) + "\n",
  );
  if (brain === "chat")
    fs.writeFileSync(files.brief, buildModeratorChatBrief({ brief: moderatorBrief({ meta, roster }), runId, handFile: HAND }));
  return files;
}

/**
 * Resolves true when `promise` settles within `ms`, else false. The timer is NOT unref'd: the run's
 * `finally` waits on it, and a process with nothing else alive must not exit before the manifest and
 * the report are written. It is cleared the moment either side wins.
 */
function within(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Starts the moderator beside the Sues. On `chat` it is one more entry in the relay (its hands are
 * moderator.mjs, it ends on `conclude`), sent in by the chat with the Sues; on a key pool it is a
 * sealed CLI brain spawned exactly the way a Sue's is. Resolves `{ ended, stop }` - `ended` settles
 * when it is done on its own, `stop` ends it - or null when it could not start (the vote still closes
 * the room without it, and the log says why).
 */
async function startModerator({ runId, opts, meta, roster, relay, deadlineMs }) {
  const files = writeModeratorFiles({ runId, meta, roster, brain: opts.brain });
  if (opts.brain === "chat") {
    const ended = relay.register({
      sueId: MODERATOR_ID,
      sueDir: files.dir,
      brief: files.brief,
      persona: MODERATOR_ID,
      bodyFile: MODERATOR,
      endsOn: "conclude",
      role: "moderator",
    });
    log(`focus group: the moderator's brief is ${files.brief}`);
    // Nothing to stop: relay.close ends a moderator whose agent is still talking.
    return { ended, stop: async () => {} };
  }
  const model = modelForBrain(opts.brain, { model: opts.model });
  let env;
  try {
    env = await brainEnv(opts.brain, process.env, {
      model,
      proxyLog: { logFile: path.join(runDir(runId), "local-proxy.jsonl"), tag: MODERATOR_ID },
    });
  } catch (err) {
    log(`focus group: the moderator could not start (${err && err.message}); the vote will close the room`);
    return null;
  }
  const cwd = scratchDir("moderator-");
  const { child, done } = spawnBrain({
    args: buildModeratorArgs({ dir: files.dir, meta, roster, model }),
    env,
    cwd,
    stdoutFile: path.join(files.dir, "brain.jsonl"),
    bin: opts.claudeBin,
    timeoutMs: deadlineMs,
  });
  log(`focus group: the moderator is in the room (${opts.brain}, model ${model})`);
  const ended = done.then((spoke) => {
    if (spoke.stderr && spoke.stderr.trim()) fs.writeFileSync(path.join(files.dir, "brain.stderr.log"), spoke.stderr);
    try {
      fs.rmSync(cwd, { recursive: true, force: true });
    } catch {
      /* a temp dir left behind is not worth failing the room over */
    }
    return spoke;
  });
  return {
    ended,
    stop: async () => {
      killBrainTree(child);
      await within(ended, 10_000);
    },
  };
}

const PHASE_WORDS = { visiting: "the Sues are on the website", table: "everyone is at the table" };

/**
 * The vote watchdog: every `everyMs` (unref'd, so it never holds the run open) it asks the room
 * whether the vote should close it now (lib/room.mjs voteShouldClose) and, if so, concludes by vote.
 * It also logs each phase the room enters, once. `tick` runs one pass on demand.
 */
export function watchRoom(dir, { everyMs = VOTE_WATCH_MS, say = log } = {}) {
  let phase = null;
  const tick = () => {
    try {
      if (voteShouldClose(dir)) conclude(dir, { by: "vote" });
      const now = phaseOf(dir);
      if (now === phase) return;
      phase = now;
      const verdict = now === "closed" ? readVerdict(dir) : null;
      say(`focus group: ${verdict ? `the room agreed (by ${verdict.decidedBy}): "${verdict.problem}"` : (PHASE_WORDS[now] ?? now)}`);
    } catch (err) {
      say(`focus group: the vote watchdog stumbled (${err && err.message}); it tries again`);
    }
  };
  tick();
  const timer = setInterval(tick, everyMs);
  timer.unref?.();
  return { tick, stop: () => clearInterval(timer) };
}

/**
 * Every Sue is done: the room closes. If nobody concluded, the vote decides (the problem with the
 * most backers; nothing at all when nobody voted). Then the moderator gets `graceMs` to finish on its
 * own and is ended either way.
 */
export async function closeRoom({ dir, watch, moderator, graceMs = MODERATOR_GRACE_MS, say = log }) {
  watch?.stop();
  if (!readVerdict(dir)) {
    try {
      const { verdict } = conclude(dir, { by: "vote" });
      if (!verdict) say("focus group: every Sue is done and nobody voted, so the room has no verdict");
    } catch (err) {
      say(`focus group: the vote could not close the room (${err && err.message})`);
    }
  }
  watch?.tick();
  if (!moderator) return;
  if (!(await within(moderator.ended, graceMs)))
    say(`focus group: the moderator was still talking ${Math.round(graceMs / 1000)}s after the last Sue; ending it`);
  await moderator.stop();
}

async function runWave({ runId, wave, opts, target, scenario, personasById, stopSignal }) {
  const results = [];
  // A focus-group Sue whose visit ended without a goodbye still leaves the room, so the table never
  // waits on a ghost (lib/room.mjs markGone; a Sue who said goodbye is left alone).
  const leaveRoom = (entry, why) => {
    if (!opts.focusGroup) return;
    try {
      if (markGone(runDir(runId), entry.sueId, { why })) log(`focus group: ${entry.sueId} left the room (${why})`);
    } catch (err) {
      log(`focus group: could not mark ${entry.sueId} as gone (${err && err.message})`);
    }
  };
  const launch = async (entry) => {
    if (stopSignal.stopped) return null;
    const persona = personasById.get(entry.personaId);
    log(`launching ${entry.sueId} (${persona.displayName}) as ${entry.address}`);
    try {
      const out = await runSue({
        runId,
        persona,
        scenario,
        target,
        identity: entry.identity,
        browserProfileDir: path.join(entry.sueDir, "profile"),
        browserWsEndpoint: opts.browserWsEndpoint,
        model: opts.model,
        brain: opts.brain,
        sueNumber: entry.sueNumber,
        sueId: entry.sueId,
        stampede: opts.stampede,
        session: opts.session,
        claudeBin: opts.claudeBin,
        relay: opts.relay,
        bodyHosts: opts.bodyHosts,
        ...(opts.focusGroup ? { focusGroup: true } : {}),
        ...(opts.tape ? { tape: opts.tape } : {}),
        ...(opts.reading ? { reading: opts.reading } : {}),
      });
      log(`${entry.sueId} finished: ${out.summary.outcome}, ${out.summary.numTurns ?? "?"} turns, $${out.summary.totalCostUsd ?? "?"}`);
      results.push(out);
      leaveRoom(entry, "her visit ended");
      return out;
    } catch (err) {
      log(`${entry.sueId} crashed before a summary: ${err && err.message}`);
      results.push({ sueId: entry.sueId, sueDir: entry.sueDir, result: null, error: String(err && err.message) });
      leaveRoom(entry, "her visit broke off");
      return null;
    }
  };
  if (opts.stampede) {
    // Everybody spawns; the bodies hold at `ready` until every `go` is written in one pass.
    const running = wave.map((entry) => launch(entry));
    const late = await waitForReady(wave, opts.readyTimeoutMs);
    if (late.length) log(`stampede: ${late.length} bodies never touched ready within ${opts.readyTimeoutMs}ms; releasing the rest anyway`);
    const releasedAt = new Date().toISOString();
    for (const entry of wave) {
      try {
        fs.writeFileSync(path.join(entry.sueDir, "go"), releasedAt + "\n");
      } catch {
        /* a Sue that already died has no dir to release */
      }
    }
    log(`stampede released ${wave.length} Sues at ${releasedAt}`);
    await Promise.all(running);
    return results;
  }
  let next = 0;
  const worker = async () => {
    while (next < wave.length && !stopSignal.stopped) {
      const entry = wave[next++];
      await launch(entry);
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency, wave.length) }, worker));
  return results;
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`${err.message}\n${usage()}\n`);
    return 64;
  }
  if (opts.help) {
    process.stdout.write(usage() + "\n");
    return 0;
  }
  // The one door (lib/door.mjs): a wave nothing tracks is refused before a Sue number is spent.
  if (!opts.dryRun && !cameThroughSueRun({ runId: opts.runId })) {
    log(`REFUSING to start: ${DOOR_REFUSAL}`);
    return 2;
  }
  // A focus group's room is opened by `sue run` (its focus_group action) before the cannon starts:
  // what the room is about, the caller's guesses and the last group's verdict live there. With no room
  // there is nothing to seat anyone at, so the run is refused before a Sue number is spent.
  if (opts.focusGroup && !opts.dryRun && !isFocusGroup(runDir(opts.runId))) {
    log(
      `REFUSING to start: --focus-group needs its room opened first, and ${path.join(runDir(opts.runId), ROOM_DIR, ROOM_META_FILE)} is not there. A focus group starts through sue run's focus_group action (or run with focusGroup: true), which opens it`,
    );
    return 2;
  }
  // A chat brain opens every Sue at once and the chat paces its own agents; her body only starts on
  // her first move, so a Sue waiting for her agent holds no browser. Neither a nonstop run nor a
  // stampede has a chat to drive it.
  if (opts.brain === "chat") {
    if (opts.forever || opts.stampede) {
      process.stderr.write(`--brain chat drives a fixed set of Sues from one chat: drop --forever and --stampede\n`);
      return 64;
    }
    opts.concurrency = opts.count;
  }
  // A focus group is everyone in the room at once, like a real one: one wave the size of the table,
  // whatever --concurrency said, and never a table bigger than the room seats.
  if (opts.focusGroup) {
    if (opts.count > FOCUS_GROUP_MAX) {
      process.stderr.write(
        `a focus group seats at most ${FOCUS_GROUP_MAX} Sues (--count ${opts.count}): send the rest in the next group\n`,
      );
      return 64;
    }
    opts.concurrency = opts.count;
  }
  // Resolve `auto` ONCE, here, so every consumer below (the fairjob decision, the wave slicing, the
  // manifest, the dry-run print) reads the same number and none of them has to know about "auto".
  const autoSized = opts.concurrency === "auto";
  opts.concurrency = resolveConcurrency(opts);
  opts.count = foreverBatchCount(opts);
  if (autoSized && opts.count > 1) {
    log(
      `wave size ${opts.concurrency} (auto: ${Math.round(os.freemem() / (1024 * 1024))} MB free, ${os.cpus().length} cores; pass --concurrency N to override)`,
    );
  }
  if (opts.concurrency > FAIRJOB_ABOVE && opts.fairjob && !opts.dryRun && !process.env.SUE_UNDER_FAIRJOB) {
    const status = reexecUnderFairjob(argv);
    if (status !== null) return status;
  }

  // `--target` is a roster slug or a PATH to a product's own target file; a path target's personas
  // and scenarios (beside it) win over the roster's, and its `errands` give roster personas the
  // product's reasons to visit.
  const target = loadTarget(opts.target);
  // A run's own copy of its page's target (sue.mjs planRun) is only where THIS run's errands and cast were kept
  // safe from other runs; everything that names the target's file means the page's.
  if (typeof target.pageFile === "string") {
    target.file = target.pageFile;
    delete target.pageFile;
  }
  // `--start-url`: the run's own address (sue.mjs cannonArgs). A link run's target file is one per page
  // section and every run rewrites it, so its startUrl is whichever run wrote last (2026-09-25: /go/22,
  // /go/24 and /go/33 started a second apart and all three Sues opened /go/33).
  if (opts.startUrl) target.startUrl = opts.startUrl;
  const scenarioRaw = loadScenario(opts.scenario, { target });
  const scenario = resolveScenario(scenarioRaw, target);
  // `--people`: the people this wave sends, as sue.mjs fetched them from Connections (lib/people.mjs) and handed
  // them over for as long as the run lasts. A cannon started by hand fetches its own.
  try {
    if (opts.people) {
      const handed = JSON.parse(fs.readFileSync(opts.people, "utf8"));
      installPeople(handed.people, { minds: handed.minds ?? {} });
    } else await readyPeople({}, { root: process.cwd(), ids: opts.personas });
  } catch (err) {
    log(`REFUSING to start: the people could not come from Connections: ${err.message}`);
    return 2;
  }
  // A critic's mind is her playbook in Connections, handed over with the people: pinned on the target ONCE, here, so
  // every Sue of the wave carries the same text into her sue.json. One with no mind, or one over the cap, refuses
  // before a Sue number is spent.
  pinCriticMinds(target, opts.personas);
  let personas;
  try {
    personas = opts.personas.map((id) => applyScenarioErrands(loadPersona(id, { target }), scenario));
  } catch (err) {
    log(`REFUSING to start: ${err.message}`);
    return 2;
  }

  // `--as <name>`: every Sue borrows the session a human saved with login.mjs. Proven live BEFORE a
  // Sue number is spent, the same way the brain is: an expired session would otherwise send a whole
  // wave to the sign-in page and score it as the product's dashboard being unreachable.
  // A target whose visit crosses sites (`sessionParts`) borrows one saved session per site, and each
  // is proven against its own sign-in; a missing or expired part is refused BY NAME.
  // The files she brings are checked here too: a folder the scenario names and that is missing
  // refuses the run before a Sue number is spent.
  let files;
  try {
    files = scenarioFiles(target, scenario);
  } catch (err) {
    log(`REFUSING to start: ${err.message}`);
    return 2;
  }
  let session = null;
  opts.freeHands = false;
  if (opts.as && mustSignUpForReal(target)) {
    log(
      `REFUSING to start: --as ${opts.as} on ${target.id}, a site whose sign-up mail the mailroom reads. Every Sue there makes her own account through the real sign-up, so drop --as`,
    );
    return 2;
  }
  if (opts.as) {
    let lent;
    try {
      lent = await borrowSession({ target, as: opts.as, probe: !opts.dryRun });
    } catch (err) {
      log(`REFUSING to start: ${err.message}`);
      return 2;
    }
    if (!lent.ok) {
      log(`REFUSING to start: ${lent.message}`);
      return 2;
    }
    if (!opts.dryRun) {
      for (const d of lent.parts) {
        const where = lent.parts.length > 1 || d.id !== target.id ? ` on ${d.id}` : "";
        const what = [d.cookies ? `${d.cookies} cookie(s)` : null, d.storage.length ? `${d.storage.length} page-storage item(s)` : null]
          .filter(Boolean)
          .join(" and ");
        log(
          `signed in as "${opts.as}"${where}: ${what || "nothing"} for ${d.hosts.join(", ")}, good until ${d.expiresAt ?? "unknown"}${d.account ? `, account ${d.account}` : ""}`,
        );
      }
      if (lent.freeHands) log("free hands (every part is a throwaway account: Sues may press anything)");
    }
    session = lent.files.length === 1 ? lent.files[0] : lent.files;
    opts.freeHands = lent.freeHands;
  }
  // `--profile <name>`: a saved login from the Logins tab, on anybody's site but Connections' own
  // (Discord for an app that signs in with it). No probe can prove an arbitrary site signed in, so it
  // is refused only when nothing in it is alive any more; the rails are the lent session's, guarded
  // unless it was saved free-handed.
  if (opts.profile) {
    if (onConnectionsSite(target.startUrl)) {
      log(
        `REFUSING to start: --profile ${opts.profile} on ${target.id}, one of Connections' own sites. Every Sue there makes her own account through the real sign-up, so drop --profile`,
      );
      return 2;
    }
    let saved;
    try {
      saved = readProfile(opts.profile);
    } catch (err) {
      log(`REFUSING to start: ${err.message}`);
      return 2;
    }
    if (!saved) {
      log(
        `REFUSING to start: no saved login named "${opts.profile}" on this computer. Add it under Logins in Sue's Settings, the gear beside your picture (or node sue/login-chrome.mjs --profile ${opts.profile} --site <url>)`,
      );
      return 2;
    }
    const d = describeProfile(opts.profile, saved.state);
    if (d.expired) {
      log(
        `REFUSING to start: the saved login "${opts.profile}" has run out (every cookie in it expired); sign in again under Logins in Sue's Settings`,
      );
      return 2;
    }
    if (!opts.dryRun)
      log(
        `signed in with saved login "${opts.profile}" on ${d.hosts.join(", ")}: ${d.cookies} cookie(s) and ${d.storage} page-storage item(s), lasting until ${d.lastsUntil ?? "unknown"}${d.freeHands ? "; free hands (a throwaway account: Sues may press anything)" : ""}`,
      );
    session = saved.file;
    opts.freeHands = d.freeHands;
  }
  opts.session = session;
  // ONE CLI for the whole run, chosen here and named in the log: the preflight and every Sue spawn it.
  const cli = resolveClaudeCli();
  opts.claudeBin = cli.bin;
  const runId = opts.runId ?? newRunId();
  // `--sampled N` mixes N drawn visitors in with the named roster, seeded by the run id so a rerun
  // of the same run id meets the same people. The scenario's errands (an intent run's `*`) still win.
  // The id is a 6-letter hash, so two draws can clash: redraw (still seeded) so personasById keeps both.
  for (let i = 0; i < opts.sampled; i++) {
    let drawn = synthesizePersona(`${runId}:sampled:${i}`);
    for (let retry = 1; personas.some((p) => p.id === drawn.id); retry++) drawn = synthesizePersona(`${runId}:sampled:${i}:${retry}`);
    personas.push(applyScenarioErrands(drawn, scenario));
  }
  const personasById = new Map(personas.map((p) => [p.id, p]));

  const verdict = capVerdict({ scenario, maxAccounts: opts.maxAccounts, alreadyThisRun: 0 });

  // BEFORE any Sue number or mail address is reserved: prove the brain can talk. A dead key pool is
  // a refusal, not a run - on 2026-09-21 it cost 410 Sue numbers, 410 addresses and five hours
  // (that day the brain was a CLI login; today it is `deepseek`/`openrouter`'s API key, but the same
  // five hours would burn just as fast on a key with no balance).
  if (opts.brain === "chat" && !opts.dryRun) log("the brains are the calling chat's own agents: no key pool is used or checked here");
  if (!opts.dryRun && !verdict && !opts.skipPreflight && opts.brain !== "chat") {
    // Every model the plan will think with is probed: a persona may name its own model, and one dead
    // model must refuse the whole run rather than let a mixed wave book its brain-errors as data.
    const models = [...new Set(personas.map((p) => modelForBrain(opts.brain, { model: opts.model, personaModel: p.model })))];
    log(
      `the brains think on --brain ${opts.brain} (an API key pool, never a login): model ${models.join(", ")}, CLI ${describeClaudeCli(cli)}`,
    );
    let sick = null;
    for (const model of models) {
      sick = await preflightBrain({ brain: opts.brain, model, bin: cli.bin });
      if (sick) {
        sick = { ...sick, message: `${model}: ${sick.message}` };
        break;
      }
    }
    if (sick) {
      log(`REFUSING to start: the brain cannot talk - ${sick.kind}: ${sick.message}; ${cliRefusalAdvice(cli, sick.message)}`);
      if (sick.kind === "auth")
        log(
          `the "${opts.brain}" brain was refused at the AI plane's door: check SUE_AI_DOOR_TOKEN (or the door's M2M secret) and the door's DeepSeek/OpenRouter key pools, then run the cannon again`,
        );
      return 2;
    }
    log("preflight: the brain answered, the key pool is good");
  }
  // The mailroom's preflight runs for EVERY brain, chat included. It used to sit inside the key-pool
  // block above, so a chat-brain run started a mailroom nobody had probed; on 2026-09-24 (run
  // 20260924-185204-fcc0, the installed Sue app with no AWS lease) it died on start, its death stopped
  // the run, the relay never opened, and five Opus agents polled it for up to 12 minutes each.
  if (!opts.dryRun && !verdict && !opts.skipPreflight && opts.mailroom && target.mailbox?.kind === "ses-inbound") {
    const mail = preflightMailroom();
    if (!mail.ok && scenario.createsAccount) {
      log(`REFUSING to start: the mailroom cannot read mail (${mail.error}), so every Sue's inbox would stay empty`);
      log(
        `sign AWS profile "${mail.profile}" back in (on this PC: aws sso login --profile ${mail.profile}), then run again; or, when the Sues need no account there, run with createAccounts false and the run goes on without mail`,
      );
      return 2;
    }
    if (!mail.ok) {
      // "Going on without it" means WITHOUT it: a mailroom already proved unable to read mail would die
      // on start, and its death ends the run (see startMailroom's caller) that never needed it.
      opts.mailroom = false;
      log(`preflight: the mailroom cannot read mail (${mail.error}); this scenario makes no accounts, so going on without one`);
    } else log("preflight: the mailroom opened both mail doors");
  }
  // The TARGET's preflight, for every brain: a start page that does not answer is a refusal, not a
  // run. On 2026-09-24 the credit lab's localhost server died at about 18:35 and runs kept starting
  // against it: 25 Opus-driven Sues each met ERR_CONNECTION_REFUSED, gave up and sat an exit
  // interview about a page they never saw, rows that read like data.
  if (!opts.dryRun && !verdict && !opts.skipPreflight && !opts.tape) {
    const reach = await preflightTarget(target.startUrl);
    if (!reach.ok) {
      log(`REFUSING to start: the target does not answer (${target.startUrl}: ${reach.error}); start it, then run again`);
      return 2;
    }
    log(`preflight: the target answered (HTTP ${reach.status})`);
  }

  const plan = buildPlan({ runId, opts, target, scenario, personas, reserve: !opts.dryRun && !verdict });
  // A focus group's seats, in plan order: the roster every Sue is told and the moderator runs.
  const roster = opts.focusGroup ? rosterOf(plan, personasById) : null;

  if (opts.dryRun) {
    const lines = plan.map((entry) => {
      const systemPromptFile = path.join(entry.sueDir, "brain-system.md");
      const mcpConfigFile = path.join(entry.sueDir, "mcp.json");
      const errandPrompt = buildScenarioPrompt({
        scenario,
        identity: entry.identity,
        errand: errandOf(personasById.get(entry.personaId) || {}, scenario, entry.sueNumber),
        persona: personasById.get(entry.personaId) || null,
      });
      const argv2 = buildClaudeArgs({
        scenarioPrompt: roster ? withFocusBrief(errandPrompt, entry.sueId, roster) : errandPrompt,
        systemPromptFile,
        mcpConfigFile,
        model: entry.model,
        maxTurns: entry.maxTurns,
      });
      const seat = roster ? { roomName: roster.find((s) => s.id === entry.sueId)?.name ?? null } : {};
      return { ...entry, ...seat, systemPromptFile, mcpConfigFile, claudeArgv: argv2 };
    });
    // The moderator a real run would start (a room that does not exist yet is described from the plan).
    let moderatorPlan = null;
    if (roster) {
      const meta = {
        ...(readMeta(runDir(runId)) ?? {
          url: target.startUrl,
          intent: scenario.title ?? scenario.id,
          suggestions: [],
          previous: null,
          moderator: "ai",
        }),
        judges: judgesScreens(target, scenario),
      };
      const files = moderatorFiles(path.join(runDir(runId), MODERATOR_ID));
      moderatorPlan =
        meta.moderator === "none"
          ? { none: true }
          : opts.brain === "chat"
            ? { brain: "chat", brief: files.brief }
            : {
                brain: opts.brain,
                systemPromptFile: files.systemPromptFile,
                mcpConfigFile: files.mcpConfigFile,
                claudeArgv: buildModeratorArgs({ dir: files.dir, meta, roster, model: modelForBrain(opts.brain, { model: opts.model }) }),
              };
    }
    const dry = {
      dryRun: true,
      runId,
      runDir: runDir(runId),
      target: target.id,
      startUrl: target.startUrl,
      scenario: scenario.id,
      createsAccount: scenario.createsAccount,
      brain: opts.brain,
      claudeBin: cli.bin,
      claudeVersion: cli.version,
      personas: opts.personas,
      sampled: personas.filter((p) => p.sampledFrom).map((p) => p.id),
      count: opts.count,
      concurrency: opts.concurrency,
      stampede: opts.stampede,
      forever: opts.forever,
      maxAccounts: opts.maxAccounts,
      accountsInLast24h: accountsToday(),
      mailroom: opts.mailroom && target.mailbox.kind === "ses-inbound" ? "would start" : "not started",
      fairjob: opts.concurrency > FAIRJOB_ABOVE && opts.fairjob ? "would re-exec under fairjob -Weight 3" : "unwrapped",
      capVerdict: verdict,
      /** What every Sue would bring: her files by name (copied from `filesFrom`) and the addresses she already has. */
      files: files.names,
      filesFrom: files.dir,
      knownAddresses: knownAddressesOf(target, scenario),
      session: session,
      ...(roster ? { focusGroup: true, moderator: moderatorPlan } : {}),
      sues: lines,
    };
    if (opts.json) {
      process.stdout.write(JSON.stringify(dry, null, 2) + "\n");
    } else {
      process.stdout.write(
        `SUE dry run: ${opts.count} x "${scenario.id}" at ${target.id} (${target.startUrl}), ${opts.concurrency} at a time${opts.stampede ? ", stampede" : ""}${opts.forever ? ", forever" : ""}\n`,
      );
      process.stdout.write(
        `run ${runId} -> ${dry.runDir}\nbrain: ${dry.brain}; CLI: ${describeClaudeCli(cli)}; mailroom: ${dry.mailroom}; fairjob: ${dry.fairjob}; accounts in last 24h: ${dry.accountsInLast24h}\n`,
      );
      if (verdict) process.stdout.write(`CAP: ${verdict}\n`);
      if (files.names.length) process.stdout.write(`her files (from ${files.dir}): ${files.names.join(", ")}\n`);
      if (dry.knownAddresses.length) process.stdout.write(`addresses she already has: ${dry.knownAddresses.join(", ")}\n`);
      if (session) process.stdout.write(`signed in with: ${[session].flat().join(", ")}\n`);
      if (roster)
        process.stdout.write(
          `focus group: ${roster.map((s) => s.name).join(", ")} at one table; moderator: ${moderatorPlan.none ? "none (the vote decides)" : moderatorPlan.brain}\n`,
        );
      for (const s of lines) {
        process.stdout.write(
          `\n${s.sueId}  ${s.address}  ${s.identity.fullName} (${s.identity.birthdate})  model ${s.model}  turns ${s.maxTurns}\n`,
        );
        process.stdout.write(`  claude ${s.claudeArgv.map((a) => (a === "" ? '""' : /\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
      }
      process.stdout.write("\nnothing was spawned.\n");
    }
    return 0;
  }

  if (verdict) {
    process.stderr.write(`[cannon] ${verdict}\n`);
    return 75;
  }

  fs.mkdirSync(mailDir(runId), { recursive: true });
  writeManifest(runId, {
    runId,
    target: target.id,
    targetFile: target.file ?? null,
    signedInAs: opts.as ?? null,
    projectId: opts.projectId ?? null,
    profile: opts.profile ?? null,
    ...(opts.tape ? { tape: opts.tape } : {}),
    ...(opts.reading ? { reading: opts.reading } : {}),
    sessionParts: opts.as ? sessionPartsOf(target).map((p) => p.id) : null,
    freeHands: opts.freeHands === true,
    files: files.names,
    groundTruth: target.groundTruth,
    exits: (target.exits ?? []).map((e) => ({ id: e.id, name: e.name ?? e.id })),
    startUrl: target.startUrl,
    scenario: scenario.id,
    personas: opts.personas,
    sampled: personas.filter((p) => p.sampledFrom).map((p) => p.id),
    count: opts.count,
    concurrency: opts.concurrency,
    stampede: opts.stampede,
    forever: opts.forever,
    maxAccounts: opts.maxAccounts,
    maxMinutes: runMaxMinutes(opts),
    mailbox: target.mailbox,
    addresses: plan.map((e) => e.address),
    sues: plan.map((e) => ({ sueId: e.sueId, sueNumber: e.sueNumber, persona: e.personaId, address: e.address })),
    ...(roster ? { focusGroup: true } : {}),
    started: new Date().toISOString(),
    finished: null,
  });
  log(`run ${runId} -> ${runDir(runId)}`);
  // Who sits at the table, written before a single Sue starts: her body reads it to name her in the room.
  if (roster) {
    writeRoster(runDir(runId), roster);
    log(`focus group: ${roster.map((s) => s.name).join(", ")} at one table`);
  }

  const stopSignal = { stopped: false };
  const onSignal = () => {
    if (stopSignal.stopped) return;
    stopSignal.stopped = true;
    log("stopping after the Sues in flight finish");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let mailroom = null;
  // ⛔ THE MAILROOM DYING ENDS THE RUN. It is the only thing that fetches a signup code, so once it is
  // gone every later Sue hits a mailbox that will never fill, cannot make an account, and blames the
  // SITE - which is how a working signup path scored 1.1 stars from 22 visitors on 2026-09-22 and
  // nearly sent a session fixing a product that was fine. Same reasoning as the dead-brain stop above:
  // one confirmed instrument failure is plenty of evidence, and manufacturing more rows past it is
  // worse than stopping, because the rows are indistinguishable from real ones afterwards.
  let mailroomDead = null;
  if (opts.mailroom && target.mailbox.kind === "ses-inbound")
    mailroom = startMailroom(runId, ({ code, signal, logFile, lastWords }) => {
      const verdict = mailroomDeathVerdict({ code, signal, logFile, lastWords, alreadyStopping: stopSignal.stopped });
      if (!verdict) return; // the run is already ending and the `finally` below killed it
      mailroomDead = verdict;
      log(`STOPPING: ${mailroomDead}`);
      log("the Sues already in flight will finish; their verdicts are about this tool, not about the product");
      stopSignal.stopped = true;
    });

  // ONE browser for every Sue in this run (see startBrowserServer). Its endpoint rides in each
  // `sue.json`; a null endpoint means each body launches its own, which still works.
  const browserServer = opts.tape ? null : await startBrowserServer(target, { runId });
  opts.browserWsEndpoint = browserServer ? browserServer.wsEndpoint() : null;

  // A CLI brain's body lives in one of the run's body hosts (lib/body-host.mjs), up to SUES_PER_HOST
  // Sues per node process, reached over HTTP MCP on her own path; the chat tier's relay holds its own.
  let bodyHosts = null;
  if (opts.brain !== "chat") {
    bodyHosts = createHostPool({ logDir: runDir(runId), say: log });
    opts.bodyHosts = bodyHosts;
  }

  let launcher = null;
  let relay = null;
  if (opts.brain === "chat") {
    // Off until asked: `--dispatch climayte`, or `node sue/dispatch.mjs <runId>` mid-run (its dispatch.json).
    launcher = createSealedDispatcher({ runDir: runDir(runId), runId, enabled: opts.dispatch === "climayte", log });
    relay = createBodyRelay({
      runDir: runDir(runId),
      bodyFile: opts.tape ? TAPE_BODY : BODY,
      ...(opts.focusGroup ? { focusGroupSeats: true } : {}),
      launcher,
    });
    const port = await relay.listen();
    opts.relay = relay;
    log(
      `chat brains: relay on 127.0.0.1:${port}; each Sue's brief is <sueDir>/brief.md, listed in ${path.join(runDir(runId), "chat-brains.json")}`,
    );
  }

  // The focus group's moderator starts beside the Sues (unless the room was opened without one), and
  // the vote watchdog starts with it: the room closes by vote when nobody concludes in words.
  let moderator = null;
  let roomWatch = null;
  if (roster) {
    // A game's room goes round its screens before it votes (lib/room.mjs moderatorBrief).
    const meta = { ...(readMeta(runDir(runId)) ?? {}), judges: judgesScreens(target, scenario) };
    if (meta.moderator === "none") log("focus group: no moderator (the room was opened without one); the vote decides");
    else {
      const longest = Math.max(...plan.map((e) => seatDeadlineMs(personasById.get(e.personaId), scenario, true)));
      try {
        moderator = await startModerator({ runId, opts, meta, roster, relay, deadlineMs: longest + MODERATOR_GRACE_MS });
      } catch (err) {
        log(`focus group: the moderator could not start (${err && err.message}); the vote will close the room`);
      }
    }
    roomWatch = watchRoom(runDir(runId));
  }

  let reportTimer = null;
  if (opts.forever) reportTimer = setInterval(() => runReport(runId), opts.reportEveryMs);

  let accountsThisRun = 0;
  const startedAtMs = Date.now();
  const maxMinutes = runMaxMinutes(opts);
  let wallClockCapped = null;
  let wavePlan = plan;
  let plannedThisRun = plan.length;
  let brainDead = null;
  let sueDoorClosed = null;
  const allResults = [];
  try {
    for (;;) {
      const waves = [];
      for (let i = 0; i < wavePlan.length; i += opts.concurrency) waves.push(wavePlan.slice(i, i + opts.concurrency));
      for (const wave of waves) {
        if (stopSignal.stopped) break;
        // Asked BEFORE every wave, not once per batch (see capVerdict's header): a batch can be far
        // larger than --max-accounts because the cap counts accounts rather than Sues. Checking here
        // bounds the overshoot at one wave.
        const capped = capVerdict({ scenario, maxAccounts: opts.maxAccounts, alreadyThisRun: accountsThisRun });
        if (capped) {
          log(capped);
          stopSignal.stopped = true;
          break;
        }
        const late = wallClockVerdict({ startedAtMs, maxMinutes });
        if (late) {
          log(late);
          stopSignal.stopped = true;
          wallClockCapped = late;
          break;
        }
        if (target.betweenSues && opts.session && !opts.dryRun) runBetweenSues(target);
        const results = await runWave({ runId, wave, opts, target, scenario, personasById, stopSignal });
        allResults.push(...results);
        accountsThisRun += results.filter((r) => r.summary && r.summary.madeAccount).length;
        // A whole wave of dead brains is never the site's fault and never a coincidence: on
        // 2026-09-21 an expired OAuth session let this loop run 40 more waves and 400 more Sues,
        // every one of them scored as a visitor who did not understand the page. One wave is plenty
        // of evidence - stop the run and name the cause instead of manufacturing data.
        const allDead = waveAllDead(results);
        if (allDead) {
          log(`STOPPING: all ${results.length} Sues in that wave failed before they saw anything - ${allDead}`);
          log("no usable data was produced; fix the brain's login or quota and start a new run");
          stopSignal.stopped = true;
          brainDead = allDead;
          break;
        }
        const doorShut = sueDoorShut(results);
        if (doorShut) {
          log(`STOPPING: ${doorShut}`);
          stopSignal.stopped = true;
          sueDoorClosed = doorShut;
          break;
        }
      }
      if (!opts.forever || stopSignal.stopped) break;
      // No second cap check here: the per-wave one above is asked before the first wave of this next
      // batch too, so a batch boundary needs no rule of its own. There used to be one here, and it
      // was the ONLY one, which is what let a whole batch overshoot the cap.
      wavePlan = buildPlan({ runId, opts, target, scenario, personas, reserve: true, offset: plannedThisRun });
      plannedThisRun += wavePlan.length;
      const manifest = readManifest(runId);
      manifest.addresses.push(...wavePlan.map((e) => e.address));
      manifest.sues.push(...wavePlan.map((e) => ({ sueId: e.sueId, sueNumber: e.sueNumber, persona: e.personaId, address: e.address })));
      writeManifest(runId, manifest);
      log(`forever: next wave of ${wavePlan.length}`);
    }
  } finally {
    if (reportTimer) clearInterval(reportTimer);
    // Every Sue is done: the room closes (by vote if nobody concluded) and the moderator is let go,
    // before the relay closes, so a chat moderator still talking gets its grace first.
    if (roomWatch) await closeRoom({ dir: runDir(runId), watch: roomWatch, moderator });
    // A visitor still waiting on CliMayte when the run ends is cancelled, so no worker outlives its run.
    if (launcher) await launcher.close();
    // Before the browser: a body the relay still holds open closes its own context first.
    if (relay) await relay.close();
    // Every Sue's body shut down properly, then the host processes let go - before the browser.
    if (bodyHosts) await bodyHosts.close();
    if (browserServer) {
      try {
        await browserServer.close();
      } catch {
        /* the wave's browser is already down */
      }
    }
    if (mailroom && mailroom.exitCode === null) {
      try {
        mailroom.kill();
      } catch {
        /* already gone */
      }
    }
    const manifest = readManifest(runId);
    manifest.finished = new Date().toISOString();
    manifest.accountsCreated = accountsThisRun;
    if (wallClockCapped) manifest.wallClockCapped = { maxMinutes, why: wallClockCapped };
    // Written BEFORE the report is generated, so the report's own banner carries it (report.mjs's
    // `toolFailure`) - a run poisoned by our apparatus must say so in the artifact people read, not
    // only in a log line that scrolls past.
    if (mailroomDead || sueDoorClosed) manifest.toolFailure = mailroomDead || sueDoorClosed;
    writeManifest(runId, manifest);
    runReport(runId);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  const crashed = allResults.filter((r) => r.error).length;
  log(`done: ${allResults.length} Sues, ${accountsThisRun} accounts, ${crashed} crashed`);
  if (mailroomDead || sueDoorClosed) return 3;
  if (brainDead) return 2;
  return crashed && crashed === allResults.length ? 1 : 0;
}

const invokedDirectly = isMainModule(import.meta.main, import.meta.url);
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`[cannon] ${err && err.stack ? err.stack : err}\n`);
      process.exit(1);
    },
  );
}
