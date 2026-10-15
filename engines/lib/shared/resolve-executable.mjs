// vendored from Connections scripts/lib/resolve-executable.mjs @ dd3d47a7ad
/**
 * resolve-executable - find a directly-spawnable binary on PATH, no shell.
 * =======================================================================
 * The single home for "locate `git` / `cloudflared` / … on PATH so we can
 * `execFileSync`/`spawn` it WITHOUT `{ shell: true }`."
 *
 * Why this exists: passing an args ARRAY together with `{ shell: true }` trips
 * Node's DEP0190 deprecation (the args get concatenated into the shell command
 * line unescaped - an injection footgun), which surfaces as a stderr "error" on
 * every dev-server / dev-tool start. The historical reason for `shell: true` was
 * only so Windows could find a binary's `.exe`/`.cmd` shim on PATH. Resolving the
 * real executable here lets the caller spawn it DIRECTLY with an args array - no
 * shell, no escaping, no deprecation - cross-platform.
 *
 * Pure `fs` (no child process, so it can't itself recurse into a spawn). Only a
 * DIRECTLY-executable match is returned - `.exe`/`.com` on Windows (via PATHEXT),
 * no-extension elsewhere - because a `.cmd`/`.bat` shim cannot be run without a
 * shell anyway; for those, resolution falls back to the bare name and lets the OS
 * loader try (a standard Git/cloudflared install ships a real `.exe`).
 */
import fs from "node:fs";
import { delimiter, join } from "node:path";

/**
 * Search every directory on PATH for `name` + one of `exts` (each including its own leading
 * dot, or `""` for no extension), returning the first existing regular file, or `undefined` if
 * none matches. Shared inner loop between {@link resolveExecutable} (PATHEXT-derived extensions)
 * and `resolveWindowsShim` below (fixed `.cmd`/`.bat`) - the two callers previously hand-spelled
 * this identical double loop, differing only in their extension list and their not-found return
 * value; each now post-processes the `undefined` case into its own contract (echo `name` vs
 * `null`). Hoisted 2026-07-21 (scripts-dir-duplication harvest).
 *
 * @param {string} name
 * @param {string[]} exts
 * @returns {string | undefined}
 */
function findOnPath(name, exts) {
  for (const dir of (process.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const cand = join(dir, `${name}${ext}`);
      try {
        if (fs.statSync(cand).isFile()) return cand;
      } catch {
        /* not in this PATH entry - keep looking */
      }
    }
  }
  return undefined;
}

/**
 * Absolute path to `name`'s directly-executable binary on PATH, or `name` itself
 * when none is found (so a caller's own spawn error handling still applies).
 *
 * @param {string} name  Executable base name, e.g. "git" or "cloudflared".
 * @returns {string}     Resolved absolute path, or the bare `name` as a fallback.
 */
export function resolveExecutable(name) {
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT || ".EXE;.COM")
          .split(";")
          .map((e) => e.toLowerCase())
          .filter((e) => e === ".exe" || e === ".com")
      : [""];
  return findOnPath(name, exts) ?? name;
}

/** Locate a Windows `.cmd`/`.bat` shim for `name` on PATH (returns the absolute path or null). */
function resolveWindowsShim(name) {
  return findOnPath(name, [".cmd", ".bat"]) ?? null;
}

/**
 * The spawn shape for a Windows `.cmd`/`.bat` shim.
 *
 * A pip-installed console script (the AWS CLI v1 is the one this repo runs) ships as TWO files:
 * `<name>.cmd`, a batch/python polyglot, and `<name>`, the real script, whose shebang names the exact
 * interpreter pip installed it into. The `.cmd` can only run through cmd.exe, and it pays for that on
 * every call: it runs `assoc .py`, which prints "File association not found for extension .py" on a
 * box with no `.py` association (measured 2026-09-15: every pinned web build printed it per aws call,
 * and it was the only output of a stalled signed publish, where it read like the failure), and cmd
 * mangles arguments on the way through (it cuts one at a newline and passes quotes through literally,
 * see scripts/aws/ops/aurora-pause-blockers.mjs). So when the sibling script's shebang names a python
 * interpreter that exists, run that interpreter on the script directly. Anything else keeps
 * `cmd.exe /c <shim>`.
 *
 * @param {string} shimPath  Path to a `.cmd`/`.bat` shim.
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function spawnForWindowsShim(shimPath) {
  return pythonScriptBeside(shimPath) ?? { command: process.env.ComSpec || "cmd.exe", prefixArgs: ["/c", shimPath] };
}

/** `{ command: <interpreter>, prefixArgs: [<script>] }` for a shim's shebang sibling, or null. */
function pythonScriptBeside(shimPath) {
  const script = shimPath.replace(/\.(cmd|bat)$/i, "");
  if (script === shimPath) return null;
  let firstLine;
  try {
    const fd = fs.openSync(script, "r");
    try {
      const head = Buffer.alloc(512);
      firstLine = head
        .subarray(0, fs.readSync(fd, head, 0, head.length, 0))
        .toString("utf8")
        .split(/\r?\n/, 1)[0];
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null; // no sibling script (or it is unreadable) - the shim is all there is
  }
  const shebang = firstLine.match(/^#!\s*(?:"([^"]+)"|(\S+))/);
  const interpreter = shebang ? (shebang[1] ?? shebang[2]) : null;
  if (!interpreter || !/python[\w.]*\.exe$/i.test(interpreter)) return null;
  try {
    if (!fs.statSync(interpreter).isFile()) return null;
  } catch {
    return null; // the interpreter pip wrote down is gone - cmd.exe's own lookup is the better bet
  }
  return { command: interpreter, prefixArgs: [script] };
}

/**
 * Resolve `name` (a bare command like "aws" OR an explicit path, possibly a `.cmd`/`.bat` shim) into
 * a directly-`execFileSync`-able `{ command, prefixArgs }` pair that needs **no** `{ shell: true }` -
 * so the caller spawns without tripping Node's DEP0190 (args-array + shell) footgun.
 *
 *  - A directly-executable match (`.exe`/`.com` on Windows, no-ext elsewhere) → run it directly.
 *  - A Windows `.cmd`/`.bat` shim (the shape the AWS CLI usually ships as): when it is a pip console
 *    script, its own python interpreter runs the sibling script directly ({@link spawnForWindowsShim});
 *    otherwise it cannot be spawned without a shell, so we run it through `cmd.exe /c <shim> <args>` -
 *    which is NOT the `shell:true` code path and therefore does NOT trip DEP0190 (the args stay a real
 *    argv, unescaped-concatenation-free).
 *
 * @param {string} name  Command base name or explicit path, e.g. "aws" or "C:/…/aws.cmd".
 * @returns {{ command: string, prefixArgs: string[] }}
 */
export function resolveSpawn(name) {
  const isWin = process.platform === "win32";
  const comSpec = process.env.ComSpec || "cmd.exe";
  // An explicit `.cmd`/`.bat` path (e.g. AWS_CLI pointing at aws.cmd).
  if (isWin && /\.(cmd|bat)$/i.test(name)) {
    return spawnForWindowsShim(name);
  }
  // A directly-spawnable binary (resolved on PATH, or already an explicit .exe path).
  const direct = resolveExecutable(name);
  if (direct !== name || /[\\/]/.test(name)) {
    return { command: direct, prefixArgs: [] };
  }
  // Bare name with no directly-executable match. On Windows, prefer a resolved `.cmd`/`.bat` shim,
  // else let cmd.exe resolve the bare name; elsewhere let the OS loader try the bare name.
  if (isWin) {
    const shim = resolveWindowsShim(name);
    return shim ? spawnForWindowsShim(shim) : { command: comSpec, prefixArgs: ["/c", name] };
  }
  return { command: name, prefixArgs: [] };
}
