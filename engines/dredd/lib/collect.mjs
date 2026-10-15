// dredd/lib/collect.mjs - the second sitting: the field evidence arrives and the room hears it.
//
// The field instruments (SUE, the Design Critic's capture, the flow walk) take minutes and run
// detached, so a convened docket ends before their evidence exists. Until this file (2026-09-21) that
// evidence never reached the docket: SUE's runId sat in a log and nobody read her report. `--collect`
// walks the docket's results, fetches what has landed - SUE's report, the critic's judge worklist
// (and LilGranny over the fresh capture), the flow walk's conformance - writes each into the docket
// as a log, and seats the board for one more round on it. What has not landed yet is said plainly,
// with the same command to run again later.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { askBrainHedged, roomCapacity } from "./brain.mjs";
import { filedLines, routeFiled } from "./bug.mjs";
import { shellArg } from "./docket.mjs";
import { CLAIMED_FIX_FIRST } from "./claim-rulings.mjs";
import { INSTRUMENT_FAILURE_MARK } from "./seats.mjs";
import { SUE_SCRIPT, parseSueJson, sueOver, sueProgress, sueStatus } from "./sue-status.mjs";
import {
  docketSurfaces,
  issueLine,
  lowestSurfaces,
  pageShotBrief,
  pageShotSurface,
  renderVision,
  renderVisionLog,
  scoreSurfaces,
  visionEnabled,
} from "./vision.mjs";

/**
 * The supervisor a bounded run goes through: a small node process that starts the shell line, and when the bound
 * passes kills the line's WHOLE process tree (taskkill /T on Windows, the process group elsewhere), then reports
 * { code, signal, timedOut } as the last thing on its stderr, behind ANSWER_MARK. Why not spawnSync's own timeout: with
 * shell:true it kills cmd.exe only, and `bun` behind its npm .cmd shim is cmd's child, so the real instrument outlived
 * its bound and kept writing into the docket after the hearing moved on (the Opus 5.5 review, 2026-09-22). CommonJS,
 * because `node -e` runs it as such. Why stderr and not a fourth pipe: Bun's spawnSync hands back three streams and no
 * fd 3 (measured 2026-09-23, `output.length` 3), so under `bun test` - the lane the specs run in - every bounded run
 * read "the supervisor gave no answer" and seven specs in sitting/collect failed while node passed all eighteen.
 */
const ANSWER_MARK = "@@dredd-supervisor-answer@@";
const SUPERVISOR = `
const { spawn, spawnSync } = require("node:child_process");
const { writeSync } = require("node:fs");
const [ms, line] = process.argv.slice(1);
const win = process.platform === "win32";
const child = spawn(line, { shell: true, stdio: "inherit", windowsHide: true, detached: !win });
let timedOut = false;
const timer = setTimeout(() => {
  timedOut = true;
  if (win) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  else process.kill(-child.pid, "SIGKILL");
}, Number(ms));
child.on("error", (err) => {
  clearTimeout(timer);
  writeSync(2, ${JSON.stringify(ANSWER_MARK)} + JSON.stringify({ error: err.code || err.message }));
  process.exit(0);
});
child.on("exit", (code, signal) => {
  clearTimeout(timer);
  writeSync(2, ${JSON.stringify(ANSWER_MARK)} + JSON.stringify({ code, signal, timedOut }));
  process.exit(0);
});
`;

/**
 * Run one shell line, bounded: the line and everything it starts are killed when `timeoutMs` passes. Returns
 * { status, stdout, stderr, timedOut, error } - `status` is the exit code or null, `error` says in words why there is
 * no code (timed out, killed by a signal, failed to start), so a log never ends in a bare "exit null" that the ladder
 * reads as still pending (the Opus 5.5 review, 2026-09-22). The shell is load-bearing: `bun` is an npm .cmd shim on
 * some machines, which node cannot spawn without one (the hearing's first live run lost every sitting to that).
 */
export function runLine(line, { cwd, timeoutMs = 10 * 60_000, env = {} } = {}) {
  const r = spawnSync(process.execPath, ["-e", SUPERVISOR, String(timeoutMs), line], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    windowsHide: true,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
    // The supervisor holds the real bound; this one only catches a supervisor that itself hung.
    timeout: timeoutMs + 30_000,
  });
  return supervisedResult(r, timeoutMs);
}

/**
 * {@link runLine} without blocking: the same supervisor and the same answer, so several bounded lines run at once (the
 * rulings' sittings, lib/claim-rulings.mjs). Resolves, never rejects.
 */
export function runLineAsync(line, { cwd, timeoutMs = 10 * 60_000, env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["-e", SUPERVISOR, String(timeoutMs), line], {
      cwd,
      env: { ...process.env, ...env },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d) => (stderr += d));
    // The supervisor holds the real bound; this one only catches a supervisor that itself hung.
    const hung = setTimeout(() => child.kill(), timeoutMs + 30_000);
    child.on("error", (error) => {
      clearTimeout(hung);
      resolve(supervisedResult({ stdout, stderr, error, status: null }, timeoutMs));
    });
    child.on("close", (status, signal) => {
      clearTimeout(hung);
      resolve(supervisedResult({ stdout, stderr, status, signal }, timeoutMs));
    });
  });
}

/** One supervised line's result from what the supervisor process left: its streams, its exit and its answer mark. */
function supervisedResult(r, timeoutMs) {
  const stdout = r.stdout || "";
  // The line's own stderr runs through the supervisor's, so its answer is the LAST mark and everything before it is the line's.
  const rawStderr = r.stderr || "";
  const at = rawStderr.lastIndexOf(ANSWER_MARK);
  const stderr = at === -1 ? rawStderr : rawStderr.slice(0, at);
  let answer;
  try {
    answer = at === -1 ? null : JSON.parse(rawStderr.slice(at + ANSWER_MARK.length));
  } catch (err) {
    return { status: null, stdout, stderr, timedOut: false, error: `the supervisor's answer is unreadable: ${err.message}` };
  }
  if (!answer) {
    const why = r.error ? r.error.code || r.error.message : `exit ${r.status}${r.signal ? `, ${r.signal}` : ""}`;
    return { status: null, stdout, stderr, timedOut: false, error: `the supervisor gave no answer (${why})` };
  }
  if (answer.error) return { status: null, stdout, stderr, timedOut: false, error: `failed to start: ${answer.error}` };
  if (answer.timedOut) {
    const s = Math.round(timeoutMs / 1000);
    return { status: null, stdout, stderr, timedOut: true, error: `timed out after ${s} s; the process tree was killed` };
  }
  if (answer.code === null) return { status: null, stdout, stderr, timedOut: false, error: `killed by ${answer.signal || "a signal"}` };
  return { status: answer.code, stdout, stderr, timedOut: false, error: null };
}

/** One command line from tokens through {@link runLine}: each token is one shell argument by the same rule as a bench
 *  run line (shellArg, lib/docket.mjs). Every caller passes paths and flags only - the prose (a sitting's opening
 *  line) lives in the callee behind a flag. */
export function run(cmd, argv, opts = {}) {
  return runLine([cmd, ...argv].map((t) => shellArg(t)).join(" "), opts);
}

/** {@link run} through {@link runLineAsync}: a promise of the same result. */
export function runAsync(cmd, argv, opts = {}) {
  return runLineAsync([cmd, ...argv].map((t) => shellArg(t)).join(" "), opts);
}

/** A log's last line. A run with no exit code ends "exit -1 (<why>)": a number the ladder reads as a failure, and the
 *  reason beside it - never "exit null", which read as a wait that would never end (2026-09-22). */
export function exitFooter(r) {
  return typeof r.status === "number" ? `--- exit ${r.status} ---` : `--- exit -1 (${r.error || "no exit code"}) ---`;
}

/** The log of one run: the command, its output, its stderr when it wrote any, and the footer. */
function runLog(heading, r) {
  return `$ ${heading}\n\n${r.stdout}${r.stderr ? `\n--- stderr ---\n${r.stderr}` : ""}\n${exitFooter(r)}\n`;
}

/**
 * The number the next sitting takes on this docket: one past the highest archived sitting (boardroom-<n>/) and the
 * live one (boardroom/, which is always the newest). The highest number, not a count, so a gap never makes two
 * sittings share a folder.
 */
export function nextSitting(docketDir) {
  const held = existsSync(docketDir)
    ? readdirSync(docketDir)
        .map((f) => /^boardroom-(\d+)$/.exec(f))
        .filter(Boolean)
        .map((m) => Number(m[1]))
    : [];
  const top = held.length ? Math.max(...held) : 0;
  return top + 1 + (existsSync(path.join(docketDir, "boardroom")) ? 1 : 0);
}

/**
 * One sitting of the room, numbered from what the docket already holds: the live boardroom/ is archived as the
 * sitting it was, and this one sits in boardroom/ with its own boardroom-<n>.log. Every caller - the hearing's
 * evidence and proposal sittings, --collect, --resolve - goes through here, so a re-run hearing or a second collect
 * never writes over a sitting that already happened (the Opus 5.5 review, 2026-09-22: both used to seat "sitting 2"
 * into the old folder and overwrite its logs).
 *
 * A room whose every hswarm route is resting on a rate limit waits for the soonest key before it is seated, within
 * `waitCapS` in all (DREDD_CAPACITY_WAIT_S, default 30 min), on its own clock and never the room's 15 min; a room that
 * failed while every route rests sits once more after the wait. One that still cannot sit returns `capacity` and a
 * failure that says so (board #7040: Lift's round 25 table spent its 900 s asleep in the zswarm's queue and filed "no
 * ballots", read as a room that had judged). `notes` says what was waited for. `capacity` is the test seam.
 */
export function sit({
  root,
  engineDir,
  docketDir,
  seats = null,
  proposal = null,
  room = null,
  ask = null,
  waitCapS = Number(process.env.DREDD_CAPACITY_WAIT_S ?? 1800),
  capacity = roomCapacity,
  resat = false,
}) {
  const notes = [];
  let left = Number.isFinite(waitCapS) ? Math.max(0, waitCapS) : 1800;
  let unseated = null;
  for (let cap = restingRoom(capacity); cap; cap = restingRoom(capacity)) {
    const waitS = Math.ceil(cap.soonest_s) + 2;
    if (waitS > left) {
      unseated = cap;
      break;
    }
    notes.push(`${capacityLine(cap)}; waited ${span(waitS)} for it`);
    sleepS(waitS);
    left -= waitS;
  }
  const sitting = nextSitting(docketDir);
  const dir = path.join(docketDir, "boardroom");
  if (existsSync(dir)) renameSync(dir, path.join(docketDir, `boardroom-${sitting - 1}`));
  if (unseated) {
    // Not seated: every route rests past the wait, and a room seated now would sleep through its clock in the queue.
    // The sitting keeps its number, its log and the room's own failure record, so the next sitting archives it.
    const failure = `${capacityLine(unseated)} - the room was not seated, the soonest key is past the ${span(waitCapS)} wait`;
    const log = path.join(docketDir, `boardroom-${sitting}.log`);
    writeFileSync(log, `${failure}\n--- exit -1 (capacity) ---\n`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "minutes.json"), JSON.stringify({ failed: true, error: failure, capacity: unseated }, null, 2));
    return { sitting, log, status: null, minutes: null, failure, capacity: unseated, notes };
  }
  const boardroom = engineDir ? path.join(engineDir, "boardroom.mjs") : "dredd/boardroom.mjs";
  const argv = [boardroom, "--root", root, "--docket", docketDir, "--rounds", "1", "--sitting", String(sitting), "--quiet"];
  if (Array.isArray(seats) && seats.length) argv.push("--seats", seats.join(","));
  if (proposal) argv.push("--proposal", proposal);
  // A design board sits as the minds room (its ballots may quote a mind's own playbook, boardroom.mjs).
  if (room) argv.push("--room", room);
  // The member's own question for this sitting (the design board's), in place of the canned second-sitting line.
  if (ask) argv.push("--", ask);
  const r = run("bun", argv, { cwd: root, timeoutMs: 15 * 60_000 });
  const log = path.join(docketDir, `boardroom-${sitting}.log`);
  writeFileSync(log, runLog(`bun ${argv.join(" ")}`, r));
  const out = { sitting, log, status: r.status, ...readMinutes(r, path.join(dir, "minutes.json")) };
  if (out.minutes) return { ...out, notes };
  // A failed sitting keeps its number and says why, so the next one archives it rather than writing over its log: a room
  // that died before it made its folder left nothing for nextSitting to count, and the next sitting took its number.
  const file = path.join(dir, "minutes.json");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ failed: true, error: out.failure }, null, 2));
  }
  const cap = restingRoom(capacity);
  if (!cap) return { ...out, notes };
  if (!resat && Math.ceil(cap.soonest_s) + 2 <= left) {
    notes.push(`sitting ${sitting} did not finish (${out.failure}) with ${capacityLine(cap)}; it sits again once that key is free`);
    const again = sit({ root, engineDir, docketDir, seats, proposal, room, ask, waitCapS: left, capacity, resat: true });
    return { ...again, notes: [...notes, ...again.notes] };
  }
  return { ...out, capacity: cap, failure: `${capacityLine(cap)} - ${out.failure}`, notes };
}

/** What a finished room left: its minutes, or the failure in words. */
function readMinutes(r, file) {
  if (r.error) return { minutes: null, failure: `the room did not finish: ${r.error}` };
  if (!existsSync(file)) return { minutes: null, failure: `the room wrote no minutes (exit ${r.status})` };
  let minutes;
  try {
    minutes = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    return { minutes: null, failure: `minutes.json is unreadable: ${err.message}` };
  }
  // A failure record is not minutes: the room says so itself (boardroom.mjs exits 1 with { failed, error }).
  return { minutes: minutes && !minutes.failed ? minutes : null, failure: minutes?.failed ? minutes.error : null };
}

/** The capacity reading when no route can take the room's calls: none ready and one resting with a known wake. The
 *  pools unread, a ready route, or only disabled keys is not a rate limit, and waiting would not bring it back. */
function restingRoom(read) {
  const cap = read();
  return cap?.all_resting && Number.isFinite(cap.soonest_s) ? cap : null;
}

const span = (s) => (s < 120 ? `${Math.round(s)} s` : s < 7200 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

/** A synchronous wait: the sitting is synchronous (its room runs under spawnSync). */
const sleepS = (s) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, s * 1000);

/** The verdict of a sitting that could not sit for capacity, never "no ballots": which routes rest, and when the soonest
 *  key is free. */
export function capacityLine(cap, now = Date.now()) {
  const rests = Object.entries(cap.resting || {}).map(([p, s]) => `${p} ${span(s)}`);
  const off = cap.disabled?.length ? `; ${cap.disabled.join(", ")} disabled` : "";
  const at = new Date(now + cap.soonest_s * 1000).toISOString().slice(11, 16);
  return `capacity: every route was rate-limited (${rests.join(", ")}${off}), the soonest free at ${at} UTC`;
}

/** What a focus group's room agreed, as the lines a critic reads first: the one problem, who agreed and who did not,
 *  their own words, and what each Sue named on her own. [] for a run with no room (plain SUE). */
export function roomLines(room) {
  if (!room) return [];
  const v = room.verdict;
  const lines = v
    ? [
        `The room agreed (${v.decidedBy === "moderator" ? "the moderator concluded" : "by vote"}, ${(v.agreedBy || []).length} of ${v.size ?? room.size ?? "?"}): ${v.problem}`,
      ]
    : [`The room never agreed (${room.phase || "no phase"}, ${room.lines ?? 0} line(s) said)`];
  if (v?.against?.length) lines.push(`against: ${v.against.join(", ")}`);
  if (v?.lastProblem) lines.push(`the last focus group's problem: ${v.lastProblem} - still there: ${v.lastProblemStillThere ?? "unclear"}`);
  for (const q of (v?.quotes || []).slice(0, 6)) lines.push(`- ${q.name ? `${q.name}: ` : ""}${q.text ?? JSON.stringify(q)}`);
  for (const o of (room.onTheirOwn || []).slice(0, 12)) lines.push(`- on her own, ${o.name}: ${o.said}`);
  return lines;
}

/** ART's design review, read from the report's `art` object (null when no designer ran): the grade, the ship count and
 *  the severity-3 fixes first, each "screen: what - fix [principle] (who)". Pure. */
export function artLines(art) {
  if (!art) return ["ART: no designer's review in the report"];
  // devices is a count per device ({ phone: 2, desktop: 1 }), said as a sentence: "2 phones and 1 computer".
  const noun = { phone: ["phone", "phones"], desktop: ["computer", "computers"] };
  const devices = Object.entries(art.devices ?? {})
    .filter(([, count]) => count > 0)
    .map(([device, count]) => {
      const [one, many] = noun[device] ?? [device, `${device}s`];
      return `${count} ${count === 1 ? one : many}`;
    })
    .join(" and ");
  const lines = [
    `ART: ${art.designers ?? "?"} designer(s) walked it${devices ? ` on ${devices}` : ""}; design grade ${art.grade ?? "?"} of 10; ` +
      `would ship yes ${art.wouldShip?.yes ?? 0}, no ${art.wouldShip?.no ?? 0}`,
  ];
  const fixFirst = Array.isArray(art.fixFirst) ? art.fixFirst : [];
  if (fixFirst.length) lines.push(CLAIMED_FIX_FIRST);
  for (const f of fixFirst.slice(0, 12))
    lines.push(`- ${f.screen ?? "?"}: ${f.text ?? ""} - ${f.fix ?? ""}${f.why ? ` [${f.why}]` : ""}${f.by ? ` (${f.by})` : ""}`);
  if (fixFirst.length > 12) lines.push(`- (${fixFirst.length - 12} more fix(es) in the run's report, not shown here)`);
  // No severity-3 line to start from: the screens carrying the most design debt say where to start (the report sorts them).
  const debt = Array.isArray(art.debtByScreen) ? art.debtByScreen : [];
  if (!fixFirst.length && debt.length) {
    lines.push("start here, by design debt:");
    for (const row of debt.slice(0, 5)) lines.push(`- ${row.screen ?? "?"}: debt ${row.score ?? 0} (${row.polish ?? 0} polish, ${row.keep ?? 0} keep)`);
  }
  return lines;
}

/** SUE, and her focus group (`id`): status, then the report once the run is over. Every branch carries the spend so
 *  far for the hearing's bill - a paid brain is the only real money in a hearing, and a run still going has already
 *  spent some. A focus group's log leads with what the room agreed, the one thing its bench entry promises.
 *  `append`: a docket that adopted several finished runs of one kind (`--run`) writes each after the one before, in
 *  the same log, each under its own "<TITLE> run <id>" line. */
export function collectSue({ root, docketDir, result, id = "sue", script = SUE_SCRIPT, append = false }) {
  const runId = result.runId;
  const logFile = path.join(docketDir, `${id}.log`);
  const putLog = (text) => (append && existsSync(logFile) ? appendFileSync(logFile, `\n${text}`) : writeFileSync(logFile, text));
  const title = { sue: "SUE", ape: "APE", art: "ART" }[id] ?? "Focus group";
  if (!runId) return { id, status: "no runId recorded - nothing to collect" };
  const st = sueStatus(root, runId, { script });
  if (!st) return { id, status: `status unreadable for ${runId}` };
  const costUsd = Number.isFinite(Number(st.costUsdSoFar)) ? Number(st.costUsdSoFar) : null;
  if (st.state === "refused") {
    return { id, status: `the cannon refused run ${runId}: ${(st.lastLog || []).slice(-2).join(" | ").slice(0, 200)}`, runId, costUsd };
  }
  if (!sueOver(st)) return { id, status: `still running (${sueProgress(st)}) - run --collect again`, runId, costUsd };
  // node runs sue.mjs directly, the JSON as one argv element: no shell, so no quoting to get wrong.
  const rep = spawnSync(process.execPath, [script, "report", "--json", JSON.stringify({ runId, quotes: 12 })], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5 * 60_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const report = parseSueJson(rep.stdout);
  if (!report) {
    // An unreadable report is not a report: filed as one, rung four read its missing stars as the page failing
    // (the Opus 5.5 review, 2026-09-22). The command's own output goes to the log and the rung stays unanswered.
    // Marked as the cannon's own failure, not a fact about the page (lib/seats.mjs INSTRUMENT_FAILURE_MARK), so a
    // ballot that quotes the crash line reads as principle, never as evidence (tallyBallots principleOnly).
    putLog(
      `${INSTRUMENT_FAILURE_MARK}\n${title} run ${runId}: the report command answered nothing readable (exit ${rep.status})\n\n${String(rep.stdout || "").slice(0, 4000)}\n${String(rep.stderr || "").slice(-2000)}\n`,
    );
    return { id, status: `report unreadable for ${runId} (exit ${rep.status}) - see ${id}.log`, log: logFile, runId, costUsd };
  }
  // sue-report.json is SUE's alone: the hearing reads it as rung four and seats Grandma Sue by it.
  if (id === "sue" && !append) writeFileSync(path.join(docketDir, "sue-report.json"), JSON.stringify(report, null, 2));
  const lines = [
    `${title} run ${runId}${st.state === "finished" ? "" : ` (${sueProgress(st)} - the report covers the Sues who finished)`}`,
  ];
  // ART's log leads with the design review the team handed back: the grade, the ship count, the fixes first.
  if (id === "art") lines.push(...artLines(report.art));
  lines.push(...roomLines(report.room));
  for (const k of ["stars", "score", "verdict", "summary"])
    if (report[k] != null) lines.push(`${k}: ${typeof report[k] === "object" ? JSON.stringify(report[k]) : report[k]}`);
  const quotes = report.quotes || report.sentences || report.said || [];
  for (const q of quotes.slice(0, 12)) lines.push(`- ${typeof q === "string" ? q : q.text || JSON.stringify(q)}`);
  // A capped read says it was capped (paperclip's garden-inbox rule, 2026-09-27): the room judges from this log, and
  // "no Sue said X" is only true of what it was shown.
  if (quotes.length > 12) lines.push(`- (${quotes.length - 12} more quote(s) in the run's report, not shown here)`);
  // `reportMarkdown` is the PATH of the run's report.md (their own words, where each stopped, what she told support).
  const md = typeof report.reportMarkdown === "string" ? report.reportMarkdown.trim() : "";
  // The problems the visitors typed, each routed where it is settled (lib/bug.mjs routeFiled): nothing on a run
  // where nobody typed one. Her moves and her look are under the run's folder, the one its report.md sits in.
  const filed = Array.isArray(report.problemsFiled) ? report.problemsFiled : [];
  lines.push(...filedLines(filed, { runId, runDir: md.endsWith(".md") ? path.dirname(md) : null }));
  const routes = { repro: 0, "design-critic": 0, room: 0 };
  for (const p of filed) if (routeFiled(p)) routes[routeFiled(p)] += 1;
  for (const k of ["neverComingBack", "confused", "stoppedAt", "support", "emails"])
    if (report[k] != null) lines.push(`${k}: ${JSON.stringify(report[k]).slice(0, 800)}`);
  for (const k of ["understoodIt", "whereTheyStopped", "emailCode", "problemsFound", "contactedSupport"])
    if (report[k] != null) lines.push(`${k}: ${JSON.stringify(report[k]).slice(0, 1200)}`);
  const mdText = md.endsWith(".md") && existsSync(md) ? readFileSync(md, "utf8") : md;
  if (mdText) {
    lines.push("", `--- ${title}'s own report ---`, mdText.slice(0, 12_000));
    if (mdText.length > 12_000)
      lines.push(`[cut: the first 12000 of ${mdText.length} characters; the whole report is ${md.endsWith(".md") ? md : "in the run"}]`);
  }
  putLog(`${lines.join("\n")}\n`);
  return {
    id,
    status: "report collected",
    ...(filed.some(routeFiled) ? { routes } : {}),
    note: lines.slice(1, 3).join(" | ").slice(0, 200),
    log: logFile,
    runId,
    costUsd,
  };
}

/**
 * Whether a capture covers THIS docket's surfaces since the docket was opened. Pure. The file's own mtime is not
 * enough: a peer's fleet wave rewrote tmp/design-critic/capture.json while the explainer hearing waited, and the
 * hearing took that as its capture landing (2026-09-22). Every surface the docket names must carry a `capturedAt`
 * at or after `createdMs`; a docket that names no surfaces (an off-roster route the adhoc wave shot) is covered by
 * any capture newer than it.
 */
export function captureCovers(capture, surfaceIds, createdMs) {
  const ids = Array.isArray(surfaceIds) ? surfaceIds.filter(Boolean) : [];
  if (!ids.length) return Date.parse(capture?.capturedAt || 0) >= createdMs;
  const rows = new Map((capture?.surfaces || []).map((s) => [s.id, s]));
  return ids.every((id) => Date.parse(rows.get(id)?.capturedAt || 0) >= createdMs);
}

/**
 * Where this docket's capture lives. A roster page's is the standing artifact; an off-roster route the adhoc wave
 * shot has its own directory under tmp/design-critic/adhoc/<name>/, the name convene recorded on the critic row from
 * the line it launched, and the judge reads it with the same two flags - every path moves together (the runner's own
 * rule). Pure given the results.
 */
export function criticPaths(root, results) {
  const row = (results || []).find((r) => r.id === "design-critic");
  const name = row?.adhocName ? String(row.adhocName) : null;
  const dir = name ? path.join(root, "tmp", "design-critic", "adhoc", name) : path.join(root, "tmp", "design-critic");
  return {
    adhoc: Boolean(name),
    adhocName: name,
    capture: path.join(dir, "capture.json"),
    worklist: path.join(dir, "judge-worklist.json"),
    emitArgs: name ? ["--emit", "--adhoc", "--adhoc-name", name] : ["--emit"],
  };
}

/**
 * The Design Critic: a capture that covers this docket's surfaces since it opened → emit the judge worklist, then
 * LilGranny over it. Every row it returns carries the convene row's note and adhoc name: the caller writes this row
 * over the convene one, and a second --collect that lost the name read the fleet's capture instead of this page's
 * (the Opus 5.5 review, 2026-09-22).
 */
async function collectDesignCritic({ root, docket, docketDir }) {
  const convened = (docket.results || []).find((r) => r.id === "design-critic") || {};
  const paths = criticPaths(root, docket.results);
  const row = (fields) => ({
    id: "design-critic",
    ...(convened.note ? { note: convened.note } : {}),
    ...(paths.adhocName ? { adhocName: paths.adhocName } : {}),
    ...fields,
  });
  const capture = paths.capture;
  if (!existsSync(capture)) return row({ status: `no capture yet (${path.relative(root, capture)}) - the wave may still be running` });
  let shot;
  try {
    shot = JSON.parse(readFileSync(capture, "utf8"));
  } catch (err) {
    return row({ status: `the capture on disk is unreadable (${err.message}) - the wave may be writing it; run --collect again` });
  }
  // One freshness rule with the hearing's wait (hearing.mjs awaitField): the file being newer is not enough, every
  // surface this docket names must have been shot since it opened. The mtime test let a peer's rewrite through.
  const created = Date.parse(docket.created || 0);
  if (!captureCovers(shot, docket.surfaces, created))
    return row({ status: "the capture on disk does not cover this docket's surfaces since it opened - run --collect again" });
  const emitStarted = Date.now();
  const emit = run("bun", [".arkitect/runners/design-critic-judge.mjs", ...paths.emitArgs], { cwd: root });
  const log = path.join(docketDir, "design-critic.log");
  writeFileSync(log, runLog(`bun .arkitect/runners/design-critic-judge.mjs ${paths.emitArgs.join(" ")}`, emit));
  // A failed emit wrote no worklist of ours; the one on disk is an earlier docket's, and vision would score it as this
  // page (the Opus 5.5 review, 2026-09-22).
  if (emit.status !== 0)
    return row({ status: `the judge's emit failed, exit ${emit.status ?? `-1 (${emit.error})`} - see design-critic.log`, log });
  const worklist = paths.worklist;
  let w;
  try {
    w = JSON.parse(readFileSync(worklist, "utf8"));
  } catch (err) {
    return row({ status: `the emit exited 0 but its worklist is unreadable (${err.message}) - see design-critic.log`, log });
  }
  if (!(Date.parse(w?.emittedAt || 0) >= emitStarted))
    return row({
      status: `the worklist on disk (emitted ${w?.emittedAt || "at an unknown time"}) is older than this emit - it is an earlier docket's; see design-critic.log`,
      log,
    });
  if (paths.adhoc) {
    // LilGranny's check reads the standing roster capture; over an ad hoc page it would grade the fleet, not this
    // page, and rung three would carry a verdict about somewhere else. Said plainly instead.
    writeFileSync(
      path.join(docketDir, "lilgranny.log"),
      `$ arkitect --check design-critic-granny\n\nnot run: LilGranny reads the standing roster capture, and this page was shot ad hoc - rung three stays dark\n--- exit 0 ---\n`,
    );
  } else {
    const granny = run(
      "bun",
      [
        "packages/connections-arkitect/bin/arkitect.mjs",
        "--root",
        ".",
        "--check",
        "design-critic-granny",
        "--quiet",
        "--out",
        path.join(docketDir, "lilgranny"),
      ],
      { cwd: root },
    );
    writeFileSync(path.join(docketDir, "lilgranny.log"), runLog("arkitect --check design-critic-granny", granny));
  }
  const pending = Array.isArray(w.surfaces) ? w.surfaces.length : 0;
  // Rung two, scored by a model with eyes as a LABELLED second opinion (lib/vision.mjs): the docket's own surfaces,
  // the session's brief, never ingested. The log is evidence for the room; the row carries the number for the ladder.
  let vision = null;
  if (visionEnabled() && Array.isArray(w.surfaces)) {
    // An adhoc capture holds exactly this docket's page; a roster capture holds the fleet, so pick the docket's own.
    // The capture tells which plane each worklist surface is on (worklist rows carry no plane).
    const surfaces = paths.adhoc ? w.surfaces : docketSurfaces(w, docket, shot);
    // Hedged at 20 s: the vision leg is the same free Gemini that stalls now and then; a normal score takes about four.
    const askBrain = (spec, log) => askBrainHedged(spec, log, { afterS: 20 });
    vision = await scoreSurfaces({ surfaces, worklist: w, askBrain, callsLog: path.join(docketDir, "vision-calls.jsonl") });
    writeFileSync(path.join(docketDir, "design-critic-vision.log"), renderVisionLog(vision));
    writeFileSync(path.join(docketDir, "design-critic-vision.json"), JSON.stringify(vision, null, 2));
  }
  const visionNote = !vision
    ? ""
    : vision.overall === null
      ? `; vision: ${vision.surfaces.length ? "no score came back" : "no surface of this docket on the worklist"}`
      : `; ${renderVision(vision)}`;
  return row({
    status: `capture collected; ${pending} surface brief(s) await scoring IN THIS SESSION (read the PNGs the worklist names, then design-critic-judge.mjs --ingest <scores.json>)${visionNote}`,
    log,
    ...(vision
      ? {
          vision: {
            model: vision.model,
            overall: vision.overall,
            scored: vision.scored,
            surfaces: vision.surfaces.map((s) => ({ id: s.id, overall: s.overall, status: s.status })),
          },
        }
      : {}),
  });
}

/** A viewport slice page-pulse writes (its sliceFile): page-desk-01.png, page-phone-12.png. */
const SLICE_FILE = /^page-(desk|phone)-(\d{2})\.png$/;

/**
 * The viewport slices page-pulse photographed into the docket, desktop first then phone, each in page order. The pulse's
 * own record (page-pulse.json `slices`) names them with their offsets; a docket whose record is unreadable is read off
 * the files. Only slices that are on disk are returned.
 */
export function pageSlices(docketDir, pulse = null) {
  const kindOrder = (k) => (k === "desk" ? 0 : 1);
  const recorded = Array.isArray(pulse?.slices) ? pulse.slices : null;
  const rows = recorded
    ? recorded.map((x) => ({ ...x, file: path.basename(String(x.file || "")) }))
    : (existsSync(docketDir) ? readdirSync(docketDir) : [])
        .map((f) => SLICE_FILE.exec(f))
        .filter(Boolean)
        .map((m) => ({ file: m[0], kind: m[1], index: Number(m[2]) }));
  const onDisk = rows.filter((x) => SLICE_FILE.test(x.file) && existsSync(path.join(docketDir, x.file)));
  const counts = { desk: onDisk.filter((x) => x.kind === "desk").length, phone: onDisk.filter((x) => x.kind === "phone").length };
  return onDisk
    .map((x) => ({
      ...x,
      of: x.of ?? counts[x.kind],
      path: path.join(docketDir, x.file),
      state: x.state || `${x.kind === "desk" ? "desktop 1440x900" : "phone 390x844"}, slice ${x.index} of ${x.of ?? counts[x.kind]}`,
    }))
    .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.index - b.index);
}

/**
 * Rung two for a page the capture lane cannot photograph (lib/convene.mjs pageShotRung): page-pulse's viewport slices of
 * it, each scored on its own by the vision model against the Design Critic's brief and the canon (lib/vision.mjs
 * pageShotBrief). The rung is the WORST slice's number - a page is as good as its weakest section, and one 14,000 px
 * photograph shrunk to fit showed the model a layout, never the bland section (2026-09-24); the three lowest are named
 * with their issues. The whole-page photographs stay in the docket as an overview for the session and are not scored.
 * The score lands where the roster path puts it - design-critic-vision.log for the room, design-critic-vision.json for
 * the seat pick (lib/seats.mjs renderedEvidence), `vision` on the row for the ladder - and every way it can fail to come
 * says NOT SCORED with the reason. A score already taken over these same slices is kept, not paid for twice. `askBrain`,
 * `env` and `briefFor` are injected so it is tested without a model.
 */
export async function collectPageShots({ docket, docketDir, row = {}, askBrain = null, env = process.env, briefFor = pageShotBrief }) {
  const base = { id: "design-critic", pageShots: true, ...(row.note ? { note: row.note } : {}) };
  const logFile = path.join(docketDir, "design-critic-vision.log");
  const jsonFile = path.join(docketDir, "design-critic-vision.json");
  const notScored = (why) => {
    writeFileSync(logFile, `$ rung two, from page-pulse's photographs of ${docket.url}\n\nNOT SCORED: ${why}\n\n--- exit 1 ---\n`);
    return { ...base, status: `NOT SCORED: ${why}`, log: logFile };
  };
  let pulse = null;
  try {
    pulse = JSON.parse(readFileSync(path.join(docketDir, "page-pulse.json"), "utf8"));
  } catch {
    /* the slices are read off the files, and the title is a nicety */
  }
  const slices = pageSlices(docketDir, pulse);
  if (!slices.length)
    return notScored("page-pulse left no viewport slices of the page in the docket (page-desk-01.png, ...) - see page-pulse.log");
  if (!visionEnabled(env))
    return notScored(
      `vision is off (DREDD_VISION=off), so no model looked at the ${slices.length} slice(s) page-pulse took - score them in this session, or turn vision on and --collect again`,
    );
  const newest = Math.max(...slices.map((s) => statSync(s.path).mtimeMs));
  let vision = null;
  try {
    const prior = JSON.parse(readFileSync(jsonFile, "utf8"));
    const fresh = statSync(jsonFile).mtimeMs >= newest;
    if (prior?.source === "page-pulse" && prior.aggregate === "min" && Number(prior.scored) > 0 && fresh) vision = prior;
  } catch {
    /* no score over these slices yet */
  }
  if (!vision) {
    const brief = await briefFor({ url: docket.url });
    const surfaces = slices.map((sl) =>
      pageShotSurface({ url: docket.url, title: pulse?.title, shots: [{ state: sl.state, path: sl.path }], brief: brief.text, slice: sl }),
    );
    const worklist = { dimensions: brief.dimensions, nullableDimensions: brief.nullableDimensions, surfaces };
    // Hedged at 20 s, as on the roster path: the vision leg is a free model that stalls now and then.
    const ask = askBrain || ((spec, log) => askBrainHedged(spec, log, { afterS: 20 }));
    try {
      vision = await scoreSurfaces({
        surfaces,
        worklist,
        askBrain: ask,
        callsLog: path.join(docketDir, "vision-calls.jsonl"),
        aggregate: "min",
        concurrency: 8,
      });
    } catch (err) {
      return notScored(`the vision call failed: ${String(err?.message || err).slice(0, 200)}`);
    }
    vision = { ...vision, source: "page-pulse", brief: brief.source };
    writeFileSync(jsonFile, JSON.stringify(vision, null, 2));
  }
  // A page longer than the slices reach is scored as far as they go, and says what was left - never spread thinner.
  const unscored = (Array.isArray(pulse?.sliceCoverage) ? pulse.sliceCoverage : [])
    .filter((c) => Number(c.unscored) > 0)
    .map((c) => `${c.kind === "phone" ? "phone" : "desktop"} page longer than ${c.slices} screens: ${c.unscored} px not scored`);
  vision = { ...vision, notes: unscored };
  writeFileSync(logFile, renderVisionLog(vision));
  if (vision.overall === null)
    return {
      ...base,
      status: `NOT SCORED: the vision model returned no score for any of ${slices.length} slice(s) (${vision.surfaces[0]?.error || "no overall"}) - the slices are in the docket for this session to score`,
      log: logFile,
    };
  const lowest = lowestSurfaces(vision.surfaces).map((s) => ({
    id: s.id,
    title: s.title,
    overall: s.overall,
    issues: (s.issues || []).slice(0, 3).map(issueLine),
  }));
  return {
    ...base,
    status: `page shots collected; ${renderVision(vision)}; lowest: ${lowest.map((s) => `${s.overall}/10 ${s.id}`).join(", ")}${unscored.length ? `; ${unscored.join("; ")}` : ""}`,
    log: logFile,
    vision: {
      model: vision.model,
      overall: vision.overall,
      aggregate: "min",
      scored: vision.scored,
      source: "page-pulse",
      lowest,
      unscored,
      surfaces: vision.surfaces.map((s) => ({ id: s.id, overall: s.overall, status: s.status })),
    },
  };
}

/**
 * Whether the walk's artifact is THIS docket's: finished (no inProgress) and started no earlier than the launch. The
 * conformance check accepts any artifact up to six hours old, so without this a walk that was skipped, or died before
 * it wrote, was reported as "conformance read" over an older walk's results (the Opus 5.5 instrument review). Pure.
 */
export function flowWalkArtifactState(artifact, launchedAt) {
  if (!artifact) return { ok: false, why: "the walk wrote no artifact" };
  if (artifact.inProgress) return { ok: false, why: "the walk has not finished" };
  const started = Date.parse(artifact.startedAt || "");
  const launched = Date.parse(launchedAt || "");
  if (Number.isFinite(launched) && (!Number.isFinite(started) || started < launched - 60_000))
    return { ok: false, why: `the artifact predates this docket's walk (started ${artifact.startedAt || "at an unknown time"})` };
  return { ok: true, why: "" };
}

/** The flow walk: its conformance check over the walk this docket launched, and nothing older. */
function collectFlowWalk({ root, docketDir, row, launchedAt }) {
  const log = path.join(docketDir, "flow-walk-conformance.log");
  if (row && /^(skipped|refused|failed)/.test(String(row.status || "")))
    return { id: "flow-walk", status: `not collected: the walk was ${row.status}`, note: row.note || "" };
  let artifact;
  try {
    artifact = JSON.parse(readFileSync(path.join(root, "tmp", "design-critic", "flow-walk.json"), "utf8"));
  } catch {
    artifact = null;
  }
  const state = flowWalkArtifactState(artifact, launchedAt);
  if (!state.ok) return { id: "flow-walk", status: `walk not finished: ${state.why}`, log: row?.log };
  const r = run("bun", ["packages/connections-arkitect/bin/arkitect.mjs", "--root", ".", "--check", "flow-walk-conformance", "--quiet"], {
    cwd: root,
  });
  writeFileSync(log, runLog("arkitect --check flow-walk-conformance", r));
  // A run with no exit code (timed out, killed) is not "read": the check never answered.
  if (r.error) return { id: "flow-walk", status: `conformance not read: ${r.error}`, log };
  return {
    id: "flow-walk",
    status: r.status === 0 ? "conformance read, exit 0" : `conformance read, exit ${r.status}`,
    note: r.stdout.trim().split(/\r?\n/).slice(-2).join(" | ").slice(0, 200),
    log,
  };
}

/** `sueScript` is SUE's entry point (sue-status.mjs SUE_SCRIPT); a test stands one in. */
export async function collect({ root, engineDir = null, docket, docketDir, board = true, seats = null, sueScript = SUE_SCRIPT }) {
  const results = docket.results || [];
  const collected = [];
  const wasConvened = (id) => results.some((r) => r.id === id) || (docket.convene || []).some((c) => c.id === id);
  const sueRow = results.find((r) => r.id === "sue");
  // A refused launch has nothing to collect, and collecting it replaced the refusal's reason with "no runId
  // recorded" (the fifth explainer hearing, 2026-09-22): the refused row stays, and the ladder reads it.
  // The brain rides along from the launch row ("launched run ... (claude brain, ...)"): the bill needs it to tell a
  // paid visitor's dollars from the subscription's list-price estimate (lib/hearing.mjs renderBill).
  const sueBrain = sueRow ? (/\((\w+) brain/.exec(String(sueRow.status || ""))?.[1] ?? sueRow.brain ?? null) : null;
  if (sueRow && !/^refused/.test(String(sueRow.status || "")))
    collected.push({ ...collectSue({ root, docketDir, result: sueRow, script: sueScript }), brain: sueBrain });
  // A docket that adopted several finished SUE runs (`--run`) reads every one of them, after the first, into the same log.
  for (const row of results.filter((r) => r.id === "sue" && r !== sueRow && r.runId))
    collected.push({ ...collectSue({ root, docketDir, result: row, script: sueScript, append: true }), brain: row.brain ?? null });
  // Her focus group is collected the same way, into its own log; a group that sat out or was skipped has nothing to read.
  const groupRow = results.find((r) => r.id === "focus-group");
  if (groupRow?.runId && !/^(?:refused|skipped)/.test(String(groupRow.status || "")))
    collected.push({
      ...collectSue({ root, docketDir, result: groupRow, id: "focus-group", script: sueScript }),
      brain: /\((\w+) brain/.exec(String(groupRow.status || ""))?.[1] ?? groupRow.brain ?? null,
    });
  // APE's power-user run and ART's design review are collected the same way, into ape.log and art.log (plain SUE's path,
  // their own log and title). Every run of the kind is read: a docket that adopted three APE runs (`--run`) puts all three
  // in ape.log, so the room rules on every claim they filed, not the first run's alone (Packing Buddy, 2026-10-10).
  for (const id of ["ape", "art"]) {
    const rows = results.filter((r) => r.id === id && r.runId && !/^(?:refused|skipped)/.test(String(r.status || "")));
    rows.forEach((row, i) =>
      collected.push({
        ...collectSue({ root, docketDir, result: row, id, script: sueScript, append: i > 0 }),
        brain: /\((\w+) brain/.exec(String(row.status || ""))?.[1] ?? row.brain ?? null,
      }),
    );
  }
  // A critic row the convene skipped (an off-roster host) stays skipped: there is no capture to collect and the
  // ladder reads the skip itself; collecting would report "the capture predates this docket" forever.
  // A page the lane cannot photograph was photographed by page-pulse (lib/convene.mjs pageShotRung): its shots are scored.
  const criticRow = results.find((r) => r.id === "design-critic");
  if (wasConvened("design-critic") && criticRow?.status !== "skipped")
    collected.push(
      criticRow?.pageShots
        ? await collectPageShots({ docket, docketDir, row: criticRow })
        : await collectDesignCritic({ root, docket, docketDir }),
    );
  if (wasConvened("flow-walk"))
    collected.push(
      collectFlowWalk({
        root,
        docketDir,
        row: results.find((r) => r.id === "flow-walk"),
        launchedAt: results.find((r) => r.id === "flow-walk")?.at || docket.created,
      }),
    );
  const landed = collected.filter((c) => /collected|read,/.test(c.status));
  if (board && landed.length) {
    const s = sit({ root, engineDir, docketDir, seats });
    collected.push({
      id: "boardroom (a sitting over the field evidence)",
      status:
        s.status === 0 ? `sitting ${s.sitting}, exit 0` : `sitting ${s.sitting}, exit ${s.status}${s.failure ? `: ${s.failure}` : ""}`,
      ...(s.notes?.length ? { note: s.notes.join("; ") } : {}),
      log: path.join(docketDir, "boardroom", "transcript.md"),
    });
  } else if (board)
    collected.push({ id: "boardroom (a sitting over the field evidence)", status: "not held - no field evidence has landed yet" });
  return collected;
}
