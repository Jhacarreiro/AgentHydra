#!/usr/bin/env node
/**
 * dispatch - hand a running chat-brain wave's Sues to CliMayte, each as ONE sealed task (lib/climayte-dispatch.mjs).
 *
 *   node sue/dispatch.mjs <runId>            SUE sends every Sue waiting now, and each later one as she arrives
 *   node sue/dispatch.mjs <runId> --print    prints the climayte_run arguments for the Sues waiting now, sends nothing
 *
 * The first writes the run's dispatch.json, which the run's cannon watches for (the same dispatcher `--dispatch climayte`
 * turns on at the start), and waits for the cannon to accept it. A run whose engine predates the dispatcher never
 * accepts: this says so and prints the climayte_run arguments to send instead. Exit 0 = accepted (or printed),
 * 1 = refused (no such run, the run is over, CliMayte unavailable, not accepted).
 */
import fs from "node:fs";
import path from "node:path";

import { CHAT_BRAINS_FILE, RELAY_FILE } from "./lib/body-relay.mjs";
import { climayteGroup, climayteReady, DISPATCH_FILE, readDispatch, requestDispatch, tasksFor } from "./lib/climayte-dispatch.mjs";
import { runDir } from "./lib/run-dir.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const USAGE = "usage: node sue/dispatch.mjs <runId> [--print]";
const ACCEPT_WAIT_MS = 15_000;

function readIndex(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, CHAT_BRAINS_FILE), "utf8"));
  } catch {
    return null;
  }
}

/** The climayte_run arguments for every Sue of the run not yet sent. */
export function printable(runId, dir) {
  return { group: climayteGroup(runId), tasks: tasksFor(readIndex(dir), { runId }).map((t) => t.task) };
}

export async function main(
  words = process.argv.slice(2),
  { out = process.stdout, ready = climayteReady, waitMs = ACCEPT_WAIT_MS, stepMs = 500 } = {},
) {
  const runId = words.find((w) => !w.startsWith("--"));
  const say = (o, code) => {
    out.write(`${JSON.stringify(o, null, 2)}\n`);
    return code;
  };
  if (!runId || words.some((w) => w.startsWith("--") && w !== "--print")) {
    out.write(`${USAGE}\n`);
    return 1;
  }
  const dir = runDir(runId);
  if (!fs.existsSync(dir)) return say({ ok: false, error: `no SUE run ${runId}` }, 1);
  if (words.includes("--print")) return say({ ok: true, ...printable(runId, dir) }, 0);
  // The relay's file lives exactly as long as the run's relay: without it nobody is left to drive.
  if (!fs.existsSync(path.join(dir, RELAY_FILE)))
    return say({ ok: false, error: `run ${runId} is not a running chat-brain wave (it has no relay): nothing to send` }, 1);
  const probe = await ready();
  if (!probe.ready) return say({ ok: false, error: `CliMayte is unavailable: ${probe.why}` }, 1);
  requestDispatch(dir, { by: "dispatch.mjs" });
  for (let waited = 0; waited <= waitMs; waited += stepMs) {
    const state = readDispatch(dir);
    if (state?.acceptedAt) {
      const index = readIndex(dir);
      return say(
        {
          ok: true,
          runId,
          group: state.group,
          accepted: state.acceptedAt,
          said: `SUE sends every Sue of this run to CliMayte sealed as she arrives: start no agent for them. climayte_status { group: "${state.group}" } shows them.`,
          sues: (index?.sues ?? []).map((s) => ({
            sueId: s.sueId,
            role: s.role,
            worker: s.climayte?.worker ?? null,
            ...(s.dispatchError ? { dispatchError: s.dispatchError } : {}),
          })),
        },
        0,
      );
    }
    await new Promise((r) => setTimeout(r, stepMs));
  }
  // Not accepted: an engine from before the dispatcher. Its file is taken back so a later look cannot read it as sent.
  fs.rmSync(path.join(dir, DISPATCH_FILE), { force: true });
  return say(
    {
      ok: false,
      error: `run ${runId}'s engine did not take the hand-over within ${Math.round(waitMs / 1000)} s (it predates SUE's CliMayte dispatch): send these with climayte_run yourself`,
      climayteRun: printable(runId, dir),
    },
    1,
  );
}

if (isMainModule(import.meta.main, import.meta.url)) process.exitCode = await main();
