import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export function addonFile(rel, appRoot, env = process.env) {
  const fromEnv = (env.SUE_DREDD_HOME ?? "").trim();
  const home = fromEnv ? path.resolve(fromEnv) : path.join(path.resolve(appRoot, ".."), "sue-dredd");
  const file = path.join(home, rel);
  return existsSync(file) ? file : null;
}

export async function loadAddon(rel, appRoot, env = process.env) {
  const file = addonFile(rel, appRoot, env);
  return file ? import(pathToFileURL(file).href) : null;
}
