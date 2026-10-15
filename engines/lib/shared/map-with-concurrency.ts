// vendored from Connections infra/shared/async/map-with-concurrency.ts @ dd3d47a7ad
/**
 * The fleet's ONE bounded-concurrency worker pool.
 *
 * ⛔ THIS FILE IS THE HOME, AND IT CANNOT MOVE TO `packages/connections-core`. It was moved there
 * on 2026-08-06 on the premise that "the web tier cannot import `@infra-shared`" - that premise is
 * false (every plane web tsconfig is REQUIRED to declare the `@infra-shared/*` +
 * `@lunawerx/infra-shared/*` paths by the `plane-web-tsconfig-paths` check, `services/main/web`'s
 * vite.config aliases both, and `services/ledger/web/src/views/BooksView.vue` already imports this
 * exact module in a Vue SFC) - and the move BROKE every plain-`node` consumer for two days:
 * `scripts/aws/ops/fleet-idle-gaps.mjs`, `scripts/aws/ops/aurora-idle-vs-work.mjs`,
 * `scripts/audit/audit-deps-all.mjs`, `scripts/audit/audit-licenses-all.mjs`, everything behind
 * `scripts/aws/lib/fleet-org-cli.mjs`, and the arkitect corpus's `.arkitect/lib/portable-concurrency.mjs`
 * all died at import with ERR_MODULE_NOT_FOUND.
 *
 * The mechanism, so nobody re-litigates it: `node_modules/@lunawerx/core` symlinks to
 * `packages/connections-core`, whose sources sit under `src/`, and that package deliberately declares
 * NO `exports` map (`workspace-package-exports-map` GATES an `exports` map on any package the root
 * tsconfig resolves via `paths`). So Node resolves `@lunawerx/core/async/map-with-concurrency` to
 * `packages/connections-core/async/…` - a path that does not exist, with or without a file extension.
 * NO bare import into `@lunawerx/core` can ever resolve under plain Node. `@lunawerx/infra-shared`
 * does resolve, because this package's files sit at its package root - which is exactly why
 * `services/main/web/vite.config.ts` already imports `@lunawerx/infra-shared/text/escape` directly
 * and says so in a comment. This module is reachable from ALL FOUR runtimes (plain Node, Bun, Vite,
 * tsc); the core path is reachable from three. That is the whole argument.
 *
 * Before the original module existed the exact same fixed-size pool had been hand-rolled FIVE
 * separate times (the Bedrock embedding worker, arkitect-core's import graph, and three live
 * arkitect probes - one of which literally carries the comment "mirrors plane-health-live's
 * helper"). That is textbook single-source debt: five copies drift, and none of them can be fixed
 * once. Reuse-first says promote on the 2nd occurrence, so this is the promoted home - import it,
 * never re-derive it (`no-rederived-concurrency-pool` gates that structurally).
 *
 * Why a pool at all, rather than `Promise.all(items.map(fn))`: an UNBOUNDED fan-out is how you
 * discover a provider's rate-limit ceiling, exhaust a connection pool, or blow a Lambda's socket
 * budget. Every caller picks a cap that matches the thing it is calling.
 *
 * Two semantics, deliberately named apart - pick the one that matches how a single item's failure
 * should affect its siblings:
 *
 *   mapWithConcurrency - ALL-OR-NOTHING. The first rejection rejects the whole call (exactly
 *                               `Promise.all`'s contract, just bounded). Use when the caller needs
 *                               every result or none, and a failure is genuinely fatal to the batch.
 *   mapSettledWithConcurrency - PER-ITEM ISOLATION. Every item settles; one item's rejection can
 *                               never abort the sweep or strand a sibling. Use for sweeps over
 *                               independent rows (one bad account must not stop the other accounts
 *                               from being refreshed) - the property the serial `for (…) await` loops
 *                               this replaces got for free, and the one a naive `Promise.all` loses.
 *
 * Both return results in INPUT order regardless of completion order, and both run at most
 * `concurrency` calls in flight at any moment.
 */

/** Shared engine: pull from one cursor, `width` workers deep. `settle` decides the failure contract. */
async function runPool<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
  settle: boolean,
): Promise<(R | PromiseSettledResult<R>)[]> {
  if (!Number.isFinite(concurrency) || concurrency < 1) {
    // Fail loudly: a 0/NaN cap would silently run ZERO workers and return a hole-filled array that
    // every caller would read as "nothing to do" - the exact class of silent no-op this repo bans.
    throw new Error(`bounded-concurrency pool: concurrency must be a finite number >= 1 (got ${String(concurrency)})`);
  }

  const results = new Array<R | PromiseSettledResult<R>>(items.length);
  const width = Math.min(Math.floor(concurrency), items.length);
  let cursor = 0;

  async function pump(): Promise<void> {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      const item = items[index] as T;
      if (!settle) {
        // All-or-nothing: let the rejection escape. Promise.all below has already attached a handler
        // to every pump(), so a LATER worker's rejection is still handled - no unhandled rejection.
        results[index] = await worker(item, index);
        continue;
      }
      try {
        results[index] = { status: "fulfilled", value: await worker(item, index) } satisfies PromiseSettledResult<R>;
      } catch (reason) {
        results[index] = { status: "rejected", reason } satisfies PromiseSettledResult<R>;
      }
    }
  }

  await Promise.all(Array.from({ length: width }, () => pump()));
  return results;
}

/**
 * Bounded `Promise.all`: run `worker` over `items` with at most `concurrency` in flight, results in
 * input order, and REJECT on the first failure. Drop-in for the hand-rolled copies this replaces.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  return (await runPool(items, concurrency, worker, false)) as R[];
}

/**
 * Bounded `Promise.allSettled`: run `worker` over `items` with at most `concurrency` in flight,
 * results in input order, and SETTLE every item - one item's rejection never aborts the rest. The
 * caller reads each outcome and decides what a failure means (count it, log it, retry it next tick).
 */
export async function mapSettledWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  return (await runPool(items, concurrency, worker, true)) as PromiseSettledResult<R>[];
}
