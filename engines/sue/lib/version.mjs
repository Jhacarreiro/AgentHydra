/**
 * version - which SUE ran a wave, so a score can be read against the SUE that gave it.
 * ======================================================================================
 *
 * Owner ask (Owner, 2026-09-23): "we need to add version numbers to sue ... so we know when sue has
 * been updated so maybe version 0.1 sue was run and we are on 2.8 version".
 *
 * Nobody bumps it by hand, because SUE changes many times a day and a hand-kept number would be
 * stale by the evening. The number before the dot is declared here: raise `SUE_MAJOR` and move
 * `SUE_MAJOR_FROM` to the commit that did it when SUE changes so much that old scores should not be
 * compared with new ones. The number after the dot counts every commit since `SUE_MAJOR_FROM` that
 * changed `sue`, so each change to SUE that lands is the next version by itself. Every machine
 * on the same commit reads the same number.
 *
 * A Sue runs the bytes on THIS disk, which on a shared tree are often ahead of the last commit. Those
 * are counted as `local` (files under `sue` that differ from the commit), and the label says so,
 * so "1.7" always means exactly the landed 1.7.
 *
 * An installed Sue has no git, so every one read "SUE 1.?" (Owner, 2026-09-24: "Please put the version
 * number on the settings page. And also probably baked into the installer as well."). The installer's
 * staging (desktop/stage-engine.mjs) counts the version with this same counter, at the commit it staged,
 * and leaves it beside the engine as `sue-version.json` with the app's own version. Where that stamp is,
 * it is the answer; a checkout has none and asks git as before.
 */
import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** SUE's own folder: the git calls read this, never the workspace a wave was sent from. */
export const SUE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const SUE_MAJOR = 1;
/** The commit SUE 1.0 is: the first commit in this standalone history (2026-06-01); the former Connections baseline is absent here. */
export const SUE_MAJOR_FROM = "7913a8f0579326214ef253b4ea2dbabd4771730d";

/** The installer's stamp, beside the engine (SUE_ROOT/sue-version.json); written only into a staged copy. */
export const STAMP_FILE = "sue-version.json";

const GIT_TIMEOUT_MS = 5000;

const countArgs = (rev) => ["rev-list", "--count", `${SUE_MAJOR_FROM}..${rev}`, "--", "."];
const commitArgs = (rev) => ["rev-parse", "--short=10", rev];
const COUNT_ARGS = countArgs("HEAD");
const COMMIT_ARGS = commitArgs("HEAD");
const LOCAL_ARGS = ["status", "--porcelain", "--untracked-files=normal", "--", "."];

/**
 * The stamp, from what git said. Pure, so a test never needs a repo. A git that did not answer gives
 * `SUE 1.?`, never a guessed number. `app` is the installed app's own version, known only from the
 * installer's stamp.
 */
export function stampFrom({ count, commit, status, app = null }) {
  const n = Number.parseInt(String(count ?? "").trim(), 10);
  const version = Number.isInteger(n) && n >= 0 ? `${SUE_MAJOR}.${n}` : `${SUE_MAJOR}.?`;
  const sha = String(commit ?? "").trim() || null;
  const local =
    status == null
      ? null
      : String(status)
          .split("\n")
          .filter((l) => l.trim()).length;
  const label = local ? `SUE ${version} + ${local} unlanded ${local === 1 ? "file" : "files"}` : `SUE ${version}`;
  return { version, commit: sha, local, label, app };
}

/**
 * The installer's stamp beside the engine, or null when there is none or it cannot be read (then git
 * answers, as in a checkout). A stamp is landed code by definition, so it has no unlanded files.
 */
export function readStamp(root = SUE_ROOT) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(root, STAMP_FILE), "utf8"));
  } catch {
    return null;
  }
  const version = typeof raw?.sue === "string" ? raw.sue.trim() : "";
  if (!/^\d+\.\d+$/.test(version)) return null;
  const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { version, commit: text(raw.commit), local: 0, label: `SUE ${version}`, app: text(raw.app) };
}

/** SUE's version as landed at `rev` (a commit, or `origin/main`), for the installer's stamp. */
export function readLandedVersion(rev, git = gitSync) {
  return stampFrom({ count: git(countArgs(rev)), commit: git(commitArgs(rev)), status: "" });
}

function gitSync(args) {
  try {
    return execFileSync("git", ["-C", SUE_ROOT, ...args], {
      encoding: "utf8",
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }
}

function gitAsync(args) {
  return new Promise((resolve) => {
    execFile("git", ["-C", SUE_ROOT, ...args], { encoding: "utf8", windowsHide: true, timeout: GIT_TIMEOUT_MS }, (err, stdout) =>
      resolve(err ? null : stdout),
    );
  });
}

const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The .git folder this checkout's files belong to (a worktree's `.git` file names it), or null. */
function gitDirOf(start) {
  for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
    const dotGit = path.join(dir, ".git");
    const stat = fs.statSync(dotGit, { throwIfNoEntry: false });
    if (stat?.isDirectory()) return dotGit;
    if (stat?.isFile()) {
      const named = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, "utf8"))?.[1]?.trim();
      return named ? path.resolve(dir, named) : null;
    }
    if (path.dirname(dir) === dir) return null;
  }
}

/** HEAD's commit read off the .git files themselves: a loose ref, then packed-refs; null when they do not say. */
function headFromFiles(root) {
  const gitDir = gitDirOf(root);
  if (!gitDir) return null;
  const head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  if (FULL_SHA.test(head)) return head;
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref) return null;
  // A worktree keeps its branches in the main repository's folder (its `commondir`).
  const commonFile = path.join(gitDir, "commondir");
  const common = fs.existsSync(commonFile) ? path.resolve(gitDir, fs.readFileSync(commonFile, "utf8").trim()) : gitDir;
  for (const dir of new Set([gitDir, common])) {
    const loose = path.join(dir, ref);
    if (fs.existsSync(loose)) {
      const sha = fs.readFileSync(loose, "utf8").trim();
      return FULL_SHA.test(sha) ? sha : null;
    }
  }
  const packed = path.join(common, "packed-refs");
  if (!fs.existsSync(packed)) return null;
  for (const line of fs.readFileSync(packed, "utf8").split("\n")) {
    const [sha, name] = line.trim().split(" ");
    if (name === ref && FULL_SHA.test(sha)) return sha;
  }
  return null;
}

/**
 * The full commit this checkout is on, at once: read off the .git files (no git process, which on a
 * busy PC takes seconds), else `git rev-parse HEAD` (a ref store the files do not show). null when
 * neither says; an installed Sue has its stamp instead (readStamp).
 */
export function readHeadCommit(root = SUE_ROOT, git = gitSync) {
  let fromFiles = null;
  try {
    fromFiles = headFromFiles(root);
  } catch {
    // A .git file mid-rewrite or not readable: git itself is the other witness, asked below.
  }
  if (fromFiles) return fromFiles;
  const sha = String(git(["rev-parse", "HEAD"]) ?? "").trim();
  return FULL_SHA.test(sha) ? sha : null;
}

/** The files under sue that differ from the commit, as `git status` lists them; null when git did not answer. */
export function readUnlandedAsync(git = gitAsync) {
  return git(LOCAL_ARGS);
}

/** SUE's version as landed at the full commit `sha`, off the event loop; `status` lists the unlanded files beside it. */
export async function readLandedVersionAsync(sha, status = "", git = gitAsync) {
  return stampFrom({ count: await git(countArgs(sha)), commit: String(sha).slice(0, 10), status });
}

/** SUE's version right now, read once per wave by `sue run` (about a second: `git status` is the slow part). */
export function readSueVersion(git = gitSync, root = SUE_ROOT) {
  const baked = readStamp(root);
  if (baked) return baked;
  return stampFrom({ count: git(COUNT_ARGS), commit: git(COMMIT_ARGS), status: git(LOCAL_ARGS) });
}

/** The same, off the event loop, for the Sue Manager's server. */
export async function readSueVersionAsync(git = gitAsync, root = SUE_ROOT) {
  const baked = readStamp(root);
  if (baked) return baked;
  const [count, commit, status] = await Promise.all([git(COUNT_ARGS), git(COMMIT_ARGS), git(LOCAL_ARGS)]);
  return stampFrom({ count, commit, status });
}
