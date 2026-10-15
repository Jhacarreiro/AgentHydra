/**
 * findings - a Sue's diary, her trace, and the small pure rules her body applies
 * ==============================================================================
 * What it is: `createFindings(sueDir)` is the ONE writer of `<sue>/findings.jsonl` (what she and
 * her body noticed) and `<sue>/trace.jsonl` (every tool call, one line each). Both are append-only
 * JSONL with an ISO `at` stamp on every row, because the report (`report.mjs`) reads them after the
 * fact and a half-written JSON object would cost it the whole file. Beside the writer live the pure
 * helpers the body needs but that have no business sitting next to a Playwright page: host
 * allow-listing, the payment-field and honeypot refusals, the six-digit-code extraction that never
 * prints the code, the inbox reader, the trace-argument sanitiser and the exit-interview shape.
 *
 * Why it exists: `body.mjs` is the per-Sue MCP server and it is already carrying a browser, a clock
 * and twelve tools; every rule that can be tested without a browser lives here so `tests/findings.spec.mjs`
 * can pin it under plain `node --test` in milliseconds. A rule that only exists inside a tool
 * handler is a rule nobody can test without launching Chromium.
 *
 * Who depends on it: `sue/body.mjs` (the only runtime caller), `sue/report.mjs` (reads
 * the two files this writes; the row shapes below are its contract), `sue/tests/findings.spec.mjs`.
 *
 * Row shapes (the contract):
 *   findings.jsonl  { at, source: "brain" | "body", kind, text, url?, ...extra }
 *                   a typed problem: ...extra holds problem { title, defect: "issue" | "warning", severity 1-5,
 *                   expected, actual, steps[], look, quoted, n, ref }; a sighting of one already filed holds
 *                   same { n, ref } instead (see TYPED PROBLEMS below); every other row is unchanged
 *   trace.jsonl     { at, ...event }   - the body supplies tool, args, clock, url, title, screenshot?
 *                   { at, kind: "hop", tab, url, how, by, ... } - a page her tab passed through (lib/hop-trace.mjs)
 *   <run>/filed.jsonl  { at, ref, sueId, page, title, defect, severity, sueSide? } - the run's ledger of typed
 *                   problems, one row per problem, its number `n` being its 1-based line; `sueSide` (sue-browser-lost
 *                   or sue-door-refused) when SUE itself was at fault as she filed it, so no other Sue is shown it
 *
 * Node builtins only, plus `tokens` from infra/shared/text/likeness.mjs (import-free; the engine store stages it
 * with the rest of the closure). Plain ESM, never bun (SPEC.md: bun hangs Playwright on this box, and this
 * file is imported by the process that launches it).
 *
 * Credit: the typed problem (title, issue or warning, the 1-5 severity rubric, expected, actual, steps) and the
 * rule that a problem already filed is not filed again are tester-army/e2e's (Apache-2.0, at b7ba009:
 * packages/e2e/src/explore/executor.ts, FINDING_SCHEMA lines 76-98, the EXPLORE_RULES rule at line 22 and the
 * tool's answer at line 131; explore/body.ts:176-189 hands its agent the titles only). Written fresh here; no
 * file was copied.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import { tokens } from "../../lib/shared/likeness.mjs";
import { AUDIENCES, DECOY_EMAILS } from "./inbox-test.mjs";
import { isInboxUrl, messageUrl } from "./inbox-page.mjs";

const SOURCES = new Set(["brain", "body"]);

/**
 * The diary. `note` and `trace` are synchronous appends on purpose: a tool handler that crashed
 * between "decided" and "wrote" would leave the report blind to the decision, and `appendFileSync`
 * on a local file is microseconds.
 */
export function createFindings(sueDir) {
  if (!sueDir || typeof sueDir !== "string") throw new Error("createFindings: sueDir is required");
  mkdirSync(sueDir, { recursive: true });
  const findingsPath = path.join(sueDir, "findings.jsonl");
  const tracePath = path.join(sueDir, "trace.jsonl");
  const rows = [];
  // Lines already in her diary, so a body restarted on the same folder keeps counting where it was: the ref of
  // a typed problem is `<sue folder>:<line>`, the very line lib/repro.mjs findingAt reads back.
  let written = 0;
  try {
    written = (readFileSync(findingsPath, "utf8").match(/\n/g) ?? []).length;
  } catch {
    /* a new diary */
  }

  function note({ source, kind, text, url, extra } = {}) {
    if (!SOURCES.has(source)) throw new Error(`findings.note: source must be brain|body, got ${String(source)}`);
    if (!kind || typeof kind !== "string") throw new Error("findings.note: kind is required");
    const row = { at: new Date().toISOString(), source, kind, text: String(text ?? "") };
    if (url) row.url = String(url);
    if (extra && typeof extra === "object") Object.assign(row, extra);
    rows.push(row);
    appendFileSync(findingsPath, `${JSON.stringify(row)}\n`, "utf8");
    written += 1;
    return row;
  }

  /** The 1-based line the next `note` lands on. */
  function nextLine() {
    return written + 1;
  }

  function trace(event = {}) {
    const row = { at: new Date().toISOString(), ...event };
    appendFileSync(tracePath, `${JSON.stringify(row)}\n`, "utf8");
    return row;
  }

  function all() {
    return rows.slice();
  }

  return { note, trace, all, nextLine, paths: { findings: findingsPath, trace: tracePath } };
}

/**
 * Is `hostname` inside the target's allow-list? An entry is either an exact host or a leading-`*`
 * wildcard: `*.example.com` covers every SUBDOMAIN and nothing else - the bare apex is its own
 * entry, which is why the target file lists both. Case-insensitive; a trailing dot is ignored.
 */
export function hostAllowed(hostname, allowedHosts = []) {
  const host = String(hostname ?? "")
    .toLowerCase()
    .replace(/\.$/, "");
  if (!host) return false;
  for (const raw of allowedHosts) {
    const entry = String(raw ?? "")
      .toLowerCase()
      .trim();
    if (!entry) continue;
    if (entry.startsWith("*.")) {
      const suffix = entry.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (entry.startsWith("*")) {
      if (host.endsWith(entry.slice(1))) return true;
    } else if (host === entry) return true;
  }
  return false;
}

/** Which browser the wave's shared server and a solo body use for `target`, decided in ONE place. */
export function browserModeFor(target) {
  if (target?.browser === "headless" || target?.browser === "headed-offscreen") return target.browser;
  let host;
  try {
    host = new URL(target?.startUrl ?? "").hostname.replace(/^\[(.*)\]$/, "$1"); // an IPv6 hostname keeps its brackets
  } catch {
    host = "";
  }
  // HEADED, PARKED OFF-SCREEN, for every target that is not loopback: Cloudflare in front of every
  // *.example.com host answers headless Chrome with "Sorry, you have been blocked" (403) on the
  // plane load - stock UA and AutomationControlled disabled included - while a headed Chrome parked
  // at -32000,-32000 passes every time (measured 2026-09-12,
  // .claude/memory/a-signed-in-production-render-needs-headed-off-screen-chrome-because-cloudflare-blocks-headless.md).
  // Loopback fixtures run headless (cheaper, no window at all); a target may pin it either way.
  return host === "127.0.0.1" || host === "localhost" || host === "::1" ? "headless" : "headed-offscreen";
}

/**
 * The Chrome flags for a Sue browser in `mode`, for the wave's shared server and a solo body alike.
 * HEADLESS GETS THE REAL GPU. `--disable-gpu` drew every WebGL frame on SwiftShader, i.e. the CPU:
 * measured 2026-09-23 on the Nexas game, three phone pages cost 10.8 cores at 8 fps that way and 3.1
 * cores at 61 fps on the RTX 3090 with these flags ("you are killing my cpu"). A machine with no
 * usable GPU falls back to SwiftShader on its own; SUE_RENDERING=cpu (the desktop app's toggle)
 * forces it.
 */
export function browserArgsFor(mode, env = process.env) {
  const gpu =
    env.SUE_RENDERING === "cpu"
      ? ["--disable-gpu"]
      : ["--enable-gpu", "--ignore-gpu-blocklist", ...(process.platform === "win32" ? ["--use-angle=d3d11"] : [])];
  // --mute-audio: the page's Web Audio (taps, chimes, a voice) still runs, it just never reaches the PC's speakers.
  return ["--no-sandbox", "--disable-dev-shm-usage", "--mute-audio", ...(mode === "headless" ? gpu : ["--window-position=-32000,-32000"])];
}

/**
 * A `blob:` URL has no host of its own (`blob:https://site/<uuid>` parses with an empty hostname):
 * it belongs to the page that made it, and that origin is written inside it. The inner URL for a
 * blob, the URL itself for anything else, or null when a blob carries no real origin (`blob:null/...`).
 */
function unwrapBlob(parsed) {
  if (parsed.protocol !== "blob:") return parsed;
  try {
    return new URL(parsed.origin);
  } catch {
    return null;
  }
}

/**
 * Is `url` under a fenced entry (`discord.com/channels/123`): that host, and that path or anything
 * below it? A product that lives inside someone else's site, a bot inside one Discord server, is
 * fenced to its own corner of it: the rest of Discord is another website to a Sue.
 */
function underFence(url, entry) {
  const slash = entry.indexOf("/");
  const prefix = entry.slice(slash).replace(/\/+$/, "");
  const where = url.pathname.toLowerCase();
  return hostAllowed(url.hostname, [entry.slice(0, slash)]) && (where === prefix || where.startsWith(`${prefix}/`));
}

/**
 * `hostAllowed` for a whole URL; an unparsable URL is never allowed. An entry with a path is a fence
 * (`underFence`). A `blob:` URL is judged by the origin written inside it: a transcript a page opens
 * as a blob in a new tab is the site's own page, and closing it as off-site was SUE's hands failing,
 * not the product (run 20260922-063426-626a).
 */
export function urlAllowed(url, allowedHosts = []) {
  try {
    const parsed = new URL(String(url));
    if (parsed.protocol === "about:" || parsed.protocol === "data:") return true;
    const owner = unwrapBlob(parsed);
    if (!owner) return false;
    const entries = allowedHosts.map((raw) =>
      String(raw ?? "")
        .toLowerCase()
        .trim(),
    );
    const fences = entries.filter((entry) => entry.indexOf("/") > 0);
    return (
      hostAllowed(
        owner.hostname,
        entries.filter((entry) => !entry.includes("/")),
      ) || fences.some((entry) => underFence(owner, entry))
    );
  } catch {
    return false;
  }
}

/**
 * Chrome's own console echo of a failed response ("Failed to load resource: the server responded
 * with a status of 500") for a request on a host the body watches. The response listener already
 * files that failure as an http-error carrying the method, URL and status, so the echo filed it a
 * second time with less in it: run 20260923-070849-2c72 held 20 echoes against exactly 20
 * http-errors. An echo for a host the body does not watch is kept - it is the only record of it -
 * and so is a request that never got a response (net::ERR_*), which no http-error covers.
 */
export function echoesHttpError(text, resourceUrl, allowedHosts = []) {
  return (
    /^Failed to load resource: the server responded with a status of \d+/.test(String(text ?? "")) &&
    urlAllowed(resourceUrl ?? "", allowedHosts)
  );
}

/**
 * The accounts refresh a signed-out visitor makes answers 401 by design (no session yet). It is an
 * http-error only once she has signed in, when a 401 means the session really failed.
 */
export function isSignedOutRefresh({ status, method, url, signedIn } = {}) {
  if (signedIn || status !== 401 || String(method ?? "").toUpperCase() !== "POST") return false;
  try {
    const { hostname, pathname } = new URL(url ?? "");
    return /^accounts\./.test(hostname) && pathname === "/auth/refresh";
  } catch {
    return false;
  }
}

const PAYMENT_TEXT = /card|cvv|cvc|expir/i;

/**
 * A payment field, by the inventory element's own attributes: `autocomplete="cc-*"` or a label /
 * placeholder / name that reads like a card. The body never types into one, whatever the brain
 * asked for (SPEC.md § Rails).
 */
export function isPaymentField(el = {}) {
  const autocomplete = String(el.autocomplete ?? "").toLowerCase();
  if (autocomplete.startsWith("cc-")) return true;
  for (const candidate of [el.labelText, el.placeholder, el.name]) {
    if (candidate && PAYMENT_TEXT.test(String(candidate))) return true;
  }
  return false;
}

/** A honeypot or otherwise invisible input: the body refuses it, a real hand could not reach it. */
export function isHiddenField(el = {}) {
  return Boolean(el.hidden) || String(el.inputType ?? "").toLowerCase() === "hidden";
}

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/**
 * The part of an ISO birthdate a form box asks for. A `<input type="date">` or a box with nothing
 * in its label/name/autocomplete/placeholder about day, month or year takes the whole date; a
 * `bday-day` / "Day" / "DD" box takes the day, a month SELECT the month's name (its options are
 * words), a month text box the number, a year box the four digits. AEGIS's signup form asks in
 * three parts; two live Sues typed the whole ISO date into "day" on 2026-09-21 and called the
 * form broken.
 */
export function birthdayPartFor(el = {}, isoDate) {
  const part = birthdayPartName(el, isoDate);
  if (!part) return isoDate;
  const [year, month, day] = String(isoDate).split("-");
  if (part === "day") return String(Number(day));
  if (part === "month") return el.role === "select" ? MONTH_NAMES[Number(month) - 1] : String(Number(month));
  return year;
}

/** Her ISO birthdate the way a person in the US types it into one box: "1985-03-14" -> "03/14/1985". */
export function birthdayAsTyped(isoDate) {
  const [year, month, day] = String(isoDate).split("-");
  return `${month}/${day}/${year}`;
}

/**
 * Which part of her birthday a box takes ("day", "month", "year"), or null when it takes the whole
 * date. Her typing is told back as that part: told "You typed your birthday into Month" after only
 * the month went in, three Sues of one round (2026-10-06) filed the form as dropping the day and year.
 */
export function birthdayPartName(el = {}, isoDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate ?? ""))) return null;
  if (String(el.inputType ?? "").toLowerCase() === "date") return null;
  const hint = [el.autocomplete, el.name, el.labelText, el.placeholder].map((v) => String(v ?? "").toLowerCase()).join(" | ");
  if (/bday-day|\bday\b|\bdd\b/.test(hint)) return "day";
  if (/bday-month|\bmonth\b|\bmm\b/.test(hint)) return "month";
  if (/bday-year|\byear\b|\byyyy\b/.test(hint)) return "year";
  return null;
}

const CAPTCHA_TEXT = /captcha|turnstile|not a robot|i'm human|i am human|verify you are human/i;

/** A CAPTCHA widget by its accessible name; the iframe kind is the inventory's `captcha` block. */
export function isCaptchaElement(el = {}) {
  return CAPTCHA_TEXT.test(String(el.name ?? "")) || CAPTCHA_TEXT.test(String(el.labelText ?? ""));
}

/**
 * The distinct six-digit codes a plain-text message shows. Same pattern as the accounts OTP probe's
 * plain-text branch (`candidateCodes` in `lib/mime-text.mjs`): a run of exactly six digits not
 * preceded by a digit or `#` (so `#123456` order numbers and longer numbers do not count).
 */
export function sixDigitCandidates(text) {
  const found = new Set();
  for (const match of String(text ?? "").matchAll(/(?<![\d#])(\d{6})(?!\d)/g)) found.add(match[1]);
  return [...found];
}

/** Exactly one candidate, or null. Never logged by the caller; never returned in a trace. */
export function singleCode(text) {
  const codes = sixDigitCandidates(text);
  return codes.length === 1 ? codes[0] : null;
}

/**
 * The six-digit codes in what she typed that her errand did not hand her: a guess at an email code,
 * which the body refuses. A code her errand names ("your clinic texted you the code 246810") is hers
 * to type: all five RadiologistBuddy patients of run 20261007-175416-3f6a were refused theirs.
 */
export function codesNotGiven(text, errand) {
  const given = new Set(sixDigitCandidates(errand));
  return sixDigitCandidates(text).filter((code) => !given.has(code));
}

/**
 * The address's mail directory: `mailDir` may already be `<run>/mail/<address>` or the parent
 * `<run>/mail`; both shapes are accepted so the cannon's choice does not break the body.
 */
export function addressMailDir(mailDir, address) {
  if (!mailDir) return null;
  const wanted = String(address ?? "").toLowerCase();
  if (path.basename(mailDir).toLowerCase() === wanted) return mailDir;
  return path.join(mailDir, wanted);
}

/**
 * Every message in the address's mail directory, newest first, as the mailroom wrote them:
 * `{ from, subject, text, receivedAt, deliveredAt, messageId }`. An unreadable file is skipped, not
 * fatal - the mailroom may be mid-write.
 */
export function readInbox(dir) {
  if (!dir || !existsSync(dir)) return [];
  const messages = [];
  for (const entry of readdirSync(dir)) {
    if (!entry.endsWith(".json")) continue;
    const file = path.join(dir, entry);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (!parsed || typeof parsed !== "object") continue;
      const stamp = Date.parse(parsed.deliveredAt ?? parsed.receivedAt ?? "") || statSync(file).mtimeMs;
      messages.push({ ...parsed, _stamp: stamp, _file: file });
    } catch {
      /* mid-write or not ours; skip */
    }
  }
  messages.sort((a, b) => b._stamp - a._stamp);
  return messages;
}

/**
 * The message that sent her (`start: "inbox"`): a campaign email, a friend's post. A Sue normally
 * arrives at a URL with a one-sentence reason, so whether the message and the page it links to
 * tell the same story was never tested (MiroFish review P26, 2026-09-23). The CALLER writes it -
 * SUE has no AI of its own - and it is seeded into her inbox before her first screen, which is it.
 */
export const ARRIVAL_ID = "seeded-arrival";

/** `{from, subject, html|text}` trimmed, or a throw naming what is missing. */
export function arrivalFrom(raw) {
  const a = raw && typeof raw === "object" ? raw : {};
  const from = String(a.from ?? "").trim();
  const subject = String(a.subject ?? "").trim();
  const html = typeof a.html === "string" && a.html.trim() ? a.html : null;
  const text = typeof a.text === "string" && a.text.trim() ? a.text : null;
  if (!from || !subject || !(html || text))
    throw new Error(
      "arrival needs {from, subject} and the message itself as html or text: the email or post that sent her, written by you",
    );
  const headers = Object.fromEntries(
    Object.entries(a.headers && typeof a.headers === "object" ? a.headers : {}).filter(([, v]) => typeof v === "string"),
  );
  if (a.audience != null && !AUDIENCES.includes(a.audience))
    throw new Error(`arrival audience must be "cold" (a stranger's email) or "known" (a company she signed up with), not ${a.audience}`);
  return {
    from,
    subject,
    ...(html ? { html } : {}),
    ...(text ? { text } : {}),
    ...(Object.keys(headers).length ? { headers } : {}),
    ...(a.audience != null ? { audience: a.audience } : {}),
  };
}

/**
 * Write the arrival into her mail directory, tagged `seeded: true`, once: a body that restarts
 * keeps the first copy and its time. Returns the file.
 */
export function seedArrival(dir, arrival, now = new Date()) {
  const message = { ...arrivalFrom(arrival), messageId: ARRIVAL_ID, receivedAt: now.toISOString(), seeded: true };
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ARRIVAL_ID}.json`);
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(message, null, 2), "utf8");
  return file;
}

/**
 * The decoy emails a Sue triages beside the one under test: seeded and marked `decoy`, dated hours before
 * `now` so the arrival is always the newest. Written once per name, like the arrival.
 */
export function seedDecoys(dir, now = new Date()) {
  mkdirSync(dir, { recursive: true });
  return DECOY_EMAILS.map((decoy, i) => {
    const messageId = `decoy-${i + 1}`;
    const file = path.join(dir, `${messageId}.json`);
    const receivedAt = new Date(now.getTime() - (i + 1) * 3 * 3600e3).toISOString();
    if (!existsSync(file))
      writeFileSync(file, JSON.stringify({ ...arrivalFrom(decoy), messageId, receivedAt, seeded: true, decoy: true }, null, 2), "utf8");
    return file;
  });
}

/**
 * The mail the PRODUCT sent her: everything but a seeded arrival. Whatever measures the product's
 * own mail reads this - the sign-in code and its latency, the sign-up door check - so a six-digit
 * number in the caller's message is never taken for a code that reached her.
 */
export function productMail(messages = []) {
  return (messages ?? []).filter((m) => !m?.seeded);
}

/** The body she is shown for one message in her inbox list. A six-digit number in the PRODUCT's own mail is named
 *  as the code to type; in a seeded arrival it is left as written, because the caller's campaign email or a
 *  friend's post may carry an order number or a promo code, and telling her to type that as a sign-in code
 *  would make the product's own sign-in look broken. */
export function inboxBody(message) {
  const body = String(message?.text ?? "");
  return message?.seeded ? body : body.replace(/(?<![\d#])\d{6}(?!\d)/g, "[a six-digit code - type it with field: the-code-from-my-email]");
}

/** Where her visit opens: the arrival for a Sue a message sent, else the scenario's path or the target's link. */
export function startUrlFor(target = {}, scenario = {}, ids = {}) {
  if (target?.arrival) return messageUrl(ARRIVAL_ID);
  const base = fillSueIds(target.startUrl, ids);
  return scenario?.startPath ? new URL(fillSueIds(scenario.startPath, ids), base).href : base;
}

/** `{sueId}` and `{runId}` become this Sue's ids, before the URL is parsed (the parser would escape the braces). */
export function fillSueIds(text, { sueId, runId } = {}) {
  if (typeof text !== "string") return text;
  let out = text;
  if (sueId != null) out = out.replaceAll("{sueId}", encodeURIComponent(String(sueId)));
  if (runId != null) out = out.replaceAll("{runId}", encodeURIComponent(String(runId)));
  return out;
}

/** "just now", "40 seconds ago", "3 minutes ago" - how she would read the inbox column. */
export function receivedAgo(stamp, now = Date.now()) {
  const ms = Math.max(0, now - Number(stamp || now));
  const seconds = Math.round(ms / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds} seconds ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"} ago`;
}

/**
 * Trace arguments with nothing secret in them. A `type` call with `field: "the-code-from-my-email"`
 * is recorded as that field name and never the digits; free `text` longer than 200 chars is cut.
 */
export function sanitizeArgs(tool, args = {}) {
  if (!args || typeof args !== "object") return {};
  const out = {};
  for (const [key, value] of Object.entries(args)) {
    if (tool === "type" && key === "text") {
      const text = String(value ?? "");
      out.text = sixDigitCandidates(text).length ? "[six-digit code redacted]" : text.slice(0, 200);
    } else if (typeof value === "string") out[key] = value.slice(0, 500);
    else out[key] = value;
  }
  return out;
}

/**
 * P25 (built from a review of MiroFish): the first-look probe. One line, asked once, the moment her
 * first look lands - what she thinks this place is and what it sells - then she is sent straight
 * back to her errand. It is NOT an exit-interview answer (kept out of `INTERVIEW_KEYS` on purpose:
 * this is not asked at the end, and a scenario must never be able to collide a question with it),
 * and it is never a model call of SUE's own (owner ruling: SUE provides no AI) - the line is text on
 * her own `look` result, the same channel `journalNudge` already uses.
 */
export const FIRST_LOOK_PROBE_ID = "first-look";
export const FIRST_LOOK_PROBE_TEXT = "Before you get back to it: in one line, what do you think this place is, and what do they sell?";

/**
 * Which probe fires on THIS look, or `null`. `scenario.probes` is `[{ id, whenUrl, ask }]`: each
 * fires once, the first time her url first contains `whenUrl` (case-insensitive) - a pricing page
 * asking "what do you think this costs you?", say. The built-in first-look probe fires once, on her
 * very first look (`looks === 1`), everywhere EXCEPT a canvas target: a game has no "what do they
 * sell", so it stays off there unless the scenario names its own probes (opting back in on
 * purpose - `named.length`, whether or not one has matched yet). `fired` is the set of probe ids
 * already asked this visit, so a probe never asks twice. A Sue a message sent (`arrived`) opens on
 * that email, which is not the site: her first-look question waits for her first look off the inbox.
 */
export function probeForLook({ url, looks, canvas, scenario, fired, arrived = false } = {}) {
  const asked = fired instanceof Set ? fired : new Set(fired ?? []);
  const named = Array.isArray(scenario?.probes) ? scenario.probes : [];
  const here = String(url ?? "").toLowerCase();
  for (const probe of named) {
    if (!probe || typeof probe.id !== "string" || !probe.id || asked.has(probe.id)) continue;
    if (typeof probe.whenUrl !== "string" || !probe.whenUrl) continue;
    if (here.includes(probe.whenUrl.toLowerCase())) return { id: probe.id, text: String(probe.ask ?? "").trim() };
  }
  const firstLook = arrived ? !isInboxUrl(url) : looks === 1;
  if (firstLook && !asked.has(FIRST_LOOK_PROBE_ID) && (!canvas || named.length))
    return { id: FIRST_LOOK_PROBE_ID, text: FIRST_LOOK_PROBE_TEXT };
  return null;
}

/**
 * The extra tag her NEXT `note` carries once a probe has fired: `{ probe, url }`, `url` being where
 * the probe was asked (she may have moved on by the time she actually writes the line). `null` once
 * there is nothing pending, so a caller never has to guess whether to spread it in.
 */
export function probeNoteExtra(pending) {
  return pending ? { probe: pending.id, url: pending.url ?? null } : null;
}

/**
 * The two diary kinds that mark attention itself (Owner, 2026-09-27: "if you're watching a video and
 * you look away for a second and look back, that part of the video needs edited because it lost the
 * user's attention"): `drop`, the moment she would look away or leave, and `hook`, the moment
 * something held her. Any Sue may write them; a critic persona writes one per screen.
 */
export const ATTENTION_KINDS = Object.freeze(["drop", "hook"]);

/**
 * What a drop or hook line carries beside its words: `why` (the mechanism), `fix`, `severity` (a whole
 * number 1 to 3, else left out rather than guessed) and `visitSeconds`, the seconds into the visit her
 * clock has spent, so the report can print the timeline in order. `null` for every other kind, which
 * keeps the rows every other Sue writes exactly as they were.
 */
export function attentionNoteExtra({ kind, why, fix, severity, seconds } = {}) {
  if (!ATTENTION_KINDS.includes(kind)) return null;
  const out = {};
  const words = (value) => (typeof value === "string" ? value.trim() : "");
  if (words(why)) out.why = words(why);
  if (words(fix)) out.fix = words(fix);
  const level = Number(severity);
  if (Number.isInteger(level) && level >= 1 && level <= 3) out.severity = level;
  if (Number.isFinite(seconds) && seconds >= 0) out.visitSeconds = Math.round(seconds);
  return out;
}

/**
 * ART (Aesthetic Review Team, sue/README.md#art): the two kinds a designer writes beside drop and hook. `polish` is
 * a design flaw with its fix and a severity (1 polish, 2 friction, 3 broken); `keep` is a design choice that works and
 * must survive the polish. Both carry why (the principle id, or judgement); a polish line also carries fix.
 */
export const ART_KINDS = Object.freeze(["polish", "keep"]);

/** The line the note tool's description adds for a designer only (every other Sue's description stays as it was). */
export const ART_NOTE_ADDENDUM =
  " As a design reviewer you also write kind polish (a design flaw: text is what is on the screen now, why is the principle with its id or judgement, fix is the exact change, severity 1 polish, 2 friction, 3 broken) or kind keep (a design choice that works and must survive the polish: text, and why it works).";

/**
 * What a polish or keep line carries beside its words: `why`, `fix` (polish), a `severity` (polish only: a whole number 1 to 3,
 * refused outside that, and refused on a keep line) and `visitSeconds`. `null` for every other kind; `{ refused }` when the
 * line cannot be written, so a refused line leaves no row (the same contract as problemNote).
 */
export function artNoteExtra({ kind, why, fix, severity, seconds } = {}) {
  if (!ART_KINDS.includes(kind)) return null;
  const words = (value) => (typeof value === "string" ? value.trim() : "");
  const out = {};
  if (!words(why)) return { refused: `Not written: a ${kind} line says why (the principle with its id, or judgement).` };
  out.why = words(why);
  if (kind === "polish") {
    if (!words(fix)) return { refused: "Not written: a polish line says fix, the exact change to make." };
    out.fix = words(fix);
    // A number or a numeric string only: Number(true) is 1, and a boolean severity is not a level.
    const level = typeof severity === "number" || typeof severity === "string" ? Number(severity) : NaN;
    if (!Number.isInteger(level) || level < 1 || level > 3)
      return { refused: "Not written: a polish line needs severity, a whole number from 1 (polish) to 3 (broken)." };
    out.severity = level;
  } else if (severity != null) return { refused: "Not written: severity is for polish lines only; a keep line carries why." };
  if (Number.isFinite(seconds) && seconds >= 0) out.visitSeconds = Math.round(seconds);
  return out;
}

/*
 * TYPED PROBLEMS (2026-10-07). `problem` sits beside her own `text`, so every reader of `kind` and `text`
 * reads the row as before. The body stamps `look`, `quoted`, `n` and `ref` itself; she never types them.
 * The ledger is per RUN (`<run>/filed.jsonl`): a Sue who runs into a problem another Sue filed still writes
 * her own line, with `same: <n>` and no problem, so the report counts who hit it and keeps her voice while
 * the facts are written once. `problem.severity` is the 1-5 rubric; a drop's or hook's top-level `severity`
 * stays the 1-3 attention scale, on its own key so no reader mistakes one scale for the other.
 */

/** The diary kinds a problem rides on; sue-ab.mjs counts exactly these as "problems". */
export const PROBLEM_NOTE_KINDS = Object.freeze(["confusion", "annoyance", "broken"]);
/** issue: it stops or misleads a person; warning: it looks wrong and blocks nothing (a 1 or a 2). */
export const DEFECTS = Object.freeze(["issue", "warning"]);
export const MAX_STEPS = 20;
/** Cut, never refused: a long field is still usable. */
export const PROBLEM_CUTS = Object.freeze({ title: 120, words: 600, step: 200 });
const MIN_TITLE = 4;
const PROBLEM_NEEDS = "title, severity (a whole number from 1 to 5), expected, actual and steps (1 to 20 moves)";

const trimmed = (value) => (typeof value === "string" ? value.trim() : "");
const cutTo = (value, max) => (value.length > max ? value.slice(0, max).trimEnd() : value);
const shown = (value) => (typeof value === "string" ? JSON.stringify(value) : String(value));

/** "a", "a and b", "a, b and c". */
function andList(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** Steps as sent: a list, that list as JSON text (the shell hand), or one piece of text, one step per line. */
function asSteps(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return null;
  if (value.trim().startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      /* not a JSON list: read it as lines */
    }
  }
  return value.split(/\r?\n/).filter((line) => line.trim());
}

/**
 * `problem` as sent (an object, or that object as JSON text from the shell hand's words) ->
 * `{ problem: { title, defect, severity, expected, actual, steps } }`, or `{ refused }`: one sentence naming
 * every fault, so one resend can fix them all. defect defaults from severity (issue at 3 and up, warning at 1
 * or 2); a warning of 3 or more is refused, because the rubric's 2 is cosmetic and its 1 trivial.
 */
export function shapeProblem(raw) {
  const given = asObject(raw);
  const p = given && typeof given === "object" && !Array.isArray(given) ? given : {};
  const missing = [];
  const faults = [];

  const title = trimmed(p.title);
  if (!title) missing.push("title");
  else if (title.length < MIN_TITLE) faults.push(`title ${shown(title)} is under ${MIN_TITLE} characters`);

  let severity = null;
  const rawSeverity = typeof p.severity === "string" ? p.severity.trim() : p.severity;
  if (rawSeverity === undefined || rawSeverity === null || rawSeverity === "") missing.push("severity");
  else {
    const level = typeof rawSeverity === "number" || typeof rawSeverity === "string" ? Number(rawSeverity) : NaN;
    if (Number.isInteger(level) && level >= 1 && level <= 5) severity = level;
    else faults.push(`severity ${shown(p.severity)} is not a whole number from 1 to 5`);
  }

  const expected = trimmed(p.expected);
  if (!expected) missing.push("expected");
  const actual = trimmed(p.actual);
  if (!actual) missing.push("actual");

  const list = asSteps(p.steps);
  const steps = [];
  if (!list || !list.length) missing.push("steps");
  else if (list.length > MAX_STEPS) faults.push(`steps holds ${list.length} moves, more than ${MAX_STEPS}`);
  else
    list.forEach((step, i) => {
      const words = typeof step === "number" ? String(step) : trimmed(step);
      if (!words) faults.push(`step ${i + 1} is empty`);
      else steps.push(cutTo(words, PROBLEM_CUTS.step));
    });

  const said = trimmed(p.defect).toLowerCase();
  let defect = null;
  let warningTooHigh = false;
  if (said && !DEFECTS.includes(said)) faults.push(`defect is issue or warning, not ${shown(p.defect)}`);
  else if (said) defect = said;
  if (severity !== null) {
    if (!defect && !said) defect = severity >= 3 ? "issue" : "warning";
    if (defect === "warning" && severity >= 3) warningTooHigh = true;
  }

  if (!missing.length && !faults.length && warningTooHigh)
    return { refused: "Not written: a warning is a 1 or a 2; a 3, 4 or 5 is an issue." };
  if (warningTooHigh) faults.push(`a warning is a 1 or a 2, and this one is a ${severity}`);
  if (missing.length || faults.length) {
    const all = [...(missing.length ? [`it is missing ${andList(missing)}`] : []), ...faults];
    return { refused: `Not written: problem needs ${PROBLEM_NEEDS}; ${all.join("; ")}. Write the line again with them.` };
  }
  return {
    problem: {
      title: cutTo(title, PROBLEM_CUTS.title),
      defect,
      severity,
      expected: cutTo(expected, PROBLEM_CUTS.words),
      actual: cutTo(actual, PROBLEM_CUTS.words),
      steps,
    },
  };
}

/**
 * Does `actual` quote words that are on her screen? true when every quoted piece ("...", or curly quotes) is
 * in her last look's text, case and spaces ignored; false when one is not, or nothing is quoted; null when her
 * last look had no words to check against (a canvas, or no look yet). Recorded, never refused: it decides
 * nothing, it only tells a reader how close to the screen the claim was written.
 */
export function quotesScreen(actual, screenText) {
  const flat = (s) =>
    String(s ?? "")
      .toLowerCase()
      .replace(/[‘’]/g, "'")
      .replace(/\s+/g, "");
  const screen = flat(screenText);
  if (!screen) return null;
  // A straight-quoted piece, or a curly-quoted one.
  const pieces = [...String(actual ?? "").matchAll(/"([^"]+)"|“([^”]+)”/g)].map((m) => flat(m[1] ?? m[2])).filter(Boolean);
  if (!pieces.length) return false;
  return pieces.every((piece) => screen.includes(piece));
}

/**
 * The page a problem is filed under: host and path, a "#/..." route kept (an SPA's page lives there), the
 * query and a trailing slash dropped. null for anything that is not an http(s) address.
 */
export function filedPage(url) {
  let u;
  try {
    u = new URL(String(url ?? ""));
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const route = u.hash.startsWith("#/") ? u.hash.split("?")[0].replace(/\/+$/, "") : "";
  return `${u.host}${u.pathname.replace(/\/+$/, "")}${route.length > 1 ? route : ""}`;
}

/** The run's ledger of typed problems, beside its Sue folders. */
export const FILED_FILE = "filed.jsonl";

/**
 * The run's ledger in filing order: `[{ n, at, ref, sueId, page, title, defect, severity }]`, `n` being the
 * row's 1-based line. A line that does not parse (a writer that died mid-line) keeps its number and reads as
 * nothing, so no later problem's number ever moves.
 */
export function readFiled(runDir) {
  let text;
  try {
    text = readFileSync(path.join(runDir, FILED_FILE), "utf8");
  } catch {
    return [];
  }
  const out = [];
  text.split("\n").forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const row = JSON.parse(line);
      if (row && typeof row.ref === "string") out.push({ n: i + 1, ...row });
    } catch {
      /* a torn line keeps its number and reads as nothing */
    }
  });
  return out;
}

/**
 * Appends one ledger row and answers its number, read back by its ref (several bodies append to one ledger,
 * so the number is where the row landed, not a count kept in memory). A torn last line from a writer that
 * died is closed first, so this row starts a line of its own.
 */
export function appendFiled(runDir, { ref, sueId, page = null, title, defect, severity, sueSide = null }, now = new Date()) {
  mkdirSync(runDir, { recursive: true });
  const file = path.join(runDir, FILED_FILE);
  let lead = "";
  try {
    const text = readFileSync(file, "utf8");
    if (text && !text.endsWith("\n")) lead = "\n";
  } catch {
    /* the run's first problem */
  }
  const row = { at: now.toISOString(), ref, sueId, page, title, defect, severity, ...(sueSide ? { sueSide } : {}) };
  appendFileSync(file, `${lead}${JSON.stringify(row)}\n`, "utf8");
  return readFiled(runDir).find((r) => r.ref === ref)?.n ?? null;
}

/**
 * The one decision for a note line, shared by both bodies. `page` is filedPage of where she is, `look` the
 * name of her latest picture, `screenText` that look's words. Answers:
 *   {}                                  an ordinary line (no problem, no same), written exactly as before
 *   { typed: { ...shaped, look, quoted } }  a problem to file
 *   { same: { n, ref } }                a sighting of problem n (any kind may say same)
 *   { refused }                         SUE talking: nothing is written and it costs her no time
 */
export function problemNote({ kind, problem, same, ledger = [], page = null, look = null, screenText = null } = {}) {
  const given = (value) => value != null && value !== "";
  if (given(same)) {
    const n = Number(same);
    const row = Number.isInteger(n) ? ledger.find((r) => r.n === n) : null;
    if (!row) {
      const here = ledger.filter((r) => r.page === page && !r.sueSide).map((r) => String(r.n));
      return {
        refused: `Not written: no problem ${String(same)} is written down yet; on this page there are ${here.length ? andList(here) : "none"}.`,
      };
    }
    if (given(problem))
      return { refused: `Not written: that is problem ${row.n} already; keep your words, say same: ${row.n} and leave problem out.` };
    return { same: { n: row.n, ref: row.ref } };
  }
  if (!given(problem)) return {};
  if (!PROBLEM_NOTE_KINDS.includes(kind)) return { refused: "Not written: problem rides on a confusion, annoyance or broken line." };
  const shaped = shapeProblem(problem);
  if (shaped.refused) return shaped;
  return { typed: { ...shaped.problem, look: look ?? null, quoted: quotesScreen(shaped.problem.actual, screenText) } };
}

/** A title as two sendings of one problem compare it: case and runs of spaces ignored. */
const titleKey = (title) =>
  String(title ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/**
 * Writes the line problemNote decided: a typed problem is appended to the run's ledger first (its ref is the
 * diary line it is about to land on), then the diary row carries it, so the two can be joined both ways. An
 * ordinary line is written byte for byte as it always was. Answers the row and what her hands are told.
 *
 * A problem she already filed on this page under the same title keeps its first number and ref and adds no
 * ledger row: a `do` whose later note was refused is resent whole (lib/body-relay.mjs runDo), and a second
 * number would split the run's sightings of one problem in two. `sueSide` (SUE_BROWSER_LOST, SUE_DOOR_REFUSED)
 * says SUE itself was at fault as she filed it; the ledger keeps it and filedHereLine never lists it.
 */
export function fileNote({ findings, sueDir, decided = {}, kind, text, url, extra = null, sueSide = null, now = new Date() }) {
  let problem = null;
  if (decided.typed) {
    const runDir = path.dirname(sueDir);
    const sueId = path.basename(sueDir);
    const page = filedPage(url);
    const { title, defect, severity } = decided.typed;
    const before = readFiled(runDir).find((r) => r.sueId === sueId && r.page === page && titleKey(r.title) === titleKey(title));
    const ref = before?.ref ?? `${sueId}:${findings.nextLine()}`;
    const n = before?.n ?? appendFiled(runDir, { ref, sueId, page, title, defect, severity, sueSide }, now);
    problem = { ...decided.typed, n, ref };
  }
  const all = { ...(extra ?? {}), ...(problem ? { problem } : {}), ...(decided.same ? { same: decided.same } : {}) };
  const row = findings.note({ source: "brain", kind, text: String(text ?? ""), url, ...(Object.keys(all).length ? { extra: all } : {}) });
  const said = problem
    ? `Noted, and written down as problem ${problem.n}.`
    : decided.same
      ? `Noted beside problem ${decided.same.n}.`
      : "Noted.";
  return { row, said };
}

const FILED_HERE_MAX = 6;
const FILED_TITLE_SHOWN = 80;

/** Does `title` share a run of four words (likeness.mjs tokens: stemmed, stop words out) with any truth text? */
function sharesTruthRun(title, truths) {
  const runs = (list) => list.slice(0, Math.max(0, list.length - 3)).map((_, i) => list.slice(i, i + 4).join(" "));
  const mine = runs(tokens(title));
  if (!mine.length) return false;
  return truths.some((truth) => {
    const theirs = new Set(runs(tokens(truth)));
    return mine.some((run) => theirs.has(run));
  });
}

/**
 * What her look adds when the run has filed problems on this page and one she has not been shown yet came
 * from another Sue: `{ line, upTo }`, `upTo` being the highest number on the page, to pass back as
 * `shownUpTo` next time so the line never repeats on every look. `line` is null when there is nothing new.
 * Titles only (never the facts or anyone's words), oldest first, at most six, each cut to 80 characters; a
 * title sharing a four-word run with the ground truth or the scenario's expect is left out of the list (it is
 * still filed), so a later Sue is never handed the answer the report grades her on. A row filed while SUE itself
 * was at fault (`sueSide`) is never listed: it would tell the others the site is broken where SUE was.
 */
export function filedHereLine({ ledger = [], page = null, sueId = null, shownUpTo = 0, truths = [] } = {}) {
  if (!page) return { line: null, upTo: shownUpTo };
  const here = ledger.filter((r) => r.page === page && !r.sueSide).sort((a, b) => a.n - b.n);
  const upTo = here.reduce((top, r) => Math.max(top, r.n), shownUpTo);
  const listed = here.filter((r) => !sharesTruthRun(r.title, truths));
  if (!listed.some((r) => r.n > shownUpTo && r.sueId !== sueId)) return { line: null, upTo };
  const cut = (t) => (t.length > FILED_TITLE_SHOWN ? `${t.slice(0, FILED_TITLE_SHOWN - 3).trimEnd()}...` : t);
  const titles = listed.slice(0, FILED_HERE_MAX).map((r) => `[${r.n}] ${cut(String(r.title ?? ""))}${r.sueId === sueId ? " (yours)" : ""}`);
  const more = listed.length > FILED_HERE_MAX ? `; and ${listed.length - FILED_HERE_MAX} more` : "";
  return {
    line:
      `Problems other visitors already wrote down on this page: ${titles.join("; ")}${more}. If you run into one of them, ` +
      "say so in your own words with same: its number; do not write its problem again, and spend no moves trying it again to be sure.",
    upTo,
  };
}

/**
 * filedHereLine at her current address, for both bodies: reads the ledger, and remembers in `shown` (page ->
 * the highest number listed there) what her look has listed, so the next look on that page adds nothing until
 * another Sue files something new. Answers the line, or null.
 */
export function filedHereAt({ runDir, sueId, url, shown, truths = [] }) {
  const page = filedPage(url);
  if (!page) return null;
  const { line, upTo } = filedHereLine({ ledger: readFiled(runDir), page, sueId, shownUpTo: shown.get(page) ?? 0, truths });
  shown.set(page, upTo);
  return line;
}

/** The texts a ledger title must not leak: every string in target.groundTruth, and the scenario's expect. */
export function truthTexts(target, scenario) {
  const out = [];
  const walk = (value) => {
    if (typeof value === "string") {
      if (value.trim()) out.push(value);
    } else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === "object") Object.values(value).forEach(walk);
  };
  walk(target?.groundTruth);
  walk(scenario?.expect);
  return out;
}

/**
 * The exit-interview keys - the ONE list, imported by `personas.mjs` for the prompt and by
 * `body.mjs` through `shapeInterview`, so a key cannot be asked for and then dropped (or shaped
 * and never asked). `starsOutOfFive` and `everComingBack` are the owner's verdict pair (the owner,
 * 2026-09-21: "couldn't even log in. What a trashy website. One star, moving on... they're done
 * with the website, never gonna come back") - the two answers `report.mjs` leads on.
 */
export const INTERVIEW_KEYS = Object.freeze([
  "whatIsThisSite",
  "whatDoTheySell",
  "oneSentenceToAFriend",
  "confidence",
  "madeAccount",
  "whyStopped",
  "mostConfusing",
  "emailCodeExperience",
  "endedUpWhereExpected",
  "easyToUnderstand",
  "trust",
  "wouldComeBack",
  "starsOutOfFive",
  "everComingBack",
  "isThisTrash",
  "threeWords",
]);

/**
 * A game (`target.canvas`) or a scenario that says `judges: true` is judged next to the games she
 * already has, not signed up for: these keys are asked instead of the website's sign-up four
 * (`WEBSITE_ONLY`), with the question a scenario words for one of them winning over the one here.
 * The SUE post-mortem (2026-09-26): 21 phone waves scored the Nexas Code phone UI 3.6/5 while an expert
 * panel gave it 3.5/10, because her interview asked what they sell and whether she made an account.
 */
export const JUDGING_KEYS = Object.freeze({
  keepOrDelete: "keep it or delete it right now, next to the games you already have, and why",
  uiStars:
    "1 to 5: how good the screens look and feel next to the best game you have (5 = as polished, 3 = a computer game squeezed onto a phone). Not whether it is fun",
  worstScreen: "the one screen that looked worst, and exactly what was wrong on it",
  squintAt: "every word or number you had to squint at, read twice or could not read, word for word",
  thumbMisses: "every button you missed, hit by accident, or could not tell what it did, and what you hit instead",
  comparedTo: "the game you play most, and what its screens do better (or worse) than this one",
});
const WEBSITE_ONLY = new Set(["whatDoTheySell", "madeAccount", "emailCodeExperience", "trust"]);

/** Whether this visit judges the screens: a canvas target, or a scenario with `judges: true`. */
export const judgesScreens = (target, scenario) => Boolean(target?.canvas || scenario?.judges === true);

/**
 * An ad viewer (`focus_group` with `watches: "ad"`) is asked about the ad she just saw in the feed,
 * never about the website: none of the sign-up or site keys above apply to her.
 */
export const AD_QUESTIONS = Object.freeze({
  stopScrolling: "did anything in the feed make you stop scrolling? yes or no, and what it was",
  feltLike: "did this ad feel like: an ad, a friend's post, or a news story? (kind) and why",
  whoIsItFor: "who did you think this ad was for, in your own words",
  whatTheyOffer: "what did you think they were offering, in one sentence",
  believeIt: "did you believe what it said? yes or no, and why",
  nextMove: "what would you do next: tap it, scroll past, hide it, or ignore it (move) and why",
  squintAt: "every word or number you had to squint at, read twice or could not read, word for word",
  oneChange: "one change that would make you trust or want this ad more",
  starsOutOfFive: "1 to 5: how much you want to see more ads like this (5 = a lot)",
});
export const AD_INTERVIEW_KEYS = Object.freeze(Object.keys(AD_QUESTIONS));

/** Whether this visit is an ad viewer's (a scenario that says `watches: "ad"`). */
export const isAdScenario = (scenario) => scenario?.watches === "ad";

/**
 * APE (Adversarial Product Evaluation): a familiar power user, not a stranger. She uses this product (or the best one
 * like it) every day, and her output is what broke her expectations, not what she thinks of the place.
 */
export const APE_QUESTIONS = Object.freeze({
  brokeExpectations: "every place it did not work the way it should: what you did, what you expected, and what happened instead",
  shortcutsThatFailed:
    "every shortcut you tried (a key, Enter, Tab, back, reload, an address typed straight in, undo, a second click) that did nothing or the wrong thing, word for word",
  slowestPath: "the job that took the most steps or the longest: how many it took, and how many it should have taken",
  lostWork: "did it ever lose something you typed or did? yes or no, and what",
  annoyanceScore: "1 to 10: how annoyed you were by the end (10 = you are done with it)",
  fixFirst: "the one thing they should fix first so you would stop being annoyed",
  wouldUseInstead: "the product you would use instead for this job, and what it does better or worse",
  wouldUseDaily: "would you use this every day for this job? yes or no, and why",
  starsOutOfFive: "1 to 5: the rating you would really leave",
  threeWords: "three words for the whole experience",
});
export const APE_INTERVIEW_KEYS = Object.freeze(Object.keys(APE_QUESTIONS));

/** Whether this visit is an APE power user's (a run that says `ape: true`). */
export const isApeScenario = (scenario) => scenario?.ape === true;

/** The keys she must answer: the APE keys for a power user, the ad keys for an ad viewer, else the standard ones, or for a judged visit the ones a game is judged on. */
export function interviewKeys(judged = false, ad = false, ape = false) {
  if (ape) return APE_INTERVIEW_KEYS;
  if (ad) return AD_INTERVIEW_KEYS;
  if (!judged) return INTERVIEW_KEYS;
  const kept = INTERVIEW_KEYS.filter((key) => !WEBSITE_ONLY.has(key));
  const at = kept.indexOf("starsOutOfFive");
  return [...kept.slice(0, at), ...Object.keys(JUDGING_KEYS), ...kept.slice(at)];
}

/** An interview answered on the judged keys (a report reads it back without knowing the target). */
const judgedAnswers = (answers) => Object.keys(JUDGING_KEYS).some((key) => answers?.[key] != null && answers[key] !== "");

/** 1-5 or 1-10 scores and the yes/no answers, by key - everything else is prose and passes through. */
const INTERVIEW_SCORES = new Set(["confidence", "easyToUnderstand", "trust", "wouldComeBack", "starsOutOfFive", "uiStars"]);
const INTERVIEW_BOOLS = new Set(["madeAccount"]);
const INTERVIEW_NESTED_BOOLS = {
  emailCodeExperience: ["wasClear"],
  endedUpWhereExpected: ["yes"],
  isThisTrash: ["yes"],
  everComingBack: ["yes"],
};
const INTERVIEW_NESTED_NUMBERS = { emailCodeExperience: ["waitedSeconds"] };

/**
 * A brain's yes/no, whatever shape it sent it in. Both tiers hand booleans over the MCP wire as
 * STRINGS often enough that it cannot be treated as an anomaly: Sonnet answered `madeAccount:
 * "false"` on 2026-09-21 and the cannon's `Boolean(interview.madeAccount)` read the non-empty
 * string as TRUE - reporting a signup that never happened and burning a row off the 200-accounts-a-
 * day cap, while report.mjs's stricter `=== true` disagreed with it in the same run. Coercing at
 * this ONE seam is why no consumer has to guess: `null` stays `null` (she skipped the question),
 * and anything genuinely unreadable stays `null` rather than defaulting to a convenient answer.
 */
function asBool(value) {
  if (typeof value === "boolean") return value;
  if (value === null || value === undefined) return null;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(text)) return true;
  if (["false", "no", "n", "0"].includes(text)) return false;
  return null;
}

/**
 * A yes/no read off a finished answer: a `{yes}` object or a bare boolean as it is, or a sentence whose first word is
 * yes or no ("No. It is built for moving house", "Yes - every day"). Null for anything else, so a sentence that does
 * not open on the answer is never guessed at. The one reader for the report (buildApe, buildAdViewers) and the shaper.
 */
export function yesNoOf(value) {
  const answer = value && typeof value === "object" && !Array.isArray(value) ? value.yes : value;
  if (typeof answer === "boolean") return answer;
  if (typeof answer !== "string") return null;
  const lead = answer.replace(/^[^A-Za-z]+/, "").match(/^(not yet|yes|no)\b/i);
  return lead ? lead[1].toLowerCase() === "yes" : null;
}

/**
 * A nested answer as a real object, whatever shape it arrived in. The brain hands the multi-field
 * answers (`emailCodeExperience`, `endedUpWhereExpected`, `isThisTrash`, `everComingBack`) over the
 * MCP wire as a JSON STRING often enough that it cannot be treated as an anomaly - a live grandma
 * did it for all four on 2026-09-21, and because a string is not an object the shaper passed it
 * through as prose: `interview.endedUpWhereExpected.yes` was then `undefined`, so the funnel counted
 * her as "did not end where expected" and the verdict counted her as never having answered whether
 * she was coming back. She had answered both, in the string. Parsed at this ONE seam so no consumer
 * has to guess; anything that does not parse to an object is left exactly as it came.
 */
function asObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim().startsWith("{")) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : value;
  } catch {
    return value;
  }
}

/** A score as a finite number; a word or an empty answer is `null`, never 0 (0 is not on the 1-5 scale). */
function asNumber(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || String(value).trim() === "") return null;
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * A scenario's own answer, which may be a list or an object the brain sent over the wire as a JSON
 * STRING (the same habit `asObject` covers): parsed when it parses to one, else kept exactly as sent.
 */
function asStructured(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !/^\s*[[{]/.test(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : value;
  } catch {
    return value;
  }
}

/**
 * The questions a scenario asks on top of the standard ones (`scenario.interview`, `{ key: question }`),
 * as `[[key, question]]` in the order written. A key that is one of the standard or optional keys is
 * never a scenario's: it would overwrite an answer every report reads. Empty when it asks none. On a
 * judged visit a judged key (`JUDGING_KEYS`) is standard too, so the scenario only rewords it.
 */
export function interviewExtras(scenario, judged = false, ad = false, ape = false) {
  const asked = scenario && typeof scenario === "object" ? scenario.interview : null;
  if (!asked || typeof asked !== "object" || Array.isArray(asked)) return [];
  return Object.entries(asked).filter(
    ([key, question]) =>
      /^[a-z][A-Za-z0-9]*$/.test(key) &&
      // `constructor`, `toString` and the rest are already on every object, so an answer under one
      // would be taken for an answer already given and skipped.
      !(key in Object.prototype) &&
      typeof question === "string" &&
      question.trim() &&
      !INTERVIEW_KEYS.includes(key) &&
      !INTERVIEW_OPTIONAL_KEYS.includes(key) &&
      !(judged && key in JUDGING_KEYS) &&
      !(ad && AD_INTERVIEW_KEYS.includes(key)) &&
      !(ape && APE_INTERVIEW_KEYS.includes(key)),
  );
}

/** An ad viewer's interview as exactly the ad keys (`AD_INTERVIEW_KEYS`); a missing answer is `null`. */
export function shapeAdInterview(answers = {}, extraKeys = []) {
  const out = {};
  for (const key of AD_INTERVIEW_KEYS) {
    const raw = answers && key in answers ? answers[key] : null;
    if (key === "starsOutOfFive") out[key] = asNumber(raw);
    else if (key === "stopScrolling" || key === "believeIt") {
      const obj = asObject(raw);
      if (obj && typeof obj === "object") out[key] = { ...obj, yes: asBool(obj.yes) };
      else {
        const yes = asBool(raw);
        out[key] = yes === null ? (raw ?? null) : { yes };
      }
    } else if (key === "feltLike" || key === "nextMove") out[key] = asObject(raw) ?? null;
    else out[key] = raw ?? null;
  }
  for (const key of INTERVIEW_OPTIONAL_KEYS) if (answers && key in answers && answers[key] != null) out[key] = answers[key];
  for (const key of extraKeys ?? []) {
    if (Object.hasOwn(out, key)) continue;
    out[key] = answers && Object.hasOwn(answers, key) ? asStructured(answers[key]) : null;
  }
  return out;
}

/**
 * A power user's interview as exactly the APE keys (`APE_INTERVIEW_KEYS`); a missing answer is `null`. The two counts
 * come back as numbers, the lost-work and would-use-daily answers as {yes, what} and {yes, why} with a real boolean.
 */
export function shapeApeInterview(answers = {}, extraKeys = []) {
  const out = {};
  for (const key of APE_INTERVIEW_KEYS) {
    const raw = answers && key in answers ? answers[key] : null;
    if (key === "annoyanceScore" || key === "starsOutOfFive") out[key] = asNumber(raw);
    else if (key === "lostWork" || key === "wouldUseDaily") {
      const obj = asObject(raw);
      if (obj && typeof obj === "object") out[key] = { ...obj, yes: asBool(obj.yes) };
      else {
        const yes = asBool(raw);
        // A sentence that opens on yes or no keeps the whole sentence as its reason (`what` / `why`).
        const sentence = yes === null ? yesNoOf(raw) : null;
        const why = key === "lostWork" ? "what" : "why";
        if (yes !== null) out[key] = { yes };
        else if (sentence !== null) out[key] = { yes: sentence, [why]: raw };
        else out[key] = raw ?? null;
      }
    } else out[key] = raw ?? null;
  }
  for (const key of extraKeys ?? []) {
    if (Object.hasOwn(out, key)) continue;
    out[key] = answers && Object.hasOwn(answers, key) ? asStructured(answers[key]) : null;
  }
  return out;
}

/**
 * ART's shared questions (sue/README.md#art), folded into every ART persona's own interview by withPersonaQuestions,
 * so the team answers the same eight whatever her specialty. The wording is the team's; the shapers below read them. The
 * grade's anchor, colourMeaning and appeal came from the owner's 2026-10-12 review of Benefit Buddy, whose blue "You
 * qualify", grey boxes and unread text block the team had passed: "find me another one that understands when something
 * looks like shit ... when a huge block of text is necessary and when it isn't, when colors make sense and when they don't".
 */
export const ART_QUESTIONS = Object.freeze({
  designGrade:
    "the design as a professional would grade it: a whole number from 1 to 10, then the one sentence that earns that grade. 7 or above means it holds its own beside Google's and Apple's best apps; a tidy stack of plain boxes, tables, grey cards and text blocks is a 4 at most, however correct",
  topFixes:
    "the five changes that would lift this design most, ranked: for each, the screen, what is there now, exactly what to change it to, the principle with its id from what you know, and how sure you are",
  progressiveDisclosure:
    "what this product shows too early (choices, fields, settings or words a person does not need yet) and what it hides too deep (what they need now but must hunt for), screen by screen, each with the fix. Name every block of text a visitor would skip, and fold or cut it",
  colourMeaning:
    "every colour that carries meaning here (a verdict, a status, a warning, a main button): what it says now, and whether a person reads it right without the words (green is yes or done, red a problem, amber a warning, blue information or an action). Each mismatch, with its fix",
  appeal:
    "would a person who uses Google's and Apple's best apps want to open this one again, or does it read as a dull form? The screen that looks most like a form, what makes it dull (sameness, grey boxes, tables, walls of text, no focal point), and the change that would make it look made with care",
  screenFit:
    "how the layout fits the screen you used (a phone in one hand, or a computer): what crowds or breaks, what space is wasted, and the change that fixes it",
  keep: "what is already well designed and must survive the polish, each with why it works",
  wouldShip: "yes or no: would you sign off on this design shipping today as it is? Then the one thing that must change first",
});
export const ART_INTERVIEW_KEYS = Object.freeze(Object.keys(ART_QUESTIONS));

/**
 * A design grade as a whole number from 1 to 10, read from its leading number ("7", "7/10", "8 - clean, but the menu is dense"),
 * else null. A number that is not a whole grade on that scale is null, never rounded to one.
 */
export function gradeOf(value) {
  if (typeof value === "number") return Number.isInteger(value) && value >= 1 && value <= 10 ? value : null;
  if (typeof value !== "string") return null;
  const lead = value.replace(/^[^0-9]+/, "").match(/^(\d+)(?!\d)(?!\.\d)/);
  const grade = lead ? Number(lead[1]) : NaN;
  return grade >= 1 && grade <= 10 ? grade : null;
}

/**
 * An ART designer's answers read on the way in and on the way back: designGrade as its whole number (gradeOf), and wouldShip
 * as {yes, why} through the shared yesNoOf reader. Idempotent, so a correct answer is unchanged by a second pass.
 */
export function shapeArtAnswers(shaped = {}) {
  const out = { ...shaped };
  if ("designGrade" in out) out.designGrade = gradeOf(out.designGrade);
  if ("wouldShip" in out) {
    const raw = out.wouldShip;
    const yes = yesNoOf(raw);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) out.wouldShip = { ...raw, yes };
    else out.wouldShip = raw === null || raw === undefined || raw === "" ? null : { yes, why: raw };
  }
  return out;
}

/** The interview as exactly those keys; a missing answer is `null`, never dropped. Scores and
 *  yes/no answers are coerced to real numbers and booleans here - see `asBool`. `extraKeys` are the
 *  scenario's own questions (`interviewExtras`): kept, `null` when she skipped one, never required.
 *  A judged interview (`judged`, read off the answers when not said) also keeps the judged keys. */
export function shapeInterview(answers = {}, extraKeys = [], judged = judgedAnswers(answers)) {
  const out = {};
  for (const key of judged ? [...INTERVIEW_KEYS, ...Object.keys(JUDGING_KEYS)] : INTERVIEW_KEYS) {
    const asGiven = answers && key in answers ? answers[key] : null;
    const raw = INTERVIEW_NESTED_BOOLS[key] || INTERVIEW_NESTED_NUMBERS[key] ? asObject(asGiven) : asGiven;
    if (INTERVIEW_BOOLS.has(key)) out[key] = asBool(raw);
    else if (INTERVIEW_SCORES.has(key)) out[key] = asNumber(raw);
    else if (raw && typeof raw === "object" && (INTERVIEW_NESTED_BOOLS[key] || INTERVIEW_NESTED_NUMBERS[key])) {
      const nested = { ...raw };
      // `{value: true, why}` or `{answer: "false", where}`: both critic brains named the yes/no
      // `value` on 2026-09-28 (runs 20260928-133054-5e00 and -9af5), every reader wants `.yes`, and
      // "Ended where expected" read 0 for a Sue who said she did. Renamed only when it reads as one.
      if ((INTERVIEW_NESTED_BOOLS[key] ?? []).includes("yes") && !("yes" in nested)) {
        const alias = ["value", "answer"].find((field) => field in nested && asBool(nested[field]) !== null);
        if (alias) {
          nested.yes = nested[alias];
          delete nested[alias];
        }
      }
      for (const field of INTERVIEW_NESTED_BOOLS[key] ?? []) if (field in nested) nested[field] = asBool(nested[field]);
      for (const field of INTERVIEW_NESTED_NUMBERS[key] ?? []) if (field in nested) nested[field] = asNumber(nested[field]);
      out[key] = nested;
    } else if ((INTERVIEW_NESTED_BOOLS[key] ?? []).includes("yes")) {
      // A BARE `everComingBack: false` (or a `"false"` string): `personas.mjs` and `SPEC.md` ask her
      // for "true or false, and why", so the brain sends the boolean itself often enough. Every
      // reader wants `.yes`, so wrap it here - an unwrapped bare boolean was silently dropped from
      // the verdict, the journal and the scoreboard.
      const yes = asBool(raw);
      out[key] = yes === null ? raw : { yes };
    } else out[key] = raw;
  }
  // Asked by an intent scenario (lib/workspace.mjs intentScenario), never required: a Sue that was
  // not told to complain or to read her mail simply has nothing to say here, and a missing optional
  // answer must never hold her visit open the way a missing required one does.
  for (const key of INTERVIEW_OPTIONAL_KEYS) if (answers && key in answers && answers[key] != null) out[key] = answers[key];
  // A scenario's own questions (the AI-answering scenario asks what the AI said to each question):
  // what she said, or null, so the report can tell "skipped" from "never asked".
  for (const key of extraKeys ?? []) {
    if (Object.hasOwn(out, key)) continue;
    out[key] = answers && Object.hasOwn(answers, key) ? asStructured(answers[key]) : null;
  }
  return out;
}

/** `contactedSupport` {did, how, whatISaid} and `emailsReceived` [{from, subject, whatIThought}]. */
export const INTERVIEW_OPTIONAL_KEYS = Object.freeze(["contactedSupport", "emailsReceived"]);

/** Which keys she skipped, so the tool result can ask for them by name. */
export function missingInterviewKeys(answers = {}, judged = false, ad = false, ape = false) {
  return interviewKeys(judged, ad, ape).filter((key) => !(answers && key in answers) || answers[key] === null || answers[key] === "");
}

/**
 * What she clicked that ASKED FOR A CODE. Deliberately does NOT match "sign": on 2026-09-21 a run
 * reported "requested a code 10, read the code 0", which reads like our mail is broken - and every
 * one of those ten was a Sue typing her address into the SIGN-IN chooser and clicking "Sign in",
 * where an address with no account correctly gets no code at all. A funnel row that turns a
 * not-registered sign-in into a missing email will send somebody chasing a production outage that
 * does not exist. "Sign up" is caught by the signup-context check at the call site, not by this word.
 */
export const OTP_REQUEST_TEXT = /\bcode\b|continue|send|next/i;

/**
 * The site's deliberately generic anti-bot answer to a code request (accounts request-otp's
 * GENERIC_REJECTION: the Turnstile gate and the spam gate both send it). A Sue meets it when OUR
 * Sue sign-up door (services/accounts/lambda/src/auth-request-otp/turnstile-gate.ts) will not let
 * her through - a key mismatch, or the robot check behind the door, which a Sue never solves. (Until
 * 2026-09-23 a daily cap there was the usual cause; it is deleted.)
 */
export const SUE_DOOR_REFUSAL_TEXT = /unable to process this request/i;

/** The body's finding kind for that refusal: a SUE-side event, never a product defect. */
export const SUE_DOOR_REFUSED = "sue-door-refused";

/**
 * SUE's own browser closed under her mid-visit: Playwright's words for it, and the body's finding
 * kind. On 2026-09-23 four live run browsers closed within two minutes of each other (13:02 to 13:04
 * UTC, every lane at once), and four Sues filed "I ticked the box and the whole website vanished" as
 * the site's defect. The page never vanished; our browser did. Everything she said after it is SUE-side.
 */
export const BROWSER_LOST_TEXT = /Target page, context or browser has been closed|Browser has been closed|browser has disconnected/i;
export const SUE_BROWSER_LOST = "sue-browser-lost";
/**
 * How the body's answer opens when it gave her a fresh browser (body.mjs `browserReopenedSentence`):
 * that answer is not her seeing a page yet, so the report's window stays open until a look after it.
 */
export const BROWSER_REOPENED = "Your browser suddenly closed, and you opened it again.";

/**
 * Did our own door refuse her, rather than the site's email failing her? True only when all three
 * hold: she asked for a code, what she `saw` shows the anti-bot refusal, and no mail carrying
 * exactly one code has reached her inbox since that request (the mailroom never saw one).
 *
 * Why it exists: on 2026-09-22 every "Unable to process this request" a Sue met on "Email me a
 * code" was the door's daily cap, and report.md still ranked "the email code flow is broken" as the
 * top defect across three runs; a morning went into chasing an outage that did not exist.
 * `otpRequestedAt` is the body's epoch ms or body.json's ISO stamp; `inbox` is `readInbox`'s shape.
 */
export function sueDoorRefused({ saw, otpRequestedAt, inbox = [] } = {}) {
  const askedAt = typeof otpRequestedAt === "number" ? otpRequestedAt : Date.parse(String(otpRequestedAt ?? ""));
  if (!Number.isFinite(askedAt)) return false;
  if (!SUE_DOOR_REFUSAL_TEXT.test(String(saw ?? ""))) return false;
  return !productMail(inbox ?? []).some((m) => Number(m?._stamp) >= askedAt && singleCode(m?.text));
}

/**
 * A hand result that says nothing was done: pointing only named the spot, the scroller was already
 * at its end, the link leaves the site, the number was stale or unknown, or nothing took the click.
 */
const HAND_DID_NOTHING =
  /^That spot is|nothing more to scroll|You stay here|There is no \[|not on the page any more|Nothing on the page says|greyed out|nothing would take the click/i;

/**
 * Did this trace event MOVE something on her screen - a click, a scroll or a pointed click the
 * body carried out? `point` counts only when it acted ("You did ..."); a refused or failed hand
 * never counts. `frozenLooks` reads this to tell a dead screen from a Sue who merely looked twice.
 */
export function handActed(event = {}) {
  if (!["click", "scroll", "point"].includes(event?.tool)) return false;
  if (event.isError || event.refused) return false;
  const said = String(event.result ?? "");
  if (HAND_DID_NOTHING.test(said)) return false;
  // A tap on a numbered thing is pressed through click, and answers the way click does.
  if (event.tool === "point") return /^You (did |clicked)/.test(said);
  if (event.tool === "scroll") return /^You scrolled/.test(said);
  return /^You clicked/.test(said);
}

/** How many byte-identical looks in a row, with a hand that acted between each, make a stretch. */
export const FROZEN_LOOKS_MIN = 3;

/**
 * Stretches where her screen did not change by one byte while her hands kept clicking or
 * scrolling: consecutive `look` events with the same `shotHash`, each after at least one hand that
 * acted (`handActed`). A look after only a note or a wait neither extends nor breaks a stretch; a
 * look that differs ends it. Returned only at `minLooks` or more:
 * `[{ fromShot, toShot, looks, hands, startAt, endAt }]`, `endAt` being the look that finally
 * changed (null when the visit ended frozen).
 *
 * Why it exists: run 20260922-115216-aa5f - eight Sues swiped a phone editor that SUE's own scroll
 * never moved (identical shots, four swipes running) and filed the editor as broken. A screen that
 * does not answer several hands in a row is SUE's perception first and the page's fault second,
 * and the report says so instead of listing it as a site defect. No hash, no claim.
 */
export function frozenLooks(trace = [], { minLooks = FROZEN_LOOKS_MIN } = {}) {
  const out = [];
  let prev = null;
  let acted = [];
  let stretch = null;
  const close = (endAt) => {
    if (stretch && stretch.looks >= minLooks) out.push({ ...stretch, endAt });
    stretch = null;
  };
  for (const event of trace ?? []) {
    if (event?.tool !== "look") {
      if (handActed(event)) acted.push(event.tool);
      continue;
    }
    const hash = event.shotHash || null;
    const shot = event.screenshot ? path.win32.basename(String(event.screenshot)) : null;
    if (!hash) {
      close(event.at ?? null);
      prev = null;
      acted = [];
      continue;
    }
    if (prev && hash === prev.hash) {
      if (acted.length) {
        stretch ??= { fromShot: prev.shot, toShot: prev.shot, looks: 1, hands: [], startAt: prev.at };
        stretch.looks += 1;
        stretch.hands.push(...acted);
        stretch.toShot = shot;
      }
    } else {
      close(event.at ?? null);
    }
    prev = { hash, shot, at: event.at ?? null };
    acted = [];
  }
  close(null);
  return out;
}

/**
 * Which AREA of the website a URL is, in the words a visitor would use - "notes", "accounts", "pay",
 * or "the front page". Not "plane": she has never heard the word and never will.
 *
 * She could not perceive this at all before 2026-09-21, which is the gap the owner named: "I logged
 * in on the notes page and it sent me to the accounts page. Why the heck am I on the accounts page
 * after heading to notes?" Her `look` shows her one screen at a time, so a cross-area throw was
 * invisible to her - the hostname never reaches her eyes. The subdomain is the area when there is
 * one, else the first path segment, else the front page.
 */
export function areaOfUrl(url) {
  let parsed;
  try {
    parsed = unwrapBlob(new URL(String(url)));
  } catch {
    return null;
  }
  if (!parsed) return null;
  const labels = parsed.hostname.split(".").filter(Boolean);
  const registrable = parsed.hostname.endsWith("localhost") ? 1 : 2;
  const sub = labels.slice(0, Math.max(0, labels.length - registrable)).filter((l) => l !== "www");
  if (sub.length) return sub.join(".");
  const segment = parsed.pathname.split("/").filter(Boolean)[0];
  return segment ? segment.toLowerCase() : "the front page";
}

/**
 * The sentence her hands hand her when a click moved her to a different area of the site, or null
 * when it did not. Said plainly and without an opinion - the opinion is hers to write in the diary.
 */
export function areaChange(before, after) {
  const from = areaOfUrl(before);
  const to = areaOfUrl(after);
  if (!from || !to || from === to) return null;
  return { from, to, sentence: `You were on ${from} a moment ago; this is ${to} now.` };
}

/** How many things she may do between diary lines before her hands point it out. */
export const NUDGE_EVERY = 6;

/**
 * The nudge, or null. The diary is the whole deliverable of a Sue, and a brain deep in a task
 * silently stops writing in it - so the body asks, on a count rather than on a judgment.
 */
export function journalNudge(sinceNote) {
  const n = Number(sinceNote);
  if (!Number.isInteger(n) || n <= 0 || n % NUDGE_EVERY !== 0) return null;
  return `You have done ${n} things since you last wrote anything down. Call note with what you are actually thinking right now - even if it is only that you are lost, or bored, or cannot find what you came for.`;
}

const LANDING_TEMPLATE = /\{\{\s*target\.expectedLandingAfterSignup\s*\}\}/g;
const ANY_TEMPLATE = /\{\{[^}]*\}\}/;

/**
 * `scenario.expectedLandingPattern` resolved against the target, as a RegExp - or null when the
 * scenario has none. The committed scenarios (`signup`, `host-event`, `return-login`) carry the
 * literal `{{target.expectedLandingAfterSignup}}`; the cannon resolves it before it writes
 * `sue.json`, but a `sue.json` that names its scenario by id reaches the body RAW (the fixture in
 * `tests/fixtures/runs/sample-run/` does exactly that), so the body resolves it here too, with the
 * same substitution `cannon.mjs`'s `resolveScenario` performs. A template that still has a `{{`
 * in it after substitution is NOT a pattern: compiled literally it could never match a real URL
 * and every Sue would earn a false `wrong-destination`, so it is null, the same as "no pattern".
 */
export function landingPattern(scenario = {}, target = {}) {
  const raw = scenario?.expectedLandingPattern;
  if (!raw || typeof raw !== "string") return null;
  const resolved = raw.replace(LANDING_TEMPLATE, String(target?.expectedLandingAfterSignup ?? ""));
  if (!resolved || ANY_TEMPLATE.test(resolved)) return null;
  try {
    return new RegExp(resolved);
  } catch {
    return null;
  }
}

/**
 * The landing pattern a Sue's ending MISSED, or null when there is nothing to file. Two endings are
 * never a wrong destination (run 20260922-224205, where both were filed as site defects):
 * - a Sue who GAVE UP already said where she stopped and why in her own `gave-up` finding; judging
 *   her landing too filed the same moment twice (karen, still on the sign-in page);
 * - her own Mail tab is SUE's page, not the site's, so `url` must be the last SITE page she was on
 *   (body.mjs `siteUrl`); grandma read her last email and was filed as ending on inbox.sue.invalid.
 */
export function missedLanding({ outcome, url, scenario, target }) {
  if (outcome === "gave-up") return null;
  const pattern = landingPattern(scenario, target);
  return pattern && !pattern.test(String(url ?? "")) ? pattern : null;
}

/**
 * Where she is on the SITE: the page she is on unless that is her Mail tab (SUE's own inbox page),
 * else the most recent open page that is not. `openUrls` is every open tab's address, oldest first.
 */
export function siteUrlOf(current, openUrls = [], isInbox = () => false) {
  if (!isInbox(current)) return current;
  return [...openUrls].reverse().find((url) => url && !isInbox(url)) ?? current;
}

/**
 * The declared EXIT a URL is, or null. An exit is a hand-off to another website that IS the
 * product's own next step - "Sign in with Discord" landing on Discord's authorize page, a checkout
 * on the payment processor's host - declared on the target as
 * `exits: [{ id, name, match, says? }]` (`match` a regex source over the full URL).
 *
 * Why it exists: before 2026-09-21 every off-host click was `left-site`, so a product whose account
 * lives on a third party (Example App Next signs in ONLY through Discord) scored every visitor who
 * pressed its main button as someone who wandered off. The rail is unchanged - the body still never
 * follows an off-host URL - but reaching a declared exit is recorded as `reached-exit` and she is
 * told how far she got, instead of being told she went to "a different website" and bounced back.
 * An unparsable URL or a bad pattern is never an exit.
 */
export function exitFor(url, exits = []) {
  const href = String(url ?? "");
  if (!href || !Array.isArray(exits)) return null;
  for (const exit of exits) {
    if (!exit || typeof exit.match !== "string" || !exit.id) continue;
    let pattern;
    try {
      pattern = new RegExp(exit.match, "i");
    } catch {
      continue;
    }
    if (pattern.test(href)) return exit;
  }
  return null;
}

/** What her hands say when a click reached an exit: the target's own words, else a plain default. */
export function exitSentence(exit) {
  const said =
    exit?.says && String(exit.says).trim()
      ? String(exit.says).trim()
      : `That opens ${exit?.name || "another website"}, which is where this website hands you over. You get no further than that page here; if that is what you came for, you got there.`;
  // `finishes`: reaching this door IS the end of the visit (a product whose every path runs through
  // its sign-in). Without it she kept circling the page she had already finished with.
  return exit?.finishes ? `${said} ${EXIT_FINISHES}` : said;
}

export const EXIT_FINISHES = "That is the end of this visit: call done, and say what you made of the website on the way here.";

/**
 * A brain that never spoke is NOT a Sue, and her silence is NOT an opinion about the page.
 *
 * The CLI reports an auth/API failure as a `result` event carrying `is_error: true` and
 * `terminal_reason: "api_error"`, with the human-readable cause in `result`. On 2026-09-21 a
 * five-hour, 400-Sue run was ENTIRELY "Failed to authenticate: OAuth session expired and could not
 * be refreshed" - the field was already recorded in every summary.json and nothing read it, so the
 * report rendered 400 dead sessions as "400 visitors had no idea what this page sells" and the
 * cannon looped 40 more waves on top. This is the one seam that decides "no data" vs "a finding".
 *
 * Returns `{ kind, message }` (kind: auth | rate-limit | timeout | api) or null when the session really ran.
 *
 * Running out of turns is NOT a dead brain: the CLI flags `error_max_turns` with `is_error: true`, but
 * that Sue browsed for every one of those turns and her diary is data. `ranOutOfTurns` names her.
 */
export function ranOutOfTurns(result) {
  return result?.subtype === "error_max_turns";
}

/** A brain that ends its visit in words with no tool call in two turns or fewer never visited the page. */
export function idleEndFrom(result) {
  const r = result || {};
  if (r.subtype !== "success" || (r.num_turns ?? 0) > 2) return null;
  return { kind: "idle", message: "the brain ended its visit in words after at most two turns, without a single tool call" };
}

export function brainErrorFrom(result) {
  const r = result || {};
  if (ranOutOfTurns(r)) return null;
  const fatal =
    r.is_error === true || r.terminal_reason === "api_error" || r.subtype === "error_during_execution" || r.subtype === "error_timeout";
  if (!fatal) return null;
  const message = String(r.result ?? r.error ?? "").trim();
  const kind =
    r.subtype === "error_timeout" || /timed out|timeout/i.test(message)
      ? "timeout"
      : /authenticat|oauth|\blogin\b|expired|credential/i.test(message)
        ? "auth"
        : /rate.?limit|usage limit|quota|\b429\b|overload|\b529\b/i.test(message)
          ? "rate-limit"
          : "api";
  return { kind, message: message || `the brain failed with ${r.terminal_reason || r.subtype || "an unnamed error"}` };
}
