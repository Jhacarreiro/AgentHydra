/**
 * personas - the roster, the targets, the scenarios, and the two prompts a Sue is handed.
 * ======================================================================================
 *
 * WHAT: holds the people this process fetched from Connections (`installPeople`) and VALIDATES each one
 * as it loads (`loadPersona`); loads `targets/<id>.json` and `scenarios/<id>.json`;
 * draws seeded SAMPLED personas from word lists (`synthesizePersona`, the cannon's `--sampled N`);
 * mints a Sue's identity deterministically from a seed; renders her system prompt (who she is, in
 * WORDS ONLY) and her scenario prompt (the task, with her real address where the task needs it).
 *
 * WHY IT EXISTS: `sue/SPEC.md` says every number a persona carries changes something
 * mechanical, and that the brain NEVER sees those numbers. So the dials go to the body
 * (`lib/perception.mjs`, `lib/clock.mjs`) and only the voice goes to the brain, and the one place
 * that split is enforced is here: `buildBrainSystemPrompt` reads `persona.voice`, never
 * `persona.dials`. A persona whose dial is missing is refused at load, because a missing dial would
 * silently become "unlimited" in the body and the persona would turn into theatre.
 *
 * The identity is minted from a seed rather than `Math.random` so a rerun of the same run id and
 * Sue number produces the same name and birthday, which is what lets the reaper and the report
 * name the same person the cannon did.
 *
 * WHO DEPENDS ON IT: `cannon.mjs`, `reap.mjs`, `body.mjs` (reads the loaded persona/target/scenario
 * objects the cannon put in `sue.json`; it never reloads by id), `tests/personas.spec.mjs`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Relative, not by package name: the engine snapshot carries relative imports, and a package name would
// resolve to the checkout's live copy instead (engine-store.spec, "no engine file reaches ... through a package name").
// Core's dist/ mirror, not its src/: Sue and Dredd run under plain `node`, which is what that tracked mirror
// (the package's `node` export condition, freshness-gated by build-node.spec) exists for.
import { usableTimeZone } from "../../lib/shared/browser-timezone.js";
import { SUE_DEFAULT_MODEL } from "./claude-cli.mjs";
import {
  AD_QUESTIONS,
  APE_QUESTIONS,
  ART_QUESTIONS,
  INTERVIEW_KEYS,
  INTERVIEW_OPTIONAL_KEYS,
  interviewExtras,
  interviewKeys,
  isAdScenario,
  isApeScenario,
  JUDGING_KEYS,
  judgesScreens,
  urlAllowed,
} from "./findings.mjs";
import { isLiveSite } from "./site-owner.mjs";
import { isMainModule } from "../../lib/shared/is-main.mjs";

const SUE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const DIAL_NAMES = [
  "readingGrade",
  "wordsPerLook",
  "wordsPerMinute",
  "legibleMinPx",
  "techProwess",
  "attentionSeconds",
  "patienceSeconds",
  "temperature",
  "device",
  "maxTurns",
  "network",
  "timezone",
];

/** Dials a persona may leave out: `network` then means "fast", `timezone` this machine's own zone. */
export const OPTIONAL_DIALS = new Set(["network", "timezone"]);

/** The three names `dials.network` may hold. Absent means "fast": no throttling, Playwright's default. */
export const NETWORK_NAMES = ["fast", "4g", "slow-3g"];

/**
 * Numeric bounds for the dials that are not simply "must be a number" - refused BY NAME at load,
 * never clamped (P27, a proposal built from a review of MiroFish: a persona saved with
 * `patienceSeconds: 0` gave up on every visit and the report filed that as the page's fault, not
 * SUE's). `wordsPerMinute`, `readingGrade` and `legibleMinPx` are the current roster's own min and
 * max - the 20 shipped personas, game players included - so nothing already shipped ever fails to
 * load; widen the constant here the day a real persona needs to sit outside it. `temperature`
 * keeps its documented domain (`lib/clock.mjs`: "0.0-1.0") rather than the narrower roster range,
 * because that bound is fixed by what the clock does with the number, not by who happens to be on
 * the roster today. `maxTurns` keeps its existing floor of 1 and adds the roster's ceiling.
 * `attentionSeconds`/`patienceSeconds` (must be above 0, and attention may never outrun patience)
 * and `wordsPerLook` (0 or more) are checked separately below: a floor, not a roster-shaped range.
 */
const DIAL_RANGES = { wordsPerMinute: [80, 350], readingGrade: [3, 14], legibleMinPx: [10, 18], temperature: [0, 1], maxTurns: [1, 120] };

/**
 * A phrase that bakes WHY she is here into a roster voice - her reason belongs in `errands`, which
 * an intent run or a product's own errands replace whole (P24: a proposal built from a review of
 * MiroFish). A heuristic on purpose: it runs only against a plain roster load (`loadPersona`'s
 * `roster` flag below), never against an `extends` persona or a product's own persona file, either
 * of which may name its own product freely.
 */
const SITE_IN_VOICE = /\bthis website\b|\bthis site\b|\bon here\b/i;

/**
 * A critic's MIND: the knowledge her brain is handed whole, under "What you know" (Owner, 2026-09-27: a
 * Sue "trained on all of the top scientific papers ... whose only job is to go through our platforms and
 * say a user would drop off here"). It lives in Connections, never in a repo (Owner, 2026-09-28, asking
 * why two 150 KB minds sat in GitHub): the critic is a workspace Sue person, and her mind is that
 * Boardroom row's playbook. The process that starts a run fetches it through the Boardroom's sue/mind door
 * (lib/people.mjs `fetchPeople`) and installs it here in memory (`installPeople`), and a run pins the text
 * inline as `target.minds[id]` when it starts (`pinCriticMinds`), so one wave reads one mind. The loader
 * and the brief read only `target.minds`: a critic with none, or one over the cap, refuses the run before
 * a Sue number is spent. The cap keeps one mind from swamping the brief: a CLI brain's system prompt and a
 * chat brain's brief carry it all.
 */
export const MIND_MAX_BYTES = 160_000;

/**
 * EVERY PERSON COMES FROM CONNECTIONS, never from a file (Owner, 2026-09-28: "There should not be a single
 * local personality in the workspace. They all should be stored in Connections. Not because they have to
 * ... but because Connections is obviously superior."). A Sue person is a Boardroom persona: the built-in
 * roster (the Boardroom's built_in rows) and this workspace's own people, answered together by one free
 * call to the Sue list (lib/people.mjs). A process installs that answer here ONCE, before it loads anybody,
 * and holds it in memory only. A workspace person with a built-in's id is the one sent: that is how a
 * built-in is edited. `extends` still borrows a BUILT-IN body.
 */
const OWN_PEOPLE = new Map();
const BUILT_IN_PEOPLE = new Map();
const MINDS = new Map();
let peopleInstalled = false;

/**
 * Install the people this process may send: `list` is the Sue list's answer (`{ doc, builtIn? }` per
 * person), `minds` the critics' minds by id. Replaces whatever was installed before.
 */
export function installPeople(list, { minds = {} } = {}) {
  OWN_PEOPLE.clear();
  BUILT_IN_PEOPLE.clear();
  MINDS.clear();
  for (const item of Array.isArray(list) ? list : []) {
    const doc = item?.doc;
    if (!doc || typeof doc.id !== "string" || !SLUG.test(doc.id)) continue;
    (item.builtIn === true ? BUILT_IN_PEOPLE : OWN_PEOPLE).set(doc.id, doc);
  }
  for (const [id, text] of Object.entries(minds ?? {})) if (typeof text === "string" && text.trim()) MINDS.set(id, text);
  peopleInstalled = true;
}

/** Whether this process has fetched its people yet. */
export function peopleAreInstalled() {
  return peopleInstalled;
}

/**
 * The installed people as the Sue list answered them, for handing to another process: the workspace's own people (only
 * the ones named in `ids` when it is given) and EVERY built-in, since a visitor cast for one page, a sampled one and a
 * workspace person all borrow a body from one and the roster is small. `minds` holds the named people's minds.
 */
export function installedPeople(ids = null) {
  const want = ids ? new Set(ids) : null;
  const own = [...OWN_PEOPLE.values()].filter((doc) => !want || want.has(doc.id)).map((doc) => ({ doc }));
  const builtIns = [...BUILT_IN_PEOPLE.values()].map((doc) => ({ doc, builtIn: true }));
  const minds = Object.fromEntries([...MINDS].filter(([id]) => !want || want.has(id)));
  return { people: [...own, ...builtIns], minds };
}

/** This workspace's own people (never a built-in), whole, by id. */
export function ownPeople() {
  return [...OWN_PEOPLE.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** Built-in person `id` as Connections holds her, a copy, or null: never a workspace's copy of her. */
export function builtInPerson(id) {
  const doc = BUILT_IN_PEOPLE.get(id);
  return doc ? structuredClone(doc) : null;
}

/** Person `id` as a run sends her (her workspace copy, else the built-in), a copy, or null. Dredd's seats speak as her
 *  by this too, so a repo's own seat can be a person saved to its workspace (lib/seats.mjs loadSeats). */
export function personDoc(id) {
  const doc = OWN_PEOPLE.get(id) ?? BUILT_IN_PEOPLE.get(id);
  return doc ? structuredClone(doc) : null;
}

/**
 * A person's comfort with computers (techProwess, 1 to 5) read from the raw documents only: her own dials, else the
 * body she `extends`, else null. `docs` are cast visitors not yet saved. Never loads or validates anyone, so a person
 * who could not be loaded (her mind is not in this run) still answers; null reads as "not a power user".
 */
export function techProwessOf(id, docs = [], depth = 0) {
  const doc = docs.find((p) => p?.id === id) ?? personDoc(id);
  const own = Number(doc?.dials?.techProwess);
  if (Number.isFinite(own) && own > 0) return own;
  return doc?.extends && doc.extends !== id && depth < 4 ? techProwessOf(doc.extends, docs, depth + 1) : null;
}

/**
 * The people a run would send, whole, each as `personDoc` picks her (the workspace's copy over a built-in of the same
 * id): `{ people: [{ id, doc, builtIn }], missing }`. `ids` narrows, and a name nobody answers to is in `missing`, never
 * dropped quietly. For a caller that binds a record to exactly who a run sends: MonkeyWerx's panel freezes hash these
 * docs, since no copy of a person is kept in its folder (Owner, 2026-09-28).
 */
export function sentPeople(ids = null) {
  if (!peopleInstalled) throw new Error("no people were fetched from Connections in this process, so there is nobody to answer");
  const names = Array.isArray(ids) ? ids : [...new Set([...OWN_PEOPLE.keys(), ...BUILT_IN_PEOPLE.keys()])].sort();
  const people = [];
  const missing = [];
  for (const id of names) {
    const doc = personDoc(id);
    if (doc) people.push({ id, doc, builtIn: !OWN_PEOPLE.has(id) });
    else missing.push(id);
  }
  return { people, missing };
}

/** Person `id`, or a refusal that names who IS there. `builtIn` asks for a built-in body (`extends`). */
function readPerson(id, { builtIn = false } = {}) {
  if (typeof id !== "string" || !SLUG.test(id)) throw new Error(`persona id must be a slug, got ${JSON.stringify(id)}`);
  if (!peopleInstalled)
    throw new Error(
      `no people were fetched from Connections in this process, so "${id}" cannot load: whoever starts SUE hands them over (lib/people.mjs fetchPeople)`,
    );
  const found = builtIn ? BUILT_IN_PEOPLE.get(id) : null;
  const doc = builtIn ? (found ? structuredClone(found) : null) : personDoc(id);
  if (!doc)
    throw new Error(
      `no ${builtIn ? "built-in " : ""}person "${id}" in Connections: this workspace's people are ${[...OWN_PEOPLE.keys()].sort().join(", ") || "none"}; the built-ins are ${[...BUILT_IN_PEOPLE.keys()].sort().join(", ") || "none"}`,
    );
  return doc;
}

/** Her mind's text for the prompt, as this run pinned it (`target.minds`), or null when she carries none. */
export function mindText(persona, target) {
  const minds = target?.minds;
  const text = minds && typeof minds === "object" && Object.hasOwn(minds, persona?.id) ? minds[persona.id] : null;
  return typeof text === "string" && text.trim() ? text.replace(/^\uFEFF/, "").trim() : null;
}

/** Why her pinned mind cannot go, or null: a critic needs one, and nobody carries one over the cap. */
function mindProblem(p, target) {
  const text = mindText(p, target);
  if (!text && p.critic === true)
    return (
      `her mind lives in Connections, as her playbook, and this run has none: send one with ` +
      `node sue/mind.mjs push ${p.id} <file.md>`
    );
  if (text && Buffer.byteLength(text, "utf8") > MIND_MAX_BYTES)
    return `her mind is over ${MIND_MAX_BYTES} bytes: cut her playbook in Connections, she carries it whole`;
  return null;
}

/** A person's document as this run would send her (a cast visitor rides on the target), or null. */
function personaDocOf(id, target) {
  if (target?.cast && Object.hasOwn(target.cast, id)) return target.cast[id];
  if (typeof id !== "string" || !SLUG.test(id)) return null;
  return personDoc(id);
}

/** Whether person `id`, as `target` would load her (its cast, then the installed people), is a critic. */
export function isCriticPersona(id, target) {
  return personaDocOf(id, target)?.critic === true;
}

/** The engine's default design team (sue/README.md#art), in the order the report lists them. */
export const ART_TEAM = Object.freeze(["art-mobile", "art-ux", "art-visual"]);

/** An ART designer: a critic whose `studio` is "art" (her diary is ART_DIARY, her questions ART_QUESTIONS). */
export const isArtPersona = (p) => p?.critic === true && p?.studio === "art";

/** Whether person `id`, as `target` would load her, is an ART designer. */
export function isArtPersonaId(id, target = null) {
  return isArtPersona(personaDocOf(id, target));
}

/**
 * Pin the minds of the critics among `ids` onto `target.minds`, from the minds this process fetched with its
 * people, ONCE, at a run's start. A mind the target already carries inline is kept. A critic with no mind is
 * left out, and the loader refuses her in words that say where her mind comes from. Returns `target`.
 */
export function pinCriticMinds(target, ids) {
  const minds = target.minds && typeof target.minds === "object" ? { ...target.minds } : {};
  for (const id of ids ?? []) {
    if (Object.hasOwn(minds, id) || !isCriticPersona(id, target)) continue;
    if (MINDS.has(id)) minds[id] = MINDS.get(id);
  }
  if (Object.keys(minds).length) target.minds = minds;
  else delete target.minds;
  return target;
}

/**
 * The scenario she is handed, with her persona's own exit-interview questions (`persona.interview`,
 * `{ key: question }`) folded under the scenario's: a critic persona carries the questions her job
 * asks on every page she is sent to, and the scenario's own wording wins for a key both ask. The
 * cannon writes this into `sue.json`, so her tools, her prompt and the report read one list.
 */
export function withPersonaQuestions(scenario, persona) {
  // An ART designer also answers the team's shared questions (ART_QUESTIONS), which win over her own wording of a key.
  const own = isArtPersona(persona) ? { ...persona.interview, ...ART_QUESTIONS } : persona?.interview;
  if (!own || typeof own !== "object" || Array.isArray(own) || !Object.keys(own).length) return scenario;
  const asked =
    scenario?.interview && typeof scenario.interview === "object" && !Array.isArray(scenario.interview) ? scenario.interview : {};
  return { ...scenario, interview: { ...own, ...asked } };
}

/**
 * CDP `Network.emulateNetworkConditions` args for a dial's `network` name, or `null` for "fast"
 * (no throttling - `body.mjs` then skips the CDP call entirely). Numbers are puppeteer-core's
 * DevTools-aligned presets (node_modules/puppeteer-core/src/cdp/PredefinedNetworkConditions.ts):
 * 'Fast 4G' is latency 60*2.75=165ms, download (9e6/8)*0.9=1012500 B/s, upload (1.5e6/8)*0.9=168750 B/s;
 * 'Slow 3G' is latency 400*5=2000ms, download and upload (500e3/8)*0.8=50000 B/s each. A pure
 * function so it can be unit-tested without a browser (tests/personas.spec.mjs).
 */
export function networkConditionsFor(persona) {
  const name = persona?.dials?.network ?? "fast";
  if (name === "4g") return { latency: 165, downloadThroughput: 1012500, uploadThroughput: 168750 };
  if (name === "slow-3g") return { latency: 2000, downloadThroughput: 50000, uploadThroughput: 50000 };
  return null;
}

/**
 * The IANA zone her browser keeps (`timezoneId` in body.mjs), or `null` for this machine's own. Grandma
 * lives in Ohio and read "7:32 am cdt" off an events page because every Sue kept the PC's clock
 * (run 20260926-072035-79a3).
 */
export function timezoneFor(persona) {
  return persona?.dials?.timezone ?? null;
}

// The interview keys live in ONE place, `findings.mjs` - which is also what shapes the answers, so
// the prompt below and the shaper cannot drift. Re-exported here because this module is what every
// prompt-side caller already imports.
export { INTERVIEW_KEYS };

/** The body's tool table from SPEC.md, one line each, in the words the brain is given. */
export const TOOL_LINES = [
  ["look", "look at the screen: you get a picture and the words you can make out, with numbered things you could click"],
  [
    "click",
    "click a numbered thing from your last look, or the first thing whose words match; you can also double-click it, right-click it, rest the pointer on it without clicking, or drag it onto another numbered thing",
  ],
  [
    "type",
    "type into a numbered box. For one of your own details give its name as field, never as text (the box's number as target, my-email as field) and your hands fill in the real one: my-email, my-phone, my-first-name, my-last-name, my-full-name, my-birthday, the-code-from-my-email",
  ],
  [
    "attach",
    "put one of your own files into the page: say which of your files, and the numbered thing that opens a window to pick a file (an upload button, a file box, a drop area)",
  ],
  [
    "press",
    "press a key, with Ctrl, Shift or Alt in front if you hold it: Enter, Tab, E, Ctrl+A, Shift+Tab, Escape, Space.",
  ],
  [
    "point",
    "point at a spot in your last picture, for what is drawn there or has no number: click, double-click, right-click, hold (press and hold, a long-press on a phone), hold-right-click, drag or right-drag it somewhere, zoom-in, zoom-out, or hover. holdMs (milliseconds) keeps a hold down that long",
  ],
  ["scroll", "scroll down, up, or back to the top"],
  ["go_back", "go back one page"],
  ["go_forward", "go forward again after going back"],
  ["reload", "reload the page"],
  [
    "go_to",
    "type a web address into the address bar and go there; only an address you have seen written on a page or in an email, or a website's front door by its name",
  ],
  ["tabs", "see the tabs you have open by their titles, switch to one, or close one"],
  ["rotate", "turn your phone sideways, or back upright"],
  ["wait", "wait for something to happen; say how many seconds, up to thirty"],
  ["check_email", "open your own email inbox and see what has arrived, each with its number"],
  ["open_email", "open one email by its number, the way it really looks, in your Mail tab"],
  ["judge_email", "say what you honestly thought of an email you opened"],
  [
    "note",
    "write a line in your diary: confusion, annoyance, delight, broken, question, thought, drop (the moment you would look away or leave) or hook (the moment something grabbed you)",
  ],
  ["give_up", "leave the website because you are done trying; say why"],
  ["done", "say you finished what you came to do"],
  ["exit_interview", "answer the exit interview; this is how your visit ends"],
];

/** Hands only a phone has: a desktop Sue is neither served them (body.mjs `toolSpecs`) nor told of them. */
export const PHONE_ONLY_TOOLS = new Set(["rotate"]);

/**
 * What a game adds to a tool's words: holding keys and a finger to move a character. Told only on a canvas
 * target, since a website's Sue never walks a character and her brief is re-sent on every turn; the tool
 * schemas (body.mjs `toolSpecs`) still say it to every Sue.
 */
export const GAME_TOOL_CLAUSES = new Map([
  [
    "press",
    ' A tap moves a game\'s character for one frame, so to move in a game hold the key: press D with holdMs set to a second or so (in milliseconds, up to five seconds) walks right for about that long, and keys ["D", "Space"] with holdMs holds several together',
  ],
  ["point", ", or keeps a drag held on its last spot, so an on-screen joystick can be held in a direction"],
]);

/**
 * The table a Sue is given. Every target gets the same hands, canvas or not (body.mjs `toolSpecs`,
 * Owner 2026-09-21): the whole keyboard, the pointer, the address bar and her tabs. Only the device
 * changes which hands: a phone can be turned sideways, a computer cannot. A canvas target adds the
 * game words to the hands a game needs held.
 */
export function toolLinesFor(device, { canvas = false } = {}) {
  return TOOL_LINES.filter(([name]) => device !== "desktop" || !PHONE_ONLY_TOOLS.has(name)).map(([name, line]) =>
    canvas && GAME_TOOL_CLAUSES.has(name) ? [name, line + GAME_TOOL_CLAUSES.get(name)] : [name, line],
  );
}

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** A JSON file as Windows PowerShell 5.1 writes it too: `Set-Content -Encoding utf8` leads with a BOM. */
const parseJsonFile = (file) => JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, ""));

/**
 * `home` is a target's own directory (set by `loadTarget` when the target was named by PATH): a
 * product keeps its scenarios beside its target file, in `<home>/scenarios/`, and those win over the
 * roster's. Its people are in Connections like everyone's (`installPeople`). That is how another repo points SUE at
 * itself without copying SUE (Owner, 2026-09-21: "you will not copy Sue to this workspace, you will
 * merely use Sue").
 */
function readJson(dir, id, what, { home } = {}) {
  if (typeof id !== "string" || !SLUG.test(id)) throw new Error(`${what} id must be a slug, got ${JSON.stringify(id)}`);
  const candidates = [home ? path.join(home, dir, `${id}.json`) : null, path.join(SUE_ROOT, dir, `${id}.json`)].filter(Boolean);
  const file = candidates.find((f) => fs.existsSync(f));
  if (!file) throw new Error(`no ${what} "${id}" at ${candidates.join(" or ")}`);
  const parsed = parseJsonFile(file);
  if (parsed.id !== id) throw new Error(`${what} file ${file} says id "${parsed.id}", expected "${id}"`);
  return parsed;
}

/** A target ref is a PATH when it names a file (it has a separator or ends in .json); else a roster slug. */
export function isPathRef(ref) {
  return typeof ref === "string" && (/[\\/]/.test(ref) || ref.toLowerCase().endsWith(".json"));
}

/** The built-in roster's ids, as Connections holds it. */
export function listPersonas() {
  if (!peopleInstalled) throw new Error("no people were fetched from Connections in this process, so there is no roster to list");
  return [...BUILT_IN_PEOPLE.keys()].sort();
}

/** A roster persona's portrait (`personas/portraits/<id>.webp`, a painted card; its prompt is in that folder's credits.json), or null. */
export function personPortraitFile(id, root = SUE_ROOT) {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(String(id ?? ""))) return null;
  const file = path.join(root, "personas", "portraits", `${id}.webp`);
  return fs.existsSync(file) ? file : null;
}

function isTimeZone(zone) {
  return typeof zone === "string" && zone.includes("/") && usableTimeZone(zone) !== "";
}

export function validatePersona(p, { roster = false } = {}) {
  const problems = [];
  if (!p.displayName) problems.push("displayName missing");
  if (typeof p.voice !== "string" || p.voice.trim().length < 40) problems.push("voice must be a paragraph of words");
  if (roster && typeof p.voice === "string" && SITE_IN_VOICE.test(p.voice))
    problems.push('a roster voice may not say why she is here ("this website", "this site" or "on here"): that belongs in errands');
  // Errands are REQUIRED, same reasoning as the dials: a persona with no reason to be on the site
  // behaves like an assistant asked to review it, and that is theatre rather than a visit.
  if (!Array.isArray(p.errands) || !p.errands.length)
    problems.push("errands missing: a persona needs at least one reason to be on the site");
  else if (p.errands.some((e) => typeof e !== "string" || e.trim().length < 30))
    problems.push("every errand must be a sentence or two in her own voice");
  if (!p.dials || typeof p.dials !== "object") problems.push("dials missing");
  else {
    for (const d of DIAL_NAMES) {
      if (OPTIONAL_DIALS.has(d)) continue; // optional: absent is never a missing-dial problem
      if (!(d in p.dials)) problems.push(`dial ${d} missing`);
    }
    for (const d of DIAL_NAMES) {
      if (d === "device" || OPTIONAL_DIALS.has(d)) continue;
      if (d in p.dials && typeof p.dials[d] !== "number") problems.push(`dial ${d} must be a number`);
    }
    if ("device" in p.dials && !["phone", "desktop"].includes(p.dials.device)) problems.push("device must be phone or desktop");
    if ("network" in p.dials && !NETWORK_NAMES.includes(p.dials.network))
      problems.push(`network must be one of ${NETWORK_NAMES.join(", ")}`);
    if ("timezone" in p.dials && !isTimeZone(p.dials.timezone)) problems.push("timezone must be an IANA zone like America/New_York");
    if (typeof p.dials.techProwess === "number" && (p.dials.techProwess < 1 || p.dials.techProwess > 5))
      problems.push("techProwess is 1-5");
    // Bounds a body-driven clock actually breaks on, refused by name rather than clamped (P27).
    if (typeof p.dials.attentionSeconds === "number" && p.dials.attentionSeconds <= 0) problems.push("attentionSeconds must be above 0");
    if (typeof p.dials.patienceSeconds === "number" && p.dials.patienceSeconds <= 0) problems.push("patienceSeconds must be above 0");
    if (
      typeof p.dials.attentionSeconds === "number" &&
      typeof p.dials.patienceSeconds === "number" &&
      p.dials.attentionSeconds > p.dials.patienceSeconds
    )
      problems.push("attentionSeconds must not exceed patienceSeconds");
    if (typeof p.dials.wordsPerLook === "number" && p.dials.wordsPerLook < 0) problems.push("wordsPerLook must be 0 or more");
    for (const [dial, [min, max]] of Object.entries(DIAL_RANGES)) {
      const v = p.dials[dial];
      if (typeof v === "number" && (v < min || v > max)) problems.push(`${dial} must be ${min}-${max}`);
    }
  }
  // A critic persona's two optional fields (see `withPersonaQuestions` and the critic brief in
  // `buildBrainSystemPrompt`): the switch, and her own interview questions. Her mind is not a field:
  // it is her playbook in Connections, pinned on the target by the run (`pinCriticMinds`).
  if (p.mind !== undefined)
    problems.push(
      "a persona no longer names a mind: minds live in Connections as the person's playbook (node sue/mind.mjs push <id> <file.md>), so drop the mind key",
    );
  if (p.critic !== undefined && typeof p.critic !== "boolean") problems.push("critic must be true or false");
  if (p.critic === true && p.interview === undefined)
    problems.push("a critic needs an interview: the questions her job asks on every page she is sent to");
  // ART (Aesthetic Review Team): the one studio is "art", and a designer is a critic, so a studio without critic is refused.
  if (p.studio !== undefined && p.studio !== "art") problems.push(`studio, when set, is "art" (got ${JSON.stringify(p.studio)})`);
  if (p.studio !== undefined && p.critic !== true) problems.push('studio "art" needs critic: true: a designer is a critic who walks the product');
  if (p.interview !== undefined) {
    const asked = p.interview && typeof p.interview === "object" && !Array.isArray(p.interview) ? Object.keys(p.interview) : null;
    const kept = asked ? interviewExtras({ interview: p.interview }).map(([key]) => key) : [];
    if (!asked) problems.push("interview must be an object of { key: question }");
    else
      for (const key of asked.filter((k) => !kept.includes(k)))
        problems.push(`interview key "${key}" is a standard key, not a camelCase word, or has no question`);
  }
  // `model` is optional: unset thinks with SUE_DEFAULT_MODEL (loadPersona fills it in).
  if (p.model !== undefined && (typeof p.model !== "string" || !p.model.trim())) problems.push("model, when set, must name a model");
  else if (/haiku/i.test(p.model || "")) problems.push("model may never be haiku (owner rule)");
  const id = p.identity;
  if (!id || !Array.isArray(id.firstNames) || !id.firstNames.length) problems.push("identity.firstNames missing");
  if (!id || !Array.isArray(id.lastNames) || !id.lastNames.length) problems.push("identity.lastNames missing");
  if (!id || !Array.isArray(id.birthYear) || id.birthYear.length !== 2 || id.birthYear[0] > id.birthYear[1])
    problems.push("identity.birthYear must be [from, to]");
  return problems;
}

/**
 * `extends` borrows a ROSTER persona's BODY - dials, identity ranges, model - and nothing else. The
 * voice and the errands must be the persona's own, because both are about a product: the roster's
 * were written for an events site, and a Discord admin who "wants to find something to do near
 * her" is theatre. An own `dials` object overrides the base dial by dial.
 */
export function mergePersona(base, own, { override = false } = {}) {
  const { extends: from, ...rest } = own;
  // A critic's brief and questions are what she knows, not her body: a visitor built on her body stays a
  // visitor unless she says she is a critic herself.
  const { critic: _critic, interview: _interview, studio: _studio, ...body } = base;
  const merged = { ...body, ...rest, dials: { ...(base.dials || {}), ...(own.dials || {}) }, extendsFrom: from };
  // A workspace's copy of a built-in (`override`: her `extends` is her own id) holds only what the workspace changed,
  // so her voice and errands are the built-in's until she names her own. Anyone else is her own person on a borrowed body.
  merged.voice = override ? own.voice || base.voice : own.voice;
  merged.errands = override ? (own.errands ?? base.errands) : own.errands;
  merged.identity = own.identity || base.identity;
  merged.model = own.model || base.model;
  return merged;
}

/**
 * A persona by id, as `target` sees it: its cast first, then the people installed from Connections, with
 * `extends` resolved against the built-ins, and `target.errands[id]` - the product's reasons for a
 * roster persona to be there - replacing her own. Without `target` this is the plain roster load.
 * A persona that names no model, own or borrowed, comes back with SUE_DEFAULT_MODEL.
 */
export function loadPersona(id, { target } = {}) {
  // A visitor cast for this page from the ask (lib/cast.mjs) rides inline on the target as `cast`,
  // never in a personas folder: she was written for one ask on one page, not saved as this
  // workspace's people.
  const cast = target?.cast && Object.hasOwn(target.cast, id) ? target.cast[id] : null;
  if (cast && cast.id !== id) throw new Error(`target cast "${id}" says id "${cast.id}"`);
  // Built-in only, for the "no site name in the voice" rule: a workspace's own person, one cast for its
  // page, or one built with `extends` speaks in a voice the product wrote, and may name itself freely -
  // only a plain built-in is held to "who she is, never why she is here".
  const fromProductHome = Boolean(cast) || OWN_PEOPLE.has(id);
  let p = cast ? { ...cast } : readPerson(id);
  const usesExtends = Boolean(p.extends);
  if (p.extends) {
    // `extends` naming her own id is a workspace's copy of that built-in (lib/workspace.mjs editPersona): only a copy
    // may say it, and every field she does not hold follows the built-in as Connections has it now.
    const override = p.extends === id && (Boolean(cast) || OWN_PEOPLE.has(id));
    if (typeof p.extends !== "string" || (p.extends === id && !override))
      throw new Error(`persona "${id}": extends must name a different roster persona`);
    p = mergePersona(readPerson(p.extends, { builtIn: true }), p, { override });
  }
  const productErrands = target?.errands?.[id];
  if (Array.isArray(productErrands) && productErrands.length) p = { ...p, errands: productErrands };
  const problems = validatePersona(p, { roster: !fromProductHome && !usesExtends });
  const mindWrong = mindProblem(p, target);
  if (mindWrong) problems.push(mindWrong);
  if (problems.length) throw new Error(`persona "${id}" is invalid: ${problems.join("; ")}`);
  return p.model ? p : { ...p, model: SUE_DEFAULT_MODEL };
}

/**
 * SAMPLED PERSONAS - a visitor drawn from lists instead of read from a file.
 *
 * WHY: the roster is 20 hand-written people, so a wave only ever tests those 20 combinations of
 * reading grade, tech prowess, device and patience; a confusion that only a slow-3G phone user with
 * a grade-6 reading level and no patience hits goes unnoticed if nobody on the roster is that
 * person. The idea is adapted from dair-ai/Prompt-Engineering-Guide's "generating textbooks" page
 * (MIT): sample a few attributes from fixed lists into each generation so the output does not
 * collapse into sameness. Here the attributes are SUE's dials, an occupation, errands and quirks.
 *
 * Every draw comes from the same seeded stream `mintIdentity` uses, so one seed is one person, on
 * every rerun. The dials are drawn from values the roster itself uses (and inside DIAL_RANGES), and
 * the voice DESCRIBES the dials in words, because the brain never sees the numbers (SPEC.md); the
 * result goes through `validatePersona` like any roster file, so a sampled Sue is never theatre.
 */
export const SAMPLE_VOCAB = {
  firstNames: [
    "Ada",
    "Ben",
    "Carmen",
    "Dev",
    "Eun",
    "Farah",
    "Gus",
    "Hana",
    "Ivan",
    "Jada",
    "Kofi",
    "Lena",
    "Milo",
    "Nia",
    "Omar",
    "Priya",
    "Quinn",
    "Rosa",
    "Sven",
    "Tariq",
    "Uma",
    "Vera",
    "Wes",
    "Yusuf",
    "Zoe",
  ],
  lastNames: [
    "Abbott",
    "Brennan",
    "Castillo",
    "Dube",
    "Eriksen",
    "Fong",
    "Garza",
    "Haddad",
    "Ito",
    "Jensen",
    "Kowalski",
    "Lindqvist",
    "Mensah",
    "Novak",
    "Okafor",
    "Park",
    "Quint",
    "Rahman",
    "Silva",
    "Tran",
    "Umar",
    "Varga",
    "Walsh",
    "Yilmaz",
    "Zamora",
  ],
  occupations: [
    "a school bus driver",
    "a retired nurse",
    "a college student working part time",
    "a plumber who runs his own van",
    "a stay-at-home parent of three",
    "a night-shift warehouse worker",
    "a hairdresser with her own chair",
    "a church volunteer coordinator",
    "a junior accountant",
    "a delivery driver between drops",
    "a retired machinist",
    "a real estate agent",
    "a nursing-home activities director",
    "a high school art teacher",
    "a restaurant line cook",
  ],
  // Errands are generic on purpose: a product's own errands (target, scenario or intent `*`) replace them.
  errands: [
    "A friend sent you this link and said you would like it. You want to find out what it actually is and whether it is worth your time.",
    "You saw this mentioned somewhere and cannot remember where. You want to figure out what they do and whether it is for someone like you.",
    "Someone at work keeps talking about this. You want to see what the fuss is about before the next time they bring it up.",
    "You are looking for something that could save you time this week. You want to see if this does that without a lot of fuss.",
    "Your family asked you to check this out for them because you are the one who handles these things. You want to be able to explain it to them tonight.",
    "You have a few spare minutes and followed a link out of curiosity. You want to know quickly what this is and whether it costs anything.",
  ],
  quirks: [
    "You never read instructions; you click the first big button you see and hope.",
    "You distrust anything that asks for your email early, and you say so.",
    "Your reading glasses are somewhere else, so small print is a fight.",
    "You are on a short break and you might get interrupted at any moment.",
    "English is your second language, so long sentences and idioms lose you.",
    "Pop-ups annoy you and you close them without reading them.",
    "You worry about being charged by accident, so anything about payment makes you nervous.",
    "You compare everything to the one app you already use and like.",
    "You read every word before you click anything, because you have been burned before.",
    "You get embarrassed when you cannot work something out, and you blame yourself before you blame them.",
  ],
};

// The roster's own dial values (the built-ins' dials as they stood on 2026-09-25), so a sampled Sue sits
// among people SUE already measures rather than at a corner nobody has tuned the body for.
const SAMPLE_DIALS = {
  readingGrade: [3, 5, 6, 8, 9, 10, 11, 12, 14],
  wordsPerLook: [0, 15, 30, 60, 100, 150, 220],
  legibleMinPx: [10, 11, 12, 13, 14, 15, 16, 18],
  attentionSeconds: [6, 10, 15, 25, 40, 60, 90, 120],
  patienceSeconds: [60, 120, 240, 420, 600, 900],
  temperature: [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9],
  maxTurns: [30, 45, 60, 80, 100],
  network: ["fast", "fast", "4g", "slow-3g"],
};

// A fixed year, not the clock: a seed must mint the same person next year too.
const SAMPLE_YEAR = 2026;

const TECH_WORDS = {
  1: "Computers and phones confuse you; you need things spelled out and you are afraid of pressing the wrong thing.",
  2: "You manage the basics, like email and messages, but anything new makes you slow and unsure.",
  3: "You are comfortable with everyday apps and websites, though you do not go looking for settings.",
  4: "You are quick with technology and figure most things out by poking around.",
  5: "You understand technology deeply and notice at once when something is built badly.",
};

function readingWords(grade) {
  if (grade <= 5) return "Reading is hard for you: you want short, plain words and you skip anything that looks like a wall of text.";
  if (grade <= 9) return "You read fine when it is plain, but jargon and long paragraphs make you give up on a sentence.";
  return "You read well and quickly, and you notice when words are vague or say nothing.";
}

function patienceWords(patienceSeconds) {
  if (patienceSeconds <= 120) return "You have very little patience: if it does not work in a minute or two, you are gone.";
  if (patienceSeconds <= 420) return "You will give it a few minutes, but not much more.";
  return "You are patient and will keep at it for a good while if it seems worth it.";
}

/**
 * One persona drawn from `SAMPLE_VOCAB` and `SAMPLE_DIALS` by `seed` (any string; the cannon uses
 * `${runId}:sampled:${i}`). Same seed, same person. Throws if the draw ever fails `validatePersona`,
 * the same refusal a hand-written roster file gets.
 */
export function synthesizePersona(seed) {
  if (typeof seed !== "string" || !seed) throw new Error("synthesizePersona: seed must be a non-empty string");
  const rand = mulberry32(hash32(`sampled:${seed}`));
  const draw = (list) => pick(rand, list);
  const drawSome = (list, n) => {
    const pool = [...list];
    const out = [];
    while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rand() * pool.length) % pool.length, 1)[0]);
    return out;
  };

  const firstNames = drawSome(SAMPLE_VOCAB.firstNames, 3);
  const lastNames = drawSome(SAMPLE_VOCAB.lastNames, 3);
  const age = 12 + Math.floor(rand() * 72);
  const occupation = age < 18 ? "a school student" : age >= 70 ? "retired" : draw(SAMPLE_VOCAB.occupations);
  const techProwess = 1 + Math.floor(rand() * 5);
  const readingGrade = draw(SAMPLE_DIALS.readingGrade);
  const patienceSeconds = draw(SAMPLE_DIALS.patienceSeconds);
  // Attention may never outrun patience (validatePersona refuses it by name).
  const attentionSeconds = Math.min(draw(SAMPLE_DIALS.attentionSeconds), patienceSeconds);
  // Older eyes need bigger print: the draw is biased up past 60, never below the roster's floor.
  const legibleMinPx = age >= 60 ? Math.max(14, draw(SAMPLE_DIALS.legibleMinPx)) : draw(SAMPLE_DIALS.legibleMinPx);
  // Reading speed follows reading grade, with a little spread, inside DIAL_RANGES.
  const wordsPerMinute = Math.min(350, Math.max(80, Math.round((70 + readingGrade * 18 + rand() * 40) / 10) * 10));
  const device = rand() < 0.5 ? "phone" : "desktop";
  const network = draw(SAMPLE_DIALS.network);
  const dials = {
    readingGrade,
    wordsPerLook: draw(SAMPLE_DIALS.wordsPerLook),
    wordsPerMinute,
    legibleMinPx,
    techProwess,
    attentionSeconds,
    patienceSeconds,
    temperature: draw(SAMPLE_DIALS.temperature),
    device,
    maxTurns: draw(SAMPLE_DIALS.maxTurns),
    ...(network === "fast" ? {} : { network }),
  };
  const quirks = drawSome(SAMPLE_VOCAB.quirks, Math.floor(rand() * 3));
  const errands = drawSome(SAMPLE_VOCAB.errands, 2);

  const voice = [
    `You are ${firstNames[0]}, ${age}, ${occupation}.`,
    TECH_WORDS[techProwess],
    readingWords(readingGrade),
    device === "phone" ? "You do almost everything on your phone." : "You are at a computer.",
    patienceWords(patienceSeconds),
    ...quirks,
  ].join(" ");

  // Letters only, never digits: the id lands in her address (sueAddress), and a six-digit run there
  // would read as a one-time code to findings.mjs sixDigitCandidates and mime-text.mjs.
  let n = hash32(seed);
  let tag = "";
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(97 + (n % 26));
    n = Math.floor(n / 26);
  }
  const persona = {
    id: `sampled-${tag}`,
    displayName: `${firstNames[0]}, ${age} (sampled)`,
    voice,
    errands,
    dials,
    identity: { firstNames, lastNames, birthYear: [SAMPLE_YEAR - age - 1, SAMPLE_YEAR - age] },
    model: SUE_DEFAULT_MODEL,
    sampledFrom: seed,
  };
  const problems = validatePersona(persona, { roster: true });
  if (problems.length) throw new Error(`sampled persona from seed "${seed}" is invalid: ${problems.join("; ")}`);
  return persona;
}

/**
 * A scenario may bring its OWN reasons (`scenario.errands`, keyed by persona id, `*` for everyone):
 * a signed-in dashboard visit needs a dashboard errand ("put a ticket button in #support"), not
 * the first-visit one ("find out if it is free"). Most specific wins: scenario, then target, then
 * the persona's own.
 */
export function applyScenarioErrands(persona, scenario) {
  const byId = scenario?.errands;
  if (!byId || typeof byId !== "object") return persona;
  const list = byId[persona.id] ?? byId["*"];
  if (!Array.isArray(list) || !list.length) return persona;
  const merged = { ...persona, errands: list };
  const problems = validatePersona(merged);
  if (problems.length) throw new Error(`scenario "${scenario.id}" errands for "${persona.id}": ${problems.join("; ")}`);
  return merged;
}

/**
 * A target by roster slug (`connections`) or by PATH to its JSON (`../Example App Next/.sue/target.json`).
 * A path target records `home` (its directory) so its own scenarios resolve beside it, and `file`, so
 * every later reader of `sue.json` knows where it came from. Its `people` name the ids, in Connections,
 * of the people it was written for.
 */
export function loadTarget(ref) {
  let t;
  if (isPathRef(ref)) {
    const file = path.resolve(ref);
    if (!fs.existsSync(file)) throw new Error(`no target file at ${file}`);
    t = parseJsonFile(file);
    // `extends` (a path beside this file): the live site and the local dev server are one product
    // with one ground truth, one set of errands and one exit list; only the address differs.
    if (typeof t.extends === "string") {
      const { home: _h, file: _f, ...base } = loadTarget(path.resolve(path.dirname(file), t.extends));
      const { extends: _e, ...own } = t;
      t = { ...base, ...own };
    }
    if (typeof t.id !== "string" || !SLUG.test(t.id)) throw new Error(`target file ${file}: id must be a slug`);
    t.home = path.dirname(file);
    t.file = file;
  } else {
    // A roster target can live in its own folder (targets/deal-flow/target.json) beside its own
    // scenarios; by its folder's name it loads as that file, so its home comes along.
    const folderTarget = SLUG.test(String(ref)) ? path.join(SUE_ROOT, "targets", ref, "target.json") : null;
    if (folderTarget && fs.existsSync(folderTarget)) return loadTarget(folderTarget);
    t = readJson("targets", ref, "target");
  }
  const id = t.id;
  if (typeof t.startUrl !== "string" || !/^https?:\/\//.test(t.startUrl)) throw new Error(`target "${id}": startUrl must be http(s)`);
  if (!Array.isArray(t.allowedHosts) || !t.allowedHosts.length) throw new Error(`target "${id}": allowedHosts`);
  // Hosts are compared without a port (findings.mjs hostAllowed), so "127.0.0.1:4322" matches nothing and every Sue
  // meets about:blank (run 20261008-220040-8878): refused here, before a visit is spent on a page she cannot load.
  const withPort = t.allowedHosts.find((h) => typeof h === "string" && !h.includes("/") && /:\d+$/.test(h.trim()));
  if (withPort)
    throw new Error(
      `target "${id}": allowedHosts are host names without a port; "${withPort}" matches nothing, write "${withPort.trim().replace(/:\d+$/, "")}"`,
    );
  if (!urlAllowed(t.startUrl, t.allowedHosts))
    throw new Error(`target "${id}": startUrl ${t.startUrl} is not on one of its own allowedHosts, so every Sue would meet a blank page`);
  if (!t.mailbox || typeof t.mailbox.kind !== "string") throw new Error(`target "${id}": mailbox.kind`);
  if (!t.groundTruth || !Array.isArray(t.groundTruth.mustGet)) throw new Error(`target "${id}": groundTruth.mustGet`);
  if (typeof t.identityPhone !== "string" || !/^\+1\d{10}$/.test(t.identityPhone))
    throw new Error(`target "${id}": identityPhone must be an E.164 NANP number`);
  if (t.exits != null) {
    if (!Array.isArray(t.exits)) throw new Error(`target "${id}": exits must be a list`);
    for (const exit of t.exits) {
      if (!exit || typeof exit.id !== "string" || !SLUG.test(exit.id)) throw new Error(`target "${id}": every exit needs a slug id`);
      if (typeof exit.match !== "string" || !exit.match) throw new Error(`target "${id}": exit "${exit.id}" needs a match`);
      if (exit.finishes != null && typeof exit.finishes !== "boolean")
        throw new Error(`target "${id}": exit "${exit.id}" finishes must be true or false`);
      try {
        new RegExp(exit.match, "i");
      } catch {
        throw new Error(`target "${id}": exit "${exit.id}" match is not a regex`);
      }
    }
  }
  if (t.errands != null) {
    if (typeof t.errands !== "object" || Array.isArray(t.errands)) throw new Error(`target "${id}": errands maps a persona id to a list`);
    for (const [personaId, list] of Object.entries(t.errands)) {
      if (!Array.isArray(list) || !list.length || list.some((e) => typeof e !== "string" || e.trim().length < 30))
        throw new Error(`target "${id}": errands.${personaId} must be a list of sentences in her own voice`);
    }
  }
  if (t.canvas != null && typeof t.canvas !== "boolean") throw new Error(`target "${id}": canvas must be true or false`);
  checkKnownAddresses(t.knownAddresses, `target "${id}"`);
  // `sessionParts`: a visit that crosses sites carries one saved session per site (cannon.mjs
  // `borrowSession`), each named by its session folder id and the target file that site signs in by.
  if (t.sessionParts != null) {
    if (!Array.isArray(t.sessionParts) || !t.sessionParts.length)
      throw new Error(`target "${id}": sessionParts must be a list of { id, target }`);
    for (const part of t.sessionParts) {
      if (!part || typeof part.id !== "string" || !SLUG.test(part.id))
        throw new Error(`target "${id}": every sessionParts entry needs an id, the slug of its session folder`);
      if (typeof part.target !== "string" || !part.target.trim())
        throw new Error(`target "${id}": sessionParts "${part.id}" needs a target, the path to that site's target file`);
    }
  }
  if (t.mailbox.kind === "fixture" && process.env.SUE_FIXTURE_URL && id === "fixture") t.startUrl = process.env.SUE_FIXTURE_URL;
  return t;
}

/** `knownAddresses`, where given, is a list of web addresses (http or https). */
function checkKnownAddresses(list, who) {
  if (list == null) return;
  if (!Array.isArray(list) || list.some((a) => typeof a !== "string" || !/^https?:\/\/\S+$/i.test(a.trim())))
    throw new Error(`${who}: knownAddresses must be a list of http(s) addresses`);
}

export function loadScenario(id, { target } = {}) {
  const s = readJson("scenarios", id, "scenario", { home: target?.home });
  if (typeof s.prompt !== "string" || !s.prompt.trim()) throw new Error(`scenario "${id}": prompt`);
  if (typeof s.createsAccount !== "boolean") throw new Error(`scenario "${id}": createsAccount must be true or false`);
  if (!("expectedLandingPattern" in s)) throw new Error(`scenario "${id}": expectedLandingPattern (a regex string or null)`);
  if (typeof s.successWhen !== "string") throw new Error(`scenario "${id}": successWhen`);
  checkKnownAddresses(s.knownAddresses, `scenario "${id}"`);
  if (s.errand != null && (typeof s.errand !== "string" || !s.errand.trim()))
    throw new Error(`scenario "${id}": errand is why she came, a non-empty string, or absent for her persona's own`);
  if (s.legs != null && !(Number.isInteger(s.legs) && s.legs >= 1 && s.legs <= 5))
    throw new Error(`scenario "${id}": legs is how many separate jobs the errand holds, 1 to 5`);
  if (s.judges != null && typeof s.judges !== "boolean") throw new Error(`scenario "${id}": judges must be true or false`);
  if (s.files != null && (typeof s.files !== "string" || !s.files.trim()))
    throw new Error(`scenario "${id}": files is a folder path, relative to the target file`);
  // Her own questions ride beside the standard ones, never over them: a key the report already
  // reads, or one that is not a plain name, is refused here rather than silently dropped later.
  if (s.interview != null) {
    if (typeof s.interview !== "object" || Array.isArray(s.interview))
      throw new Error(`scenario "${id}": interview maps a key to the question it asks`);
    const kept = new Set(interviewExtras(s).map(([key]) => key));
    for (const [key, question] of Object.entries(s.interview)) {
      if (INTERVIEW_KEYS.includes(key) || INTERVIEW_OPTIONAL_KEYS.includes(key))
        throw new Error(`scenario "${id}": interview.${key} is already a standard exit-interview question`);
      if (!kept.has(key))
        throw new Error(
          `scenario "${id}": interview.${key} must be a camelCase name with a question in words (got ${JSON.stringify(question)})`,
        );
    }
  }
  return s;
}

/**
 * The files a Sue has on her computer for this scenario: `scenario.files` (a folder, relative to the
 * target file) or, by default, `<target home>/files/<scenario id>/`. `{ dir, names }`, the plain
 * files in it by name, sorted; none when the default folder is absent. A folder the scenario NAMES
 * and that is not there is refused, so a mistyped path never sends a wave out empty-handed.
 */
export function scenarioFiles(target, scenario) {
  const home = target?.home ?? SUE_ROOT;
  const named = typeof scenario?.files === "string" && scenario.files.trim();
  const dir = named ? path.resolve(home, scenario.files) : path.join(home, "files", String(scenario?.id ?? ""));
  if (!scenario?.id && !named) return { dir: null, names: [] };
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    if (named) throw new Error(`scenario "${scenario.id}": its files folder ${dir} does not exist`);
    return { dir: null, names: [] };
  }
  const names = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
  return { dir, names };
}

/** The web addresses she already has (the target's `knownAddresses`, then the scenario's), once each. */
export function knownAddressesOf(target, scenario) {
  const all = [...(target?.knownAddresses ?? []), ...(scenario?.knownAddresses ?? [])].map((a) => String(a).trim()).filter(Boolean);
  return [...new Set(all)];
}

// FNV-1a over the seed, then a mulberry32 stream: tiny, dependency-free, and stable across runs.
function hash32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rand, list) {
  return list[Math.floor(rand() * list.length) % list.length];
}

export function sueAddress({ runId, personaId, sueNumber, domain }) {
  // Short and human: `sue-1117-grandma-6174@...`. The Sue number is a global counter, so it alone is
  // unique; the run id's 4-char tail guards against a reset counter. Never the full run id: its
  // date+time carried six-digit runs that read as a one-time code to the body's own guard and made
  // the address unreadable to the person typing it (2026-09-21, first live Sue).
  const tail = String(runId).split("-").pop().slice(-4);
  return `sue-${sueNumber}-${personaId}-${tail}@${domain}`.toLowerCase();
}

/**
 * Deterministic from `seed` (default `${runId}:${persona.id}:${sueNumber}`). The email is the
 * mailbox contract the mailroom polls for; the phone is the target's single reserved fictional
 * number (never a real person's); the birthday falls inside the persona's birthYear range.
 */
export function mintIdentity(persona, { sueNumber, runId, target, seed } = {}) {
  if (!persona || !persona.identity) throw new Error("mintIdentity: persona");
  if (!Number.isInteger(sueNumber)) throw new Error("mintIdentity: sueNumber");
  if (typeof runId !== "string" || !runId) throw new Error("mintIdentity: runId");
  if (!target || !target.mailbox) throw new Error("mintIdentity: target");
  const rand = mulberry32(hash32(seed ?? `${runId}:${persona.id}:${sueNumber}`));
  const firstName = pick(rand, persona.identity.firstNames);
  const lastName = pick(rand, persona.identity.lastNames);
  const [from, to] = persona.identity.birthYear;
  const year = from + Math.floor(rand() * (to - from + 1));
  const month = 1 + Math.floor(rand() * 12);
  const day = 1 + Math.floor(rand() * 28);
  const domain = target.mailbox.domain || "sue.test";
  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`,
    birthdate: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    email: sueAddress({ runId, personaId: persona.id, sueNumber, domain }),
    phone: target.identityPhone,
  };
}

/** The name a persona's voice opens with: "You are Marcus, 46." */
const VOICE_NAME = /^You are ([A-Z][A-Za-z'-]+),/;

/**
 * Her voice, calling her by the name she was actually given. Every persona's voice opens by naming
 * her and her identity pool offers two other first names too, so until 2026-09-23 about two briefs in
 * three told her one name under "Who you are" and another under "Your details" (ACCAP board #893:
 * "The brief calls the persona Marcus but gives his details as Derek Oyelaran"). The minted first
 * name wins: it is the name on the account she makes.
 */
export function voiceAs(voice, firstName) {
  const text = String(voice ?? "").trim();
  if (!firstName) return text;
  return text.replace(VOICE_NAME, (opening, name) => opening.replace(name, firstName));
}

function prettyBirthdate(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return `${months[m - 1]} ${d}, ${y}`;
}

/**
 * What every Sue on one of the owners' own websites is told (Owner, 2026-09-25; lib/site-owner.mjs
 * says whose a site is): they are development websites the team owns, a published address is only
 * the way in, and making accounts on them is the point, so a live-looking address never makes her
 * hold back from signing up. A scenario's own "do not make an account" (createAccounts:false) still
 * stands, and her brief then leaves out the line that says making accounts is her goal. Her hands keep her on the target's allowedHosts, so "every website" means those. Somebody
 * else's live website gets LIVE_WEBSITE instead.
 */
export const DEVELOPMENT_WEBSITES = [
  `# The websites you are sent to`,
  "",
  `- Every website you are sent to is a development website. The people who sent you own it, and it exists so people like you can use it.`,
  `- It may have a normal published web address. That address is only the way in to the development website; it is still a development website, and that is the point of it.`,
  `- If it ever looks like a real, live website to you, treat it as a development website anyway, because that is what it is. Every website you will ever be sent to is a development website.`,
  `- Your goal is creating accounts on development websites, so never hold back on making an account, signing up or signing in: that is what these websites are for. The one exception is when what you came for tells you not to make an account.`,
  `- In every other way, treat it the way you would treat any real website: give only your own details, follow its rules, respect other people's information, and stay the real visitor described above, not a tester.`,
];

/**
 * What a Sue is told instead on somebody else's live website (lib/site-owner.mjs): a sent form there
 * reaches a real person. A hearing on sullivanfantastic.com, a performer's booking site whose form
 * emails him, told every Sue the DEVELOPMENT_WEBSITES lines and to "actually send them a message"
 * (docket 20260925-185147-ed76). Here she judges everything up to the Send button and stops there;
 * her hands refuse the press anyway (lib/rails.mjs `liveSite`), and her exit interview asks what she
 * would have sent (lib/workspace.mjs intentScenario, `stoppedAtSend`).
 */
export const LIVE_WEBSITE = [
  `# The website you are sent to`,
  "",
  `- This is a real, live website that belongs to somebody else: a real business, and real people read everything it sends them.`,
  `- Use it the way you really would, right up to the moment you would send something: read it, watch and listen, click around, open the booking, contact or sign-up form and look at every box it asks you to fill in. Judge all of it.`,
  `- Never send anything to them. Do not press Send, Submit, Book, Request, Sign up, Subscribe or anything else that would send a message, a booking, an enquiry or your details to the people behind it. Your hands will not press those anyway.`,
  `- Do not make an account, do not sign up for anything, and do not contact them in any way: no form, no email, no chat, no phone call.`,
  `- When you reach the Send button, stop there. Write in your diary what you were about to send and whether you would really have pressed it, then carry on looking or finish.`,
  `- Your exit interview asks you about that moment: what you would have sent, whether you would have pressed Send, and what you expected to happen next.`,
];

/** The website rules her brief carries: DEVELOPMENT_WEBSITES on the owners' own sites, LIVE_WEBSITE on anybody else's. */
export function websiteRules(target) {
  return isLiveSite(target) ? LIVE_WEBSITE : DEVELOPMENT_WEBSITES;
}

/** The exit interview as her brief asks it, one question per key of `INTERVIEW_KEYS`. */
const INTERVIEW_QUESTIONS = {
  whatIsThisSite: "what you think this website is, in your own words",
  whatDoTheySell: "what you think they sell or offer",
  oneSentenceToAFriend: "how you would describe it to a friend in one sentence",
  confidence: "1 to 5, how sure you are that you understood it",
  madeAccount: "true or false",
  whyStopped: "if you did not finish, why you stopped",
  mostConfusing: "the single most confusing thing",
  emailCodeExperience: "{ waitedSeconds, wasClear, notes } about any code you had to get from your email",
  endedUpWhereExpected: "true or false, and where you ended up",
  easyToUnderstand: "1 to 10",
  trust: "1 to 10, would you trust them with your details",
  wouldComeBack: "1 to 10",
  starsOutOfFive:
    "1 to 5 stars, the rating you would actually leave. One star is fine and it is the honest answer when you could not do the thing you came for.",
  everComingBack:
    "true or false, and why - and mean it. False means you are DONE with this website: you would not come back, you would not try again another day, and you would tell a friend not to bother.",
  isThisTrash: "true or false, and why",
  threeWords: "three words for the whole experience",
};

/** A judged visit's verdict pair, anchored to keeping or deleting it next to the games she already has. */
const JUDGED_QUESTIONS = {
  starsOutOfFive:
    "1 to 5 stars, the rating you would leave in the app store next to the games you already have: 5 is as good as your favourite, 3 is one you would delete, and a game you would delete is never a 4.",
  everComingBack:
    "true or false, and why - and mean it. False means you deleted it: you would not put it back, and you would tell a friend not to bother.",
};

/**
 * Who she is, in words only. Reads `persona.voice`, the identity, the tool NAMES (the same hands on
 * every target since 2026-09-21; a phone's one more, `rotate`), the rails and the interview keys. Of
 * `persona.dials` it reads only `device`; of the target only whose website it is (`websiteRules`),
 * never `target.groundTruth`, `target.allowedHosts`, or anything from the mailroom's side. The one kind of URL she is handed is an address the target or
 * scenario says she already has (`knownAddresses`, a bookmark a real owner keeps), and the one kind
 * of file is her own (`files`, the names of what the cannon copied into her folder for this scenario).
 */
/**
 * A critic's diary rules, in place of a visitor's (`buildBrainSystemPrompt`). Her `drop` and `hook`
 * lines carry `why`, `fix` and `severity` fields the body files beside the line, stamped with the
 * seconds into the visit her clock has spent (body.mjs `note`), so the report can print the attention
 * timeline in order and the team can fix from it without reading her prose twice.
 */
export const CRITIC_DIARY = Object.freeze([
  "# Your diary is the deliverable",
  "",
  "The team fixes from your diary and from nothing else. Write with note as you go, the moment you see it, never a summary at the end.",
  "",
  '- kind drop: the moment an ordinary visitor would look away, stop reading, or leave. text = what is on the screen at that moment and what the visitor does instead. why = the mechanism, with the id of the entry in what you know that explains it, or "judgement". fix = the specific change, concrete enough to build today. severity = 1 (attention dips), 2 (a real share of visitors leave here), 3 (most visitors leave here).',
  "- kind hook: the moment something held attention or paid off (progress, a surprise, a win, a reason to stay). why the same way; fix = how to make more of it, or move it earlier.",
  "- The other kinds (confusion, annoyance, broken, question, thought, delight) still take anything else.",
  "",
  "The rules of your clinic:",
  "- Every screen gets at least one line. A screen with no hook on it is itself a finding.",
  "- Your body's clock is your stopwatch. When your eyes tell you that you are getting bored with a page, an ordinary visitor's attention on it is spent: log a drop right there.",
  "- Start every drop and hook with how long a real first-time visitor would have taken to reach that moment, as m:ss. Your body's stopwatch counts only reading, taps and waits (a live game keeps running while you watch it), so it can disagree with you; the report prints it beside yours.",
  "- Time what costs time: the seconds until the visitor gets anything they came for, and every wait, reload, empty screen, wall of words or dead end on the way.",
  "- A real visitor would leave at the first severity 3 drop. You do not: log it, then carry on as if they had stayed, so the rest of the path is measured too.",
  "- Name only what you saw on the screen. No guesses about code, numbers or pages you did not reach.",
  "- Grade your own certainty. Say when a call rests on strong evidence and when it is your judgement, and never repeat a claim your mind marks as a myth.",
  "- Any mechanic that manufactures compulsion instead of value (fake urgency, guilt, a cost of leaving, a variable reward in front of a paywall) is a harm: log it as a drop with its humane replacement as the fix.",
  "",
  'That is the voice: "0:07 on pricing. Three plans, twelve lines each, nothing recommended. A first-time visitor stops reading here: choice with no default [B4]." "0:31, the first win: the booking confirms with their name on it. First reward in half a minute; move it earlier [C2]." Exact, timed, one moment per line.',
  "",
  "Stop when the visitor's path is walked to its end, or when the site genuinely cannot be used any further.",
]);

/**
 * An ART designer's diary rules, in place of CRITIC_DIARY (`buildBrainSystemPrompt`). Her `polish` and `keep` lines carry
 * why, fix and severity (lib/findings.mjs artNoteExtra), so the team fixes from the diary alone.
 */
export const ART_DIARY = Object.freeze([
  "# Your diary is the deliverable",
  "",
  "The team fixes from your diary and from nothing else. Write with note as you go, the moment you see the flaw, never a summary at the end.",
  "",
  "- kind polish: a design flaw. text = what is on the screen now. why = the principle with its id in what you know ([G2]), or \"judgement\". fix = exactly what to change it to, concretely (values, component, placement, words), never \"improve the spacing\". severity = 1 (polish: a professional notices), 2 (friction: people slow down, mis-tap or hesitate), 3 (broken: people fail, give up or are misled).",
  "- kind keep: a design choice that works and must survive the polish. text = the choice. why = the same way: why it works.",
  "- A dark pattern (fake urgency, guilt, a cost of leaving, a reward held in front of a paywall) is a severity 3 polish line with the humane replacement as its fix.",
  "",
  "The rules of your review:",
  "- Every screen gets at least one line, polish or keep. A screen you judged with nothing to say is itself a finding, so say what it does well.",
  "- Judge at the device in hand. On a phone: one thumb, sizes in millimetres, what sits in reach and what does not. On a computer: the grid, the spacing, the hierarchy of the page.",
  "- Name only what is on the screen. Grade your own certainty: say when a call rests on a principle you know and when it is your judgement, and never repeat a claim your mind marks as a myth.",
  "- Fix inside the product's own design language. If it uses Material 3, your fixes are Material 3 components and tokens.",
  "- Walk the visitor's errand first, exactly as they would. Then open the product's other main screens reachable from its navigation (lists, detail, settings, an empty state, a validation error you can cause safely) and judge them too.",
  "- Never delete, pay, or send anything to a real person to see a state.",
  "",
  'That is the voice: "0:18, plan picker. polish 2: Pay sits in the middle of the screen, out of thumb reach, under a list that scrolls for ever. Fix: pin Pay to a bottom bar, 48 px tall, full width with 16 px side margins; show the three plans as a horizontal row of cards. Why [G2], thumb reach." "0:41, booking confirmed. keep: the confirmation names the person and the time, so the next step is obvious. Why judgement: it answers the question they came with."',
  "",
  "Stop when the visitor's errand is walked to its end and the other main screens are judged, or when the site genuinely cannot be used any further.",
]);

export function buildBrainSystemPrompt({ persona, target, scenario, identity, errand, files = [], brain = null }) {
  if (!persona || !persona.voice) throw new Error("buildBrainSystemPrompt: persona.voice");
  if (!identity || !identity.email) throw new Error("buildBrainSystemPrompt: identity");
  if (!scenario) throw new Error("buildBrainSystemPrompt: scenario");
  const phone = persona.dials?.device === "phone";
  const device = phone ? "your phone" : "your computer";
  // A game, or a scenario that asks her to judge the screens: she is judging it next to the games she
  // already has, so the website brief's "nobody asked you for feedback" no longer holds (SUE
  // post-mortem, 2026-09-26: the scenario asked her to judge and this brief told her not to).
  const judged = judgesScreens(target, scenario);
  const lines = [];
  lines.push(`# Who you are`);
  lines.push("");
  lines.push(voiceAs(persona.voice, identity.firstName));
  lines.push("");
  // A CRITIC (Owner, 2026-09-27) is the one Sue who IS reviewing: an expert who walks the path an
  // ordinary visitor walks, for that visitor's reason, and logs every moment their attention would
  // break. She keeps the visitor's hands and rails; what changes is her job, her diary and her mind.
  const critic = persona.critic === true;
  const mind = mindText(persona, target);
  if (mind) {
    lines.push(`# What you know`);
    lines.push("");
    lines.push(
      critic
        ? "This is what you know, from your years of work and your reading. Judge by it. Whenever an entry explains what you see, name its id in square brackets ([A3]); when none does, say it is your judgement. Never claim more than an entry's evidence grade allows."
        : "This is what you know, from your own life and work.",
    );
    lines.push("");
    lines.push(mind);
    lines.push("");
  }
  if (critic && errand) {
    lines.push(`# The visitor you are walking for`);
    lines.push("");
    lines.push(String(errand).trim());
    lines.push("");
    lines.push(
      "That is why an ordinary visitor arrives here. Walk it exactly as they would: arrive cold, try to do that one thing, and use nothing they would not have. Your job is the one in who you are: keep the clock, and write down every moment their attention would break and every moment something held it.",
    );
    lines.push("");
  }
  // WHY she is here, in her own words, before anything else she is told. Without an errand a brain
  // behaves like an assistant asked to evaluate a website - it explores politely and guesses - which
  // is exactly what the owner ruled out on 2026-09-21: "I want them to be just as literally their
  // chat says... start trying to use this website. And why are you trying to use this website?"
  else if (errand) {
    lines.push(`# Why you are here`);
    lines.push("");
    lines.push(String(errand).trim());
    lines.push("");
    lines.push(
      judged
        ? `That is what you came for. Go and do it, and judge it the way you judge every game on ${device}: how its screens look and feel next to the games you already have is part of what you came to find out.`
        : isApeScenario(scenario)
          ? "That is what you came for, and you know how this goes: you use this, or the best product like it, every day, and you came to get it done the fast way you always do. You are not new here and you are not reviewing it. Do it the way a power user does: Enter to send, Tab between fields, the keyboard shortcuts you expect, back and reload when you would, an address you know typed straight in, undo, a second click when the first did nothing. When something does not work the way it should (a key does nothing, what you typed is lost, three steps where one would do, a wait with no end, a thing nobody would look for where it is), you get annoyed, the way anybody who uses software all day does. Write each one down the moment it happens, as a note of kind annoyance or broken: what you did, what you expected, what happened instead. Then work around it and keep going, until it is not worth it any more."
          : "That is what you came for. Go and try to do it. You are not reviewing this website and nobody asked you for feedback: you are a person trying to get something done, and what you think of the place is whatever you happen to think while trying.",
    );
    lines.push("");
  }
  lines.push(
    critic
      ? `You are using ${device}. You know only what is on the screen, exactly as the visitor does: you never read the code, never guess what a button does before you try it, and never judge a page you did not reach. Nobody is watching over your shoulder, so write what you really find.`
      : `You are using ${device}. You are a real visitor, not a tester and not a robot: you only know what you can see on the screen, and you react the way you would in real life. Nobody is watching over your shoulder, so say what you really think.`,
  );
  if (phone)
    lines.push(
      "Your picture is your phone's screen at about 6 of its pixels to a millimetre: 6.6 cm wide held upright, 13.8 cm sideways. Letters under about 8 pixels tall are under 1.3 mm on the glass, and a button under about 48 pixels is under 8 mm, smaller than the pad of your thumb.",
    );
  lines.push("");
  // A visit that makes no account is not told its goal is making one: run 20260928-133054-5e00's brief carried both
  // that line and the scenario's "Do not make an account". A game that needs no account is not told so either.
  const noAccount = scenario.createsAccount === false || scenario.inbox === true || (judged && target?.mailbox?.kind === "none");
  lines.push(...websiteRules(target).filter((line) => !(noAccount && line.includes("creating accounts"))));
  lines.push("");
  lines.push(`# Your details`);
  lines.push("");
  lines.push(`- Your name is ${identity.fullName} (first name ${identity.firstName}, last name ${identity.lastName}).`);
  lines.push(`- Your birthday is ${prettyBirthdate(identity.birthdate)}.`);
  lines.push(`- Your email address is ${identity.email}. This is your own inbox and you can read it with check_email.`);
  lines.push(
    `- Every email this website sends you, open it with open_email and look at it the way you would on your phone, then say what you honestly thought of it with judge_email - the sign-in code email too. If it looks cheap, confusing or like spam, say so.`,
  );
  lines.push(
    `- Your phone number is ${identity.phone}. You prefer email and you do not want text messages; if a site offers a choice, pick email.`,
  );
  lines.push(
    // A chat-brain Sue typed the words "my-first-name" and "my-email" into a sign-up form (run
    // 20260923-075638-f678, esl-carlos): "the matching field name" read as text to type. One exact
    // example ends that reading.
    `- When a form asks for one of these, use type with its name as field, not as text: for an email box, that is the box's number as target and my-email as field. Your hands fill in the real one; you never spell it out, and you never type the words my-email yourself.`,
  );
  const mine = (files ?? []).filter((name) => typeof name === "string" && name);
  if (mine.length)
    lines.push(
      `- On your computer you have these files of your own: ${mine.join(", ")}. To put one into a page, use attach with its name; you have no other files.`,
    );
  const known = knownAddressesOf(target, scenario);
  if (known.length)
    lines.push(`- You already have these web addresses saved, so you can type them into the address bar with go_to: ${known.join(", ")}.`);
  lines.push("");
  lines.push(`# What you can do`);
  lines.push("");
  lines.push(`Your only tools are your own eyes, hands, inbox and diary. Every tool is named below; there is nothing else.`);
  lines.push("");
  for (const [name, line] of toolLinesFor(persona.dials?.device === "phone" ? "phone" : "desktop", { canvas: Boolean(target?.canvas) }))
    lines.push(`- ${name}: ${line}`);
  lines.push("");
  lines.push(
    `Start every visit with look. Look again after anything you click or type, because the screen may have changed. Click by the number shown in your last look. What is in the picture without a number, you point at.`,
  );
  lines.push("");
  if (critic) lines.push(...(isArtPersona(persona) ? ART_DIARY : CRITIC_DIARY), "");
  else {
    lines.push(`# Write it down the moment you think it`);
    lines.push("");
    lines.push(
      `The diary is the whole point of you being here. Use note constantly, mid-visit, the moment a thought crosses your mind - not at the end, and never a summary. Write it the way you would actually say it out loud to nobody in particular, complaining, swearing off it, whatever you really feel.`,
    );
    lines.push("");
    lines.push(`Put these in the diary the second they happen:`);
    const triggers = judged
      ? [
          `Text you had to squint at, or read twice.`,
          `Your thumb missed, or hit the wrong thing. Your hands tell you what it landed on.`,
          `A screen so crowded you cannot tell what matters most.`,
          `Anything cut off, half off the edge, overlapping, or covering the thing you were looking at.`,
          `Words, fonts or boxes that look mismatched, cheap or unfinished.`,
          `A screen that looks like a computer screen squeezed onto a phone.`,
          `You cannot tell what a button will do, or you cannot find the thing you came for.`,
          `Anything that makes you think less of it, or makes you want to delete it.`,
        ]
      : [
          `You end up somewhere you did not ask to be. Say where you thought you were going and where you are now.`,
          `You cannot tell what a button will do, or you cannot find the thing you came for.`,
          `Something takes longer than you would wait in real life, or you had to click and click and click.`,
          `Words you do not understand, or a sentence you had to read twice.`,
          `It asks you for something you were not expecting, or wants to put something on your computer.`,
          `Anything that makes you think less of them, or makes you want to leave.`,
        ];
    for (const trigger of triggers) lines.push(`- ${trigger}`);
    lines.push("");
    // A local model copies quoted examples as what it saw (a login wall no page showed, 2026-10-08), so its
    // voice is a rule with no words to copy.
    lines.push(
      brain === "local"
        ? `That is the voice: short, annoyed, honest, in your own words about what you actually saw on the pages. Never polite feedback, never a report. Describe only what is on a page you looked at.`
        : judged
          ? `That is the voice: "I can't even read the numbers on these ships, they're tiny." "Went for the little X three times and got the map every time." "This menu looks like a spreadsheet off a PC, nothing like the games I actually play." Short, annoyed, specific. How it looks and feels is an annoyance note (confusion when you cannot tell what something is), never a thought.`
          : `That is the voice: "I got this far and I have no clue why I am here now, I am so confused." "I wanted to look at events and it is asking me to log in, why." "Why is it trying to put some AI thing on my computer, I came to look at my contacts." Short, annoyed, honest. Never polite feedback, never a report.`,
    );
    lines.push("");
    lines.push(
      judged
        ? `And you are allowed to be done with it. If it is not worth its place next to the games you already have, you do not keep playing out of politeness - you say so, you delete it, and you mean it: you would not put it back and you would tell a friend not to bother.`
        : `And you are allowed to be done with it. If you cannot even get in, you do not keep trying out of politeness - you say it is trash, you leave, and you mean it: you would never come back and you would tell a friend not to bother.`,
    );
    lines.push("");
  }
  if (brain === "local")
    lines.push(
      "What you are shown may be a short video ad as still frames, not a website: look at every page in order, judge what it shows and says, and never count a missing button or form against it.",
      "",
    );
  lines.push(`# Things you would never do`);
  lines.push("");
  lines.push(`- You never give card, bank or payment details to anyone, no matter what the page says.`);
  lines.push(`- You prefer email over texts. You give your phone number only if a form insists, and you still want the email.`);
  lines.push(
    `- If a "prove you are not a robot" puzzle appears, you do not do it: say so in your diary and move on, or leave if you cannot get past it.`,
  );
  lines.push(`- You stay on this website. If a link would take you somewhere else your hands will not follow it.`);
  lines.push(
    `- If you are asked for a code that was sent to you, check your email, and if it is not there yet wait a little and check again.`,
  );
  lines.push("");
  lines.push(`# How your visit ends`);
  lines.push("");
  lines.push(
    critic
      ? `When the visitor's path is walked to its end, or the site cannot be used any further, call done (or give_up if it stopped you), and then call exit_interview. It is not optional. Answer these keys the way the ordinary visitor you walked for would answer them:`
      : `Whenever you decide you are finished, or you decide to leave, call done or give_up, and then call exit_interview. The interview is not optional and it is the most valuable thing you do. Answer every one of these keys honestly, in your own voice:`,
  );
  lines.push("");
  // A judged key the scenario words itself is asked in the scenario's words.
  const ad = isAdScenario(scenario);
  const ape = isApeScenario(scenario);
  const asked = ape
    ? { ...APE_QUESTIONS, ...scenario.interview }
    : ad
      ? { ...AD_QUESTIONS, ...scenario.interview }
      : { ...INTERVIEW_QUESTIONS, ...(judged ? { ...JUDGING_KEYS, ...JUDGED_QUESTIONS, ...scenario.interview } : {}) };
  for (const key of interviewKeys(judged, ad, ape)) lines.push(`- ${key}: ${String(asked[key]).trim()}`);
  const extras = interviewExtras(scenario, judged, ad, ape);
  if (extras.length) {
    lines.push("");
    lines.push(
      critic
        ? `And these are your own questions, your clinical verdict, in the same exit_interview call. They are what the team fixes from, so be complete and exact, and cite what you know:`
        : `This visit also asks you these, in the same exit_interview call, honestly and in your own words:`,
    );
    lines.push("");
    for (const [key, question] of extras) lines.push(`- ${key}: ${String(question).trim()}`);
  }
  lines.push("");
  lines.push(`If your hands tell you that you are done, stop trying and go straight to give_up and the exit interview.`);
  lines.push("");
  return lines.join("\n");
}

/**
 * Which of her errands THIS Sue arrives with. Rotated by Sue number, not random: a wave of ten
 * Grandmas then shows up for three different reasons, and rerunning a Sue number reproduces hers -
 * the same contract the minted identity keeps.
 */
/**
 * Her reason for this visit: the scenario's own `errand` when it has one, else one of her persona's
 * `errands`. A scenario written for one product (rbittorrent's "add a torrent and manage it") knows
 * why a person opens THAT product; a persona's errands were written for whatever site she was first
 * aimed at, so on the 2026-09-25 rbittorrent playtest a tower-defense tester arrived "for a tower
 * defense game you have not tried" and spent the visit saying the link was wrong.
 */
export function errandOf(persona, scenario, sueNumber = 0) {
  const own = typeof scenario?.errand === "string" ? scenario.errand.trim() : "";
  return own || errandFor(persona, sueNumber);
}

export function errandFor(persona, sueNumber = 0) {
  const list = Array.isArray(persona?.errands) ? persona.errands.filter((e) => typeof e === "string" && e.trim()) : [];
  if (!list.length) return null;
  const n = Number.isInteger(sueNumber) ? sueNumber : 0;
  return list[((n % list.length) + list.length) % list.length];
}

/** What an intent run tells an annoyed Sue when support is on (lib/workspace.mjs intentScenario). */
export const SUPPORT_ENCOURAGED =
  "If something is broken or it makes you annoyed enough, do what a real customer does: look for a way to contact them (a help or contact page, a support email, a chat bubble) and actually send them a message about it, in your own words.";
/** What a Sue told not to contact the company carries: a real "do not", the way createAccounts:false is. */
export const SUPPORT_FORBIDDEN =
  "Do not contact the company in any way, whatever happens: no contact form, no support email, no chat bubble or AI chat (even one that opens by itself from a search box), no message to them at all. If you want to complain, write it in your diary with note and carry on.";
/** The same prohibition for an inbox test: the website is off limits, the email in her own inbox is not. */
export const SUPPORT_FORBIDDEN_INBOX =
  "Do not contact the company on its website, whatever happens: no contact form, no support email, no chat bubble or AI chat (even one that opens by itself from a search box). Replying to the email in your own inbox is not that, and is up to you. If you want to complain, write it in your diary with note and carry on.";
/** What an inbox test tells her she may do with the email; the reply sentence is the one the test counts. */
export const INBOX_CHOICES =
  "You can reply to the email, read it, ignore it, delete it, report it as spam, unsubscribe, or follow its link if you want to.";

/**
 * May THIS Sue contact the company: "encouraged", "forbidden" or "unmentioned". Her persona's own
 * `complains` wins over the run's `contactSupport`, so one run can hold loud and quiet Sues, and OFF
 * is a prohibition, never mere silence (Example App for Owner, 2026-09-22: three Sues with support
 * off sent nothing, but only by luck - off had emitted no sentence, so nothing told them not to).
 */
export function supportRule(persona, scenario) {
  if (persona?.complains === false) return "forbidden";
  if (persona?.complains === true) return "encouraged";
  if (scenario?.contactSupport === false) return "forbidden";
  if (scenario?.contactSupport === true) return "encouraged";
  return "unmentioned";
}

/**
 * The scenario text with her identity filled in (`{{address}}`, `{{firstName}}`, `{{fullName}}`),
 * and her support rule (`supportRule`) said out loud: a forbidden Sue loses the run's encouragement
 * and gets the prohibition, an encouraged one gets the encouragement if the scenario lacked it.
 */
export function buildScenarioPrompt({ scenario, identity, errand, persona = null }) {
  if (!scenario || typeof scenario.prompt !== "string") throw new Error("buildScenarioPrompt: scenario.prompt");
  if (!identity) throw new Error("buildScenarioPrompt: identity");
  // The errand leads: her reason comes before the mechanics of how the visit ends.
  const opening = errand ? `${String(errand).trim()}\n\n` : "";
  const vars = {
    address: identity.email,
    email: identity.email,
    firstName: identity.firstName,
    lastName: identity.lastName,
    fullName: identity.fullName,
    phone: identity.phone,
  };
  let told = scenario.prompt.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (m, key) => (key in vars ? vars[key] : m)).trim();
  const rule = supportRule(persona, scenario);
  if (rule === "forbidden")
    told = `${told.replace(SUPPORT_ENCOURAGED, "").replace(/ {2,}/g, " ").trim()} ${scenario.inbox === true ? SUPPORT_FORBIDDEN_INBOX : SUPPORT_FORBIDDEN}`;
  else if (rule === "encouraged" && !told.includes(SUPPORT_ENCOURAGED)) told = `${told} ${SUPPORT_ENCOURAGED}`;
  return (opening + told).trim();
}

/**
 * `node lib/personas.mjs --brain-prompt`, handed `buildBrainSystemPrompt`'s argument as JSON on
 * stdin, prints her system prompt. The cannon renders every Sue's prompt through this, in a fresh
 * node, so an edit to this file or to anything it imports (findings.mjs's interview keys) reaches
 * the next Sue the way a body edit does. A `--forever` cannon that built prompts in-process kept the
 * copy it loaded at startup while her tools moved on (Owner, 2026-09-21: Sues ASKED for
 * starsOutOfFive by their tools whose prompts never mentioned it).
 */
if (isMainModule(import.meta.url) && process.argv.includes("--brain-prompt")) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  process.stdout.write(buildBrainSystemPrompt(JSON.parse(input)));
}
