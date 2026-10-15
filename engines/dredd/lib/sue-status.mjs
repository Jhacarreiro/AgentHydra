// dredd/lib/sue-status.mjs - the one reader of a SUE run's status, shared by the hearing's field wait, the collector
// and the convene's refusal poll. There were three, each with its own spawn, its own parser and its own idea of
// "done" (the Opus 5.5 review, 2026-09-22): the hearing waited on a run the collector already called over, and one
// copy went through the shell for no reason. sue.mjs `status` answers { ok, runId, state, expected, launched,
// finished, costUsdSoFar, lastLog, ... } (sue/sue.mjs runStatus).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** SUE's own entry point, by its place beside Dredd in the engine's checkout: she resolves her runs and state from her
 *  own folder, so she answers from any cwd, and a hearing on another repository (--root) reads her runs the same way.
 *  The cwd stays the judged repository - it is her workspace (sue/lib/workspace.mjs). */
export const SUE_SCRIPT = fileURLToPath(new URL("../../sue/sue.mjs", import.meta.url));

/** The JSON object a sue.mjs command prints (status, report): the first line that begins with a brace, to the end; null when none. */
export function parseSueJson(stdout) {
  const text = String(stdout || "");
  const line = text.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) return null;
  try {
    return JSON.parse(text.slice(text.indexOf(line)));
  } catch {
    return null;
  }
}

/** SUE's status for one run, or null when the cannon could not be read. The JSON rides as one argv element, no shell. */
/** `script` is SUE's entry point, SUE_SCRIPT unless a test stands one in. */
export function sueStatus(root, runId, { timeoutMs = 60_000, script = SUE_SCRIPT } = {}) {
  const r = spawnSync(process.execPath, [script, "status", "--json", JSON.stringify({ runId })], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
    timeout: timeoutMs,
  });
  return parseSueJson(r.stdout);
}

/** States after which nothing more will come: a run that finished, was refused, or whose process died ("stopped"). */
const OVER = new Set(["finished", "refused", "stopped", "failed"]);

/** Whether a run is over, by the one rule every reader shares: an ending state, or every expected Sue finished. */
export function sueOver(st) {
  if (!st) return false;
  if (OVER.has(st.state)) return true;
  return typeof st.expected === "number" && st.expected > 0 && typeof st.finished === "number" && st.finished >= st.expected;
}

/** "finished 3/5" - the progress line every reader prints. */
export function sueProgress(st) {
  return `${st?.state || "no status"} ${st?.finished ?? 0}/${st?.expected ?? "?"}`;
}
