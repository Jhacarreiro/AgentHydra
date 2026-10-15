/**
 * door - a wave starts one way: `sue run`.
 * ========================================
 *
 * Owner ask (Owner, 2026-09-23): "make sure we have it so no ai can/wants to not use the carefully
 * crafted sue manager as we have no reason not to have ai use it". `sue run` (the Connections MCP
 * `sue` tool, the Sue Manager's New wave, DREDD's hearings, `node sue/sue.mjs run`) is what
 * gives a wave its run record: the Manager's window and toolbar, `status`/`report`/`stop`, the
 * workspace's run ledger, every persona's journal and the page's scoreboard. A cannon started by hand
 * got none of it and was invisible to all of them, and launch-waves.ps1 and `bun run sue` did exactly
 * that until this door.
 *
 * So `sue run`'s runner hands the cannon its run id in `SUE_DOOR`, beside the status file it has
 * already written, and the cannon refuses to start a wave without both (a `--dry-run` still prints its
 * plan). Setting the variable by hand is not the point of a lock like this: it is there so no agent
 * gets a wave that nothing tracks by accident, and its refusal says which door to use.
 */
import fs from "node:fs";
import path from "node:path";

import { stateRoot } from "./run-dir.mjs";

export const DOOR_ENV = "SUE_DOOR";

/** Where `sue run` keeps each run's spec, status and log. One home: sue.mjs reads and writes it here. */
export const runStateDir = () => path.join(stateRoot(), "mcp");
export const runStatusFile = (runId) => path.join(runStateDir(), `${runId}.status.json`);

/** The environment `sue run`'s runner starts the cannon with. */
export function doorEnv(runId, env = process.env) {
  return { ...env, [DOOR_ENV]: runId };
}

/** True when this cannon was started by `sue run` for this very run. */
export function cameThroughSueRun({ runId, env = process.env, exists = fs.existsSync } = {}) {
  return Boolean(runId) && env[DOOR_ENV] === runId && exists(runStatusFile(runId));
}

export const DOOR_REFUSAL = [
  "a wave starts through `sue run`, never the cannon on its own.",
  'Use the Connections MCP `sue` tool (action "run"), the Sue Manager\'s New wave,',
  "or `node sue/sue.mjs run --json-file <args.json>` with {url, intent} (a roster errand: {target, scenario, personas}).",
  "That is what gives the wave a run the Sue Manager shows, status/report/stop, the persona journals and the page scoreboard.",
  "`--dry-run` still prints a plan here.",
].join(" ");
