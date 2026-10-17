#!/usr/bin/env node
/**
 * Pre-push kit drift gate: refuse a push that carries a kit-synced file away from the kit, judged by
 * what the push contains, as the pre-commit guard (check-kit-sync-staged.mjs) judges a commit by what
 * it stages.
 *
 * It replaced `bun run check:local` in .githooks/pre-push, which ran `sync.mjs --check` over the whole
 * working tree. This tree has many sessions editing at once, so one session's unfinished, uncommitted
 * edit to a synced file blocked every other session's push however unrelated (2026-10-05: five tray
 * host files edited in the working tree for hours held a Desk 2 and CliMayte push that touched none of
 * them).
 *
 * A drifted file (the kit reports it `differs`, `missing` or `orphan`) blocks the push only when a commit
 * in the push changes, deletes or adds it. Drift the push does not change (someone's uncommitted edit,
 * an untracked file in a synced folder, or a copy already on the remote) is named and left alone: the
 * remote keeps the copy it had, and whoever changes that file next is held to the kit. Reading only
 * `differs` let one session's untracked probe test under server/tests/server-lib/ refuse every other
 * session's push (2026-10-11). Any other failure of the kit check (nothing it calls drifted) still
 * refuses the push. An uncommitted kit is judged the same way: it refuses a push only when the push
 * carries a copy of an uncommitted kit file (its content), and is otherwise named and left alone.
 *
 * It never reimplements the kit's path rules: it runs `sync.mjs --check --app <key>` and reads that
 * report. Without the sibling kit checkout it exits 0 (pre-push already says so before calling it).
 *
 * Usage: node .githooks/check-kit-sync-pushed.mjs <remote> <kit.config app key>...  (refs on stdin)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const [remote, ...apps] = process.argv.slice(2);
if (!remote || apps.length === 0) {
  console.error("check-kit-sync-pushed: usage: <remote> <app key>...  (refs on stdin)");
  process.exit(2);
}

const REPO = process.cwd();
const KIT = resolve(REPO, "..", "..", "lunarwerx-ui");
if (!existsSync(join(KIT, "sync.mjs"))) process.exit(0);

const norm = (p) => p.replace(/\\/g, "/").toLowerCase();
const git = (args) => execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const lines = (s) => s.split("\n").map((l) => l.trim()).filter(Boolean);

// The kit's report names files under the main checkout (kit.config.json's fixed paths), while this push
// may run from a linked worktree: both sides are compared as paths inside the repo.
const mainRoot = norm(resolve(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(), ".."));
const inRepo = (abs) => {
  const n = norm(abs);
  return n.startsWith(`${mainRoot}/`) ? n.slice(mainRoot.length + 1) : n;
};

// Files the push changes: every commit it sends that the remote does not have yet. `pushedAt` keeps each
// path as git spells it with the pushed commit it is read at (tree paths are case-sensitive).
const pushed = new Set();
const pushedAt = new Map();
const ZERO = /^0+$/;
for (const line of lines(readFileSync(0, "utf8"))) {
  const [, localSha] = line.split(/\s+/);
  if (!localSha || ZERO.test(localSha)) continue; // a deletion sends no files
  // Unquoted: a quoted path (git's default for one with non-ASCII bytes) names no blob in `<sha>:<path>` below.
  for (const p of lines(git(["-c", "core.quotePath=false", "log", "--name-only", "--format=", localSha, "--not", `--remotes=${remote}`]))) {
    pushed.add(norm(p));
    pushedAt.set(p, localSha);
  }
}

let failed = false;
for (const app of apps) {
  let report = "";
  let ok = true;
  try {
    // Drift only: the kit's "uncommitted kit" half is judged below by what this push carries.
    report = execFileSync("node", [join(KIT, "sync.mjs"), "--check", "--app", app], {
      cwd: KIT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, LUNARWERX_KIT_ALLOW_DIRTY: "1" },
    });
  } catch (err) {
    ok = false;
    report = `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
  if (ok) continue;
  // Report lines look like:  "      ! differs  D:/path/to/file.ts"  (also `missing` and `orphan`)
  const drifted = [...report.matchAll(/^\s*!\s+(?:differs|missing|orphan)\s+(.+?)\s*$/gm)].map((m) =>
    m[1].replace(/\\/g, "/"),
  );
  if (drifted.length === 0) {
    console.error(report);
    console.error(`✗ kit check for ${app} failed (see above).`);
    failed = true;
    continue;
  }
  const carried = drifted.filter((p) => pushed.has(inRepo(p)));
  const inProgress = drifted.filter((p) => !carried.includes(p));
  if (inProgress.length)
    console.error(
      [`› kit drift this push does not change (${app}), left alone:`, ...inProgress.map((p) => `    ${p}`)].join("\n"),
    );
  if (carried.length) {
    console.error(
      [
        "",
        `✗ this push carries kit-synced files that differ from the kit (${app}):`,
        ...carried.map((p) => `    ${p}`),
        "",
        `  Make the edit in ${KIT.replace(/\\/g, "/")}/src/..., run \`node sync.mjs\` there, and commit the`,
        "  kit and the re-synced app copies.",
        "",
      ].join("\n"),
    );
    failed = true;
  }
}

// The kit's other half: an app copy synced from a kit file only this machine has (uncommitted in the kit)
// is what a fresh clone plus a sync reverts. A pushed file whose content is a dirty kit file's working copy
// refuses the push; anyone's unfinished kit edit the push carries no copy of is named and left alone, as
// drift is. Before, the kit's check refused every push while any kit file was dirty (2026-10-17: four
// tray-host files mid-edit in the kit held a two-file AgentHydra CI fix that touched none of them).
const dirty = dirtyKitFiles();
if (dirty.length) {
  const body = (s) => s.replace(/\r\n/g, "\n");
  const kitCopy = new Map();
  for (const f of dirty) {
    try {
      const text = body(readFileSync(join(KIT, f), "utf8"));
      if (text) kitCopy.set(text, f);
    } catch {
      // not in the kit's working tree: there is no text for a copy to match
    }
  }
  const copies = [];
  let unread = null;
  try {
    // A copy is the kit text with LF or CRLF line ends: at most twice its length, so no larger blob is read.
    const most = 2 * Math.max(0, ...[...kitCopy.keys()].map((text) => Buffer.byteLength(text)));
    for (const [path, text] of pushedContents(most)) {
      const from = kitCopy.get(body(text));
      if (from) copies.push(`    ${path}  (the kit's ${from})`);
    }
  } catch (err) {
    unread = err instanceof Error ? err.message : String(err);
  }
  if (unread !== null) {
    console.error(
      `\n✗ the kit has ${dirty.length} uncommitted file(s), and the pushed files could not be read to tell whether this push carries a copy of one: ${unread}\n`,
    );
    failed = true;
  } else if (copies.length) {
    console.error(
      [
        "",
        "✗ this push carries copies of kit files that are not committed in the kit:",
        ...copies,
        "",
        `  Commit them in ${KIT.replace(/\\/g, "/")} first: a fresh clone plus a sync would revert these copies.`,
        "",
      ].join("\n"),
    );
    failed = true;
  } else {
    console.error(
      [`› the kit has ${dirty.length} uncommitted file(s) this push carries no copy of, left alone:`, ...dirty.map((f) => `    ${f}`)].join("\n"),
    );
  }
}
process.exit(failed ? 1 : 0);

/** The kit's uncommitted synced source (`src/`, kit.config.json), as the kit's own check lists it; none when
 *  the kit folder is not its own checkout. The hook's GIT_* variables are dropped so git asks the kit. */
function dirtyKitFiles() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const kitGit = (args) => execFileSync("git", args, { cwd: KIT, env, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    if (norm(resolve(kitGit(["rev-parse", "--show-toplevel"]).trim())) !== norm(KIT)) return [];
    // Untrimmed: a porcelain line's status takes its first two columns, the first one often a space.
    return kitGit(["status", "--porcelain", "--", "src", "kit.config.json"])
      .split("\n")
      .filter((l) => l.length > 3)
      .map((l) => l.slice(3).replace(/^.* -> /, "").replace(/^"|"$/g, ""));
  } catch {
    return [];
  }
}

/** [path, text] of every pushed file of at most `maxBytes` as its pushed commit holds it (a file the push deletes has
 *  none). Sizes are asked first, so a large binary in the push is never read. */
function pushedContents(maxBytes) {
  if (pushedAt.size === 0) return [];
  const spec = (p) => `${pushedAt.get(p)}:${p}\n`;
  const paths = [...pushedAt.keys()];
  // Each answer is `<oid> blob <size>`, or `<spec> missing` for a path deleted at that commit.
  const sizes = execFileSync("git", ["cat-file", "--batch-check=%(objecttype) %(objectsize)"], {
    input: paths.map(spec).join(""),
    encoding: "utf8",
  }).split("\n");
  const small = paths.filter((_, i) => {
    const [type, size] = (sizes[i] ?? "").split(" ");
    return type === "blob" && Number(size) <= maxBytes;
  });
  if (small.length === 0) return [];
  const out = execFileSync("git", ["cat-file", "--batch"], { input: small.map(spec).join(""), maxBuffer: 64 * 1024 * 1024 });
  const files = [];
  let at = 0;
  for (const path of small) {
    const eol = out.indexOf(0x0a, at);
    const size = Number(out.toString("utf8", at, eol).split(" ")[2]);
    at = eol + 1;
    files.push([path, out.toString("utf8", at, at + size)]);
    at += size + 1;
  }
  return files;
}
