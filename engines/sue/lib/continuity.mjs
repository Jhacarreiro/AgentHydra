/**
 * continuity - the verdict on one sign-in carried across the sibling planes, read off SUE's hop trace
 * ====================================================================================================
 * What it is: `continuityVerdict(lines, { planes })` takes the trace lines a SUE run wrote (lib/hop-trace.mjs,
 * `kind: "hop"`; her move rows are not hops and are ignored) and says whether the visitor stayed signed in.
 *
 * The sign-in is the first hop whose `cxActive` pointer reads "yes". Everything before it is the sign-in
 * itself and is not judged. From that hop on, each plane must be reached by one page load that keeps the
 * pointer:
 *   - `extra-redirect`: the server sent her on again (a redirect hop) - continuity is a plain load;
 *   - `second-sign-in`: a hop landed on the sign-in or authorize path - she was asked to sign in twice;
 *   - `pointer-lost`: a plane read the pointer as "blank" or "no" - the site signed her out;
 *   - `unread`: a plane's pointer read did not answer in time (`cxActive: null`) - never a pass;
 *   - `plane-not-reached`: a listed plane was never opened after sign-in;
 *   - `never-signed-in`: no hop ever carried the pointer.
 *
 * Why it exists: the Apple-test check (4Man e5cceb64). Crossing planes is a visible top-level redirect
 * today; this is the pass/fail a pre-deploy run reads, so a sign-in change that adds a hop fails here.
 *
 * Pure: no browser, no network, no clock. The live run that produces the lines is a separate part of
 * e5cceb64. Node builtins only; never bun (SPEC.md).
 */
import { isHop } from "./hop-trace.mjs";

/** The paths a sign-in or re-authorization answers on: a second one of these after sign-in is a second sign-in. */
export const SIGN_IN_PATH = /^\/(?:oauth\/authorize|sign-?in|login)(?:\/|$)/i;

const POINTER_SIGNED_IN = "yes";

/** The origin of a hop's url, or null when it does not parse as an absolute address. */
function originOf(url) {
  try {
    return new URL(String(url ?? "")).origin;
  } catch {
    return null;
  }
}

/**
 * Judge one sign-in carried across `planes` (origins such as `https://example.com`).
 * Returns `{ ok, findings, reached, judged }`: `findings` is `{ kind, at, url?, plane? }` in trace order.
 */
export function continuityVerdict(lines, { planes = [] } = {}) {
  const hops = (Array.isArray(lines) ? lines : []).filter(isHop).sort((a, b) => a.at - b.at);
  const signedIn = hops.findIndex((hop) => hop.cxActive === POINTER_SIGNED_IN);
  const findings = [];
  const reached = new Set();

  if (signedIn < 0) {
    findings.push({ kind: "never-signed-in", at: null });
  }

  for (const [index, hop] of hops.entries()) {
    if (signedIn < 0 || index < signedIn) continue;
    const origin = originOf(hop.url);
    const isSignedInHop = index === signedIn;

    if (!isSignedInHop) {
      if (SIGN_IN_PATH.test(new URL(hop.url, "http://relative.invalid").pathname)) {
        findings.push({ kind: "second-sign-in", at: hop.at, url: hop.url });
      }
      if (hop.how === "redirect") {
        findings.push({ kind: "extra-redirect", at: hop.at, url: hop.url });
      }
    }

    if (origin && planes.includes(origin)) {
      reached.add(origin);
      if (hop.cxActive == null) {
        findings.push({ kind: "unread", at: hop.at, url: hop.url });
      } else if (hop.cxActive !== POINTER_SIGNED_IN) {
        findings.push({ kind: "pointer-lost", at: hop.at, url: hop.url });
      }
    }
  }

  for (const plane of planes) {
    if (!reached.has(plane)) findings.push({ kind: "plane-not-reached", at: null, plane });
  }

  return { ok: findings.length === 0, findings, reached: [...reached], judged: signedIn < 0 ? 0 : hops.length - signedIn };
}
