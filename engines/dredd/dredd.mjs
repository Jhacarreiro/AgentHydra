#!/usr/bin/env node
import { targetRoot } from "../lib/target.mjs";
/**
 * DREDD - the judge. One door for any ask: which instruments to convene, which memories to pull,
 * which tier does the work, who else is on it - then it convenes them and files the docket.
 * ==========================================================================================
 *
 * Owner ask (the Chair, 2026-09-21): "combine Odin, Architect, SUE, Boardroom, AWS Atlas etc. into a
 * single platform that Jev (or a similar model) orchestrates ... sometimes the AI may not know which
 * tool to call ... build me out that judge now. Call it Dredd." And the same night: the message board
 * (peers), "which memories it needs" (recall), and "whether we should be using the zswarm and which
 * model" (delegation) fold into the same judge.
 *
 *   node dredd/dredd.mjs "<the ask>"                 the docket: what Dredd would convene, and why
 *   node dredd/dredd.mjs "<the ask>" --convene       ...and convene it (facts → board → field), log everything
 *   node dredd/dredd.mjs --convene --docket <dir>    convene a docket the hook already decided
 *   node dredd/dredd.mjs "<ask>" --url <page>        name the page: SUE, the critic and the live copy count key off it.
 *                                                          A complaint about a page with no page named is REFUSED at
 *                                                          --convene/--hearing (exit 2, the roster pages its words match);
 *                                                          --no-page when the page does not exist yet
 *   node dredd/dredd.mjs --collect --docket <dir>    the second sitting: SUE's report, the critic's capture, the flow walk - then the board again
 *   node dredd/dredd.mjs "<ask>" --url <page> --hearing   THE WHOLE THING, unattended: convene, wait for SUE and the
 *                                                          critic, the ladder, Jev picks the seats, the room sits over the
 *                                                          evidence, a drafter + the claims check + the Humanizer propose,
 *                                                          the room scores it, until happy (--happy-at 7) or out of rounds (--until-happy 2)
 *   node dredd/dredd.mjs --hearing --docket <dir>    resume a hearing on a convened docket (waits --wait 25 minutes at most)
 *   node dredd/dredd.mjs --resolve --docket <dir>    only the resolution loop again, on a docket that already has its seats
 *   ... --hearing --detach                                 the hearing runs hidden in the background; prints its docket in seconds
 *   node dredd/dredd.mjs "<ask>" --url <page> --run <runId>[,<runId>...] --hearing [--detach]
 *                                                          a new docket whose field is finished SUE/APE/ART runs (sue/runs/):
 *                                                          nothing launches; the room rules on their claims, then the drafter.
 *                                                          --field <field.json> keeps a SUE field run's decisions (scope, who
 *                                                          went, why ART and APE did or did not run) on the docket
 *                                                          (sue/lib/field.mjs: `sue field` hands its waves here, once)
 *   ... --hearing --chat                                   the chat that launched it drives SUE and the focus group on its own
 *                                                          Sonnet 5.5 agents (--status names the briefs), so every seat sits: the
 *                                                          pulse, the critic, the visitors, the room. Without it SUE sits out
 *   node dredd/dredd.mjs --status --docket <dir>     step n of 8, hearing.log from --from-line N, SUE's progress, the
 *                                                          sittings and the bill so far, verdict.md once it exists
 *   node dredd/dredd.mjs --stop --docket <dir>       end a running hearing (its whole process tree) and record the step
 *   node dredd/dredd.mjs --dockets [--url <page>]    past dockets, newest first: when, ask, state, score, next command
 *                                                          One hearing per docket: a second is refused while the first runs.
 *   node dredd/dredd.mjs --root <repo> "<ask>"       judge ANOTHER repository: its .dredd/bench.json and .dredd/seats/ when
 *                                                          it has them, else this bench minus the instruments only Connections can run
 *   node dredd/dredd.mjs --doctor [--root <repo>]    can this machine (and that repo) hold a hearing? every prerequisite, named
 *   node dredd/dredd.mjs --member "<ask>" [--no-jev] [--json]
 *                                                          a member's goal, never a hearing: every member setting in
 *                                                          member-bench.json, ordered by how strongly the ask names it
 *   node dredd/dredd.mjs --hunt [--json]             Dredd's own ranked self-improvement queue (the doctor, the last dockets'
 *                                                          failures, the eval's misses, decision changes the A/B never measured);
 *                                                          take the top item - the loop: .claude/rules/dredd-self-improvement.md
 *   node dredd/dredd.mjs --hunt --bucket             the stall mode: NO edit, the remaining trained misses bucketed by root cause
 *   node dredd/dredd.mjs --converge --ask-file <spec.md> [--tasks <tasks.md> [--append]] [--base <ref>] [--json]
 *                                                          the convergence ruling: every requirement the ask states (FR-001,
 *                                                          SC-002, US1... or one per list item) against `git diff <base>` plus
 *                                                          untracked files (base HEAD), each gap missing / partial /
 *                                                          contradicts / unrequested as a traced task; a ticked task is a
 *                                                          claim, not evidence. --append adds the tasks to --tasks. Exit 0
 *                                                          converged, 1 not: build and rule again until 0 (lib/converge.mjs)
 *   node dredd/dredd.mjs --rate <docket id> --score 1-5 --right a,b --unneeded c --wrong d --not-run e --missed f
 *          [--missing-tool "<what>"] [--class <c>] [--domain <d>] --note "<why>" [--gold "<the ask in your own words>"]
 *                                                          the chat that received a docket says whether each call was right;
 *                                                          a wrong or missed one becomes eval/verdicts/v-<id>.json (lib/verdict.mjs)
 *   node dredd/dredd.mjs --review-depth [--base <ref>] [--depth low|medium|high|xhigh|max] [--json]
 *                                                          how many reviewers a code review gets (lib/depth.mjs): the diff
 *                                                          against --base (HEAD = the uncommitted work) read for size and
 *                                                          risk, the role seats, the hunter cap, the verifier policy, and
 *                                                          the scope block every subagent prompt starts with. A code
 *                                                          review or complaint docket carries the same as `reviewDepth`
 *   node dredd/dredd.mjs --rule-fix <docket id> --repro "<what you re-ran, what it showed>" --repro-result gone|still|not-run
 *          --tests pass|fail|none                          a bug docket's fix, ruled verified, partial or failed (lib/bug.mjs):
 *                                                          green tests with the original repro not re-run rule partial
 *   node dredd/dredd.mjs --rule-fix <docket id> --repro-file <repro.mjs> | --repro-check "<command>" --tests pass|fail|none
 *                                                          the same ruling on a repro that RAN instead of one typed: the file
 *                                                          goes through sue/repro.mjs run (its assertion failing is
 *                                                          still, a pass gone, any other error not-run); the command is gone
 *                                                          on exit 0, else still
 *   node dredd/dredd.mjs --round-file <round.json> --hearing [--detach]
 *                                                          a hearing over a SUE round that already happened (sue/round.mjs
 *                                                          table writes the file and starts it): the round's report is the
 *                                                          field, only the page's pulse convenes, the review table sits, and
 *                                                          under the target a stall or an early stop seats the design board,
 *                                                          whose redesign is the resolution (lib/round.mjs)
 *   flags: --no-recall --no-peers --no-catalog --announce --no-jev --escalate 0.7 --json --hook --out <dir> --skip sue,design-critic --scope 0|1|2
 *          an unknown --flag is refused (exit 2); everything after a bare -- is the ask; --url must be an http(s) page
 *
 * HOW IT DECIDES. bench.json is the roster; every instrument carries one typed question. Jev
 * (TypeSafe's typed-decision model, through HSwarm's measured cascade - lib/jev.mjs) answers the
 * four standing questions (class, domain, scope, delegation) and one per instrument in about a
 * second for well under a tenth of a cent. When Jev is unreachable the bench's keywords answer the
 * same questions, and the docket says so (`decidedBy: heuristic`). The decision itself is pure code
 * (lib/docket.mjs), so it is tested without the network.
 *
 * WHAT IT KNOWS. Recall = the agent memory lane's pgvector search (the same store every memory file
 * is mirrored into), local full-text as the fallback. Peers = the team board and the message board.
 * Connections = the catalog's answer for the ask (lib/catalog.mjs): the local tools, vault scripts,
 * endpoints and connectors that fit it, an unconnected connector with the page a person connects it on.
 * Delegation = Jev's tier verdict; the agent_routing_gate hook stays the enforcer.
 *
 * WHAT IT RECORDS. Every new docket (the plain call, the prompt hook, a convene, a hearing) is one `run` on the
 * Connections scoring lane's "the docket" row and one on each convened instrument's row (lib/lane-record.mjs), queued
 * to ~/.connections/lane/outbox.jsonl for the MCP to ship; the lane's reflection then asks the chat that received it
 * to --rate it, which scores those rows and turns a wrong docket into a verdict row for `eval.mjs --verdicts`.
 * DREDD_NO_RECORD=1 records nothing, DREDD_VERDICTS_DIR moves the verdict rows (both for the specs).
 *
 * WHAT IT WRITES. <root>/tmp/dredd/<stamp>/docket.json + docket.md, and one log per convened instrument.
 * The Boardroom of critics (boardroom.mjs) reads the same docket and argues over the facts in it.
 * The prompt hook (dredd/hooks/dredd-docket.mjs) runs this with --hook on grievance-shaped prompts.
 */
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adoptedDomain, adoptRuns } from "./lib/claim-rulings.mjs";
import { matterFor } from "./lib/ladder.mjs";
import { catalogFor } from "./lib/catalog.mjs";
import { convene, planFor, runDetached, vaultInstanceFor } from "./lib/convene.mjs";
import { appendTasks, converge, renderConverge } from "./lib/converge.mjs";
import {
  ASK_CLASSES,
  DOMAINS,
  ENGINE_DIR,
  ENGINE_ROOT,
  buildMemberQuestions,
  buildQuestions,
  decideDocket,
  dreddDirFor,
  extractPaths,
  extractUrl,
  heuristicAnswers,
  loadBench,
  loadMemberBench,
  memberChecklist,
  memberHeuristicAnswers,
  mergeAnswers,
  noPageLines,
  normalizeUrl,
  renderDocket,
  renderMemberChecklist,
  samePath,
  shellArg,
} from "./lib/docket.mjs";
import { scoreText } from "./lib/ballot.mjs";
import { closeBrain } from "./lib/brain.mjs";
import { executedRepro, ruleFix } from "./lib/bug.mjs";
import { collect } from "./lib/collect.mjs";
import { LEVELS, depthFor, measureDiff, renderDepth, scopeBlock, wantsReviewDepth } from "./lib/depth.mjs";
import { listDockets, recentFinished, renderDocketsTable } from "./lib/dockets.mjs";
import { brainPreflight, doctor, renderDoctor } from "./lib/doctor.mjs";
import { gatherHunt, huntBuckets, rankHunt, renderHunt } from "./lib/hunt.mjs";
import {
  diedBeforeDocketText,
  hearing,
  hearingStatus,
  liveHearingLock,
  mayResumeAtResolve,
  readJson,
  renderFailureVerdict,
  renderStatus,
  stopHearing,
} from "./lib/hearing.mjs";
import { askJev } from "./lib/jev.mjs";
import { recordDocket, recordRating, sessionOf } from "./lib/lane-record.mjs";
import { priceFeedbackFor } from "./lib/price.mjs";
import { openLocalMcp } from "./lib/mcp.mjs";
import { announce, readPeers } from "./lib/peers.mjs";
import { docketFacets, recallFacets, recallLane } from "./lib/recall.mjs";
import { applyRound } from "./lib/round.mjs";
import { seatsDirFor } from "./lib/seats.mjs";
import { checkRating, goldRowFor } from "./lib/verdict.mjs";
import { castForDocket, castWanted, presueForDocket, presueWanted, readyCastBodies, renderCast } from "./lib/visitors.mjs";
import { isMainModule } from "../lib/shared/is-main.mjs";
import { fetchOwnedSites, ownedSitesDoorOf } from "../sue/lib/owned-sites.mjs";

/** The one local MCP this run opened, until it is closed: the entry point closes it on every way out. */
let openMcp = null;

/** The --rate flags and the field of lib/verdict.mjs checkRating each one fills. */
const RATE_FLAGS = {
  "--score": "score",
  "--right": "right",
  "--unneeded": "unneeded",
  "--wrong": "wrong",
  "--not-run": "notRun",
  "--missed": "missed",
  "--missing-tool": "missingTool",
  "--note": "note",
  "--gold": "gold",
  "--class": "klass",
  "--domain": "domain",
};

/** The --rule-fix flags and the field of lib/bug.mjs ruleFix each one fills. */
const FIX_FLAGS = {
  "--repro": "repro",
  "--repro-result": "reproResult",
  "--tests": "tests",
  "--repro-file": "reproFile",
  "--repro-check": "reproCheck",
};

/** A command line Dredd cannot act on: main() prints it with exit 2, before anything has run. */
export class UsageError extends Error {}

/**
 * The command line. A flag-shaped word it does not know is refused (a mistyped `--hearng` used to be judged as part
 * of the ask and file a plain docket, exit 0 - 2026-09-22); everything after a bare `--` is the ask, however it
 * starts, which is how the prompt hook passes a prompt through untouched. Numbers are checked, so `--wait 0` is zero.
 * Exported for its test.
 */
export function parseArgs(argv) {
  const a = {
    ask: [],
    convene: false,
    recall: true,
    peers: true,
    catalog: true,
    announce: false,
    jev: true,
    escalate: null,
    json: false,
    hook: false,
    out: null,
    url: null,
    docket: null,
    skip: [],
    hearing: false,
    resolve: false,
    root: null,
    wait: 25,
    untilHappy: 2,
    happyAt: 7,
    status: false,
    stop: false,
    dockets: false,
    detach: false,
    chat: false,
    fromLine: 0,
    limit: 20,
    askFile: null,
    rate: null,
    rating: {},
    reviewDepth: false,
    base: null,
    depth: null,
    ruleFix: null,
    fix: {},
    // Which argv entries the ask came from: --detach hands the ask to its child through a file instead, because cmd
    // cannot carry a double quote inside one argument and a complaint about a headline usually quotes it.
    askAt: [],
  };
  const value = (i, flag) => {
    if (i >= argv.length) throw new UsageError(`${flag} needs a value`);
    return argv[i];
  };
  const num = (i, flag, { min = -Infinity, max = Infinity } = {}) => {
    const n = Number(value(i, flag));
    if (!Number.isFinite(n) || n < min || n > max) throw new UsageError(`${flag} takes a number from ${min} to ${max}, not "${argv[i]}"`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    if (x === "--") {
      a.ask.push(...argv.slice(i + 1));
      for (let j = i; j < argv.length; j += 1) a.askAt.push(j);
      break;
    } else if (x === "--convene") a.convene = true;
    else if (x === "--no-recall") a.recall = false;
    else if (x === "--no-peers") a.peers = false;
    else if (x === "--no-catalog") a.catalog = false;
    else if (x === "--announce") a.announce = true;
    else if (x === "--no-jev") a.jev = false;
    else if (x === "--json") a.json = true;
    else if (x === "--hook") a.hook = true;
    else if (x === "--escalate") a.escalate = num(++i, x, { min: 0, max: 1 });
    else if (x === "--out") a.out = value(++i, x);
    else if (x === "--url") a.url = value(++i, x);
    else if (x === "--no-page") a.noPage = true;
    else if (x === "--docket") a.docket = value(++i, x);
    // --run <runId>[,<runId>...]: a new docket whose field is those finished SUE/APE/ART runs (lib/claim-rulings.mjs adoptRuns).
    else if (x === "--run") a.run = value(++i, x).split(",").map((s) => s.trim()).filter(Boolean);
    // --field <field.json>: the SUE field run that gathered those runs (sue/lib/field.mjs), its decisions kept on the docket.
    else if (x === "--field") a.field = value(++i, x);
    else if (x === "--root") a.root = value(++i, x);
    else if (x === "--scope") a.scope = num(++i, x, { min: 0, max: 2 });
    else if (x === "--doctor") a.doctor = true;
    else if (x === "--hunt") a.hunt = true;
    else if (x === "--member") a.member = true;
    else if (x === "--bucket") a.bucket = true;
    else if (x === "--converge") a.converge = true;
    else if (x === "--tasks") a.tasks = value(++i, x);
    else if (x === "--base") a.base = value(++i, x);
    else if (x === "--append") a.append = true;
    else if (x === "--collect") a.collect = true;
    else if (x === "--hearing") a.hearing = true;
    else if (x === "--resolve") a.resolve = true;
    else if (x === "--wait") a.wait = num(++i, x, { min: 0 });
    else if (x === "--until-happy") a.untilHappy = num(++i, x, { min: 0 });
    else if (x === "--happy-at") a.happyAt = num(++i, x, { min: 0, max: 10 });
    else if (x === "--status") a.status = true;
    else if (x === "--stop") a.stop = true;
    else if (x === "--dockets") a.dockets = true;
    else if (x === "--detach") a.detach = true;
    else if (x === "--chat") a.chat = true;
    else if (x === "--from-line") a.fromLine = num(++i, x, { min: 0 });
    else if (x === "--limit") a.limit = num(++i, x, { min: 1, max: 500 });
    else if (x === "--ask-file") a.askFile = value(++i, x);
    else if (x === "--round-file") a.roundFile = value(++i, x);
    else if (x === "--rate") a.rate = value(++i, x);
    else if (RATE_FLAGS[x]) a.rating[RATE_FLAGS[x]] = value(++i, x);
    else if (x === "--review-depth") a.reviewDepth = true;
    else if (x === "--depth") {
      a.depth = value(++i, x);
      if (!LEVELS.includes(a.depth)) throw new UsageError(`--depth takes one of ${LEVELS.join(", ")}, not "${a.depth}"`);
    } else if (x === "--rule-fix") a.ruleFix = value(++i, x);
    else if (FIX_FLAGS[x]) a.fix[FIX_FLAGS[x]] = value(++i, x);
    else if (x === "--skip")
      a.skip.push(
        ...String(value(++i, x))
          .split(",")
          .map((v) => v.trim())
          .filter(Boolean),
      );
    else if (x === "--help" || x === "-h") a.help = true;
    else if (/^--[a-z][a-z-]*$/i.test(x)) throw new UsageError(`unknown flag ${x}`);
    else {
      a.ask.push(x);
      a.askAt.push(i);
    }
  }
  a.ask = a.ask.join(" ").trim();
  if (!a.rate && Object.keys(a.rating).length) throw new UsageError(`${Object.keys(a.rating).join(", ")} only go with --rate <docket id>`);
  if (a.rate && a.ask) throw new UsageError("--rate takes a docket id, not an ask");
  if (a.member && !a.ask) throw new UsageError("--member needs the member's ask");
  if (!a.converge && (a.tasks || a.append)) throw new UsageError("--tasks and --append only go with --converge");
  if (a.append && !a.tasks) throw new UsageError("--append needs --tasks <file> to append to");
  if (a.field && !a.run) throw new UsageError("--field only goes with --run: the field run's own waves");
  if (!a.converge && !a.reviewDepth && a.base !== null) throw new UsageError("--base only goes with --converge or --review-depth");
  if (!a.reviewDepth && a.depth !== null) throw new UsageError("--depth only goes with --review-depth");
  if (a.converge && a.reviewDepth) throw new UsageError("--converge and --review-depth are two rulings: ask for one");
  if (!a.ruleFix && Object.keys(a.fix).length)
    throw new UsageError(
      `${Object.keys(FIX_FLAGS)
        .filter((f) => FIX_FLAGS[f] in a.fix)
        .join(", ")} only go with --rule-fix <docket id>`,
    );
  if (a.ruleFix && a.ask) throw new UsageError("--rule-fix takes a docket id, not an ask");
  // The page is checked once, here, before anything runs: every instrument that takes {url} gets the same parsed href.
  if (a.url !== null) {
    try {
      a.url = normalizeUrl(a.url);
    } catch (err) {
      throw new UsageError(`--url: ${err.message}`);
    }
  }
  return a;
}

/** Why a docket is refused while its hearing runs: whose it is, where, since when, and the two ways out. */
export function lockRefusal(record) {
  return `a hearing is already running on this docket (pid ${record.pid} on ${record.host || os.hostname()}, at "${record.step || "?"}" since ${record.startedAt || "?"}) - read it with --status or end it with --stop`;
}

/** An untracked file larger than this is a build output or a fixture, not work to judge: --converge skips it. */
const UNTRACKED_MAX_BYTES = 200_000;

/**
 * The work --converge judges: `git diff <base>` of the working tree, plus every untracked file (not ignored) as an
 * all-added diff, because a fresh module the build step wrote is exactly what `git diff` alone would never show.
 */
export function workingDiff(root, base) {
  const git = (...argv) => {
    const r = spawnSync("git", ["-C", root, ...argv], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    if (r.status !== 0) throw new Error(`git ${argv.join(" ")}: ${(r.stderr || r.error?.message || "failed").trim()}`);
    return r.stdout;
  };
  const tracked = git("diff", "--no-color", "--no-ext-diff", base, "--");
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z")
    .split("\0")
    .filter(Boolean)
    .flatMap((rel) => {
      const abs = path.join(root, rel);
      // A nested repository or untracked submodule is listed as "dir/", a broken symlink cannot be read: neither is a
      // file of work, and reading either would abort the whole ruling.
      const st = lstatSync(abs, { throwIfNoEntry: false });
      if (!st?.isFile() || st.size > UNTRACKED_MAX_BYTES) return [];
      const text = readFileSync(abs, "utf8");
      if (text.includes("\0")) return [];
      const body = text.split(/\r?\n/).map((l) => `+${l}`);
      return [`diff --git a/${rel} b/${rel}`, "--- /dev/null", `+++ b/${rel}`, ...body];
    });
  return [tracked, ...untracked].join("\n");
}

/**
 * One --converge ruling over `root`: the tasks file read (absent is fine when appending), the working diff, and the
 * ruling. The ask file and the tasks file are left out of the evidence: an untracked spec repeats every requirement word
 * for word and --append writes each requirement's text into the tasks file, so either one would rule an unbuilt ask
 * converged. Paths are as the caller typed them (relative to the working directory). Returns { r, tasksText }.
 */
export function convergeRuling(root, { ask, askFile = null, tasks = null, append = false, base = "HEAD" }) {
  let tasksText = "";
  if (tasks && existsSync(tasks)) tasksText = readFileSync(tasks, "utf8");
  else if (tasks && !append) throw new UsageError(`--tasks ${tasks} does not exist`);
  const exclude = [askFile, tasks]
    .filter(Boolean)
    .map((p) => path.relative(root, path.resolve(p)).split(path.sep).join("/"))
    .filter((rel) => rel && !rel.startsWith("../") && !path.isAbsolute(rel));
  const r = converge({ ask, diff: workingDiff(root, base), tasks: tasksText, exclude });
  return { r, tasksText };
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(16).slice(2, 6)}`;
}

function loadSurfaces(root) {
  try {
    const policy = JSON.parse(readFileSync(path.join(root, ".arkitect", "policies", "connections", "design-critic-surfaces.json"), "utf8"));
    return Array.isArray(policy.surfaces) ? policy.surfaces : [];
  } catch {
    return [];
  }
}

/** The capability inventory the claims check reads: Connections' own, and only when the repo judged IS Connections. */
function loadInventory(root) {
  if (!samePath(root, targetRoot())) return null;
  try {
    return JSON.parse(readFileSync(fileURLToPath(new URL("../vendor/infra/shared/plane-capabilities.json", import.meta.url)), "utf8"));
  } catch {
    return null;
  }
}

/** The prompt hook kills this process at 9 s (dredd/hooks/dredd-docket.mjs); everything it does must print inside
 *  this, counted from process start. Jev gets at most HOOK_JEV_MS of it and recall what is left (2026-09-22: Jev had
 *  the whole 9 s, so a slow Jev meant the hook printed no docket at all, not the heuristic one it promised). */
const HOOK_BUDGET_MS = 7_500;
const HOOK_JEV_MS = 4_500;

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (!(err instanceof UsageError)) throw err;
    process.stderr.write(`dredd: ${err.message} (node dredd/dredd.mjs --help)\n`);
    process.exit(2);
  }
  if (args.askFile) {
    try {
      args.ask = [args.ask, readFileSync(args.askFile, "utf8").trim()].filter(Boolean).join(" ");
    } catch (err) {
      process.stderr.write(`dredd: --ask-file ${args.askFile}: ${err.message}\n`);
      process.exit(2);
    }
  }
  // A SUE round that already happened (sue/round.mjs table): its ask, page and repository come from its own file,
  // and the docket below is built over its evidence instead of sending anyone (lib/round.mjs).
  let round = null;
  if (args.roundFile) {
    try {
      round = JSON.parse(readFileSync(args.roundFile, "utf8"));
    } catch (err) {
      process.stderr.write(`dredd: --round-file ${args.roundFile}: ${err.message}\n`);
      process.exit(2);
    }
    if (!round || typeof round !== "object" || Array.isArray(round)) {
      process.stderr.write(`dredd: --round-file ${args.roundFile} holds no round (expected the object sue/round.mjs writes)\n`);
      process.exit(2);
    }
    if (!args.ask) args.ask = String(round.ask || "").trim();
    if (!args.url && round.url) {
      // The same door --url passes (an http(s) page or nothing), said as a usage error rather than thrown.
      try {
        args.url = normalizeUrl(round.url);
      } catch (err) {
        process.stderr.write(`dredd: --round-file ${args.roundFile}: url ${err.message}\n`);
        process.exit(2);
      }
    }
    if (!args.root && round.root) args.root = round.root;
  }
  // A SUE field run's record (sue/lib/field.mjs): the scope, who went, why ART and APE did or did not run. Read
  // before anything is filed, so a file that is not one refuses the call instead of leaving half a docket.
  let field = null;
  if (args.field) {
    try {
      field = { file: path.resolve(args.field), ...JSON.parse(readFileSync(args.field, "utf8")) };
    } catch (err) {
      process.stderr.write(`dredd: --field ${args.field}: ${err.message}\n`);
      process.exit(2);
    }
  }
  const hookDeadline = args.hook ? Math.floor(performance.timeOrigin) + HOOK_BUDGET_MS : null;
  if (
    args.help ||
    (!args.ask &&
      !args.docket &&
      !args.doctor &&
      !args.dockets &&
      !args.hunt &&
      !args.rate &&
      !args.converge &&
      !args.reviewDepth &&
      !args.ruleFix)
  ) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]
        .replace(/^\/\*\*\n/, "")
        .replace(/^ \* ?/gm, ""),
    );
    process.exit(args.help ? 0 : 2);
  }
  // The repository judged. Connections unless --root names another; the engine, the bench and the seats stay here.
  // Connections named in another case IS Connections: canonical here, so every identity check downstream (the bench,
  // the inventory, the doctor) sees the engine's own root.
  const ROOT = args.root ? path.resolve(args.root) : targetRoot();
  if (!existsSync(ROOT)) throw new Error(`--root ${ROOT} is not a directory`);
  const bench = loadBench(ROOT);
  const dredd = dreddDirFor(ROOT);
  const seatsDir = seatsDirFor(ROOT);
  if (args.doctor) {
    const rows = doctor({ root: ROOT, bench });
    const { text, missing } = renderDoctor(rows, { root: ROOT });
    process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${text}\n`);
    process.exit(missing ? 1 : 0);
  }
  if (args.rate) {
    let out;
    try {
      out = rateDocket(args, { root: ROOT, bench });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      process.stderr.write(`dredd: ${err.message}\n`);
      process.exit(2);
    }
    process.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : `${out.lines.join("\n")}\n`);
    return;
  }
  if (args.ruleFix) {
    let out;
    try {
      out = ruleFixDocket(args, { root: ROOT });
    } catch (err) {
      if (!(err instanceof UsageError)) throw err;
      process.stderr.write(`dredd: ${err.message}\n`);
      process.exit(2);
    }
    process.stdout.write(args.json ? `${JSON.stringify(out, null, 2)}\n` : `${out.lines.join("\n")}\n`);
    return;
  }
  // A member's goal (1af4a7de): the member roster's settings, ordered by how strongly the ask names each one.
  if (args.member) {
    const roster = loadMemberBench(ROOT);
    const heuristic = memberHeuristicAnswers(roster, args.ask);
    let answers = heuristic;
    let source = "heuristic";
    if (args.jev) {
      const res = await askJev(buildMemberQuestions(roster, args.ask), { escalate: args.escalate ?? 0.7 });
      if (res.answers) {
        const merged = mergeAnswers(res.answers, heuristic);
        answers = merged.answers;
        source = `jev${merged.filled.length ? "+heuristic" : ""}`;
      }
    }
    const rows = memberChecklist(roster, { answers });
    process.stdout.write(
      args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderMemberChecklist(rows, { file: roster.file, source, ask: args.ask })}\n`,
    );
    return;
  }
  // Dredd's RSI queue: the Architect's `arkitect:hunt`, pointed at the judge (the Chair, 2026-09-23). Local reads only.
  if (args.hunt) {
    const gold = JSON.parse(readFileSync(path.join(ENGINE_DIR, "eval", "asks.json"), "utf8")).asks;
    const gathered = gatherHunt(ROOT, {
      bench,
      gold,
      doctorRows: doctor({ root: ROOT, bench }),
      limit: args.limit === 20 ? 60 : args.limit,
    });
    if (args.bucket) {
      process.stdout.write(`${huntBuckets(gathered, gold)}
`);
      return;
    }
    const items = rankHunt(gathered);
    process.stdout.write(args.json ? `${JSON.stringify(items, null, 2)}\n` : `${renderHunt(items)}\n`);
    return;
  }
  // The convergence ruling (github/spec-kit's converge step, adapted): the ask's requirements against the diff, gaps as
  // traced tasks. Local git reads only; exit 1 until converged, so a build loop can run on the exit code.
  if (args.converge) {
    if (!args.ask) {
      process.stderr.write("dredd: --converge needs the ask: --ask-file <spec.md> or the ask as text\n");
      process.exit(2);
    }
    let r;
    let tasksText = "";
    try {
      ({ r, tasksText } = convergeRuling(ROOT, {
        ask: args.ask,
        askFile: args.askFile,
        tasks: args.tasks,
        append: args.append,
        base: args.base || "HEAD",
      }));
    } catch (err) {
      process.stderr.write(`dredd: --converge: ${err.message}\n`);
      process.exit(2);
    }
    let appended = 0;
    if (args.append) {
      const out = appendTasks(tasksText, r.tasks);
      if (out.appended) writeFileSync(args.tasks, out.text);
      appended = out.appended;
    }
    const tail = args.append ? `\n${appended} task(s) appended to ${args.tasks}` : "";
    process.stdout.write(args.json ? `${JSON.stringify({ ...r, appended }, null, 2)}\n` : `${renderConverge(r)}${tail}\n`);
    process.exit(r.verdict === "converged" ? 0 : 1);
  }
  // The review depth dial: one git read and a pure decision, so a reviewer (or the agent about to spawn its seats) knows
  // the fan-out cap before anyone is spawned. A base git does not know is a usage error, not a crash.
  if (args.reviewDepth) {
    const base = args.base || "HEAD";
    let d;
    try {
      d = { ...depthFor(measureDiff(ROOT, { base }), { forced: args.depth }), base, scope: scopeBlock({ root: ROOT, base }) };
    } catch (err) {
      process.stderr.write(`dredd: --review-depth: ${String(err?.stderr || err?.message || err).trim()}\n`);
      process.exit(2);
    }
    process.stdout.write(args.json ? `${JSON.stringify(d, null, 2)}\n` : `${renderDepth(d, { block: d.scope })}\n`);
    return;
  }
  // The docket history: newest first, read from each docket's docket.json and hearing.json only, never its logs, so a
  // hearing lost to a caller's timeout can be found again (the MiroFish review, 2026-09-23).
  if (args.dockets) {
    const rows = listDockets(ROOT, { limit: args.limit, url: args.url });
    process.stdout.write(args.json ? `${JSON.stringify(rows, null, 2)}\n` : `${renderDocketsTable(rows)}\n`);
    return;
  }
  // A hearing's status and its stop read the docket on disk, so they answer from any process, at any time, and two
  // callers polling at once never disagree.
  if (args.status || args.stop) {
    if (!args.docket) {
      process.stderr.write(`dredd: --${args.stop ? "stop" : "status"} needs --docket <dir> (--dockets lists them)\n`);
      process.exit(2);
    }
    const dir = path.resolve(args.docket);
    if (args.stop) {
      const r = stopHearing(dir);
      process.stdout.write(
        args.json ? `${JSON.stringify(r)}\n` : r.stopped ? `stopped the hearing at "${r.step}"\n` : `not stopped: ${r.why}\n`,
      );
      process.exit(r.stopped ? 0 : 1);
    }
    const st = hearingStatus({ root: ROOT, docketDir: dir, fromLine: args.fromLine });
    process.stdout.write(args.json ? `${JSON.stringify(st, null, 2)}\n` : renderStatus(st));
    return;
  }
  // A page heard within the last few hours is named, never reused: after words land, hearing it again is the normal case.
  // The room is told what the last hearing of the page ruled (lib/earlier.mjs), so a change that followed it is not
  // scored as the opposite defect.
  if ((args.hearing || args.detach) && !args.docket && args.url) {
    const recent = recentFinished(listDockets(ROOT, { url: args.url }));
    if (recent)
      process.stderr.write(
        `dredd: this page was heard at ${recent.when} (${scoreText(recent)}): ${recent.dir}; the room reads its ruling\n`,
      );
  }
  // --detach: the hearing runs hidden in the background and this call returns its docket in seconds. A caller with a
  // ceiling (the MCP door kills its child at its timeout, and with it the verdict) polls --status instead of waiting.
  if (args.detach) {
    if (!args.hearing && !args.resolve) {
      process.stderr.write("dredd: --detach runs a --hearing or a --resolve in the background\n");
      process.exit(2);
    }
    const dir = path.resolve(args.docket || args.out || path.join(ROOT, "tmp", "dredd", stamp()));
    mkdirSync(dir, { recursive: true });
    const held = liveHearingLock(dir);
    if (held.live) {
      process.stderr.write(`dredd: ${lockRefusal(held.record)}\n`);
      process.exit(2);
    }
    // The child gets the same flags, and the ask through a file in its own docket (a quote survives a file).
    const askAt = new Set(args.askAt);
    const argv = process.argv.slice(2).filter((x, i) => x !== "--detach" && !askAt.has(i));
    if (args.ask) {
      const askFile = path.join(dir, "ask.txt");
      writeFileSync(askFile, `${args.ask}\n`);
      argv.push("--ask-file", askFile);
    }
    if (!args.docket && !args.out) argv.unshift("--out", dir);
    let cmd;
    try {
      cmd = [process.execPath, fileURLToPath(import.meta.url), ...argv].map((x) => shellArg(x)).join(" ");
    } catch (err) {
      process.stderr.write(`dredd: cannot launch it detached: ${err.message}\n`);
      process.exit(2);
    }
    // detached.out, not a .log: the room reads every .log in the docket as evidence, and its own run is never evidence.
    const launched = runDetached(cmd, { cwd: ROOT, log: path.join(dir, "detached.out"), heavy: false });
    // --stop reads this while the hearing is still convening, before its hearing.json (and its pid) exists.
    if (launched.pid) writeFileSync(path.join(dir, "detached.json"), JSON.stringify({ pid: launched.pid, at: new Date().toISOString() }));
    const status = `node dredd/dredd.mjs --status --docket ${dir}`;
    process.stdout.write(
      args.json
        ? `${JSON.stringify({ docketDir: dir, launched: launched.status, pid: launched.pid, status })}\n`
        : `Docket: ${dir}\nThe hearing is ${launched.status}. Read it with: ${status}\n`,
    );
    process.exit(launched.pid ? 0 : 1);
  }
  let docket;
  let docketDir;
  let isNew = false;

  if (args.docket) {
    docketDir = path.resolve(args.docket);
    // A docket folder with no docket.json died before its docket was written (a hearing launched before the preflight
    // marked it, lib/hearing.mjs `diedBeforeDocket`): say so and what to do, never an ENOENT stack.
    if (!existsSync(path.join(docketDir, "docket.json"))) {
      process.stderr.write(`dredd: ${diedBeforeDocketText(docketDir)}\n`);
      process.exit(2);
    }
    docket = JSON.parse(readFileSync(path.join(docketDir, "docket.json"), "utf8"));
    // One hearing per docket: a second one would number its sitting the same as the first and rename over its minutes.
    // A record whose pid is dead (or on another host) is taken over, and said once.
    if (args.hearing || args.resolve || args.collect || args.convene) {
      const held = liveHearingLock(docketDir);
      if (held.live) {
        process.stderr.write(`dredd: ${lockRefusal(held.record)}\n`);
        process.exit(2);
      }
      if (held.record?.state === "running")
        process.stderr.write(`dredd: the last hearing on this docket died at "${held.record.step || "?"}"; taking it over\n`);
    }
    if (args.ask) docket.ask = args.ask;
    // A docket the hook filed with no page, named at convene time (`--convene --docket <dir> --url <page>`, the fix the
    // NO PAGE refusal asks for): decided again from its own saved answers, so the page rungs sit this time.
    if (args.url && !docket.url && !(docket.results || []).length && docket.answers) {
      const { jev, answers, heuristicFilled, created, root, bench: benchNote } = docket;
      const kept = { jev, answers, heuristicFilled, created, root, bench: benchNote };
      docket = {
        ...decideDocket({
          bench,
          ask: docket.ask,
          url: args.url,
          answers: docket.answers,
          source: docket.decidedBy,
          surfaces: loadSurfaces(ROOT),
          forcedScope: args.scope ?? null,
          paths: docket.paths,
        }),
        ...Object.fromEntries(Object.entries(kept).filter(([, v]) => v !== undefined)),
      };
    }
    // A docket filed before the door checked URLs gets the same check on its way back in.
    if (docket.url) {
      try {
        docket.url = normalizeUrl(docket.url);
      } catch (err) {
        throw new Error(`${path.join(docketDir, "docket.json")}: url ${err.message}`, { cause: err });
      }
    }
  } else {
    const url = args.url || extractUrl(args.ask);
    const items = buildQuestions(bench, args.ask, { url });
    const heuristic = heuristicAnswers(bench, args.ask, { url });
    let answers = heuristic;
    let source = "heuristic";
    let jevNote = null;
    let filled = [];
    if (args.jev) {
      const escalate = args.escalate ?? (args.hook ? 0.0 : 0.7);
      const timeoutMs = hookDeadline ? Math.min(HOOK_JEV_MS, hookDeadline - Date.now() - 1_500) : 40_000;
      const res =
        timeoutMs > 1_000
          ? await askJev(items, { escalate, timeoutMs })
          : { reason: "no time left in the hook's budget" };
      if (res.answers) {
        ({ answers, filled } = mergeAnswers(res.answers, heuristic));
        source = `${escalate > 0 ? "jev+cascade" : "jev"}${filled.length ? "+heuristic" : ""}`;
        jevNote = { ...res.summary, unanswered: res.unanswered || [] };
      } else jevNote = { error: res.reason };
    }
    // A named path only counts when it is on disk, and it counts BEFORE the decision: a code gate on a typo is a false
    // red, and prose like "sign-in/sign-up" used to convene the Architect repo-wide before this filter ran.
    const paths = extractPaths(args.ask).filter((p) => existsSync(path.join(ROOT, p)));
    docket = decideDocket({
      bench,
      ask: args.ask,
      url,
      answers,
      source,
      surfaces: loadSurfaces(ROOT),
      forcedScope: args.scope ?? null,
      paths,
    });
    docket.jev = jevNote;
    if (filled.length) docket.heuristicFilled = filled;
    docket.answers = answers;
    if (!samePath(ROOT, ENGINE_ROOT)) {
      docket.root = ROOT;
      docket.bench = { file: bench.file, filtered: bench.filtered || [] };
    }
    docketDir = path.resolve(args.out || path.join(ROOT, "tmp", "dredd", stamp()));
    mkdirSync(docketDir, { recursive: true });
    // Who asked and through which door: the lane records every new docket under this id, and the lane's reflection
    // finds a chat's dockets by its session (lib/lane-record.mjs).
    docket.id = path.basename(docketDir);
    docket.mode = args.hook ? "hook" : args.hearing ? "hearing" : args.convene ? "convene" : process.env.DREDD_DOOR || "docket";
    const session = sessionOf();
    if (session) docket.session = session;
    docket.engine = ENGINE_DIR;
    // A review or complaint about code gets the depth dial's reading of the uncommitted work, so the agent that seats
    // the reviewers knows the cap. Never fatal: a repo git cannot read, or a hook short of time, files without it.
    if (wantsReviewDepth(docket)) {
      // In the hook the dial gets at most 1.5 s, and never the last second before the deadline recall and printing need;
      // under 300 ms left it is skipped and says so, like Jev above.
      const deadline = hookDeadline ? hookDeadline - 1_000 : null;
      const timeoutMs = deadline ? Math.min(1_500, deadline - Date.now()) : 5_000;
      if (timeoutMs < 300) docket.reviewDepthError = "no time left in the hook's budget";
      else
        try {
          const diff = measureDiff(ROOT, { timeoutMs, deadline: deadline && Date.now() + timeoutMs });
          docket.reviewDepth = { ...depthFor(diff), base: "HEAD", scope: scopeBlock({ root: ROOT }) };
          if (docket.root) docket.reviewDepth.root = docket.root;
        } catch (err) {
          docket.reviewDepthError = String(err?.message || err).slice(0, 200);
        }
    }
    if (round) applyRound(docket, docketDir, round, path.resolve(args.roundFile));
    isNew = true;
  }
  docket.created = docket.created || new Date().toISOString();
  // Every new docket is one run on the lane, recorded the moment it exists, before any convene or hearing: one that
  // throws or is stopped still counts and is still asked about. --convene, --collect and --hearing with --docket re-run
  // a docket that was recorded when it was filed. The outcome is written into the docket, so a machine with no lane,
  // or an append that failed, shows there.
  if (isNew) docket.laneRecord = recordDocket(docket, docketDir, { mode: docket.mode, engineRoot: ENGINE_ROOT, root: ROOT, bench });
  // --hearing convenes first unless every instrument the docket names has already landed a result - read from
  // convene.jsonl (via planFor), not from "docket.results is empty": a process killed mid-convene (SUE's refusal
  // poll runs up to ~90 s) left docket.results empty but convene.jsonl holding what had already landed, and the old
  // "results is empty" check re-ran the whole thing from scratch, sending a second Sue over a visit whose first was
  // still in flight (the MiroFish review, 2026-09-23). convene() itself does the actual keeping/re-attaching.
  // --run: the field is the finished runs, adopted as the docket's results. Nothing convenes, so the hearing collects them
  // and the room rules on what they found (lib/claim-rulings.mjs). A new docket only: a resumed one keeps its own field.
  // SUE files every run in this checkout, whatever repository --root judges, and the rulings read them from here too.
  if (args.run && !args.docket) {
    docket.convene = [];
    docket.results = adoptRuns(ENGINE_ROOT, args.run);
    docket.adopted = args.run;
    if (field) docket.field = field;
    const domain = adoptedDomain(docket.domain, docket.url);
    if (domain !== docket.domain) Object.assign(docket, { domain, matter: matterFor(domain) });
    args.convene = false;
    process.stdout.write(`adopted ${docket.results.map((r) => `${r.id} ${r.runId}`).join(", ")}: the room rules on their findings, nothing is launched\n`);
  }
  if (args.hearing) {
    const resumeCheck = planFor(docket, docketDir);
    if (resumeCheck.toRun.length || Object.keys(resumeCheck.reattach).length || Object.keys(resumeCheck.stillLaunching).length) args.convene = true;
  }
  // A page matter with no page is refused BEFORE anything convenes: the room would judge the ask's words and the critic
  // could not sit (lib/docket.mjs, pageMissing). --no-page is the page that does not exist yet, and the docket says so.
  if (docket.page?.missing && args.noPage) docket.page = { ...docket.page, missing: false, waived: "--no-page" };
  if (docket.page?.missing && (args.convene || args.collect || args.resolve)) {
    process.stderr.write(`dredd: ${noPageLines(docket).join("\n")}\n`);
    process.exit(2);
  }

  // Recall + peers share ONE local-MCP process. The hook cannot afford its five seconds, so it recalls nothing: the MCP
  // the chat is already running prints the memories beside the docket (dredd_hook, lib/hook-recall.mjs).
  let mcp = null;
  // Closed on every way out, a throw included (see the entry point below): an unclosed MCP child keeps this process
  // alive forever, and a detached hearing that threw sat hidden with its loader for good (found 2026-09-23).
  const trackMcp = (m) => (openMcp = m);
  const wantLane = args.recall && !args.hook;
  const wantPeers = args.peers && !args.hook;
  // What Connections already has for the ask (tools, scripts, endpoints, connectors): one catalog search on the same MCP.
  const wantCatalog = args.catalog && !args.hook;
  // An instrument that declares a vault `instance` (the bill, SUE's mailroom) runs through the local MCP's shell with
  // credentials minted for that account, so convening one opens the MCP too. Only SUE opened it until 2026-09-23, which
  // left the bill running bare and answering AccessDenied.
  const wantVault =
    args.convene &&
    (docket.convene || []).some((c) => !args.skip.includes(c.id) && vaultInstanceFor(bench.instruments.find((i) => i.id === c.id)));
  // A docket that casts SUE's visitors reads their built-in bodies from Connections through the same MCP.
  const wantCast = !args.hook && docket.cast === undefined && (castWanted(docket) || presueWanted(docket));
  if (wantLane || wantPeers || wantCatalog || args.announce || wantVault || wantCast) {
    try {
      // The loader is Connections' own (it lives in the engine's checkout); the workspace it binds is the repo judged.
      mcp = trackMcp(await openLocalMcp({ root: ROOT, loaderRoot: targetRoot(), timeoutMs: 25_000 }));
    } catch (err) {
      docket.mcpError = String(err?.message || err).slice(0, 200);
    }
  }
  if (args.recall) {
    let rows = [];
    let sourceNote = "";
    if (mcp && wantLane) {
      // One query per facet (the ask's sentences, the page, each named path), merged: a single query on the whole ask,
      // cut at 500 characters, missed memories about the page or a path the ask only named in passing.
      const facets = docketFacets({ ask: docket.ask, url: docket.url, paths: docket.paths || [] });
      rows = await recallFacets(mcp, facets);
      if (rows.length) sourceNote = `memory lane, pgvector cosine over ${facets.length} facet(s)`;
      else {
        // Nothing merged: ask once on the whole ask, so a lane that is down says so instead of reading "none matched".
        const lane = await recallLane(mcp, docket.ask);
        rows = lane.rows;
        sourceNote = lane.ok ? "memory lane, pgvector cosine" : `lane failed: ${lane.error}`;
      }
    } else if (wantLane && docket.mcpError) sourceNote = `lane unavailable: ${docket.mcpError}`;
    if (args.hook) docket.memoriesBeside = true;
    else {
      delete docket.memoriesBeside;
      docket.memories = rows;
      docket.memorySource = sourceNote;
    }
  }
  if (mcp && wantPeers) docket.peers = await readPeers(mcp, { ask: docket.ask });
  if (mcp && wantCatalog) docket.connections = await catalogFor(mcp, docket);
  // Who SUE sends is cast from the ask and the page before anything convenes (lib/visitors.mjs), so a docket-only run
  // shows it and SUE's args file carries it. The hook has no time for a page read and a model call: a docket it filed
  // is cast when it is convened.
  if (wantCast) {
    // A visitor borrows one of SUE's built-in bodies, and every Sue person lives in Connections: read them first.
    const bodies = await readyCastBodies(mcp);
    // This workspace's own websites, read once for the docket (sue/lib/owned-sites.mjs): a site only the list owns is the owners'.
    const ownedHosts = bodies.ok ? (await fetchOwnedSites(ownedSitesDoorOf(mcp))).hosts : [];
    // Pre-sue first (the Chair, 2026-10-05): Jev picks the saved people who really visit this page, the missing kinds are
    // drafted and saved for the next hearing. A docket it cannot pre-sue is cast from the ask and the page as before.
    const pre = bodies.ok && presueWanted(docket) ? await presueForDocket(docket, { mcp, docketDir }) : null;
    if (pre?.error) docket.presueError = pre.error;
    docket.cast = bodies.ok
      ? pre && !pre.error
        ? pre
        : await castForDocket(docket, { docketDir, ownedHosts })
      : {
          visitors: [],
          source: "none",
          why: "SUE's people could not be read from Connections",
          page: { error: "not read" },
          error: bodies.why,
        };
  }

  // An unattended hearing that will send paid visitors first proves one model answers with structure: the room used to
  // fail only after SUE had spent (a night of dead keys went unseen). One free call, tried twice, before anything runs.
  const sendsSue = args.convene && (docket.convene || []).some((c) => c.id === "sue") && !args.skip.includes("sue");
  if (args.hearing && sendsSue && process.env.DREDD_PREFLIGHT !== "0") {
    // The docket is on disk, marked at the preflight, BEFORE the call: a hearing that dies here used to leave a folder with
    // logs and no docket.json, so --status read "convening" forever and a resume died ENOENT (2026-09-28). Now the resume
    // (--hearing --docket <dir>) reads the ask, the cast and the page it already paid for, and --status names the death.
    // The pid names who set the mark: a mark still unset once that process is gone died mid-preflight.
    docket.preflight = { at: new Date().toISOString(), ok: null, pid: process.pid, host: os.hostname() };
    writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
    const pf = await brainPreflight();
    docket.preflight = {
      ...docket.preflight,
      ok: Boolean(pf.ok),
      ...(pf.ok ? {} : { error: pf.error || "no answer", model: pf.model || null }),
    };
    if (!pf.ok) {
      writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
      process.stderr.write(
        `dredd: no model answered with structure (${pf.error || "no answer"}${pf.model ? `, ${pf.model}` : ""}) - the room could not sit after SUE had spent. Fix the brain (node dredd/dredd.mjs --doctor), or DREDD_PREFLIGHT=0 to send her anyway; then resume this docket with --hearing --docket ${docketDir}.\n`,
      );
      if (mcp) await mcp.close();
      process.exit(2);
    }
  }
  if (args.convene) {
    // The board reads docket.json for the ask, the memories and the fact logs, so it is on disk BEFORE
    // anything is convened (and rewritten with the results after).
    writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
    // --skip a,b leaves an instrument on the docket (the decision stands) but does not run it this time.
    if (args.skip.length) {
      docket.skipped = args.skip;
      docket.convene = docket.convene.filter((c) => !args.skip.includes(c.id));
    }
    // A chat convening starts SUE's visitors on its own Sonnet 5.5 agents (the SUE tier); an unattended hearing cannot,
    // unless the chat that launched it says it will drive them (--chat): then the whole tribunal sits - the visitors'
    // briefs wait for the chat's agents while the hearing waits for their reports, and the room sits over those too
    // (the Chair, 2026-09-25: "Dredd should also pretty much always work with Sue and the Boardroom").
    docket.results = await convene({ root: ROOT, dredd, docket, bench, docketDir, mcp, chat: !args.hearing || args.chat });
    if (mcp && args.announce) {
      const a = await announce(mcp, docket, docketDir);
      docket.announced = a.ok ? "posted to the team board" : `announce failed: ${a.text.slice(0, 120)}`;
    }
  }
  if (args.hearing || args.resolve) {
    writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
    const say = (line) => {
      if (!args.json && !args.hook) process.stdout.write(`${line}\n`);
    };
    // A resumed hearing whose field had landed and whose room had sat goes straight to the resolution loop: waiting,
    // collecting and a second Jev seat pick over the same evidence each booked another call for nothing.
    const prior = args.docket ? readJson(path.join(docketDir, "hearing.json")) : null;
    const resumeAtResolve = args.hearing && !args.resolve && mayResumeAtResolve(prior);
    if (resumeAtResolve) say(`resuming at the resolution loop: the field had landed and the room had sat before this hearing stopped`);
    try {
      docket.hearing = await hearing({
        root: ROOT,
        engineDir: ENGINE_DIR,
        seatsDir,
        inventory: loadInventory(ROOT),
        docket,
        docketDir,
        waitMs: args.wait * 60_000,
        untilHappy: args.untilHappy,
        happyAt: args.happyAt,
        jev: args.jev,
        resolveOnly: (args.resolve && !args.hearing) || resumeAtResolve,
        say,
      });
    } catch (err) {
      // A hearing that throws still files: hearing.json says failed and where, verdict.md is a labelled partial record
      // with the one command that resumes. It used to leave the owner nothing but a stack trace.
      const file = path.join(docketDir, "hearing.json");
      const H = {
        ...(readJson(file) || {}),
        state: "failed",
        error: String(err?.message || err).slice(0, 500),
        finishedAt: new Date().toISOString(),
        docketDir,
      };
      writeFileSync(file, JSON.stringify(H, null, 2));
      writeFileSync(path.join(docketDir, "verdict.md"), `${renderFailureVerdict({ ...docket, docketDir }, H, err)}\n`);
      throw err;
    }
  }
  if (args.collect) {
    const second = await collect({ root: ROOT, engineDir: ENGINE_DIR, docket, docketDir });
    docket.collected = [...(docket.collected || []), { at: new Date().toISOString(), results: second }];
    docket.results = [...(docket.results || []).filter((r) => !second.some((s) => s.id === r.id)), ...second];
  }
  if (mcp) await mcp.close();
  openMcp = null;

  // The depth dial prints under the docket, not inside renderDocket: lib/docket.mjs is a decision file (A/B owed), and
  // the dial changes who reviews, not what convenes.
  const depthText = (compact) =>
    `${docket.reviewDepth ? `\n${renderDepth(docket.reviewDepth, { compact, block: compact ? null : docket.reviewDepth.scope })}` : ""}${
      docket.cast ? `\n${renderCast(docket.cast)}` : ""
    }${docket.field?.lines?.length ? `\nFIELD (the run that gathered these claims)\n${docket.field.lines.join("\n")}` : ""}`;
  const text = `${renderDocket(docket, bench, { compact: args.hook, docketDir, dredd })}${depthText(args.hook)}`;
  writeFileSync(path.join(docketDir, "docket.json"), JSON.stringify(docket, null, 2));
  writeFileSync(
    path.join(docketDir, "docket.md"),
    `# Dredd docket\n\n${docket.ask}\n\n\`\`\`\n${renderDocket(docket, bench, { docketDir, dredd })}${depthText(false)}\n\`\`\`\n`,
  );
  if (args.json) process.stdout.write(`${JSON.stringify(docket, null, 2)}\n`);
  else if (args.hook) process.stdout.write(`<dredd-docket>\n${text}\n</dredd-docket>\n`);
  else process.stdout.write(`${text}\n`);
}

/** Where a docket id lives: a path to its folder, or <root>/tmp/dredd/<id> under the judged repo or the engine's own. */
export function findDocketDir(id, roots) {
  const given = path.resolve(String(id));
  if (existsSync(path.join(given, "docket.json"))) return given;
  for (const r of roots) {
    const dir = path.join(r, "tmp", "dredd", path.basename(String(id)));
    if (existsSync(path.join(dir, "docket.json"))) return dir;
  }
  return null;
}

/**
 * --rate: the chat that received a docket says whether each convened instrument was the right call (lib/verdict.mjs),
 * the lane gets the scores (lib/lane-record.mjs), the docket keeps the rating, and a docket that convened something
 * wrong or missed an instrument becomes eval/verdicts/v-<id>.json, which `eval.mjs --verdicts` grades Dredd against.
 * Re-rating overwrites: the lane keeps one score per chat per row, the latest.
 */
function rateDocket(args, { root, bench }) {
  const dir = findDocketDir(args.rate, [root, ENGINE_ROOT]);
  if (!dir) throw new UsageError(`--rate ${args.rate}: no docket by that id under ${path.join(root, "tmp", "dredd")}`);
  const file = path.join(dir, "docket.json");
  const docket = JSON.parse(readFileSync(file, "utf8"));
  docket.id = docket.id || path.basename(dir);
  let rating;
  try {
    rating = checkRating(
      docket,
      args.rating,
      bench.instruments.map((i) => i.id),
      { classes: Object.keys(ASK_CLASSES), domains: Object.keys(DOMAINS) },
    );
  } catch (err) {
    if (!err.problems) throw err;
    throw new UsageError(`--rate ${docket.id} refused:\n  ${err.problems.join("\n  ")}`);
  }
  const row = goldRowFor(docket, rating);
  const vdir = process.env.DREDD_VERDICTS_DIR || path.join(ENGINE_DIR, "eval", "verdicts");
  let verdictFile = null;
  let withdrawn = false;
  if (row) {
    mkdirSync(vdir, { recursive: true });
    verdictFile = path.join(vdir, `${row.id}.json`);
    writeFileSync(verdictFile, `${JSON.stringify(row, null, 2)}\n`);
  } else {
    // A re-rate that finds nothing wrong takes back the row an earlier rating of this docket wrote: the eval must not
    // keep failing Dredd on a label its own chat retracted.
    const stale = path.join(vdir, `v-${docket.id}.json`);
    if (existsSync(stale)) {
      rmSync(stale);
      withdrawn = true;
    }
  }
  const lane = recordRating(docket, rating, { engineRoot: ENGINE_ROOT, root: docket.root || root });
  const again = Boolean(docket.rating);
  docket.rating = { ...rating, at: new Date().toISOString(), session: sessionOf() || null, lane, verdictFile };
  writeFileSync(file, JSON.stringify(docket, null, 2));
  const priceFeedback = priceFeedbackFor({ docket, rating, docketDir: dir, root: docket.root || root });
  const counts = Object.values(rating.choices).reduce((m, c) => ({ ...m, [c]: (m[c] || 0) + 1 }), {});
  const lines = [
    `${again ? "Re-rated" : "Rated"} docket ${docket.id} (${docket.class} · ${docket.domain}): ${rating.score}/5 ${rating.verdict}`,
    `  choices: ${
      Object.entries(counts)
        .map(([c, n]) => `${n} ${c}`)
        .join(", ") || "nothing was convened"
    }${rating.missed.length ? ` · missed ${rating.missed.join(", ")}` : ""}${rating.missingTool ? ` · missing tool: ${rating.missingTool}` : ""}`,
    `  lane: ${lane}`,
    verdictFile
      ? `  verdict row: ${path.relative(ENGINE_ROOT, verdictFile).replace(/\\/g, "/")} - node dredd/eval.mjs --verdicts grades Dredd against it`
      : withdrawn
        ? `  verdict row withdrawn: this rating finds nothing wrong, so v-${docket.id}.json is gone`
        : "  no verdict row: nothing convened was wrong and nothing was missed",
  ];
  if (priceFeedback && !priceFeedback.ok) lines.push(`  pricecheck feedback not sent (the rating stands): ${priceFeedback.why}`);
  return { docket: docket.id, rating: docket.rating, verdictRow: row, lines };
}

/**
 * --rule-fix: the fix of a bug docket is ruled verified, partial or failed (lib/bug.mjs), never a free-text "fixed".
 * Verified needs the original repro re-run with the symptom gone; green tests with the repro not re-run rule partial.
 * The ruling is kept in docket.json as `fix`; a re-rule overwrites it, and `fix.history` keeps the earlier verdicts.
 */
function ruleFixDocket(args, { root }) {
  const dir = findDocketDir(args.ruleFix, [root, ENGINE_ROOT]);
  if (!dir) throw new UsageError(`--rule-fix ${args.ruleFix}: no docket by that id under ${path.join(root, "tmp", "dredd")}`);
  const file = path.join(dir, "docket.json");
  const docket = JSON.parse(readFileSync(file, "utf8"));
  docket.id = docket.id || path.basename(dir);
  const { reproFile, reproCheck, ...typed } = args.fix;
  const ran = reproFile || reproCheck ? runFixRepro({ reproFile, reproCheck, typed }) : null;
  let ruling;
  try {
    ruling = ruleFix(ran ? { ...typed, repro: ran.repro, reproResult: ran.reproResult } : typed);
  } catch (err) {
    if (!err.problems) throw err;
    throw new UsageError(`--rule-fix ${docket.id} refused:\n  ${err.problems.join("\n  ")}`);
  }
  const history = docket.fix ? [...(docket.fix.history || []), { verdict: docket.fix.verdict, at: docket.fix.at }] : [];
  docket.fix = {
    ...ruling,
    ...(ran ? { executed: ran.executed } : {}),
    at: new Date().toISOString(),
    session: sessionOf() || null,
    ...(history.length ? { history } : {}),
  };
  writeFileSync(file, JSON.stringify(docket, null, 2));
  const lines = [
    `Fix of docket ${docket.id} ruled ${ruling.verdict.toUpperCase()}: ${ruling.why}`,
    ...(ran ? [`  the repro ran: ${ran.executed.result}${ran.executed.why ? ` - ${ran.executed.why}` : ""}`] : []),
    ...(ran?.executed.result === "broken-test"
      ? ["  it counts as not run: fix the repro so only its assertion can fail, and rule again"]
      : []),
    ...(ruling.downgraded ? ["  green tests alone never verify a bug fix: re-run the original repro and rule again"] : []),
    ...(docket.bug ? [] : ["  (Dredd did not read this docket as a bug complaint; ruled on the same ladder anyway)"]),
    ...(docket.bug?.repro && ruling.reproResult !== "not-run" ? [`  the repro the docket heard: "${docket.bug.repro}"`] : []),
  ];
  return { docket: docket.id, fix: docket.fix, lines };
}

/**
 * Run the repro a --rule-fix names instead of typing its result: --repro-file through sue/repro.mjs run (a
 * repro drives Chromium, so under node even when Dredd runs under bun), --repro-check as a shell command in the
 * current folder (exit 0 = gone). Returns lib/bug.mjs executedRepro's { repro, reproResult, executed }.
 */
function runFixRepro({ reproFile, reproCheck, typed }) {
  if (reproFile && reproCheck) throw new UsageError("--repro-file and --repro-check are two repros: give one");
  if (typed.repro !== undefined || typed.reproResult !== undefined)
    throw new UsageError("--repro-file and --repro-check set the repro and its result from the run: drop --repro and --repro-result");
  if (reproCheck) {
    const r = spawnSync(reproCheck, { shell: true, cwd: process.cwd(), encoding: "utf8", timeout: 600_000, windowsHide: true });
    if (r.error && r.error.code !== "ETIMEDOUT") throw new UsageError(`--repro-check could not start: ${r.error.message}`);
    const why = r.error ? "it timed out after 600 s" : `it exited ${r.status ?? r.signal}`;
    return executedRepro({ form: "check", target: reproCheck, result: r.status === 0 ? "gone" : "still", why });
  }
  const runner = fileURLToPath(new URL("../sue/repro.mjs", import.meta.url));
  const target = path.resolve(reproFile);
  const node = process.versions.bun ? "node" : process.execPath;
  const r = spawnSync(node, [runner, "run", target, "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, windowsHide: true });
  const last = String(r.stdout || "")
    .trim()
    .split(/\r?\n/)
    .pop();
  let got;
  try {
    got = JSON.parse(last);
  } catch {
    throw new UsageError(
      `--repro-file ${target}: sue/repro.mjs run said nothing readable (exit ${r.status}): ${String(r.stderr || "").trim()}`,
    );
  }
  return executedRepro({ form: "file", target, result: got.result, why: got.why });
}

// Run only as the program, so the tests can import parseArgs without convening anything.
if (isMainModule(import.meta.url))
  main()
    .catch((err) => {
      process.stderr.write(`dredd: ${err?.stack || err}\n`);
      process.exitCode = 1;
    })
    .finally(async () => {
      closeBrain();
      if (openMcp) await openMcp.close().catch(() => {});
    });
