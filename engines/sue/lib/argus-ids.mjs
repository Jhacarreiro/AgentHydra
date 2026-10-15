/**
 * argus-ids - the ARGUS visit ids a Sue's page holds, so her trace can name the ARGUS session she made.
 *
 * WHAT: `readArgusIds(page)` reads sessionStorage `argus_sid` and localStorage `argus_anon` (else the
 * `argus_anon` cookie) from her page. It never throws and never waits past its timeout: an absent id
 * is `null`, and a hop or end row is written without it rather than not at all.
 */
export const ARGUS_PIXEL_HOST_PATTERN = "https://analytics.example.com/**";

const ARGUS_TIMEOUT_MS = 1_500;

export function pickArgusIds({ session = null, local = null, cookie = null } = {}) {
  return { argus_sid: session || null, argus_anon: local || cookie || null };
}

/** Runs IN THE PAGE (serialized by Playwright), so it reaches nothing outside its body. */
export function readArgusIdsInPage() {
  let session = null;
  let local = null;
  try {
    session = window.sessionStorage.getItem("argus_sid");
  } catch {
    // no storage on this origin
  }
  try {
    local = window.localStorage.getItem("argus_anon");
  } catch {
    // no storage on this origin
  }
  const match = /(?:^|;\s*)argus_anon=([^;]*)/.exec(document.cookie || "");
  return { session, local, cookie: match ? match[1] : null };
}

export async function readArgusIds(page, timeoutMs = ARGUS_TIMEOUT_MS) {
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    const read = await Promise.race([Promise.resolve(page.evaluate(readArgusIdsInPage)), late]);
    return pickArgusIds(read ?? {});
  } catch {
    return pickArgusIds();
  } finally {
    clearTimeout(timer);
  }
}

export const ARGUS_ROW_KIND = "argus";

export const isArgusRow = (row) => row?.kind === ARGUS_ROW_KIND;

/** The trace row for an ARGUS session this page holds and the visit has not written yet, else null. Never throws. */
export async function learnArgusRow(page, seen, at = new Date().toISOString()) {
  const ids = await readArgusIds(page);
  if (!ids.argus_sid || seen.has(ids.argus_sid)) return null;
  seen.add(ids.argus_sid);
  return { at, kind: ARGUS_ROW_KIND, ...ids };
}

/** The distinct ARGUS session ids a trace.jsonl text carries, in first-seen order; a `kind:"end"` row never counts. */
export function argusSidsIn(traceText) {
  const seen = new Set();
  for (const line of String(traceText ?? "").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row.kind === "end") continue;
      const sid = row.argus_sid;
      if (typeof sid === "string" && sid) seen.add(sid);
    } catch {
      // a torn line is not a visit id
    }
  }
  return [...seen];
}
