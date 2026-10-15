/**
 * guest-walk-judge - PURE: did the T-72h Sue guest walk pass? Read from `sue.mjs report`'s answer.
 * Kept apart from event-guest-walks.mjs (which reaches TypeScript through the MCP client) so a plain
 * `node --test` can load it.
 */

export const SUMMARY_MAX_CHARS = 2000;
/** What her own report files when the site stopped her. */
const SITE_FAILURE_KINDS = new Set(["broken", "gave-up", "wrong-destination"]);
/** report.mjs's `diedAt` stops before her account existed: the sign-up form is part of what a guest walks
 *  (ACCAP Houston's was broken for a week), so a walk that never got through it did not pass. */
const SIGNUP_STOPS = /^(before-signup|before-code-request|before-code-read|refused-at-our-sue-door|before-sign-in|handed-off:)/;

/** Passed = the run finished, her report is complete for exactly one Sue, she made her account, and it
 *  files nothing that says the site stopped her on the way to the final RSVP or ticket step. */
export function judge(status, report) {
  const words = (report.theirWords ?? []).map((w) => `${w.kind}${w.where ? ` at ${w.where}` : ""}: ${w.said}`);
  const problems = (report.problemsFound ?? []).map((p) => `${p.kind} x${p.count}`);
  const reasons = [];
  if (status.state !== "finished") reasons.push(`the run ended ${status.state}${status.error ? ` (${status.error})` : ""}`);
  if (report.complete !== true) reasons.push("her report never completed");
  else if (report.sues !== 1) reasons.push(`the report holds ${report.sues} Sues, not one`);
  const siteFailures = (report.problemsFound ?? []).filter((p) => SITE_FAILURE_KINDS.has(p.kind));
  if (siteFailures.length) reasons.push(`she filed ${siteFailures.map((p) => p.kind).join(", ")}`);
  if (report.whereTheyStopped?.["sue-browser-lost"]) reasons.push("her browser closed under her, so the walk proved nothing");
  else {
    const stoppedInSignup = Object.keys(report.whereTheyStopped ?? {}).find((where) => SIGNUP_STOPS.test(where));
    if (stoppedInSignup) reasons.push(`she never got through Create account (stopped ${stoppedInSignup})`);
  }
  const stars = report.verdict?.averageStars;
  const summary = [
    reasons.length
      ? `FAILED: ${reasons.join("; ")}.`
      : "PASSED: she made her account, reached the final RSVP or ticket step and filed no site failure.",
    stars != null ? `Stars ${stars}.` : "",
    problems.length ? `Findings: ${problems.join(", ")}.` : "",
    words.length ? `In her words: ${words.slice(0, 6).join(" | ")}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return { passed: reasons.length === 0, summary: summary.slice(0, SUMMARY_MAX_CHARS) };
}
