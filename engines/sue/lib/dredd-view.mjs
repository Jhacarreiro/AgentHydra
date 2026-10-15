// dredd-view.mjs - Dredd's hearings and Boardroom, read-only, for the Sue Manager page's Hearings and Boardroom tabs.
//
// Owner ask (the Chair, 2026-09-26): turn Sue's window into Dredd's, with tabs for Sue and the Boardroom, so he can see
// "all of these people you've made, the boardroom decisions, and then the Sue", with each adviser's picture and
// specialty, and "view previous boardroom discussions ... so I can judge whether or not you're making a stupid
// decision, like I ask you to review a charity website and you stick in game developers".
//
// So every hearing shows WHO WAS CONSIDERED AND WHY (seats.json: each seat's score and Jev's reason), who sat, what
// each seat argued (the sitting's transcript and ballots), the one fix the room backed and the verdict.
//
// It reads only what Dredd already wrote under a workspace's own `tmp/dredd/<stamp>/` (dredd/dredd.mjs, WHAT IT
// WRITES) and the seat roster Dredd itself sits (dredd/lib/seats.mjs loadSeatRoster: the seat files and one
// seat per shipped mind skill). Every folder and file is reached by an id that must match the shapes Dredd writes, so
// no request can name a path; nothing here writes, and no path of this computer is handed to the page.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { ENGINE_ROOT } from "../../dredd/lib/docket.mjs";
import { loadSeatRoster, seatsDirFor } from "../../dredd/lib/seats.mjs";
import { personPortraitFile } from "./personas.mjs";

/** A docket folder: `<yyyymmdd>-<hhmmss>-<4 hex>`, as dredd.mjs names it. */
export const HEARING_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
/** A sitting of the Boardroom inside a docket: `boardroom`, then `boardroom-1`, `boardroom-2`... */
const SITTING = /^boardroom(?:-(\d{1,2}))?$/;
/** The page screenshots a hearing takes (the ladder's render rung). */
export const HEARING_SHOT = /^page-(?:desk|phone)(?:-\d{2})?\.png$/;
/** A seat id: a seat file's own id, or `mind-<skill>`. */
export const SEAT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PORTRAIT_EXTS = [".webp", ".png", ".jpg"];
const HEARINGS_LISTED = 80;
const TEXT_MAX = 200_000;

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const readText = (file, max = TEXT_MAX) => {
  try {
    return readFileSync(file, "utf8").slice(0, max);
  } catch {
    return null;
  }
};
/** fn(), or `fallback` when it throws (a folder that is not there, a roster that will not load). */
const tryOr = (fn, fallback) => {
  try {
    return fn();
  } catch {
    return fallback;
  }
};
const str = (v, max = 2000) => (typeof v === "string" ? v.slice(0, max) : null);
const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Where a workspace's dockets are. */
const docketsDir = (root) => path.join(root, "tmp", "dredd");

/** A docket's time, from its own id (local time, as dredd.mjs stamped it). */
function stampAt(id) {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}` : null;
}

/** A docket's sittings, in order: each folder that holds its minutes. */
function sittingsOf(dir) {
  const n = (name) => Number(SITTING.exec(name)?.[1] ?? 0);
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && SITTING.test(e.name) && existsSync(path.join(dir, e.name, "minutes.json")))
      .map((e) => e.name)
      .sort((a, b) => n(a) - n(b));
  } catch {
    return [];
  }
}

/**
 * The verdict's ladder, one row per rung: `  4. FAIL Can people understand it?   2.3 stars over 3 Sue(s) ...`.
 * `state` is ok, FAIL, you (the owner's to confirm) or NOT CHECKED.
 */
export function ladderOf(verdictText) {
  const block = /## The ladder\s*```([\s\S]*?)```/.exec(String(verdictText ?? ""))?.[1] ?? "";
  const rows = [];
  for (const line of block.split(/\r?\n/)) {
    const m = /^\s*(\d)\.\s+(ok|FAIL|you|NOT CHECKED:?)\s+(.+?)(?:\s{2,}(.*))?$/.exec(line);
    if (!m) continue;
    // A rung that did not run says why after its question: "Does the design make sense? - not run: ...".
    const [question, why] = m[3].trim().split(/\s+-\s+(?=not run\b)/);
    const detail = (m[4] ?? why ?? "").trim().slice(0, 600);
    rows.push({ rung: Number(m[1]), state: m[2].replace(/:$/, ""), question: question.trim(), detail });
  }
  return rows;
}

/**
 * A sitting's debate as turns: each line that opens `**Name:** text` starts one, a line after it continues it. The
 * debate ends at the transcript's `---` (the verdict, ballots, minutes and plan below it are read from minutes.json).
 */
export function turnsOf(transcript) {
  const turns = [];
  for (const raw of String(transcript ?? "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "---") break;
    if (!line || line.startsWith("#") || line.startsWith("_Held on")) continue;
    const m = /^\*\*([^*]{1,80}):\*\*\s*(.*)$/.exec(line);
    if (m) turns.push({ speaker: m[1].trim(), text: m[2].trim().slice(0, 6000) });
    else if (turns.length) turns[turns.length - 1].text = `${turns[turns.length - 1].text}\n${line}`.slice(0, 6000);
  }
  return turns;
}

/** One sitting as the page sees it. */
function sittingView(dir, name, { withTurns }) {
  const m = readJson(path.join(dir, name, "minutes.json")) ?? {};
  const tally = m.tally && typeof m.tally === "object" ? m.tally : {};
  const view = {
    name,
    title: str(m.title, 200),
    room: str(m.room, 40),
    verdict: num(tally.verdict) ?? num(m.verdict),
    scores: Array.isArray(tally.scores) ? tally.scores.filter((s) => num(s) !== null) : [],
    split: tally.split === true,
    seats: Array.isArray(m.seats) ? m.seats.map((s) => str(s, 80)).filter(Boolean) : [],
    benched: Array.isArray(m.benched)
      ? m.benched.map((b) => ({ seat: str(b?.seat, 80), why: str(b?.why, 300) })).filter((b) => b.seat)
      : [],
    closer: str(m.closer, 80),
    fixFirst: str(m.fix_first, 1200),
    fixFirstBackedBy: num(m.fix_first_backed_by),
    closingLine: str(m.closing_line, 600),
  };
  if (!withTurns) return view;
  return {
    ...view,
    minutes: str(m.minutes, 8000),
    plan: str(m.plan, 4000),
    ballots: Array.isArray(m.ballots)
      ? m.ballots.map((b) => ({ seat: str(b?.seat, 80), score: num(b?.score), fixFirst: str(b?.fix_first, 1200) })).filter((b) => b.seat)
      : [],
    turns: turnsOf(readText(path.join(dir, name, "transcript.md"))),
  };
}

/** The ask a docket was opened on. */
function askOf(dir, docket) {
  return str(docket?.ask, 1200) ?? str(readText(path.join(dir, "ask.txt"), 1200)?.trim(), 1200);
}

/** One hearing in the list: what was asked, where, who sat in its last sitting, and what they decided. */
function hearingSummary(root, id) {
  const dir = path.join(docketsDir(root), id);
  const sittings = sittingsOf(dir);
  const verdictFile = path.join(dir, "verdict.md");
  const hasVerdict = existsSync(verdictFile);
  if (!sittings.length && !hasVerdict) return null;
  const docket = readJson(path.join(dir, "docket.json"));
  const last = sittings.length ? sittingView(dir, sittings[sittings.length - 1], { withTurns: false }) : null;
  const ladder = hasVerdict ? ladderOf(readText(verdictFile, 20_000)) : [];
  return {
    id,
    at: stampAt(id),
    ask: askOf(dir, docket),
    url: str(docket?.url, 600),
    title: last?.title ?? null,
    room: last?.room ?? null,
    verdict: last?.verdict ?? null,
    fixFirst: last?.fixFirst ?? null,
    seats: last?.seats ?? [],
    sittings: sittings.length,
    hearing: hasVerdict,
    failed: ladder.filter((r) => r.state === "FAIL").length,
  };
}

/** A workspace's hearings and Boardroom sittings, newest first. Empty for a folder Dredd never sat in. */
export function listHearings(root, { limit = HEARINGS_LISTED } = {}) {
  const ids = tryOr(() => readdirSync(docketsDir(root)).filter((name) => HEARING_ID.test(name)), []);
  const out = [];
  for (const id of ids.sort().reverse()) {
    const summary = hearingSummary(root, id);
    if (summary) out.push(summary);
    if (out.length >= limit) break;
  }
  return out;
}

/** Who Dredd considered for the room, with each seat's score and the reason it sat or did not (seats.json). */
function picksOf(dir) {
  const s = readJson(path.join(dir, "seats.json"));
  if (!s || !Array.isArray(s.rows)) return null;
  const picked = new Set(Array.isArray(s.picked) ? s.picked : []);
  return {
    room: str(s.room, 40),
    decidedBy: str(s.decidedBy, 200),
    rows: s.rows
      .map((r) => ({ id: str(r?.id, 80), name: str(r?.name, 80), score: num(r?.p), why: str(r?.why, 400), sat: picked.has(r?.id) }))
      .filter((r) => r.id && r.name),
  };
}

/** One hearing, whole: the ask, the verdict and its ladder, who was considered and why, and every sitting's debate. */
export function readHearing(root, id) {
  if (!HEARING_ID.test(String(id ?? ""))) return null;
  const summary = hearingSummary(root, id);
  if (!summary) return null;
  const dir = path.join(docketsDir(root), id);
  const verdictText = readText(path.join(dir, "verdict.md"), 60_000);
  let shots = [];
  try {
    shots = readdirSync(dir)
      .filter((name) => HEARING_SHOT.test(name))
      .sort();
  } catch {
    /* no shots */
  }
  return {
    ...summary,
    verdictText,
    ladder: ladderOf(verdictText),
    picks: picksOf(dir),
    sittingsDetail: sittingsOf(dir).map((name) => sittingView(dir, name, { withTurns: true })),
    shots,
  };
}

/** A hearing's screenshot file, or null when the id or name is not one Dredd writes. */
export function hearingShotFile(root, id, name) {
  if (!HEARING_ID.test(String(id ?? "")) || !HEARING_SHOT.test(String(name ?? ""))) return null;
  const file = path.join(docketsDir(root), id, name);
  return existsSync(file) ? file : null;
}

/** Where Dredd's seat portraits live, with credits.json: each photo's author, licence and source, each painting's prompt. */
const portraitsDir = (engineRoot) => path.join(engineRoot, "dredd", "portraits");
/** A seat that speaks as one of SUE's people (its brief is read `briefFrom` her file) wears her portrait. */

/**
 * A seat's portrait: `dredd/portraits/<seat id>.webp|png|jpg` in Dredd's own checkout, else the portrait of the
 * SUE person the seat speaks as (Grandma Sue's seat is SUE's grandma), else none. A real person's is a real photo (a
 * Wikimedia Commons one, credited, or their own public profile photo); a character's is a painted card.
 */
export function portraitFile(seatId, engineRoot = ENGINE_ROOT, seat = undefined) {
  if (!SEAT_ID.test(String(seatId ?? ""))) return null;
  for (const ext of PORTRAIT_EXTS) {
    const file = path.join(portraitsDir(engineRoot), `${seatId}${ext}`);
    if (existsSync(file)) return file;
  }
  const own = seat ?? tryOr(() => loadSeatRoster().find((s) => s.id === seatId), null);
  const sue = String(own?.briefFrom?.sue ?? "");
  const persona = SEAT_ID.test(sue) ? sue : null;
  return persona ? personPortraitFile(persona, path.join(engineRoot, "sue")) : null;
}

/** A photo's credit, as its licence asks: who took it, the licence and where it came from. Paintings carry none. */
function photoCredits(engineRoot = ENGINE_ROOT) {
  const photos = readJson(path.join(portraitsDir(engineRoot), "credits.json"))?.photos ?? {};
  const out = new Map();
  for (const [id, c] of Object.entries(photos)) {
    const author = str(c?.author, 160);
    const license = str(c?.license, 60);
    const source = str(c?.source, 600);
    if (author && license && source?.startsWith("https://commons.wikimedia.org/")) out.set(id, { author, license, source });
  }
  return out;
}

/**
 * Everyone who can sit: Dredd's seat files and one seat per shipped mind skill (loadSeatRoster, the roster Dredd itself
 * seats from), each with its specialty, rooms, whether a portrait exists, and how many of this folder's hearings it sat
 * in. The roster is Dredd's own, the same in every folder (a folder's `.dredd/seats` replaces the seat files, as it does
 * for Dredd); only the counts are the folder's.
 */
export function readRoster(root, hearings = listHearings(root)) {
  const roster = tryOr(() => loadSeatRoster(seatsDirFor(root)), []);
  const credits = photoCredits();
  const sat = new Map();
  for (const h of hearings) for (const name of h.seats) sat.set(name, (sat.get(name) ?? 0) + 1);
  return roster
    .filter((s) => SEAT_ID.test(String(s?.id ?? "")) && typeof s?.name === "string")
    .map((s) => ({
      id: s.id,
      name: s.name.slice(0, 80),
      title: str(s.seatTitle, 160),
      oneLiner: str(s.oneLiner, 600),
      kind: s.mind ? "mind" : "seat",
      rooms: Array.isArray(s.rooms) ? s.rooms.map((r) => str(r, 40)).filter(Boolean) : [],
      portrait: portraitFile(s.id, ENGINE_ROOT, s) !== null,
      portraitCredit: credits.get(s.id) ?? null,
      hearings: sat.get(s.name) ?? 0,
    }));
}
