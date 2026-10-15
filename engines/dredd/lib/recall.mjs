// dredd/lib/recall.mjs - which memories does this ask need?
//
// Owner ask (the Chair, 2026-09-21): "when the AI asks a question, help it determine which memories it
// needs access to ... a right proper vector database". That database EXISTS: the agent memory lane is
// the notes plane's pgvector store (Titan Text Embeddings v2, 1024-dim, HNSW, cosine -
// services/notes/lambda/src/agent-lane-memory-store.ts), and since 2026-09-21 it holds every file of
// Lunarwerx/claude-memory by (repo, slug), losslessly (the memory cloud cutover's last file check,
// 2026-10-03, found every file there or superseded by a newer store edit). So recall is a QUERY, not a build: `memory_search` through the local MCP, top N by cosine.
//
// The prompt hook cannot afford the MCP's five-second spawn, so it never recalls itself: the MCP the chat is ALREADY
// running answers a second UserPromptSubmit hook (an `mcp_tool` entry calling `dredd_hook`, 26c-tools-dredd.mjs), and
// that tool runs hookRecall below with its own memory_search, in-process (MEMORY_CLOUD_CUTOVER.md S3, row 17).
import path from "node:path";

import { pageKey } from "../../sue/lib/workspace.mjs";

/** Parse memory_search's text into rows. A row reads `NN%  [slug]  title…  (Repo)  (global)  updated YYYY-MM-DD
 *  SUPERSEDED by <slug>`, every part after the title optional; they are peeled off the end in that order, so a
 *  global row's repo is its repo, never "global". */
export function parseLaneText(text) {
  const rows = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = /^\s*(\d{1,3})%\s+\[([^\]]+)\]\s+(.*)$/.exec(line);
    if (!m) continue;
    let rest = m[3].trim();
    const peel = (re) => {
      const hit = re.exec(rest);
      if (hit) rest = rest.slice(0, hit.index).trim();
      return hit;
    };
    const superseded = peel(/\s*SUPERSEDED by (\S+)$/);
    const updated = peel(/\s*updated (\d{4}-\d{2}-\d{2})$/);
    const global = peel(/\s*\(global\)$/);
    const repo = peel(/\s+\(([^()]*)\)$/);
    rows.push({
      score: Number(m[1]),
      slug: m[2],
      title: rest.replace(/…$/, "").trim(),
      repo: repo ? repo[1].trim() : null,
      source: "lane",
      ...(global ? { global: true } : {}),
      ...(updated ? { updatedAt: updated[1] } : {}),
      ...(superseded ? { supersededBy: superseded[1] } : {}),
    });
  }
  return rows;
}

/** The lane (pgvector) through an open local-MCP handle. Never throws. */
export async function recallLane(mcp, ask, { limit = 6, timeoutMs = 15_000 } = {}) {
  const res = await mcp.call("memory_search", { query: ask.slice(0, 500), limit }, timeoutMs);
  if (!res.ok) return { ok: false, rows: [], error: res.text.slice(0, 200) };
  return { ok: true, rows: parseLaneText(res.text).slice(0, limit), raw: res.text };
}

/**
 * Recall for the prompt hook, inside `budgetMs`: the prompt's sentence chunks as facets (docketFacets - the hook has no
 * page or paths yet), searched together through `search(query, limit) -> {ok, text}` (the running MCP's own
 * memory_search; recallFacets below merges them). Never throws and never waits past the budget: a lane that did not
 * answer in time, or failed on every facet, is ok:false with the reason, never a clean-looking "none matched".
 */
export async function hookRecall(prompt, search, { budgetMs = 3_500, limit = 6, cap = 6, concurrency = 3 } = {}) {
  const t0 = Date.now();
  const facets = docketFacets({ ask: String(prompt || "").trim() }).slice(0, concurrency);
  if (!facets.length) return { ok: true, rows: [], facets: 0, ms: 0 };
  const failures = [];
  const handle = {
    call: async (_tool, params) => {
      try {
        const r = await search(params.query, params.limit);
        if (!r?.ok) failures.push(String(r?.text || "no answer").slice(0, 200));
        return { ok: Boolean(r?.ok), text: String(r?.text || "") };
      } catch (err) {
        failures.push(String(err?.message || err).slice(0, 200));
        return { ok: false, text: String(err?.message || err) };
      }
    },
  };
  let timer;
  const late = new Promise((done) => {
    timer = setTimeout(() => done(null), budgetMs);
  });
  const rows = await Promise.race([recallFacets(handle, facets, { limit, cap, concurrency }), late]);
  clearTimeout(timer);
  const ms = Date.now() - t0;
  if (rows === null)
    return { ok: false, rows: [], facets: facets.length, ms, error: `the memory lane did not answer inside ${budgetMs} ms` };
  if (failures.length >= facets.length) return { ok: false, rows: [], facets: facets.length, ms, error: failures[0] };
  return { ok: true, rows, facets: facets.length, ms };
}

// --- facets (P15) -------------------------------------------------------------------------------------------
//
// One query gets one shot: the complaint text alone, cut to 500 characters (recallLane above), asked once at
// docket time and never again. So a sitting reads memories chosen from the ask even when SUE shows visitors
// dying at a step the complaint never named. recallFacets fans a docket's evidence out into several short,
// targeted queries instead of one long one - no model call, just splitting text the docket already has - and
// merges what comes back so a memory two facets agree on still shows once, with both reasons attached.

/** The ask split at sentence boundaries into chunks no longer than `maxLen` characters, so a long, run-on
 *  complaint becomes several short, targeted queries instead of one that gets cut mid-sentence at 500
 *  (recallLane). A single sentence longer than `maxLen` is hard-cut rather than dropped. Pure. */
export function sentenceChunks(text, maxLen = 500) {
  const sentences = String(text || "")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!sentences.length) return [];
  const chunks = [];
  let cur = "";
  for (const s of sentences) {
    const piece = cur ? `${cur} ${s}` : s;
    if (piece.length <= maxLen) {
      cur = piece;
      continue;
    }
    if (cur) chunks.push(cur);
    if (s.length <= maxLen) {
      cur = s;
    } else {
      for (let i = 0; i < s.length; i += maxLen) chunks.push(s.slice(i, i + maxLen));
      cur = "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * The docket-time facets: the ask split into sentence chunks, the page as `pageKey` (host plus first path
 * segment - SUE's own function, lib/workspace.mjs, so a campaign URL and its scoreboard row read one page the
 * same way), and the basename of each named repository path. Each facet is `{q, label}`; `label` is what a
 * reader sees on a memory's `via` line. No model call. Pure (a bad URL just names no page facet, never throws).
 */
export function docketFacets({ ask = "", url = null, paths = [] } = {}) {
  const facets = sentenceChunks(ask).map((q) => ({ q, label: q.length > 60 ? `${q.slice(0, 57)}...` : q }));
  if (url) {
    try {
      const key = pageKey(url);
      if (key) facets.push({ q: key, label: `page: ${key}` });
    } catch {
      // an unparsable URL names no page facet
    }
  }
  for (const p of paths || []) {
    const base = path.basename(String(p || ""));
    if (base) facets.push({ q: base, label: `path: ${base}` });
  }
  return facets;
}

/**
 * Recall over several facets at once instead of one. Each facet is a query string, or `{q, label}` when the
 * caller wants a via label other than the query itself (a bare string is its own label). At most `concurrency`
 * facets are searched - one memory_search call each, run together, never one at a time - so a long facet list
 * still costs one round trip's worth of wall clock, not a queue of them.
 *
 * Rows are merged on (repo, slug): a memory two facets both find keeps its HIGHEST score and gathers every
 * facet that found it into `via` (deduped, in the order facets were given), so `docket.md` can say which
 * evidence turned up which memory. Every field parseLaneText returns rides along unchanged (title, updatedAt,
 * supersededBy, global included) - this only fans the query out and folds the rows back together. Capped at
 * `cap` rows overall, strongest first. No model call; a facet whose search failed contributes nothing and is
 * never an error for the others.
 */
/**
 * The facets a hearing recalls on AFTER the field lands: where the visitors stopped (the two commonest places, never
 * "finished"), the first ladder rung that failed, and a broken pulse. Recall used to run once, on the complaint's
 * words, so a room hearing that Sues died at a step the complaint never named read memories about the complaint only.
 * Pure; `[]` when nothing in the field points anywhere new.
 */
export function fieldFacets({ sue = null, ladder = null, pulse = null } = {}) {
  const facets = [];
  const stopped = Object.entries(sue?.whereTheyStopped || {})
    .filter(([where, n]) => where && where !== "finished" && Number(n) > 0)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .slice(0, 2);
  for (const [where] of stopped) facets.push({ q: `visitors stopped at ${where}`, label: `sue: stopped at ${where}` });
  const failed = (Array.isArray(ladder) ? ladder : []).find((r) => r?.state === "fail" && r.question);
  if (failed) facets.push({ q: failed.question, label: `ladder: ${failed.question}` });
  if (pulse?.verdict === "broken") facets.push({ q: `the page is broken: ${pulse.summary || ""}`.trim(), label: "pulse: broken" });
  return facets;
}

/** Recalled rows added to what a docket already holds, deduplicated on (repo, slug): a row already there keeps its
 *  place and gains the new facet labels. Pure. */
export function mergeMemories(held, found) {
  const out = (held || []).map((r) => ({ ...r }));
  const at = new Map(out.map((r, i) => [`${r.repo || ""}|${r.slug}`, i]));
  for (const row of found || []) {
    const i = at.get(`${row.repo || ""}|${row.slug}`);
    if (i === undefined) {
      at.set(`${row.repo || ""}|${row.slug}`, out.length);
      out.push(row);
    } else out[i].via = [...new Set([...(out[i].via || []), ...(row.via || [])])];
  }
  return out;
}

export async function recallFacets(mcp, facets, { limit = 6, concurrency = 5, cap = 8, timeoutMs = 15_000 } = {}) {
  const items = (Array.isArray(facets) ? facets : [])
    .map((f) => (typeof f === "string" ? { q: f, label: f } : f))
    .filter((f) => f && typeof f.q === "string" && f.q.trim())
    .slice(0, concurrency);
  const results = await Promise.all(items.map((f) => recallLane(mcp, f.q, { limit, timeoutMs })));

  const merged = new Map();
  items.forEach((facet, i) => {
    const r = results[i];
    if (!r?.ok) return;
    for (const row of r.rows) {
      const key = `${row.repo || ""}\u0000${row.slug}`;
      const existing = merged.get(key);
      const via = existing?.via || [];
      const winner = existing && (existing.score ?? 0) >= (row.score ?? 0) ? existing : row;
      merged.set(key, { ...winner, via: via.includes(facet.label) ? via : [...via, facet.label] });
    }
  });
  return [...merged.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, cap);
}
