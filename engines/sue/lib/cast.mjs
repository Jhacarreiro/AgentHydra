/**
 * Who visits a page: cast from the ask and the page, never drawn from a pool written for another product.
 *
 * A hearing on sullivanfantastic.com ("I'm a party planner looking for a live performer for a client's
 * bar mitzvah") sent Robert, a Tampa commercial real-estate broker from a WhatsApp deal group, and Tasha,
 * a house wholesaler: this workspace's saved Deal Flow people, with the party planner's words pasted
 * under "Why you are here" (runs 20260925-185445-29ca and 20260925-185450-21ed). The visitor an ask
 * names is that person; the others are the people the page is for.
 *
 * Two ways in. `castPrompt` and `CAST_SCHEMA` are what Dredd hands a model (dredd/lib/visitors.mjs),
 * and `castFromAnswer` turns its answer into persona documents, refusing a malformed visitor by name.
 * `castFromAsk` is the floor with no model at all: the one visitor the ask names, in its own words, on
 * three bodies. Either way a visitor is a whole persona document that a run carries inline (`cast`,
 * sue.mjs planRun): it borrows a roster body with `extends`, and its voice and errand are its own.
 */
import { listPersonas, loadPersona, mergePersona, validatePersona } from "./personas.mjs";
import { hostOfUrl } from "./site-owner.mjs";
import { slugFor } from "./workspace.mjs";

/** How many visitors a cast holds: a run of more Sues rotates them. */
export const CAST_MAX = 4;

/** The bodies the no-model floor puts the named visitor in: two desktops and a phone, all adults. */
/** An APE power user is comfortable with computers: techProwess 4 or 5 (lib/personas.mjs DIAL_NAMES). */
export const APE_MIN_TECH = 4;
const FLOOR_BODIES = ["elaine", "shop-owner", "bob"];

/** "I'm a party planner looking for...", "I am the owner of...", up to the end of that sentence. */
const SELF_DESCRIBED = /\b(?:I['’]m|I am)\s+((?:an?|the)\s+[^.;:!?\n]{3,200})/i;
/** "As a parent, I want...": the role up to the comma. */
const AS_A = /(?:^|[.!?]\s+)As\s+(an?\s+[^,.;:!?\n]{3,120})/;
/** "I'm a bit lost", "I'm a little confused": a state, not who she is. */
const NOT_A_ROLE = /^(?:an?|the)\s+(?:bit|little|lot|tad|while|moment|second|minute|few|huge|big|total|complete)\b/i;

/** First person into second: the ask is written as "I", her brief speaks to her as "you". */
export function secondPerson(text) {
  const swaps = [
    [/\bI['’]m\b/g, "you're"],
    [/\bI am\b/g, "you are"],
    [/\bI['’]ve\b/g, "you've"],
    [/\bI['’]d\b/g, "you'd"],
    [/\bI['’]ll\b/g, "you'll"],
    [/\bI\b/g, "you"],
    [/\bmyself\b/gi, "yourself"],
    [/\bmine\b/gi, "yours"],
    [/\bmy\b/gi, "your"],
    [/\bme\b/gi, "you"],
  ];
  return swaps.reduce((s, [from, to]) => s.replace(from, to), String(text ?? ""));
}

/** Who the ask says the visitor is, in the second person ("a party planner looking for ..."), or null. */
export function visitorFromAsk(ask) {
  const text = String(ask ?? "");
  const m = SELF_DESCRIBED.exec(text) ?? AS_A.exec(text);
  if (!m) return null;
  const role = m[1].trim().replace(/[,\s]+$/, "");
  if (NOT_A_ROLE.test(role) || role.split(/\s+/).length < 2) return null;
  return secondPerson(role);
}

/** The noun at the head of a role: "a party planner looking for ..." -> "party planner". */
function roleHead(role) {
  const head = String(role)
    .replace(/^(?:an?|the)\s+/i, "")
    .split(/\s+(?:looking|who|that|with|for|from|in|at|trying|planning|searching|wanting|hoping|about|of|and|but)\b|,/i)[0];
  return head.split(/\s+/).slice(0, 4).join(" ");
}

const title = (s) => String(s).replace(/\b\w/g, (c) => c.toUpperCase());

/** Every roster body but a critic's (her dials are an expert's reading speed and patience, not an ordinary visitor's). */
function rosterBodies(now) {
  return listPersonas()
    .map((id) => ({ id, p: loadPersona(id) }))
    .filter(({ p }) => p.critic !== true)
    .map(({ id, p }) => {
      const [from, to] = p.identity.birthYear;
      const age = now.getFullYear() - Math.round((from + to) / 2);
      return {
        id,
        age,
        firstName: p.identity.firstNames[0],
        device: p.dials.device,
        techProwess: p.dials.techProwess,
        patienceSeconds: p.dials.patienceSeconds,
        readingGrade: p.dials.readingGrade,
      };
    });
}

/** A roster body a visitor can borrow, as a model reads it. Adults only: a cast visitor is never a child. */
export function castBodies(now = new Date(), { ape = false } = {}) {
  return rosterBodies(now).filter((b) => b.age >= 18 && (!ape || b.techProwess >= APE_MIN_TECH));
}

/**
 * The roster's own children, who go as themselves when the ask says the visitors are kids. A model cast a kid onto an
 * adult body with a kid's errand: "Fifth Grader Maya, 19" on Lift, a learning app for 9 to 11 year olds (docket
 * 20260929-031805-044a).
 */
export function rosterChildren(now = new Date()) {
  return rosterBodies(now).filter((b) => b.age < 18);
}

/** Does the ask say the visitors are children: an age under 18, a school grade, or a word that only means a child? */
const CHILD_VISITORS =
  /\b(?:(?:kids?|children|students?|pupils?|learners?)\s+(?:aged?|ages)\s+(?:[4-9]|1[0-7])\b|(?:kids?|children|students?|pupils?)\s+in\s+grades?\s+[1-8]\b|(?:[4-9]|1[0-7])(?:\s*(?:to|-)\s*(?:[4-9]|1[0-7]))?[- ]year[- ]olds?\b|(?:first|second|third|fourth|fifth|sixth|seventh|eighth|[1-8](?:st|nd|rd|th))[- ]graders?\b|school ?(?:kids|children)\b|(?:elementary|primary|middle)[- ]school(?:ers| students| kids)\b|tweens?\b)/i;
export function childrenInAsk(ask) {
  return CHILD_VISITORS.test(String(ask ?? ""));
}

/** "You are Dana, 38," with the body's own age: the birthday she is minted falls in the body's years. */
const VOICE_OPENING = /^You are ([A-Z][A-Za-z'-]+), (\d{1,3}),/;

/**
 * One visitor as the persona document a run carries: her own voice and errand on a roster body, written
 * for this page's host only, and loadable exactly as a run will load it (or refused here, by name).
 */
export function castPersona({ id, displayName, body: named, voice, errand, host }) {
  const bodies = castBodies();
  // The prompt lists each body as "<id>: age 58, on a desktop, ...", and a model answering "the one
  // body below" copies that whole line back. The id is the part before the colon: matching the line
  // instead refused every visitor of a rAidiology hearing, bob and casual-cassie included
  // (docket 20261001-221501-0ac3), and the run went out with SUE's stock visitors.
  const body = String(named ?? "")
    .split(":")[0]
    .trim();
  const base = bodies.find((b) => b.id === body);
  if (!base) throw new Error(`body "${named}" is not an adult roster body: ${bodies.map((b) => b.id).join(", ")}`);
  const said = String(voice ?? "").trim();
  if (!VOICE_OPENING.test(said)) throw new Error(`voice must open "You are <FirstName>, <age>," (got "${said.slice(0, 40)}")`);
  const doc = {
    id,
    displayName: String(displayName ?? "").trim() || title(id.replace(/-/g, " ")),
    extends: body,
    voice: said.replace(VOICE_OPENING, (_m, name) => `You are ${name}, ${base.age},`),
    errands: [String(errand ?? "").trim()],
    ...(host ? { for: [host] } : {}),
  };
  const problems = validatePersona(mergePersona(loadPersona(body), doc));
  if (problems.length) throw new Error(problems.join("; "));
  return doc;
}

/** The ask's own sentences about why she came, in her voice: first-person ones only, a reviewer's "Review X:" lead-in dropped. */
function errandFromAsk(ask) {
  const sentences = String(ask ?? "")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.replace(/^[^:]{0,80}:\s*/, (lead) => (/\b(I|my|me)\b/.test(lead) ? lead : "")).trim())
    .filter((s) => /\b(I|I['’]m|my|me)\b/.test(s));
  const said = secondPerson(sentences.join(" "))
    .replace(/(^|[.!?]\s+)([a-z])/g, (_m, lead, c) => lead + c.toUpperCase())
    .slice(0, 300)
    .trim();
  return said.length >= 30 ? said : null;
}

/**
 * The floor with no model: the visitor the ask names, on up to three bodies, or null when it names
 * nobody. Her errand is the ask's own first-person sentences, turned to "you".
 */
export function castFromAsk(ask, { url = null, count = CAST_MAX, ape = false } = {}) {
  const role = visitorFromAsk(ask);
  if (!role) return null;
  const head = roleHead(role) || "visitor";
  const errand =
    errandFromAsk(ask) ?? `You are ${role}, and you want to find out whether this is what you need and how fast you can get it done.`;
  const host = hostOfUrl(url);
  const bodies = castBodies(undefined, { ape }).filter((b) => FLOOR_BODIES.includes(b.id));
  if (!bodies.length) return null;
  const n = Math.max(1, Math.min(count, CAST_MAX));
  return Array.from({ length: n }, (_, i) => bodies[i % bodies.length]).map((b, i) =>
    castPersona({
      id: slugFor(`${head}-${i + 1}`, 40),
      displayName: `${title(head)} ${i + 1}`,
      body: b.id,
      voice: `You are ${b.firstName}, ${b.age}, ${role}. You are practical and busy, and when something is unclear you say so plainly.`,
      errand,
      host,
    }),
  );
}

/** The answer a model returns for a cast. */
export const CAST_SCHEMA = {
  type: "object",
  required: ["visitors"],
  properties: {
    visitors: {
      type: "array",
      minItems: 1,
      maxItems: CAST_MAX,
      items: {
        type: "object",
        required: ["id", "displayName", "body", "voice", "errand"],
        properties: {
          id: { type: "string" },
          displayName: { type: "string" },
          body: { type: "string" },
          voice: { type: "string" },
          errand: { type: "string" },
          why: { type: "string" },
        },
      },
    },
  },
};

/**
 * What a model is told to cast: the ask, the page as fetched (or its absence), and the bodies it may use. `already` is
 * who pre-sue (lib/presue.mjs) found fitting and is sending anyway, `{ displayName, voice }` each: the model casts the
 * kinds of person still missing, never a second copy of one already going.
 */
export function castPrompt({ ask, url, page = null, count = CAST_MAX, already = [], ape = false, scope = null }) {
  const named = visitorFromAsk(ask);
  const bodies = castBodies(undefined, { ape })
    .map(
      (b) =>
        `- ${b.id}: age ${b.age}, on a ${b.device}, comfort with computers ${b.techProwess}/5, reads at grade ${b.readingGrade}, gives up after about ${b.patienceSeconds} seconds`,
    )
    .join("\n");
  const pageLines = page
    ? [
        `Title: ${page.title || "(none)"}`,
        `Description: ${page.description || "(none)"}`,
        page.headings?.length ? `Headings: ${page.headings.join(" | ")}` : null,
        `What the page says (the first words): ${page.text || "(nothing readable)"}`,
      ].filter(Boolean)
    : ["(The page could not be read, so go by the address and the ask.)"];
  const going = (Array.isArray(already) ? already : [])
    .filter((p) => p?.displayName || p?.voice)
    .map((p) => `- ${p.displayName || "(unnamed)"}: ${String(p.voice ?? "").slice(0, 200)}`);
  const system =
    "You cast the visitors for a usability visit to a website: real people who would really arrive at this page, each with their own reason. Never a tester, a reviewer, a critic, a designer or anyone who works for the website. Answer with JSON only.";
  const prompt = [
    "What the person who asked for this visit wrote:",
    String(ask ?? "").trim(),
    "",
    `The page: ${url}`,
    ...pageLines,
    // A field run's scope (lib/field.mjs): what kind of product Jev read this as, so the cast are its real visitors.
    ...(scope ? [`What kind of product this is: ${String(scope).trim()}`] : []),
    "",
    `Cast ${count}${going.length ? " more" : ""} visitor${count === 1 ? "" : "s"} who would really come to this page.`,
    named
      ? `- The ask says who the visitor is (${named}). ${going.length ? "Unless one of the people already going is that person, the" : "The"} first visitor is exactly that person.`
      : "- The ask does not say who the visitor is. Cast the people this page is for, going by the page and the ask.",
    "- The others are different people this page is for, going by the page and the ask. Each one a different kind of person, with a different reason.",
    "- Nobody from an unrelated world: every visitor's life and reason fit this page and this ask.",
    ...(ape
      ? [
          "- This is a power-user visit: every visitor uses this kind of thing every day, is comfortable with computers (4 or 5 out of 5, the only bodies listed), and expects it to work the way it should.",
        ]
      : []),
    ...(going.length
      ? [
          "- These people already fit this page and are going. Cast only the kinds of person still missing: nobody with the same job, role or reason as one of them.",
          ...going,
        ]
      : []),
    "",
    "For each visitor give:",
    '- id: a short slug of 2 or 3 lower-case words joined by hyphens, naming who they are (e.g. "party-planner-dana").',
    '- displayName: 2 to 4 words (e.g. "Party Planner Dana").',
    "- body: the id (the word before the colon) of the one body below closest to this person's age and to the device they would really use.",
    '- voice: who they are, speaking to them as "you", 2 to 4 sentences. Open with exactly "You are <FirstName>, <age>," using the age of the body you chose. Say what they do and how they behave online. Do not say why they are on this page and do not name the website: that goes in errand.',
    '- errand: why they are on this page today, speaking to them as "you", 1 or 2 sentences in their own everyday words (30 to 300 characters). What they want to get done, never a request to review or rate the site.',
    "- why: one short line on why this person really visits this page.",
    "",
    "The bodies:",
    bodies,
  ].join("\n");
  return { system, prompt };
}

/**
 * A model's cast as persona documents: `{ visitors, refused }`, each visitor loadable as a run loads it,
 * each refused one named with why. Ids are made unique; a repeated one gets a number, and so does one that
 * is a roster persona's id: a model that names a visitor after her body ("dev-dan" on the dev-dan body)
 * got the whole run refused by sue.mjs's castDocs (app.example.net hearing, 2026-09-26). `taken` adds ids a
 * visitor may not have either: pre-sue saves its visitors to the workspace, where a reused id would overwrite her.
 */
export function castFromAnswer(data, { url = null, taken: alsoTaken = [] } = {}) {
  const host = hostOfUrl(url);
  const visitors = [];
  const refused = [];
  const taken = new Set([...listPersonas(), ...alsoTaken]);
  for (const v of Array.isArray(data?.visitors) ? data.visitors.slice(0, CAST_MAX) : []) {
    let id = slugFor(v?.id || v?.displayName || "", 40);
    if (!id) {
      refused.push({ id: String(v?.id ?? ""), why: "no id" });
      continue;
    }
    const stem = id.slice(0, 36);
    for (let n = 2; taken.has(id); n++) id = slugFor(`${stem}-${n}`, 40);
    try {
      visitors.push(castPersona({ id, displayName: v.displayName, body: v.body, voice: v.voice, errand: v.errand, host }));
      taken.add(id);
    } catch (err) {
      refused.push({ id, why: String(err?.message ?? err).slice(0, 200) });
    }
  }
  return { visitors, refused };
}
