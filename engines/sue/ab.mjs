#!/usr/bin/env node
import { loadTarget, targetPath } from "../lib/target.mjs";
/**
 * sue/ab.mjs - the A/B every SUE decision change owes: the old arm of visits against the new arm, on the same people
 * and builds (lib/sue-ab.mjs). Reads the rounds on disk; never starts a round. The contract it shares with the hunt:
 * lib/sue-rsi.mjs. The loop: .claude/rules/sue-self-improvement.md.
 *
 *   node sue/ab.mjs --series lift-v2,lift-v2-ab              the newest arm against the newest comparable older arm
 *     (each series is read with its pinned-arm sibling <series>-engine; another product's rounds need --rounds-dir)
 *   node sue/ab.mjs --series <s> --base <hash prefix> --head <hash prefix>   (engine, driver or hands hash)
 *   node sue/ab.mjs ... --record [--note "..."]              append the row to eval/ab-ledger.jsonl
 *   node sue/ab.mjs ... --record --accept "<why>"            record a worse verdict on purpose (exit 0)
 *   node sue/ab.mjs ... --reject --note "<what it tried>"    record a change measured and thrown away
 *   node sue/ab.mjs ... --driver-file <old> <new>            overfit-screen a changed driver agent text
 *   flags: --json --no-git --rounds-dir <dir> --runs-dir <dir> --ledger <file>
 *
 * It prints behaviour first (who took another path, left out of the perception numbers), then each metric's change per
 * visit with its 95% interval against the metric's dead zone, then the verdict (better, worse, same or unresolved) and
 * the stop line: whether another round is owed and of which arm (two rounds of each arm at least, three at most).
 * Exit 1 on worse that was not --accept'ed; unresolved exits 0 and is not a pass. --record refuses (exit 2) an unresolved
 * read that still owes a round (lib/sue-rsi.mjs noBandGate): at the budget it records.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  goldOf,
  ledgerRow,
  METRICS,
  MIN_SHARED_PEOPLE,
  NO_TRACE,
  OVER_EVERYONE,
  overfitSuspects,
  pickArms,
  seriesRows,
  readVisits,
  compareArms,
  comparePersonaDocs,
} from "./lib/sue-ab.mjs";
import { runsRoot } from "./lib/run-dir.mjs";
import { SUE_AB_LEDGER, SUE_DECISION_PATHS, noBandGate } from "./lib/sue-rsi.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const o = { texts: [] };
  const take = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--series") o.series = String(take(i++)).split(",").filter(Boolean);
    else if (["--base", "--head", "--note", "--accept", "--rounds-dir", "--runs-dir", "--ledger", "--persona"].includes(a))
      o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = take(i++);
    else if (a === "--driver-file" || a === "--text-file") {
      o.texts.push({ label: a.slice(2), old: take(i), new: argv[i + 2] });
      i += 2;
    } else if (["--record", "--reject", "--json", "--no-git"].includes(a))
      o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

const git = (...args) => execFileSync("git", args, { cwd: REPO, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });

/** True when commit `a` is in `b`'s history (git exits 1 for no, which throws). */
function isAncestor(a, b) {
  try {
    git("merge-base", "--is-ancestor", a, b);
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits touching a decision file that the head has and the base has not, newest first: between the two pinned
 * commits when both arms ran on Sue's code at a git ref, else between the two arms' newest visits. Time alone named a
 * commit that landed while lift-v2-engine's rounds ran and was in neither arm (2026-10-04).
 */
function decisionCommits(base, head) {
  const range = base.commit && head.commit ? [`${base.commit}..${head.commit}`] : [`--since=${base.newest}`, `--until=${head.newest}`];
  try {
    return git("log", ...range, "--format=%H", "--", ...SUE_DECISION_PATHS)
      .split("\n")
      .filter(Boolean);
  } catch {
    return [];
  }
}

const readText = (file) => readFileSync(file, "utf8");

function textPairs(opts, commits) {
  const pairs = opts.texts.map((t) => ({ label: t.label, baseText: readText(t.old), headText: readText(t.new) }));
  const ws = "sue/lib/workspace.mjs";
  if (commits.length && !opts.noGit) {
    try {
      pairs.push({ label: ws, baseText: git("show", `${commits[commits.length - 1]}~1:${ws}`), headText: readText(path.join(REPO, ws)) });
    } catch {
      /* the file did not exist before, or no history: nothing to screen */
    }
  }
  return pairs;
}

const fixed = (n) => (Number.isFinite(n) ? n.toFixed(2) : "-");
const signed = (n) => (Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}` : "-");
const listOf = (names) => (names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}` : names[0] || "");

/** Prints a path; routes lose their host when every printed route shares one (a route is host + path + hash). */
function pathPrinter(diverged) {
  const at = (route) => (route.includes("/") ? route.indexOf("/") : route.length);
  const routes = diverged.flatMap((d) => (d.kind === "changed" ? [...(d.base || []), ...(d.head || [])] : []));
  const strip = new Set(routes.map((route) => route.slice(0, at(route)))).size === 1;
  return (list) => (list ? list.map((route) => (strip ? route.slice(at(route)) : route)).join(" > ") : NO_TRACE);
}

/** The stop line: another round or not, and which arm, with the command that pins that arm's engine when it ran pinned. */
function nextLine(r) {
  const a = r.another;
  if (!a.round) return `another round: no - ${a.why}`;
  const notes = [];
  if (Math.min(r.rounds.base, r.rounds.head) >= r.stat.minRounds) notes.push(`${r.rounds[a.arm]} of ${r.stat.maxRounds}`);
  if (r[a.arm].commit) notes.push(`node sue/round.mjs start --plan <plan> --engine-ref ${r[a.arm].commit} --fresh`);
  return `another round: yes - ${a.why}; next: a round of the ${a.arm} arm${notes.length ? ` (${notes.join("; ")})` : ""}`;
}

function render(r, suspects) {
  const lines = [];
  lines.push(
    `base ${r.base.key}  ${r.base.visits} visits in ${r.base.rounds} round(s)    head ${r.head.key}  ${r.head.visits} visits in ${r.head.rounds} round(s)`,
  );
  lines.push(
    `people in both: ${r.personas.join(", ") || "none"}; ${r.sameBuild ? "same builds" : "THE BUILDS DIFFER between the arms: this reads the change and the site together"}`,
  );
  if (r.only.base.length) lines.push(`only in the base arm: ${r.only.base.join(", ")}`);
  if (r.only.head.length) lines.push(`only in the head arm: ${r.only.head.join(", ")}`);
  // Behaviour before any number: a Sue who took another path did other work, and her numbers measure that work.
  if (!r.diverged.length) lines.push(`behaviour first: every one of the ${r.personas.length} took the same path in both arms`);
  else {
    const perPath = METRICS.filter((m) => !OVER_EVERYONE.has(m));
    lines.push(
      `behaviour first: ${r.diverged.length} of ${r.personas.length} took another path, left out of ${listOf(perPath)} (${listOf([...OVER_EVERYONE])} counts everyone)`,
    );
    const show = pathPrinter(r.diverged);
    for (const d of r.diverged) {
      const moved = Object.entries(d.outcomes || {}).map(([m, o]) => `${m} ${o.base} -> ${o.head}`);
      const who = moved.length ? `${d.who} (${moved.join(", ")})` : d.who;
      lines.push(
        d.kind === "changed"
          ? `  changed   ${who}: ${show(d.base)}  ->  ${show(d.head)}`
          : `  unstable  ${who}: ${d.variants} paths across the ${d.side} arm's ${r.rounds[d.side]} rounds`,
      );
    }
  }
  for (const m of METRICS) {
    const x = r.metrics[m];
    const judged = x.deadZone != null;
    if (x.people < MIN_SHARED_PEOPLE) {
      const over = OVER_EVERYONE.has(m) ? "in both arms" : `of ${r.personas.length} kept their path`;
      lines.push(`${m.padEnd(10)} not read: ${x.people} ${over}, and a change needs ${MIN_SHARED_PEOPLE}`);
      continue;
    }
    lines.push(
      `${m.padEnd(10)} base ${fixed(x.base)}  head ${fixed(x.head)}  change ${signed(x.estimate)} per visit  ${Math.round(x.level * 100)}% [${signed(x.low)}, ${signed(x.high)}]  ${judged ? `dead zone ±${x.deadZone}  ` : ""}over ${x.people}  ${judged ? x.verdict : "(shown, not judged)"}`,
    );
  }
  for (const s of suspects) lines.push(`overfit flag (${s.label}): "${s.phrase}" sits in ${s.gold.join(", ")} - a flag, not a verdict`);
  lines.push(`verdict: ${r.verdict}${r.resolved ? " (resolved)" : ""}`);
  lines.push(nextLine(r));
  return lines.join("\n");
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.series?.length) throw new Error("--series <name>[,<name>...] is required");
  if (opts.reject && !opts.note) throw new Error('--reject needs --note "<what it tried, what it did>"');
  const roundsDir = opts.roundsDir || targetPath(loadTarget().sueStore, "rounds"); // where round.mjs keeps a series (lib/rounds.mjs roundsFile)
  const runsDir = opts.runsDir || runsRoot();
  const rows = seriesRows(roundsDir, opts.series);
  const visits = readVisits({ rows, runsDir });
  if (opts.persona) {
    const one = comparePersonaDocs(visits, opts.persona);
    console.log(opts.json ? JSON.stringify(one, null, 2) : `${one.persona}: ${one.verdict} (${one.why})`);
    return;
  }
  const unlabelled = visits.filter((v) => !v.arm).length;
  const picked = pickArms(visits, { base: opts.base, head: opts.head, isAncestor: opts.noGit ? null : isAncestor });
  if (!picked.base) {
    const out = { verdict: "no comparison", why: picked.why, visits: visits.length, unlabelled };
    console.log(
      opts.json
        ? JSON.stringify(out)
        : `no comparison: ${picked.why} (${visits.length} fresh visits read, ${unlabelled} without an identity)`,
    );
    if (opts.record || opts.reject) {
      console.error("nothing to record");
      process.exit(2);
    }
    return;
  }
  const report = compareArms(picked);
  const commits = opts.noGit ? [] : decisionCommits(report.base, report.head);
  const measured = visits.filter(
    (v) =>
      v.arm &&
      [report.head.key, report.base.key].includes(`${v.arm.engine.slice(0, 12)}/${v.arm.driver.slice(0, 12)}/${v.arm.hands.slice(0, 12)}`),
  );
  const suspects = textPairs(opts, commits).flatMap((p) =>
    overfitSuspects({ baseText: p.baseText, headText: p.headText, gold: goldOf(measured) }).map((s) => ({ ...s, label: p.label })),
  );
  const accepted = Boolean(opts.accept);
  const out = { ...report, commits, overfit: suspects, unlabelled };
  console.log(opts.json ? JSON.stringify(out, null, 2) : render(report, suspects, opts));
  if (opts.record && !opts.reject) {
    const gate = noBandGate(report);
    if (!gate.ok) {
      console.error(gate.why);
      process.exit(2);
    }
  }
  if (opts.record || opts.reject) {
    const row = ledgerRow(report, {
      kind: opts.reject ? "rejected" : "measured",
      commits,
      series: opts.series,
      accept: opts.accept,
      note: opts.note,
    });
    const ledger = opts.ledger || SUE_AB_LEDGER;
    mkdirSync(path.dirname(ledger), { recursive: true });
    appendFileSync(ledger, `${JSON.stringify(row)}\n`);
    if (!opts.json) console.log(`recorded in ${ledger}`);
  }
  if (report.verdict === "worse" && !accepted && !opts.reject) {
    console.error('worse beyond the dead zone: land it only with --accept "<why>", or drop the change');
    process.exit(1);
  }
}

try {
  main();
} catch (e) {
  console.error(e.message);
  process.exit(2);
}
