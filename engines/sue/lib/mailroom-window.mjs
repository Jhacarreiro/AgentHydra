/**
 * mailroom-window - the delivery window one mailroom poll reads.
 * ====================================================================
 *
 * WHAT: `createHighWaterMark({ overlapMs })` remembers the newest `event_timestamp` a mailroom poll has
 * seen and answers `since()` - that mark minus `overlapMs`, or `null` until the first poll has seen an
 * event (the caller then falls back to the run's own start).
 *
 * WHY IT EXISTS: the mailroom re-reads `<run>/manifest.json` every `POLL_MS` so a `--forever` cannon's
 * later Sues are picked up, but it queried RDS for every `delivery` event since the run began on every
 * poll, `existsSync`-checking each one it had already delivered. Under `--forever` that set grows all
 * day, so later polls re-read and re-skip the whole run's mail (2026-09-22 review,
 * `sue-report-mailroom-full-rescan`). Keeping a high-water mark and subtracting a small overlap fixes
 * it while still catching a delivery whose event timestamp lands a beat after a poll already ran.
 * Deliberately pure and dependency-free, so the window is one source of truth and unit-testable with
 * no AWS in reach.
 *
 * WHO DEPENDS ON IT: `mailroom.mjs` only.
 */

/** True for a usable timestamp: a real `Date`, not the `Invalid Date` a bad parse produces. */
function isUsable(date) {
  return date instanceof Date && !Number.isNaN(date.getTime());
}

export function createHighWaterMark({ overlapMs }) {
  let highWater = null;
  return {
    /** Lower bound (`event_timestamp >`) for the next query: `null` before any event has been seen. */
    since() {
      return highWater === null ? null : new Date(highWater.getTime() - overlapMs);
    },
    /** Advance the mark to `newest` when it is later than everything seen so far; older calls no-op. */
    observe(newest) {
      if (!isUsable(newest)) return;
      if (highWater === null || newest.getTime() > highWater.getTime()) highWater = newest;
    },
  };
}
