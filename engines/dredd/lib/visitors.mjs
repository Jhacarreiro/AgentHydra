// dredd/lib/visitors.mjs - who SUE sends: the visitors cast for this docket from the ask and the page.
//
// A hearing on sullivanfantastic.com ("I'm a party planner looking for a live performer for a client's bar mitzvah")
// sent this workspace's saved Deal Flow people - Robert, a Tampa real-estate broker from a WhatsApp deal group, and Tasha,
// a house wholesaler - with the party planner's words pasted under "Why you are here" (docket 20260925-185147-ed76).
// So the docket casts the visitors itself: on somebody else's website, or whenever the ask says who the visitor is, it
// reads the page (title, description, headings, first words), asks the HSwarm brain for the people who really come to
// it (sue/lib/cast.mjs castPrompt), and carries them to SUE in her args file (lib/convene.mjs writeSueArgs). With
// no model answer the floor is the visitor the ask names, in its own words (castFromAsk); with neither, the docket says
// so and SUE picks as she always has. The cast is on the docket before anything convenes, so a docket-only run shows it.
import { lookup as dnsLookup } from "node:dns";
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";

import { askBrain, askBrainHedged } from "./brain.mjs";
import { sueIntentOf } from "./convene.mjs";
import { askJev } from "./jev.mjs";
import {
  CAST_MAX,
  CAST_SCHEMA,
  castFromAnswer,
  castFromAsk,
  castPrompt,
  childrenInAsk,
  rosterChildren,
  visitorFromAsk,
} from "../../sue/lib/cast.mjs";
import { fetchPeopleList } from "../../sue/lib/people.mjs";
import { installPeople } from "../../sue/lib/personas.mjs";
import { PRESUE_NEED, runPresue, saveOnboarded } from "../../sue/lib/presue.mjs";
import { isOwnedSite } from "../../sue/lib/site-owner.mjs";

/** An instrument that sends SUE's visitors: SUE herself, and her focus group (lib/convene.mjs launchesSue). */
const SUE_FAMILY = ["sue", "focus-group"];

/** Does this docket send visitors, and does their cast have to come from the ask and the page? */
export function castWanted(docket, ownedHosts = []) {
  if (!docket?.url || !(docket.convene || []).some((c) => SUE_FAMILY.includes(c.id))) return null;
  const named = visitorFromAsk(docket.ask);
  const owned = isOwnedSite(docket.url, null, ownedHosts);
  const children = childrenInAsk(docket.ask);
  if (owned && !named && !children) return null;
  return { named, owned, children };
}

const decode = (s) =>
  String(s ?? "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCharCode(Number(n)));
const words = (html) =>
  decode(String(html ?? "").replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();

/** A meta tag's content by name or property, whichever order its attributes come in. */
function metaContent(html, key) {
  for (const tag of html.match(/<meta\b[^>]*>/gi) || []) {
    if (!new RegExp(`(?:name|property)\\s*=\\s*["']${key}["']`, "i").test(tag)) continue;
    const m = /content\s*=\s*(["'])([\s\S]*?)\1/i.exec(tag);
    if (m) return words(m[2]);
  }
  return "";
}

/** What a first look at the page says, as text: its title, description, headings and first words. Null when unreadable. */
export function pageSummary(html) {
  const doc = String(html ?? "");
  if (!doc.trim()) return null;
  const body = doc.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ").replace(/<!--[\s\S]*?-->/g, " ");
  const headings = [...body.matchAll(/<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/gi)]
    .map((m) => words(m[1]))
    .filter(Boolean)
    .slice(0, 12);
  return {
    title: words(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(doc)?.[1] ?? ""),
    description: metaContent(doc, "description") || metaContent(doc, "og:description"),
    headings,
    text: words(/<body\b[^>]*>([\s\S]*)/i.exec(body)?.[1] ?? body).slice(0, 1500),
  };
}

/**
 * A loopback, private, link-local or carrier-grade NAT address: nowhere a public page may send the reader. An IPv4
 * address carried inside IPv6 (mapped `::ffff:`, or NAT64 `64:ff9b::`) is judged as the IPv4 it carries, dotted or as
 * the two hex groups the URL parser rewrites it to (`[::ffff:127.0.0.1]` becomes `[::ffff:7f00:1]`).
 */
export function isInternalAddress(ip) {
  let a = String(ip)
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  const carried = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(a);
  if (carried) {
    const [hi, lo] = [parseInt(carried[1], 16), parseInt(carried[2], 16)];
    a = `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  } else a = a.replace(/^(?:::ffff:|64:ff9b::)(?=\d+\.\d+\.\d+\.\d+$)/, "");
  if (a === "::1" || a === "::" || /^f[cd]/.test(a) || /^fe[89ab]/.test(a)) return true;
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(a);
  if (!v4) return false;
  const [x, y] = [Number(v4[1]), Number(v4[2])];
  return (
    x === 0 ||
    x === 10 ||
    x === 127 ||
    (x === 169 && y === 254) ||
    (x === 172 && y >= 16 && y <= 31) ||
    (x === 192 && y === 168) ||
    (x === 100 && y >= 64 && y <= 127)
  );
}

/** Every address a host answers on is public. A host that does not resolve is refused too. */
async function publicHost(host) {
  const bare = host.replace(/^\[|\]$/g, "");
  const addrs = isIP(bare) ? [{ address: bare }] : await lookup(bare, { all: true }).catch(() => []);
  return addrs.length > 0 && !addrs.some((r) => isInternalAddress(r.address));
}

/**
 * A dns.lookup for the socket itself that refuses an internal answer, so a host cannot resolve public for the hop
 * check and private for the connection that follows it (DNS rebinding). An IP literal never reaches a lookup, which is
 * why each hop is also checked by `publicHost` first.
 */
function publicOnlyLookup(hostname, options, callback) {
  dnsLookup(hostname, { ...options, all: true }, (err, addrs) => {
    if (err) return callback(err);
    const inside = addrs.find((r) => isInternalAddress(r.address));
    if (inside) return callback(new Error(`${hostname} resolves to ${inside.address}, which is not a public address`));
    if (options?.all) return callback(null, addrs);
    return callback(null, addrs[0].address, addrs[0].family);
  });
}

/** Ceiling on what a page read keeps: its words are summarised, never stored whole. */
const PAGE_MAX_BYTES = 2_000_000;

/** One GET, no redirect followed: `{ status, location, body }`. `guard` puts publicOnlyLookup on the socket. */
function getOnce(url, { signal, guard }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const request = (u.protocol === "https:" ? https : http).get(
      u,
      {
        signal,
        headers: {
          accept: "text/html,application/xhtml+xml",
          "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36",
        },
        ...(guard ? { lookup: publicOnlyLookup } : {}),
      },
      (res) => {
        const chunks = [];
        let size = 0;
        const done = () =>
          resolve({ status: res.statusCode, location: res.headers.location ?? null, body: Buffer.concat(chunks).toString("utf8") });
        res.on("data", (chunk) => {
          chunks.push(chunk);
          size += chunk.length;
          if (size >= PAGE_MAX_BYTES) {
            done();
            res.destroy();
          }
        });
        res.on("end", done);
        res.on("error", reject);
      },
    );
    request.on("error", reject);
  });
}

/**
 * The page as a first-time browser gets it, summarised; `{ error }` when it cannot be read in time. Redirects are
 * followed by hand, at most five: the docket's own address is the operator's choice, but every hop after it is chosen
 * by the remote page, so a hop onto this machine or a private network is refused, at the hop and again at the socket
 * (its words would otherwise go into a model prompt). A docket that names a local page may stay on local pages.
 */
export async function readPage(url, { timeoutMs = 10_000 } = {}) {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const startsLocal = !(await publicHost(new URL(url).hostname));
    let at = url;
    let res;
    for (let hop = 0; ; hop++) {
      res = await getOnce(at, { signal, guard: !startsLocal });
      const next = res.status >= 300 && res.status < 400 ? res.location : null;
      if (!next) break;
      if (hop >= 5) return { error: "more than five redirects" };
      const to = new URL(next, at);
      if (!/^https?:$/.test(to.protocol)) return { error: `redirected to a ${to.protocol} address` };
      if (!startsLocal && !(await publicHost(to.hostname))) return { error: `redirected to ${to.hostname}, which is not a public address` };
      at = to.href;
    }
    if (res.status < 200 || res.status >= 300) return { error: `HTTP ${res.status}` };
    const page = pageSummary(res.body);
    return page && (page.title || page.text) ? page : { error: "no readable words on the page" };
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 160) };
  }
}

/**
 * The docket's `cast`: `{ visitors, source, why, page, model?, refused?, error? }`, or null when this docket sends no
 * visitors or the page is the owners' own and the ask names nobody (SUE's own picking stands). `source` is "model"
 * (the HSwarm brain's cast, checked), "ask" (the visitor the ask names, no model) or "none" (neither: SUE picks).
 */
export async function castForDocket(docket, { docketDir = null, count = CAST_MAX, ownedHosts = [] } = {}) {
  const wanted = castWanted(docket, ownedHosts);
  if (!wanted) return null;
  // Kids go as themselves: a cast visitor is never a child, so no model is asked and no page is read (sue/lib/cast.mjs).
  if (wanted.children) {
    const children = rosterChildren().map((b) => b.id);
    const why = "the ask says the visitors are children, and SUE's roster sends its own children as themselves";
    return children.length
      ? { visitors: [], children, source: "roster", why }
      : { visitors: [], source: "none", why, error: "SUE's roster holds no child" };
  }
  const why = wanted.owned
    ? `the ask says who the visitor is (${wanted.named})`
    : `${new URL(docket.url).hostname} is not one of the owners' websites${wanted.named ? `, and the ask says who the visitor is (${wanted.named})` : ""}`;
  const read1 = await readPage(docket.url);
  const page = read1?.error ? null : read1;
  const { system, prompt } = castPrompt({ ask: docket.ask, url: docket.url, page, count });
  const res = await askBrain(
    { system, prompt, schema: CAST_SCHEMA, timeoutS: 90, profile: "routine" },
    docketDir ? `${docketDir}/cast-calls.jsonl` : null,
  );
  const pageNote = page ? { title: page.title, description: page.description } : { error: read1?.error ?? "not read" };
  const answered = res?.status === "ok" && res.data ? castFromAnswer(res.data, { url: docket.url }) : null;
  if (answered?.visitors.length)
    return {
      visitors: answered.visitors,
      source: "model",
      model: res.model ?? null,
      why,
      page: pageNote,
      ...(answered.refused.length ? { refused: answered.refused } : {}),
    };
  const error = answered
    ? `every visitor the model cast was refused: ${answered.refused.map((r) => `${r.id} (${r.why})`).join("; ")}`
    : res?.error || `no answer (${res?.status ?? "?"})`;
  const floor = castFromAsk(docket.ask, { url: docket.url, count });
  if (floor?.length) return { visitors: floor, source: "ask", why, page: pageNote, error };
  return { visitors: [], source: "none", why, page: pageNote, error };
}

/**
 * Does this docket pre-sue (the Chair, 2026-10-05: "Sue/Dredd need a Jev. Pre-sue")? Every docket that sends SUE's visitors
 * to a page, owned or not, except a kids ask: the roster's own children go as themselves (castForDocket).
 */
export function presueWanted(docket) {
  if (!docket?.url || !(docket.convene || []).some((c) => SUE_FAMILY.includes(c.id))) return false;
  return !childrenInAsk(docket.ask);
}

/**
 * The docket's cast from pre-sue (sue/lib/presue.mjs): Jev asks which of SUE's saved people really visit this page, the
 * brain drafts the kinds still missing, and the drafts Jev keeps are saved to this workspace through the hearing's MCP, so
 * the next hearing on the page sends the same people. `{ visitors, personas, source: "presue", ... }`: `personas` is who
 * goes, by name and strongest first (at most a cast's size, so a hearing sends as many as before); `visitors` the
 * onboarded, whole, riding inline. Null when it cannot run (no MCP, no answer): the caller falls back to castForDocket.
 */
export async function presueForDocket(docket, { mcp, docketDir = null, presue = runPresue, save = saveOnboarded } = {}) {
  if (!mcp) return null;
  let report;
  try {
    report = await presue({
      url: docket.url,
      intent: sueIntentOf(docket),
      expect: typeof docket.expect === "string" ? docket.expect : null,
      jev: (items) => askJev(items, { escalate: 0, timeoutMs: 30_000 }),
      brain: (spec) => askBrainHedged(spec, docketDir ? `${docketDir}/cast-calls.jsonl` : null),
      readPage,
    });
  } catch (err) {
    return { error: String(err?.message ?? err).slice(0, 300) };
  }
  // Nobody fit and nobody was drafted: an empty cast would send the workspace's saved people, so the docket casts instead.
  if (!report.send.length) return { error: `pre-sue sent nobody: ${report.said}`.slice(0, 300) };
  const inConnections = report.onboarded.length ? await save((tool, body) => mcp.api("boardroom", tool, body), report.onboarded) : [];
  return {
    visitors: report.onboarded,
    personas: report.send.slice(0, Math.max(PRESUE_NEED, report.onboarded.length)),
    source: "presue",
    why: report.said,
    page: report.page,
    presue: {
      judge: report.judge,
      ...(report.judgeNote ? { judgeNote: report.judgeNote } : {}),
      asked: report.asked,
      need: report.need,
      fit: report.fit,
      closest: report.closest,
      ...(report.refused ? { refused: report.refused } : {}),
      ...(report.onboardNote ? { onboardNote: report.onboardNote } : {}),
      ...(inConnections.length ? { inConnections } : {}),
    },
  };
}

/**
 * Install SUE's people in this process before a visitor is cast: a visitor borrows a built-in's body, and every Sue person
 * lives in Connections (Owner, 2026-09-28), so they are read through this hearing's MCP (the Boardroom's Sue list, no
 * minds). `{ ok, people }`, or `{ ok: false, why }` when there is no MCP or the list did not come; never throws.
 */
export async function readyCastBodies(mcp) {
  if (!mcp) return { ok: false, why: "no Connections MCP to read SUE's people through" };
  try {
    const list = await fetchPeopleList((tool, body) => mcp.api("boardroom", tool, body));
    installPeople(list);
    return { ok: true, people: list.length };
  } catch (err) {
    return { ok: false, why: String(err?.message ?? err).slice(0, 300) };
  }
}

/** The lines the docket prints about who SUE sends. */
export function renderCast(cast) {
  if (!cast) return "";
  if (cast.source === "presue") return renderPresue(cast);
  const from =
    cast.source === "roster"
      ? `the roster's own children (${cast.children.join(", ")})`
      : cast.source === "model"
        ? `cast from the ask and the page by ${cast.model || "the HSwarm brain"}`
        : cast.source === "ask"
          ? `the visitor the ask names, in its own words (no model answered: ${cast.error})`
          : `NONE CAST (${cast.error}): SUE picks as she always has`;
  const lines = [`VISITORS SUE SENDS: ${from}; because ${cast.why}.`];
  if (cast.page) lines.push(`  page read: ${cast.page.error ? `no (${cast.page.error})` : `"${cast.page.title || "untitled"}"`}`);
  for (const v of cast.visitors) {
    lines.push(`  - ${v.id} (${v.displayName}, body ${v.extends}): ${v.voice}`);
    lines.push(`      here because: ${v.errands[0]}`);
  }
  for (const r of cast.refused || []) lines.push(`  refused: ${r.id} - ${r.why}`);
  return lines.join("\n");
}

/** The lines a pre-sued cast prints: who fit and by how much, who was onboarded and whether Connections kept them. */
function renderPresue(cast) {
  const pre = cast.presue ?? {};
  const lines = [
    `VISITORS SUE SENDS: pre-sue, ${pre.judge === "jev" ? "judged by Jev" : `NOT judged by Jev (${pre.judgeNote})`}. ${cast.why}`,
  ];
  if (cast.page) lines.push(`  page read: ${cast.page.error ? `no (${cast.page.error})` : `"${cast.page.title || "untitled"}"`}`);
  lines.push(`  going: ${(cast.personas || []).join(", ") || "nobody"}`);
  if (pre.closest?.length) lines.push(`  closest under the bar: ${pre.closest.map((r) => `${r.id} ${r.p}`).join(", ")}`);
  for (const v of cast.visitors || []) {
    const kept = pre.inConnections?.find((s) => s.id === v.id);
    lines.push(
      `  + onboarded ${v.id} (${v.displayName}, body ${v.extends}${kept ? `, ${kept.saved ? "saved to the workspace" : `NOT saved: ${kept.why}`}` : ""}): ${v.voice}`,
    );
  }
  for (const r of pre.refused || []) lines.push(`  refused draft: ${r.id} - ${r.why}`);
  if (pre.onboardNote) lines.push(`  onboarding: ${pre.onboardNote}`);
  return lines.join("\n");
}
