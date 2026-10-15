/**
 * slow-waits - which slow requests are a finding: the ones she sat waiting on, once each.
 * ========================================================================================
 *
 * WHY THIS EXISTS: the body used to file every request over 3 s as `slow-response`, one finding per
 * request. Measured 2026-09-25 over 325 visits: 4,619 of them, 4,571 pictures, sounds, fonts and
 * scripts a page streams in behind what she is doing (a game's sound pack alone filed 1,700), which
 * buried the 48 that were real: a sign-in call she sat in front of for 4 s. A person waits on a page
 * and on the answer to what she just did; how heavy the page's pictures are is `slow-navigation`'s
 * job (the load event) and her own eyes' (a look that shows half a page).
 *
 * So a finding is: a `document`, `xhr` or `fetch` over the line, the line moved out by her own
 * network's latency (a Sue on slow 3G pays 2 s per round trip before the site says a word, and that
 * is her line, not the site), and one per method + host + path per visit, ids folded, so a slow
 * endpoint she hits ten times is one finding, not ten.
 *
 * DEPENDED ON BY: body.mjs (`watch`, its requestfinished listener). Spec: tests/slow-waits.spec.mjs.
 */

/** Past this many ms, beyond her network's own latency, a wait is slow. */
export const SLOW_WAIT_MS = 3_000;

/** How often her harness asks her browser whether it still answers. */
export const HEARTBEAT_EVERY_MS = 1_000;

/** A beat that fired or came back this much past its time is a stall of her own browser or machine. */
export const STALL_MS = 1_000;

/** Playwright's `request.resourceType()` values a person actually waits on. */
const WAITED_ON = new Set(["document", "xhr", "fetch"]);

/** A path segment that is an id (a long hex, uuid or opaque token), folded so one endpoint is one key. */
const ID_SEGMENT = /\/(?:[0-9a-f]{8,}|[0-9a-f-]{20,}|[A-Za-z0-9_-]{24,})(?=\/|$)/gi;

function endpointKey(method, url) {
  try {
    const u = new URL(url);
    return `${method} ${u.host}${u.pathname.replace(ID_SEGMENT, "/:id")}`;
  } catch {
    return `${method} ${String(url).split("?")[0]}`;
  }
}

/**
 * Where a request's time went, from Playwright's `request.timing()` (ms after its start; -1 marks a
 * phase that did not happen, as DNS and connect on a reused connection), so a room can tell her
 * browser holding a request from a server taking its time.
 */
export function timingPhases(timing) {
  const span = (from, to) => (from >= 0 && to >= 0 ? Math.round(to - from) : null);
  const firstOnTheWire = [timing.domainLookupStart, timing.connectStart, timing.requestStart].find((v) => v >= 0);
  return {
    queued: firstOnTheWire === undefined ? null : Math.round(firstOnTheWire),
    dns: span(timing.domainLookupStart, timing.domainLookupEnd),
    connect: span(timing.connectStart, timing.connectEnd),
    wait: span(timing.requestStart, timing.responseStart),
    download: span(timing.responseStart, timing.responseEnd),
  };
}

/**
 * Her harness's own clock, so time her own browser stood still is never the site's (2026-10-11): the
 * Sues of a wave share one browser, which on a busy PC stops for seconds at once, and run
 * 20261011-084626-7760 filed a 5513 ms ingest batch, ruled REAL 5-0, that box A answered in 31 ms
 * once it arrived 5.4 s late. Every `everyMs` it pings her browser (`ping`, a CDP call that never
 * touches the page, so the site's own JS blocking her tab trips nothing), and a beat that fired or
 * came back more than `stallMs` late is a stall from the moment it was due. `stalledMs(from, to)` is
 * how much of that span she stood still, a stall under way included: the request it held and the
 * beat come back together, and the request is often read first. Known miss, measured: a stall that
 * held nothing (one inside a slow answer's wait, or of her harness alone) is taken off too.
 */
export function createHarnessClock({ ping, everyMs = HEARTBEAT_EVERY_MS, stallMs = STALL_MS, keep = 100 }) {
  const stalls = [];
  let due = null;
  let timer = null;
  let run = 0; // a beat out when she stopped is not one of the next start's beats
  const schedule = () => {
    due = Date.now() + everyMs;
    timer = setTimeout(beat, everyMs);
    timer.unref?.();
  };
  async function beat() {
    timer = null;
    const mine = run;
    await Promise.resolve()
      .then(ping)
      .catch(() => {}); // a tab closing under her answers with an error, and an error is an answer
    if (mine !== run) return;
    const now = Date.now();
    if (now - due > stallMs) stalls.push({ from: due, to: now });
    if (stalls.length > keep) stalls.shift();
    schedule();
  }
  return {
    start() {
      if (due === null) schedule();
    },
    stop() {
      run += 1;
      due = null;
      if (timer) clearTimeout(timer);
      timer = null;
    },
    stalledMs(from, to) {
      const now = Date.now();
      const open = due !== null && now - due > stallMs ? [{ from: due, to: now }] : [];
      return [...stalls, ...open].reduce((sum, s) => sum + Math.max(0, Math.min(s.to, to) - Math.max(s.from, from)), 0);
    },
  };
}

/**
 * A judge for one visit. Call it with each finished request; it answers `{ text, extra }` for the
 * body to file as `slow-response`, or `null`. `networkLatencyMs` is her network dial's latency
 * (personas.mjs `networkConditionsFor`), 0 on a fast line. `stalledMs` is how much of the request
 * her own browser or machine stood still (`createHarnessClock`), and is never the site's; `timing`
 * is the request's own `timing()`, carried on a finding as its phases.
 */
export function createSlowWaitJudge({ networkLatencyMs = 0 } = {}) {
  const line = SLOW_WAIT_MS + Math.max(0, networkLatencyMs);
  const filed = new Set();
  return function judge({ resourceType, method, url, ms, stalledMs = 0, timing = null }) {
    const stalled = Math.max(0, Math.round(stalledMs));
    if (!WAITED_ON.has(resourceType) || !(ms - stalled > line)) return null;
    const key = endpointKey(method, url);
    if (filed.has(key)) return null;
    filed.add(key);
    return {
      text: `${ms}ms ${method} ${String(url).slice(0, 300)}${stalled ? ` (her own browser stood still ${stalled}ms of it)` : ""}`,
      extra: {
        ms,
        request: url,
        resourceType,
        ...(stalled ? { stalledMs: stalled } : {}),
        ...(timing ? { timing: timingPhases(timing) } : {}),
      },
    };
  };
}
