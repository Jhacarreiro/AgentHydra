// dredd/lib/resolve.mjs - the resolution loop: the room rules, a drafter writes the change, the Humanizer
// cleans it, the room scores the proposal, until the room is happy or the rounds run out (the Chair,
// 2026-09-22: "run a boardroom session over the content ... along with a humanizer, and then we review
// changes with the boardroom until we're happy").
//
// A proposal is a FILE in the docket (proposal-<n>.md): where, before, after, why, and what to cut.
// Nothing here writes to the repo - the front door's words are the owner's to land, and he lands them
// with the room's score next to them. The drafter and the Humanizer are HSwarm's tool-free brain;
// the Humanizer's rules are the global skill's own text, so the pass and the skill cannot drift.
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { scoreText } from "./ballot.mjs";
import { askBrain, askBrainHedged, plainDashes } from "./brain.mjs";
import { extractPaths } from "./docket.mjs";

/**
 * Whether the room's ruling is a happy one - the ONE rule, read by the stop rule below and by the hearing's H.happy,
 * which used to disagree (a split 7 at the last round printed "RESOLUTION: happy - ... still at 7/10", 2026-09-22).
 * A SPLIT room (the ballots four or more apart, lib/ballot.mjs) is never happy, whatever its median: a 7 that is
 * three 9s and a 3 is a fight, not a ruling. Nor is a room where EVERY ballot was void (no seat's quote was in the
 * material): lib/ballot.mjs still counts those so the number is shown, but a score nobody grounded cannot end a
 * hearing (Opus 5.5 review, 2026-09-22: three void 8s stopped the loop "happy"). Nor is a room that is `principleOnly`
 * (lib/ballot.mjs tallyBallots): every counted ballot grounded in a law or the complaint's own words, never in a
 * fact this docket's evidence actually carries. It is still a real, grounded verdict - never voided - it just is not
 * a ruling ON THE PAGE, and cannot end a hearing on its own (the MiroFish review, 2026-09-23). Nor is a sitting that
 * was not `conclusive` (fewer than two valid ballots, lib/ballot.mjs MIN_BALLOTS): it has no verdict to be happy with.
 */
export function roomHappy({ verdict, happyAt = 7, split = false, allVoid = false, principleOnly = false, conclusive = true }) {
  return typeof verdict === "number" && verdict >= happyAt && !split && !allVoid && !principleOnly && conclusive !== false;
}

/** When the loop ends: the room is happy, or the rounds are spent. Pure. */
export function shouldStop({
  verdict,
  happyAt = 7,
  round,
  maxRounds,
  split = false,
  allVoid = false,
  principleOnly = false,
  conclusive = true,
}) {
  if (roomHappy({ verdict, happyAt, split, allVoid, principleOnly, conclusive }))
    return { stop: true, why: `the room scored it ${verdict}/10 (happy at ${happyAt})` };
  // An all-void room is never conclusive either (no valid ballot at all), so it is named first.
  const inconclusive = conclusive === false;
  const unhappy = allVoid
    ? "every ballot was void (no seat quoted the material)"
    : inconclusive
      ? "fewer than two ballots were valid"
      : split
        ? "the room is split"
        : principleOnly
          ? "every ballot is grounded only in principle, not in this docket's evidence"
          : "";
  if (typeof verdict === "number" && verdict >= happyAt && round < maxRounds)
    return { stop: false, why: `the median is ${verdict}/10 but ${unhappy}; another round` };
  if (round >= maxRounds)
    return {
      stop: true,
      why: `${maxRounds} proposal round(s) held; the room is still ${inconclusive ? `not conclusive (${unhappy})` : `at ${verdict ?? "-"}/10${unhappy ? `, and ${unhappy}` : ""}`}`,
    };
  return { stop: false, why: "" };
}

const CHANGE = {
  type: "object",
  properties: {
    where: { type: "string", description: "Where on the page: the headline, the first paragraph, the pricing section, the footer CTA..." },
    before: { type: "string", description: "The current text this replaces, quoted exactly, or empty when it is new." },
    after: { type: "string", description: "The new text, exactly as it should read." },
    why: { type: "string", description: "One sentence: which visitor's words or which ruling this answers." },
  },
  required: ["where", "after", "why"],
};
const PROPOSAL_SCHEMA = {
  type: "object",
  properties: {
    headline: { type: "string", description: "The new headline, only if it changes." },
    changes: { type: "array", items: CHANGE },
    cuts: { type: "array", items: { type: "string" }, description: "Sentences or sections to remove outright, quoted." },
    note: { type: "string", description: "The one thing you could not decide without the owner, if any." },
  },
  required: ["changes"],
};

/**
 * The Humanizer skill's own rules, read from the machine; empty when the skill is not installed. The rules proper run
 * from its first section ("## A.") through "When not to act", and they go in whole: a 7,000-character head of the file
 * carried the front matter, the vendor note and half of section A, so the hearing's Humanizer never saw triads, dashes,
 * the AI word list or sales language, all of which bench.json says it judges (the Opus 5.5 instrument review,
 * 2026-09-22). `limit` stays a guard against a skill that grows past any sane prompt. Pure over `text`.
 */
export function humanizerRules(limit = 40_000, text = null) {
  const p = path.join(homedir(), ".claude", "skills", "humanizer", "SKILL.md");
  const raw = text ?? (existsSync(p) ? readFileSync(p, "utf8") : "");
  if (!raw) return "";
  const start = raw.search(/^## A\./m);
  const end = raw.search(/^## Source\b/m);
  const rules = start >= 0 ? raw.slice(start, end > start ? end : undefined) : raw;
  return rules.slice(0, limit).trimEnd();
}

/** The drafter's model: DREDD_DRAFTER_MODEL, else `auto` - HSwarm's published profile, at its exact evaluated
 *  effort (a hardcoded Gemini pin bypassed it). An explicit env pin still wins. Earlier measurements on the real landing-page draft (2026-09-22,
 *  tmp/dredd/probe-drafter.mjs): gemini-3.8-flash 3.3 s / $0.0034 / valid JSON; mistral-medium-3.5 6.5 s / $0.0017 /
 *  valid; deepseek-flash (routed to openrouter) 90 s and an empty answer twice, so DeepSeek is not the drafter until
 *  its direct pool has keys. The room stays on `auto`: scoring is cheap judgment. */
export function drafterModel() {
  return process.env.DREDD_DRAFTER_MODEL || "auto";
}

/**
 * Every model the drafter may ask, in order: the drafter model, then DREDD_DRAFTER_FALLBACK (comma-separated), else
 * `auto`, HSwarm's published-profile route, which answers the Humanizer's call in
 * the same PROPOSAL_SCHEMA in about 1.5 s. Why a second model at all (2026-09-24, four hearings on futurethatworks.org):
 * with Gemini's free pool spent the zswarm routed "gemini-3.8-flash" straight to deepseek-flash-or, and every one of
 * its eight draft calls spent the whole 4000-token output cap on reasoning (the ledger: out 4000, reasoning 4000),
 * because OpenRouter never gets the "thinking off" that a schema call asks for. No tool call, no text, 0 chars after
 * about 70 s; asking the same model again, which the hedge did, ran away the same way.
 */
export function drafterModels(first = drafterModel()) {
  const env = process.env.DREDD_DRAFTER_FALLBACK;
  const rest = env != null ? env.split(",").map((m) => m.trim()) : ["auto"];
  return [...new Set([first, ...rest].filter(Boolean))];
}

/** The most of one named file the drafter reads, in characters, and how many files; the prompt states the cap. */
export const NAMED_FILE_CAP = 60_000;
const NAMED_FILES_MAX = 3;

/**
 * The text of every file the ruling names, read from the judged repository's root. Lift's round 23 hearing (2026-10-02)
 * ruled "In site/student/player.js, make each question step look different", and the drafter, a tool-free call shown the
 * page and the screens but never that file, answered "I need to read the site/student/player.js file first" with an
 * empty after. A path that resolves outside `root` (`../`, an absolute path, a link out of it) is never read, nor is a
 * folder. Returns [{ path, text, size, cut }].
 */
export function namedFiles(text, root, { cap = NAMED_FILE_CAP, max = NAMED_FILES_MAX } = {}) {
  if (!root || !text) return [];
  let base;
  try {
    base = realpathSync(root);
  } catch {
    return [];
  }
  const out = [];
  for (const p of extractPaths(text)) {
    if (out.length >= max) break;
    let real;
    try {
      real = realpathSync(path.resolve(base, p));
    } catch {
      continue;
    }
    const rel = path.relative(base, real);
    if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel) || !statSync(real).isFile()) continue;
    const body = readFileSync(real, "utf8");
    out.push({ path: rel.split(path.sep).join("/"), text: body.slice(0, cap), size: body.length, cut: body.length > cap });
  }
  return out;
}

/** The named files as a prompt section, with the cap said out loud so a cut file is never read as the whole file. */
function filesSection(files, cap = NAMED_FILE_CAP) {
  if (!files.length) return "";
  const each = files.map((f) => `### ${f.path}${f.cut ? ` (cut at ${cap} of its ${f.size} characters)` : ""}\n\`\`\`\n${f.text}\n\`\`\``);
  return `## the files the ruling names, read from the repository (each cut at ${cap} characters) - the change is written against this text and a before is quoted from it; never ask to read them\n${each.join("\n\n")}`;
}

/** A drafter asking for a file or a tool instead of answering: "I need to read X first", "let me open the file". */
const READ_FIRST =
  /\bI(?:'d|'ll|\s+would|\s+will)?\s+(?:first\s+)?(?:need|have|want)\s+to\s+(?:first\s+)?(?:read|see|open|view|examine|inspect|look\s+at|access)(?:\s+\S+){0,4}?\s+(?:files?|code|source|contents?|[\w./-]+\.[a-z]{1,5})\b|\blet\s+me\s+(?:first\s+)?(?:read|open|view|examine|inspect|look\s+at)\b/i;

/**
 * Why a draft is no draft, or null. A change with no `after` gives the room nothing to land, and a drafter that asks to
 * read a file first has not drafted: Lift's round 23 sent exactly that stub to the room, which scored it 1/10 and ended
 * the hearing on it (2026-10-02). Checked on the drafter's own voice (each change's after and why, and the note), never
 * the copy's before. Dredd had no give-up detector of its own; ~/.claude/tools/teacher_escalation.py's GIVE_UP shapes
 * miss this one ("needs-more-context" wants "more information"), and its "could you clarify" shape is what this
 * schema's `note` is FOR (the one thing only the owner can decide), so they are not run here. Pure.
 */
export function draftGaveUp(p) {
  const changes = Array.isArray(p?.changes) ? p.changes : [];
  const blank = changes.find((c) => !String(c?.after ?? "").trim());
  if (blank) return `no after for "${blank.where || "a change"}"`;
  if (!changes.length && !p?.cuts?.length && !p?.headline) return "no change, cut or headline";
  const said = [p?.note, ...changes.flatMap((c) => [c?.after, c?.why])].find((t) => READ_FIRST.test(String(t ?? "")));
  return said ? `asked to read first: "${String(said).trim().slice(0, 200)}"` : null;
}

/** The route a give-up is asked again on, once: HSwarm's code profile, which steps down on its own when no code
 *  route answers (hswarm dispatch's _STEP_DOWN), never the routine default that gave up. */
const GAVE_UP_ROUTE = { model: "auto", profile: "code" };

export async function draftProposal({
  ask,
  url = null,
  pageText = "",
  screens = "",
  sue = null,
  minutes = null,
  prior = null,
  claims = null,
  house = "",
  callsLog = null,
  model = drafterModel(),
  models = null,
  missingFiles = [],
  rulings = "",
  realClaims = "",
  root = null,
  askFn = askBrainHedged,
}) {
  const files = namedFiles([minutes?.fix_first, minutes?.plan].filter(Boolean).join("\n"), root);
  const words = (sue?.theirWords || [])
    .slice(0, 10)
    .map((w) => `- (${w.kind}, ${w.where}) ${w.said}`)
    .join("\n");
  const system =
    `You are the drafter for a product's front door. The board of critics has ruled; you write the exact copy change and nothing else. ${house} ` +
    `You obey the marketing laws: never position as cheap, never lead with price (showing a price is fine, leading with it is not), never admit a capability is not the best, never advertise storage capacity. ` +
    `Plain words a stranger uses. No em dashes. No 'not X but Y'. No triads for rhythm. No stock words (seamless, robust, empower, leverage, unlock, effortless). ` +
    `A stranger's page is a couple of hundred words: prefer cuts to additions. Every change quotes the current text it replaces when there is one. ` +
    `YOU MAY NOT INVENT: name only capabilities the page's current text already names, never a free trial, a guarantee, a discount, a customer, a number or a feature the page does not carry - a claim in front of strangers is held to the same bar as a live deploy. If the right fix needs a fact you do not have, say so in the note instead of writing it.`;
  const prompt = [
    `## the complaint\n${ask}`,
    url ? `## the page\n${url}` : "",
    minutes
      ? `## the board's ruling\nverdict ${scoreText({ verdict: minutes.verdict, conclusive: minutes.tally?.conclusive })}; fix first: ${minutes.fix_first || "-"}\n${minutes.plan || ""}`
      : "",
    words ? `## what the visitors said, in their words\n${words}` : "",
    prior ? `## the previous proposal and what the room said about it\n${prior}` : "",
    claims
      ? `## the claims check REJECTED the previous draft - every line below is an invention; remove it, do not rephrase it\n${claims}`
      : "",
    missingFiles?.length
      ? `## files the ruling names that are NOT in the repository - never name them, they do not exist\n${missingFiles.map((f) => `- ${f}`).join("\n")}`
      : "",
    filesSection(files),
    // The ⛔ paragraphs of the route component's header (lib/rulings.mjs): what the owners already decided about this
    // page. The Deal Flow invite hearing re-proposed two of them because the drafter could not read them (2026-09-25).
    rulings
      ? `## the owners' recorded rulings for this page - already decided; never propose against them (a name they retire, an element they keep)\n${String(rulings).slice(0, 8000)}`
      : "",
    // The field's claims the room ruled REAL (lib/claim-rulings.mjs): the only reports the drafter may act on. A claim
    // the room did not rule real is not in front of it at all.
    realClaims ? `## the field's claims the room ruled REAL - the only reports you may act on\n${String(realClaims).slice(0, 6000)}` : "",
    pageText ? `## the page's current text (rendered, truncated)\n${String(pageText).slice(0, 6000)}` : "",
    // What the visitors read past the front door (SUE's screensSeen): on a complaint about a flow inside the product,
    // these are the words the complaint is about, and a before quoted from them is on the page (Lift, 2026-09-29).
    // All of them, to SUE's own 16000-character cap: a complaint is often about the END of a flow (Lift's kids and its
    // mastery check), and a cut from the start drops exactly those screens.
    screens
      ? `## the screens the visitors saw past the page, in order (their browser's text) - a change may be on any of them; quote their text as the before\n${String(screens).slice(0, 16000)}`
      : "",
    `## write\nA proposal: the new headline if it changes, each change as where / before / after / why, the sentences or sections to cut, and one note on what you could not decide without the owner.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // 4000 output tokens: a proposal is a few hundred, but a paid leg counts its reasoning against the cap and the first
  // deepseek-flash draft (2026-09-22) was cut mid-JSON at 1600 after 53 s, which read back as "the drafter failed: null".
  // Hedged: a drafter leg stalls now and then on its own side (49 s and 101 s against a 2 s median).
  // A call that brings back no proposal (empty, not JSON, cut off, or failed outright) is asked of the next model. A
  // draft that gave up (draftGaveUp) is never returned: it is asked once more on GAVE_UP_ROUTE, and a second give-up
  // ends the drafting with the reason, so the room never scores a stub. When the models are used up with no proposal
  // for any reason (a lone 'auto' that answered malformed has no next model), GAVE_UP_ROUTE is asked once too, if it
  // has not been yet: at most one such extra ask per drafting.
  const tried = [];
  let res = null;
  let queue = (models || drafterModels(model)).map((m) => ({ model: m }));
  let escalated = false;
  while (queue.length) {
    const { model: m, profile } = queue.shift();
    res = await askFn(
      { system, prompt, schema: PROPOSAL_SCHEMA, model: m, ...(profile ? { profile } : {}), maxTokens: 4000, timeoutS: 180 },
      callsLog,
    );
    const gaveUp = res?.data ? draftGaveUp(res.data) : null;
    if (res?.data && !gaveUp) return tried.length ? { ...res, fellBackFrom: tried } : res;
    tried.push(
      `${m}${profile ? ` (${profile})` : ""}${res?.model && res.model !== m ? ` (answered by ${res.model})` : ""}: ${gaveUp ? `drafted nothing, ${gaveUp}` : res?.error || res?.status || "no answer"}`,
    );
    if ((gaveUp || !queue.length) && !escalated) {
      escalated = true;
      queue = [GAVE_UP_ROUTE];
    }
  }
  return {
    ...(res || {}),
    data: null,
    status: "error",
    error: tried.length > 1 ? `every drafter failed - ${tried.join("; ")}` : tried[0] || "no drafter model to ask",
  };
}

export async function humanize({ proposal, callsLog = null, model = "auto" }) {
  const rules = humanizerRules();
  if (!rules) return { data: null, status: "skipped", error: "the humanizer skill is not installed on this machine" };
  const system =
    `You are the Humanizer. Rewrite ONLY the 'after' and 'headline' strings of the proposal so a person would believe a person wrote them; ` +
    `change nothing about what they say, and keep every 'where', 'before' and 'why' exactly as given. Return the same JSON shape. The rules you apply:\n\n${rules}`;
  return askBrain(
    { system, prompt: JSON.stringify(proposal, null, 2), schema: PROPOSAL_SCHEMA, model, maxTokens: 4000, timeoutS: 180 },
    callsLog,
  );
}

/**
 * The Humanizer's answer, taken on its contract: it may change only the headline (when the draft changes one) and each
 * change's `after`. Everything else - where, before, why, cuts, note - stays the draft's. Its answer used to replace
 * the draft wholesale, so a Humanizer that dropped a change or rewrote a `before` (which the claims check reads as
 * page text) went through unseen (Opus 5.5 review, 2026-09-22). An answer of another shape keeps the draft, and says
 * why. Pure. Returns { proposal, humanized, why }.
 */
export function mergeHumanized(draft, human, error = null) {
  if (!human) return { proposal: draft, humanized: false, why: error || "the Humanizer answered nothing" };
  const mine = draft.changes || [];
  const theirs = Array.isArray(human.changes) ? human.changes : [];
  if (theirs.length !== mine.length)
    return {
      proposal: draft,
      humanized: false,
      why: `the Humanizer returned ${theirs.length} change(s) for the draft's ${mine.length}; the draft stands unhumanized`,
    };
  const moved = theirs.findIndex((c, i) => c?.where !== mine[i].where);
  if (moved >= 0)
    return {
      proposal: draft,
      humanized: false,
      why: `the Humanizer renamed "${mine[moved].where}" to "${theirs[moved]?.where}"; the draft stands unhumanized`,
    };
  const text = (s) => typeof s === "string" && s.trim() !== "";
  const proposal = { ...draft, changes: mine.map((c, i) => (text(theirs[i].after) ? { ...c, after: theirs[i].after } : c)) };
  if (draft.headline && text(human.headline)) proposal.headline = human.headline;
  return { proposal, humanized: true, why: null };
}

const DESIGN_CHANGE = {
  type: "object",
  properties: {
    where: { type: "string", description: "The screen, part or step it touches (and the file, when the material names one)." },
    now: { type: "string", description: "What the person does or sees there today, from their own words or the screens they saw." },
    after: { type: "string", description: "What they will do or see after the redesign, concretely enough to build." },
    why: { type: "string", description: "Which person's words or which mind's principle this answers." },
  },
  required: ["where", "after", "why"],
};
const DESIGN_SCHEMA = {
  type: "object",
  properties: {
    idea: { type: "string", description: "The one redesign, in one sentence a builder and a student would both understand." },
    problem: { type: "string", description: "What the evidence says: where they stop and why, in their terms." },
    changes: { type: "array", items: DESIGN_CHANGE },
    keeps: { type: "array", items: { type: "string" }, description: "What stays as it is, and the owners' recorded rulings it respects." },
    measure: { type: "string", description: "What the next round must show if it worked: where they get to, and the stars." },
    note: { type: "string", description: "The one thing you could not decide without the owner, if any." },
  },
  required: ["idea", "changes", "measure"],
};

/**
 * The redesign a design board's ruling calls for (lib/round.mjs designCall): how the product should WORK and PLAY,
 * written as a brief a builder can build, never a copy change. The copy drafter above is told "the exact copy change and
 * nothing else ... prefer cuts to additions", which is right for a front door's words and wrong for a lesson nine rounds
 * of students stopped in (Lift, 2026-10-01). No claims check: a redesign is not a claim to strangers; the owners' recorded
 * rulings still bind it. `askFn` is injectable for the spec.
 */
export async function draftRedesign({
  ask,
  url = null,
  screens = "",
  sue = null,
  minutes = null,
  prior = null,
  house = "",
  rulings = "",
  realClaims = "",
  callsLog = null,
  model = drafterModel(),
  models = null,
  root = null,
  askFn = askBrainHedged,
}) {
  const files = namedFiles([minutes?.fix_first, minutes?.plan].filter(Boolean).join("\n"), root);
  const words = (sue?.theirWords || [])
    .slice(0, 16)
    .map((w) => `- (${w.kind}, ${w.where}) ${w.said}`)
    .join("\n");
  const stopped = (sue?.whyTheyStopped || [])
    .slice(0, 10)
    .map((w) => `- ${w.said}`)
    .join("\n");
  const system =
    `You write the design board's redesign as a brief a builder can build in a day. The board (game designers, product designers, attention and habit designers, psychologists) has ruled; the users only said what they need, and the board decides how, in a way the users did not know to ask for. ${house} ` +
    `Change how the experience WORKS: its structure, a mechanic, a feedback loop, the order of things, what the person does on each screen. Never a wording patch, never an answer-key fix, never "make it shorter" alone. ` +
    `Keep what the evidence says works. Plain words. No em dashes. Invent no facts, numbers or people; a redesign that needs a fact you do not have says so in the note.`;
  const prompt = [
    `## the question\n${ask}`,
    url ? `## the product\n${url}` : "",
    minutes
      ? `## the design board's ruling\nverdict ${scoreText({ verdict: minutes.verdict, conclusive: minutes.tally?.conclusive })}; fix first: ${minutes.fix_first || "-"}\n${minutes.plan || ""}\n${minutes.minutes || ""}`.slice(
          0,
          9000,
        )
      : "",
    stopped ? `## why they stopped, in their words\n${stopped}` : "",
    words ? `## what they and the critics beside them said\n${words}` : "",
    prior ? `## the previous redesign and what the board said about it\n${prior}` : "",
    rulings
      ? `## the owners' recorded rulings - already decided; the redesign never goes against them\n${String(rulings).slice(0, 8000)}`
      : "",
    realClaims ? `## the field's claims the room ruled REAL - the only reports you may act on\n${String(realClaims).slice(0, 6000)}` : "",
    screens ? `## the screens they saw, in order\n${String(screens).slice(0, 16000)}` : "",
    filesSection(files),
    `## write\nThe one redesign: its idea, the problem it answers, each change as where / now / after / why, what it keeps, and what the next round must show.`,
  ]
    .filter(Boolean)
    .join("\n\n");
  // A redesign is a design decision, so it asks HSwarm's "decision" profile first and steps down to the widest
  // ("routine") only when no decision route answers: on the default, Lift's first round hearing drafted its redesign on
  // a small fast model and proposed mid-lesson badge pop-ups for students who quit over too many screens (2026-10-01).
  const tried = [];
  let res = null;
  const attempts = [...(models || drafterModels(model)).map((m) => [m, "decision"]), ["auto", "routine"]];
  for (const [m, profile] of attempts) {
    res = await askFn({ system, prompt, schema: DESIGN_SCHEMA, model: m, profile, maxTokens: 6000, timeoutS: 240 }, callsLog);
    const gaveUp = res?.data?.changes?.length ? draftGaveUp(res.data) : null;
    if (res?.data?.changes?.length && !gaveUp) return tried.length ? { ...res, fellBackFrom: tried } : res;
    tried.push(
      `${m} (${profile})${res?.model && res.model !== m ? ` (answered by ${res.model})` : ""}: ${gaveUp ? `drafted nothing, ${gaveUp}` : res?.error || res?.status || "no redesign"}`,
    );
  }
  return { ...(res || {}), data: null, status: "error", error: tried.join("; ") || "no drafter model to ask" };
}

export function renderRedesign(p, { round, url = null, model = null }) {
  const lines = [`# Redesign ${round}${url ? ` - ${url}` : ""}`, ""];
  if (model) lines.push(`_Drafted by ${model} from the design board's ruling._`, "");
  lines.push(`**The idea:** ${plainDashes(p.idea || "")}`, "");
  if (p.problem) lines.push(`**The problem it answers:** ${plainDashes(p.problem)}`, "");
  for (const c of p.changes || []) {
    lines.push(`## ${plainDashes(c.where || "")}`);
    if (c.now) lines.push(`- now: ${plainDashes(c.now)}`);
    lines.push(`- after: ${plainDashes(c.after || "")}`, `- why: ${plainDashes(c.why || "")}`, "");
  }
  if (Array.isArray(p.keeps) && p.keeps.length) lines.push(`## Keeps`, ...p.keeps.map((k) => `- ${plainDashes(k)}`), "");
  lines.push(`## What the next round must show`, plainDashes(p.measure || "-"), "");
  if (p.note) lines.push(`> ${plainDashes(p.note)}`);
  return lines.join("\n");
}

export function renderProposal(p, { round, url = null, model = null, rejected = null, cut = null }) {
  const lines = [`# Proposal ${round}${url ? ` - ${url}` : ""}`, ""];
  if (model) lines.push(`_Drafted by ${model}._`, "");
  if (rejected)
    lines.push(
      `> **REJECTED by the claims check - the room never saw this one.** Every line below names something the page does not carry:`,
      ...rejected.split("\n").map((l) => `> ${l}`),
      "",
    );
  if (Array.isArray(cut) && cut.length)
    lines.push(
      `> **The claims check cut ${cut.length} place(s)** the redraft still filled with what the page does not carry; the room scored what is left:`,
      ...cut.map((c) => `> - ${plainDashes(c)}`),
      "",
    );
  if (p.headline) lines.push(`**Headline:** ${plainDashes(p.headline)}`, "");
  for (const c of p.changes || []) {
    lines.push(`## ${plainDashes(c.where || "")}`);
    if (c.before) lines.push(`- before: ${plainDashes(c.before)}`);
    lines.push(`- after: ${plainDashes(c.after || "")}`, `- why: ${plainDashes(c.why || "")}`, "");
  }
  if (Array.isArray(p.cuts) && p.cuts.length) lines.push(`## Cut`, ...p.cuts.map((c) => `- ${plainDashes(c)}`), "");
  if (p.note) lines.push(`> ${plainDashes(p.note)}`);
  return lines.join("\n");
}
