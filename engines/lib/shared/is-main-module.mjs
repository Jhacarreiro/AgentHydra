// vendored from Connections scripts/lib/is-main-module.mjs @ dd3d47a7ad
// is-main-module - the bun/node "was this file run directly" test, both ways.
// `import.meta.main` is undefined under plain node (a bun-only field), which silently turns
// `node <script> --check` into an exit-0 no-op unless a path-based fallback catches it -
// scripts/docs-index.mjs and scripts/docs-prune-queue.mjs each independently guarded against this
// identically (arkitect scripts-dir-duplication harvest, 2026-08-14).
//
// The fallback compares REAL paths: node resolves a linked folder (a junction, a symlink) to its
// real path for import.meta.url but leaves argv[1] as typed, so a plain resolve() compare read a
// linked script as imported and it exited 0 having done nothing (tools/sue/sue.mjs through a
// junction, MonkeyWerx 2026-09-22). On Windows the compare ignores case, since C: and c: are one file.
//
// `import.meta.main`/`import.meta.url` are per-MODULE, so they cannot be read from inside this
// shared helper - pass the caller's own values through:
//   const isMain = isMainModule(import.meta.main, import.meta.url);
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function realOf(file) {
  try {
    return realpathSync.native(file);
  } catch {
    return path.resolve(file);
  }
}

export function isMainModule(mainFlag, moduleUrl) {
  if (typeof mainFlag === "boolean") return mainFlag;
  if (!process.argv[1]) return false;
  const ran = realOf(process.argv[1]);
  const self = realOf(fileURLToPath(moduleUrl));
  return process.platform === "win32" ? ran.toLowerCase() === self.toLowerCase() : ran === self;
}
