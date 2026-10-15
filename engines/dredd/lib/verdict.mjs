// dredd/lib/verdict.mjs - a chat's verdict on one docket, pure: was each convened instrument the right call, what did
// the docket miss, and - when it got something wrong - the gold row that makes the eval fail until Dredd learns it.
//
// Owner, 2026-09-23: "every single call with Dredd tracked and analyzed ... the same way we rate the prompts ... was
// this the right tool used in Dredd afterwards, so we can learn and progress recursive improvements." The chat that
// received a docket is the only one that knows whether it fit, and it knows at the end of the work, so the Connections
// lane's reflection asks it (services/studio/local-mcp/src-impl/26-tools-rules-lane.mjs) and `dredd.mjs --rate` lands
// the answer here. Nothing in this file touches the disk or the network; lib/lane-record.mjs and dredd.mjs do.
//
// THE CHOICES, one per convened instrument:
//   right     convening it was the correct call and it earned its place
//   unneeded  it fit the ask but added nothing here (a cost, not a mistake)
//   wrong     it did not fit the ask at all
//   not-run   the chat skipped it - says the docket was not followed, never whether it chose well
// plus `missed`: bench instruments the docket should have convened and did not, and `missingTool`: what the work
// needed that no instrument on the bench does (a gap in the bench, filed as such).
//
// THE GOLD ROW. A docket that convened a wrong instrument or missed one becomes dredd/eval/verdicts/<id>.json in
// eval/asks.json's shape, graded by `eval.mjs --verdicts`. These rows are chat-labelled, so they are a separate column
// and never merged into the hand-written gold set, whose rule is that no model writes a label. The ask is written in
// the chat's own words (`gold`), not copied: a dictated ask can hold private detail, and a paraphrase is what makes the
// row test the judge rather than one sentence.

export const CHOICES = ["right", "unneeded", "wrong", "not-run"];
const VERDICTS = ["helped", "harmless", "hurt", "na"];

/** The verdict a 1-5 rating implies, the lane's own mapping (1 na, 2 hurt, 3 harmless, 4-5 helped). */
export function verdictFor(score) {
  // A docket rating always applied (the chat got the docket), so it is never "na": the lane drops na from the mean,
  // and a 1 would have been the one rating that could never count against Dredd.
  return score <= 2 ? "hurt" : score === 3 ? "harmless" : "helped";
}

const list = (v) => (Array.isArray(v) ? v : String(v ?? "").split(",")).map((x) => String(x).trim()).filter(Boolean);

/** How many words in a row the two texts share at most: the check that `gold` is a paraphrase and not the ask. */
export function longestSharedRun(a, b) {
  const words = (t) =>
    String(t || "")
      .toLowerCase()
      .replace(/[^a-z0-9' ]+/g, " ")
      .split(/\s+/)
      .filter(Boolean);
  const x = words(a);
  const y = words(b);
  let best = 0;
  const prev = new Array(y.length + 1).fill(0);
  for (let i = 1; i <= x.length; i += 1) {
    let diag = 0;
    for (let j = 1; j <= y.length; j += 1) {
      const up = prev[j];
      prev[j] = x[i - 1] === y[j - 1] ? diag + 1 : 0;
      if (prev[j] > best) best = prev[j];
      diag = up;
    }
  }
  return best;
}

export const PARAPHRASE_MAX_RUN = 8;

/**
 * Checks one rating against its docket and the bench and returns it normalised, or throws with every problem named.
 * `input`: { score, verdict?, right, unneeded, wrong, notRun, missed, missingTool, note, gold, klass?, domain? } - klass and
 * domain are what the ask really was, given only when the docket misread it (checked against `classes` / `domains`).
 */
export function checkRating(docket, input, benchIds, { classes = null, domains = null } = {}) {
  const problems = [];
  const score = Number(input.score);
  if (!Number.isInteger(score) || score < 1 || score > 5) problems.push(`--score takes 1 to 5, not "${input.score ?? ""}"`);
  const verdict = input.verdict ? String(input.verdict) : Number.isInteger(score) ? verdictFor(score) : "na";
  if (!VERDICTS.includes(verdict)) problems.push(`--verdict is one of ${VERDICTS.join(", ")}`);

  const convened = (docket.convene || []).map((c) => c.id);
  const choices = {};
  const seen = new Map();
  for (const choice of CHOICES) {
    const key = choice === "not-run" ? "notRun" : choice;
    for (const id of list(input[key])) {
      if (!convened.includes(id))
        problems.push(`--${choice} ${id}: the docket did not convene ${id} (it convened ${convened.join(", ") || "nothing"})`);
      else if (seen.has(id)) problems.push(`${id} is both ${seen.get(id)} and ${choice}`);
      else {
        seen.set(id, choice);
        choices[id] = choice;
      }
    }
  }
  const unclassified = convened.filter((id) => !seen.has(id));
  if (unclassified.length)
    problems.push(
      `say for every convened instrument whether it was right, unneeded, wrong or not-run: ${unclassified.join(", ")} has no choice`,
    );

  const bench = new Set(benchIds);
  const missed = list(input.missed);
  for (const id of missed) {
    if (!bench.has(id)) problems.push(`--missed ${id}: not a bench instrument (a tool the bench lacks goes in --missing-tool)`);
    else if (convened.includes(id)) problems.push(`--missed ${id}: the docket did convene it`);
  }
  const missingTool = String(input.missingTool || "").trim();
  const note = String(input.note || "").trim();
  const faulty = missed.length > 0 || Object.values(choices).includes("wrong");
  if ((score <= 3 || faulty || Object.values(choices).includes("unneeded") || missingTool) && !note)
    problems.push(
      "--note is required on a score of 3 or lower and whenever anything was wrong, unneeded, missed or missing: say what the docket should have done",
    );

  const klass = String(input.klass || "").trim();
  const domain = String(input.domain || "").trim();
  const gold = String(input.gold || "").trim();
  if (klass && classes && !classes.includes(klass)) problems.push(`--class is one of ${classes.join(", ")}`);
  if (domain && domains && !domains.includes(domain)) problems.push(`--domain is one of ${domains.join(", ")}`);
  const needsGold = faulty || Boolean(klass) || Boolean(domain);
  if (needsGold && !gold)
    problems.push(
      "--gold is required when the docket convened something wrong, missed an instrument or misread the class or domain: the ask in your own words (a paraphrase, never the ask itself)",
    );
  if (gold && longestSharedRun(gold, docket.ask) >= PARAPHRASE_MAX_RUN)
    problems.push(`--gold repeats ${PARAPHRASE_MAX_RUN} or more words of the ask in a row: write it in your own words`);

  if (problems.length) {
    const err = new Error(problems.join("\n"));
    err.problems = problems;
    throw err;
  }
  return {
    score,
    verdict,
    choices,
    missed,
    missingTool: missingTool || null,
    note: note || null,
    gold: gold || null,
    class: klass || null,
    domain: domain || null,
  };
}

/** The eval row a faulty docket becomes (eval/asks.json's shape), or null when the docket got nothing wrong. */
export function goldRowFor(docket, rating) {
  const wrong = Object.entries(rating.choices)
    .filter(([, c]) => c === "wrong")
    .map(([id]) => id);
  const right = Object.entries(rating.choices)
    .filter(([, c]) => c === "right")
    .map(([id]) => id);
  if (!wrong.length && !rating.missed.length && !rating.class && !rating.domain) return null;
  return {
    id: `v-${docket.id}`,
    ask: rating.gold,
    // The page it was about: a page instrument convenes only when a url is present, so a row without it could
    // never be graded green (eval.mjs reads item.url).
    ...(docket.url ? { url: docket.url } : {}),
    class: rating.class || docket.class || null,
    domain: rating.domain || docket.domain || null,
    must: [...right, ...rating.missed],
    mustNot: wrong,
    source: "verdict",
    docket: docket.id,
    decidedBy: docket.decidedBy || null,
    judged: { class: docket.class || null, domain: docket.domain || null, convened: (docket.convene || []).map((c) => c.id) },
    why: rating.note,
    ...(rating.missingTool ? { missingTool: rating.missingTool } : {}),
  };
}

/** Per-instrument score events' numbers: a right call helped, an unneeded one was harmless, a wrong one hurt. */
export function instrumentScore(choice, docketScore) {
  if (choice === "right") return { rating: docketScore === 5 ? 5 : 4, verdict: "helped" };
  if (choice === "unneeded") return { rating: 3, verdict: "harmless" };
  if (choice === "wrong") return { rating: 2, verdict: "hurt" };
  return null; // not-run says nothing about the instrument
}
