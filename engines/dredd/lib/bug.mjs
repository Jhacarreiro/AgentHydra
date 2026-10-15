// dredd/lib/bug.mjs - the bug ladder, pure: a docket that is a bug complaint demands the original repro, and a fix of
// it is ruled verified, partial or failed - never a free-text "fixed".
//
// WHY: an agent calls a fix done because the tests are green while the symptom the person reported was never run
// again. Three verdicts tied to that repro make the claim impossible to make silently: green tests with the repro not
// re-run rule PARTIAL, whatever the tests say. The idea is github/spec-kit's bug extension (MIT): its test step ends in
// verified, partial or failed, and a fix is downgraded to partial when the assessment's reproduction was not exercised.
// Written fresh for Dredd; nothing of theirs is copied.
//
// Nothing here touches the disk or the network: decideDocket (lib/docket.mjs) files `docket.bug`, and
// `dredd.mjs --rule-fix` checks a ruling here and keeps it in docket.json as `docket.fix`.
//
// THE EXECUTABLE REPRO. A repro typed as a sentence is still a claim about what ran. `--rule-fix --repro-file <file>`
// runs a repro script through sue/repro.mjs run (it asserts the CORRECT behaviour: an assertion failing is
// still, a pass is gone, any other failure is a broken repro, which re-ran nothing), and `--repro-check "<cmd>"` runs
// a command (exit 0 is gone, anything else still); executedRepro below turns that run into the result the ladder
// rules on. The rule that a failing assertion of the right behaviour is what makes a claim a bug, and the same test
// passing is what makes it fixed, is tester-army/e2e's bug-bash reference (Apache-2.0), written fresh.
//
// A SUE VISITOR'S TYPED PROBLEM (2026-10-07). A SUE run's summary carries `problemsFiled` (sue/report.mjs
// filedList): each problem a visitor typed with the 1-5 severity rubric and issue or warning. routeFiled sends each
// where it is settled and filedLines prints that for sue.log (lib/collect.mjs collectSue): a 4-5 issue to a repro,
// with the exact confirm command; a warning to the Design Critic, with her look's picture; a 1-3 issue to the room.
// The rubric and the issue/warning split are tester-army/e2e's (Apache-2.0, at b7ba009:
// packages/e2e/src/explore/executor.ts FINDING_SCHEMA, lines 76-98), written fresh; nothing of theirs is copied.

import { proseOf } from "../../lib/shared/prose.mjs";

/** The words a bug report is made of: something that ran and did the wrong thing. Copy and taste words ("wordy", "ugly",
 *  "wrong" about a headline) are not here - a page that reads badly has no repro to re-run. */
export const BUG_RX =
  /\b(?:bugs?|buggy|crash(?:es|ed|ing)?|exceptions?|stack ?traces?|regress(?:ed|ion|ions)?|throws?|threw|errors?|erroring|broken|breaks|broke|fails?|failing|failed|hangs?|hung|freez(?:es|ing)|froze|stopped working|doesn'?t work|not working|won'?t (?:load|open|start|save|send|build|run)|no longer (?:works?|loads?|runs?)|500s?)\b/i;

/** The three verdicts a fix of a bug can get, and what each one claims. */
export const FIX_VERDICTS = {
  verified: "the original repro was re-run and the symptom is gone, and no test the fix touched is red",
  partial: "something passed, but the original repro was not re-run - green tests alone never verify a bug fix",
  failed: "the original repro still shows the symptom, or a test is red",
};
export const REPRO_RESULTS = ["gone", "still", "not-run"];
export const TEST_RESULTS = ["pass", "fail", "none"];

/** Is this docket a bug complaint? A bug word, and an ask that is not a pick between options; a build is one only when
 *  it asks to FIX something ("fix the crash on save"), never new work that names a bug word ("build a crash reporter").
 *  Only the person's own words count: a pasted handoff or log is material, not the complaint (a pasted handoff quoting
 *  "Broken for users 8" filed a bug docket, 2026-10-02). */
export function isBugComplaint({ ask, askClass }) {
  const text = proseOf(ask);
  if (!BUG_RX.test(text) || askClass === "decision") return false;
  if (askClass === "build") return /\bfix(?:es|ed|ing)?\b/i.test(text);
  return true;
}

/** The repro the ask itself states, when it states one: a command in backticks, else the clause that says when the
 *  symptom shows ("when I click save", "every time the export runs"), from the person's own words: a command quoted in
 *  a pasted handoff is never the repro. null when the ask names none. */
export function statedRepro(ask) {
  const text = proseOf(ask);
  const code = /`([^`]{3,200})`/.exec(text);
  if (code) return code[1].trim();
  const clause =
    /\b((?:when(?:ever)?|every time|each time|after|as soon as) (?:i|we|you|they|it|the|a|an|my|our|someone|anyone|people|users?)\b[^.;!?\n]{3,160})/i.exec(
      text,
    );
  return clause ? clause[1].trim() : null;
}

/** What a bug docket carries: the repro it heard and the ladder its fix is ruled on. null for any other docket. */
export function bugFor({ ask, askClass }) {
  if (!isBugComplaint({ ask, askClass })) return null;
  return { repro: statedRepro(ask), verdicts: Object.keys(FIX_VERDICTS) };
}

const words = (t) =>
  String(t || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;

/**
 * Rule one fix. `input`: { repro, reproResult, tests } - `repro` is the evidence (what was re-run and what it showed),
 * required whenever the result claims the repro ran. Throws with every problem named; returns
 * { verdict, why, downgraded, repro, reproResult, tests }.
 */
export function ruleFix(input) {
  const problems = [];
  const reproResult = String(input?.reproResult ?? "").trim();
  const tests = String(input?.tests ?? "").trim();
  const repro = String(input?.repro ?? "").trim();
  if (!REPRO_RESULTS.includes(reproResult)) problems.push(`--repro-result is one of ${REPRO_RESULTS.join(", ")}, not "${reproResult}"`);
  if (!TEST_RESULTS.includes(tests)) problems.push(`--tests is one of ${TEST_RESULTS.join(", ")}, not "${tests}"`);
  // A repro that "ran" with nothing said about what ran is the free-text claim this ladder exists to refuse.
  if ((reproResult === "gone" || reproResult === "still") && words(repro) < 3)
    problems.push(
      `--repro-result ${reproResult} needs --repro "<the steps or command you re-ran, and what it showed>" (three words at least)`,
    );
  if (problems.length) {
    const err = new Error(problems.join("\n"));
    err.problems = problems;
    throw err;
  }
  let verdict;
  let why;
  if (reproResult === "still") [verdict, why] = ["failed", "the original repro still shows the symptom"];
  else if (tests === "fail") [verdict, why] = ["failed", "a test is red"];
  else if (reproResult === "gone") [verdict, why] = ["verified", "the original repro was re-run and the symptom is gone"];
  else if (tests === "pass") [verdict, why] = ["partial", "the tests are green but the original repro was not re-run"];
  else [verdict, why] = ["partial", "neither the original repro nor a test was run: nothing shows the fix works"];
  return {
    verdict,
    why,
    // Green tests would have been called a fix; the ladder says why they were not enough.
    downgraded: verdict === "partial" && tests === "pass",
    repro: repro || null,
    reproResult,
    tests,
  };
}

/**
 * A repro that was RUN, as ruleFix's `repro` and `reproResult`. `form` is "file" (a repro script through
 * sue/repro.mjs run, whose result is gone, still or broken-test) or "check" (a command: gone on exit 0, else
 * still). A broken repro re-ran nothing, so it rules as not-run. `target` is the file or the command, `why` what the run
 * said. Returns { repro, reproResult, executed } - `executed` is kept beside the ruling in docket.json.
 */
export function executedRepro({ form, target, result, why }) {
  const reproResult = result === "gone" || result === "still" ? result : "not-run";
  const how = form === "file" ? `ran ${target} through sue/repro.mjs run` : `ran the check \`${target}\``;
  return {
    repro: `${how}: ${result}${why ? ` - ${String(why).replace(/\s+/g, " ").trim()}` : ""}`,
    reproResult,
    executed: { form, target, result, ...(why ? { why: String(why) } : {}) },
  };
}

/** The docket's BUG block: the demand before the fix, and the ruling once there is one. */
export function bugLines(docket, { docketDir = null } = {}) {
  const lines = [];
  if (docket.bug) {
    lines.push(
      `BUG: a fix is ruled verified, partial or failed - verified only when the original repro is re-run and the symptom is gone; green tests alone rule partial.`,
      docket.bug.repro
        ? `  REPRO heard: "${docket.bug.repro}" - re-run exactly this after the fix`
        : `  REPRO: none in the ask - write down the steps that show the symptom BEFORE the fix, then re-run exactly them`,
      `  rule it: node dredd/dredd.mjs --rule-fix ${docketDir || docket.id || "<docket>"} --repro "<what you re-ran, what it showed>" --repro-result gone|still|not-run --tests pass|fail|none`,
      `  or let it run: --repro-file <repro.mjs> (a script asserting the right behaviour, run by sue/repro.mjs: its assertion failing is still, a pass is gone) or --repro-check "<command>" (exit 0 is gone), in place of --repro and --repro-result`,
    );
  }
  if (docket.fix)
    lines.push(`FIX: ${docket.fix.verdict.toUpperCase()} - ${docket.fix.why}${docket.fix.repro ? ` (repro: ${docket.fix.repro})` : ""}`);
  return lines;
}

/** Where a SUE visitor's typed problem goes, and why. */
export const FILED_ROUTES = {
  repro:
    "straight to a repro: a 4 or 5 issue says a core journey, data, money or security is wrong, so it is proved or rejected before anyone fixes it",
  "design-critic": "to the Design Critic: a warning blocks nothing, and how a page looks is the critic's to judge",
  room: "stays with the room: an issue of 1 to 3, read with the rest of what the visitors said",
};
const ROUTE_LABEL = { repro: "REPRO", "design-critic": "DESIGN CRITIC", room: "ROOM" };
/** What `quoted` (sue/lib/findings.mjs quotesScreen) says about her actual; null or absent says nothing. */
const QUOTED_WORDS = { true: " (quoted from her screen)", false: " (not word for word on her screen)" };

/** "repro" | "design-critic" | "room", or null for a row with no typed problem (every row written before 2026-10-07). */
export function routeFiled(p) {
  if (!p || !Number.isInteger(p.severity)) return null;
  if (p.defect === "warning") return "design-critic";
  return p.severity >= 4 ? "repro" : "room";
}

/** A page as a reader places it: its path, an SPA's "#/..." route kept; the address as given when it does not parse. */
function pathOf(page) {
  if (!page) return null;
  try {
    const u = new URL(String(page));
    return `${u.pathname}${u.hash.startsWith("#/") ? u.hash : ""}`;
  } catch {
    return String(page);
  }
}

/**
 * The routed block sue.log carries for a SUE run's `problemsFiled` (worst first, as the report sorted them); [] when
 * nothing was filed, so the log of a run before typed problems is unchanged. `runId` names the run in the confirm
 * command; `runDir` is the run's folder, which the paths to her moves and her look start from (SUE_HOME can move it,
 * so collectSue reads it off the run's report path). A caller with none gets SUE's default folder,
 * sue/runs/<runId>, from the checkout root the confirm command runs in.
 */
export function filedLines(filed, { runId, runDir = null }) {
  const rows = (Array.isArray(filed) ? filed : []).filter((p) => routeFiled(p));
  if (!rows.length) return [];
  const inRun = (...parts) => [String(runDir ?? `sue/runs/${runId}`).replace(/\\/g, "/"), ...parts].join("/");
  const lines = ["Problems the visitors filed, worst first (routed by lib/bug.mjs routeFiled):"];
  for (const p of rows) {
    const route = routeFiled(p);
    const where = pathOf(p.page);
    const head = `${ROUTE_LABEL[route]} [${p.severity} ${p.defect}] "${p.title}"${where ? ` on ${where}` : ""}`;
    if (route === "repro") {
      lines.push(`- ${head}${p.seen > 1 ? `, seen by ${p.seen}` : ""} (${p.ref})`);
      lines.push(`    expected: ${p.expected} | actual: ${p.actual}${QUOTED_WORDS[p.quoted] ?? ""}`);
      if (p.steps?.length) lines.push(`    steps: ${p.steps.map((step, i) => `${i + 1}. ${step}`).join(" ")}`);
      lines.push(
        `    write a repro that asserts the expected and fails on the actual (her moves are in ${inRun(p.sueId, "trace.jsonl")}), then:`,
      );
      lines.push(`    node sue/repro.mjs confirm ${runId} --finding ${p.ref} --repro <file>`);
    } else if (route === "design-critic") {
      lines.push(`- ${head} (${p.ref}${p.look ? `, her look: ${inRun(p.sueId, "shots", p.look)}` : ""})`);
    } else lines.push(`- ${head} (${p.ref})`);
  }
  for (const route of Object.keys(FILED_ROUTES))
    if (rows.some((p) => routeFiled(p) === route)) lines.push(`  ${ROUTE_LABEL[route]}: ${FILED_ROUTES[route]}`);
  return lines;
}
