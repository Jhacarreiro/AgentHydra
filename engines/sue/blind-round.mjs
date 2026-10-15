// Blind round: one finished SUE run's analytics, blind, to a fresh analyst; the guess is then scored against the interviews.
// Run: node sue/sue.mjs blind-round --url <url> --intent <text> --personas a,b,c,d --letter Q   (see README "Blind round")

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { postTasks } from "./lib/climayte-dispatch.mjs";
import { localConfigDir } from "../lib/target.mjs";
import { runDir } from "./lib/run-dir.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUE_CLI = path.join(HERE, "sue.mjs");
const CHECKOUT_ROOT = path.resolve(HERE, "..");
export const ANALYST_PROMPTS = {
  v1: {
    file: path.join(HERE, "blind", "analyst-prompt-v1.txt"),
    sha256: "554f113bb145da78a12a7138fa7d92dbd1db7e00f98fab7380ece1d2ee416d51",
  },
  v2: {
    file: path.join(HERE, "blind", "analyst-prompt-v2.txt"),
    sha256: "7e5e99d521a0a850221e5cd97596abaa2713976970399ba5491d9fd8f64d94d2",
  },
};
export const DEFAULT_PROMPT = "v2";
export const DEFAULT_SITE = "b8459c41-149b-4bf0-858b-30e92d1d5f9c";
export const DEFAULT_PROJECT = "ExampleApp";
/** Project name -> folder: the owner's local config (`<engines config>/blind-projects.json`), none by default. */
export const PROJECT_FOLDERS = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(localConfigDir(), "blind-projects.json"), "utf8"));
  } catch {
    return {};
  }
})();
export const DEFAULT_OUT = path.join(os.homedir(), ".agenthydra", "scratch");
const ENGINE_TIMEOUT_MS = 240_000;
const RUN_WAIT_MS = 45 * 60_000;
const GUESS_WAIT_MS = 60 * 60_000;
const POLL_MS = 15_000;
const TIE_SECONDS = 2;
const LEAK_PATTERNS = [
  [/sue-[0-9]/i, "sue-N"],
  [/persona/i, "persona"],
  [/unsure/i, "unsure"],
  [/considered/i, "considered"],
  [/irritated/i, "irritated"],
  [/continues below/i, "continues below"],
];

const refuse = (message) => new Error(message);

export const sha256 = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

export function fillPrompt(template, { id4, letter }) {
  return template
    .replace(/blind-e257/g, `blind-${id4}`)
    .replace(/run-F\.json/g, `run-${letter}.json`)
    .replace(/\bF([1-4])\b/g, `${letter}$1`);
}

export function promptVersion(value = DEFAULT_PROMPT) {
  if (typeof value !== "string" || !Object.hasOwn(ANALYST_PROMPTS, value))
    throw refuse(`--prompt is one of ${Object.keys(ANALYST_PROMPTS).join(", ")}`);
  return value;
}

export function renderAnalystPrompt({ version = DEFAULT_PROMPT, id4, letter } = {}) {
  const name = promptVersion(version);
  const pinned = ANALYST_PROMPTS[name];
  const bytes = fs.readFileSync(pinned.file);
  if (sha256(bytes) !== pinned.sha256)
    throw refuse(`the analyst prompt ${name} changed: it is frozen (sue/blind/analyst-prompt-${name}.txt)`);
  return { version: name, sha256: pinned.sha256, text: fillPrompt(bytes.toString("utf8"), { id4, letter }) };
}

const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wholeWord = (term) => new RegExp(`\\b${escapeRegex(term)}\\b`, "i");

export function hiddenNamesFor(runId, personas = []) {
  const slugs = new Set(personas.map(String));
  const names = new Set();
  const root = runDir(runId);
  for (const entry of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : []) {
    const file = path.join(root, entry.name, "sue.json");
    if (!entry.isDirectory() || !entry.name.startsWith("sue-") || !fs.existsSync(file)) continue;
    const { persona } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (persona?.id) slugs.add(persona.id);
    for (const first of persona?.identity?.firstNames ?? []) names.add(first);
    const named = /^You are ([^,]+),/.exec(String(persona?.voice ?? ""));
    if (named) names.add(named[1].trim());
  }
  return { personas: [...slugs], names: [...names] };
}

export function leakCheck(bytes, { personas = [], names = [], count }) {
  const failures = [];
  const nonAscii = [...bytes].filter((b) => b > 127).length;
  if (nonAscii) failures.push(`${nonAscii} non-ASCII byte(s)`);
  const text = Buffer.from(bytes).toString("utf8");
  for (const term of [...personas, ...names].map((t) => String(t).trim()).filter(Boolean))
    if (wholeWord(term).test(text)) failures.push(`persona name "${term}" appears`);
  for (const [pattern, label] of LEAK_PATTERNS) if (pattern.test(text)) failures.push(`"${label}" appears`);
  let view = null;
  try {
    view = JSON.parse(text);
  } catch {
    failures.push("the file is not JSON");
  }
  if (view && view.visitorCount !== count) failures.push(`visitorCount ${view.visitorCount} is not ${count}`);
  return { ok: failures.length === 0, failures };
}

export function parseBlindArgs(words) {
  const out = {};
  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (word === "--dry") out.dry = true;
    else if (word === "--no-wait") out.noWait = true;
    else if (word === "--json") Object.assign(out, JSON.parse(words[++i] ?? "{}"));
    else if (word === "--json-file") Object.assign(out, JSON.parse(fs.readFileSync(String(words[++i]), "utf8").replace(/^\uFEFF/, "")));
    else if (word.startsWith("--")) out[word.slice(2)] = words[++i];
    else throw refuse(`"${word}" is not an argument blind-round understands`);
  }
  if (typeof out.personas === "string")
    out.personas = out.personas
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
  if (out.count != null) out.count = Number(out.count);
  return out;
}

const ASSIGN_LIMIT = 8;

const gapOf = (value, target) =>
  Number.isFinite(value) && Number.isFinite(target) ? Math.abs(value - target) : null;

const distanceTo = (sue, visitor) => Math.abs(visitor.lastT - sue.engagedSeconds);

function nearestVisitor(sue, visitors) {
  let best = -1;
  visitors.forEach((v, j) => {
    if (best < 0 || distanceTo(sue, v) < distanceTo(sue, visitors[best])) best = j;
  });
  return best;
}

function assignVisitors(sues, visitors) {
  if (sues.length > visitors.length || visitors.length > ASSIGN_LIMIT)
    return sues.map((sue) => nearestVisitor(sue, visitors));
  let best = [];
  let bestTotal = Infinity;
  const picked = [];
  const used = new Set();
  const walk = (i, total) => {
    if (total >= bestTotal) return;
    if (i === sues.length) {
      bestTotal = total;
      best = [...picked];
      return;
    }
    visitors.forEach((v, j) => {
      if (used.has(j)) return;
      used.add(j);
      picked.push(j);
      walk(i + 1, total + distanceTo(sues[i], v));
      picked.pop();
      used.delete(j);
    });
  };
  walk(0, 0);
  return best;
}

function breakTie(sue, mine, rivals) {
  const levels = [
    ["clicks", (v) => gapOf(v.clicks, sue.clickCount)],
    ["scroll", (v) => gapOf(v.scroll, sue.maxScroll)],
  ];
  for (const [by, gap] of levels) {
    const own = gap(mine);
    const others = rivals.map(gap).filter((g) => g !== null);
    if (own === null || others.length === 0) continue;
    const closest = Math.min(...others);
    if (own === closest) continue;
    return own < closest ? by : null;
  }
  return null;
}

export function mapVisitors(sues, visitors) {
  const picked = assignVisitors(sues, visitors);
  return sues.map((sue, i) => {
    const j = picked[i] ?? -1;
    const best = j >= 0 ? visitors[j] : null;
    const rivals = best
      ? visitors.filter((v, k) => k !== j && Math.abs(distanceTo(sue, v) - distanceTo(sue, best)) <= TIE_SECONDS)
      : [];
    const brokenBy = rivals.length ? breakTie(sue, best, rivals) : null;
    return {
      sueId: sue.sueId,
      persona: sue.persona,
      engagedSeconds: sue.engagedSeconds,
      label: best?.label ?? null,
      lastT: best?.lastT ?? null,
      gap: best ? Number(distanceTo(sue, best).toFixed(1)) : null,
      tie: rivals.length > 0 && brokenBy === null,
      ...(brokenBy ? { tieBrokenBy: brokenBy } : {}),
    };
  });
}

export function guessOk(text, letter) {
  return text.length > 0 && new RegExp(`\\b${letter}4\\b`).test(text) && /could not tell/i.test(text);
}

export function checkLetter(value) {
  const letter = String(value ?? "");
  if (!/^[A-Z]{1,2}$/.test(letter)) throw refuse("--letter is one or two capital letters, e.g. Q or QA");
  return letter;
}

export function workspaceFor({ workspace, project = DEFAULT_PROJECT } = {}) {
  return workspace ?? PROJECT_FOLDERS[project] ?? null;
}

const cell = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .replace(/\|/g, "\\|")
    .trim() || "-";

function guessExcerpt(guess, label) {
  const hit = guess.split(/\n\s*\n/).find((p) => new RegExp(`\\b${label}\\b`).test(p));
  return hit ? cell(hit).slice(0, 400) : `no paragraph names ${label}`;
}

export function renderDraft({ runId, letter, mapping, interviews, guess }) {
  const rows = mapping.map((m) => {
    const i = interviews[m.sueId] ?? {};
    return `| ${cell(m.sueId)} | ${cell(i.mostConfusing)} | ${cell(i.starsOutOfFive)} | ${cell(i.whyStopped)} | ${cell(m.label)}: ${guessExcerpt(guess, m.label)} | review | review |`;
  });
  const map = mapping.map(
    (m) =>
      `| ${cell(m.sueId)} | ${cell(m.persona)} | ${m.engagedSeconds} | ${cell(m.label)} | ${m.lastT ?? "-"} | ${m.gap ?? "-"} | ${m.tieBrokenBy ? `near tie: ${m.tieBrokenBy} decided it` : m.tie ? `another visitor is within ${TIE_SECONDS} s: check by hand` : "-"} |`,
  );
  return [
    `# Draft score: blind round ${runId.slice(-4)} (run ${runId}, letter ${letter})`,
    "",
    `Mapping: each Sue's engaged seconds (non-blind analytics) against each blind visitor's last timeline t, one visitor per Sue (lowest total gap). Where another visitor is within ${TIE_SECONDS} s, the closer clickCount decides, then the closer maxScroll; "near tie: clicks/scroll decided it" marks those. A draft, not a verdict.`,
    "",
    "| Sue | persona | engaged s | blind label | visitor last t | gap s | note |",
    "|---|---|---|---|---|---|---|",
    ...map,
    "",
    "Recall and precision are left for the human reviewer.",
    "",
    "| Sue | interview: most confusing | stars | why stopped | guess for the mapped label | recall | precision |",
    "|---|---|---|---|---|---|---|",
    ...rows,
    "",
  ].join("\n");
}

function runEngine(command, args, timeoutMs = ENGINE_TIMEOUT_MS) {
  const file = path.join(os.tmpdir(), `blind-round-${crypto.randomUUID()}.json`);
  fs.writeFileSync(file, JSON.stringify(args));
  try {
    const res = spawnSync(process.execPath, [SUE_CLI, command, "--json-file", file], {
      cwd: CHECKOUT_ROOT,
      encoding: "utf8",
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 64 * 1024 * 1024,
    });
    let answer;
    try {
      answer = JSON.parse(String(res.stdout ?? "").trim());
    } catch {
      throw refuse(`sue ${command} printed no answer (exit ${res.status}): ${String(res.stderr ?? "").slice(0, 300)}`);
    }
    if (!answer.ok) throw refuse(`sue ${command} refused: ${answer.error}`);
    return answer;
  } finally {
    fs.rmSync(file, { force: true });
  }
}

const interviewCount = (runId) => {
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) return 0;
  return fs.readdirSync(dir).filter((n) => n.startsWith("sue-") && fs.existsSync(path.join(dir, n, "interview.json"))).length;
};

async function waitUntil(check, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() > deadline) throw refuse(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

function readInterviews(runId, sueIds) {
  const out = {};
  for (const sueId of sueIds) {
    const file = path.join(runDir(runId), sueId, "interview.json");
    if (fs.existsSync(file)) out[sueId] = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return out;
}

async function draftScore({ runId, letter, count, site, project, blindFile, roundDir }) {
  runEngine("analytics", { runId, site, project });
  const view = JSON.parse(fs.readFileSync(path.join(runDir(runId), "analytics-view.json"), "utf8"));
  const blind = JSON.parse(fs.readFileSync(blindFile, "utf8"));
  const visitors = blind.visitors.map((v, i) => ({
    label: `${letter}${i + 1}`,
    lastT: Math.max(0, ...v.timeline.map((e) => Number(e.t) || 0)),
    clicks: v.summary?.clickCount,
    scroll: v.summary?.maxScrollDepth,
  }));
  const sues = view.sues.slice(0, count).map((s) => ({
    sueId: s.sueId,
    persona: s.persona,
    engagedSeconds: s.engagementSeconds,
    clickCount: s.clickCount,
    maxScroll: s.maxScroll,
  }));
  const mapping = mapVisitors(sues, visitors);
  const guess = fs.readFileSync(path.join(roundDir, "guess.md"), "utf8");
  const interviews = readInterviews(
    runId,
    sues.map((s) => s.sueId),
  );
  const file = path.join(roundDir, "draft-score.md");
  fs.writeFileSync(file, renderDraft({ runId, letter, mapping, interviews, guess }));
  return { file, mapping };
}

export async function blindRound(args) {
  const letter = checkLetter(args.letter);
  const version = promptVersion(args.prompt);
  const personas = Array.isArray(args.personas) ? args.personas : [];
  if (personas.length === 0) throw refuse("--personas names the run's personas, comma separated");
  const count = args.count ?? 4;
  if (!Number.isInteger(count) || count < 1) throw refuse("--count is a whole number of Sues");
  const site = args.site ?? DEFAULT_SITE;
  const project = args.project ?? DEFAULT_PROJECT;
  const workspace = workspaceFor({ workspace: args.workspace, project });
  const outDir = args.out ?? DEFAULT_OUT;

  let runId = args.run ?? null;
  if (runId) {
    if (interviewCount(runId) < count) throw refuse(`run ${runId} is not finished: fewer than ${count} interviews`);
  } else {
    if (!args.url || !args.intent) throw refuse("--url and --intent start a run; or pass --run <runId> to reuse a finished one");
    const started = runEngine("run", {
      url: args.url,
      intent: args.intent,
      count,
      personas,
      presue: false,
      dispatch: "climayte",
      reading: "paced",
      workspace,
    });
    runId = started.runId;
    if (args.noWait) {
      return {
        ok: true,
        runId,
        letter,
        blindDir: path.join(outDir, `blind-${runId.slice(-4)}`),
        waiting: true,
        next: `re-run with --run ${runId} once its ${count} interviews are in`,
      };
    }
    await waitUntil(() => interviewCount(runId) >= count, RUN_WAIT_MS, `run ${runId} to finish ${count} interviews`);
  }

  const roundDir = path.join(outDir, `blind-${runId.slice(-4)}`);
  fs.mkdirSync(roundDir, { recursive: true });
  const blindFile = path.join(roundDir, `run-${letter}.json`);
  const blind = runEngine("analytics", { runId, site, project, workspace, blind: true });
  fs.copyFileSync(blind.file, blindFile);

  const leak = leakCheck(fs.readFileSync(blindFile), { ...hiddenNamesFor(runId, personas), count });
  if (!leak.ok) {
    fs.rmSync(blindFile, { force: true });
    throw refuse(`blind file refused, not handed to the analyst: ${leak.failures.join("; ")}`);
  }

  const analyst = renderAnalystPrompt({ version, id4: runId.slice(-4), letter });
  const promptFile = path.join(roundDir, "analyst-prompt.txt");
  fs.writeFileSync(promptFile, analyst.text);
  const promptRecord = { version: analyst.version, sha256: analyst.sha256 };
  fs.writeFileSync(path.join(roundDir, "analyst-prompt.version.json"), `${JSON.stringify(promptRecord, null, 2)}\n`);

  const result = { ok: true, runId, letter, blindDir: roundDir, blindFile, promptFile, prompt: promptRecord, visitorCount: count, leak };
  if (args.dry) return { ...result, dry: true };

  const [worker] = await postTasks({
    tasks: [{ title: `Blind analyst ${runId} ${letter}`, prompt: analyst.text, cwd: roundDir, kind: "review" }],
    group: `blind-${runId}`,
  });
  const launched = { ...result, analyst: worker?.id ?? worker ?? null };
  if (args.noWait) return { ...launched, waiting: true };

  const guessFile = path.join(roundDir, "guess.md");
  await waitUntil(
    () => fs.existsSync(guessFile) && guessOk(fs.readFileSync(guessFile, "utf8"), letter),
    GUESS_WAIT_MS,
    `the analyst's guess.md in ${roundDir}`,
  );
  const score = await draftScore({ runId, letter, count, site, project, blindFile, roundDir });
  return { ...launched, guess: path.join(roundDir, "guess.md"), draftScore: score.file, mapping: score.mapping };
}

export async function blindRoundMain(words) {
  try {
    const answer = await blindRound(parseBlindArgs(words));
    return answer;
  } catch (err) {
    process.exitCode = 1;
    return { ok: false, error: err.message };
  }
}
