// The resolution loop's own rules: when the room is happy, what the Humanizer may change, in what order a draft is
// checked and humanized, what the claims check counts as the page's words, and what the bill counts.
//
//   node --test dredd/tests/resolve.spec.mjs
//
// Every case here is from the Opus 5.5 review of Dredd (2026-09-22). No model is called: the drafter and the
// Humanizer are handed in as plain functions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { checkClaims, trimClaims } from "../lib/claims.mjs";
import { awaitField, draftChecked, hearingBill, jevCallRow, lastRuling, renderBill } from "../lib/hearing.mjs";
import { draftProposal, drafterModels, mergeHumanized, roomHappy, shouldStop } from "../lib/resolve.mjs";
import { reapAfterEach } from "./_scratch.mjs";

const PAGE = "One login for email and payments. Pro $39.99/mo. 10K users.";

/** Scratch dirs made by a test; removed after each one whatever the outcome. */
const scratchDirs = reapAfterEach([]);
const scratch = (prefix) => {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  scratchDirs.push(d);
  return d;
};

test("a failed Design Critic launch is not waited on; a real launch is", async () => {
  const root = scratch("dredd-field-");
  const docket = (status) => ({ created: new Date().toISOString(), surfaces: [], results: [{ id: "design-critic", status }] });
  const failed = await awaitField({ root, docket: docket("launch failed - pwsh not found"), waitMs: 0, log: () => {} });
  assert.equal(failed.criticDone, true, "a critic that never started has nothing to wait for");
  const launched = await awaitField({ root, docket: docket("launched, pid 4242 (fairjob)"), waitMs: 0, log: () => {} });
  assert.equal(launched.criticDone, false, "a launched critic is waited on until its capture lands");
});

test("one rule for a happy room: never split, never every ballot void, and the stop rule and H.happy agree", () => {
  assert.equal(roomHappy({ verdict: 8, happyAt: 7 }), true);
  assert.equal(roomHappy({ verdict: 8, happyAt: 7, split: true }), false);
  assert.equal(roomHappy({ verdict: 8, happyAt: 7, allVoid: true }), false, "a room that grounded nothing is not happy");
  assert.equal(roomHappy({ verdict: 6, happyAt: 7 }), false);
  assert.equal(roomHappy({ verdict: null, happyAt: 7 }), false);

  const voidRoom = shouldStop({ verdict: 8, happyAt: 7, round: 1, maxRounds: 2, allVoid: true });
  assert.equal(voidRoom.stop, false, "an all-void room runs another round");
  assert.match(voidRoom.why, /void/);

  // Out of rounds on a split 7: stopped, and the reason must not read like a happy ruling.
  const spent = shouldStop({ verdict: 7, happyAt: 7, round: 2, maxRounds: 2, split: true });
  assert.equal(spent.stop, true);
  assert.match(spent.why, /split/);
  assert.doesNotMatch(spent.why, /happy at/);
  const spentVoid = shouldStop({ verdict: 7, happyAt: 7, round: 2, maxRounds: 2, allVoid: true });
  assert.match(spentVoid.why, /void/);

  for (const room of [
    { verdict: 8, split: false, allVoid: false },
    { verdict: 8, split: true, allVoid: false },
    { verdict: 8, split: false, allVoid: true },
    { verdict: 5, split: false, allVoid: false },
  ]) {
    const stop = shouldStop({ ...room, happyAt: 7, round: 2, maxRounds: 2 });
    assert.equal(/happy at/.test(stop.why), roomHappy({ ...room, happyAt: 7 }), JSON.stringify(room));
  }
});

test("the Humanizer may change only 'after' and 'headline'; a reshaped answer keeps the draft", () => {
  const draft = {
    headline: "One login",
    changes: [
      { where: "hero", before: "Old hero", after: "New hero", why: "Ray" },
      { where: "pricing", before: "Old price line", after: "Pro is $39.99 a month.", why: "Sue" },
    ],
    cuts: ["a tired line"],
    note: "the owner decides the price placement",
  };
  const human = {
    headline: "One login, that's it",
    changes: [
      { where: "hero", before: "Start your free trial", after: "A hero a person wrote", why: "rewritten why" },
      { where: "pricing", before: "Old price line", after: "Pro costs $39.99 a month.", why: "Sue" },
    ],
    cuts: [],
    note: "",
  };
  const m = mergeHumanized(draft, human);
  assert.equal(m.humanized, true);
  assert.equal(m.proposal.headline, "One login, that's it");
  assert.deepEqual(
    m.proposal.changes.map((c) => c.after),
    ["A hero a person wrote", "Pro costs $39.99 a month."],
  );
  assert.equal(m.proposal.changes[0].before, "Old hero", "the draft's before stands, whatever the Humanizer wrote");
  assert.equal(m.proposal.changes[0].why, "Ray");
  assert.deepEqual(m.proposal.cuts, ["a tired line"]);
  assert.equal(m.proposal.note, "the owner decides the price placement");

  const dropped = mergeHumanized(draft, { ...human, changes: human.changes.slice(0, 1) });
  assert.equal(dropped.humanized, false);
  assert.equal(dropped.proposal, draft);
  assert.match(dropped.why, /1 change\(s\) for the draft's 2/);

  const renamed = mergeHumanized(draft, { ...human, changes: [human.changes[0], { ...human.changes[1], where: "footer" }] });
  assert.equal(renamed.humanized, false);
  assert.match(renamed.why, /footer/);

  const noHeadline = mergeHumanized({ changes: draft.changes }, human);
  assert.equal(noHeadline.proposal.headline, undefined, "a headline the draft did not change is not added");

  const missing = mergeHumanized(draft, null, "the humanizer skill is not installed");
  assert.equal(missing.humanized, false);
  assert.equal(missing.proposal, draft);
});

/** A drafter and a Humanizer that answer from a list and count their calls. */
function fakes(drafts, humanized) {
  const calls = { draft: 0, humanize: 0 };
  return {
    calls,
    draft: async () => ({ data: drafts[calls.draft++] }),
    humanizer: async () => ({ data: humanized[calls.humanize++] ?? null, error: "no answer" }),
  };
}

test("a draft the claims check refuses never pays for a Humanizer call; the check still reads the humanized text", async () => {
  const bad = { changes: [{ where: "hero", after: "Start your free trial", why: "x" }] };
  const good = { changes: [{ where: "hero", after: "One login for email and payments.", why: "x" }] };
  const f = fakes([bad, good], [{ changes: [{ where: "hero", after: "Email and payments, one login.", why: "x" }] }]);
  const d = await draftChecked({ round: 1, base: {}, callsLog: null, pageText: PAGE, inventory: null, log: () => {}, ...f });
  assert.equal(f.calls.draft, 2);
  assert.equal(f.calls.humanize, 1, "only the passing redraft was humanized");
  assert.equal(d.humanized, true);
  assert.equal(d.proposal.changes[0].after, "Email and payments, one login.");
  assert.equal(d.rejected, null);

  // The Humanizer adds a claim the page never carries: the checked, unhumanized draft goes to the room instead.
  const g = fakes([good], [{ changes: [{ where: "hero", after: "One login, no credit card.", why: "x" }] }]);
  const lines = [];
  const e = await draftChecked({ round: 1, base: {}, callsLog: null, pageText: PAGE, inventory: null, log: (l) => lines.push(l), ...g });
  assert.equal(e.humanized, false);
  assert.equal(e.proposal.changes[0].after, "One login for email and payments.");
  assert.ok(
    lines.some((l) => /no credit card/.test(l)),
    lines.join("\n"),
  );

  // Refused twice with nothing left after the cut: REJECTED, and the Humanizer was never asked.
  const h = fakes([bad, bad], []);
  const r = await draftChecked({ round: 1, base: {}, callsLog: null, pageText: PAGE, inventory: null, log: () => {}, ...h });
  assert.equal(h.calls.humanize, 0);
  assert.ok(r.rejected?.length);
});

test("a draft's why may quote what the hearing's visitors said, why they stopped, the complaint and the ruling", async () => {
  // Round 12 of lift-v2 (docket round-20261004-031251-2f1d): the claims check refused a why that quoted
  // crazygames-kid's own stop words and kid-jo's note as "nobody said it", twice, and the hearing ended with no proposal.
  const base = {
    ask: 'Round 12 of lift-v2: crazygames-kid: "i finished it. didnt do lesson 6 cuz nobody told me to"',
    sue: {
      theirWords: [{ kind: "thought", where: "/lift/student/", said: "KHOU is a news channel. had to read 'settles' twice tho" }],
      whyTheyStopped: [{ sueId: "sue-1-kid-jo", said: "I finished the lesson. After that I was just done for the night." }],
    },
    minutes: { fix_first: "Add a primary Next lesson button under the level bar.", plan: "Make the level-up a moment." },
  };
  const grounded = {
    changes: [
      {
        where: "finish",
        after: "One login.",
        why: '"didnt do lesson 6 cuz nobody told me to"; "had to read \'settles\' twice"; "just done for the night"; "Next lesson button"',
      },
    ],
  };
  const f = fakes([grounded], []);
  const d = await draftChecked({ round: 1, base, callsLog: null, pageText: PAGE, inventory: null, log: () => {}, ...f });
  assert.equal(f.calls.draft, 1, "nothing was refused, so nothing was redrafted");
  assert.equal(d.claims, null);
  assert.equal(d.proposal.changes[0].why, grounded.changes[0].why);

  // A quote nobody said is still refused.
  const invented = { changes: [{ where: "finish", after: "One login.", why: '"this is the best app ever"' }] };
  const g = fakes([invented, invented], []);
  const e = await draftChecked({ round: 1, base, callsLog: null, pageText: PAGE, inventory: null, log: () => {}, ...g });
  assert.equal(g.calls.draft, 2);
  assert.match(e.claims, /best app ever/);
});

test("a code proposal may name only files that exist or that it creates (Dredd's self-hearing scored an import of a missing file 7/10, 2026-09-23)", () => {
  const onDisk = new Set(["dredd/tests/room.spec.mjs", "dredd/bench.json"]);
  const exists = (p) => onDisk.has(p);
  // The room's winning fix, verbatim: the file it imports was the very file the evidence said was missing.
  const ghost = checkClaims({
    proposal: {
      changes: [
        {
          where: "dredd/tests/room.spec.mjs, top import block",
          after: "import '.arkitect/runners/atlas/bill.mjs';",
          why: "rely on the shared module",
        },
      ],
    },
    matter: "code",
    exists,
  });
  assert.deepEqual(
    ghost.findings.map((f) => [f.kind, f.text, f.at]),
    [["path:missing", ".arkitect/runners/atlas/bill.mjs", [0]]],
  );
  // A file the proposal itself creates is not missing, and a code line's numbers and words are not page claims.
  const made = checkClaims({
    proposal: {
      changes: [
        { where: "dredd/lib/new-thing.mjs (new file)", after: "export const RETRIES = 3; // free trial of the idea", why: "x" },
        {
          where: "dredd/bench.json",
          after: "import { RETRIES } from './lib/new-thing.mjs' in dredd/lib/new-thing.mjs",
          why: "x",
        },
      ],
    },
    matter: "code",
    exists,
  });
  assert.deepEqual(made.findings, [], JSON.stringify(made.findings));
  // The page rules still hold on a page matter.
  const page = checkClaims({
    proposal: { changes: [{ where: "hero", after: "Start your free trial", why: "x" }] },
    pageText: "One login.",
  });
  assert.ok(page.findings.some((f) => f.kind === "offer:free-trial"));
});

test("a code proposal is never humanized - the Humanizer rewrites copy, not code", async () => {
  const f = fakes(
    [{ changes: [{ where: "dredd/bench.json", after: '"jev": "Is the ask..."', why: "x" }] }],
    [{ changes: [{ where: "dredd/bench.json", after: "Is the ask, really?", why: "x" }] }],
  );
  const d = await draftChecked({
    round: 1,
    base: {},
    callsLog: null,
    pageText: "",
    inventory: null,
    matter: "code",
    exists: () => true,
    log: () => {},
    ...f,
  });
  assert.equal(f.calls.humanize, 0);
  assert.equal(d.humanized, false);
  assert.equal(d.proposal.changes[0].after, '"jev": "Is the ask..."');
});

test("a `before` counts as the page's words only when the page really carries it", () => {
  const invented = checkClaims({
    proposal: { changes: [{ where: "cta", before: "Start your free trial", after: "Start your free trial, no credit card", why: "x" }] },
    pageText: "One login for email and payments. Pro $39.99/mo.",
  });
  assert.ok(
    invented.findings.some((f) => f.kind === "offer:free-trial"),
    JSON.stringify(invented.findings),
  );
  assert.deepEqual(invented.offPage, ["cta"], "the unquoted before is named");

  // Typographic drift is not an invention: a curly quote and an en dash still match the page.
  const drift = checkClaims({
    proposal: {
      changes: [{ where: "hero", before: "It\u2019s one login \u2013 for everything", after: "One login for everything.", why: "x" }],
    },
    pageText: "It's one login - for   everything. Start your free trial.",
  });
  assert.deepEqual(drift.offPage, []);

  // No page text: no before counts, so a capability is refused instead of taking the drafter's word for it.
  const blind = checkClaims({
    proposal: { changes: [{ where: "hero", before: "Take payments", after: "Take payments today.", why: "x" }] },
    pageText: "",
  });
  assert.ok(
    blind.findings.some((f) => f.kind === "capability:not-on-page"),
    JSON.stringify(blind.findings),
  );
});

test("the stamp cuts by place, never by label: every change an invention sits in goes, a clean twin stays", () => {
  const twoPlaces = {
    changes: [
      { where: "a", after: "Start a free trial", why: "" },
      { where: "b", after: "Free trial for all", why: "" },
      { where: "c", after: "One login for email.", why: "" },
    ],
  };
  const c = checkClaims({ proposal: twoPlaces, pageText: PAGE });
  assert.equal(c.findings.length, 1, "still one finding per invention");
  const t = trimClaims(twoPlaces, c.findings);
  assert.deepEqual(
    t.proposal.changes.map((x) => x.where),
    ["c"],
    "the invention in both changes is cut from both",
  );

  const sameLabel = {
    changes: [
      { where: "hero", after: "Free trial", why: "" },
      { where: "hero", after: "One login for email.", why: "" },
    ],
  };
  const s = trimClaims(sameLabel, checkClaims({ proposal: sameLabel, pageText: PAGE }).findings);
  assert.deepEqual(
    s.proposal.changes.map((x) => x.after),
    ["One login for email."],
    "the clean change that shares a label survives",
  );

  const headlineLabel = { headline: "One login", changes: [{ where: "headline", after: "Free trial", why: "" }] };
  const hl = trimClaims(headlineLabel, checkClaims({ proposal: headlineLabel, pageText: PAGE }).findings);
  assert.equal(hl.proposal.headline, "One login", "a change labelled 'headline' does not take the headline with it");

  assert.throws(() => trimClaims(sameLabel, [{ kind: "number", where: "hero", text: "5" }]), /no place/);
});

test("P10: a why or note that quotes nobody real is stamped; the change survives, only the why is cut", () => {
  const proposal = {
    changes: [
      {
        where: "hero",
        after: "One login for email and payments.",
        why: 'Sue said "the checkout was the smoothest part of the whole thing"',
      },
      { where: "pricing", after: "Pro is $39.99 a month.", why: "matches the board's ruling" },
    ],
    note: 'a visitor said "give me a free trial or I am gone"',
  };
  const c = checkClaims({ proposal, pageText: PAGE, sueWords: ["the checkout was fine, nothing special"], ruling: "cut the second card" });
  const kinds = c.findings.filter((f) => f.kind === "quote:not-in-evidence");
  assert.equal(kinds.length, 2, JSON.stringify(c.findings));
  // checkClaims groups findings by (kind, text) and keeps every place they sit in, so `at` is an array of places.
  assert.ok(kinds.some((f) => f.at.includes(0) && /smoothest part/.test(f.text)));
  assert.ok(kinds.some((f) => f.at.includes("note") && /free trial or I am gone/.test(f.text)));

  const t = trimClaims(proposal, kinds);
  assert.equal(t.proposal.changes.length, 2, "the change survives, only the why is cut");
  assert.equal(t.proposal.changes[0].why, "", "the invented why is stripped");
  assert.equal(t.proposal.changes[0].after, "One login for email and payments.", "the change itself stands");
  assert.equal(t.proposal.changes[1].why, "matches the board's ruling", "an untouched why is untouched");
  assert.equal(t.proposal.note, undefined, "the invented note is stripped");
  assert.ok(t.cut.some((x) => /smoothest part/.test(x)));
  assert.ok(t.cut.some((x) => /free trial or I am gone/.test(x)));
});

test("P10: a why that really quotes a visitor, the ruling or the page passes the claims check untouched", () => {
  const proposal = {
    changes: [
      {
        where: "hero",
        after: "One login for email and payments.",
        why: 'echoes what a visitor said: "I read the whole first screen twice"',
      },
      { where: "pricing", after: "Pro is $39.99 a month.", why: 'the board ruled "cut the second pricing card"' },
    ],
  };
  const c = checkClaims({
    proposal,
    pageText: PAGE,
    sueWords: ["I read the whole first screen twice and still had no idea"],
    ruling: "cut the second pricing card first",
  });
  assert.deepEqual(
    c.findings.filter((f) => f.kind === "quote:not-in-evidence"),
    [],
  );
});

test("P12: roomHappy and shouldStop refuse a principleOnly room exactly as they refuse an all-void one, without touching the void rule", () => {
  assert.equal(roomHappy({ verdict: 8, happyAt: 7, principleOnly: true }), false, "grounded only in principle is not happy");
  assert.equal(roomHappy({ verdict: 8, happyAt: 7, principleOnly: false }), true);
  const another = shouldStop({ verdict: 8, happyAt: 7, round: 1, maxRounds: 2, principleOnly: true });
  assert.equal(another.stop, false, "another round, same as an all-void room");
  assert.match(another.why, /principle/);
  const spent = shouldStop({ verdict: 8, happyAt: 7, round: 2, maxRounds: 2, principleOnly: true });
  assert.equal(spent.stop, true);
  assert.match(spent.why, /principle/);
  assert.doesNotMatch(spent.why, /happy at/);
});

test("the page's own figures pass whatever their currency sign or letter case", () => {
  const c = checkClaims({
    proposal: { changes: [{ where: "pricing", after: "Pro is 39.99 a month, 10k users.", why: "x" }] },
    pageText: PAGE,
  });
  assert.deepEqual(c.findings, []);
  const pct = checkClaims({
    proposal: { changes: [{ where: "pricing", after: "Save 5% today", why: "x" }] },
    pageText: "Pro is 5 dollars.",
  });
  assert.ok(
    pct.findings.some((f) => f.kind === "number" && f.text === "5%"),
    "a percent is not the bare number",
  );
});

test("a drafter whose queue is used up with no proposal is asked once more on the code route (Lift lift-v2 round 5: 'not an object' ended the drafting)", async () => {
  const bad = { data: null, status: "error", model: "gemini-3.5-flash-lite", error: "InvalidStructuredAnswer: (root): not an object" };
  const proposal = { changes: [{ where: "hero", after: "One login for email and payments.", why: "x" }] };
  const gaveUp = { data: { changes: [], note: "I cannot draft this without the owner." }, status: "ok", model: "auto" };

  // 1. one malformed answer on ['auto'] is not the end: the second ask is auto on the code profile.
  const asked = [];
  const d = await draftProposal({
    ask: "x",
    models: ["auto"],
    askFn: async (s) => {
      asked.push(s);
      return asked.length === 1 ? bad : { data: proposal, status: "ok", model: "groq-gpt-oss-120b" };
    },
  });
  assert.equal(asked.length, 2);
  assert.equal(asked[1].model, "auto");
  assert.equal(asked[1].profile, "code");
  assert.deepEqual(d.data, proposal);
  assert.match(d.fellBackFrom[0], /^auto \(answered by gemini-3\.5-flash-lite\): InvalidStructuredAnswer/);

  // 2. both fail: exactly two asks, one error naming both.
  let n = 0;
  const none = await draftProposal({ ask: "x", models: ["auto"], askFn: async () => (n++, bad) });
  assert.equal(n, 2);
  assert.equal(none.data, null);
  assert.match(none.error, /^every drafter failed - auto .*InvalidStructuredAnswer.*; auto \(code\) .*InvalidStructuredAnswer/);

  // 3. a give-up, then a failure: still two asks, never a third.
  let m = 0;
  const after = await draftProposal({ ask: "x", models: ["auto"], askFn: async () => (m++ === 0 ? gaveUp : bad) });
  assert.equal(m, 2);
  assert.equal(after.data, null);
  assert.match(after.error, /^every drafter failed - /);
});

test("--resolve drafts only against a real ruling, never a failure record", () => {
  const dir = scratch("dredd-ruling-");
  assert.match(lastRuling(dir).why, /no minutes/);
  mkdirSync(path.join(dir, "boardroom"));
  writeFileSync(path.join(dir, "boardroom", "minutes.json"), JSON.stringify({ failed: true, error: "no seat answered", verdict: null }));
  const failed = lastRuling(dir);
  assert.equal(failed.minutes, null);
  assert.match(failed.why, /no seat answered/);
  writeFileSync(path.join(dir, "boardroom", "minutes.json"), JSON.stringify({ verdict: 6, fix_first: "say what it is" }));
  const ok = lastRuling(dir);
  assert.equal(ok.minutes.verdict, 6);
  assert.equal(ok.why, null);
});

test("the bill counts Jev's seat pick, says when SUE is still running, and times a --resolve from its own start", () => {
  assert.deepEqual(jevCallRow({ jev_model: "typesafe-jev", jev_cost_usd: 0.0002, fallback_cost_usd: 0.0011, seconds: 2.4 }), {
    what: "seat pick",
    model: "typesafe-jev",
    cost_usd: 0.0013,
    seconds: 2.4,
  });
  assert.deepEqual(jevCallRow({ model: "opus", cost_usd: 0.05, seconds: 9 }), {
    what: "seat pick",
    model: "opus",
    cost_usd: 0.05,
    seconds: 9,
  });
  assert.equal(jevCallRow(null), null);

  const dir = scratch("dredd-bill-jev-");
  writeFileSync(path.join(dir, "jev-calls.jsonl"), `${JSON.stringify(jevCallRow({ model: "opus", cost_usd: 0.05, seconds: 9 }))}\n`);
  const docket = {
    created: "2026-09-20T10:00:00.000Z",
    results: [{ id: "sue", status: "still running (2 of 5 finished) - run --collect again", costUsd: 1.1 }],
  };
  const b = hearingBill({ docketDir: dir, docket, openedAt: "2026-09-22T10:00:00.000Z", finishedAt: "2026-09-22T10:02:00.000Z" });
  assert.equal(b.calls, 1);
  assert.equal(b.modelUsd, 0.05);
  assert.equal(b.wallMs, 120_000, "from this run's start, not the docket's opening two days earlier");
  assert.match(renderBill(b), /SUE \$1\.10 so far \(still running\)/);
});

test("a drafter that brings back no proposal is asked again on another model (futurethatworks.org, 2026-09-24: 0 chars after 75 s)", async () => {
  // The four failed hearings as the zswarm ledger saw them: "gemini-3.8-flash" was routed to deepseek-flash-or, whose
  // whole 4000-token output cap went on reasoning (out 4000, reasoning 4000), so the answer was empty, and the hedge
  // asked the SAME model again. The hearing ended at the evidence score with no proposal drafted.
  const empty = {
    data: null,
    status: "error",
    model: "deepseek-flash-or",
    error: "no structured answer from deepseek-flash-or after 75.552 s (0 chars) - no JSON object in the answer",
  };
  const proposal = { changes: [{ where: "hero", after: "One login for email and payments.", why: "x" }] };
  const asked = [];
  const askFn = async (spec) => {
    asked.push(spec);
    return spec.model === "auto" ? { data: proposal, status: "ok", model: "groq-gpt-oss-120b" } : empty;
  };
  const saved = process.env.DREDD_DRAFTER_FALLBACK;
  delete process.env.DREDD_DRAFTER_FALLBACK;
  try {
    const d = await draftProposal({ ask: "x", model: "gemini-3.8-flash", missingFiles: ["src/components/SharedCTA.vue"], askFn });
    assert.deepEqual(
      asked.map((s) => s.model),
      ["gemini-3.8-flash", "auto"],
    );
    assert.deepEqual(d.data, proposal);
    assert.equal(d.model, "groq-gpt-oss-120b");
    assert.match(d.fellBackFrom[0], /^gemini-3\.8-flash \(answered by deepseek-flash-or\): no structured answer/);
    // The ruling's invented files reach the drafter by name, on every model it asks.
    for (const s of asked) assert.match(s.prompt, /NOT in the repository - never name them[^]*- src\/components\/SharedCTA\.vue/);

    // Every model answers nothing: one error that names each attempt and the model that really answered it.
    const none = await draftProposal({
      ask: "x",
      models: ["gemini-3.8-flash", "auto"],
      askFn: async (s) => ({ ...empty, model: s.model === "auto" ? "groq-gpt-oss-120b" : "deepseek-flash-or" }),
    });
    assert.equal(none.data, null);
    assert.equal(none.status, "error");
    assert.match(
      none.error,
      /^every drafter failed - gemini-3\.8-flash \(answered by deepseek-flash-or\): .*; auto \(answered by groq-gpt-oss-120b\): /,
    );

    // The chain: the drafter model, then DREDD_DRAFTER_FALLBACK (else auto), never one model twice; empty turns it off.
    assert.deepEqual(drafterModels("gemini-3.8-flash"), ["gemini-3.8-flash", "auto"]);
    process.env.DREDD_DRAFTER_FALLBACK = "mistral-medium-3.5, gemini-3.8-flash ,auto";
    assert.deepEqual(drafterModels("gemini-3.8-flash"), ["gemini-3.8-flash", "mistral-medium-3.5", "auto"]);
    process.env.DREDD_DRAFTER_FALLBACK = "";
    assert.deepEqual(drafterModels("gemini-3.8-flash"), ["gemini-3.8-flash"]);
  } finally {
    if (saved === undefined) delete process.env.DREDD_DRAFTER_FALLBACK;
    else process.env.DREDD_DRAFTER_FALLBACK = saved;
  }

  // The hearing records the model that really drafted, and says it fell back.
  const lines = [];
  const r = await draftChecked({
    round: 1,
    base: { model: "gemini-3.8-flash" },
    callsLog: null,
    pageText: PAGE,
    inventory: null,
    log: (l) => lines.push(l),
    draft: async () => ({
      data: proposal,
      model: "groq-gpt-oss-120b",
      fellBackFrom: ["gemini-3.8-flash (answered by deepseek-flash-or): 0 chars"],
    }),
    humanizer: async () => ({ data: null, error: "skipped" }),
  });
  assert.equal(r.drafter, "groq-gpt-oss-120b");
  assert.ok(
    lines.some((l) => /fell back to groq-gpt-oss-120b after gemini-3\.8-flash/.test(l)),
    lines.join("\n"),
  );
});

test("the drafter reads the file the ruling names, and a 'need to read it first' stub never reaches the room (Lift round 23, board #7037)", async () => {
  // Lift's docket round-20261002-022054-b5ea: the ruling named site/student/player.js, the drafter was never shown it,
  // and its answer (an empty after, "I need to read ... first") went to the room as proposal-1.md and scored 1/10.
  const root = scratch("dredd-named-file-");
  mkdirSync(path.join(root, "site", "student"), { recursive: true });
  writeFileSync(path.join(root, "site", "student", "player.js"), "function renderStep(step) { return template(step); }\n");
  const outside = scratch("dredd-outside-");
  writeFileSync(path.join(outside, "secret.js"), "OUTSIDE_THE_ROOT\n");
  const minutes = {
    verdict: 6,
    fix_first: "In site/student/player.js, make each question step look different from the last.",
    plan: `1. Modify site/student/player.js. 2. Compare ../${path.basename(outside)}/secret.js.`,
  };
  const stub = {
    changes: [{ where: "site/student/player.js", after: "", why: "Need to examine the current player.js first" }],
    note: "I need to read the site/student/player.js file first to understand the current rendering logic.",
  };
  const asked = [];
  const askFn = async (spec) => {
    asked.push(spec);
    return { data: stub, status: "ok", model: spec.profile ? "strong-route" : "rank:nemotron-3-ultra:nvidia" };
  };
  let humanized = 0;
  const d = await draftChecked({
    round: 1,
    base: { ask: "kids say every step looks the same", minutes, model: "auto", root, askFn },
    callsLog: null,
    pageText: PAGE,
    inventory: null,
    log: () => {},
    humanizer: async () => {
      humanized += 1;
      return { data: null, error: "skipped" };
    },
  });

  // The material: the named file's text, the cap stated, and nothing from outside the repository root.
  assert.match(asked[0].prompt, /function renderStep\(step\) \{ return template\(step\); \}/);
  assert.match(asked[0].prompt, /each cut at [\d,]+ characters/);
  assert.doesNotMatch(asked[0].prompt, /OUTSIDE_THE_ROOT/);
  // The stub is asked once more on a stronger route, then the step fails with the reason; no proposal, no Humanizer.
  assert.deepEqual(
    asked.map((s) => s.profile ?? null),
    [null, "code"],
  );
  assert.equal(d.proposal, undefined);
  assert.equal(humanized, 0);
  assert.match(d.error, /^the drafter failed in round 1: .*drafted nothing, no after for "site\/student\/player\.js"/);
});
