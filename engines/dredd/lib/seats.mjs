// dredd/lib/seats.mjs - who sits. Jev picks the seats for a sitting from the EVIDENCE, the same way it
// picks the instruments from the ask (the Chair, 2026-09-22: "the boardroom, which will determine who in
// the boardroom should be in this conversation using Jev"). Every seat file carries one typed yes/no
// question and a few keywords for the day Jev is unreachable; the decision itself is pure and tested.
// The rooms, the house brief, the seat roster and what the room reads (roomMaterial, ballotEvidence) live
// here so the Boardroom (bun, imports the plane's TypeScript) and the hearing (node) read one copy, and so
// node's specs can test them.
import { loadTarget, targetRoot } from "../../lib/target.mjs";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { groundedIn, scoreText } from "./ballot.mjs";
import { earlierHearings, renderEarlierHearings } from "./earlier.mjs";
import { frontMatter, kbToPlaybook, mergedPlaybook, mindBrief, readMind, tagWords } from "../../lib/shared/skill-playbook.mjs";
import { extractPaths, isCodePath, pYes, RETENTION_ASK, samePath } from "./docket.mjs";
import { repoFacts } from "./repo-facts.mjs";
import { readSeats } from "../../lib/people-home.mjs";
import { personDoc } from "../../sue/lib/personas.mjs";

const PERSONA_PHOTO_DIR = path.join("services", "boardroom", "web", "public", "personas");
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The seats are people: the people store's `dredd-seat` folders (lib/people-home.mjs), never files in this repo.
const SEATS_DIR = null;
/** The engine's own checkout: a mind seat's skill (its KB.md) resolves here whatever --root names. */
const ENGINE_ROOT = path.resolve(HERE, "..", "..");
/**
 * What SUE's person says and knows at a Boardroom table, on her own Connections record beside her voice (the owner,
 * 2026-09-28: no personality lives in a repo). A seat that speaks as her (`briefFrom`) opens with her voice, then
 * this; her table playbook is the seat's playbook. Changed in Connections like any of her fields (SUE's
 * edit_persona, builtIn: true for a built-in).
 */
const AT_THE_TABLE = "atTheTable";
const AT_THE_TABLE_PLAYBOOK = "atTheTablePlaybook";
/** Every word a mind seat derives from its skill, so every word a sitting owes Connections for it. */
const DERIVED_WORDS = ["modeledOn", "seatTitle", "oneLiner", "brief", "playbook"];
/** A seat sits when Jev's yes clears this. */
export const SIT = 0.5;
/** A room's own bar where SIT is too loose for it. The minds room: over ten saved Jev answer sets (2026-09-23, 140
 *  gold seatings) every mind the gold wanted scored 0.71 or more while 100 of the 1,820 others cleared 0.65, 143 cleared
 *  0.6 and 38 cleared 0.7. At 0.65 every wanted mind is still a firm yes on every set and the seats beyond the room's
 *  minimum fall from 121 to 21, lower on each of the ten; 0.7 would leave the wanted minds a hundredth of margin. */
export const ROOM_SIT = { minds: 0.65 };
/** The bar a pick sits at: a room's own ROOM_SIT is calibrated on Jev's probabilities, so it applies to Jev's answers
 *  only. The keywords' "p" is a hit count on another scale: at 0.65 it lost three of the minds room's gold seats. */
export function sitFor(room, source) {
  return source === "jev" ? (ROOM_SIT[room] ?? SIT) : SIT;
}
/** A seat under this is a firm no: it is never topped up beside a yes. Read off eval/seats.json's probabilities
 *  (2026-09-22): the six seats the old minimum of three dragged in beside a real yes scored 0.09 to 0.26, and at
 *  0.3 the seven held-out briefs still topped up the Design Critic at 0.30 and 0.32 beside a lone Architect on a
 *  page that did not load and a widget that took eight seconds; every seat the gold wanted scored 0.49 or more. */
export const FLOOR = 0.4;
/** A minds sitting fills every chair the plane has (the Chair, 2026-10-01: "leverage the boardroom"; left to choose, Jev
 *  seated two minds on Lift's lessons while thirty sat idle). A mind Jev scores under this is an outright no for the
 *  ask (a screenwriter on a pricing call) and never fills a chair. */
export const MINDS_FILL_FLOOR = 0.2;
/** At most this many minds of one field in a filled sitting, so five chairs are five lenses, not five game designers. */
export const FIELD_CAP = 2;
/** Fields whose minds sit on Jev's yes but never fill an empty chair: how to live, not how to build (fillMinds). */
export const FILL_SKIPS = new Set(["life"]);
/**
 * The named boards (the Chair, 2026-10-01: "students and teachers say what they need; the boardroom's experts - game
 * designers, gamification, product designers, psychologists, attention and funnel people - decide how"). A board is a
 * set of FIELDS (each mind skill's `field:` front matter), never a list of names: a mind shipped tomorrow with a field
 * sits on its board the same day. `lead` fields each get a chair first, so a design board is never five of one kind;
 * `cap` is the most of one field.
 */
export const BOARDS = Object.freeze({
  design: {
    fields: ["play", "product", "attention", "psychology", "humor", "growth"],
    lead: ["play", "product", "attention", "psychology"],
    cap: 2,
    about: "how it works and plays, and why a person wants the next screen: games, product design, attention, psychology",
  },
  educators: {
    fields: ["learning", "psychology"],
    lead: ["learning", "psychology"],
    cap: 4,
    about: "what the learner learns, remembers and is motivated by",
  },
});

/** A question about what a course of study covers: its curriculum, syllabus, or scope and sequence. */
export const CURRICULUM_ASK = /\b(?:curricul(?:um|a|ar)|syllab(?:us|i)|scope and sequence)\b/i;
/**
 * The chairs an ask is owed whatever Jev scores the minds in them (fillMinds `chairs`, field -> count). A curriculum
 * question seats the learning field and one growth mind for the people who buy it. Jev scored Wiliam 0.08, Willingham
 * 0.07 and Mayer 0.12 on whether Lift's curriculum was comprehensive enough to sell to schools, tutors and sponsors,
 * and two minds sat (docket 20261003-195820-67df; the Chair, 2026-10-04: consult "our teachers on staff" on "the
 * comprehensiveness of our curriculum"). Null for every other ask.
 */
export function chairsFor(ask) {
  return CURRICULUM_ASK.test(String(ask ?? "")) ? { why: "a curriculum question", fields: { learning: 4, growth: 1 } } : null;
}

/** The seat files for a repository: `<repo>/.dredd/seats/` when it has one, else the engine's own ten-plus. */
export function seatsDirFor(root) {
  const own = root ? path.join(root, ".dredd", "seats") : null;
  return own && existsSync(own) ? own : SEATS_DIR;
}

/** Which room hears which domain: the product room for pages, copy and flows; the tooling room for code, data,
 *  infra, security and money - found the night Dredd was run on itself, when six product critics argued about a
 *  headline for a CLI. A seat file's `rooms` names the rooms it sits in; an unlabeled seat sits in every room. */
export const ROOMS = {
  product: ["copy", "visual", "flow", "product", "cross_repo", "other"],
  tooling: ["code", "data", "infra", "security", "money"],
};
/** A product call with no page in front of it (what to build, how to price it, why growth stalled, how a game should
 *  play) goes to the MINDS room: one seat per verified mind skill (`mindSeats`). The product room's critics judge a
 *  page; with no page they had nothing to judge and argued from taste (the Chair, 2026-09-23: "combine" the boardroom
 *  with the Hormozi-and-similar skills). A page always keeps the product room. */
export function roomForDomain(domain, { url = null } = {}) {
  if (ROOMS.tooling.includes(domain)) return "tooling";
  if (domain === "product" && !url) return "minds";
  return "product";
}

/**
 * The rooms whose seats Jev is asked about. A page keeps the product room; when the complaint is about attention
 * (`RETENTION_ASK`: bored, drop off, come back, hooked) the minds join its pool, since the game designers, the habit
 * designers and the educators are who answer that, and Jev still picks who sits (the Chair, 2026-09-29: "a boardroom of,
 * say, gamification developers, addiction developers. Educators, design experts" hearing the kids' complaints,
 * "decided using, like, the JEV agent, which was managed by Dredd"). Only Jev's pick hears them: the keyword fallback
 * scores most minds alike, so seat-file order chose five and cut Willingham on kids-quit-the-lesson (eval/seats.json).
 */
export function roomsHeard(room, ask) {
  return room === "product" && RETENTION_ASK.test(String(ask ?? "")) ? ["product", "minds"] : [room];
}

/** The rooms heard for a brief that has no docket (the eval, the gold's own checks): its complaint is the ask. */
export const heardFor = (brief, room) => roomsHeard(room, complaintOf(brief));

/**
 * The file paths a room's write-up names that do not exist. A tooling room asked to "cite a finding by file and line"
 * over clean paths invented src/auth/cognito.ts:42 (the third self-hearing, 2026-09-22); the same stamp that refuses an
 * invented free trial refuses an invented file. Pure given `exists`; returns the distinct offending paths.
 */
export function unfoundedCitations(text, exists) {
  const out = new Set();
  // A URL's path is not a repository path: drop every URL before looking, as extractPaths does. The web's own file
  // types are here since a static site is judged too (a seat cited assets/site.css on one, 2026-09-24).
  for (const m of String(text || "")
    .replace(/https?:\/\/\S+/g, " ")
    .matchAll(
      /(?<![\w@/])((?:[\w.-]+\/)+[\w.-]+\.(?:ts|tsx|mjs|cjs|jsx|js|vue|svelte|astro|json|py|md|sql|yml|yaml|html|htm|css|scss|sass|less|toml|rs|go|rb|php))(?::\d+)?(?![\w/])/g,
    )) {
    const p = m[1].replace(/^\.\//, "");
    if (/^https?:/.test(p) || p.startsWith("node_modules")) continue;
    // A host with no scheme (futurethatworks.org/founders.html) is a page's address, not a file in the repository.
    if (/^[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}$/i.test(p.split("/")[0]) && !p.startsWith(".")) continue;
    if (!exists(p)) out.add(p);
  }
  return [...out];
}

/** Marks, never strips (lib/ballot.mjs markUnfoundedQuotes' rule): each file the repository does not have gets
 *  " [not in the repository]" after its first appearance, so round two and the secretary read it as invented. */
export function markUnfoundedPaths(text, paths) {
  let marked = String(text || "");
  for (const p of paths || []) {
    const at = marked.indexOf(p);
    if (at >= 0) marked = `${marked.slice(0, at + p.length)} [not in the repository]${marked.slice(at + p.length)}`;
  }
  return marked;
}

/** The files the room writes for itself (boardroom-<n>.log) and the hearing's own diary (hearing.log) are never
 *  evidence for the next sitting - Dredd's review of its own room (2026-09-22) found the exclusion keyed on a
 *  name nothing wrote, so the critics were being handed their previous transcript as field evidence. */
export function isRoomOwnLog(name) {
  return /^boardroom(-\d+)?\.log$/.test(String(name)) || name === "hearing.log";
}

/** The line lib/collect.mjs writes at the head of an instrument's log when it never produced real evidence - a
 *  crash, an unreadable report - so roomMaterial labels the log a FAILURE, not EVIDENCE: a ballot may still ground
 *  in it (the text is real, the void rule is unchanged), but the room reads it as "instrument failure, not evidence
 *  about the page" and it never counts toward a docket having field evidence (tallyBallots principleOnly). A crash
 *  line used to read as a fact about the page it never measured (the MiroFish review, 2026-09-23). */
export const INSTRUMENT_FAILURE_MARK = "INSTRUMENT FAILURE (not evidence about the page):";

/**
 * What the room reads of one evidence log. An instrument's log ends in its verdict, so the tail was all the room
 * ever saw - and a log that IS the evidence (a page's text, a report) begins with what matters: sat over the
 * explainer (2026-09-22), the room was handed the last forty lines of a 152-line page and asked about its first
 * screen, and the Copy Editor critiqued the Chair's ask as if it were the page's opening paragraph. A short log is
 * given whole; a long one as its first lines, a gap marker, then its last lines, and `how` says which.
 */
export function logExcerpt(text, { headLines = 12, tailLines = 40, headChars = 1500, tailChars = 3000 } = {}) {
  const lines = String(text || "")
    .trim()
    .split(/\r?\n/);
  if (lines.length <= tailLines) {
    const whole = lines.join("\n");
    if (whole.length <= headChars + tailChars) return { text: whole, how: "its log" };
    // Few lines but long ones (a JSON dump, a page's text): the same head-and-tail cut, by characters. The short path
    // used to keep only the tail and still call it the whole log (Opus 5.5 review, 2026-09-22).
    const gap = whole.length - headChars - tailChars;
    return {
      text: `${whole.slice(0, headChars)}\n[... ${gap} characters ...]\n${whole.slice(-tailChars)}`,
      how: "its first lines, then its last lines",
    };
  }
  const head = lines.slice(0, headLines).join("\n").slice(0, headChars);
  const tail = lines.slice(-tailLines).join("\n").slice(-tailChars);
  return { text: `${head}\n[... ${lines.length - headLines - tailLines} lines ...]\n${tail}`, how: "its first lines, then its last lines" };
}

/**
 * Whether anything in a docket was RENDERED - a screenshot landed, a vision score came back, or the critic captured
 * the surfaces the docket names.
 * A seat that judges pixels needs one: handed only a page's text, the Design Critic measured a hero headline "48 px
 * from the top", a diagram "under 3:1 contrast" and a teal button, none of which the page has (2026-09-22). A seat
 * file's `needs: "render"` benches it when this is false; the minutes say so.
 */
export function renderedEvidence(docketDir) {
  if (!docketDir || !existsSync(docketDir)) return false;
  const top = readdirSync(docketDir);
  const json = (f) => {
    try {
      return JSON.parse(readFileSync(path.join(docketDir, f), "utf8"));
    } catch {
      return null;
    }
  };
  // A page that did not load rendered nothing, whatever else the docket holds.
  if (top.includes("page-pulse.json") && json("page-pulse.json")?.verdict === "broken") return false;
  // Pixels of THIS page: a screenshot in the docket, a vision score over its surfaces, or the critic's capture
  // when the docket names surfaces the capture covers. A pulse alone is text, not pixels: it seated the Design
  // Critic on the explainer hearing, where nobody had photographed the page (2026-09-22).
  if (top.some((f) => /\.png$/i.test(f))) return true;
  if (top.includes("design-critic-vision.json") && Number(json("design-critic-vision.json")?.scored) > 0) return true;
  if (top.some((f) => /^design-critic.*\.log$/.test(f))) {
    const surfaces = json("docket.json")?.surfaces;
    return Array.isArray(surfaces) && surfaces.length > 0;
  }
  return false;
}
/**
 * Whether a docket puts no prose in front of the room: a code matter, no page named, and every path the ask names is
 * code (isCodePath). A seat that edits prose has nothing to cut there - the Copy Editor sits in the tooling room for a
 * README or a doc, and on Dredd's own self-hearing it read "tear dredd apart" as a headline, its ballot and one
 * other were the only grounded ones, and the proposal rounds drafted copy rules for the judge (2026-09-23). An ask that
 * names no path is not prose-free: nobody can say what is in front of the room.
 */
export function proseAbsent({ matter, url, paths }) {
  return matter === "code" && !url && Array.isArray(paths) && paths.length > 0 && paths.every(isCodePath);
}

/** Everything a docket lacks that a seat file's `needs` may name: nothing rendered, no prose. */
export function docketAbsent(docketDir) {
  let docket;
  try {
    docket = JSON.parse(readFileSync(path.join(docketDir, "docket.json"), "utf8"));
  } catch {
    docket = null; // no docket (a bare room) or an unreadable one: nothing known about prose
  }
  const out = renderedEvidence(docketDir) ? [] : ["render"];
  if (docket && proseAbsent({ matter: docket.matter?.kind, url: docket.url, paths: docket.paths })) out.push("prose");
  return out;
}

/** A brief's complaint, off the line `evidenceBrief` writes it on. */
function complaintOf(brief) {
  return /^The complaint: (.*)$/m.exec(String(brief || ""))?.[1] || "";
}

/** The same rules for a brief that has no docket (the eval): a broken pulse in the text is nothing rendered, and a
 *  tooling-room brief whose complaint names only code paths and no page has no prose. */
export function absentFor(brief, room = null) {
  const text = String(brief || "");
  const out = /page-pulse\): broken\b/.test(text) ? ["render"] : [];
  const complaint = complaintOf(text);
  const page = /^The page: /m.test(text) ? "named" : null;
  if (room === "tooling" && proseAbsent({ matter: "code", url: page, paths: extractPaths(complaint) })) out.push("prose");
  return out;
}
export const NEEDS_RENDER_WHY = "needs a rendered page; nothing in this docket was rendered";
export const NEEDS_PROSE_WHY = "needs prose to edit; the docket names only code and no page";
/** Why a seat whose `needs` the docket lacks is benched. */
export function benchWhy(needs) {
  return needs === "prose" ? NEEDS_PROSE_WHY : NEEDS_RENDER_WHY;
}
/** The why on a seat that sits because Jev (or the keywords) said yes - as against "always sits" or a top-up. The eval
 *  grades a must-sit seat as a hit only with this why, so the label lives once, here. */
export const JUDGED_IN = "jev: yes";

/** The laws that bind any room, whichever repository it judges. */
const HOUSE_LAWS =
  "the product is the 70-80%, never the 100% (five refined features beat five hundred half-built ones); reuse first, bespoke is the cardinal sin; copy is cut to a fixpoint and a stranger's page is a couple of hundred words; never position as cheap, never lead with price, never admit a capability is not the best, never advertise storage capacity; a change is tested by the next round of SUE's simulated people and the stars they give, never by a real pilot, a real class or a wait on real users (the Chair, 2026-10-01: one real person speaks for nobody else); users say what they need, and the design experts decide how";
export const HOUSE = `Connections is a Vue 3 + TypeScript SPA over AWS Lambda, Aurora and Cognito - one product made of planes (main, pass, events, market, chat, boardroom, ...), each on its own host. The company's own laws that bind this room: ${HOUSE_LAWS}; the design bar is Material 3 and the owner (the Chair) is final on how anything looks. the Chair owns UI/UX and the AI product; the owner owns backend, data and AWS.`;

/**
 * The house brief for the repository judged: HOUSE for Connections itself (or no root), else the laws with THAT
 * repository's stack and files (lib/repo-facts.mjs). HOUSE told every room "a Vue 3 + TypeScript SPA" whatever --root
 * named, and on a plain static site the seats proposed src/components/SharedCTA.vue (2026-09-24).
 */
export function houseFor(root, { engineRoot = targetRoot(), url = null } = {}) {
  // No repository named and a page on someone else's host: that site's house. A caller naming Connections itself wins.
  if (!root) {
    const host = foreignHost(url);
    return host ? foreignHouse(host, url) : HOUSE;
  }
  if (samePath(path.resolve(root), engineRoot)) return HOUSE;
  return `${NOT_OUR_BAR}\n\nThe laws that bind this room: ${HOUSE_LAWS}; the owner is final on how anything looks.\n\n${repoFacts(root).text}`;
}

/**
 * Said to every room judging something that is not Connections. The seats' own briefs carry Connections' design bar
 * and kit, and without this a room hearing a performer's site proposed a "Material-3 ElevatedButton" (2026-09-25).
 */
const NOT_OUR_BAR =
  "This is not Connections. Where a seat's brief names a design bar, a component kit or plane rules, those are " +
  "Connections' own and do not apply here: judge this site by its own design language and by what its visitors need, " +
  "and a fix names this site's own sections, files and elements.";

/** Our own hosts: every plane's domain family and the API's. A page on any of them is judged as Connections. */
const OUR_HOST_RX = /(?:^|\.)(?:get)?connections(?:api)?\.(?:icu|app|co|com)$/i;

/**
 * The hostname of a public page that is not ours, else null. A local server (localhost, 127.0.0.1, a LAN name) is not
 * called foreign: the explainer on :4919 is Connections', and a local copy of another site names its repository with
 * --root, which gets that repository's own house.
 */
export function foreignHost(url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host.includes(".") || /^(?:127\.|10\.|192\.168\.|\[?::1\]?$)/.test(host) || host.endsWith(".local")) return null;
  return OUR_HOST_RX.test(host) ? null : host;
}

/**
 * The house for a page on a host that is not ours, with no repository to read. HOUSE told that room "Connections is a
 * Vue 3 SPA ... the design bar is Material 3" and the seats proposed "the shared LandingPage component" for a
 * performer's site (sullivanfantastic.com, 2026-09-25).
 */
export function foreignHouse(host, url) {
  return (
    `The page on trial is ${url}, on ${host}: a site that is NOT Connections. ${NOT_OUR_BAR} The laws that bind this ` +
    `room: ${HOUSE_LAWS}; the page's owner is final on how anything looks.`
  );
}

/** The seat files, in seat order, as written (id, name, rooms, needs, jev, keywords, and briefFrom or minds: who sits
 *  where, never what they say, which is Connections'), then one seat per mind skill (`mindSeats`), which sit in the
 *  minds room only. */
export function loadSeatRoster(dir = SEATS_DIR) {
  const files = dir
    ? readdirSync(dir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .map((f) => JSON.parse(readFileSync(path.join(dir, f), "utf8")))
    : readSeats();
  return [...files, ...mindSeats()];
}

/** Words every skill's "use whenever" line carries, which would seat every mind on every ask as keywords. */
const GENERIC_FIT_WORDS = new Set(
  (
    "user asks question questions about thing things someone somebody wants want need needs make making work working next " +
    "even named product products whether actually something first look looks end person really run write build know keeps " +
    "use tool base change team's plan company real decision fix step machine"
  ).split(" "),
);

/** The part of a skill description that says when it fits: its "Use whenever ..." sentence, else its first one. */
function whenItFits(description) {
  const d = String(description || "");
  const use = /\bUse (?:whenever|when)\s+(.*?)(?:\.\s+Also use|\.\s*$|$)/s.exec(d);
  return (use ? use[1] : d.split(/\.\s/)[0]).replace(/\s+/g, " ").trim();
}

/**
 * One seat per operator skill on disk - every `.claude/skills/<name>/` that carries a KB.md, the same roster rule as
 * the Architect's operator-skill-integrity check, so a mind shipped by the OperatorSkills pipeline is a board member
 * the same day and there is no list here to drift. The seat's brief and playbook are read from the skill when the
 * seat sits (`loadSeats`), never copied into a file; its Jev question is the skill's own "use whenever" line.
 */
export function mindSeats(root = targetRoot()) {
  const dir = path.join(root, loadTarget().skillsDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => existsSync(path.join(dir, name, "KB.md")) && existsSync(path.join(dir, name, "SKILL.md")))
    .sort()
    .map((name) => {
      const skill = readFileSync(path.join(dir, name, "SKILL.md"), "utf8");
      const { description = "", field = "" } = frontMatter(skill);
      const h1 = (/^# (.+)$/m.exec(skill)?.[1] || name).trim();
      const [who, tagline] = h1.split(/\s+-\s+/);
      const fits = whenItFits(description).replace(/[?.]+$/, "");
      const firstSentence = description.split(/\.\s/)[0].trim();
      const firstClause = firstSentence.split(/,\s| using /)[0].trim();
      // The offline fallback's keywords: the name, then the distinctive words of the "use whenever" line (a keyword
      // matches as a substring of the evidence, so single topical words - churn, pricing, positioning - carry it).
      const topical = tagWords(fits).filter((w) => w.length >= 4 && !GENERIC_FIT_WORDS.has(w));
      return {
        id: `mind-${name}`,
        name: who,
        seatTitle: (tagline || firstClause).slice(0, 120),
        modeledOn: `.claude/skills/${name} - a verified knowledge base of ${who}'s own material`.slice(0, 120),
        oneLiner: firstSentence.slice(0, 400),
        mind: name,
        // The headshot the Boardroom ships for this mind (web/public/personas/<mind>.webp), so a new sitting never
        // makes a faceless adviser. Absent when no portrait exists: personaFields then leaves the photo alone.
        photoUrl: existsSync(path.join(root, loadTarget().personaPhotoDir, `${name}.webp`)) ? `/personas/${name}.webp` : null,
        // The mind's discipline (play, product, attention, psychology, learning, growth, story, humor, life): what a
        // named board draws from and what keeps a filled sitting from being five of one kind (BOARDS, fillMinds).
        field: field || null,
        rooms: ["minds"],
        jev: `Is this a call for ${who}'s method, which is for when ${fits}?`.slice(0, 700),
        keywords: [...new Set([who.toLowerCase(), who.split(/\s+/).pop().toLowerCase(), name, ...topical])].slice(0, 16),
      };
    });
}

/** A seat's playbook when the sitting derives it: one mind's KB (`mind`) or several minds' KBs in one chair (`minds`). */
function derivedPlaybook(s) {
  if (s.mind) return kbToPlaybook(readMind(s.mind, targetRoot()).kb, { title: `${s.name}'s playbook` });
  if (Array.isArray(s.minds) && s.minds.length) {
    const minds = s.minds.map(({ skill, who }) => ({ who, kb: readMind(skill, targetRoot()).kb }));
    return mergedPlaybook(minds, { title: `${s.name}'s playbook` }).playbook;
  }
  return null;
}

/** Whether a seat sits in a room: its `rooms` names the room, or it names none and sits in every room. The one copy of
 *  the rule (it had been written out in three places, 2026-09-22). */
/**
 * The plane seats `max`; past that the last seats NAMED sit out (the caller's order is its priority: a hearing names the
 * seats that must sit first, then Jev's picks by rank) and the rest keep the roster's speaking order. By roster order the
 * minds, which come last, were always the ones cut: Lift's round 4 benched Norman, Jev's one mind, to seat the Marketing
 * Minds for a proposal (docket 20260929-034049-7a11). `seats` carry `personaId`; with no `only` the roster order decides.
 */
export function capSeats(seats, only = null, max = 5) {
  if (seats.length <= max) return { sit: seats, out: [] };
  const rank = (s) => (only ? only.indexOf(s.personaId) : seats.indexOf(s));
  const out = new Set([...seats].sort((a, b) => rank(a) - rank(b)).slice(max));
  // The plane speaks in seatIndex order, numbered from 0 with no gaps (loadSeats numbers them so).
  const sit = seats.filter((s) => !out.has(s)).map((s, i) => (typeof s.seatIndex === "number" ? { ...s, seatIndex: i } : s));
  return { sit, out: seats.filter((s) => out.has(s)) };
}

export function inRoom(seat, room) {
  const rooms = [].concat(room);
  return !Array.isArray(seat.rooms) || seat.rooms.some((r) => rooms.includes(r));
}

/** The seats, in seat order, as the plane's SeatedMember shape. `only` (--seats, or the hearing's seats.json) names
 *  seats outright whatever their room; else the room's seats sit. A seat's words are the Connections board member's
 *  (lib/connections-board.mjs seatOnConnections), so a seat carries here only what this sitting derives, named in
 *  `push`: a mind's KB, or SUE's person at the table. A seat that speaks as one of SUE's people (`briefFrom.sue`,
 *  Grandma Sue) opens with her own words, read from the people installed from Connections (lib/visitors.mjs
 *  readyCastBodies), the workspace's own copy over a built-in, as a run sends her, so a repo's own seat can be a person
 *  saved to its workspace; unread, she is benched and named, never given a voice that is not hers. A seat whose `needs` is
 *  in `absent` is benched too, because a seat that judges pixels with nothing rendered invents them. */
export function loadSeats(only = null, room = null, seatsDir = SEATS_DIR, { absent = [], benched = [] } = {}) {
  const seats = [];
  for (const s of loadSeatRoster(seatsDir)) {
    if (only && !only.includes(s.id) && !(s.mind && only.includes(s.mind))) continue;
    if (!only && room && !inRoom(s, room)) continue;
    if (s.needs && absent.includes(s.needs)) {
      benched.push({ seat: s.name, why: benchWhy(s.needs) });
      continue;
    }
    let brief = "";
    let playbook = derivedPlaybook(s);
    const push = s.mind ? [...DERIVED_WORDS] : playbook === null ? [] : ["playbook"];
    if (s.briefFrom) {
      const person = personDoc(s.briefFrom.sue);
      const own = person?.[s.briefFrom.field];
      if (typeof own !== "string" || !own.trim()) {
        benched.push({
          seat: s.name,
          why: `SUE's ${s.briefFrom.sue} was not read from Connections this sitting, and this seat speaks only in her own words`,
        });
        continue;
      }
      brief = [own, person[AT_THE_TABLE]].filter((part) => typeof part === "string" && part.trim()).join("\n\n");
      playbook = typeof person[AT_THE_TABLE_PLAYBOOK] === "string" ? person[AT_THE_TABLE_PLAYBOOK] : "";
      push.push("brief", "playbook");
    }
    if (s.mind) brief = mindBrief(readMind(s.mind, targetRoot()), s.name);
    seats.push({
      personaId: s.id,
      slug: s.id,
      name: s.name,
      modeledOn: s.modeledOn || null,
      seatTitle: s.seatTitle || "",
      oneLiner: s.oneLiner || "",
      brief,
      playbook: playbook ?? "",
      photoUrl: s.photoUrl || null,
      push: [...new Set(push)],
      seatIndex: seats.length,
    });
  }
  return seats;
}

/** One line on the sitting before this one, from its minutes (the hearing and --collect keep it as boardroom-<n-1>).
 *  A second sitting is asked what changes in its verdict, and it had never been shown that verdict (2026-09-22). */
function previousSittingLine(docketDir, sitting) {
  const n = sitting - 1;
  const file = path.join(docketDir, `boardroom-${n}`, "minutes.json");
  if (!existsSync(file)) return `There is no record of the board's previous sitting (${n}).`;
  const m = JSON.parse(readFileSync(file, "utf8"));
  if (m.failed) return `The board's previous sitting (${n}) reached no verdict: ${m.error || "it failed"}`;
  return `The board's previous sitting (${n}): ${scoreText({ verdict: m.verdict, conclusive: m.tally?.conclusive })}, fix first: ${m.fix_first || "-"}`;
}

/**
 * What the room knows going in: the complaint, the sitting before this one, the docket's recalled memories, and the
 * fact logs. The complaint leads, every sitting: a second or proposal sitting opens on a canned member line, and the
 * seats had been scoring "the thing complained about" without ever being told what it was (Opus 5.5 review,
 * 2026-09-22). No docket: nothing but the question the member typed.
 *
 * `root` is the repository judged: --root when the caller has one, else the docket's own `root` (dredd.mjs writes it
 * for any repository but Connections), so the sitting the hearing convenes with no --root reads the same house as the
 * ones it sits later. `house` (houseFor) is returned with it and is what the room and every ballot read as the house.
 *
 * A page heard before (lib/earlier.mjs earlierHearings: the last few earlier dockets on the same url that ruled on it)
 * puts those rulings in front of the room, each score and fix, and returns them as `earlier` so every ballot is asked
 * whether its fix reverses one (lib/ballot.mjs ballotSchema). The founders page was scored 3/10 for doing what a
 * hearing before had asked, by a room that had never been told what that was (2026-09-24).
 */
export function roomMaterial(docketDir, { proposalFile = null, sitting = 1, root = null } = {}) {
  if (!docketDir) {
    const house = houseFor(root);
    return {
      companyContext: "",
      advisorFindings: "",
      ask: null,
      domain: null,
      matter: null,
      parts: [{ label: "house", text: house }],
      hasEvidence: false,
      root,
      house,
    };
  }
  const docket = JSON.parse(readFileSync(path.join(docketDir, "docket.json"), "utf8"));
  const judged = root || docket.root || null;
  const house = houseFor(judged, { url: docket.url });
  const parts = [];
  // The labelled parts a ballot's quote can be traced to (lib/ballot.mjs groundedWhere is asked over these): the
  // house laws lead, since they are read whatever the docket holds. Only the five kinds P12 names are labelled -
  // the previous sitting's line and recalled memories stay unlabelled (out of scope), so a quote from them grounds
  // a ballot exactly as before but resolves to no source.
  const labeled = [{ label: "house", text: house }];
  if (docket.ask) {
    parts.push(`The complaint: ${docket.ask}`);
    labeled.push({ label: "complaint", text: docket.ask });
  }
  if (sitting >= 2) parts.push(previousSittingLine(docketDir, sitting));
  if (docket.url) parts.push(`The page in question: ${docket.url}`);
  const earlier = earlierHearings(docketDir, docket);
  const earlierText = renderEarlierHearings(earlier);
  if (earlierText) parts.push(earlierText);
  if (docket.memories?.length) {
    // A superseded memory is a belief the fleet has since replaced: it is history, never something it still holds.
    const recalled = docket.memories.slice(0, 6);
    const line = (m) => `- [${m.slug}]${m.repo ? ` (${m.repo})` : ""} ${m.title || ""}${m.updatedAt ? ` (updated ${m.updatedAt})` : ""}`;
    const held = recalled.filter((m) => !m.supersededBy);
    const replaced = recalled.filter((m) => m.supersededBy);
    if (held.length) parts.push(`Memories the fleet already holds about this (strongest first):\n${held.map(line).join("\n")}`);
    if (replaced.length)
      parts.push(
        `Once believed, since replaced (history, not current belief):\n${replaced.map((m) => `${line(m)}, replaced by [${m.supersededBy}]`).join("\n")}`,
      );
  }
  // A docket that names paths is judged on those paths: the Grid's repo-at-a-glance is not evidence about them (the
  // third self-hearing's room argued about another package's orphans it had read off the grid, 2026-09-22).
  const scoped = Array.isArray(docket.paths) && docket.paths.length > 0;
  const repoWide = new Set(["grid.log", "arkitect.log"]); // arkitect-named-paths.log carries what names the paths
  const logs = readdirSync(docketDir).filter((f) => f.endsWith(".log") && !isRoomOwnLog(f) && !(scoped && repoWide.has(f)));
  // A code matter is judged on the code: the gate, the checks and an agent's audit landed as <docket>/<id>.log (the
  // docket's "lands:" line) lead, and the page's words come last with an instrument's excerpt, never the first screen.
  // SageThumbs 2K, 2026-09-23: both tooling-room sittings argued the site's copy from page-words.log while the deep
  // audit sat in the docket as deep-audit.log.
  const codeMatter = docket.matter?.kind === "code";
  if (codeMatter) {
    logs.sort((x, y) => Number(x === "page-words.log") - Number(y === "page-words.log"));
    if (logs.length)
      parts.push(
        "A code matter: the code evidence decides - the gate, the checks, an audit landed in the docket. The page's words are context, never the finding.",
      );
  }
  for (const f of logs) {
    // The page's own words get a longer first excerpt than an instrument's log: the first screen is what the critics
    // judge and what a ballot quotes, and it is at the top, not the tail. Not on a code matter (above).
    const budget = f === "page-words.log" && !codeMatter ? { headLines: 60, headChars: 6000, tailLines: 20, tailChars: 2000 } : {};
    const raw = readFileSync(path.join(docketDir, f), "utf8");
    const { text, how } = logExcerpt(raw, budget);
    if (text.trim()) {
      const name = f.replace(/\.log$/, "");
      parts.push(`Evidence from ${name} (${how}):\n${text}`);
      // A log lib/collect.mjs marked as an instrument's own failure is principle, not a fact about the page: it
      // reads to the room, but a ballot grounded only in it can never carry a docket to "happy" (tallyBallots
      // principleOnly). The mark rides in the raw log, not the excerpt, so it survives whichever head or tail kept it.
      labeled.push({ label: raw.startsWith(INSTRUMENT_FAILURE_MARK) ? `failure:${name}` : `evidence:${name}`, text });
    }
  }
  if (proposalFile && existsSync(proposalFile)) {
    const proposalText = readFileSync(proposalFile, "utf8").slice(0, 9000);
    parts.push(`The proposal on the table:\n${proposalText}`);
    labeled.push({ label: "proposal", text: proposalText });
  }
  // Last, so a quote the page and an earlier fix both carry is traced to the page: an earlier ruling is advice, never
  // a fact about the page as it is now (tallyBallots principleOnly).
  if (earlierText) labeled.push({ label: "earlier", text: earlierText });
  return {
    companyContext: "",
    advisorFindings: parts.join("\n\n"),
    ask: docket.ask,
    url: docket.url || null,
    domain: docket.domain || null,
    matter: docket.matter?.kind || null,
    parts: labeled,
    hasEvidence: labeled.some((p) => p.label.startsWith("evidence:")),
    root: judged,
    house,
    earlier,
  };
}

/** Which labelled part of `roomMaterial`'s (or a bare room's HOUSE-only) parts a ballot's quote is grounded in - the
 *  same rule the void check uses (groundedIn), asked of each part in turn. Pure. Returns the part's label, or null
 *  when the quote grounds in none of them (an ungrounded ballot has no source to name). */
export function groundedWhere(quote, parts) {
  for (const p of Array.isArray(parts) ? parts : []) if (groundedIn(quote, p.text)) return p.label;
  return null;
}

/** What a ballot may quote: the question the member typed (a bare room's ask), the house laws and the room's material
 *  (the complaint and the evidence) - never the meeting, and never the member's canned sitting line: the code room's
 *  "say plainly that the paths are clean" was grounding a 9 over a lint log that reported an error (2026-09-22). */
export function ballotEvidence({ typedAsk, ctx }) {
  return [typedAsk, ctx.house || HOUSE, ctx.companyContext, ctx.advisorFindings].filter(Boolean).join("\n\n");
}

/** One yes/no per seat, in Jev's item shape (lib/docket.mjs buildQuestions); the state is the evidence brief. */
export function buildSeatQuestions(seats, evidence) {
  return seats.filter((s) => s.jev).map((s) => ({ id: `seat:${s.id}`, state: evidence, type: "yesno", question: s.jev }));
}

/** The keyword fallback when Jev is unreachable: a seat sits when its keywords appear in the evidence. */
export function heuristicSeatAnswers(seats, evidence) {
  const text = String(evidence || "").toLowerCase();
  const out = {};
  for (const s of seats) {
    const hits = (s.keywords || []).filter((k) => text.includes(String(k).toLowerCase())).length;
    const p = hits === 0 ? 0.2 : hits === 1 ? 0.55 : hits === 2 ? 0.7 : 0.85;
    out[`seat:${s.id}`] = { answer: p >= SIT ? "yes" : "no", probabilities: { yes: p, no: 1 - p }, confidence: p >= SIT ? p : 1 - p };
  }
  return out;
}

/**
 * The sitting's roster: every seat of the room Jev said yes to (p >= SIT, or the room's own ROOM_SIT), plus the `always` seats, topped up
 * by p to `min` from the seats Jev did not firmly reject (p >= FLOOR), capped at `max` strongest. A firm no is
 * never dragged in beside a yes: the old minimum of three seated the Design Critic and the Product Engineer at
 * 0.09 and 0.11 on a page that did not render (the eval's broken-page brief, 2026-09-22), and seven of the ten
 * gold rosters could never be exact. A room of one is a room when Jev was firm about everyone else. With no yes
 * at all the floor has nothing to protect, so the strongest seats sit to the minimum and the sitting says so.
 * A seat whose `needs` is in `absent` (the docket has nothing rendered) is benched whatever Jev said, and its row
 * says why. The picked ids come back in SEAT-FILE order, because the plane's speaking order keys on the seat index.
 */
export function decideSeats({ seats, answers, room, heard = [room], min = 2, max = 6, always = [], absent = [], sit = SIT }) {
  const roomSeats = seats.filter((s) => inRoom(s, heard));
  const bar = sit;
  const benched = (s) => s.needs && absent.includes(s.needs);
  const rows = roomSeats.map((s) => {
    const p = Math.round(pYes((answers || {})[`seat:${s.id}`]) * 100) / 100;
    const why = benched(s) ? benchWhy(s.needs) : always.includes(s.id) ? "always sits" : p >= bar ? JUDGED_IN : "jev: no";
    return { id: s.id, name: s.name, p, why };
  });
  const out = new Set(roomSeats.filter(benched).map((s) => s.id));
  const byP = rows.filter((r) => !out.has(r.id)).sort((a, b) => b.p - a.p);
  // The `always` seats go first so the cap never cuts them: in p order, a room of six other yeses cut Grandma Sue at
  // p 0.1 while her row still said "always sits" (Opus 5.5 review, 2026-09-22).
  const picked = [...byP.filter((r) => always.includes(r.id)), ...byP.filter((r) => !always.includes(r.id) && r.p >= bar)].map((r) => r.id);
  const floor = picked.length ? FLOOR : 0;
  for (const r of byP) {
    if (picked.length >= min) break;
    if (picked.includes(r.id) || r.p < floor) continue;
    picked.push(r.id);
    r.why = "topped up to the minimum";
  }
  const capped = new Set(picked.slice(0, max));
  for (const r of rows) if (picked.includes(r.id) && !capped.has(r.id)) r.why = "capped at max";
  return { picked: roomSeats.map((s) => s.id).filter((id) => capped.has(id)), rows, room, ...(heard.length > 1 ? { heard } : {}), min };
}

/**
 * A minds sitting, filled: Jev's yeses (p >= `sit`) first by p, then one chair for each `lead` field Jev did not already
 * seat (its strongest mind), then the strongest of the rest, until `max` chairs are filled - never more than `cap` minds of
 * one field, and never a mind under MINDS_FILL_FLOOR. Until 2026-10-01 the minds room sat the yeses and topped up to two,
 * so a sitting on Lift's lessons held two minds of thirty (the Chair: "leverage the boardroom"). `chairs` (chairsFor) go
 * before all of it: each of its fields seats its strongest minds up to its count, under the fill floor too, and that
 * count is the field's cap; such a row carries `chair: true`. Pure; the picked ids come back in roster order, each row
 * with why it sat or did not.
 */
export function fillMinds({ seats, answers, max = 5, sit = ROOM_SIT.minds, cap = FIELD_CAP, lead = [], chairs = null }) {
  const rows = seats.map((s) => ({
    id: s.id,
    name: s.name,
    field: s.field || null,
    p: Math.round(pYes((answers || {})[`seat:${s.id}`]) * 100) / 100,
    why: "not seated",
  }));
  const byP = [...rows].sort((a, b) => b.p - a.p);
  const chosen = [];
  const count = (field) => chosen.filter((r) => field && r.field === field).length;
  const capOf = (field) => Math.max(cap, chairs?.fields?.[field] ?? 0);
  const take = (r, why, floor = MINDS_FILL_FLOOR) => {
    if (chosen.length >= max || chosen.includes(r) || r.p < floor || (r.field && count(r.field) >= capOf(r.field))) return false;
    chosen.push(r);
    r.why = why;
    return true;
  };
  for (const [field, n] of Object.entries(chairs?.fields || {}))
    for (const r of byP.filter((x) => x.field === field).slice(0, n))
      if (take(r, r.p >= sit ? JUDGED_IN : `the ${field} chair of ${chairs.why}`, 0)) r.chair = true;
  for (const r of byP) if (r.p >= sit) take(r, JUDGED_IN);
  for (const field of lead) {
    if (count(field)) continue;
    const best = byP.find((r) => r.field === field && !chosen.includes(r));
    if (best) take(best, `the ${field} chair`);
  }
  // A filled chair goes to a mind whose discipline is the work (FILL_FIELDS): the life minds (Manson, Robbins) and a seat
  // with no field (the owner's own voice) sit on Jev's yes alone. Filling from them seated Manson as the fifth chair on
  // stalled signups, a lesson screen and a review queue (the full eval, 2026-10-01: 6 of 48 must-not seatings).
  for (const r of byP) if (r.field && !FILL_SKIPS.has(r.field)) take(r, "filled the room");
  for (const r of rows)
    if (r.why === "not seated" && r.p < MINDS_FILL_FLOOR) r.why = "jev: no";
    else if (r.why === "not seated" && r.field && count(r.field) >= capOf(r.field)) r.why = `${r.field} already holds ${capOf(r.field)}`;
  const picked = new Set(chosen.map((r) => r.id));
  return { picked: seats.map((s) => s.id).filter((id) => picked.has(id)), rows, room: "minds", min: max };
}

/**
 * Who sits in the minds room for this ask: Jev's yes per mind (the skill's own "use whenever" line is the question),
 * the keywords when Jev cannot answer, then `fillMinds` with the plane's seat count as the room's size. `board` names
 * a board (BOARDS: design, educators) whose fields alone sit, each lead field with a chair. `ask` is injectable so the
 * spec runs without the network.
 */
export async function pickMinds({ ask, evidence = "", max = 5, cwd, askJevFn = null, board = null } = {}) {
  const spec = board ? BOARDS[board] : null;
  if (board && !spec) throw new Error(`no board "${board}": the boards are ${Object.keys(BOARDS).join(", ")}`);
  const roster = loadSeatRoster().filter((s) => inRoom(s, "minds") && (!spec || spec.fields.includes(s.field)));
  const brief = [`The question before the board: ${ask}`, evidence].filter(Boolean).join("\n\n").slice(0, 6000);
  let answers = null;
  let decidedBy = "heuristic";
  try {
    const jev = askJevFn || (await import("./jev.mjs")).askJev;
    const res = await jev(buildSeatQuestions(roster, brief), { escalate: 0.7, timeoutMs: 60_000, cwd });
    if (res?.answers) {
      answers = res.answers;
      decidedBy = "jev";
    }
  } catch {
    /* Jev unreachable: the keywords decide, and the pick says so */
  }
  if (!answers) answers = heuristicSeatAnswers(roster, brief);
  const filled = fillMinds({
    seats: roster,
    answers,
    max,
    sit: sitFor("minds", decidedBy),
    cap: spec?.cap ?? FIELD_CAP,
    lead: spec?.lead ?? [],
    chairs: spec ? null : chairsFor(ask),
  });
  return { ...filled, decidedBy, ...(board ? { board } : {}) };
}

/** The brief's ceiling: Jev reads at most this many characters. */
export const BRIEF_MAX = 6000;

/** The instruments whose evidence already has its own line in the brief (the room, SUE's report, the page's pulse). */
const BRIEF_OWN_LINE = new Set(["boardroom", "sue", "page-pulse"]);

/** Head and tail of a text around an omission marker, `max` characters at most. */
function headTail(text, max) {
  const s = String(text || "");
  if (s.length <= max) return s;
  if (max < 40) return s.slice(0, Math.max(0, max));
  const half = Math.floor((max - 7) / 2);
  return `${s.slice(0, half)} [...] ${s.slice(-half)}`;
}

/**
 * What Jev reads to pick the seats: the complaint, the page's pulse, what the Sues said, the scoreboard's before/after
 * line, the first sitting, the ladder. Budgeted by part, never cut at the end: the short lines that sum the evidence up
 * (the pulse, SUE's numbers, the scoreboard line, the first sitting, the ladder) are always whole, and the long ones
 * (the complaint, the page's words, the visitors' own lines) share what is left, each kept head and tail. A plain
 * `.slice(0, 6000)` over the joined text used to drop exactly the first sitting and the ladder whenever the quotes ran
 * long (found by the MiroFish review, 2026-09-23). The order is the one the seat gold set (eval/seats.json) was written in.
 */
export function evidenceBrief({
  ask,
  url = null,
  sueReport = null,
  pulse = null,
  minutes = null,
  ladder = null,
  pageText = null,
  scoreboard = null,
  round = null,
  results = [],
}) {
  const parts = [{ text: `The complaint: ${ask}`, stretch: "complaint" }];
  // A round's numbers against its target (lib/round.mjs targetLine): a short fixed part, read before everything it sums up.
  if (round) parts.push({ text: round });
  if (url) parts.push({ text: `The page: ${url}` });
  if (pulse) parts.push({ text: `Page health (page-pulse): ${pulse.verdict} - ${pulse.summary || ""}` });
  // The page's first words, so a seat question about the words (the Copy Editor, the Marketer) reads the real ones.
  const words = String(pageText || pulse?.text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (words) parts.push({ text: `The page's first words: ${words.slice(0, 600)}${words.length > 600 ? " ..." : ""}`, stretch: "words" });
  if (sueReport) {
    const v = sueReport.verdict || {};
    parts.push({
      text: `Simulated visitors (SUE, ${sueReport.sues ?? "?"} people): ${v.averageStars ?? "-"} stars, never coming back ${Math.round((v.neverComingBackShare || 0) * 100)}%, understood it: ${JSON.stringify(sueReport.understoodIt || {})}, stopped at: ${JSON.stringify(sueReport.whereTheyStopped || {})}`,
    });
    // Why each one stopped comes first: it is the complaint, where their words below are their first looks.
    const why = (sueReport.whyTheyStopped || []).slice(0, 8);
    if (why.length)
      parts.push({
        text: "Why they stopped:",
        quotes: why.map((w) => `- ${w.said}${w.threeWords ? ` (in three words: ${w.threeWords})` : ""}`),
      });
    const said = (sueReport.theirWords || []).slice(0, 8);
    if (said.length) parts.push({ text: "In their words:", quotes: said.map((w) => `- (${w.kind}, ${w.where}) ${w.said}`) });
  }
  // P17: the scoreboard's own before/after line (rendered by hearing.mjs from readScoreboard - this
  // function stays pure and never reads a file itself). A short fixed part, like the pulse and the
  // first sitting: never trimmed away by the quote budget below.
  if (scoreboard) parts.push({ text: scoreboard });
  // What the checks found - the facts the room argues over, so the seat pick reads them too. Dredd's self-hearing whose
  // first sitting said "No fix needed" handed Jev the complaint and five page rungs nobody convened, and Jev seated the
  // Copy Editor over the Architect on the judge's own code (2026-09-23). The room's own row and the instruments with a
  // line of their own above are left out, and so is a launch that has produced nothing yet.
  const checks = (results || []).filter(
    (r) => r?.status && !BRIEF_OWN_LINE.has(r.id) && !/^launched\b/.test(String(r.status)) && r.id !== "convene",
  );
  if (checks.length)
    parts.push({
      text: `What the checks found: ${checks
        .map((r) => `${r.id} ${r.status}${r.note ? ` - ${String(r.note).replace(/\s+/g, " ").trim().slice(0, 220)}` : ""}`)
        .join("; ")}`,
      stretch: "checks",
    });
  if (minutes && (minutes.verdict != null || minutes.tally?.conclusive === false))
    parts.push({
      text: `The board's first sitting: ${scoreText({ verdict: minutes.verdict, conclusive: minutes.tally?.conclusive })}, fix first: ${minutes.fix_first || "-"}`,
    });
  // A ladder no rung of which was convened (a code matter) says nothing, and five page questions read as a page matter.
  if (Array.isArray(ladder) && ladder.some((r) => r.state !== "not-convened"))
    parts.push({ text: `The ladder: ${ladder.map((r) => `${r.n}. ${r.question} ${r.state}`).join("; ")}` });

  const render = (p) => (p.quotes ? [p.text, ...p.quotes].join("\n") : p.text);
  const full = parts.map(render).join("\n");
  if (full.length <= BRIEF_MAX) return full;
  // Over the ceiling: every fixed line whole (each still capped, so one runaway line cannot starve the rest), then
  // the stretchable parts shrink together until the whole fits.
  const fixed = parts.filter((p) => !p.stretch && !p.quotes);
  for (const p of fixed) p.text = headTail(p.text, 900);
  const newlines = parts.length - 1 + parts.reduce((n, p) => n + (p.quotes ? p.quotes.length : 0), 0);
  const room = BRIEF_MAX - newlines - fixed.reduce((n, p) => n + p.text.length, 0);
  // Fair shares, smallest first: a part that needs less than its share keeps what it needs and leaves the rest to the
  // parts after it, so the room is used rather than split blindly.
  const want = (p) => (p.quotes ? p.text.length + p.quotes.reduce((n, q) => n + q.length, 0) : p.text.length);
  const stretchy = parts.filter((p) => p.stretch || p.quotes).sort((a, b) => want(a) - want(b));
  let left = Math.max(0, room);
  stretchy.forEach((p, i) => {
    const share = Math.max(60, Math.min(want(p), Math.floor(left / (stretchy.length - i))));
    left -= share;
    if (p.quotes) {
      // Every visitor keeps a line: the quotes split the share evenly, each kept head and tail.
      const per = Math.max(40, Math.floor((share - p.text.length) / p.quotes.length));
      p.quotes = p.quotes.map((q) => headTail(q, per));
    } else p.text = headTail(p.text, share);
  });
  return parts.map(render).join("\n").slice(0, BRIEF_MAX);
}
