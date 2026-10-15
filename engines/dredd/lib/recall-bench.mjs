// dredd/lib/recall-bench.mjs - which recall path finds the answer, and for how many tokens?
//
// WHY: Dredd recalls memories more than one way (a session's own memory_search, the docket's facets, the prompt hook's
// hookRecall) and nothing said which one finds the answer, or what each costs the reader in tokens. The idea is
// Leviathan's known-answer benchmark (elstongun/leviathan bench/run_bench.py, Apache-2.0; ideas only, written fresh):
// fixed questions whose answer is known, scored on answer-in-top-5, median and worst-case tokens, and latency.
// Leviathan's set is a best case (every question names its entity, bench/run_bench.py:153), so ours is worded unlike
// the memory titles and carries questions no memory answers.
//
// An instrument, not a gate: nothing here fails on a score. The pure parts live here (the synthetic stand-in for
// memory_search, the paths, the scoring, the report); recall-bench.mjs is the command. Slugs and numbers only, never
// a memory body.
import { memoryLines } from "./docket.mjs";
import { dreddHookWants, hookMemoriesBlock } from "./hook-recall.mjs";
import { docketFacets, hookRecall, recallFacets, recallLane } from "./recall.mjs";

/** An answer counts when its slug is among the first TOP_K rows a path returns. */
export const TOP_K = 5;

/** Tokens a reader pays for `text`: characters / 4, rounded up. The repo keeps no tokenizer for prose, and every path
 *  is measured by the same rule, so the comparison holds even where the absolute number is rough. */
export function estimateTokens(text) {
  return Math.ceil(String(text || "").length / 4);
}

const STOP = new Set(
  "a an and are as at be been but by can do does for from get gets has have how i if in into is it its just like more of on or our out should so some than that the their them then there these they this to up was we what when where which who why will with would you your".split(
    " ",
  ),
);

/** Lower-case word runs, letters and digits. Pure. */
function words(text) {
  return (
    String(text || "")
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu) || []
  );
}

/** A crude stem: the first six letters, or a short word without its plural s, so "releases", "released" and
 *  "release" meet, as do "fonts" and "font". Pure. */
function stem(w) {
  if (w.length > 6) return w.slice(0, 6);
  return w.length >= 4 && w.endsWith("s") ? w.slice(0, -1) : w;
}

const terms = (text) =>
  words(text)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);

/** One memory_search row in the tool's own text shape (services/studio/local-mcp/src-impl/23-tools-agent-lane.mjs,
 *  memory_search), so parseLaneText reads the fixture exactly as it reads the lane. */
function laneRow(m, pct, repo) {
  const preview = String(m.body || "")
    .replace(/\s+/g, " ")
    .slice(0, 160);
  const updated = m.updated ? `  updated ${m.updated}` : "";
  const superseded = m.supersededBy ? `  SUPERSEDED by ${m.supersededBy}` : "";
  return `${String(pct).padStart(3)}%  [${m.slug}]  ${m.title}${repo ? `  (${repo})` : ""}${updated}${superseded}\n       ${preview}`;
}

/**
 * A stand-in for the memory lane over a checked-in fixture, answering `search(query, limit)` and `contains(text, limit)`
 * as `{ ok, text }` in memory_search's own text. The ranking is lexical (BM25 over the title twice and the body), NOT
 * the lane's Titan embeddings: synthetic numbers compare Dredd's paths over one ranker, they do not measure the lane.
 * Unlike the lane it returns nothing when no term overlaps, so an absent answer can come back empty. Pure.
 */
export function fixtureLane(memories, { repo = null } = {}) {
  const docs = (memories || []).map((m) => ({ m, terms: terms(`${m.title} ${m.title} ${m.body}`) }));
  const avgdl = docs.reduce((n, d) => n + d.terms.length, 0) / Math.max(1, docs.length);
  const df = new Map();
  for (const d of docs) for (const t of new Set(d.terms)) df.set(t, (df.get(t) || 0) + 1);
  const idf = (t) => Math.log(1 + (docs.length - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
  const bm25 = (q, d) => {
    let s = 0;
    for (const t of new Set(q)) {
      const tf = d.terms.filter((x) => x === t).length;
      if (tf) s += (idf(t) * tf * 2.2) / (tf + 1.2 * (0.25 + (0.75 * d.terms.length) / avgdl));
    }
    return s;
  };
  return {
    async search(query, limit = 8) {
      const q = terms(query);
      const ranked = docs
        .map((d) => ({ m: d.m, s: bm25(q, d) }))
        .filter((r) => r.s > 0)
        .sort((a, b) => b.s - a.s)
        .slice(0, limit);
      if (!ranked.length) return { ok: true, text: `No memory matches "${query}".` };
      const lines = ranked.map((r) => laneRow(r.m, Math.min(99, Math.round((100 * r.s) / (r.s + 6))), repo));
      return { ok: true, text: `${ranked.length} memories for "${query}":\n\n${lines.join("\n")}` };
    },
    async contains(text, limit = 100) {
      const needle = String(text || "").toLowerCase();
      const hits = docs
        .map((d) => d.m)
        .filter((m) => `${m.title}\n${m.body}`.toLowerCase().includes(needle))
        .slice(0, limit);
      if (!hits.length) return { ok: true, text: `No live memory holds the text "${text}".` };
      const lines = hits.map((m) => `  [${m.slug}]${repo ? `  (${repo})` : ""}  ${m.title}\n       ${String(m.body).slice(0, 160)}`);
      return { ok: true, text: `${hits.length} memories hold "${text}":\n${lines.join("\n")}` };
    },
  };
}

/** The slugs of a memory_search `contains` answer, in order. Pure. */
export function containsSlugs(text) {
  return [...String(text || "").matchAll(/^\s*\[([^\]]+)\]/gm)].map((m) => m[1]);
}

/** The words a grep would try: the question's three longest content words, longest first. Pure. */
export function grepWords(ask) {
  const seen = [...new Set(words(ask).filter((w) => w.length >= 4 && !STOP.has(w)))];
  return seen.sort((a, b) => b.length - a.length).slice(0, 3);
}

/** The local-MCP handle shape recall.mjs calls (`call(tool, params) -> {ok, text}`), over a backend. */
const handleOf = (backend) => ({ call: (_tool, params) => backend.search(params.query, params.limit) });

/**
 * Dredd's recall paths, each `run(ask, backend) -> { ok, rows, text, error? }` where `text` is what the path hands its
 * reader (the tokens counted) and `rows` its ranked slugs. `backend` is `{ search, contains }` as fixtureLane answers.
 * `recordsReads`: on the real lane a `query` hit RECORDS a read (it ages memory_prune's staleness and can ratify a
 * tentative memory); a `contains` hit records none. --live runs a path that records reads only with --record-reads.
 */
export const PATHS = [
  {
    id: "memory_search",
    recordsReads: true,
    what: "one query, the tool's default 8 rows with previews, as a session calls it (recallLane)",
    async run(ask, backend) {
      const r = await recallLane(handleOf(backend), ask, { limit: 8 });
      return r.ok ? { ok: true, rows: r.rows, text: r.raw } : { ok: false, rows: [], text: "", error: r.error };
    },
  },
  {
    id: "docket",
    recordsReads: true,
    what: "a docket's recall: one query per sentence facet, merged on (repo, slug), the whole ask when none merge (dredd.mjs)",
    async run(ask, backend) {
      const facets = docketFacets({ ask });
      let rows = await recallFacets(handleOf(backend), facets);
      let source = `memory lane, pgvector cosine over ${facets.length} facet(s)`;
      if (!rows.length) {
        const lane = await recallLane(handleOf(backend), ask);
        if (!lane.ok) return { ok: false, rows: [], text: "", error: lane.error };
        rows = lane.rows;
        source = "memory lane, pgvector cosine";
      }
      return { ok: true, rows, text: memoryLines({ memories: rows, memorySource: source }, 10).join("\n") };
    },
  },
  {
    id: "hook",
    recordsReads: true,
    what: "the prompt hook's hookRecall and the <dredd-memories> block it prints (titles only; the hook's gate not applied)",
    async run(ask, backend) {
      const r = await hookRecall(ask, (q, limit) => backend.search(q, limit));
      return { ok: r.ok, rows: r.rows, text: hookMemoriesBlock(r), ...(r.ok ? {} : { error: r.error }) };
    },
  },
  {
    id: "grep",
    recordsReads: false,
    what: "baseline, not a Dredd path: memory_search { contains } on the ask's three longest words, ranked by words matched",
    async run(ask, backend) {
      const texts = [];
      const matched = new Map();
      for (const w of grepWords(ask)) {
        const r = await backend.contains(w, 100);
        if (!r.ok) return { ok: false, rows: [], text: "", error: String(r.text).slice(0, 200) };
        texts.push(r.text);
        for (const slug of containsSlugs(r.text)) matched.set(slug, (matched.get(slug) || 0) + 1);
      }
      const rows = [...matched.entries()].sort((a, b) => b[1] - a[1]).map(([slug]) => ({ slug }));
      return { ok: true, rows, text: texts.join("\n") };
    },
  },
];

/** WHY: the brief wants --live read-only, and a query hit on the real lane writes a read. So a live run without
 *  `recordReads` runs only the paths that record none and names the rest as skipped, with the reason. Pure. */
export function benchPaths({ live = false, recordReads = false } = {}, paths = PATHS) {
  if (!live || recordReads) return { run: paths, skipped: [] };
  return {
    // Fail closed: a path that does not say it records no read is treated as one that does.
    run: paths.filter((p) => p.recordsReads === false),
    skipped: paths
      .filter((p) => p.recordsReads !== false)
      .map((p) => ({ id: p.id, reason: "every query hit records a read in your store; add --record-reads to run it" })),
  };
}

/** One question's grade on one path's rows: `answerKey` names the field holding the expected slug ("answer" on the
 *  fixture, "liveAnswer" live). A question without that field is unscored; a null answer is correct only when the path
 *  returned nothing. Pure. */
export function gradeRows(question, rows, answerKey = "answer") {
  if (!question || !(answerKey in question)) return { scored: false };
  const top = (rows || []).slice(0, TOP_K).map((r) => r.slug);
  const expected = question[answerKey];
  if (expected === null) return { scored: true, absent: true, correct: top.length === 0 };
  return { scored: true, absent: false, correct: top.includes(expected) };
}

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/** Per path: answerable hits, absent questions left empty, median and worst tokens, median ms, failed runs. Pure. */
export function summarize(results) {
  const byPath = new Map();
  for (const r of results) {
    const p = byPath.get(r.path) || { path: r.path, hits: 0, answerable: 0, empty: 0, absent: 0, tokens: [], ms: [], failed: 0 };
    if (!r.ok) p.failed += 1;
    else {
      p.tokens.push(r.tokens);
      p.ms.push(r.ms);
    }
    if (r.grade?.scored && r.grade.absent) {
      p.absent += 1;
      p.empty += r.grade.correct ? 1 : 0;
    } else if (r.grade?.scored) {
      p.answerable += 1;
      p.hits += r.grade.correct ? 1 : 0;
    }
    byPath.set(r.path, p);
  }
  return [...byPath.values()].map((p) => ({
    path: p.path,
    hits: p.hits,
    answerable: p.answerable,
    empty: p.empty,
    absent: p.absent,
    tokensMedian: median(p.tokens),
    tokensWorst: p.tokens.length ? Math.max(...p.tokens) : null,
    msMedian: median(p.ms),
    failed: p.failed,
  }));
}

/** Run every question on every path; slugs and numbers only. `now` is injectable for a steady clock in a spec.
 *  Only a run that succeeded is graded: a failed recall returns no rows, which would otherwise read as a correct
 *  "nothing" on an absent-answer question. Failures are counted apart (summarize's `failed`). */
export async function runBench(questions, backend, { paths = PATHS, answerKey = "answer", now = () => performance.now() } = {}) {
  const results = [];
  for (const path of paths)
    for (const q of questions) {
      const t0 = now();
      const out = await path.run(q.ask, backend);
      const ms = Math.round((now() - t0) * 10) / 10;
      results.push({
        path: path.id,
        id: q.id,
        ok: out.ok,
        ms,
        tokens: estimateTokens(out.text),
        top: (out.rows || []).slice(0, TOP_K).map((r) => r.slug),
        grade: out.ok ? gradeRows(q, out.rows, answerKey) : { scored: false },
        ...(out.ok ? {} : { error: out.error }),
      });
    }
  return results;
}

/** How many of the questions Dredd's prompt hook would fire on at all (its gate, dreddHookWants). Pure. */
export function hookFires(questions) {
  return questions.filter((q) => dreddHookWants(q.ask)).length;
}

const pct = (n, d) => (d ? `${n}/${d} ${String(Math.round((100 * n) / d)).padStart(3)}%` : "n/a");
const num = (v) => (v === null ? "-" : String(v));

/** The table, one row per path. Pure. */
export function reportLines(summary, paths = PATHS) {
  const head = `${"path".padEnd(14)} ${"hit@5".padEnd(12)} ${"absent->none".padEnd(13)} ${"tok med".padStart(8)} ${"tok worst".padStart(9)} ${"ms med".padStart(8)} ${"failed".padStart(6)}`;
  const rows = summary.map(
    (s) =>
      `${s.path.padEnd(14)} ${pct(s.hits, s.answerable).padEnd(12)} ${pct(s.empty, s.absent).padEnd(13)} ${num(s.tokensMedian).padStart(8)} ${num(s.tokensWorst).padStart(9)} ${num(s.msMedian).padStart(8)} ${String(s.failed).padStart(6)}`,
  );
  const notes = paths.map((p) => `  ${p.id}: ${p.what}`);
  return [head, ...rows, "", ...notes];
}
