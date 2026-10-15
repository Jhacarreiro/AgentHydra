// dredd/lib/catalog.mjs - what Connections already has for an ask, read off the catalog.
//
// Owner, 2026-09-23: Dredd should be Connections' orchestration layer - "making a website and you are hosting
// on Cloudflare, we suggest using Connections' plugin and connecting Cloudflare, or running the Architect".
// The catalog (connections_search_catalog) already ranks, for any plain-English query, this machine's local
// tools, the Script Vault, the API endpoints this company reaches and the connector registry (connected or
// not). So the docket asks it once and prints what fits the ask's own words: no second router, and no
// hand-kept list of Connections tools on the bench. The AI may SUGGEST a connector but never connects one
// (rail 2, Owner 2026-09-09): an unconnected connector prints the page a person connects it on.
// Design and the hosted follow-up: docs/strategy/DREDD_ORCHESTRATION_LAYER.md.

export const CATALOG_LIMITS = Object.freeze({ tools: 4, scripts: 3, connectors: 3, endpoints: 3 });

/** A name hit outweighs any number of description hits. An item with no name hit needs this many distinct ask words
 *  in its description, or it is noise the search returned anyway (a live "audit this codebase" docket listed
 *  prompt_save on "code" + "codebase" at a looser bar, 2026-09-23). */
const NAME_HIT = 3;
const TEXT_ONLY_MIN = 3;

const oneLine = (s, max = 150) => {
  const t = String(s ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};

/** The first JSON object in `text` at or after `from`, by string-aware brace matching; null when none parses. */
export function firstJsonObject(text, from = 0) {
  const start = text.indexOf("{", from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A name token is the term, or (both 5+ letters) one is the other plus a suffix: "websites" for "website", never "hosting" for "host". */
const tokenFits = (token, term) =>
  token === term || (term.length >= 5 && token.startsWith(term)) || (token.length >= 5 && term.startsWith(token));

/** How the ask's key terms fit an item: whole-word hits in its name tokens, and in its description only. */
export function fitScore(name, summary, terms) {
  const tokens = String(name || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const s = String(summary || "").toLowerCase();
  let nameHits = 0;
  let textHits = 0;
  for (const term of new Set(terms.map((t) => String(t).toLowerCase()))) {
    if (term.length < 3) continue;
    if (tokens.some((tok) => tokenFits(tok, term))) nameHits += 1;
    else if (new RegExp(`\\b${escapeRx(term)}s?\\b`).test(s)) textHits += 1;
  }
  return { nameHits, textHits, score: nameHits * NAME_HIT + textHits, fits: nameHits > 0 || textHits >= TEXT_ONLY_MIN };
}

function ranked(items, terms, limit) {
  return items
    .map((it) => ({ ...it, ...fitScore(it.name, it.summary, terms) }))
    .filter((it) => it.fits)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * The local MCP's search answer (its "LOCAL TOOLS" lines, then the hosted catalog's JSON after "API ENDPOINTS
 * (catalog):") into typed suggestions, keeping only what the ask's key terms fit. Pure.
 */
export function suggestionsFromCatalog(text, terms, limits = CATALOG_LIMITS) {
  const body = String(text || "");
  const cut = body.indexOf("API ENDPOINTS (catalog):");
  const localPart = cut >= 0 ? body.slice(0, cut) : body;
  const json = cut >= 0 ? firstJsonObject(body, cut) : null;
  const tools = [...localPart.matchAll(/^• ([A-Za-z0-9_]+) - (.+)$/gm)].map((m) => ({ name: m[1], summary: m[2] }));
  const scripts = (json?.scripts || []).map((s) => ({ name: s.tool_name, summary: `${s.name || ""} ${s.summary || ""}` }));
  const endpoints = (json?.results || [])
    .filter((r) => r?.tool_name)
    .map((r) => ({ name: r.tool_name, service: r.service || r.kind || "", summary: r.summary || "" }));
  const connectors = (json?.connectors || [])
    .filter((c) => c?.slug)
    .map((c) => ({
      name: c.slug,
      label: c.name || c.slug,
      summary: `${c.name || ""} ${c.blurb || ""}`,
      connected: c.connected === true,
      url: c.connected ? c.page_url || null : c.connect_url || c.page_url || null,
      copyable: Array.isArray(c.copyable_from) ? c.copyable_from.length : 0,
    }));
  const oneLined = (xs) => xs.map((x) => ({ ...x, summary: oneLine(x.summary) }));
  return {
    tools: oneLined(ranked(tools, terms, limits.tools)),
    scripts: oneLined(ranked(scripts, terms, limits.scripts)),
    // A connector is suggested only on a NAME hit: "Cloudflare" for an ask that says Cloudflare, never a
    // connector whose blurb merely shares a word with the ask.
    connectors: oneLined(ranked(connectors, terms, limits.connectors).filter((c) => c.nameHits > 0)),
    endpoints: oneLined(ranked(endpoints, terms, limits.endpoints)),
  };
}

export const suggestionCount = (s) => (s ? s.tools.length + s.scripts.length + s.connectors.length + s.endpoints.length : 0);

/** Ask the catalog once for the docket's ask. Never throws: { ok, error?, ...suggestions }. */
export async function catalogFor(mcp, docket, { ms = 45_000 } = {}) {
  const query = String(docket.ask || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
  if (!query) return { ok: false, error: "no ask" };
  const out = await mcp.search(query, ms);
  if (!out.ok) return { ok: false, error: oneLine(out.text, 200) };
  return { ok: true, ...suggestionsFromCatalog(out.text, docket.terms || []) };
}

/** The docket lines for it: what Connections has, and the one step a person takes for a connector not yet connected. */
export function renderConnections(c, { compact = false } = {}) {
  if (!c) return [];
  if (!c.ok) return [`CONNECTIONS HAS: the catalog did not answer (${c.error})`];
  if (!suggestionCount(c)) return [`CONNECTIONS HAS: nothing in the catalog fits this ask's words.`];
  const lines = [`CONNECTIONS HAS, for this ask (the catalog, matched on the ask's own words):`];
  for (const k of c.connectors) {
    lines.push(
      k.connected
        ? `  connector ${k.label}: connected - its endpoints answer connections_search_catalog { query }`
        : `  connector ${k.label}: NOT connected - a person connects it${k.url ? ` at ${k.url}` : ""}${k.copyable ? ` (or copies it from ${k.copyable} other workspace${k.copyable === 1 ? "" : "s"})` : ""}; never ask them for the credential`,
    );
  }
  for (const t of c.tools)
    lines.push(`  tool      ${t.name}${compact ? "" : ` - ${t.summary}`}  → connections_execute { local:true, tool_name:"${t.name}" }`);
  for (const s of c.scripts) lines.push(`  script    ${s.name}${compact ? "" : ` - ${s.summary}`}  → script_run { script:"${s.name}" }`);
  for (const e of c.endpoints) lines.push(`  endpoint  ${e.name} (${e.service})${compact ? "" : ` - ${e.summary}`}`);
  return lines;
}
