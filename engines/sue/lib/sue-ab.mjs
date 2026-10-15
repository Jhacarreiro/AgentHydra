/**
 * sue-ab - the measurement a SUE change owes: the old arm of visits against the new arm, over the same people and the
 * same builds, read as better, worse, same or unresolved. Pure but for the file reads in `readVisits`.
 * =============================================================================================================
 *
 * Owner, 2026-10-04: "RRSI, or RSI, whichever you want to call it, needs to always be implemented during sue, dread,
 * et cetera." Dredd's gate (dredd/ab.mjs, .claude/rules/dredd-self-improvement.md) measures old code against new
 * over the same gold; SUE has no gold, but every fresh visit records the identity it ran under (`reuse.json`: the
 * engine, driver and hands hashes, and the live build ids), so two arms of visits on one build ARE old against new.
 * A flag from the overfit screen (the idea of Dredd's `leakageSuspects`, same function) never decides the verdict.
 *
 * THE READ (2026-10-07, after tester-army/e2e scripts/bench-ab, Apache-2.0). Behaviour first: a Sue whose path (her
 * ordered routes, `routesOf`) differs between the arms, or between two rounds of one arm, did different work, so she
 * is named and left out of the numbers that measure what she perceived on her path (e2e's compare.ts `caseChanges`,
 * ported as `pathChanges`). Then per metric, per persona: her mean per visit in the head minus in the base, and a
 * seeded bootstrap of the mean of those (`pairedVerdict`, lib/regularizers.mjs) read against a fixed dead zone. A
 * verdict needs two rounds of each arm, and a round is owed only while the verdict is unresolved and under the budget
 * (`nextRound`, e2e's --min-pairs / --max-pairs). The old read, a band from same-arm round pairs, read every single
 * persona's finish flip as beyond noise (its band for finishing was 0) and had no answer but "no band" for the 11 of
 * 14 arms on disk that ran one round.
 *
 * A visit's numbers: notes (every line of findings.jsonl with a text, the body's and the Sue's own), characters (their
 * text length), problems (kinds annoyance, confusion, broken), typed (the problem notes that carry a typed claim,
 * lib/findings.mjs problemNote), stars and finished (the round row's, per person). A critic has no finish line, so its
 * `finished` counts 1. Notes, problems, stars and finished decide the verdict (a Sue who perceives less reports less, so
 * down on any of them is worse); characters and typed are shown, not judged.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { bootstrapInterval, leakageSuspects, pairedVerdict, quantile, seededRandom, verdictOf } from "../../dredd/lib/regularizers.mjs";
import { PROBLEM_NOTE_KINDS } from "./findings.mjs";

export const PROBLEM_KINDS = new Set(PROBLEM_NOTE_KINDS);
/** The metrics a verdict is read from. */
export const VERDICT_METRICS = ["notes", "problems", "stars", "finished"];
/**
 * The metrics shown beside them with an interval, never judged: a longer note is not a better one, and an arm from before
 * typed problems has none to type.
 */
export const SHOWN_METRICS = ["characters", "typed"];
export const METRICS = [...VERDICT_METRICS, ...SHOWN_METRICS];
/**
 * Outcomes every Sue has whichever path she took (e2e's test status), read over every shared persona. The rest measure
 * what she perceived on her path (e2e's timings) and are read over the personas whose path matched: a finish change
 * also changes her path (she never returns to the lesson list), so leaving her out of `finished` would delete its signal.
 */
export const OVER_EVERYONE = new Set(["finished"]);
/**
 * A base arm needs this many people in common with the head, and a metric this many people to be read over, or the
 * comparison is anecdote (pairedVerdict leaves fewer than two items unresolved for the same reason).
 */
export const MIN_SHARED_PEOPLE = 2;
/**
 * The dead zone per metric, in its own unit per visit: two thirds of one persona's same-arm spread, measured 2026-10-07
 * over 40 same-arm person-pairs of lift-v2 and lift-v2-engine (notes 3.03, problems 1.11, stars 0.42). Finishing never
 * moved between two rounds of one arm (0 of 40), so its zone only has to sit under one person in eight: the bootstrap's
 * edges land on multiples of 1/8 there, so a zone of exactly 0.125 would need five of eight to stop finishing before
 * reading worse, and 0.1 lets three. Frozen from one site and one 8-person panel: re-derive them for another.
 */
export const DEAD_ZONE = Object.freeze({ notes: 2, problems: 0.75, stars: 0.25, finished: 0.1 });
/** One round per arm cannot tell the change from that round's weather (arms run hours apart, not interleaved). */
export const MIN_ROUNDS_PER_ARM = 2;
/** The most any arm on disk ran; from 3 rounds to 4 the null interval narrows only 13%. */
export const MAX_ROUNDS_PER_ARM = 3;
/** e2e's bootstrap settings (stats.ts), so a report is reproducible from its seed. */
const STAT = Object.freeze({ level: 0.95, resamples: 4000, seed: 1 });

const READ = {
  notes: (v) => v.notes,
  characters: (v) => v.characters,
  problems: (v) => v.problems,
  typed: (v) => v.typed ?? 0,
  stars: (v) => v.stars,
  finished: (v) => v.finished,
};

const round3 = (n) => Math.round(n * 1000) / 1000;
const whoOf = (sueFolder) => sueFolder.replace(/^sue-\d+-/, "");
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

/** The rows of a series file, a re-reported round replacing its earlier row. */
export function readSeriesRows(roundsDir, series) {
  const file = path.join(roundsDir, `${series}.jsonl`);
  if (!existsSync(file)) return [];
  const byId = new Map();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      byId.set(row.id, row);
    } catch {
      /* a torn last line */
    }
  }
  return [...byId.values()];
}

/**
 * Every row an A/B reads for the named series: each series and its pinned-arm sibling `<series>-engine` (a round started
 * with --engine-ref writes there), once each. None at all throws, naming the folder: a product's rounds live in its own
 * workspace's .sue/rounds, and reading Connections' folder for them gave "0 fresh visits" with no hint (Raise Buddy,
 * 2026-10-12, six rounds spent before it was seen).
 */
export function seriesRows(roundsDir, series) {
  // A room's series is `<series>.focus`, its pinned arm's `<series>-engine.focus` (lib/rounds.mjs seriesKey).
  const sibling = (s) => {
    const dot = s.indexOf(".");
    const [base, kind] = dot < 0 ? [s, ""] : [s.slice(0, dot), s.slice(dot)];
    return base.endsWith("-engine") ? [s] : [s, `${base}-engine${kind}`];
  };
  const names = [...new Set(series.flatMap(sibling))];
  const rows = names.flatMap((s) => readSeriesRows(roundsDir, s));
  if (rows.length === 0)
    throw new Error(
      `no rounds for ${names.join(", ")} in ${roundsDir}: a product's rounds are in <its workspace>/.sue/rounds; pass --rounds-dir`,
    );
  return rows;
}

function findingsOf(file) {
  const out = [];
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const f = JSON.parse(line);
      if (typeof f?.text === "string" && f.text.trim()) out.push(f);
    } catch {
      /* skip a torn line */
    }
  }
  return out;
}

const groundTruthText = (gt) =>
  Object.values(gt && typeof gt === "object" ? gt : {})
    .flat()
    .filter((s) => typeof s === "string")
    .join(" ");

/** A page's route: host, path and hash, any query dropped (Lift routes by hash: /lift/student/#/play/<lesson>/class). */
export function routeOf(url) {
  try {
    const u = new URL(url);
    return `${u.host}${u.pathname}${u.hash.replace(/\?.*$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * A Sue's path: the routes of every trace.jsonl line that names a url (her hops and her tool calls alike), in order,
 * a route repeated back to back counted once. null when the visit has no trace. Measured 2026-10-07 over 144 armed
 * visits: her exact moves never repeat between two rounds of one arm (an LLM Sue never clicks the same way twice), the
 * set of routes never differs at all (the plan fixes her lesson), and this kept 22 of 24 personas stable within an arm
 * while naming the ones who stopped before the lesson list or came back to it.
 */
export function routesOf(traceFile) {
  let text;
  try {
    text = readFileSync(traceFile, "utf8");
  } catch {
    return null;
  }
  const out = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // a torn line
    }
    const route = typeof entry?.url === "string" ? routeOf(entry.url) : null;
    if (route && out[out.length - 1] !== route) out.push(route);
  }
  return out;
}

/**
 * Every fresh visit of the rows' rounds that has a reuse.json with `parts`: one object per visit. A visit without
 * parts (written before the parts existed) comes back with `arm: null` and belongs to no arm.
 */
export function readVisits({ rows, runsDir }) {
  const out = [];
  for (const row of rows) {
    const stars = new Map([...(row.each || []), ...(row.critics || [])].map((e) => [e.who, e]));
    for (const runId of row.runIds || []) {
      const dir = path.join(runsDir, runId);
      let folders;
      try {
        folders = readdirSync(dir).filter((d) => d.startsWith("sue-"));
      } catch {
        continue;
      }
      for (const f of folders) {
        const rec = readJson(path.join(dir, f, "reuse.json"));
        if (!rec || rec.round !== row.id) continue;
        const who = whoOf(f);
        const found = findingsOf(path.join(dir, f, "findings.jsonl"));
        const mine = stars.get(who) || {};
        const p = rec.parts;
        const manifest = readJson(path.join(dir, "manifest.json"));
        out.push({
          series: row.series,
          rowId: row.id,
          round: row.round,
          runId,
          who,
          at: rec.at || row.at || row.id,
          arm: p && p.engine && p.driver && p.hands ? { engine: p.engine, driver: p.driver, hands: p.hands } : null,
          docs: typeof p?.docs === "string" ? p.docs : null,
          // The commit a round pinned Sue's code at (round.mjs start --engine-ref), or null for the checkout's own code.
          engineCommit: row.engine?.commit ?? null,
          builds: rec.builds && typeof rec.builds === "object" ? rec.builds : {},
          notes: found.length,
          characters: found.reduce((n, x) => n + x.text.length, 0),
          problems: found.filter((x) => PROBLEM_KINDS.has(x.kind)).length,
          typed: found.filter((x) => PROBLEM_KINDS.has(x.kind) && x.problem && typeof x.problem === "object").length,
          stars: Number(mine.stars) || 0,
          finished: mine.finished === false ? 0 : 1,
          routes: routesOf(path.join(dir, f, "trace.jsonl")),
          text: found.map((x) => x.text).join(" "),
          expect: groundTruthText(manifest?.groundTruth),
        });
      }
    }
  }
  return out;
}

export const armKey = (a) => `${a.engine.slice(0, 12)}/${a.driver.slice(0, 12)}/${a.hands.slice(0, 12)}`;
const buildsKey = (b) =>
  Object.entries(b || {})
    .sort(([x], [y]) => x.localeCompare(y))
    .map(([u, id]) => `${u}=${id}`)
    .join(" ");

/** Arms by identity, newest visit first: { key, parts, visits, newest }. */
export function groupArms(visits) {
  const byKey = new Map();
  for (const v of visits) {
    if (!v.arm) continue;
    const key = armKey(v.arm);
    const arm = byKey.get(key) || { key, parts: v.arm, visits: [], newest: "" };
    arm.visits.push(v);
    if (v.at > arm.newest) arm.newest = v.at;
    byKey.set(key, arm);
  }
  return [...byKey.values()].sort((a, b) => b.newest.localeCompare(a.newest));
}

const matches = (arm, prefix) => Object.values(arm.parts).some((h) => h.startsWith(prefix));
/** The one commit every visit ran pinned at (round.mjs start --engine-ref), or null when any ran on the checkout's own code. */
const pinnedCommitOf = (vs) =>
  vs.length && vs.every((v) => v.engineCommit && v.engineCommit === vs[0].engineCommit) ? vs[0].engineCommit : null;
const peopleOf = (arm) => new Set(arm.visits.map((v) => v.who));
const buildSetsOf = (arm) => new Set(arm.visits.map((v) => buildsKey(v.builds)));

/**
 * The two arms to compare. Head: the arm whose engine, driver or hands hash starts with `head`, else the newest.
 * Base: likewise for `base`, else the newest other arm that shares a build set and two people with the head. Neither
 * named, two arms pinned at commits where `isAncestor(head, base)` holds swap: an A/B alternates its arms, so the
 * newest round is often the old engine's (lift-v2-engine, 2026-10-07: round B2 made the old engine the head).
 * `{ head, base, why }`; `base` is null with `why` when there is nothing to compare against.
 */
export function pickArms(visits, { base = null, head = null, isAncestor = null } = {}) {
  const arms = groupArms(visits);
  const h = head ? arms.find((a) => matches(a, head)) : arms[0];
  if (!h)
    return { head: null, base: null, why: head ? `no arm has a hash starting ${head}` : "no visit carries an identity (reuse.json parts)" };
  const others = arms.filter((a) => a !== h);
  let b;
  if (base) {
    b = others.find((a) => matches(a, base));
    if (!b) return { head: h, base: null, why: `no other arm has a hash starting ${base}` };
  } else {
    const headPeople = peopleOf(h);
    const headBuilds = buildSetsOf(h);
    b = others.find(
      (a) =>
        [...peopleOf(a)].filter((p) => headPeople.has(p)).length >= MIN_SHARED_PEOPLE && [...buildSetsOf(a)].some((k) => headBuilds.has(k)),
    );
    if (!b)
      return {
        head: h,
        base: null,
        why: `${arms.length} arm(s) on disk, none besides the head shares a build and ${MIN_SHARED_PEOPLE} people with it`,
      };
    const [hc, bc] = [pinnedCommitOf(h.visits), pinnedCommitOf(b.visits)];
    if (!head && isAncestor && hc && bc && hc !== bc && isAncestor(hc, bc)) return { head: b, base: h, why: null };
  }
  return { head: h, base: b, why: null };
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

function perPerson(visits) {
  const by = new Map();
  for (const v of visits) by.set(v.who, [...(by.get(v.who) || []), v]);
  return by;
}

/** A path as one comparable string; a visit with no trace is a variant of its own (e2e's "(absent)"). */
export const NO_TRACE = "(no trace)";
const pathKey = (routes) => (routes ? routes.join(" > ") : NO_TRACE);

/**
 * Behaviour first, over the shared personas (`bp`/`hp`: Map(person -> visits) of each arm). Ported from tester-army/e2e
 * scripts/bench-ab/compare.ts `caseChanges` at b7ba009 (Apache-2.0, Copyright 2026 TesterArmy, Inc.), written fresh
 * for a Sue's path: more than one path across one arm's rounds is unstable (the base side named first), else one path
 * each that differ is changed. People in one arm only are the report's `only`, e2e's added and removed.
 * -> [{ who, kind: "unstable", side, variants } | { who, kind: "changed", base: routes | null, head: routes | null }]
 */
export function pathChanges(bp, hp, people) {
  const out = [];
  for (const who of people) {
    const inBase = new Map(bp.get(who).map((v) => [pathKey(v.routes), v.routes]));
    const inHead = new Map(hp.get(who).map((v) => [pathKey(v.routes), v.routes]));
    if (inBase.size > 1) out.push({ who, kind: "unstable", side: "base", variants: inBase.size });
    else if (inHead.size > 1) out.push({ who, kind: "unstable", side: "head", variants: inHead.size });
    else {
      const [[baseKey, baseRoutes]] = inBase;
      const [[headKey, headRoutes]] = inHead;
      if (baseKey !== headKey) out.push({ who, kind: "changed", base: baseRoutes, head: headRoutes });
    }
  }
  return out;
}

const straddle = (names, still = "") => `${names.join(", ")} ${still}${names.length > 1 ? "straddle their" : "straddles its"} dead zone`;

/**
 * Why the unread metrics stay unread whatever the rounds: a round adds visits, never people, and a Sue whose path
 * diverged stays diverged (a later round can only add a path to her arm). `people` is the personas both arms share.
 */
function unreadWhy(names, metrics, people) {
  const kept = Math.min(...names.map((m) => metrics[m].people));
  const who =
    people < MIN_SHARED_PEOPLE
      ? `the arms share ${people} ${people === 1 ? "person" : "people"}`
      : kept === 0
        ? `every one of the ${people} took another path, so the behaviour changed for everyone`
        : `only ${kept} of the ${people} kept her path`;
  return `${names.join(", ")} cannot be read (${who}), and more rounds add visits, not people`;
}

/**
 * The stop rule (e2e's bench-ab.ts --min-pairs / --max-pairs): another round is owed only while the verdict is
 * unresolved, a metric it could read still straddles its dead zone, and the arm with fewer rounds is under the budget;
 * it goes to that arm (a tie: the head). An unread metric is named, never paid a round for.
 * -> { round: boolean, arm: "base" | "head" | null, why }
 */
export function nextRound({ verdict, rounds, metrics, people }) {
  const fewest = Math.min(rounds.base, rounds.head);
  const arm = rounds.head <= rounds.base ? "head" : "base";
  if (fewest < MIN_ROUNDS_PER_ARM)
    return {
      round: true,
      arm,
      why: `the ${arm} arm has ${fewest} round${fewest === 1 ? "" : "s"}, and one round cannot tell the change from that round's weather`,
    };
  if (verdict !== "unresolved") return { round: false, arm: null, why: `resolved: ${verdict}` };
  const open = VERDICT_METRICS.filter((m) => metrics[m].verdict === "unresolved");
  const unread = VERDICT_METRICS.filter((m) => metrics[m].verdict === "unread");
  const blind = unread.length ? unreadWhy(unread, metrics, people) : null;
  if (!open.length) return { round: false, arm: null, why: blind };
  if (fewest >= MAX_ROUNDS_PER_ARM)
    return {
      round: false,
      arm: null,
      why: [
        `${MAX_ROUNDS_PER_ARM} rounds of each arm are spent and ${straddle(open, "still ")}: the change is smaller than this panel can see`,
        blind,
      ]
        .filter(Boolean)
        .join("; "),
    };
  return { round: true, arm, why: [straddle(open), blind].filter(Boolean).join("; ") };
}

/**
 * A metric's line of the report: the means per visit, and the paired read with its interval. Over fewer than
 * MIN_SHARED_PEOPLE there is no mean to show and no interval to read: every number is null and a judged metric is
 * "unread", which no round can fix (an empty mean is not 0 notes, and one Sue is anecdote).
 */
function metricRow(m, over, bp, hp) {
  const judged = VERDICT_METRICS.includes(m);
  const deadZone = judged ? DEAD_ZONE[m] : null;
  if (over.length < MIN_SHARED_PEOPLE)
    return {
      base: null,
      head: null,
      estimate: null,
      low: null,
      high: null,
      level: STAT.level,
      people: over.length,
      deadZone,
      verdict: judged ? "unread" : "shown",
    };
  const read = READ[m];
  const diffs = over.map((p) => mean(hp.get(p).map(read)) - mean(bp.get(p).map(read)));
  const r = judged ? pairedVerdict(diffs, { threshold: deadZone, ...STAT }) : bootstrapInterval(diffs, mean, STAT);
  return {
    base: round3(mean(over.flatMap((p) => bp.get(p).map(read)))),
    head: round3(mean(over.flatMap((p) => hp.get(p).map(read)))),
    estimate: round3(r.estimate),
    low: round3(r.low),
    high: round3(r.high),
    level: r.level,
    people: over.length,
    deadZone,
    verdict: judged ? r.verdict : "shown",
  };
}

/**
 * The comparison of two arms (from `pickArms`) over the people in both, on the builds in both when there are any.
 * { personas, only: { base, head }, sameBuild, rounds: { base, head }, diverged, base, head,
 *   metrics: { name: { base, head, estimate, low, high, level, people, deadZone, verdict } },
 *   verdict: "better" | "worse" | "same" | "unresolved", resolved, another, stat }.
 * `diverged` is `pathChanges`, a Sue whose finishing also moved first (with `outcomes`), and those people are left out
 * of every metric but OVER_EVERYONE's. `base`/`head` of a metric are its mean per visit over the people it is read over;
 * `estimate` and its interval are the mean of the per-persona changes per visit; read over fewer than MIN_SHARED_PEOPLE
 * they are null and the metric is "unread". Any judged metric worse is worse; else any unresolved or unread is
 * unresolved; else any better is better; else same. Under MIN_ROUNDS_PER_ARM rounds of either arm the verdict is
 * unresolved whatever the intervals say.
 */
export function compareArms({ base, head }) {
  const shared = [...buildSetsOf(head)].filter((k) => buildSetsOf(base).has(k));
  const sameBuild = shared.length > 0;
  const keepBuilds = (arm) => (sameBuild ? arm.visits.filter((v) => shared.includes(buildsKey(v.builds))) : arm.visits);
  const bv = keepBuilds(base);
  const hv = keepBuilds(head);
  const bp = perPerson(bv);
  const hp = perPerson(hv);
  const personas = [...bp.keys()].filter((p) => hp.has(p)).sort();
  const only = { base: [...bp.keys()].filter((p) => !hp.has(p)).sort(), head: [...hp.keys()].filter((p) => !bp.has(p)).sort() };
  const bs = bv.filter((v) => personas.includes(v.who));
  const hs = hv.filter((v) => personas.includes(v.who));
  const rounds = { base: new Set(bs.map((v) => v.rowId)).size, head: new Set(hs.map((v) => v.rowId)).size };
  // A Sue whose outcome moved with her path (she stopped finishing) is the one a reader must not miss: she is listed
  // first, carrying the move. One of eight reads unresolved rather than failing the A/B, so this line is how she is seen.
  const outcomes = (who) =>
    Object.fromEntries(
      [...OVER_EVERYONE].flatMap((m) => {
        const was = mean(bp.get(who).map(READ[m]));
        const now = mean(hp.get(who).map(READ[m]));
        return was === now ? [] : [[m, { base: round3(was), head: round3(now) }]];
      }),
    );
  const diverged = pathChanges(bp, hp, personas)
    .map((d) => (Object.keys(outcomes(d.who)).length ? { ...d, outcomes: outcomes(d.who) } : d))
    .sort((a, b) => Number(Boolean(b.outcomes)) - Number(Boolean(a.outcomes)));
  const out = new Set(diverged.map((d) => d.who));
  const kept = personas.filter((p) => !out.has(p));
  const metrics = {};
  for (const m of METRICS) metrics[m] = metricRow(m, OVER_EVERYONE.has(m) ? personas : kept, bp, hp);
  const verdicts = VERDICT_METRICS.map((m) => metrics[m].verdict);
  let verdict = verdicts.includes("worse")
    ? "worse"
    : verdicts.includes("unresolved") || verdicts.includes("unread")
      ? "unresolved"
      : verdicts.includes("better")
        ? "better"
        : "same";
  if (Math.min(rounds.base, rounds.head) < MIN_ROUNDS_PER_ARM) verdict = "unresolved";
  const another = nextRound({ verdict, rounds, metrics, people: personas.length });
  const describe = (arm, vs) => ({
    key: arm.key,
    parts: { engine: arm.parts.engine, driver: arm.parts.driver, hands: arm.parts.hands },
    visits: vs.length,
    rounds: new Set(vs.map((v) => v.rowId)).size,
    builds: vs[0]?.builds || {},
    newest: vs.reduce((t, v) => (v.at > t ? v.at : t), ""),
    commit: pinnedCommitOf(vs),
  });
  return {
    personas,
    only,
    sameBuild,
    rounds,
    diverged,
    base: describe(base, bs),
    head: describe(head, hs),
    metrics,
    verdict,
    resolved: verdict !== "unresolved",
    another,
    stat: { statistic: "mean", ...STAT, minRounds: MIN_ROUNDS_PER_ARM, maxRounds: MAX_ROUNDS_PER_ARM, deadZone: { ...DEAD_ZONE } },
  };
}

const newestVisit = (vs) => vs.reduce((t, v) => (!t || v.at > t.at ? v : t), null);
const roundsOf = (vs) => new Set(vs.map((v) => v.rowId)).size;

/** One persona's visits grouped by their docs part, newest group first. */
function docGroups(vs) {
  const by = new Map();
  for (const v of vs) by.set(v.docs, [...(by.get(v.docs) || []), v]);
  return [...by.values()].sort((a, b) => newestVisit(b).at.localeCompare(newestVisit(a).at));
}

const DOCS_VERDICT = { higher: "better", lower: "worse", same: "same", unresolved: "unresolved" };

/**
 * A two-sample bootstrap of the difference of means: each side resampled on its own, seeded as compareArms' intervals
 * are. bootstrapInterval resamples one array, so it cannot keep the two sides apart.
 */
function twoSampleInterval(head, base) {
  const random = seededRandom(STAT.seed);
  const draw = (xs) => Array.from({ length: xs.length }, () => xs[Math.floor(random() * xs.length)]);
  const stats = [];
  for (let i = 0; i < STAT.resamples; i += 1) stats.push(mean(draw(head)) - mean(draw(base)));
  const tail = (1 - STAT.level) / 2;
  return { estimate: mean(head) - mean(base), low: quantile(stats, tail), high: quantile(stats, 1 - tail) };
}

/** One metric of one persona: her per-visit means, and the read of their change against the dead zone. */
function personaMetric(m, bvs, hvs, readable) {
  const judged = VERDICT_METRICS.includes(m);
  const deadZone = judged ? DEAD_ZONE[m] : null;
  if (!readable)
    return {
      base: null,
      head: null,
      estimate: null,
      low: null,
      high: null,
      level: STAT.level,
      deadZone,
      verdict: judged ? "unread" : "shown",
    };
  const read = READ[m];
  const base = bvs.map(read);
  const head = hvs.map(read);
  const r = twoSampleInterval(head, base);
  return {
    base: round3(mean(base)),
    head: round3(mean(head)),
    estimate: round3(r.estimate),
    low: round3(r.low),
    high: round3(r.high),
    level: STAT.level,
    deadZone,
    verdict: judged ? DOCS_VERDICT[verdictOf(r.low, r.high, deadZone)] : "shown",
  };
}

const describeDocs = (vs) => {
  const newest = newestVisit(vs);
  return { docs: newest.docs, visits: vs.length, rounds: roundsOf(vs), builds: newest.builds, newest: newest.at };
};

/**
 * One persona's docs against her previous docs (`docs` is the docs part of reuse.json: her doc, the doc it extends,
 * her mind). Her visits only, on one arm and the builds her newest docs ran on: the newest docs version is the head,
 * the one before it the base. Arms are tried newest first and the first with two docs versions is read; with none, the
 * newest arm says it has one version. The read is compareArms': the same path check (a changed path leaves every
 * judged metric but finishing unread), the same metrics and dead zones, the same stop on fewer than
 * MIN_ROUNDS_PER_ARM rounds of either side. Her rounds are the units, so each interval is twoSampleInterval.
 * -> { persona, verdict: "better" | "worse" | "same" | "unresolved", why, resolved, arm, head, base, rounds, diverged,
 *      metrics, stat } ; base is null when there is no previous version on the same builds.
 */
export function comparePersonaDocs(visits, persona) {
  const mine = visits.filter((v) => v.who === persona && v.arm && typeof v.docs === "string");
  const unresolved = (why, extra = {}) => ({
    persona,
    verdict: "unresolved",
    why,
    resolved: false,
    arm: null,
    head: null,
    base: null,
    rounds: { base: 0, head: 0 },
    diverged: [],
    metrics: null,
    ...extra,
  });
  if (!mine.length) return unresolved("no visit of hers carries a docs part (reuse.json parts)");
  const arms = groupArms(mine);
  const arm = arms.find((a) => docGroups(a.visits).length >= 2) ?? arms[0];
  const newest = newestVisit(arm.visits);
  const onBuilds = arm.visits.filter((v) => buildsKey(v.builds) === buildsKey(newest.builds));
  const groups = docGroups(onBuilds);
  const armInfo = { key: arm.key, parts: { engine: arm.parts.engine, driver: arm.parts.driver, hands: arm.parts.hands } };
  if (groups.length < 2) {
    const why =
      docGroups(arm.visits).length < 2
        ? "her docs are one version on this arm: nothing to compare against"
        : "no earlier docs version ran on the builds her newest docs ran on: nothing to compare against";
    return unresolved(why, { arm: armInfo, head: describeDocs(groups[0]) });
  }
  const [headVs, baseVs] = groups;
  const diverged = pathChanges(new Map([[persona, baseVs]]), new Map([[persona, headVs]]), [persona]);
  const readable = diverged.length === 0;
  const metrics = {};
  for (const m of METRICS) metrics[m] = personaMetric(m, baseVs, headVs, readable || OVER_EVERYONE.has(m));
  const verdicts = VERDICT_METRICS.map((m) => metrics[m].verdict);
  const short = Math.min(roundsOf(baseVs), roundsOf(headVs)) < MIN_ROUNDS_PER_ARM;
  let verdict = verdicts.includes("worse")
    ? "worse"
    : verdicts.includes("unresolved") || verdicts.includes("unread")
      ? "unresolved"
      : verdicts.includes("better")
        ? "better"
        : "same";
  let why;
  if (short) {
    verdict = "unresolved";
    why = `the newest docs have ${roundsOf(headVs)} round(s) and the previous ${roundsOf(baseVs)}: a round is needed on each side, one round cannot tell the change from that round's weather`;
  } else if (verdict === "unresolved") {
    const open = VERDICT_METRICS.filter((m) => ["unresolved", "unread"].includes(metrics[m].verdict));
    why = `${open.join(", ")} straddle their dead zone or cannot be read${diverged.length ? " (her path changed)" : ""}`;
  } else {
    why = `the judged metrics read ${verdict} past their dead zones`;
  }
  return {
    persona,
    verdict,
    why,
    resolved: verdict !== "unresolved",
    arm: armInfo,
    head: describeDocs(headVs),
    base: describeDocs(baseVs),
    rounds: { base: roundsOf(baseVs), head: roundsOf(headVs) },
    diverged,
    metrics,
    stat: { statistic: "mean", ...STAT, minRounds: MIN_ROUNDS_PER_ARM, maxRounds: MAX_ROUNDS_PER_ARM, deadZone: { ...DEAD_ZONE } },
  };
}

/**
 * Runs of four words that a changed prompt or brief text ADDED and that sit verbatim in one or two measured visits'
 * words or plan expectations: the head tuned toward what it was measured on. Dredd's `leakageSuspects`, pointed at
 * text. `gold` is [{ id, text }]; returns [{ item, kind, phrase, gold, heldOut }]. A flag never decides the verdict.
 */
export function overfitSuspects({ baseText = "", headText = "", gold = [] }) {
  if (baseText === headText) return [];
  return leakageSuspects({ base: [{ id: "text", jev: baseText }], head: [{ id: "text", jev: headText }], gold });
}

/** The measured visits' words as gold for the overfit screen, one text per visit. */
export const goldOf = (visits) => visits.map((v) => ({ id: `${v.who}@${v.round}`, text: `${v.text} ${v.expect}` }));

/** One ledger row (sue-rsi.mjs SUE_AB_LEDGER's documented shape) for a comparison. */
export function ledgerRow(
  report,
  { at = new Date().toISOString(), kind = "measured", commits = [], series = [], accept = null, note = null } = {},
) {
  const metrics = {};
  for (const [m, r] of Object.entries(report.metrics))
    metrics[m] = {
      base: r.base,
      head: r.head,
      estimate: r.estimate,
      low: r.low,
      high: r.high,
      people: r.people,
      deadZone: r.deadZone,
      verdict: r.verdict,
    };
  const row = {
    at,
    kind,
    base: report.base.parts,
    head: report.head.parts,
    commits,
    builds: { same: report.sameBuild, base: report.base.builds, head: report.head.builds },
    series,
    visits: { base: report.base.visits, head: report.head.visits },
    rounds: report.rounds,
    // Who diverged and how; their routes stay in the report (--json), they are too long for a ledger line.
    diverged: report.diverged.map(({ who, kind: how, side, variants }) => ({ who, kind: how, ...(side ? { side, variants } : {}) })),
    metrics,
    verdict: report.verdict,
    resolved: report.resolved,
    another: report.another,
    stat: report.stat,
  };
  if (accept) row.accept = accept;
  if (note) row.note = note;
  return row;
}
