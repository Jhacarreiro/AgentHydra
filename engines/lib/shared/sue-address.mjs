// vendored from Connections infra/shared/auth/sue-address.mjs @ dd3d47a7ad
/**
 * sue-address - the ONE definition of a SUE simulated user's email address.
 *
 * WHAT: `isSueAddress(email)` answers "is this account one of our own simulated users (tools/sue)?"
 * from the address alone, and `SUE_ADDRESS_PATTERN` is the same rule as a string for SQL (`~`).
 *
 * WHY ONE FILE: three kinds of code ask this question and they must never disagree. The producer is
 * `sueAddress()` in tools/sue/lib/personas.mjs (`sue-1117-grandma-6174@example.com`: global Sue
 * number, persona id, the run id's 4-hex tail). AEGIS's Sue door (auth-request-otp/turnstile-gate.ts)
 * lets only this shape past Turnstile. And every STAFF alert holds its fire when the person it is
 * about is a Sue (owner, Owner, 2026-09-22: "add an exception so I stop seeing sign up
 * notifications, et cetera, for Sue, because I'm going to be running a lot of Sue's through here").
 * A Sue's OWN mail (her code, her welcome, her Pass email) is unaffected: she is the one being
 * tested, so she must receive exactly what a person receives.
 *
 * WHY THE ADDRESS IS ENOUGH: the domain is ours and its mail lands only in our SES inbound bucket,
 * so nobody outside can receive a sign-in code at a Sue-shaped address, which means nobody outside
 * can own an account at one.
 *
 * WHO DEPENDS ON IT: services/accounts (the Sue door, the signup alert, the admins-internal pulse
 * door every other plane's staff alert goes through), services/chat's support escalation (a Sue's
 * "Send it" reaches no human inbox), services/main's public-form owner alerts (a Sue's submission
 * pings no Slack and mails no owner; her own receipt still goes), services/events (a Sue's RSVP on
 * a real event alerts no host, joins no pending-approvals nudge and fires no webhook), and
 * tools/sue's own parity spec against the producer.
 */

export const SUE_ADDRESS_PATTERN = "^sue-[0-9]+-[a-z0-9-]+-[0-9a-f]{4}@(sue\\.)?connections\\.icu$";

const SUE_ADDRESS = new RegExp(SUE_ADDRESS_PATTERN);

/** True only for a Sue-shaped address; case and surrounding space do not matter, anything else is false. */
export function isSueAddress(email) {
  return typeof email === "string" && SUE_ADDRESS.test(email.trim().toLowerCase());
}
