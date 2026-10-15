import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PACE_DIALS,
  paceWaitMs,
  readingModeOf,
  screenOnly,
  screenReadMs,
  seededRandom,
  weighMs,
  capStays,
  MAX_STAY_MS,
  MIN_STAY_CAP_MS,
} from "../lib/reading-pace.mjs";

test("N words at W wpm wait N*60/W seconds", () => {
  assert.equal(screenReadMs(150, { wordsPerMinute: 200 }), 45_000);
  assert.equal(screenReadMs(100, { wordsPerMinute: 200 }), 30_000);
  assert.equal(screenReadMs(200, { wordsPerMinute: 400 }), 30_000);
});

test("a screen's wait is capped per screen and by attention left", () => {
  assert.equal(screenReadMs(10_000, { wordsPerMinute: 200 }), PACE_DIALS.screenCapMs);
  assert.equal(screenReadMs(100, { wordsPerMinute: 200, attentionMs: 12_000 }), 12_000);
  assert.equal(screenReadMs(100, { wordsPerMinute: 200, attentionMs: 0 }), 0);
});

test("a visit's total wait is capped; the last screens get what is left", () => {
  assert.equal(paceWaitMs(100, { mode: "paced", spentMs: 0, visitCapMs: 50_000 }), 30_000);
  assert.equal(paceWaitMs(100, { mode: "paced", spentMs: 40_000, visitCapMs: 50_000 }), 10_000);
  assert.equal(paceWaitMs(100, { mode: "paced", spentMs: 60_000, visitCapMs: 50_000 }), 0);
});

test("a screen with no new words costs no wait, so scrolling back to re-read is allowed", () => {
  assert.equal(paceWaitMs(0, { mode: "paced" }), 0);
});

test("the default reading mode waits nothing", () => {
  assert.equal(readingModeOf(undefined), null);
  assert.equal(readingModeOf(null), null);
  assert.equal(readingModeOf(""), null);
  assert.equal(paceWaitMs(500, { mode: null }), 0);
  assert.equal(readingModeOf("paced"), "paced");
  assert.throws(() => readingModeOf("fast"), /reading takes paced/);
});

test("screenOnly keeps only what is above the fold", () => {
  const inventory = {
    blocks: [
      { id: 1, aboveFold: true, text: "shown" },
      { id: 2, aboveFold: false, text: "below" },
    ],
    elements: [
      { id: "a", aboveFold: true },
      { id: "b", aboveFold: false },
    ],
    captcha: { present: false },
  };
  const screen = screenOnly(inventory);
  assert.deepEqual(
    screen.blocks.map((b) => b.id),
    [1],
  );
  assert.deepEqual(
    screen.elements.map((e) => e.id),
    ["a"],
  );
  assert.deepEqual(screen.captcha, { present: false });
  assert.equal(inventory.blocks.length, 2);
});

test("weighing a control: three Sues over the same words get three different times, none on the ceiling", () => {
  const times = ["sue-a", "sue-b", "sue-c"].map((id) => weighMs(40, { wordsPerMinute: 200, random: seededRandom(id) }));
  assert.equal(new Set(times).size, 3);
  for (const t of times) assert.ok(t >= 4_900 && t <= 11_200 && t !== 7_000, `${t}`);
  const short = weighMs(2, { wordsPerMinute: 200, random: seededRandom("sue-a") });
  assert.ok(short >= 1_050 && short <= 4_000, `${short}`);
});

test("Get Premium plus its deciding line: four Sues weigh it more than 300 ms apart, all above the floor", () => {
  // "Get Premium" and "You sign in with Discord first, then pick your server": about 12 words.
  const times = ["sue-75", "sue-56", "sue-120", "sue-118"].map((id) => weighMs(12, { wordsPerMinute: 200, random: seededRandom(id) }));
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i += 1) assert.ok(sorted[i] - sorted[i - 1] > 300, `${times}`);
  assert.ok(sorted[0] > 1_500 && sorted.at(-1) < 7_000, `${times}`);
});

test("a long stay is held to a seeded cap, eight capped stays spread, none above the top of the range", () => {
  const capped = [];
  for (const seed of ["sue-8937", "sue-8938"]) {
    const random = seededRandom(seed);
    for (let i = 0; i < 4; i += 1) capped.push(capStays([{ index: i, ms: 15_000 }], 15_000, { random }).stays[0].ms);
  }
  assert.ok(Math.max(...capped) - Math.min(...capped) > 1_500, `${capped}`);
  for (const v of capped) assert.ok(v >= MIN_STAY_CAP_MS && v <= MAX_STAY_MS, `${v}`);
  const { leftoverMs } = capStays([{ index: 0, ms: 15_000 }], 15_000, { random: () => 0 });
  assert.equal(leftoverMs, 15_000 - MIN_STAY_CAP_MS);
});

test("short stays are left as they are and leave nothing over", () => {
  const { stays, leftoverMs } = capStays([{ index: 0, ms: 2_400 }, { index: 1, ms: 2_000 }], 4_400, { random: () => 0.99 });
  assert.deepEqual(stays.map((s) => s.ms), [2_400, 2_000]);
  assert.equal(leftoverMs, 0);
});
