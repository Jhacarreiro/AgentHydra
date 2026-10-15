/**
 * room - the table a FOCUS GROUP of Sues sits at: who is in it, what each one said or wrote in her
 * diary, the problems put on the table, the votes, and the one problem the room agreed on.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-23): "focus group is tons of Sues go into a room and they are presented
 * with something, your website, something, and they all give their opinions. They talk to each
 * other ... the Sues can see and talk to each other. And the goal is for the Sues to tell you what
 * feels off ... Then they all agree and they give you literally what their biggest problem is. Then
 * you fix that. Then you send in the next focus group. And the AI can make suggestions to Sues ...
 * imagine the AI is managing the group ... we think this is the problem, okay, what do you think
 * about this?"
 *
 * So a focus group is an ordinary SUE run (every Sue is still a whole Sue: her own browser, her own
 * account, her own rails) plus this room. Three phases, all derived from what was said, never a
 * second state file that could disagree with it:
 *   visiting  - everyone is on the website; each diary line she writes is heard by the others, and
 *               she can speak to them.
 *   table     - everyone has left the website (done or give_up), or the moderator called them in.
 *               The moderator asks, they talk, and each one VOTES for the single biggest problem:
 *               a new one in her own words, or one already on the table.
 *   closed    - the room agreed (`verdict.json`), by the moderator's conclude or, when the votes are
 *               in and nobody concludes, by the vote itself. Only then does a Sue give her exit
 *               interview (or when she has waited at the table longer than anyone should).
 *
 * ON DISK (`<runDir>/room/`), every file append-only or written once:
 *   room.json      what the room is about: the page, why they came, the caller's suggestions to put
 *                  to the table, and the LAST focus group's verdict on this page (the fix loop).
 *   roster.json    who sits at the table: every Sue's id, name and persona, in seat order.
 *   <speaker>.jsonl one file per speaker (each Sue, `moderator`, `host`), so two processes never
 *                  append to the same file at once except the host, whose lines are rare and small.
 *   verdict.json   the agreed problem, written once.
 *   heard files live with the listener (`<sueDir>/room-heard.json`), because only she writes them.
 *
 * NO AI HERE. Every word in the room was written by a Sue's brain, the moderator's brain or the
 * human host; this module only files, orders, counts and tells. The vote is counted, never judged.
 *
 * DEPENDED ON BY: body.mjs (a Sue's room, say and vote hands), moderator.mjs (the moderator's
 * hands), cannon.mjs (opens the roster, keeps the vote watchdog), sue.mjs (opens the room, books the
 * verdict into the workspace), report.mjs (the room's section), manager.mjs (the room route the Sue
 * Manager and Boardroom's Focus Group read and the host speaks through). Spec: tests/room.spec.mjs.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const ROOM_DIR = "room";
export const ROOM_META_FILE = "room.json";
export const ROSTER_FILE = "roster.json";
export const VERDICT_FILE = "verdict.json";
export const HEARD_FILE = "room-heard.json";
export const MODERATOR_ID = "moderator";
export const HOST_ID = "host";
/** The room's own voice: the lines nobody said but the harness (a verdict reached by the vote). */
export const ROOM_ID = "room";

/** The most Sues one focus group seats. They all browse at once, so this is also a wave's size. */
export const FOCUS_GROUP_MAX = 12;
/** Four Sues and their moderator: five agents, the most a chat drives at once on the flagship. */
export const FOCUS_GROUP_DEFAULT = 4;
/** The longest a Sue's `room` move waits for somebody to say something. */
export const ROOM_WAIT_MAX_SECONDS = 30;
/** How long a Sue sits at the table with no verdict before she may leave anyway. */
export const TABLE_MAX_MS = 12 * 60 * 1000;
/** Every vote is in and nobody has concluded for this long: the vote decides. */
export const VOTE_GRACE_MS = 3 * 60 * 1000;
/**
 * The longest the builders' guesses hold a room the vote would close: from the moderator's guesses
 * `ask` until every Sue at the table has answered, or past the vote's grace when no such ask came.
 */
export const GUESSES_WAIT_MS = 3 * 60 * 1000;
/** The longest a line a person says is kept whole; a longer one is cut there, and the cut is marked. */
export const LINE_MAX_CHARS = 1200;
/** A focus-group Sue's own exit-interview question, on top of the standard ones. */
export const BIGGEST_PROBLEM_KEY = "biggestProblem";
export const BIGGEST_PROBLEM_QUESTION =
  "In one sentence, in your own words: the single biggest problem with this website for you (even if the room picked a different one).";

/**
 * Every kind of line. `journal` is a diary line (her `note`), heard by the whole room as she writes
 * it (the owner: "you can literally hear them journaling. They hear each other's journal").
 */
export const LINE_KINDS = Object.freeze(["joined", "journal", "say", "vote", "left-page", "left", "ask", "propose", "gather", "verdict"]);

const SPEAKER_ID = /^[a-z0-9][a-z0-9-]{0,80}$/;

export function roomDir(runDir) {
  return path.join(runDir, ROOM_DIR);
}

/** Whether this run is a focus group: its room was opened. */
export function isFocusGroup(runDir) {
  return fs.existsSync(path.join(roomDir(runDir), ROOM_META_FILE));
}

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJsonOnce(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // `wx`: a second writer (a moderator's conclude racing the vote watchdog) is refused, never merged.
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

function clip(text, max = LINE_MAX_CHARS) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ── opening the room ────────────────────────────────────────────────────────────────────────────

/**
 * What the room is about, written by `sue run` before a single Sue opens her browser. `suggestions`
 * are the caller's own hypotheses ("we think the pricing is unclear"), put to the table by the
 * moderator AFTER the Sues have looked for themselves, never told to a Sue up front. `previous` is
 * the last focus group's verdict on this page, for the moderator only.
 */
export function openRoom(runDir, { url, page = null, intent, suggestions = [], previous = null, moderator = "ai", now = new Date() }) {
  const meta = {
    url: String(url),
    page,
    intent: String(intent ?? ""),
    suggestions: (Array.isArray(suggestions) ? suggestions : [])
      .map((s) => clip(s, 400))
      .filter(Boolean)
      .slice(0, 10),
    previous: previous ?? null,
    moderator: moderator === "none" ? "none" : "ai",
    openedAt: now.toISOString(),
  };
  fs.mkdirSync(roomDir(runDir), { recursive: true });
  fs.writeFileSync(path.join(roomDir(runDir), ROOM_META_FILE), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  return meta;
}

export function readMeta(runDir) {
  return readJson(path.join(roomDir(runDir), ROOM_META_FILE));
}

/** Who sits at the table, in seat order: `[{ id, name, persona, device? }]`. Written by the cannon. */
export function writeRoster(runDir, seats) {
  const roster = seats.map((s) => ({
    id: String(s.id),
    name: String(s.name),
    persona: String(s.persona ?? ""),
    ...(s.device ? { device: s.device } : {}),
  }));
  for (const seat of roster) if (!SPEAKER_ID.test(seat.id)) throw new Error(`room: "${seat.id}" is not a seat id`);
  fs.mkdirSync(roomDir(runDir), { recursive: true });
  fs.writeFileSync(path.join(roomDir(runDir), ROSTER_FILE), `${JSON.stringify(roster, null, 2)}\n`, "utf8");
  return roster;
}

export function readRoster(runDir) {
  const roster = readJson(path.join(roomDir(runDir), ROSTER_FILE), []);
  return Array.isArray(roster) ? roster : [];
}

// ── lines ───────────────────────────────────────────────────────────────────────────────────────

/**
 * One line into the room, from one speaker. The id is unique without any coordination between
 * processes (a speaker's own file, a time and a salt), so a vote can name the exact line it backs.
 * Unless the caller names its own time, the line is stamped at least a millisecond past the room's
 * newest line: every speaker writes its own file, so two lines in one clock tick were ordered by
 * speaker id, and the host's question could land BEFORE the Sue line it answered (2026-09-24,
 * manager.spec's host test failed about 1 run in 3 on Windows' coarse clock).
 */
export function appendLine(runDir, speaker, line, now = afterNewestLine(runDir)) {
  const from = String(speaker);
  if (!SPEAKER_ID.test(from)) throw new Error(`room: "${from}" is not a speaker`);
  const kind = String(line.kind ?? "say");
  if (!LINE_KINDS.includes(kind)) throw new Error(`room: "${kind}" is not a kind of line`);
  const at = now.toISOString();
  const full = {
    id: `${from}.${now.getTime().toString(36)}.${crypto.randomBytes(2).toString("hex")}`,
    at,
    from,
    name: String(line.name ?? from),
    kind,
    text: clip(line.text),
    ...(line.to ? { to: String(line.to) } : {}),
    ...(line.ref ? { ref: String(line.ref) } : {}),
    ...(line.why ? { why: clip(line.why, 600) } : {}),
    ...(line.url ? { url: String(line.url).replace(/[?#].*$/, "") } : {}),
    ...(line.noteKind ? { noteKind: String(line.noteKind) } : {}),
    ...(line.guesses ? { guesses: true } : {}),
  };
  fs.mkdirSync(roomDir(runDir), { recursive: true });
  fs.appendFileSync(path.join(roomDir(runDir), `${from}.jsonl`), `${JSON.stringify(full)}\n`, "utf8");
  return full;
}

/** Now, or one millisecond past the room's newest line when that line is not yet behind this clock. */
function afterNewestLine(runDir, clock = Date.now()) {
  let newest = -Infinity;
  for (const l of readLines(runDir)) newest = Math.max(newest, Date.parse(l.at) || -Infinity);
  return new Date(Math.max(clock, newest + 1));
}

/** Every line, in the order it was said. A half-written last line (a writer mid-append) waits for the next read. */
export function readLines(runDir) {
  const dir = roomDir(runDir);
  let files;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  const lines = [];
  for (const file of files) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    for (const row of raw.split("\n")) {
      if (!row.trim()) continue;
      try {
        const line = JSON.parse(row);
        if (line && typeof line.id === "string" && typeof line.at === "string") lines.push(line);
      } catch {
        /* a line still being written */
      }
    }
  }
  return lines.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
}

// ── who is where ────────────────────────────────────────────────────────────────────────────────

/**
 * Each seat's state, from what she said: `looking` (on the website), `table` (left the website, at
 * the table) or `gone` (exit interview given). Plus her current vote (the line id she backs).
 */
export function seatsOf(lines, roster) {
  const seats = new Map(roster.map((s) => [s.id, { ...s, state: "looking", vote: null, votedAt: null, atTableSince: null }]));
  const proposals = proposalsOf(lines);
  for (const line of lines) {
    const seat = seats.get(line.from);
    if (!seat) continue;
    if (line.kind === "left-page" && seat.state === "looking") {
      seat.state = "table";
      seat.atTableSince = line.at;
    } else if (line.kind === "left") seat.state = "gone";
    else if (line.kind === "vote") {
      const backs = line.ref && proposals.some((p) => p.id === line.ref) ? line.ref : line.id;
      seat.vote = backs;
      seat.votedAt = line.at;
    }
  }
  return [...seats.values()];
}

/**
 * The problems on the table, numbered in the order they were put there. A problem is a `vote`
 * with words and no `ref` (she put a new one down) or the moderator's `propose`. Each Sue's LATEST
 * vote is the one that counts, so changing her mind moves her, never counts her twice.
 */
export function proposalsOf(lines) {
  return lines
    .filter((l) => (l.kind === "vote" && !l.ref) || l.kind === "propose")
    .map((l, i) => ({ n: i + 1, id: l.id, by: l.from, byName: l.name, text: l.text, why: l.why ?? null, at: l.at }));
}

export function tally(lines, roster) {
  const proposals = proposalsOf(lines);
  const seats = seatsOf(lines, roster);
  const counted = proposals.map((p) => ({ ...p, backers: seats.filter((s) => s.vote === p.id).map((s) => ({ id: s.id, name: s.name })) }));
  return counted;
}

/** The phase the room is in, from its lines and its verdict. */
export function phaseOf(runDir, { lines = readLines(runDir), roster = readRoster(runDir) } = {}) {
  if (readVerdict(runDir)) return "closed";
  if (lines.some((l) => l.kind === "gather")) return "table";
  const seats = seatsOf(lines, roster);
  if (seats.length && seats.every((s) => s.state !== "looking")) return "table";
  return "visiting";
}

// ── hearing ─────────────────────────────────────────────────────────────────────────────────────

export function readHeard(file) {
  const ids = readJson(file, []);
  return new Set(Array.isArray(ids) ? ids : []);
}

export function writeHeard(file, heard) {
  fs.writeFileSync(file, `${JSON.stringify([...heard])}\n`, "utf8");
}

/** What `listener` has not heard yet, oldest first (her own lines are never news to her). */
export function unheard(lines, heard, listener) {
  return lines.filter((l) => l.from !== listener && !heard.has(l.id));
}

/**
 * Waits up to `seconds` (capped) for a line `listener` has not heard, checking the room's files
 * every `everyMs`. Answers the lines as soon as there is one, or an empty list when time runs out.
 */
export async function waitForNews(
  runDir,
  { heard, listener, seconds, everyMs = 500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) },
) {
  const until = Date.now() + Math.max(0, Math.min(Number(seconds) || 0, ROOM_WAIT_MAX_SECONDS)) * 1000;
  for (;;) {
    const news = unheard(readLines(runDir), heard, listener);
    if (news.length || Date.now() >= until) return news;
    await sleep(everyMs);
  }
}

// ── the verdict ─────────────────────────────────────────────────────────────────────────────────

export function readVerdict(runDir) {
  return readJson(path.join(roomDir(runDir), VERDICT_FILE));
}

/** What the backers of a problem said about it: their vote's reason, else their last words at the table. */
function quotesFor(lines, backers, proposal) {
  const quotes = [];
  if (proposal.why) quotes.push({ name: proposal.byName, text: proposal.why });
  for (const backer of backers) {
    const vote = [...lines]
      .reverse()
      .find((l) => l.from === backer.id && l.kind === "vote" && (l.ref === proposal.id || l.id === proposal.id));
    const said = vote?.why || [...lines].reverse().find((l) => l.from === backer.id && l.kind === "say")?.text;
    if (said && !quotes.some((q) => q.name === backer.name && q.text === said)) quotes.push({ name: backer.name, text: said });
  }
  return quotes.slice(0, 6);
}

/**
 * The room's verdict. `by` is who closed it: `moderator` (with the problem number the room agreed
 * on, or new words of its own for what they agreed) or `vote` (the watchdog, the problem with the
 * most backers; a tie goes to the one put on the table first). Written once: a second conclude is
 * refused and answered with the verdict already standing.
 */
export function conclude(runDir, { by, proposal = null, problem = null, summary = null, lastProblemStillThere = null, now = new Date() }) {
  const standing = readVerdict(runDir);
  if (standing) return { verdict: standing, already: true };
  const lines = readLines(runDir);
  const roster = readRoster(runDir);
  const counted = tally(lines, roster);
  let chosen = null;
  if (proposal != null && proposal !== "") {
    chosen = counted.find((p) => p.n === Number(proposal)) ?? null;
    if (!chosen)
      throw new Error(
        `there is no problem number ${proposal} on the table (there ${counted.length === 1 ? "is 1" : `are ${counted.length}`})`,
      );
  } else if (!problem) {
    chosen = [...counted].sort((a, b) => b.backers.length - a.backers.length || a.n - b.n)[0] ?? null;
    if (!chosen || !chosen.backers.length) return { verdict: null, already: false };
  }
  const words = clip(problem || chosen?.text || "", 600);
  if (!words) throw new Error("say what the room agreed the biggest problem is");
  const backers = chosen ? chosen.backers : [];
  const seats = seatsOf(lines, roster);
  const meta = readMeta(runDir) ?? {};
  const verdict = {
    problem: words,
    proposal: chosen ? chosen.n : null,
    putOnTableBy: chosen ? chosen.byName : null,
    agreedBy: backers.map((b) => b.name),
    against: seats.filter((s) => s.vote && !backers.some((b) => b.id === s.id)).map((s) => s.name),
    didNotVote: seats.filter((s) => !s.vote).map((s) => s.name),
    size: roster.length,
    summary: summary ? clip(summary, 1200) : null,
    quotes: chosen ? quotesFor(lines, backers, chosen) : [],
    decidedBy: by === "moderator" ? "moderator" : "vote",
    lastProblem: meta.previous?.problem ?? null,
    lastProblemStillThere: ["yes", "no", "unclear"].includes(String(lastProblemStillThere)) ? String(lastProblemStillThere) : null,
    at: now.toISOString(),
  };
  try {
    writeJsonOnce(path.join(roomDir(runDir), VERDICT_FILE), verdict);
  } catch (err) {
    if (err?.code === "EEXIST") return { verdict: readVerdict(runDir), already: true };
    throw err;
  }
  appendLine(
    runDir,
    by === "moderator" ? MODERATOR_ID : ROOM_ID,
    { kind: "verdict", name: by === "moderator" ? "The moderator" : "The room", text: words },
    now,
  );
  return { verdict, already: false };
}

/**
 * A Sue whose visit ended without saying goodbye (her browser died, her brain crashed, nobody drove
 * her, her deadline ran out) leaves the room anyway, so nobody at the table waits on a ghost and the
 * vote can close. A Sue who already left is left alone. Returns the line written, or null.
 *
 * After the verdict too, exactly as her own goodbye would be (focus-hands left()): a Sue whose brain
 * died in the exit interview otherwise kept her seat forever, and a closed room with a seat still
 * taken reads as live, so the Sue Manager offered its composer on a finished run (2026-09-23 review).
 */
export function markGone(runDir, sueId, { name, why = "her visit ended", now = new Date() } = {}) {
  const seat = seatsOf(readLines(runDir), readRoster(runDir)).find((s) => s.id === sueId);
  if (!seat || seat.state === "gone") return null;
  return appendLine(runDir, sueId, { kind: "left", name: name ?? seat.name ?? sueId, text: `(${why})` }, now);
}

/**
 * The vote watchdog's question: should the vote close the room now? Yes once nobody is still on the
 * website, every Sue at the table has voted, somebody backs something, and the last vote is
 * `graceMs` old (the moderator's chance to conclude in words first), unless the builders' guesses
 * still hold it (guessesHold). Also yes, with whatever votes there are, once every Sue has gone.
 */
export function voteShouldClose(runDir, { now = Date.now(), graceMs = VOTE_GRACE_MS } = {}) {
  if (readVerdict(runDir)) return false;
  const lines = readLines(runDir);
  const roster = readRoster(runDir);
  const seats = seatsOf(lines, roster);
  if (!seats.length) return false;
  if (seats.every((s) => s.state === "gone")) return seats.some((s) => s.vote);
  if (seats.some((s) => s.state === "looking") && !lines.some((l) => l.kind === "gather")) return false;
  const present = seats.filter((s) => s.state !== "gone");
  if (!present.every((s) => s.vote)) return false;
  const last = Math.max(...seats.filter((s) => s.votedAt).map((s) => Date.parse(s.votedAt)));
  if (!(Number.isFinite(last) && now - last >= graceMs)) return false;
  return !guessesHold({ meta: readMeta(runDir), lines, seats, now, since: last + graceMs });
}

/**
 * Whether the builders' guesses keep a room open that the vote would close: the room has suggestions
 * and an AI moderator, and not every Sue at the table has said something since the moderator's
 * guesses `ask`. The Sues vote as soon as they reach the table, so the vote alone closed rooms before
 * the guesses were put (run 20260925-074931-2d5f). Bounded by GUESSES_WAIT_MS: from the ask, or from
 * `since` (when the vote would have closed) while no guesses ask has come.
 */
function guessesHold({ meta, lines, seats, now, since }) {
  const state = guessesState({ meta, lines, seats });
  if (!state) return false;
  if (!state.ask) return now - since < GUESSES_WAIT_MS;
  if (now - Date.parse(state.ask.at) >= GUESSES_WAIT_MS) return false;
  return state.waiting.length > 0;
}

/**
 * Where the builders' guesses stand: null when the room has none to put (no suggestions, or no AI
 * moderator); else the moderator's guesses `ask` line (null until it comes) and the Sues at the table
 * who have said nothing since it.
 */
function guessesState({ meta, lines, seats }) {
  if (!meta?.suggestions?.length || meta.moderator === "none") return null;
  const at = lines.findIndex((l) => l.from === MODERATOR_ID && l.kind === "ask" && l.guesses);
  if (at < 0) return { ask: null, waiting: seats.filter((s) => s.state === "table") };
  const answered = new Set(
    lines
      .slice(at + 1)
      .filter((l) => l.kind === "say" || l.kind === "vote")
      .map((l) => l.from),
  );
  return { ask: lines[at], waiting: seats.filter((s) => s.state === "table" && !answered.has(s.id)) };
}

/**
 * Why the moderator may not conclude yet, or null: the builders' guesses are the one part of a focus
 * group its runner writes, so a room concluded in words before the Sues answered them loses exactly
 * what the runner came for (runs 20260924-185310-a67e, 20260925-074931-2d5f). Held until the guesses
 * `ask` is put and every Sue at the table has answered it, or GUESSES_WAIT_MS after that ask.
 */
export function guessesBlockConclude(runDir, { now = Date.now() } = {}) {
  const lines = readLines(runDir);
  const state = guessesState({ meta: readMeta(runDir), lines, seats: seatsOf(lines, readRoster(runDir)) });
  if (!state) return null;
  if (!state.ask) return "Put the builders' guesses to the room first: ask with guesses=true, then hear their answers (room wait=30) before you conclude.";
  if (now - Date.parse(state.ask.at) >= GUESSES_WAIT_MS || !state.waiting.length) return null;
  const names = state.waiting.map((s) => s.name ?? s.id).join(", ");
  return `Not yet: ${names} ${state.waiting.length === 1 ? "has" : "have"} not answered the builders' guesses. Use room with wait=30, then conclude.`;
}

// ── what each person is told ────────────────────────────────────────────────────────────────────

const STATE_WORDS = { looking: "still on the website", table: "at the table", gone: "has left" };

function speakerLabel(line) {
  if (line.from === MODERATOR_ID) return "The moderator";
  if (line.from === HOST_ID) return "The host";
  if (line.from === ROOM_ID) return "The room";
  return line.name;
}

/** One line as a person hears it. */
export function sayLine(line) {
  const who = speakerLabel(line);
  const to = line.to ? ` (to ${line.to})` : "";
  switch (line.kind) {
    case "journal":
      return `${who} wrote in her diary${line.noteKind ? ` (${line.noteKind})` : ""}: "${line.text}"`;
    case "say":
      return `${who}${to} said: "${line.text}"`;
    case "vote":
      return line.ref
        ? `${who} voted for a problem already on the table${line.why ? `: "${line.why}"` : "."}`
        : `${who} put a problem on the table: "${line.text}"${line.why ? ` (why: "${line.why}")` : ""}`;
    case "left-page":
      return `${who} has left the website and come to the table${line.text ? `: "${line.text}"` : "."}`;
    case "left":
      return `${who} has gone home.`;
    case "joined":
      return `${who} sat down and opened the website.`;
    case "ask":
      return `${who}${to} asks: "${line.text}"`;
    case "propose":
      return `${who} put a problem on the table: "${line.text}"`;
    case "gather":
      return `${who} is calling everyone to the table${line.text ? `: "${line.text}"` : "."}`;
    case "verdict":
      return `${who} has agreed on the biggest problem: "${line.text}"`;
    default:
      return `${who}: "${line.text}"`;
  }
}

/** The problems on the table, as a numbered list with who backs each one. */
export function tableLines(counted) {
  if (!counted.length) return ["Nobody has put a problem on the table yet."];
  return counted.map((p) => {
    const backers = p.backers.length ? `backed by ${p.backers.map((b) => b.name).join(", ")}` : "nobody backs it yet";
    return `  ${p.n}. "${p.text}" (put there by ${p.byName}; ${backers})`;
  });
}

/** Who is where, in one line. */
export function aroundTheTable(seats, me = null) {
  return seats
    .filter((s) => s.id !== me)
    .map((s) => `${s.name} (${STATE_WORDS[s.state]}${s.vote ? ", has voted" : ""})`)
    .join("; ");
}

/**
 * A Sue's `room` move: who is around the table, the moderator's latest question, the problems on
 * the table, then everything she has not heard yet. Marks nothing: the caller records what she heard.
 */
export function renderRoomForSue({ runDir, me, news, lines = readLines(runDir), roster = readRoster(runDir) }) {
  const seats = seatsOf(lines, roster);
  const mine = seats.find((s) => s.id === me);
  const phase = phaseOf(runDir, { lines, roster });
  const verdict = readVerdict(runDir);
  const out = [];
  out.push(`Around the table: ${aroundTheTable(seats, me) || "nobody else yet"}.`);
  if (verdict) {
    out.push(`The room has agreed. The biggest problem: "${verdict.problem}". You may give your exit interview now.`);
  } else {
    const lastAsk = [...lines].reverse().find((l) => l.kind === "ask" || l.kind === "gather");
    if (lastAsk) out.push(`The moderator's latest question: "${lastAsk.text}"`);
    if (phase !== "visiting" || mine?.state !== "looking") {
      out.push("The problems on the table:");
      out.push(...tableLines(tally(lines, roster)));
    }
  }
  if (news.length) {
    out.push(`Since you last listened (${news.length}):`);
    for (const line of news) out.push(`- ${sayLine(line)}`);
  } else out.push("Nothing new has been said since you last listened.");
  if (!verdict && mine?.state === "table") {
    out.push(
      mine.vote
        ? "You have voted. Stay at the table: say what you think of what the others say (say), change your vote if they convince you (vote), or listen for more (room with wait=30)."
        : "You have not voted yet: use vote to back a problem already on the table by its number, or to put down the one that bothered you most, in your own words.",
    );
  }
  return out.join("\n");
}

/** The moderator's `room`: the same, from outside the table, plus who has not voted. */
export function renderRoomForModerator({ runDir, news, lines = readLines(runDir), roster = readRoster(runDir) }) {
  const seats = seatsOf(lines, roster);
  const phase = phaseOf(runDir, { lines, roster });
  const verdict = readVerdict(runDir);
  const out = [];
  out.push(`Phase: ${phase === "visiting" ? "they are still on the website" : phase === "table" ? "at the table" : "closed"}.`);
  out.push(`Around the table: ${aroundTheTable(seats) || "nobody"}.`);
  if (verdict) out.push(`The room agreed: "${verdict.problem}" (decided by ${verdict.decidedBy}). You are finished.`);
  else {
    out.push("The problems on the table:");
    out.push(...tableLines(tally(lines, roster)));
    const waiting = seats.filter((s) => s.state !== "gone" && !s.vote).map((s) => s.name);
    if (phase === "table" && waiting.length) out.push(`Not voted yet: ${waiting.join(", ")}.`);
  }
  if (news.length) {
    out.push(`Since you last listened (${news.length}):`);
    for (const line of news) out.push(`- ${sayLine(line)}`);
  } else out.push("Nothing new has been said since you last listened.");
  return out.join("\n");
}

/**
 * The words a focus-group Sue gets on top of her errand, so she knows who else is there and what
 * the room is for. She is told who the others are by name, never what they think.
 */
export function focusGroupBrief({ me, roster }) {
  const others = roster.filter((s) => s.id !== me).map((s) => s.name);
  return [
    "## You are in a focus group",
    "",
    `You are one of ${roster.length} people in a focus group, all trying this same website at the same time${others.length ? `: ${others.join(", ")}` : ""}. You can hear what the others write in their diaries and say, and they hear yours. Your hands have three moves for it: \`room\` (hear what the others said; add wait=30 to wait for someone to speak), \`say\` (talk to them, or to one of them with to=<name>) and \`vote\` (the single biggest problem, by its number on the table or in your own words).`,
    "",
    "First use the website the way you would on your own; talk to the others when you want to. When you are finished with the website (done or give_up), you join the others at the table. A moderator will ask what felt off. Say what you really think, disagree when you disagree, and help the room agree on ONE biggest problem: the one thing that most made this website feel wrong, even if it looked fine. Your exit interview comes after the room agrees.",
  ].join("\n");
}

/**
 * The moderator's whole job, as its first message. The moderator is an AI of whichever tier drives
 * the Sues (the calling chat's own agent on `chat`, a key-pool CLI otherwise). It never sees the
 * website: like a real moderator it runs the room, it does not answer for it.
 */
export function moderatorBrief({ meta, roster }) {
  const suggestions = meta?.suggestions ?? [];
  const previous = meta?.previous ?? null;
  const lines = [
    "# You are the moderator of a focus group",
    "",
    `${roster.length} people (${roster.map((s) => s.name).join(", ")}) are trying this website: ${meta?.url ?? "(unknown)"}.`,
    `Why they came: ${meta?.intent ?? "(not given)"}`,
    "",
    "Your job: get them to agree on the SINGLE BIGGEST problem with this website, the one thing that most made it feel off, in their words. Not a list: one problem somebody could go and fix.",
    "",
    "How a good moderator runs the room:",
    "- While they are still on the website, mostly listen (`room` with wait=30). You may answer somebody who talks to you.",
    "- Once they are at the table (`room` tells you), ask open questions first (`ask`): what felt off, where they got stuck, what they expected. Do not lead them.",
    // A game's many small cuts (tiny print, missed buttons, a cramped panel) each lose a vote to one
    // gameplay complaint unless each is named first (SUE post-mortem, 2026-09-26).
    ...(meta?.judges
      ? [
          "- Then, before anyone votes, go round the table screen by screen: ask each of them by name (`ask` with to=<name>) for the worst screen they saw and one thing on it (too small to read, too small for a thumb, cut off, covered, crowded, cheap-looking), and `propose` each one in their words, so a pile of small things on the screens is on the table beside the one about how it plays.",
        ]
      : []),
    '- Then test ideas (`ask`): "Some of you said X. Does anyone disagree?" Push them from vague to specific: which page, which button, which words.',
    "- Get everyone to vote (`vote` is theirs; you can `propose` a problem in words the room already used, and they vote for it by number).",
    "- When most of them back one problem, `conclude` with its number and a two-sentence summary of why they agreed. Do not conclude on your own opinion.",
    "- If somebody is still on the website long after the others, you may `gather` everyone to the table.",
  ];
  if (suggestions.length) {
    lines.push(
      "",
      'The people who built this website have their own guesses. Put each one to the room AFTER the room has said what it thinks on its own, as a question ("We think the problem might be ... What do you think?") with guesses=true on that ask, and let the room reject it if it does not agree. The room stays open until each of them has answered it:',
      ...suggestions.map((s) => `- ${s}`),
    );
  }
  if (previous?.problem) {
    lines.push(
      "",
      `The LAST focus group on this page (${previous.at ? previous.at.slice(0, 10) : "earlier"}) agreed the biggest problem was: "${previous.problem}". It may have been fixed since. Do not tell this room. After they have said what they think, find out whether anything like it still bothered them, and pass lastProblemStillThere (yes, no or unclear) when you conclude.`,
    );
  }
  lines.push(
    "",
    "Your hands: room (wait=30 to wait for talk), ask (text, optionally to=<name>), propose (problem), gather (text), conclude (proposal=<number> or problem=<words>, summary, lastProblemStillThere). When conclude thanks you, you are finished.",
  );
  return lines.join("\n");
}

// ── the fix loop: every verdict a workspace has had ─────────────────────────────────────────────

export const FOCUS_GROUPS_FILE = "focus-groups.jsonl";

/** `.sue/focus-groups.jsonl`: one line per closed focus group, the next group's moderator reads the last. */
export function focusGroupsFile(store) {
  return path.join(store, FOCUS_GROUPS_FILE);
}

export function recordVerdict(store, { runId, pageKey, url, build = null, verdict }) {
  if (!verdict) return null;
  const row = {
    runId,
    page: pageKey,
    url,
    build: build?.commit ?? build ?? null,
    at: verdict.at,
    problem: verdict.problem,
    decidedBy: verdict.decidedBy,
    agreedBy: verdict.agreedBy.length,
    size: verdict.size,
    lastProblemStillThere: verdict.lastProblemStillThere,
  };
  fs.mkdirSync(store, { recursive: true });
  const file = focusGroupsFile(store);
  // Upserted by run id, so booking a run twice never adds a second row for it.
  const kept = readVerdicts(store).filter((r) => r.runId !== runId);
  fs.writeFileSync(file, [...kept, row].map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  return row;
}

export function readVerdicts(store) {
  let raw;
  try {
    raw = fs.readFileSync(focusGroupsFile(store), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** The last verdict a focus group reached on this page, or null. */
export function lastVerdictFor(store, pageKey) {
  return (
    readVerdicts(store)
      .filter((r) => r.page === pageKey)
      .sort((a, b) => (a.at < b.at ? -1 : 1))
      .at(-1) ?? null
  );
}

/** A room's whole public picture, for the Sue Manager, Boardroom's Focus Group and `sue room`. */
export function roomSnapshot(runDir) {
  if (!isFocusGroup(runDir)) return null;
  const lines = readLines(runDir);
  const roster = readRoster(runDir);
  return {
    meta: readMeta(runDir),
    phase: phaseOf(runDir, { lines, roster }),
    seats: seatsOf(lines, roster).map(({ id, name, persona, device, state, vote }) => ({
      id,
      name,
      persona,
      device: device ?? null,
      state,
      voted: Boolean(vote),
    })),
    table: tally(lines, roster).map(({ n, text, byName, backers, why }) => ({
      n,
      text,
      by: byName,
      why,
      backers: backers.map((b) => b.name),
    })),
    lines: lines.map(({ id, at, from, name, kind, text, to, ref, why, noteKind }) => ({
      id,
      at,
      from,
      name,
      kind,
      text,
      ...(to ? { to } : {}),
      ...(ref ? { ref } : {}),
      ...(why ? { why } : {}),
      ...(noteKind ? { noteKind } : {}),
    })),
    verdict: readVerdict(runDir),
  };
}
