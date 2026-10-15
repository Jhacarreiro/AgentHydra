// vendored from Connections tools/lib/is-main.mjs
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// A junction's argv[1] is the typed path, not the real one, so both sides compare real paths.
function realPath(p) {
  try {
    return realpathSync.native(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

export function isMainModule(importMetaUrl, argv1 = process.argv[1], { platform = process.platform } = {}) {
  if (!argv1) return false;
  const a = realPath(argv1);
  const b = realPath(fileURLToPath(importMetaUrl));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
