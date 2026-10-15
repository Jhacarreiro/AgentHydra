// vendored from Connections scripts/deploy/stamp-envelope.mjs @ dd3d47a7ad
/**
 * stamp-envelope - the safe-parse + `{ v: 1, sha: <40-hex> }` shape check shared by the fleet's two
 * build stamps (build-stamp.mjs's `.vite-build-success` marker, shipped-build-stamp.mjs's
 * `build-stamp.json`).
 * ===========================================================================
 * Extracted 2026-09-12 after `scripts-dir-duplication` flagged the byte-identical validation body
 * between `parseBuildSuccessStamp` and `parseShippedStamp`: an empty/non-string body is null, a
 * JSON parse failure is null, a body whose `v` is not `1` is null, and a `sha` that is not exactly
 * 40 lowercase hex characters is null. Both readers still own their OWN final shape - the build
 * marker returns `{ sha, dirty }`, the shipped stamp returns the fuller `{ v, sha, plane, source,
 * dirty, at }` - so this hoists only the shared envelope check, not either script's record shape.
 * Both files also carried their own copy of the 40-hex regex; `FULL_SHA` here is the one definition
 * now, re-exported so a caller that only needs the sha check (not the full envelope) can use it too.
 */

export const FULL_SHA = /^[0-9a-f]{40}$/;

/** `true` only for a full, lowercase, 40-hex commit sha - never an abbreviation `git merge-base` cannot compare reliably. */
export function isFullSha(sha) {
  return typeof sha === "string" && FULL_SHA.test(sha);
}

/**
 * Safely parse `text` as JSON and check the shared envelope shape (`v === 1`, `sha` a full 40-hex
 * commit). Returns the parsed object for the caller to read its own remaining fields from, or
 * `null` when the text is empty/not-a-string, not valid JSON, not an object, the wrong version, or
 * missing a comparable sha - the same "no usable record" outcome both stamps need, since a stamp
 * that cannot be compared is a decoration either way.
 *
 * @param {unknown} text
 * @returns {Record<string, unknown>|null}
 */
export function parseStampEnvelope(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || parsed.v !== 1) return null;
  if (!isFullSha(parsed.sha)) return null;
  return parsed;
}
