// dredd/lib/convene.mjs - run the docket.
//
// Three modes, from bench.json:
//   now       - run it here, capture stdout+stderr to {docket}/<id>.log, record status and duration.
//   detached  - launch it HIDDEN with the same log, record the pid, and move on (never a visible
//               console - the Chair, 2026-09-05; never a bare load generator on the shared box - the
//               heavy ones go through fairjob when it is installed).
//   agent     - nothing to run; the docket names the exact skill or MCP call for the session, and where its result
//               lands for the board ({docket}/<id>.log, which the room reads like any instrument's log).
// An instrument whose `needs` is not met (no dev server on :4173, say) is recorded as skipped with
// the reason, not attempted - a skipped instrument is a line in the docket, a false red is a lie.
// An instrument that declares an `instance` (the bill, SUE) runs through ONE route, runInstrument: the local
// MCP's shell with AWS credentials minted from the vault for that instance, value-blind; with no MCP handle
// it runs bare and its log says so, so a credential error further down is never read as its own finding.
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import net from "node:net";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BRAINS, assertBrain, sueBrainPolicy } from "../../sue/lib/claude-cli.mjs";
import { climayteGroup, climayteReady } from "../../sue/lib/climayte-dispatch.mjs";
import { fetchPeopleList } from "../../sue/lib/people.mjs";
import { runLine } from "./collect.mjs";
import { agentLandsAt, connectionsDirFor, fillRun, INSTRUMENT_TIERS, paidSueCount, RETENTION_ASK, sueCount } from "./docket.mjs";
import { sueStatus } from "./sue-status.mjs";

const DEV_SERVER = { host: "127.0.0.1", port: 4173 };

export function portOpen({ host, port }, ms = 800) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (v) => {
      try {
        s.destroy();
      } catch {
        /* closed */
      }
      resolve(v);
    };
    s.setTimeout(ms, () => done(false));
    s.once("connect", () => done(true));
    s.once("error", () => done(false));
  });
}

function fairjob() {
  const cmd = path.join(homedir(), ".claude", "tools", "fairjob.cmd");
  return process.platform === "win32" && existsSync(cmd) ? cmd : null;
}

/** Run one shell line now, bounded (the line's whole process tree dies with the bound - collect.mjs runLine),
 *  capturing to a log. A run with no exit code ends "exit -1 (<why>)", the same footer as collect's logs. */
function runNow(cmd, { cwd, log, timeoutMs, env = {}, note = null }) {
  const t0 = Date.now();
  const r = runLine(cmd, { cwd, timeoutMs, env });
  const exit = typeof r.status === "number" ? String(r.status) : `-1 (${r.error})`;
  const out = `$ ${cmd}\n${note ? `(${note})\n` : ""}\n${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}\n--- exit ${exit} in ${Date.now() - t0} ms ---\n`;
  writeFileSync(log, out);
  const tail = r.stdout.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 240);
  return {
    status: r.error ? `failed (${r.error})` : r.status === 0 ? "ran, exit 0" : `ran, exit ${r.status}`,
    ms: Date.now() - t0,
    tail,
    exit: r.status,
  };
}

/**
 * Launch one shell line hidden and detached, stdout+stderr appended to a log. Exported for its test.
 *
 * On Windows the hop is a synchronous hidden Start-Process, never node's `detached` (measured over six probes on
 * 2026-09-22, after four self-hearings whose subtract.log held nothing but its header): `detached: true` is
 * DETACHED_PROCESS, a child with no console, so every grandchild behind a shim - bun.exe behind the npm bun.cmd,
 * pwsh behind fairjob.cmd, node behind cmd - allocates a console of its own and writes there; only cmd's own `echo`
 * reached the log. Without the flag the direct child sits in libuv's kill-on-close job and dies with the launcher
 * before a shim has handed off, so a docket whose last instrument is detached would lose it. Start-Process from a
 * pwsh the launcher waits for gives the instrument a hidden console, its own append into the log through cmd, and
 * membership in no job of ours; the launcher may exit the moment the pid is back. The line, the log and the cwd
 * travel as environment, never through pwsh's own quoting. A .cmd shim also cannot be spawned bare on current node
 * (EINVAL), which is why the fairjob line goes through the shell like everything else.
 */
export function runDetached(cmd, { cwd, log, heavy }) {
  const fj = heavy ? fairjob() : null;
  if (fj && cmd.includes('"')) {
    // fairjob takes the line as ONE quoted -Run argument, and a quoted argument inside it (a path with a space, now
    // that fillRun quotes every value) would split it. Dropping fairjob would put a heavy instrument on the shared box
    // ungated, so the launch is refused by name instead (the Opus 5.5 review, 2026-09-22). Plain paths never reach here.
    const why = "the line carries a quoted argument (a path with a space or a %?) and fairjob takes the line as one quoted -Run";
    writeFileSync(log, `$ ${cmd}\n(launch refused: ${why})\n`);
    return { status: `launch refused - ${why}`, pid: null };
  }
  const line = fj ? `"${fj}" -Weight 3 -Detach -Run "${cmd}"` : cmd;
  const tag = fj ? " (fairjob)" : "";
  writeFileSync(log, `$ ${line}\n(launched ${new Date().toISOString()}, detached)\n\n`);
  if (process.platform !== "win32") {
    const fd = openSync(log, "a");
    const child = spawn(line, { cwd, shell: true, detached: true, windowsHide: true, stdio: ["ignore", fd, fd] });
    child.unref();
    return { status: `launched, pid ${child.pid}${tag}`, pid: child.pid };
  }
  const env = { ...process.env, DREDD_DETACHED_ARGS: `/d /s /c "${line} >> "${log}" 2>&1"`, DREDD_DETACHED_CWD: cwd };
  const script =
    "$p = Start-Process -FilePath cmd.exe -ArgumentList $env:DREDD_DETACHED_ARGS -WorkingDirectory $env:DREDD_DETACHED_CWD -WindowStyle Hidden -PassThru; $p.Id";
  let r = null;
  for (const exe of ["pwsh.exe", "powershell.exe"]) {
    r = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
      cwd,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
    });
    if (!r.error) break;
  }
  const pid = Number(
    String(r?.stdout || "")
      .trim()
      .split(/\r?\n/)
      .pop(),
  );
  if (!r || r.error || r.status !== 0 || !Number.isFinite(pid) || pid <= 0) {
    const why = (r?.error?.message || r?.stderr || "").trim().split(/\r?\n/)[0] || `exit ${r?.status}`;
    appendFileSync(log, `(launch failed: ${why})\n`);
    return { status: `launch failed - ${why}`, pid: null };
  }
  return { status: `launched, pid ${pid}${tag}`, pid };
}

/** The docket's durable convene record, one JSON row per result, in the order it landed. Read with
 *  readConveneLog; every row convene() decides is appended here the moment it is decided, not only once the
 *  whole loop finishes - so a process killed mid-convene (SUE's own refusal poll runs up to ~90 s) leaves a
 *  record of what had already landed, instead of nothing (the MiroFish review, 2026-09-23). */
function conveneLogFile(docketDir) {
  return path.join(docketDir, "convene.jsonl");
}

/** Every row convene() has ever written for this docket, oldest first. Never throws: no file (an old docket,
 *  or one that never started) reads as no rows. A malformed line is dropped rather than failing the whole read. */
export function readConveneLog(docketDir) {
  let text;
  try {
    text = readFileSync(conveneLogFile(docketDir), "utf8");
  } catch {
    return [];
  }
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      /* one damaged line never loses the rows around it */
    }
  }
  return rows;
}

function appendConveneLog(docketDir, row) {
  appendFileSync(conveneLogFile(docketDir), `${JSON.stringify(row)}\n`);
}

/** How long a SUE row of status "launching" is trusted with no runId in its log before it counts as never
 *  having launched at all: longer than sueRefusal's own poll (30 * 3 s = 90 s), so a launch genuinely still
 *  starting up is never raced by a resume that runs moments later, but short enough that a process that died
 *  before sue.mjs printed its startup line is not remembered forever (RISK, proposal P5). */
export const SUE_LAUNCHING_WINDOW_MS = 2 * 60_000;
/** The seats that run as plain SUE: one Sue per visitor, the same launch, resume and collect path. APE (power users)
 *  and ART (the design team) are the others; the focus group is not, it is a room (its own launch path, see launchesSue). */
export const PLAIN_SUE_IDS = new Set(["sue", "ape", "art"]);
/** What a plain-SUE seat calls itself in its notes and its log: "SUE" for a stranger, "APE" for a power user, "ART" for a designer. */
export const plainSueLabel = (id) => ({ ape: "APE", art: "ART" })[id] ?? "SUE";
/** What a plain-SUE seat's people are counted as in the launch note: "3 Designer(s)" for ART, never "3 Sue(s)". */
const plainSueNoun = (id) => ({ ape: "APE", art: "Designer" })[id] ?? "Sue";

/** A row whose instrument did not produce its evidence: refused, failed, never launched, or a non-zero exit. */
const DID_NOT_RUN_RE = /^(?:failed|launch failed|launch refused|refused)|ran, exit (?:[1-9]\d*|-1)\b/i;
const rowDidNotRun = (row) => DID_NOT_RUN_RE.test(String(row?.status || ""));

/** A backend outage in a row's own words: it said wait, timed out, ran out of room or was not there. */
const OUTAGE_RE =
  /try again|temporar(?:y|ily)|timed? ?out|connection slots|too many connections|ECONN(?:RESET|REFUSED)|ETIMEDOUT|ENOTFOUND|socket hang up|fetch failed|\b50[234]\b|service unavailable|couldn.?t check your credits|rate.?limit|overloaded/i;

/**
 * True for a row that says a backend outage stopped its instrument (2026-10-02, board mail #7016: the credit check
 * answered "try again in a moment" and the personas list a connection-slots error, so SUE, the focus group and the
 * room were refused, and the resume minutes later kept all three as if they were answers). Such a row is not a
 * result, so a resume sends the instrument again. A refusal by design (SUE sitting an unattended hearing out, an
 * ungated launch) names no outage and stays final.
 */
export function refusedByOutage(row) {
  return rowDidNotRun(row) && OUTAGE_RE.test(`${row.status} ${row.note || ""}`);
}

/**
 * Pure: what a resumed convene should do with each instrument the docket names, from the rows convene.jsonl
 * already holds. No I/O, no spawning - the caller reads the log and (for a "launching" SUE row) its log file's
 * runId, and hands both in.
 *   kept        - rows to reuse as-is; that instrument does not run again.
 *   toRun       - ids with no usable row yet; convene() runs them now (a "now" instrument: cheap, just reruns).
 *   sueReattach - {runId, brain, log} | null: a launching SUE row whose log already named a run. convene()
 *                 polls that run instead of launching a second one.
 *   sueStillLaunching - the row | null: a launching SUE row with no runId yet, but still inside the window -
 *                 neither reattach (nothing to poll) nor relaunch (it may still be starting); convene() records
 *                 a wait-and-retry row instead of spending on a second launch.
 *   retried     - ids in toRun because their row says a backend outage stopped them (refusedByOutage): the
 *                 instrument never got to run, so the row is not an answer and a resume sends it again.
 *   final       - kept rows that refused or failed for any other reason; a resume does not send those again, and
 *                 convene() names them so nobody waits on one.
 * Exactly one of {sue kept, sueReattach, sueStillLaunching, sue in toRun} holds for a docket that names "sue".
 */
export function resumePlan({ instruments, rows, sueLogRunId = null, logRunIds = {}, now = Date.now() }) {
  const byId = new Map();
  for (const row of rows) if (row?.id) byId.set(row.id, row); // later rows supersede earlier ones for the same id
  const runIds = { ...logRunIds, ...(sueLogRunId ? { sue: sueLogRunId } : {}) };
  const kept = [];
  const toRun = [];
  const retried = [];
  // Per plain-SUE seat (PLAIN_SUE_IDS): a launch whose log named a run, and one still inside its launch window.
  const reattach = {};
  const stillLaunching = {};
  for (const inst of instruments || []) {
    const row = byId.get(inst.id);
    if (PLAIN_SUE_IDS.has(inst.id) && row?.status === "launching") {
      if (runIds[inst.id]) reattach[inst.id] = { runId: runIds[inst.id], brain: row.brain, log: row.log };
      else if (now - Date.parse(row.at || 0) <= SUE_LAUNCHING_WINDOW_MS) stillLaunching[inst.id] = row;
      else toRun.push(inst.id); // no runId ever landed, and the poll window passed: never launched, run it now
      continue;
    }
    if (row && refusedByOutage(row)) {
      toRun.push(inst.id);
      retried.push(inst.id);
    } else if (row) kept.push(row);
    else toRun.push(inst.id);
  }
  return {
    kept,
    toRun,
    reattach,
    stillLaunching,
    sueReattach: reattach.sue ?? null,
    sueStillLaunching: stillLaunching.sue ?? null,
    retried,
    final: kept.filter(rowDidNotRun),
  };
}

/**
 * The resume plan for a docket exactly as convene() itself will compute it, so a caller deciding WHETHER to call
 * convene() (dredd.mjs's `--hearing` resume decision) and convene() deciding what to skip never disagree. Rows come
 * from two places: convene.jsonl (the durable, per-result record) and, for a docket convened before this file
 * existed, docket.results itself - so an already-finished legacy docket is never re-convened just because it has
 * no convene.jsonl yet. jsonl rows are read after `docket.results`, so they supersede it for the same id.
 */
export function planFor(docket, docketDir) {
  const rows = [...(docket.results || []), ...readConveneLog(docketDir)];
  const logRunIds = {};
  for (const id of PLAIN_SUE_IDS) {
    const last = [...rows].reverse().find((r) => r.id === id);
    logRunIds[id] = last?.status === "launching" && last.log ? (parseSueStart(last.log)?.runId ?? null) : null;
  }
  return resumePlan({ instruments: docket.convene, rows, logRunIds });
}

/** Convene every instrument on the docket, in order. Mutates nothing on the docket; returns results. */
export async function convene({
  root,
  dredd = "dredd",
  docket,
  bench,
  docketDir,
  timeoutMs = 20 * 60_000,
  mcp = null,
  // true when a chat convened (dredd.mjs --convene), false for an unattended hearing: only a chat can start the agents
  // that think for SUE's visitors on the elevated tier.
  chat = false,
}) {
  mkdirSync(docketDir, { recursive: true });
  const byId = new Map(bench.instruments.map((i) => [i.id, i]));
  const devUp = await portOpen(DEV_SERVER);
  const results = [];
  const record = (row) => {
    results.push(row);
    appendConveneLog(docketDir, row);
  };
  // A Sue's people live in Connections (Owner, 2026-09-28: "There should not be a single local personality in the
  // workspace"): SUE fetches them itself when it starts. Before the first visit this hearing reads the list through its
  // MCP (sue/lib/people.mjs) only to know which critics are there whole, a critic with her mind in Connections.
  // Never throws; how many there are, or why the list could not be read, is on the docket as `people`.
  const syncPeople = async () => {
    if (docket.people) return;
    if (!mcp) {
      docket.people = { fetched: false, why: "this hearing has no Connections MCP to read the people through" };
      return;
    }
    try {
      const list = await fetchPeopleList((tool, body) => mcp.api("boardroom", tool, body));
      const critics = list.filter((p) => p?.doc?.critic === true && p.builtIn !== true && Number(p.mindChars) > 0).map((p) => p.doc.id);
      docket.people = { fetched: true, fromConnections: list.length, critics };
    } catch (err) {
      docket.people = { fetched: false, why: String(err?.message ?? err).slice(0, 300) };
    }
  };
  // Durable resume (proposal P5, the MiroFish review 2026-09-23): an instrument that already landed a result in
  // convene.jsonl (or, for a docket convened before this file existed, in docket.results) is kept rather than run
  // again, and a SUE launch a prior process died mid-poll on is re-attached by runId instead of sending a second one.
  const plan = planFor(docket, docketDir);
  const keptById = new Map(plan.kept.map((r) => [r.id, r]));
  const plainReattach = Object.keys(plan.reattach);
  const plainStillLaunching = Object.keys(plan.stillLaunching);
  if (plan.kept.length || plainReattach.length || plainStillLaunching.length || plan.retried.length) {
    const sueNote = [
      ...plainReattach.map((id) => `, ${plainSueLabel(id).toLowerCase()} re-attached to run ${plan.reattach[id].runId}`),
      ...plainStillLaunching.map((id) => `, ${plainSueLabel(id).toLowerCase()} still inside its startup window - not re-launched yet`),
    ].join("");
    const retriedNote = plan.retried.length ? ` (${plan.retried.join(", ")} sent again: refused by a backend outage last time)` : "";
    // A kept refusal is final for this docket: say so, and how to send it again, so nobody waits on it.
    const finalNote = plan.final.length
      ? `; kept as final, not sent again: ${plan.final.map((r) => `${r.id} (${r.status})`).join(", ")} - a fresh docket (the same ask with --convene) sends them`
      : "";
    results.push({
      id: "convene",
      status: "resumed",
      note: `convene resumed: ${plan.kept.length} kept${sueNote}, ${plan.toRun.length} launched${retriedNote}${finalNote}`,
    });
  }
  // Rung one of the ladder: once page-pulse says the page is broken, the field (phase 3) is not sent - there is
  // nothing to critique on a page that does not load - and the room sits over the breakage. DREDD_LADDER_STOP=0 overrides.
  let brokenPage = null;
  for (const c of docket.convene) {
    const inst = byId.get(c.id);
    if (!inst) continue;
    const kept = keptById.get(inst.id);
    if (kept) {
      // Already on disk from an earlier pass on this docket; replayed as-is, never re-appended.
      results.push(kept);
      if (inst.id === "page-pulse") {
        try {
          const pj = JSON.parse(readFileSync(path.join(docketDir, "page-pulse.json"), "utf8"));
          if (pj.verdict === "broken") brokenPage = pj.summary;
        } catch {
          /* no pulse written: the ladder does not stop on a missing fact */
        }
      }
      continue;
    }
    if (brokenPage && inst.phase === 3 && process.env.DREDD_LADDER_STOP !== "0") {
      record({ id: inst.id, status: "skipped", note: `the page is broken (${brokenPage}) - the ladder stops at rung one; fix that first` });
      continue;
    }
    const log = path.join(docketDir, `${inst.id}.log`);
    const fill = (tpl) =>
      fillRun(tpl, {
        docketDir,
        url: docket.url,
        ask: docket.ask,
        checks: inst.checks || (inst.checksByDomain || {})[docket.domain],
        surfaces: docket.surfaces,
        term: (docket.terms || [])[0],
        sueArgsFile: path.join(docketDir, "sue-args.json"),
        paths: docket.paths,
        adhocFile: path.join(docketDir, "adhoc.txt"),
        adhocName: `dredd-${path
          .basename(docketDir)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, "-")}`,
        dredd,
        repo: docket.root,
      });
    if (inst.mode === "agent") {
      record({
        id: inst.id,
        status: "yours",
        note: `${fill(inst.run)} - then write its result to ${agentLandsAt(docketDir, inst.id)} for the board`,
      });
      continue;
    }
    if (inst.mode === "always") continue;
    if (inst.needs && /localhost:4173/.test(inst.needs) && !devUp) {
      record({ id: inst.id, status: "skipped", note: `needs ${inst.needs} - start it and run: ${fill(inst.run)}` });
      continue;
    }
    if (inst.id === "lilgranny") {
      // page-pulse ran in phase one; its scan of the page's controls is what she judges on a page the lane cannot shoot.
      let pulse = null;
      try {
        pulse = JSON.parse(readFileSync(path.join(docketDir, "page-pulse.json"), "utf8"));
      } catch {
        /* no pulse written: lilgrannyAtConvene says so on the row */
      }
      const why = lilgrannyAtConvene(docket, { pulse, foreign: path.resolve(root).toLowerCase() !== targetRoot().toLowerCase() });
      if (why?.status === "over-pulse") {
        record(await lilgrannyOverPulse({ docketDir, pulse, note: why.note }));
        continue;
      }
      if (why) {
        record(why);
        continue;
      }
    }
    if (inst.id === "design-critic" && !docket.surfaces.length && !docket.url) {
      record({
        id: inst.id,
        status: "skipped",
        note: "no page named - pass --url so the capture knows which surfaces (or run the whole roster: bun .arkitect/runners/design-critic-capture.mjs)",
      });
      continue;
    }
    // Rung two for ANY page: a page the capture lane cannot photograph (a host that is not ours, or another repository
    // judged with --root, whose planes the wave cannot boot) is scored from page-pulse's own photographs of it, by the
    // vision model at collect. Until 2026-09-24 it was skipped here, rung two sat dark as a quiet "-", the Design Critic
    // was benched, and twelve hearings passed a site the owner found bland.
    const pageShot = pageShotRung(inst, docket, { foreign: path.resolve(root).toLowerCase() !== targetRoot().toLowerCase() });
    if (pageShot) {
      record(pageShot);
      continue;
    }
    if (inst.id === "code-gate" && !(docket.paths && docket.paths.length)) {
      record({
        id: inst.id,
        status: "skipped",
        note: "the ask names no repository path - say which files or directory (e.g. dredd) and the gate runs on them",
      });
      continue;
    }
    // A route of ours off the roster: the lane shoots it ad hoc. A host that is not ours never reaches here (pageShotRung).
    const spec = inst.id === "design-critic" && !docket.surfaces.length && docket.url && inst.runAdhoc ? adhocSpec(docket.url) : null;
    if (spec) {
      writeFileSync(path.join(docketDir, "adhoc.txt"), `${spec}\n`);
      const line = fill(inst.runAdhoc);
      // The collector finds the capture by the name the wave was launched with, read off the line itself so the row
      // and the wave can never disagree; a line with no name would shoot into a directory nobody collects from.
      const adhocName = /--adhoc-name\s+([a-z0-9-]+)/.exec(line)?.[1];
      if (!adhocName) {
        record({
          id: inst.id,
          status: "refused",
          note: `bench.json's runAdhoc names no --adhoc-name, so nothing could collect its capture: ${line}`,
        });
        continue;
      }
      const r = runDetached(line, { cwd: root, log, heavy: true });
      record({ id: inst.id, status: r.status, note: `off-roster surface ${spec}; then: ${fill(inst.then || "")}`, log, adhocName });
      continue;
    }
    if ((launchesSue(inst) || inst.id === "page-pulse") && !docket.url) {
      record({
        id: inst.id,
        status: "skipped",
        note: `no page named - pass --url <page> and ${inst.id === "page-pulse" ? "its pulse is taken first" : PLAIN_SUE_IDS.has(inst.id) ? `${plainSueLabel(inst.id)} will send people through it` : "the focus group sits over it"}`,
      });
      continue;
    }
    // The repository's copy checks read THIS repository's copy. A page on a host that is not ours (localhost off the
    // roster, another product's site) is not in it, so the minute the Architect takes here says nothing about the page;
    // the page's own visible copy is measured by page-pulse, from the same load as rung one.
    if (inst.id === "copy-audit" && docket.url && !adhocSpec(docket.url)) {
      record({
        id: inst.id,
        status: "skipped",
        note: `off-roster host ${new URL(docket.url).hostname}: the copy checks read this repository's copy, not that page's; page-pulse measured the page's own`,
      });
      continue;
    }
    const checks = inst.checks || (inst.checksByDomain || {})[docket.domain];
    if (inst.id === "arkitect" && checks && checks[0] === "*strict*") {
      record({
        id: inst.id,
        status: "yours",
        note: "the strict gate is the owner's time: bun run audit:strict once, when the tree is still - not from a docket",
      });
      continue;
    }
    if (inst.id === "arkitect" && !checks) {
      record({
        id: inst.id,
        status: "skipped",
        note: `no check family for domain ${docket.domain}; run a named check: bun run audit -- --check <id>`,
      });
      continue;
    }
    // The walk is scoped to the planes of the page the docket names; with none, the whole fleet (35 flows, dev servers
    // four at a time, minutes per flow) is a run somebody asks for by hand, never one complaint's side effect.
    if (inst.id === "flow-walk" && !(docket.planes || []).length) {
      record({
        id: inst.id,
        status: "skipped",
        note: "no page named, so no plane to walk; the whole fleet is a hand-run: bun run audit:flow-walk",
      });
      continue;
    }
    const cmd = fill(inst.run);
    if (inst.mode === "detached") {
      const r = runDetached(cmd, { cwd: root, log, heavy: /design-critic|flow-walk|atlas/.test(inst.id) });
      // The launch time is what a collector holds the instrument's artifact against: evidence older than this is
      // another run's, never this docket's.
      record({ id: inst.id, status: r.status, note: inst.then ? `then: ${inst.then}` : "", log, at: new Date().toISOString() });
      continue;
    }
    if (PLAIN_SUE_IDS.has(inst.id) && plan.stillLaunching[inst.id]) {
      // A prior process wrote "launching" and died before sue.mjs's runId reached the log, and we are still
      // inside the window it might yet land in - relaunching now risks paying for two Sues over one visit. This
      // row is NOT `record()`ed: the durable "launching" row must stay the last word on sue in convene.jsonl, so
      // the NEXT resume re-reads it fresh (finds the runId by then, or finds the window has since passed) rather
      // than reading today's "still starting" as a kept, terminal answer and never trying again.
      const row = plan.stillLaunching[inst.id];
      const sinceS = Math.round((Date.now() - Date.parse(row.at || 0)) / 1000);
      results.push({
        id: inst.id,
        status: "refused - a launch from earlier is still starting",
        note: `a launch begun ${sinceS}s ago (brain ${row.brain || "?"}) has not yet written a runId to ${row.log || "its log"} - rerun --convene in a bit; past ${Math.round(SUE_LAUNCHING_WINDOW_MS / 1000)}s with no runId it is treated as never launched`,
        log: row.log,
      });
      continue;
    }
    if (PLAIN_SUE_IDS.has(inst.id) && plan.reattach[inst.id]) {
      // A prior process's launch is known to have started (its log named a runId); poll that run instead of
      // sending a second Sue over the same visit.
      const { runId, brain, log: blog } = plan.reattach[inst.id];
      const started = parseSueStart(blog) || { runId };
      const refusal = started?.runId
        ? await sueRefusal(root, started.runId, brain === "chat" ? { ready: chatBrainsReady(started) } : {})
        : { kind: "other", why: "the resumed row named no runId" };
      noteBrain(root, brain, refusal?.kind === "brain" ? refusal : null);
      if (refusal) {
        record({
          id: inst.id,
          status: refusal.kind === "brain" ? "refused - no brain can think" : "refused",
          note: `re-attached to run ${started?.runId}, then refused: ${refusal.why.slice(0, 200)}`,
          log: blog,
          runId: started?.runId,
          brain,
        });
        continue;
      }
      record({
        id: inst.id,
        status: `re-attached to run ${started.runId} (${brain} brain)`,
        note:
          brain === "chat"
            ? chatSueNote({ started, url: docket.url, docketDir, climayte: started.dispatch ? null : await climayteReady() })
            : `${started.count ?? "?"} Sue(s) on ${docket.url}; collect: node dredd/dredd.mjs --collect --docket ${docketDir}`,
        log: blog,
        runId: started.runId,
        brain,
      });
      continue;
    }
    if (launchesSue(inst) && chat && !process.env.SUE_BRAIN) {
      // Convened from a chat: SUE is the SUE tier (bench.json `tier`, INSTRUMENT_TIERS in lib/docket.mjs), so her
      // visitors think on this chat's own Sonnet 5.5 agents, one per Sue, never a pool brain (Owner, 2026-10-05, replacing
      // the 2026-09-23 Opus 5.5 ruling: "spin up the Sues moving forward as Sonnet 5.5, not Opus"). Only an unattended hearing, which has no chat to
      // start those agents, climbs only the key pools the chat pinned (below). SUE_BRAIN still pins a brain by name.
      // Each of those Sues is ONE sealed CliMayte task (Owner, 2026-10-06): while AgentHydra answers, SUE sends them
      // itself (`dispatch: "climayte"`, sue/lib/climayte-dispatch.mjs) and the chat starts nothing.
      try {
        assertBrain("chat");
      } catch (err) {
        record({ id: inst.id, status: "refused", note: err.message });
        continue;
      }
      await syncPeople();
      const climayte = await climayteReady();
      writeSueArgs(docketDir, inst, docket, { dispatch: climayte.ready ? "climayte" : null });
      // Only SUE's launch is re-attached on a resume (resumePlan); any other row left at "launching" would stand forever.
      if (PLAIN_SUE_IDS.has(inst.id))
        appendConveneLog(docketDir, { id: inst.id, status: "launching", brain: "chat", log, at: new Date().toISOString() });
      const r = await runInstrument(inst, { mcp, root, cmd, log, timeoutMs, env: { SUE_BRAIN: "chat" } });
      const started = parseSueStart(log);
      const refusal = started?.runId
        ? await sueRefusal(root, started.runId, { ready: chatBrainsReady(started) })
        : { kind: "other", why: "the launch printed no runId" };
      if (refusal) {
        record({
          id: inst.id,
          status: refusal.kind === "mailroom" ? "refused - the mailroom cannot read mail" : "refused",
          note:
            refusal.kind === "mailroom"
              ? "SUE's mailroom has no AWS credentials, so no Sue could read her sign-in code: open the local MCP (Dredd leases org credentials through it) or have a person run `aws sso login --profile main` on this PC, then rerun --convene"
              : `the chat-brain run did not come up: ${String(started?.error || refusal.why).slice(0, 200)}`,
          log,
          runId: started?.runId,
          brain: "chat",
        });
        continue;
      }
      record({
        id: inst.id,
        status: `launched run ${started.runId} (chat brain: ${INSTRUMENT_TIERS.elevated.label}${r.viaVault ? ", vault credentials" : ""})`,
        note: chatSueNote({ started, url: docket.url, docketDir, focusGroup: !PLAIN_SUE_IDS.has(inst.id), climayte }),
        log,
        runId: started.runId,
        brain: "chat",
      });
      continue;
    }
    if (launchesSue(inst)) {
      // Unattended, SUE climbs only the key pools the chat pinned (DREDD_SUE_BRAINS or SUE_BRAIN); none pinned, she
      // sits the hearing out. The cannon refuses a pool with no key with balance: poll for that and step down.
      // The launch takes the one instance route (runInstrument), so the mailroom gets org credentials minted
      // value-blind instead of depending on a human's AWS SSO session on this PC (2026-09-22).
      // The ladder first: a rung that refused within the memo window is not tried again (each refusal costs a launch
      // and a poll of up to ninety seconds), DREDD_SUE_BRAINS pins the ladder, and an empty ladder is said plainly.
      // A misspelled rung in SUE_BRAIN or DREDD_SUE_BRAINS is refused here, by name, before any launch.
      let brains;
      try {
        brains = process.env.SUE_BRAIN ? [assertBrain(process.env.SUE_BRAIN)] : sueBrainLadder(root);
      } catch (err) {
        record({ id: inst.id, status: "refused", note: err.message });
        continue;
      }
      if (!brains.length) {
        const policy = sueBrainPolicy();
        const pooled = !policy || policy.brains.some((b) => b === "deepseek" || b === "openrouter");
        const pin = String(process.env.DREDD_SUE_BRAINS || "").trim();
        const [who, her, she] = PLAIN_SUE_IDS.has(inst.id) ? [plainSueLabel(inst.id), "her", "she"] : ["The focus group", "it", "it"];
        record({
          id: inst.id,
          status: "refused",
          note: !pooled
            ? `this machine runs Sue only on --brain ${policy.brains.join(" | ")}${policy.model ? ` (${policy.model})` : ""} (${policy.file}): an unattended hearing has no chat to drive a Sue, so ${who} sits this one out - run ${her} from a chat with the sue tool`
            : pin
              ? `no brain can think: every pinned rung (${pin}) refused within the last ${BRAIN_MEMO_MS / 3600000} h (tmp/dredd/sue-brains.json) - land a key with balance in HSwarm's secrets (~/.hswarm/secrets), then rerun`
              : `${who} thinks in the chat that runs Dredd, never on a key pool unasked (the Chair, 2026-09-23): an unattended hearing has no chat to drive ${her}, so ${she} sits this one out - convene from the chat (dredd.mjs --convene, one Sonnet 5.5 agent per Sue), or pin DREDD_SUE_BRAINS=openrouter when the chat decides a paid pool is worth it`,
        });
        continue;
      }
      let brain = brains[0];
      let started = null;
      let refusal = null;
      let r = { status: "not launched" };
      // The log of the rung that ran last: after a step down the ladder, the first rung's log holds only its refusal.
      let blog = log;
      for (let step = 0; step < brains.length; step += 1) {
        brain = brains[step];
        blog = step === 0 ? log : path.join(docketDir, `${inst.id}-${brain}.log`);
        // The arguments go to disk, never onto a command line: cmd, PowerShell 5.1 and sh each quote JSON differently.
        await syncPeople();
        writeSueArgs(docketDir, inst, docket, { paid: true });
        const env = { SUE_BRAIN: brain };
        // Durable BEFORE the launch: if this process dies during the refusal poll below (up to ~90 s), a resume
        // reads this row and either finds the runId sue.mjs went on to print, or - past the window - treats it
        // as never launched. Not `record()`: this is not a result yet, and must never appear twice in `results`.
        if (PLAIN_SUE_IDS.has(inst.id))
          appendConveneLog(docketDir, { id: inst.id, status: "launching", brain, log: blog, at: new Date().toISOString() });
        r = await runInstrument(inst, { mcp, root, cmd, log: blog, timeoutMs, env });
        started = parseSueStart(blog);
        refusal = started?.runId ? await sueRefusal(root, started.runId) : { kind: "other", why: "the launch printed no runId" };
        noteBrain(root, brain, refusal?.kind === "brain" ? refusal : null);
        if (refusal?.kind !== "brain") break;
      }
      if (refusal) {
        const fix =
          refusal.kind === "mailroom"
            ? "SUE's mailroom has no AWS credentials, so no Sue could read her sign-in code: open the local MCP (Dredd leases org credentials through it) or have a person run `aws sso login --profile main` on this PC, then rerun --convene"
            : refusal.kind === "brain"
              ? `no brain could think (tried ${brains.join(" → ")}; ${refusal.why.slice(0, 160)}): land a key with balance in HSwarm's secrets (~/.hswarm/secrets) for a pinned pool (DREDD_SUE_BRAINS), or convene from the chat so its own agents drive her, then rerun`
              : `the cannon refused: ${refusal.why.slice(0, 200)}`;
        record({
          id: inst.id,
          status:
            refusal.kind === "mailroom"
              ? `refused - the mailroom cannot read mail (brain ${brain} was fine)`
              : refusal.kind === "brain"
                ? "refused - no brain can think"
                : "refused",
          note: fix,
          log: blog,
          runId: started?.runId,
          brain,
        });
        continue;
      }
      record({
        id: inst.id,
        status: started?.runId ? `launched run ${started.runId} (${brain} brain${r.viaVault ? ", vault credentials" : ""})` : r.status,
        note: started?.runId
          ? `${PLAIN_SUE_IDS.has(inst.id) ? `${started.count ?? "?"} ${plainSueNoun(inst.id)}(s)` : `a focus group of ${started.count ?? "?"}`} on ${docket.url}; collect: node dredd/dredd.mjs --collect --docket ${docketDir}`
          : started?.error || r.tail,
        log: blog,
        ...(started?.runId ? { runId: started.runId, brain } : {}),
      });
      continue;
    }
    const r = await runInstrument(inst, { mcp, root, cmd, log, timeoutMs });
    let note = r.tail;
    if (inst.id === "arkitect" && docket.paths?.length) {
      // The Architect reports over the whole repository; the room needs the lines that name the docket's paths, so
      // they are appended to the log's tail (the part the room reads). Found on Dredd's second hearing on itself
      // (2026-09-22): the room argued about an orphan in another package because that is what the summary said.
      const scoped = arkitectFindingsFor(root, docket.paths);
      appendFileSync(log, `\n--- ${namedPathsSection(docket.paths, scoped)} ---\n${scoped.lines.join("\n")}\n`);
      // The room reads a log's tail; the repo-wide summary ("60 warning(s)") next to "0 lines name dredd" had it
      // scoring the named paths on the whole repository's numbers. The scoped section gets its own log, and that is
      // the one the room sees for a docket that names paths (boardroom.mjs keeps arkitect.log out of such a room).
      const scopedLog = path.join(docketDir, "arkitect-named-paths.log");
      writeFileSync(scopedLog, namedPathsLog({ from: log, paths: docket.paths, scoped, exit: r.exit ?? -1 }));
      // An unread report is said on the row as well as in the log: the paths were not measured, which is not clean.
      const status = scoped.report ? r.status : `${r.status}; the report was not read (${scoped.error}) - the named paths are NOT measured`;
      note = scoped.report ? `${scoped.lines.length} finding line(s) name the docket's paths · ${r.tail}` : `not measured: ${scoped.error}`;
      record({ id: inst.id, status, note, log: scopedLog, fullLog: log });
      continue;
    }
    record({ id: inst.id, status: r.status, note, log });
    if (inst.id === "page-pulse") {
      try {
        const pj = JSON.parse(readFileSync(path.join(docketDir, "page-pulse.json"), "utf8"));
        if (pj.verdict === "broken") brokenPage = pj.summary;
      } catch {
        /* no pulse written: the ladder does not stop on a missing fact */
      }
    }
  }
  return results;
}

/** sue.mjs prints ONE JSON object; lift runId / count / error out of the captured log. */
function parseSueStart(log) {
  try {
    // The log opens with the echoed command (which carries the same braces, escaped); the answer is the
    // first line that BEGINS with a brace, up to the exit marker.
    const text = readFileSync(log, "utf8").split(/\n--- (?:exit |stderr ---)/)[0];
    const start = text.search(/^\{/m);
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) return null;
    const j = JSON.parse(text.slice(start, end + 1));
    return {
      runId: j.runId,
      count: j.count,
      error: j.ok === false ? j.error : null,
      ...(j.chatBrains ? { chatBrains: j.chatBrains } : {}),
      ...(j.dispatch ? { dispatch: j.dispatch } : {}),
    };
  } catch {
    return null;
  }
}

/** A chat-brain run is up once its chat-brains.json exists: its Sues then wait for the chat's agents, so no Sue ever
 *  counts as "launched" until the chat starts one, and the ninety-second launch poll would read that as a failure. */
function chatBrainsReady(started) {
  return () => Boolean(started?.chatBrains && existsSync(started.chatBrains));
}

/** What the chat does next for a chat-brain SUE run: Dredd names the tier (the elevated one), the chat starts the agents. */
/** An instrument that launches a SUE run: SUE herself, and any instrument whose run line reads her args file (her focus
 *  group). All take the same page skip, the same brain gate, the same args file and the same collect; only the size
 *  differs. The focus group ran as a bare "now" instrument until 2026-09-23, reading an args file only SUE's branch
 *  ever wrote. */
export function launchesSue(inst) {
  return inst?.id === "sue" || String(inst?.run || "").includes("{sueArgsFile}");
}

/**
 * An ask about attention, boredom, drop-off or coming back also sends SUE's two critics (Owner, 2026-09-27: a Sue
 * "whose only job is to go through our platforms and be like a user would drop off here"). The retention doctor and
 * the game designer (`critic: true`) walk the path the visitors walk and log every attention break with its mechanism
 * and fix. They ride beside the page's cast, or beside TikTok Sue (the attention-native visitor) when the docket cast
 * nobody, so the report holds both what a visitor did and the expert's reading of why. Since 2026-09-28 they are the
 * Connections workspace's Sue people, and each one's mind is her Boardroom row's playbook; SUE fetches both when it
 * starts. A critic the workspace does not hold whole (her person and a mind, read from the list above) stays home and
 * is named on the docket as `criticsSkipped`, so the visitors still walk: sue.mjs refuses a whole run over one unknown
 * or mindless person. The ask is read by `RETENTION_ASK` (lib/docket.mjs).
 */
export const SUE_CRITICS = Object.freeze(["retention-doctor", "game-designer"]);

/**
 * A BUYING ask sends the buying critic, `ads-readiness` (a consumer psychologist who walks the paid-ad visitor's path
 * and calls every screen stay, leave or buy), with the retention doctor beside her. Owner, 2026-09-30: "what's left
 * before I can start running ads ... would they stay? would they leave? would they purchase?" sent no critic at all,
 * because none of those words is an attention word. Read on words about ads, paid traffic, conversion, purchase,
 * checkout, the pricing or landing page, and whether a person would stay, leave, pay or buy; a sign-up screen alone
 * is not one (a button's colour is a design complaint).
 */
export const BUYING_CRITICS = Object.freeze(["ads-readiness", "retention-doctor"]);
export const BUYING_ASK =
  /\b(?:ads?|advertis\w*|paid (?:traffic|clicks?|social|search)|ad (?:spend|budget|campaigns?)|convert(?:s|ed|ing)?|conversions?|purchas\w*|buy(?:s|ing|ers?)?|pay(?:s|ing)? for|checkout|pricing page|landing pages?|stay(?:s|ed)? or leave|would (?:they|people|anyone|a human|a person) (?:stay|leave|pay|buy|purchase))\b/i;

/** The critics an ask sends: the two retention critics on an attention ask, the buying pair on a buying ask, each once. */
export function criticsFor(ask) {
  const said = String(ask ?? "");
  const out = [...(RETENTION_ASK.test(said) ? SUE_CRITICS : []), ...(BUYING_ASK.test(said) ? BUYING_CRITICS : [])];
  return [...new Set(out)];
}

/** Of `ids`, the critics the workspace holds whole in Connections (`people.critics`, read by the hearing) and the rest. */
export function readyCritics(people, ids) {
  const whole = new Set(people?.fetched ? people.critics : []);
  return { ready: ids.filter((id) => whole.has(id)), skipped: ids.filter((id) => !whole.has(id)) };
}

/** The args file a SUE-family launch reads. SUE sends the chat's count (the paid pool's smaller one on a key); a focus
 *  group seats the room's own default unless DREDD_SUE_COUNT names a size (sue.mjs refuses a table past its ceiling). */
export function writeSueArgs(docketDir, inst, docket, { paid = false, dispatch = null } = {}) {
  // ART seats its design team (ART_TEAM, three designers): no count is sent, so sue.mjs art takes the team's own size.
  let count =
    inst.id === "art"
      ? undefined
      : !PLAIN_SUE_IDS.has(inst.id)
        ? process.env.DREDD_SUE_COUNT
          ? sueCount()
          : undefined
        : paid
          ? paidSueCount()
          : sueCount();
  // The visitors the docket cast from the ask and the page (lib/visitors.mjs) go as SUE's `cast`: without it she drew
  // from this workspace's saved people, and a party-planner hearing on a performer's site sent a WhatsApp deal group.
  const cast = docket.cast?.visitors?.length ? { cast: docket.cast.visitors } : {};
  // A retention ask names its people: the cast (or TikTok Sue) plus the critics the workspace holds whole, each sent at least once.
  let critics = inst.id === "sue" ? criticsFor(docket.ask) : [];
  if (critics.length && docket.people) {
    const { ready, skipped } = readyCritics(docket.people, critics);
    critics = ready;
    if (skipped.length) docket.criticsSkipped = skipped;
  }
  // The roster's own children (a kids ask, lib/visitors.mjs) go by id, with the critics beside them when the ask sends them.
  const children = docket.cast?.children ?? [];
  // Pre-sue's pick (lib/visitors.mjs presueForDocket) goes by name, strongest first: the saved people who fit the page,
  // then the ones it onboarded, who also ride in `cast` so they go even when their save to Connections failed.
  const picked = docket.cast?.personas ?? [];
  const visitors = children.length ? children : picked.length ? picked : (docket.cast?.visitors ?? []).map((v) => v.id).filter(Boolean);
  const people =
    critics.length || children.length || picked.length ? { personas: [...(visitors.length ? visitors : ["tiktok"]), ...critics] } : {};
  if (people.personas) count = Math.max(count ?? 0, people.personas.length);
  // DREDD_SUE_CREATE_ACCOUNTS=0 keeps every Sue signed out, for a page whose button spends a real, capped thing (a
  // minted trial code, a live Stripe trial).
  const intent = sueIntentOf(docket);
  // DREDD_SUE_EXPECT (or the docket's own `expect`) is what the page is meant to be, told to every visitor so a page that
  // is something else gets noted. Never made up from the ask: the owner or the caller says it, or there is none.
  const expectSaid = process.env.DREDD_SUE_EXPECT?.trim() || String(docket.expect ?? "").trim() || null;
  const expect = expectSaid ? { expect: expectSaid } : {};
  const signedOut = process.env.DREDD_SUE_CREATE_ACCOUNTS === "0" ? { createAccounts: false } : {};
  // DREDD_SUE_LEGS (1 to 5) is how many jobs that errand holds, each on the visitor's own patience: a lesson the
  // teacher set is several, and a kid's one leg of two minutes never reached its second part (sue/lib/workspace.mjs).
  const legsSet = Number(process.env.DREDD_SUE_LEGS);
  const legs = Number.isInteger(legsSet) && legsSet > 1 ? { legs: legsSet } : {};
  writeFileSync(
    path.join(docketDir, "sue-args.json"),
    JSON.stringify(
      // hearing: false - this hearing rules on the run's claims itself, so the finished run does not hand itself to a second one.
      {
        url: docket.url,
        intent,
        ...expect,
        count,
        ...legs,
        ...cast,
        ...people,
        ...signedOut,
        ...(dispatch ? { dispatch } : {}),
        hearing: false,
      },
      null,
      2,
    ),
  );
}

/** The ask as SUE's intent: at most 300 characters, cut at a sentence end or else a word, never mid-word ("see him perfor"). */
/**
 * Why SUE's visitors come, as her run is told it and as pre-sue judges who fits (lib/visitors.mjs). DREDD_SUE_INTENT is
 * the visitor's errand when the ask is the owner's complaint ("it feels AI"): the complaint stays the room's, and never
 * primes the people sent to test it.
 */
export function sueIntentOf(docket) {
  return process.env.DREDD_SUE_INTENT?.trim() || intentOf(docket?.ask);
}

export function intentOf(ask, max = 300) {
  const text = String(ask ?? "").trim();
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const sentence = head.match(/^[\s\S]*[.!?](?=\s)/)?.[0];
  return sentence && sentence.length >= 60 ? sentence : head.replace(/\s+\S*$/, "");
}

/**
 * What the chat does next for a chat-brain SUE run. Every Sue is ONE sealed CliMayte task (Owner, 2026-10-06): a run SUE
 * sends itself (`started.dispatch`) needs nothing from the chat; while CliMayte answers (`climayte.ready`) the chat hands
 * the run over with dispatch.mjs; only when it does not does the chat start brief-reading agents of its own.
 */
export function chatSueNote({ started, url, docketDir, focusGroup = false, climayte = null }) {
  const t = INSTRUMENT_TIERS.elevated;
  const who = focusGroup ? `A focus group of ${started?.count ?? "?"} on ${url}` : `${started?.count ?? "?"} Sue(s) on ${url}`;
  const collect = `Then collect: node dredd/dredd.mjs --collect --docket ${docketDir}`;
  const group = started?.runId ? climayteGroup(started.runId) : "sue-<runId>";
  if (started?.dispatch === "climayte")
    return (
      `${who}: SUE sends each one to CliMayte itself, as ONE sealed task on ${t.label}, so this chat starts NO agent for them ` +
      `(climayte_status { group: "${group}" } shows them; each entry of ${started?.chatBrains || "the run's chat-brains.json"} names its worker). ${collect}`
    );
  if (climayte?.ready)
    return (
      `${who} wait${focusGroup ? "s" : ""} for this chat: hand them to CliMayte, each as ONE sealed task on ${t.label}, never an agent of this chat's own: ` +
      `node sue/dispatch.mjs ${started?.runId ?? "<runId>"} (it prints the climayte_run call to send yourself if the run cannot take it). ${collect}`
    );
  const down = climayte?.why ? `CliMayte is unavailable (${climayte.why}), so the old way: ` : "";
  if (focusGroup)
    return (
      `${down}A focus group of ${started?.count ?? "?"} on ${url} waits for this chat: start one agent per entry in ${started?.chatBrains || "the run's chat-brains.json"}, the moderator included, ALL in one message (the room needs everyone at the table together), ` +
      `each on model "${t.agent}" (${t.label}), each told only to read its brief file (by its full path) and do what it says. ` +
      `Check the account first (check_my_usage): a room is driven whole or not at all, never handed to a cheaper model. ` +
      `Then collect: node dredd/dredd.mjs --collect --docket ${docketDir}`
    );
  return (
    `${down}${started?.count ?? "?"} Sue(s) on ${url} wait for this chat: start one agent per Sue listed in ${started?.chatBrains || "the run's chat-brains.json"}, ` +
    `each on model "${t.agent}" (${t.label}), each told only to read its brief file (by its full path) and do what it says. ` +
    `Check the account first (check_my_usage): drive only as many as it can take; a Sue nobody drives is let go after an hour, never handed to a cheaper model. ` +
    `Then collect: node dredd/dredd.mjs --collect --docket ${docketDir}`
  );
}

/** The settings prefix for one instrument: DREDD_SUE for sue, DREDD_BILL for bill. */
const settingsKey = (id) =>
  `DREDD_${String(id)
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")}`;

/**
 * The vault instance an instrument runs under, or null. Its bench entry declares `instance`; <KEY>_AWS_INSTANCE names
 * another connected account and <KEY>_VIA_VAULT=0 opts it out, where KEY is settingsKey(id) - so SUE keeps the two
 * settings it always had (DREDD_SUE_AWS_INSTANCE, DREDD_SUE_VIA_VAULT) and the bill gets the same pair. Exported for its test.
 */
export function vaultInstanceFor(inst, env = process.env) {
  if (!inst?.instance) return null;
  const key = settingsKey(inst.id);
  if (env[`${key}_VIA_VAULT`] === "0") return null;
  return env[`${key}_AWS_INSTANCE`] || inst.instance;
}

/** The shell's own ceiling: a larger timeoutMs is refused by name, never clamped (local MCP, 12-tools-shell-git.mjs). */
const VAULT_SHELL_MAX_MS = 60 * 60_000;

/**
 * Run one instrument's line now - the ONE route for every instrument that declares an `instance` (the bill, SUE) and for
 * every plain "now" one. With an instance and an open local-MCP handle it goes through the MCP's `shell`, which injects
 * AWS credentials minted from the vault for that instance (value-blind: the key never reaches this process's output);
 * the log carries the shell's own exit line and the same `--- exit N` footer runNow writes, so the ladder reads both
 * alike. With no handle, or opted out, it runs bare and the log's second line says it had no vault credentials, so an
 * AccessDenied further down reads as what it is. Exported for its test (a fake `mcp` with a `call`).
 */
export async function runInstrument(inst, { mcp, root, cmd, log, timeoutMs, env = {} }) {
  const instance = vaultInstanceFor(inst);
  if (instance && mcp) {
    const t0 = Date.now();
    const bound = Math.min(timeoutMs, VAULT_SHELL_MAX_MS);
    const res = await mcp.call(
      "shell",
      { command: cmd, instance, cwd: root, shell: process.platform === "win32" ? "cmd" : "bash", env: { ...env }, timeoutMs: bound },
      bound + 30_000,
    );
    // The shell answers `$ cmd`, `exit N`, `--- stdout ---`, `--- stderr ---`; a refused or timed-out call has no exit line.
    const exit = Number(/^exit (-?\d+)\s*$/m.exec(res.text)?.[1] ?? NaN);
    const stdout = /--- stdout ---\r?\n([\s\S]*?)\r?\n--- stderr ---/.exec(res.text)?.[1] ?? res.text;
    const ms = Date.now() - t0;
    writeFileSync(
      log,
      `$ ${cmd}\n(through the local MCP shell - vault-minted AWS credentials for ${instance}, value-blind)\n\n${res.text}\n--- exit ${Number.isFinite(exit) ? exit : -1} in ${ms} ms ---\n`,
    );
    return {
      status: !res.ok
        ? "failed (vault shell)"
        : !Number.isFinite(exit)
          ? "ran (on vault credentials), no exit line"
          : `ran, exit ${exit} (on vault credentials)`,
      ms,
      tail: stdout.trim().split(/\r?\n/).slice(-3).join(" | ").slice(0, 240),
      exit: Number.isFinite(exit) ? exit : null,
      viaVault: true,
    };
  }
  const note = !inst?.instance
    ? null
    : instance
      ? `no vault credentials for ${instance}: no local MCP handle was open, so this ran bare on whatever AWS session this PC holds`
      : `no vault credentials: ${settingsKey(inst.id)}_VIA_VAULT=0 opted out, so this ran bare on whatever AWS session this PC holds`;
  return { ...runNow(cmd, { cwd: root, log, timeoutMs, env, note }), viaVault: false };
}

/** How long a brain's refusal is remembered: a login does not appear by itself, and every rung that refuses costs a
 *  launch and a poll of up to ninety seconds before the hearing steps down (the subscription rung on every hearing
 *  of 2026-09-22). Signing the "sue" instance in, or a key landing in the pool, is the human's act; the memo expires. */
export const BRAIN_MEMO_MS = 6 * 60 * 60 * 1000;

/**
 * The key pools a hearing climbs, in order, pure. There is no default ladder: a pool is used only when the chat that
 * runs Dredd names it in `pin` (DREDD_SUE_BRAINS, comma-separated) - the Chair, 2026-09-23: "I don't think they should
 * need api keys or something else, unless the desktop instance (aka here) has deemed say, a... zswarm necessary" -
 * and never a CLI login ("you're not allowed to use CLI logins"). `memo` remembers which rung refused and when. A
 * pinned name that is not a rung throws, with the spelling to use instead; a pinned "claude" is refused by name.
 */
export function ladderFrom({ memo = {}, now = Date.now(), pin = "" }) {
  const pinned = String(pin || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const b of pinned) {
    if (b === "claude")
      throw new Error(
        `DREDD_SUE_BRAINS=${pin}: the claude rung is retired (the Chair, 2026-09-23: no CLI logins) - deepseek and openrouter only`,
      );
    try {
      assertBrain(b);
    } catch (err) {
      throw new Error(`DREDD_SUE_BRAINS=${pin}: ${err.message}`, { cause: err });
    }
  }
  return pinned.filter((b) => {
    const m = memo[b];
    return !(m && m.kind === "brain" && now - Date.parse(m.at || 0) < BRAIN_MEMO_MS);
  });
}

function brainMemoFile(root) {
  return path.join(root, "tmp", "dredd", "sue-brains.json");
}

/**
 * The memo as the ladder reads it. Stored data may name the subscription rung by its old spelling,
 * "sonnet"; it is the same login, so its refusal is read as the claude rung's (the newer entry wins
 * when both are there) and the next write drops the old key.
 * Any other name that is not a rung is dropped, so stored data can never pin or block a rung.
 */
export function brainMemoFromDisk(memo) {
  const out = {};
  if (!memo || typeof memo !== "object") return out;
  const old = memo.sonnet;
  for (const [rung, entry] of Object.entries(memo)) if (BRAINS.includes(rung)) out[rung] = entry;
  if (old && (!out.claude || Date.parse(old.at || 0) > Date.parse(out.claude.at || 0))) out.claude = old;
  return out;
}

function readBrainMemo(root) {
  try {
    return brainMemoFromDisk(JSON.parse(readFileSync(brainMemoFile(root), "utf8")));
  } catch {
    return {};
  }
}

/** A brain that can think again (a key landed): its remembered refusal is dropped at once rather than holding the
 *  rung shut for the rest of the six hours. */
function noteBrain(root, brain, refusal) {
  const memo = readBrainMemo(root);
  if (refusal) memo[brain] = { kind: refusal.kind, why: String(refusal.why || "").slice(0, 200), at: new Date().toISOString() };
  else delete memo[brain];
  try {
    mkdirSync(path.dirname(brainMemoFile(root)), { recursive: true });
    writeFileSync(brainMemoFile(root), JSON.stringify(memo, null, 2));
  } catch {
    /* the memo is a saving, never a requirement */
  }
}

/** The key pools an unattended hearing may think on: exactly DREDD_SUE_BRAINS, minus a refusal within the memo window.
 *  Unset, none - the chat that runs Dredd decides a pool is worth paying for, never Dredd by itself. A pinned name the
 *  machine's sueBrainPolicy excludes is refused by assertBrain in ladderFrom, with the policy's reason. */
function sueBrainLadder(root) {
  return ladderFrom({ memo: readBrainMemo(root), pin: process.env.DREDD_SUE_BRAINS });
}

/** Poll a SUE run for up to ~90 s (the preflight probes the brain, then the mailroom). null when it started; otherwise the refusal: { kind: brain | mailroom | other, why }.
 *  Only a `brain` refusal is worth another rung of the ladder - a mailroom with no AWS credentials is the same on
 *  every brain, and its fix is a human's browser login (aws sso login --profile main). */
async function sueRefusal(root, runId, { ready = null } = {}) {
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    // A chat-brain run says it is up by writing its chat-brains.json (see chatBrainsReady), never by launching a Sue.
    if (ready?.()) return null;
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const st = sueStatus(root, runId, { timeoutMs: 30_000 });
    if (process.env.DREDD_DEBUG)
      process.stderr.write(
        `[dredd] sue ${runId} poll ${i}: state=${st?.state} launched=${st?.launched} ok=${st?.ok} err=${st?.error || ""}\n`,
      );
    if (!st) continue;
    if (st.state === "refused") {
      const why = (st.lastLog || []).filter((l) => /REFUSING|sign /i.test(l)).join(" | ") || (st.lastLog || []).slice(-2).join(" | ");
      if (/mailroom|CredentialsProviderError|aws sso login/i.test(why)) return { kind: "mailroom", why };
      if (/brain cannot talk|Not logged in|\/login|no usable|balance|credit/i.test(why)) return { kind: "brain", why };
      return { kind: "other", why };
    }
    // `running` with launched=0 is the preflight (brain probe, then the mailroom check) - a refusal can still follow.
    if ((typeof st.launched === "number" && st.launched > 0) || /^(finished|done)$/i.test(String(st.state || ""))) return null;
    last = st;
  }
  return {
    kind: "other",
    why: `no Sue had started after 90 s (state ${last?.state || "unknown"}, launched ${last?.launched ?? "?"}) - read the cannon log`,
  };
}

/**
 * The lines of the Architect's latest per-check reports that name any of `paths`. The run's manifest names its run
 * id; the saved report folder ends with `--<runId>` under .arkitect/reports. Never throws, and never hides why:
 * { report, lines, error } - `report` null with `error` saying what could not be read. Zero lines from an unread
 * report used to reach the room as a clean bill (the Opus 5.5 review, 2026-09-22).
 */
export function arkitectFindingsFor(root, paths, { limit = 200 } = {}) {
  const wanted = paths.map((p) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  try {
    const manifestFile = path.join(root, "tmp", "arkitect", "manifest.json");
    if (!existsSync(manifestFile)) return { report: null, lines: [], error: "tmp/arkitect/manifest.json is missing - the run wrote none" };
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    const runId = String(manifest?.artifacts?.runDir || "")
      .split(/[\\/]/)
      .pop();
    if (!runId) return { report: null, lines: [], error: "tmp/arkitect/manifest.json names no run directory" };
    const reportsDir = path.join(root, ".arkitect", "reports");
    const report = existsSync(reportsDir) ? readdirSync(reportsDir).find((d) => d.endsWith(`--${runId}`)) : null;
    if (!report) return { report: null, lines: [], error: `no report folder ends with --${runId} under .arkitect/reports` };
    const lines = [];
    for (const f of readdirSync(path.join(reportsDir, report)).filter((f) => /^check-.*\.md$/.test(f))) {
      const check = f.replace(/^check-/, "").replace(/-[0-9a-f]{32}\.md$/, "");
      for (const line of readFileSync(path.join(reportsDir, report, f), "utf8").split(/\r?\n/)) {
        const norm = line.replace(/\\/g, "/").toLowerCase();
        if (/workspace changed while the architect was running/i.test(line)) continue;
        if (wanted.some((w) => norm.includes(w))) lines.push(`[${check}] ${line.trim()}`);
        if (lines.length >= limit) return { report, lines, error: null };
      }
    }
    return { report, lines, error: null };
  } catch (err) {
    return { report: null, lines: [], error: `the report could not be read: ${err.message}` };
  }
}

/** The one-line head of the scoped section: how many lines name the paths, from which report, or that none was read. */
function namedPathsSection(paths, scoped) {
  return `Architect findings naming ${paths.join(", ")}: ${scoped.lines.length} line(s)${scoped.report ? ` (${scoped.report})` : ` (no report read: ${scoped.error})`}`;
}

/**
 * arkitect-named-paths.log, the log the room reads for a docket that names paths. Pure. The clean sentence is written
 * only over a report that was read; an unread one says the paths were not measured and why, so no seat can quote a
 * clean bill for code nothing examined.
 */
export function namedPathsLog({ from, paths, scoped, exit }) {
  const verdict = !scoped.report
    ? `The Architect's report could not be read (${scoped.error}): these paths were NOT measured, which is not a clean bill.\n`
    : scoped.lines.length
      ? ""
      : "No check of the code-quality family names these paths: nothing dead, duplicated, over-complex or slop-shaped was found in them.\n";
  return `$ (the Architect's findings that name this docket's paths, from ${from})\n\n${namedPathsSection(paths, scoped)}\n${scoped.lines.join("\n")}\n${verdict}\n--- exit ${exit} ---\n`;
}

/**
 * Whether LilGranny may run at convene time, pure: null to run, else the row that says why not, or a row with status
 * "over-pulse" when she judges page-pulse's scan instead. On a roster page she grades the capture lane's photographs,
 * so a docket whose own critic is shooting the page waits for THAT capture - collect runs her over it the moment it
 * lands. Run at convene over the fleet's old capture, she graded pages this docket never named, exited 0, and rung
 * three read "ok" for the explainer on localhost (the first hearing after the docket's bars were lowered, 2026-09-22).
 * A page the lane cannot photograph (an off-roster host, or any page of a --root hearing, `foreign`) is judged from
 * page-pulse's own scan of its controls (`pulse.inventory`, the Chair, 2026-09-25: every tool on any site); a pulse
 * with no inventory keeps the honest skipped row, naming why.
 */
export function lilgrannyAtConvene(docket, { pulse = null, foreign = false } = {}) {
  if (docket.url && (foreign || !adhocSpec(docket.url))) {
    let host = docket.url;
    try {
      host = new URL(docket.url).hostname;
    } catch {
      /* the door already refused a URL that does not parse; the raw text names it */
    }
    const where = foreign ? `${host}, a page in another repository's hearing` : `off-roster host ${host}`;
    if (Array.isArray(pulse?.inventory) && pulse.inventory.length)
      return { id: "lilgranny", status: "over-pulse", note: `${where}: LilGranny judges page-pulse's own scan of the page's controls` };
    const why = pulse ? pulse.inventorySkipReason || "page-pulse.json holds no inventory" : "no page-pulse.json in the docket";
    return {
      id: "lilgranny",
      status: "skipped",
      note: `${where}: the capture lane cannot photograph it, and page-pulse's scan of its controls is missing (${why})`,
    };
  }
  if (foreign)
    return { id: "lilgranny", status: "skipped", note: "no page named - pass --url <page> and LilGranny judges page-pulse's scan of it" };
  const shooting = (docket.convene || []).some((c) => c.id === "design-critic") && (docket.url || (docket.surfaces || []).length);
  if (shooting)
    return {
      id: "lilgranny",
      status: "deferred",
      note: "LilGranny runs over this docket's own capture when it lands (--collect, or the hearing's collect step)",
    };
  return null;
}

/** The granny adapter, and the repository its policy path is relative to: this file's own Connections checkout,
 *  whichever repository the hearing judges. */
const GRANNY_PAGE = pathToFileURL(targetPath(loadTarget().grannyPageEngine));
const CONNECTIONS_ROOT = targetRoot();

/** What a finding is about, for the log's list: the control it names, else the leg whose fold it counts. */
function grannyControl(meta = {}) {
  if (meta.control) return String(meta.control);
  if (meta.name) return `"${meta.name}" (${meta.role || "control"})`;
  return meta.leg ? `the ${meta.leg} fold` : "the page";
}

/**
 * LilGranny over page-pulse's scan of an off-roster page: the same rules and standards the design-critic-granny check
 * uses (.arkitect/lib/engines/design-critic/granny-page.mjs), written as lilgranny.log (rule, control, why) and
 * lilgranny.json (the findings, plus a `checks` row in the Architect manifest's shape, so rung three grades it exactly
 * as it grades her run over the roster capture). Her exit is 0 over any finding, as the check's is: the row is graded
 * from lilgranny.json, never the exit. Returns the convene row.
 */
export async function lilgrannyOverPulse({ docketDir, pulse, note }) {
  const log = path.join(docketDir, "lilgranny.log");
  const at = pulse?.finalUrl || pulse?.url || "the page";
  const head = `$ LilGranny over page-pulse's scan of ${at}`;
  let lib;
  try {
    lib = await import(GRANNY_PAGE.href);
  } catch (err) {
    const why = `the granny engine did not load: ${String(err?.message || err).slice(0, 200)}`;
    writeFileSync(log, `${head}\n\n${why}\n\n--- exit 1 ---\n`);
    return { id: "lilgranny", status: "failed", note: `${note}; ${why}`, log };
  }
  let policy = null;
  let policyNote = `standards from ${String(lib.GRANNY_POLICY_PATH).replace(/\\/g, "/")}`;
  try {
    policy = JSON.parse(readFileSync(path.join(CONNECTIONS_ROOT, lib.GRANNY_POLICY_PATH), "utf8"));
  } catch (err) {
    policyNote = `the policy could not be read (${String(err?.message || err).slice(0, 120)}), so the engine's measured defaults`;
  }
  const standards = lib.grannyStandardsFrom(policy);
  const judged = lib.grannyOverPulse(pulse, { standards });
  if (!judged.judged) return { id: "lilgranny", status: "skipped", note: `${note}; ${judged.reason}` };
  const count = (severity) => judged.findings.filter((f) => f.severity === severity).length;
  const errors = count("error");
  const warnings = count("warning");
  const info = count("info");
  const byRule = new Map();
  for (const f of judged.findings) byRule.set(f.ruleId, (byRule.get(f.ruleId) || 0) + 1);
  const top = [...byRule].map(([rule, n]) => `${rule} x${n}`).join(", ");
  let host = at;
  try {
    host = new URL(at).hostname;
  } catch {
    /* the raw text names it */
  }
  const legs = judged.legs.join(" and ");
  const controls = `${pulse.inventory.length} control(s) at desktop${judged.phoneSkipReason ? "" : `, ${pulse.mobileInventory.length} at phone width`}`;
  writeFileSync(
    path.join(docketDir, "lilgranny.json"),
    JSON.stringify(
      {
        source: "page-pulse",
        url: at,
        at: new Date().toISOString(),
        label: `LilGranny over page-pulse's scan of ${host} (${legs})`,
        checks: [{ id: "design-critic-granny", status: errors ? "failed" : warnings ? "warned" : "clean", errors, warnings, info }],
        top,
        legs: judged.legs,
        phoneSkipReason: judged.phoneSkipReason,
        notJudged: judged.notJudged,
        standards,
        findings: judged.findings.map(({ ruleId, severity, message, meta }) => ({
          ruleId,
          severity,
          control: grannyControl(meta),
          message,
          meta,
        })),
      },
      null,
      2,
    ),
  );
  const lines = [
    `${head} (${legs}: ${controls})`,
    "",
    `${judged.findings.length} finding(s)${top ? `: ${top}` : " - she could find her way around every control scanned"}`,
    "",
    ...judged.findings.map((f) => `- [${f.severity}] ${f.ruleId} · ${grannyControl(f.meta)} · ${f.message}`),
    ...(judged.findings.length ? [""] : []),
    ...judged.notJudged.map((n) => `Not judged: ${n.ruleId} - ${n.why}.`),
    ...(judged.phoneSkipReason ? [`Not judged at phone width: ${judged.phoneSkipReason}.`] : []),
    `Ceilings: ${standards.maxAboveFoldChoices} choices above the fold on desktop, ${standards.maxAboveFoldChoicesMobile} at phone width (${policyNote}).`,
    "",
    "--- exit 0 ---",
    "",
  ];
  writeFileSync(log, lines.join("\n"));
  return {
    id: "lilgranny",
    status: "ran, exit 0",
    note: `${note}; ${judged.findings.length} finding(s) over ${legs}${top ? ` (${top})` : ""}`,
    log,
  };
}

/**
 * Whether the Design Critic's rung two comes from page-pulse's photographs instead of the capture lane, pure: the convene
 * row when it does, else null. It does for a named page on a host that is not ours (the lane shoots declared planes
 * only), and for any named page when the hearing judges another repository (`foreign`: the wave boots Connections'
 * planes and cannot run there). A foreign hearing with no page named has nothing to photograph and says so.
 */
export function pageShotRung(inst, docket, { foreign = false } = {}) {
  if (inst?.id !== "design-critic") return null;
  if (!docket.url)
    return foreign
      ? { id: inst.id, status: "skipped", note: "no page named - pass --url <page> and page-pulse photographs it for rung two" }
      : null;
  const offRoster = !(docket.surfaces || []).length && !adhocSpec(docket.url);
  if (!foreign && !offRoster) return null;
  let host = docket.url;
  try {
    host = new URL(docket.url).hostname;
  } catch {
    /* the door already refused a URL that does not parse; the raw text names it */
  }
  const why = foreign
    ? "the capture wave boots Connections' own planes, and this hearing judges another repository"
    : `off-roster host ${host}: the capture lane photographs declared planes only`;
  return {
    id: inst.id,
    status: "awaiting scoring: page-pulse's photographs of the page",
    pageShots: true,
    note: `${why}, so page-pulse photographed the page itself (page-desk.png, page-phone.png) and --collect scores the shots with the vision model`,
  };
}

/** The host labels that are not the plane that serves them, so the capture lane (which knows planes, not hosts) is
 *  handed the plane. `pass.` is the Pass front Worker's host (the
 *  Pay dev server serves /trial/ on any host); the other two are CONSTELLATION_PLANES rows whose label is
 *  read out of their origin. The Deal Flow invite hearing (2026-09-25) sent `pass:/trial/...`, the wave refused it on
 *  start, and the hearing waited on a capture that could never come. */
const HOST_LABEL_PLANE = { www: "main", pass: "pay", workspaces: "companies", events: "events_explore" };

/** The capture lane's off-roster spec, `<plane>:</route>`, for a page on one of OUR hosts; null for any other host
 *  (a foreign site, a local file server), because the lane photographs a declared plane's dev server and would shoot
 *  the wrong page - the explainer on :4919 would have become main:/DREDD-EXPLAINED.html (2026-09-22). */
export function adhocSpec(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const m = /^([a-z0-9-]+)\.(?:get)?connections\.(?:icu|app|co)$/.exec(host);
  if (m) return `${HOST_LABEL_PLANE[m[1]] ?? m[1]}:${u.pathname || "/"}`;
  if (/^(?:get)?connections\.(?:icu|app|co)$/.test(host)) return `main:${u.pathname || "/"}`;
  return null;
}
