// A page heard again, and a sitting too thin to rule. Both cases are the NGO site's own dockets of 2026-09-24
// (D:/.SystemFiles/Desktop/scratch/NGO-Foundation/website/tmp/dredd): the founders page was told to drop its repeated
// "Ask about a founding seat" lines (20260923-225601-3fad), was changed to three different button labels, and was then
// scored 3/10 on ONE valid ballot by a room that asked for one unified label again (20260923-231649-640f); the home
// page's final sitting (20260923-231651-79a1) was also scored on one ballot after the Copy Editor's was voided.
//
//   node --test dredd/tests/earlier.spec.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BALLOT_SCHEMA,
  ballotInstruction,
  ballotNote,
  ballotSchema,
  earlierReversal,
  MIN_BALLOTS,
  renderTally,
  scoreText,
  tallyBallots,
} from "../lib/ballot.mjs";
import { EARLIER_RULE, earlierFixes, earlierHearings, pageRuling, renderEarlierHearings } from "../lib/earlier.mjs";
import { renderDocketsTable } from "../lib/dockets.mjs";
import { standingOf } from "../lib/hearing.mjs";
import { roomHappy, shouldStop } from "../lib/resolve.mjs";
import { ballotEvidence, groundedWhere, roomMaterial } from "../lib/seats.mjs";
import { reapAfterEach } from "./_scratch.mjs";

const scratchDirs = reapAfterEach([]);

const FOUNDERS = "https://futurethatworks.org/founders";
const HOME = "https://futurethatworks.org/";
// The rulings as the dockets hold them, word for word.
const A_FIX = "Delete all duplicate “Ask about a founding seat” lines and replace them with a single SharedCTA component reference.";
const BETWEEN_FIX = "No single fix achieved majority among grounded ballots.";
const B_FIX = "Replace all three call-to-action button texts with the unified phrase “Tell us you’re interested.”";
const PAGE_WORDS = "Ask about a founding seat\nTell us you're interested\nEmail us\nEvery founding seat helps pay for year one.\n";

/** A tmp/dredd history: each docket is [stamp, docket.json fields, hearing.json or null]. Returns the history dir. */
function history(dockets) {
  const root = mkdtempSync(path.join(tmpdir(), "dredd-earlier-"));
  scratchDirs.push(root);
  const dir = path.join(root, "tmp", "dredd");
  for (const [stamp, docket, hearing, files = {}] of dockets) {
    mkdirSync(path.join(dir, stamp), { recursive: true });
    writeFileSync(path.join(dir, stamp, "docket.json"), JSON.stringify(docket));
    if (hearing) writeFileSync(path.join(dir, stamp, "hearing.json"), JSON.stringify(hearing));
    for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, stamp, name), body);
  }
  return dir;
}

const evidenceSitting = (verdict, fix_first) => ({ sitting: 2, verdict, fix_first, exit: 0, tally: "median of 3 ballot(s)" });

/** The founders page's history up to sitting B, plus a home page hearing and one founders hearing after B. */
function foundersHistory() {
  return history([
    [
      "20260923-222451-2be4",
      { url: FOUNDERS, created: "2026-09-24T03:24:51.000Z" },
      { state: "finished", sittings: [evidenceSitting(5, "An older fix.")] },
    ],
    [
      "20260923-225556-3cb4",
      { url: HOME, created: "2026-09-24T03:55:56.000Z" },
      { state: "finished", sittings: [evidenceSitting(4, "A home page fix.")] },
    ],
    [
      "20260923-225601-3fad",
      { url: FOUNDERS, created: "2026-09-24T03:56:05.871Z" },
      { state: "finished", sittings: [evidenceSitting(4, A_FIX)] },
    ],
    // A hearing that died before its room sat: no ruling, so it is not an earlier hearing.
    ["20260923-230000-dead", { url: FOUNDERS, created: "2026-09-24T04:00:00.000Z" }, { state: "failed", sittings: [] }],
    [
      "20260923-230624-2633",
      { url: FOUNDERS, created: "2026-09-24T04:06:33.418Z" },
      { state: "finished", sittings: [evidenceSitting(4, BETWEEN_FIX)] },
    ],
    [
      "20260923-231649-640f",
      {
        url: FOUNDERS,
        created: "2026-09-24T04:16:58.528Z",
        ask: "Final voice check of the live Founding donors page. Since the last sitting: each call-to-action button now says something different.",
      },
      null,
      { "page-words.log": PAGE_WORDS },
    ],
    [
      "20260924-010000-late",
      { url: FOUNDERS, created: "2026-09-24T06:00:00.000Z" },
      { state: "finished", sittings: [evidenceSitting(9, "A later fix.")] },
    ],
  ]);
}

test("earlier-1: a re-hearing finds the page's own earlier rulings, newest first, and never a later one or another page's", () => {
  const dir = foundersHistory();
  const b = path.join(dir, "20260923-231649-640f");
  const found = earlierHearings(b, { url: FOUNDERS, created: "2026-09-24T04:16:58.528Z" });
  assert.deepEqual(
    found.map((e) => path.basename(e.dir)),
    ["20260923-230624-2633", "20260923-225601-3fad", "20260923-222451-2be4"],
    "the in-between hearing, then sitting A, then the oldest; not the home page, not the dead docket, not the later one",
  );
  assert.equal(found[1].fix_first, A_FIX);
  assert.equal(found[1].verdict, 4);
  assert.equal(found[1].conclusive, true);
  assert.deepEqual(earlierFixes(found), [BETWEEN_FIX, A_FIX, "An older fix."]);
  assert.equal(earlierHearings(b, { url: FOUNDERS, created: "2026-09-24T04:16:58.528Z" }, { limit: 1 }).length, 1);
  // The first hearing of a page has none, and so does a docket with no url (a code hearing).
  assert.deepEqual(earlierHearings(path.join(dir, "20260923-222451-2be4"), { url: FOUNDERS, created: "2026-09-24T03:24:51.000Z" }), []);
  assert.deepEqual(earlierHearings(b, { created: "2026-09-24T04:16:58.528Z" }), []);
});

test("earlier-2: a hearing's ruling on the page is its last sitting over the evidence, with the proposal its room scored", () => {
  // The home page's 20260923-230626-02bb: 3/10 over the evidence, then its proposal 1 scored 9/10 and was applied.
  const proposal = "D:/x/tmp/dredd/20260923-230626-02bb/proposal-1.md";
  const r = pageRuling("02bb", {
    sittings: [
      evidenceSitting(3, "Remove the extra “Lift the Generation” instances, keeping it only in the closing heading."),
      { sitting: 3, verdict: 9, proposal, fix_first: "Add a brief neutral footer tagline." },
    ],
    proposals: [
      {
        round: 1,
        file: proposal,
        headline: null,
        changes: [
          { where: "Hero section, right after the headline", before: "AI is changing how the world earns a living.", after: "" },
          { where: "Footer brand line", before: "Lift the Generation.", after: "" },
        ],
      },
    ],
  });
  assert.equal(r.verdict, 3);
  assert.equal(r.proposal.verdict, 9);
  const text = renderEarlierHearings([{ when: "2026-09-24T04:06:35.275Z", ...r }]);
  assert.match(text, /the page 3\/10, fix first: Remove the extra “Lift the Generation” instances/);
  assert.match(text, /its room then scored proposal 1 9\/10, which changed:/);
  assert.match(text, /- Hero section, right after the headline: cut "AI is changing how the world earns a living\."/);
  assert.ok(text.endsWith(EARLIER_RULE));
  // An earlier sitting that was not conclusive says so, never "-/10"; a hearing that never sat has no ruling.
  assert.match(
    renderEarlierHearings([
      { when: "t", ...pageRuling("x", { sittings: [{ sitting: 2, verdict: null, conclusive: false, fix_first: "f" }] }) },
    ]),
    /the page not conclusive, fix first: f/,
  );
  assert.equal(pageRuling("x", { sittings: [] }), null);
  assert.equal(pageRuling("x", null), null);
  assert.equal(renderEarlierHearings([]), "");
});

test("earlier-3: the room reads the earlier rulings and the rule; a quote from them grounds a ballot as advice, never as evidence", () => {
  const dir = foundersHistory();
  const ctx = roomMaterial(path.join(dir, "20260923-231649-640f"), { sitting: 2 });
  assert.equal(ctx.earlier.length, 3);
  assert.ok(ctx.advisorFindings.includes(A_FIX), "sitting A's fix is in front of the room");
  assert.ok(ctx.advisorFindings.includes(EARLIER_RULE));
  assert.equal(ctx.parts.at(-1).label, "earlier", "labelled last, so a quote the page also carries traces to the page");
  // A line the page carries is evidence even though an earlier fix quotes it too.
  assert.equal(groundedWhere("Ask about a founding seat", ctx.parts), "evidence:page-words");
  assert.equal(groundedWhere("No single fix achieved majority among grounded ballots", ctx.parts), "earlier");
  assert.ok(ballotEvidence({ typedAsk: "", ctx }).includes(A_FIX));
  // A first hearing's material carries no earlier line.
  const first = roomMaterial(path.join(dir, "20260923-222451-2be4"), { sitting: 2 });
  assert.deepEqual(first.earlier, []);
  assert.ok(!first.advisorFindings.includes("This page was heard before"));
});

test("earlier-4: a ballot that reverses an earlier fix counts only when it says why that advice was wrong", () => {
  const earlier = [{ fix_first: BETWEEN_FIX }, { fix_first: A_FIX }];
  // The schema grows the two fields only when the page was heard before with a fix.
  assert.equal(ballotSchema({}), BALLOT_SCHEMA);
  assert.equal(ballotSchema({ earlier: [] }), BALLOT_SCHEMA);
  assert.equal(ballotSchema({ earlier: [{ fix_first: "" }] }), BALLOT_SCHEMA);
  const schema = ballotSchema({ earlier });
  assert.deepEqual(schema.required, ["score", "fix_first", "evidence", "reverses_earlier", "earlier_was_wrong"]);
  assert.ok(schema.properties.reverses_earlier.description.includes(A_FIX));
  assert.deepEqual(BALLOT_SCHEMA.required, ["score", "fix_first", "evidence"], "the base schema is never mutated");
  assert.ok(ballotInstruction({ name: "The Copy Editor" }, "the Chair", { earlier }).includes(A_FIX));
  assert.ok(!ballotInstruction({ name: "The Copy Editor" }, "the Chair").includes("heard before"));
  // Sitting B's ballot, as it would be cast now: it asks for the unified phrase sitting A told the page to drop.
  const b = { score: 3, fix_first: B_FIX, evidence: "Ask about a founding seat" };
  assert.deepEqual(earlierReversal({ ...b, reverses_earlier: true, earlier_was_wrong: "" }, earlier), { explained: false, why: "" });
  assert.equal(
    earlierReversal({ ...b, reverses_earlier: "true", earlier_was_wrong: "It was wrong." }, earlier).explained,
    false,
    "not a reason",
  );
  assert.equal(
    earlierReversal(
      { ...b, reverses_earlier: true, earlier_was_wrong: "Three labels for one action make a donor wonder which one to press." },
      earlier,
    ).explained,
    true,
  );
  assert.equal(earlierReversal({ ...b, reverses_earlier: false, earlier_was_wrong: "" }, earlier), null);
  assert.equal(earlierReversal({ ...b, reverses_earlier: true }, []), null, "no earlier fix, nothing to reverse");
  // The void is named apart from a quote void, and an explained reversal carries its reason to the secretary.
  const cast = [
    { seat: "The Copy Editor", score: 3, grounded: false, voidWhy: "reversal", fix_first: B_FIX },
    { seat: "The Speech Coach", score: 6, grounded: true, fix_first: "x" },
    { seat: "The Architect", score: 5, grounded: true, fix_first: "y", reversesEarlier: true, earlierWasWrong: "Three labels confuse." },
    { seat: "The Marketer", score: 2, grounded: false, fix_first: "z" },
  ];
  const t = tallyBallots(cast);
  assert.deepEqual(t.reversed, ["The Copy Editor"]);
  assert.deepEqual(t.ungrounded, ["The Copy Editor", "The Marketer"]);
  assert.equal(t.verdict, 5, "the lower median of the two valid ballots, 5 and 6");
  assert.match(
    renderTally(t),
    /void, quote not in the material: The Marketer · void, reverses an earlier hearing's fix without saying why it was wrong: The Copy Editor/,
  );
  assert.equal(ballotNote(cast[0]), " (VOID: reverses an earlier hearing's fix without saying why it was wrong)");
  assert.equal(ballotNote(cast[2]), " (reverses an earlier hearing's fix: Three labels confuse.)");
  assert.equal(ballotNote(cast[3]), " (VOID: the quote is not in the material)");
  assert.equal(ballotNote(cast[1]), "");
});

test("earlier-5: fewer than two valid ballots is not conclusive - no verdict, the scores still shown, never happy", () => {
  assert.equal(MIN_BALLOTS, 2);
  // The home page's final sitting (20260923-231651-79a1): the Copy Editor's ballot void, the Speech Coach's 6 alone.
  const home = tallyBallots([
    { seat: "The Copy Editor", score: 7, grounded: false, fix_first: "a" },
    { seat: "The Speech Coach", score: 6, grounded: true, fix_first: "Remove the repeated slogan line", source: "evidence:page-words" },
  ]);
  assert.equal(home.conclusive, false);
  assert.equal(home.valid, 1);
  assert.equal(home.verdict, null);
  assert.deepEqual(home.scores, [6], "the one valid score is still on the record");
  assert.equal(scoreText(home), "not conclusive");
  assert.match(
    renderTally(home),
    /^NOT CONCLUSIVE: 1 valid ballot\(s\), a verdict takes 2 · cast 1 ballot\(s\): 6 · spread 0 · void, quote not in the material: The Copy Editor/,
  );
  // Every ballot void: not conclusive either, and the void scores are shown.
  const allVoid = tallyBallots([
    { seat: "A", score: 7, grounded: false },
    { seat: "B", score: 8, grounded: false },
  ]);
  assert.equal(allVoid.verdict, null);
  assert.equal(allVoid.conclusive, false);
  assert.match(renderTally(allVoid), /NOT CONCLUSIVE: 0 valid ballot\(s\).*cast 2 ballot\(s\): 7, 8.*every ballot void/);
  // A room of one seat is one opinion, whatever it scored; two valid ballots are a verdict.
  assert.equal(tallyBallots([{ seat: "A", score: 9, grounded: true }]).verdict, null);
  const two = tallyBallots([
    { seat: "A", score: 9, grounded: true },
    { seat: "B", score: 8, grounded: true },
  ]);
  assert.equal(two.conclusive, true);
  assert.equal(two.verdict, 8);
  assert.equal(scoreText(two), "8/10");
  assert.ok(!/NOT CONCLUSIVE/.test(renderTally(two)));
  // A record from before `conclusive` existed reads as it always did.
  assert.equal(scoreText({ verdict: 4 }), "4/10");
  assert.equal(scoreText({ verdict: null }), "-/10");
  // The hearing reads the tally's flags, and none of them ends it happy.
  const standing = standingOf(home);
  assert.deepEqual(standing, { split: false, allVoid: false, principleOnly: false, conclusive: false });
  assert.equal(roomHappy({ verdict: 9, happyAt: 7, conclusive: false }), false);
  assert.equal(roomHappy({ verdict: 9, happyAt: 7, ...standingOf(two) }), true);
  assert.equal(
    shouldStop({ verdict: null, happyAt: 7, round: 2, maxRounds: 2, ...standing }).why,
    "2 proposal round(s) held; the room is still not conclusive (fewer than two ballots were valid)",
  );
  assert.equal(shouldStop({ verdict: null, happyAt: 7, round: 0, maxRounds: 2, ...standing }).stop, false, "another round may conclude");
  // principleOnly reaches the stop rule now: a room grounded only in principle is not happy, whatever its median.
  assert.equal(roomHappy({ verdict: 9, happyAt: 7, ...standingOf({ principleOnly: true, conclusive: true }) }), false);
  // The docket history prints it the same way.
  assert.match(
    renderDocketsTable([{ when: "w", state: "finished", verdict: null, conclusive: false, happy: false, url: FOUNDERS, ask: "a" }]),
    /finished {2,}not conclusive not happy/,
  );
});
