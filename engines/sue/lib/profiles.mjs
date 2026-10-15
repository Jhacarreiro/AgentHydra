/**
 * profiles - saved logins a Sue can arrive with, on any site a human signs in to once.
 * =====================================================================================
 *
 * Owner ask (Owner, 2026-09-23): "make it so sue can save separate profiles eg, if I need to login to
 * lets say discord for app testing using sue ... we can save login cookies and such." A profile is a
 * NAME and a SITE ("discord-owner", https://discord.com/login): the human signs in once in his own
 * Chrome from the Sue Manager's Logins tab (`login-chrome.mjs --profile`), and any wave that names the
 * profile (`sue run { profile }`, the cannon's `--profile`) starts every Sue signed in to that site.
 *
 * It is the general form of the per-target sessions in lib/sessions.mjs, which stay for a target that
 * can PROVE a session (its `signIn.probe`, Example App Next's `--as`). A profile has no probe, so it is
 * proven only by its cookies' expiry and by the person who made it. Same file shape (Playwright
 * storageState), so the body loads either through `readSessions`.
 *
 * What is kept: the site's own cookies (its domain and subdomains, never an identity provider's on
 * another domain) and the page storage of its pages (Discord keeps its sign-in token there). Nothing
 * here prints, logs or returns a cookie or storage VALUE; the files are under the gitignored `state/`.
 *
 * The rails: a profile is never used on one of Connections' own sites (every Sue there makes her own
 * real account, `onConnectionsSite` in lib/site-owner.mjs), and it is guarded unless it was saved as a
 * throwaway (`freeHands`): on a real account a Sue looks and tries but never commits.
 */
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./run-dir.mjs";
import { describeSession, keptFields, readSession } from "./sessions.mjs";
import { registrableDomain } from "./workspace.mjs";

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export const profilesDir = () => path.join(stateRoot(), "profiles");

export function assertProfileName(name) {
  const value = String(name ?? "").trim();
  if (!NAME.test(value)) throw new Error(`a profile name is a short slug like "discord-owner", got ${JSON.stringify(name)}`);
  return value;
}

export function profileFile(name) {
  return path.join(profilesDir(), `${assertProfileName(name)}.json`);
}

/** The Chrome profile it signs in with, so signing in again is usually one click. */
export function profileChromeDir(name) {
  return path.join(profilesDir(), `${assertProfileName(name)}.chrome`);
}

/** The site a profile is for: `{ url, origin, host, domain }`. Refuses anything but an http(s) address. */
export function profileSite(raw) {
  let url;
  try {
    url = new URL(String(raw ?? "").trim());
  } catch {
    throw new Error(`site must be a web address like https://discord.com/login, got ${JSON.stringify(raw)}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("site must be an http or https address");
  // The domain its sign-in lives under: "discord.com" for "www.discord.com".
  return { url: url.href, origin: url.origin, host: url.hostname, domain: registrableDomain(url.hostname) };
}

/** True when `hostname` is the site's domain or under it. */
export function onSite(hostname, site) {
  const host = String(hostname ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  return host === site.domain || host.endsWith(`.${site.domain}`);
}

/** The site's own cookies: set for its domain or a subdomain. An identity provider elsewhere is dropped. */
export function keepSiteCookies(cookies = [], site) {
  return cookies.filter((c) => onSite(c.domain, site));
}

/** Save a profile. `origins` is Playwright's storageState shape; only origins on the site are kept. */
export function saveProfile(name, { site, cookies = [], origins = [], freeHands = false, now = new Date() }) {
  const file = profileFile(name);
  const where = profileSite(site);
  const state = {
    site: where.url,
    savedAt: now.toISOString(),
    cookies: keepSiteCookies(cookies, where),
    origins: origins.filter((o) => {
      try {
        return onSite(new URL(o.origin).hostname, where) && Array.isArray(o.localStorage) && o.localStorage.length > 0;
      } catch {
        return false;
      }
    }),
  };
  if (freeHands) state.freeHands = true;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Whole or not at all: a wave reading it mid-write never sees half a sign-in. A field only a newer Sue
  // writes is kept (lib/sessions.mjs keptFields).
  const kept = keptFields(file, ["site", "savedAt", "cookies", "origins", "freeHands"]);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ ...kept, ...state }, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return describeProfile(name, state);
}

/**
 * What may be said about a profile: its site, when it was saved, counts and hosts. Never a value.
 * `lastsUntil` is the LATEST cookie expiry and `expired` means nothing in it is alive any more: a
 * site's half-hour bot cookie (Cloudflare's `__cf_bm` on Discord) runs out long before its sign-in
 * does, so the soonest expiry, the right test for a probed session, would call every profile dead.
 */
export function describeProfile(name, state, now = Date.now()) {
  const d = describeSession(state);
  const cookies = Array.isArray(state?.cookies) ? state.cookies : [];
  const expiries = cookies.map((c) => Number(c.expires)).filter((n) => Number.isFinite(n) && n > 0);
  const alive = cookies.filter((c) => !(Number(c.expires) > 0) || Number(c.expires) * 1000 > now).length;
  return {
    name,
    site: typeof state?.site === "string" ? state.site : null,
    savedAt: typeof state?.savedAt === "string" ? state.savedAt : null,
    cookies: d.cookies,
    storage: d.storage.length,
    hosts: d.hosts,
    lastsUntil: expiries.length ? new Date(Math.max(...expiries) * 1000).toISOString() : null,
    expired: alive === 0 && d.storage.length === 0,
    freeHands: d.freeHands,
  };
}

/** One profile as the body loads it, or null when there is none by that name. */
export function readProfile(name) {
  const file = profileFile(name);
  const saved = readSession(file);
  if (!saved) return null;
  let site = null;
  let savedAt = null;
  try {
    ({ site = null, savedAt = null } = JSON.parse(fs.readFileSync(file, "utf8")));
  } catch {
    // readSession already read it whole; a race with a re-save leaves the meta for the next read
  }
  return { file, state: { ...saved, site, savedAt } };
}

/** Every saved profile on this computer, described (never a value), by name. */
export function listProfiles(now = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(profilesDir());
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".json") && NAME.test(n.slice(0, -5)))
    .map((n) => n.slice(0, -5))
    .map((name) => {
      const read = readProfile(name);
      return read ? describeProfile(name, read.state, now) : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Forget a profile: its saved sign-in and the Chrome profile it was made in. False when there was none. */
export function forgetProfile(name) {
  const file = profileFile(name);
  const had = fs.existsSync(file);
  fs.rmSync(file, { force: true });
  fs.rmSync(profileChromeDir(name), { recursive: true, force: true });
  return had;
}
