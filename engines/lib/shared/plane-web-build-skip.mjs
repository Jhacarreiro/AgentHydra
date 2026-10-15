// vendored from Connections scripts/deploy/plane-web-build-skip.mjs @ dd3d47a7ad
/**
 * plane-web-build-skip - ship nothing for a plane whose build inputs did not change.
 *
 * Owner, 2026-09-26: "100% yes, skip building planes whose files didn't change." Every plane build
 * records the repo files it read (`planeBuildInputsPlugin`, infra/shared/plane-vite-config.build-inputs-plugin.ts).
 * The next publish diffs the live commit against the one being shipped; when no changed file is one of
 * those inputs, the live bytes ARE what the new commit builds to, so the build, the uploads and the
 * invalidation are skipped and only the stamp moves forward (`reusedFrom` names the build that made them).
 *
 * A wrong skip serves stale code under a stamp that says it is current, so the judge sends a change to a
 * real build whenever the recorder cannot see it: anything under the plane's own web folder (public/,
 * index.html, env files, its config), any package manifest, lockfile or tsconfig (dependencies and
 * compile options), any stylesheet outside other planes (a CSS @import is not a module Rolldown lists),
 * the build and upload tooling, and any file added to or removed from a folder the build globbed.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const MANIFEST = /(^|\/)(package\.json|bun\.lockb?|bunfig\.toml|\.npmrc|(ts|js)config[^/]*\.json)$/;
export const STYLESHEET = /\.(css|scss|sass|less|styl|stylus|pcss|postcss)$/i;
const TOOLING = [
  /^scripts\/deploy\/(?!.*\.spec\.)/,
  /^scripts\/config\//,
  /^infra\/shared\/[^/]*(vite|plugin)[^/]*$/,
  /^infra\/shared\/seo\//,
  /^\.arkitect\/arkitect\.config\.json$/,
  /^\.arkitect\/.*icon/i,
];

/** `git diff --name-status -M` output as [{ status, path, oldPath? }]. */
export function parseNameStatus(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [status, first, second] = line.split("\t");
      return second ? { status: status[0], path: second, oldPath: first } : { status: status[0], path: first };
    });
}

/** { skip, why, path? } - `path` names the first change that forces a build. */
export function judgeBuildSkip({ changes, record, planeWebDir }) {
  if (!record || !Array.isArray(record.inputs)) return { skip: false, why: "no record of what the live build read" };
  if (record.complete === false) return { skip: false, why: "the live build could not list what its vite config imports" };
  const inputs = new Set(record.inputs);
  const dirs = record.dirs ?? [];
  const ownDir = `${planeWebDir.replace(/\/$/, "")}/`;
  const otherPlane = (p) => p.startsWith("services/") && !p.startsWith(`${ownDir.split("/").slice(0, 2).join("/")}/`);
  for (const change of changes) {
    for (const p of [change.path, change.oldPath].filter(Boolean)) {
      const why =
        (p.startsWith(ownDir) && "it is in the plane's own web folder") ||
        (inputs.has(p) && "the live build read it") ||
        (dirs.some((d) => p.startsWith(`${d}/`)) && "it is in a folder the build globbed") ||
        (MANIFEST.test(p) && "it is a package manifest, lockfile or tsconfig") ||
        (STYLESHEET.test(p) && !otherPlane(p) && "it is a stylesheet, and CSS imports are not recorded") ||
        (TOOLING.some((rule) => rule.test(p)) && "it is build or upload tooling") ||
        (record.globUnknown && change.status !== "M" && "the build had a glob it could not read, and a file came or went");
      if (why) return { skip: false, why: `${p} changed and ${why}`, path: p };
    }
  }
  return { skip: true, why: `none of the ${changes.length} changed file(s) is an input of this build` };
}

/** The record a build wrote, normalised: sorted, de-duplicated. */
export function normaliseRecord(raw) {
  return {
    inputs: [...new Set(raw?.inputs ?? [])].sort(),
    dirs: [...new Set(raw?.dirs ?? [])].sort(),
    globUnknown: Boolean(raw?.globUnknown),
    complete: raw?.complete !== false,
  };
}

export const recordDigest = (record) =>
  createHash("sha256")
    .update(JSON.stringify(normaliseRecord(record)))
    .digest("hex");

/** The build sees every VITE_* variable, so a different set means different bytes. Values stay here, hashed. */
export function viteEnvDigest(env = process.env) {
  const pairs = Object.keys(env)
    .filter((key) => key.startsWith("VITE_"))
    .sort()
    .map((key) => `${key}=${env[key]}`);
  return createHash("sha256").update(pairs.join("\n")).digest("hex");
}

// The full list is also written into the deployed stamp (`buildInputs`), so any machine can judge a skip
// from the live deployment; this local copy is only the fallback for a stamp that predates it. Any machine
// with neither builds as before, which is the safe direction.
const recordDir = () => process.env.PLANE_BUILD_INPUTS_DIR || path.join(os.homedir(), ".connections", "plane-web-build-inputs");
const recordPath = (plane, sha) => path.join(recordDir(), plane, `${sha}.json`);

export function saveRecord(plane, sha, record) {
  mkdirSync(path.dirname(recordPath(plane, sha)), { recursive: true });
  writeFileSync(recordPath(plane, sha), `${JSON.stringify(normaliseRecord(record))}\n`);
}

/** A record the live deployment carries, only when it hashes to the digest that same stamp names. */
export function recordFromStamp(buildInputs, digest) {
  if (!digest || !buildInputs || typeof buildInputs !== "object") return null;
  try {
    const record = normaliseRecord(buildInputs);
    return recordDigest(record) === digest ? record : null;
  } catch {
    return null;
  }
}

/** The record for a live build, only when it hashes to the digest that build's stamp carries. */
export function loadRecord(plane, sha, digest) {
  const file = recordPath(plane, sha);
  if (!digest || !existsSync(file)) return null;
  try {
    const record = normaliseRecord(JSON.parse(readFileSync(file, "utf8")));
    return recordDigest(record) === digest ? record : null;
  } catch {
    return null;
  }
}
