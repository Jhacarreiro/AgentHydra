/**
 * sample-files - the files every Sue has on her computer, from one fixed folder.
 *
 * A Sue's `attach` hand (body.mjs) reaches only the files in her own folder. Until 2026-10-10 those came
 * only from a scenario's files folder, and no scenario had one, so a Sue sent to upload a price list said
 * she had no PDF (SUE run 20261010-065644-e33d, 4Man 67ab64f1). `sue/sample-files/` is what a real
 * person has lying about: a PDF, a spreadsheet and a picture. A scenario's own folder still wins by name.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scenarioFiles } from "./personas.mjs";

export const SAMPLE_FILES_DIR = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "sample-files");

const plainFiles = (dir) =>
  fs.existsSync(dir)
    ? fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && !entry.name.startsWith("."))
        .map((entry) => entry.name)
    : [];

/** `{ names, sources }`: her files by name, sorted, and where each is copied from. A named-but-missing scenario folder throws. */
export function herFiles(target, scenario) {
  const own = scenarioFiles(target, scenario);
  const sources = Object.fromEntries(plainFiles(SAMPLE_FILES_DIR).map((name) => [name, path.join(SAMPLE_FILES_DIR, name)]));
  for (const name of own.names) sources[name] = path.join(own.dir, name);
  return { names: Object.keys(sources).sort(), sources };
}

/** Copies her files into `<sueDir>/files/` (the attach hand's whole reach) and returns their names. */
export function bringHerFiles(target, scenario, sueDir) {
  const { names, sources } = herFiles(target, scenario);
  if (names.length) {
    const into = path.join(sueDir, "files");
    fs.mkdirSync(into, { recursive: true });
    for (const name of names) fs.copyFileSync(sources[name], path.join(into, name));
  }
  return names;
}
