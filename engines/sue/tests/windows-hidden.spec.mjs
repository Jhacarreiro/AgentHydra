/**
 * windows-hidden.spec - every process SUE and Dredd start names `windowsHide`, so none opens a console window.
 * ============================================================================================================
 *
 * WHAT: `node --test sue/tests/windows-hidden.spec.mjs`. Reads every non-test .mjs file under sue and
 * dredd, finds each child_process call (spawn, spawnSync, execFile, execFileSync, exec, execSync, fork) and
 * asserts its arguments say `windowsHide`. `windowsHide: false` passes too: it is a decision written down (the
 * Chrome a person signs in through must be seen).
 *
 * WHY IT EXISTS: Owner, 2026-10-06: every process SUE or its helpers start on Windows stays hidden. Node opens a new
 * console window for a console program started without it whenever the parent has none (a detached or hidden
 * parent, which is how SUE's runners, Dredd's hearings and the MCP door all live); another chat's helper that
 * forgot it opened a terminal every few seconds until it was fixed the same day.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const TOOLS = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const ROOTS = [path.join(TOOLS, "sue"), path.join(TOOLS, "dredd")];
/** Run folders hold what a run wrote, `state/` (gitignored) holds engine copies of other trees' code, and tests start
 * what they test: none of them is SUE starting a process. */
const SKIP_DIRS = new Set(["node_modules", "tests", "runs", "state", "__pycache__"]);
const STARTERS = new Set(["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]);
const CP = String.raw`["'](?:node:)?child_process["']`;
const NAMED_IMPORT = new RegExp(String.raw`import\s*\{([^}]*)\}\s*from\s*${CP}`, "g");
const NAMED_LOAD = new RegExp(String.raw`(?:const|let|var)\s*\{([^}]*)\}\s*=[^;]*?(?:require|import)\s*\(\s*${CP}\s*\)`, "g");
const WHOLE_IMPORT = new RegExp(String.raw`import\s+(?:\*\s+as\s+)?([\w$]+)\s+from\s*${CP}`, "g");
const WHOLE_LOAD = new RegExp(String.raw`(?:const|let|var)\s+([\w$]+)\s*=[^;]*?(?:require|import)\s*\(\s*${CP}\s*\)`, "g");

/** The local names a file binds to child_process's starters (`spawn`, `spawn as run`, `{ spawn: run }`) and to the
 * module itself (`import * as cp`), so `exec` the RegExp method or an injected parameter is never mistaken for one. */
function bindings(src) {
  const calls = new Set();
  const modules = new Set();
  for (const re of [NAMED_IMPORT, NAMED_LOAD])
    for (const [, list] of src.matchAll(re))
      for (const part of list.split(",")) {
        const [name, local = name] = part.split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
        if (STARTERS.has(name)) calls.add(local);
      }
  for (const re of [WHOLE_IMPORT, WHOLE_LOAD]) for (const [, name] of src.matchAll(re)) modules.add(name);
  return { calls, modules };
}

function sources(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) sources(full, out);
    else if (entry.name.endsWith(".mjs") && !entry.name.endsWith(".spec.mjs")) out.push(full);
  }
  return out;
}

/** The text between a call's parentheses, skipping strings and comments; null when it never closes. */
export function callArgs(src, open) {
  let depth = 1;
  for (let i = open + 1; i < src.length; i += 1) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") i = src.indexOf("\n", i) === -1 ? src.length : src.indexOf("\n", i);
    else if (c === "/" && src[i + 1] === "*") i = src.indexOf("*/", i + 2) + 1;
    else if (c === '"' || c === "'" || c === "`") {
      for (i += 1; i < src.length && src[i] !== c; i += 1) if (src[i] === "\\") i += 1;
    } else if (c === "(") depth += 1;
    else if (c === ")" && (depth -= 1) === 0) return src.slice(open + 1, i);
  }
  return null;
}

/** Every process-starting call in one file's text that does not say windowsHide, as `line: call`. */
export function unhidden(src) {
  const { calls, modules } = bindings(src);
  if (!calls.size && !modules.size) return [];
  const alt = (names) => [...names].map((n) => n.replace(/\$/g, "\\$")).join("|");
  const shapes = [];
  if (calls.size) shapes.push(`(?:${alt(calls)})`);
  if (modules.size) shapes.push(`(?:${alt(modules)})\\s*\\.\\s*(?:${alt(STARTERS)})`);
  const out = [];
  for (const m of src.matchAll(new RegExp(String.raw`(?<![\w$.])(?:${shapes.join("|")})\s*\(`, "g"))) {
    const [whole] = m;
    const before = src.slice(Math.max(0, m.index - 30), m.index);
    if (/\b(function|async)\s*\*?\s*$/.test(before) || /\bnew\s+$/.test(before)) continue; // a declaration
    const lineStart = src.lastIndexOf("\n", m.index) + 1;
    if (/^\s*(\/\/|\*)/.test(src.slice(lineStart, m.index))) continue; // a comment
    const args = callArgs(src, m.index + whole.length - 1);
    if (args === null || /\bwindowsHide\b/.test(args)) continue;
    out.push(`${src.slice(0, m.index).split("\n").length}: ${src.slice(m.index, m.index + 90).split("\n")[0]}`);
  }
  return out;
}

test("the scanner reads a call's own arguments, past strings and comments", () => {
  const named = 'import { spawn, spawnSync, execFileSync, exec } from "node:child_process";\n';
  assert.deepEqual(unhidden(`${named}spawn("git", ["(", ")"], { windowsHide: true });`), []);
  assert.deepEqual(unhidden(`${named}spawnSync(bin, [], {\n  // ) not the end\n  windowsHide: false,\n});`), []);
  assert.equal(unhidden(`${named}execFileSync("git", args, { encoding: "utf8" });`).length, 1);
  assert.equal(unhidden('import * as cp from "child_process";\ncp.fork(file, [], { stdio: "ignore" });').length, 1);
  assert.equal(unhidden('import { spawn as run } from "node:child_process";\nrun("git", []);').length, 1, "an alias");
  assert.equal(unhidden('const { spawn } = await import("node:child_process");\nspawn("x", []);').length, 1, "a dynamic import");
  assert.deepEqual(unhidden(`${named}const m = /^(\\d+)$/.exec(line);`), [], "a RegExp's exec is not a process");
  assert.deepEqual(unhidden(`${named}async function exec(line) {}\nexport function spawn(x) {}`), [], "a declaration is not a call");
  assert.deepEqual(unhidden("async function f({ exec = powershell }) { await exec(cmd); }"), [], "an injected exec is not child_process's");
});

test("every process SUE and Dredd start says windowsHide (Owner, 2026-10-06)", () => {
  const missing = [];
  for (const root of ROOTS)
    for (const file of sources(root))
      for (const hit of unhidden(fs.readFileSync(file, "utf8")))
        missing.push(`${path.relative(TOOLS, file).split(path.sep).join("/")}:${hit}`);
  assert.deepEqual(missing, [], `these start a process without windowsHide (add windowsHide: true):\n${missing.join("\n")}`);
});
