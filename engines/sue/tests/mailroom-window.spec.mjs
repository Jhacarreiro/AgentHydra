/**
 * mailroom-window.spec - the delivery window a mailroom poll asks RDS for.
 * ==========================================================================
 * WHAT: `node --test sue/tests/mailroom-window.spec.mjs`. `createHighWaterMark` starts at `null`
 * (so `pollOnce` falls back to the run's start) and then returns the newest event timestamp it has seen
 * minus a small overlap, so a `--forever` run stops re-reading every delivery since the run began.
 * WHY IT EXISTS: the old mailroom passed `manifest.started - 2min` as `since` on EVERY poll, so each
 * poll re-queried and re-skipped the whole run's mail (review finding `sue-report-mailroom-full-rescan`).
 * Nothing spawns and no AWS is reached here.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHighWaterMark } from "../lib/mailroom-window.mjs";

const MINUTE = 60 * 1000;

test("with nothing seen yet the mark answers null, so the caller uses the run's start", () => {
  const mark = createHighWaterMark({ overlapMs: MINUTE });
  assert.equal(mark.since(), null);
});

test("since is the newest event minus the overlap, so the run's mail is not re-read", () => {
  const mark = createHighWaterMark({ overlapMs: MINUTE });
  mark.observe(new Date("2026-09-22T12:00:00.000Z"));
  assert.equal(mark.since().toISOString(), "2026-09-22T11:59:00.000Z");
});

test("the mark only moves forward: an older event never rewinds it", () => {
  const mark = createHighWaterMark({ overlapMs: MINUTE });
  mark.observe(new Date("2026-09-22T12:00:00.000Z"));
  mark.observe(new Date("2026-09-22T11:00:00.000Z"));
  assert.equal(mark.since().toISOString(), "2026-09-22T11:59:00.000Z");
  mark.observe(new Date("2026-09-22T12:05:00.000Z"));
  assert.equal(mark.since().toISOString(), "2026-09-22T12:04:00.000Z");
});

test("an unusable timestamp is ignored rather than poisoning the mark", () => {
  const mark = createHighWaterMark({ overlapMs: MINUTE });
  mark.observe(new Date("2026-09-22T12:00:00.000Z"));
  mark.observe(new Date("nonsense"));
  mark.observe(null);
  mark.observe(undefined);
  assert.equal(mark.since().toISOString(), "2026-09-22T11:59:00.000Z");
});

test("a returned since is a fresh Date, so a caller cannot mutate the mark through it", () => {
  const mark = createHighWaterMark({ overlapMs: MINUTE });
  mark.observe(new Date("2026-09-22T12:00:00.000Z"));
  const first = mark.since();
  first.setUTCFullYear(1999);
  assert.equal(mark.since().toISOString(), "2026-09-22T11:59:00.000Z");
});
