// reader-motion.mjs - a Sue who reads a page moves the viewport like a reader, and a visit ends like a
// person leaving a tab. The site's ARGUS pixel only counts scroll milestones from scroll events and only
// flushes engagement time on pagehide / visibilitychange:hidden; a Sue who read the whole text without
// moving, then had her context torn down, looked like a bounce (measured 2026-10-11, run 20261011-084900-92c1).
// Pure browser calls, no LLM, every wait bounded.

export const READ_STEPS = 6;
export const READ_STEP_MS = 350; // 6 steps x 350 ms = 2.1 s at most per read
export const LEAVE_BOUND_MS = 1_500;

const withBound = (promise, ms) =>
  Promise.race([Promise.resolve(promise).catch(() => {}), new Promise((resolve) => setTimeout(resolve, ms))]);

/**
 * Scroll `page` in steps to `fraction` (0..1) of the way down the scrollable distance, then back to where she
 * was. Never past the fraction she was shown. Returns the furthest scrollY reached (0 when nothing moved).
 * `onStep(y)`, when given, is called with the scrollY each step lands on, in the order the steps run.
 */
export async function scrollLikeAReader(page, fraction, { steps = READ_STEPS, stepMs = READ_STEP_MS, onStep } = {}) {
  const f = Math.max(0, Math.min(1, Number(fraction) || 0));
  if (f < 0.05) return 0;
  const from = await page.evaluate(() => [window.scrollX, window.scrollY]).catch(() => null);
  if (!from) return 0;
  let reached = 0;
  try {
    for (let i = 1; i <= steps; i += 1) {
      reached = await page.evaluate(
        ({ f: frac, i: n, steps: total }) => {
          const el = document.scrollingElement || document.documentElement;
          const room = Math.max(0, el.scrollHeight - window.innerHeight);
          window.scrollTo({ top: (room * frac * n) / total, behavior: "instant" });
          return window.scrollY;
        },
        { f, i, steps },
      );
      onStep?.(reached);
      await page.waitForTimeout(stepMs);
    }
  } catch {
    // a page that navigated or closed mid-read: nothing more to move
  }
  await page.evaluate(([x, y]) => window.scrollTo({ left: x, top: y, behavior: "instant" }), from).catch(() => {});
  return reached;
}

export const BEACON_WAIT_MS = 3_000;
export const LEAVE_TRIES = 3;
const isIngest = (request) => request.method() === "POST" && /\/ingest\b/.test(request.url());

/**
 * Leave every open page of `context` the way a visitor does (pagehide, visibilitychange:hidden), then wait for the
 * pixel's end beacons to be answered before the context closes: a context closed on a beacon still on its way, or one
 * the server answered with an error (a 429 under a burst of Sues ending together), lost a visitor's attention,
 * user_engagement and web_vitals (run 20261011-133328-e6e0). A refused or failed beacon is sent again by leaving
 * again (the pixel keeps an unanswered batch and posts it on pagehide; the server drops a repeat by event id), up to
 * `tries` times. Every wait is bounded, so a hung page cannot hold teardown.
 */
export async function endVisit(context, { boundMs = LEAVE_BOUND_MS, beaconMs = BEACON_WAIT_MS, tries = LEAVE_TRIES } = {}) {
  const started = Date.now();
  const pages = () => {
    try {
      return context.pages();
    } catch {
      return [];
    }
  };
  let pending = 0;
  let refused = 0;
  const onRequest = (request) => {
    if (isIngest(request)) pending += 1;
  };
  const onResponse = (response) => {
    if (isIngest(response.request()) && response.status() >= 400) refused += 1;
  };
  const onDone = (request) => {
    if (isIngest(request)) pending = Math.max(0, pending - 1);
  };
  const onFailed = (request) => {
    if (!isIngest(request)) return;
    pending = Math.max(0, pending - 1);
    refused += 1;
  };
  try {
    context.on("request", onRequest);
    context.on("response", onResponse);
    context.on("requestfinished", onDone);
    context.on("requestfailed", onFailed);
  } catch {
    // a context already closed: nothing to wait for
  }
  const leave = (page) =>
    withBound(
      page.evaluate(() => {
        try {
          Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
          Object.defineProperty(document, "hidden", { value: true, configurable: true });
        } catch {
          // already redefined
        }
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
      }),
      boundMs,
    );
  for (let attempt = 0; attempt < Math.max(1, tries); attempt += 1) {
    refused = 0;
    await Promise.all(pages().map(leave));
    await withBound(new Promise((resolve) => setTimeout(resolve, 250)), boundMs); // let the pixel's fetch start
    const until = Date.now() + beaconMs;
    while (pending > 0 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 50));
    if (refused === 0) break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  // runBeforeUnload can sit on a page's own dialog; the bound is what stops that.
  await withBound(Promise.all(pages().map((page) => page.close({ runBeforeUnload: true }).catch(() => {}))), boundMs);
  await withBound(context.close(), 3_000);
  return Date.now() - started;
}
