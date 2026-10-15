/**
 * focus-hands - a focus-group Sue's hands at the table: `room` (hear the others), `say` (talk to
 * them) and `vote` (the single biggest problem), plus what her body does on her behalf so the room
 * hears her and she hears the room between her moves on the website.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-23): "the Sues can see and talk to each other ... you can literally hear
 * them journaling. They hear each other's journal, they hear each other's points ... then they all
 * agree and they give you literally what their biggest problem is." A focus-group Sue is still a whole
 * Sue (her own browser, account and rails in body.mjs); this unit is only what the table adds, and it
 * is browser-free so a spec drives every handler against a temp run dir.
 *
 * What body.mjs calls, and only when her `sue.json` says `focusGroup: true`:
 *   room / say / vote  her three moves at the table. They need no page, so they never open or reopen
 *                      a browser, stay open after done or give_up and after her patience is gone, and
 *                      do not count toward the journal nudge.
 *   joined()           her first move: she sat down and opened the website.
 *   heardNote()        every diary line she writes, heard by the room as she writes it.
 *   leftPage()         done or give_up: she has left the website and come to the table.
 *   left()             her exit interview is written: she has gone home.
 *   exitGate()         null when she may give her exit interview, else the words that send her back.
 *   overheard()        on a page move's answer: the newest things the others said since, in brief.
 *   gatherNotice()     once: the moderator called the room in while she is still on the website.
 *
 * Every line goes through lib/room.mjs (one file per speaker, so her body is the only writer of hers);
 * what she has heard lives in her own folder (`HEARD_FILE`), so a restarted body never hears a line
 * twice. NO AI HERE: the words are hers, the others' and the moderator's; this unit files and tells.
 *
 * DEPENDED ON BY: body.mjs. Spec: tests/focus-hands.spec.mjs.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import {
  BIGGEST_PROBLEM_KEY,
  BIGGEST_PROBLEM_QUESTION,
  HEARD_FILE,
  ROOM_WAIT_MAX_SECONDS,
  TABLE_MAX_MS,
  appendLine,
  proposalsOf,
  readHeard,
  readLines,
  readRoster,
  readVerdict,
  renderRoomForSue,
  sayLine,
  unheard,
  waitForNews,
  writeHeard,
} from "./room.mjs";

/** The moves only a focus-group Sue is served. None of them needs a page. */
export const ROOM_MOVES = new Set(["room", "say", "vote"]);

/** Her answer to done or give_up in a focus group: the website is behind her, the table is not. */
export const FOCUS_LEFT_PAGE =
  "You have left the website. Now join the others at the table: use room to hear them, say to talk, and vote for the single biggest problem. Your exit interview comes after the room agrees.";

/** Her last few moves at the table, when the turn budget is nearly spent: her interview must not be lost. */
export const FOCUS_OUT_OF_TIME =
  "You are nearly out of time. Vote for the single biggest problem now if you have not, then call exit_interview and answer every question.";

/** How many of the others' lines a page move's answer quotes, and how much of each. */
export const OVERHEARD_QUOTES = 2;
export const OVERHEARD_CLIP = 200;

const told = (value) => ({ content: [{ type: "text", text: String(value) }] });
const refused = (value) => ({ content: [{ type: "text", text: String(value) }], isError: true });
/** A tool's input: an object of these properties, extra keys tolerated (a brain adds them), as body.mjs. */
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });

function clip(text, max) {
  const s = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * Her name at the table when the roster has not named her: her persona's display name and her Sue
 * number ("Grandma Sue 1117"), the same words the cannon writes into `roster.json`.
 */
export function seatNameFor({ displayName, sueId }) {
  const number = String(sueId ?? "").match(/^sue-(\d+)/)?.[1];
  return [String(displayName ?? "").trim(), number].filter(Boolean).join(" ") || String(sueId ?? "");
}

/**
 * A scenario's own exit-interview questions with the focus group's one on top (merged, never
 * replacing), so body.mjs's tool table and `shapeInterview`'s extras path both ask and keep it.
 */
export function withBiggestProblem(interview) {
  const own = interview && typeof interview === "object" && !Array.isArray(interview) ? interview : {};
  return { ...own, [BIGGEST_PROBLEM_KEY]: BIGGEST_PROBLEM_QUESTION };
}

/** The three moves, `[name, description, inputSchema]`, in the order body.mjs serves them. */
export function focusToolSpecs() {
  return [
    [
      "room",
      `Hear the others in your focus group: who is where, the problems on the table, and everything said since you last listened. wait: seconds to wait for someone to speak (at most ${ROOM_WAIT_MAX_SECONDS}).`,
      obj({ wait: { type: "number" } }),
    ],
    [
      "say",
      "Talk to the others in your focus group. to: one person's name, or leave it out to speak to everyone.",
      obj({ text: { type: "string" }, to: { type: "string" } }, ["text"]),
    ],
    [
      "vote",
      "Vote for the single biggest problem with this website: proposal is its number on the table (room shows them), or problem is a new one in your own words. Say why. Your latest vote is the one that counts.",
      obj({ proposal: { type: "number" }, problem: { type: "string" }, why: { type: "string" } }),
    ],
  ];
}

/**
 * Her hands at the table, over one run dir. `now` and `sleep` are injectable so a spec moves the
 * clock by hand and `room wait=30` never waits in a test.
 */
/**
 * Whether a Sue ever looked at the page: a `look` in her own trace. A Sue who never did has only what the others said,
 * which is hearsay: in a Postal Buddy focus group (2026-10-01, run 20250101-000000-0000) two Sues whose first look said
 * they had already left voted for the room's problem and wrote 1-star exits from the others' words, and the moderator
 * reported "2 of 3 agreed".
 */
export function sawThePage(sueDir) {
  let text;
  try {
    text = readFileSync(path.join(sueDir, "trace.jsonl"), "utf8");
  } catch {
    return false;
  }
  return text.split("\n").some((l) => {
    try {
      const t = JSON.parse(l);
      return t?.tool === "look" && typeof (t.pageText ?? t.result) === "string" && (t.pageText ?? t.result).trim() !== "";
    } catch {
      return false;
    }
  });
}

export function createFocusHands({ runDir, sueId, sueDir, fallbackName = null, now = () => new Date(), sleep } = {}) {
  const me = String(sueId);
  const heardFile = path.join(sueDir, HEARD_FILE);
  const at = () => {
    const value = now();
    return value instanceof Date ? value : new Date(value);
  };
  let seatName = null;
  const name = () => {
    if (seatName) return seatName;
    const seat = readRoster(runDir).find((s) => s.id === me);
    if (seat?.name) seatName = seat.name;
    return seatName ?? fallbackName ?? me;
  };
  const put = (line) => appendLine(runDir, me, { name: name(), ...line }, at());
  /** Lines she was told about in a page move's answer, quoted or counted: never told about twice. */
  const mentioned = new Set();
  let sat = false;
  let wentToTable = false;
  let gathered = false;

  function hear(lines) {
    const heard = readHeard(heardFile);
    for (const line of lines) heard.add(line.id);
    writeHeard(heardFile, heard);
  }

  return {
    async room({ wait } = {}) {
      const heard = readHeard(heardFile);
      // Once the room has agreed there is nothing left to wait for: she is told so at once.
      const seconds = readVerdict(runDir) ? 0 : Math.min(Math.max(Number(wait) || 0, 0), ROOM_WAIT_MAX_SECONDS);
      const news = seconds > 0 ? await waitForNews(runDir, { heard, listener: me, seconds, sleep }) : unheard(readLines(runDir), heard, me);
      hear(news);
      return told(renderRoomForSue({ runDir, me, news }));
    },

    async say({ text: words, to } = {}) {
      const said = String(words ?? "").trim();
      if (!said) return refused("Say what you want to tell them.");
      const whom = String(to ?? "").trim();
      put({ kind: "say", text: said, ...(whom ? { to: whom } : {}) });
      return told(
        whom
          ? `You said it to ${whom}. Use room with wait=30 to hear the answer.`
          : "You said it to the table. Use room with wait=30 to hear what they answer.",
      );
    },

    async vote({ proposal, problem, why } = {}) {
      // Only a Sue who saw the website votes on its biggest problem; the others' words are hearsay (sawThePage).
      if (!sawThePage(sueDir))
        return refused(
          "You never saw the website, so you cannot vote on its biggest problem: what the others said is not your own look. Look at it yourself first, or give your exit interview; it will be kept apart as not seen.",
        );
      const table = proposalsOf(readLines(runDir));
      const typed = String(problem ?? "").trim();
      const picked = String(proposal ?? "").trim();
      // A number written where her words go ("1", "#1", "number 1") means that problem: in Raise Buddy re-visit 25
      // (run 20261012-165340-3db6) three Sues who all meant number 1 put "1" down five times as a problem of its own.
      const numbered = picked ? null : /^(?:(?:number|no\.?|problem)\s*)?#?\s*(\d+)\.?$/i.exec(typed);
      const n = picked ? Number(picked) : numbered ? Number(numbered[1]) : NaN;
      // A brain that writes its words where the number goes still means a problem of her own.
      const words = numbered ? "" : typed || (picked && !Number.isInteger(n) ? picked : "");
      // Her words, the same as a problem already on the table, back that problem rather than put a copy down: a copy
      // splits the vote, and that room's tally read its unanimous three as two to one.
      const same = (s) => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const copied = words ? table.find((p) => same(p.text) === same(words)) : undefined;
      const reason = String(why ?? "").trim();
      const because = reason ? { why: reason } : {};
      // A vote after the verdict still counts: her exit interview waits on her vote, never on a lock.
      const verdict = readVerdict(runDir);
      const after = verdict
        ? ` The room has already agreed: "${verdict.problem}". You may give your exit interview now.`
        : " Your latest vote is the one that counts: change it if the others convince you.";
      if (copied) {
        put({ kind: "vote", text: copied.text, ref: copied.id, ...because });
        return told(`Those are the words of number ${copied.n}, so you voted for number ${copied.n}: "${copied.text}".${after}`);
      }
      if (Number.isInteger(n)) {
        const backed = table.find((p) => p.n === n);
        if (!backed)
          return refused(
            table.length
              ? `There is no problem number ${n} on the table (there ${table.length === 1 ? "is 1" : `are ${table.length}`}). Use room to see them, or put yours down in your own words (problem).`
              : `Nobody has put a problem on the table yet, so there is no number ${n}. Put yours down in your own words (problem).`,
          );
        put({ kind: "vote", text: backed.text, ref: backed.id, ...because });
        return told(`You voted for number ${n}: "${backed.text}".${after}`);
      }
      if (words) {
        const line = put({ kind: "vote", text: words, ...because });
        const placed = proposalsOf(readLines(runDir)).find((p) => p.id === line.id);
        return told(
          `Your problem is on the table as number ${placed?.n ?? table.length + 1}: "${line.text}". The others can back it by that number.${after}`,
        );
      }
      return refused(
        "Vote for the single biggest problem: its number on the table (proposal), or a new one in your own words (problem), and why.",
      );
    },

    joined() {
      if (sat) return;
      sat = true;
      // A body that restarts mid-visit is the same Sue: she sat down once.
      if (readLines(runDir).some((l) => l.from === me && l.kind === "joined")) return;
      put({ kind: "joined", text: "" });
    },

    heardNote(kind, text, url) {
      put({ kind: "journal", noteKind: String(kind ?? "thought"), text: String(text ?? ""), ...(url ? { url } : {}) });
    },

    leftPage(kind, words) {
      if (wentToTable) return;
      wentToTable = true;
      put({ kind: "left-page", noteKind: String(kind ?? ""), text: String(words ?? "") });
    },

    left() {
      put({ kind: "left", text: "" });
    },

    /** Whether she looked at the page herself (sawThePage). */
    sawPage() {
      return sawThePage(sueDir);
    },

    /**
     * Whether she may give her exit interview: she has voted, and the room has agreed or she has sat
     * at the table `TABLE_MAX_MS` since she left the website. `null` means yes; else what to do first.
     */
    exitGate() {
      // A Sue who never saw the page leaves without a vote; her exit is kept apart as not seen (body.mjs).
      if (!sawThePage(sueDir)) return null;
      const lines = readLines(runDir);
      const hers = lines.filter((l) => l.from === me);
      const voted = hers.some((l) => l.kind === "vote");
      const verdict = readVerdict(runDir);
      const fromPage = hers.find((l) => l.kind === "left-page");
      if (voted && verdict) return null;
      if (!fromPage && !verdict)
        return "You are still on the website. Finish first: call done or give_up, then join the others at the table and vote for the single biggest problem. Your exit interview comes after the room agrees.";
      if (!voted)
        return verdict
          ? `Before your exit interview, vote: the room agreed the biggest problem is "${verdict.problem}". Back it by its number on the table, or put down the one that bothered you most in your own words (vote).`
          : "Before your exit interview, vote for the single biggest problem: back one already on the table by its number, or put down yours in your own words (vote). Use room to see the table.";
      if (fromPage && at().getTime() - Date.parse(fromPage.at) >= TABLE_MAX_MS) return null;
      return "The room has not agreed yet. Stay at the table: use room with wait=30 to hear the others, say what you think, and change your vote if they convince you. Your exit interview comes after the room agrees.";
    },

    /**
     * What the others said since her last move, for a page move's answer: the newest
     * `OVERHEARD_QUOTES` lines, each clipped, and how many more are waiting in the room. A line quoted
     * here counts as heard; a line only counted is never quoted later (no old news dripped out), and
     * `room` still hears it in full.
     */
    overheard() {
      const heard = readHeard(heardFile);
      const news = unheard(readLines(runDir), heard, me);
      const fresh = news.filter((l) => !mentioned.has(l.id));
      if (!fresh.length) return "";
      const quoted = fresh.slice(-OVERHEARD_QUOTES);
      for (const line of fresh) mentioned.add(line.id);
      hear(quoted);
      const more = news.length - quoted.length;
      return [
        "Meanwhile, in your focus group:",
        ...quoted.map(
          (l) => `- ${sayLine({ ...l, text: clip(l.text, OVERHEARD_CLIP), ...(l.why ? { why: clip(l.why, OVERHEARD_CLIP / 2) } : {}) })}`,
        ),
        ...(more > 0 ? [`(${more} more: use room to hear everything)`] : []),
      ].join("\n");
    },

    /** Once, while she is still on the website: the moderator has called everyone to the table. */
    gatherNotice() {
      if (gathered) return "";
      const lines = readLines(runDir);
      const call = [...lines].reverse().find((l) => l.kind === "gather");
      if (!call) return "";
      if (lines.some((l) => l.from === me && (l.kind === "left-page" || l.kind === "left"))) return "";
      gathered = true;
      mentioned.add(call.id);
      hear([call]);
      return `${sayLine(call)} Finish with the website now: call done or give_up (say what you did, or why you stopped), then come to the table.`;
    },
  };
}
