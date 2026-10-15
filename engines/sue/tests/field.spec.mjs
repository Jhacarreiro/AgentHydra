// A field run (lib/field.mjs): the scope Jev names reaches pre-sue, a caller's names are kept, ART follows SUE only on
// design trouble Jev reads in her claims, APE goes on the written rule, and every finished wave reaches the room in ONE
// docket, once, only when the room can sit. Jev, pre-sue, the waves and the room are injected; nothing here reaches the network or launches anyone.
import assert from "node:assert/strict";
import { test } from "node:test";

import { APE_GAP, apeDecision, artDecision, planField, runField, SCOPE_SAYS, waitForRoom } from "../lib/field.mjs";

const ERRAND = {
  url: "https://clinic.example.test/book",
  intent: "You need to book a follow-up appointment for your knee and see what the doctor wrote after the last visit.",
  expect: "A clinic's patient portal.",
};

/** A Jev that names the scope, answers the repeat-use question, and reads `design:<id>` from `design`. */
function fakeJev({ scope = "medical", repeat = 0.2, design = {} } = {}, calls = []) {
  return async (items) => {
    calls.push(items);
    const answers = {};
    for (const i of items) {
      if (i.id === "scope") answers.scope = { answer: scope, confidence: 0.81, probabilities: { [scope]: 0.81 } };
      else if (i.id === "repeat-use") answers[i.id] = { probabilities: { yes: repeat } };
      else if (i.id.startsWith("design:")) answers[i.id] = { probabilities: { yes: design[i.id.slice(7)] ?? 0.1 } };
    }
    return { answers, unanswered: [] };
  };
}

/** Pre-sue's door: records each spec it was asked with and sends `send` (power users when ape). */
function fakePresue(asked = []) {
  return async (spec) => {
    asked.push(spec);
    const send = spec.ape ? ["power-pat", "power-quinn"] : ["patient-ana", "carer-ben", "nurse-cho", "extra-dee"];
    return { ok: true, send, said: `pre-sue sent ${send.join(", ")}`, judge: "jev", fit: [], closest: [], onboarded: [] };
  };
}

const claims = (texts) => texts.map((text, i) => ({ id: `C${i + 1}`, text }));

test("the scope Jev names goes into pre-sue, whose picks are SUE's visitors; a caller's named visitors skip pre-sue", async () => {
  const asked = [];
  const record = await planField(ERRAND, { jev: fakeJev(), presue: fakePresue(asked), history: () => [] });
  assert.equal(record.scope.answer, "medical");
  assert.equal(asked[0].scope, SCOPE_SAYS.medical, "pre-sue fits the visitors to the scope");
  assert.deepEqual(record.sue.visitors, ["patient-ana", "carer-ben", "nurse-cho"], "pre-sue's strongest three go");
  assert.equal(record.sue.by, "presue");

  const named = await planField({ ...ERRAND, personas: "grandma, bob" }, { jev: fakeJev(), presue: fakePresue([]), history: () => [] });
  assert.deepEqual(named.sue.visitors, ["grandma", "bob"]);
  assert.equal(named.sue.by, "caller");
});

test("no Jev: the scope is recorded as unread, never guessed, and pre-sue still picks", async () => {
  const asked = [];
  const record = await planField(ERRAND, {
    jev: async () => ({ answers: null, reason: "no key" }),
    presue: fakePresue(asked),
    history: () => [],
  });
  assert.equal(record.scope.answer, null);
  assert.match(record.scope.note, /no key/);
  assert.equal(asked[0].scope, null);
  assert.equal(record.repeatUse.answer, false, "an unread repeat use counts as a product used once (the longer APE gap)");
});

test("ART goes when Jev reads at least one of SUE's claims as design trouble, and stays home when none is", () => {
  const filed = claims(["The Book button is grey and looks disabled", "Booking failed with an error after I picked a date"]);
  const yes = artDecision({
    claims: filed,
    answers: { "design:C1": { probabilities: { yes: 0.83 } }, "design:C2": { probabilities: { yes: 0.1 } } },
  });
  assert.equal(yes.goes, true);
  assert.deepEqual(
    yes.design.map((d) => d.id),
    ["C1"],
  );
  const no = artDecision({
    claims: filed,
    answers: { "design:C1": { probabilities: { yes: 0.3 } }, "design:C2": { probabilities: { yes: 0.1 } } },
  });
  assert.equal(no.goes, false);
  assert.match(no.why, /0 of SUE's 2 claims/);
  assert.equal(artDecision({ claims: [] }).goes, false, "no claims, no design trouble");
});

test("ART with no Jev: the claims' own words decide, and the record says so", () => {
  const read = artDecision({
    claims: claims(["The text is too small to read on my phone", "It logged me out"]),
    answers: null,
    reason: "timed out",
  });
  assert.equal(read.goes, true);
  assert.equal(read.by, "floor");
  assert.match(read.why, /no Jev \(timed out\)/);
  assert.equal(artDecision({ claims: claims(["It logged me out"]), answers: null }).goes, false);
});

test("APE: the caller's word wins; otherwise a repeat-use product gets APE every other field run, anything else every fourth", () => {
  assert.equal(apeDecision({ caller: true, repeat: { answer: false }, history: [] }).goes, true);
  assert.equal(apeDecision({ caller: false, repeat: { answer: true }, history: [{ ape: false }] }).goes, false);
  const rows = (...apes) => apes.map((ape) => ({ ape }));
  const repeat = { answer: true, by: "jev", p: 0.8 };
  const once = { answer: false, by: "jev", p: 0.2 };
  // The nth field run of a site, given what APE did on the runs before it.
  assert.equal(apeDecision({ repeat, history: [] }).goes, false, "a site's first field run is SUE's");
  assert.equal(apeDecision({ repeat, history: rows(false) }).goes, true);
  assert.equal(apeDecision({ repeat, history: rows(false, true) }).goes, false);
  assert.equal(apeDecision({ repeat: once, history: rows(false, false) }).goes, false);
  assert.equal(apeDecision({ repeat: once, history: rows(false, false, false) }).goes, true);
  assert.equal(apeDecision({ repeat: once, history: rows(false, false, false, true, false) }).goes, false);
  const said = apeDecision({ repeat: once, history: rows(false) });
  assert.equal(said.gap, APE_GAP.other);
  assert.match(said.why, /1 field run on this site/);
});

test("a dry run with an earlier SUE run decides ART over that run's claims, and launches nobody", async () => {
  const record = await planField(
    { ...ERRAND, dryRun: true, sueRun: "20261010-010101-abcd" },
    {
      jev: fakeJev({ design: { C2: 0.9 } }),
      presue: fakePresue([]),
      history: () => [],
      claimsOf: async (runId) => (runId === "20261010-010101-abcd" ? claims(["Slow to load", "The menu overlaps the logo"]) : []),
    },
  );
  assert.equal(record.art.goes, true);
  assert.equal(record.art.fromRun, "20261010-010101-abcd");
  await assert.rejects(planField({ ...ERRAND, sueRun: "20261010-010101-abcd" }, { presue: fakePresue([]) }), /DRY run/);
});

/** The doors runField drives, recording every wave started and every hand to the room. */
function fakeRun({ endings = {}, design = {} } = {}) {
  const started = [];
  const handed = [];
  const ledger = [];
  let n = 0;
  return {
    started,
    handed,
    ledger,
    doors: {
      startWave: async (args) => {
        const kind = args.art ? "art" : args.ape ? "ape" : "sue";
        started.push({ kind, args });
        return { runId: `run-${kind}-${(n += 1)}` };
      },
      waitWave: async (runId) => ({ state: endings[runId.split("-")[1]] ?? "finished" }),
      claimsOf: async () => claims(["The Save button is the same colour as the background", "The total is wrong"]),
      jev: fakeJev({ design }),
      hand: async ({ runs, ask }) => (handed.push({ runs, ask }), { docket: "D:/tmp/dredd/docket-1" }),
      save: async () => {},
      appendLedger: async (row) => ledger.push(row),
    },
  };
}

test("SUE goes first; ART follows on design trouble and APE on the rule; every finished wave reaches the room in ONE docket", async () => {
  const record = await planField(
    { ...ERRAND, ape: true, createAccounts: false, contactSupport: false, owned: true },
    { id: "field-1", jev: fakeJev(), presue: fakePresue([]), history: () => [] },
  );
  const run = fakeRun({ design: { C1: 0.9 } });
  await runField(record, run.doors);
  assert.equal(run.started[0].kind, "sue", "SUE goes first");
  assert.deepEqual(run.started.map((s) => s.kind).sort(), ["ape", "art", "sue"]);
  assert.ok(
    run.started.every((s) => s.args.hearing === false && s.args.presue === false),
    "no wave hands itself to the room or pre-sues again",
  );
  assert.ok(
    run.started.every((s) => s.args.createAccounts === false),
    "the caller's word on accounts reaches every wave",
  );
  assert.ok(
    run.started.every((s) => s.args.contactSupport === false && s.args.owned === true),
    "the caller's word on support and on whose site it is reaches every wave",
  );
  assert.deepEqual(run.started.find((s) => s.kind === "ape").args.personas, ["power-pat", "power-quinn"]);
  assert.equal(run.handed.length, 1, "one hand to the room for the whole field");
  assert.deepEqual(run.handed[0].runs.map((r) => r.kind).sort(), ["ape", "art", "sue"]);
  assert.equal(record.docket.dir, "D:/tmp/dredd/docket-1");
  assert.deepEqual(run.ledger, [
    { fieldId: "field-1", host: "clinic.example.test", at: record.at, ape: true, art: true, scope: "medical" },
  ]);
});

test("no design trouble and APE home: SUE alone goes to the room; a SUE wave that failed sends nobody after her", async () => {
  const quiet = await planField(ERRAND, { id: "field-2", jev: fakeJev(), presue: fakePresue([]), history: () => [] });
  const run = fakeRun({ design: {} });
  await runField(quiet, run.doors);
  assert.deepEqual(
    run.started.map((s) => s.kind),
    ["sue"],
  );
  assert.deepEqual(
    run.handed[0].runs.map((r) => r.kind),
    ["sue"],
  );
  assert.match(quiet.ape.why, /stays home/);

  const failed = await planField({ ...ERRAND, ape: false }, { id: "field-3", jev: fakeJev(), presue: fakePresue([]), history: () => [] });
  const broken = fakeRun({ endings: { sue: "refused" }, design: { C1: 0.9 } });
  await runField(failed, broken.doors);
  assert.equal(failed.art.goes, false);
  assert.match(failed.art.why, /ended refused/);
  assert.equal(broken.handed.length, 0, "nothing finished, so nothing goes to the room");
  assert.match(failed.docket.error, /no wave finished/);
  assert.equal(broken.ledger.length, 0);
});

test("resumed: a wave that already ended is not run again, a decided ART is not re-asked, a handed docket is not handed twice", async () => {
  const record = await planField(ERRAND, { id: "field-4", jev: fakeJev(), presue: fakePresue([]), history: () => [] });
  const first = fakeRun({ design: { C1: 0.9 } });
  await runField(record, first.doors);
  const again = fakeRun({ design: {} });
  await runField(record, again.doors);
  assert.equal(again.started.length, 0);
  assert.equal(again.handed.length, 0);
  assert.equal(record.art.goes, true, "ART's decision stands as first made");
  assert.equal(again.ledger.length, 0, "a field run is on the ledger once");
});

test("a room that refuses holds the hand until a meeting opens, and the wait is recorded; one that never opens keeps the waves", async () => {
  const record = await planField(ERRAND, { id: "field-5", jev: fakeJev(), presue: fakePresue([]), history: () => [] });
  const run = fakeRun();
  const answers = [
    { refused: true, why: "The five-hour allowance is used up." },
    { refused: true, why: "The five-hour allowance is used up." },
    { open: true },
  ];
  const slept = [];
  await runField(record, { ...run.doors, probeRoom: async () => answers.shift(), sleep: async (ms) => slept.push(ms) });
  assert.equal(run.handed.length, 1, "handed once the meeting opened");
  assert.equal(record.room.open, true);
  assert.equal(record.room.probes, 3);
  assert.equal(slept.length, 2);
  assert.match(record.room.firstRefusal, /allowance/);

  let clock = 0;
  const closed = await waitForRoom({
    probe: async () => ({ refused: true, why: "credit refused" }),
    sleep: async (ms) => (clock += ms),
    now: () => clock,
    everyMs: 10,
    maxMs: 30,
  });
  assert.equal(closed.open, false);
  assert.equal(closed.refusal, "credit refused");
  const other = await waitForRoom({ probe: async () => ({ error: "MCP did not start" }) });
  assert.equal(other.open, true, "a probe that fails for another reason never holds the waves back");
  assert.equal(other.probeError, "MCP did not start");
});
