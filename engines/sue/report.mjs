#!/usr/bin/env node
/**
 * report.mjs - turns a cannon run's raw per-Sue files into something a person can read in one
 * sitting, and one line a machine can trend over every run there has ever been.
 * ============================================================================================
 *
 * WHY THIS EXISTS: a Sue's whole visit is scattered across `sue.json`, `body.json`,
 * `interview.json`, `findings.jsonl`, `trace.jsonl` and `summary.json` - nobody should have to
 * read four Sues' worth of that by hand to answer "did they understand what we sell". This is the
 * one place that reads all of it and turns it into: a comprehension bucket per Sue (mechanical
 * keyword hits against the target's `groundTruth`, never a vibe), a funnel (who died where), OTP
 * latency percentiles, clock stats (boredom, patience) and findings grouped by kind. `node
 * report.mjs --run <runId>` writes `report.md` +
 * `report.json` into that run's own directory and upserts one row per run into `runs/ledger.jsonl`
 * (a re-report of a run replaces its own row rather than appending a duplicate); `--all`
 * does every run found under `runs/` and also writes a combined `aggregate-report.md/json`.
 *
 * WHAT DEPENDS ON IT: nobody upstream - this is a leaf. It reads the file contracts SPEC.md pins
 * (`sue.json`, `interview.json`, `findings.jsonl`, `trace.jsonl`, `manifest.json`) plus the two
 * shapes `cannon.mjs` and `body.mjs` actually landed with (SPEC.md's own prose was looser than
 * what they built, so this reads THEIR real shape, not the prose): `summary.json` is
 * `cannon.mjs`'s `summarize()` - `persona`/`scenario` are the bare STRING ids there (unlike
 * `sue.json`'s `persona`, which is the full loaded persona object - `personaOf()` below prefers
 * the string), and the cost/duration/turn fields are `totalCostUsd`/`durationMs`/`numTurns`
 * (camelCase, not SPEC.md's `total_cost_usd`/`duration_ms`/`num_turns`). OTP timing and the clock
 * live in `body.json` (`otpRequestedAt`, `otpEmailLatencyMs`, `firstInboxCheckAt`, `clock`,
 * `outcome`, `finalUrl`) - `body.mjs` writes it on shutdown; a mid-run Ctrl-C can leave it absent,
 * read defensively like everything else here. `interview.json`'s `endedUpWhereExpected` and
 * `isThisTrash` are `{ yes, where }` / `{ yes, why }` - the exact shape `body.mjs` puts in the
 * brain's own exit-interview instructions, not the `{ value, ... }` guess SPEC.md's "bool + why"
 * wording would suggest. "Ended where expected" is read as the self-report AND the absence of a
 * body-side `wrong-destination` finding (`recordOutcome` in body.mjs fires that mechanically off
 * the scenario's landing pattern) - the mechanical signal wins any disagreement. A Sue with no
 * `interview.json` at all is `no-interview`, never a `wrong-destination` she never claimed.
 *
 * `--runs-dir` / `--out-dir` / `--ledger-file` exist so `tests/report.spec.mjs` can point this at
 * the committed `tests/fixtures/runs/sample-run/` fixture and a scratch temp dir without ever
 * writing into the committed fixture tree. The default `--runs-dir` is `lib/run-dir.mjs`'s own
 * `runsRoot()` (not a re-derived `<here>/runs`), so this agrees with the cannon about where a real
 * run lives even when `SUE_HOME` relocates it.
 *
 * SUE-SIDE SUSPECTS (`buildSueSide`): what SUE itself caused is told apart from what the site did,
 * and rendered before the verdict. A Sue our own sign-up door refused, and a Sue whose screen stood
 * still byte for byte under several clicks or scrolls, keep their words in that section and out of
 * the diary, the findings count and the email-code numbers. To judge that, `loadSue` also reads her
 * inbox off `<run>/mail/<address>` and hashes each look's shot when the trace carries no `shotHash`.
 *
 * FOCUS GROUPS (`buildRoom`): a run whose room was opened (lib/room.mjs) gains a `room` key in
 * report.json and a "The room agreed" (or "never agreed") section right after the verdict: the one
 * problem, who closed it, who agreed and who did not, their words, the rest of the table, the last
 * focus group's problem on this page and whether this room still felt it, and each Sue's own answer.
 * Every other run's report is exactly what it was.
 *
 * REPROS (`reproSections`, lib/repro.mjs): a run someone ran repros against (sue/repro.mjs confirm and
 * triage write `<run>/repro.json`) gains a `repro` key and, first after the tool banners, "Confirmed by a repro"
 * (each finding a failing repro proved, its page and the repro's path), then "Rejected findings" grouped by
 * bucket (environment, design, fixture, sue-side) and by repro outcome (did not reproduce, broken repro), apart
 * from the SUE-side suspects this file finds on its own. A run with no repro.json reports byte for byte as before.
 * The claim-to-bug rule is tester-army/e2e's bug-bash reference (Apache-2.0), written fresh here.
 *
 * TYPED PROBLEMS (`buildFiled`, lib/findings.mjs problemNote): a run where a Sue's line carried `problem` gains a
 * `filed` key and "Problems they filed, worst first" (after the verdict and the room): each problem's rubric,
 * expected, actual, steps, her look and her own words, with every other Sue who said `same:` its number. SUE-side
 * rows stay out of it, as they stay out of the findings count. `filedList` is the compact copy SUE's summary hands
 * Dredd. A run with no typed row reports byte for byte as before.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  ARRIVAL_ID,
  ATTENTION_KINDS,
  BROWSER_LOST_TEXT,
  BROWSER_REOPENED,
  FIRST_LOOK_PROBE_ID,
  SUE_BROWSER_LOST,
  SUE_DOOR_REFUSAL_TEXT,
  SUE_DOOR_REFUSED,
  addressMailDir,
  areaOfUrl,
  frozenLooks,
  AD_INTERVIEW_KEYS,
  judgesScreens,
  interviewExtras,
  isAdScenario,
  isApeScenario,
  yesNoOf,
  JUDGING_KEYS,
  shapeAdInterview,
  shapeApeInterview,
  shapeArtAnswers,
  ART_KINDS,
  PROBLEM_NOTE_KINDS,
  readInbox,
  shapeInterview,
  sueDoorRefused,
} from "./lib/findings.mjs";
import { isArtPersona } from "./lib/personas.mjs";
import { isEnd, isHop } from "./lib/hop-trace.mjs";
import { isArgusRow } from "./lib/argus-ids.mjs";
import { isInboxUrl, messageUrl } from "./lib/inbox-page.mjs";
import { REPRO_REJECTS, BUCKETS, reproSections } from "./lib/repro.mjs";
import { BIGGEST_PROBLEM_KEY, roomSnapshot } from "./lib/room.mjs";
import { runsRoot } from "./lib/run-dir.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const SUE_ROOT = path.dirname(fileURLToPath(import.meta.url));

// A Sue counts as "got it" only once she names the thing AND at least this many of the softer
// signals - one stray mustGet hit with nothing else is "partly", not a pass. Mechanical and
// tunable in one place, per SPEC.md's "a judge pass can re-grade the ambiguous ones later".
const GOT_IT_SHOULD_GET_THRESHOLD = 2;

const BUCKET_SEVERITY = { "wrong-idea": 3, "no-idea": 2, partly: 1, "got-it": 0, ungraded: -1 };

// ---------------------------------------------------------------------------------------------
// small file helpers - every read is defensive, because a partial run (a Sue mid-visit when the
// cannon was Ctrl-C'd) must still produce a report for everyone who finished.
// ---------------------------------------------------------------------------------------------

function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/** A Sue is a directory holding a `sue.json`. `mail/` and a browser-profile dir (the e2e test parks
 * one under the run as `sue-live-e2e`) are not Sues, and counting them made a phantom "null" Sue. */
function listSueDirNames(runDir) {
  if (!existsSync(runDir)) return [];
  return readdirSync(runDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(path.join(runDir, entry.name, "sue.json")))
    .map((entry) => entry.name);
}

function listRunIds(runsDir) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(path.join(runsDir, name, "manifest.json")));
}

// ---------------------------------------------------------------------------------------------
// loading a run
// ---------------------------------------------------------------------------------------------

/**
 * A Sue's interview as the body shaped it (body.mjs): the ape or ad shaper for her scenario, else the plain one, and for a
 * designer the ART shaping on top. Re-shaped on the way in, so a file written before a key existed still reads the same.
 */
function shapeSueInterview(interview, sue) {
  const shaped = isApeScenario(sue.scenario)
    ? shapeApeInterview(
        interview,
        interviewExtras(sue.scenario, false, false, true).map(([key]) => key),
      )
    : isAdScenario(sue.scenario)
      ? shapeAdInterview(
          interview,
          interviewExtras(sue.scenario, false, true).map(([key]) => key),
        )
      : shapeInterview(interview, [
          ...interviewExtras(sue.scenario).map(([key]) => key),
          ...(sue.focusGroup === true ? [BIGGEST_PROBLEM_KEY] : []),
        ]);
  return isArtPersona(sue.persona) ? shapeArtAnswers(shaped) : shaped;
}

export function loadSue(runDir, sueId) {
  const dir = path.join(runDir, sueId);
  const interview = readJson(path.join(dir, "interview.json"), null);
  const sue = readJson(path.join(dir, "sue.json"), {});
  const traced = readJsonl(path.join(dir, "trace.jsonl"));
  return {
    sueId,
    dir,
    sue,
    body: readJson(path.join(dir, "body.json"), {}),
    // Re-shaped on the way IN, not trusted as written: every run recorded before 2026-09-21 holds
    // nested answers the brain sent as JSON strings, and reading those raw undercounts the funnel
    // and the verdict for the whole history. `shapeInterview` is idempotent, so a correct file is
    // unchanged by this. Her scenario's own questions (`sue.json`'s scenario.interview) ride through,
    // and so does a focus-group Sue's own "biggest problem" answer (lib/room.mjs) even when her
    // scenario did not carry the question: the room's section quotes it beside what the room agreed.
    interview: interview ? shapeSueInterview(interview, sue) : null,
    summary: readJson(path.join(dir, "summary.json"), {}),
    findings: readJsonl(path.join(dir, "findings.jsonl")),
    // Her moves, one row each. Her trace also has a `kind: "hop"` line for every page her tab passed
    // through (lib/hop-trace.mjs) and a `kind: "end"` line closing each visit; those are kept out of her moves.
    trace: withShotHashes(
      dir,
      traced.filter((row) => !isHop(row) && !isEnd(row) && !isArgusRow(row)),
    ),
    hops: traced.filter(isHop),
    mail: inboxOf(runDir, sue),
  };
}

/**
 * Her inbox as the mailroom left it (`readInbox`'s shape), so "the mailroom never saw a code" is
 * read off the mail itself, not off whether she happened to check. `null` when the run kept no mail
 * at all (then nothing is claimed); an address with no folder in a run that has one got nothing.
 */
function inboxOf(runDir, sue) {
  const email = sue?.identity?.email;
  const runMail = path.join(runDir, "mail");
  if (!email || !existsSync(runMail)) return null;
  return readInbox(addressMailDir(runMail, email));
}

/**
 * Each look's screenshot as a hash, for `frozenLooks`. A `shotHash` the body wrote is trusted; an
 * older trace is hashed from `<sue>/shots/<file>` first (the run may have moved since), then from
 * the absolute path the trace recorded. A shot that is gone stays unhashed, and claims nothing.
 */
function withShotHashes(sueDir, trace) {
  return trace.map((event) => {
    if (event.tool !== "look" || event.shotHash || !event.screenshot) return event;
    const name = path.win32.basename(String(event.screenshot));
    const file = [path.join(sueDir, "shots", name), String(event.screenshot)].find((candidate) => existsSync(candidate));
    return file ? { ...event, shotHash: createHash("sha1").update(readFileSync(file)).digest("hex") } : event;
  });
}

/** `summary.json`'s `persona` is always the bare id string; `sue.json`'s is the full loaded
 * object. Prefer the string, fall back to the object's `.id`, and only then the raw value (so a
 * hand-built fixture that just puts a string on `sue.json.persona` still works). The ONE place
 * every renderer reads a Sue's persona id from, so nothing below ever prints the literal word
 * "null" for a Sue whose persona could not be resolved - it reads "unknown persona" instead
 * (measured: the 100-Sue 2026-09-21 death-list tally showed "null x5" because this used to
 * `return null` and a template literal stringifies that as "null"). */
function personaOf(s) {
  if (typeof s.summary?.persona === "string") return s.summary.persona;
  if (typeof s.sue?.persona?.id === "string") return s.sue.persona.id;
  if (typeof s.sue?.persona === "string") return s.sue.persona;
  return "unknown persona";
}

function loadTargetGroundTruth(targetId) {
  if (!targetId) return {};
  const target = readJson(path.join(SUE_ROOT, "targets", `${targetId}.json`), null);
  return target?.groundTruth || {};
}

/** A run fired by `runSue` directly (the e2e test, a one-off) has no `manifest.json`; every Sue's
 * `sue.json` carries the full target and scenario she was given, so the run's facts come from the
 * first Sue when the cannon never wrote them. Without this the report read "Target: unknown" and
 * scored comprehension against an empty ground truth, so a Sue who got it right scored no-idea. */
function loadRun(runsDir, runId) {
  const runDir = path.join(runsDir, runId);
  const manifest = readJson(path.join(runDir, "manifest.json"), {});
  const manifestSueIds = (manifest.sues || []).map((s) => s.sueId).filter(Boolean);
  const sueIds = manifestSueIds.length ? manifestSueIds : listSueDirNames(runDir);
  const sues = sueIds.map((sueId) => loadSue(runDir, sueId));
  const first = sues[0]?.sue || {};
  const target = manifest.target ?? first.target?.id ?? null;
  const scenario = manifest.scenario ?? first.scenario?.id ?? null;
  const groundTruth = manifest.groundTruth || first.target?.groundTruth || loadTargetGroundTruth(target);
  const exits = manifest.exits || (first.target?.exits || []).map((e) => ({ id: e.id, name: e.name ?? e.id }));
  return { runId, runDir, manifest: { ...manifest, target, scenario, exits }, sues, groundTruth };
}

// ---------------------------------------------------------------------------------------------
// stats
// ---------------------------------------------------------------------------------------------

function median(nums) {
  const list = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const mid = Math.floor(list.length / 2);
  return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
}

function percentile(nums, p) {
  const list = nums.filter((n) => typeof n === "number" && Number.isFinite(n)).sort((a, b) => a - b);
  if (list.length === 0) return null;
  const idx = Math.min(list.length - 1, Math.max(0, Math.ceil((p / 100) * list.length) - 1));
  return list[idx];
}

// ---------------------------------------------------------------------------------------------
// comprehension - mechanical keyword hits against the target's groundTruth, per SPEC.md's
// "Report" section. A wrong-idea hit always wins (she said the wrong thing outright); otherwise
// she needs every mustGet word AND a couple of the softer shouldGet words to count as "got it".
// ---------------------------------------------------------------------------------------------

function normalizeText(...parts) {
  return parts.filter(Boolean).join(" ").toLowerCase();
}

function countHits(haystack, keywords) {
  return (keywords || []).filter((keyword) => haystack.includes(String(keyword).toLowerCase()));
}

export function scoreComprehension(interview, groundTruth) {
  const haystack = normalizeText(interview?.whatIsThisSite, interview?.whatDoTheySell, interview?.oneSentenceToAFriend);
  const mustGet = groundTruth?.mustGet || [];
  const shouldGet = groundTruth?.shouldGet || [];
  const wrongIf = groundTruth?.wrongIf || [];
  // A page SUE derived a target for has an empty ground truth until someone writes one: nothing to score
  // against is "ungraded", never "no-idea" (app.example.net, 2026-09-26: five Sues who each said
  // what it was correctly were reported as five who had no idea, and Dredd's room heard that as a fact).
  if (!mustGet.length && !shouldGet.length && !wrongIf.length) return { bucket: "ungraded", mustHits: [], shouldHits: [], wrongHits: [] };
  const mustHits = countHits(haystack, mustGet);
  const shouldHits = countHits(haystack, shouldGet);
  const wrongHits = countHits(haystack, wrongIf);

  let bucket;
  if (wrongHits.length > 0) {
    bucket = "wrong-idea";
  } else if (mustGet.length > 0 && mustHits.length === mustGet.length && shouldHits.length >= GOT_IT_SHOULD_GET_THRESHOLD) {
    bucket = "got-it";
  } else if (mustHits.length > 0 || shouldHits.length > 0) {
    bucket = "partly";
  } else {
    bucket = "no-idea";
  }
  return { bucket, mustHits, shouldHits, wrongHits };
}

/** First non-empty (after trim) of the given interview answers, or "" when she answered none of
 * them - a Sue's exit interview varies in which field she actually filled in (a `no-idea` Sue
 * rarely wrote a one-sentence pitch but often said why she stopped), so reading only one field
 * printed an empty quote for anyone who answered under a different key. */
function firstAnswer(...values) {
  for (const value of values) {
    const trimmed = String(value ?? "").trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/** Ground-truth entries a keyword match can never find: each is looked for word for word inside what a Sue said,
 * so a whole sentence there scores every Sue no-idea (radbuddy preview, 2026-10-06: four clinicians who each said
 * what it was read as 0 of 4 understood, because the target held "It is for clinicians, who make and share..."). */
function sentenceKeywords(groundTruth) {
  return [...(groundTruth?.mustGet || []), ...(groundTruth?.shouldGet || []), ...(groundTruth?.wrongIf || [])]
    .map(String)
    .filter((keyword) => keyword.trim().split(/\s+/).length > 4);
}

function buildComprehension(sues, groundTruth) {
  const perSue = sues.map((s) => {
    const score = scoreComprehension(s.interview, groundTruth);
    return {
      sueId: s.sueId,
      persona: personaOf(s),
      bucket: score.bucket,
      severity: BUCKET_SEVERITY[score.bucket],
      sentence: firstAnswer(
        s.interview?.oneSentenceToAFriend,
        s.interview?.whatIsThisSite,
        s.interview?.whyStopped,
        s.interview?.mostConfusing,
      ),
    };
  });
  const bucketCounts = {};
  for (const row of perSue) bucketCounts[row.bucket] = (bucketCounts[row.bucket] || 0) + 1;
  const worstThree = perSue
    .slice()
    .sort((a, b) => b.severity - a.severity)
    .slice(0, 3);
  return { perSue, bucketCounts, worstThree, sentenceKeywords: sentenceKeywords(groundTruth) };
}

/**
 * P25: comprehension scored from the FIRST-LOOK probe, not the exit interview - so "she never
 * understood it" can be told apart from "she worked it out after 20 clicks" (README:3-5's founding
 * complaint). Read from the tagged finding `body.mjs` writes on her next `note` after the probe
 * fires (`extra: { probe: FIRST_LOOK_PROBE_ID, url }`), scored with the same `scoreComprehension`
 * the exit interview uses. A Sue the probe never fired for (a canvas target, or one whose brain
 * never called `note` again before the visit ended) gets `bucket: null` - a MISSING answer, never
 * "no-idea": `buildComprehension`'s exit-interview bucket already owns that word.
 */
function buildFirstLook(sues, groundTruth) {
  const perSue = sues.map((s) => {
    const probe = (s.findings || []).find((f) => f.probe === FIRST_LOOK_PROBE_ID);
    if (!probe) return { sueId: s.sueId, persona: personaOf(s), said: null, bucket: null };
    const said = String(probe.text ?? "").trim();
    return { sueId: s.sueId, persona: personaOf(s), said, bucket: scoreComprehension({ whatIsThisSite: said }, groundTruth).bucket };
  });
  const answered = perSue.filter((row) => row.bucket !== null);
  const gotIt = answered.filter((row) => row.bucket === "got-it").length;
  return { perSue, answered: answered.length, gotIt, gotItShare: answered.length ? gotIt / answered.length : null };
}

// ---------------------------------------------------------------------------------------------
// funnel - who reached what, and where she died. `endedUpWhereExpected`/`isThisTrash` in
// `interview.json` are `{ yes, where }` / `{ yes, why }` (body.mjs's own exit-interview wording).
// OTP request/arrival comes from `body.json`, not `summary.json` (see header note).
// ---------------------------------------------------------------------------------------------

function classifyFunnel(s, { doorRefused = false, browserLost = false } = {}) {
  const interview = s.interview || {};
  const body = s.body || {};
  const urlLooksLikeSignup = (s.trace || []).some((t) => typeof t.url === "string" && /signup|sign-up|register|join/i.test(t.url));
  // A borrowed session (`cannon --as`) is not an account she made, whatever she answered.
  //
  // ⛔ THE CANNON DECIDES THIS, AND THIS FILE ONLY READS ITS DECISION. The interview is a
  // SELF-REPORT and a Sue cut off by the turn budget never gives one, so two Sues who typed their
  // codes on 2026-09-21 - two live rows in AEGIS `identities`, confirmed by query - were both
  // classed `before-sign-in`. `summarize()` now weighs the body's `codeSubmittedAt` against the
  // scenario (a code also signs an EXISTING account in, so only a sign-up scenario counts) and
  // writes `madeAccountEvidence`. Re-deriving that here from the raw body would fork the rule and
  // drop the scenario gate - which is exactly the false positive a skeptic caught on the first cut.
  // A summary written before that field existed carries no key, and falls back to what it knew.
  const summary = s.summary || {};
  const madeAccount = summary.borrowedSession
    ? false
    : "madeAccountEvidence" in summary
      ? summary.madeAccount === true
      : interview.madeAccount === true;
  const requestedCode = Boolean(body.otpRequestedAt);
  const readCode = requestedCode && body.otpEmailLatencyMs !== null && body.otpEmailLatencyMs !== undefined;
  const reachedSignup = madeAccount || requestedCode || urlLooksLikeSignup;
  const signedIn = madeAccount;
  // ⛔ A SUE CUT OFF BY THE TURN BUDGET NEVER GIVES HER EXIT INTERVIEW, and `cannon.mjs`'s
  // `summarize()` already names that outcome `no-interview`. Reading the absent self-report as a
  // "no" invented a `wrong-destination` product finding for a Sue who said nothing - the same
  // self-report trap `madeAccount` above was fixed for. Only a WHOLLY absent interview counts:
  // body.mjs writes `interview.json` only when `exit_interview` ran, so a file that exists is a
  // real self-report, and the body's mechanical finding still wins any disagreement with it.
  const interviewed = s.interview != null;
  const hasWrongDestinationFinding = (s.findings || []).some((f) => f.kind === "wrong-destination");
  const endedWhereExpected = interview.endedUpWhereExpected?.yes === true && !hasWrongDestinationFinding;
  // `whyStopped` is a required interview answer, so its presence says nothing; the body records
  // `gave-up` only when she called give_up, and the brain files a `gave-up` finding when it did.
  const gaveUp = body.outcome === "gave-up" || (s.findings || []).some((f) => f.kind === "gave-up");
  // A declared exit (the target's own hand-off to another site, e.g. "Sign in with Discord") is
  // progress, not leaving: body.json lists them, and a Sue recorded before body.json carried the
  // list still has her `reached-exit` findings.
  const reachedExits = Array.isArray(body.exitsReached)
    ? body.exitsReached
    : [...new Set((s.findings || []).filter((f) => f.kind === "reached-exit" && f.exit).map((f) => f.exit))];

  let diedAt = "ended";
  if (!reachedSignup && reachedExits.length) diedAt = `handed-off:${reachedExits[0]}`;
  else if (!reachedSignup) diedAt = "before-signup";
  else if (!requestedCode) diedAt = "before-code-request";
  // Our own Sue door refusing her is where SUE stopped her, not where the site's email lost her.
  else if (!readCode) diedAt = doorRefused ? "refused-at-our-sue-door" : "before-code-read";
  else if (!signedIn) diedAt = "before-sign-in";
  else if (!interviewed && !hasWrongDestinationFinding) diedAt = "no-interview";
  else if (!endedWhereExpected) diedAt = "wrong-destination";
  // Wherever she stopped after SUE's browser closed under her, SUE stopped her, not the site.
  if (browserLost && diedAt !== "ended" && diedAt !== "refused-at-our-sue-door") diedAt = "sue-browser-lost";

  return {
    reachedSignup,
    requestedCode,
    readCode,
    signedIn,
    endedWhereExpected,
    gaveUp,
    reachedExits,
    refusedAtOurDoor: doorRefused,
    browserLost,
    diedAt,
  };
}

function buildFunnelSummary(sues, { doorRefused = new Set(), browserLost = new Set() } = {}) {
  const perSue = sues.map((s) => ({
    sueId: s.sueId,
    persona: personaOf(s),
    ...classifyFunnel(s, { doorRefused: doorRefused.has(s.sueId), browserLost: browserLost.has(s.sueId) }),
  }));
  const count = (pred) => perSue.filter(pred).length;
  const exits = {};
  for (const row of perSue) for (const id of row.reachedExits) exits[id] = (exits[id] || 0) + 1;
  return {
    exits,
    perSue,
    started: perSue.length,
    reachedSignup: count((r) => r.reachedSignup),
    requestedCode: count((r) => r.requestedCode),
    refusedAtOurDoor: count((r) => r.refusedAtOurDoor),
    browserLost: count((r) => r.browserLost),
    readCode: count((r) => r.readCode),
    signedIn: count((r) => r.signedIn),
    endedWhereExpected: count((r) => r.endedWhereExpected),
    gaveUp: count((r) => r.gaveUp),
  };
}

// ---------------------------------------------------------------------------------------------
// support - each Sue's own rule (her persona's `complains` wins over the run's `contactSupport`,
// `lib/personas.mjs`'s `supportRule`, recorded by `cannon.mjs` onto `sue.json`) told apart from
// whether she actually contacted them. A silent `contactedSupport` alone cannot say WHY she was
// silent - nobody wanted to, she was forbidden, or nothing was ever said (Example App for the owner,
// 2026-09-22: three Sues with support off sent nothing, but only by luck - off had emitted no
// sentence, so nothing told them not to). This is the whole per-Sue rule; `report.mjs` used to say
// nothing about support at all.
// ---------------------------------------------------------------------------------------------

/** Did she actually contact them, from her exit interview (`{ did }` or the older `{ yes }`). */
function didContactSupport(interview) {
  const c = interview?.contactedSupport;
  return Boolean(c && (c.did ?? c.yes));
}

export function buildSupport(sues) {
  const perSue = sues.map((s) => ({
    sueId: s.sueId,
    persona: personaOf(s),
    rule: s.sue?.supportRule ?? "unmentioned",
    contacted: didContactSupport(s.interview),
  }));
  const rules = { encouraged: 0, forbidden: 0, unmentioned: 0 };
  for (const row of perSue) rules[row.rule] = (rules[row.rule] ?? 0) + 1;
  return { perSue, rules, contactedCount: perSue.filter((row) => row.contacted).length };
}

// ---------------------------------------------------------------------------------------------
// OTP latency - from `body.json`'s `otpRequestedAt` / `otpEmailLatencyMs` / `firstInboxCheckAt`.
// `found` is derived (requested but `otpEmailLatencyMs` never landed = never found); "checked
// before it arrived" compares her first inbox check against the moment the mail actually landed
// (`otpRequestedAt + otpEmailLatencyMs`) - body.json carries no separate check COUNT.
// ---------------------------------------------------------------------------------------------

function buildOtpStats(sues, { doorRefused = new Set() } = {}) {
  const perSue = sues
    .map((s) => {
      const body = s.body || {};
      const requestedAt = body.otpRequestedAt ? Date.parse(body.otpRequestedAt) : null;
      const latencyMs = typeof body.otpEmailLatencyMs === "number" ? body.otpEmailLatencyMs : null;
      const firstCheckAt = body.firstInboxCheckAt ? Date.parse(body.firstInboxCheckAt) : null;
      const arrivedAt = requestedAt !== null && latencyMs !== null ? requestedAt + latencyMs : null;
      return {
        sueId: s.sueId,
        persona: personaOf(s),
        latencyMs,
        found: requestedAt !== null ? latencyMs !== null : null,
        checkedBeforeArrival: arrivedAt !== null && firstCheckAt !== null ? firstCheckAt < arrivedAt : null,
        refusedAtOurDoor: doorRefused.has(s.sueId),
      };
    })
    .filter((o) => o.latencyMs !== null || o.found !== null);
  const latencies = perSue.map((o) => o.latencyMs).filter((v) => typeof v === "number");
  return {
    perSue,
    p50Ms: median(latencies),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length ? Math.max(...latencies) : null,
    // A code our own Sue door never let the site send is not a code the site's email lost.
    neverFoundCount: perSue.filter((o) => o.found === false && !o.refusedAtOurDoor).length,
    refusedAtOurDoorCount: perSue.filter((o) => o.refusedAtOurDoor).length,
    checkedBeforeArrivalCount: perSue.filter((o) => o.checkedBeforeArrival === true).length,
  };
}

// ---------------------------------------------------------------------------------------------
// clock - median seconds to first click, per-page boredom, patience exhaustion.
// ---------------------------------------------------------------------------------------------

function firstClickSeconds(trace) {
  const clickEvent = (trace || []).find((t) => t.tool === "click");
  return typeof clickEvent?.clock?.elapsedSeconds === "number" ? clickEvent.clock.elapsedSeconds : null;
}

function buildClockStats(sues) {
  const firstClicks = sues.map((s) => firstClickSeconds(s.trace)).filter((v) => v !== null);
  const boredEvents = sues.reduce((sum, s) => sum + (s.findings || []).filter((f) => f.kind === "bored").length, 0);
  const patienceExhaustions = sues.reduce((sum, s) => sum + (s.findings || []).filter((f) => f.kind === "patience-exhausted").length, 0);
  return { medianSecondsToFirstClick: median(firstClicks), sampleSize: firstClicks.length, boredEvents, patienceExhaustions };
}

// ---------------------------------------------------------------------------------------------
// the message that sent her (`start: "inbox"`)
// ---------------------------------------------------------------------------------------------

/**
 * Did the email or post that sent her and the page it links to tell the same story? For every Sue
 * whose visit opened on the seeded arrival: whether she ever reached a page off her inbox (clicked
 * through), and what she said of the message with judge_email. `null` for a run nobody was sent to.
 */
export function buildArrival(sues) {
  const arrivalUrl = messageUrl(ARRIVAL_ID);
  const sent = sues.filter((s) => (s.trace || []).find((t) => t?.url)?.url === arrivalUrl);
  if (!sent.length) return null;
  const perSue = sent.map((s) => ({
    sueId: s.sueId,
    persona: personaOf(s),
    clickedThrough: (s.trace || []).some((t) => /^https?:/i.test(String(t?.url ?? "")) && !isInboxUrl(t.url)),
    whatIThought: (s.findings || []).filter((f) => f.kind === "email" && f.url === arrivalUrl).at(-1)?.text ?? null,
  }));
  return { sent: sent.length, clickedThrough: perSue.filter((s) => s.clickedThrough).length, perSue };
}

// ---------------------------------------------------------------------------------------------
// findings by kind, and the "is this trash" verdicts
// ---------------------------------------------------------------------------------------------

/** Findings about the wire, not the screen: listed after every kind she could see or feel. */
const MACHINE_KINDS = new Set(["slow-response", "slow-navigation", "console-error", "http-error"]);

function buildFindingsSummary(sues, { moved = new Set(), doorRefused = new Set(), browserLost = new Set() } = {}) {
  const byKind = new Map();
  for (const s of sues) {
    for (const f of s.findings || []) {
      // SUE-side suspects are counted in their own section, never as findings about the site.
      if (moved.has(f) || f.kind === SUE_DOOR_REFUSED || f.kind === SUE_BROWSER_LOST) continue;
      const key = f.kind || "unknown";
      if (!byKind.has(key)) byKind.set(key, []);
      byKind.get(key).push({ sueId: s.sueId, persona: personaOf(s), url: f.url ?? null, text: f.text ?? null, source: f.source ?? null });
    }
  }
  // What she saw and felt comes first: 170 slow calls on a canvas game buried its one tiny-text row
  // (SUE post-mortem, 2026-09-26). The machine's own kinds follow, each still by count.
  const kinds = [...byKind.entries()]
    .map(([kind, items]) => ({ kind, count: items.length, items }))
    .sort((a, b) => MACHINE_KINDS.has(a.kind) - MACHINE_KINDS.has(b.kind) || b.count - a.count);

  const trashRows = sues
    .map((s) => ({
      persona: personaOf(s),
      answer: s.interview?.isThisTrash,
      refusedAtOurDoor: doorRefused.has(s.sueId),
      browserLost: browserLost.has(s.sueId),
    }))
    .filter((row) => row.answer);
  const trashYes = trashRows.filter((row) => row.answer.yes === true).length;

  return {
    kinds,
    isThisTrashYesRate: trashRows.length ? trashYes / trashRows.length : null,
    isThisTrashWhys: trashRows.map((row) => ({
      persona: row.persona,
      why: row.answer.why ?? null,
      refusedAtOurDoor: row.refusedAtOurDoor,
      browserLost: row.browserLost,
    })),
  };
}

/**
 * The problems the Sues typed (a brain row carrying `problem`), worst first: severity down, an issue before a
 * warning, more sightings first, then filing order. Each `same` row joins its problem by `same.n` as one of
 * `seenBy`. `untyped` counts the problem lines (lib/findings.mjs PROBLEM_NOTE_KINDS) that carry neither, and a
 * sighting of a problem this report does not list (its filer's row was SUE-side): it carries only her words. SUE-side
 * rows (`moved`) are left out exactly as buildFindingsSummary leaves them out; a problem resent under its first ref
 * (lib/findings.mjs fileNote) is listed once. null when nothing was typed, so a report written before typed problems
 * existed is unchanged.
 */
export function buildFiled(sues, { moved = new Set() } = {}) {
  const typed = [];
  const sightings = [];
  const refs = new Set();
  let untyped = 0;
  for (const s of sues) {
    for (const f of s.findings || []) {
      if (f.source !== "brain" || moved.has(f)) continue;
      if (f.problem && typeof f.problem === "object") {
        if (f.problem.ref && refs.has(f.problem.ref)) continue;
        if (f.problem.ref) refs.add(f.problem.ref);
        typed.push({ s, f });
      } else if (f.same && Number.isInteger(f.same.n)) sightings.push({ s, f });
      else if (PROBLEM_NOTE_KINDS.includes(f.kind)) untyped += 1;
    }
  }
  if (!typed.length) return null;
  const said = (f) => String(f.text ?? "").trim();
  const problems = typed.map(({ s, f }) => {
    const p = f.problem;
    return {
      n: p.n ?? null,
      ref: p.ref ?? null,
      sueId: s.sueId,
      persona: personaOf(s),
      at: f.at ?? null,
      page: f.url ?? null,
      look: p.look ?? null,
      title: p.title ?? "",
      defect: p.defect ?? null,
      severity: p.severity ?? null,
      expected: p.expected ?? "",
      actual: p.actual ?? "",
      steps: Array.isArray(p.steps) ? p.steps : [],
      quoted: p.quoted ?? null,
      said: said(f),
      seenBy: sightings
        .filter(({ f: g }) => p.n !== undefined && p.n !== null && g.same.n === p.n)
        .map(({ s: t, f: g }) => ({ sueId: t.sueId, persona: personaOf(t), said: said(g) })),
    };
  });
  problems.sort(
    (a, b) =>
      (b.severity ?? 0) - (a.severity ?? 0) ||
      (a.defect === "warning") - (b.defect === "warning") ||
      b.seenBy.length - a.seenBy.length ||
      (a.n ?? Infinity) - (b.n ?? Infinity),
  );
  const listed = new Set(problems.map((p) => p.n));
  untyped += sightings.filter(({ f }) => PROBLEM_NOTE_KINDS.includes(f.kind) && !listed.has(f.same.n)).length;
  return { problems, untyped };
}

/**
 * The compact rows SUE's summary hands Dredd (sue.mjs runReport `problemsFiled`, read by dredd/lib/bug.mjs
 * filedLines): worst first as buildFiled sorted them, `seen` being how many visitors hit it, the filer included.
 */
export function filedList(filed, { limit = 20 } = {}) {
  return (filed?.problems ?? [])
    .slice(0, limit)
    .map((p) => ({
      n: p.n,
      ref: p.ref,
      sueId: p.sueId,
      persona: p.persona,
      page: p.page,
      look: p.look,
      title: p.title,
      defect: p.defect,
      severity: p.severity,
      expected: p.expected,
      actual: p.actual,
      steps: p.steps,
      quoted: p.quoted,
      seen: 1 + (p.seenBy?.length ?? 0),
    }));
}

// ---------------------------------------------------------------------------------------------
// the verdict - the two numbers the owner asked to be told FIRST (Owner, 2026-09-21): "couldn't
// even log in. What a trashy website. One star, moving on... they're done with the website, never
// gonna come back." Stars average and the share who are never coming back, with their reasons.
// ---------------------------------------------------------------------------------------------

/** A star rating we can believe: an integer 1-5. Anything else is a skipped answer, not a zero. */
function starOf(interview) {
  // A Sue who never looked at the page rated what she heard, not what she saw: never a star (body.mjs `unseen`).
  if (interview?.unseen) return null;
  const n = Number(interview?.starsOutOfFive);
  return Number.isFinite(n) && n >= 1 && n <= 5 ? Math.round(n) : null;
}

function averageOf(stars) {
  return stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : null;
}

/**
 * `doorRefused` is the ids of Sues our own sign-up door turned away, `browserLost` the ids of Sues
 * whose browser SUE lost mid-visit (`buildSueSide`). Their stars stay in the average, because they
 * did see the site, but the verdict says how many there were and what the rest rated: a one-star
 * "could not even sign up" or "the website vanished" is about SUE, not the site.
 */
export function buildVerdict(sues, { doorRefused = new Set(), browserLost = new Set() } = {}) {
  const stars = sues.map((s) => starOf(s.interview)).filter((n) => n !== null);
  const histogram = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  for (const n of stars) histogram[n] += 1;
  const rated = (s) => starOf(s.interview) !== null;
  const refusedStars = sues.filter((s) => doorRefused.has(s.sueId) && rated(s)).length;
  const lostStars = sues.filter((s) => browserLost.has(s.sueId) && !doorRefused.has(s.sueId) && rated(s)).length;
  const otherStars = sues
    .filter((s) => !doorRefused.has(s.sueId) && !browserLost.has(s.sueId))
    .map((s) => starOf(s.interview))
    .filter((n) => n !== null);

  const asked = sues.filter((s) => !s.interview?.unseen && typeof s.interview?.everComingBack?.yes === "boolean");
  const gone = asked.filter((s) => s.interview.everComingBack.yes === false);
  // A game's verdict is its screens next to the games she already has (lib/findings.mjs JUDGING_KEYS).
  // An APE visit is never a judged one, whatever keys it holds: its power user judged nothing on screen.
  const judgedKeys = Object.keys(JUDGING_KEYS);
  const screens = sues
    .filter((s) => !isApeScenario(s.sue?.scenario))
    .filter((s) => judgedKeys.some((key) => s.interview?.[key] != null && s.interview[key] !== ""))
    .map((s) => ({
      persona: personaOf(s),
      sueId: s.sueId,
      stars: starOf(s.interview),
      ...Object.fromEntries(judgedKeys.map((key) => [key, s.interview[key] ?? null])),
    }));
  const uiStars = screens.map((row) => Number(row.uiStars)).filter((n) => n >= 1 && n <= 5);

  return {
    averageStars: averageOf(stars),
    starHistogram: histogram,
    starsAnswered: stars.length,
    oneStarCount: histogram[1],
    refusedAtOurDoor: refusedStars,
    browserLost: lostStars,
    averageStarsWithoutSueSide: refusedStars || lostStars ? averageOf(otherStars) : null,
    averageUiStars: averageOf(uiStars),
    screens,
    neverComingBackCount: gone.length,
    neverComingBackShare: asked.length ? gone.length / asked.length : null,
    neverComingBackAnswered: asked.length,
    neverComingBackWhys: gone.map((s) => ({
      persona: personaOf(s),
      sueId: s.sueId,
      stars: starOf(s.interview),
      why: s.interview.everComingBack.why ?? null,
      refusedAtOurDoor: doorRefused.has(s.sueId),
      browserLost: browserLost.has(s.sueId),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// what the scenario itself asked - its own exit-interview questions (`scenario.interview`), each
// Sue's answer verbatim. The AI-answering scenario asks what the AI said to each thing she asked:
// that is the finding the whole run exists for, so it is never folded into a count.
// ---------------------------------------------------------------------------------------------

export function buildScenarioAnswers(sues) {
  const questions = new Map();
  // A judged key is the verdict's own ("How the screens looked"), never listed twice.
  for (const s of sues)
    for (const [key, question] of interviewExtras(s.sue?.scenario, true)) if (!questions.has(key)) questions.set(key, question);
  return [...questions].map(([key, question]) => ({
    key,
    question,
    answers: sues
      .map((s) => ({ persona: personaOf(s), sueId: s.sueId, said: s.interview?.[key] ?? null }))
      .filter((row) => row.said !== null && row.said !== ""),
  }));
}

/** An answer as it reads in a report: words verbatim, a list or an object as compact JSON. */
function answerText(said) {
  return typeof said === "string" ? said.trim() : JSON.stringify(said);
}

/** How deep a structured answer is laid out as bullets; anything deeper stays compact JSON. */
const ANSWER_DEPTH = 4;

/**
 * A list or object answer as nested markdown bullets, `depth` levels in: a list item per bullet
 * (a list or object item under a numbered `(n)`), an object as `key: value` bullets, strings verbatim.
 * Run 20260928-133054-5e00 printed topFixes, rewardMap and attentionTimeline as one raw JSON line each.
 */
function answerLines(said, depth = 1) {
  const pad = "  ".repeat(depth);
  const nested = (value) => value && typeof value === "object" && Object.keys(value).length > 0;
  const lines = [];
  const entries = Array.isArray(said)
    ? said.map((value, i) => [`(${i + 1})`, value, true])
    : Object.entries(said).map(([k, v]) => [k, v, false]);
  for (const [label, value, listed] of entries) {
    if (nested(value) && depth < ANSWER_DEPTH) {
      lines.push(`${pad}- ${listed ? label : `${label}:`}`);
      lines.push(...answerLines(value, depth + 1));
    } else if (listed) lines.push(`${pad}- ${answerText(value)}`);
    else lines.push(`${pad}- ${label}: ${answerText(value)}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// what confused them, verbatim - her own diary, unsummarized. This is the section the owner
// actually reads: "they need to be able to scratchboard, like a journal, like, yeah, I made it
// this far. No clue why the heck I'm here now. I am so confused."
// ---------------------------------------------------------------------------------------------

// The diary is her journal, so a `thought` is in it too: run 20260928-133054-5e00's only journal line
// was a thought, and with it left out the section said nobody wrote anything down. The SUE-side
// checks (`sueSideOf`) read the same kinds, so a thought about our frozen screen moves out with the rest.
const HER_OWN_VOICE = new Set(["confusion", "annoyance", "broken", "question", "thought"]);

/**
 * Where she was, short enough to read. A raw OAuth URL is ~400 characters of state and PKCE
 * challenge, and three of them in a row made the diary section - the part that exists to be READ -
 * unreadable on its first live run. Area plus path is all a reader needs to place her.
 */
function whereShortly(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url));
    const at = parsed.pathname === "/" ? "" : ` ${parsed.pathname}`;
    return `${areaOfUrl(url)}${at}`;
  } catch {
    return String(url).slice(0, 80);
  }
}

/**
 * Where attention broke and where it held, in the order it happened (Owner, 2026-09-27: "that part
 * of the video needs edited because it lost the user's attention. That's the level of retention").
 * Every `drop` and `hook` a Sue wrote (lib/findings.mjs ATTENTION_KINDS), per Sue in clock order,
 * with the why, fix and severity she filed beside it; then the pages that lost the most, and every
 * severity-3 drop together, because those are where most visitors leave. Empty when nobody wrote one.
 * The body's own `patience-exhausted` row is a drop too, marked `patienceExhausted`: her patience ran
 * out on that page, and it is the real drop even when her own note about it blamed the site.
 */
export function buildAttention(sues, { moved = new Set() } = {}) {
  const perSue = [];
  for (const s of sues) {
    const lines = (s.findings || [])
      .filter(
        (f) =>
          (f.source === "body" && f.kind === PATIENCE_EXHAUSTED) ||
          (f.source === "brain" && ATTENTION_KINDS.includes(f.kind) && !moved.has(f) && String(f.text ?? "").trim()),
      )
      .map((f) => ({
        kind: f.source === "body" ? "drop" : f.kind,
        visitSeconds: Number.isFinite(f.visitSeconds) ? f.visitSeconds : null,
        where: whereShortly(f.url),
        url: f.url ?? null,
        said: f.source === "body" ? "" : String(f.text).trim(),
        why: f.why ?? null,
        fix: f.fix ?? null,
        severity: Number.isInteger(f.severity) ? f.severity : null,
        ...(f.source === "body" ? { patienceExhausted: true } : {}),
      }));
    if (lines.length) perSue.push({ persona: personaOf(s), sueId: s.sueId, lines });
  }
  const all = perSue.flatMap((row) => row.lines.map((line) => ({ ...line, persona: row.persona, sueId: row.sueId })));
  const pages = new Map();
  for (const line of all) {
    const key = line.where ?? "unknown page";
    const page = pages.get(key) ?? { where: key, drops: 0, hooks: 0, severity: 0 };
    if (line.kind === "drop") {
      page.drops += 1;
      page.severity += line.severity ?? 1;
    } else page.hooks += 1;
    pages.set(key, page);
  }
  return {
    perSue,
    drops: all.filter((line) => line.kind === "drop").length,
    hooks: all.filter((line) => line.kind === "hook").length,
    worst: all.filter((line) => line.kind === "drop" && line.severity === 3),
    byPage: [...pages.values()].sort((a, b) => b.severity - a.severity || b.drops - a.drops),
  };
}

/** Seconds into a visit as m:ss, or null when the line carries none. */
export function clockText(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const whole = Math.round(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

// Two clocks, each named: her words carry how long a first-time visitor would have taken to get there, and her
// body's stopwatch (lib/clock.mjs) counts only reading at her words per minute, taps and waits, so it runs
// ahead on a page she reads whole and behind in a live game she watches (live, 2026-09-28: "0:05 on the
// landing page" at 0:20; a match clock of 8:02 at 0:41). Unlabelled side by side they read as one clock
// contradicting itself.
function attentionLine(line) {
  const at = clockText(line.visitSeconds);
  if (line.patienceExhausted) {
    return `DROP (patience-exhausted)${line.where ? ` on ${line.where}` : ""}${at ? ` (${at} on her stopwatch)` : ""}: her patience ran out here and SUE stopped her - nothing on the page failed`;
  }
  const label = line.kind === "drop" ? `DROP${line.severity ? ` ${line.severity}` : ""}` : "HOOK";
  const parts = [`${label}${line.where ? ` on ${line.where}` : ""}${at ? ` (${at} on her stopwatch)` : ""}: "${line.said}"`];
  if (line.why) parts.push(`why: ${line.why}`);
  if (line.fix) parts.push(`fix: ${line.fix}`);
  return parts.join(" - ");
}

export function buildConfusion(sues, { moved = new Set(), doorRefused = new Set(), browserLost = new Set() } = {}) {
  const diary = [];
  // What else she wrote (drops, hooks, email notes), by kind: an empty diary beside these is a Sue who
  // wrote elsewhere, never the silent Sue the empty-diary warning is for.
  const writtenElsewhere = {};
  for (const s of sues) {
    for (const f of s.findings || []) {
      if (f.source !== "brain") continue;
      const said = String(f.text ?? "").trim();
      if (!said) continue;
      if (!HER_OWN_VOICE.has(f.kind) || moved.has(f)) writtenElsewhere[f.kind] = (writtenElsewhere[f.kind] ?? 0) + 1;
      else diary.push({ persona: personaOf(s), sueId: s.sueId, kind: f.kind, url: f.url ?? null, where: whereShortly(f.url), said });
    }
  }
  const mostConfusing = sues
    .map((s) => ({
      persona: personaOf(s),
      sueId: s.sueId,
      said: String(s.interview?.mostConfusing ?? "").trim(),
      refusedAtOurDoor: doorRefused.has(s.sueId),
      browserLost: browserLost.has(s.sueId),
    }))
    .filter((row) => row.said);
  return { diary, mostConfusing, sueCountWithDiary: new Set(diary.map((d) => d.sueId)).size, writtenElsewhere };
}

// ---------------------------------------------------------------------------------------------
// SUE-side suspects - what SUE caused, or may have, told apart from what the site did. On
// 2026-09-22 every "Unable to process this request" on "Email me a code" was OUR Sue sign-up
// door's daily cap, and report.md still led three runs with "the email code flow is broken"; a
// morning went into an outage that did not exist. Two kinds, each moved out of the diary, the
// findings count and the email-code numbers into a section of their own:
//   - our door refused her: she asked for a code, the page showed the site's anti-bot refusal and
//     the mailroom never saw a code (the body's `sue-door-refused` note, or, for a run recorded
//     before the body watched for it, her own quote of the refusal plus her empty inbox);
//   - a possible perception fault: several byte-identical looks after clicks or scrolls
//     (`frozenLooks`), with the lines she wrote while the screen stood still.
// ---------------------------------------------------------------------------------------------

/** A diary line about the refused code: it names the code, her inbox or the verify step, and says it failed. */
const ABOUT_THE_CODE = /\bcode\b|inbox|verif/i;

/**
 * How the body's answer opens when it refused six digits she typed by hand as a guess at an email code
 * (body.mjs `type`, `codesNotGiven`; tests/typed-code.spec.mjs pins the body to it). Kept here, not in
 * lib/findings.mjs: that file is part of the hands, and an edit there makes every A/B arm a new one.
 */
export const CODE_REFUSED_TEXT = /^Do not type the code yourself\b/;
const SAYS_IT_FAILED = /error|fail|broke|stuck|loop|never|nothing|empty|n't|not sent|no code|no email/i;

/**
 * Her patience ran out (the body's `patience-exhausted` row): from then on SUE's gate refused every
 * move before it reached the page. On 2026-09-28 a visitor refused that way wrote a severity-1 DROP,
 * "the site stopped responding to clicks - every action bounced", and the report carried it as a site
 * failure. A line written after that moment which blames the site is SUE's own refusal described,
 * unless the body saw the site fail (`SITE_FAILED_KINDS`), which is the only failure the record shows.
 */
const PATIENCE_EXHAUSTED = "patience-exhausted";
const BLAMES_THE_SITE =
  /stopp?ed (?:respond|work)|not respond|unresponsive|bounc|nothing happen|(?:did|does|would)(?:n't| not) (?:work|respond|do anything|load)|broke|froze|frozen|stuck|hung|dead|crash|error|fail/i;
const SITE_FAILED_KINDS = new Set(["http-error", "slow-response", "slow-navigation"]);

function atMs(stamp) {
  const ms = Date.parse(String(stamp ?? ""));
  return Number.isFinite(ms) ? ms : null;
}

/** When our door refused her, or null. The body's own note wins; an older run is read from her words. */
function doorRefusedAt(s) {
  const findings = s.findings || [];
  const body = s.body || {};
  const noted = findings.find((f) => f.source === "body" && f.kind === SUE_DOOR_REFUSED);
  if (noted) return noted.at ?? body.doorRefusedAt ?? body.otpRequestedAt ?? null;
  if (body.doorRefusedAt) return body.doorRefusedAt;
  if (!body.otpRequestedAt) return null;
  const quoted = findings
    .filter((f) => f.source === "brain" && SUE_DOOR_REFUSAL_TEXT.test(String(f.text ?? "")))
    .sort((a, b) => (atMs(a.at) ?? 0) - (atMs(b.at) ?? 0));
  const saw = quoted.length ? quoted.map((f) => f.text).join("\n") : JSON.stringify(s.interview ?? {});
  // Her inbox when the run kept one; else the body's own word that no code was ever read.
  const inbox = Array.isArray(s.mail) ? s.mail : body.otpEmailLatencyMs == null ? [] : null;
  if (!inbox || !sueDoorRefused({ saw, otpRequestedAt: body.otpRequestedAt, inbox })) return null;
  return quoted[0]?.at ?? body.otpRequestedAt;
}

function within(stamp, startAt, endAt) {
  const t = atMs(stamp);
  const start = atMs(startAt);
  const end = atMs(endAt);
  return t !== null && start !== null && t >= start && (end === null || t < end);
}

function lineOf(f) {
  return { kind: f.kind, where: whereShortly(f.url), said: String(f.text ?? "").trim(), at: f.at ?? null };
}

/** One Sue's SUE-side lines (door, frozen screen, lost browser); complaints.mjs reads them too, so there is one rule. */
export function sueSideOf(s) {
  const refusedAt = doorRefusedAt(s);
  const voice = (s.findings || []).filter((f) => f.source === "brain" && HER_OWN_VOICE.has(f.kind));
  const from = atMs(refusedAt);
  const doorLines =
    refusedAt === null
      ? []
      : voice.filter((f) => {
          const text = String(f.text ?? "");
          if (SUE_DOOR_REFUSAL_TEXT.test(text)) return true;
          const t = atMs(f.at);
          return (t === null || from === null || t >= from) && ABOUT_THE_CODE.test(text) && SAYS_IT_FAILED.test(text);
        });
  const stretches = frozenLooks(s.trace || []);
  const frozenLines = voice.filter((f) => !doorLines.includes(f) && stretches.some((st) => within(f.at, st.startAt, st.endAt)));
  // Every line she wrote while SUE's browser was closed under her, whatever its kind (her give-up
  // and her last thought too): she was describing our dead browser, not the site.
  const lostWindows = browserLostWindows(s);
  const lostLines = (s.findings || []).filter(
    (f) =>
      f.source === "brain" &&
      !doorLines.includes(f) &&
      !frozenLines.includes(f) &&
      lostWindows.some((w) => within(f.at, w.startAt, w.endAt)),
  );
  // SUE's code guard refused six digits she typed by hand and no code ever came out of her inbox: her lines from then on
  // about the code failing describe that refusal, not the site.
  const trace = s.trace || [];
  const codeRefusal = trace.find((t) => t?.tool === "type" && t.isError === true && CODE_REFUSED_TEXT.test(String(t.result ?? "")));
  const inboxGaveIt = trace.some((t) => t?.tool === "type" && t.args?.field === "the-code-from-my-email" && t.isError !== true);
  const codeRefusedAt = codeRefusal && !inboxGaveIt ? (codeRefusal.at ?? null) : null;
  const codeLines =
    codeRefusedAt === null
      ? []
      : voice.filter(
          (f) =>
            !doorLines.includes(f) &&
            !frozenLines.includes(f) &&
            !lostLines.includes(f) &&
            within(f.at, codeRefusedAt, null) &&
            ABOUT_THE_CODE.test(String(f.text ?? "")) &&
            SAYS_IT_FAILED.test(String(f.text ?? "")),
        );
  // Every line after her patience ran out that blames a site the body never saw fail (her give-up too).
  const tiredAt = (s.findings || []).find((f) => f.source === "body" && f.kind === PATIENCE_EXHAUSTED && f.at)?.at ?? null;
  const siteFailed = (s.findings || []).some((f) => f.source === "body" && SITE_FAILED_KINDS.has(f.kind));
  const tiredLines =
    tiredAt === null || siteFailed
      ? []
      : (s.findings || []).filter(
          (f) =>
            f.source === "brain" &&
            !doorLines.includes(f) &&
            !frozenLines.includes(f) &&
            !lostLines.includes(f) &&
            !codeLines.includes(f) &&
            within(f.at, tiredAt, null) &&
            BLAMES_THE_SITE.test(String(f.text ?? "")),
        );
  return {
    sueId: s.sueId,
    persona: personaOf(s),
    refusedAt,
    doorLines,
    stretches,
    frozenLines,
    lostWindows,
    lostLines,
    codeRefusedAt,
    codeLines,
    tiredAt,
    tiredLines,
  };
}

/**
 * A look that showed her a real page again: the browser is back. Any look that answered and was not
 * the dead browser speaking - never the `[address bar]` line, which only a tech-savvy (4-5) Sue is
 * shown, so a grandma's window would never have closed and every word after it would have been lost.
 * The body's own "you opened it again" answer is not a page yet; her next look is.
 */
const sawAPage = (t, said) =>
  t?.tool === "look" && t?.isError !== true && !BROWSER_LOST_TEXT.test(said) && !said.startsWith(BROWSER_REOPENED);

/**
 * The stretches SUE's own browser was closed under her: each opens at the body's `sue-browser-lost`
 * note or the first tool answer saying the browser closed, and ends at the next look that showed her
 * a page (`endAt` null when it never came back). On 2026-09-23 one Sue's browser came back when she
 * opened her email four minutes later, and her next twenty lines were about the real site. Since the
 * same day the body reopens it for her (body.mjs `reopenBrowser`), so coming back is the usual end.
 */
function browserLostWindows(s) {
  const windows = [];
  let open = null;
  const noted = (s.findings || []).filter((f) => f.source === "body" && f.kind === SUE_BROWSER_LOST && f.at).map((f) => f.at);
  const events = [
    ...noted.map((at) => ({ at, lost: true })),
    ...(s.trace || []).map((t) => {
      const said = String(t?.result ?? t?.error ?? "");
      return { at: t?.at, lost: BROWSER_LOST_TEXT.test(said), back: sawAPage(t, said) };
    }),
  ]
    .filter((e) => atMs(e.at) !== null)
    .sort((a, b) => atMs(a.at) - atMs(b.at));
  for (const e of events) {
    if (e.lost && !open) {
      open = { startAt: e.at, endAt: null };
      windows.push(open);
    } else if (e.back && open) {
      open.endAt = e.at;
      open = null;
    }
  }
  return windows;
}

/**
 * `{ doorRefused, frozen, browserLost, tired, codeRefused }` for the report (plain data), plus `moved` (the diary
 * findings that left the diary, by identity) and `doorRefusedIds` / `browserLostIds` for the
 * builders that must leave them out.
 */
export function buildSueSide(sues = []) {
  const per = sues.map(sueSideOf);
  const doorRefused = per
    .filter((p) => p.refusedAt !== null)
    .map((p) => ({ sueId: p.sueId, persona: p.persona, at: p.refusedAt, lines: p.doorLines.map(lineOf) }));
  const frozen = per
    .filter((p) => p.stretches.length)
    .map((p) => ({ sueId: p.sueId, persona: p.persona, stretches: p.stretches, lines: p.frozenLines.map(lineOf) }));
  const browserLost = per
    .filter((p) => p.lostWindows.length)
    .map((p) => ({
      sueId: p.sueId,
      persona: p.persona,
      at: p.lostWindows[0].startAt,
      backAt: p.lostWindows.at(-1).endAt,
      windows: p.lostWindows,
      lines: p.lostLines.map(lineOf),
    }));
  const tired = per
    .filter((p) => p.tiredLines.length)
    .map((p) => ({ sueId: p.sueId, persona: p.persona, at: p.tiredAt, lines: p.tiredLines.map(lineOf) }));
  const codeRefused = per
    .filter((p) => p.codeRefusedAt !== null)
    .map((p) => ({ sueId: p.sueId, persona: p.persona, at: p.codeRefusedAt, lines: p.codeLines.map(lineOf) }));
  return {
    doorRefused,
    frozen,
    browserLost,
    tired,
    codeRefused,
    moved: new Set(per.flatMap((p) => [...p.doorLines, ...p.frozenLines, ...p.lostLines, ...p.codeLines, ...p.tiredLines])),
    doorRefusedIds: new Set(doorRefused.map((d) => d.sueId)),
    browserLostIds: new Set(browserLost.map((d) => d.sueId)),
    // Whose browser never came back: where she stopped is SUE's doing, not the site's.
    browserGoneIds: new Set(browserLost.filter((d) => d.backAt === null).map((d) => d.sueId)),
  };
}

// ---------------------------------------------------------------------------------------------
// assembling and rendering one run's report
// ---------------------------------------------------------------------------------------------

/**
 * A Sue whose brain never authenticated did not see the page, so she is NOT data: she is excluded
 * from every count and reported as a broken session instead. On 2026-09-21 an expired OAuth session
 * produced 400 of these and this file rendered them as "no-idea: 400" - a tool failure wearing a
 * product finding's clothes. Splits into the Sues who really visited and the dead ones.
 */
export function partitionByBrain(sues = []) {
  const dead = sues.filter((s) => s?.summary?.outcome === "brain-error" || (s?.summary?.brainError && !s?.interview));
  const alive = sues.filter((s) => !dead.includes(s));
  const reasons = new Map();
  for (const s of dead) {
    const why = s.summary.brainError || "the brain failed before it spoke";
    reasons.set(why, (reasons.get(why) || 0) + 1);
  }
  return { alive, dead, reasons: [...reasons.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count) };
}

// ---------------------------------------------------------------------------------------------
// the focus group's room (lib/room.mjs). Owner, 2026-09-23: "they all agree and they give you
// literally what their biggest problem is. Then you fix that. Then you send in the next focus
// group." Only a focus-group run has a room, so every other report is exactly what it was.
// ---------------------------------------------------------------------------------------------

/**
 * What the room agreed, or that it never did: the verdict as `conclude` wrote it, every problem that
 * was on the table with its backers, the builders' own guesses, the last focus group's verdict on
 * this page, and each Sue's own answer to the biggest-problem question in her exit interview, which
 * may not be the room's. `lines` is how many lines were said in the room, never the lines themselves
 * (the room route serves those). Null when the run is not a focus group.
 */
export function buildRoom(runDir, sues = []) {
  const snapshot = runDir ? roomSnapshot(runDir) : null;
  if (!snapshot) return null;
  const meta = snapshot.meta ?? {};
  const names = new Map(snapshot.seats.map((seat) => [seat.id, seat.name]));
  return {
    verdict: snapshot.verdict ?? null,
    table: snapshot.table,
    size: snapshot.seats.length,
    phase: snapshot.phase,
    moderator: meta.moderator === "none" ? "none" : "ai",
    lines: snapshot.lines.length,
    suggestions: meta.suggestions ?? [],
    previous: meta.previous ?? null,
    onTheirOwn: sues
      .map((s) => ({ name: names.get(s.sueId) ?? personaOf(s), sueId: s.sueId, said: s.interview?.[BIGGEST_PROBLEM_KEY] ?? null }))
      .filter((row) => row.said !== null && row.said !== ""),
  };
}

/** An ad viewer run's answers, read across the Sues that watched an ad: the stop share, what it felt like, and each answer as written. */
export function buildAdViewers(sues) {
  const ads = sues.filter((s) => isAdScenario(s.sue?.scenario) && s.interview);
  if (!ads.length) return null;
  const tally = (values) =>
    Object.fromEntries(
      [...values.reduce((counts, v) => counts.set(v, (counts.get(v) ?? 0) + 1), new Map())].sort(
        (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
      ),
    );
  const shortLead = (value) => {
    const text = value && typeof value === "object" ? (value.kind ?? value.move) : value;
    if (typeof text !== "string") return "no answer";
    return (
      text
        .split(/,|\.|\bbecause\b/i)[0]
        .trim()
        .toLowerCase() || "no answer"
    );
  };
  const stars = ads.map((s) => s.interview.starsOutOfFive).filter((n) => typeof n === "number");
  const believed = ads.map((s) => yesNoOf(s.interview.believeIt)).filter((v) => v !== null);
  return {
    sues: ads.length,
    stoppedScrolling: ads.filter((s) => yesNoOf(s.interview.stopScrolling) === true).length,
    believeIt: { yes: believed.filter(Boolean).length, no: believed.filter((v) => !v).length },
    feltLike: tally(ads.map((s) => shortLead(s.interview.feltLike))),
    nextMove: tally(ads.map((s) => shortLead(s.interview.nextMove))),
    starsOutOfFive: stars.length ? Math.round((stars.reduce((a, b) => a + b, 0) / stars.length) * 10) / 10 : null,
    verbatim: ads.map((s) => ({
      sueId: s.sueId,
      persona: personaOf(s),
      answers: Object.fromEntries(AD_INTERVIEW_KEYS.map((key) => [key, s.interview[key] ?? null])),
    })),
  };
}

/**
 * The APE power users, read across the Sues that ran as a power user (`ape: true`): how annoyed and how well they rated it,
 * whether they would use it daily, whether it lost their work, what they would fix first, and every answer that broke an
 * expectation or a shortcut, verbatim with the Sue who said it. Null when no power user answered.
 */
export function buildApe(sues) {
  const apes = sues.filter((s) => isApeScenario(s.sue?.scenario) && s.interview);
  if (!apes.length) return null;
  const mean = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
  // A fix lead is its first clause, lower-cased, so "autosave, mostly" and "autosave" count as one fix.
  const leadOf = (value) => {
    if (typeof value !== "string") return "no answer";
    return (
      value
        .split(/,|\.|\bbecause\b/i)[0]
        .trim()
        .toLowerCase() || "no answer"
    );
  };
  const fixes = apes.reduce((counts, s) => {
    if (s.interview.fixFirst == null) return counts;
    const lead = leadOf(s.interview.fixFirst);
    return counts.set(lead, (counts.get(lead) ?? 0) + 1);
  }, new Map());
  const given = (key) =>
    apes
      .filter((s) => typeof s.interview[key] === "string" && s.interview[key].trim())
      .map((s) => ({ sueId: s.sueId, persona: personaOf(s), answer: s.interview[key] }));
  const daily = apes.map((s) => yesNoOf(s.interview.wouldUseDaily)).filter((v) => v !== null);
  return {
    sues: apes.length,
    annoyanceScore: mean(apes.map((s) => s.interview.annoyanceScore).filter((n) => typeof n === "number")),
    starsOutOfFive: mean(apes.map((s) => s.interview.starsOutOfFive).filter((n) => typeof n === "number")),
    wouldUseDaily: { yes: daily.filter(Boolean).length, no: daily.filter((v) => !v).length },
    lostWork: apes.filter((s) => yesNoOf(s.interview.lostWork) === true).length,
    fixFirst: Object.fromEntries([...fixes].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))),
    brokeExpectations: given("brokeExpectations"),
    shortcutsThatFailed: given("shortcutsThatFailed"),
  };
}

/**
 * The ART design review (sue/README.md#art), read across the Sues that ran as a designer (lib/personas.mjs isArtPersona):
 * who walked it on which devices, the average design grade, who would ship it, every severity 3 polish line team-wide (fix
 * these first), the screens by design debt, each designer's own answers, and every polish and keep line in clock order.
 * Null when no designer ran. ART designers' stars are rated like the critics' (buildVerdict), so nothing here adds a star.
 */
export function buildArt(sues) {
  const arts = sues.filter((s) => isArtPersona(s.sue?.persona));
  if (!arts.length) return null;
  const devices = {};
  for (const s of arts) {
    const device = s.sue.persona?.dials?.device === "phone" ? "phone" : "desktop";
    devices[device] = (devices[device] ?? 0) + 1;
  }
  const screenOf = (url) => {
    try {
      const u = new URL(url);
      return `${u.pathname}${u.search}${u.hash}`;
    } catch {
      return String(url ?? "") || "/";
    }
  };
  const lines = arts
    .flatMap((s) =>
      (s.findings ?? [])
        .filter((f) => ART_KINDS.includes(f.kind))
        .map((f) => ({
          sueId: s.sueId,
          by: personaOf(s),
          kind: f.kind,
          screen: screenOf(f.url),
          text: String(f.text ?? ""),
          why: f.why ?? null,
          fix: f.fix ?? null,
          severity: f.kind === "polish" ? f.severity : null,
          visitSeconds: Number.isFinite(f.visitSeconds) ? f.visitSeconds : null,
        })),
    )
    .sort((a, b) => (a.visitSeconds ?? 0) - (b.visitSeconds ?? 0));
  // A designer who never saw the page (interview `unseen`) gave no grade or ship verdict of it: left out, as starOf does.
  const saw = arts.filter((s) => !s.interview?.unseen);
  const grades = saw.map((s) => s.interview?.designGrade).filter((n) => typeof n === "number");
  const ships = saw.map((s) => yesNoOf(s.interview?.wouldShip));
  const debt = new Map();
  for (const line of lines) {
    const row = debt.get(line.screen) ?? { screen: line.screen, score: 0, polish: 0, keep: 0 };
    if (line.kind === "polish") {
      row.score += line.severity;
      row.polish += 1;
    } else row.keep += 1;
    debt.set(line.screen, row);
  }
  const mean = (values) => (values.length ? Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 10) / 10 : null);
  return {
    designers: arts.length,
    devices,
    grade: mean(grades),
    wouldShip: { yes: ships.filter((v) => v === true).length, no: ships.filter((v) => v === false).length },
    fixFirst: lines
      .filter((l) => l.kind === "polish" && l.severity === 3)
      .map((l) => ({ screen: l.screen, text: l.text, fix: l.fix, why: l.why, severity: l.severity, by: l.by })),
    debtByScreen: [...debt.values()].sort((a, b) => b.score - a.score || b.polish - a.polish || a.screen.localeCompare(b.screen)),
    answers: arts.map((s) => ({
      sueId: s.sueId,
      persona: personaOf(s),
      device: s.sue.persona?.dials?.device === "phone" ? "phone" : "desktop",
      designGrade: s.interview?.designGrade ?? null,
      wouldShip: s.interview?.wouldShip ?? null,
      topFixes: s.interview?.topFixes ?? null,
      progressiveDisclosure: s.interview?.progressiveDisclosure ?? null,
      screenFit: s.interview?.screenFit ?? null,
      keep: s.interview?.keep ?? null,
    })),
    lines: lines.map(({ sueId, by, kind, screen, text, why, fix, severity, visitSeconds }) => ({
      sueId,
      by,
      kind,
      screen,
      text,
      why,
      fix,
      severity,
      visitSeconds,
    })),
  };
}

export function buildReport({ runId, runDir = null, manifest, sues: allSues, groundTruth }) {
  const { alive: sues, dead, reasons } = partitionByBrain(allSues);
  const side = buildSueSide(sues);
  const doorRefused = side.doorRefusedIds;
  const browserLost = side.browserLostIds;
  const room = buildRoom(runDir, sues);
  // Only a run someone ran repros against (sue/repro.mjs) has a repro.json, and only its report a `repro` key.
  const repro = runDir ? reproSections(runDir) : null;
  // Only a run where a Sue typed a problem has a `filed` key.
  const filed = buildFiled(sues, { moved: side.moved });
  // In a focus group each Sue's own biggest problem is the room's section, never a second list here.
  const scenarioAnswers = buildScenarioAnswers(sues).filter((q) => !room || q.key !== BIGGEST_PROBLEM_KEY);
  const adViewers = buildAdViewers(sues);
  const ape = buildApe(sues);
  const art = buildArt(sues);
  return {
    runId,
    // ⛔ Set by the cannon when OUR OWN apparatus died mid-run (today: the mailroom exiting, which
    // makes every inbox stay empty and every Sue blame the site for a code that was never fetched).
    // It is the first thing rendered, because a verdict built on a broken instrument is not a weaker
    // verdict - it is a statement about the tool wearing the product's clothes. Measured 2026-09-22:
    // a dead poller produced "1.1 stars from 22 visitors" over a signup path that was working.
    toolFailure: manifest.toolFailure ?? null,
    broken: { count: dead.length, ofTotal: allSues.length, reasons },
    target: manifest.target ?? null,
    scenario: manifest.scenario ?? null,
    exits: manifest.exits ?? [],
    generatedAt: new Date().toISOString(),
    sueCount: sues.length,
    ...(repro ? { repro } : {}),
    sueSide: {
      doorRefused: side.doorRefused,
      frozen: side.frozen,
      browserLost: side.browserLost,
      tired: side.tired,
      codeRefused: side.codeRefused,
    },
    verdict: buildVerdict(sues, { doorRefused, browserLost }),
    // Only a focus group's report has a `room` key at all.
    ...(room ? { room } : {}),
    ...(filed ? { filed } : {}),
    scenarioAnswers,
    attention: buildAttention(sues, { moved: side.moved }),
    confusion: buildConfusion(sues, { moved: side.moved, doorRefused, browserLost }),
    comprehension: buildComprehension(sues, groundTruth),
    firstLook: buildFirstLook(sues, groundTruth),
    funnel: buildFunnelSummary(sues, { doorRefused, browserLost: side.browserGoneIds }),
    support: buildSupport(sues),
    otp: buildOtpStats(sues, { doorRefused }),
    clock: buildClockStats(sues),
    arrival: buildArrival(sues),
    findings: buildFindingsSummary(sues, { moved: side.moved, doorRefused, browserLost }),
    // Only a run on a recorded tape has `offTape`: the moves the tape could not answer (tape/body.mjs), per Sue.
    ...(manifest.tape || offTapeOf(sues).total ? { offTape: offTapeOf(sues) } : {}),
    ...(adViewers ? { adViewers } : {}),
    ...(ape ? { ape } : {}),
    // Null when no designer ran (buildArt); a run with designers carries the whole review.
    art,
  };
}

/** The trace rows a tape body marked `offTape: true`, in total and per Sue (a Sue with none is not listed). */
export function offTapeOf(sues) {
  const perSue = {};
  let total = 0;
  for (const s of sues) {
    const n = (s.trace || []).filter((row) => row?.offTape === true).length;
    if (!n) continue;
    perSue[s.sueId] = n;
    total += n;
  }
  return { total, perSue };
}

function msToSeconds(ms) {
  return ms === null || ms === undefined ? "n/a" : Math.round(ms / 1000);
}

function sueCountText(n) {
  return `${n} Sue${n === 1 ? "" : "s"}`;
}

/** How a row about a Sue SUE failed is marked wherever her own words are quoted, or null. */
function sueSideTag(row) {
  if (row?.refusedAtOurDoor) return "refused at our door";
  if (row?.browserLost) return "SUE lost her browser";
  return null;
}

/** How many Sues a SUE-side list names before it says "and N more". */
const SUE_SIDE_LIMIT = 12;

/** The SUE-side suspects section, or nothing on a run where SUE caused nothing it can see. */
function renderAdViewers(ad, lines) {
  if (!ad) return;
  const counts = (table) =>
    Object.entries(table)
      .map(([key, n]) => `${key} (${n})`)
      .join(", ") || "none";
  lines.push("## The ad viewers", "");
  lines.push(`${ad.sues} watched the ad; ${ad.stoppedScrolling} stopped scrolling for it.`);
  lines.push(`Believed it: ${ad.believeIt.yes} yes, ${ad.believeIt.no} no.`);
  if (ad.starsOutOfFive != null) lines.push(`Average stars for more ads like it: ${ad.starsOutOfFive} of 5.`);
  lines.push(`Felt like: ${counts(ad.feltLike)}.`);
  lines.push(`Next move: ${counts(ad.nextMove)}.`, "");
  for (const row of ad.verbatim) {
    lines.push(`### ${row.persona ?? row.sueId}`, "");
    for (const [key, value] of Object.entries(row.answers)) {
      const text = value === null ? "(skipped)" : typeof value === "object" ? JSON.stringify(value) : String(value);
      lines.push(`- ${key}: ${text}`);
    }
    lines.push("");
  }
}

/** The APE power users' section: the means, the daily count, lost work, fix leads, then every broken expectation and shortcut verbatim. */
function renderApe(ape, lines) {
  if (!ape) return;
  const counts = (table) =>
    Object.entries(table)
      .map(([key, n]) => `${key} (${n})`)
      .join(", ") || "none";
  lines.push("## APE: power users", "");
  lines.push(`${ape.sues} power user${ape.sues === 1 ? "" : "s"} used it the way they use it every day.`);
  if (ape.annoyanceScore != null) lines.push(`Average annoyance: ${ape.annoyanceScore} of 10.`);
  if (ape.starsOutOfFive != null) lines.push(`Average stars they would really leave: ${ape.starsOutOfFive} of 5.`);
  lines.push(`Would use it every day: ${ape.wouldUseDaily.yes} yes, ${ape.wouldUseDaily.no} no. Lost their work: ${ape.lostWork}.`);
  lines.push(`Fix first: ${counts(ape.fixFirst)}.`, "");
  if (ape.brokeExpectations.length) {
    lines.push("### Broke their expectations", "");
    for (const row of ape.brokeExpectations) lines.push(`- ${row.persona ?? row.sueId}: ${row.answer}`);
    lines.push("");
  }
  if (ape.shortcutsThatFailed.length) {
    lines.push("### Shortcuts that failed", "");
    for (const row of ape.shortcutsThatFailed) lines.push(`- ${row.persona ?? row.sueId}: ${row.answer}`);
    lines.push("");
  }
}

/**
 * The ART design review: who walked it, the grade, who would ship it, the severity 3 polish lines to fix first, the screens by
 * design debt, each designer's ranked fixes and answers, then every polish and keep line in clock order.
 */
function renderArt(art, lines) {
  if (!art) return;
  lines.push("## ART: design review", "");
  const devices = Object.entries(art.devices)
    .map(([device, n]) => `${n} on ${device === "phone" ? `${n === 1 ? "a phone" : "phones"}` : `${n === 1 ? "a computer" : "computers"}`}`)
    .join(", ");
  lines.push(`${art.designers} designer${art.designers === 1 ? "" : "s"} walked it: ${devices}.`);
  lines.push(art.grade === null ? "Design grade: nobody gave one." : `Design grade: ${art.grade} of 10.`);
  lines.push(`Would ship: ${art.wouldShip.yes} yes, ${art.wouldShip.no} no.`, "");
  if (art.fixFirst.length) {
    lines.push("### Fix these first", "");
    for (const f of art.fixFirst) lines.push(`- ${f.screen}: ${f.text} - ${f.fix} [${f.why ?? "judgement"}] (${f.by})`);
    lines.push("");
  }
  if (art.debtByScreen.length) {
    lines.push("### Screens by design debt", "");
    for (const row of art.debtByScreen) lines.push(`- ${row.screen}: debt ${row.score} (${row.polish} polish, ${row.keep} keep)`);
    lines.push("");
  }
  const section = (title, key) => {
    const rows = art.answers.filter((a) => typeof a[key] === "string" && a[key].trim());
    if (!rows.length) return;
    lines.push(`### ${title}`, "");
    for (const row of rows) lines.push(`- ${row.persona}: ${row[key]}`);
    lines.push("");
  };
  section("Top fixes", "topFixes");
  section("Progressive disclosure", "progressiveDisclosure");
  section("Screen fit", "screenFit");
  section("Keep", "keep");
  if (art.lines.length) {
    lines.push("### Polish and keep, in clock order", "");
    for (const line of art.lines) {
      const at = line.visitSeconds === null ? "" : `${clockText(line.visitSeconds)} `;
      const level = line.kind === "polish" ? ` ${line.severity}` : "";
      const fix = line.fix ? ` Fix: ${line.fix}.` : "";
      lines.push(`- ${at}${line.by} ${line.kind}${level} on ${line.screen}: ${line.text}.${fix} Why: ${line.why ?? "judgement"}.`);
    }
    lines.push("");
  }
}

function renderSueSide(side, lines) {
  if (
    !side ||
    (!side.doorRefused?.length && !side.frozen?.length && !side.browserLost?.length && !side.tired?.length && !side.codeRefused?.length)
  )
    return;
  lines.push("");
  lines.push("## SUE-side suspects - check SUE before the site");
  lines.push("");
  lines.push("SUE caused these, or may have. They are kept out of the diary, the findings count and the email-code numbers below.");
  const more = (list) => (list.length > SUE_SIDE_LIMIT ? [`  - and ${list.length - SUE_SIDE_LIMIT} more`] : []);
  if (side.doorRefused.length) {
    lines.push("");
    lines.push(
      `- Our own Sue sign-up door refused ${sueCountText(side.doorRefused.length)}: each asked for a code, the page said "Unable to process this request" and no code reached her inbox. ` +
        "That is our door (its key or the robot check behind it), not the site's email. The accounts request-otp log names the reason on its `[sue-door]` line.",
    );
    for (const d of side.doorRefused.slice(0, SUE_SIDE_LIMIT)) {
      lines.push(
        `  - ${d.persona} (${d.sueId})${d.lines.length ? `: ${d.lines.length} diary line${d.lines.length === 1 ? "" : "s"} left out` : ""}`,
      );
    }
    lines.push(...more(side.doorRefused));
  }
  if (side.browserLost?.length) {
    lines.push("");
    lines.push(
      `- SUE's own browser closed under ${sueCountText(side.browserLost.length)} mid-visit ("Target page, context or browser has been closed"). ` +
        "The page did not vanish; our browser did. What each wrote while it was closed is left out of the diary and the findings count.",
    );
    const clock = (at) => String(at ?? "").slice(11, 19) || "an unknown time";
    for (const b of side.browserLost.slice(0, SUE_SIDE_LIMIT)) {
      lines.push(
        `  - ${b.persona} (${b.sueId}) at ${clock(b.at)} UTC, ${b.backAt ? `back at ${clock(b.backAt)}` : "never came back"}` +
          (b.lines.length ? `: ${b.lines.length} line${b.lines.length === 1 ? "" : "s"} left out` : ""),
      );
    }
    lines.push(...more(side.browserLost));
  }
  if (side.tired?.length) {
    lines.push("");
    lines.push(
      `- ${sueCountText(side.tired.length)} ran out of patience, and SUE refused every move after that before it reached the page. ` +
        "What each wrote afterwards blaming the site describes that refusal, not the site, so it is left out; her drop is filed as patience-exhausted.",
    );
    for (const t of side.tired.slice(0, SUE_SIDE_LIMIT)) {
      lines.push(
        `  - ${t.persona} (${t.sueId})${t.lines.length ? `: ${t.lines.length} line${t.lines.length === 1 ? "" : "s"} left out` : ""}`,
      );
    }
    lines.push(...more(side.tired));
  }
  if (side.codeRefused?.length) {
    lines.push("");
    lines.push(
      `- SUE's code guard refused a code ${sueCountText(side.codeRefused.length)} typed by hand, and no code ever came out of her inbox. ` +
        "Her code came from somewhere the guard did not know (a text her errand named, the page itself), so what she wrote about it failing is left out.",
    );
    for (const c of side.codeRefused.slice(0, SUE_SIDE_LIMIT)) {
      lines.push(
        `  - ${c.persona} (${c.sueId})${c.lines.length ? `: ${c.lines.length} line${c.lines.length === 1 ? "" : "s"} left out` : ""}`,
      );
    }
    lines.push(...more(side.codeRefused));
  }
  if (side.frozen.length) {
    lines.push("");
    lines.push(
      `- Possible SUE perception fault: ${sueCountText(side.frozen.length)} saw the same screen, byte for byte, after several clicks or scrolls. Open those shots before blaming the page.`,
    );
    for (const f of side.frozen.slice(0, SUE_SIDE_LIMIT)) {
      const stretches = f.stretches.map((st) => `${st.fromShot} to ${st.toShot}, after ${st.hands.join(", ")}`).join("; ");
      lines.push(`  - ${f.persona} (${f.sueId}): ${stretches}`);
    }
    lines.push(...more(side.frozen));
    const words = side.frozen.flatMap((f) => f.lines.map((line) => ({ ...line, persona: f.persona })));
    if (words.length) {
      lines.push("");
      lines.push("What they wrote while the screen stood still:");
      lines.push("");
      for (const w of words) lines.push(`- ${w.persona} (${w.kind})${w.where ? ` on ${w.where}` : ""}: "${w.said}"`);
    }
  }
}

/** One finding a repro or a triage ruled on, as a report line. */
function reproLine(e) {
  const where = e.page ? whereShortly(e.page) : null;
  // A typed problem (lib/repro.mjs findingFacts) is named by its rubric and title before her words.
  const typed = e.problem?.title ? ` [${e.problem.severity} ${e.problem.defect}] ${e.problem.title}` : "";
  return `- ${e.finding}${typed}${where ? ` on ${where}` : ""}${e.said ? `: "${e.said}"` : ""}`;
}

/**
 * The repro sections, first after the tool banners, or nothing on a run with no repro.json: what a failing repro
 * confirmed, then what was rejected, by bucket and by repro outcome. A finding is a claim until a repro asserting
 * the correct behaviour fails on that assertion (tester-army/e2e's bug-bash reference, Apache-2.0; lib/repro.mjs).
 */
function renderRepro(repro, lines) {
  if (!repro) return;
  lines.push("");
  lines.push("## Confirmed by a repro");
  lines.push("");
  if (!repro.confirmed.length)
    lines.push("Nothing in this run is confirmed by a repro yet: every finding not rejected below is still a claim.");
  else {
    lines.push(
      "Each of these failed a repro that asserts the right behaviour, on that assertion. The same repro passes once the bug is fixed: `node sue/repro.mjs check <repro>`.",
    );
    lines.push("");
    for (const e of repro.confirmed) {
      lines.push(reproLine(e));
      lines.push(`  - repro: ${e.repro}`);
      if (e.why) lines.push(`  - ${e.why}`);
    }
  }
  if (!repro.rejected.length) return;
  lines.push("");
  lines.push("## Rejected findings - not bugs in the site");
  for (const g of repro.rejected) {
    lines.push("");
    lines.push(`${g.label}: ${BUCKETS[g.group] ?? REPRO_REJECTS[g.group]}.`);
    lines.push("");
    for (const e of g.entries) {
      lines.push(reproLine(e));
      if (e.why) lines.push(`  - ${e.bucket ? "why" : "the repro"}: ${e.why}`);
      if (e.repro) lines.push(`  - repro: ${e.repro}`);
    }
  }
}

/** What `quoted` (lib/findings.mjs quotesScreen) says about her actual; null or absent says nothing. */
const QUOTED_WORDS = { true: " (quoted from her screen)", false: " (not word for word on her screen)" };

/**
 * The problems they typed, worst first, after the verdict and the room: each one's rubric, where, whose look,
 * who else hit it, the facts as she filed them and her own words. Nothing on a run where nobody typed one.
 */
function renderFiled(filed, sueCount, lines) {
  if (!filed?.problems?.length) return;
  const count = filed.problems.length;
  const filers = new Set(filed.problems.map((p) => p.sueId)).size;
  const untyped = filed.untyped ?? 0;
  lines.push("");
  lines.push("## Problems they filed, worst first");
  lines.push("");
  // The owner, 2026-10-09: what the visitors find is never repaired until the Boardroom rules it real.
  lines.push(
    "These are claims, not a work list: the Boardroom rules each one real, not real or unproven (a Dredd hearing), and only a real one is repaired.",
  );
  lines.push("");
  lines.push(
    `${count} ${count === 1 ? "problem" : "problems"}, typed the moment they were on screen, by ${filers} of ${sueCount} visitors` +
      (untyped ? `; ${untyped} more problem ${untyped === 1 ? "line carries" : "lines carry"} only their words.` : "."),
  );
  lines.push("");
  filed.problems.forEach((p, i) => {
    const where = p.page ? whereShortly(p.page) : null;
    const others = [...new Set((p.seenBy ?? []).map((s) => s.persona))];
    const whose = [p.persona, p.look].filter(Boolean).join(", ") + (others.length ? `; seen by ${namesText(others)} too` : "");
    lines.push(`${i + 1}. [${p.severity} ${p.defect}] ${p.title}${where ? ` - ${where}` : ""} (${whose})`);
    lines.push(`   - expected: ${p.expected}`);
    lines.push(`   - actual: ${p.actual}${QUOTED_WORDS[p.quoted] ?? ""}`);
    if (p.steps?.length) lines.push(`   - steps: ${p.steps.map((step, k) => `${k + 1}. ${step}`).join(" ")}`);
    if (p.said) lines.push(`   - her words: "${p.said}"`);
    if (p.ref) lines.push(`   - finding: ${p.ref}`);
  });
}

/** A list of names as a person says it: "A", "A and B", "A, B and C", or "nobody". */
function namesText(names) {
  if (!names?.length) return "nobody";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** What the moderator found out about the last focus group's problem (`conclude`'s lastProblemStillThere). */
const STILL_THERE_WORDS = {
  yes: "This room still felt it: it is not fixed yet.",
  no: "This room did not feel it any more: it looks fixed.",
  unclear: "This room could not say whether it is still there.",
};

/**
 * The room's section, right after the verdict: the one problem the room agreed on, how, and who did
 * not agree, or that it never agreed. Nothing on a run that was not a focus group.
 */
function renderRoom(room, lines) {
  if (!room) return;
  const verdict = room.verdict;
  lines.push("");
  lines.push(verdict ? "## The room agreed" : "## The room never agreed");
  lines.push("");
  const table = `${room.size} ${room.size === 1 ? "person" : "people"} sat at the table, ${room.moderator === "none" ? "with no moderator" : "with an AI moderator"}, and ${room.lines} ${room.lines === 1 ? "line was" : "lines were"} said in the room.`;
  if (verdict) {
    lines.push(`The biggest problem, as the room put it: "${verdict.problem}"`);
    lines.push("");
    lines.push(
      verdict.decidedBy === "moderator"
        ? "Decided by the moderator, once the room had backed it."
        : "Decided by the vote: nobody concluded, so the problem with the most backers won.",
    );
    lines.push(table);
    lines.push(
      `Agreed: ${namesText(verdict.agreedBy)}. Did not agree: ${namesText(verdict.against)}. Never voted: ${namesText(verdict.didNotVote)}.`,
    );
    if (verdict.summary) {
      lines.push("");
      lines.push(`The moderator's summary: ${verdict.summary}`);
    }
    if (verdict.quotes?.length) {
      lines.push("");
      lines.push("In their own words:");
      lines.push("");
      for (const q of verdict.quotes) lines.push(`- ${q.name}: "${q.text}"`);
    }
  } else {
    lines.push(
      room.phase === "visiting"
        ? "They were still on the website when this report was written, so nobody had come to the table yet."
        : "They came to the table, but nobody concluded and the vote never closed the room, so there is no one agreed problem.",
    );
    lines.push(table);
  }
  const others = (room.table ?? []).filter((p) => !verdict || p.n !== verdict.proposal);
  if (others.length) {
    lines.push("");
    lines.push(verdict ? "The other problems on the table:" : "The problems on the table:");
    lines.push("");
    for (const p of others)
      lines.push(
        `- ${p.n}. "${p.text}", put there by ${p.by}; ${p.backers.length ? `backed by ${namesText(p.backers)}` : "nobody backed it"}.`,
      );
  } else if (!verdict) {
    lines.push("");
    lines.push("Nobody put a problem on the table.");
  }
  if (room.suggestions?.length) {
    lines.push("");
    lines.push(
      room.moderator === "none"
        ? "What the builders guessed (the room had no moderator, so nobody put these to it):"
        : "What the builders guessed, for the moderator to put to the room once it had spoken:",
    );
    lines.push("");
    for (const s of room.suggestions) lines.push(`- "${s}"`);
  }
  if (room.previous?.problem) {
    lines.push("");
    const when = room.previous.at ? `, on ${String(room.previous.at).slice(0, 10)},` : "";
    lines.push(`The last focus group on this page${when} agreed the biggest problem was: "${room.previous.problem}"`);
    if (verdict) lines.push(STILL_THERE_WORDS[verdict.lastProblemStillThere] ?? "Nobody asked this room whether it was still there.");
  }
  if (room.onTheirOwn?.length) {
    lines.push("");
    lines.push("What each one said on their own, in the exit interview:");
    lines.push("");
    for (const row of room.onTheirOwn) lines.push(`- ${row.name}: "${answerText(row.said)}"`);
  }
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push(`# SUE report - ${report.runId}`);
  lines.push("");
  lines.push(
    `Target: ${report.target || "unknown"}. Scenario: ${report.scenario || "unknown"}. ${report.sueCount} Sues ran. Generated ${report.generatedAt}.`,
  );
  if (report.toolFailure) {
    lines.push("");
    lines.push("## ⛔ THE TOOL BROKE DURING THIS RUN - do not read what follows as a verdict on the product");
    lines.push("");
    lines.push(report.toolFailure);
    lines.push("");
    lines.push(
      "Every Sue who ran after that point was reporting on SUE, not on the website. Fix the tool, start a new run, and judge the product from that one.",
    );
  }
  const broken = report.broken || { count: 0, ofTotal: report.sueCount, reasons: [] };
  if (broken.count > 0) {
    lines.push("");
    lines.push(`## BROKEN RUN - ${broken.count} of ${broken.ofTotal} Sues never saw the page`);
    lines.push("");
    lines.push(
      "Their brains failed before they looked at anything, so they are NOT counted anywhere below. Nothing here is a statement about the website until this is fixed.",
    );
    lines.push("");
    for (const r of broken.reasons) lines.push(`- ${r.count} x ${r.reason}`);
    if (report.sueCount === 0) {
      lines.push("");
      lines.push("NO USABLE DATA in this run: every Sue died before she saw the page.");
      return lines.join("\n") + "\n";
    }
  }
  renderRepro(report.repro, lines);
  renderSueSide(report.sueSide, lines);
  renderAdViewers(report.adViewers, lines);
  renderApe(report.ape, lines);
  renderArt(report.art, lines);
  lines.push("");
  lines.push("## The verdict");
  lines.push("");
  const verdict = report.verdict || {};
  if (verdict.averageStars === null || verdict.averageStars === undefined) {
    lines.push("Nobody left a star rating in this run.");
  } else {
    lines.push(`Average rating: ${verdict.averageStars} stars out of 5, from ${verdict.starsAnswered} Sues.`);
    lines.push(
      `Stars: ${[5, 4, 3, 2, 1].map((n) => `${n}* ${verdict.starHistogram?.[n] ?? 0}`).join(", ")}.${verdict.oneStarCount ? ` ${verdict.oneStarCount} of them one star.` : ""}`,
    );
    const refused = verdict.refusedAtOurDoor ?? 0;
    const lost = verdict.browserLost ?? 0;
    if (refused || lost) {
      const why = [
        refused ? `${refused} from ${refused === 1 ? "a Sue" : "Sues"} our own sign-up door refused` : null,
        lost ? `${lost} from ${lost === 1 ? "a Sue" : "Sues"} whose browser SUE lost mid-visit` : null,
      ].filter(Boolean);
      lines.push(
        `${why.join(" and ").replace(/^(\d+) from/, "$1 of these ratings came from")} (see SUE-side suspects).` +
          (verdict.averageStarsWithoutSueSide !== null && verdict.averageStarsWithoutSueSide !== undefined
            ? ` Without them: ${verdict.averageStarsWithoutSueSide} stars from ${sueCountText(verdict.starsAnswered - refused - lost)}.`
            : ""),
      );
    }
  }
  if (verdict.screens?.length) {
    lines.push("");
    lines.push(
      `How the screens looked to them${verdict.averageUiStars ? ` (screens rated ${verdict.averageUiStars} of 5)` : ""}${judgesScreens(report.target, report.scenario) ? ", next to the games they already have" : ""}:`,
    );
    lines.push("");
    for (const row of verdict.screens) {
      const said = Object.keys(JUDGING_KEYS).filter((key) => key !== "uiStars" && row[key] != null && row[key] !== "");
      const tags = [row.stars ? `${row.stars}*` : null, row.uiStars ? `screens ${row.uiStars}*` : null].filter(Boolean);
      lines.push(
        `- ${row.persona}${tags.length ? ` (${tags.join(", ")})` : ""}: ${said.map((key) => `${key}: ${answerText(row[key])}`).join("; ")}`,
      );
    }
    lines.push("");
  }
  if (verdict.neverComingBackShare !== null && verdict.neverComingBackShare !== undefined) {
    lines.push(
      `Never coming back: ${verdict.neverComingBackCount} of ${verdict.neverComingBackAnswered} (${Math.round(verdict.neverComingBackShare * 100)}%) said they are done with the website for good.`,
    );
  }
  if (verdict.neverComingBackWhys?.length) {
    lines.push("");
    lines.push("Why they are done with us:");
    lines.push("");
    for (const row of verdict.neverComingBackWhys) {
      const tags = [row.stars ? `${row.stars}*` : null, sueSideTag(row)].filter(Boolean);
      lines.push(`- ${row.persona}${tags.length ? ` (${tags.join(", ")})` : ""}: "${row.why ?? "no reason given"}"`);
    }
  }
  renderRoom(report.room, lines);
  renderFiled(report.filed, report.sueCount, lines);

  if (report.scenarioAnswers?.length) {
    lines.push("");
    lines.push("## What this scenario asked them");
    for (const q of report.scenarioAnswers) {
      lines.push("");
      lines.push(`### ${q.key}: ${q.question}`);
      lines.push("");
      if (!q.answers.length) lines.push("Nobody answered this.");
      for (const row of q.answers) {
        if (row.said && typeof row.said === "object" && Object.keys(row.said).length) {
          lines.push(`- ${row.persona} (${row.sueId}):`);
          lines.push(...answerLines(row.said));
        } else lines.push(`- ${row.persona} (${row.sueId}): ${answerText(row.said)}`);
      }
    }
  }

  const attention = report.attention;
  if (attention?.perSue?.length) {
    lines.push("");
    lines.push("## Where attention broke, moment by moment");
    lines.push("");
    lines.push(
      `${attention.drops} drop${attention.drops === 1 ? "" : "s"} (a visitor would look away or leave) and ${attention.hooks} hook${attention.hooks === 1 ? "" : "s"} (something held them), in the order each Sue hit them. The time is seconds into her visit on her own clock. Severity: 1 attention dips, 2 some leave, 3 most leave.`,
    );
    if (attention.worst.length) {
      lines.push("");
      lines.push("Where most visitors leave (severity 3), fix these first:");
      lines.push("");
      for (const line of attention.worst) lines.push(`- ${line.persona}: ${attentionLine(line)}`);
    }
    if (attention.byPage.length > 1) {
      lines.push("");
      lines.push("Pages by attention lost (drops weighted by severity):");
      lines.push("");
      for (const page of attention.byPage)
        lines.push(`- ${page.where}: ${page.drops} drop${page.drops === 1 ? "" : "s"}, ${page.hooks} hook${page.hooks === 1 ? "" : "s"}`);
    }
    for (const row of attention.perSue) {
      lines.push("");
      lines.push(`### ${row.persona} (${row.sueId})`);
      lines.push("");
      for (const line of row.lines) lines.push(`- ${attentionLine(line)}`);
    }
  }

  const confusion = report.confusion || { diary: [], mostConfusing: [] };
  lines.push("");
  lines.push("## What confused them, in their own words");
  lines.push("");
  const elsewhere = Object.entries(confusion.writtenElsewhere ?? {}).map(([kind, n]) => `${n} ${kind}${n === 1 ? "" : "s"}`);
  if (!confusion.diary.length && elsewhere.length) {
    const listed = elsewhere.length > 1 ? `${elsewhere.slice(0, -1).join(", ")} and ${elsewhere.at(-1)}` : elsewhere[0];
    lines.push(
      `No diary lines (confusion, annoyance, broken, question or thought). They wrote ${listed}, listed elsewhere in this report.`,
    );
  } else if (!confusion.diary.length) {
    lines.push("Nobody wrote anything down. That is a SUE defect, not a clean run - check the diary nudge in body.mjs.");
  } else {
    lines.push(`${confusion.diary.length} diary lines from ${confusion.sueCountWithDiary} Sues, verbatim and in full:`);
    lines.push("");
    for (const row of confusion.diary) {
      lines.push(`- ${row.persona} (${row.kind})${row.where ? ` on ${row.where}` : ""}: "${row.said}"`);
    }
  }
  if (confusion.mostConfusing?.length) {
    lines.push("");
    lines.push("The single most confusing thing, one per Sue:");
    lines.push("");
    for (const row of confusion.mostConfusing) {
      lines.push(`- ${row.persona}${sueSideTag(row) ? ` (${sueSideTag(row)})` : ""}: "${row.said}"`);
    }
  }

  lines.push("");
  lines.push("## Comprehension");
  lines.push("");
  const sentences = report.comprehension.sentenceKeywords || [];
  if (sentences.length) {
    lines.push(
      `Check the ground truth before trusting these numbers: ${sentences.length} of its keywords are sentences (such as "${sentences[0]}"). Each is looked for word for word in what a Sue said, so it almost never matches and she reads as no-idea; use short words (\`groundTruth\` in the target file).`,
    );
    lines.push("");
  }
  const firstLook = report.firstLook || { perSue: [], answered: 0, gotIt: 0, gotItShare: null };
  if (report.comprehension.bucketCounts.ungraded) {
    lines.push(
      "Not graded: this page's target has no ground truth (`groundTruth` in its target file is empty), so what they understood is only in their own words below.",
    );
    lines.push("");
    for (const row of firstLook.perSue.filter((r) => r.said)) lines.push(`- ${row.persona} (first look): "${row.said}"`);
    lines.push("");
  } else if (firstLook.answered) {
    const byEnd = report.comprehension.bucketCounts["got-it"] ?? 0;
    lines.push(
      `Understood what we sell at first look: ${firstLook.gotIt} of ${firstLook.answered}; by the end: ${byEnd} of ${report.sueCount}.`,
    );
    lines.push("");
    for (const row of firstLook.perSue.filter((r) => r.said)) lines.push(`- ${row.persona} (${row.bucket}): "${row.said}"`);
    lines.push("");
  }
  for (const [bucket, count] of Object.entries(report.comprehension.bucketCounts)) {
    lines.push(`- ${bucket}: ${count}`);
  }
  lines.push("");
  lines.push("The worst three, in her own words:");
  lines.push("");
  for (const row of report.comprehension.worstThree) {
    lines.push(
      row.sentence ? `- ${row.persona} (${row.bucket}): "${row.sentence}"` : `- ${row.persona} (${row.bucket}): no words recorded`,
    );
  }
  lines.push("");
  lines.push("## Funnel");
  lines.push("");
  lines.push(
    `Started ${report.funnel.started}. Reached signup ${report.funnel.reachedSignup}. Requested a code ${report.funnel.requestedCode}. ` +
      (report.funnel.refusedAtOurDoor ? `Refused at our own Sue door ${report.funnel.refusedAtOurDoor}. ` : "") +
      (report.funnel.browserLost ? `Lost SUE's browser ${report.funnel.browserLost}. ` : "") +
      `Read the code ${report.funnel.readCode}. Signed in ${report.funnel.signedIn}. Ended where expected ${report.funnel.endedWhereExpected}. ` +
      `Gave up ${report.funnel.gaveUp}.`,
  );
  lines.push("");
  const exitNames = new Map((report.exits || []).map((e) => [e.id, e.name]));
  const reached = Object.entries(report.funnel.exits || {});
  if (reached.length || exitNames.size) {
    lines.push(
      reached.length
        ? `Handed off to the next site: ${reached.map(([id, n]) => `${n} reached ${exitNames.get(id) || id}`).join("; ")}.`
        : `Handed off to the next site: nobody reached ${[...exitNames.values()].join(" or ")}.`,
    );
    lines.push("");
  }
  // A row per Sue is readable for a handful and useless for a hundred: the 100-Sue run of
  // 2026-09-21 printed 100 consecutive "before-signup" lines and buried everything after them.
  // Past a dozen Sues the interesting fact is WHICH STAGE loses people, and which personas lose
  // there - so the same data is rolled up by stage, worst stage first, with its personas named.
  const PER_SUE_LIMIT = 12;
  if (report.funnel.perSue.length <= PER_SUE_LIMIT) {
    lines.push("Where each Sue died:");
    lines.push("");
    for (const row of report.funnel.perSue) {
      lines.push(`- ${row.persona}: ${row.diedAt}`);
    }
  } else {
    const byStage = new Map();
    for (const row of report.funnel.perSue) {
      if (!byStage.has(row.diedAt)) byStage.set(row.diedAt, []);
      byStage.get(row.diedAt).push(row.persona);
    }
    lines.push(`Where they died (${report.funnel.perSue.length} Sues, by stage):`);
    lines.push("");
    for (const [stage, personas] of [...byStage].sort((a, b) => b[1].length - a[1].length)) {
      const tally = new Map();
      for (const p of personas) tally.set(p, (tally.get(p) ?? 0) + 1);
      const named = [...tally]
        .sort((a, b) => b[1] - a[1])
        .map(([p, n]) => (n > 1 ? `${p} x${n}` : p))
        .join(", ");
      lines.push(`- ${stage}: ${personas.length} (${named})`);
    }
  }
  lines.push("");
  lines.push("## Support");
  lines.push("");
  const support = report.support || { perSue: [], rules: { encouraged: 0, forbidden: 0, unmentioned: 0 }, contactedCount: 0 };
  lines.push(
    `Her rule: ${support.rules.encouraged} encouraged, ${support.rules.forbidden} forbidden, ${support.rules.unmentioned} unmentioned. ` +
      `${support.contactedCount} of ${support.perSue.length} actually contacted them.`,
  );
  if (support.perSue.length && support.perSue.length <= PER_SUE_LIMIT) {
    lines.push("");
    for (const row of support.perSue) {
      lines.push(`- ${row.persona} (${row.sueId}): ${row.rule}${row.contacted ? ", contacted them" : ""}`);
    }
  }
  lines.push("");
  lines.push("## Email code (OTP)");
  lines.push("");
  if (report.otp.perSue.length === 0) {
    lines.push("Nobody requested a code in this run.");
  } else {
    lines.push(
      `Latency: p50 ${msToSeconds(report.otp.p50Ms)}s, p95 ${msToSeconds(report.otp.p95Ms)}s, max ${msToSeconds(report.otp.maxMs)}s.`,
    );
    lines.push(
      `${report.otp.checkedBeforeArrivalCount} Sues checked her inbox before the mail arrived. ${report.otp.neverFoundCount} never found it.` +
        (report.otp.refusedAtOurDoorCount
          ? ` ${report.otp.refusedAtOurDoorCount} more never got one because our own Sue door refused them, not the site's email.`
          : ""),
    );
  }
  lines.push("");
  if (report.arrival) {
    lines.push("## The message that sent her");
    lines.push("");
    lines.push(`${report.arrival.clickedThrough} of ${report.arrival.sent} clicked through from the message to the site.`);
    for (const s of report.arrival.perSue) {
      const said = s.whatIThought ? `"${s.whatIThought}"` : "said nothing about it";
      lines.push(`- ${s.persona}: ${s.clickedThrough ? "clicked through" : "never left the message"}; ${said}`);
    }
    lines.push("");
  }
  lines.push("## Clock");
  lines.push("");
  lines.push(
    `Median seconds to her first click: ${report.clock.medianSecondsToFirstClick ?? "n/a"}. Bored events: ${report.clock.boredEvents}. ` +
      `Patience exhausted: ${report.clock.patienceExhaustions} times.`,
  );
  lines.push("");
  lines.push("## Findings by kind");
  lines.push("");
  for (const k of report.findings.kinds) {
    lines.push(`- ${k.kind}: ${k.count}`);
  }
  lines.push("");
  if (report.findings.isThisTrashYesRate !== null) {
    lines.push(`Is this trash: ${Math.round(report.findings.isThisTrashYesRate * 100)}% said yes.`);
    for (const row of report.findings.isThisTrashWhys) {
      lines.push(`- ${row.persona}${sueSideTag(row) ? ` (${sueSideTag(row)})` : ""}: ${row.why}`);
    }
    lines.push("");
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// aggregate across every run
// ---------------------------------------------------------------------------------------------

export function buildAggregate(perRunReports) {
  // A run where SUE's own apparatus broke judges the tool, not the product - the same reason
  // report.md refuses to call it a verdict. It never feeds a trend; it is listed on its own below.
  const toolFailed = perRunReports.filter((r) => r.toolFailure);
  const scored = perRunReports.filter((r) => !r.toolFailure);
  const bucketCounts = {};
  for (const r of scored) {
    for (const [bucket, count] of Object.entries(r.comprehension.bucketCounts)) {
      bucketCounts[bucket] = (bucketCounts[bucket] || 0) + count;
    }
  }
  const funnelKeys = ["started", "reachedSignup", "requestedCode", "readCode", "signedIn", "endedWhereExpected", "gaveUp"];
  const funnelTotals = {};
  for (const key of funnelKeys) funnelTotals[key] = scored.reduce((sum, r) => sum + r.funnel[key], 0);
  const allLatencies = scored.flatMap((r) => r.otp.perSue.map((o) => o.latencyMs)).filter((v) => typeof v === "number");
  // Stars weighted by how many Sues actually answered, so a 2-Sue run cannot outvote a 40-Sue one.
  const starWeight = scored.reduce((sum, r) => sum + (r.verdict?.starsAnswered ?? 0), 0);
  const starTotal = scored.reduce((sum, r) => sum + (r.verdict?.averageStars ?? 0) * (r.verdict?.starsAnswered ?? 0), 0);
  const backAsked = scored.reduce((sum, r) => sum + (r.verdict?.neverComingBackAnswered ?? 0), 0);
  const backGone = scored.reduce((sum, r) => sum + (r.verdict?.neverComingBackCount ?? 0), 0);
  return {
    generatedAt: new Date().toISOString(),
    runCount: scored.length,
    toolFailedRuns: toolFailed.map((r) => ({ runId: r.runId, toolFailure: r.toolFailure })),
    totalSues: scored.reduce((sum, r) => sum + r.sueCount, 0),
    verdict: {
      averageStars: starWeight ? Math.round((starTotal / starWeight) * 10) / 10 : null,
      starsAnswered: starWeight,
      neverComingBackCount: backGone,
      neverComingBackAnswered: backAsked,
      neverComingBackShare: backAsked ? backGone / backAsked : null,
    },
    bucketCounts,
    funnelTotals,
    otp: {
      p50Ms: median(allLatencies),
      p95Ms: percentile(allLatencies, 95),
      maxMs: allLatencies.length ? Math.max(...allLatencies) : null,
    },
    runs: scored.map((r) => ({ runId: r.runId, sueCount: r.sueCount, bucketCounts: r.comprehension.bucketCounts })),
  };
}

export function renderAggregateMarkdown(agg) {
  const lines = [];
  lines.push("# SUE aggregate report");
  lines.push("");
  lines.push(`${agg.runCount} runs, ${agg.totalSues} Sues total. Generated ${agg.generatedAt}.`);
  if (agg.toolFailedRuns?.length) {
    lines.push("");
    lines.push(
      `${agg.toolFailedRuns.length} run${agg.toolFailedRuns.length === 1 ? "" : "s"} left out of these numbers: SUE's own tool broke during them, so they judge the tool, not the site.`,
    );
    for (const r of agg.toolFailedRuns) lines.push(`- ${r.runId}: ${r.toolFailure}`);
  }
  if (agg.verdict?.averageStars !== null && agg.verdict?.averageStars !== undefined) {
    lines.push("");
    const backClause =
      agg.verdict.neverComingBackAnswered > 0
        ? `${Math.round(agg.verdict.neverComingBackShare * 100)}% are never coming back.`
        : "nobody answered whether they are coming back.";
    lines.push(`Across every run: ${agg.verdict.averageStars} stars out of 5 (${agg.verdict.starsAnswered} ratings), and ${backClause}`);
  }
  lines.push("");
  lines.push("## Comprehension across every run");
  lines.push("");
  for (const [bucket, count] of Object.entries(agg.bucketCounts)) lines.push(`- ${bucket}: ${count}`);
  lines.push("");
  lines.push("## Funnel across every run");
  lines.push("");
  for (const [key, value] of Object.entries(agg.funnelTotals)) lines.push(`- ${key}: ${value}`);
  lines.push("");
  lines.push("## Runs");
  lines.push("");
  for (const r of agg.runs) lines.push(`- ${r.runId}: ${r.sueCount} Sues`);
  lines.push("");
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------------------------
// ledger
// ---------------------------------------------------------------------------------------------

function upsertLedgerLine(ledgerFile, report) {
  mkdirSync(path.dirname(ledgerFile), { recursive: true });
  const row = {
    runId: report.runId,
    generatedAt: report.generatedAt,
    target: report.target,
    scenario: report.scenario,
    sueCount: report.sueCount,
    averageStars: report.verdict?.averageStars ?? null,
    neverComingBackShare: report.verdict?.neverComingBackShare ?? null,
    bucketCounts: report.comprehension.bucketCounts,
    gaveUp: report.funnel.gaveUp,
    signedIn: report.funnel.signedIn,
    endedWhereExpected: report.funnel.endedWhereExpected,
    otpP50Ms: report.otp.p50Ms,
    sueDoorRefused: report.sueSide?.doorRefused?.length ?? 0,
    frozenSues: report.sueSide?.frozen?.length ?? 0,
    browserLostSues: report.sueSide?.browserLost?.length ?? 0,
    toolFailure: report.toolFailure ?? null,
    brokenSues: report.broken?.count ?? 0,
  };
  // UPSERT BY RUNID, NOT APPEND. `--forever` re-runs this report every reportEveryMs and `--all`
  // re-reports every old run, so a blind append left the same runId in the file over and over (11
  // rows for 10 runs, one runId twice, on 2026-09-21) while the README promises one line per run
  // for trending. A run already present is replaced in place, keeping one line per run.
  const kept = [];
  if (existsSync(ledgerFile)) {
    for (const line of readFileSync(ledgerFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let existing;
      try {
        existing = JSON.parse(line);
      } catch {
        kept.push(line); // an unparseable line is kept verbatim rather than silently dropped
        continue;
      }
      if (existing.runId !== report.runId) kept.push(line);
    }
  }
  kept.push(JSON.stringify(row));
  writeFileSync(ledgerFile, kept.join("\n") + "\n", "utf8");
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { all: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--all") args.all = true;
    else if (arg === "--run") args.run = argv[(i += 1)];
    else if (arg === "--runs-dir") args.runsDir = argv[(i += 1)];
    else if (arg === "--out-dir") args.outDir = argv[(i += 1)];
    else if (arg === "--ledger-file") args.ledgerFile = argv[(i += 1)];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.error("usage: node report.mjs --run <runId> | --all  [--runs-dir <dir>] [--out-dir <dir>] [--ledger-file <file>]");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.run && !args.all)) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const runsDir = args.runsDir || runsRoot();
  const ledgerFile = args.ledgerFile || path.join(runsDir, "ledger.jsonl");
  const runIds = args.all ? listRunIds(runsDir) : [args.run];

  const perRun = [];
  for (const runId of runIds) {
    const bundle = loadRun(runsDir, runId);
    const report = buildReport(bundle);
    const outDir = args.outDir || bundle.runDir;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2) + "\n", "utf8");
    writeFileSync(path.join(outDir, "report.md"), renderMarkdown(report), "utf8");
    upsertLedgerLine(ledgerFile, report);
    perRun.push(report);
    console.error(`[sue-report] ${runId}: wrote ${path.join(outDir, "report.md")}`);
  }

  if (args.all) {
    const aggregate = buildAggregate(perRun);
    const outDir = args.outDir || runsDir;
    mkdirSync(outDir, { recursive: true });
    writeFileSync(path.join(outDir, "aggregate-report.json"), JSON.stringify(aggregate, null, 2) + "\n", "utf8");
    writeFileSync(path.join(outDir, "aggregate-report.md"), renderAggregateMarkdown(aggregate), "utf8");
    console.error(`[sue-report] aggregate: wrote ${path.join(outDir, "aggregate-report.md")}`);
  }
}

const isMain = isMainModule(import.meta.main, import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}

export { loadRun, median, percentile, classifyFunnel, personaOf, buildComprehension, buildFirstLook };
