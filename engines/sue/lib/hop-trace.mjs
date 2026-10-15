import { pickArgusIds, readArgusIds } from "./argus-ids.mjs";

/**
 * hop-trace - every page her tabs pass through, on her move or on their own
 * ==========================================================================
 * What it is: `createHopTrace` watches each of her tabs and writes one `kind: "hop"` line into her
 * `trace.jsonl` (the same file her moves go to, through `findings.trace`) after every main-frame
 * navigation: a page load, a server redirect on the way to one, and an address the page changed
 * with no load (its own router, or back and forward from the browser's cache). Each line says which
 * tab, when, where (`hopUrl`: the path and the param names, never a code, state or token value),
 * how, who moved her, and whether the shared login pointer was there at that moment:
 *
 *   { at, kind: "hop", tab, url, how: "load" | "redirect" | "in-page", by: "her" | "site" | "body",
 *     move?, status?, cxActive: "yes" | "blank" | "no" | null, cxActiveOn: [domain], sessionKeys: [name] | null, readMs }
 *
 * `by` is "her" on the one hop a move of hers started (`move` names it; "arrive" is the link she came
 * on), "body" on a page SUE's body opened for her (a reopened browser, back off an off-site page), and
 * "site" on everything the site did after that by itself: each redirect, each script that sent her on.
 * `cxActive` is the `cx-active` cookie the page would be sent (set, set but empty as a sign-out
 * leaves it, or not there), `cxActiveOn` every domain in her jar that holds a set one, and
 * `sessionKeys` the page's own localStorage keys that name a login session (`isSessionKey`), read
 * over CDP (DOMStorage), never by running script in her page. Names only: no cookie value and no
 * storage value is ever written. `null` is a read that did not answer in time, or a redirect (it has
 * no page to read). The reads start the moment the hop is seen and `readMs` says how long they took,
 * so a page that wrote its own keys in those few milliseconds shows them (measured: 2 to 110 ms).
 *
 * Why it exists: run 20260923-191716-e508 (sue-4788-angel-priya). A new member signed in on Pass,
 * was sent on to Deals, and ended signed out on the homepage. Her trace had one row per move, so the
 * pages her tab went through between two moves (the OAuth bounce, the location.assign to Deals, the
 * signed-out bounce home) and whether the pointer survived each were never written, and the run
 * could not say which of them lost her session (AI to-do 6871e46f).
 *
 * Cheap on purpose, because it runs on every navigation of hundreds of Sues: one cookie read and one
 * CDP storage read per hop, both started at once, each bounded by `HOP_READ_MS`, never awaited by
 * her moves. Lines in one tab are written in the order the hops happened.
 *
 * Who depends on it: `sue/body.mjs` (the only writer), `sue/report.mjs` (keeps hop lines
 * out of her moves with `isHop`), `sue/tests/hop-trace.spec.mjs` and `hands.spec.mjs`.
 * Node builtins only; the pages come from playwright-core in body.mjs. Never bun (SPEC.md).
 */

/** The `kind` of a hop line: her moves have no kind, so a reader of her moves leaves these out. */
export const HOP_KIND = "hop";

/** Is this trace line a hop line (not one of her moves)? */
export const isHop = (row) => row?.kind === HOP_KIND;

/** The `kind` of the line a visit closes with (argus ids, no move). */
export const END_KIND = "end";

/** Is this trace line the closing line of a visit (not one of her moves)? */
export const isEnd = (row) => row?.kind === END_KIND;

/** The shared login pointer every plane reads on load (infra/shared/auth-refresh-cookie.ts, ACTIVE_ACCOUNT_COOKIE_NAME). */
export const POINTER_COOKIE = "cx-active";

/** How long one hop's cookie or storage read may take before the line is written without it. */
export const HOP_READ_MS = 1_500;

/** More hops than this in one tab in one second are counted, not written (a page rewriting its address as she types). */
const HOPS_PER_SECOND = 8;

/**
 * A page storage key that names a login session: the AEGIS client's own keys
 * (`<plane>.aegis.oauth.*`, infra/shared/auth/aegis-bearer-client.ts) and the optimistic identity
 * (`cx-id`, infra/shared/auth/optimistic-identity.ts). Everything else a page stores stays unlisted.
 */
export const isSessionKey = (name) => /(^|\.)aegis\./i.test(String(name ?? "")) || name === "cx-id";

/** A param whose value is never kept, by its name. */
const SECRET_NAME = /code|state|token|secret|pass|pwd|key|sig|auth|session|ticket|jwt|invite|verif|otp|nonce|challenge|cred|salt|hash/i;
/** A value plain enough to keep: a lower-case word (hyphens allowed) or a number of at most four digits. */
const PLAIN_VALUE = /^(?:[a-z]+(?:-[a-z]+)*|\d{1,4})$/;
/** A path part that looks like a secret: a JWT, or anything long enough to be a token. */
const SECRET_SEGMENT = /^eyJ|^.{41,}$/;

const escapeValue = (value) => value.replace(/[%&#+\s]/g, (c) => encodeURIComponent(c));

/** One `name=value`, or the name alone when the value is not kept. An address in a value is cleaned too, `depth` deep. */
function paramOf(name, value, depth) {
  const shown = encodeURIComponent(name);
  if (!value || SECRET_NAME.test(name)) return shown;
  if (value.length <= 24 && PLAIN_VALUE.test(value)) return `${shown}=${value}`;
  if (depth > 0 && /^(?:\/(?!\/)|https?:\/\/)/i.test(value)) {
    const inner = cleanAddress(value, depth - 1);
    if (inner) return `${shown}=${escapeValue(inner)}`;
  }
  return shown;
}

const queryOf = (params, depth) => {
  const parts = [...params].map(([name, value]) => paramOf(name, value, depth));
  return parts.length ? `?${parts.join("&")}` : "";
};

const pathOf = (pathname) =>
  pathname
    .split("/")
    .map((part) => (SECRET_SEGMENT.test(part) ? "[hidden]" : part))
    .join("/");

/** A fragment is kept only as a plain anchor or route; one that carries values keeps their names. */
function fragmentOf(hash) {
  if (!hash || hash === "#") return "";
  const body = hash.slice(1);
  if (/^[\w/-]{1,60}$/.test(body)) return hash;
  if (body.includes("=")) return `#${[...new URLSearchParams(body).keys()].map((n) => encodeURIComponent(n)).join("&")}`;
  return "";
}

function cleanAddress(value, depth) {
  try {
    const u = new URL(value, "http://relative.invalid");
    const rest = `${pathOf(u.pathname)}${queryOf(u.searchParams, depth)}`;
    return value.startsWith("/") ? rest : `${u.origin}${rest}`;
  } catch {
    return null;
  }
}

/**
 * Where a hop went, safe to write: the origin, the path, every query param's NAME, and a value only
 * when it is a plain word or a small number under a harmless name (`welcome=trial`, `days=60`). A
 * code, state, token, invite, password or anything that looks like one keeps its name alone; an
 * address carried in a param (a `return` path) is cleaned the same way, one level deep.
 */
export function hopUrl(raw) {
  const text = String(raw ?? "");
  let u;
  try {
    u = new URL(text);
  } catch {
    return text.replace(/[?#][\s\S]*$/, "");
  }
  if (u.protocol === "data:" || u.protocol === "javascript:") return u.protocol;
  if (u.protocol === "blob:") return `blob:${hopUrl(u.pathname)}`;
  if (!/^https?:$/.test(u.protocol)) return `${u.protocol}${u.host ? `//${u.host}` : ""}${u.pathname}`;
  return `${u.origin}${pathOf(u.pathname)}${queryOf(u.searchParams, 1)}${fragmentOf(u.hash)}`;
}

const bareDomain = (domain) => String(domain ?? "").replace(/^\./, "");

/** Would a cookie on `domain` go to `host`? A leading dot is a domain cookie (host and every subdomain); none is its host's alone. */
function sentTo(domain, host) {
  const d = String(domain ?? "").toLowerCase();
  if (d.startsWith(".")) return host === d.slice(1) || host.endsWith(d);
  return host === d;
}

/** The pointer the page at `url` would be sent: "yes", "blank" (there but empty, as a sign-out leaves it) or "no". */
export function cxActiveFor(cookies, url) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return "no";
  }
  const sent = (cookies ?? []).filter((c) => c?.name === POINTER_COOKIE && sentTo(c.domain, host));
  if (sent.some((c) => c.value)) return "yes";
  return sent.length ? "blank" : "no";
}

/** Every domain in her jar that holds a set pointer, bare and sorted: where she is signed in, by name only. */
export const cxActiveDomains = (cookies) =>
  [...new Set((cookies ?? []).filter((c) => c?.name === POINTER_COOKIE && c.value).map((c) => bareDomain(c.domain)))].sort();

/** `promise`'s answer, or null when it fails or takes longer than `ms`. */
function within(ms, promise) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  return Promise.race([Promise.resolve(promise).catch(() => null), late]).finally(() => clearTimeout(timer));
}

const withoutFragment = (url) => String(url ?? "").replace(/#[\s\S]*$/, "");
function originOf(url) {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? null : origin;
  } catch {
    return null;
  }
}

/**
 * The watcher. `write(row)` appends a line to her trace; `mover()` says who is moving her right now
 * (`{ seq, by, move }`: a move of hers or a page the body is opening, a new `seq` each time, or null
 * when nothing is); `cdpFor(page)` gives a CDP session on a tab; `storageAllowed(url)` says whose page
 * storage may be read (her target's own hosts). `{ watch(page), settle(ms), stop() }`.
 */
export function createHopTrace({ write, mover = () => null, cdpFor, storageAllowed = () => true, readMs = HOP_READ_MS, log = () => {} }) {
  const tabs = new WeakMap();
  const pending = new Set();
  let nextTab = 1;
  let stopped = false;

  /** Who started this chain: the move running now, once per tab per move; after that the site. */
  function claim(tab) {
    const m = mover();
    if (m && tab.claimed !== m.seq) {
      tab.claimed = m.seq;
      return { by: m.by, move: m.move };
    }
    return { by: "site", move: null };
  }

  async function sessionKeys(page, origin) {
    const session = await cdpFor(page);
    const read = (storageId) => session.send("DOMStorage.getDOMStorageItems", { storageId: { ...storageId, isLocalStorage: true } });
    const reply = await read({ securityOrigin: origin }).catch(() => read({ storageKey: `${origin}/` }));
    return (reply?.entries ?? [])
      .map(([name]) => name)
      .filter(isSessionKey)
      .sort();
  }

  async function markers(page, url, how, redirected) {
    const started = Date.now();
    const web = /^https?:/i.test(url);
    const origin = originOf(url);
    const [jar, keys, status, argus] = await Promise.all([
      web ? within(readMs, page.context().cookies()) : null,
      web && origin && how !== "redirect" && storageAllowed(url) ? within(readMs, sessionKeys(page, origin)) : null,
      redirected
        ? within(
            readMs,
            redirected.response().then((res) => res?.status() ?? null),
          )
        : null,
      web ? within(readMs, readArgusIds(page)) : null,
    ]);
    return {
      ...(status ? { status } : {}),
      cxActive: jar ? cxActiveFor(jar, url) : null,
      cxActiveOn: jar ? cxActiveDomains(jar) : null,
      sessionKeys: keys,
      ...pickArgusIds(argus ?? {}),
      readMs: Date.now() - started,
    };
  }

  function hop(page, tab, { at, url, how, by, move, redirected = null }) {
    if (stopped) return;
    if (how !== "redirect") tab.lastUrl = url;
    const second = Math.floor(at / 1000);
    if (tab.second !== second) Object.assign(tab, { second, inSecond: 0 });
    tab.inSecond += 1;
    if (tab.inSecond > HOPS_PER_SECOND) {
      tab.skipped += 1;
      return;
    }
    const skipped = tab.skipped;
    tab.skipped = 0;
    // The line is still written without its markers: where she went matters even when the jar would not answer.
    const reading = markers(page, url, how, redirected).catch((err) => {
      log("the login markers were not read:", err?.message ?? err);
      return {};
    });
    const written = tab.writing
      .then(() => reading)
      .then((marks) =>
        write({
          at: new Date(at).toISOString(),
          kind: HOP_KIND,
          tab: tab.n,
          url: hopUrl(url),
          how,
          by,
          ...(move ? { move } : {}),
          ...(skipped ? { skippedBefore: skipped } : {}),
          ...marks,
        }),
      )
      .catch((err) => log("a hop line was not written:", err?.message ?? err));
    tab.writing = written;
    pending.add(written);
    written.finally(() => pending.delete(written));
  }

  function onRequest(page, tab, req) {
    const at = Date.now();
    const from = req.redirectedFrom();
    if (from) {
      const chain = tab.chain ?? { by: "site", move: null };
      hop(page, tab, { at, url: from.url(), how: "redirect", by: chain.by, move: chain.move, redirected: from });
      tab.chain = { url: req.url(), by: "site", move: null };
      return;
    }
    tab.chain = { url: req.url(), ...claim(tab) };
  }

  function onCommit(page, tab, url) {
    if (!url || url === "about:blank") return;
    const at = Date.now();
    const chain = tab.chain;
    if (chain && withoutFragment(chain.url) === withoutFragment(url)) {
      tab.chain = null;
      hop(page, tab, { at, url, how: "load", by: chain.by, move: chain.move });
      return;
    }
    const sameDocument = tab.lastUrl && originOf(tab.lastUrl) && originOf(tab.lastUrl) === originOf(url);
    if (sameDocument) {
      if (url === tab.lastUrl) return;
      hop(page, tab, { at, url, how: "in-page", ...claim(tab) });
      return;
    }
    // A page that loaded without a request seen for it: the tab's very first, or an error page.
    tab.chain = null;
    hop(page, tab, { at, url, how: "load", ...(chain ?? claim(tab)) });
  }

  function watch(page) {
    if (!page || tabs.has(page)) return;
    const tab = { n: nextTab++, lastUrl: null, chain: null, claimed: null, writing: Promise.resolve(), second: 0, inSecond: 0, skipped: 0 };
    tabs.set(page, tab);
    page.on("request", (req) => {
      try {
        if (!req.isNavigationRequest() || req.frame() !== page.mainFrame()) return;
      } catch {
        return; // a service worker's request has no frame, and is no navigation of hers
      }
      onRequest(page, tab, req);
    });
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) onCommit(page, tab, frame.url());
    });
  }

  /** Waits (at most `ms`) for the hop lines still being read, so a visit that ends writes its last hops. */
  async function settle(ms = readMs + 500) {
    if (!pending.size) return;
    await within(ms, Promise.allSettled([...pending]));
  }

  return {
    watch,
    settle,
    stop: () => {
      stopped = true;
    },
  };
}
