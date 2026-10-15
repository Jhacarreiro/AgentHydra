// dredd/lib/claim-diagnosis.mjs - the experts' homework on what the room ruled REAL, and the burn-down list it becomes.
//
// The owner, 2026-10-10: the findings go to "a Jev-type model that would be asked, 'Which of the experts should weigh in
// on which of these questions'", the experts get homework on what the visitors complained about, and they write "a
// burn-down list that the AI would then follow". So the REAL claims are cut into units (one screen, one likely cause),
// Jev routes each unit to the seats of the whole bench whose own question says yes, each seat answers its homework in a
// shape this file reads, and one synthesis turn writes burndown.json and burndown.md. The experts think on a strong
// vision route: on Packing Buddy's hearing the rulings' seats answered from flash-lite and free mini models (2026-10-10).
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { askBrain, structuredAnswer } from "./brain.mjs";
import { claimLine, picturesOf, readRulings, realClaims, similarity } from "./claim-rulings.mjs";
import { ROUTE_MAX, ROUTE_SIT, routeUnits } from "./claim-routing.mjs";
import { askJev } from "./jev.mjs";
import { loadSeatRoster } from "./seats.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** The bun script that sits the experts' homework (and a repair's review) on the Connections Boardroom. */
export const DIAGNOSE_SCRIPT = path.join(HERE, "..", "diagnose-claims.mjs");

/**
 * The model every expert and the synthesis think on: GPT-6.1 Sol on OpenAI's own API, HSwarm's shipped
 * `rank:gpt-6-1-sol:openai`, which reads images since 2026-10-10 (HSwarm's routine image route, the one the rulings sit
 * on, still walks the free Gemini models first). The experts pin it and fail over to the `critical` profile's own route
 * when it does not answer; the model that answered each one is recorded either way.
 */
export const EXPERT_ROUTE = Object.freeze({
  model: process.env.DREDD_EXPERT_MODEL || "rank:gpt-6-1-sol:openai",
  profile: "critical",
  reasoning: "high",
  // Reasoning tokens count against OpenAI's completion cap: 8k (the brain's default) empties answers at high effort.
  maxTokens: 32000,
  timeoutS: 600,
});
/** The synthesis reads every expert's homework at once and writes the whole list. */
const BURNDOWN_ROUTE = Object.freeze({ ...EXPERT_ROUTE, maxTokens: 90000, timeoutS: 1500 });

/** A unit holds at most this many claims: Jev routes it whole, and an expert reads it whole. */
export const GROUP_MAX_CLAIMS = 10;
/** A split's unit under this many claims joins another unit of its screen that has room (packSmall). */
export const GROUP_MIN_CLAIMS = 3;
/** And at most this much claim text (the plane's prompt cap is 48k characters, the room's own lines included). */
export const GROUP_MAX_CHARS = 30000;
/** One homework sitting carries at most this many claims (whole units), so a busy expert gets several sittings. */
export const HOMEWORK_MAX_CLAIMS = 14;
export const HOMEWORK_MAX_CHARS = 36000;

export const ROUTING_JSON = "routing.json";
export const HOMEWORK_JSON = "homework.json";
export const BURNDOWN_JSON = "burndown.json";
export const BURNDOWN_MD = "burndown.md";
/** Each homework's request and answer, and the unit plan, so a rerun keeps what already sat. */
export const HOMEWORK_DIR = "homework";
/** What the product landed since the visits, as the experts read it: at most this many commits and this much text. */
export const CHANGES_MAX = 40;
export const CHANGES_MAX_CHARS = 8000;
const CHANGE_SUBJECT_MAX = 600;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const clip = (text, max) => {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}...` : s;
};

/**
 * The screen a claim's page is, as one place: the path, its ids folded ("/box/:id"), its query dropped ("/print?room=x"
 * is the print screen, "/?demo" the home). An ART line names a screen by word ("Home"), kept lower-cased. Pure.
 */
export function screenKey(screen) {
  const raw = String(screen ?? "").trim();
  if (!raw) return "(no screen)";
  let p;
  if (/^(https?:\/\/|\/)/i.test(raw)) {
    try {
      p = new URL(raw, "http://screen.invalid").pathname;
    } catch {
      p = raw.split(/[?#]/)[0];
    }
  } else p = raw.toLowerCase();
  p = p
    .split("/")
    .map((seg) => (UUID.test(seg) ? ":id" : /^\d+$/.test(seg) ? ":n" : seg))
    .join("/");
  return p.length > 1 ? p.replace(/\/$/, "") : p || "/";
}

/** The screen a claim names, or its first source's. */
export const claimScreen = (c) => c.screen ?? c.sources?.find((s) => s.screen)?.screen ?? null;

/** Claims cut into chunks within `max` claims and `maxChars` of claim text, in order. Pure. */
export function chunkClaims(claims, { max = GROUP_MAX_CLAIMS, maxChars = GROUP_MAX_CHARS } = {}) {
  const out = [];
  let cur = [];
  let size = 0;
  for (const c of claims) {
    const len = claimLine(c).length;
    if (cur.length && (cur.length >= max || size + len > maxChars)) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c);
    size += len;
  }
  if (cur.length) out.push(cur);
  return out;
}

/**
 * A splitter's proposed groups made whole: every id of `claims` in exactly one group, unknown ids dropped, an id
 * named twice kept where it was first named, a group over the caps cut, the ids the splitter left out grouped under
 * "not placed by the split" rather than lost (a claim nobody diagnoses is never repaired), tiny groups packed. Pure.
 * Returns [{ cause, claims }].
 */
export function placeAll(proposed, claims, caps = {}) {
  const byId = new Map(claims.map((c) => [c.id, c]));
  const placed = new Set();
  const out = [];
  for (const g of Array.isArray(proposed) ? proposed : []) {
    const ids = [...new Set((Array.isArray(g?.ids) ? g.ids : []).map((x) => String(x).trim().toUpperCase()))];
    const mine = ids.filter((id) => byId.has(id) && !placed.has(id));
    for (const id of mine) placed.add(id);
    if (!mine.length) continue;
    const cause = String(g.cause ?? "").trim() || "a shared cause";
    for (const part of chunkClaims(
      mine.map((id) => byId.get(id)),
      caps,
    ))
      out.push({ cause, claims: part });
  }
  const left = claims.filter((c) => !placed.has(c.id));
  for (const part of chunkClaims(left, caps)) out.push({ cause: "not placed by the split", claims: part });
  return packSmall(out, caps);
}

/**
 * Groups under `min` claims packed into another group of the same screen that has room, the one whose cause reads most
 * alike, causes joined. Packing Buddy's first split (2026-10-10) cut 110 claims into 32 groups, 15 of them a single
 * claim: every one a sitting of its own, and an expert who sees one claim cannot see the cause it shares. Pure.
 */
export function packSmall(parts, { max = GROUP_MAX_CLAIMS, maxChars = GROUP_MAX_CHARS, min = GROUP_MIN_CLAIMS } = {}) {
  const chars = (p) => p.claims.reduce((n, c) => n + claimLine(c).length, 0);
  const out = parts.filter((p) => p.claims.length >= min).map((p) => ({ ...p, claims: [...p.claims] }));
  for (const p of parts.filter((x) => x.claims.length < min)) {
    const home = out
      .filter((o) => o.claims.length + p.claims.length <= max && chars(o) + chars(p) <= maxChars)
      .sort((a, b) => similarity(b.cause, p.cause) - similarity(a.cause, p.cause) || a.claims.length - b.claims.length)[0];
    if (home) {
      home.claims.push(...p.claims);
      home.cause = `${home.cause}; ${p.cause}`;
    } else out.push({ ...p, claims: [...p.claims] });
  }
  return out;
}

/** The splitter's question for one crowded screen: its claims, one line each, to be grouped by shared cause. */
export function splitRequest(screen, claims, max = GROUP_MAX_CLAIMS) {
  const least = Math.ceil(claims.length / max);
  return [
    `These ${claims.length} claims were ruled REAL on one screen of a product (${screen}). Group them by the root cause they`,
    `most likely share, so that one repair fixes each group: the same element, the same layout decision, the same flow.`,
    `Each group holds at most ${max} claims; every claim id goes in exactly one group. Use as few groups as that allows,`,
    `about ${least} to ${least + 2}: a group is what one builder repairs together, and it may hold several related causes.`,
    `A group of one or two claims only when they share nothing with the rest.`,
    `Answer with ONE JSON object and nothing else: {"groups": [{"cause": "<the shared cause, one line>", "ids": ["C1", "C7"]}]}`,
    "",
    ...claims.map((c) => `${c.id}. ${clip(c.text, 400)}`),
  ].join("\n");
}

/**
 * The units Jev routes: the REAL claims by screen, in the order their screens first appear; a screen over the caps is
 * split by `split({ screen, claims })` (a model's proposal of [{ cause, ids }], made whole by placeAll), or cut in
 * order when no splitter is given or it fails. Ids U1, U2, ... in that order. Returns { units, splits }.
 */
export async function planGroups(real, { split = null, caps = {} } = {}) {
  const max = caps.max ?? GROUP_MAX_CLAIMS;
  const maxChars = caps.maxChars ?? GROUP_MAX_CHARS;
  const byScreen = new Map();
  for (const c of real) {
    const key = screenKey(claimScreen(c));
    if (!byScreen.has(key)) byScreen.set(key, []);
    byScreen.get(key).push(c);
  }
  const units = [];
  const splits = [];
  for (const [screen, claims] of byScreen) {
    const fits = claims.length <= max && claims.reduce((n, c) => n + claimLine(c).length, 0) <= maxChars;
    if (fits) {
      units.push({ screen, cause: null, claims });
      continue;
    }
    let parts = null;
    if (split) {
      try {
        const proposed = await split({ screen, claims });
        parts = placeAll(proposed?.groups ?? proposed, claims, { max, maxChars });
        splits.push({
          screen,
          claims: claims.length,
          groups: parts.length,
          model: proposed?.model ?? null,
          cost_usd: proposed?.cost_usd ?? null,
        });
      } catch (err) {
        splits.push({ screen, claims: claims.length, error: String(err?.message || err) });
      }
    }
    parts ??= chunkClaims(claims, { max, maxChars }).map((part) => ({ cause: "cut in order (no split)", claims: part }));
    for (const p of parts) units.push({ screen, cause: p.cause, claims: p.claims });
  }
  return { units: units.map((u, i) => ({ id: `U${i + 1}`, ...u })), splits };
}

/**
 * How much a unit weighs when the allowance may not reach every sitting: each claim counts the share of the room's
 * seats that ruled it REAL (1 when the rulings carry no counts), so a larger unit and a firmer ruling sit first. Pure.
 */
export function unitWeight(unit) {
  return unit.claims.reduce((t, c) => {
    const k = c?.counts;
    const all = k ? (Number(k.real) || 0) + (Number(k.notReal) || 0) + (Number(k.cantTell) || 0) : 0;
    return t + (all ? (Number(k.real) || 0) / all : 1);
  }, 0);
}

/** Is this answers file an answered homework sitting ("<seat>-<n>", not a review's or a round's)? */
const isHomeworkAnswer = (a) =>
  Boolean(
    a &&
    !a.error &&
    a.text &&
    typeof a.seat === "string" &&
    Array.isArray(a.claims) &&
    String(a.id).startsWith(`${a.seat}-`) &&
    /^\d+$/.test(String(a.id).slice(a.seat.length + 1)),
  );

/** The homework sittings a docket's homework folder holds answered, from any earlier plan: [{ id, seat, claims }]. */
export function answeredHomework(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".answers.json"))
    .map((f) => readJson(path.join(dir, f)))
    .filter(isHomeworkAnswer)
    .map((a) => ({ id: a.id, seat: a.seat, claims: a.claims }));
}

/**
 * Every routed seat's homework, breadth first. A seat's units are bundled by its rank in each unit's routing (tier 0:
 * the units it leads, routeSeats' order), heaviest first (unitWeight), within the homework caps, so a unit is never
 * split between two sittings; the sittings then run tier by tier, the heaviest bundle first, so every unit's first
 * expert sits before any unit's second. On Packing Buddy (2026-10-10) they ran seat by seat, and the design critic,
 * routed to 20 of 21 units, answered nothing before the Boardroom refused at its five-hour allowance. `kept` are
 * sittings already answered under any plan (answeredHomework): each (seat, unit) one holds is not planned again, and a
 * seat's new ids number on past its kept ones. Ids "<seat>-<n>". Pure. Returns the kept sittings, then the new in order.
 */
export function planHomework(routing, unitsById, { max = HOMEWORK_MAX_CLAIMS, maxChars = HOMEWORK_MAX_CHARS, kept = [] } = {}) {
  const covered = new Set();
  const last = new Map();
  const nameOf = new Map(routing.flatMap((r) => r.seats.map((s) => [s.id, s.name])));
  const keptOut = [];
  for (const k of kept) {
    const held = new Set(k.claims);
    const units = routing.filter((r) => r.seats.some((s) => s.id === k.seat) && r.claims.every((id) => held.has(id))).map((r) => r.unit);
    if (!units.length) continue;
    for (const u of units) covered.add(`${k.seat}\t${u}`);
    keptOut.push({ id: k.id, seat: k.seat, name: nameOf.get(k.seat), units, claims: k.claims, kept: true });
    last.set(k.seat, Math.max(last.get(k.seat) || 0, Number(k.id.slice(k.seat.length + 1)) || 0));
  }
  const buckets = new Map();
  for (const r of routing)
    r.seats.forEach((s, tier) => {
      if (covered.has(`${s.id}\t${r.unit}`)) return;
      const key = `${tier}\t${s.id}`;
      if (!buckets.has(key)) buckets.set(key, { seat: s.id, name: s.name, tier, units: [] });
      buckets.get(key).units.push(unitsById.get(r.unit));
    });
  const bundles = [];
  for (const b of buckets.values()) {
    let cur = [];
    let n = 0;
    let chars = 0;
    const flush = () => {
      if (cur.length) bundles.push({ ...b, units: cur, weight: unitWeight(cur[0]) });
      cur = [];
      n = 0;
      chars = 0;
    };
    for (const u of [...b.units].sort((x, y) => unitWeight(y) - unitWeight(x))) {
      const len = u.claims.reduce((t, c) => t + claimLine(c).length, 0);
      if (cur.length && (n + u.claims.length > max || chars + len > maxChars)) flush();
      cur.push(u);
      n += u.claims.length;
      chars += len;
    }
    flush();
  }
  bundles.sort((a, b) => a.tier - b.tier || b.weight - a.weight);
  const fresh = bundles.map((b) => {
    const n = (last.get(b.seat) || 0) + 1;
    last.set(b.seat, n);
    return {
      id: `${b.seat}-${n}`,
      seat: b.seat,
      name: b.name,
      tier: b.tier,
      weight: Math.round(b.weight * 100) / 100,
      units: b.units.map((u) => u.id),
      claims: b.units.flatMap((u) => u.claims.map((c) => c.id)),
    };
  });
  return [...keptOut, ...fresh];
}

/** What one homework sitting cost on Packing Buddy's proof run ($0.055 to $0.106, 2026-10-10): the projection before any sitting of a run has answered. */
export const SITTING_USD_GUESS = 0.1;
/** The Connections Boardroom's words when its allowance is spent: no meeting opens until it resets, so none is tried. */
export const ALLOWANCE_REFUSAL = /allowance is used up/i;

/**
 * Sittings run in the order given, `together` at once, until the door closes: `sitOne(s, state)` sits one and resolves
 * { cost_usd } (or { skipped: why } when it found the door closed); a sitting that meets the Boardroom's allowance
 * refusal sets `state.stopped` at once (or resolves { stop: why }), so no later sitting opens a meeting, and none opens
 * once this run's spend plus the sittings in flight would pass `maxUsd` (each projected at the run's mean so far, or
 * SITTING_USD_GUESS before any answered). Every sitting not opened goes to `skip(s, why)`, so a rerun sits it. On
 * Packing Buddy (2026-10-10) the 31 sittings after the refusal each tried the plane and failed the same way.
 * Resolves { stopped, spent, skipped }.
 */
export async function runSittings(sittings, { sitOne, skip, together = 6, maxUsd = null }) {
  const state = { stopped: null, spent: 0, answered: 0, running: 0, skipped: [] };
  const each = () => (state.answered ? state.spent / state.answered : SITTING_USD_GUESS);
  const queue = [...sittings];
  const pass = async (s, why) => {
    state.skipped.push(s.id);
    await skip(s, why);
  };
  const worker = async () => {
    while (queue.length) {
      const s = queue.shift();
      if (!state.stopped && maxUsd != null && state.spent + (state.running + 1) * each() > maxUsd)
        state.stopped = `the --max-usd $${maxUsd} cap ($${Math.round(state.spent * 1e4) / 1e4} spent in this run; the next sitting would pass it)`;
      if (state.stopped) {
        await pass(s, state.stopped);
        continue;
      }
      state.running += 1;
      try {
        const r = (await sitOne(s, state)) || {};
        if (r.skipped) await pass(s, r.skipped);
        if (r.cost_usd != null) {
          state.spent += Number(r.cost_usd) || 0;
          state.answered += 1;
        }
        if (r.stop) state.stopped ??= r.stop;
      } finally {
        state.running -= 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(together, queue.length) }, worker));
  return { stopped: state.stopped, spent: Math.round(state.spent * 1e6) / 1e6, skipped: state.skipped };
}

/** A run id is its start stamp ("20261009-215943-316b"), in the local time of the machine that made it (sue's runs). */
const RUN_STAMP = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-|$)/;

/** When a visitor run started, read from its id in this machine's local time; null when the id is not a stamp. Pure. */
export function runStartedAt(id) {
  const m = RUN_STAMP.exec(String(id ?? ""));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map(Number);
  const at = new Date(y, mo - 1, d, h, mi, s);
  return Number.isNaN(at.getTime()) ? null : at;
}

/** The newest visitor run the claims' sources cite: { run, at }, or null when none names a stamped run. Pure. */
export function newestVisit(claims) {
  let best = null;
  for (const c of claims)
    for (const s of c.sources || []) {
      const at = runStartedAt(s.run);
      if (at && (!best || at > best.at)) best = { run: s.run, at };
    }
  return best;
}

/** Whether `repo` has the ref (rev-parse --verify --quiet exits 1 when it does not). */
function hasRef(repo, ref) {
  try {
    execFileSync("git", ["-C", repo, "rev-parse", "--verify", "--quiet", `refs/remotes/${ref}`], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * The commits the product's repository landed after the newest visit the claims cite, oldest first, at most `max` and
 * `maxChars` of them: the visitors' records and pictures are from before these. On Packing Buddy (2026-10-10) items B5,
 * B6 and B14 described print problems e8215b4 had reworked after the visits and hours before the hearing, which the
 * experts could not know. The log reads the checkout's HEAD and its origin/main together: a hearing's checkout can sit
 * far behind what landed (Raise Buddy's, 23 commits on 2026-10-12, held by a peer's edits), and a builder's own commits
 * may not be pushed yet. Returns { repo, run, since, commits: [{ sha, at, subject }], more }, or null when no claim
 * cites a stamped run. Throws with git's words when `repo` is not a repository git reads.
 */
export function changesSinceVisits(repo, claims, { max = CHANGES_MAX, maxChars = CHANGES_MAX_CHARS } = {}) {
  const visit = newestVisit(claims);
  if (!visit) return null;
  const since = visit.at.toISOString();
  const refs = ["HEAD", ...(hasRef(repo, STANDING_REF) ? [STANDING_REF] : [])];
  const out = execFileSync("git", ["-C", repo, "log", ...refs, `--since=${since}`, "--no-merges", "--reverse", "--format=%h%x09%cI%x09%s"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  const all = out
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha, at, ...subject] = line.split("\t");
      return { sha, at, subject: clip(subject.join(" "), CHANGE_SUBJECT_MAX) };
    });
  const commits = [];
  let chars = 0;
  for (const c of all) {
    const len = c.sha.length + c.at.length + c.subject.length + 4;
    if (commits.length >= max || chars + len > maxChars) break;
    commits.push(c);
    chars += len;
  }
  return { repo, run: visit.run, since, commits, more: all.length - commits.length };
}

/** The CHANGED SINCE THE VISITS block of a homework and of the synthesis prompt; nothing when no repository was read. Pure. */
export function changesLines(changes) {
  if (!changes?.commits) return [];
  const where = `${path.basename(changes.repo)}, after the newest visitor run ${changes.run} began at ${changes.since}`;
  if (!changes.commits.length) return ["", `CHANGED SINCE THE VISITS (${where}): nothing landed.`];
  return [
    "",
    `CHANGED SINCE THE VISITS (${where}; the complaints and pictures are from before these commits):`,
    ...changes.commits.map((c) => `- ${c.sha} ${c.at} ${c.subject}`),
    ...(changes.more ? [`(and ${changes.more} later commit(s) not listed)`] : []),
  ];
}

/** The existing headless capture door (scripts/ui/phone-render.mjs): its phone view is 390x844; this size is added. */
const PHONE_RENDER = path.join("scripts", "ui", "phone-render.mjs");
const NOW_DESKTOP = "1280x800";

/**
 * Where a unit's screen is today: its first claim's own page (ids and query kept: "/box/<id>", "/?demo"), on the
 * product's origin; null when no claim names a page there. Pure.
 */
export function nowUrl(unit, url) {
  let base;
  try {
    base = new URL(url);
  } catch {
    return null;
  }
  for (const c of unit.claims) {
    const raw = String(claimScreen(c) ?? "").trim();
    if (raw.startsWith("/")) return new URL(raw, base.origin).href;
    if (/^https?:\/\//i.test(raw) && URL.canParse(raw) && new URL(raw).origin === base.origin) return new URL(raw).href;
  }
  return null;
}

/** A heavy line under fairjob when this machine has it (Windows), as convene.mjs launches its heavy instruments. */
function underFairjob(cmd, argv) {
  const fj = path.join(homedir(), ".claude", "tools", "fairjob.cmd");
  if (process.platform !== "win32" || !existsSync(fj)) return [cmd, argv];
  // fairjob takes the line as one quoted -Run argument, so a token that needs quotes would split it.
  if (argv.some((a) => /[\s"]/.test(a))) throw new Error("a path with a space cannot ride fairjob's one quoted -Run line");
  return [fj, ["-Weight", "3", "-Run", [cmd, ...argv].join(" ")]];
}

/**
 * Today's screen of every unit, headless at 390x844 and 1280x800, through the existing capture door
 * (scripts/ui/phone-render.mjs: --live for an https product, --local <port> for a localhost one), one picture pair per
 * distinct page, into `outDir`. On Packing Buddy (2026-10-10) the experts judged the visitors' screenshots of the day
 * before, so items commits had already fixed came back. A page the render failed (a 404, a blank page, a boot crash)
 * gives no picture, and its unit says why. Resolves { at, mode, shots: { <unit id>: { url, phone, desktop } | { url, error } } }.
 */
export async function captureNow({ root, run, units, url, outDir, now = () => Date.now() }) {
  const at = new Date(now()).toISOString();
  const shots = {};
  const unitsAt = new Map();
  for (const u of units) {
    const target = nowUrl(u, url);
    if (!target) shots[u.id] = { url: null, error: "no claim names a page on the product's origin" };
    else unitsAt.set(target, [...(unitsAt.get(target) || []), u.id]);
  }
  const first = unitsAt.size ? new URL([...unitsAt.keys()][0]) : null;
  const local = first && ["localhost", "127.0.0.1"].includes(first.hostname) && first.port;
  const mode = first?.protocol === "https:" ? ["--live"] : local ? ["--local", first.port] : null;
  const rows = [];
  for (const [target, ids] of unitsAt) {
    if (mode && new URL(target).origin === first.origin) rows.push({ url: target, name: `now-${rows.length + 1}`, ids });
    else for (const id of ids) shots[id] = { url: target, error: "the capture door renders an https product or a localhost port" };
  }
  if (!rows.length) return { at, mode: null, shots };
  mkdirSync(outDir, { recursive: true });
  const listFile = path.join(outDir, "urls.json");
  writeFileSync(
    listFile,
    `${JSON.stringify(
      rows.map(({ url: u, name }) => ({ url: u, name })),
      null,
      2,
    )}\n`,
  );
  const [cmd, argv] = underFairjob("bun", [
    PHONE_RENDER,
    ...mode,
    "--urls",
    listFile,
    "--viewport",
    NOW_DESKTOP,
    "--settle",
    "10000",
    "--out",
    outDir,
  ]);
  const r = await run(cmd, argv, { cwd: root, timeoutMs: 20 * 60_000 });
  const pages = new Map((readJson(path.join(outDir, "facts.json"))?.pages || []).map((p) => [p.name, p]));
  for (const row of rows) {
    const page = pages.get(row.name);
    const phone = path.join(outDir, `${row.name}.png`);
    const desktop = path.join(outDir, `${row.name}-${NOW_DESKTOP}.png`);
    const failed = page
      ? Object.entries(page.views || {}).flatMap(([view, v]) => (v.failures || []).map((f) => `${view}: ${f}`))
      : [`the capture left no result (exit ${r?.status ?? "?"}${r?.error ? `, ${r.error}` : ""})`];
    if (!failed.length && !(existsSync(phone) && existsSync(desktop))) failed.push("the capture wrote no picture");
    const shot = failed.length ? { url: row.url, error: clip(failed.join("; "), 300) } : { url: row.url, phone, desktop };
    for (const id of row.ids) shots[id] = shot;
  }
  return { at, mode: mode.join(" "), shots };
}

/**
 * A sitting's pictures in the order its text numbers them: THEN, the visitors' own screens (picturesOf), then NOW,
 * each unit's screen today (captureNow), a page shared by two units sent once. Pure.
 * Returns { then: [paths], now: Map(unit id -> [phone number, desktop number]), all: [paths] }.
 */
export function sittingPictures(units, shots = null) {
  const then = picturesOf(units.flatMap((u) => u.claims));
  const all = [...then];
  const now = new Map();
  for (const u of units) {
    const s = shots?.[u.id];
    if (!s?.phone) continue;
    const at = (p) => (all.includes(p) ? all.indexOf(p) : all.push(p) - 1) + 1;
    now.set(u.id, [at(s.phone), at(s.desktop)]);
  }
  return { then, now, all };
}

/** The room's own ruling on a claim, one line: how the seats split and the first reason a seat gave for REAL. */
function rulingLine(c) {
  const k = c.counts;
  if (!k) return null;
  const why = (c.votes || []).find((v) => v.ruling === "real" && v.why)?.why;
  return `   the room ruled it REAL (${k.real} real, ${k.notReal} not real, ${k.cantTell} can't tell)${why ? `: ${why}` : ""}`;
}

/**
 * One homework said into the seat's meeting: the product and its ask, the recorded decisions, what the product landed
 * since the visits (changesSinceVisits), then each routed unit (its screen and likely cause) with every claim's record,
 * the room's ruling and its picture number. Pure.
 */
export function homeworkText(hw, units, { url = null, job = null, decisions = "", changes = null, now = null } = {}) {
  const claims = units.flatMap((u) => u.claims);
  const pictures = sittingPictures(units, now?.shots);
  const shotOf = (c) => c.sources?.find((s) => s.shot)?.shot ?? null;
  const range = (a, b) => (a === b ? `${a}` : `${a}-${b}`);
  const lines = [
    ...(url ? [`THE PRODUCT: ${url}`] : []),
    ...(job ? [`THE HEARING'S ASK: ${job}`] : []),
    "",
    "RECORDED DECISIONS (they win over any fix):",
    decisions?.trim() ? decisions.trim() : "none recorded",
    ...changesLines(changes),
    "",
    `HOMEWORK FOR ${hw.name || hw.seat}: these ${claims.length} complaints were routed to you because your field bears on them.`,
  ];
  if (now) {
    const k = pictures.then.length;
    lines.push(
      `THE PICTURES: ${k ? `${range(1, k)} are THEN, the visitors' own screens on the day of the visits` : "no THEN picture"}; ${
        pictures.all.length > k
          ? `${range(k + 1, pictures.all.length)} are NOW, each screen as it rendered at ${now.at} in a fresh visit with no account`
          : "no NOW picture"
      }.`,
    );
  }
  for (const u of units) {
    lines.push("", `ON ${u.screen}${u.cause ? ` (likely shared cause: ${u.cause})` : ""}:`);
    if (now) {
      const n = pictures.now.get(u.id);
      const s = now.shots?.[u.id];
      lines.push(
        n
          ? `NOW (${s.url}): picture ${n[0]} at 390x844, picture ${n[1]} at ${NOW_DESKTOP}`
          : `NOW: not captured (${s?.error || "no capture"}); judge from THEN`,
      );
    }
    for (const c of u.claims) {
      lines.push(claimLine(c, pictures.then.indexOf(shotOf(c)) + 1 || null));
      const r = rulingLine(c);
      if (r) lines.push(r);
    }
  }
  return lines.join("\n");
}

/**
 * The reply shape every expert reads under its homework, in its own instructions (the rulings learned that a shape put
 * after the meeting reads as an injection, 2026-10-10). The headings are what parseHomework reads.
 */
export const HOMEWORK_INSTRUCTION = [
  "HOMEWORK. The visitors' complaints below were routed to you because your field bears on them. The room ruled each",
  'real on its face; your job is the expert\'s. Look at every picture ("her screen: picture N", the pictures in that',
  "order). Judge each complaint in your field: is it right (a misread of the page, or a fix the visitor asked for that",
  "would hurt the product, makes it wrong), what is the underlying problem, how much it matters to the product's main",
  "job, the fix concrete enough for an engineer who has never seen this to build, what done looks like, and what must not",
  "change. A recorded decision always wins over your fix: keep it and design around it.",
  "",
  "HOW A FIX IS CHOSEN. A complaint names a symptom; the remedy is yours, and adding to the screen is the last one. Take",
  "the first of these that solves it: take something away (a duplicate, a line nobody needs, a box around a thing);",
  "reorder or regroup so the one thing this screen is for leads and the rest steps back in size, weight, colour and place",
  "(visual hierarchy); put it behind a tap where the visitor looked for it (a details fold, an info icon, a sheet, the next",
  "step: progressive disclosure); only then add to what shows before any tap, and say what leaves to make room. A question",
  "one visitor asked is answered where she looked, on demand, never by a permanent line for everyone. Anything that opens,",
  "closes, expands or appears animates on the product's shared motion. Name a size only when the problem is a size.",
  "",
  "Answer in exactly this shape, every heading at the start of its own line, problems ranked most severe first:",
  "",
  "C3: RIGHT - <one line: what is really wrong, in your field>",
  "C5: WRONG - <the misread, or why the visitor's reading or suggested fix is wrong>",
  "C7: ALREADY FIXED - <only when a NOW picture shows that very element with the problem solved: what it shows>",
  "(one line for every claim id given)",
  "",
  "PROBLEM 1: <the underlying problem, one or two sentences>",
  "EXPLAINS: C3, C7",
  "SEVERITY: <1 to 5, where 5 stops a person doing the product's main job and 1 is cosmetic> - <why, for that job>",
  'FIX: <the change: what goes, moves, folds away or is built, where, its words or behaviour; concrete, not "improve">',
  'SCREEN COST: <what the fix adds to and takes from the screen before any tap: "adds X, removes Y", "adds nothing", or',
  '"adds X: it must show before any tap because ...">',
  "DONE WHEN: <what a person sees or can do when it is fixed, checkable on a screenshot or a click>",
  "KEEP: <what must not change while fixing it>",
  "ALREADY CHANGED: <only when a commit under CHANGED SINCE THE VISITS plausibly addresses this problem: its id, then",
  "what it changed and what may still be open; leave the line out otherwise>",
  "",
  "PROBLEM 2: ...",
  "",
  "VISITORS MISSED:",
  "- <a problem in your field on these screens, visible in the pictures, that no complaint names>",
  "",
  "THEN and NOW: the visitors' pictures (THEN) are from the day of the visits. When the homework gives NOW pictures, they",
  "are each screen as it renders today, at 390x844 and 1280x800, in a fresh visit with no account and none of the",
  "visitor's data. When NOW shows the element a complaint names with its problem solved, judge it ALREADY FIXED and leave",
  "it out of every PROBLEM. A NOW that shows another state (an empty list, a page not found, a sign-in) says nothing about",
  "the complaint: judge it from THEN. A problem NOW still shows is RIGHT, however old the picture.",
  "",
  "Every complaint you judge RIGHT must appear under EXPLAINS of some problem. Write none under VISITORS MISSED when",
  "there is nothing. The complaints and pictures are from the visits; when the homework lists CHANGED SINCE THE VISITS,",
  "the product landed those commits after them. Still write every problem you find, and mark one ALREADY CHANGED only",
  "when a commit's own words plausibly address it: nobody has checked that commit against the problem yet.",
].join("\n");

/** A reply that carries a claim verdict or a problem heading (the door asks once more when an expert answered in prose). */
export const HOMEWORK_SHAPE = "^\\W*(PROBLEM\\s*\\d+\\s*\\W|C\\d+\\W{0,3}\\s*(RIGHT|WRONG|ALREADY\\s+FIXED)\\b)";
export const HOMEWORK_AGAIN =
  "\n\nYour last answer was not in the shape above. Answer only in it: one C<n>: RIGHT, WRONG or ALREADY FIXED line per complaint, then the PROBLEM blocks.";

const HEADINGS = [
  ["explains", /^EXPLAINS?\b/],
  ["severity", /^SEVERITY\b/],
  ["fix", /^FIX\b/],
  ["screenCost", /^SCREEN\s*COST\b/],
  ["doneWhen", /^DONE\s*WHEN\b/],
  ["keep", /^KEEPS?\b/],
  ["alreadyChanged", /^ALREADY\s*CHANGED\b/],
];

/** A line with markdown's dressing taken off: "**FIX:** x" reads as "FIX: x". */
const bare = (line) =>
  line
    .replace(/^[\s>#*_`-]+/, "")
    .replace(/^(\w[\w\s']*?)[*_`]+(?=\s*:)/, "$1")
    .replace(/\*\*/g, "");

/** The value after a heading's colon (or dash), the heading itself dropped. */
const afterHeading = (line) => line.replace(/^[^:\-–—]*?[:\-–—]\s*/, "").trim();

const idsIn = (text, wanted) => [
  ...new Set(
    (
      String(text)
        .toUpperCase()
        .match(/\bC\d+\b/g) || []
    ).filter((id) => wanted.has(id)),
  ),
];

/**
 * An expert's homework, read from the fixed shape (HOMEWORK_INSTRUCTION). Tolerant of markdown dressing; a heading's
 * value runs on over the lines under it until the next heading; an id the homework does not hold is dropped. Pure.
 * A complaint judged ALREADY FIXED reads { right: true, fixed: true, why }: right on the day of the visits, solved today.
 * Returns { verdicts: { C1: { right, why, fixed? } }, problems: [{ problem, explains, severity, severityWhy, fix, screenCost, doneWhen, keep, alreadyChanged }],
 * missed: [text], unexplained: [ids judged RIGHT that no problem explains] }; empty when the reply is not in the shape.
 */
export function parseHomework(text, ids = []) {
  const wanted = new Set(ids.map((x) => String(x).toUpperCase()));
  const verdicts = {};
  const problems = [];
  const missed = [];
  let cur = null;
  let field = null;
  let inMissed = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = bare(raw).trim();
    if (!line) continue;
    const verdict = /^(C\d+)\W{0,3}\s*(RIGHT|WRONG|ALREADY\s+FIXED)\b\W*\s*(.*)$/i.exec(line);
    if (verdict && !cur && !inMissed) {
      const id = verdict[1].toUpperCase();
      const said = verdict[2].toUpperCase();
      if (wanted.has(id) && !verdicts[id])
        verdicts[id] = { right: said !== "WRONG", why: verdict[3].trim(), ...(said.startsWith("ALREADY") ? { fixed: true } : {}) };
      continue;
    }
    const opened = /^PROBLEM\s*(\d+)\s*[:.\-–—)]?\s*(.*)$/i.exec(line);
    if (opened) {
      cur = {
        problem: opened[2].trim(),
        explains: [],
        severity: null,
        severityWhy: "",
        fix: "",
        screenCost: "",
        doneWhen: "",
        keep: "",
        alreadyChanged: "",
      };
      problems.push(cur);
      field = "problem";
      inMissed = false;
      continue;
    }
    if (/^VISITORS?\s+MISSED\b/i.test(line)) {
      inMissed = true;
      cur = null;
      const rest = afterHeading(line);
      if (rest && !/^none\.?$/i.test(rest)) missed.push(rest);
      continue;
    }
    if (inMissed) {
      const item = line.replace(/^[-*•\d.)\s]+/, "").trim();
      if (item && !/^none\.?$/i.test(item)) missed.push(item);
      continue;
    }
    if (!cur) continue;
    const head = HEADINGS.find(([, rx]) => rx.test(line.toUpperCase()));
    if (head) {
      field = head[0];
      const value = afterHeading(line);
      if (field === "explains") cur.explains = idsIn(value, wanted);
      else if (field === "severity") {
        const n = /\b([1-5])\b/.exec(value);
        cur.severity = n ? Number(n[1]) : null;
        cur.severityWhy = value.replace(/^\s*[1-5]\s*(\/\s*5)?\s*[-–—:,.]?\s*/, "").trim();
      } else cur[field] = value;
      continue;
    }
    // A line under a heading continues it.
    if (field === "explains") cur.explains = [...new Set([...cur.explains, ...idsIn(line, wanted)])];
    else if (field === "severity") cur.severityWhy = `${cur.severityWhy} ${line}`.trim();
    else if (field) cur[field] = `${cur[field]}${cur[field] ? "\n" : ""}${line}`;
  }
  const explained = new Set(problems.flatMap((p) => p.explains));
  const unexplained = Object.entries(verdicts)
    .filter(([id, v]) => v.right && !v.fixed && !explained.has(id))
    .map(([id]) => id);
  return { verdicts, problems, missed, unexplained };
}

/**
 * The synthesis turn's instruction: every expert's homework merged into ONE ordered burn-down list, as one JSON object
 * (no schema rides with the ask: a schema reply is a function call, which the GPT-6 routes refuse).
 */
export const BURNDOWN_INSTRUCTION = [
  "You turn a board of experts' homework into the burn-down list an engineering AI follows item by item, handing each",
  "item to one builder who has never seen this board. Below are the product, its recorded decisions, every complaint",
  "(id, screen, text) and each expert's homework: their RIGHT or WRONG call on each complaint routed to them, the",
  "problems they found, their fixes, done criteria and keeps, and what the visitors missed.",
  "Merge it: one item per problem to repair. Experts who found the same problem become one item naming them all. Keep",
  "the fix that best serves the product's main job and every recorded decision; when experts disagree, take the better",
  "call and say the other under dissent. Order the list: what stops the product's main job first, then what most people",
  "hit, then polish; an item another one needs comes before it. A complaint the experts judged WRONG is not built: put it",
  "under wrong_claims with why. Every complaint id goes in an item's claims or in wrong_claims. Each item stands alone:",
  "its fix names the screen, the element, words and behaviour (a size only when the problem is a size); done_when is",
  "checkable on a screenshot or a click.",
  "Choose each fix in the order the experts were given: take away, then reorder (hierarchy), then put behind a tap",
  "(progressive disclosure), and add to what shows before any tap only when the person needs it before their first action",
  "there, saying what leaves to make room; take the expert's fix that costs the screen least. screen_cost says what the",
  "fix adds to and takes from the screen before any tap. When three or more items land on one screen, that screen's first",
  "item is a SCREEN PASS: the order of importance on it (the one thing that leads, what comes second, what waits behind a",
  "tap) and what leaves it; the screen's other items follow it and say so. A fix that shows, hides or expands something",
  "names its motion.",
  "CHANGED SINCE THE VISITS, when given, lists the commits the product landed after the visitors' runs: the complaints and",
  "pictures are from before them. When a listed commit plausibly addresses an item (an expert's ALREADY CHANGED line, or",
  "the commit's own words), keep the item where it belongs in the list and fill already_changed with that commit's id and",
  "what may still be open; the builder reads today's code first. Leave already_changed out otherwise.",
  "A complaint the experts judged ALREADY FIXED (their NOW picture, today's screen, shows it solved) is not built: put it",
  "under already_fixed with what today's screen shows. When one expert calls it ALREADY FIXED and another RIGHT, keep it",
  "in its item and say the other call under dissent.",
  "THE SPLITS, when given, lists the complaints the experts called differently and each expert's call after one round",
  "between them. A settled split follows the experts' final call. A split still open is not yours to settle: never put it",
  "under wrong_claims or already_fixed; keep it in the item its RIGHT side's problem belongs to, or in no item, and name",
  "both sides under that item's dissent.",
  "Answer with ONE JSON object and nothing else, in this shape:",
  JSON.stringify({
    items: [
      {
        id: "B1",
        title: "<the repair in a few words>",
        screen: "<the screen path>",
        problem: "<the underlying problem>",
        claims: ["C1"],
        severity: 5,
        why_this_order: "<why it sits here in the list>",
        fix: "<the change, concrete: what goes, moves, folds away or is built>",
        screen_cost: "<what it adds to and takes from the screen before any tap>",
        done_when: "<what a person sees or can do when it is fixed>",
        keep: "<what must not change while fixing it>",
        experts: ["<seat ids behind it>"],
        dissent: "<another expert's different call and why it was not taken, or empty>",
        already_changed: {
          commit: "<a commit id from CHANGED SINCE THE VISITS that plausibly addresses this item>",
          how: "<what that commit changed for this item, and what may still be open>",
        },
      },
    ],
    wrong_claims: [{ claims: ["C5"], why: "<the misread or the harmful suggested fix>", experts: ["<seat ids>"] }],
    already_fixed: [{ claims: ["C7"], how: "<what today's screen shows>", experts: ["<seat ids>"] }],
    missed: [{ screen: "<path>", problem: "<what no complaint names>", expert: "<seat id>" }],
  }),
].join("\n");

/**
 * The synthesis prompt: the product, the decisions, what the product landed since the visits, every complaint one line
 * each, every expert's homework under its seat and the complaints it covered, then the splits after their round. Pure.
 */
export function burndownPrompt(claims, homework, { url = null, job = null, decisions = "", changes = null, round = [] } = {}) {
  return [
    ...(url ? [`THE PRODUCT: ${url}`] : []),
    ...(job ? [`THE HEARING'S ASK: ${job}`] : []),
    "",
    "RECORDED DECISIONS (they win over any fix):",
    decisions?.trim() ? decisions.trim() : "none recorded",
    ...changesLines(changes),
    "",
    `THE COMPLAINTS (${claims.length}), each ruled REAL by the room:`,
    ...claims.map((c) => `${c.id} [${screenKey(claimScreen(c))}] ${clip(c.text, 260)}`),
    "",
    "THE EXPERTS' HOMEWORK:",
    ...homework.flatMap((h) => [
      "",
      `=== ${h.seat}${h.name ? ` (${h.name})` : ""} on ${h.claims.join(", ")} ===`,
      String(h.text ?? "").trim(),
    ]),
    ...splitLines(round),
  ].join("\n");
}

/**
 * The burn-down list read and made safe to render: items in the synthesis's order (that order is the priority), renumbered
 * B1, B2, ..., unknown claim ids and unknown experts dropped, severity clamped to 1-5, an item's already_changed kept
 * only when it names one of `commits` (the changes since the visits; filled in from that list), `already_fixed` (the
 * complaints today's screen shows solved, never built), and `uncovered` naming every complaint no item, wrong_claims or
 * already_fixed entry accounts for. Throws when the answer holds no JSON object or names nothing at all. Pure.
 */
export function readBurndown(text, ids = [], seats = [], commits = []) {
  const got = structuredAnswer(text);
  const obj = got.data;
  if (!obj) throw new Error(`the burn-down is not one JSON object (${got.error})`);
  const wanted = new Set(ids.map((x) => String(x).toUpperCase()));
  const sat = new Set(seats);
  const str = (v) => (v == null ? "" : String(v).trim());
  const known = (list) => [...new Set((Array.isArray(list) ? list : []).map((x) => str(x).toUpperCase()))].filter((id) => wanted.has(id));
  const experts = (list) => [...new Set((Array.isArray(list) ? list : []).map(str))].filter((s) => !sat.size || sat.has(s));
  const changedBy = (v) => {
    const said = str(typeof v === "object" ? v?.commit : v);
    const sha = /\b[0-9a-f]{7,40}\b/i.exec(said)?.[0].toLowerCase();
    const hit = sha && commits.find((c) => c.sha.startsWith(sha) || sha.startsWith(c.sha));
    // A mark written as one string ("e8215b4 - the picker order is unchecked") keeps its words after the commit.
    const how = typeof v === "object" ? str(v?.how) : said.replace(/\b[0-9a-f]{7,40}\b[\s:\-–—]*/i, "").trim();
    return hit ? { commit: hit.sha, at: hit.at, subject: hit.subject, how } : null;
  };
  const items = (Array.isArray(obj.items) ? obj.items : [])
    .map((x) => {
      const changed = changedBy(x?.already_changed);
      return {
        title: str(x?.title),
        screen: str(x?.screen),
        problem: str(x?.problem),
        claims: known(x?.claims),
        severity: Math.min(5, Math.max(1, Math.round(Number(x?.severity)) || 1)),
        why_this_order: str(x?.why_this_order),
        fix: str(x?.fix),
        screen_cost: str(x?.screen_cost),
        done_when: str(x?.done_when),
        keep: str(x?.keep),
        experts: experts(x?.experts),
        dissent: str(x?.dissent),
        ...(changed ? { already_changed: changed } : {}),
      };
    })
    .filter((x) => x.problem && x.fix)
    .map((x, i) => ({ id: `B${i + 1}`, ...x, title: x.title || clip(x.problem, 80) }));
  const wrong = (Array.isArray(obj.wrong_claims) ? obj.wrong_claims : [])
    .map((x) => ({ claims: known(x?.claims), why: str(x?.why), experts: experts(x?.experts) }))
    .filter((x) => x.claims.length && x.why);
  const fixed = (Array.isArray(obj.already_fixed) ? obj.already_fixed : [])
    .map((x) => ({ claims: known(x?.claims), how: str(x?.how), experts: experts(x?.experts) }))
    .filter((x) => x.claims.length);
  // Every complaint may be fixed today or a misread; a list that names nothing at all is no answer.
  if (!items.length && !wrong.length && !fixed.length) throw new Error("the burn-down named no item with a fix");
  const missed = (Array.isArray(obj.missed) ? obj.missed : [])
    .map((x) => ({ screen: str(x?.screen), problem: str(x?.problem), expert: str(x?.expert) }))
    .filter((x) => x.problem);
  const covered = new Set([...items, ...wrong, ...fixed].flatMap((x) => x.claims));
  return { items, wrong_claims: wrong, already_fixed: fixed, missed, uncovered: [...wanted].filter((id) => !covered.has(id)) };
}

/** An expert's call on one complaint, as the split round names it. */
const callOf = (v) => (v.fixed ? "ALREADY FIXED" : v.right ? "RIGHT" : "WRONG");

/**
 * The complaints the homework split on: two experts or more called one differently (RIGHT, WRONG, ALREADY FIXED), in
 * claim order. On Packing Buddy (2026-10-10) the Architect called four demo claims WRONG where Norman called them
 * RIGHT, and the synthesis settled it by itself, against what was built. Pure.
 * Returns [{ claim, calls: [{ seat, call, why }] }].
 */
export function splitsOf(homework) {
  const byClaim = new Map();
  for (const h of homework)
    for (const [claim, v] of Object.entries(h.verdicts || {})) {
      const calls = byClaim.get(claim) || [];
      if (!calls.some((c) => c.seat === h.seat)) calls.push({ seat: h.seat, call: callOf(v), why: v.why });
      byClaim.set(claim, calls);
    }
  return [...byClaim]
    .filter(([, calls]) => new Set(calls.map((c) => c.call)).size > 1)
    .sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([claim, calls]) => ({ claim, calls }));
}

/** The split round's sittings: each expert in a split meets once, on every split it is in. Ids "round-<seat>". Pure. */
export function planRound(splits, names = new Map()) {
  const bySeat = new Map();
  for (const s of splits) for (const c of s.calls) bySeat.set(c.seat, [...(bySeat.get(c.seat) || []), s.claim]);
  return [...bySeat].map(([seat, claims]) => ({ id: `round-${seat}`, seat, name: names.get(seat) ?? null, claims }));
}

/** The reply shape an expert reads in the split round, in its own instructions (as the homework's). */
export const ROUND_INSTRUCTION = [
  "SPLIT ROUND. In the homework you and another expert called the complaints below differently. Each comes with every",
  "expert's call and reason, yours marked (you), and the pictures: THEN, the visitors' own screens on the day of the",
  "visits; NOW, the screen as it renders today in a fresh visit with no account, when given. Weigh the other reasons",
  "against the pictures and give your final call on each, one line per complaint, in exactly this shape and nothing else:",
  "",
  "C15: RIGHT - <your reason, answering the other expert's>",
  "C16: WRONG - <your reason>",
  "C17: ALREADY FIXED - <what the NOW picture shows of that very element>",
  "",
  "Keep your call unless the other reason or the pictures convince you; when they do, change it and say what did.",
].join("\n");
export const ROUND_SHAPE = "^\\W*C\\d+\\W{0,3}\\s*(RIGHT|WRONG|ALREADY\\s+FIXED)\\b";
export const ROUND_AGAIN =
  "\n\nYour last answer was not in the shape above. Answer only with one C<n>: RIGHT, WRONG or ALREADY FIXED line per complaint.";

/**
 * One expert's split round said into its meeting: each split it is in, the claim's record and THEN picture, today's
 * NOW pictures of its screen when captured (`now`, keyed by unit through `unitOf`), and every expert's call and reason.
 * Pure. Returns { text, images }.
 */
export function roundText(r, splits, byId, { url = null, now = null, unitOf = new Map() } = {}) {
  const mine = splits.filter((s) => r.claims.includes(s.claim));
  const groups = new Map();
  for (const s of mine) {
    const c = byId.get(s.claim);
    if (!c) continue;
    const u = unitOf.get(c.id) ?? c.id;
    groups.set(u, { id: u, claims: [...(groups.get(u)?.claims || []), c] });
  }
  const pictures = sittingPictures([...groups.values()], now?.shots);
  const shotOf = (c) => c.sources?.find((s) => s.shot)?.shot ?? null;
  const lines = [
    ...(url ? [`THE PRODUCT: ${url}`] : []),
    `SPLIT ROUND FOR ${r.name || r.seat}: the experts called these ${mine.length} complaint(s) differently in their homework.`,
  ];
  const k = pictures.then.length;
  if (pictures.all.length)
    lines.push(
      `THE PICTURES: ${k ? `1-${k} are THEN` : "no THEN picture"}${pictures.all.length > k ? `; ${k + 1}-${pictures.all.length} are NOW (${now.at})` : ""}.`,
    );
  for (const s of mine) {
    const c = byId.get(s.claim);
    lines.push("");
    if (c) lines.push(claimLine(c, pictures.then.indexOf(shotOf(c)) + 1 || null));
    else lines.push(`${s.claim}.`);
    const n = c && pictures.now.get(unitOf.get(c.id) ?? c.id);
    if (n) lines.push(`   NOW: picture ${n[0]} at 390x844, picture ${n[1]} at ${NOW_DESKTOP}`);
    for (const x of s.calls) lines.push(`   ${x.seat}${x.seat === r.seat ? " (you)" : ""}: ${x.call} - ${clip(x.why, 600)}`);
  }
  return { text: lines.join("\n"), images: pictures.all };
}

/**
 * Each split after the round: every expert's first call, its final call (its round answer, or its first call held
 * when it gave none), and whether the experts now agree. Pure. `finals` maps a seat to its round verdicts.
 * Returns [{ claim, settled, call?, calls: [{ seat, first, final, why, unanswered? }] }].
 */
export function settleSplits(splits, finals = new Map()) {
  return splits.map((s) => {
    const calls = s.calls.map((c) => {
      const v = finals.get(c.seat)?.[s.claim];
      return { seat: c.seat, first: c.call, final: v ? callOf(v) : c.call, why: v?.why || c.why, ...(v ? {} : { unanswered: true }) };
    });
    const agreed = new Set(calls.map((c) => c.final));
    return { claim: s.claim, settled: agreed.size === 1, ...(agreed.size === 1 ? { call: calls[0].final } : {}), calls };
  });
}

/** The synthesis prompt's block of splits after the round. Pure. */
export function splitLines(round) {
  if (!round?.length) return [];
  const said = (c) => `${c.seat} ${c.first === c.final ? c.final : `${c.first} -> ${c.final}`}: ${clip(c.why, 300)}`;
  return [
    "",
    "THE SPLITS, AFTER ONE ROUND BETWEEN THEIR EXPERTS (their own final calls; a split still open is not yours to settle):",
    ...round.map((s) => `${s.claim}: ${s.settled ? `SETTLED ${s.call}` : "STILL SPLIT"} - ${s.calls.map(said).join("; ")}`),
  ];
}

/**
 * The burn-down made to keep every split the round left open: such a claim is taken out of wrong_claims and
 * already_fixed (the synthesis does not settle a split), each item holding one carries `split` with every expert's
 * final call, and `splits` lists them all with the item each sits in (null: none, so it is not built until decided).
 * Pure; returns a new list.
 */
export function applySplits(list, round = []) {
  const open = new Map(round.filter((s) => !s.settled).map((s) => [s.claim, s]));
  const calls = (id) => open.get(id).calls.map(({ seat, final, why }) => ({ seat, call: final, why }));
  const strip = (rows = []) => rows.map((x) => ({ ...x, claims: x.claims.filter((id) => !open.has(id)) })).filter((x) => x.claims.length);
  const items = list.items.map((x) => {
    const here = x.claims.filter((id) => open.has(id));
    return here.length ? { ...x, split: here.map((id) => ({ claim: id, calls: calls(id) })) } : x;
  });
  return {
    ...list,
    items,
    wrong_claims: strip(list.wrong_claims),
    already_fixed: strip(list.already_fixed),
    splits: [...open.keys()].map((id) => ({ claim: id, item: items.find((x) => x.claims.includes(id))?.id ?? null, calls: calls(id) })),
    uncovered: list.uncovered.filter((id) => !open.has(id)),
  };
}

/** A homework record without its full reply text (the files keep the text; homework.json keeps what was read from it). */
const withoutText = ({ text: _text, ...r }) => r;

const sumCost = (rows) => Math.round(rows.reduce((t, r) => t + (Number(r?.cost_usd) || 0), 0) * 1e6) / 1e6;

/**
 * One ask on the expert route: the pinned model first, then the `critical` profile's own route when it did not answer.
 * Resolves askBrain's reply with `failedOver` (the pinned try's error) when the second answered.
 */
export async function askStrong(spec, { ask = askBrain, route = EXPERT_ROUTE } = {}) {
  const base = { maxTokens: route.maxTokens, timeoutS: route.timeoutS, ...spec };
  const pinned = await ask({ ...base, model: route.model, reasoning: route.reasoning }, null);
  if (pinned?.status === "ok" && String(pinned.answer ?? "").trim()) return pinned;
  const why = `${route.model}: ${pinned?.status ?? "no reply"}${pinned?.error ? ` - ${String(pinned.error).slice(0, 200)}` : ""}`;
  const routed = await ask({ ...base, model: "auto", profile: route.profile, reasoning: route.reasoning }, null);
  return { ...routed, failedOver: why };
}

/** The default splitter: one text-only ask on the expert route, its JSON read. */
export function strongSplit({ ask = askBrain } = {}) {
  return async ({ screen, claims }) => {
    const reply = await askStrong({ prompt: splitRequest(screen, claims) }, { ask });
    if (reply.status !== "ok") throw new Error(`the split did not answer: ${reply.error || reply.status}`);
    const got = structuredAnswer(reply.answer);
    const data = got.data;
    if (!Array.isArray(data?.groups)) throw new Error(`the split's answer held no groups (${got.error || "no groups key"})`);
    return { groups: data.groups, model: reply.model, cost_usd: reply.cost_usd ?? null, seconds: reply.seconds ?? null };
  };
}

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The docket's recorded decisions: decisions.md beside the rulings, when the hearing or the owner left one. */
export function docketDecisions(docketDir) {
  const p = path.join(docketDir, "decisions.md");
  return existsSync(p) ? readFileSync(p, "utf8").trim() : "";
}

/** Where a product keeps its standing decisions: a path in its repository, read at STANDING_REF. */
export const STANDING_DECISIONS = ".dredd/decisions.md";
/** The landed picks: a hearing's checkout can sit far behind (Raise Buddy's, 23 commits on 2026-10-12, held by a peer's edits). */
export const STANDING_REF = "origin/main";

/**
 * The product's standing decisions: the owner's dated picks for its screens, .dredd/decisions.md as landed on its
 * origin/main. Every hearing on the product reads them beside its own decisions.md, and the repair review with them, so
 * a pick outlives the hearing it was made beside. Raise Buddy's matches header, the owner's pick A on 2026-10-12 (counts
 * in each group's head, nothing above the list), was undone within ten hours by visitor rounds 14, 17 and 20, whose
 * dockets recorded no decision. Empty when there is no checkout, no origin/main, or no such file on it; any other git
 * failure throws.
 */
export function standingDecisions(repo) {
  if (!repo) return "";
  try {
    return execFileSync("git", ["-C", repo, "show", `${STANDING_REF}:${STANDING_DECISIONS}`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    }).trim();
  } catch (err) {
    if (/does not exist in|exists on disk, but not in|invalid object name|not a git repository/i.test(String(err?.stderr || ""))) return "";
    throw new Error(`could not read ${STANDING_DECISIONS} at ${STANDING_REF} in ${repo}: ${String(err?.stderr || err?.message || err).trim()}`, {
      cause: err,
    });
  }
}

/** How many homework sittings and syntheses each model answered. Pure. */
export function modelsOf(rows) {
  const n = {};
  for (const r of rows) if (r) n[r.model ?? "?"] = (n[r.model ?? "?"] || 0) + 1;
  return n;
}

/**
 * The whole stage on a docket that holds its rulings: units (homework/units.json), Jev's routing (routing.json), every
 * routed expert's homework (homework/<seat>-<n>.answers.json, then homework.json), and the burn-down (burndown.json,
 * burndown.md). With `repo` (the judged product's git checkout) the homework and the synthesis read what it landed
 * after the newest visit (changesSinceVisits), and the list marks an item a listed commit plausibly addresses. A rerun
 * keeps the units, the routing and every homework that already answered (it judged the visits, which have not changed),
 * and writes the burn-down again when a homework sat, the changes since the visits differ, or it is missing; `fresh`
 * redoes all. The sittings run breadth first (planHomework) and stop opening at the Boardroom's allowance refusal or
 * once they would pass `maxUsd` dollars in this run (runSittings; the synthesis, one call, is outside the cap).
 * `sitHomework(sittings, { outDir, maxUsd })` defaults to the Connections door (diagnose-claims.mjs through `run`); `route` to
 * Jev; `synthesize` to the expert route. Throws when the docket holds no rulings, or the burn-down could not be written.
 */
export async function diagnoseFieldClaims({
  root,
  docketDir,
  seatsDir = null,
  run = null,
  sitHomework = null,
  capture = undefined,
  route = null,
  askJevFn = askJev,
  split = undefined,
  synthesize = null,
  roster = null,
  url = null,
  job = null,
  decisions = null,
  repo = null,
  fresh = false,
  maxUsd = null,
  log = () => {},
  now = () => Date.now(),
}) {
  const started = now();
  const ruled = readRulings(docketDir);
  if (!ruled) throw new Error(`no rulings in ${docketDir}: the experts work on what the room ruled REAL`);
  const real = realClaims(ruled);
  const dir = path.join(docketDir, HOMEWORK_DIR);
  mkdirSync(dir, { recursive: true });
  const decided = [standingDecisions(repo), decisions ?? "", docketDecisions(docketDir)].filter((t) => t && t.trim()).join("\n\n");
  const byId = new Map(real.map((c) => [c.id, c]));
  const bench = roster ?? loadSeatRoster(seatsDir || undefined);

  let changes = null;
  if (repo) {
    try {
      changes = changesSinceVisits(repo, real);
      log(
        changes
          ? `experts: ${changes.commits.length + changes.more} commit(s) landed in ${repo} after the newest visit (${changes.run})`
          : `experts: no REAL claim cites a dated run, so nothing in ${repo} is compared with the visits`,
      );
    } catch (err) {
      // The list is still worth writing; it says it was not checked against today's code (renderBurndownMd).
      changes = { repo, error: clip(err?.message || err, 300) };
      log(`experts: could not read what ${repo} changed since the visits: ${changes.error}`);
    }
  }

  const unitsFile = path.join(dir, "units.json");
  let plan = fresh ? null : readJson(unitsFile);
  if (plan && !plan.units?.every((u) => u.claims.every((id) => byId.has(id)))) plan = null;
  if (!plan) {
    const made = await planGroups(real, { split: split === undefined ? strongSplit() : split });
    plan = {
      units: made.units.map((u) => ({ id: u.id, screen: u.screen, cause: u.cause, claims: u.claims.map((c) => c.id) })),
      splits: made.splits,
    };
    writeFileSync(unitsFile, `${JSON.stringify(plan, null, 2)}\n`);
  }
  const units = plan.units.map((u) => ({ ...u, claims: u.claims.map((id) => byId.get(id)) }));
  const unitsById = new Map(units.map((u) => [u.id, u]));
  log(`experts: ${real.length} REAL claim(s) in ${units.length} unit(s)`);

  const routingFile = path.join(docketDir, ROUTING_JSON);
  let routing = fresh ? null : readJson(routingFile)?.routing;
  if (routing && routing.map((r) => r.unit).join() !== units.map((u) => u.id).join()) routing = null;
  if (!routing) {
    routing = route
      ? await route(units, { roster: bench, url })
      : await routeUnits(units, { roster: bench, url, ask: askJevFn });
    writeFileSync(routingFile, `${JSON.stringify({ routing, bench: bench.length, sit: ROUTE_SIT, max: ROUTE_MAX }, null, 2)}\n`);
  }
  const seatCount = {};
  for (const r of routing) for (const s of r.seats) seatCount[s.id] = (seatCount[s.id] || 0) + r.claims.length;
  log(
    `experts: Jev routed the units to ${Object.keys(seatCount).length} seat(s): ${Object.entries(seatCount)
      .map(([s, n]) => `${s} (${n})`)
      .join(", ")}`,
  );

  const homework = planHomework(routing, unitsById, { kept: fresh ? [] : answeredHomework(dir) });
  const answerFile = (h) => path.join(dir, `${h.id}.answers.json`);
  const answered = (h) => {
    const a = readJson(answerFile(h));
    return a && !a.error && a.text && a.claims?.join() === h.claims.join() ? a : null;
  };
  const todo = homework.filter((h) => !h.kept && (fresh || !answered(h)));
  if (homework.length - todo.length) log(`experts: ${homework.length - todo.length} homework(s) already answered, kept`);
  let today = null;
  let spent = 0;
  if (todo.length) {
    // Today's screen of every unit still to sit, beside the visitors' pictures (captureNow), captured once per run.
    const shoot = capture === undefined ? (run && url ? (o) => captureNow({ root, run, url, ...o }) : null) : capture;
    if (shoot) {
      const toSit = [...new Set(todo.flatMap((h) => h.units))].map((id) => unitsById.get(id));
      const stamp = new Date(started).toISOString().replace(/[-:]/g, "").slice(0, 15);
      try {
        today = await shoot({ units: toSit, url, outDir: path.join(dir, "now", stamp) });
      } catch (err) {
        today = { at: new Date(started).toISOString(), shots: {}, error: clip(err?.message || err, 300) };
      }
      const got = toSit.filter((u) => today.shots?.[u.id]?.phone).length;
      log(`experts: today's screens for ${got} of ${toSit.length} unit(s)${today.error ? ` (${today.error})` : ""}`);
      writeFileSync(path.join(dir, "now.json"), `${JSON.stringify(today, null, 2)}\n`);
    }
    const sittings = todo.map((h) => {
      const mine = h.units.map((id) => unitsById.get(id));
      return {
        id: h.id,
        seat: h.seat,
        claims: h.claims,
        text: homeworkText(h, mine, { url, job, decisions: decided, changes, now: today }),
        images: sittingPictures(mine, today?.shots).all,
        instruction: HOMEWORK_INSTRUCTION,
        shape: HOMEWORK_SHAPE,
        again: HOMEWORK_AGAIN,
      };
    });
    log(`experts: ${sittings.length} homework sitting(s), in order: ${sittings.map((s) => `${s.id} (${s.claims.length})`).join(", ")}`);
    const door = sitHomework || ((list) => sitSittings({ root, seatsDir, run, outDir: dir, label: "homework", sittings: list, maxUsd }));
    const out = await door(sittings, { outDir: dir, maxUsd, label: "homework" });
    spent += Number(out?.spent) || 0;
    if (out?.stopped)
      log(`experts: stopped at ${out.stopped}:${out.skipped?.length ?? "?"} sitting(s) not sat; rerun the same command to sit them`);
  }
  const records = homework.map((h) => {
    const a = readJson(answerFile(h));
    if (!a || a.error || !a.text) return { ...h, error: a?.error || "no answer" };
    const parsed = parseHomework(a.text, h.claims);
    return {
      ...h,
      model: a.model ?? null,
      seconds: a.seconds ?? null,
      cost_usd: a.cost_usd ?? null,
      ...(a.failedOver ? { failedOver: a.failedOver } : {}),
      ...(a.retried ? { retried: true } : {}),
      ...parsed,
      ...(parsed.problems.length || Object.keys(parsed.verdicts).length ? {} : { unshaped: String(a.text).slice(0, 600) }),
      text: a.text,
    };
  });
  const done = records.filter((r) => !r.error);
  for (const r of records.filter((x) => x.error)) log(`experts: ${r.id} gave no homework: ${r.error}`);

  // A split goes back to the experts in it once, each reading the others' reasons, before the synthesis: the synthesis
  // is never the one to settle it (Packing Buddy, 2026-10-10: it took the Architect's WRONG over Norman's RIGHT).
  const splits = splitsOf(done);
  const roundPlan = planRound(splits, new Map(done.map((h) => [h.seat, h.name])));
  const roundAnswer = (r) => {
    const a = readJson(answerFile(r));
    return a && !a.error && a.text && a.claims?.join() === r.claims.join() ? a : null;
  };
  const roundTodo = roundPlan.filter((r) => fresh || !roundAnswer(r));
  if (roundTodo.length) {
    const shots = today ?? readJson(path.join(dir, "now.json"));
    const unitOf = new Map(units.flatMap((u) => u.claims.map((c) => [c.id, u.id])));
    const sittings = roundTodo.map((r) => ({
      id: r.id,
      seat: r.seat,
      claims: r.claims,
      ...roundText(r, splits, byId, { url, now: shots, unitOf }),
      instruction: ROUND_INSTRUCTION,
      shape: ROUND_SHAPE,
      again: ROUND_AGAIN,
    }));
    log(
      `experts: ${splits.length} split claim(s) go back to their experts once: ${sittings.map((x) => `${x.id} (${x.claims.length})`).join(", ")}`,
    );
    const left = maxUsd == null ? null : Math.max(0, maxUsd - spent);
    const door =
      sitHomework || ((list) => sitSittings({ root, seatsDir, run, outDir: dir, label: "split round", sittings: list, maxUsd: left }));
    await door(sittings, { outDir: dir, maxUsd: left, label: "split round" });
  }
  const roundRecords = roundPlan.map((r) => {
    const a = roundAnswer(r);
    if (!a) return { ...r, error: readJson(answerFile(r))?.error || "no answer" };
    return {
      ...r,
      model: a.model ?? null,
      seconds: a.seconds ?? null,
      cost_usd: a.cost_usd ?? null,
      verdicts: parseHomework(a.text, r.claims).verdicts,
    };
  });
  const round = settleSplits(splits, new Map(roundRecords.filter((r) => r.verdicts).map((r) => [r.seat, r.verdicts])));
  if (round.length)
    log(
      `experts: after one round, ${round.filter((x) => x.settled).length} split(s) settled, ${round.filter((x) => !x.settled).length} still split`,
    );
  writeFileSync(
    path.join(docketDir, HOMEWORK_JSON),
    `${JSON.stringify({ homework: records.map(withoutText), ...(round.length ? { round: roundRecords, splits: round } : {}) }, null, 2)}\n`,
  );
  if (!done.length) throw new Error("no expert answered its homework");

  const burnFile = path.join(docketDir, BURNDOWN_JSON);
  const prior = readJson(burnFile);
  const shas = (ch) => (ch?.commits ?? []).map((c) => c.sha).join();
  let burn = !fresh && !todo.length && !roundTodo.length && prior?.items && shas(prior.changes) === shas(changes) ? prior : null;
  if (!burn) {
    const prompt = burndownPrompt(real, done, { url, job, decisions: decided, changes, round });
    const ask = synthesize || ((spec) => askStrong(spec, { route: BURNDOWN_ROUTE }));
    let reply = await ask({ system: BURNDOWN_INSTRUCTION, prompt });
    let list = null;
    let why = null;
    for (let attempt = 0; attempt < 2 && !list; attempt += 1) {
      if (attempt)
        reply = await ask({
          system: `${BURNDOWN_INSTRUCTION}\n\nYour last answer was not one JSON object with items. Answer with the JSON object only.`,
          prompt,
        });
      if (reply?.status !== "ok") {
        why = `the burn-down did not answer (${reply?.status}${reply?.error ? `: ${String(reply.error).slice(0, 200)}` : ""})`;
        continue;
      }
      try {
        list = readBurndown(
          reply.answer,
          real.map((c) => c.id),
          [...new Set(done.map((h) => h.seat))],
          changes?.commits ?? [],
        );
      } catch (err) {
        why = String(err?.message || err);
      }
    }
    if (!list) throw new Error(why || "the burn-down could not be written");
    list = applySplits(list, round);
    // A claim ruled wrong keeps the experts whose last call was RIGHT: on Packing Buddy (2026-10-10) the list took the
    // Architect's WRONG on four demo claims Norman had called RIGHT, and the split was lost.
    const finalOf = new Map(round.map((x) => [x.claim, new Map(x.calls.map((c) => [c.seat, c.final]))]));
    const calledRight = (h, id) =>
      finalOf.has(id) ? finalOf.get(id).get(h.seat) === "RIGHT" : Boolean(h.verdicts?.[id]?.right && !h.verdicts[id].fixed);
    for (const w of list.wrong_claims) {
      w.ruledRightBy = [...new Set(done.filter((h) => w.claims.some((id) => calledRight(h, id))).map((h) => h.seat))];
    }
    const sat = roundRecords.filter((r) => !r.error);
    const costs = [...done, ...sat, ...(plan.splits || []), reply];
    burn = {
      docket: docketDir,
      url,
      // The repair review holds every repair to them (reviewItem).
      decisions: decided || null,
      ...list,
      synthesis: {
        model: reply.model ?? null,
        seconds: reply.seconds ?? null,
        cost_usd: reply.cost_usd ?? null,
        ...(reply.failedOver ? { failedOver: reply.failedOver } : {}),
      },
      route: { experts: EXPERT_ROUTE.model, failover: EXPERT_ROUTE.profile, routing: "jev" },
      claims: real.length,
      units: units.length,
      homework: done.length,
      // A list written from part of the homework says so: the Packing Buddy proof run (2026-10-10) had 31 of 50
      // sittings refused at the plane's five-hour allowance, and its list read as whole.
      unanswered: records.filter((r) => r.error).map((r) => ({ id: r.id, error: clip(r.error, 200) })),
      ...(changes ? { changes } : {}),
      ...(today ? { now: { at: today.at, captured: Object.values(today.shots || {}).filter((x) => x.phone).length } } : {}),
      ...(round.length ? { split_round: round } : {}),
      models: modelsOf([...done, ...sat, reply]),
      cost_usd: sumCost(costs),
      seconds: Math.round((now() - started) / 1000),
      finishedAt: new Date(now()).toISOString(),
    };
    writeFileSync(burnFile, `${JSON.stringify(burn, null, 2)}\n`);
  }
  writeFileSync(path.join(docketDir, BURNDOWN_MD), renderBurndownMd(burn, { byId, routing, docketDir }));
  log(
    `experts: burn-down of ${burn.items.length} item(s), ${burn.wrong_claims.length} wrong claim(s), ${burn.already_fixed?.length ?? 0} already fixed (${BURNDOWN_MD}); $${burn.cost_usd}; models ${JSON.stringify(burn.models)}`,
  );
  return { ...burn, routing, homework: records.map(withoutText) };
}

/** The burn-down a docket holds (null when none, or unreadable). */
export function readBurndownFile(docketDir) {
  return readJson(path.join(docketDir, BURNDOWN_JSON));
}

/**
 * burndown.md: the list in order, then every item as a standalone brief, in the shape the Packing Buddy repairs were
 * handed to their builders (tmp/boardroom-h5/task-*.txt and PLAN.md), then what the experts ruled wrong and what the
 * visitors missed. Pure.
 */
export function renderBurndownMd(
  burn,
  { byId = new Map(), routing = [], docketDir = "", reviewCommand = "bun dredd/diagnose-claims.mjs" } = {},
) {
  const lines = [
    "# Burn-down: the experts' repairs, in order",
    "",
    `${burn.claims} REAL claim(s) in ${burn.units} unit(s), routed by Jev to the experts; ${burn.homework} homework(s); synthesis on ${burn.synthesis?.model ?? "?"}.`,
    `Docket: ${docketDir || burn.docket}. Follow it top down; hand each item to one builder as it stands.`,
    ...(burn.unanswered?.length
      ? [
          "",
          `PARTIAL: ${burn.unanswered.length} homework sitting(s) did not answer (${burn.unanswered.map((u) => u.id).join(", ")}): ${burn.unanswered[0].error}. Rerun the same command to sit them and write the list again.`,
        ]
      : []),
    ...changesHeader(burn.changes),
    "",
    "## The list",
    "",
    ...burn.items.map(
      (x) =>
        `${x.id}. [severity ${x.severity}] ${x.screen}: ${x.title} (${x.claims.join(", ") || "no claim"}; ${x.experts.join(", ") || "no expert named"})${x.already_changed ? ` ALREADY CHANGED in ${x.already_changed.commit}` : ""}${x.split?.length ? ` SPLIT on ${x.split.map((p) => p.claim).join(", ")}` : ""}`,
    ),
    "",
  ];
  const routedTo = (id) => routing.filter((r) => r.claims.includes(id)).flatMap((r) => r.seats.map((s) => s.id));
  for (const x of burn.items) {
    lines.push(`## ${x.id} - ${x.title}`, "");
    const ch = x.already_changed;
    if (ch) {
      lines.push(
        `ALREADY CHANGED in ${ch.commit} (${ch.at}): ${ch.subject}${ch.how ? ` - ${ch.how}` : ""}. The complaints below are from before it: read today's code and build only what is still open.`,
        "",
      );
    }
    for (const p of x.split || []) {
      lines.push(
        `SPLIT on ${p.claim}: its experts still disagree after one round (${callsLine(p.calls)}). Not settled here: decide ${p.claim} on today's screen before building that part.`,
        "",
      );
    }
    if (burn.url) lines.push(`Product: ${burn.url} (screen ${x.screen || "?"}). From Dredd docket ${docketDir || burn.docket}.`, "");
    lines.push(`Problem: ${x.problem}`, "", `Fix: ${x.fix}`, "");
    if (x.screen_cost) lines.push(`Screen cost: ${x.screen_cost}`, "");
    if (x.done_when) lines.push(`Done when: ${x.done_when}`, "");
    if (x.keep) lines.push(`Keep: ${x.keep}`, "");
    if (x.why_this_order) lines.push(`Why here in the list: ${x.why_this_order}`, "");
    lines.push(`Experts behind it: ${x.experts.join(", ") || "none named"}.${x.dissent ? ` Dissent: ${x.dissent}` : ""}`, "");
    lines.push("The complaints it answers, as the visitors filed them:");
    for (const id of x.claims) {
      const c = byId.get(id);
      const shot = c?.sources?.find((s) => s.shot)?.shot;
      lines.push(`- ${id}: ${c ? clip(c.text, 500) : "(not in the rulings)"}${shot ? `\n  her screenshot then: ${shot}` : ""}`);
    }
    const routed = [...new Set(x.claims.flatMap(routedTo))];
    lines.push(
      "",
      `Proof owed: render ${x.screen || "the screen"} headless before and after, at 390x844 and 1280x800, keep the PNGs, then`,
      `\`${reviewCommand} --review --docket ${docketDir || burn.docket} --item ${x.id} --after <png>[,<png>]\`${routed.length ? ` (routed experts: ${routed.join(", ")})` : ""}.`,
      "",
    );
  }
  if (burn.wrong_claims.length) {
    lines.push("## Complaints the experts ruled wrong: do not build", "");
    for (const w of burn.wrong_claims) {
      const who = [
        ...(w.experts.length ? [w.experts.join(", ")] : []),
        ...(w.ruledRightBy?.length ? [`ruled right by ${w.ruledRightBy.join(", ")}`] : []),
      ];
      lines.push(`- ${w.claims.join(", ")}: ${w.why}${who.length ? ` (${who.join("; ")})` : ""}`);
    }
    lines.push("");
  }
  if (burn.splits?.length) {
    lines.push("## Splits the experts did not settle after one round: decide before building", "");
    for (const p of burn.splits) lines.push(`- ${p.claim} (${p.item ? `in ${p.item}` : "in no item"}): ${callsLine(p.calls)}`);
    lines.push("");
  }
  const settled = (burn.split_round || []).filter((p) => p.settled);
  if (settled.length) {
    lines.push("## Splits the round settled", "");
    for (const p of settled) {
      const moved = p.calls.filter((c) => c.first !== c.final);
      lines.push(
        `- ${p.claim}: ${p.call}${moved.length ? ` (${moved.map((c) => `${c.seat} moved from ${c.first}: ${c.why}`).join("; ")})` : ""}`,
      );
    }
    lines.push("");
  }
  if (burn.already_fixed?.length) {
    lines.push("## Complaints today's screen shows fixed: do not build", "");
    for (const f of burn.already_fixed)
      lines.push(`- ${f.claims.join(", ")}: ${f.how || "fixed on today's screen"}${f.experts.length ? ` (${f.experts.join(", ")})` : ""}`);
    lines.push("");
  }
  if (burn.missed.length) {
    lines.push("## What the visitors missed", "");
    for (const m of burn.missed) lines.push(`- ${m.screen ? `${m.screen}: ` : ""}${m.problem}${m.expert ? ` (${m.expert})` : ""}`);
    lines.push("");
  }
  if (burn.uncovered?.length) lines.push("## Complaints no item accounts for", "", `- ${burn.uncovered.join(", ")}`, "");
  if (burn.changes?.commits?.length) {
    lines.push("## Changed since the visits", "", ...burn.changes.commits.map((c) => `- ${c.sha} ${c.at} ${c.subject}`));
    if (burn.changes.more) lines.push(`- and ${burn.changes.more} later commit(s) not listed`);
    lines.push("");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** Every expert's call on a split claim, one line. */
const callsLine = (calls) => calls.map((c) => `${c.seat} ${c.call ?? c.final} - ${clip(c.why, 300)}`).join("; ");

/** The lines under burndown.md's title that say whether the list was read against what the product landed since the visits. */
function changesHeader(ch) {
  if (!ch) return [];
  if (ch.error) return ["", `NOT CHECKED AGAINST TODAY'S CODE: reading what ${ch.repo} changed since the visits failed (${ch.error}).`];
  if (!ch.commits.length) return ["", `Nothing landed in ${ch.repo} after the newest visit (${ch.run}, ${ch.since}).`];
  return [
    "",
    `CHANGED SINCE THE VISITS: ${ch.repo} landed ${ch.commits.length + ch.more} commit(s) after the newest visit (${ch.run}, ${ch.since}), listed at the end; the complaints are from before them. An item marked ALREADY CHANGED names the commit that plausibly addresses it: read today's code before building it.`,
  ];
}

/**
 * Sittings on the Connections Boardroom through diagnose-claims.mjs (bun): each { id, seat, text, images, instruction,
 * shape, again } is one meeting of that seat alone; each answer lands in `outDir/<id>.answers.json` as it comes, so a
 * stopped run keeps what answered. The door runs them through runSittings (`maxUsd` its cap) and resolves
 * { status, stopped, spent, skipped }. Throws with the door's own words when it could not sit at all. `run` is the
 * hearing's command door (lib/collect.mjs runAsync).
 */
export async function sitSittings({ root, seatsDir = null, run, outDir, label, sittings, maxUsd = null }) {
  if (typeof run !== "function") throw new Error("sitSittings needs the hearing's command door (lib/collect.mjs runAsync)");
  const stem = path.join(outDir, `${label.replace(/\W+/g, "-")}-${Date.now()}`);
  const requestFile = `${stem}.request.json`;
  const outFile = `${stem}.out.json`;
  writeFileSync(
    requestFile,
    JSON.stringify({
      root,
      seatsDir,
      label,
      route: EXPERT_ROUTE,
      outDir,
      sittings,
      maxUsd,
      cacheFile: path.join(root, "tmp", "dredd", "connections-board.json"),
    }),
  );
  const r = await run("bun", [DIAGNOSE_SCRIPT, requestFile, outFile], { cwd: root, timeoutMs: 90 * 60_000 });
  const out = readJson(outFile);
  if (!out || out.error || r.status !== 0) {
    const why =
      out?.error ||
      String(r.error || r.stderr || `exit ${r.status}`)
        .trim()
        .slice(-400);
    throw new Error(`the Connections Boardroom could not sit the ${label}: ${why}`);
  }
  return out;
}

/** The reply shape a reviewing expert reads: one verdict for the item, what the AFTER pictures show, what broke, what is next. */
export const REVIEW_INSTRUCTION = [
  "REPAIR REVIEW. You and the other experts wrote the repair below (problem, fix, done when, keep). A builder has now",
  "repaired the screen. The pictures marked BEFORE are the screen as the visitors saw it; the pictures marked AFTER are",
  "the screen after the repair. Judge the AFTER pictures against the item's own FIX and DONE WHEN and against what must",
  "not change. Do not judge anything the item did not ask for, except a new problem the repair itself made. A screen",
  "that before any tap is busier AFTER than BEFORE (more words, more boxes, more things competing to be seen first) by",
  "more than the item's SCREEN COST allows is a problem the repair made: name it under BROKE. So is an AFTER screen that",
  "undoes a RECORDED DECISION, whatever the item asked.",
  "Answer in exactly this shape and nothing else:",
  "VERDICT: SOLVED | PARTLY | NOT SOLVED",
  "P1: SOLVED - <what the AFTER picture shows against the fix>",
  "BROKE: <anything the repair broke, or anything under KEEP that changed, or none>",
  "NEXT: <the next thing to build, concrete, or none>",
].join("\n");
export const REVIEW_SHAPE = "^\\W*VERDICT\\s*\\W";
export const REVIEW_AGAIN = "\n\nYour last answer had no VERDICT line. Answer only in the shape above, starting with VERDICT:.";

const VERDICT_WORD = /(NOT\s+SOLVED|PARTLY|SOLVED)/i;
const verdictOf = (text) => {
  const m = VERDICT_WORD.exec(String(text || ""));
  if (!m) return null;
  const w = m[1].toUpperCase().replace(/\s+/g, " ");
  return w === "NOT SOLVED" ? "NOT SOLVED" : w;
};

/**
 * A reviewing expert's reply: its verdict, a verdict per problem id, what broke and what is next. Pure. Returns
 * { verdict, problems: { P1: { verdict, why } }, broke, next }, `verdict` null when the reply has no VERDICT line.
 */
export function parseReview(text, problemIds = []) {
  const out = { verdict: null, problems: {}, broke: "", next: "" };
  const wanted = new Set(problemIds.map((x) => String(x).toUpperCase()));
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = bare(raw).trim();
    if (!line) continue;
    if (/^VERDICT\b/i.test(line)) out.verdict ??= verdictOf(afterHeading(line));
    else if (/^BROKE\b/i.test(line)) out.broke = afterHeading(line).replace(/^none\.?$/i, "");
    else if (/^NEXT\b/i.test(line)) out.next = afterHeading(line).replace(/^none\.?$/i, "");
    else {
      const m = /^(P\d+)\s*[:.\-–—)]\s*(NOT\s+SOLVED|PARTLY|SOLVED)\b\W*\s*(.*)$/i.exec(line);
      if (m && wanted.has(m[1].toUpperCase())) out.problems[m[1].toUpperCase()] ??= { verdict: verdictOf(m[2]), why: m[3].trim() };
    }
  }
  return out;
}

/** The experts' verdict on a repair: SOLVED or NOT SOLVED on a majority, PARTLY otherwise, NO VERDICT when none gave one. Pure. */
export function roomReview(verdicts) {
  const v = verdicts.filter(Boolean);
  if (!v.length) return "NO VERDICT";
  const n = (w) => v.filter((x) => x === w).length;
  if (n("SOLVED") * 2 > v.length) return "SOLVED";
  if (n("NOT SOLVED") * 2 > v.length) return "NOT SOLVED";
  return "PARTLY";
}

/** The room for the "... N more reading(s) cut" line when even the smallest share cannot fit every reading. */
const MEASURED_CUT_RESERVE = 120;
/** A reading's line never shrinks below this many characters; below it, the remaining readings are cut. */
const MEASURED_LINE_MIN = 160;

/**
 * The readings interleaved by view (the first of each view, then the second of each, and so on), each view keeping its
 * own order, so a page's phone and desktop readings both reach the expert whatever the budget. One view changes nothing. Pure.
 */
function interleaveByView(readings) {
  const byView = new Map();
  for (const r of readings) {
    if (!byView.has(r.view)) byView.set(r.view, []);
    byView.get(r.view).push(r);
  }
  const queues = [...byView.values()];
  const out = [];
  for (let i = 0; out.length < readings.length; i++) {
    for (const q of queues) if (i < q.length) out.push(q[i]);
  }
  return out;
}

/** The lines within `budget` characters (each line plus its newline), every line capped at one common share. Pure. */
function fitShares(lines, budget) {
  const cost = (cap) => lines.reduce((sum, l) => sum + Math.min(l.length, cap) + 1, 0);
  let lo = MEASURED_LINE_MIN;
  let hi = Math.max(...lines.map((l) => l.length));
  if (cost(hi) <= budget) return lines;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (cost(mid) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return lines.map((l) => (l.length <= lo ? l : `${l.slice(0, lo - 3)}...`));
}

/**
 * The capture's own readings as the experts' block: a head line, then one line per reading, `- <page>, <view>,
 * <source>: <json>`. The readings are interleaved by view so every view is represented throughout. The `max`
 * characters are shared fairly: when the lines do not all fit whole, each long line's JSON is cut to one common share
 * ending in "..." (a short line keeps its whole text and leaves its room to the long ones). A line never shrinks below
 * about 160 characters; only when even that cannot fit every reading are the rest cut, with a "... N more reading(s)
 * cut" line. A whole view is never dropped silently. Pure.
 */
export function measuredBlock(readings = [], max = 8000) {
  if (!readings.length) return [];
  const head = "MEASURED ON THE RENDERED PAGES (the capture's own readings, not the builder's claims):";
  const avail = max - head.length;
  const lines = interleaveByView(readings).map((r) => `- ${r.page}, ${r.view}, ${r.source}: ${JSON.stringify(r.result)}`);
  const total = lines.reduce((sum, l) => sum + l.length + 1, 0);
  if (total <= avail) return [head, ...lines];
  if (lines.length * (MEASURED_LINE_MIN + 1) <= avail) return [head, ...fitShares(lines, avail)];
  const kept = Math.floor((avail - MEASURED_CUT_RESERVE) / (MEASURED_LINE_MIN + 1));
  const cut = `- ... ${lines.length - kept} more reading(s) cut: the block is capped at ${max} characters`;
  return [head, ...fitShares(lines.slice(0, kept), avail - MEASURED_CUT_RESERVE), cut];
}

/**
 * The review's text said into each expert's meeting: the product's recorded decisions, the item's own spec, the picture
 * map and the measured readings. Pure.
 */
export function reviewText(item, { before = [], after = [], url = null, measured = [], others = [], kept = null, decisions = "" } = {}) {
  return [
    ...(url ? [`THE PRODUCT: ${url}`] : []),
    ...(decisions?.trim() ? ["RECORDED DECISIONS (an AFTER screen that undoes one is BROKE):", decisions.trim(), ""] : []),
    `THE SCREEN: ${item.screen || "?"}. THE REPAIR (${item.id}): ${item.title}`,
    "",
    `P1. [severity ${item.severity}/5] ${item.problem}`,
    `   FIX: ${item.fix}`,
    ...(item.screen_cost ? [`   SCREEN COST: ${item.screen_cost}`] : []),
    ...(item.done_when ? [`   DONE WHEN: ${item.done_when}`] : []),
    ...(item.keep ? [`   KEEP: ${item.keep}`] : []),
    "",
    `THE PICTURES: ${before.length ? `1-${before.length} are BEFORE` : "no BEFORE picture"}; ${after.length ? `${before.length + 1}-${before.length + after.length} are AFTER` : "no AFTER picture"}.`,
    ...(kept ? ["", `KEPT CALL (a recorded decision, not evidence): ${kept}`] : []),
    ...(others.length
      ? [
          "",
          "OTHER REPAIRS ON THESE SCREENS (judged under their own items; their visible effects are not this repair's regressions):",
          ...others.map((o) => `- ${o.id} (${o.status}) ${o.title}: ${o.spec}`),
        ]
      : []),
    ...(measured.length ? ["", ...measuredBlock(measured)] : []),
  ].join("\n");
}

/**
 * The experts' review of one burn-down item's repair: `after` screenshot paths (required), `before` ones (default: the
 * visitors' own pictures of the item's complaints), and `measured` the capture's readings (lib/burndown-follow.mjs
 * measuredReadings). The item's own experts review it. Writes review-<item>.json and .md
 * into the docket and appends to reviews.jsonl. Resolves { verdict, seats, ... }.
 */
export async function reviewItem({
  root,
  docketDir,
  seatsDir = null,
  itemId,
  after,
  before = null,
  run = null,
  sitReview = null,
  measured = [],
  others = [],
  kept = null,
  decisions = null,
  log = () => {},
  now = () => Date.now(),
}) {
  const burn = readBurndownFile(docketDir);
  if (!burn) throw new Error(`no ${BURNDOWN_JSON} in ${docketDir}: run the experts first`);
  const item = burn.items.find((x) => x.id === itemId);
  if (!item) throw new Error(`no item ${itemId} in ${BURNDOWN_JSON} (it has ${burn.items.map((x) => x.id).join(", ")})`);
  const afterShots = (after || []).filter(Boolean);
  if (!afterShots.length) throw new Error("--review needs --after <png>[,<png>]: the screen after the repair");
  for (const p of afterShots) if (!existsSync(p)) throw new Error(`no after screenshot at ${p}`);
  const ruled = readRulings(docketDir);
  const byId = new Map(realClaims(ruled).map((c) => [c.id, c]));
  const beforeShots = (before ?? picturesOf(item.claims.map((id) => byId.get(id)).filter(Boolean))).filter((p) => existsSync(p));
  const experts = item.experts.length ? item.experts : ["design-critic"];
  const t0 = now();
  const text = reviewText(item, {
    before: beforeShots,
    after: afterShots,
    url: burn.url,
    measured,
    others,
    kept,
    decisions: decisions ?? burn.decisions ?? "",
  });
  const dir = path.join(docketDir, HOMEWORK_DIR);
  const sittings = experts.map((seat) => ({
    id: `review-${itemId}-${seat}-${t0}`,
    seat,
    claims: item.claims,
    text,
    images: [...beforeShots, ...afterShots],
    instruction: REVIEW_INSTRUCTION,
    shape: REVIEW_SHAPE,
    again: REVIEW_AGAIN,
  }));
  const door = sitReview || ((list) => sitSittings({ root, seatsDir, run, outDir: dir, label: "repair review", sittings: list }));
  await door(sittings, { outDir: dir });
  const bySeat = {};
  for (const s of sittings) {
    const a = readJson(path.join(dir, `${s.id}.answers.json`));
    if (a?.text) bySeat[s.seat] = { model: a.model ?? null, cost_usd: a.cost_usd ?? null, ...parseReview(a.text, ["P1"]) };
  }
  const review = {
    item: itemId,
    screen: item.screen,
    verdict: roomReview(Object.values(bySeat).map((s) => s.verdict)),
    next: Object.entries(bySeat)
      .filter(([, s]) => s.next)
      .map(([seat, s]) => ({ seat, next: s.next })),
    broke: Object.entries(bySeat)
      .filter(([, s]) => s.broke)
      .map(([seat, s]) => ({ seat, broke: s.broke })),
    seats: bySeat,
    before: beforeShots,
    after: afterShots,
    cost_usd: sumCost(Object.values(bySeat)),
    seconds: Math.round((now() - t0) / 1000),
    at: new Date(now()).toISOString(),
  };
  writeFileSync(path.join(docketDir, `review-${itemId}.json`), `${JSON.stringify(review, null, 2)}\n`);
  writeFileSync(path.join(docketDir, `review-${itemId}.md`), renderReviewMd(review, item));
  appendFileSync(path.join(docketDir, "reviews.jsonl"), `${JSON.stringify({ item: itemId, verdict: review.verdict, at: review.at })}\n`);
  log(
    `review ${itemId}: ${review.verdict} (${Object.entries(bySeat)
      .map(([s, v]) => `${s} ${v.verdict ?? "none"}`)
      .join(", ")})`,
  );
  return review;
}

/** review-<item>.md: the experts' verdict, what broke and what is next, each expert's line. Pure. */
export function renderReviewMd(review, item) {
  const lines = [
    `# Repair review: ${review.item} (${review.screen}) - ${review.verdict}`,
    "",
    `Against "${item.title}": ${item.fix}`,
    `Before: ${review.before.length} picture(s); after: ${review.after.join(", ")}.`,
    "",
  ];
  if (review.broke.length) lines.push("## What the repair broke", "", ...review.broke.map((b) => `- ${b.seat}: ${b.broke}`), "");
  if (review.next.length) lines.push("## What is next", "", ...review.next.map((n) => `- ${n.seat}: ${n.next}`), "");
  lines.push("## The experts", "");
  for (const [seat, s] of Object.entries(review.seats)) {
    lines.push(`- ${seat} (${s.model ?? "?"}): ${s.verdict ?? "no verdict"}${s.problems.P1?.why ? ` - ${s.problems.P1.why}` : ""}`);
  }
  return `${lines.join("\n")}\n`;
}
