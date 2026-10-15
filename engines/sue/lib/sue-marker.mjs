/**
 * sue-marker - every Sue browser announces itself before any page code runs.
 *
 * WHAT: `installSueMarker(context, { run, id, borrowed, scenario, persona })` adds one init script to her browser
 * context that sets `window.__CONNECTIONS_SUE__ = { run, id, scenario, persona }` and
 * `localStorage["connections.sue.run"]` on every
 * origin she opens (the same mechanism as lib/signup-door.mjs's Turnstile wrap). The names live in
 * infra/shared/auth/sue-browser-marker.mjs, the one definition the product reads them by.
 *
 * WHY (Owner, 2026-09-28): Sues are a separate dataset. The product's client code can now tell a Sue
 * page from a person's before she signs in, and keep her out of human signals (RUM first:
 * packages/connections-core/src/runtime/cloudwatch-rum.ts starts no RUM on a Sue page).
 *
 * WHAT IT NEVER CARRIES: her email or her persona's name. `persona` is the persona's id, a slug such as
 * `casual-cassie`. Page code, and any third-party script on the page, can read the marker, so it holds only
 * the run id, the Sue id, the scenario id and the persona id.
 *
 * DEPENDED ON BY: body.mjs prepareContext (her first browser and every reopened one).
 */
import { SUE_BROWSER_GLOBAL, SUE_BROWSER_STORAGE_KEY } from "../../lib/shared/sue-browser-marker.mjs";

/**
 * The marker's value: the run id and the Sue id, each a string or null, plus `borrowed: true` when she
 * drives a PERSON's saved login (`--as`). Analytics then files only this visit as hers and leaves that
 * person's account and earlier visits in the human set (services/analytics ingest/dataset.ts).
 */
export function sueMarker({ run, id, borrowed, scenario, persona } = {}) {
  return {
    run: run == null ? null : String(run),
    id: id == null ? null : String(id),
    ...(borrowed === true ? { borrowed: true } : {}),
    ...(scenario == null ? {} : { scenario: String(scenario) }),
    ...(persona == null ? {} : { persona: String(persona) }),
  };
}

/**
 * Runs IN THE PAGE (serialized by Playwright), so it reaches nothing outside its argument. An opaque
 * origin (about:blank, data:) has no localStorage and throws on touch; the window half still lands.
 */
export function markSueBrowser({ globalName, storageKey, marker }) {
  window[globalName] = marker;
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(marker));
  } catch {
    // no storage on this origin
  }
}

/** Installs the marker on `context` before its first navigation. */
export async function installSueMarker(context, { run, id, borrowed, scenario, persona } = {}) {
  const marker = sueMarker({ run, id, borrowed, scenario, persona });
  await context.addInitScript(markSueBrowser, { globalName: SUE_BROWSER_GLOBAL, storageKey: SUE_BROWSER_STORAGE_KEY, marker });
  return marker;
}
