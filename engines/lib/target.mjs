import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CONFIG_DIR = fileURLToPath(new URL("../targets/", import.meta.url));

/**
 * The owner's local settings, outside the repo: `~/.agenthydra/engines/targets/<name>.json` (AGENTHYDRA_ENGINES_CONFIG
 * moves the folder). When it exists it is read over the shipped target of the same name, key by key; when it does not,
 * the engine runs on the shipped defaults.
 */
export function localConfigDir(env = process.env) {
  return env.AGENTHYDRA_ENGINES_CONFIG ? path.resolve(env.AGENTHYDRA_ENGINES_CONFIG) : path.join(os.homedir(), ".agenthydra", "engines");
}

function readConfig(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    if (existsSync(file)) throw new Error(`${file}: ${err.message}`);
    return null;
  }
}

function expand(value) {
  if (typeof value !== "string") return value;
  if (value === "$CWD") return process.cwd();
  if (value === "~" || value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** The project under test, never this tool's code root. */
export function loadTarget(name = process.env.SUE_DREDD_TARGET || "default") {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) throw new Error(`Invalid target name: ${name}`);
  const shipped = readConfig(path.join(CONFIG_DIR, `${name}.json`));
  const local = readConfig(path.join(localConfigDir(), "targets", `${name}.json`));
  if (!shipped && !local) throw new Error(`no target named ${name} (targets/${name}.json or ${localConfigDir()}/targets/${name}.json)`);
  const merged = { ...(shipped ?? {}), ...(local ?? {}) };
  const config = Object.fromEntries(Object.entries(merged).map(([k, v]) => [k, expand(v)]));
  if (typeof config.root !== "string" || !config.root.trim()) throw new Error(`target ${name}: root must be a non-empty path`);
  const home = local ? path.join(localConfigDir(), "targets") : CONFIG_DIR;
  return { ...config, root: path.resolve(home, config.root) };
}

/** Every target this checkout or the local config names, each with its name and resolved root; one that will not load is left out. */
export function loadTargets() {
  const names = new Set();
  for (const dir of [CONFIG_DIR, path.join(localConfigDir(), "targets")]) {
    try {
      for (const file of readdirSync(dir)) if (file.endsWith(".json")) names.add(file.slice(0, -5));
    } catch {
      // no such folder: no targets from there
    }
  }
  return [...names].sort().flatMap((name) => {
    try {
      return [{ name, ...loadTarget(name) }];
    } catch {
      return [];
    }
  });
}

export function targetRoot() {
  return loadTarget().root;
}

/** Resolve a path owned by the selected target; pass the configured path or its parts. */
export function targetPath(...parts) {
  return path.resolve(targetRoot(), ...parts);
}

/**
 * Import a file the selected target names (a product's own hook or helper). A target that names none, or whose file is
 * missing, answers `fallback`: the engine runs without the product's extras.
 */
export async function importTargetFile(key, fallback) {
  const rel = loadTarget()[key];
  if (!rel) return fallback;
  const file = targetPath(rel);
  if (!existsSync(file)) return fallback;
  const { pathToFileURL } = await import("node:url");
  return import(pathToFileURL(file).href);
}
