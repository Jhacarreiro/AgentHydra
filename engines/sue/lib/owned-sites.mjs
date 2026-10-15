/**
 * owned-sites - the websites a Connections workspace says are its own, read ONCE per run by the planner, never by a Sue.
 * ======================================================================================================================
 *
 * WHY: Owner, 2026-10-02: "the person adds a list and says these are mine and Sues treat those as his ... if they're
 * uncertain, they can check the list". A page on one of these sites, or under one, gets the owners' rules (lib/site-owner.mjs
 * `isOwnedSite`: Sues make accounts and write to support); anything else stays somebody else's live site, where no Sue
 * makes an account, contacts anyone or presses Send.
 *
 * WHAT THE LIST IS: the union of three reads, each made on its own through the member's local MCP, for the company the
 * run's folder is bound to (connections_whoami):
 *   - the Companies plane's websites (`companies_list_my_sites`): the workspace's own domain, its verified custom
 *     domains, and every site a member declared (`companies_add_my_site`);
 *   - its own email domains that are verified (`email_action` `domains.list`; one another workspace shared is not its own);
 *   - every cookie banner's domains (`legal_consent_sites_list`).
 * A read that fails or refuses is skipped and NAMED in the run's answer (`ownedSitesNote`), never silently; a door that
 * will not open leaves today's rules (local and Connections hosts, and the page's own target) and says so. The list
 * never holds a run up.
 *
 * `owned: true` on a run is the human saying the site is theirs, so a host that is not on the list yet is added to it
 * (`companies_add_my_site`) once the run is planned, and the answer says `registeredSite`. `owned: false` removes nothing.
 *
 * THE DOOR: `{ whoami(), api(service, tool, body, routing) }`, each answering like dredd/lib/mcp.mjs (`{ ok, text }`
 * and `{ ok, status, body, text }`); `routing` carries a path parameter (`company_id`). Specs hand in a fake one.
 */
import { openPeopleDoor, wordsOf } from "./people.mjs";
import { bareHost, hostOfUrl, isOwnedSite, onListedSite } from "./site-owner.mjs";

/** How long one read may take: the run waits on it, and a slow source is skipped and named rather than waited out. */
const SOURCE_TIMEOUT_MS = 15_000;

/** Why every source is skipped when the folder names no company. */
const NO_WORKSPACE = "this folder is bound to no Connections workspace (connections_whoami: company null)";

/** The three reads, each with what it is called in the answer, and how its hosts come out of its body (null = unreadable). */
const SOURCES = [
  {
    label: "website list",
    service: "companies",
    tool: "companies_list_my_sites",
    body: () => ({}),
    routing: (companyId) => ({ company_id: companyId }),
    hosts: (body) => (Array.isArray(body?.sites) ? body.sites.map((site) => site?.hostname) : null),
  },
  {
    label: "email domains",
    service: "email",
    tool: "email_action",
    body: (companyId) => ({ action: "domains.list", companyId }),
    routing: () => null,
    hosts: (body) =>
      Array.isArray(body) ? body.filter((d) => !d?.sharedFrom && d?.verificationStatus === "verified").map((d) => d.domain) : null,
  },
  {
    label: "cookie banner sites",
    service: "legal",
    tool: "legal_consent_sites_list",
    body: (companyId) => ({ companyId }),
    routing: () => null,
    hosts: (body) => (Array.isArray(body?.sites) ? body.sites.flatMap((site) => (Array.isArray(site?.domains) ? site.domains : [])) : null),
  },
];

const said = (err) => String(err?.message ?? err).slice(0, 300);

/** `hosts` as bare lower-case hosts, each once, sorted; anything that names no host is dropped. */
function hostsOf(hosts) {
  return [...new Set(hosts.map(bareHost).filter(Boolean))].sort();
}

/** The company a connections_whoami answer names, or null (not signed in, unbound, or no answer). */
function companyIdOf(answer) {
  if (!answer?.ok) return null;
  const text = String(answer.text ?? "");
  try {
    const id = JSON.parse(text)?.company?.companyId;
    return typeof id === "string" && id ? id : null;
  } catch {
    // An answer with a notice after its JSON: the company is still read off it.
    return /"company":\s*\{\s*"companyId":\s*"([^"]+)"/.exec(text)?.[1] ?? null;
  }
}

/** A local MCP (dredd/lib/mcp.mjs `openLocalMcp`) as this module's door. */
export function ownedSitesDoorOf(mcp) {
  return {
    whoami: () => mcp.call("connections_whoami", {}, SOURCE_TIMEOUT_MS),
    api: (service, tool, body, routing) => mcp.api(service, tool, body, SOURCE_TIMEOUT_MS, null, routing),
  };
}

/** A door through a local MCP bound to `root`, opened the way the people's door is (lib/people.mjs). `{ door, close }`. */
export async function openOwnedSitesDoor({ root }) {
  const opened = await openPeopleDoor({ root });
  return { door: ownedSitesDoorOf(opened.mcp), close: opened.close };
}

/**
 * The workspace's own websites: `{ companyId, hosts, skipped: [{ source, why }] }`, hosts bare, each once, sorted. Every
 * source is read on its own; one that fails, refuses or answers something unreadable is in `skipped`. Never throws.
 */
export async function fetchOwnedSites(door) {
  let companyId = null;
  let why = NO_WORKSPACE;
  try {
    const who = await door.whoami();
    companyId = companyIdOf(who);
    if (!who?.ok) why = `connections_whoami did not answer: ${wordsOf(who)}`;
  } catch (err) {
    why = `connections_whoami did not answer: ${said(err)}`;
  }
  if (!companyId) return { companyId: null, hosts: [], skipped: SOURCES.map((source) => ({ source: source.label, why })) };
  const read = await Promise.all(
    SOURCES.map(async (source) => {
      try {
        const answer = await door.api(source.service, source.tool, source.body(companyId), source.routing(companyId));
        const hosts = answer?.ok && answer.body?.refused !== true ? source.hosts(answer.body) : null;
        if (!hosts) return { skipped: { source: source.label, why: wordsOf(answer) } };
        return { hosts };
      } catch (err) {
        return { skipped: { source: source.label, why: said(err) } };
      }
    }),
  );
  return { companyId, hosts: hostsOf(read.flatMap((r) => r.hosts ?? [])), skipped: read.map((r) => r.skipped).filter(Boolean) };
}

/** The note a run's answer carries for each source of the list that was skipped (`skipped` from fetchOwnedSites). */
export function skippedNote(skipped) {
  return `This workspace's websites were read without its ${skipped.map((s) => `${s.source} (${s.why})`).join(" or its ")}, so a site named only there counts as somebody else's this run.`;
}

/**
 * The host a run's list read matters for, or null when the list cannot change whose site it is: a roster errand (its
 * target keeps its own rules), no web address, a local or Connections host (always the owners'), `owned: false` (the
 * run's own word wins), or a login a human lent (`profile`, `as`: the borrowed rails, whoever's site) unless the run
 * says `owned: true`, which still puts the host on the list.
 */
function hostToRead(args) {
  if (!args || args.target || args.scenario) return null;
  const host = hostOfUrl(args.url);
  if (!host || isOwnedSite(args.url)) return null;
  if (args.owned === false) return null;
  if ((args.profile || args.as) && args.owned !== true) return null;
  return host;
}

/**
 * Ready a run's websites before it is planned: `args.ownedSites` when a caller handed them over (a list of hostnames),
 * else read here through a door opened for `root` (or `reuse`, a door this process already holds). Answers
 * `{ args, settle(answer), close() }`: `args` carry `ownedSites` for sue.mjs planRun; `settle` adds the host of an
 * `owned: true` run to the list once the run was planned (`answer.ok`) and puts `registeredSite` and `ownedSitesNote` on
 * the answer; `close` closes a door this opened. Never throws, and never holds the run up.
 */
export async function ownedSitesForRun(args, { root, openDoor = openOwnedSitesDoor, reuse = null } = {}) {
  const host = hostToRead(args);
  const handed = Array.isArray(args?.ownedSites) ? hostsOf(args.ownedSites) : null;
  const notes = [];
  let hosts = handed ?? [];
  let companyId = null;
  let door = reuse;
  let close = async () => {};
  let unopened = null;
  // Opened at most once, and only when the list or an add needs it.
  const doorNow = async () => {
    if (door || unopened) return door;
    try {
      const opened = await openDoor({ root });
      door = opened.door;
      close = opened.close;
    } catch (err) {
      unopened = said(err);
    }
    return door;
  };
  if (host && !handed) {
    if (await doorNow()) {
      const read = await fetchOwnedSites(door);
      hosts = read.hosts;
      companyId = read.companyId;
      if (read.skipped.length) notes.push(skippedNote(read.skipped));
    } else
      notes.push(
        `This workspace's websites could not be read (${unopened}), so only local and Connections sites, and a page whose target says owned, count as yours this run.`,
      );
  }
  const addSite = async (hostname) => {
    if (!(await doorNow())) return { why: unopened };
    try {
      companyId ??= companyIdOf(await door.whoami());
      if (!companyId) return { why: NO_WORKSPACE };
      const answer = await door.api("companies", "companies_add_my_site", { hostname }, { company_id: companyId });
      if (!answer?.ok || answer.body?.refused === true) return { why: wordsOf(answer) };
      return { added: answer.body?.added === true };
    } catch (err) {
      return { why: said(err) };
    }
  };
  async function settle(answer) {
    if (!answer || typeof answer !== "object") return answer;
    if (host && answer.ok === true && args.owned === true && !onListedSite(args.url, hosts)) {
      const added = await addSite(host);
      if (added.added) answer.registeredSite = host;
      else if (added.why)
        notes.push(`${host} was not added to this workspace's websites (${added.why}), so a later run needs owned: true again.`);
    }
    if (notes.length) answer.ownedSitesNote = notes.join(" ");
    return answer;
  }
  return { args: host || handed ? { ...args, ownedSites: hosts } : args, settle, close: () => close() };
}
