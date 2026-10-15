import { test } from "node:test";
import assert from "node:assert/strict";
import { restOnThought, restedBlockOf } from "../lib/rest-on-text.mjs";

const HERO = "Free on every server. Premium from $7.99 a month per server, with a 7-day free trial.";
const CHANNEL = "Private channel per member for every ticket they open.";

const candidates = [
  { i: 0, text: HERO, link: false, above: false },
  { i: 1, text: CHANNEL, link: false, above: false },
];

function fakePage(list) {
  const page = { pointed: [], waits: [], moves: 0 };
  page.evaluate = async (fn, arg) => {
    if (fn.name === "collectCandidates") return list;
    if (fn.name === "pointAt") {
      page.pointed.push(arg[1]);
      return { x: 100, y: 100 };
    }
    if (fn.name === "LEAVE_SPOT") return { x: 5, y: 5 };
    return null;
  };
  page.mouse = { move: async () => (page.moves += 1) };
  page.waitForTimeout = async (ms) => page.waits.push(ms);
  return page;
}

const THOUGHT_ON_HERO = 'Free on every server, "Premium from $7.99 a month per server" with a free trial. Let\'s see pricing.';
const THOUGHT_ON_CHANNEL = '"Private channel per member for every ticket", does that hold on a free server?';

test("a thought that names a block she already rested on in this look gets no second rest there", async () => {
  const page = fakePage(candidates);
  const spent = await restOnThought(page, THOUGHT_ON_HERO, { wordsPerMinute: 200, rests: [{ text: HERO, ms: 4682 }] });
  assert.deepEqual(page.pointed, []);
  assert.equal(page.waits.length, 1);
  assert.equal(spent, page.waits[0]);
});

test("a thought that quotes a block she has not rested on yet still rests there", async () => {
  const page = fakePage(candidates);
  const spent = await restOnThought(page, THOUGHT_ON_CHANNEL, { wordsPerMinute: 200, rests: [{ text: HERO, ms: 4682 }] });
  assert.deepEqual(page.pointed, [1]);
  assert.ok(spent > 0);
});

test("the block match is the same words, or one holds the other", () => {
  assert.equal(restedBlockOf(HERO, [{ text: HERO, ms: 2000 }]), true);
  assert.equal(restedBlockOf("Free on every server", [{ text: HERO, ms: 2000 }]), true);
  assert.equal(restedBlockOf(CHANNEL, [{ text: HERO, ms: 2000 }]), false);
  assert.equal(restedBlockOf(HERO, []), false);
});
