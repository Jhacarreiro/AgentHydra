/**
 * material-address - the address a Sue opens to look at something a person gave her group.
 * ==========================================================================================
 *
 * A file or a typed idea is not a page yet: lib/material.mjs stores it, and the Sue Manager on this
 * computer serves it at `http://127.0.0.1:<port>/material/<id>` (manager.mjs). A group is then sent
 * there exactly like any other page. This file only knows the shape of that address, so the store,
 * the Manager and the page rules (lib/workspace.mjs) can all read it without importing each other.
 */

/** A stored item's id: 128 random bits, lowercase hex. Nothing else is ever looked up. */
export const MATERIAL_ID = /^[0-9a-f]{32}$/;
const MATERIAL_PATH = /^\/material\/([0-9a-f]{32})(\/view)?$/;
const LOOPBACK = new Set(["127.0.0.1", "localhost"]);

export function materialUrl(id, port) {
  return `http://127.0.0.1:${port}/material/${id}`;
}

/** A PDF's page viewer: the same item, its pages shown one under another (lib/pdf-pages.mjs). */
export function materialViewUrl(id, port) {
  return `${materialUrl(id, port)}/view`;
}

/** The id in a Sue Manager material address, or null for any other address. */
export function materialIdFrom(url) {
  try {
    const u = new URL(String(url));
    if (u.protocol !== "http:" || !LOOPBACK.has(u.hostname)) return null;
    return MATERIAL_PATH.exec(u.pathname)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** The id a request path names (`/material/<id>`), null for a malformed one, undefined for any other path. */
export function materialIdOfPath(pathname) {
  if (!String(pathname).startsWith("/material/")) return undefined;
  return MATERIAL_PATH.exec(pathname)?.[1] ?? null;
}
