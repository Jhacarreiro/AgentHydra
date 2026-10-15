/**
 * art.spec - ART (Aesthetic Review Team, sue/README.md#art): three professional designers walk a product on a phone
 * and a computer and return a polish list. Built on the critics' machinery: `critic: true` plus `studio: "art"`.
 * ==========================================================================================
 *
 * WHAT: `node --test sue/tests/art.spec.mjs`.
 *
 * WHY IT EXISTS: an ART designer changes what a Sue is asked, what her diary says and what the report prints. These tests
 * pin the seams a real change could break: the studio rules on a persona, the designer's diary in place of the critic's,
 * the polish and keep lines (with their severity scale), the shared questions, the design team a run seats and refuses,
 * and the report section. A non-ART Sue is unchanged: her note kinds, her note tool description and her critic's brief.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { NOTE_KINDS, toolSpecs } from "../body.mjs";
import { installTestPeople } from "./fixtures/people.mjs";
import { ART_KINDS, ART_NOTE_ADDENDUM, ART_QUESTIONS, artNoteExtra, gradeOf, shapeArtAnswers, yesNoOf } from "../lib/findings.mjs";
import {
  ART_DIARY,
  ART_TEAM,
  CRITIC_DIARY,
  buildBrainSystemPrompt,
  isArtPersona,
  mergePersona,
  mintIdentity,
  validatePersona,
} from "../lib/personas.mjs";
import { artCount, artSeats, planRun } from "../sue.mjs";
import { buildArt, buildReport, loadSue, renderMarkdown } from "../report.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DESIGNERS_FILE = path.resolve(here, "fixtures/art-designers.json");
const DESIGNERS = JSON.parse(fs.readFileSync(DESIGNERS_FILE, "utf8"));
const MOBILE = DESIGNERS.find((p) => p.id === "art-mobile");

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  delete process.env.SUE_HOME;
});
const tempDir = (prefix) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
};

const INTENT = "you renew your team's subscription every month and want to do it in one go, the fast way you always do";
const CRITIC_BRIEF_LINES = [...CRITIC_DIARY];

test("the three designers in tmp/art/personas.json are ART personas and pass validatePersona unchanged", () => {
  assert.deepEqual(
    DESIGNERS.map((p) => p.id),
    [...ART_TEAM],
  );
  for (const doc of DESIGNERS) {
    const before = JSON.stringify(doc);
    assert.equal(isArtPersona(doc), true, `${doc.id} is an ART persona`);
    assert.deepEqual(validatePersona(doc), [], `${doc.id} is a valid persona`);
    assert.equal(JSON.stringify(doc), before, `${doc.id} is not edited by validation`);
  }
  assert.deepEqual(ART_TEAM, ["art-mobile", "art-ux", "art-visual"]);
});

test("studio is refused without critic, refused when unknown, and never inherited through extends", () => {
  const withoutCritic = { ...MOBILE, critic: undefined };
  assert.ok(
    validatePersona(withoutCritic).some((problem) => /studio "art" needs critic: true/.test(problem)),
    "a studio with no critic is refused with a clear message",
  );
  const unknown = { ...MOBILE, studio: "design" };
  assert.ok(
    validatePersona(unknown).some((problem) => /studio, when set, is "art"/.test(problem)),
    "an unknown studio is refused by name",
  );
  // A visitor built on the designer's body is a visitor: the studio, like critic and interview, is hers alone.
  const visitor = mergePersona(MOBILE, { id: "visitor-vic", extends: "art-mobile", voice: "You are Vic, a visitor." });
  assert.equal(visitor.studio, undefined, "the studio is not inherited");
  assert.equal(visitor.critic, undefined, "the critic is not inherited either");
  assert.equal(isArtPersona(visitor), false);
});

test("isArtPersona is true only for a critic whose studio is art", () => {
  assert.equal(isArtPersona(MOBILE), true);
  assert.equal(isArtPersona({ ...MOBILE, studio: undefined }), false, "a critic with no studio is a plain critic");
  assert.equal(isArtPersona({ ...MOBILE, critic: false }), false);
  assert.equal(isArtPersona(null), false);
});

test("a non-ART Sue's note kinds and note tool description are unchanged, and an ART Sue's add polish and keep", () => {
  assert.deepEqual([...NOTE_KINDS], ["confusion", "annoyance", "delight", "broken", "question", "thought", "drop", "hook"]);
  const plainNote = toolSpecs("phone", {}).find(([name]) => name === "note")[1];
  assert.equal(plainNote.includes("polish"), false, "no polish kind for a plain Sue");
  assert.equal(plainNote, toolSpecs("phone", { art: false }).find(([name]) => name === "note")[1]);
  const designerNote = toolSpecs("phone", { art: true }).find(([name]) => name === "note")[1];
  assert.equal(designerNote, `${plainNote}${ART_NOTE_ADDENDUM}`, "a designer's note description is the plain one plus the ART line");
  assert.deepEqual([...ART_KINDS], ["polish", "keep"]);
});

test("a polish line is written with why, fix and severity 1 to 3; a keep line with why; anything else is refused", () => {
  const polish = artNoteExtra({ kind: "polish", why: "[G2]", fix: "pin Pay to a bottom bar, 48 px tall", severity: 2, seconds: 41.6 });
  assert.deepEqual(polish, { why: "[G2]", fix: "pin Pay to a bottom bar, 48 px tall", severity: 2, visitSeconds: 42 });
  for (const level of [1, 3]) {
    assert.equal(artNoteExtra({ kind: "polish", why: "judgement", fix: "x", severity: level }).severity, level);
  }
  for (const level of [0, 4, 1.5, "high", undefined]) {
    assert.ok(artNoteExtra({ kind: "polish", why: "judgement", fix: "x", severity: level }).refused, `severity ${level} is refused`);
  }
  assert.ok(artNoteExtra({ kind: "polish", why: "judgement", severity: 1 }).refused, "a polish line says fix");
  assert.ok(artNoteExtra({ kind: "polish", fix: "x", severity: 1 }).refused, "a polish line says why");
  assert.deepEqual(artNoteExtra({ kind: "keep", why: "it answers the question they came with" }), {
    why: "it answers the question they came with",
  });
  assert.ok(artNoteExtra({ kind: "keep", why: "works", severity: 2 }).refused, "severity is for polish only");
  assert.ok(artNoteExtra({ kind: "keep" }).refused, "a keep line says why");
  assert.equal(artNoteExtra({ kind: "thought", why: "x" }), null, "any other kind is not a designer's line");
});

test("a polish severity that is a boolean is refused, not written as 1; a numeric string is still read", () => {
  assert.ok(artNoteExtra({ kind: "polish", why: "judgement", fix: "x", severity: true }).refused, "true is refused");
  assert.ok(artNoteExtra({ kind: "polish", why: "judgement", fix: "x", severity: false }).refused, "false is refused");
  assert.equal(artNoteExtra({ kind: "polish", why: "judgement", fix: "x", severity: "2" }).severity, 2);
});

test("a grade read off a sentence's full stop is the whole number; a decimal or an off-scale one is still null", () => {
  assert.equal(gradeOf("7. Clean, but the menu is dense."), 7);
  assert.equal(gradeOf("10."), 10);
  assert.equal(gradeOf("7.5"), null, "a decimal is not a whole grade");
  assert.equal(gradeOf("0"), null);
  assert.equal(gradeOf("11."), null);
});

test("an answer that leads with 'not yet' reads as no, and every other yes or no reads as it did", () => {
  assert.equal(yesNoOf("Not yet - the total is hidden"), false);
  assert.equal(yesNoOf("not yet"), false);
  assert.equal(yesNoOf("Yes - every day"), true);
  assert.equal(yesNoOf("No. It is built for moving house"), false);
  assert.equal(yesNoOf("Nothing to ship yet"), null, "a word that only starts with no is not a no");
  assert.equal(yesNoOf("maybe"), null);
});

test("an art run refuses a cast, naming the two as different instruments, before it writes anything", () => {
  installTestPeople(DESIGNERS.map((doc) => ({ doc })));
  process.env.SUE_HOME = tempDir("sue-art-home-");
  const args = { workspace: tempDir("sue-art-ws-"), url: "https://example.com/renew", intent: INTENT, art: true };
  const cast = [{ id: "party-planner-dana", displayName: "Dana", extends: "art-mobile", voice: "You are Dana.", errands: [INTENT] }];
  assert.throws(() => planRun({ ...args, cast }), /art and a cast are different instruments/);
});

test("an art run whose designer does not fit the local brain's context is refused by name, never swapped for a cast visitor", () => {
  installTestPeople(DESIGNERS.map((doc) => ({ doc })));
  process.env.SUE_HOME = tempDir("sue-art-home-");
  const args = { workspace: tempDir("sue-art-ws-"), url: "https://example.com/renew", intent: INTENT, art: true };
  assert.throws(
    () => planRun({ ...args, brainContextTokens: 4000 }),
    /art-mobile: her prompt is about \d+ tokens and the local brain has 4000 loaded[^]*seats designers only/,
  );
});

test("a designer who ran an APE scenario keeps its questions in the report, then gets the ART shaping", () => {
  const runDir = tempDir("sue-art-run-");
  const dir = path.join(runDir, "sue-1");
  fs.mkdirSync(dir, { recursive: true });
  // The designer's ART questions are the scenario's own here, as the body asks them in an APE visit: the APE shaper keeps those.
  const scenario = { id: "ape", ape: true, interview: { designGrade: "the design grade, 1 to 10", wouldShip: "would you ship it" } };
  fs.writeFileSync(path.join(dir, "sue.json"), JSON.stringify({ persona: MOBILE, scenario }));
  fs.writeFileSync(
    path.join(dir, "interview.json"),
    JSON.stringify({ lostWork: "yes, my draft", annoyanceScore: 4, designGrade: "6 - tight", wouldShip: "no - the pay is lost" }),
  );
  const loaded = loadSue(runDir, "sue-1").interview;
  assert.equal(loaded.lostWork.yes, true, "the APE key survives the report's shaping");
  assert.equal(loaded.annoyanceScore, 4);
  assert.equal(loaded.designGrade, 6, "and the ART shaping is applied after it");
  assert.equal(loaded.wouldShip.yes, false);
});

test("an unseen designer (she never saw the page) is left out of the grade average and the would-ship counts", () => {
  const seen = { sueId: "sue-1", sue: { persona: MOBILE, scenario: { id: "s" } }, body: {}, summary: {}, findings: [], trace: [], interview: shapeArtAnswers({ designGrade: "7 - clean", wouldShip: "no - the pay is lost" }) };
  const unseen = { ...seen, sueId: "sue-2", interview: { ...shapeArtAnswers({ designGrade: "2 - broken", wouldShip: "yes" }), unseen: true } };
  const art = buildArt([seen, unseen]);
  assert.equal(art.grade, 7, "a grade she gave without seeing the page does not count");
  assert.deepEqual(art.wouldShip, { yes: 0, no: 1 });
});

test("ART's shared questions are the eight the contract names, and a designer's own interview is folded with them", () => {
  assert.deepEqual(Object.keys(ART_QUESTIONS), ["designGrade", "topFixes", "progressiveDisclosure", "colourMeaning", "appeal", "screenFit", "keep", "wouldShip"]);
  assert.equal(gradeOf("7/10 - clean, but the menu is dense"), 7);
  assert.equal(gradeOf("8"), 8);
  assert.equal(gradeOf(9), 9);
  assert.equal(gradeOf(11), null, "a grade past 10 is not rounded to one");
  assert.equal(gradeOf("7.5"), null, "a fraction is not a whole grade");
  assert.equal(gradeOf("no idea"), null);
  assert.equal(yesNoOf("yes, after the menu is fixed"), true);
  assert.equal(yesNoOf("no"), false);
  const shaped = shapeArtAnswers({ designGrade: "6 of 10", wouldShip: "no - the checkout hides the total" });
  assert.equal(shaped.designGrade, 6);
  assert.equal(shaped.wouldShip.yes, false);
  assert.equal(shapeArtAnswers(shaped).designGrade, 6, "a second pass changes nothing");
});

test("a designer's brief is ART_DIARY, and a non-ART critic's brief keeps CRITIC_DIARY exactly", () => {
  const target = { id: "example", url: "https://example.com/", name: "Example", mailbox: { kind: "fixture" } };
  const identityFor = (persona) => mintIdentity(persona, { sueNumber: 1, runId: "20261009-000000-abcd", target });
  const designer = buildBrainSystemPrompt({
    persona: MOBILE,
    target,
    scenario: { id: "s", prompt: "Go." },
    identity: identityFor(MOBILE),
    errand: "You want to renew your team's subscription.",
  });
  assert.ok(designer.includes(ART_DIARY.join("\n")), "the designer's diary is ART_DIARY");
  assert.equal(designer.includes(CRITIC_BRIEF_LINES.join("\n")), false, "and not the critic's diary");

  const plainCritic = { ...MOBILE, studio: undefined };
  const critic = buildBrainSystemPrompt({
    persona: plainCritic,
    target,
    scenario: { id: "s", prompt: "Go." },
    identity: identityFor(plainCritic),
    errand: "You want to renew your team's subscription.",
  });
  assert.ok(critic.includes(CRITIC_BRIEF_LINES.join("\n")), "a non-ART critic keeps CRITIC_DIARY");
  assert.equal(critic.includes(ART_DIARY.join("\n")), false, "and never the designer's diary");
});

test("an art run seats the design team by default, names only designers, and refuses a non-designer by name", () => {
  installTestPeople(DESIGNERS.map((doc) => ({ doc })));
  process.env.SUE_HOME = tempDir("sue-art-home-");
  assert.deepEqual(artSeats(undefined), [...ART_TEAM]);
  assert.deepEqual(artSeats(["art-ux"]), ["art-ux"]);
  assert.throws(() => artSeats(["dev-dan"]), /dev-dan: not an ART designer/);
});

test("an art run's count is one visit per designer seated, and a count above that is refused", () => {
  assert.equal(artCount(undefined, 3), 3);
  assert.equal(artCount(2, 3), 2);
  assert.throws(() => artCount(4, 3), /above the 3 designers/);
  assert.throws(() => artCount(0, 3), /1 or more/);
});

test("planRun refuses an art run with ape, with watches ad, and with a non-designer, before it writes anything", () => {
  installTestPeople(DESIGNERS.map((doc) => ({ doc })));
  process.env.SUE_HOME = tempDir("sue-art-home-");
  const args = { workspace: tempDir("sue-art-ws-"), url: "https://example.com/renew", intent: INTENT, art: true };
  assert.throws(() => planRun({ ...args, ape: true }), /art and ape are different instruments/);
  assert.throws(() => planRun({ ...args, watches: "ad" }), /cannot be art/);
  assert.throws(() => planRun({ ...args, personas: ["dev-dan"] }), /dev-dan: not an ART designer/);
  assert.throws(() => planRun({ ...args, count: 4 }), /above the 3 designers/);
  assert.throws(() => planRun({ ...args, art: "yes" }), /art is true or not set/);
});

test("the report's ART section and its JSON are built from the designers' Sues, and are null with no designer", () => {
  const sue = (sueId, persona, findings, interview) => ({
    sueId,
    sue: { persona, scenario: { id: "s" } },
    body: { outcome: "done" },
    interview,
    summary: {},
    findings,
    trace: [],
  });
  const polish = (text, severity, screenUrl, visitSeconds) => ({
    source: "brain",
    kind: "polish",
    text,
    url: screenUrl,
    why: "[G2]",
    fix: `fix ${text}`,
    severity,
    visitSeconds,
  });
  const keep = (text, url, visitSeconds) => ({ source: "brain", kind: "keep", text, url, why: "judgement", visitSeconds });
  const sues = [
    sue(
      "sue-1",
      MOBILE,
      [polish("Pay sits out of thumb reach", 3, "https://example.com/plans", 20), keep("the confirmation names the time", "https://example.com/book", 50)],
      shapeArtAnswers({ designGrade: "7 - clean, dense menu", wouldShip: "no, the pay button is lost", topFixes: "pin pay" }),
    ),
    sue("sue-2", { id: "dev-dan" }, [], null),
  ];
  const report = buildReport({ runId: "20261009-000000-abcd", manifest: { target: "example", scenario: "s" }, sues, groundTruth: {} });
  assert.equal(report.art.designers, 1);
  assert.deepEqual(report.art.devices, { phone: 1 });
  assert.equal(report.art.grade, 7);
  assert.deepEqual(report.art.wouldShip, { yes: 0, no: 1 });
  assert.deepEqual(
    report.art.fixFirst.map((f) => [f.screen, f.text, f.severity, f.by]),
    [["/plans", "Pay sits out of thumb reach", 3, "art-mobile"]],
  );
  assert.deepEqual(report.art.debtByScreen.map((row) => [row.screen, row.score, row.polish, row.keep]), [
    ["/plans", 3, 1, 0],
    ["/book", 0, 0, 1],
  ]);
  const markdown = renderMarkdown(report);
  assert.ok(markdown.includes("## ART: design review"), "the section prints");
  assert.ok(markdown.indexOf("## ART: design review") < markdown.indexOf("The verdict"), "before the verdict");
  assert.equal(buildArt([sues[1]]), null, "no designer, no section");
  assert.equal(buildReport({ runId: "r", manifest: { target: "t", scenario: "s" }, sues: [sues[1]], groundTruth: {} }).art, null);
  assert.equal(ART_KINDS.includes("polish"), true);
});
