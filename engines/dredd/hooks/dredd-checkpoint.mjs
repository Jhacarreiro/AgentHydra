#!/usr/bin/env node
/**
 * dredd/hooks/dredd-checkpoint.mjs - PostToolUse (Bash, PowerShell, the Connections MCP shell) hook: once in a while, after a change
 * that people will SEE lands, Dredd reads what landed and says which instruments deserve a look at it.
 *
 * Owner ask (the Chair, 2026-09-23): "dredd should generally... (not every damn change obviously) wired in to be run
 * occasionally over things to help make decisions while things run." The prompt hook (dredd-docket.mjs) only fires
 * when the OWNER speaks a complaint, a review or a decision; a session that ships twenty changes on its own never
 * hears from the judge. This is the other half: the session's own landings, sampled.
 *
 * ⛔ NOT EVERY CHANGE, by construction - all four must hold, or it stays silent:
 *   1. the command landed something (`bun run save` / land.py) and HEAD moved since this hook last looked;
 *   2. the landed commit touches a surface a person sees or a decision Dredd makes (checkpointWorthy below) - a test,
 *      a script, a doc or plumbing alone never fires;
 *   3. at least DREDD_CHECKPOINT_MINUTES (default 90) since this session's last checkpoint;
 *   4. fewer than DREDD_CHECKPOINT_MAX (default 4) checkpoints this session.
 * Then `dredd.mjs --hook` (Jev on a 4.5 s share, keywords when slow - the same budget as the prompt hook) decides the
 * docket for "review what just landed", and a landing that touched Dredd's own decision files also gets the A/B line
 * its RSI rule owes (.claude/rules/dredd-self-improvement.md). It never blocks: it adds context and moves on.
 * Fails OPEN on every error. Per-machine off switch: the project's .claude/hooks-off.local, read by its wiring line.
 *
 * Moved here from Connections' .claude/hooks/dredd-checkpoint.mjs (2026-10-15, Sue and Dredd off Connections). It still
 * judges the target's landings (targets/<name>.json: ROOT is the target's checkout, the plane map and the tool-command
 * reader are the target's own files); the project wires it with a thin line that finds this checkout (Connections:
 * .claude/hooks/sue-dredd-hook.mjs), so a machine without sue-dredd hears nothing.
 *
 * ★ A UI LANDING CONVENES THE DESIGN CRITIC, IT DOES NOT ONLY SUGGEST IT (burnout audit 2026-09-24, item 4, "Taste
 * Eye"). Printed advice was measured and it did not work: across 163 dockets the docket named the critic 6 times and
 * none of those 6 docket folders ever held a critic artifact. So when the landing touched a plane's web app, the kit or
 * the buyer flow, this hook picks at most three roster surfaces that show it (critiqueSurfaces) and starts the critic's
 * capture itself - the wave's named ad-hoc door (tmp/design-critic/adhoc/checkpoint-<sha>/, never the roster's
 * artifacts, shots or baseline, so a fleet run in flight is untouched), detached, hidden and under fairjob - and tells
 * the session the two commands that score what it photographs. Scoring stays in the session on purpose: the judge is
 * the in-session model, never a subprocess (owner, 2026-08-08). Same throttle as the docket (it only runs when a
 * checkpoint fires), one capture at a time per machine, and never inside a sub-agent: a builder writes code and the
 * product is checked once at the end (owner, the Chair, 2026-09-25). What the critic is calibrated against is the owner's
 * own corrections: .arkitect/readiness/design-critic-taste-set.json, scored by scripts/audit/design-critic-taste-eye.mjs.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";

const TARGET = loadTarget();
const ROOT = targetRoot();
const { PLANE_SOURCE_DIRS } = await import(pathToFileURL(targetPath(TARGET.planeSourceDirs)).href);
const { toolCommand } = await import(pathToFileURL(targetPath(TARGET.toolCommandHook)).href);
const DREDD = fileURLToPath(new URL("../dredd.mjs", import.meta.url));

/** A command that lands work on trunk: this repo's one landing door (AGENTS.md: `bun run save`, or land.py itself). */
export function isLandingCommand(command) {
  return /\bbun run save\b|\bland\.py\b/.test(String(command || ""));
}

/** The surfaces a person sees, and the judge's own decisions: the only landings worth a docket. */
const WORTHY = [
  /^services\/[^/]+\/web\//,
  /^packages\/connections-(?:ui|components|explore)\/src\//,
  /^infra\/shared\/pay\/buyer\//,
  /^infra\/shared\/(?:first-party-products|plane-capabilities)\.json$/,
  /^services\/[^/]+\/lambda\/src\/email-templates\//,
  /^infra\/shared\/email\/fleet-templates\//,
  /^docs\/strategy\//,
  /^dredd\/(?:bench\.json|lib\/(?:claim-routing|docket|ladder|pipeline|seats)\.mjs|seats\/)/,
];
const NEVER = /(?:^|\/)(?:tests?|__tests__|fixtures)\/|\.(?:spec|test)\.[cm]?[jt]sx?$|\.md$/;

/** The `Landed-By-Session:` trailer land.py writes for a session (its session_stamp: sha256 of the id, 16 hex). */
export function sessionStamp(sessionId) {
  const raw = String(sessionId || "").trim();
  return raw ? createHash("sha256").update(raw).digest("hex").slice(0, 16) : "";
}

const FRESH_MS = 5 * 60 * 1000;

/**
 * Which commit, of the ones HEAD now shows (newest first: { sha, at, stamp }), this session just landed - or null.
 * A save fast-forwards the checkout to origin's tip, and that tip can be a PEER's fresh commit: on 2026-09-27 a save
 * whose own land was refused moved HEAD to the Chair's 190550d154, and this hook credited it to the session, whose
 * closer then demanded a deploy of work it never touched. So a stamped commit counts only when the stamp is this
 * session's; an UNSTAMPED fresh HEAD (a land from outside an agent session) keeps the old reading. Pure.
 */
export function ownLanding(commits, stamp, now) {
  const fresh = (commits || []).filter((c) => c && now - c.at < FRESH_MS);
  if (stamp) {
    const own = fresh.find((c) => c.stamp === stamp);
    if (own) return own.sha;
  }
  const head = (commits || [])[0];
  return head && !head.stamp && now - head.at < FRESH_MS ? head.sha : null;
}

// A changed line that cannot move a pixel: blank, a `//` or `/* */` line, a JSDoc `* ...` continuation
// (never one carrying `{`, `}` or `;`, so CSS's `* { ... }` still renders), or an HTML comment marker.
const COMMENT_ONLY_LINE = /^\s*$|^\s*(?:\/\/|\/\*|\*\/|<!--|-->)|^\s*\*(?:\s[^{};]*)?$/;

/**
 * The paths whose landed diff (`diffOf(path)`, the `git show -U0` text) changes a line that can render.
 * A comment-only edit cannot change a photograph, so it never convenes the critic (2026-09-28: a land
 * that re-worded two code comments booted the dev servers to photograph byte-identical pages). A path
 * with no readable diff, or one line that is not provably a comment, stays in - the safe direction.
 */
export function renderingChanges(paths, diffOf) {
  return paths.filter((p) => {
    const changed = String(diffOf(p) || "")
      .split(/\r?\n/)
      .filter((line) => /^[-+]/.test(line) && !/^(?:---|\+\+\+) /.test(line))
      .map((line) => line.slice(1));
    return !changed.length || changed.some((line) => !COMMENT_ONLY_LINE.test(line));
  });
}

/** The landed paths that earn a checkpoint (empty = stay silent). */
export function checkpointWorthy(paths) {
  return paths.map((p) => String(p).replace(/\\/g, "/")).filter((p) => !NEVER.test(p) && WORTHY.some((rx) => rx.test(p)));
}

/** Dredd's own decision files among the landed paths (lib/hunt.mjs DECISION_PATHS, kept in step by tests/rsi.spec.mjs). A
 *  landing in this checkout that changes how Dredd decides is worth a docket, so WORTHY names them too. */
export function decisionFilesIn(paths) {
  return paths.filter((p) => /^dredd\/(?:bench\.json|lib\/(?:claim-routing|docket|ladder|pipeline|seats)\.mjs|seats\/)/.test(String(p).replace(/\\/g, "/")));
}

/** Is a checkpoint due? Pure: `state` is this session's { lastAt, fired }. */
export function checkpointDue(state, now, { everyMin = 90, max = 4 } = {}) {
  if ((state?.fired || 0) >= max) return false;
  return !state?.lastAt || now - state.lastAt >= everyMin * 60 * 1000;
}

/**
 * The ask Dredd judges: the landing in the owner's register, so Jev reads it as a review of a thing that exists. It
 * names the landed commit because review.mjs reads it from the docket: after the land origin/main already holds the
 * commit, so only `<sha>~1..<sha>` shows the change (sue-dredd: dredd/lib/review.mjs reviewRange).
 */
export function checkpointAsk(subject, worthy, sha) {
  const shown = worthy.slice(0, 6).join(", ");
  return `review what just landed in ${String(sha).slice(0, 10)}: "${String(subject).slice(0, 160)}" - ${worthy.length} file(s) people see: ${shown}${worthy.length > 6 ? ` and ${worthy.length - 6} more` : ""}`;
}

/** The planes a landing touched (`services/<plane>/...`), and which of them carry code that only a deploy makes live. */
export function landedPlanes(paths) {
  const planes = new Set();
  const deployable = new Set();
  for (const p of paths.map((x) => String(x).replace(/\\/g, "/"))) {
    const m = /^services\/([^/]+)\/(lambda|web|api|infra)?/.exec(p);
    if (!m) continue;
    planes.add(m[1]);
    if (m[2] && !NEVER.test(p)) deployable.add(m[1]);
  }
  return { planes: [...planes].sort(), deployable: [...deployable].sort() };
}

/** A plane's web directory -> the plane id the design critic's roster uses (the launcher calls main "connections"). */
const WEB_DIR_PLANE = Object.fromEntries(
  Object.entries(PLANE_SOURCE_DIRS).map(([launcher, dir]) => [dir, launcher === "connections" ? "main" : launcher]),
);
const KIT = /^packages\/connections-(?:ui|components|explore)\/src\//;
const BUYER = /^infra\/shared\/pay\/buyer\//;
/** Path words that name the layer, not the page ("infra/shared/pay/buyer/UsageDetailsView.vue" says "usage details"). */
const PATH_NOISE = new Set(
  "services web src app views view components component pages page lib shared packages connections infra buyer vue mjs css index spec test the and".split(
    " ",
  ),
);
const wordsOf = (text) =>
  new Set(
    (
      String(text || "")
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        .toLowerCase()
        .match(/[a-z][a-z0-9]{2,}/g) || []
    ).filter((w) => !PATH_NOISE.has(w)),
  );

/** The roster planes a landed path is seen on: its own plane's web app, the buyer flow (pay and checkout), the kit (every
 *  plane, so Main - the plane with the most roster surfaces and the first to render a kit change). */
function critiquePlanesOf(p) {
  const web = /^(services\/[^/]+\/web)\//.exec(p);
  if (web) return WEB_DIR_PLANE[web[1]] ? [WEB_DIR_PLANE[web[1]]] : [];
  if (BUYER.test(p)) return ["pay", "checkout"];
  if (KIT.test(p)) return ["main"];
  return [];
}

/**
 * The roster surfaces the Design Critic photographs for a landing (empty = nothing a still frame can show: an email
 * template, the product catalog, a strategy doc, Dredd's own files). Per plane the landed file names rank the plane's
 * surfaces by shared words (WordsProgressView.vue -> learn-words-progress), the plane's landing route breaks a tie, and
 * the planes take turns so one landing across three planes shows each. A route with a required `:param` needs a record
 * the ad-hoc door cannot invent, so it is left to the roster's own fleet run; an optional one (`/trial/:code?`) is
 * photographed without it. Each pick carries its ad-hoc spec (`<plane>:</route>`, `:public` for a surface the roster
 * declares signed out). The before/after runner's selectSurfacesForChangedFiles answers a different question on
 * purpose: it picks EVERY surface a change could have moved, which is right for diffing shots already on disk and
 * wrong for a capture that costs a browser per surface, so this ranks and caps instead.
 */
export function critiqueSurfaces(paths, surfaces, { limit = 3 } = {}) {
  const concrete = (route) => {
    const r = String(route ?? "").replace(/\/:[A-Za-z0-9_]+\?/g, "") || "/";
    return typeof route === "string" && !r.includes(":") ? r : null;
  };
  const rows = (Array.isArray(surfaces) ? surfaces : [])
    .filter((s) => s && typeof s.id === "string" && !s.id.startsWith("$") && concrete(s.route))
    .map((s) => ({ ...s, route: concrete(s.route) }));
  const byPlane = new Map();
  for (const p of paths.map((x) => String(x).replace(/\\/g, "/")).filter((x) => !NEVER.test(x)))
    for (const plane of critiquePlanesOf(p)) byPlane.set(plane, [...(byPlane.get(plane) || []), p]);
  const queues = [...byPlane]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([plane, planePaths]) => {
      const landed = wordsOf(planePaths.map((p) => p.split("/").slice(3).join(" ")).join(" "));
      return rows
        .map((s, order) => ({ s, order, hits: [...wordsOf(`${s.id} ${s.title || ""} ${s.route}`)].filter((w) => landed.has(w)).length }))
        .filter(({ s }) => (s.plane || "main") === plane)
        .sort((a, b) => b.hits - a.hits || Number(b.s.route === "/") - Number(a.s.route === "/") || a.order - b.order)
        .map(({ s }) => s);
    });
  const picked = [];
  for (let round = 0; picked.length < limit && queues.some((q) => q.length > round); round += 1)
    for (const q of queues) if (q[round] && picked.length < limit && !picked.some((p) => p.id === q[round].id)) picked.push(q[round]);
  return picked.map((s) => ({ id: s.id, spec: `${s.plane || "main"}:${s.route}${s.auth === false ? ":public" : ""}` }));
}

/** The critic's capture for this landing is still running: its log has no verdict line yet and moved recently (the
 *  wave prints `OK - capture=...` or `FAILED stage=...` last, and its shard watchdog kills a capture silent for 10 min). */
export function criticCaptureRunning(logText, logMtimeMs, now, { silentMin = 20 } = {}) {
  if (/OK - capture=|FAILED stage=/.test(String(logText || ""))) return false;
  return now - logMtimeMs < silentMin * 60 * 1000;
}

/**
 * Start the Design Critic's capture of what just landed and say how to score it. Returns the lines for the session.
 * One at a time per machine: a capture still running for an earlier landing wins, and the reply says this one was not
 * photographed rather than queueing it behind a capture nobody may be waiting for.
 */
async function conveneCritic(head, worthy) {
  let policy;
  try {
    policy = JSON.parse(readFileSync(path.join(ROOT, ".arkitect", "policies", "connections", "design-critic-surfaces.json"), "utf8"));
  } catch {
    return [];
  }
  const rendering = renderingChanges(worthy, (p) => git(["show", "-U0", "--format=", head, "--", p]));
  if (worthy.length && !rendering.length) return ["DESIGN CRITIC: not convened - the landed UI files changed only comments, which cannot change a photograph."];
  const picked = critiqueSurfaces(rendering, policy?.surfaces);
  if (!picked.length) return [];
  const dir = path.join(ROOT, "tmp", "design-critic", "checkpoint");
  mkdirSync(dir, { recursive: true });
  const lockFile = path.join(dir, "running.json");
  const held = readState(lockFile);
  if (held.log && existsSync(held.log)) {
    const running = criticCaptureRunning(readFileSync(held.log, "utf8"), statSync(held.log).mtimeMs, Date.now());
    if (running)
      return [
        `DESIGN CRITIC: still photographing ${held.sha} (${(held.surfaces || []).join(", ")}; log ${path.relative(ROOT, held.log).replace(/\\/g, "/")}), and it runs one capture at a time per machine, so this landing (${picked.map((p) => p.id).join(", ")}) was not photographed.`,
      ];
  }
  const name = `checkpoint-${head.slice(0, 10)}`;
  const list = path.join(dir, `${name}.txt`);
  const log = path.join(dir, `${name}.log`);
  writeFileSync(list, `# ${head.slice(0, 10)}: the roster surfaces that show what landed (dredd-checkpoint critiqueSurfaces)\n${picked.map((p) => p.spec).join("\n")}\n`);
  const rel = (p) => path.relative(ROOT, p).replace(/\\/g, "/");
  const { runDetached } = await import("../lib/convene.mjs");
  const launched = runDetached(`node scripts/audit/design-critic-wave.mjs --adhoc-file ${rel(list)} --adhoc-name ${name} --parts 1 --merge`, {
    cwd: ROOT,
    log,
    heavy: true,
  });
  if (!launched.pid) return [`DESIGN CRITIC: the capture of ${picked.map((p) => p.id).join(", ")} did not start (${launched.status}); log ${rel(log)}.`];
  writeFileSync(lockFile, JSON.stringify({ sha: head.slice(0, 10), name, log, surfaces: picked.map((p) => p.id), pid: launched.pid, at: new Date().toISOString() }));
  return [
    `DESIGN CRITIC CONVENED on ${picked.map((p) => p.id).join(", ")} (${launched.status}): it boots its own dev servers and photographs them; log ${rel(log)}.`,
    `When the log's last line reads "OK - capture=ok", score it in this session: \`bun .arkitect/runners/design-critic-judge.mjs --adhoc --adhoc-name ${name}\` (the brief and the PNGs), then \`bun .arkitect/runners/design-critic-judge.mjs --adhoc --adhoc-name ${name} --ingest <scores.json>\`. Verify each finding against the live page before acting on it.`,
  ];
}

/**
 * THE CLOSER'S LEDGER (burnout audit 2026-09-24, item 3): every landing this hook sees is appended to
 * tmp/closer/landed.jsonl - sha, subject, planes, the planes whose change needs a deploy - so the Stop hook
 * closer-claims.mjs can tell a "fixed" backed by a landing from one backed by nothing. Recorded for every landing,
 * worthy or not; the docket below stays sampled.
 */
function recordLanding(event) {
  try {
    const dir = path.join(ROOT, "tmp", "closer");
    mkdirSync(dir, { recursive: true });
    appendFileSync(path.join(dir, "landed.jsonl"), `${JSON.stringify(event)}\n`);
  } catch {
    /* the ledger is a measurement, never a requirement */
  }
}

function git(args) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, timeout: 5_000 });
  return r.status === 0 ? String(r.stdout).trim() : "";
}

function readState(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

/** Read the PostToolUse payload from stdin and print the checkpoint, or nothing. */
export async function main({ stdin = () => readFileSync(0, "utf8") } = {}) {
  let input;
  try {
    input = JSON.parse(stdin());
  } catch {
    return;
  }
  const { command } = toolCommand(input);
  if (!isLandingCommand(command)) return;

  const sessionId = String(input?.session_id ?? "nosession").replace(/[^a-zA-Z0-9_-]/g, "");
  const dir = path.join(tmpdir(), "claude-dredd-checkpoint");
  const file = path.join(dir, `${sessionId}.json`);
  const state = readState(file);
  const head = git(["rev-parse", "HEAD"]);
  if (!head || head === state.lastHead) return; // nothing landed (a refused save leaves HEAD where it was)
  const save = (patch) => {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, JSON.stringify({ ...state, lastHead: head, ...patch }));
    } catch {
      /* the state is a saving, never a requirement */
    }
  };

  const now = Date.now();
  // A session's first sight of HEAD has nothing to compare with: a refused save would read as a landing and the hook
  // would judge whatever a peer landed hours ago. Only a commit made in the last five minutes, stamped by THIS session
  // (or unstamped, on HEAD), is this command's landing - never a peer's commit the save fast-forwarded to.
  const recent = git(["log", "-n", "20", "--format=%H%x1f%cI%x1f%(trailers:key=Landed-By-Session,valueonly,separator=)", head])
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, iso, stamp] = line.split("\x1f");
      return { sha, at: Date.parse(iso || ""), stamp: String(stamp || "").trim() };
    });
  const landed = ownLanding(recent, sessionStamp(input?.session_id), now);
  if (!landed) {
    save({});
    return;
  }
  const shown = git(["show", "--name-only", "--format=%s", landed]).split(/\r?\n/);
  const subject = shown[0] || "";
  const paths = shown.slice(1).filter(Boolean);
  const worthy = checkpointWorthy(paths);
  recordLanding({ at: new Date(now).toISOString(), sessionId, sha: landed, subject: subject.slice(0, 200), files: paths.length, ...landedPlanes(paths) });
  const everyMin = Number(process.env.DREDD_CHECKPOINT_MINUTES) || 90;
  const max = Number(process.env.DREDD_CHECKPOINT_MAX) || 4;
  if (!worthy.length || !checkpointDue(state, now, { everyMin, max })) {
    save({});
    return;
  }
  save({ lastAt: now, fired: (state.fired || 0) + 1 });

  const parts = [
    `<dredd-checkpoint landed="${landed.slice(0, 10)}" note="sampled: at most once every ${everyMin} min, ${max} a session, and only for landings people see - advice, not a gate">`,
  ];
  // Before the docket, so a slow Jev can never cost the capture its launch inside the hook's budget. A sub-agent
  // (Claude Code sends agent_id only inside one) is a builder: it lands code and the product is checked once at the end.
  if (!input?.agent_id) {
    try {
      parts.push(...(await conveneCritic(landed, worthy)));
    } catch (err) {
      parts.push(`DESIGN CRITIC: not convened (${String(err?.message || err).slice(0, 160)}).`);
    }
  }
  const decisions = decisionFilesIn(paths);
  if (decisions.length)
    parts.push(
      `Dredd's own decision files landed (${decisions.join(", ")}). The RSI rule owes an A/B: \`node dredd/ab.mjs --base ${landed.slice(0, 10)}~1 --record\` (free, no model), then \`node dredd/dredd.mjs --hunt\` (both in the sue-dredd checkout) for what to improve next.`,
    );
  if (worthy.length > decisions.length) {
    const r = spawnSync(process.execPath, [DREDD, "--hook", "--no-peers", "--", checkpointAsk(subject, worthy, landed)], {
      cwd: ROOT,
      encoding: "utf8",
      timeout: 9_000,
      windowsHide: true,
    });
    if (r.status === 0 && r.stdout.trim()) parts.push(r.stdout.trim());
  }
  parts.push("If the docket names another instrument worth its cost for this change, convene it now (it runs while you work); otherwise carry on.", "</dredd-checkpoint>");
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: parts.join("\n") } })}\n`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  main().catch(() => {
    /* fail open */
  });
}
