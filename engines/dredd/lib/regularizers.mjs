/**
 * regularizers.mjs - two of RRSI's selection-side regularizers, pointed at Dredd's own self-improvement loop.
 *
 * WHY (2026-09-27): google-research/rrsi ("Regularized Recursive Self-Improvement of Agent Harnesses", Apache-2.0)
 * evolves an agent harness against a fixed task set and measures what the unregularized loop does: the best score on
 * the set it tunes against, and +0.6 points out of distribution, where the regularized loop kept +3.9 on 36% fewer
 * tokens (its Table 2). Dredd's loop has the same shape - `jev` lines, keywords and seat questions tuned by hand
 * against eval/asks.json and eval/seats.json - so two of the paper's screens fit it as they are:
 *
 *   - THE LEAKAGE SCREEN (rrsi/critic.py): a change that writes the evaluation set's own words into the thing being
 *     tuned is memorizing the gold, not generalizing. `leakageSuspects` is its deterministic half: a keyword, or a
 *     four-word run of a `jev` line, that the change ADDED and that sits verbatim in one or two gold texts. A phrase
 *     that many gold texts share is ordinary vocabulary, not a lifted answer.
 *   - THE NOISE BAND (rrsi/calibrate.py): a gain no bigger than the spread between two runs of the SAME code is not a
 *     gain. A full Jev eval is a paid, stochastic run (the same two sentences scored 55/55 and 51/55 in two orders,
 *     2026-09-23), so "compare its tally with the last run's" needs a band. `noiseBand` measures it from repeated runs
 *     of unchanged code, paired per ask; `againstNoise` reads a move through it, against the last run and against the
 *     best run on record (the paper's floor: S* - delta, so no line walks downhill one noise-sized step at a time).
 *     `partBand` and `partAgainstNoise` do the same for the seat pick (per room) and the expert routing (per unit),
 *     which a seat question moves and the asks' band never saw (2026-10-10).
 *
 * And one read that is not RRSI's (2026-10-07):
 *
 *   - THE PAIRED VERDICT (tester-army/e2e scripts/bench-ab/stats.ts): a seeded bootstrap interval of the mean paired
 *     difference, read against a fixed dead zone into better, worse, same or unresolved. SUE's A/B decides by it
 *     (sue/lib/sue-ab.mjs), and Dredd's A/B shows it as the gold read: whether a move would survive another draw
 *     of asks of the same kind. Unresolved is an answer: the interval straddles an edge of the dead zone, so the
 *     measurement cannot yet tell the change from no change.
 *
 * Ideas only and written fresh, but for the paired verdict below, ported from tester-army/e2e. Pure functions: ab.mjs,
 * eval.mjs and the hunt do the reading.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { tokens } from "../../lib/shared/likeness.mjs";

/** A phrase found in more gold texts than this is shared vocabulary ("the page"), not one ask's words. */
export const LIFT_MAX_GOLD = 2;
/** A `jev` line is screened by runs of this many words: short enough to catch a lifted clause, long enough to skip idiom. */
export const JEV_RUN = 4;

function words(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

/** Does `hay` (a word list) hold `needle` (a word list) as one contiguous run? */
function holds(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (hay[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

function runs(list, n) {
  const out = new Set();
  for (let i = 0; i + n <= list.length; i += 1) out.add(list.slice(i, i + n).join(" "));
  return out;
}

/** The fields where a bench instrument or a seat says what it is FOR, in its own words (never its `jev` or keywords). */
const OWN_WORDS = ["name", "judges", "when", "seatTitle", "oneLiner", "brief", "playbook", "modeledOn"];

/**
 * The lines a change ADDED that are lifted verbatim from the gold. `base` and `head` are the tuned items before and
 * after ({ id, jev, keywords }: bench instruments or seat files), `gold` the texts they are judged on ({ id, text }),
 * `heldOut` the gold ids the held-out check owns. Returns [{ item, kind: "keyword" | "jev", phrase, gold, heldOut }].
 * Two derived filters keep it to lifts (the first real run, 2026-09-27, flagged "should the" and "the copy" beside the
 * one line that had broken a held-out ask): a phrase needs two content words (routing.mjs `tokens`: no stop words, no
 * two-letter scraps), and a phrase the item's own description already uses is its purpose's vocabulary ("terms of
 * service" on the Legal room), not an ask's words.
 */
export function leakageSuspects({ base = [], head = [], gold = [], heldOut = new Set() } = {}) {
  const texts = gold.map((g) => ({ id: g.id, w: words(g.text) }));
  const whereFound = (phraseWords) => texts.filter((t) => holds(t.w, phraseWords)).map((t) => t.id);
  const before = new Map(base.map((b) => [b.id, b]));
  const out = [];
  let own = [];
  const flag = (item, kind, phrase, found) => {
    if (!found.length || found.length > LIFT_MAX_GOLD) return false;
    if (tokens(phrase).length < 2 || holds(own, words(phrase))) return false;
    out.push({ item, kind, phrase, gold: found, heldOut: found.filter((id) => heldOut.has(id)) });
    return true;
  };
  for (const h of head) {
    own = words(OWN_WORDS.map((f) => (typeof h[f] === "string" ? h[f] : h[f] ? JSON.stringify(h[f]) : "")).join(" fieldbreak "));
    const b = before.get(h.id);
    const had = new Set((b?.keywords || []).map((k) => String(k).toLowerCase().trim()));
    for (const k of h.keywords || []) {
      const key = String(k).toLowerCase().trim();
      const kw = words(key);
      if (had.has(key) || kw.length < 2) continue;
      flag(h.id, "keyword", key, whereFound(kw));
    }
    if (h.jev && h.jev !== b?.jev) {
      const old = runs(words(b?.jev), JEV_RUN);
      const seen = new Set();
      for (const run of runs(words(h.jev), JEV_RUN)) {
        if (old.has(run)) continue;
        const found = whereFound(run.split(" "));
        // One row per gold text a line lifted from: the first run found in it names it, the overlapping runs after it
        // are the same lift.
        const fresh = found.filter((id) => !seen.has(id));
        if (!fresh.length || found.length > LIFT_MAX_GOLD) continue;
        if (flag(h.id, "jev", run, fresh)) for (const id of fresh) seen.add(id);
      }
    }
  }
  return out;
}

/** Per-ask values a noise band is measured on: the numbers the eval prints for an arm, one ask at a time. */
export const NOISE_METRICS = {
  convPerfect: (s) => (s?.convMisses?.length ? 0 : 1),
  perfect: (s) => (s?.misses?.length ? 0 : 1),
  convMust: (s) => Number(s?.convMustHit) || 0,
  convMustNot: (s) => Number(s?.convNotHit) || 0,
};

/** Per-brief values the seat pick's band is measured on (eval.mjs scoreSeats), one room at a time. */
export const SEAT_NOISE_METRICS = {
  exact: (s) => (s?.exact ? 1 : 0),
  sit: (s) => Number(s?.sitHit) || 0,
  mustNot: (s) => Number(s?.notHit) || 0,
};

/** Per-unit values the expert routing's band is measured on (eval.mjs scoreExperts). */
export const EXPERT_NOISE_METRICS = {
  exact: (s) => (s?.exact ? 1 : 0),
  lead: (s) => (s?.leadHit ? 1 : 0),
  want: (s) => Number(s?.wantHit) || 0,
  extra: (s) => s?.extra?.length || 0,
};

/**
 * The parts of a results.json a band is measured on beside the asks: where each keeps its rows, the metrics it reads,
 * the groups a row counts in, and the metrics where fewer is better. A seat question moves both (it seats the hearings
 * and routes the homework), and two rewrites of Grandma Sue's moved the seat pick's exact 18 -> 14 and 18 -> 15 with no
 * band to read it through (2026-10-10). The seat pick groups by room, since a product-room number says nothing about
 * the tooling room's Adversary, and over `all`, the number the eval's seats table leads with; the routing is one group.
 */
export const NOISE_PARTS = {
  seats: { rows: (r) => r?.seats?.rows, metrics: SEAT_NOISE_METRICS, groups: (row) => ["all", row.room || "product"], fewer: [] },
  experts: { rows: (r) => r?.experts?.rows, metrics: EXPERT_NOISE_METRICS, groups: () => ["all"], fewer: ["extra"] },
};

/** The rows `arm` graded, by id: a row it never graded (an ask Jev left unanswered) is no sample. */
function perItem(rows, arm) {
  const m = new Map();
  for (const r of rows || []) if (r.arms?.[arm]?.s) m.set(r.id, r.arms[arm].s);
  return m;
}

function perAsk(results, arm) {
  return perItem(results?.rows, arm);
}

/** `all` first, then the rooms by name: the order the eval's seats table prints them. */
function groupNames(rowLists, spec) {
  const names = new Set(rowLists.flatMap((rows) => (rows || []).flatMap((row) => spec.groups(row))));
  return [...names].sort((a, b) => (a === "all" ? -1 : b === "all" ? 1 : a.localeCompare(b)));
}

function groupTable(results, spec, name, arm) {
  return perItem(
    (spec.rows(results) || []).filter((row) => spec.groups(row).includes(name)),
    arm,
  );
}

/**
 * The paired-difference math under a noise band, for any items and any numbers (Dredd's asks, or anything else run
 * twice on unchanged code).
 * `tables` is a list of Map(itemId -> sample), one per run of UNCHANGED code; `metrics` is { name: (sample) => number }.
 * Per pair of tables the null difference of a metric's total is D = sum over shared items of (a - b); its variance is
 * estimated by sum (a - b)^2 averaged over the pairs, so delta = z * sd. Returns null under two tables, else
 * { z, runs, pairs, metrics: { name: { sumSq, sd, delta, diffs } }, flips: { name: Map(itemId -> pairs where the
 * metric differed) } }.
 */
export function pairedBand(tables, metrics, { z = 2 } = {}) {
  if (tables.length < 2) return null;
  const acc = {};
  const flips = {};
  let pairs = 0;
  for (const name of Object.keys(metrics)) {
    acc[name] = { sumSq: 0, diffs: [] };
    flips[name] = new Map();
  }
  for (let i = 0; i < tables.length; i += 1)
    for (let j = i + 1; j < tables.length; j += 1) {
      pairs += 1;
      const shared = [...tables[i].keys()].filter((id) => tables[j].has(id));
      for (const [name, read] of Object.entries(metrics)) {
        let d = 0;
        let sq = 0;
        for (const id of shared) {
          const x = read(tables[i].get(id)) - read(tables[j].get(id));
          d += x;
          sq += x * x;
          if (x !== 0) flips[name].set(id, (flips[name].get(id) || 0) + 1);
        }
        acc[name].sumSq += sq;
        acc[name].diffs.push(d);
      }
    }
  const out = { z, runs: tables.length, pairs, metrics: {}, flips };
  for (const [name, m] of Object.entries(acc)) {
    const sd = Math.sqrt(m.sumSq / pairs);
    out.metrics[name] = { sumSq: m.sumSq, sd: Math.round(sd * 1000) / 1000, delta: Math.round(z * sd * 1000) / 1000, diffs: m.diffs };
  }
  return out;
}

/*
 * THE PAIRED VERDICT. Ported from tester-army/e2e scripts/bench-ab/stats.ts at b7ba009 (Apache-2.0, Copyright 2026
 * TesterArmy, Inc.; its NOTICE: "This product includes software developed at TesterArmy, Inc. (https://tester.army)").
 * seededRandom (mulberry32), quantile, median, verdictOf and the resampling loop are e2e's, in JavaScript; verdictOf's
 * words are direction-neutral (lower | higher for e2e's faster | slower). Changed: the statistic. e2e bootstraps the
 * median of ln(head / base); SUE's per-persona moves are small counts with zeros and ternary steps, so a ratio is
 * undefined and the median of eight sits at 0 while one persona stops finishing (2026-10-07: 18 of 64 metric rows on
 * disk gave a zero-width median interval). pairedVerdict bootstraps the MEAN of the per-item paired differences.
 */

/** A deterministic PRNG (mulberry32), so a bootstrap is reproducible from its seed. */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The `q` quantile of `values` by linear interpolation; NaN for none. */
export function quantile(values, q) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * q;
  const lower = Math.floor(position);
  const low = sorted[lower];
  return low + (sorted[Math.ceil(position)] - low) * (position - lower);
}

/** The median of `values` (e2e's statistic; kept beside the mean so the change of statistic is visible, not silent). */
export function median(values) {
  return quantile(values, 0.5);
}

const meanOf = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);

/**
 * Where a change interval sits against the dead zone (-threshold, +threshold): wholly below it is lower, wholly above
 * higher, wholly inside the same, and one that straddles an edge is not resolved yet.
 */
export function verdictOf(low, high, threshold) {
  if (high < -threshold) return "lower";
  if (low > threshold) return "higher";
  if (low > -threshold && high < threshold) return "same";
  return "unresolved";
}

/**
 * A percentile bootstrap of `stat` over `values`: `resamples` draws with replacement from a seeded PRNG, the interval
 * at `level` read off their spread. -> { estimate, low, high, level, n }; NaN throughout for no values.
 */
export function bootstrapInterval(values, stat, { level = 0.95, resamples = 4000, seed = 1 } = {}) {
  if (!values.length) return { estimate: Number.NaN, low: Number.NaN, high: Number.NaN, level, n: 0 };
  const random = seededRandom(seed);
  const stats = [];
  const draw = Array.from({ length: values.length }, () => 0);
  for (let round = 0; round < resamples; round += 1) {
    for (let index = 0; index < values.length; index += 1) draw[index] = values[Math.floor(random() * values.length)];
    stats.push(stat(draw));
  }
  const tail = (1 - level) / 2;
  return { estimate: stat(values), low: quantile(stats, tail), high: quantile(stats, 1 - tail), level, n: values.length };
}

/**
 * The four-way verdict on paired differences (head - base, one per item): the bootstrap of their mean read against
 * +-threshold, in the metric's own unit. No items: NaN and unresolved; one item: its interval, and unresolved, since one
 * item cannot tell a change from that item's own weather.
 * -> { estimate, low, high, level, n, threshold, verdict: "better" | "worse" | "same" | "unresolved", resolved }
 */
export function pairedVerdict(diffs, { threshold, higherIsBetter = true, level, resamples, seed } = {}) {
  const interval = bootstrapInterval(diffs, meanOf, { level, resamples, seed });
  const side = interval.n < 2 ? "unresolved" : verdictOf(interval.low, interval.high, threshold);
  const up = higherIsBetter ? "better" : "worse";
  const down = higherIsBetter ? "worse" : "better";
  const verdict = side === "higher" ? up : side === "lower" ? down : side;
  return { ...interval, threshold, verdict, resolved: verdict !== "unresolved" };
}

/**
 * The noise band from R >= 2 runs of UNCHANGED code (rrsi/calibrate.py, repeated-evaluation branch, paired per ask).
 * For each pair of runs the null difference of a total is D = sum over shared asks of (a_i - b_i); with no change
 * between the runs E[D] = 0, so Var(D) is estimated by sum (a_i - b_i)^2, averaged over the pairs. delta = z * sd(D):
 * an unchanged judge clears it about 97.5% of the time at z = 2. Also names the asks whose convened verdict flipped
 * between runs of the same code - chasing one of those is chasing a coin.
 */
export function noiseBand(runList, { arm = "jev", z = 2 } = {}) {
  const tables = runList.map((r) => perAsk(r, arm)).filter((t) => t.size);
  const band = pairedBand(tables, NOISE_METRICS, { z });
  if (!band) return null;
  const out = { arm, z, runs: band.runs, pairs: band.pairs, metrics: {}, unstable: [] };
  for (const [name, m] of Object.entries(band.metrics)) out.metrics[name] = { sd: m.sd, delta: m.delta, diffs: m.diffs };
  out.unstable = unstableOf(band.flips.convPerfect, band.pairs);
  return out;
}

function unstableOf(flips, pairs) {
  return [...flips.entries()].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, flips: n, pairs }));
}

/**
 * The seat pick's or the expert routing's band (`part`, a key of NOISE_PARTS) from R >= 2 runs of UNCHANGED code: the
 * asks' paired math (pairedBand) per group, so per room and over all briefs for the seats, over every unit for the
 * routing. Each group names the briefs or units whose exact verdict flipped between runs: the part's own coins.
 * Runs that never graded the part (an --asks-only run has no seats) are not samples of it.
 * -> null under two such runs, else { arm, z, runs, pairs, groups: { name: { items, metrics: { m: { sd, delta, diffs } },
 * unstable: [{ id, flips, pairs }] } } }
 */
export function partBand(runList, part, { arm = "jev", z = 2 } = {}) {
  const spec = NOISE_PARTS[part];
  const graded = runList.filter((r) => perItem(spec.rows(r), arm).size);
  if (graded.length < 2) return null;
  const groups = {};
  let pairs = 0;
  for (const name of groupNames(graded.map(spec.rows), spec)) {
    const tables = graded.map((r) => groupTable(r, spec, name, arm));
    const band = pairedBand(tables, spec.metrics, { z });
    pairs = band.pairs;
    const metrics = {};
    for (const [m, v] of Object.entries(band.metrics)) metrics[m] = { sd: v.sd, delta: v.delta, diffs: v.diffs };
    groups[name] = { items: Math.max(...tables.map((t) => t.size)), metrics, unstable: unstableOf(band.flips.exact, band.pairs) };
  }
  return { arm, z, runs: graded.length, pairs, groups };
}

function total(table, read, ids) {
  let s = 0;
  for (const id of ids) s += read(table.get(id));
  return s;
}

/**
 * Per metric, `now`'s move from `before` and its gap to the best of `history` (Maps of item -> sample), each over the
 * items both graded. The best run is the one `now` trails most in the metric's own direction (`fewer`: the metrics where
 * a smaller count is better, so their floor is the best run's lowest count and sitting above it is the slide).
 */
function readThrough({ now, before, history, metrics, deltaOf, fewer = new Set() }) {
  const rows = [];
  for (const [name, read] of Object.entries(metrics)) {
    const delta = deltaOf(name);
    const sign = fewer.has(name) ? -1 : 1;
    const row = { metric: name, delta: delta ?? null };
    if (before) {
      const ids = [...now.keys()].filter((id) => before.has(id));
      const a = total(before, read, ids);
      const b = total(now, read, ids);
      row.last = { before: a, after: b, move: b - a, items: ids.length };
      row.reading = delta == null ? "no band" : Math.abs(b - a) > delta ? "beyond noise" : "within noise";
    }
    let best = null;
    for (const t of history) {
      const ids = [...now.keys()].filter((id) => t.has(id));
      if (!ids.length) continue;
      const gap = total(now, read, ids) - total(t, read, ids);
      if (!best || sign * gap < sign * best.gap) best = { gap, items: ids.length };
    }
    if (best) row.floor = { gap: best.gap, below: delta != null && sign * best.gap < -delta };
    rows.push(row);
  }
  return rows;
}

/**
 * One run read through the band: per metric, the move from `before` and the gap to the best of `history` (the floor),
 * each over the asks both runs graded. reading: "beyond noise" | "within noise" | "no band". A move within the band is
 * not a result; a run under best - delta has walked downhill whatever the last step looked like.
 */
export function againstNoise({ before = null, history = [], after, noise = null, arm = "jev" } = {}) {
  return readThrough({
    now: perAsk(after, arm),
    before: before && perAsk(before, arm),
    history: history.map((h) => perAsk(h, arm)),
    metrics: NOISE_METRICS,
    deltaOf: (name) => noise?.metrics?.[name]?.delta,
  });
}

/**
 * againstNoise for the seat pick or the routing (`part`), through that part's band (partBand; eval/noise.json keeps it
 * under the part's name), one row per group and metric: [{ group, metric, delta, last, reading, floor }].
 */
export function partAgainstNoise({ part, before = null, history = [], after, noise = null, arm = "jev" } = {}) {
  const spec = NOISE_PARTS[part];
  const out = [];
  for (const name of groupNames([spec.rows(after)], spec)) {
    const table = (r) => groupTable(r, spec, name, arm);
    const rows = readThrough({
      now: table(after),
      before: before && table(before),
      history: history.map(table),
      metrics: spec.metrics,
      deltaOf: (m) => noise?.groups?.[name]?.metrics?.[m]?.delta,
      fewer: new Set(spec.fewer),
    });
    for (const row of rows) out.push({ group: name, ...row });
  }
  return out;
}

/**
 * Which code a run measured: the bytes of every decision file (hunt.mjs DECISION_PATHS, passed in so this module does
 * not import the hunt). Two runs with the same hash asked Jev the same questions and decided with the same rules, so
 * the difference between them is noise and nothing else.
 */
export function decisionHash(root, paths) {
  const h = createHash("sha1");
  const files = [];
  for (const p of paths) {
    const abs = path.join(root, p);
    if (!existsSync(abs)) continue;
    if (statSync(abs).isDirectory()) for (const f of readdirSync(abs).sort()) files.push(path.join(abs, f));
    else files.push(abs);
  }
  for (const f of files) {
    if (!statSync(f).isFile()) continue;
    h.update(path.relative(root, f).replace(/\\/g, "/"));
    h.update(readFileSync(f));
  }
  return h.digest("hex").slice(0, 16);
}

/**
 * The saved full Jev runs under `root`, newest first: [{ file, results }]. A run only counts as a sample of the judge
 * when Jev answered every ask itself - a partial run (--only, --limit), a verdicts run, a replay (someone else's
 * answers) or a run that fell back to the keywords is not one. `part` is the half Jev must have graded: "asks", or a
 * key of NOISE_PARTS (an --experts-only run is a sample of the routing and of nothing else). Reads at most `scan`
 * folders: each file holds every answer, and a noise band or a floor needs a handful.
 */
export function fullJevRuns(root, { limit = 8, exclude = null, scan = 40, part = "asks" } = {}) {
  const rowsOf = part === "asks" ? (r) => r?.rows : NOISE_PARTS[part].rows;
  const dir = path.join(root, "tmp", "dredd");
  if (!existsSync(dir)) return [];
  const names = readdirSync(dir)
    .filter((f) => /^eval-\d{8}T?\d+/.test(f))
    .sort()
    .reverse()
    .slice(0, scan);
  const out = [];
  for (const name of names) {
    const abs = path.join(dir, name);
    if (exclude && path.resolve(abs) === path.resolve(exclude)) continue;
    const file = path.join(abs, "results.json");
    if (!existsSync(file)) continue;
    let results;
    try {
      results = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      continue;
    }
    const jev = rowsOf(results)?.[0]?.arms?.jev;
    if (!jev || results.partial || results.gold === "verdicts" || results.jevFallbacks || results.replay || jev.note === "replayed")
      continue;
    out.push({ file: path.relative(root, file).replace(/\\/g, "/"), results });
    if (out.length >= limit) break;
  }
  return out;
}

/** The noise file of record: dredd/eval/noise.json, committed, so every machine reads one band. */
export function readNoise(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}
