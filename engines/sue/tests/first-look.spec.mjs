// The first-look probe (built from a review of MiroFish, 2026-09-23): one line, asked once, the moment
// her first look lands - what she thinks this place is and what it sells - scored the way the exit
// interview is, so "she never understood it" can be told from "she worked it out 20 clicks later".
//
//   node --test sue/tests/first-look.spec.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { FIRST_LOOK_PROBE_ID, INTERVIEW_KEYS, probeForLook } from "../lib/findings.mjs";
import { buildFirstLook } from "../report.mjs";

test("the first-look probe fires once, on her first look, and never on a game unless the scenario asks", () => {
  const first = probeForLook({ url: "https://x.example/", looks: 1 });
  assert.equal(first.id, FIRST_LOOK_PROBE_ID);
  assert.match(first.text, /what do you think this place is/);
  assert.equal(probeForLook({ url: "https://x.example/", looks: 2 }), null, "only the first look");
  assert.equal(probeForLook({ url: "https://x.example/", looks: 1, fired: [FIRST_LOOK_PROBE_ID] }), null, "never twice");
  assert.equal(probeForLook({ url: "https://x.example/", looks: 1, canvas: true }), null, "a game has nothing to sell");
  const scenario = { probes: [{ id: "price", whenUrl: "/Pricing", ask: "What do you think this costs you?" }] };
  assert.equal(
    probeForLook({ url: "https://x.example/", looks: 1, canvas: true, scenario }).id,
    FIRST_LOOK_PROBE_ID,
    "a scenario's own probes opt a game back in",
  );
  assert.deepEqual(probeForLook({ url: "https://x.example/pricing", looks: 4, scenario }), {
    id: "price",
    text: "What do you think this costs you?",
  });
  assert.equal(probeForLook({ url: "https://x.example/pricing", looks: 5, scenario, fired: new Set(["price"]) }), null);
  assert.ok(!INTERVIEW_KEYS.includes(FIRST_LOOK_PROBE_ID), "a probe is not an exit-interview key");
});

test("first look is scored from the tagged line; a Sue who never answered is missing, never 'no idea'", () => {
  const groundTruth = { oneLiner: "an events platform", mustGet: ["events"], shouldGet: ["near you", "host"], wrongIf: ["dating app"] };
  const sues = [
    {
      sueId: "sue-1-grandma",
      findings: [{ probe: FIRST_LOOK_PROBE_ID, text: "A place to find events happening near you, or host your own." }],
    },
    { sueId: "sue-2-tiktok", findings: [{ probe: FIRST_LOOK_PROBE_ID, text: "Honestly looks like a dating app." }] },
    { sueId: "sue-3-karen", findings: [{ kind: "note", text: "where is the phone number" }] },
  ];
  const fl = buildFirstLook(sues, groundTruth);
  assert.equal(fl.answered, 2);
  assert.equal(fl.gotIt, 1);
  assert.equal(fl.gotItShare, 0.5);
  assert.equal(fl.perSue[0].bucket, "got-it");
  assert.notEqual(fl.perSue[1].bucket, "got-it");
  assert.equal(fl.perSue[2].bucket, null);
  assert.equal(fl.perSue[2].said, null);
  assert.equal(buildFirstLook([], groundTruth).gotItShare, null, "no answers is no share, never 0%");
});
