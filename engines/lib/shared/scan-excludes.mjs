// vendored from Connections packages/connections-arkitect/src/core/scan-excludes.mjs @ dd3d47a7ad
/**
 * scan-excludes - the ONE registry of what the scanned workspace calls not-source.
 * ================================================================================
 *
 * Workspace-level scan exclusions (config `scan.excludeDirs`, `.arkitect/ignore`, and on a foreign
 * corpus scan whatever the target's git ignores): repo-relative paths set once per run by the
 * runner and matched by ABSOLUTE path prefix, so walks over other roots (check discovery inside the
 * core package itself) are never affected.
 *
 * ⛔ WHY IT IS ITS OWN MODULE (2026-09-14). It lived inside `fs-walk.mjs`, and `portable-files.mjs`
 * - the walker `discoverConfigScanFiles` and the agnostic `walkFiles` delegate to - cannot import
 * `fs-walk.mjs` (fs-walk imports it). So that walker never asked, and every check reading through it
 * graded what the workspace had excluded: MonkeyWerx's gitignored, config-excluded
 * `packages/socialsuite/packages/socialsuite/web/index.html` kept a gating error on the fleet board
 * after both exclude lists named it. A registry every walker can import is the only shape where a
 * new walker cannot be born blind to it.
 *
 * A SET, looked up once per ancestor of the queried path: a git-derived exclude list can name
 * hundreds of paths, and a linear prefix scan per walked file made that files x excludes work.
 */
import { resolve } from "node:path";

let SCAN_EXCLUDE_PREFIXES = new Set();

export function setScanExcludes(root, dirs = []) {
  const rootPosix = resolve(root).replace(/\\/g, "/").replace(/\/+$/, "");
  SCAN_EXCLUDE_PREFIXES = new Set(
    (Array.isArray(dirs) ? dirs : [])
      .filter((d) => typeof d === "string" && d.trim())
      .map((d) => `${rootPosix}/${d.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")}`),
  );
}

/** Cheap guard for hot paths: false when this run declared no exclusions at all. */
export function hasScanExcludes() {
  return SCAN_EXCLUDE_PREFIXES.size > 0;
}

export function isScanExcluded(p) {
  if (SCAN_EXCLUDE_PREFIXES.size === 0) return false;
  let posix = String(p).replace(/\\/g, "/");
  for (;;) {
    if (SCAN_EXCLUDE_PREFIXES.has(posix)) return true;
    const cut = posix.lastIndexOf("/");
    if (cut <= 0) return false;
    posix = posix.slice(0, cut);
  }
}
