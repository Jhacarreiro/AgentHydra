/**
 * workspace - the per-workspace SUE store: intents, journals and the scoreboard.
 * =========================================================================================
 *
 * Owner ask (Owner, 2026-09-21): "make Sue into an MCP server on my PC that we can use, and you
 * just create your personas per workspace, save your personas, and each one of your personas save
 * their journal entry, whatever scoreboard ... all you have to do is point it at the page and say
 * run Sue."
 *
 * Everything a workspace owns lives in `<workspace>/.sue/`, the layout Example App Next already
 * uses, so nothing that exists today moves:
 *
 *   .sue/target.<slug>.json     one per page SUE was pointed at (derived from the URL, editable)
 *   .sue/target.json            a hand-written target still works exactly as before
 *   (this workspace's people live in Connections, never here: lib/people.mjs; only their painted
 *    cards sit in .sue/personas/portraits/)
 *   .sue/scenarios/<id>.json    hand-written scenarios, plus intent-<hash>.json, one per intent
 *   .sue/journal/<persona>.jsonl  every visit a persona ever made, in her own words
 *   .sue/scoreboard.json        every page, every run: stars, accounts made, never-coming-back
 *
 * Heavy run output (screenshots, brain streams, browser profiles) stays under SUE_HOME/runs, never
 * in the workspace: a journal line is what she said and how it went, not the evidence locker.
 */
import { loadTarget, targetPath, targetRoot } from "../../lib/target.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { writeJsonAtomic as writeJsonShared } from "./atomic-json.mjs";
import { INTERVIEW_KEYS, INTERVIEW_OPTIONAL_KEYS, arrivalFrom, shapeInterview } from "./findings.mjs";
import { materialIdFrom } from "./material-address.mjs";
import { DIAL_NAMES, INBOX_CHOICES, SUPPORT_ENCOURAGED, builtInPerson, listPersonas, loadPersona, ownPeople } from "./personas.mjs";
import { CONNECTIONS_FAMILY, TWO_LABEL_SUFFIXES } from "./site-owner.mjs";

export const STORE_DIR = ".sue";
const ENGINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SLUG = /^[a-z0-9][a-z0-9-]*$/;
/** personas.mjs refuses an errand under this length: it must be a sentence, not a label. */
export const MIN_ERRAND_CHARS = 30;
const ERRAND_PLACEHOLDER = "You came to this page for the reason this run gives you when it starts.";
const MIND_PLACEHOLDER = "What you know comes down from Connections when a run sends you.";

/** Hosts that belong to one product family: a Sue sent to any of them may walk into the others. */
const FAMILIES = [CONNECTIONS_FAMILY];
/** Always allowed: the bot-check frame a real visitor's browser also loads. */
const ALWAYS_HOSTS = ["challenges.cloudflare.com"];
/** The reserved fictional NANP number every Sue carries (SPEC: never SMS). */
export const SUE_PHONE = "+12065550100";
/** Where a Sue's own mail lands. `app.example.com` once its MX is live; see mailbox.mjs. */
export const DEFAULT_MAILBOX = Object.freeze({ kind: "ses-inbound", domain: "example.com" });

export function workspaceRoot(ws) {
  return path.resolve(ws || targetRoot());
}

export function storeDir(ws) {
  return path.join(workspaceRoot(ws), STORE_DIR);
}

export function ensureStore(ws) {
  const dir = storeDir(ws);
  for (const sub of ["scenarios", "journal"]) fs.mkdirSync(path.join(dir, sub), { recursive: true });
  return dir;
}

/** `app.example.com` -> `example.com`; `app.foo.co.uk` -> `foo.co.uk`; an IP or localhost stays whole. */
export function registrableDomain(host) {
  const h = String(host || "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h.includes(".") || /^\d+(\.\d+){3}$/.test(h)) return h;
  const labels = h.split(".");
  const lastTwo = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIXES.has(lastTwo) && labels.length > 2 ? labels.slice(-3).join(".") : lastTwo;
}

/** Each domain and its subdomains, as allowedHosts spells them. */
function domainHosts(domains) {
  return domains.flatMap((d) => [d, `*.${d}`]);
}

/**
 * Every host a Sue sent to `url` may visit: its site, the site's subdomains, its product family.
 * An `owned` site is one of ours, and ours sign in (app.example.com) and take payment
 * (example.com) through Connections, so those hops are part of the site: without them
 * every Sue on pinkyrest.com bounced off Sign in as "another website" (run 20260926-091603-9591).
 * Somebody else's live site stays fenced to its own host.
 */
export function allowedHostsFor(url, { owned = false } = {}) {
  const { hostname } = new URL(url);
  // Something a person gave the group (lib/material.mjs): that one item, fenced, because a bare
  // 127.0.0.1 would let her walk into every other server on this computer.
  const material = materialIdFrom(url);
  if (material) return [`${hostname}/material/${material}`];
  const root = registrableDomain(hostname);
  const family = FAMILIES.find((f) => f.includes(root)) ?? [root];
  const hosts = domainHosts(family);
  if (!family.includes(hostname) && !hosts.includes(hostname)) hosts.unshift(hostname);
  return [...new Set([...hosts, ...(owned ? domainHosts(CONNECTIONS_FAMILY) : []), ...ALWAYS_HOSTS])];
}

/**
 * A hand-written host list is kept as written; an owned site's list always carries the Connections family.
 * The file's list is also the last derivation's, so when ownership changes the hand's edit (what it
 * added, what it took out) is replayed onto the new derivation: keeping the list whole left a page
 * first run as ours, then as somebody else's, still walking into app.example.com.
 */
function hostsFor(url, written, owned, wasOwned) {
  let hosts = written ?? allowedHostsFor(url, { owned });
  if (written && owned !== wasOwned) {
    const before = allowedHostsFor(url, { owned: wasOwned });
    const removed = before.filter((h) => !written.includes(h));
    const added = written.filter((h) => !before.includes(h));
    hosts = [...new Set([...allowedHostsFor(url, { owned }).filter((h) => !removed.includes(h)), ...added])];
  }
  return owned && !materialIdFrom(url) ? [...new Set([...hosts, ...domainHosts(CONNECTIONS_FAMILY)])] : hosts;
}

/** A stable, readable key for a page: host plus its first path segment. The code in an invite link
 *  is dropped, so every link of one campaign lands on one scoreboard row. */
export function pageKey(url) {
  const u = new URL(url);
  // Every item a person gave a group sits under /material/: each is its own page, not one row for all.
  const material = materialIdFrom(url);
  if (material) return `${u.host}/material/${material}`;
  const first = u.pathname.split("/").filter(Boolean)[0] ?? "";
  return `${u.host}${first ? `/${first}` : ""}`;
}

export function slugFor(text, max = 48) {
  const s = String(text)
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return s || "page";
}

function hash8(text) {
  return crypto.createHash("sha256").update(String(text)).digest("hex").slice(0, 8);
}

/** Side-by-side runs write one target and one scenario: the shared writer retries and skips identical bytes. */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJsonShared(file, value);
  return file;
}

function readJsonOr(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Hand-written targets on this machine: the workspace's own `.sue/target*.json`, then the engine's. */
function handWrittenTargets(dir) {
  const files = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) if (/^target(\..+)?\.json$/.test(f)) files.push(path.join(dir, f));
  const engine = path.join(ENGINE_DIR, "targets");
  for (const d of fs.existsSync(engine) ? fs.readdirSync(engine) : []) files.push(path.join(engine, d, "target.json"));
  return files;
}

const hasTruth = (g) => Boolean(g && (String(g.oneLiner ?? "").trim() || g.mustGet?.length));

/** The first time SUE meets a page, what somebody already wrote about it by hand (its ground truth,
 *  its exits, its mailbox) comes along, so pointing at a page never throws that knowledge away. */
function seedTargetFor(dir, url) {
  const key = pageKey(url);
  for (const file of handWrittenTargets(dir)) {
    const t = readJsonOr(file, null);
    // A seed has to know something: a blank derived target (this page's own included) is not one.
    if (!t?.startUrl || !(hasTruth(t.groundTruth) || t.exits?.length)) continue;
    try {
      if (pageKey(t.startUrl) === key) return { ...t, seededFrom: file };
    } catch {
      /* a target with a start URL that does not parse is not a seed */
    }
  }
  return null;
}

/**
 * The target for one page, written the first time SUE is pointed at it and reused after that.
 *
 * `start: "link"` (default) - she was handed this exact link, the way a friend's WhatsApp message
 *   or an email hands it over. `start: "home"` - she only knows the site, lands on its front door
 *   and has to find the page herself. `start: "inbox"` - she was sent `arrival` ({from, subject,
 *   html|text}, the caller's own email or post, carrying the link) and her first screen is that
 *   message in her own inbox. Every way her browser is a fresh, empty one: no cookies, no account,
 *   no session - nothing a first-time visitor would not have.
 *
 * A hand edit to the file (a sharper groundTruth, an exit) survives: only startUrl follows the call.
 *
 * `listed`: the page is on this workspace's own websites (lib/owned-sites.mjs, read by the planner for this run).
 */
export function deriveTarget({
  ws,
  url,
  start = "link",
  groundTruth = null,
  exits = null,
  arrival = null,
  decoys = false,
  owned = null,
  listed = false,
}) {
  const parsed = new URL(url);
  if (!/^https?:$/.test(parsed.protocol)) throw new Error(`url must be http(s): ${url}`);
  if (!["link", "home", "inbox"].includes(start))
    throw new Error(
      `start must be "link" (she was sent this exact link), "home" (she starts at the site's front page) or "inbox" (she was sent the arrival message and starts on it)`,
    );
  if (start === "inbox" && !arrival)
    throw new Error('start: "inbox" needs arrival: {from, subject, html or text}, the message that sent her');
  if (arrival && start !== "inbox") throw new Error('an arrival message only makes sense with start: "inbox"');
  const sent = arrival ? arrivalFrom(arrival) : null;
  const dir = ensureStore(ws);
  const id = slugFor(pageKey(url));
  const file = path.join(dir, `target.${id}.json`);
  const own = readJsonOr(file, null);
  // A derived file whose ground truth was never filled in still learns from a hand-written seed.
  const seed = own && hasTruth(own.groundTruth) ? null : seedTargetFor(dir, url);
  const existing = own ?? seed;
  const startUrl = start === "home" ? `${parsed.origin}/` : parsed.href;
  // `owned`: the caller says whose site this is, and the page's file keeps it for every later run. With no word from
  // either, a site on the workspace's own websites is ours for its hosts too: its Sues make accounts, so they follow its
  // sign-in and checkout to Connections. The file notes it (`listedSite`), never as `owned`, so a later run that finds
  // the site off the list takes those hosts back out, and the page's own word keeps outranking the list.
  const word = typeof owned === "boolean" ? owned : typeof own?.owned === "boolean" ? own.owned : null;
  const isOwned = word ?? listed === true;
  const wasOwned = typeof existing?.owned === "boolean" ? existing.owned : existing?.listedSite === true;
  const target = {
    // Whatever a hand wrote into this page's own file and nothing below recomputes: a `refuseClicks`
    // rail, `errands`, `knownAddresses`, `canvas`. Listing the kept fields one by one dropped every
    // field nobody had listed, so a rail written to stop Sues sending anything vanished at the next run.
    ...(own ?? {}),
    id,
    startUrl,
    allowedHosts: hostsFor(url, existing?.allowedHosts, isOwned, wasOwned),
    groundTruth: groundTruth ??
      (hasTruth(own?.groundTruth) ? own.groundTruth : seed?.groundTruth) ?? { oneLiner: "", mustGet: [], shouldGet: [], wrongIf: [] },
    ...((exits ?? existing?.exits ?? seed?.exits) ? { exits: exits ?? existing?.exits ?? seed.exits } : {}),
    // A file or an idea needs no sign-up, so it has no mailbox: no mailroom starts and nothing reads AWS.
    mailbox: materialIdFrom(url) !== null ? { kind: "none" } : (existing?.mailbox ?? { ...DEFAULT_MAILBOX }),
    identityPhone: existing?.identityPhone ?? SUE_PHONE,
    ...(existing?.expectedLandingAfterSignup ? { expectedLandingAfterSignup: existing.expectedLandingAfterSignup } : {}),
    ...(existing?.blockRequests ? { blockRequests: existing.blockRequests } : {}),
    ...((seed?.seededFrom ?? own?.seededFrom) ? { seededFrom: seed?.seededFrom ?? own.seededFrom } : {}),
    page: { url: parsed.href, key: pageKey(url), start },
  };
  if (typeof owned === "boolean") target.owned = owned;
  if (word === null && listed === true) target.listedSite = true;
  else delete target.listedSite;
  // The message follows the call, like startUrl: kept from the file it would send a later link start
  // to her inbox with an old email in it.
  if (sent) target.arrival = sent;
  else delete target.arrival;
  if (sent && decoys) target.decoys = true;
  else delete target.decoys;
  writeJsonAtomic(file, target);
  return { file, target };
}

/** The longest `expect` a run takes: one short line on what the page is meant to be. */
export const MAX_EXPECT_CHARS = 300;

/** A run's `expect` trimmed, or "" when none; one over the ceiling is refused in words a caller can act on. */
export function expectOf(expect) {
  const text = String(expect ?? "").trim();
  if (text.length > MAX_EXPECT_CHARS)
    throw new Error(
      `expect is at most ${MAX_EXPECT_CHARS} characters (got ${text.length}): one short line on what this page is meant to be`,
    );
  return text;
}

/**
 * The scenario for an intent: the one sentence the caller said about WHY these people are here.
 * Same intent, same file, so an intent run twice is one scenario with a history.
 *
 * ⛔ The prompt never tells her the shortcut. It says what a real person would do: get there, make
 * an account if that is what it takes, read her own mail like anybody would, and complain to the
 * company when it breaks - because a real annoyed customer does exactly that.
 */
export function intentScenario({
  ws,
  intent,
  createAccounts = true,
  // Off unless asked (Owner, 2026-09-30): on Connections' own sites a support message is a paid AI turn,
  // so the planner (sue.mjs planRun) turns it on only for a run that asks for `contactSupport: true`.
  contactSupport = false,
  goal = null,
  liveSite = false,
  errands = null,
  legs = 1,
  interview = null,
  expect = null,
  watches = null,
  // A power user, not a stranger (lib/findings.mjs APE_QUESTIONS): true, or not set for a stranger.
  ape = false,
  // A design reviewer (ART, sue/README.md#art): true, or not set for anyone else. Her id is her own, never a plain run's.
  art = false,
  // An inbox test (lib/inbox-test.mjs): she was sent an email and deals with it; visiting the site, and any account, are her choice.
  inbox = false,
}) {
  if (watches != null && watches !== "ad") throw new Error(`watches is "ad" or not set (got ${JSON.stringify(watches)})`);
  if (inbox != null && inbox !== true && inbox !== false) throw new Error(`inbox is true or not set (got ${JSON.stringify(inbox)})`);
  if (ape != null && ape !== true && ape !== false) throw new Error(`ape is true or not set (got ${JSON.stringify(ape)})`);
  if (art != null && art !== true && art !== false) throw new Error(`art is true or not set (got ${JSON.stringify(art)})`);
  if (!intent || !String(intent).trim())
    throw new Error("intent is required: one sentence on why these people are visiting, in plain words");
  if (String(intent).trim().length < MIN_ERRAND_CHARS)
    throw new Error(
      `intent must be a whole sentence (${MIN_ERRAND_CHARS}+ characters) in their terms, e.g. "a friend posted this link in his WhatsApp group; you want to post your deals there"`,
    );
  if (liveSite && (createAccounts || contactSupport))
    throw new Error(
      "on somebody else's live website no Sue makes an account or contacts them: createAccounts and contactSupport are off there",
    );
  // An errand of several jobs gives each Sue her patience on each (lib/clock.mjs legsOf), as a scenario file's
  // `legs` does: homework a teacher set runs a whole lesson, and one leg of a kid's two minutes cut every synthetic
  // kid off inside its first part (Lift, 2026-09-29).
  if (!Number.isInteger(legs) || legs < 1 || legs > 5) throw new Error(`legs is a whole number from 1 to 5 (got ${legs})`);
  // What the page is meant to be, one short line: every Sue is told it, so a page that is something else gets noted.
  const expected = expectOf(expect);
  const dir = ensureStore(ws);
  // A cast's own errands (`errands`, by persona id) are part of what the scenario says, so they are part of its id.
  // Extra exit-interview questions a round plan asks (`interview: {key: question}`), kept as the scenario's own.
  const extraInterview =
    interview && typeof interview === "object" && !Array.isArray(interview) && Object.keys(interview).length ? interview : null;
  const castKey = errands ? JSON.stringify(Object.entries(errands).sort()) : "";
  const id = `intent-${hash8(`${intent}|${createAccounts}|${contactSupport}|${goal ?? ""}${liveSite ? "|live" : ""}${castKey ? `|${castKey}` : ""}${legs > 1 ? `|legs${legs}` : ""}${extraInterview ? `|iv${hash8(JSON.stringify(extraInterview))}` : ""}${expected ? `|expect${hash8(expected)}` : ""}${watches === "ad" ? "|ad" : ""}${ape === true ? "|ape" : ""}${art === true ? "|art" : ""}${inbox === true ? "|inbox" : ""}`)}`;
  const accountLine = createAccounts
    ? inbox
      ? null
      : "If getting there needs an account, make one yourself, the normal way, with your own email - and read your own inbox for anything they send you, the way anybody would, including any welcome email. Say what you think of it."
    : "Do not make an account; if the page will not let you go further without one, say so and stop.";
  const lines = [
    inbox
      ? "Take as long as you really would."
      : watches === "ad"
        ? "You scrolled your feed and this ad is what you saw. Look at it and at where it takes you, as you would in your own feed, and say what you made of it."
        : ape === true
          ? "Open it and get done what you came for, the fast way you always do: you know how this kind of thing should work."
          : "Open the page and try to do what you came here for. Take as long as you really would.",
    ...(expected ? [`You were told this is ${expected.replace(/[.\s]+$/, "")}.`, "If what you find is not that, say so in a note."] : []),
    ...(accountLine ? [accountLine] : []),
    ...(inbox ? [INBOX_CHOICES] : []),
  ];
  // Somebody else's live website (lib/site-owner.mjs): everything up to the Send button, never the send.
  if (liveSite)
    lines.push(
      "This is somebody else's real website: go as far as you really would, right up to the Send button on any form, and stop there without sending it.",
    );
  // Off is not silence: buildScenarioPrompt adds the prohibition for every Sue this run forbids.
  if (contactSupport) lines.push(SUPPORT_ENCOURAGED);
  lines.push("When you have done it, or when you have had enough, stop.");
  const extra = [];
  if (contactSupport) extra.push("contactedSupport {did (true or false), how, whatISaid}");
  if (createAccounts) extra.push("emailsReceived, a list of {from, subject, whatIThought} for every email they sent you");
  if (extra.length) lines.push(`In your exit interview, also answer ${extra.join(" and ")}.`);
  const scenario = {
    id,
    title: String(intent).slice(0, 120),
    prompt: lines.join(" "),
    createsAccount: Boolean(createAccounts),
    ...(legs > 1 ? { legs } : {}),
    expectedLandingPattern: null,
    successWhen: goal || `She did what she came for: ${intent}`,
    // A cast visitor arrives for her own reason; everyone else for the intent.
    errands: { ...(errands ?? {}), "*": [String(intent).trim()] },
    intent: String(intent).trim(),
    ...(expected ? { expect: expected } : {}),
    contactSupport: Boolean(contactSupport),
    ...(watches === "ad" ? { watches: "ad" } : {}),
    ...(ape === true ? { ape: true } : {}),
    ...(art === true ? { art: true } : {}),
    ...(inbox === true ? { inbox: true } : {}),
    // Her exit interview asks about the moment she stopped (lib/personas.mjs LIVE_WEBSITE tells her so).
    ...(liveSite || extraInterview
      ? {
          interview: {
            ...(extraInterview ?? {}),
            ...(liveSite
              ? {
                  stoppedAtSend:
                    "this website is real, so you stopped at the Send button on purpose: what you were about to send them, whether you would really have pressed Send, and what you expected to happen next (or that you never got as far as a Send button, and why)",
                }
              : {}),
          },
        }
      : {}),
  };
  // Written over the file as it stands: a field a newer Sue added (an older snapshot of this code still
  // runs a wave after the checkout moves on, lib/engine-store.mjs) or a hand wrote is kept.
  const file = path.join(dir, "scenarios", `${id}.json`);
  const prior = readJsonOr(file, null);
  writeJsonAtomic(file, { ...(prior && typeof prior === "object" && !Array.isArray(prior) ? prior : {}), ...scenario });
  return { id, scenario };
}

// ── personas ────────────────────────────────────────────────────────────────────────────────

/** `mobile`/`tablet` mean phone to the body; everything else it does not know means desktop. */
const DEVICE_ALIASES = {
  mobile: "phone",
  cell: "phone",
  iphone: "phone",
  android: "phone",
  tablet: "phone",
  laptop: "desktop",
  pc: "desktop",
  computer: "desktop",
};

/** A persona's `for` list, lower-cased hosts, or null when she was written for any site. */
function hostsOf(value) {
  const hosts = Array.isArray(value) ? value.map((h) => String(h).trim().toLowerCase()).filter(Boolean) : [];
  return hosts.length ? hosts : null;
}

/**
 * Was a saved persona written for this url? Yes when she declares no `for` hosts, or one of them is
 * the url's host (a leading `www.` ignored). A persona's `voice` often carries the errand she was
 * written for: the seven Deal Flow people each "got the link from a WhatsApp deals group", and a link
 * run on example.com that named nobody sent three of them there, all of whom read Book as
 * the wrong page (run 20260923-083441-985f). So a persona may say which sites she belongs to.
 */
export function writtenFor(persona, url) {
  const hosts = hostsOf(persona?.for);
  if (!hosts) return true;
  let host;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return false;
  }
  return hosts.some((h) => h.replace(/^www\./, "") === host);
}

/**
 * This workspace's own people, as Connections answered them to this process (lib/personas.mjs `installPeople`): a
 * workspace's people live in Connections, never in its folder (Owner, 2026-09-28). `ws` is kept for the callers that
 * name the folder the people belong to.
 */
export function listWorkspacePersonas(_ws) {
  return ownPeople().map((p) => ({
    id: p.id,
    displayName: p.displayName,
    like: p.extends ?? null,
    errands: p.errands?.length ?? 0,
    voice: String(p.voice ?? "").slice(0, 160),
    for: hostsOf(p.for),
    // The workspace's copy of a built-in (editPersona): the built-in with a change, never a person of the folder's own.
    ...(p.extends === p.id ? { builtInCopy: true } : {}),
  }));
}

/** A folder's own person's portrait (`.sue/personas/portraits/<id>.webp`, a painted card; its prompt is in that folder's credits.json), or null. */
export function ownPersonPortraitFile(ws, id) {
  if (!SLUG.test(String(id ?? "")) || String(id).length > 64) return null;
  const file = path.join(storeDir(ws), "personas", "portraits", `${id}.webp`);
  return fs.existsSync(file) ? file : null;
}

/** The fields a person's doc carries - everything a run reads from her, and nothing else. */
export const PERSONA_DOC_KEYS = [
  "id",
  "displayName",
  "extends",
  "voice",
  "errands",
  "dials",
  "identity",
  "complains",
  "for",
  "depth",
  "critic",
  "interview",
];

/**
 * Sue's own people, for a workspace's People list and `sue personas`. One file the loader refuses is
 * that person's problem, never the list's: she is listed with the loader's own words in `problem`, and
 * a wave that sends her is refused by `sue run` in the same words. 2026-09-22 (ARGUS, 884 answers of
 * HTTP 500): a Manager whose loader refused the roster's files failed every workspace view whole.
 * The words name no path of this computer: the Manager hands them to the page.
 */
export function listRosterPersonas({ list = listPersonas, load = loadPersona } = {}) {
  return list().map((id) => {
    try {
      const p = load(id);
      return { id, displayName: p.displayName, device: p.dials?.device, voice: String(p.voice ?? "").slice(0, 160) };
    } catch (err) {
      return { id, displayName: id, device: undefined, voice: "", problem: String(err?.message ?? err).split("\n")[0] };
    }
  });
}

/** Said once in her voice when she tells the company (`complains: true`): a persona written back from Connections already carries it. */
const COMPLAINS_LINE =
  " When something is broken or wastes your time, you do not just leave: you find a way to tell the company, and you tell them straight.";

/**
 * Make a person in one call, ready to save to Connections (lib/people.mjs `savePeople`): `like` borrows a
 * built-in's body (dials, identity ranges, model); `voice` and `errands` are hers. She is loaded through
 * the same loader the cannon uses before this returns - a person this makes is a person a run can use -
 * and nothing is written anywhere: she lives in Connections, never in this folder (Owner, 2026-09-28).
 * Her copy in Connections keeps every field this call does not decide.
 */
export function buildPersona({
  id,
  displayName,
  like: likeName,
  // Her doc stores the body as `extends` and the README names it so: dropped silently, a person written that way got bob's.
  extends: extendsName,
  voice,
  errands = [],
  dials = {},
  identity = null,
  complains = null,
  for: sites = null,
  depth = null,
  critic = false,
  interview = null,
}) {
  const pid = slugFor(id ?? displayName ?? "", 40);
  if (!SLUG.test(pid)) throw new Error("id must be a short slug like broker-ray");
  if (!voice || String(voice).trim().length < 40)
    throw new Error(
      "voice is who she is, in the second person, at least a sentence or two: 'You are Ray, 54, a commercial real estate broker...'",
    );
  if (likeName != null && extendsName != null && likeName !== extendsName)
    throw new Error(`like "${likeName}" and extends "${extendsName}" name two different bodies: give one`);
  const like = likeName ?? extendsName;
  const roster = listPersonas();
  // Saved again without `like`, she keeps the body she had (a copy of a built-in keeps that built-in's); a new one is bob's.
  const prior = ownPeople().find((p) => p.id === pid) ?? null;
  const base = like ?? (typeof prior?.extends === "string" ? prior.extends : roster.includes(pid) ? pid : "bob");
  if (!roster.includes(base)) throw new Error(`like must name a built-in persona to borrow a body from: ${roster.join(", ")}`);
  const cleanDials = {};
  for (const [k, v] of Object.entries(dials ?? {})) {
    if (!DIAL_NAMES.includes(k)) throw new Error(`unknown dial "${k}". The dials are: ${DIAL_NAMES.join(", ")}`);
    cleanDials[k] = k === "device" ? (DEVICE_ALIASES[String(v).toLowerCase()] ?? String(v).toLowerCase()) : v;
  }
  if (cleanDials.device && !["phone", "desktop"].includes(cleanDials.device))
    throw new Error(`device "${dials.device}" - use phone or desktop`);
  const list = (Array.isArray(errands) ? errands : [errands]).map((e) => String(e).trim()).filter(Boolean);
  const said = String(voice).trim();
  const persona = {
    id: pid,
    displayName: displayName || pid.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
    extends: base,
    voice: said + (complains === true && !said.endsWith(COMPLAINS_LINE.trim()) ? COMPLAINS_LINE : ""),
    ...(list.length ? { errands: list } : {}),
    ...(Object.keys(cleanDials).length ? { dials: cleanDials } : {}),
    ...(identity ? { identity } : {}),
    // Stored, not only voiced: false is a prohibition buildScenarioPrompt says to her, and it wins
    // over the run's contactSupport, so one run can hold loud and quiet Sues.
    ...(typeof complains === "boolean" ? { complains } : {}),
    // The sites she was written for (`writtenFor`): a link run elsewhere that names nobody leaves her home.
    ...(hostsOf(sites) ? { for: hostsOf(sites) } : {}),
    // Which form made her, Simple or Advanced (the one persona creator, Owner, 2026-09-25): the page
    // opens her on it, and the Boardroom files her under it. A run never reads it.
    ...(depth === "simple" || depth === "advanced" ? { depth } : {}),
    // A critic reviews where every other Sue visits (lib/personas.mjs): the switch and the questions her job
    // asks. Her mind is not in her doc; it is her playbook in Connections (sue/mind.mjs push).
    ...(critic === true ? { critic: true } : {}),
    ...(interview != null ? { interview } : {}),
  };
  // Every field this call does not decide is kept: one a newer Sue writes (an older engine still runs
  // after an update, lib/engine-lease.mjs) or the Boardroom's editor adds. The fields it does decide follow
  // the call, so an errand left out of a re-save is gone, as before.
  const kept =
    prior && typeof prior === "object" && !Array.isArray(prior)
      ? Object.fromEntries(Object.entries(prior).filter(([k]) => !PERSONA_DOC_KEYS.includes(k)))
      : {};
  const doc = { ...persona, ...kept };
  try {
    // A persona with no errands of her own still loads when a run hands her an intent; check her
    // with a placeholder errand so this refuses exactly what a run would refuse, and nothing else.
    // The placeholder has to pass the same errand rule as a real one (a sentence, 30+ characters).
    // A critic's mind is pinned by the run that sends her, never carried in her doc, so she is checked with a
    // placeholder mind the same way. She is checked as the cast of one page: no file is ever written to check her.
    loadPersona(pid, {
      target: {
        cast: { [pid]: doc },
        errands: list.length ? undefined : { [pid]: [ERRAND_PLACEHOLDER] },
        minds: critic === true ? { [pid]: MIND_PLACEHOLDER } : undefined,
      },
    });
  } catch (err) {
    throw new Error(`that persona would not load, nothing was saved: ${err.message}`, { cause: err });
  }
  return { persona: doc };
}

/** The fields `editPersona` takes by name; `set` carries any field, one no editor knows yet included. */
const EDIT_FIELDS = ["displayName", "like", "voice", "errands", "dials", "identity", "complains", "for", "depth", "critic", "interview"];
/** A field a person may carry: the engine names its fields as short camelCase words (the Boardroom keeps the same shape). */
const FIELD_KEY = /^[A-Za-z][A-Za-z0-9]{0,39}$/;

/** Set field `key` of `doc` (a copy being edited) to `value`, checked the way `buildPersona` checks it. */
function setField(doc, key, value) {
  switch (key) {
    case "like":
      if (!listPersonas().includes(value))
        throw new Error(`like must name a built-in persona to borrow a body from: ${listPersonas().join(", ")}`);
      doc.extends = value;
      return;
    case "voice":
      if (String(value).trim().length < 40) throw new Error("voice is who she is, in the second person, at least a sentence or two");
      doc.voice = String(value).trim();
      return;
    case "errands": {
      const list = (Array.isArray(value) ? value : [value]).map((e) => String(e).trim()).filter(Boolean);
      if (list.length) doc.errands = list;
      else delete doc.errands;
      return;
    }
    case "dials": {
      if (typeof value !== "object" || Array.isArray(value)) throw new Error("dials is an object of dial: value");
      const dials = { ...(doc.dials ?? {}) };
      for (const [k, v] of Object.entries(value)) {
        if (!DIAL_NAMES.includes(k)) throw new Error(`unknown dial "${k}". The dials are: ${DIAL_NAMES.join(", ")}`);
        if (v === null) delete dials[k];
        else dials[k] = k === "device" ? (DEVICE_ALIASES[String(v).toLowerCase()] ?? String(v).toLowerCase()) : v;
      }
      if (dials.device && !["phone", "desktop"].includes(dials.device)) throw new Error(`device "${dials.device}" - use phone or desktop`);
      if (Object.keys(dials).length) doc.dials = dials;
      else delete doc.dials;
      return;
    }
    case "for":
      if (!hostsOf(value)) throw new Error('for names the sites she was written for, e.g. ["example.com"]');
      doc.for = hostsOf(value);
      return;
    case "depth":
      if (value !== "simple" && value !== "advanced") throw new Error("depth is simple or advanced");
      doc.depth = value;
      return;
    case "critic":
      if (value === true) doc.critic = true;
      else delete doc.critic;
      return;
    case "complains":
      if (typeof value !== "boolean")
        throw new Error("complains is true (she tells the company) or false (she never does); null leaves it to the run");
      doc.complains = value;
      return;
    default:
      doc[key] = value;
  }
}

/**
 * Change a person in one call: name the fields that change and every other field stays as her copy in Connections has
 * it (Owner, 2026-09-28: adding a feature to a persona takes seconds, and every run after it has it). `set` carries any
 * field by name, one no editor has heard of included, so a field the engine learns tomorrow is set the same minute; null
 * removes a field, and a dial set to null goes back to her body's own. A built-in with no copy in this workspace yet
 * gets one that holds ONLY what changed (`extends` is her own id, lib/personas.mjs loadPersona), so every later
 * improvement to the built-in still reaches her. Checked through the loader a run uses; nothing is written here, the
 * caller saves her (lib/people.mjs savePeople, or the sue door's MCP).
 */
export function editPersona({ id, set = {}, builtIn: forEveryone = false, ...named }) {
  const pid = String(id ?? "");
  if (!SLUG.test(pid)) throw new Error("id must name the person to change, e.g. broker-ray");
  if (set === null || typeof set !== "object" || Array.isArray(set)) throw new Error("set is an object of field: value");
  if (typeof forEveryone !== "boolean") throw new Error("builtIn is true (change the built-in for everyone) or false");
  // builtIn: the built-in herself changes, for every member (a Connections admin's edit; the Boardroom refuses anyone
  // else). Otherwise the change is this workspace's copy of her.
  const own = forEveryone ? null : (ownPeople().find((p) => p.id === pid) ?? null);
  const builtIn = builtInPerson(pid);
  if (forEveryone && !builtIn)
    throw new Error(`no built-in person is called "${pid}": builtIn changes one of ${listPersonas().join(", ")}`);
  if (!own && !builtIn) {
    const people = [...ownPeople().map((p) => p.id), ...listPersonas()];
    throw new Error(`nobody is called "${pid}" here: make her with save_persona, or change one of ${people.join(", ")}`);
  }
  const changes = { ...set };
  for (const key of EDIT_FIELDS) if (named[key] !== undefined) changes[key] = named[key];
  if (!Object.keys(changes).length) throw new Error("name at least one field to change, or give them in set");
  const doc = forEveryone ? builtIn : own ? structuredClone(own) : { id: pid, extends: pid };
  if (forEveryone && "like" in changes) throw new Error("a built-in is a whole person: change her fields, not whom she is like");
  for (const [key, value] of Object.entries(changes)) {
    if (key === "mindText")
      throw new Error("a critic's mind is her playbook in Connections: send it with node sue/mind.mjs push <id> <file.md>");
    if (!FIELD_KEY.test(key) || key === "id") throw new Error(`"${key}" is not a field a person can carry`);
    if (value === null) delete doc[key];
    else setField(doc, key, value);
  }
  doc.displayName ||= own?.displayName || builtIn?.displayName || pid.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  // Her voice says what her `complains` says: the line goes in with true and comes out with anything else.
  // An empty voice is none (a copy of a built-in comes back from Connections with ""): hers is the built-in's then.
  if (!doc.voice) delete doc.voice;
  else {
    const line = COMPLAINS_LINE.trim();
    const bare = doc.voice.endsWith(line) ? doc.voice.slice(0, -line.length).trimEnd() : doc.voice;
    doc.voice = doc.complains === true ? bare + COMPLAINS_LINE : bare;
  }
  return { persona: checkPersonaDoc(doc), changed: Object.keys(changes), ...(forEveryone ? { builtIn: true } : {}) };
}

/**
 * A whole person as a page or a file hands her over (Studio's Sue page, a folder's old `.sue/personas` file), checked by
 * the loader a run uses exactly as buildPersona checks a new one: the cast of one page, with a placeholder errand and
 * mind. Returned as she is; throws the loader's own words, so a person refused here is one a run would refuse too.
 */
export function checkPersonaDoc(doc) {
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("not a person");
  const pid = String(doc.id ?? "");
  if (!SLUG.test(pid)) throw new Error("id must be a short slug like broker-ray");
  if (!String(doc.displayName ?? "").trim()) throw new Error("displayName is her name in reports");
  try {
    loadPersona(pid, {
      target: {
        cast: { [pid]: doc },
        errands: doc.errands?.length ? undefined : { [pid]: [ERRAND_PLACEHOLDER] },
        minds: doc.critic === true ? { [pid]: MIND_PLACEHOLDER } : undefined,
      },
    });
  } catch (err) {
    throw new Error(`that person would not load, nothing was saved: ${err.message}`, { cause: err });
  }
  return doc;
}

// ── journals ────────────────────────────────────────────────────────────────────────────────

export function journalFile(ws, personaId) {
  return path.join(storeDir(ws), "journal", `${slugFor(personaId, 60)}.jsonl`);
}

export function appendJournal(ws, personaId, entry) {
  const file = journalFile(ws, personaId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  return file;
}

// A journal is parsed again only when it grew or changed: the Manager's page asks for every
// person's journal each time it shows a workspace, and one person's can run to thousands of visits.
const JOURNALS = new Map();

export function readJournal(ws, personaId, limit = 10) {
  const file = journalFile(ws, personaId);
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    JOURNALS.delete(file);
    return [];
  }
  let hit = JOURNALS.get(file);
  if (!hit || hit.mtimeMs !== stat.mtimeMs || hit.size !== stat.size) {
    const rows = fs
      .readFileSync(file, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    hit = { mtimeMs: stat.mtimeMs, size: stat.size, rows };
    JOURNALS.set(file, hit);
  }
  return hit.rows.slice(-Math.max(1, limit)).reverse();
}

/**
 * One visit, as her journal keeps it: what she came for, what she said as she went, how it ended,
 * and her verdict. Built from the files a finished Sue already leaves, plus the run's report for
 * the lines she wrote (report.mjs owns what counts as a diary line, so this never re-decides it).
 */
export function journalEntryFromSue({ sueDir, report, page, intent, runId, build = null }) {
  const read = (f) => readJsonOr(path.join(sueDir, f), null);
  const sue = read("sue.json") ?? {};
  const summary = read("summary.json") ?? {};
  const body = read("body.json") ?? {};
  // Shaped on the way IN (`shapeInterview`), never trusted as written: a historical `interview.json`
  // holds bare `everComingBack: false` and nested answers the brain sent as JSON strings, and
  // reading those raw left the journal row's and the scoreboard's `everComingBack.yes` undefined.
  const rawInterview = read("interview.json");
  const interview = rawInterview ? shapeInterview(rawInterview) : null;
  const sueId = summary.sueId ?? sue.sueId ?? path.basename(sueDir);
  const diary = (report?.confusion?.diary ?? [])
    .filter((d) => d.sueId === sueId)
    .map((d) => ({ kind: d.kind, where: d.where ?? d.url, said: d.said }));
  const funnel = (report?.funnel?.perSue ?? []).find((f) => f.sueId === sueId) ?? null;
  // Her attention timeline (report.mjs buildAttention): every drop and hook with its time, why, fix
  // and severity, so a critic's journal IS the running list of what to fix on each page.
  const attention = (report?.attention?.perSue ?? []).find((row) => row.sueId === sueId)?.lines ?? [];
  // The problems she typed (report.mjs buildFiled), the rubric and where, never the facts: the journal is read by
  // the Manager and `sue journal`, never handed to a later Sue.
  const filed = (report?.filed?.problems ?? [])
    .filter((p) => p.sueId === sueId)
    .map(({ n, title, defect, severity, page: where, look }) => ({ n, title, defect, severity, page: where, look }));
  // What her scenario (or her critic persona) asked beyond the standard keys, answered in her words.
  const standard = new Set([...INTERVIEW_KEYS, ...INTERVIEW_OPTIONAL_KEYS]);
  const answers = Object.fromEntries(
    Object.entries(rawInterview ?? {}).filter(([key, value]) => !standard.has(key) && value != null && value !== ""),
  );
  return {
    at: summary.endedAt ?? new Date().toISOString(),
    runId,
    sueId,
    persona: summary.persona ?? sue.persona?.id ?? null,
    page: page ?? null,
    intent: intent ?? null,
    // What the page was serving at the moment this run started (the harness's own one-time read of
    // <origin>/build-stamp.json), so a visit can be told apart from one that hit an earlier build.
    // null on localhost, a stranger's site, or any fetch that did not land - never a guess.
    build: build ?? null,
    outcome: body.outcome ?? null,
    endedAt: body.finalUrl ?? null,
    madeAccount: Boolean(summary.madeAccount ?? interview?.madeAccount),
    stars: interview?.starsOutOfFive ?? null,
    everComingBack: interview?.everComingBack ?? null,
    threeWords: interview?.threeWords ?? null,
    whatIsThisSite: interview?.whatIsThisSite ?? null,
    mostConfusing: interview?.mostConfusing ?? null,
    whyStopped: interview?.whyStopped ?? null,
    contactedSupport: interview?.contactedSupport ?? null,
    emailsReceived: interview?.emailsReceived ?? null,
    diedAt: funnel?.diedAt ?? null,
    // What she thought this place was on her FIRST look (the first-look probe), scored like the exit answers:
    // null when she never answered it, which is a missing answer and never "no idea".
    firstLook: (report?.firstLook?.perSue ?? []).find((r) => r.sueId === sueId)?.bucket ?? null,
    diary,
    ...(attention.length ? { attention } : {}),
    ...(filed.length ? { filed } : {}),
    ...(Object.keys(answers).length ? { answers } : {}),
    costUsd: summary.totalCostUsd ?? null,
    seconds: summary.durationMs != null ? Math.round(summary.durationMs / 1000) : null,
  };
}

// ── scoreboard ──────────────────────────────────────────────────────────────────────────────

export function scoreboardFile(ws) {
  return path.join(storeDir(ws), "scoreboard.json");
}

export function readScoreboard(ws) {
  return readJsonOr(scoreboardFile(ws), { pages: {} });
}

const mean = (xs) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 100) / 100 : null);
const share = (n, d) => (d ? Math.round((n / d) * 1000) / 1000 : null);

/** One run's numbers for one page, folded into the page's row. Pure over the journal entries. */
export function scoreRun(entries) {
  const stars = entries.map((e) => e.stars).filter((s) => typeof s === "number");
  const answeredBack = entries.filter((e) => e.everComingBack && typeof e.everComingBack.yes === "boolean");
  return {
    sues: entries.length,
    averageStars: mean(stars),
    madeAccountShare: share(entries.filter((e) => e.madeAccount).length, entries.length),
    finishedShare: share(entries.filter((e) => e.outcome === "done").length, entries.length),
    neverComingBackShare: share(answeredBack.filter((e) => e.everComingBack.yes === false).length, answeredBack.length),
    // Homepage clarity, run to run: of the Sues who answered the first-look probe, the share who got it at once.
    firstLookGotItShare: share(entries.filter((e) => e.firstLook === "got-it").length, entries.filter((e) => e.firstLook).length),
    contactedSupport: entries.filter((e) => e.contactedSupport && (e.contactedSupport.did === true || e.contactedSupport.yes === true))
      .length,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** `.sue/runs.jsonl`: one line per wave `sue run` started from this workspace, oldest first. */
export function readRunsLog(ws) {
  let text;
  try {
    text = fs.readFileSync(path.join(storeDir(ws), "runs.jsonl"), "utf8");
  } catch {
    return [];
  }
  return text
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * How many waves were sent at one page from this workspace (Owner, 2026-09-23: "we dont want sue
 * running 57 times on the same page making changes in circles but its fine we just need to track it
 * so we know if its happening"). Read off `.sue/runs.jsonl`, the line `sue run` writes the moment a
 * wave starts, so a wave that was refused, stopped or never finished counts too; the scoreboard's own
 * `runs` counts only the waves that finished and were booked. Tracked, never a cap.
 */
export function pageRunTally(runs, key, now = Date.now()) {
  const here = (Array.isArray(runs) ? runs : []).filter((r) => {
    try {
      return typeof r?.url === "string" && pageKey(r.url) === key;
    } catch {
      return false;
    }
  });
  const within = (ms) => here.filter((r) => now - Date.parse(r.at ?? "") < ms).length;
  return {
    total: here.length,
    last24h: within(DAY_MS),
    last7d: within(7 * DAY_MS),
    firstAt: here[0]?.at ?? null,
    lastAt: here.at(-1)?.at ?? null,
  };
}

/** The tally in one plain line, for whoever started the wave. */
export function pageRunLine(tally) {
  if (!tally?.total) return "No wave has been sent at this page from this workspace yet.";
  const nth = tally.total === 1 ? "the first wave" : `wave ${tally.total}`;
  return `This is ${nth} sent at this page from this workspace (${tally.last24h} in the last day, ${tally.last7d} in the last week).`;
}

export function updateScoreboard(ws, { page, runId, intent, at, entries, build = null, sueVersion = null }) {
  const board = readScoreboard(ws);
  const key = page?.key ?? "unknown";
  const row = board.pages[key] ?? { url: page?.url ?? null, runs: 0, sues: 0, history: [] };
  const score = scoreRun(entries);
  row.url = page?.url ?? row.url;
  row.runs += 1;
  row.sues += score.sues;
  // Which SUE gave the score (lib/version.mjs), so a move in the stars can be told apart from a change to SUE.
  row.last = { runId, at, intent, build, sueVersion, ...score };
  row.history = [...(row.history ?? []), { runId, at, intent, build, sueVersion, ...score }].slice(-50);
  // The all-time average runs on its own totals, so the 50-run history never drops an old run and
  // only the Sues who gave a rating weigh in.
  const ratedStars = entries.map((e) => e.stars).filter((s) => typeof s === "number");
  row.starsSummed = (row.starsSummed ?? 0) + ratedStars.reduce((a, b) => a + b, 0);
  row.starsCounted = (row.starsCounted ?? 0) + ratedStars.length;
  row.averageStarsAllTime = row.starsCounted ? Math.round((row.starsSummed / row.starsCounted) * 100) / 100 : null;
  // P17: the same totals again, bucketed by the build this run's page was actually serving, so a
  // hearing can tell whether the build just shipped moved visitors instead of reading an all-time
  // blend of every build ever served. A page with no stamp (localhost, a stranger's site) buckets
  // under "unknown" - never a guess - and a run booked before this landed never gets backfilled here.
  const buildKey = build?.commit ? build.commit : "unknown";
  row.byBuild = row.byBuild ?? {};
  const bucket = row.byBuild[buildKey] ?? { runs: 0, sues: 0, starsSummed: 0, starsCounted: 0 };
  bucket.runs += 1;
  bucket.sues += score.sues;
  bucket.starsSummed += ratedStars.reduce((a, b) => a + b, 0);
  bucket.starsCounted += ratedStars.length;
  row.byBuild[buildKey] = bucket;
  board.pages[key] = row;
  board.updatedAt = at;
  writeJsonAtomic(scoreboardFile(ws), board);
  return row;
}
