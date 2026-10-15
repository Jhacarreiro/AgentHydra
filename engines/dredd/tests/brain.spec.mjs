/**
 * brain.spec - which model Dredd thinks with, and how the resident worker survives a stalled call. No model is
 * called: one test runs a fake worker (a node script) in place of ask.py.
 *
 * `node --test dredd/tests/brain.spec.mjs`. Every call goes through HSwarm. The old
 * DREDD_BRAIN=opus door (a sealed `claude -p` on Opus 5.5 under SUE's own login) is retired - the Chair,
 * 2026-09-23: "I never want you to use, like, the Claude code or the GPT code CLI. You can use API keys
 * I've given you or things like in the Z Swarm, but you're not allowed to use CLI logins."
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RETRY_CAP, askBrain, askBrainHedged, configureWorker, mapForModel, structuredAnswer } from "../lib/brain.mjs";

// A stand-in for ask.py: a prompt "stall" is never answered, "wait:<ms>" is answered after that long.
const FAKE_WORKER = `
const rl = require("node:readline").createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const spec = JSON.parse(line);
  if (spec.prompt === "stall") return;
  const ms = Number(String(spec.prompt).split(":")[1] || 10);
  setTimeout(() => process.stdout.write(JSON.stringify({ rid: spec.rid, status: "ok", answer: "fine", model: "fake", seconds: ms / 1000 }) + "\\n"), ms);
});
`;

test("a call that stalls past its timeout never fails another call waiting on the same worker", async () => {
  // 2026-09-28: one stalled call killed the shared worker, and the drafter's call on it failed "ask.py exit SIGTERM".
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-brain-"));
  const fake = path.join(dir, "fake-ask.cjs");
  writeFileSync(fake, FAKE_WORKER);
  configureWorker({ command: [process.execPath, fake], grace: 0 });
  try {
    const [stalled, waiting] = await Promise.all([
      askBrain({ prompt: "stall", timeoutS: 0.3 }),
      askBrain({ prompt: "wait:900", timeoutS: 5 }),
    ]);
    assert.match(stalled.error, /did not answer/);
    assert.equal(waiting.status, "ok", waiting.error);
    // The next call is answered too, by a fresh worker.
    assert.equal((await askBrain({ prompt: "wait:10", timeoutS: 5 })).status, "ok");
  } finally {
    configureWorker();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a local model's calls are asked one at a time, a paid model's together", async () => {
  let inFlight = 0;
  let peak = 0;
  const call = async (x) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return x * 2;
  };
  assert.deepEqual(await mapForModel("lmstudio-qwen3-30b-a3b", [1, 2, 3], call), [2, 4, 6]);
  assert.equal(peak, 1, "five ballots asked together on one GPU all overrun the seat timeout");
  peak = 0;
  assert.deepEqual(await mapForModel("claude-sonnet-5-5", [1, 2, 3], call), [2, 4, 6]);
  assert.equal(peak, 3);
});

test("a hedged call asks once more when the first is slow, takes the first answer, and waits out an early error", async () => {
  const later = (ms, res) => () => new Promise((r) => setTimeout(() => r(res), ms));
  const ok = (who) => ({ status: "ok", model: who });
  // Fast: one call, no hedge.
  let calls = 0;
  const fast = await askBrainHedged({}, null, { afterS: 0.05, ask: () => (calls++, later(5, ok("a"))()) });
  assert.equal(calls, 1);
  assert.equal(fast.hedged, undefined);
  // Stalled: the second call wins, and says it was a hedge.
  const plan = [later(400, ok("slow")), later(10, ok("hedge"))];
  let i = 0;
  const won = await askBrainHedged({}, null, { afterS: 0.03, ask: () => plan[i++]() });
  assert.equal(i, 2);
  assert.equal(won.model, "hedge");
  assert.equal(won.hedged, true);
  // The first errors after the hedge started: the other call's answer is taken.
  const mixed = [later(60, { status: "error", error: "cut off" }), later(80, ok("second"))];
  let j = 0;
  assert.equal((await askBrainHedged({}, null, { afterS: 0.02, ask: () => mixed[j++]() })).model, "second");
  // An early error with nothing else running is the answer, at once.
  const failed = await askBrainHedged({}, null, { afterS: 5, ask: later(5, { status: "error", error: "no structure" }) });
  assert.equal(failed.error, "no structure");
});

test("the one object in an answer's text: wrappers stripped, braces in the prose ignored, two answers refused", () => {
  const one = (text, schema) => structuredAnswer(text, schema).data;
  assert.deepEqual(one('Here it is: {"a": 1}. Hope that helps.'), { a: 1 });
  assert.deepEqual(one('```json\n{"a": 1}\n```'), { a: 1 });
  assert.deepEqual(one('\uFEFF<think>maybe {"a": 2}, maybe not</think>\n{"a": 1}'), { a: 1 });
  assert.deepEqual(one('Use {braces} sparingly; the answer is {"a": "it\'s {fine}"}'), { a: "it's {fine}" });
  assert.deepEqual(one('It\'s settled: {"a": 1}'), { a: 1 });
  assert.deepEqual(one('{"a": 1}\n\nAgain: {"a": 1}'), { a: 1 }, "copies of one answer are that answer");
  const two = structuredAnswer('{"score": 3} or perhaps {"score": 7}');
  assert.equal(two.data, null);
  assert.match(two.error, /2 different JSON answers/);
  const cut = structuredAnswer('{"changes": [{"where": "hero", "after": "Find things to do near y');
  assert.equal(cut.data, null);
  assert.equal(cut.cut, true);
  const shape = structuredAnswer('{"score": 6}', { required: ["score", "fix_first"] });
  assert.equal(shape.data, null);
  assert.match(shape.error, /missing fix_first/);
  assert.equal(structuredAnswer("I cannot score this page.").cut, false);
});

test("a structured answer cut off at the output cap is asked once more with twice the room, and only then", async () => {
  const schema = { type: "object", required: ["a"] };
  const replies = (...answers) => {
    const caps = [];
    return { caps, ask: async (tokens) => (caps.push(tokens), { status: "ok", model: "m", answer: answers[caps.length - 1] }) };
  };
  const cutThenWhole = replies('{"a": "long and', '{"a": 1}');
  const won = await askBrain({ schema, maxTokens: 4000 }, null, { ask: cutThenWhole.ask });
  assert.deepEqual(cutThenWhole.caps, [4000, 8000]);
  assert.deepEqual(won.data, { a: 1 });
  assert.equal(won.retried, "output cap 4000 -> 8000");
  // A refusal that is not a truncation is not retried.
  const twoAnswers = replies('{"a": 1} {"a": 2}');
  assert.equal((await askBrain({ schema, maxTokens: 4000 }, null, { ask: twoAnswers.ask })).status, "error");
  assert.deepEqual(twoAnswers.caps, [4000]);
  // At the ceiling already: the cut answer is the error, named as the cap.
  const atCap = replies('{"a": "long and');
  const capped = await askBrain({ schema, maxTokens: RETRY_CAP }, null, { ask: atCap.ask });
  assert.deepEqual(atCap.caps, [RETRY_CAP]);
  assert.match(capped.error, /cut off at the output cap/);
  // Cut twice: one retry, then the second cut is the answer.
  const cutTwice = replies('{"a": "x', '{"a": "xy');
  const lost = await askBrain({ schema, maxTokens: 6000 }, null, { ask: cutTwice.ask });
  assert.deepEqual(cutTwice.caps, [6000, 12000]);
  assert.equal(lost.status, "error");
  assert.equal(lost.retried, "output cap 6000 -> 12000");
  // An empty "ok" (a thinking leg spent the cap reasoning) is never a success: asked once more with the full room.
  const emptyThenSaid = replies("", "The page reads well.");
  const said = await askBrain({ maxTokens: 1200 }, null, { ask: emptyThenSaid.ask });
  assert.deepEqual(emptyThenSaid.caps, [1200, RETRY_CAP]);
  assert.equal(said.status, "ok");
  assert.equal(said.answer, "The page reads well.");
});

test("askBrain leaves effort to the published profile, forwards profile only with AUTO, keeps explicit pins", async () => {
  const specs = [];
  const send = (spec) => (specs.push(spec), { status: "ok", model: "m", answer: "a" });
  await askBrain({ prompt: "p" }, null, { send });
  assert.equal(specs[0].model, "auto");
  assert.equal(specs[0].profile, "routine");
  assert.ok(!("reasoning_effort" in specs[0]));
  await askBrain({ prompt: "p", reasoning: "high", profile: "prose" }, null, { send });
  assert.equal(specs[1].reasoning_effort, "high");
  assert.equal(specs[1].profile, "prose");
  await askBrain({ prompt: "p", model: "gemini-3.8-flash" }, null, { send });
  assert.equal(specs[2].model, "gemini-3.8-flash");
  assert.ok(!("profile" in specs[2]));
});
