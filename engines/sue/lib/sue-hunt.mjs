// sue/lib/sue-hunt.mjs - SUE's own ranked self-improvement queue (`node sue/round.mjs hunt --plan <plan.json>`).
//
// Owner, 2026-10-04: "RRSI, or RSI, whichever you want to call it, needs to always be implemented during sue, dread,
// et cetera." Dredd's `--hunt` (dredd/lib/hunt.mjs) is the model: a queue of the judge's OWN faults, each with its
// evidence and one action. SUE's signals already exist on disk, nothing gathered them: on 2026-10-04 (round 8, lift-v2)
// a critic filed "no level-up moment" because SUE's look stopped waiting at 2 s and the page's level-up lands at 2.7 s,
// and nobody knew it was SUE's fault until a person opened the picture. Every round is also a run on SUE.
//
// `rankSueHunt` is pure; `gatherSueHunt` is the thin reader around it (rounds jsonl, each run folder's summary.json,
// findings.jsonl, repro.json, trace.jsonl, reuse.json, and git for the decision commits), so the ranking is tested with
// no disk. Read-only: nothing here writes under .sue/rounds or a run folder.
import { execFile, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadSue, sueSideOf } from "../report.mjs";
import { canonical, visitsOf } from "./reuse.mjs";
import { readLedger } from "./repro.mjs";
import { readRounds, seriesKey } from "./rounds.mjs";
import { timeRows, traceOf } from "./round-times.mjs";
import { readSueLedger, SUE_AB_POLICY_SINCE, SUE_DECISION_PATHS } from "./sue-rsi.mjs";

/** A look taken while a finite animation still ran at the stillness cap (a body note, body.mjs). */
export const MID_MOTION_KIND = "look-mid-motion";

const W = { noStart: 100, unmeasured: 90, sueSide: 80, midMotion: 75, offProtocol: 50, suspect: 45, slow: 40, unstable: 35 };

/** A move this many times the round's median per-move time, and at least this many seconds, is slow. */
const SLOW_FACTOR = 3;
const SLOW_MIN_S = 5;

const SUSPECT_ACTION = {
  "tired-driver":
    "sue/lib/clock.mjs: her patience ran out and SUE refused every move after it; check the dials or the driver's pace before blaming the site",
  "door-refused":
    "sue/lib/signup-door.mjs: our sign-up door refused her; lift the cap or give her a fresh door before trusting the run",
  "frozen-screen":
    "sue/lib/perception.mjs: several byte-identical looks in a row; find why her screen stood still (a stuck look, a closed page)",
  "browser-lost": "sue/body.mjs (reopenBrowser): her browser closed under her; fix the reopen so the visit is the site's, not SUE's",
  "code-refused":
    "sue/body.mjs (type, codesNotGiven): the code guard refused a code she typed and her inbox never had one; find where her code came from and let the body take it",
};

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The queue, pure. Every item: { weight, kind, subject, evidence, action } - the ONE action is the point. Heaviest first,
 * ties by subject.
 *   noStart         [{ round, subject, why }]                        a round short of runs, or a run that ended as a brain error
 *   sueSide         [{ runId, sue, finding, why }]                    findings triaged into the sue-side bucket
 *   midMotion       [{ runId, sue, count, moving? }]                  looks noted `look-mid-motion`, with what still moved
 *   pageMotion      [name]                                            animations the plan names as the page's own progress
 *   suspects        [{ kind, runId, sue, lines }]                     report.mjs SUE-side suspects (tired-driver, door-refused, ...)
 *   offProtocol     [{ runId, sue, why? }]                            a driver that never made a `see` move
 *   seeUntraced     true when no trace in the window records a `see` at all, so the above cannot be told
 *   slow            [{ round, who, moves, perMove?, median? }]        timing outliers; moves 0 is a Sue that never moved
 *   unstable        [{ persona, pairs, flipped, rounds? }]            a verdict that flipped on identical engine, driver, hands, builds
 *   decisionCommits [{ sha, files }] with measured (Set of covered shas)
 *   hashChanges     [{ round, part, hash, was? }] with ledgerHashes (Set of hashes a ledger row names)
 */
export function rankSueHunt({
  noStart = [],
  sueSide = [],
  midMotion = [],
  pageMotion = [],
  suspects = [],
  offProtocol = [],
  seeUntraced = false,
  slow = [],
  unstable = [],
  decisionCommits = [],
  measured = new Set(),
  hashChanges = [],
  ledgerHashes = new Set(),
} = {}) {
  const items = [];
  const add = (weight, kind, subject, evidence, action) => items.push({ weight, kind, subject, evidence, action });

  for (const n of noStart)
    add(
      W.noStart,
      "no-start",
      n.subject,
      n.why,
      "sue/round.mjs start / sue/sue.mjs: read the run's summary.json brainError and body.stderr.log, and fix why it did not start or its brain failed",
    );

  const unmeasured = decisionCommits.filter((c) => !measured.has(c.sha));
  if (unmeasured.length) {
    const files = [...new Set(unmeasured.flatMap((c) => c.files))];
    add(
      W.unmeasured,
      "unmeasured",
      "decision change landed unmeasured",
      `${plural(unmeasured.length, "commit")} (${unmeasured.map((c) => c.sha.slice(0, 10)).join(", ")}) touched ${files.slice(0, 6).join(", ")}${files.length > 6 ? ` and ${files.length - 6} more` : ""} with no A/B ledger row covering them`,
      "measure old against new over the same build and people: node sue/ab.mjs (then --record), so a row in sue/eval/ab-ledger.jsonl names these commits",
    );
  }
  for (const h of hashChanges.filter((x) => !ledgerHashes.has(x.hash)))
    add(
      W.unmeasured,
      "unmeasured",
      `new ${h.part} hash in round ${h.round}`,
      `round ${h.round}'s visits carry ${h.part} ${String(h.hash).slice(0, 10)}${h.was ? ` (was ${String(h.was).slice(0, 10)})` : ""} on the same builds as the round before, and no ledger row names it`,
      `measure the ${h.part} change with node sue/ab.mjs (then --record) so sue/eval/ab-ledger.jsonl names ${String(h.hash).slice(0, 10)}`,
    );

  for (const s of sueSide)
    add(
      W.sueSide,
      "sue-side",
      `${s.runId}/${s.sue}`,
      `finding ${s.finding} was triaged sue-side: ${s.why}`,
      "fix SUE where the why says (sue/body.mjs, lib/perception.mjs, lib/looks.mjs), then re-run the finding's repro (node sue/repro.mjs)",
    );

  // a page's own progress that its plan names (a playback fill, a countdown) is what a person meets half-way too: a look
  // taken while only that moved is no SUE fault (lift-v2's vn-sweep, judged page progress in round 14, came back every round)
  const own = new Set(pageMotion);
  for (const m of midMotion) {
    const moving = (m.moving ?? []).filter(({ name }) => !own.has(name));
    if (m.moving?.length && !moving.length) continue;
    const most = new Map();
    for (const { name, remainingMs } of moving) most.set(name, Math.max(most.get(name) ?? 0, remainingMs ?? 0));
    const what = most.size ? [...most].map(([name, ms]) => `${name} (up to ${ms} ms left)`).join(", ") : "a finite animation";
    add(
      W.midMotion,
      "mid-motion",
      `${m.runId}/${m.sue}`,
      `${plural(m.count, "look")} taken while ${what} was still running at the stillness cap, so her picture is a frame of the motion, not the page`,
      "sue/lib/looks.mjs and sue/body.mjs: wait for the animation to settle (raise the stillness cap or wait on the animation itself) before the look; a page's own progress (a playback fill, a countdown) is what a person meets half-way too, so read her notes first and change nothing when none is about it",
    );
  }

  for (const o of offProtocol)
    add(
      W.offProtocol,
      "off-protocol",
      `${o.runId}/${o.sue}`,
      o.why ||
        "her driver never made a `see` move and never Read a picture file, so she moved on words alone, without her screen's picture",
      "sue/hands-mcp.mjs and the sue-driver agent brief: make `see` after every move that shows the page, and refuse a next move before it",
    );
  if (seeUntraced)
    add(
      W.offProtocol,
      "off-protocol",
      "no see is recorded in these rounds",
      "no sees.jsonl in these rounds holds a `see` and no trace.jsonl a picture Read (runs from before hands-mcp.mjs recorded them), so a driver that never looked at a picture cannot be told from one that did",
      "send a round on the current hands-mcp.mjs (it writes sees.jsonl for every `see`) so this hunt can read the protocol",
    );

  for (const s of suspects)
    add(
      W.suspect,
      s.kind,
      `${s.runId}/${s.sue}`,
      `report.mjs lists her as a SUE-side suspect (${plural(s.lines, "line")} blame the site for what SUE caused)`,
      SUSPECT_ACTION[s.kind] || "sue/report.mjs: read this SUE-side suspect and fix its cause in SUE",
    );

  for (const s of slow)
    add(
      W.slow,
      "slow",
      `round ${s.round} ${s.who}`,
      s.moves
        ? `${s.perMove.toFixed(1)} s per move against the round's median ${s.median.toFixed(1)} s over ${plural(s.moves, "move")}`
        : "never moved: no tool move in her trace",
      "node sue/round.mjs times --plan <plan.json> shows where; sue/body.mjs (a slow wait) or the driver's pace is the fix",
    );

  for (const u of unstable)
    add(
      W.unstable,
      "unstable",
      u.persona,
      `${u.persona}'s stars or finishing flipped in ${u.flipped} of ${u.pairs} pairs of visits with the same engine, driver, hands and builds${u.rounds?.length ? ` (rounds ${u.rounds.join(", ")})` : ""}: that verdict is a coin for now`,
      "send a second fresh visit of her before trusting one result; the variance itself is the fix (sue/ab.mjs reads two rounds of each arm and leaves out a Sue whose path varied between them)",
    );

  return items.sort((a, b) => b.weight - a.weight || String(a.subject).localeCompare(String(b.subject)));
}

/** The queue as text: the heaviest `top` items, each with its one action. */
export function renderSueHunt(items, { top = 25, rounds = null } = {}) {
  if (!items.length)
    return `SUE HUNT: nothing SUE can see wrong with itself in the last ${rounds ?? "few"} rounds - say so, that statement is itself the audit.`;
  const lines = [
    `SUE HUNT: ${items.length} item(s), heaviest first - take the top one (fix SUE in the same session, then measure it with sue/ab.mjs)`,
  ];
  for (const [i, it] of items.slice(0, top).entries()) {
    lines.push(`${String(i + 1).padStart(2)}. [${it.kind}] ${it.subject} - ${it.evidence}`);
    lines.push(`    -> ${it.action}`);
  }
  if (items.length > top) lines.push(`... + ${items.length - top} more (node sue/round.mjs hunt --plan <plan.json> --json for all)`);
  return lines.join("\n");
}

const readJson = (file, fallback) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
};

const rowsOfJsonl = (file) => {
  try {
    return readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
};

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** What landed is origin/main when the checkout has it: `bun run save` lands there and leaves local main behind, holding
 *  local copies of landed commits under other hashes, and an A/B row names the landed hashes. Else HEAD. */
const LANDED_REF = "refs/remotes/origin/main";
const HAS_LANDED = ["rev-parse", "--verify", "--quiet", LANDED_REF];
const decisionLog = (rev) => ["log", rev, `--since=${SUE_AB_POLICY_SINCE}`, "--format=%x00%H", "--name-only", "--", ...SUE_DECISION_PATHS];

function parseDecisionLog(stdout) {
  return stdout
    .split(String.fromCharCode(0))
    .map((block) => block.split(String.fromCharCode(10)).filter(Boolean))
    .filter((lines) => lines.length)
    .map(([sha, ...files]) => ({ sha, files }));
}

/** Commits since the policy's first day that touched a decision file: [{ sha, files }], newest first. A folder that is
 *  not a git checkout reads as none. */
function decisionCommitsOf(root) {
  const run = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 20_000 });
  const r = run(decisionLog(run(HAS_LANDED).status === 0 ? LANDED_REF : "HEAD"));
  return r.status === 0 ? parseDecisionLog(r.stdout) : [];
}

/** The same read, started now and awaited later: git over this checkout takes ~0.4 s, which `report` spends while it
 *  waits on its runs, so the hunt adds nothing to it. Resolves to none on any failure. */
export function decisionCommitsAsync(root) {
  const run = (args, done) => execFile("git", args, { cwd: root, windowsHide: true, timeout: 20_000, maxBuffer: 16 * 1024 * 1024 }, done);
  return new Promise((resolve) => {
    run(HAS_LANDED, (missing) =>
      run(decisionLog(missing ? "HEAD" : LANDED_REF), (err, stdout) => resolve(err ? [] : parseDecisionLog(String(stdout)))),
    );
  });
}

const sueFolders = (runDir) => {
  try {
    return readdirSync(runDir).filter((d) => d.startsWith("sue-"));
  } catch {
    return [];
  }
};

/**
 * The hunt's signals read from disk, ranked. `limit` rounds of the series (default 3) are read, newest last; nothing is
 * written. `root` is the checkout the decision commits are read from, unless `decisionCommits` already holds them.
 */
export function gatherSueHunt({
  workspace,
  series,
  kind = "people",
  runsDir,
  root,
  limit = 3,
  raw = false,
  ledgerFile,
  decisionCommits: given = null,
  pageMotion = [],
} = {}) {
  const all = readRounds(workspace, seriesKey(series, kind)).sort((a, b) => String(a.at).localeCompare(String(b.at)));
  const rows = all.slice(-limit);
  const signals = { noStart: [], sueSide: [], midMotion: [], suspects: [], offProtocol: [], slow: [], unstable: [] };
  if (!rows.length) return raw ? { signals } : [];
  let anySee = false;
  const seeRow = (t) => t?.tool === "see" || t?.move === "see" || (t?.tool === "Read" && /[\\/](eyes|shots)[\\/]/.test(JSON.stringify(t)));

  for (const row of rows) {
    const expected = (row.people ?? row.each?.length ?? 0) + (row.critics?.length ?? 0) - (row.reused?.length ?? 0);
    const started = (row.runIds || []).length;
    if (started < expected)
      signals.noStart.push({
        round: row.round,
        subject: `round ${row.round}`,
        why: `round ${row.round} started ${started} of ${expected} runs: ${plural(expected - started, "run")} never started`,
      });
    const times = [];
    for (const runId of row.runIds || []) {
      const runDir = path.join(runsDir, runId);
      const repro = readLedger(runDir);
      for (const sue of sueFolders(runDir)) {
        const dir = path.join(runDir, sue);
        const summary = readJson(path.join(dir, "summary.json"), {});
        if (summary.outcome === "brain-error")
          signals.noStart.push({
            round: row.round,
            subject: `round ${row.round} ${runId}/${sue}`,
            why: `round ${row.round}: ${runId}/${sue} ended as a brain error${summary.brainError ? ` (${String(summary.brainError).slice(0, 120)})` : ""}`,
          });
        for (const e of repro?.entries ?? [])
          if (e.bucket === "sue-side" && String(e.finding).startsWith(`${sue}:`))
            signals.sueSide.push({ runId, sue, finding: e.finding, why: e.why });
        const findings = rowsOfJsonl(path.join(dir, "findings.jsonl"));
        const mid = findings.filter((f) => f.kind === MID_MOTION_KIND);
        if (mid.length) signals.midMotion.push({ runId, sue, count: mid.length, moving: mid.flatMap((f) => f.moving ?? []) });
        const trace = traceOf(dir);
        const moved = trace.some((t) => t.tool && !seeRow(t));
        // hands-mcp.mjs writes each `see` to her sees.jsonl (never to her trace); a picture Read in the trace counts too.
        const saw = rowsOfJsonl(path.join(dir, "sees.jsonl")).length > 0 || trace.some(seeRow);
        if (saw) anySee = true;
        if (moved && !saw) signals.offProtocol.push({ runId, sue });
        const suspect = sueSideOf(loadSue(runDir, sue));
        const add = (kind, lines) => signals.suspects.push({ kind, runId, sue, lines });
        if (suspect.tiredLines.length) add("tired-driver", suspect.tiredLines.length);
        if (suspect.refusedAt !== null) add("door-refused", suspect.doorLines.length);
        if (suspect.stretches.length) add("frozen-screen", suspect.frozenLines.length);
        if (suspect.lostWindows.length) add("browser-lost", suspect.lostLines.length);
        if (suspect.codeRefusedAt !== null) add("code-refused", suspect.codeLines.length);
      }
      times.push({ name: runId, runId });
    }
    const timed = timeRows(times, runsDir, 0);
    const med = median(timed.filter((x) => x.moves).map((x) => x.perMove));
    for (const x of timed) {
      if (!x.moves) signals.slow.push({ round: row.round, who: x.who, moves: 0 });
      else if (timed.filter((y) => y.moves).length >= 3 && x.moves >= 4 && x.perMove >= SLOW_MIN_S && x.perMove > SLOW_FACTOR * med)
        signals.slow.push({ round: row.round, who: x.who, moves: x.moves, perMove: x.perMove, median: med });
    }
  }
  // With no `see` recorded anywhere, "never made a see move" would be every driver: say the trace cannot tell, once.
  const seeUntraced = !anySee && signals.offProtocol.length > 0;
  if (seeUntraced) signals.offProtocol = [];

  // A persona is a coin when two fresh visits on identical engine, driver, hands and builds disagree.
  for (const who of new Set(rows.flatMap((r) => (r.each || []).map((e) => e.who)))) {
    const visits = visitsOf(rows, runsDir, who);
    const same = (v) => canonical({ p: [v.rec.parts?.engine, v.rec.parts?.driver, v.rec.parts?.hands], b: v.rec.builds });
    const verdict = (v) => {
      const e = rows.find((r) => r.id === v.id)?.each?.find((x) => x.who === who);
      return e ? `${e.stars ?? "-"}/${e.finished ? "f" : "n"}` : null;
    };
    let pairs = 0;
    let flipped = 0;
    const flipRounds = new Set();
    for (let i = 0; i < visits.length; i += 1)
      for (let j = i + 1; j < visits.length; j += 1) {
        if (same(visits[i]) !== same(visits[j])) continue;
        const a = verdict(visits[i]);
        const b = verdict(visits[j]);
        if (a === null || b === null) continue;
        pairs += 1;
        if (a !== b) {
          flipped += 1;
          flipRounds.add(visits[i].round);
          flipRounds.add(visits[j].round);
        }
      }
    if (flipped) signals.unstable.push({ persona: who, pairs, flipped, rounds: [...flipRounds].sort((x, y) => x - y) });
  }

  if (raw) return { signals };

  // The ledger against the decision commits, and against a driver or hands hash that changed between two rounds.
  const ledger = readSueLedger(ledgerFile);
  const decisionCommits = given ?? (existsSync(root || "") ? decisionCommitsOf(root) : []);
  const covered = new Set(ledger.flatMap((r) => r.commits || []));
  const measured = new Set(
    decisionCommits.filter((c) => [...covered].some((m) => c.sha.startsWith(m) || m.startsWith(c.sha))).map((c) => c.sha),
  );
  const ledgerHashes = new Set(
    ledger.flatMap((r) => [r.base, r.head].flatMap((p) => Object.values(p || {}))).filter((v) => typeof v === "string"),
  );
  const hashChanges = [];
  const sorted = all.slice(-(limit + 1));
  const fingerprints = (row) => {
    const out = new Map();
    for (const runId of row.runIds || [])
      for (const sue of sueFolders(path.join(runsDir, runId))) {
        const rec = readJson(path.join(runsDir, runId, sue, "reuse.json"), null);
        if (rec?.round !== row.id || !rec.parts) continue;
        const k = canonical(rec.builds);
        const slot = out.get(k) || { driver: new Set(), hands: new Set() };
        slot.driver.add(rec.parts.driver);
        slot.hands.add(rec.parts.hands);
        out.set(k, slot);
      }
    return out;
  };
  for (let i = 1; i < sorted.length; i += 1) {
    if (Date.parse(sorted[i].at) < Date.parse(SUE_AB_POLICY_SINCE)) continue;
    const before = fingerprints(sorted[i - 1]);
    for (const [k, now] of fingerprints(sorted[i]))
      for (const part of ["driver", "hands"]) {
        const had = before.get(k)?.[part];
        if (!had) continue;
        for (const hash of now[part])
          if (hash && !had.has(hash)) hashChanges.push({ round: sorted[i].round, part, hash, was: [...had][0] });
      }
  }

  return rankSueHunt({ ...signals, pageMotion, seeUntraced, decisionCommits, measured, hashChanges, ledgerHashes });
}
