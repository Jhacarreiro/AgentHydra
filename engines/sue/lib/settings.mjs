/**
 * settings - how Sue's window behaves on this computer (the Manager's Settings tab), kept in Sue's state folder.
 * Owner, 2026-09-23: closing her window shrinks her to the toolbar and says so, by default. An AI's wave is
 * headless and has no setting (2026-10-09).
 *   whenClosed    toolbar  closing the window leaves Sue in the toolbar, and she says so
 *                 quit     closing the window ends the Manager and its icon (the next wave starts it)
 *   keepPictures  forever  every run keeps its pictures and brain streams for good (the default)
 *                 7|14|30|90  a run finished that many days ago loses its pictures and brain streams;
 *                          its report, scores and findings stay (lib/retention.mjs). Off until the owner picks a
 *                          number: it deletes his data (519 runs held 9.0 GB, 2026-09-23; choices: decide-48).
 */
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./run-dir.mjs";

export const SETTING_CHOICES = Object.freeze({
  whenClosed: Object.freeze(["toolbar", "quit"]),
  keepPictures: Object.freeze(["forever", "7", "14", "30", "90"]),
});
export const DEFAULT_SETTINGS = Object.freeze({ whenClosed: "toolbar", keepPictures: "forever" });

const settingsFile = () => path.join(stateRoot(), "manager", "settings.json");

/** The settings file as it was written, every key kept; {} when there is none or it is not an object. */
function savedSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(settingsFile(), "utf8"));
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {};
  } catch {
    return {}; // never saved, or half-written: the defaults
  }
}

/** Every key this engine knows, each one a known choice (an unknown one reads as its default). */
function known(saved) {
  const out = {};
  for (const [key, choices] of Object.entries(SETTING_CHOICES)) {
    out[key] = choices.includes(saved[key]) ? saved[key] : DEFAULT_SETTINGS[key];
  }
  return out;
}

/** This computer's settings: every key present, each one a known choice (an unknown one reads as its default). */
export function readSettings() {
  return known(savedSettings());
}

/**
 * Save a change of one or more settings and return all of them. Throws (naming the key and its
 * choices) on an unknown key or value, before anything is written. The change is written over the file
 * as it stands, so a setting or a choice only a newer Sue knows (an older engine still runs a wave after
 * an update, lib/engine-lease.mjs) survives an older one's save; the answer is what this engine reads.
 */
export function saveSettings(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("send the settings as an object");
  const saved = savedSettings();
  const next = { ...known(saved), ...saved };
  for (const [key, value] of Object.entries(patch)) {
    const choices = SETTING_CHOICES[key];
    if (!choices) throw new Error(`${key} is not a setting (${Object.keys(SETTING_CHOICES).join(", ")})`);
    if (!choices.includes(value)) throw new Error(`${key} is ${choices.join(" or ")}`);
    next[key] = value;
  }
  const file = settingsFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written whole and renamed in, so `sue run` reading it mid-write never sees half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next));
  fs.renameSync(tmp, file);
  return known(next);
}
