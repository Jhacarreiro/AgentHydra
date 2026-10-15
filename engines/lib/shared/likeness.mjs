// vendored from Connections infra/shared/text/likeness.mjs @ dd3d47a7ad
// How alike pieces of text read, with no model: each text's stemmed words weighted by TF-IDF over the set it belongs
// to, two texts compared by cosine. One source for every "do these say the same thing" question asked without a model:
// Dredd's routing pass (which instruments describe the same asks, tools/dredd/lib/routing.mjs) and 4man's
// consolidation (which tasks or memories are the same work, tools/4man/lib/duplicates.mjs). Import-free, so a tool
// may vendor it.

const STOP = new Set(
  "the a an and or but of to in on at for with from by is are was were be been being this that these those it its our we you your they them their me my he she his her as if so than then too very just not no yes do does did done have has had can could should would will shall may might must about into over under out up down off again more most some any all each every both few own same other such only what which who whom when where why how there here one also get gets any it's".split(
    " ",
  ),
);

/** A light suffix strip, enough that "convened", "convenes" and "convening" meet; never shorter than three letters. */
export function stem(word) {
  let w = word;
  for (const [tail, put] of [
    ["ies", "y"],
    ["ing", ""],
    ["ed", ""],
    ["es", ""],
    ["s", ""],
    ["ly", ""],
    ["er", ""],
  ]) {
    if (w.endsWith(tail) && w.length - tail.length + put.length >= 3) {
      w = w.slice(0, -tail.length) + put;
      break;
    }
  }
  return w;
}

/** A text's words: lower case, links dropped, three letters or more, stop words out, each stemmed. */
export function tokens(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .split(/[^a-z0-9']+/)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map(stem);
}

function counts(list) {
  const m = new Map();
  for (const t of list) m.set(t, (m.get(t) || 0) + 1);
  return m;
}

function unit(weights) {
  const norm = Math.sqrt([...weights.values()].reduce((s, v) => s + v * v, 0));
  if (norm) for (const [t, v] of weights) weights.set(t, v / norm);
  return weights;
}

/** The cosine of two unit vectors (Maps of term to weight): 1 is the same words in the same proportions, 0 none shared. */
export function cosine(a, b) {
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  let s = 0;
  for (const [t, v] of small) s += v * (big.get(t) || 0);
  return s;
}

/**
 * The TF-IDF index over `docs` ([{ id, text }]): an idf per term, one unit vector per doc, and `vectorize` for a text
 * outside the set (an ask to rank against it). A word every doc uses weighs little; a word two docs share and nothing
 * else uses weighs most, which is what makes two of them read alike.
 */
export function likenessIndex(docs) {
  const tf = docs.map((d) => counts(tokens(d.text)));
  const df = new Map();
  for (const d of tf) for (const t of d.keys()) df.set(t, (df.get(t) || 0) + 1);
  const n = tf.length;
  const idf = new Map([...df].map(([t, k]) => [t, Math.log((n + 1) / (k + 1)) + 1]));
  const vectorize = (counted) =>
    unit(new Map([...counted].filter(([t]) => idf.has(t)).map(([t, k]) => [t, (1 + Math.log(k)) * idf.get(t)])));
  return {
    ids: docs.map((d) => d.id),
    vectors: new Map(docs.map((d, i) => [d.id, vectorize(tf[i])])),
    vectorize: (text) => vectorize(counts(tokens(text))),
  };
}

/** Every pair of the index's docs at `threshold` cosine or more, most alike first; `skip(a, b)` leaves a pair out. */
export function alikePairs(index, { threshold, skip = () => false }) {
  const out = [];
  const { ids, vectors } = index;
  for (let i = 0; i < ids.length; i += 1)
    for (let j = i + 1; j < ids.length; j += 1) {
      const sim = cosine(vectors.get(ids[i]), vectors.get(ids[j]));
      if (sim >= threshold && !skip(ids[i], ids[j])) out.push({ a: ids[i], b: ids[j], sim: Math.round(sim * 1000) / 1000 });
    }
  return out.sort((x, y) => y.sim - x.sim);
}

/** The pairs joined into groups (two pairs sharing a doc are one group), biggest first: [{ ids, sim }], `sim` the closest pair's. */
export function alikeGroups(pairs) {
  const parent = new Map();
  const find = (x) => {
    while (parent.get(x) !== x) {
      parent.set(x, parent.get(parent.get(x)));
      x = parent.get(x);
    }
    return x;
  };
  for (const { a, b } of pairs) {
    if (!parent.has(a)) parent.set(a, a);
    if (!parent.has(b)) parent.set(b, b);
    parent.set(find(a), find(b));
  }
  const groups = new Map();
  for (const id of parent.keys()) {
    const root = find(id);
    if (!groups.has(root)) groups.set(root, { ids: [], sim: 0 });
    groups.get(root).ids.push(id);
  }
  for (const { a, sim } of pairs) {
    const g = groups.get(find(a));
    g.sim = Math.max(g.sim, sim);
  }
  return [...groups.values()].sort((x, y) => y.ids.length - x.ids.length || y.sim - x.sim);
}
