// mcp/proc.mjs - what the sue and dredd tools share: where the engines are, how a refusal is said, how the engine runs.
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** This checkout's root: the server finds its engines beside itself, never at a fixed path. */
export const ROOT = path.resolve(import.meta.dirname, "..");

/** The engine folder `name` (sue or dredd) with `entry` in it: <NAME>_ENGINE_DIR when set (a stand-in engine, a
 *  developer's other checkout), else this checkout's own. Null when neither has it. */
export function engineDir(name, entry, { env = process.env } = {}) {
  for (const dir of [env[`${name.toUpperCase()}_ENGINE_DIR`], path.join(ROOT, name)]) {
    if (dir && existsSync(path.join(dir, entry))) return path.resolve(dir);
  }
  return null;
}

/** A refusal as an error result whose text is `{ error, detail, hint }`, so a client can tell nothing ran. */
export function toolFailure(code, detail, hint) {
  const body = { error: String(code) };
  if (detail) body.detail = String(detail);
  if (hint) body.hint = String(hint);
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
}

/** Runs `cmd args` to completion or its ceiling, killing the whole tree at the ceiling. Never throws. */
export function runProc(cmd, args, { cwd = ROOT, env = {}, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let timedOut = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      resolve({ code: null, stdout: "", stderr: String(e?.message || e), timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      else child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (c) => out.push(c));
    child.stderr.on("data", (c) => err.push(c));
    child.on("error", (e) => err.push(Buffer.from(String(e?.message || e))));
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), timedOut });
    });
  });
}

/** A run that answered nothing on stdout, said as the command, its exit and the tail of what it printed. */
export function fmt(label, { code, stdout = "", stderr = "", timedOut }) {
  const tail = (s) => String(s).trim().split("\n").slice(-40).join("\n");
  return [`${label}`, timedOut ? "timed out" : `exit ${code}`, tail(stdout), tail(stderr)].filter(Boolean).join("\n");
}
