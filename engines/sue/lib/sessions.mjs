/**
 * sessions - a signed-in Sue borrows a session a HUMAN made, and never sees it.
 * ==============================================================================
 *
 * WHAT: where a saved session lives (`<state>/sessions/<targetId>/<name>.json`, Playwright
 * storageState shape), which cookies are kept (the target's own hosts, nothing else), which page
 * storage is kept (only the items the target names in `signIn.localStorage`, on its own origin), what
 * may be SAID about one (counts, names, hosts, expiry - never a value), and whether it still works
 * (the target's `signIn.probe` answered 200 with it).
 *
 * WHY IT EXISTS: Owner, 2026-09-21: "you yourself need to save cookies or something to allow Sue to
 * get past our login door ... I can log in, I can save you cookies so all the Sues can use my
 * account." Example App Next signs in ONLY through Discord, and a Sue can never make a Discord
 * account (no CAPTCHA, no phone, no real identity), so without this no Sue ever sees the dashboard,
 * which is most of the product. `login.mjs` opens a window, the human signs in, and this module keeps
 * only the product's cookie: never the Discord (or any identity provider's) session, so a Sue can
 * reach the product as him and nothing else he is signed in to.
 *
 * Some products keep their sign-in in page storage, not a cookie: Discord's web app holds its token
 * in localStorage (Owner, 2026-09-22: "can we not just log Sue into Discord?"). A target like that
 * names the items (`signIn.localStorage: ["token"]`), the session carries exactly those, and the probe
 * sends one as its `authorization` header (`signIn.authorizationFrom`).
 *
 * A session cookie or storage item is a credential: nothing here prints, logs or returns its VALUE.
 * The file is under the gitignored `state/` dir.
 *
 * WHO DEPENDS ON IT: `login.mjs` (writes), `cannon.mjs` (`--as`, `mustSignUpForReal`, the preflight, a target's
 * `sessionParts`), `body.mjs` (loads the cookies into her context, every part's together through
 * `readSessions`), `tests/sessions.spec.mjs`.
 */
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./run-dir.mjs";

const NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * True when a Sue on this target can make her OWN account the way a person does: the site mails its
 * sign-up code to a Sue address and the mailroom reads that mail (`ses-inbound`). There she always
 * does, and nothing may hand her an account instead - not a session a human saved (`--as`), not an
 * account an earlier Sue made. Owner, Owner, 2026-09-22: "all SUSE should fundamentally, simply, and
 * correctly literally create real accounts ... If SUSE aren't creating real accounts, we have
 * problems. Because that means we aren't actually testing real user data." A lent session stays only
 * for a site whose sign-up we cannot drive (Discord for Example App Next: a human made that account).
 * `cannon.mjs` refuses `--as` there and `login.mjs` / `login-chrome.mjs` refuse to save one. The cannon's `--reuse-accounts` (sign in to an earlier Sue's account while the sign-up door was
 * shut) was deleted for the same ruling the same day.
 */
export function mustSignUpForReal(target) {
  return target?.mailbox?.kind === "ses-inbound";
}

export function sessionFile(targetId, name) {
  if (!NAME.test(String(targetId ?? ""))) throw new Error(`session: target id must be a slug, got ${JSON.stringify(targetId)}`);
  if (!NAME.test(String(name ?? ""))) throw new Error(`session: --as must be a slug like "owner", got ${JSON.stringify(name)}`);
  return path.join(stateRoot(), "sessions", targetId, `${name}.json`);
}

/** The persistent browser profile `login.mjs` signs in with, so the identity provider remembers him next time. */
export function loginProfileDir(targetId, name) {
  return sessionFile(targetId, name).replace(/\.json$/, ".profile");
}

/** The hosts whose cookies a Sue may carry: the start URL's host, and nothing an identity provider owns. */
export function sessionHosts(target) {
  const host = new URL(target.startUrl).hostname;
  return [host];
}

/**
 * The parent domains a target lends on purpose (`signIn.cookieDomains`), each one its start host sits
 * under. For a product whose own login cookie is scoped to the parent: Example App's API sets its
 * session on `.tickettool.xyz`, so its review host keeps nothing of its own and a saved sign-in came
 * back empty. A domain the start host is not under is never lent.
 */
export function lentParentDomains(target) {
  const host = new URL(target.startUrl).hostname;
  return (target?.signIn?.cookieDomains ?? [])
    .map((d) =>
      String(d ?? "")
        .toLowerCase()
        .replace(/^\./, ""),
    )
    .filter((d) => d && (host === d || host.endsWith(`.${d}`)));
}

/** Would a browser send this cookie to `hostname`: its own host, or a parent domain the target lends. */
function cookieReaches(cookie, hostname, target) {
  const domain = String(cookie?.domain ?? "").toLowerCase();
  if (domain === hostname) return true;
  return lentParentDomains(target).some((p) => domain === `.${p}` && (hostname === p || hostname.endsWith(`.${p}`)));
}

/**
 * Keep only cookies set for EXACTLY the target's host. A parent-domain cookie (`.example.net`) is
 * dropped on purpose: the identity provider (`example.net`) could read it, and the point is
 * that a Sue carries the product's session and nothing that signs her into anything else. The one
 * exception is a parent the target names in `signIn.cookieDomains`, and then only cookies scoped to
 * that domain, never one set for a sibling host.
 */
export function keepTargetCookies(cookies = [], target) {
  const hosts = sessionHosts(target);
  const parents = lentParentDomains(target).map((p) => `.${p}`);
  return cookies.filter((c) => {
    const domain = String(c?.domain ?? "").toLowerCase();
    return hosts.includes(domain) || parents.includes(domain);
  });
}

/**
 * The page storage a Sue may carry: of the start URL's origin's items, only those the target names in
 * `signIn.localStorage`. Playwright's storageState `origins` shape, empty when the target names none.
 */
export function keepTargetStorage(items = [], target) {
  const names = Array.isArray(target?.signIn?.localStorage) ? target.signIn.localStorage : [];
  const kept = items.filter((item) => names.includes(item?.name) && typeof item.value === "string" && item.value);
  return kept.length ? [{ origin: new URL(target.startUrl).origin, localStorage: kept.map(({ name, value }) => ({ name, value })) }] : [];
}

/** What may be said about a session: how many cookies and storage items, their names, for which hosts, until when. Never a value. */
export function describeSession(state) {
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const origins = Array.isArray(state?.origins) ? state.origins : [];
  const expiries = cookies.map((c) => Number(c.expires)).filter((n) => Number.isFinite(n) && n > 0);
  const soonest = expiries.length ? new Date(Math.min(...expiries) * 1000).toISOString() : null;
  return {
    cookies: cookies.length,
    hosts: [
      ...new Set([...cookies.map((c) => String(c.domain ?? "").replace(/^\./, "")), ...origins.map((o) => new URL(o.origin).hostname)]),
    ],
    expiresAt: soonest,
    names: cookies.map((c) => c.name),
    storage: origins.flatMap((o) => (o.localStorage ?? []).map((item) => item.name)),
    freeHands: state?.freeHands === true,
  };
}

export function readSession(file) {
  if (!file || !fs.existsSync(file)) return null;
  try {
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(state?.cookies)) return null;
    const origins = Array.isArray(state.origins)
      ? state.origins.filter((o) => typeof o?.origin === "string" && Array.isArray(o.localStorage))
      : [];
    return { cookies: state.cookies, origins, freeHands: state.freeHands === true };
  } catch {
    return null;
  }
}

/**
 * Several saved sessions as the one a Sue carries, for a visit that crosses sites (a target's
 * `sessionParts`: Discord's sign-in beside a product's dashboard). Every part's cookies and page
 * storage, storage for one origin gathered into one entry, and free hands ONLY when every part is a
 * throwaway: one guarded account in the mix keeps every rail on. Each part was captured single-site
 * by `login.mjs`, so the union still carries nothing an identity provider owns.
 */
export function mergeSessions(states = []) {
  const parts = states.filter(Boolean);
  const byOrigin = new Map();
  for (const state of parts) {
    for (const o of state.origins ?? []) {
      if (!byOrigin.has(o.origin)) byOrigin.set(o.origin, []);
      byOrigin.get(o.origin).push(...(o.localStorage ?? []));
    }
  }
  return {
    cookies: parts.flatMap((state) => state.cookies ?? []),
    origins: [...byOrigin].map(([origin, localStorage]) => ({ origin, localStorage })),
    freeHands: parts.length > 0 && parts.every((state) => state.freeHands === true),
  };
}

/** `readSession` for one file or a list of them (`mergeSessions`); null when any one is missing or unreadable. */
export function readSessions(files) {
  const list = Array.isArray(files) ? files : [files];
  if (!list.length) return null;
  const states = list.map((file) => readSession(file));
  if (states.some((state) => !state)) return null;
  return states.length === 1 ? states[0] : mergeSessions(states);
}

/**
 * `freeHands`: the account is a THROWAWAY a human made for Sues, so they may press anything on it
 * (lib/rails.mjs lifts every rail but the one that would sign the shared session out). It is a fact
 * about the account, so it is saved with the account's session, never passed per run: a guarded
 * account can never be driven with free hands by a mistyped flag.
 */
export function writeSession(file, cookies, { freeHands = false, origins = [] } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const state = freeHands ? { cookies, origins, freeHands: true } : { cookies, origins };
  fs.writeFileSync(file, JSON.stringify({ ...keptFields(file, ["cookies", "origins", "freeHands"]), ...state }, null, 2) + "\n", {
    mode: 0o600,
  });
}

/**
 * The fields of the JSON object in `file` that a writer about to replace it does not decide (`decided`),
 * so a field a newer Sue wrote survives an older one's save: an older snapshot of this code still runs a
 * wave after the checkout moves on (lib/engine-store.mjs). {} when there is no file or no object in it.
 */
export function keptFields(file, decided) {
  let prior;
  try {
    prior = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!prior || typeof prior !== "object" || Array.isArray(prior)) return {};
  return Object.fromEntries(Object.entries(prior).filter(([key]) => !decided.includes(key)));
}

/**
 * True when every cookie is still inside its expiry (session cookies, expires -1, never expire here).
 * A session held only in page storage has no expiry to read, so only its probe can say it has ended.
 */
export function sessionUnexpired(state, now = Date.now()) {
  if (!state?.cookies?.length) return Boolean(state?.origins?.some((o) => o.localStorage?.length));
  return state.cookies.every((c) => !(Number(c.expires) > 0) || Number(c.expires) * 1000 > now);
}

/**
 * Did the probe say "signed in"? A 200 alone is not enough: Example App Next's `/api/auth/me`
 * answers 200 `{ authenticated: false }` to a stranger, so a target names the JSON field that must
 * be true (`signIn.signedInField`, e.g. "authenticated"). Without a field, 200 is the answer.
 */
export function probeSaysSignedIn(target, status, bodyText) {
  if (status !== 200) return false;
  const field = target?.signIn?.signedInField;
  if (!field) return true;
  try {
    return (
      String(field)
        .split(".")
        .reduce((v, k) => (v == null ? v : v[k]), JSON.parse(String(bodyText))) === true
    );
  } catch {
    return false;
  }
}

/** A saved storage item as the product's own code reads it back: Discord keeps its token JSON-quoted. */
function storedValue(state, origin, name) {
  const raw = (state?.origins ?? []).find((o) => o.origin === origin)?.localStorage?.find((item) => item.name === name)?.value;
  if (typeof raw !== "string" || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : raw;
  } catch {
    return raw; // not JSON: the product stores it bare
  }
}

/**
 * Which account the probe answered for (`signIn.accountField`, e.g. "username"), so the human who
 * saved a session sees whose it is. An account name, never a credential; null when not named.
 */
export function probeAccount(target, bodyText) {
  const field = target?.signIn?.accountField;
  if (!field) return null;
  try {
    const value = String(field)
      .split(".")
      .reduce((v, k) => (v == null ? v : v[k]), JSON.parse(String(bodyText)));
    return typeof value === "string" && value ? value : null;
  } catch {
    return null;
  }
}

/**
 * Does the saved session still sign the product in? One GET of `target.signIn.probe` with the
 * cookies (and the `signIn.authorizationFrom` storage item as `authorization`, to the product's own
 * origin only), from node, no browser. Resolves `{ ok, status, account }`; no credential leaves this
 * function.
 */
export async function probeSession(target, state, { fetchImpl = globalThis.fetch } = {}) {
  const probe = target?.signIn?.probe;
  if (!probe) return { ok: sessionUnexpired(state), status: null, account: null };
  const url = new URL(probe, target.startUrl);
  const cookie = (state?.cookies ?? [])
    .filter((c) => cookieReaches(c, url.hostname, target))
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const headers = cookie ? { cookie } : {};
  // Sent the way the product's own page sends it. A relay that refuses a request carrying a session
  // but no sign of the page it came from (Example App's server/proxy.mjs) answered this probe 403.
  const own = new URL(target.startUrl);
  if (cookie && url.origin === own.origin) {
    headers.origin = own.origin;
    headers.referer = own.href;
  }
  const from = target?.signIn?.authorizationFrom;
  const authorization = from && url.origin === new URL(target.startUrl).origin ? storedValue(state, url.origin, from) : null;
  if (authorization) headers.authorization = authorization;
  try {
    const res = await fetchImpl(url, { headers, redirect: "manual" });
    const text = await res.text().catch(() => "");
    const ok = probeSaysSignedIn(target, res.status, text);
    return { ok, status: res.status, account: ok ? probeAccount(target, text) : null };
  } catch (err) {
    return { ok: false, status: null, error: String(err?.message ?? err).slice(0, 200) };
  }
}
