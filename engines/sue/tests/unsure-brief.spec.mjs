import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatBrief, buildSealedSystem } from "../lib/body-relay.mjs";
import { planBatch } from "../lib/move-batch.mjs";

const brief = (reading) =>
  buildChatBrief({
    systemPrompt: "You are Dana.",
    scenarioPrompt: "Find the ticket settings.",
    runId: "20261011-1",
    sueId: "sue-1-dana",
    handFile: "C:\\x\\sue\\hand.mjs",
    reading,
  });

test("a paced brief says lingered is required once per screen, none only for a blank page, unsure answered each screen, and never to invent", () => {
  const text = brief("paced");
  assert.match(text, /once per screen, her next move of any kind/);
  assert.match(text, /`lingered`: the words or numbers on that screen she read most carefully/);
  assert.match(text, /"none" only for a blank or loading page/);
  assert.match(text, /could not judge for her own situation.*explained before she decides.*she says it as `unsure` quoting exactly that.*`unsure: "none"`.*else it is refused/);
  assert.match(text, /refused and not made/);
  assert.match(text, /Never invent it/);
  const sealed = buildSealedSystem({ systemPrompt: "You are Dana.", scenarioPrompt: "x", reading: "paced" });
  assert.match(sealed, /once per screen/);
});

test("an unpaced brief does not teach the unsure note", () => {
  assert.doesNotMatch(brief(null), /unsure/);
  assert.doesNotMatch(buildSealedSystem({ systemPrompt: "x", scenarioPrompt: "y" }), /unsure/);
});

test("a note of kind unsure in a do is passed through to the body with its phrase", () => {
  const plan = planBatch({
    moves: [
      { move: "note", kind: "unsure", text: "Shared by the whole server" },
      { move: "click", target: 3 },
    ],
  });
  assert.deepEqual(plan.moves[0], { tool: "note", args: { kind: "unsure", text: "Shared by the whole server" } });
  assert.equal(plan.moves[1].tool, "click");
});
