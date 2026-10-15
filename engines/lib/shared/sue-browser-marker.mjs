// vendored from Connections infra/shared/auth/sue-browser-marker.mjs @ dd3d47a7ad
/**
 * sue-browser-marker - the ONE definition of how a SUE simulated user's browser announces itself.
 *
 * WHAT: tools/sue puts `window.__CONNECTIONS_SUE__ = { run, id }` and
 * `localStorage["connections.sue.run"] = JSON.stringify({ run, id })` on every origin before any
 * page code runs (tools/sue/lib/sue-marker.mjs, from body.mjs prepareContext). `isSueBrowser(win)`
 * answers "is the page I am running in a Sue's?" from either one.
 *
 * WHY (Owner, 2026-09-28): Sues are a separate dataset, kept and read side by side with the human
 * one, never mixed into it. The address rule (sue-address.mjs) knows a Sue only once she has an
 * account; the browser marker knows her from her first page, so client code can keep her out of a
 * human signal before she ever signs in. The run id and the Sue id are the whole marker: no email
 * and no persona name, since page code (and any third-party script on it) can read it.
 *
 * WHO DEPENDS ON IT: tools/sue (the producer), packages/connections-core's cloudwatch-rum.ts (a Sue
 * page starts no RUM, so her JS errors never page anyone as a frontend error).
 */

/** The window property a Sue browser carries: `{ run, id }`, plus `borrowed: true` on a lent human login. */
export const SUE_BROWSER_GLOBAL = "__CONNECTIONS_SUE__";

/** The localStorage key a Sue browser carries: `JSON.stringify({ run, id })`. */
export const SUE_BROWSER_STORAGE_KEY = "connections.sue.run";

/** True when `win` (a browser window, or anything shaped like one) carries either half of the marker. */
export function isSueBrowser(win) {
  if (!win || typeof win !== "object") return false;
  if (win[SUE_BROWSER_GLOBAL] != null) return true;
  try {
    return Boolean(win.localStorage?.getItem(SUE_BROWSER_STORAGE_KEY));
  } catch {
    return false;
  }
}
