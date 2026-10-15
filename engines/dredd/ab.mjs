#!/usr/bin/env node
/**
 * dredd/ab.mjs - the A/B every decision change owes: the judge's OLD decision code against its NEW decision code, over
 * the SAME gold asks and the SAME classifier answers, before the change lands.
 * ===================================================================================================================
 *
 * Owner ask (the Chair, 2026-09-23): the Architect's RSI instructions integrated into Dredd. The Architect's A/B policy
 * (`.claude/rules/arkitect-self-improvement.md`) exists because a widened exemption stayed green on every unit test
 * while it silently stopped reporting a real site; only old bytes against new bytes over the whole corpus could see it.
 * Dredd's corpus is its gold set (eval/asks.json, eval/seats.json, eval/experts.json) and its decision code is
 * DECISION_PATHS (lib/hunt.mjs): the bench, the docket's rules, the ladder, the seat pick, the expert-homework routing. A tweak that fixes the ask in front of you
 * can quietly break three others; this is how that is seen before it ships. The loop around it:
 * .claude/rules/dredd-self-improvement.md.
 *
 *   node dredd/ab.mjs                         the working tree against HEAD (what you are about to land)
 *   node dredd/ab.mjs --base <ref>            against any commit (<sha>~1 measures a change that already landed)
 *   node dredd/ab.mjs --record [--note "..."] append the verdict to eval/ab-ledger.jsonl (the hunt reads it)
 *   node dredd/ab.mjs --accept "<why>"        record a regression on purpose, with the reason (exit 0)
 *   node dredd/ab.mjs --reject --for <ask ids> --note "<what it tried, what it did>"
 *                                                  write down a change the measurement condemned, with its diff, before
 *                                                  reverting it; the hunt shows it beside those asks from then on
 *   node dredd/ab.mjs --keep "<item>:<phrase>" --note "<why>"
 *                                                  record that a line the overfit screen flagged is the instrument's own
 *                                                  vocabulary, not a lifted answer (repeatable; the hunt stops listing it)
 *   node dredd/ab.mjs --replay <results.json> the Jev arm from that run's saved answers (default: the newest run
 *                                                   that saved them); --no-replay grades the keyword arm alone
 *   flags: --json --force (measure even when no decision file changed)
 *
 * HOW. The base tree is materialized from git into a temp folder with no worktree (dredd whole, plus every file
 * outside it that the base's own eval.mjs reaches by import), this checkout's operator skills are lent to it through a
 * junction (the minds seat reads them; they are input, not decision), the CURRENT gold files are copied over its own so
 * both sides are graded on one set, and each tree runs its own eval.mjs: the keyword arm (free, deterministic) over
 * asks, seats, ballots and the expert routing, and - when saved Jev answers exist and the base's eval knows --replay -
 * the replayed Jev arm over the asks (free: only the decision rules can move that number), and the same over the expert
 * routing from the newest run that saved every unit's p, when the base's eval knows --experts-only ("experts replayed":
 * ROUTE_SIT, ROUTE_MAX and routeSeats on Jev's own answers). No model is called. The asks decide on every
 * metric and on every gold ask that flips; the seats decide per room, and a room the base never seated in is shown as
 * its first measurement, not a slide; the expert routing decides on its whole tally and on every gold unit that stops (or
 * starts) being routed exactly. Exit 1 on a regression that was not --accept'ed.
 *
 * Shown under the verdict, never deciding it (2026-10-07): each run's gold read (`compareRuns` `gold`: would the move
 * survive another draw of asks of this kind, or do one or two asks carry it; a rerun of a deterministic arm repeats it,
 * so only more gold asks can resolve it), and the two full-Jev lines (`jevEvalCall`): whether a paid full eval is owed
 * because a Jev question changed, and whether another one would tell anything beyond the noise band on record.
 */
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { AB_LEDGER, DECISION_PATHS, NOISE_FILE } from "./lib/hunt.mjs";
import { leakageSuspects, NOISE_METRICS, pairedVerdict, readNoise } from "./lib/regularizers.mjs";
import { holdoutIds } from "./lib/routing.mjs";
import { isMainModule } from "../lib/shared/is-main.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const GOLD = ["asks.json", "seats.json", "ballots.json", "experts.json"];
const LOWER_IS_BETTER = new Set(["extra", "extraBeyondMin"]);
/** Shown and never the verdict: how many experts the routing sent in all (fair ones included), a cost to read, not a score. */
const SHOWN_ONLY = new Set(["seats"]);
/** The arm each run is FOR, whose gold read it prints: the keyword run grades only the keywords, the replay is Jev's. */
const RUN_ARM = { keywords: ["heuristic", "experts:heuristic"], "jev replayed": ["jev"], "experts replayed": ["experts:jev"] };

function git(args, opts = {}) {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true, maxBuffer: 256 * 1024 * 1024, ...opts });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${String(r.stderr || r.error?.message || "").trim()}`);
  return r.stdout;
}

/** The number a metric reads as: a [hit, n] pair is its hit count, a count is itself. */
function num(v) {
  return Array.isArray(v) ? Number(v[0]) || 0 : Number(v) || 0;
}

/**
 * Before against after, pure: per arm and metric, the delta; per gold ask, which flipped from right to wrong and back.
 * `before`/`after` are eval results.json objects. verdict: regression | improvement | neutral, by the exact rule below.
 * `gold` is the gold read per arm (lib/regularizers.mjs pairedVerdict), shown and never the verdict: over the asks both
 * runs graded, each ask's change in convened-perfect (0 or 1), bootstrapped over the asks with a dead zone of one ask.
 * Both arms are deterministic (e2e's counters, compared exactly), so a rerun repeats every number and the exact rule
 * stays the gate; the read answers what the exact rule cannot: would this move survive another draw of asks of the
 * same kind, or is it carried by one or two of them (RRSI's overfitting worry, in numbers).
 */
export function compareRuns(before, after) {
  const deltas = [];
  const pairs = [
    ...Object.keys(after?.arms || {}).map((arm) => ["asks", arm, before?.arms?.[arm], after.arms[arm]]),
    ...Object.keys(after?.seats?.arms || {}).map((arm) => ["seats", arm, before?.seats?.arms?.[arm], after.seats.arms[arm]]),
    ...Object.keys(after?.experts?.arms || {}).map((arm) => ["experts", arm, before?.experts?.arms?.[arm], after.experts.arms[arm]]),
  ];
  for (const [part, arm, b, a] of pairs) {
    if (!b) continue;
    // The seat half decides per ROOM (`heuristic:product`, `heuristic:minds`); its all-rooms and holdout tallies are
    // shown but decide nothing, because a room the base never seated in adds its first extras to them and reads as a
    // slide (the first A/B, 2026-09-23: the minds room was new that day, 0 -> 28 extra, every other room 4 -> 4).
    const room = part === "seats" && /:(?!holdout$)/.test(arm);
    const newRoom = room && num(b.sit) === 0 && num(b.exact) === 0;
    // The experts' held-out tally is inside the whole arm's, which decides; shown apart, it decides nothing twice.
    const informational = (part === "seats" && !room) || newRoom || (part === "experts" && arm.endsWith(":holdout"));
    for (const metric of Object.keys(a)) {
      if (metric === "n") continue;
      const shownOnly = part === "experts" && SHOWN_ONLY.has(metric);
      // A metric the base's eval never counted is its first measurement, not a slide from zero (extraBeyondMin,
      // 2026-09-23).
      const newMetric = !(metric in b);
      const d = num(a[metric]) - num(b[metric]);
      if (d)
        deltas.push({
          part,
          arm,
          metric,
          before: num(b[metric]),
          after: num(a[metric]),
          better: LOWER_IS_BETTER.has(metric) ? d < 0 : d > 0,
          ...(informational || newMetric || shownOnly
            ? {
                informational: newMetric
                  ? "a metric the base never counted"
                  : shownOnly
                    ? "experts sent in all, a cost and not a score"
                    : newRoom
                      ? "a room the base never seated in"
                      : part === "experts"
                        ? "the held-out units, already in the whole tally"
                        : "all-rooms tally",
              }
            : {}),
        });
    }
  }
  const flips = [];
  const beforeRows = new Map((before?.rows || []).map((r) => [r.id, r]));
  for (const r of after?.rows || []) {
    const b = beforeRows.get(r.id);
    if (!b) continue;
    for (const arm of Object.keys(r.arms || {})) {
      const was = b.arms?.[arm]?.s?.convMisses?.length ?? null;
      const now = r.arms[arm]?.s?.convMisses?.length ?? null;
      if (was === null || now === null || !was === !now) continue;
      flips.push({ id: r.id, arm, to: now ? "wrong" : "right", misses: r.arms[arm].s.convMisses, convened: r.arms[arm].convene });
    }
  }
  // A gold complaint unit routed exactly before and not after (or the reverse) is a flip like an ask's.
  const beforeUnits = new Map((before?.experts?.rows || []).map((r) => [r.id, r]));
  for (const r of after?.experts?.rows || []) {
    const b = beforeUnits.get(r.id);
    if (!b) continue;
    for (const arm of Object.keys(r.arms || {})) {
      const was = b.arms?.[arm]?.s?.exact;
      const now = r.arms[arm]?.s?.exact;
      if (typeof was !== "boolean" || typeof now !== "boolean" || was === now) continue;
      const s = r.arms[arm].s;
      flips.push({
        part: "experts",
        id: r.id,
        arm,
        to: now ? "right" : "wrong",
        misses: s.misses.length ? s.misses : [`extra ${s.extra.join(", ")}`],
        routed: r.arms[arm].routed,
      });
    }
  }
  const deciding = deltas.filter((d) => !d.informational);
  const worse =
    deciding.some((d) => !d.better) ||
    flips.some((f) => f.to === "wrong") ||
    (before?.ballots && after?.ballots && after.ballots.right < before.ballots.right);
  const better = deciding.some((d) => d.better) || flips.some((f) => f.to === "right");
  const gold = {};
  for (const arm of new Set((after?.rows || []).flatMap((r) => Object.keys(r.arms || {})))) {
    const diffs = [];
    for (const r of after?.rows || []) {
      const was = beforeRows.get(r.id)?.arms?.[arm]?.s;
      const now = r.arms?.[arm]?.s;
      if (was && now) diffs.push(NOISE_METRICS.convPerfect(now) - NOISE_METRICS.convPerfect(was));
    }
    gold[arm] = pairedVerdict(diffs, { threshold: diffs.length ? 1 / diffs.length : 0 });
  }
  for (const arm of new Set((after?.experts?.rows || []).flatMap((r) => Object.keys(r.arms || {})))) {
    const diffs = [];
    for (const r of after.experts.rows) {
      const was = beforeUnits.get(r.id)?.arms?.[arm]?.s;
      const now = r.arms?.[arm]?.s;
      if (was && now) diffs.push(Number(now.exact) - Number(was.exact));
    }
    gold[`experts:${arm}`] = pairedVerdict(diffs, { threshold: diffs.length ? 1 / diffs.length : 0 });
  }
  return { verdict: worse ? "regression" : better ? "improvement" : "neutral", deltas, flips, gold };
}

/** The gold read as one line: the net move in asks, its interval per ask, and why an unresolved one stays so. */
function goldLine(arm, g) {
  const kind = arm.startsWith("experts:") ? "unit" : "ask";
  if (!g?.n) return `gold read (${arm}): no ${kind} graded by both trees`;
  const net = Math.round(g.estimate * g.n);
  const per = (x) => `${x >= 0 ? "+" : ""}${x.toFixed(3)}`;
  const why =
    g.verdict === "unresolved"
      ? ` - a deterministic arm, a rerun repeats it; only more gold ${kind}s of this kind can resolve it`
      : g.verdict === "same"
        ? ` - inside one ${kind}`
        : ` - beyond one ${kind}, so not carried by one or two ${kind}s alone (shown, never the verdict)`;
  return `gold read (${arm}): ${net >= 0 ? "+" : ""}${net} ${kind}${Math.abs(net) === 1 ? "" : "s"} net of ${g.n}, ${Math.round(g.level * 100)}% [${per(g.low)}, ${per(g.high)}] per ${kind}, dead zone ±${g.threshold.toFixed(3)} (one ${kind}): ${g.verdict}${why}`;
}

function json(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Every seat file of a seats folder, parsed; an unreadable one is skipped. */
function seatFiles(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .map((f) => json(path.join(dir, f), null))
        .filter(Boolean)
    : [];
}

/**
 * The Jev questions a change rewrote, added or dropped: `bench/<instrument id>` and `seat/<id>` whose `jev` text differs
 * between the two trees' dredd folders. The replayed arm cannot see one: its answers belong to the old question.
 */
export function jevQuestions(baseDredd, headDredd) {
  const out = [];
  const differ = (prefix, before, after) => {
    const was = new Map(before.filter((x) => x?.id).map((x) => [x.id, x.jev ?? ""]));
    const now = new Map(after.filter((x) => x?.id).map((x) => [x.id, x.jev ?? ""]));
    for (const id of [...new Set([...was.keys(), ...now.keys()])].sort())
      if ((was.get(id) ?? "") !== (now.get(id) ?? "")) out.push(`${prefix}/${id}`);
  };
  const instruments = (dir) => json(path.join(dir, "bench.json"), { instruments: [] }).instruments || [];
  differ("bench", instruments(baseDredd), instruments(headDredd));
  differ("seat", seatFiles(path.join(baseDredd, "seats")), seatFiles(path.join(headDredd, "seats")));
  return out;
}

/**
 * Whether a paid full Jev eval is owed, and whether another one would tell anything. Owed when a Jev question changed
 * (the rule: run the full eval after one). Another is worth paying for only when an ask that moved in the replayed arm
 * (`moved`, its flip ids) flipped between runs of unchanged code (`noise`, eval/noise.json's `unstable`): every other
 * ask gave the same answer on every rerun on record, so a rerun repeats it. `another` is null with no noise file.
 * A seat's question also seats the hearings and routes the homework, so for one the owed line names the seat pick's and
 * the routing's bands too (eval/noise.json `seats` and `experts`, lib/regularizers.mjs partBand): two rewrites of
 * Grandma Sue's were read on the routing alone while the seat pick fell 18 -> 14 (2026-10-10).
 * -> { owed, questions, another, coins, why: { owed, another } }
 */
export function jevEvalCall({ questions = [], moved = [], noise = null } = {}) {
  const owed = questions.length > 0;
  const whyOwed = owed
    ? `${questions.length} Jev question(s) changed (${questions.join(", ")}): the replayed answers are the old questions' answers; run node dredd/eval.mjs and read its move through the noise band${questions.some((q) => q.startsWith("seat/")) ? `; ${seatBands(noise)}` : ""}`
    : "no Jev question changed, so the replayed answers measured this change";
  if (!noise)
    return {
      owed,
      questions,
      another: null,
      coins: [],
      why: { owed: whyOwed, another: "no noise band on record (node dredd/eval.mjs --noise 3)" },
    };
  const unstable = new Set((noise.unstable || []).map((u) => u.id));
  const coins = [...new Set(moved)].filter((id) => unstable.has(id));
  const record = `${noise.runs ?? "?"} runs of unchanged code, ${String(noise.at || "").slice(0, 10) || "undated"}`;
  return {
    owed,
    questions,
    another: coins.length > 0,
    coins,
    why: {
      owed: whyOwed,
      another: coins.length
        ? `${coins.join(", ")} moved and flipped between runs of unchanged code (eval/noise.json, ${record}): one more full eval tells the coin from the change`
        : `no ask that moved is unstable in eval/noise.json (${record})`,
    },
  };
}

/** Where a seat question's move on the seat pick and the routing is read: each band's deltas over all its items. */
function seatBands(noise) {
  const band = (part, label) => {
    const metrics = noise?.[part]?.groups?.all?.metrics;
    if (!metrics) return `no ${part} band on record (node dredd/eval.mjs --noise 3)`;
    const deltas = Object.entries(metrics).map(([m, v]) => `${m} ${v.delta}`);
    return `eval/noise.json's ${part} band (${label}${deltas.join(", ")})`;
  };
  return `a seat question also seats the hearings and routes the homework: read the seat pick's and the expert routing's moves the eval prints (per room, per unit) through ${band("seats", "all rooms: ")} and ${band("experts", "")}`;
}

/** Every file of `ref` under `prefixes`, written under `dest`, through one `git cat-file --batch` (no worktree - the
 *  repository never gets a second checkout, AGENTS.md). */
export function materialize(ref, prefixes, dest) {
  const files = git(["ls-tree", "-r", "--name-only", ref, "--", ...prefixes])
    .split(/\r?\n/)
    .filter(Boolean);
  const r = spawnSync("git", ["cat-file", "--batch"], {
    cwd: ROOT,
    input: files.map((f) => `${ref}:${f}`).join("\n") + "\n",
    maxBuffer: 512 * 1024 * 1024,
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`git cat-file: ${String(r.stderr || "").trim()}`);
  const out = r.stdout;
  let at = 0;
  for (const f of files) {
    const nl = out.indexOf(10, at);
    const header = out.subarray(at, nl).toString("utf8");
    const size = Number(/ blob (\d+)$/.exec(header)?.[1]);
    if (!Number.isFinite(size)) throw new Error(`git cat-file: no blob for ${f} (${header})`);
    const body = out.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1;
    const target = path.join(dest, f);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, body);
  }
  return files.length;
}

const IMPORT_RX = /\bfrom\s*["'](\.{1,2}\/[^"']+)["']|\bimport\(\s*["'](\.{1,2}\/[^"']+)["']\s*\)|^\s*import\s*["'](\.{1,2}\/[^"']+)["']/gm;

/**
 * Every repository file `entries` reach through relative imports, AS OF the commit `read` reads from - the base's own
 * graph, not today's, so a module the old code imported and the new one dropped is still there for it (the first A/B,
 * 2026-09-23, died on sue/lib/claude-cli.mjs because a hand-kept folder list missed it). `read(rel)` returns the
 * file's text at that commit, or null when it has none.
 */
export function importClosure(entries, read) {
  const seen = new Set();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (seen.has(rel)) continue;
    const text = read(rel);
    if (text === null) continue;
    seen.add(rel);
    for (const m of text.matchAll(IMPORT_RX)) {
      const spec = m[1] || m[2] || m[3];
      queue.push(path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec)));
    }
  }
  return [...seen];
}

/** The newest eval run under `root` that saved Jev's answers for the asks (or, with "experts", every unit's p), or null. */
export function newestReplayable(root, part = "asks") {
  const dir = path.join(root, "tmp", "dredd");
  if (!existsSync(dir)) return null;
  for (const name of readdirSync(dir)
    .filter((f) => /^eval-\d/.test(f))
    .sort()
    .reverse()) {
    const file = path.join(dir, name, "results.json");
    try {
      const res = JSON.parse(readFileSync(file, "utf8"));
      const rows = part === "experts" ? res.experts?.rows : res.rows;
      const saved = (r) => (part === "experts" ? r.arms?.jev?.p : r.arms?.jev?.answers);
      if (rows?.length && rows.every((r) => saved(r) && !r.arms.jev.note?.startsWith("jev unavailable"))) return file;
    } catch {
      /* not a run */
    }
  }
  return null;
}

/**
 * The overfit screen (RRSI's leakage critic, deterministic half - lib/regularizers.mjs): every keyword or `jev` phrase
 * the change ADDED to a bench instrument or a seat that sits verbatim in one or two gold texts. The A/B cannot see it:
 * a line that copies the ask it was written for flips that ask to right and reads as an IMPROVEMENT. `baseDredd` and
 * `headDredd` are the two trees' dredd folders.
 */
export function overfitScreen(baseDredd, headDredd, touched) {
  const out = [];
  if (touched.includes("dredd/bench.json")) {
    const asks = json(path.join(headDredd, "eval", "asks.json"), { asks: [] }).asks;
    out.push(
      ...leakageSuspects({
        base: json(path.join(baseDredd, "bench.json"), { instruments: [] }).instruments,
        head: json(path.join(headDredd, "bench.json"), { instruments: [] }).instruments,
        gold: asks.map((a) => ({ id: a.id, text: a.ask })),
        heldOut: holdoutIds(asks),
      }).map((s) => ({ ...s, item: `bench/${s.item}` })),
    );
  }
  if (touched.some((f) => f.startsWith("dredd/seats/"))) {
    const briefs = json(path.join(headDredd, "eval", "seats.json"), { briefs: [] }).briefs;
    out.push(
      ...leakageSuspects({
        base: seatFiles(path.join(baseDredd, "seats")),
        head: seatFiles(path.join(headDredd, "seats")),
        gold: briefs.map((b) => ({ id: b.id, text: b.brief })),
        heldOut: new Set(briefs.filter((b) => b.holdout).map((b) => b.id)),
      }).map((s) => ({ ...s, item: `seat/${s.item}` })),
    );
  }
  return out;
}

/** Run one tree's eval.mjs and return the results.json it wrote. */
function runEval(tree, flags) {
  const evalDir = path.join(tree, "tmp", "dredd");
  const startedAt = Date.now() - 1000;
  // eval.mjs imports the fleet's one worker pool straight from its .ts home (map-with-concurrency.ts), which Node 22.13
  // loads only with type stripping on: without the flag both arms died at import and every A/B read UNMEASURED (2026-09-27).
  const r = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", path.join(tree, "dredd", "eval.mjs"), ...flags],
    { cwd: tree, encoding: "utf8", windowsHide: true, timeout: 10 * 60 * 1000 },
  );
  // The folder the run itself names on its last line ("→ <dir>"), written after its results: a run that died never
  // prints it. Picking by write time let a crashed replay arm borrow a file and the A/B printed NEUTRAL over an arm
  // that measured nothing (the Dredd self-pass, 2026-09-23). An eval exits 1 on a void-rule miss and still finished.
  const named = [...String(r.stdout || "").matchAll(/→ (.+?eval-[\dT]+(?:-\d+)?)\s*$/gm)].pop()?.[1];
  const file = named && path.resolve(named).startsWith(path.resolve(evalDir)) ? path.join(named, "results.json") : null;
  if (!file || !existsSync(file) || statSync(file).mtimeMs < startedAt)
    return {
      error: `eval ${flags.join(" ")} in ${tree} did not finish (exit ${r.status}): ${String(r.stderr || r.stdout || "")
        .trim()
        .split(/\r?\n/)
        .slice(-2)
        .join(" | ")}`,
    };
  return { results: JSON.parse(readFileSync(file, "utf8")), file };
}

function parseArgs(argv) {
  const a = {
    base: "HEAD",
    record: false,
    note: "",
    accept: null,
    replay: undefined,
    json: false,
    force: false,
    keep: [],
    reject: false,
    for: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const x = argv[i];
    const val = () => {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) throw new Error(`${x} needs a value`);
      return v;
    };
    if (x === "--base") a.base = val();
    else if (x === "--record") a.record = true;
    else if (x === "--note") a.note = val();
    else if (x === "--accept") a.accept = val();
    else if (x === "--keep") {
      const v = val();
      const at = v.indexOf(":");
      if (at < 1 || at === v.length - 1) throw new Error(`--keep takes "<item>:<phrase>", as the hunt prints it (got ${v})`);
      a.keep.push({ item: v.slice(0, at), phrase: v.slice(at + 1) });
    } else if (x === "--reject") a.reject = true;
    else if (x === "--for")
      a.for = val()
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    else if (x === "--replay") a.replay = val();
    else if (x === "--no-replay") a.replay = null;
    else if (x === "--json") a.json = true;
    else if (x === "--force") a.force = true;
    else if (x === "--help" || x === "-h") a.help = true;
    else throw new Error(`unknown argument ${x}`);
  }
  // A kept line is a judgment that the words are the instrument's own; the note is that judgment's reason.
  if (a.keep.length && !a.note) throw new Error("--keep needs --note saying why the words are the instrument's own vocabulary");
  if (a.keep.length) a.record = true;
  if (a.reject && (!a.for.length || !a.note))
    throw new Error('--reject needs --for <gold ask ids> and --note "<what it tried and what the measurement did>"');
  return a;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`dredd ab: ${err.message} (node dredd/ab.mjs --help)\n`);
    process.exit(2);
  }
  if (args.help) {
    process.stdout.write(
      readFileSync(fileURLToPath(import.meta.url), "utf8")
        .split("*/")[0]
        .replace(/^#!.*\n\/\*\*\n/, "")
        .replace(/^ \* ?/gm, ""),
    );
    return;
  }
  const baseSha = git(["rev-parse", "--verify", `${args.base}^{commit}`]).trim();
  const changed = git(["diff", "--name-only", baseSha, "--", ...DECISION_PATHS])
    .split(/\r?\n/)
    .filter(Boolean);
  const untracked = git(["ls-files", "--others", "--exclude-standard", "--", ...DECISION_PATHS])
    .split(/\r?\n/)
    .filter(Boolean);
  const touched = [...new Set([...changed, ...untracked])];
  // A change measured and thrown away is written down BEFORE the revert, with its diff, so the hunt can show it beside
  // the ask it tried to fix and the next fixer does not redraw it (RRSI's negative-result history, SkillOpt's
  // rejected-edit buffer, 2026-09-27). No measurement runs here: the eval or A/B that condemned it already did.
  if (args.reject) {
    if (!touched.length) {
      process.stderr.write("dredd ab: --reject records the change still in the working tree, and no decision file differs\n");
      process.exit(2);
    }
    const diff = git(["diff", baseSha, "--", ...DECISION_PATHS]);
    const row = {
      at: new Date().toISOString(),
      rejected: true,
      for: args.for,
      note: args.note,
      base: baseSha,
      changed: touched,
      diff: diff.slice(0, 6000),
    };
    appendFileSync(AB_LEDGER, `${JSON.stringify(row)}\n`);
    process.stdout.write(
      `rejected change recorded for ${args.for.join(", ")} -> ${path.relative(ROOT, AB_LEDGER).replace(/\\/g, "/")}; now revert it\n`,
    );
    return;
  }
  if (!touched.length && !args.force) {
    process.stdout.write(`dredd ab: no decision file differs from ${args.base} (${DECISION_PATHS.join(", ")}) - nothing to measure\n`);
    return;
  }

  const tree = mkdtempSync(path.join(tmpdir(), "dredd-ab-"));
  try {
    // dredd whole (its data - the bench, the seats, the gold - is read from disk, not imported), plus every file
    // outside it that the base's own eval reaches by import.
    const readAt = (rel) => {
      const r = spawnSync("git", ["show", `${baseSha}:${rel}`], {
        cwd: ROOT,
        encoding: "utf8",
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024,
      });
      return r.status === 0 ? r.stdout : null;
    };
    const outside = importClosure(["dredd/eval.mjs"], readAt).filter((f) => !f.startsWith("dredd/"));
    const n = materialize(baseSha, ["dredd", ...outside], tree);
    for (const g of GOLD) copyFileSync(path.join(HERE, "eval", g), path.join(tree, "dredd", "eval", g));
    // The operator skills are not a decision file but the minds seat reads them (lib/seats.mjs mindSeats): both sides
    // must see the same ones, so the base tree borrows this checkout's through a junction (no admin right needed).
    const skills = path.join(ROOT, ".claude", "skills");
    if (existsSync(skills)) {
      mkdirSync(path.join(tree, ".claude"), { recursive: true });
      symlinkSync(skills, path.join(tree, ".claude", "skills"), "junction");
    }
    const replay = args.replay === undefined ? newestReplayable(ROOT) : args.replay;
    const runs = [{ label: "keywords", flags: ["--heuristic-only"] }];
    // An eval older than --replay ignores the flag and asks Jev for real - a paid run where a free one was promised
    // (the first A/B spent three cents that way, 2026-09-23). So the base must know the flag, or that arm is skipped.
    const baseKnowsReplay = readFileSync(path.join(tree, "dredd", "eval.mjs"), "utf8").includes('"--replay"');
    // A gold ask lands WITH the change it measures, so the saved run never holds it: both arms grade the asks it does
    // hold (--only), and the report names the rest - the base's own eval would otherwise die on the first one.
    const savedIds = replay ? new Set((JSON.parse(readFileSync(path.resolve(replay), "utf8")).rows || []).map((r) => r.id)) : new Set();
    const goldIds = JSON.parse(readFileSync(path.join(HERE, "eval", "asks.json"), "utf8")).asks.map((a) => a.id);
    const unsaved = goldIds.filter((id) => !savedIds.has(id));
    const only = unsaved.length ? ["--only", goldIds.filter((id) => savedIds.has(id)).join(",")] : [];
    if (replay && baseKnowsReplay)
      runs.push({ label: "jev replayed", flags: ["--asks-only", "--replay", path.resolve(replay), ...only], unsaved });
    else if (replay)
      runs.push({
        label: "jev replayed",
        skip: `the base's eval.mjs predates --replay, so it would ask Jev for real - the keyword arm is the measure`,
      });
    // The expert routing the same way, from the newest run that saved every unit's p: free, and only when the base's eval
    // grades the routing at all (one older than --experts-only would run its whole eval, Jev included).
    const expertsReplay = args.replay === null ? null : newestReplayable(ROOT, "experts");
    const baseKnowsExperts = readFileSync(path.join(tree, "dredd", "eval.mjs"), "utf8").includes('"--experts-only"');
    if (expertsReplay && baseKnowsExperts) {
      const savedUnits = new Set((JSON.parse(readFileSync(expertsReplay, "utf8")).experts?.rows || []).map((r) => r.id));
      const goldUnits = JSON.parse(readFileSync(path.join(HERE, "eval", "experts.json"), "utf8")).units.map((u) => u.id);
      runs.push({
        label: "experts replayed",
        flags: ["--experts-only", "--replay", expertsReplay],
        unsaved: goldUnits.filter((id) => !savedUnits.has(id)),
      });
    } else
      runs.push({
        label: "experts replayed",
        skip: !expertsReplay
          ? "no eval run saved Jev's routing answers yet (eval.mjs --experts-only, cents) - the keyword arm is the measure"
          : "the base's eval.mjs predates --experts-only - the keyword arm is the measure",
      });

    const report = {
      at: new Date().toISOString(),
      base: baseSha,
      head: git(["rev-parse", "HEAD"]).trim(),
      changed: touched,
      // The exact bytes measured, by git blob: `bun run save` lands the change on origin's tip, not on this HEAD, so the
      // hunt matches a landed commit to its row by these, never by sha or parent (lib/hunt.mjs, 2026-09-23).
      blobs: Object.fromEntries(touched.map((f) => [f, existsSync(path.join(ROOT, f)) ? git(["hash-object", "--", f]).trim() : null])),
      files: n,
      replay: replay ? path.relative(ROOT, path.resolve(replay)).replace(/\\/g, "/") : null,
      expertsReplay: expertsReplay ? path.relative(ROOT, expertsReplay).replace(/\\/g, "/") : null,
      runs: [],
    };
    for (const run of runs) {
      if (run.skip) {
        report.runs.push({ label: run.label, skipped: run.skip });
        continue;
      }
      const before = runEval(tree, run.flags);
      const after = runEval(ROOT, run.flags);
      if (before.error || after.error) {
        report.runs.push({ label: run.label, error: before.error || after.error });
        continue;
      }
      report.runs.push({
        label: run.label,
        ...compareRuns(before.results, after.results),
        ...(run.unsaved?.length ? { unsaved: run.unsaved } : {}),
      });
    }
    const measured = report.runs.filter((r) => !r.error && !r.skipped);
    report.verdict = !measured.length
      ? "unmeasured"
      : measured.some((r) => r.verdict === "regression")
        ? "regression"
        : measured.some((r) => r.verdict === "improvement")
          ? "improvement"
          : "neutral";
    if (args.accept) report.accepted = args.accept;
    if (args.note) report.note = args.note;
    if (args.keep.length) report.kept = args.keep;
    // Informational, never the verdict: a heuristic screen that failed a change on its own would be a false red. The
    // hunt lists every row that carries one for two weeks, so a lifted line is read by a person or a later pass.
    const overfit = overfitScreen(path.join(tree, "dredd"), HERE, touched);
    if (overfit.length) report.overfit = overfit;
    // Never the verdict either: whether the paid live eval is owed (a changed Jev question, which the replayed answers
    // cannot see), and whether another one would tell anything (only when an ask that moved is a known coin).
    const replayed = measured.find((r) => r.label === "jev replayed");
    report.jevEval = jevEvalCall({
      questions: jevQuestions(path.join(tree, "dredd"), HERE),
      moved: (replayed?.flips || []).filter((f) => f.arm === "jev").map((f) => f.id),
      noise: readNoise(NOISE_FILE),
    });

    if (args.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    else {
      const lines = [
        `DREDD A/B · ${args.base} (${baseSha.slice(0, 10)}) -> working tree · ${touched.length} decision file(s): ${touched.join(", ")}`,
      ];
      for (const r of report.runs) {
        if (r.error || r.skipped) {
          lines.push(`  ${r.label}: ${r.skipped ? `skipped - ${r.skipped}` : `NOT MEASURED - ${r.error}`}`);
          continue;
        }
        lines.push(`  ${r.label}: ${r.verdict.toUpperCase()}`);
        if (r.unsaved?.length)
          lines.push(
            `    (${r.unsaved.length} gold ${r.label === "experts replayed" ? "unit" : "ask"}(s) newer than the saved answers, graded by the keyword arm only: ${r.unsaved.join(", ")})`,
          );
        for (const d of r.deltas)
          lines.push(
            `    ${d.informational ? " " : d.better ? "+" : "-"} ${d.part}/${d.arm} ${d.metric}: ${d.before} -> ${d.after}${d.informational ? `  (${d.informational})` : ""}`,
          );
        for (const f of r.flips)
          lines.push(
            `    ${f.to === "right" ? "fixed " : "BROKE "} ${f.part === "experts" ? "unit " : ""}${f.id} (${f.arm})${f.to === "wrong" ? `: ${f.misses.join("; ")}` : ""}`,
          );
        for (const own of RUN_ARM[r.label] || []) if (r.gold?.[own]) lines.push(`    ${goldLine(own, r.gold[own])}`);
      }
      if (report.overfit?.length) {
        lines.push(
          `  overfit screen: ${report.overfit.length} added line(s) sit verbatim in the gold - a line that copies its ask scores that ask and nothing like it; say the mechanism instead`,
        );
        for (const s of report.overfit)
          lines.push(
            `    ! ${s.item} ${s.kind} "${s.phrase}" <- ${s.gold.join(", ")}${s.heldOut.length ? "  [HELD OUT: spoils the held-out check]" : ""}`,
          );
      }
      const call = report.jevEval;
      lines.push(`  full Jev eval: ${call.owed ? "owed" : "not owed"} - ${call.why.owed}`);
      lines.push(`  another full Jev eval: ${call.another === null ? "unknown" : call.another ? "yes" : "no"} - ${call.why.another}`);
      lines.push(`verdict: ${report.verdict.toUpperCase()}${report.accepted ? ` (accepted: ${report.accepted})` : ""}`);
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    if (args.record || args.accept) {
      appendFileSync(AB_LEDGER, `${JSON.stringify(report)}\n`);
      process.stdout.write(`recorded -> ${path.relative(ROOT, AB_LEDGER).replace(/\\/g, "/")}\n`);
    }
    if (report.verdict === "regression" && !args.accept) process.exitCode = 1;
    if (report.verdict === "unmeasured") process.exitCode = 1;
  } finally {
    // The junction first, on its own: a recursive remove must never walk through it into this checkout's skills.
    try {
      unlinkSync(path.join(tree, ".claude", "skills"));
    } catch {
      /* none was made */
    }
    rmSync(tree, { recursive: true, force: true });
  }
}

if (isMainModule(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`dredd ab: ${err?.stack || err}\n`);
    process.exitCode = 1;
  });
}
