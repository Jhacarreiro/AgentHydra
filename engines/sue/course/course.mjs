#!/usr/bin/env node
/**
 * course.mjs - the SUE course: a folder of small pages, each hard for a visitor in one way, some
 * with one planted product bug, so a wave over it says what SUE can and cannot do on a page whose
 * answer is known. See README.md beside this file for the page contract.
 *
 *   node sue/course/course.mjs scenarios        writes .sue/scenarios/<slug>.json for every page
 *   node sue/course/course.mjs score <run id>   reads runs/<id>/, prints and writes course-score.json
 *   node sue/course/course.mjs list             every page folder found and what is wrong with it
 *
 * `score` also takes `--runs-dir <dir>` (default: SUE's own runs folder) and `--site <dir>`.
 * Who depends on it: serve.mjs (`listPages`), tests/course.spec.mjs. Never bun for the browser parts.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SITE_DIR = path.join(HERE, "site");
export const SUE_DIR = path.join(HERE, ".sue");

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GENERATED_BY = "sue/course/course.mjs scenarios";

// ---------------------------------------------------------------------------------------------
// pages
// ---------------------------------------------------------------------------------------------

/** What is wrong with one page.json, as plain sentences; empty when it keeps the contract. */
export function pageProblems(page, folder) {
  const problems = [];
  const text = (value) => typeof value === "string" && value.trim().length > 0;
  if (!page || typeof page !== "object" || Array.isArray(page)) return ["page.json is not an object"];
  if (!text(page.slug) || !SLUG.test(page.slug)) problems.push("slug must be a lowercase slug");
  else if (folder && page.slug !== folder) problems.push(`slug "${page.slug}" is not its folder's name "${folder}"`);
  if (!text(page.title)) problems.push("title is missing");
  if (!text(page.surface) || /\n/.test(page.surface)) problems.push("surface must be one line");
  if (!text(page.task)) problems.push("task is missing");
  if (!page.success || typeof page.success !== "object" || !("text" in page.success)) problems.push("success must be { text }");
  else if (page.success.text !== null && !text(page.success.text)) problems.push("success.text must be words on screen, or null");
  if (page.plantedBug !== null) {
    const bug = page.plantedBug;
    if (!bug || typeof bug !== "object") problems.push("plantedBug must be null or { what, keywords }");
    else {
      if (!text(bug.what)) problems.push("plantedBug.what is missing");
      if (!Array.isArray(bug.keywords) || !bug.keywords.length || bug.keywords.some((k) => !text(k)))
        problems.push("plantedBug.keywords must be a list of words");
    }
  }
  if (page.success && page.success.text === null && page.plantedBug === null) problems.push("success.text may be null only on a bug page");
  if (!text(page.credit) || !/tester-army\/e2e/.test(page.credit) || !/Apache-2\.0/.test(page.credit))
    problems.push("credit must name tester-army/e2e and Apache-2.0");
  return problems;
}

/** Every page folder under `siteDir` (a folder with a page.json), sorted: `{ slug, dir, page, problems }`. */
export function listPages(siteDir = SITE_DIR) {
  if (!existsSync(siteDir)) return [];
  return readdirSync(siteDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(siteDir, entry.name, "page.json")))
    .map((entry) => {
      const dir = path.join(siteDir, entry.name);
      let page = null;
      let problems;
      try {
        page = JSON.parse(readFileSync(path.join(dir, "page.json"), "utf8"));
        problems = pageProblems(page, entry.name);
      } catch (error) {
        problems = [`page.json does not parse: ${error.message}`];
      }
      return { slug: entry.name, dir, page, problems };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------------------------
// scenarios: one per page, in the shape lib/personas.mjs loadScenario reads
// ---------------------------------------------------------------------------------------------

/** The scenario a Sue is sent on for one page. Never names the planted bug: she has to find it. */
export function scenarioFor(page) {
  const done = page.success.text;
  return {
    id: page.slug,
    title: page.title,
    generatedBy: GENERATED_BY,
    errand: page.task,
    startPath: `/${page.slug}/`,
    prompt:
      "This is one page of a small website. Do what you came for, the way you really would. " +
      "If anything on the page looks wrong, does not add up or does not answer when you use it, write down exactly what you saw. " +
      "Stop when it is done, or when you are sure it cannot be done here.",
    createsAccount: false,
    expectedLandingPattern: null,
    successWhen: done ? `The page says "${done}".` : "She did what she came for, or said exactly what on the page stopped her.",
  };
}

/** Writes `<sueDir>/scenarios/<slug>.json` for every valid page and removes the generated ones whose page is gone. */
export function writeScenarios({ siteDir = SITE_DIR, sueDir = SUE_DIR } = {}) {
  const dir = path.join(sueDir, "scenarios");
  mkdirSync(dir, { recursive: true });
  const pages = listPages(siteDir);
  const written = [];
  const skipped = [];
  for (const { slug, page, problems } of pages) {
    if (problems.length) {
      skipped.push({ slug, problems });
      continue;
    }
    writeFileSync(path.join(dir, `${slug}.json`), JSON.stringify(scenarioFor(page), null, 2) + "\n", "utf8");
    written.push(slug);
  }
  const removed = [];
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".json"))) {
    const slug = name.slice(0, -5);
    if (written.includes(slug)) continue;
    try {
      const old = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
      if (old.generatedBy === GENERATED_BY && !pages.some((p) => p.slug === slug)) {
        rmSync(path.join(dir, name));
        removed.push(slug);
      }
    } catch {
      // A file that does not parse is someone's hand-written work in progress; leave it.
    }
  }
  return { written, skipped, removed };
}

// ---------------------------------------------------------------------------------------------
// score: what a finished run did on each page
// ---------------------------------------------------------------------------------------------

/** The slug a URL (full, or a hop's path) sits under, or null. */
export function slugOfUrl(url) {
  if (!url) return null;
  try {
    const first = new URL(String(url), "http://course.invalid/").pathname.split("/").filter(Boolean)[0];
    return first ? decodeURIComponent(first) : null;
  } catch {
    return null;
  }
}

const lower = (value) => String(value ?? "").toLowerCase();

/** The first keyword her words contain, or null. */
export function keywordIn(words, keywords) {
  const said = lower(words);
  return keywords.find((k) => said.includes(lower(k))) ?? null;
}

/**
 * Scores one loaded run (report.mjs `loadRun`'s shape) against the pages: per page `reached` (a Sue
 * saw its success words on that page, or, on a page with none, called done there), `gave-up` (visited,
 * never reached) or `never-visited`; per planted bug `found` (a line she wrote on that page names it
 * in the bug's keywords) or `missed`.
 */
export function scoreLoadedRun(run, pages, { personaOf = (s) => s.summary?.persona ?? s.sue?.persona ?? "unknown" } = {}) {
  const rows = [];
  for (const { slug, page } of pages) {
    const successText = page.success?.text ?? null;
    const visitors = [];
    const reachedBy = [];
    const evidence = [];
    for (const s of run.sues) {
      const scenarioId = s.sue?.scenario?.id ?? s.summary?.scenario ?? null;
      const moves = s.trace ?? [];
      const onPage = [...moves, ...(s.hops ?? [])].some((row) => slugOfUrl(row.url) === slug);
      if (!onPage) continue;
      const who = { sueId: s.sueId, persona: String(personaOf(s)) };
      visitors.push(who);
      const reached = successText
        ? moves.some((row) => slugOfUrl(row.url) === slug && lower(row.pageText).includes(lower(successText)))
        : s.body?.outcome === "done" && slugOfUrl(s.body?.finalUrl) === slug;
      if (reached) reachedBy.push(who);
      if (!page.plantedBug) continue;
      for (const f of s.findings ?? []) {
        if (f.source && f.source !== "brain") continue;
        const here = f.url ? slugOfUrl(f.url) === slug : scenarioId === slug;
        if (!here) continue;
        // A typed problem's title and actual are her words about the bug too (lib/findings.mjs problemNote).
        const said = [f.text, f.why, f.fix, f.problem?.title, f.problem?.actual].filter(Boolean).join(" ");
        const keyword = keywordIn(said, page.plantedBug.keywords);
        if (keyword) evidence.push({ ...who, kind: f.kind ?? null, keyword, said: String(f.text ?? "").trim() });
      }
    }
    rows.push({
      slug,
      title: page.title,
      status: reachedBy.length ? "reached" : visitors.length ? "gave-up" : "never-visited",
      visitors: visitors.length,
      reached: reachedBy.length,
      gaveUp: visitors.length - reachedBy.length,
      bug: page.plantedBug ? { what: page.plantedBug.what, status: evidence.length ? "found" : "missed", evidence } : null,
    });
  }
  const bugs = rows.filter((r) => r.bug);
  return {
    runId: run.runId,
    scoredAt: new Date().toISOString(),
    pages: rows,
    totals: {
      pages: rows.length,
      reached: rows.filter((r) => r.status === "reached").length,
      gaveUp: rows.filter((r) => r.status === "gave-up").length,
      neverVisited: rows.filter((r) => r.status === "never-visited").length,
      bugs: bugs.length,
      bugsFound: bugs.filter((r) => r.bug.status === "found").length,
    },
  };
}

/** Reads `<runsDir>/<runId>/`, scores it, writes course-score.json there, and returns the score. */
export async function scoreRun(runId, { runsDir, siteDir = SITE_DIR } = {}) {
  const report = await import("../report.mjs");
  const { runsRoot } = await import("../lib/run-dir.mjs");
  const dir = runsDir ?? runsRoot();
  if (!existsSync(path.join(dir, runId))) throw new Error(`no run "${runId}" in ${dir}`);
  const run = report.loadRun(dir, runId);
  const pages = listPages(siteDir).filter((p) => !p.problems.length);
  const score = scoreLoadedRun(run, pages, { personaOf: report.personaOf });
  writeFileSync(path.join(run.runDir, "course-score.json"), JSON.stringify(score, null, 2) + "\n", "utf8");
  return { score, file: path.join(run.runDir, "course-score.json") };
}

/** The score as lines a person reads. */
export function renderScore(score) {
  const t = score.totals;
  const lines = [`Course score for run ${score.runId}`, ""];
  for (const row of score.pages) {
    const counts = row.visitors ? ` (${row.reached} of ${row.visitors} visitors reached it)` : "";
    lines.push(`${row.slug.padEnd(28)} ${row.status}${counts}`);
    if (row.bug) {
      const first = row.bug.evidence[0];
      lines.push(`${"".padEnd(28)} bug ${row.bug.status}${first ? `: ${first.persona} said "${first.said}"` : ""}`);
    }
  }
  lines.push("", `Pages: ${t.reached} reached, ${t.gaveUp} gave up, ${t.neverVisited} never visited, of ${t.pages}.`);
  lines.push(`Planted bugs: ${t.bugsFound} found of ${t.bugs}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function flag(args, name) {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(argv) {
  const [command, ...args] = argv;
  const siteDir = flag(args, "--site") ? path.resolve(flag(args, "--site")) : SITE_DIR;
  if (command === "scenarios") {
    const { written, skipped, removed } = writeScenarios({ siteDir });
    console.log(`wrote ${written.length} scenario(s) to ${path.join(SUE_DIR, "scenarios")}: ${written.join(", ") || "none"}`);
    if (removed.length) console.log(`removed ${removed.length} for pages that are gone: ${removed.join(", ")}`);
    for (const { slug, problems } of skipped) console.log(`skipped ${slug}: ${problems.join("; ")}`);
    return skipped.length ? 1 : 0;
  }
  if (command === "score") {
    const runId = args.find((a, i) => !a.startsWith("--") && !String(args[i - 1] ?? "").startsWith("--"));
    if (!runId) throw new Error("usage: course.mjs score <run id> [--runs-dir <dir>]");
    const runsDir = flag(args, "--runs-dir") ? path.resolve(flag(args, "--runs-dir")) : undefined;
    const { score, file } = await scoreRun(runId, { runsDir, siteDir });
    console.log(renderScore(score));
    console.log(`\nwrote ${file}`);
    return 0;
  }
  if (command === "list") {
    for (const { slug, problems } of listPages(siteDir)) console.log(`${slug}: ${problems.length ? problems.join("; ") : "ok"}`);
    return 0;
  }
  console.error("usage: node sue/course/course.mjs scenarios | score <run id> [--runs-dir <dir>] | list");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => (process.exitCode = code),
    (error) => {
      console.error(error?.message ?? error);
      process.exitCode = 1;
    },
  );
}
