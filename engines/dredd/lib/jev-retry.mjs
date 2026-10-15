// dredd/lib/jev-retry.mjs - the eval's retry for Jev calls that timed out under load (2026-10-09).
//
// A Jev bridge that hits its 60 s wall answers ETIMEDOUT, and on a loaded machine many did at the eval's default
// concurrency (32), so the run graded the keyword fallback as if it were Jev. This pass asks again only the items that
// timed out, at a low concurrency, for a bounded number of rounds. An item that still has no answer after the retries
// is returned with its reason and is NOT graded: the caller reports it, and never grades the fallback in its place.
import { mapWithConcurrency } from "../../lib/shared/map-with-concurrency.ts";

const TIMED_OUT = /ETIMEDOUT|timed out/i;

/** True when a Jev call answered nothing because its wall ran out (askJev's { answers: null, reason } shape). */
export function timedOut(res) {
  return !res?.answers && TIMED_OUT.test(String(res?.reason || ""));
}

/**
 * Ask every item once at `concurrency`; re-ask the ones that timed out, `retryConcurrency` at a time, up to `retries`
 * rounds. `ask(item, index)` is one Jev call. `mapWith` is the pool (the same bounded map the eval uses; a spec can stub it).
 *
 * Returns { results, retried, failed, failedIndexes }: results[i] is the item's last answer (its `answers` is null when it
 * still failed), `retried` counts the items that were asked again at least once, `failed` the items still unanswered.
 */
export async function askWithRetry(items, ask, { concurrency, retryConcurrency = 4, retries = 2, mapWith = mapWithConcurrency } = {}) {
  const results = await mapWith(
    items.map((_, i) => i),
    concurrency,
    (i) => ask(items[i], i),
  );
  const again = new Set();
  for (let round = 0; round < retries; round += 1) {
    const due = results.map((r, i) => (timedOut(r) ? i : -1)).filter((i) => i >= 0);
    if (!due.length) break;
    for (const i of due) again.add(i);
    const answers = await mapWith(due, retryConcurrency, (i) => ask(items[i], i));
    due.forEach((i, k) => {
      results[i] = answers[k];
    });
  }
  const failedIndexes = results.map((r, i) => (r?.answers ? -1 : i)).filter((i) => i >= 0);
  return { results, retried: again.size, failed: failedIndexes.length, failedIndexes };
}
