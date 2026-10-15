#!/usr/bin/env node
/**
 * SUE ROUNDS - several runs at one product at once (a class of students, a panel of teachers), scored against a
 * target, kept as a series, and handed to Dredd's review table and design board by themselves.
 *
 *   node sue/round.mjs start  --plan <plan.json> [--focus [--room <key>] | --teachers] [--no-critics] [--fresh] [--engine-ref <ref>] [--dispatch climayte]
 *   node sue/round.mjs report --plan <plan.json> [--no-table] [--tape <dir> | --reference] [--engine-ref <ref>]
 *   node sue/round.mjs table  --plan <plan.json> [--tape <dir> | --reference]
 *   node sue/round.mjs times  --plan <plan.json> [--tape <dir> | --reference]
 *   node sue/round.mjs hunt   --plan <plan.json> [--json]   SUE's own faults, ranked (lib/sue-hunt.mjs)
 *   node sue/round.mjs people-hunt --plan <plan.json> [--json]   the personas that read weakest, with a rewrite direction (lib/people-hunt.mjs)
 *   node sue/round.mjs mark   --plan <plan.json> <step> start|end [--tape <dir> | --reference]
 *   node sue/round.mjs trend  --plan <plan.json> [--teachers | --focus | --reference]
 *
 * `start --reference` is the ceiling check: the same students on the plan's reference product, scored on its own
 * doneWhen and kept in its own series, whose stars become the bar (target.starsVs). Every command after `start` reads
 * the round's series and kind from the state `start` saved, never from the plan, which may have moved on since. Each
 * kind of round keeps its own state file (last.json live, last-tape.json for --tape, last-reference.json for
 * --reference, last-engine-<ref>.json for each --engine-ref), so they can run side by side; give a later command the
 * same --tape / --reference / --engine-ref as its `start`.
 * A series still without a new best after its ceiling check is AT CEILING (the Chair, 2026-10-03: "a reasonable cutoff, so
 * we don't end up running till infinity attempting to achieve a score that is potentially technically impossible"):
 * `start` refuses until the build id or the plan changes (--despite-ceiling "<reason>" overrides).
 *
 * `--engine-ref <ref>` runs the round on Sue's own code as it was at a git ref (the old arm of an A/B of a change to
 * SUE, ab.mjs): that commit's engine is staged once (lib/engine-store.mjs stageEngineAt), every run is handed to it by
 * its commit (sue.mjs runOnEngineAt), and its visits carry that engine's id, so they are an arm of their own on the
 * same builds and people. It is a measurement of SUE, not of the product: its rows go to "<series>-engine" and its
 * state to last[-tape|-reference]-engine.json, and it is never stuck, at ceiling or followed by a review table. A run
 * whose answer names any other engine is not counted; give `report` the same --engine-ref.
 *
 * the Chair, 2026-10-01: "The synthetic process is the answer, not real people ... Students and teachers say what they
 * need; the boardroom's experts decide how ... The stars are the target, and it should improve as it goes, every round."
 * Lift's class unit sat at 3 stars for nine rounds because its round script (Lift's sue-round.mjs) sent users only,
 * held no review table after round 9, and knew no target: each round's fixes were wording, answer keys and screens
 * while students kept stopping in parts 1 and 2. So a round here:
 *   - sends the plan's CRITICS beside its users (SUE's retention-doctor and game-designer by default: experts who walk
 *     the same path and say where attention breaks and why), and says so loudly when a plan has none;
 *   - reports the USERS' stars (never a critic's), who FINISHED (a screen that shows a `doneWhen` text) and how far
 *     each got (`progress`), against the plan's target (4.5 stars, 5 of 6 finishing, two rounds running by default);
 *   - keeps the round in <workspace>/.sue/rounds/<series>.jsonl and reads it against the ones before (lib/rounds.mjs):
 *     met, improving, or STALLED - and a stalled or early-stop round's next work is the DESIGN BOARD's;
 *   - starts Dredd's round hearing once every run is in (dredd.mjs --round-file): the review table sits over the
 *     round, and under the target the design board (five minds: games, product design, attention, psychology) drafts
 *     a redesign, never a wording patch. `report --no-table` holds it; `table` starts it by hand.
 *
 * The plan (JSON) is the product's own file, e.g. Lift's docs/kids/class-cast.json: series, demo, reset, url, root,
 * target, doneWhen, progress, intent ({en, es} or one string), expect (optional, same shape: one short line on what the
 * page is meant to be, told to every Sue so a page that is something else gets noted; a `reference` block and
 * `teachers` may carry their own), students [{persona, seat, lang}], critics [{persona,
 * seat}], rooms [{key, name, seat, personas, lang}], teachers {seat, personas, intent}, suggestions. A seat is a path
 * under `demo` or a whole URL.
 *
 * Identity reuse (a plan with a `reuse` block only, lib/reuse.mjs): a student whose engine, driver, hands, persona docs
 * (and a critic's mind), run args and the plan's `reuse.builds` (live build ids) are all byte-equal to her last FRESH
 * visit's (per-part hashes in its reuse.json) is not sent again; that visit stands for the round, labelled `(reused from
 * round N)`, and the row lists her in `reused`. The cheap parts are compared first and the people are fetched once, in
 * process, only if someone still matches. When every run is reusable `start` prints NOTHING CHANGED and starts nothing.
 * The people come through a warm holder (people-door.mjs: one open local-MCP door, 127.0.0.1 and a token, gone after 30
 * minutes idle) when one answers, which `report` and a `start` that had to open a door leave running; else through a door
 * `start` opens itself. The timing line says `people N warm` or `people N cold`. Every part is still a live check at the
 * moment of the start: the holder remembers no answer, it only keeps the door (and the HEAD connections) open. It
 * answers the builds, the default engine id, the list and the minds in one local `identity` call (people-door.mjs).
 * `--fresh` measures again. A reused round can break a streak but never extend one (lib/rounds.mjs trend).
 *
 * Drivers: every Sue is ONE sealed CliMayte task (Owner, 2026-10-06; lib/climayte-dispatch.mjs): her brain holds her
 * system prompt and her hands and nothing else. `start --dispatch climayte` has SUE send them itself, so the caller
 * starts nothing; without it `start` prints, per run, `node sue/dispatch.mjs <runId>` and the climayte_run call.
 * Only when CliMayte is unavailable (or a run's engine wrote no sealed launch) does it print one brief per Sue for the
 * old way: one sue-driver agent per brief, ALL in one message, with the Agent tool - never a Workflow, whose agents are
 * handed the operator's own message (a student who has read it is no longer a stranger).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { runStatusFile } from "./lib/door.mjs";
import { runsRoot } from "./lib/run-dir.mjs";
import { climayteGroup, climayteReady, climayteRunCall } from "./lib/climayte-dispatch.mjs";
import { checkoutRoot } from "./lib/engine-lease.mjs";
import { CHECKOUT, currentEngineId, stageEngineAt } from "./lib/engine-store.mjs";
import { openPeopleDoor } from "./lib/people.mjs";
import { ensureHolder, warmDoor } from "./people-door.mjs";
import { argsOf, fetchBuilds, fillDocs, findReuse, inputsHash, writeReuse } from "./lib/reuse.mjs";
import { timeRows, traceOf } from "./lib/round-times.mjs";
import { decisionCommitsAsync, gatherSueHunt, renderSueHunt } from "./lib/sue-hunt.mjs";
import { gatherPeopleHunt, rankPeopleHunt, renderPeopleHunt } from "./lib/people-hunt.mjs";
import { markRound, mergeMarks, readRounds, referenceAtOf, renderTrend, seriesKey, targetOf, trend, writeRound } from "./lib/rounds.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUE = path.join(HERE, "sue.mjs");
/**
 * Dredd's CLI in the checkout, never one beside this file: the round's table is a new job of another tool, so it
 * starts on the current code, and Dredd is no part of SUE's engine. Named from checkoutRoot() inside the call on
 * purpose: a path built from this file's own folder (or from a constant holding a root) is one the engine store
 * carries into every snapshot, and Dredd's CLI brings the design critic's wave and the whole Architect with it
 * (tests/engine-store.spec.mjs went red on exactly that, 2026-10-01).
 */
const DREDD = path.join(checkoutRoot(), "dredd", "dredd.mjs");
const RUNS = runsRoot();
/** Hands a running wave's Sues to SUE's own CliMayte dispatch, written with forward slashes for any shell. */
const DISPATCH_CLI = path.join(HERE, "dispatch.mjs").split(path.sep).join("/");
/** SUE's own critics, the ones Dredd sends on an attention ask (dredd/lib/convene.mjs SUE_CRITICS). */
const DEFAULT_CRITICS = ["retention-doctor", "game-designer"];
/** The routing gate refuses a driver whose prompt is only a brief path; this is SUE's own reason line. */
const REASON =
  "why-not-hswarm: SUE's contract puts every visitor on Sonnet 5.5 (Dredd's SUE tier, owner 2026-10-05), and her hands are a local browser session on this PC that only a local Bash can drive.";

function usage(why) {
  if (why) console.log(why);
  console.log(
    "usage: node sue/round.mjs start|report|table|times|hunt|people-hunt|mark|trend|agree --plan <plan.json> [--reference] [--focus [--room key] | --teachers] [--no-critics] [--no-table] [--fresh] [--tape <dir>] [--engine-ref <ref>] [--dispatch climayte (start: SUE sends each Sue to CliMayte sealed)] [--despite-stall <reason>] [--despite-ceiling <reason>] [--workspace dir] (report, table, times and mark take the --tape / --reference / --engine-ref their start had: each kind keeps its own state file)",
  );
  console.log("       node sue/round.mjs mark --plan <plan.json> <step> start|end [--workspace dir]");
  console.log(
    "       node sue/round.mjs agree --plan <plan.json> [--live-round <n>] [--tape-round <n>] [--runs dir] [--workspace dir]",
  );
  process.exit(2);
}

export function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const a = {
    cmd,
    plan: null,
    reference: false,
    focus: false,
    room: null,
    teachers: false,
    critics: true,
    table: true,
    workspace: null,
    tape: null,
    engineRef: null,
    despiteStall: null,
    despiteCeiling: null,
    fresh: false,
    step: null,
    liveRound: null,
    tapeRound: null,
    runs: null,
    json: false,
    dispatch: null,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const x = rest[i];
    const value = () => {
      const v = rest[++i];
      if (!v || v.startsWith("--")) usage(`${x} needs a value`);
      return v;
    };
    if (x === "--plan") a.plan = value();
    else if (x === "--reference") a.reference = true;
    else if (x === "--focus") a.focus = true;
    else if (x === "--room") {
      a.room = value();
      a.focus = true;
    } else if (x === "--teachers") a.teachers = true;
    else if (x === "--no-critics") a.critics = false;
    else if (x === "--no-table") a.table = false;
    else if (x === "--fresh") a.fresh = true;
    else if (x === "--workspace") a.workspace = value();
    else if (x === "--tape") a.tape = value();
    else if (x === "--engine-ref") a.engineRef = value();
    else if (x === "--despite-stall") a.despiteStall = value();
    else if (x === "--despite-ceiling") a.despiteCeiling = value();
    else if (x === "--live-round" || x === "--tape-round") {
      const n = value();
      if (!/^\d+$/.test(n)) usage(`${x} needs a round number, not ${n}`);
      a[x === "--live-round" ? "liveRound" : "tapeRound"] = Number(n);
    } else if (x === "--runs") a.runs = value();
    else if (x === "--json" && (cmd === "hunt" || cmd === "people-hunt")) a.json = true;
    else if (x === "--dispatch" && cmd === "start") {
      a.dispatch = value();
      if (a.dispatch !== "climayte") usage(`--dispatch takes climayte (AgentHydra's CliMayte), not ${a.dispatch}`);
    } else if (cmd === "mark" && !a.step) a.step = x;
    else if (cmd === "mark" && !a.event) a.event = x;
    else usage(`unknown: ${x}`);
  }
  if (!["start", "report", "table", "times", "hunt", "people-hunt", "mark", "trend", "agree"].includes(cmd))
    usage(cmd ? `unknown command ${cmd}` : "");
  if (!a.plan) usage("--plan <plan.json> is required: the product's round plan (who goes, where, the target)");
  return a;
}

/** The plan, its paths made absolute, and where this round's state lives. */
export function loadPlan(file, { workspace = null } = {}) {
  const abs = path.resolve(file);
  const plan = JSON.parse(readFileSync(abs, "utf8"));
  const root = plan.root ? path.resolve(path.dirname(abs), plan.root) : null;
  return {
    ...plan,
    file: abs,
    root,
    workspace: workspace || process.env.SUE_WORKSPACE || plan.workspace || "D:/NEWProjects",
    state: path.join(root || path.dirname(abs), "tmp", "sue-round"),
  };
}

const seatUrl = (plan, seat) => (/^https?:\/\//.test(seat) ? seat : `${plan.demo || ""}${seat}`);
const intentFor = (plan, lang = "en", own = null) =>
  own || (typeof plan.intent === "string" ? plan.intent : plan.intent?.[lang] || plan.intent?.en);
/** What the page is meant to be, in this run's language: the run's own, else the plan's ({en, es} or one string); "" when none. */
const expectFor = (plan, lang = "en", own = null) =>
  own || (typeof plan.expect === "string" ? plan.expect : plan.expect?.[lang] || plan.expect?.en) || "";
const kindOf = (r) => (r.teachers ? "teachers" : r.focus ? "focus" : "people");

function sue(action, args, workspace) {
  // One process per call, one after another: six started in the same second left three without a run folder
  // (Lift, 2026-10-01).
  return new Promise((resolve) => {
    const argsFile = path.join(RUNS, `round-args-${process.pid}-${Math.random().toString(36).slice(2, 8)}.json`);
    mkdirSync(RUNS, { recursive: true });
    writeFileSync(argsFile, JSON.stringify(args));
    const child = spawn(process.execPath, [SUE, action, "--workspace", workspace, "--json-file", argsFile], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", (code) => {
      rmSync(argsFile, { force: true });
      const at = out.indexOf("{");
      try {
        resolve(JSON.parse(out.slice(at)));
      } catch {
        resolve({ ok: false, error: (err || out).trim().slice(0, 400) || `exit ${code}` });
      }
    });
  });
}

async function resetDemo(plan) {
  if (!plan.reset) return null;
  const res = await fetch(plan.reset, {
    method: "POST",
    redirect: "manual",
    headers: { origin: new URL(plan.reset).origin, "content-type": "application/x-www-form-urlencoded" },
    body: "",
  });
  if (res.status >= 400) throw new Error(`the demo did not reset (HTTP ${res.status} from ${plan.reset})`);
  return res.status;
}

/** Why a run that ended without a brief list says it ended (a refused cannon names itself), or null while it still runs. */
function endedWhy(runId) {
  const st = readJson(runStatusFile(runId));
  if (!st || !["refused", "failed", "finished", "finished-with-errors", "stopped"].includes(st.state)) return null;
  const why = [].concat(st.why || []).join("; ");
  return why || `the run ${st.state} before it wrote its briefs${st.cannonExit != null ? ` (cannon exit ${st.cannonExit})` : ""}`;
}

/** The brief list of one run, or `{ error }` when the run ended without writing one (waiting on it is pointless). */
async function briefsOf(chatBrains, runId) {
  // The runner writes the list a moment after the run starts: wait for it to parse, not only to exist.
  const polls = Math.max(1, Math.round((Number(process.env.SUE_BRIEFS_WAIT_MS) || 30000) / 500));
  for (let i = 0; i < polls; i += 1) {
    try {
      const list = JSON.parse(readFileSync(chatBrains, "utf8"));
      return {
        briefs: (Array.isArray(list) ? list : list.sues || []).map((b) => ({
          id: b.sueId || b.id,
          role: b.role,
          persona: b.persona,
          brief: b.brief,
          // CliMayte can launch her: a sealed launch (her system prompt and hands), or a moderator's brief.
          climayte: Boolean(b.sealed) || b.role === "moderator",
        })),
      };
    } catch {
      const error = endedWhy(runId);
      if (error) return { error };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { briefs: [] };
}

/** What a round sends: one run per user (or one room per focus group, or the teachers), and one run per critic.
 *  In reference mode, use the plan's reference config (students only, no critics). */
export function roundRuns(plan, { focus = false, room = null, teachers = false, critics = true, reference = false } = {}) {
  if (reference) {
    const ref = plan.reference || {};
    if (!ref.url) throw new Error("reference mode needs plan.reference.url");
    if (!ref.series) throw new Error("reference mode needs plan.reference.series (the series its rounds are kept in)");
    const people = plan.students || plan.people || [];
    if (!people.length) throw new Error("the plan has no students (students: [{persona, seat}])");
    return people.map((s) => ({
      name: s.persona,
      personas: [s.persona],
      url: ref.url,
      lang: s.lang || "en",
      room: false,
      intent: ref.intent,
      expect: ref.expect,
    }));
  }
  if (teachers) {
    const t = plan.teachers || {};
    if (!t.personas?.length) throw new Error("the plan has no teachers (teachers.personas)");
    return [
      {
        name: "teachers",
        personas: t.personas,
        url: seatUrl(plan, t.seat || ""),
        lang: "en",
        room: false,
        intent: t.intent,
        expect: t.expect,
        teachers: true,
      },
    ];
  }
  if (focus) {
    const rooms = (plan.rooms || []).filter((r) => !room || r.key === room || r.name === room);
    if (!rooms.length) throw new Error(`no room "${room}"; the rooms are ${(plan.rooms || []).map((r) => r.key).join(", ") || "none"}`);
    return rooms.map((r) => ({
      name: r.name,
      personas: r.personas,
      url: seatUrl(plan, r.seat),
      lang: r.lang || "en",
      room: r.personas.length > 1,
      focus: true,
    }));
  }
  const people = plan.students || plan.people || [];
  if (!people.length) throw new Error("the plan has no students (students: [{persona, seat}])");
  const out = people.map((s) => ({
    name: s.persona,
    personas: [s.persona],
    url: seatUrl(plan, s.seat),
    lang: s.lang || "en",
    room: false,
  }));
  if (critics)
    for (const c of plan.critics || [])
      out.push({ name: c.persona, personas: [c.persona], url: seatUrl(plan, c.seat), lang: c.lang || "en", room: false, critic: true });
  return out;
}

const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};

/** The recorded tape a round runs on: the flag wins over the plan's own `tape`. Null is the live site. */
export const tapeOf = (plan, opts = {}) => opts.tape || plan.tape || null;

/** The series a started round is kept in. A tape round is a measurement of the tape, never a product round, so it
 *  keeps its own "<series>-tape" and cannot move the live series' trend or target; a round on an older engine
 *  (--engine-ref) measures SUE, so it adds "-engine". */
export function startedSeries(plan, opts = {}) {
  const base = opts.reference ? plan.reference.series : plan.series;
  return `${tapeOf(plan, opts) ? `${base}-tape` : base}${opts.engineRef ? "-engine" : ""}`;
}

/** The file a round's state is saved in, one per kind so a live round, its tape twin and a reference round can run side
 *  by side without overwriting each other: last.json (live), last-tape.json (tape), last-reference.json (reference),
 *  each with "-engine-<ref>" before ".json" for a round on a pinned engine (--engine-ref). The ref is in the name so the
 *  two arms of an A/B, pinned at <sha>~1 and <sha>, run from one plan at the same time: one "-engine" file had the
 *  second arm's start overwrite the first's state (Raise Buddy, 2026-10-12; each arm then needed its own plan copy). */
export function stateFileOf(plan, opts = {}) {
  const kind = opts.reference ? "-reference" : tapeOf(plan, opts) ? "-tape" : "";
  const engine = opts.engineRef ? `-engine-${String(opts.engineRef).replace(/[^A-Za-z0-9]+/g, "-")}` : "";
  return path.join(plan.state, `last${kind}${engine}.json`);
}

/** The flags a later command needs to find the state its `start` saved. */
const stateFlagsOf = (plan, opts = {}) =>
  `${opts.reference ? " --reference" : tapeOf(plan, opts) ? ` --tape ${tapeOf(plan, opts)}` : ""}${opts.engineRef ? ` --engine-ref ${opts.engineRef}` : ""}`;

/** Does a started round reset the plan's live demo? Not a reference round, and not a tape round (the tape never uses it). */
export const resetsDemo = (opts, tape) => !opts.reference && !tape;

/**
 * What identity reuse finds for a start: `{ identity: Promise<{ builds, at } | null>, parts: [parts per run], found: [the
 * fresh visit each run can reuse, or null], ms, why }`. A plan with no `reuse` block finds nothing and says nothing; a
 * round that cannot reuse says why in one line (`NO REUSE: ...`). `--fresh` reuses no visit but still records the
 * round's identity and parts: the A/B reads a visit only through them, and its verdict needs a second round of each
 * arm, which is a `--fresh` one (SUE rounds 10 and 11 of lift-v2, 2026-10-04: the fresh round 11 recorded none).
 */
async function reuseFor(
  plan,
  opts,
  runs,
  tape,
  { fetchFn, door, engineId, handsEntry, runsDir, warm = warmDoor, openDoor = openPeopleDoor },
) {
  const none = { identity: Promise.resolve(null), parts: [], found: runs.map(() => null), ms: null, why: null };
  if (!plan.reuse) return none;
  const rows = readRounds(plan.workspace, seriesKey(startedSeries(plan, opts), kindOf(opts)));
  const got = await findReuse(plan, runs, rows, runsDir, {
    argsFor: (r) =>
      argsOf(r, {
        intent: intentFor(plan, r.lang, r.intent),
        interview: plan.interview,
        tape,
        expect: expectFor(plan, r.lang, r.expect),
        createAccounts: plan.createAccounts,
      }),
    fetchFn,
    door,
    openDoor: () => openDoor({ root: plan.workspace }),
    // The warm holder (people-door.mjs). Its kept-alive HEADs only stand in for this process's own when it would use the
    // real fetch: a spec that injects one is asking about its own world.
    warm: async () => {
      const w = await warm({ root: plan.workspace });
      return w && fetchFn !== globalThis.fetch ? { door: w.door } : w;
    },
    engineId,
    handsEntry,
    // Only the default engine id may be answered by the holder; a spec's injected one is its own world.
    engineSpec: engineId === currentEngineId ? { checkout: CHECKOUT } : null,
  });
  const at = new Date().toISOString();
  // Already in flight since the first line of the check: by the time a fresh round saves its state this has long answered.
  const identity = got.buildsP.then((b) => (b.builds ? { builds: b.builds, at } : null));
  if (opts.fresh)
    return { identity, parts: got.parts, found: runs.map(() => null), ms: got.ms, why: got.why ?? "--fresh asked to measure again" };
  return { identity, parts: got.parts, found: got.found, ms: got.ms, why: got.why };
}

/** `(612 ms: builds 401, people 0, engine 180)` - the elapsed time and where it went. */
const tookOf = (t0, ms) =>
  `(${Date.now() - t0} ms${ms ? `: builds ${ms.builds}, people ${ms.people}${ms.via ? ` ${ms.via}` : ""}, engine ${ms.engine}, hands ${ms.hands}` : ""})`;

/** The real holder only for the real runner: a spec's injected `run` is a world of its own and must start no process. */
const holderFor = (run, holder) => holder ?? (run === sue ? ensureHolder : null);

/** sha256 of the plan's canonical JSON (keys sorted; the file path is where it lives, not what it says). */
export function planHashOf(plan) {
  const canon = (v) =>
    Array.isArray(v)
      ? v.map(canon)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, canon(v[k])]),
          )
        : v;
  const { file: _file, ...rest } = plan || {};
  return createHash("sha256")
    .update(JSON.stringify(canon(rest)))
    .digest("hex");
}

export async function start(
  plan,
  opts,
  {
    run = sue,
    fetch: fetchFn = globalThis.fetch,
    people: door,
    engineId = currentEngineId,
    runsDir = RUNS,
    warm,
    openDoor,
    holder,
    stageAt = stageEngineAt,
    climayte: probeClimayte = climayteReady,
  } = {},
) {
  const t0 = Date.now();
  let runs;
  try {
    runs = roundRuns(plan, opts);
  } catch (err) {
    console.log(err.message);
    process.exit(2);
  }
  const userRound = !opts.teachers && !opts.focus;
  const tape = tapeOf(plan, opts);

  // Check if the series is stuck (under target with N rounds since best) - skip in reference mode, on a tape and on an
  // older engine, whose rounds are not in the live series.
  if (userRound && !opts.reference && !tape && !opts.engineRef) {
    const key = seriesKey(plan.series, "people");
    const target = targetOf(plan, plan.workspace);
    const rows = readRounds(plan.workspace, key);
    const t = trend(rows, target, { referenceAt: referenceAtOf(plan, plan.workspace) });
    if (t.state === "ceiling") {
      console.log(`AT CEILING: ${t.why}`);
      const was = rows.at(-1)?.ceilingId || {};
      const now = plan.reuse ? await fetchBuilds(plan.reuse.builds, fetchFn) : {};
      const lifted =
        now.builds && was.builds && JSON.stringify(now.builds) !== JSON.stringify(was.builds)
          ? "the build changed"
          : was.planHash !== planHashOf(plan)
            ? "the plan changed"
            : null;
      if (lifted) console.log(`AT CEILING lifted: ${lifted}`);
      else if (opts.despiteCeiling) console.log(`AT CEILING overridden: ${opts.despiteCeiling}`);
      else {
        console.log(
          "The series is over: ship the best build, or change the page (a new build) or the plan before another round. Nothing started.",
        );
        console.log(`To override, use: --despite-ceiling "<reason>"`);
        process.exit(1);
      }
    }
    if (t.state === "stuck") {
      console.log(`STUCK: the series has ${t.roundsSinceBest} round(s) since its best with no improvement.`);
      if (!opts.despiteStall) {
        console.log(
          `Run the ceiling check (does this panel give a 5 to a product kids love?) and planted-bug check (does the panel notice deliberate defects?) before more rounds.`,
        );
        console.log(`To override, use: --despite-stall "<reason>"`);
        process.exit(1);
      }
    }
  }

  if (userRound && opts.critics && !(plan.critics || []).length && !opts.reference)
    console.log(
      `NO CRITICS IN THIS PLAN: the round sends users only. Experts walk the same path and say where attention breaks and why; add ${DEFAULT_CRITICS.join(" and ")} to the plan's "critics", each with a seat of its own.\n`,
    );
  // Sue's code at the git ref, staged once: its id labels every visit of the round, and its commit (not the ref, which
  // moves) is what each run is handed to.
  let pinned = null;
  if (opts.engineRef) {
    try {
      pinned = stageAt(opts.engineRef);
    } catch (err) {
      console.log(`ENGINE REFUSED: ${err?.message ?? err}`);
      process.exit(2);
    }
    console.log(`ENGINE ${opts.engineRef} = ${pinned.commit}: ${pinned.id}${pinned.reused ? " (already staged)" : ""}`);
  }
  const reuse = await reuseFor(plan, opts, runs, tape, {
    fetchFn,
    door,
    engineId: pinned ? () => pinned.id : engineId,
    // Her hands are the staged engine's own hands-mcp.mjs (cannon.mjs HANDS_MCP), so those files are her hands part: an
    // edit in this checkout no longer splits a pinned arm from one started before it (lift-v2-engine round 20).
    handsEntry: pinned ? path.join(pinned.root, "sue", "hands-mcp.mjs") : undefined,
    runsDir,
    warm,
    openDoor,
  });
  const { found, ms } = reuse;
  // This start opened a door itself: leave a warm one behind for the next (detached, hidden, nothing waits for it).
  if (ms?.via === "cold") await holderFor(run, holder)?.({ root: plan.workspace });
  if (reuse.why) console.log(`NO REUSE: ${reuse.why}; every student is sent fresh. ${tookOf(t0, ms)}`);
  const compared = "same engine, driver, hands, persona docs, brief and live build ids";
  if (found.every(Boolean)) {
    const last = Math.max(...found.map((f) => Number(f.round) || 0));
    console.log(
      `NOTHING CHANGED: every student's visit is the same as round ${last} (${compared}), so round ${last} stands. Use --fresh to measure again. ${tookOf(t0, ms)}`,
    );
    return;
  }
  // Every Sue goes to CliMayte sealed (Owner, 2026-10-06): asked once, before anything starts, so a round told to send
  // them itself never starts students nobody will drive.
  const climayte = await probeClimayte();
  if (opts.dispatch === "climayte" && !climayte.ready) {
    console.log(
      `--dispatch climayte needs AgentHydra's CliMayte, and ${climayte.why}: start AgentHydra, or leave --dispatch out. Nothing was started.`,
    );
    process.exit(2);
  }
  const reuseAt = new Date().toISOString();
  for (const [i, f] of found.entries()) if (f) console.log(`  ${runs[i].name}: reused from round ${f.round} (${compared})`);
  const resetAt = new Date().toISOString();
  // A reference round and a tape round never touch the live demo (a tape answers its students from the recording), so
  // neither resets it: a reset would wipe a live student's progress in a live round running beside the tape.
  const status = resetsDemo(opts, tape) ? await resetDemo(plan) : null;

  // Create the runs directory once before the concurrent wave to avoid mkdirSync race.
  mkdirSync(RUNS, { recursive: true });

  // Start runs concurrently, bounded by SUE_START_PARALLEL (default 4), keeping started[] in plan order.
  const SUE_START_PARALLEL = Math.max(1, Math.floor(Number(process.env.SUE_START_PARALLEL)) || 4);
  const started = [];

  // Execute each run with bounded concurrency using a semaphore-like queue.
  const active = new Set();
  for (let i = 0; i < runs.length; i += 1) {
    if (found[i]) {
      started[i] = { ...runs[i], runId: found[i].runId, error: null, chatBrains: null, reused: { round: found[i].id, at: reuseAt } };
      continue;
    }
    const p = (async () => {
      try {
        const r = await run(
          runs[i].room ? "focus_group" : "run",
          {
            count: runs[i].personas.length,
            brain: "chat",
            url: runs[i].url,
            intent: intentFor(plan, runs[i].lang, runs[i].intent),
            ...(expectFor(plan, runs[i].lang, runs[i].expect) ? { expect: expectFor(plan, runs[i].lang, runs[i].expect) } : {}),
            personas: runs[i].personas,
            // Only a plan's no: a round whose visitors make no account needs no mailroom (the run's own default stands otherwise).
            ...(plan.createAccounts === false ? { createAccounts: false } : {}),
            // The round's table is its hearing (table() below): its runs do not each hand themselves to another.
            hearing: false,
            // A recorded tape instead of the live site: the flag wins over the plan's own `tape`.
            ...(tape ? { tape } : {}),
            ...(plan.interview && !runs[i].critic ? { interview: plan.interview } : {}),
            ...(runs[i].room ? { suggestions: plan.suggestions || [] } : {}),
            ...(pinned ? { engineRef: pinned.commit } : {}),
            ...(opts.dispatch ? { dispatch: opts.dispatch } : {}),
          },
          plan.workspace,
        );
        // A wave planned by any engine but the staged one is no visit of this arm, whatever it measured.
        const stray = pinned && r.runId && r.engine?.id !== pinned.id;
        started[i] = {
          ...runs[i],
          runId: stray ? null : r.runId,
          error: stray
            ? `its wave answered from engine ${r.engine?.id ?? "(none named)"}, not the staged ${pinned.id}: run ${r.runId} is not counted in this arm`
            : r.runId
              ? null
              : r.error || r.refused || JSON.stringify(r).slice(0, 300),
          chatBrains: stray ? null : r.chatBrains,
          // The run's own word that SUE sends its Sues: an engine older than the dispatcher never says it.
          dispatched: !stray && r.dispatch === "climayte",
        };
      } catch (e) {
        started[i] = { ...runs[i], runId: null, error: String(e), chatBrains: null };
      } finally {
        active.delete(p);
      }
    })();

    active.add(p);
    if (active.size >= SUE_START_PARALLEL) {
      await Promise.race(active);
    }
  }
  await Promise.all(active);
  // The run ids are saved before anything else can fail, so report and times always find this round.
  const identity = await reuse.identity;
  const state = {
    plan: plan.file,
    series: startedSeries(plan, opts),
    tape,
    kind: opts.teachers ? "teachers" : opts.focus ? "focus" : "people",
    resetAt,
    startedAt: new Date().toISOString(),
    focus: opts.focus,
    teachers: opts.teachers,
    reference: opts.reference || null,
    despiteStall: opts.despiteStall || null,
    ...(pinned ? { engine: { ref: opts.engineRef, commit: pinned.commit, id: pinned.id } } : {}),
    planHash: planHashOf(plan),
    ...(identity ? { identity } : {}),
    runs: started.map((r, i) => ({
      name: r.name,
      runId: r.runId,
      room: r.room,
      critic: Boolean(r.critic),
      url: r.url,
      error: r.error,
      ...(r.dispatched ? { dispatch: "climayte" } : {}),
      briefs: [],
      ...(identity && reuse.parts[i] ? { inputs: inputsHash(reuse.parts[i]), parts: reuse.parts[i] } : {}),
      ...(r.reused ? { reused: r.reused } : {}),
    })),
  };
  mkdirSync(plan.state, { recursive: true });
  const stateFile = stateFileOf(plan, opts);
  // A stopwatch mark made while the briefs were still being read lands in the state file: the rewrite keeps it.
  const write = () => {
    const onDisk = readJson(stateFile);
    if (onDisk?.resetAt === resetAt) state.marks = mergeMarks(onDisk.marks, state.marks);
    writeFileSync(stateFile, JSON.stringify(state, null, 2));
  };
  write();
  // Side by side: a run whose runner already ended (a refused cannon) stops being waited on and carries its reason.
  await Promise.all(
    started.map(async (r, i) => {
      if (!r.chatBrains) return;
      const got = await briefsOf(r.chatBrains, r.runId);
      if (got.error) {
        state.runs[i].runId = null;
        state.runs[i].error = got.error;
      } else state.runs[i].briefs = got.briefs;
    }),
  );
  write();
  console.log(
    `${status ? `demo reset (HTTP ${status}) at ${resetAt.slice(11, 19)}Z; ` : ""}${state.runs.filter((r) => r.runId && !r.reused).length} of ${state.runs.filter((r) => !r.reused).length} runs started in ${((Date.now() - Date.parse(resetAt)) / 1000).toFixed(1)} s`,
  );
  for (const r of state.runs) if (r.error) console.log(`  FAILED ${r.name}: ${r.error}`);
  for (const line of driversText(state.runs, climayte)) console.log(line);
  console.log(`\nWhen they are done: node sue/round.mjs report --plan ${plan.file}${stateFlagsOf(plan, opts)}`);
}

/**
 * What the caller does to drive a started round's Sues, as lines. Every Sue is ONE sealed CliMayte task (the owner,
 * 2026-10-06): a run SUE already sends (`dispatch: "climayte"`) needs nothing; while CliMayte is ready (`climayte`, the
 * start's one probe) each other run is one dispatch.mjs command; only a Sue CliMayte cannot launch (CliMayte down, or an
 * engine that wrote no sealed launch) is printed for the old brief-reading sue-driver agent.
 */
export function driversText(runs, climayte) {
  const lines = [];
  const label = (b) => (b.role === "moderator" ? "moderator" : `${b.persona}${b.critic ? " (critic)" : ""}`);
  const withCritic = (r) => r.briefs.map((b) => ({ ...b, critic: r.critic }));
  const sent = runs.filter((r) => r.dispatch === "climayte" && r.briefs.length);
  if (sent.length)
    lines.push(
      `\nSUE is sending ${sent.reduce((n, r) => n + r.briefs.length, 0)} Sues to CliMayte itself, each as ONE sealed task as she arrives: start NO agent for them. climayte_status { group } shows them (${sent.map((r) => `${r.name}: ${climayteGroup(r.runId)}`).join(", ")}).`,
    );
  const left = runs.filter((r) => r.dispatch !== "climayte" && r.briefs.length);
  const sealed = climayte?.ready ? left.filter((r) => r.briefs.some((b) => b.climayte)) : [];
  if (sealed.length) {
    lines.push(
      `\nSend each Sue to CliMayte as ONE sealed task, never as an agent of your own: her brain holds her system prompt and her hands and nothing else (6,000 tokens before her first move, against 38,700 for a brief-reading agent). One command per run hands it to SUE, which sends every Sue now and each later one as she arrives:`,
    );
    for (const r of sealed)
      lines.push(
        `  node ${DISPATCH_CLI} ${r.runId}    (${r.name}: ${withCritic(r)
          .filter((b) => b.climayte)
          .map(label)
          .join(", ")})`,
      );
    lines.push(
      `Or send them yourself (\`node ${DISPATCH_CLI} <runId> --print\` prints a run's exact group and tasks): ${climayteRunCall({ runId: sealed[0].runId, chatBrains: "the run's chat-brains.json" })}.`,
    );
  }
  const old = left.flatMap((r) => withCritic(r).filter((b) => !(climayte?.ready && b.climayte)));
  if (old.length) {
    const why = climayte?.ready
      ? `${old.length} of them have no sealed launch (their engine predates it), so they are driven the old way.`
      : `CliMayte is unavailable (${climayte?.why ?? "not asked"}), so these Sues are driven the old way.`;
    lines.push(
      `\n${why} Start ${old.length} drivers ALL IN ONE MESSAGE with the Agent tool (subagent_type sue-driver, model sonnet, background). Each prompt:`,
      `  Read your brief file whole, to its last line, before your first move (a brief too long for one Read is read in parts, with offset and limit, until nothing is left), then do what it says: <brief>\n\n  ${REASON}\n`,
      ...old.map((b) => `  ${label(b).padEnd(28)} ${b.brief}`),
    );
  }
  return lines;
}

const readState = (plan, opts = {}) => {
  try {
    return JSON.parse(readFileSync(stateFileOf(plan, opts), "utf8"));
  } catch {
    console.log(`no round yet: node sue/round.mjs start --plan ${plan.file}${stateFlagsOf(plan, opts)}`);
    process.exit(1);
  }
};

/** The series key a saved round is kept under: the series and kind `start` saved, never the plan's (a plan moved on to a
 *  new series must not take a round of the old one as its own). */
function savedRound(plan, state, opts = {}) {
  if (!state.series) {
    console.log(`the saved round (${stateFileOf(plan, opts)}) names no series; start a new round`);
    process.exit(1);
  }
  const kind = state.kind || kindOf(state);
  return { kind, key: seriesKey(state.series, kind) };
}

/** The rounds a saved round's trend is read against: an arm pinned to an engine, only that engine's. Both arms of an A/B
 *  keep their rounds in one "<series>-engine", and the other arm's measure other code (2026-10-07: the low-effort arm's
 *  ROUND line was the default arm's newer round, 2 of 4 finished, while none of its own 4 Sues had finished). */
function ownRounds(plan, key, state) {
  const rows = readRounds(plan.workspace, key);
  return state.engine ? rows.filter((r) => r.engine?.id === state.engine.id) : rows;
}

/** The plan a round is scored on: a reference round's finishers are the ones who reached the reference's own end. */
export function scoringPlan(plan, state) {
  if (!state.reference) return plan;
  const ref = plan.reference || {};
  return { ...plan, doneWhen: ref.doneWhen || [], progress: ref.progress || null };
}

/**
 * One Sue's visit, from her own files: her stars, whether a screen she saw shows the plan's `doneWhen` (she finished),
 * the furthest `progress` mark she saw ("Part 2 of 4"), why she stopped, and a critic's drops. Pure over `dir`'s files.
 */
export function visitOf(dir, plan) {
  const trace = traceOf(dir);
  const iv = readJson(path.join(dir, "interview.json")) || {};
  // Her visit is over once the relay wrote its summary, interview or not: a brain that went quiet before the exit
  // interview (outcome "no-interview") leaves her unrated, never a round that waits for her stars.
  const ended = Boolean(readJson(path.join(dir, "summary.json"))?.endedAt);
  // A Sue who never looked at the page (interview `unseen`) gave no rating of it.
  const stars = iv.unseen ? NaN : Number(iv.starsOutOfFive);
  const screens = trace.filter((t) => t.tool === "look").map((t) => String(t.pageText ?? t.result ?? ""));
  const done = (plan.doneWhen || []).map((d) => String(d).toLowerCase());
  const finished = done.length > 0 && screens.some((s) => done.some((d) => s.toLowerCase().includes(d)));
  let reached = null;
  if (plan.progress) {
    const rx = new RegExp(plan.progress, "gi");
    for (const s of screens)
      for (const m of s.matchAll(rx)) {
        const nums = m
          .slice(1)
          .filter((x) => x !== undefined)
          .map(Number);
        if (nums.length >= 2 && (!reached || nums[0] > reached.at)) reached = { at: nums[0], of: nums[1] };
      }
  }
  const findings = (() => {
    try {
      return readFileSync(path.join(dir, "findings.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  })();
  const drops = findings
    .filter((f) => /drop/i.test(String(f.kind || "")))
    .map((f) => ({ severity: Number(f.severity) || null, text: String(f.text || f.said || "").slice(0, 400), url: f.url || null }))
    .sort((a, b) => (b.severity || 0) - (a.severity || 0));
  return {
    sueId: path.basename(dir),
    who: path.basename(dir).replace(/^sue-\d+-/, ""),
    moves: trace.filter((t) => t.tool).length,
    interviewed: Number.isFinite(Number(iv.starsOutOfFive)),
    ended,
    unseen: Boolean(iv.unseen),
    stars: Number.isFinite(stars) && stars >= 1 && stars <= 5 ? Math.round(stars) : null,
    finished,
    reached,
    whyStopped: iv.whyStopped || null,
    mostConfusing: iv.mostConfusing || null,
    drops: drops.slice(0, 6),
  };
}

/** The round's row: its users' stars (never a critic's), who finished, how far each got, and the critics' drops. */
export function roundRow(state, visits, plan) {
  const users = visits.filter((v) => !v.critic);
  const rated = users.filter((v) => v.stars !== null);
  const stars = rated.length ? Math.round((rated.reduce((a, v) => a + v.stars, 0) / rated.length) * 100) / 100 : null;
  const reachedHist = {};
  for (const v of users) {
    // How far a person got is said only when the plan can measure it (its progress marks); otherwise "did not finish",
    // never a part number the screens no longer show (Lift dropped its part counter, 2026-10-01).
    const key = v.finished ? "finished" : v.reached ? `stopped in part ${v.reached.at} of ${v.reached.of}` : "did not finish";
    reachedHist[key] = (reachedHist[key] || 0) + 1;
  }
  return {
    id: state.resetAt,
    at: state.resetAt,
    series: state.series,
    kind: state.kind,
    plan: plan.file,
    runIds: state.runs.filter((r) => r.runId).map((r) => r.runId),
    people: users.length,
    stars,
    finished: users.filter((v) => v.finished).length,
    reached: reachedHist,
    each: users.map((v) => ({
      who: v.who,
      stars: v.stars,
      finished: v.finished,
      reached: v.reached,
      whyStopped: v.whyStopped,
      ...(!v.interviewed && v.ended ? { noInterview: true } : {}),
    })),
    critics: visits.filter((v) => v.critic).map((v) => ({ who: v.who, stars: v.stars, drops: v.drops })),
    complete: users.every((v) => v.interviewed || v.ended),
    // Who stood on an earlier round's fresh visit, and how many runs this round really sent: a reused round can break
    // a streak but never extend one (lib/rounds.mjs trend).
    reused: state.runs.filter((r) => r.reused).map((r) => r.name),
    fresh: state.runs.filter((r) => r.runId && !r.reused).length,
    despiteStall: state.despiteStall || null,
    // A round on Sue's code at a git ref names it, so an A/B between two such rounds names the commits between them.
    ...(state.engine ? { engine: state.engine } : {}),
  };
}

function visitsOf(state, plan, runsDir = RUNS) {
  const out = [];
  for (const r of state.runs.filter((x) => x.runId)) {
    const dir = path.join(runsDir, r.runId);
    if (!existsSync(dir)) continue;
    for (const s of readdirSync(dir).filter((d) => d.startsWith("sue-")))
      out.push({ ...visitOf(path.join(dir, s), plan), critic: r.critic, run: r.name });
  }
  return out;
}

const clip = (s, n = 220) => (String(s ?? "").length > n ? `${String(s).slice(0, n - 1)}…` : String(s ?? ""));

/** What a reference round's report says: its stars, and whether they are now the main series' bar. */
export function referenceLines(plan, row, target) {
  const lines = [`REFERENCE ${row.series}: ${row.stars} stars, ${row.finished} of ${row.people} finished (round ${row.round})`];
  if (target.reference && target.starsVs === row.series)
    lines.push(
      `NEW BAR   ${plan.series} is now held to ${target.stars} stars (the reference's ${target.reference.stars} minus ${target.reference.within})`,
    );
  else
    lines.push(
      `NO BAR    the plan's target.starsVs does not name ${row.series}, so ${plan.series} keeps its fixed bar of ${target.stars} stars`,
    );
  return lines;
}

/**
 * A start that found something cheaper already changed fetched no people, so its fresh visits carry no docs part yet:
 * fetch them once here (in process, one list call) so those visits can be reused later. Never throws.
 */
async function recordDocs(plan, state, door) {
  if (!state.runs.some((r) => r.parts?.docs === null && r.runId && !r.reused)) return;
  let opened = null;
  try {
    opened = door ? { door, close: async () => {} } : await openPeopleDoor({ root: plan.workspace });
    await fillDocs(state, opened.door);
  } catch {
    // The docs stay empty: those visits are simply never matched.
  } finally {
    await opened?.close();
  }
}

export async function report(
  plan,
  opts = {},
  { run = sue, runsDir = RUNS, startTable = table, fetch: fetchFn = globalThis.fetch, people: door = null, holder } = {},
) {
  const commits = decisionCommitsAsync(checkoutRoot());
  const state = readState(plan, opts);
  const { kind, key } = savedRound(plan, state, opts);
  const scored = scoringPlan(plan, state);
  const priorRows = readRounds(plan.workspace, key);
  const reusedFrom = new Map(
    state.runs
      .filter((r) => r.reused)
      .map((r) => [r.name, `(reused from round ${priorRows.find((x) => x.id === r.reused.round)?.round ?? "?"})`]),
  );
  for (const r of state.runs.filter((x) => !x.runId)) console.log(`\n## ${r.name}: did not start (${clip(r.error, 200)})`);
  const reports = await Promise.all(
    state.runs
      .filter((r) => r.runId)
      .map(async (r) => ({
        r,
        rep: await run("report", { runId: r.runId }, plan.workspace),
        room: r.room ? await run("room", { runId: r.runId }, plan.workspace) : null,
      })),
  );
  for (const { r, rep, room } of reports) {
    if (!rep.ok) {
      console.log(`\n## ${r.name}${r.critic ? " (critic)" : ""}: no report (${clip(rep.error, 200)})`);
      continue;
    }
    console.log(
      `\n## ${r.name}${r.critic ? " (critic)" : ""}${reusedFrom.has(r.name) ? ` ${reusedFrom.get(r.name)}` : ""}: ${rep.verdict?.averageStars ?? rep.averageStars ?? "?"} stars${rep.complete ? "" : " (still running)"}`,
    );
    for (const w of rep.whyTheyStopped || [])
      console.log(`  stopped (${w.sueId.replace(/^sue-\d+-/, "")}): ${clip(w.said, 400)}  [${w.threeWords}]`);
    for (const w of rep.theirWords || []) console.log(`  - ${w.sueId.replace(/^sue-\d+-/, "")}: ${clip(w.said)}`);
    if (room?.verdict)
      console.log(
        `  ROOM VERDICT: ${clip(room.verdict.problem, 400)} (agreed ${room.verdict.agreedBy?.length ?? 0} of ${room.verdict.size ?? "?"}, by ${room.verdict.decidedBy})\n  ${clip(room.verdict.summary, 600)}`,
      );
    else if (room) console.log(`  room: ${room.phase || "no verdict yet"}`);
  }
  const visits = visitsOf(state, scored, runsDir);
  const row = roundRow({ ...state, kind }, visits, scored);
  for (const c of row.critics)
    for (const d of c.drops.slice(0, 3)) console.log(`  CRITIC ${c.who}: drop${d.severity ? ` ${d.severity}` : ""} - ${clip(d.text, 300)}`);
  console.log("\n# The round");
  for (const e of row.each)
    console.log(
      `  ${e.who.padEnd(22)} ${e.stars ?? "-"} stars  ${e.finished ? "FINISHED" : e.reached ? `stopped in part ${e.reached.at} of ${e.reached.of}` : "did not finish"}${e.noInterview ? "  (her visit ended without an exit interview)" : ""}${reusedFrom.has(e.who) ? `  ${reusedFrom.get(e.who)}` : ""}`,
    );
  if (!(scored.doneWhen || []).length) console.log("  (the plan names no doneWhen text, so nobody can be counted as finished)");
  if (!row.complete) {
    console.log(
      `\nSTILL RUNNING: ${row.each.filter((e) => e.stars === null).length} of ${row.people} have not given their stars; the round is recorded when they have.`,
    );
    if (!state.reference) {
      const target = targetOf(plan, plan.workspace);
      const t = trend(ownRounds(plan, key, state), target, { referenceAt: referenceAtOf(plan, plan.workspace) });
      console.log(renderTrend(t, target, { tape: Boolean(state.tape) }).join("\n"));
      await printHunt(plan, { kind, series: state.series }, runsDir, commits);
    }
    return;
  }
  const prior = readRounds(plan.workspace, key).find((r) => r.id === row.id);
  // The marks made so far (kept in the saved state) go in with every report; writeRound keeps the row's own.
  // What identifies the build and the plan this round measured: `start` compares it when the series is AT CEILING.
  const ceilingId = {
    ...(state.identity?.builds ? { builds: state.identity.builds } : {}),
    ...(state.planHash ? { planHash: state.planHash } : {}),
  };
  const saved = writeRound(plan.workspace, key, {
    ...row,
    marks: state.marks || [],
    table: prior?.table || null,
    ...(ceilingId.planHash ? { ceilingId } : {}),
  });
  // The visits of this round become reusable only if the sites did not change while it ran: a visit of a half-old,
  // half-new build is no fresh measurement of either.
  if (state.identity && plan.reuse) {
    const now = await fetchBuilds(plan.reuse.builds, fetchFn);
    if (now.builds && JSON.stringify(now.builds) === JSON.stringify(state.identity.builds)) {
      await recordDocs(plan, state, door);
      writeReuse(state, saved, runsDir);
    } else
      console.log(
        `\nNO REUSE RECORDED: ${now.why || "a build changed while the round ran"}, so this round's visits cannot stand for a later round.`,
      );
  }
  // The next start finds the people door warm: a holder left behind (people-door.mjs), nothing waits for it.
  if (plan.reuse) await holderFor(run, holder)?.({ root: plan.workspace });
  // Read after the write: a reference round's stars are the bar it sets.
  const target = targetOf(plan, plan.workspace);
  if (state.reference) {
    console.log(`\n${referenceLines(plan, saved, target).join("\n")}`);
    return;
  }
  const t = trend(ownRounds(plan, key, state), target, { referenceAt: referenceAtOf(plan, plan.workspace) });
  console.log(`\n${renderTrend(t, target, { tape: Boolean(state.tape) }).join("\n")}`);
  await printHunt(plan, { kind, series: state.series }, runsDir, commits);
  if (saved.table)
    console.log(`\nThe round's table: ${saved.table.docket} (node dredd/dredd.mjs --status --docket ${saved.table.docket})`);
  else if (state.tape) console.log("\na tape round starts no review table: it measures the tape, not the product");
  else if (state.engine) console.log("\na round on an older engine starts no review table: it measures SUE, not the product");
  else if (opts.table && kind !== "focus") await startTable(plan, { state, row: saved, t, target, key });
  else console.log(`\nThe review table: node sue/round.mjs table --plan ${plan.file}`);
}

/** The SUE hunt's top items, one blank line after the STATE/NEXT block. SUE's own faults must never break the report. */
export async function printHunt(plan, { kind, series }, runsDir, commits, top = 5) {
  try {
    console.log(`\n${renderSueHunt(huntOf(plan, kind, runsDir, await commits, series), { top, rounds: HUNT_ROUNDS })}`);
  } catch (err) {
    console.log(`\nSUE HUNT: could not read SUE's own signals (${clip(err?.message, 160)})`);
  }
}

const HUNT_ROUNDS = 3;

/** `series` is the round's own (a `-engine` or `-tape` round keeps its rows apart from the live series), never only the plan's. */
function huntOf(plan, kind, runsDir = RUNS, decisionCommits = undefined, series = plan.series) {
  return gatherSueHunt({
    workspace: plan.workspace,
    series,
    kind,
    runsDir,
    root: checkoutRoot(),
    limit: HUNT_ROUNDS,
    decisionCommits,
    pageMotion: plan.pageMotion || [],
  });
}

/** `hunt`: SUE's own ranked self-improvement queue from the rounds on disk (nothing is written). */
export function hunt(plan, opts = {}) {
  // The saved round's series and kind, as every command after `start` reads them; with none saved, the flags' own.
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(stateFileOf(plan, opts), "utf8"));
  } catch {
    // no round saved here yet: the series the flags name
  }
  const series = saved?.series || startedSeries(plan, opts);
  const items = huntOf(plan, saved?.kind || kindOf(opts), opts.runs || RUNS, undefined, series);
  console.log(opts.json ? JSON.stringify(items, null, 2) : renderSueHunt(items, { top: 25, rounds: HUNT_ROUNDS }));
}

/** `people-hunt`: the personas that read weakest in the rounds on disk, each with its evidence and one rewrite direction (nothing is written). */
export function peopleHunt(plan, opts = {}) {
  let saved = null;
  try {
    saved = JSON.parse(readFileSync(stateFileOf(plan, opts), "utf8"));
  } catch {
    // no round saved here yet: the series the flags name
  }
  const series = saved?.series || startedSeries(plan, opts);
  const signals = gatherPeopleHunt({
    workspace: plan.workspace,
    series,
    kind: saved?.kind || kindOf(opts),
    runsDir: opts.runs || RUNS,
    root: checkoutRoot(),
    limit: HUNT_ROUNDS,
    pageMotion: plan.pageMotion || [],
  });
  const rows = rankPeopleHunt(signals, { top: 25 });
  console.log(opts.json ? JSON.stringify(rows, null, 2) : renderPeopleHunt(rows));
}

/** Where they stopped, in a sentence. */
function reachedLine(row) {
  return Object.entries(row.reached || {})
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n} ${k}`)
    .join(", ");
}

/** The ask Dredd's round hearing argues: the users' numbers against the target, the trend, where they stopped, their
 *  own words. When the trend says design, the ask says so in the owner's terms. */
export function roundAsk(plan, row, t, target) {
  const who = row.kind === "teachers" ? "teachers" : "students";
  const need = Math.ceil(target.finishShare * row.people - 1e-9);
  const parts = [
    `Round ${row.round} of ${row.series}: ${row.people} simulated ${who} rate it ${row.stars} stars against a target of ${target.stars}, and ${row.finished} of ${row.people} finished against a target of ${need}.`,
    `Where they stopped: ${reachedLine(row) || "not measured"}.`,
  ];
  if (t.next === "design")
    parts.push(
      `The rating has not moved (${t.history.join(", ")}) or most stop early: this is a design problem, not a wording one. The users have said what they need; the design board decides how this should work and play, in a way they did not know to ask for.`,
    );
  // those who did not finish lead, each marked: a finisher's "i finished" is no stop, and in lift-v2 round 14 three of
  // them took three of the four places ahead of the one student who quit, so the room argued a screen that student never reached
  const said = row.each
    .filter((e) => e.whyStopped)
    .sort((a, b) => Number(!!a.finished) - Number(!!b.finished))
    .slice(0, 4)
    .map((e) => `${e.who} (${e.finished ? "finished" : "did not finish"}): "${clip(e.whyStopped, 220)}"`);
  if (said.length) parts.push(`Why they stopped, in their words: ${said.join(" ")}`);
  return parts.join(" ").slice(0, 2400);
}

/** The round's evidence in SUE's report shape (what a hearing's sue-report.json holds), from every user run's report. */
async function roundReport(plan, state, row) {
  const reps = [];
  for (const r of state.runs.filter((x) => x.runId)) {
    const rep = await sue("report", { runId: r.runId }, plan.workspace);
    if (rep.ok) reps.push({ r, rep });
  }
  const users = reps.filter((x) => !x.r.critic);
  const screens = [];
  let size = 0;
  for (const { rep } of reps)
    for (const s of rep.screensSeen || []) {
      if (screens.some((k) => k.text.startsWith(s.text) || s.text.startsWith(k.text))) continue;
      if (size + s.text.length > 16000) break;
      screens.push(s);
      size += s.text.length;
    }
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const e of row.each) if (e.stars) histogram[e.stars] += 1;
  const gone = users.map((x) => x.rep.verdict?.neverComingBackShare).filter((n) => typeof n === "number");
  return {
    sues: row.people,
    complete: true,
    round: { series: row.series, round: row.round, kind: row.kind },
    verdict: {
      averageStars: row.stars,
      starHistogram: histogram,
      neverComingBackShare: gone.length ? gone.reduce((a, b) => a + b, 0) / gone.length : null,
    },
    whyTheyStopped: users.flatMap((x) => x.rep.whyTheyStopped || []),
    theirWords: [
      ...users.flatMap((x) => x.rep.theirWords || []),
      ...row.critics.flatMap((c) => c.drops.map((d) => ({ sueId: c.who, kind: "critic drop", where: d.url || "", said: d.text }))),
    ],
    screensSeen: screens,
    whereTheyStopped: row.reached,
    understoodIt: {},
  };
}

async function table(plan, given = null, opts = {}) {
  const state = given?.state || readState(plan, opts);
  if (state.reference) {
    console.log("a reference round (the ceiling check) has no review table: its stars are the bar, not a product to fix");
    process.exit(1);
  }
  if (state.tape) {
    console.log("a tape round has no review table: it measures the tape, not the product");
    process.exit(1);
  }
  if (state.engine) {
    console.log("a round on an older engine has no review table: it measures SUE, not the product");
    process.exit(1);
  }
  const key = given?.key || savedRound(plan, state, opts).key;
  const target = given?.target || targetOf(plan, plan.workspace);
  const rows = readRounds(plan.workspace, key);
  const row = given?.row || rows.find((r) => r.id === state.resetAt);
  if (!row) {
    console.log(`the round of ${state.resetAt} is not recorded yet: node sue/round.mjs report --plan ${plan.file}`);
    process.exit(1);
  }
  const t = given?.t || trend(rows, target);
  const root = plan.root || path.dirname(plan.file);
  const stampText = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = path.join(root, "tmp", "dredd", `round-${stampText}-${Math.random().toString(16).slice(2, 6)}`);
  mkdirSync(dir, { recursive: true });
  const evidence = {
    ask: roundAsk(plan, row, t, target),
    url: plan.url || plan.demo || null,
    root,
    series: row.series,
    key,
    target,
    trend: t,
    row,
    report: await roundReport(plan, state, row),
  };
  const file = path.join(dir, "round.json");
  writeFileSync(file, JSON.stringify(evidence, null, 2));
  const argv = [DREDD, "--round-file", file, "--root", root, "--out", dir, "--hearing", "--detach", "--no-catalog"];
  if (evidence.url) argv.push("--url", evidence.url);
  else argv.push("--no-page");
  const r = spawnSync(process.execPath, argv, { cwd: checkoutRoot(), encoding: "utf8", windowsHide: true, timeout: 120_000 });
  const out = `${r.stdout || ""}${r.stderr || ""}`.trim();
  console.log(`\nTHE ROUND'S TABLE (Dredd, detached${t.next === "design" ? ", with the design board" : ""}):\n${out}`);
  if (r.status === 0) writeRound(plan.workspace, key, { ...row, table: { docket: dir, at: new Date().toISOString() } });
  else console.log(`the table did not start (exit ${r.status}); start it again with: node sue/round.mjs table --plan ${plan.file}`);
}

/** Each stopwatch step's spans: every start paired with the next end of the same step, so a retried step keeps both
 *  tries. `{ step: { first, spans: [ms] } }`, `first` the step's first start. */
export function stepSpans(marks) {
  const out = {};
  const open = {};
  for (const m of mergeMarks(marks)) {
    const at = Date.parse(m.at);
    if (m.event === "start") {
      open[m.step] = at;
      out[m.step] ??= { first: at, spans: [] };
    } else if (m.event === "end" && open[m.step] !== undefined) {
      out[m.step].spans.push(at - open[m.step]);
      delete open[m.step];
    }
  }
  return out;
}

export function times(plan, opts = {}) {
  const runsDir = opts.runs || RUNS;
  const state = readState(plan, opts);
  const { resetAt, runs } = state;
  const { key } = savedRound(plan, state, opts);
  const round = readRounds(plan.workspace, key).find((r) => r.id === resetAt);
  const marks = mergeMarks(round?.marks, state.marks);
  const t0 = Date.parse(resetAt);
  const rows2 = timeRows(runs, runsDir, t0);
  const done = rows2.filter((x) => x.moves);
  if (!done.length) console.log("no Sue has moved yet");
  else timesOfSues(rows2, done);
  if (marks.length) {
    console.log("\n# Round-level timing marks:");
    for (const [step, s] of Object.entries(stepSpans(marks))) {
      if (!s.spans.length) continue;
      const total = s.spans.reduce((a, b) => a + b, 0) / 1000;
      console.log(
        `  ${step.padEnd(20)} +${((s.first - t0) / 1000).toFixed(0).padStart(4)} s, ${total.toFixed(1).padStart(5)} s${s.spans.length > 1 ? ` over ${s.spans.length} spans` : ""}`,
      );
    }
  }
}

function timesOfSues(rows2, done) {
  const end = Math.max(...done.map((x) => x.endS));
  console.log(
    `round: ${(end / 60).toFixed(1)} min from the reset to the last move (first move at +${Math.min(...done.map((x) => x.firstS)).toFixed(0)} s)`,
  );
  for (const x of rows2.sort((a, b) => (b.endS || 0) - (a.endS || 0))) {
    if (!x.moves) {
      console.log(`  ${x.who.padEnd(28)} never moved`);
      continue;
    }
    console.log(
      `  ${x.who.padEnd(28)} first move +${x.firstS.toFixed(0).padStart(3)} s, visit ${x.visitS.toFixed(0).padStart(3)} s, ${String(x.moves).padStart(3)} moves at ${x.perMove.toFixed(1)} s (browser ${x.bodyS.toFixed(0)} s), done at +${x.endS.toFixed(0)} s`,
    );
  }
}

function showTrend(plan, opts) {
  const key = seriesKey(plan.series, kindOf(opts));
  // --reference: the main series against the bar its reference sets (the reference measured against itself says nothing).
  if (opts.reference && !plan.reference?.series) usage("trend --reference needs plan.reference.series");
  const target = targetOf(
    opts.reference
      ? { ...plan, target: { ...plan.target, starsVs: { within: 0.2, ...plan.target?.starsVs, series: plan.reference.series } } }
      : plan,
    plan.workspace,
  );
  const rows = readRounds(plan.workspace, key);
  for (const r of rows)
    console.log(
      `  round ${String(r.round).padStart(2)}  ${r.at.slice(0, 16)}  ${r.stars ?? "-"} stars  ${r.finished} of ${r.people} finished${r.table ? `  table ${path.basename(r.table.docket)}` : ""}`,
    );
  const referenceAt = kindOf(opts) === "people" && !opts.reference ? referenceAtOf(plan, plan.workspace) : null;
  console.log(renderTrend(trend(rows, target, { referenceAt }), target).join("\n"));
}

/** A stopwatch mark: kept in the round's saved state at once (the row may not exist yet; report merges it in), and
 *  added to the row when it does. */
export function mark(plan, opts) {
  if (!opts.step || !opts.event)
    usage("mark needs a step and start|end: node sue/round.mjs mark --plan <plan.json> <step> start|end");
  if (!["start", "end"].includes(opts.event)) usage(`the event is start or end, not ${opts.event}`);
  const state = readState(plan, opts);
  const { key } = savedRound(plan, state, opts);
  const m = { step: opts.step, at: new Date().toISOString(), event: opts.event };
  state.marks = mergeMarks(state.marks, [m]);
  writeFileSync(stateFileOf(plan, opts), JSON.stringify(state, null, 2));
  markRound(plan.workspace, key, state.resetAt, m);
  return m;
}

const STOPWORDS = new Set(
  "the and for are but not you your was were with that this have has had from they them their there then than into its out can all any our too very just about what when where which while would could should been being does did how why who her him she his over also more some such only own same will off per get got via".split(
    " ",
  ),
);

/** A finding's content words: lowercase, punctuation gone, stopwords and words under 3 letters dropped. */
const contentWords = (text) =>
  new Set(
    String(text || "")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );

/** True when the tape finding shares at least a third of the live finding's content words. */
export function findingsMatch(liveFinding, tapeFinding) {
  const live = contentWords(liveFinding);
  if (!live.size) return false;
  const tape = contentWords(tapeFinding);
  const shared = [...live].filter((w) => tape.has(w)).length;
  return shared >= Math.ceil(live.size / 3);
}

const FINDING_KINDS = /^(confusion|annoyance|broken|drop|question)$/i;

/** A round's findings, read from its runs the way roundReport() reads them: every student's notes of kind confusion,
 *  annoyance, broken, drop or question, and every critic's drops, from the findings.jsonl of each sue-* folder of
 *  each of the round's runs in runsDir. If allowedWhos is provided, only include findings from people in that set. */
export function findingsOf(row, runsDir = RUNS, allowedWhos = null) {
  const critics = new Set((row.critics || []).map((c) => c.who));
  const out = [];
  for (const runId of row.runIds || []) {
    const dir = path.join(runsDir, runId);
    if (!existsSync(dir)) continue;
    for (const s of readdirSync(dir).filter((d) => d.startsWith("sue-"))) {
      const who = s.replace(/^sue-\d+-/, "");
      if (allowedWhos !== null && !allowedWhos.has(who)) continue;
      const critic = critics.has(who);
      let lines;
      try {
        lines = readFileSync(path.join(dir, s, "findings.jsonl"), "utf8")
          .split("\n")
          .filter(Boolean);
      } catch {
        continue;
      }
      for (const l of lines) {
        let f;
        try {
          f = JSON.parse(l);
        } catch {
          continue;
        }
        const kind = String(f.kind || "");
        const text = String(f.text || f.said || "").trim();
        if (text && (critic ? /drop/i.test(kind) : FINDING_KINDS.test(kind))) out.push(text);
      }
    }
  }
  return out;
}

/** Does the tape agree with the live site? Pure over two rows and their findings. Every student is paired by `who`; a
 *  student missing from one side, or with no stars, is not within one star and not the same. The bar (TAPE-PANEL.md,
 *  "Proven before it is trusted"): every student within one star, the same finishers for at least people - 1, and over
 *  half of the live findings raised again, or, when a live round came before, max(1, floor - 1) where floor is how
 *  many of the compared round's findings that earlier live round raises. `prev` is { round, findings } or null. Returns { ok, held, failed, lines }. */
export function agreeRounds(liveRow, tapeRow, liveFindings = [], tapeFindings = [], prev = null) {
  const lines = [];
  const liveEach = liveRow.each || [];
  const tapeEach = tapeRow.each || [];
  const names = [...new Set([...liveEach.map((e) => e.who), ...tapeEach.map((e) => e.who)])];
  const people = liveEach.length;
  const starsOf = (e) => (e && Number.isFinite(e.stars) ? e.stars : null);
  const fin = (e) => (e ? (e.finished ? "yes" : "no") : "-");
  let within = 0;
  let same = 0;
  for (const who of names) {
    const l = liveEach.find((e) => e.who === who);
    const t = tapeEach.find((e) => e.who === who);
    const ls = starsOf(l);
    const ts = starsOf(t);
    const near = ls !== null && ts !== null && Math.abs(ls - ts) <= 1;
    const alike = Boolean(l && t) && Boolean(l.finished) === Boolean(t.finished);
    if (near) within += 1;
    if (alike) same += 1;
    lines.push(
      `  ${who.padEnd(20)} stars live ${ls ?? "-"}, tape ${ts ?? "-"}  ${near ? "within one" : "NOT within one"}   finished live ${fin(l)}, tape ${fin(t)}  ${alike ? "same" : "NOT the same"}`,
    );
  }
  const starsOk = people > 0 && within === names.length;
  const needSame = Math.max(1, people - 1);
  const finishOk = same >= needSame;
  lines.push(
    "",
    `STARS     ${within} of ${people} students within one star (all must be): ${starsOk ? "held" : "FAILED"}`,
    `FINISHED  ${same} of ${people} finished the same (need ${needSame}): ${finishOk ? "held" : "FAILED"}`,
    "",
    "FINDINGS  a live finding is raised again when a tape finding shares at least a third of its content words (lowercase; stopwords and words under 3 letters dropped)",
  );
  const raised = liveFindings.map((f) => tapeFindings.some((t) => findingsMatch(f, t)));
  const hits = raised.filter(Boolean).length;
  let needHits = Math.floor(liveFindings.length / 2) + 1;
  if (prev) {
    const floor = liveFindings.filter((f) => prev.findings.some((p) => findingsMatch(f, p))).length;
    needHits = Math.max(1, floor - 1);
    lines.push(
      `FLOOR     live round ${prev.round} raised ${floor} of live round ${liveRow.round}'s ${liveFindings.length} findings: the tape needs ${needHits}`,
    );
  }
  const findingsOk = liveFindings.length > 0 && hits >= needHits;
  lines.push(`  LIVE (${liveFindings.length})`);
  liveFindings.forEach((f, i) => lines.push(`    ${raised[i] ? "raised again" : "NOT raised  "}  ${clip(f, 110)}`));
  lines.push(`  TAPE (${tapeFindings.length})`);
  for (const f of tapeFindings) lines.push(`    ${clip(f, 110)}`);
  const barDesc = prev ? `${needHits} needed` : "over half needed";
  lines.push(`FINDINGS  ${hits} of ${liveFindings.length} live findings raised again (${barDesc}): ${findingsOk ? "held" : "FAILED"}`);
  const held = [starsOk && "stars", finishOk && "finished", findingsOk && "findings"].filter(Boolean);
  const failed = [!starsOk && "stars", !finishOk && "finished", !findingsOk && "findings"].filter(Boolean);
  const ok = failed.length === 0;
  lines.push(
    "",
    `VERDICT   ${ok ? "AGREE" : "DO NOT TRUST THE TAPE YET"}: held ${held.join(", ") || "nothing"}; failed ${failed.join(", ") || "nothing"}`,
  );
  return { ok, held, failed, lines };
}

async function agree(plan, opts) {
  if (!plan.series) usage("agree needs plan.series (the live series a tape round is compared with)");
  const liveRows = readRounds(plan.workspace, seriesKey(plan.series, "people"));
  const tapeRows = readRounds(plan.workspace, seriesKey(`${plan.series}-tape`, "people"));
  const pick = (rows, n, label, series) => {
    const row = n === null ? rows.at(-1) : rows.find((r) => Number(r.round) === n);
    if (!row) {
      console.log(
        n === null
          ? `no ${label} round is recorded in ${series}`
          : `no ${label} round ${n} in ${series} (rounds: ${rows.map((r) => r.round).join(", ") || "none"})`,
      );
      process.exit(2);
    }
    return row;
  };
  const liveRow = pick(liveRows, opts.liveRound ?? null, "live", plan.series);
  const tapeRow = pick(tapeRows, opts.tapeRound ?? null, "tape", `${plan.series}-tape`);
  const runsDir = opts.runs || RUNS;
  console.log(
    `LIVE round ${liveRow.round} of ${plan.series} (${liveRow.at}) against TAPE round ${tapeRow.round} of ${plan.series}-tape (${tapeRow.at})\n`,
  );
  const tapeWhos = new Set([...(tapeRow.each || []).map((e) => e.who), ...(tapeRow.critics || []).map((c) => c.who)]);
  const liveFindings = findingsOf(liveRow, runsDir, tapeWhos);
  const tapeFindings = findingsOf(tapeRow, runsDir);
  const before = liveRows.filter((r) => Number(r.round) < Number(liveRow.round)).sort((x, y) => Number(y.round) - Number(x.round))[0];
  const prev = before ? { round: before.round, findings: findingsOf(before, runsDir, tapeWhos) } : null;
  const result = agreeRounds(liveRow, tapeRow, liveFindings, tapeFindings, prev);
  for (const line of result.lines) console.log(line);
  process.exit(result.ok ? 0 : 1);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = loadPlan(opts.plan, { workspace: opts.workspace });
  if (opts.cmd === "start") await start(plan, opts);
  else if (opts.cmd === "report") await report(plan, opts);
  else if (opts.cmd === "table") await table(plan, null, opts);
  else if (opts.cmd === "times") times(plan, opts);
  else if (opts.cmd === "hunt") hunt(plan, opts);
  else if (opts.cmd === "people-hunt") peopleHunt(plan, opts);
  else if (opts.cmd === "mark") mark(plan, opts);
  else if (opts.cmd === "agree") await agree(plan, opts);
  else showTrend(plan, opts);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
