import { test } from "node:test";
import assert from "node:assert/strict";
import { restOnThought, thinkRestMs } from "../lib/rest-on-text.mjs";

const CAP = "10 tickets a minute, shared across all panels.";
const DIRECT_MESSAGES = "Direct Messages: send private notes to members from the mod team, premium only.";

const candidates = [
  { i: 0, text: CAP, link: false, above: false },
  { i: 1, text: DIRECT_MESSAGES, link: false, above: false },
];

function fakePage(list) {
  const page = { pointed: [], located: [], waits: [], moves: 0 };
  page.evaluate = async (fn, arg) => {
    if (fn.name === "collectCandidates") return list;
    if (fn.name === "pointAt") {
      page.pointed.push(arg[1]);
      return { x: 100, y: 100 };
    }
    if (fn.name === "locatePhrase") {
      const i = list.findIndex((c) => c.text.toLowerCase().includes(String(arg[0]).toLowerCase()));
      if (i < 0) return null;
      page.located.push(i);
      return { x: 100, y: 100 + i, top: 0 };
    }
    if (fn.name === "LEAVE_SPOT") return { x: 5, y: 5 };
    return null;
  };
  page.mouse = { move: async () => (page.moves += 1) };
  page.waitForTimeout = async (ms) => page.waits.push(ms);
  return page;
}

const MAYA =
  "Free: unlimited panels, transcripts, but 10 tickets a minute shared. For a few thousand members that's probably fine. " +
  "Premium $66/yr per server: auto transcripts, DMs, automation. Worth a trial maybe. " +
  "Odd: 'Direct Messages' is premium-only and my mods drown in DMs - unclear what that is.";

test("a thought that quotes on-page text rests on the block holding the quoted words, not the keyword line", async () => {
  const page = fakePage(candidates);
  const spent = await restOnThought(page, MAYA, { wordsPerMinute: 200 });
  assert.deepEqual(page.pointed, [1]);
  assert.ok(spent > 0);
});

test("a thought that mentions a block without quotes rests on that block", async () => {
  const page = fakePage(candidates);
  const spent = await restOnThought(page, "10 tickets a minute, shared across all panels, probably fine for a few thousand members.", {
    wordsPerMinute: 200,
  });
  assert.deepEqual(page.pointed, [0]);
  assert.ok(spent > 0);
});

test("a thought that names only a three-word block rests on no text", async () => {
  const page = fakePage([{ i: 0, text: "10 tickets minute", link: false, above: false }]);
  const spent = await restOnThought(page, "10 tickets a minute, probably fine for a few thousand members.", { wordsPerMinute: 200 });
  assert.deepEqual(page.pointed, []);
  assert.equal(spent, page.waits[0]);
});

test("a thought that mentions a heading without quoting it does not rest on the heading", async () => {
  const page = fakePage([{ i: 0, text: "Example App", link: false, above: false }]);
  const spent = await restOnThought(
    page,
    "Example App: Discord ticket bot. Free, Premium from $7.99/mo per server with 7-day trial. Going to pricing.",
    { wordsPerMinute: 200 },
  );
  assert.deepEqual(page.pointed, []);
  assert.equal(spent, page.waits[0]);
  assert.ok(spent > 0);
});

const ALEX =
  "Clear table. Free is plenty for a few thousand members unless 10 tickets/min is hit, which is unlikely. " +
  "Premium worth it for auto transcripts, DMs and auto-close...";
const ALEX_BLOCKS = [
  { i: 0, text: "10 Tickets a minute Shared by the whole server", link: false, above: false },
  { i: 1, text: "Automatic Transcripts Premium only", link: false, above: false },
  { i: 2, text: "Faster Premium Only Bot Premium only", link: false, above: false },
  { i: 3, text: "Full Customization Messages up to 250 characters", link: false, above: false },
];

test("an unquoted thought that names part of a block parks off it: the matcher needs most of the block's words", async () => {
  const page = fakePage(ALEX_BLOCKS);
  const spent = await restOnThought(page, ALEX, { wordsPerMinute: 200 });
  assert.deepEqual(page.pointed, []);
  assert.equal(spent, page.waits[0]);
});

test("an unquoted thought never rests on a text block of three words or fewer", async () => {
  const page = fakePage([
    { i: 0, text: "Example App", link: false, above: false },
    { i: 1, text: "Direct messages", link: false, above: false },
  ]);
  const spent = await restOnThought(page, "Example App: Discord ticket bot. Direct messages are premium only.", { wordsPerMinute: 200 });
  assert.deepEqual(page.pointed, []);
  assert.equal(spent, page.waits[0]);
});

test("a thought quoting words that are not on the page rests on no text", async () => {
  const page = fakePage(candidates);
  const spent = await restOnThought(page, "Odd: 'Premium Plus at $99 a year' is not on this page, is it?", { wordsPerMinute: 200 });
  assert.deepEqual(page.pointed, []);
  assert.equal(spent, page.waits[0]);
});

const ALEX_THOUGHT =
  "Clear pricing. Free is probably enough for a few thousand members; 10 tickets a minute shared is plenty. " +
  "Premium adds auto transcripts, DMs, automation. Nice-to-have, $7.99 is fine. 7-day trial, no card. Good enough, I'd invite free first.";

test("a note naming an unsure phrase rests on that phrase's block for the thought's time, never on the block it mentions", async () => {
  const page = fakePage([
    ...ALEX_BLOCKS,
    { i: 4, text: "Premium from $7.99 per server with a 7-day trial, no card needed", link: false, above: false },
  ]);
  const spent = await restOnThought(page, ALEX_THOUGHT, { wordsPerMinute: 200, unsure: "10 Tickets a minute" });
  assert.deepEqual(page.located, [0]);
  assert.deepEqual(page.pointed, []);
  assert.ok(spent >= Math.min(thinkRestMs(ALEX_THOUGHT, { wordsPerMinute: 200 }), 20_000));
});
