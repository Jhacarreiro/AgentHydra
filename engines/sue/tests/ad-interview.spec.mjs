/**
 * sue-ad-viewer-interview - `focus_group` with `watches: "ad"` asks an ad viewer the ad questions,
 * never the website's, and the report reads her answers as an ad run.
 * ==========================================================================================
 *
 * WHAT: `node --test sue/tests/ad-interview.spec.mjs`.
 *
 * WHY IT EXISTS: every exit interview was built from the website keys (or the game keys when judged),
 * so an ad viewer was asked whether she made an account and what the site sells. These tests pin the
 * ad mode at each seam: the key list, the shaping, the scenario a run writes, the report aggregate, and
 * the refusal of any other `watches` value. The website and game key lists are checked unchanged.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import {
  AD_INTERVIEW_KEYS,
  INTERVIEW_KEYS,
  interviewExtras,
  interviewKeys,
  isAdScenario,
  missingInterviewKeys,
  shapeAdInterview,
  shapeInterview,
} from "../lib/findings.mjs";
import { intentScenario, storeDir } from "../lib/workspace.mjs";
import { buildAdViewers, buildReport, renderMarkdown } from "../report.mjs";
import { planRun } from "../sue.mjs";
import { installTestPeople } from "./fixtures/people.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const tempWs = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "sue-ad-"));
  roots.push(root);
  return root;
};

const INTENT = "a friend shared this ad in the feed and you wanted to see what it was selling";

test("an ad viewer is asked the nine ad keys and none of the website's", () => {
  assert.deepEqual(interviewKeys(false, true), AD_INTERVIEW_KEYS);
  assert.equal(AD_INTERVIEW_KEYS.length, 9);
  for (const key of ["madeAccount", "emailCodeExperience", "whatDoTheySell", "trust", "everComingBack", "isThisTrash"]) {
    assert.ok(!AD_INTERVIEW_KEYS.includes(key), `${key} is not asked of an ad viewer`);
  }
  assert.deepEqual(missingInterviewKeys({}, false, true), AD_INTERVIEW_KEYS);
});

test("website and game key lists are unchanged by the ad mode", () => {
  assert.equal(INTERVIEW_KEYS.length, 16);
  assert.deepEqual(interviewKeys(false, false), INTERVIEW_KEYS);
  assert.equal(interviewKeys(false).length, 16);
  assert.equal(interviewExtras({ interview: { lookedAt: "what did you look at?" } }, false, false).length, 1);
});

test("an ad answer is shaped to its nested yes/kind/move fields, and a stringified one is parsed", () => {
  const shaped = shapeAdInterview({
    stopScrolling: { yes: "yes", why: "a dog" },
    feltLike: '{"kind": "an ad", "why": "it had a price"}',
    believeIt: "false",
    nextMove: { move: "scroll past", why: "not for me" },
    starsOutOfFive: "2",
    whoIsItFor: "parents",
  });
  assert.deepEqual(shaped.stopScrolling, { yes: true, why: "a dog" });
  assert.deepEqual(shaped.feltLike, { kind: "an ad", why: "it had a price" });
  assert.deepEqual(shaped.believeIt, { yes: false });
  assert.deepEqual(shaped.nextMove, { move: "scroll past", why: "not for me" });
  assert.equal(shaped.starsOutOfFive, 2);
  assert.equal(shaped.whoIsItFor, "parents");
  assert.equal(shaped.oneChange, null, "a skipped ad question stays null");
  assert.ok(!("madeAccount" in shaped));
  assert.equal(shapeInterview({ madeAccount: "true" }).madeAccount, true, "website shaping is untouched");
});

test('intentScenario writes watches:"ad" under its own id; the same intent without it keeps its old id', () => {
  const ws = tempWs();
  const plain = intentScenario({ ws, intent: INTENT });
  const ad = intentScenario({ ws, intent: INTENT, watches: "ad" });
  assert.notEqual(plain.id, ad.id);
  assert.ok(ad.id.endsWith("|ad") === false && ad.id.startsWith("intent-"), "the id is a hash, the suffix is hashed in");
  assert.equal(ad.scenario.watches, "ad");
  assert.equal(plain.scenario.watches, undefined);
  assert.equal(isAdScenario(ad.scenario), true);
  assert.equal(isAdScenario(plain.scenario), false);
  const written = JSON.parse(fs.readFileSync(path.join(storeDir(ws), "scenarios", `${ad.id}.json`), "utf8"));
  assert.equal(written.watches, "ad");
  assert.match(written.prompt, /this ad is what you saw/);
});

test('focus_group carries watches:"ad" into the scenario it writes; a plan without it writes a website scenario', () => {
  const ws = tempWs();
  const sueHome = tempWs();
  process.env.SUE_HOME = sueHome;
  installTestPeople();
  try {
    const args = { workspace: ws, url: "https://example.com/pricing", intent: INTENT, personas: ["bob"], runId: "20261008-000000-abcd" };
    const ad = planRun({ ...args, watches: "ad" });
    const adScenario = JSON.parse(fs.readFileSync(path.join(storeDir(ws), "scenarios", `${ad.scenarioId}.json`), "utf8"));
    assert.equal(adScenario.watches, "ad");
    const web = planRun({ ...args, runId: "20261008-000001-abcd" });
    const webScenario = JSON.parse(fs.readFileSync(path.join(storeDir(ws), "scenarios", `${web.scenarioId}.json`), "utf8"));
    assert.equal(webScenario.watches, undefined);
    assert.notEqual(ad.scenarioId, web.scenarioId);
  } finally {
    delete process.env.SUE_HOME;
  }
});

test("any other watches value is refused before a scenario is written", () => {
  assert.throws(() => intentScenario({ ws: tempWs(), intent: INTENT, watches: "site" }), /watches is "ad" or not set/);
});

test("the report reads the ad viewers' answers: stop share, what it felt like, and each answer as written", () => {
  const ad = (persona, interview) => ({ sueId: persona, sue: { persona: { id: persona }, scenario: { watches: "ad" } }, interview });
  const sues = [
    ad(
      "a",
      shapeAdInterview({
        stopScrolling: { yes: true, why: "a dog" },
        feltLike: { kind: "An ad" },
        nextMove: { move: "tap it" },
        starsOutOfFive: 4,
      }),
    ),
    ad(
      "b",
      shapeAdInterview({
        stopScrolling: { yes: false },
        feltLike: { kind: "an ad" },
        nextMove: { move: "scroll past" },
        starsOutOfFive: 3,
      }),
    ),
    { sueId: "web", sue: { persona: { id: "web" }, scenario: {} }, interview: shapeInterview({ madeAccount: true }) },
  ];
  const view = buildAdViewers(sues);
  assert.equal(view.sues, 2);
  assert.equal(view.stoppedScrolling, 1);
  assert.deepEqual(view.feltLike, { "an ad": 2 });
  assert.deepEqual(view.nextMove, { "scroll past": 1, "tap it": 1 });
  assert.equal(view.starsOutOfFive, 3.5);
  assert.equal(view.verbatim.length, 2);
  assert.equal(view.verbatim[0].answers.stopScrolling.why, "a dog");
  assert.equal(buildAdViewers([sues[2]]), null, "a run with no ad viewer has no ad section");
});

const REAL_AD_RUN = [
  {
    stopScrolling: "yes, the ad made me stop scrolling because it was confusing and seemed like a scam.",
    feltLike: "an ad, because it looked like a video ad with a person speaking and text overlays.",
    whoIsItFor: "people who use AI tools or are concerned about their billing for AI services.",
    whatTheyOffer: "a service related to Claude Code that charges $60 for tokens, but the details are unclear.",
    believeIt: "no, because the language is broken and the numbers don't add up, making it feel like a scam.",
    nextMove: "ignore it, because I don't want to engage with something that seems suspicious or poorly made.",
    squintAt: "On Table you pay $60 Sure it's made for, the hardest work On Sonnet",
    oneChange: "make the language clear and grammatically correct, so people can understand what is being offered.",
    starsOutOfFive: 1,
    biggestProblem:
      "The ad uses broken, grammatically incorrect sentences like 'On Table you pay $60 Sure it's made for' and 'the hardest work On Sonnet', making the message unclear and untrustworthy.",
  },
  {
    stopScrolling: "yes, because the ad was confusing and felt like a scam.",
    feltLike: "an ad, because it looked like a video ad with a person talking about billing issues.",
    whoIsItFor: "people who use AI tools and are worried about their bills.",
    whatTheyOffer: "a service that charges $60 for tokens on Claude Code.",
    believeIt: "no, because the numbers don't add up and the language is broken.",
    nextMove: "ignore it, because it feels like a scam or poorly made ad.",
    squintAt:
      "Your Claude Code bill keeps climbing, okay? quick math a million tokens in and out, On Table you pay $60 Sure it's made for, the hardest work On Sonnet, 12 Instead of 60 the model picker, is in the dropdown Maybe try it on your next small task",
    oneChange: "make the ad clearer and more coherent, with proper grammar and a logical flow.",
    starsOutOfFive: 1,
    biggestProblem:
      "The ad is confusing and poorly written. The sentences are broken and don't make sense, like 'On Table you pay $60 Sure it's made for' or 'the hardest work On Sonnet'. It feels like a scam because the numbers don't add up and the message is unclear.",
  },
  {
    stopScrolling: "yes, because the ad was confusing and felt like a scam.",
    feltLike: "an ad, because it looked like a video ad with a person talking about billing issues.",
    whoIsItFor: "people who use AI tools and are worried about their bills, but it’s unclear if that’s even real or just a scare tactic.",
    whatTheyOffer: "a service called Claude Code that supposedly charges $60 for tokens, but the details are vague and confusing.",
    believeIt: "no, because the ad is poorly written and doesn’t make sense. The numbers don't add up, and it feels like a scam.",
    nextMove: "ignore it, because I wouldn’t want to click on something that seems suspicious or poorly made.",
    squintAt:
      "'On Table you pay $60 Sure it's made for', 'the hardest work On Sonnet', 'Your Claude Code bill keeps climbing' — these phrases are broken and hard to read. I had to squint at them because they don’t form complete sentences.",
    oneChange: "make the ad clearer and more professional, with proper grammar and a clear explanation of what they’re selling.",
    starsOutOfFive: 1,
    biggestProblem:
      "The ad is confusing and poorly written, making it feel like a scam. The broken sentences and unclear messaging make it hard to trust or understand what’s being offered.",
  },
  {
    stopScrolling: { yes: true },
    feltLike: "an ad",
    whoIsItFor: "people who use AI tools, especially those with billing concerns",
    whatTheyOffer: "a service that charges $60 for tokens on a platform called Claude Code",
    believeIt: { yes: false },
    nextMove: "ignore it",
    squintAt: "On Table you pay $60 Sure it's made for, the hardest work On Sonnet",
    oneChange: "Fix the grammar and make the message clear.",
    starsOutOfFive: 1,
    biggestProblem:
      "The ad uses broken, grammatically incorrect sentences like 'On Table you pay $60 Sure it's made for' and 'the hardest work On Sonnet', making the message unclear and untrustworthy.",
  },
];

test("the report reads a real ad run's plain-sentence answers: all four stopped scrolling, believed nothing, an ad, ignore it", () => {
  const sues = REAL_AD_RUN.map((interview, i) => ({
    sueId: `sue-746${6 + i}`,
    sue: { persona: { id: `viewer-${i + 1}` }, scenario: { watches: "ad" } },
    interview,
  }));
  const view = buildAdViewers(sues);
  assert.equal(view.sues, 4);
  assert.equal(view.stoppedScrolling, 4);
  assert.deepEqual(view.believeIt, { yes: 0, no: 4 });
  assert.deepEqual(view.feltLike, { "an ad": 4 });
  assert.deepEqual(view.nextMove, { "ignore it": 4 });
  assert.equal(view.starsOutOfFive, 1);
  assert.equal(view.verbatim[0].answers.feltLike, REAL_AD_RUN[0].feltLike, "the verbatim answer is kept as written");
});

test("the games wording appears only in a game run's report, never a website run's", () => {
  const report = (runId, target, interview) =>
    renderMarkdown(
      buildReport({
        runId,
        manifest: { target, scenario: { id: "s" } },
        sues: [{ sueId: "sue-7001", sue: { persona: { id: "p" }, scenario: { id: "s" } }, interview }],
        groundTruth: {},
      }),
    );
  const website = report("w", { url: "https://example.test" }, { whatIsThisSite: "a shop", squintAt: "the price" });
  assert.match(website, /How the screens looked to them/, "the screens block still prints on a website run");
  assert.doesNotMatch(website, /games they already have/);
  const game = report("g", { url: "https://example.test", canvas: true }, { keepOrDelete: "keep", uiStars: 4 });
  assert.match(game, /games they already have/);
});

test("an unclear stop answer is unanswered, not a no", () => {
  const sue = (interview) => ({ sueId: "x", sue: { persona: { id: "x" }, scenario: { watches: "ad" } }, interview });
  const view = buildAdViewers([
    sue({ stopScrolling: "maybe, hard to say", believeIt: "I'm not sure", feltLike: "a friend's post, because it was personal" }),
  ]);
  assert.equal(view.stoppedScrolling, 0);
  assert.deepEqual(view.believeIt, { yes: 0, no: 0 });
  assert.deepEqual(view.feltLike, { "a friend's post": 1 });
});
