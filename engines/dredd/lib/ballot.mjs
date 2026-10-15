// dredd/lib/ballot.mjs - the vote that decides. After the room has argued, every seat casts a ballot in silence:
// a score, the one fix, and the evidence it rests on, quoted from the material. The verdict is then arithmetic,
// not the secretary's impression of a debate (the Chair, 2026-09-22: "more black and white ... a way to decide
// who's right"). Three rules, all here and all pure:
//
//   1. A ballot counts only when its evidence quote is really in the material (`groundedIn`). A seat that
//      scores from a measurement it did not read, or a page it did not see, is named and does not count. Nor
//      does a ballot whose fix reverses an earlier hearing's fix on the same page without saying why that advice
//      was wrong (`earlierReversal`, lib/earlier.mjs).
//   2. The verdict is the lower median of the grounded scores, and it takes two (`MIN_BALLOTS`): a sitting with
//      fewer valid ballots is NOT CONCLUSIVE and has no verdict. Its scores are still printed, void ones included,
//      so the number is not lost; it can never end a hearing happy (lib/resolve.mjs roomHappy). The founders page's
//      final sitting and the home page's were each "scored" by one ballot after the Copy Editor's was voided
//      (2026-09-24). The spread is named, and a spread of four or more is a SPLIT room, said as such - never
//      averaged into a number that nobody in the room gave.
//   3. The ladder caps the number (`ladderCeiling`): a page whose visitors never came back cannot score above
//      five whatever the critics felt, a page that did not load cannot score above two. The cap and its rung
//      are on the verdict line.
//
// The fix that wins is the one the most ballots named; the secretary clusters the wording and reports the count,
// and the ballots themselves are in the minutes so the count can be checked.
import { earlierFixes } from "./earlier.mjs";

/** The seat's silent vote, structured. */
export const BALLOT_SCHEMA = {
  type: "object",
  properties: {
    score: {
      type: "integer",
      description: "Your score for the thing complained about, 1 (unusable) to 10 (ship it as is). A proposal sitting scores the PROPOSAL.",
    },
    fix_first: { type: "string", description: "The one change you would make before anything else, in one sentence." },
    evidence: {
      type: "string",
      description:
        "The one piece of evidence in the material that decides your score, QUOTED VERBATIM: up to twenty-five words copied exactly from the evidence, the page's text, the visitors' words, or the house laws. Not a paraphrase, not your own words. A quote that is not in the material voids the ballot.",
    },
  },
  required: ["score", "fix_first", "evidence"],
};

/** The earlier fixes a ballot answers to, each quoted, newest first: `"A"; "B"`. */
const quotedFixes = (earlier) =>
  earlierFixes(earlier)
    .map((f) => `"${f}"`)
    .join("; ");

/**
 * The ballot a seat fills in: BALLOT_SCHEMA, and when this page was heard before (`earlier`, lib/earlier.mjs
 * earlierHearings), two more fields that make the seat face those hearings' fixes - whether its own fix reverses one,
 * and if so why that advice was wrong. Sitting B on the founders page asked for one unified button label after sitting
 * A had asked for the repeated one to go (2026-09-24); neither field existed and nobody had to say which advice was wrong.
 */
export function ballotSchema({ earlier = null } = {}) {
  if (!earlierFixes(earlier).length) return BALLOT_SCHEMA;
  return {
    ...BALLOT_SCHEMA,
    properties: {
      ...BALLOT_SCHEMA.properties,
      reverses_earlier: {
        type: "boolean",
        description: `The earlier hearings of this page asked, newest first: ${quotedFixes(earlier)}. True when your fix_first asks for the opposite of one of them, undoes a change that did what one asked, or your score marks the page down for having done it. False otherwise.`,
      },
      earlier_was_wrong: {
        type: "string",
        description:
          "Only when reverses_earlier is true: one sentence on why that earlier advice was wrong. Empty otherwise. A reversal with no reason voids the ballot.",
      },
    },
    required: [...BALLOT_SCHEMA.required, "reverses_earlier", "earlier_was_wrong"],
  };
}

/** Fewer words than this is not a reason ("it was wrong"). */
const MIN_REASON_WORDS = 5;

/**
 * Whether a cast ballot reverses an earlier hearing's fix, by the seat's own answer (ballotSchema), and whether it said
 * why that advice was wrong. Pure. null when there was no earlier fix or the seat says its fix reverses none; else
 * { explained, why }. A ballot with { explained: false } does not count (boardroom.mjs voids it, `voidWhy: "reversal"`).
 */
export function earlierReversal(data, earlier) {
  if (!earlierFixes(earlier).length || !data) return null;
  const reverses = data.reverses_earlier === true || String(data.reverses_earlier).trim().toLowerCase() === "true";
  if (!reverses) return null;
  const why = String(data.earlier_was_wrong || "").trim();
  return { explained: why.split(/\s+/).filter(Boolean).length >= MIN_REASON_WORDS, why };
}

export function ballotInstruction(member, memberName, { room = null, earlier = null } = {}) {
  // A mind seat (the minds room) is a verified knowledge base: on a bare advice question the only evidence is the
  // question and its own playbook, and the first live minds sittings voided every ballot for quoting the meeting.
  const sources =
    room === "minds"
      ? "the question's own words, or a line of YOUR playbook entries in the material, the principle that decides it"
      : "the evidence logs, the page's own text, what the visitors said, or the house laws";
  const before = earlierFixes(earlier).length
    ? ` This page was heard before, and those hearings' fixes first were, newest first: ${quotedFixes(earlier)}. The page may have been changed since to do exactly that. A change that does what an earlier fix asked is not a defect: do not score it down and do not ask for its opposite unless you say why the earlier advice was wrong (reverses_earlier, earlier_was_wrong). A reversal with no reason is void.`
    : "";
  return `You are ${member.name}, one of the advisers at ${memberName}'s table. The meeting is over. Cast your ballot in silence: a score from 1 to 10, the one fix you would make first, and the single piece of evidence that decides your score, copied word for word from the material (${sources}). Your fix answers the question this table was asked; a house law can limit a fix but is never the fix itself (a design board asked why students stop voted "consolidate duplicated UI elements into shared components", 2026-10-01). Do not argue, do not address anyone, do not repeat the meeting: a line said in the meeting is never evidence. A ballot whose quote is not in the material is void, so copy, never paraphrase. When the evidence in front of you is clean and you can point to nothing wrong, score it high and quote the line that shows it clean.${before}`;
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * Whether a ballot's quote is really in the material. Both are normalised (case, punctuation, whitespace); a quote
 * of three to seven words must appear whole, a longer one must carry a run of eight consecutive words that appears -
 * so a trimmed start or a dropped closing word does not void an honest quote, and a paraphrase does. Under three
 * words is not a quote of anything ("the", "HTTP 200") and never counts.
 */
export function groundedIn(quote, material) {
  const q = norm(quote);
  const m = ` ${norm(material)} `;
  if (!q) return false;
  const words = q.split(" ");
  if (words.length < 3) return false;
  if (words.length <= 7) return m.includes(` ${q} `);
  for (let i = 0; i + 8 <= words.length; i += 1) if (m.includes(` ${words.slice(i, i + 8).join(" ")} `)) return true;
  return false;
}

/** A double-quoted span of three or more words, straight or curly quotes, exactly as written (the quote marks
 *  included, so it can be matched back into the text it came from). Pure. `inner` is the words with the marks off,
 *  for grounding; `quote` is the marked span, for finding and marking. */
const QUOTE_RX = /["“]([^"“”]{3,}?)["”]/g;
export function quotedSpans(text) {
  const out = [];
  for (const m of String(text || "").matchAll(QUOTE_RX)) {
    const inner = m[1].trim();
    if (inner.split(/\s+/).filter(Boolean).length >= 3) out.push({ quote: m[0], inner });
  }
  return out;
}

/**
 * The quoted spans of a meeting turn (or a drafter's why/note) that are grounded in neither `material` nor an
 * earlier line really said (`priorLines`) - pure, over the same rule a ballot's own quote is judged by (`groundedIn`).
 * A seat quoting what a fellow seat just said in THIS meeting is honest even though the meeting is never evidence
 * FOR A BALLOT (lib/seats.mjs ballotEvidence excludes it): "did anyone say this" and "does this decide a score" are
 * different questions. Two seats fabricating a measurement or a visitor line and having it feed round two, the
 * secretary, and through the proposal the drafter, is the laundering path this closes (the MiroFish review,
 * 2026-09-23). Returns the unfounded quotes, marks included, deduplicated, in the order they were said.
 */
export function unfoundedQuotes(text, material, priorLines = []) {
  const combined = [material, ...priorLines].filter(Boolean).join("\n\n");
  const seen = new Set();
  const out = [];
  for (const { quote, inner } of quotedSpans(text)) {
    if (seen.has(quote) || groundedIn(inner, combined)) continue;
    seen.add(quote);
    out.push(quote);
  }
  return out;
}

/** Marks, never strips (the Chair's rule for the void ballot carries over: a stamp NAMES a problem, it does not erase
 *  the record of it): each unfounded quote gets " [not in the evidence]" right after its first appearance. */
export function markUnfoundedQuotes(text, unfounded) {
  let marked = String(text || "");
  for (const q of unfounded || []) if (marked.includes(q)) marked = marked.replace(q, `${q} [not in the evidence]`);
  return marked;
}

/** The highest score the measured rungs allow, and the rung that set it. */
export function ladderCeiling(ladder) {
  const state = (id) => (Array.isArray(ladder) ? ladder.find((r) => r.id === id)?.state : undefined);
  if (state("broken") === "fail") return { ceiling: 2, by: "rung 1 failed: the page is broken" };
  if (state("understood") === "fail") return { ceiling: 5, by: "rung 4 failed: people did not understand it" };
  if (state("sense") === "fail") return { ceiling: 6, by: "rung 3 failed: the design does not make sense" };
  if (state("copy") === "fail") return { ceiling: 6, by: "rung 5 failed: the copy is not up to snuff" };
  if (state("broken") === "wobbly") return { ceiling: 8, by: "rung 1 wobbly: the page has errors" };
  return { ceiling: 10, by: null };
}

/** A ballot's score on the 1-10 scale, or null when it carries no number. Only a real number or a plain numeric string
 *  is a score: Number(null), Number("") and Number(false) are all 0, and a flaky call's missing score was clamping to a
 *  counted 1/10 that dragged the median down and marked the room SPLIT (Opus 5.5 review, 2026-09-22). A real 0 is a
 *  vote and clamps to 1. */
export function clampScore(s) {
  const numeric = (typeof s === "number" && Number.isFinite(s)) || (typeof s === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(s));
  return numeric ? Math.min(10, Math.max(1, Math.round(Number(s)))) : null;
}

/** Whether a ballot's `source` (lib/seats.mjs groundedWhere) is a real fact about the page - a log an instrument
 *  actually gathered, or the proposal on the table - as against a law, the complaint's own words, or a failed
 *  instrument's log (principle, not evidence: the round trips on it, it never grounds a taste call). */
function isEvidenceSource(source) {
  return source === "proposal" || (typeof source === "string" && source.startsWith("evidence:"));
}

/** A ballot's source, folded into the handful of words the verdict line names: "evidence", "house laws", "the
 *  complaint", "the proposal", "instrument failure", or the label itself when it names none of those. */
function sourceCategory(source) {
  if (source.startsWith("evidence:")) return "evidence";
  if (source.startsWith("failure:")) return "instrument failure";
  if (source === "house") return "house laws";
  if (source === "complaint") return "the complaint";
  if (source === "proposal") return "the proposal";
  if (source === "earlier") return "the earlier hearing";
  return source;
}

/** The fewest valid (grounded) ballots a verdict takes. One seat's score is that seat's opinion, not the room's. */
export const MIN_BALLOTS = 2;

/**
 * The tally. `ballots` are { seat, score, fix_first, evidence, grounded, failed?, source? }; the ladder is optional
 * (a bare room has none). `hasEvidence` says whether this docket carries any real evidence log at all (lib/seats.mjs
 * roomMaterial) - with none, a room that grounded itself in the house laws or the complaint had nothing else to
 * quote, so it is not `principleOnly`. Returns the verdict and everything a reader needs to check it.
 *
 * `conclusive` is false when fewer than MIN_BALLOTS ballots are valid: the verdict is then null, and `scores` still
 * lists what was cast (the valid one, or the void ones when none is valid) so a reader sees the number nobody may use.
 * A ballot voided for reversing the earlier hearing's fix without a reason (`voidWhy: "reversal"`) is in `ungrounded`
 * like any void ballot and named apart in `reversed`.
 */
export function tallyBallots(ballots, { ladder = null, hasEvidence = false } = {}) {
  const cast = (ballots || []).filter((b) => !b.failed && clampScore(b.score) !== null).map((b) => ({ ...b, score: clampScore(b.score) }));
  const grounded = cast.filter((b) => b.grounded);
  const ungrounded = cast.filter((b) => !b.grounded).map((b) => b.seat);
  const reversed = cast.filter((b) => !b.grounded && b.voidWhy === "reversal").map((b) => b.seat);
  const conclusive = grounded.length >= MIN_BALLOTS;
  const counted = grounded.length ? grounded : cast;
  const scores = counted.map((b) => b.score).sort((a, b) => a - b);
  const median = scores.length ? scores[Math.floor((scores.length - 1) / 2)] : null;
  const spread = scores.length ? scores[scores.length - 1] - scores[0] : 0;
  const { ceiling, by } = ladderCeiling(ladder);
  const verdict = median === null || !conclusive ? null : Math.min(median, ceiling);
  const bySource = {};
  for (const b of counted) if (b.source != null) bySource[sourceCategory(b.source)] = (bySource[sourceCategory(b.source)] || 0) + 1;
  // Never voids a ballot (the void rule is groundedIn's alone, unchanged): a room can be fully grounded and still
  // principleOnly, and it is still counted, still shown - it just cannot end a hearing happy (lib/resolve.mjs
  // roomHappy), the same carve-out an all-void room already gets.
  const principleOnly = hasEvidence && counted.length > 0 && counted.every((b) => !isEvidenceSource(b.source));
  return {
    verdict,
    median,
    scores,
    spread,
    split: scores.length >= 2 && spread >= 4,
    counted: counted.map((b) => b.seat),
    ungrounded,
    reversed,
    allUngrounded: cast.length > 0 && grounded.length === 0,
    conclusive,
    valid: grounded.length,
    ceiling,
    cappedBy: conclusive && median > ceiling ? by : null,
    cast: cast.length,
    bySource,
    principleOnly,
  };
}

/** Why a sitting has no verdict to write up, or null when at least one seat cast a ballot. A room where every ballot
 *  call failed used to reach the secretary with "-/10 (no ballots)" and exit 0, so the hearing drafted against a fix the
 *  secretary had to invent (Opus 5.5 review, 2026-09-22). An all-void room is not this: it cast, and its minutes say
 *  it was not conclusive. */
export function noBallotError(ballots, tally) {
  if (tally.cast > 0) return null;
  const seats = (ballots || []).map((b) => b.seat).filter(Boolean);
  return `no seat cast a ballot${seats.length ? ` (${seats.join(", ")})` : ""}`;
}

/**
 * The fix-first backing counted by code, never taken from the secretary: the secretary names WHICH seats' ballots named
 * that fix (grouping two wordings of one fix is the only judgment left to it), and this counts the names that match a
 * ballot really cast. A name matching no cast ballot is dropped and listed in `errors`; every cast seat off the list
 * keeps its own fix, word for word, in `others`, so the fixes the room did not back still sit next to the verdict.
 * The secretary used to write the integer itself ("count them"), and that number steered the drafter and the next
 * sitting (found by the MiroFish review, 2026-09-23: its interview summary trusts the model's count the same way).
 */
export function countBacking(namedSeats, ballots) {
  const cast = (ballots || []).filter((b) => !b.failed);
  const bySeat = new Map(cast.map((b) => [String(b.seat).trim().toLowerCase(), b]));
  const seats = [];
  const errors = [];
  for (const name of Array.isArray(namedSeats) ? namedSeats : []) {
    const b = bySeat.get(String(name).trim().toLowerCase());
    if (!b) errors.push(String(name));
    else if (!seats.includes(b.seat)) seats.push(b.seat);
  }
  const others = cast.filter((b) => !seats.includes(b.seat) && b.fix_first).map((b) => ({ seat: b.seat, fix: b.fix_first }));
  return { backedBy: seats.length, seats, others, errors };
}

/**
 * The score counts only grounded ballots, and so does the fix: a fix whose every backer was voided (its quote was not in
 * the material) does not lead the ruling while a grounded ballot named a fix. The harshest grounded ballot's fix leads
 * instead, and the void-backed one is kept, named, in `voidOnly`. Dredd's own self-pass sitting (2026-09-23): three
 * seats invented an auth-token logging bug the code does not have, were voided on score, and still set the fix the
 * hearing drafts against. With no grounded fix at all the room's choice stands (the tally already says every ballot is
 * void). Pure. Returns { fix, seats, voidOnly: { fix, seats } | null, invented: { fix, seats, paths } | null, replaced }.
 *
 * Nor does a fix that names a file the repository does not have (`fixPaths`, lib/seats.mjs unfoundedCitations over the
 * room's fix; a ballot's own are its `unfoundedPaths`): on a plain static site the room's fix was "replace them with a
 * single SharedCTA component reference (src/components/SharedCTA.vue)" (2026-09-24). A backer's own fix that names only
 * real files leads instead, else the harshest such grounded ballot's; with none, the fix stands and `invented` flags it.
 */
export function groundedFix({ fix, seats, ballots, fixPaths = [] }) {
  const cast = (ballots || []).filter((b) => !b.failed);
  const backers = (seats || []).map((s) => cast.find((b) => b.seat === s)).filter(Boolean);
  const canLead = (b) => b.grounded && b.fix_first && !b.unfoundedPaths?.length;
  const leaders = cast.filter(canLead);
  const voidBacked = backers.length > 0 && !backers.some((b) => b.grounded);
  const invented = fixPaths.length ? { fix, seats, paths: [...fixPaths] } : null;
  if ((!voidBacked && !invented) || !leaders.length) return { fix, seats, voidOnly: null, invented, replaced: false };
  const harshest = (list) => [...list].sort((a, b) => (clampScore(a.score) ?? 11) - (clampScore(b.score) ?? 11))[0];
  const lead = harshest(backers.filter(canLead).length ? backers.filter(canLead) : leaders);
  return { fix: lead.fix_first, seats: [lead.seat], voidOnly: voidBacked ? { fix, seats } : null, invented, replaced: true };
}

/** The fixes the room did not back, each with its seat: " · other fixes: Grandma Sue: Y; Copy Editor: Z". */
export function renderOtherFixes(others) {
  return others?.length ? ` · other fixes: ${others.map((o) => `${o.seat}: ${o.fix}`).join("; ")}` : "";
}

/** The backing of the fix, out of the ballots actually cast; a seat whose ballot call failed cast none, and counting it
 *  made a unanimous fix read as contested ("3 of 4" when the fourth never voted, 2026-09-22). "" when there is no count. */
export function renderBacking(backedBy, ballots, seats = null) {
  if (!Number.isFinite(backedBy)) return "";
  const none = (ballots || []).filter((b) => b.failed).map((b) => b.seat);
  const cast = (ballots || []).length - none.length;
  const who = Array.isArray(seats) && seats.length ? `: ${seats.join(", ")}` : "";
  return ` (${backedBy} of ${cast} ballots cast${who}${none.length ? `; no ballot from ${none.join(", ")}` : ""})`;
}

/** What a ballot line says after its score: why it is void, or that it reverses an earlier hearing's fix and why. */
export function ballotNote(b) {
  if (!b.grounded)
    return b.voidWhy === "reversal"
      ? " (VOID: reverses an earlier hearing's fix without saying why it was wrong)"
      : " (VOID: the quote is not in the material)";
  return b.reversesEarlier ? ` (reverses an earlier hearing's fix: ${b.earlierWasWrong})` : "";
}

/** A sitting's score as every reader prints it: "N/10", "not conclusive", or "-/10" when no ballot was cast. Takes
 *  anything with `verdict` and `conclusive` (a tally, a hearing.json sitting); a record from before `conclusive`
 *  existed reads as it always did. A sitting that could not sit for capacity (lib/collect.mjs sit) is no score at all,
 *  never "-/10": the room never judged (board #7040). */
export function scoreText(x) {
  if (x?.capacity) return `did not sit (${typeof x.capacity === "string" ? x.capacity : "capacity"})`;
  if (x?.conclusive === false) return "not conclusive";
  return `${x?.verdict ?? "-"}/10`;
}

/** One line for the verdict line and the hearing's log. */
export function renderTally(t) {
  if (!t || !t.scores?.length) return "no ballots";
  const inconclusive = t.conclusive === false;
  const parts = [];
  if (inconclusive) parts.push(`NOT CONCLUSIVE: ${t.valid ?? 0} valid ballot(s), a verdict takes ${MIN_BALLOTS}`);
  parts.push(`${inconclusive ? "cast" : "median of"} ${t.counted.length} ballot(s): ${t.scores.join(", ")}`, `spread ${t.spread}`);
  if (t.split) parts.push("SPLIT");
  if (t.cappedBy) parts.push(`capped at ${t.ceiling} by the ladder (${t.cappedBy})`);
  const quoteVoid = (t.ungrounded || []).filter((s) => !(t.reversed || []).includes(s));
  if (quoteVoid.length) parts.push(`void, quote not in the material: ${quoteVoid.join(", ")}`);
  if (t.reversed?.length) parts.push(`void, reverses an earlier hearing's fix without saying why it was wrong: ${t.reversed.join(", ")}`);
  if (t.allUngrounded) parts.push("every ballot void");
  if (t.bySource && Object.keys(t.bySource).length)
    parts.push(
      `grounded in: ${Object.entries(t.bySource)
        .map(([k, n]) => `${k} ${n}`)
        .join(", ")}`,
    );
  if (t.principleOnly) parts.push("grounded only in principle, never happy");
  return parts.join(" · ");
}
