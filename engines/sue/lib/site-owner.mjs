/**
 * Whose website a Sue is sent to: the owners' own, or somebody else's live one.
 *
 * On the owners' own sites (a local dev server, any Connections host, a page whose target file says
 * `owned: true`, a site on the workspace's own websites list, lib/owned-sites.mjs) a Sue is told it is
 * a development website: she makes accounts and, when annoyed, writes to support, because that is
 * what those sites are for (Owner, 2026-09-25; the list, 2026-10-02).
 *
 * Anywhere else a sent form reaches a real person. A hearing on sullivanfantastic.com, a performer's
 * live booking site whose form emails him, told every Sue it was a development website and to
 * "actually send them a message"; the operator had to add "do not press Send" to every seat by hand
 * (docket 20260925-185147-ed76). On such a site she makes no account, contacts nobody, and her hands
 * refuse any press that would send a form (lib/rails.mjs `liveSite`), while she still judges
 * everything up to the Send button.
 */

import { isPublicSuffix } from "../../lib/shared/public-suffix.mjs";

/**
 * Connections' own apexes, the same three as infra/shared/first-party-origin.ts FIRST_PARTY_APEX_HOSTS
 * (tests/site-owner.spec.mjs holds them equal). Not imported from there: every Sue body is a plain node
 * process, and a .ts import would break all of them on a node without type stripping.
 */
export const CONNECTIONS_FAMILY = ["example.com", "example.org", "api.example.com"];

/** A local development host: localhost, a loopback address, or a name under .localhost or .test. */
const LOCAL_HOST = /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1)$|\.(localhost|test)$/;

/**
 * Two-label public suffixes and shared hosting names (`co.uk`, `github.io`, `vercel.app`): a name under one is somebody's
 * own site, never a sibling of every other name under it. The one list every caller reads, the companies plane's
 * "my websites" refusal included; lib/workspace.mjs `registrableDomain` reads the two-label half.
 */
export { TWO_LABEL_PUBLIC_SUFFIXES as TWO_LABEL_SUFFIXES } from "../../lib/shared/public-suffix.mjs";

/** The lower-cased host of `url`, or null when it is not a web address. */
export function hostOfUrl(url) {
  try {
    const u = new URL(String(url ?? ""));
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/\.$/, "") : null;
  } catch {
    return null;
  }
}

/**
 * True for a page on one of Connections' own sites. Every Sue there makes her own real account through
 * the public sign-up (Owner, 2026-09-22), so a saved login (lib/profiles.mjs) is never used on one; on
 * anybody else's site a saved login is what he asked for (2026-09-23, Discord for app testing).
 */
export function onConnectionsSite(url) {
  const host = hostOfUrl(url);
  return Boolean(host) && CONNECTIONS_FAMILY.some((apex) => host === apex || host.endsWith(`.${apex}`));
}

/**
 * A website's name as people write it ("https://www.Foo.com/path", "foo.com:443", "foo.com.", "*.foo.com") as the
 * bare lower-case host, or null when it names none.
 */
export function bareHost(raw) {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/^\*\./, "");
  if (!name) return null;
  return hostOfUrl(/^[a-z][a-z0-9+.-]*:\/\//i.test(name) ? name : `https://${name}`);
}

/**
 * True when `url`'s host is one of `hosts` (a workspace's own websites, lib/owned-sites.mjs) or under one of them. An
 * entry that is a top-level name ("com") or a public suffix ("co.uk", "vercel.app", or "*.vercel.app", read as
 * "vercel.app") names no website of anyone's, and would hand every stranger's site under it the owners' rules, so it
 * counts for nothing.
 */
export function onListedSite(url, hosts = []) {
  const host = hostOfUrl(url);
  if (!host || !Array.isArray(hosts)) return false;
  return hosts.map(bareHost).some((listed) => listed && !isPublicSuffix(listed) && (host === listed || host.endsWith(`.${listed}`)));
}

/**
 * Is `url` one of the owners' own websites? The target's own `owned` (true or false, written by hand
 * or by a run's `owned` argument) decides first; then yes for a host on this workspace's own websites
 * or under one (`ownedHosts`, read once per run by the planner, lib/owned-sites.mjs); else yes for a
 * local development host and for any Connections host. Everything else, an address that cannot be
 * read included, is somebody else's.
 */
export function isOwnedSite(url, target = null, ownedHosts = []) {
  if (typeof target?.owned === "boolean") return target.owned;
  const host = hostOfUrl(url);
  if (!host) return false;
  return onListedSite(url, ownedHosts) || LOCAL_HOST.test(host) || onConnectionsSite(url);
}

/**
 * Does this target carry the live-site rules? Decided ONCE, by a link run's planner (sue.mjs planRun
 * writes `liveSite` on the page's target): somebody else's site, visited by anonymous Sues. A
 * hand-written target is the owners' own setup for their product and keeps its own rules unless it
 * says `liveSite: true` itself; a run on a login a human lent (`profile`, `as`) is theirs to act in,
 * under the borrowed rails (Discord bot testing, 2026-09-23).
 */
export function isLiveSite(target) {
  return target?.liveSite === true;
}
