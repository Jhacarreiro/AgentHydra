import { spawnSync } from "node:child_process";
import path from "node:path";
import { CODE_ROOTS, ROOT, filesUnder, importsIn, resolveRelative } from "./source-files.mjs";

let checked = 0;
let imports = 0;
const failures = [];
for (const area of CODE_ROOTS) {
  for (const file of filesUnder(path.join(ROOT, area))) {
    const rel = path.relative(ROOT, file).replaceAll("\\", "/");
    if (/\.(?:mjs|js)$/.test(file)) {
      const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8", windowsHide: true });
      checked++;
      if (result.status !== 0) failures.push(`${rel}: syntax check failed\n${result.stderr || result.error?.message || "unknown error"}`);
    }
    if (!/\.(?:mjs|js|cjs|ts|mts|cts)$/.test(file)) continue;
    let found;
    try { found = importsIn(file); } catch (err) { failures.push(`${rel}: cannot parse imports: ${err.message}`); continue; }
    for (const { specifier, line } of found) {
      if ((area === "sue" || area === "dredd") && /^(?:\.\.\/)+(?:infra|services|packages|scripts)\//.test(specifier))
        failures.push(`${rel}:${line}: monorepo import must be vendored or target-owned: ${specifier}`);
      if (!specifier.startsWith(".")) continue;
      imports++;
      if (!resolveRelative(file, specifier)) failures.push(`${rel}:${line}: missing relative import ${specifier}`);
    }
  }
}
for (const failure of failures) console.error(failure);
console.log(`check: ${checked} JS syntax checks, ${imports} relative imports, ${failures.length} failures`);
process.exitCode = failures.length ? 1 : 0;
