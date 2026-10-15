#!/usr/bin/env node
/**
 * complaints.mjs - every complaint every Sue has ever made, bucketed and ranked.
 * =============================================================================
 *
 * WHAT: walks `runs/<runId>/sue-*` across ONE run or ALL of them, pulls every sentence a Sue wrote
 * in her own voice (her diary lines, plus the free-text interview answers), sorts them into themes
 * by a keyword table, and prints each theme with its count, the personas who hit it, and their
 * verbatim words. Anything that matches no theme is printed too, under `unbucketed` - a silent drop
 * would be the one failure mode that matters here, because the whole point is to find what we did
 * not already know.
 *
 * WHY IT EXISTS: owner directive (Owner, 2026-09-21): "go send through like nonstop those while
 * we're testing because that's proper. And then start fixing what they're saying." Fixing what they
 * are saying needs the complaints RANKED by how many real visitors hit them, not a reading of the
 * newest report - and "find every X over a mechanically recognizable pattern" is a script in this
 * repo, never an agent sweep (AGENTS.md § Programmatic-first discovery).
 *
 * The themes are deliberately coarse and their keywords are visible in one table below: this is a
 * TRIAGE instrument, not a classifier. A quote can land in several themes; the counts are per
 * (theme, Sue) so one Sue complaining three times about the robot check counts once.
 *
 * WHO DEPENDS ON IT: tests/report.spec.mjs and tests/complaints.spec.mjs import `collectQuotes` (no
 * browser); otherwise run it by hand, `node sue/complaints.mjs`.
 *
 *   node sue/complaints.mjs                  # every run
 *   node sue/complaints.mjs --run <runId>    # one run
 *   node sue/complaints.mjs --json           # machine-readable, for a fan-out or a diff
 *   node sue/complaints.mjs --since 2026-09-21   # runs whose id starts at or after this date
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { runsRoot } from "./lib/run-dir.mjs";
import { loadSue, sueSideOf } from "./report.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

/**
 * The themes, in the words a visitor used. Each is a list of regexes; a quote joins the theme when
 * ANY of them matches. Order here is the order they print when counts tie.
 */
const THEMES = [
  ["robot-check", [/turnstile/i, /\brobot\b/i, /captcha/i, /verify you are human/i, /prove you.{0,10}human/i]],
  ["phone-demanded", [/phone/i, /mobile number/i, /\bsms\b/i, /text message/i]],
  [
    "sign-in-wall",
    [
      /(sign|log) ?in (first|before)/i,
      /without (an )?account/i,
      /make an account (just|first|before)/i,
      /browse first/i,
      /won't show me|wont show me|didn't show me|did not show me/i,
    ],
  ],
  [
    "too-many-steps",
    [
      /step \d of \d/i,
      /another (screen|step|page)/i,
      /so many (steps|screens|clicks)/i,
      /click(ed)? and click/i,
      /multi.?step/i,
      /how many more/i,
      /still (asking|wants)/i,
      /drawn out/i,
      /friction/i,
    ],
  ],
  ["password-rules", [/\d{2}.?character/i, /password/i]],
  ["email-code", [/\bcode\b/i, /verification email/i, /no email came/i, /check my (email|inbox)/i]],
  [
    "jargon",
    [
      /jargon/i,
      /contact graph/i,
      /don'?t (know|understand) what .{0,20}means/i,
      /big words/i,
      /too hard (to read|words)/i,
      /what (is|does) .{0,25}mean/i,
      /technical/i,
    ],
  ],
  [
    "unclear-what-it-is",
    [
      /what (is|does) this (site|website|place)/i,
      /not sure (this|what) is/i,
      /never said so/i,
      /couldn'?t tell what/i,
      /doesn'?t say what/i,
      /can'?t tell (if|what|whether)/i,
      /sprawling|scattered|overloaded/i,
    ],
  ],
  [
    "not-for-me",
    [
      /not for (kids|me|someone like me)/i,
      /for (grown ?ups|founders|business)/i,
      /professional networking/i,
      /isn'?t built for/i,
      /not what (i|my) .{0,25}(wanted|described|told)/i,
    ],
  ],
  [
    "nothing-to-do",
    [/nothing to (do|see|show|screenshot)/i, /dead ?end/i, /couldn'?t click/i, /not clickable/i, /menu (did|does) nothing/i, /empty/i],
  ],
  ["price", [/\$\d/i, /per month/i, /pricing/i, /costs?\b/i, /credits/i, /free tier/i, /paywall/i, /card later/i]],
  [
    "trust",
    [
      /sketchy/i,
      /trust/i,
      /scam/i,
      /suspicious/i,
      /google copy|looks like (a )?google/i,
      /different domain/i,
      /small print/i,
      /no (human|person) to talk to/i,
    ],
  ],
  ["ai-push", [/\bAI\b/, /install/i, /on my computer/i, /assistant/i]],
  ["wrong-place", [/why (the heck )?am i/i, /sent me to/i, /threw me/i, /ended up/i, /didn'?t ask to be/i, /where am i/i]],
  ["cookies", [/cookie/i, /consent/i]],
  ["slow", [/slow/i, /taking (forever|ages)/i, /still loading/i, /spinner/i, /waited/i]],
  ["contacts-grab", [/my contacts/i, /upload .{0,15}contacts/i, /address book/i]],
];

/** The interview fields that are her OWN prose, with the label the digest prints them under. */
const PROSE_FIELDS = [
  ["mostConfusing", (i) => i?.mostConfusing],
  ["whyStopped", (i) => i?.whyStopped],
  ["whyNeverComingBack", (i) => i?.everComingBack?.why],
  ["whyTrash", (i) => i?.isThisTrash?.why],
  ["toAFriend", (i) => i?.oneSentenceToAFriend],
];

/**
 * The brain kinds that are NOT complaints: praise and a friendly sign-off. report.mjs ranks her own
 * voice from confusion/annoyance/broken/question only, so counting delight or done here inflates a
 * theme's Sue count with words that are not a complaint. Thought lines are kept, tagged diary:thought.
 */
const NOT_A_COMPLAINT = new Set(["delight", "done"]);

function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/**
 * Every Sue who actually visited, with her quotes - a dead brain is excluded, it said nothing. The
 * lines SUE itself caused (report.mjs `sueSideOf`: our sign-up door refused her, her screen stood
 * still under SUE's hands, SUE's browser closed under her, or she blamed the site after her patience
 * ran out and SUE refused every move) go to `sueSide` with the reason, never
 * into a theme: on 2026-09-22 every "Unable to process this request" was our own door's daily cap,
 * and this list still ranked them as the site's email code being broken. Nothing is dropped.
 */
export function collectQuotes(runsDir, { run, since } = {}) {
  if (!existsSync(runsDir)) return { runs: [], quotes: [], sueSide: [] };
  // Run ids start with an undashed YYYYMMDD (run-dir.mjs), so a dashed --since must lose its dashes
  // before the string compare or "20260101-..." >= "2026-09-21" is true for every 2026 run.
  const sinceKey = since ? String(since).replace(/-/g, "") : null;
  const runIds = (
    run
      ? [run]
      : readdirSync(runsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name)
  )
    .filter((id) => !sinceKey || id >= sinceKey)
    .sort();
  const quotes = [];
  const sueSide = [];
  const runsSeen = [];
  for (const runId of runIds) {
    const runDir = path.join(runsDir, runId);
    if (!existsSync(runDir)) continue;
    // A run where SUE's own apparatus broke says nothing about the product; her words there judge the
    // tool, and report.md already refuses to read them as a verdict. Keep them out of the themes.
    const manifest = readJson(path.join(runDir, "manifest.json"), {});
    if (manifest.toolFailure) continue;
    const sueDirs = readdirSync(runDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && d.name.startsWith("sue-"))
      .map((d) => d.name);
    if (!sueDirs.length) continue;
    runsSeen.push({ runId, sues: sueDirs.length });
    for (const sueId of sueDirs) {
      const s = loadSue(runDir, sueId);
      if (s.summary.brainError) continue; // she never saw the page; her silence is not an opinion
      const persona = s.summary.persona ?? s.sue?.persona?.id ?? "unknown";
      const interview = s.interview;
      const stars = Number(interview?.starsOutOfFive);
      const base = { runId, sueId, persona, stars: Number.isFinite(stars) ? stars : null };
      const side = sueSideOf(s);
      const lineWhy = (f) => {
        if (side.doorLines.includes(f)) return DOOR;
        if (side.frozenLines.includes(f)) return FROZEN;
        if (side.lostLines.includes(f)) return LOST;
        if (side.codeLines.includes(f)) return CODE;
        return side.tiredLines.includes(f) ? TIRED : null;
      };
      // Her interview is about the whole visit; when our door refused her or SUE lost her browser,
      // its answers are read beside that, the way report.md tags them, never ranked as the site's.
      const visitWhy = side.refusedAt !== null ? DOOR : side.lostWindows.length ? LOST : side.codeRefusedAt !== null ? CODE : null;
      for (const f of s.findings) {
        if (f.source !== "brain") continue;
        if (NOT_A_COMPLAINT.has(f.kind)) continue;
        const said = String(f.text ?? "").trim();
        if (!said) continue;
        const quote = { ...base, from: `diary:${f.kind}`, url: f.url ?? null, said };
        const why = lineWhy(f);
        if (why) sueSide.push({ ...quote, why });
        else quotes.push(quote);
      }
      for (const [label, pick] of PROSE_FIELDS) {
        const said = String(pick(interview) ?? "").trim();
        if (!said) continue;
        const quote = { ...base, from: label, url: null, said };
        if (visitWhy) sueSide.push({ ...quote, why: visitWhy });
        else quotes.push(quote);
      }
    }
  }
  return { runs: runsSeen, quotes, sueSide };
}

const DOOR = "our own sign-up door refused her";
const FROZEN = "her screen stood still under SUE's hands";
const LOST = "SUE's browser closed under her";
const CODE = "SUE's code guard refused the code she was given";
const TIRED = "her patience ran out and SUE refused every move after it";

/** Which themes a sentence belongs to - possibly several, possibly none. */
export function themesOf(said) {
  const hits = [];
  for (const [theme, patterns] of THEMES) if (patterns.some((p) => p.test(said))) hits.push(theme);
  return hits;
}

export function bucket(quotes) {
  const byTheme = new Map(THEMES.map(([t]) => [t, { theme: t, quotes: [], sues: new Set(), personas: new Set() }]));
  const unbucketed = [];
  for (const q of quotes) {
    const themes = themesOf(q.said);
    if (!themes.length) {
      unbucketed.push(q);
      continue;
    }
    for (const t of themes) {
      const row = byTheme.get(t);
      row.quotes.push(q);
      row.sues.add(`${q.runId}/${q.sueId}`);
      row.personas.add(q.persona);
    }
  }
  const ranked = [...byTheme.values()]
    .map((r) => ({ theme: r.theme, sues: r.sues.size, mentions: r.quotes.length, personas: [...r.personas].sort(), quotes: r.quotes }))
    .filter((r) => r.mentions > 0)
    .sort((a, b) => b.sues - a.sues || b.mentions - a.mentions);
  return { ranked, unbucketed };
}

function render({ runs, quotes, ranked, unbucketed, sueSide, totalSues }) {
  const lines = [];
  lines.push(`# What every Sue is complaining about`);
  lines.push("");
  lines.push(`${runs.length} run(s), ${totalSues} Sues who actually visited, ${quotes.length} sentences in their own words.`);
  lines.push("");
  lines.push(`Ranked by how many DIFFERENT Sues hit it (a Sue who says the same thing three times counts once):`);
  lines.push("");
  for (const r of ranked) {
    const share = totalSues ? ` (${Math.round((r.sues / totalSues) * 100)}% of visitors)` : "";
    lines.push(`- ${r.theme}: ${r.sues} Sues${share}, ${r.mentions} mentions - ${r.personas.join(", ")}`);
  }
  for (const r of ranked) {
    lines.push("");
    lines.push(`## ${r.theme} - ${r.sues} Sues, ${r.mentions} mentions`);
    lines.push("");
    for (const q of r.quotes) lines.push(`- ${q.persona}${q.stars ? ` (${q.stars}*)` : ""} [${q.from}]: "${q.said}"`);
  }
  lines.push("");
  lines.push(`## unbucketed - ${unbucketed.length} sentences no theme matched`);
  lines.push("");
  lines.push(`Printed in full on purpose: a complaint we have no theme for is the one worth reading.`);
  lines.push("");
  for (const q of unbucketed) lines.push(`- ${q.persona}${q.stars ? ` (${q.stars}*)` : ""} [${q.from}]: "${q.said}"`);
  lines.push("");
  lines.push(`## SUE-side - ${sueSide.length} sentences about what SUE itself did, not the site`);
  lines.push("");
  lines.push(`Kept out of the ranking above (report.mjs \`sueSideOf\` decides which) and printed so nothing is lost.`);
  lines.push("");
  for (const q of sueSide) lines.push(`- ${q.persona}${q.stars ? ` (${q.stars}*)` : ""} [${q.from}] (${q.why}): "${q.said}"`);
  lines.push("");
  return lines.join("\n");
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--run") args.run = argv[(i += 1)];
    else if (argv[i] === "--since") args.since = argv[(i += 1)];
    else if (argv[i] === "--json") args.json = true;
    else if (argv[i] === "--out") args.out = argv[(i += 1)];
    else if (argv[i] === "--runs-dir") args.runsDir = argv[(i += 1)];
  }
  return args;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runsDir = args.runsDir ?? runsRoot();
  const { runs, quotes, sueSide } = collectQuotes(runsDir, args);
  const { ranked, unbucketed } = bucket(quotes);
  const totalSues = new Set(quotes.map((q) => `${q.runId}/${q.sueId}`)).size;
  const payload = { runs, totalSues, quoteCount: quotes.length, ranked, unbucketed, sueSide };
  const text = args.json ? `${JSON.stringify(payload, null, 2)}\n` : render({ runs, quotes, ranked, unbucketed, sueSide, totalSues });
  if (args.out) {
    writeFileSync(args.out, text, "utf8");
    console.error(`[sue-complaints] wrote ${args.out}`);
  } else process.stdout.write(text);
}

if (isMainModule(import.meta.main, import.meta.url)) {
  main();
}
