/**
 * recall.spec - splitting an ask into facets and fanning recall out over them, with no network.
 * =================================================================================================
 *
 * WHAT: `node --test dredd/tests/recall.spec.mjs`. Drives lib/recall.mjs's sentenceChunks,
 * docketFacets and recallFacets against a fake MCP handle, so the merge-on-(repo,slug) rule, the via
 * list and the concurrency cap are pinned with no memory lane and no model call.
 *
 * WHY: P15 (proposal review of MiroFish, 2026-09-23) - recall ran once, on the complaint alone, cut
 * to 500 characters, so a sitting never saw memories a longer ask or a named page would have found.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { docketFacets, fieldFacets, hookRecall, mergeMemories, recallFacets, sentenceChunks } from "../lib/recall.mjs";

test("sentenceChunks: splits at sentence boundaries, never over maxLen, hard-cuts a lone long sentence", () => {
  assert.deepEqual(sentenceChunks(""), []);
  assert.deepEqual(sentenceChunks("One sentence."), ["One sentence."]);
  assert.deepEqual(sentenceChunks("First one. Second one! Third one?"), ["First one. Second one! Third one?"]);
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const c = "c".repeat(40);
  const chunks = sentenceChunks(`${a}. ${b}. ${c}.`, 50);
  for (const ch of chunks) assert.ok(ch.length <= 50, ch.length);
  assert.equal(chunks.length, 3, "each 40-char sentence plus its neighbour would overflow 50, so each stands alone");
  // A single sentence longer than maxLen is hard-cut into pieces, never dropped.
  const long = "x".repeat(130) + ".";
  const cut = sentenceChunks(long, 50);
  assert.ok(cut.length >= 3, cut.length);
  for (const ch of cut) assert.ok(ch.length <= 50, ch.length);
  assert.equal(cut.join(""), long);
});

test("docketFacets: the ask split into chunks, the page as host+first-segment, and each named path's basename", () => {
  const facets = docketFacets({
    ask: "The landing page copy is bloated. Nobody knows what we sell.",
    url: "https://app.example.com/pricing?utm=x",
    paths: ["dredd/lib/docket.mjs", "dredd/bench.json"],
  });
  const qs = facets.map((f) => f.q);
  assert.ok(qs.includes("The landing page copy is bloated. Nobody knows what we sell."), qs.join(" | "));
  assert.ok(qs.includes("app.example.com/pricing"), qs.join(" | "));
  assert.ok(qs.includes("docket.mjs"));
  assert.ok(qs.includes("bench.json"));
  const pageFacet = facets.find((f) => f.q === "app.example.com/pricing");
  assert.equal(pageFacet.label, "page: app.example.com/pricing");
  const pathFacet = facets.find((f) => f.q === "docket.mjs");
  assert.equal(pathFacet.label, "path: docket.mjs");
  // An unparsable URL names no page facet, never throws.
  assert.doesNotThrow(() => docketFacets({ ask: "x", url: "not a url", paths: [] }));
  const noPage = docketFacets({ ask: "x", url: "not a url", paths: [] });
  assert.ok(!noPage.some((f) => f.label.startsWith("page:")));
  // No ask, no paths, no url: an empty facet list, not a throw.
  assert.deepEqual(docketFacets({}), []);
});

/** A fake MCP whose memory_search answers per query from a table, recording every call it received. */
function fakeMcp(byQuery) {
  const calls = [];
  return {
    calls,
    call: async (tool, params) => {
      calls.push(params.query);
      if (tool !== "memory_search") return { ok: false, text: "unknown tool" };
      const hit = byQuery[params.query];
      if (!hit) return { ok: true, text: "" };
      if (hit === "FAIL") return { ok: false, text: "lane down" };
      return { ok: true, text: hit };
    },
  };
}

test("recallFacets: one memory_search per facet, at most `concurrency`, run together", async () => {
  const mcp = fakeMcp({ a: " 50%  [slug-a]  A\n", b: " 40%  [slug-b]  B\n", c: " 30%  [slug-c]  C\n" });
  const rows = await recallFacets(mcp, ["a", "b", "c"], { concurrency: 5 });
  assert.equal(mcp.calls.length, 3);
  assert.equal(rows.length, 3);
  const capped = await recallFacets(mcp, ["a", "b", "c"], { concurrency: 2 });
  assert.equal(capped.length, 2, "only the first `concurrency` facets are ever searched");
});

test("recallFacets: merges on (repo, slug), keeps the highest score, and gathers every facet that found it into via", async () => {
  const mcp = fakeMcp({
    "the page reads long": " 41%  [words-are-a-wall]  Words are a wall  (Connections)\n 30%  [only-facet-one]  Only here\n",
    "app.example.com/pricing": " 67%  [words-are-a-wall]  Words are a wall  (Connections)\n",
    "docket.mjs": " 20%  [only-facet-three]  Third\n",
  });
  const rows = await recallFacets(mcp, [
    { q: "the page reads long", label: "the page reads long" },
    { q: "app.example.com/pricing", label: "page: app.example.com/pricing" },
    { q: "docket.mjs", label: "path: docket.mjs" },
  ]);
  const merged = rows.find((r) => r.slug === "words-are-a-wall");
  assert.ok(merged, rows.map((r) => r.slug).join(","));
  assert.equal(merged.score, 67, "the higher-scoring facet's row wins");
  assert.deepEqual(
    merged.via,
    ["the page reads long", "page: app.example.com/pricing"],
    "both facets that found it, in order, deduped",
  );
  const single = rows.find((r) => r.slug === "only-facet-one");
  assert.deepEqual(single.via, ["the page reads long"]);
  // Sorted strongest first.
  assert.deepEqual(
    rows.map((r) => r.slug),
    ["words-are-a-wall", "only-facet-one", "only-facet-three"],
  );
});

test("recallFacets: a failed facet contributes nothing and never fails the others; capped at 8 overall", async () => {
  const table = { good: " 90%  [ok-slug]  Ok\n", bad: "FAIL" };
  const mcp = fakeMcp(table);
  const rows = await recallFacets(mcp, ["good", "bad"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, "ok-slug");

  const many = fakeMcp({
    f1: [1, 2, 3, 4, 5].map((n) => ` ${90 - n}%  [slug-${n}]  T${n}\n`).join(""),
    f2: [6, 7, 8, 9].map((n) => ` ${90 - n}%  [slug-${n}]  T${n}\n`).join(""),
  });
  const capped = await recallFacets(many, ["f1", "f2"], { limit: 10, cap: 8 });
  assert.equal(capped.length, 8);
});

test("recallFacets: every field parseLaneText returns rides along - updatedAt, supersededBy, global included", async () => {
  const mcp = fakeMcp({
    q:
      " 52%  [dredd-judges-pages]  Dredd judges pages  (Connections)  (global)  updated 2026-09-23\n" +
      " 40%  [old-room-rule]  The room reads its own sittings  (Connections)  updated 2026-09-20  SUPERSEDED by room-never-reads-itself\n",
  });
  const rows = await recallFacets(mcp, ["q"]);
  const global = rows.find((r) => r.slug === "dredd-judges-pages");
  assert.equal(global.global, true);
  assert.equal(global.updatedAt, "2026-09-23");
  const replaced = rows.find((r) => r.slug === "old-room-rule");
  assert.equal(replaced.supersededBy, "room-never-reads-itself");
});

test("recallFacets: a plain string facet is its own via label; facets is never mutated or required non-empty", async () => {
  const mcp = fakeMcp({ x: " 10%  [s]  T\n" });
  const rows = await recallFacets(mcp, ["x"]);
  assert.deepEqual(rows[0].via, ["x"]);
  assert.deepEqual(await recallFacets(mcp, []), []);
  assert.deepEqual(await recallFacets(mcp, [""]), []);
});

test("after the field, recall asks where the visitors stopped, the rung that failed and a broken page - nothing else", () => {
  const facets = fieldFacets({
    sue: { whereTheyStopped: { finished: 4, "/verify": 3, "/signup": 1, "/pricing": 2 } },
    ladder: [
      { n: 1, id: "broken", question: "Is the page broken?", state: "ok" },
      { n: 4, id: "understood", question: "Can people understand it?", state: "fail" },
    ],
    pulse: { verdict: "broken", summary: "HTTP 500" },
  });
  assert.deepEqual(
    facets.map((f) => f.label),
    ["sue: stopped at /verify", "sue: stopped at /pricing", "ladder: Can people understand it?", "pulse: broken"],
  );
  assert.equal(facets[0].q, "visitors stopped at /verify");
  assert.deepEqual(fieldFacets({ sue: { whereTheyStopped: { finished: 5 } }, pulse: { verdict: "wobbly" } }), []);
  assert.deepEqual(fieldFacets(), []);
});

test("recalled rows join what the docket holds once each, and a repeat gains the new facet's label", () => {
  const held = [{ slug: "a", repo: "Connections", score: 60, via: ["the ask"] }];
  const merged = mergeMemories(held, [
    { slug: "a", repo: "Connections", score: 70, via: ["sue: stopped at /verify"] },
    { slug: "b", repo: null, score: 40, via: ["pulse: broken"] },
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].score, 60, "a row already held keeps its place and score");
  assert.deepEqual(merged[0].via, ["the ask", "sue: stopped at /verify"]);
  assert.equal(merged[1].slug, "b");
  assert.equal(held[0].via.length, 1, "the docket's own rows are not mutated");
  assert.deepEqual(mergeMemories(undefined, undefined), []);
});

// hookRecall is the prompt hook's recall through the running MCP's memory_search (MEMORY_CLOUD_CUTOVER.md S3): the
// hook has 5 s, so it must answer inside its budget and never let a dead lane read as "none matched".
test("hookRecall: the prompt's sentences searched together, merged strongest first, each row naming what found it", async () => {
  const asked = [];
  const search = async (query, limit) => {
    asked.push({ query, limit });
    if (query.startsWith("The pricing page"))
      return { ok: true, text: " 61%  [pricing-wall]  Pricing wall  (Connections)\n 33%  [shared-one]  Shared\n" };
    return { ok: true, text: " 72%  [shared-one]  Shared\n" };
  };
  // Two sentences that together pass the 500-character chunk: two facets, so two searches.
  const ask = `The pricing page reads like a wall of text. ${"Every card says the same thing again ".repeat(13).trim()}?`;
  const r = await hookRecall(ask, search, { budgetMs: 1_000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.facets, 2);
  assert.equal(asked.length, 2, "one memory_search per facet");
  assert.deepEqual(
    r.rows.map((m) => m.slug),
    ["shared-one", "pricing-wall"],
    "merged on slug, the higher score kept, strongest first",
  );
  assert.equal(r.rows[0].via.length, 2, "both facets found shared-one");
  assert.ok(r.rows.every((m) => Array.isArray(m.via) && m.via.length));
});

test("hookRecall: a lane that fails on every facet is ok:false with its reason, never an empty success", async () => {
  const r = await hookRecall("The checkout page keeps failing for everyone today", async () => ({
    ok: false,
    text: "signed out of Connections",
  }));
  assert.equal(r.ok, false);
  assert.match(r.error, /signed out/);
  assert.deepEqual(r.rows, []);
  const thrown = await hookRecall("The checkout page keeps failing for everyone today", async () => {
    throw new Error("socket closed");
  });
  assert.equal(thrown.ok, false);
  assert.match(thrown.error, /socket closed/);
});

test("hookRecall: a lane that never answers gives up inside the budget", async () => {
  const t0 = Date.now();
  const r = await hookRecall("The checkout page keeps failing for everyone today", () => new Promise(() => {}), { budgetMs: 200 });
  assert.equal(r.ok, false);
  assert.match(r.error, /did not answer inside 200 ms/);
  assert.ok(Date.now() - t0 < 1_000, `returned after ${Date.now() - t0} ms`);
});
