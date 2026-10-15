/**
 * routing.mjs - the bench's own words, measured with no model: do two instruments describe the same asks, and does
 * each gold ask read closest to the instruments it must convene?
 *
 * WHY (harvest, 2026-09-24, ideas gh-addyosmani-agent-skills~eb60399 and gh-anthropics-skills~d2ea765): which
 * instrument a docket convenes rests on one `jev` question and one keyword list per instrument, tuned by hand. The
 * eval grades Jev and the keywords against the gold, but nothing said when two instruments' lines had drifted into
 * describing the same asks - so the two competed for them and Jev's answer between them was a coin. This is the
 * zero-token lens on that: every routable instrument's name (twice), `when`, `jev` line and keywords become one
 * stemmed TF-IDF vector; any two at COLLIDE cosine or more are a collision; each gold ask is ranked against the
 * vectors, and a mustNot instrument has to be strictly OUTRANKED by an instrument the ask must convene (a tie at
 * zero is a miss, so an ask no line mentions cannot pass vacuously). Each ask's own hash bucket holds about a
 * quarter of the gold out, and the rewrite brief shows only the other three quarters' misses, so a line tuned
 * against the brief is judged on asks it never saw. Written fresh; the two upstream ideas are MIT and Apache-2.0.
 * The words, the weights and the cosine are infra/shared/text/likeness.mjs, which 4man's consolidation reads too.
 */
import { alikePairs, cosine, likenessIndex } from "../../lib/shared/likeness.mjs";

/** Two instruments whose lines read this alike (cosine) are a collision: the upstream gate's bar. */
export const COLLIDE = 0.75;
/** An owner ranked within this many places counts as routed (the rank-1 ratio is the stricter number). */
export const TOP_K = 3;
/** One ask in HOLDOUT_EVERY is held out of the rewrite brief. */
export const HOLDOUT_EVERY = 4;

/** The text an instrument is routed by: the name counts twice (it is the one line every doc repeats). */
export function instrumentText(inst) {
  return [inst.name, inst.name, inst.when, inst.jev, ...(inst.keywords || [])].filter(Boolean).join("\n");
}

/** The instruments a docket decides on: the ones with a `jev` line. `always` rungs are on every docket and never compete. */
export function routable(bench) {
  return (bench.instruments || []).filter((i) => i.jev);
}

/** The TF-IDF index over the routable instruments (infra/shared/text/likeness.mjs): an idf per term and one unit vector per instrument. */
export function buildIndex(bench) {
  const insts = routable(bench);
  // A candidate bench (--routing-against) is read raw, not through loadBench, so a duplicate id is refused here: the
  // vectors Map would otherwise keep one of the two silently.
  const seen = new Set();
  for (const inst of insts) {
    if (seen.has(inst.id)) throw new Error(`bench: duplicate instrument id ${inst.id}`);
    seen.add(inst.id);
  }
  return likenessIndex(insts.map((inst) => ({ id: inst.id, text: instrumentText(inst) })));
}

/** Every pair of instruments at `threshold` cosine or more, most alike first. */
export function collisions(index, { threshold = COLLIDE } = {}) {
  return alikePairs(index, { threshold });
}

export function rankAsk(index, ask) {
  const q = index.vectorize(ask);
  return index.ids
    .map((id) => ({ id, score: Math.round(cosine(q, index.vectors.get(id)) * 1e4) / 1e4 }))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/** FNV-1a over a string: a stable bucket for one ask, the same on every machine and run. */
function fnv(s) {
  let h = 2166136261;
  for (const ch of String(s)) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  return h;
}

/**
 * Whether one gold ask is held out: its own bucket, a hash of its domain and id, never its place in a list. WHY: a
 * split by position moved asks in or out of the holdout whenever the list was filtered (--only, --limit, a replay)
 * or one gold ask was added, so the eval could name an ask the brief treats as held out. Roughly one in
 * HOLDOUT_EVERY of every domain.
 */
export function isHeldOut(ask, { every = HOLDOUT_EVERY } = {}) {
  return fnv(`${ask.domain ?? "none"}\n${ask.id}`) % every === 0;
}

/** The held-out gold: every ask whose own bucket holds it out, whatever else is in the list. */
export function holdoutIds(asks, { every = HOLDOUT_EVERY } = {}) {
  return new Set(asks.filter((a) => isHeldOut(a, { every })).map((a) => a.id));
}

/**
 * One gold ask against the ranking. Only instruments that can route count: an owner with no `jev` line (an `always`
 * rung) is on every docket already. rank1: the top instrument is one the ask must convene (and scored above zero);
 * topK: an owner is within TOP_K; pairs: each mustNot strictly outranked by the best owner.
 */
export function scoreRouting(index, item, { k = TOP_K } = {}) {
  const ranking = rankAsk(index, item.ask);
  const place = new Map(ranking.map((r, i) => [r.id, { rank: i + 1, score: r.score }]));
  const owners = [...new Set([...(item.must || []), ...(item.anyOf || [])])].filter((id) => place.has(id));
  if (!owners.length) return null;
  const best = owners.map((id) => ({ id, ...place.get(id) })).sort((a, b) => a.rank - b.rank)[0];
  const misses = [];
  const rank1 = best.rank === 1 && best.score > 0;
  const topK = best.rank <= k && best.score > 0;
  if (!topK) misses.push(`owner ${best.id} ranked ${best.rank} (score ${best.score}), behind ${ranking[0].id} (${ranking[0].score})`);
  let pairsHit = 0;
  const rivals = (item.mustNot || []).filter((id) => place.has(id));
  for (const id of rivals) {
    if (best.score > place.get(id).score) pairsHit += 1;
    else misses.push(`mustNot ${id} (${place.get(id).score}) not outranked by ${best.id} (${best.score})`);
  }
  return { rank1, topK, pairsHit, pairsN: rivals.length, best: best.id, top: ranking[0].id, misses };
}

export function tallyRouting(rows) {
  const t = { n: rows.length, rank1: [0, rows.length], topK: [0, rows.length], pairs: [0, 0] };
  for (const r of rows) {
    if (r.s.rank1) t.rank1[0] += 1;
    if (r.s.topK) t.topK[0] += 1;
    t.pairs[0] += r.s.pairsHit;
    t.pairs[1] += r.s.pairsN;
  }
  return t;
}

/** The whole routing pass over the bench and the gold: collisions, every graded ask, and the train / holdout tallies. */
export function routingReport(bench, asks, { threshold = COLLIDE, k = TOP_K } = {}) {
  const index = buildIndex(bench);
  const held = holdoutIds(asks);
  const rows = asks.map((a) => ({ id: a.id, holdout: held.has(a.id), s: scoreRouting(index, a, { k }) })).filter((r) => r.s);
  return {
    collisions: collisions(index, { threshold }),
    threshold,
    rows,
    train: tallyRouting(rows.filter((r) => !r.holdout)),
    holdout: tallyRouting(rows.filter((r) => r.holdout)),
    all: tallyRouting(rows),
  };
}

/**
 * The gate the eval exits on: every collision fails it, and so does a training rank-1 ratio under the `minRank1`
 * ratchet (when one is set). The ratchet reads the training asks only, so its message never prints a number the
 * held-out asks moved. A report with no graded asks cannot pass a ratchet: 0 of 0 is not a ratio.
 */
export function routingGate(report, { minRank1 = null } = {}) {
  const failures = report.collisions.map((c) => `collision ${c.a} ~ ${c.b} at ${c.sim} (bar ${report.threshold})`);
  if (minRank1 !== null) {
    const [hit, n] = report.train.rank1;
    const ratio = n ? hit / n : 0;
    if (ratio < minRank1)
      failures.push(`rank-1 ${hit}/${n} (${Math.round(ratio * 1000) / 1000}) is under the --min-rank1 ratchet ${minRank1}`);
  }
  return { ok: !failures.length, failures };
}

/** One number per report for the held-out asks: rank-1 hits, top-k hits and mustNot pairs won, summed. */
export function holdoutScore(report) {
  const t = report.holdout;
  return t.rank1[0] + t.topK[0] + t.pairs[0];
}

/**
 * A rewritten bench against the current one, decided on the held-out asks alone (the upstream loop keeps the
 * iteration with the best held-out score). A candidate that adds a collision is discarded whatever it scores, and a
 * tie is discarded too: a rewrite has to earn its churn. Only the verdict leaves this function with the holdout in
 * it - the caller prints the training tallies - so the next rewrite is still made blind to the held-out asks.
 */
export function judgeRewrite(current, candidate) {
  if (candidate.collisions.length > current.collisions.length)
    return { keep: false, why: `the candidate adds ${candidate.collisions.length - current.collisions.length} collision(s)` };
  const before = holdoutScore(current);
  const after = holdoutScore(candidate);
  if (after > before) return { keep: true, why: "the held-out asks route better" };
  return { keep: false, why: after === before ? "the held-out asks route no better" : "the held-out asks route worse" };
}

/**
 * The rewrite brief: per instrument, the TRAINING asks it lost (it should have ranked and did not) or stole (a
 * mustNot it was not outranked on), with the ask text. Held-out asks and every held-out number are left out on
 * purpose: whoever rewrites a `jev` or `when` line from this brief is then judged on asks the brief never showed.
 */
export function rewriteBrief(report, asks) {
  const text = new Map(asks.map((a) => [a.id, a.ask]));
  const by = new Map();
  const add = (id, line) => {
    if (!by.has(id)) by.set(id, []);
    by.get(id).push(line);
  };
  for (const r of report.rows) {
    if (r.holdout) continue;
    if (!r.s.topK) add(r.s.best, `lost "${text.get(r.id)}" to ${r.s.top}`);
    for (const m of r.s.misses) {
      const stole = /^mustNot (\S+)/.exec(m);
      if (stole) add(stole[1], `stole "${text.get(r.id)}" from ${r.s.best}`);
    }
  }
  const lines = [`routing rewrite brief: ${report.train.n} training asks (the held-out quarter and its score are not shown)`];
  for (const c of report.collisions)
    lines.push(`collision ${c.a} ~ ${c.b} at ${c.sim}: make one of the two lines say what the other is not`);
  for (const [id, rows] of [...by].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))) {
    lines.push(`${id} (${rows.length}):`);
    for (const row of rows) lines.push(`  ${row}`);
  }
  if (lines.length === 1) lines.push("nothing to rewrite: every training ask routes and no two lines collide");
  return lines.join("\n");
}
