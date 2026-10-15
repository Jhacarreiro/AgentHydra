/**
 * run-start - has a run that `sue run` just started actually come up, and if it died, why?
 *
 * `sue run` answers the moment its detached runner is spawned. On 2026-09-24 (run 20260924-185204-fcc0)
 * that answer was `ok:true` about a run whose mailroom had already died and stopped it: the relay never
 * opened, and five Opus agents polled `hand.mjs` for 4 to 12 minutes each, told only "it has not started
 * yet, or it is over". Two readers need the same judgment from the run's own records:
 *
 *   - `sue run` (sue.mjs main), which now waits until the run is up or dead before it answers, so the
 *     caller never sends a brain at a relay that will never open;
 *   - a move with no relay to go to (lib/hand-move.mjs), which says the run was stopped and why instead
 *     of the generic line.
 *
 * `home` is the SUE_HOME the run was started under, for a caller whose own environment has another (the
 * MCP door, where the installed Sue app names its home in its marker). Same layout as run-dir.mjs and
 * door.mjs: `<home>/runs/<runId>` and `<home>/state/mcp/<runId>.{status.json,log}`.
 */

import fs from "node:fs";
import path from "node:path";

import { RELAY_FILE } from "./body-relay.mjs";
import { runDir, stateRoot } from "./run-dir.mjs";

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return "";
  }
}

function paths(runId, home) {
  const root = home ? path.resolve(home) : null;
  const dir = root ? path.join(root, "runs", runId) : runDir(runId);
  const state = root ? path.join(root, "state", "mcp") : path.join(stateRoot(), "mcp");
  return { dir, status: path.join(state, `${runId}.status.json`), log: path.join(state, `${runId}.log`) };
}

/** The run's own records, read once: the runner's status, the cannon's log, the mailroom's log, and
 *  whether the relay is open / any Sue has started. */
export function readRunStart(runId, { home } = {}) {
  const p = paths(runId, home);
  let status;
  try {
    status = JSON.parse(readText(p.status) || "null");
  } catch {
    status = null;
  }
  let suesStarted;
  try {
    suesStarted = fs.readdirSync(p.dir).some((n) => n.startsWith("sue-"));
  } catch {
    suesStarted = false;
  }
  return {
    status,
    log: readText(p.log),
    mailroomLog: readText(path.join(p.dir, "mailroom.log")),
    relayOpen: fs.existsSync(path.join(p.dir, RELAY_FILE)),
    suesStarted,
  };
}

/** The cannon's last `STOPPING: <why>` line, or null. */
export function stoppedBecause(log) {
  const lines = String(log ?? "")
    .split(/\r?\n/)
    .map((l) => l.match(/\bSTOPPING: (.+)$/))
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1][1].trim() : null;
}

/**
 * Pure: `{ dead: why }` when the run refused, failed or stopped; `{ up: true }` when a caller can use it
 * now (a chat run's relay is open, any other run has a Sue started, and a mailroom that was started has
 * logged that it is serving); null while it is still on its way.
 */
export function runStartVerdict({ status, log, mailroomLog, relayOpen, suesStarted, chat }) {
  if (status && (status.state === "refused" || status.state === "failed")) {
    const why = [...(status.why ?? []), status.error].filter(Boolean).join("; ");
    return { dead: why || `the run ${status.state}` };
  }
  const stopped = stoppedBecause(log);
  if (stopped) return { dead: stopped };
  if (status && /^finished/.test(status.state ?? "")) return { up: true };
  const mailroomUp = !/mailroom started \(pid/.test(log ?? "") || /serving run/.test(mailroomLog ?? "");
  const started = chat ? relayOpen : suesStarted;
  return started && mailroomUp ? { up: true } : null;
}

/** Why a move found no relay, in the run's own words, or null when the records do not say. */
export function whyNoRelay(runId, { home } = {}) {
  const records = readRunStart(runId, { home });
  if (!records.status && !records.log) return null;
  const verdict = runStartVerdict({ ...records, chat: true });
  if (verdict?.dead) return `Run ${runId} was stopped: ${verdict.dead}`;
  if (records.status && /^finished/.test(records.status.state ?? "")) return `Run ${runId} is over (${records.status.state}).`;
  return null;
}

/**
 * Waits until the run `sue run` just started is up or dead, and returns the answer to give: the original
 * one when it is up, `ok:false` with the run's own reason when it is dead, and the original one with a
 * `starting` note when it is still on its way at the deadline (never a guess that it died).
 */
export async function awaitRunStart(answer, { timeoutMs = 75_000, pollMs = 500, home, read = readRunStart } = {}) {
  if (!answer?.ok || !answer.runId) return answer;
  const chat = Boolean(answer.chatBrains);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const verdict = runStartVerdict({ ...read(answer.runId, { home }), chat });
    if (verdict?.dead)
      return {
        ...answer,
        ok: false,
        error: `run ${answer.runId} did not come up: ${verdict.dead}`,
        next: 'Nothing is running: send no brain at it. Fix the cause named above and start a new run (action "status" shows the same reason).',
      };
    if (verdict?.up) return answer;
    if (Date.now() >= deadline)
      return {
        ...answer,
        starting: `still starting after ${Math.round(timeoutMs / 1000)}s: ${chat ? "its relay is not open yet" : "no Sue has started yet"}; ask action "status" before sending anyone`,
      };
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}
