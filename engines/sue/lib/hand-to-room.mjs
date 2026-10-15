/**
 * hand-to-room - a finished wave an AI started goes before the Boardroom by itself.
 * ================================================================================
 *
 * The owner, 2026-10-09: "Sue, Art, and Ape, their only job is to find errors. They can never send the errors to be
 * repaired unless they run through the boardroom." What a wave reports is a list of claims, never a work list. So the
 * runner hands its own finished run to a Dredd hearing (`dredd.mjs --run <kind>:<runId> --hearing --detach`): the room
 * rules every claim REAL, NOT REAL or UNPROVEN, and only the REAL ones reach a drafter (dredd/lib/claim-rulings.mjs).
 * A wave that a hearing or a round started (`hearing: false` in its args) is already before the room, so it is not
 * handed over a second time.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

import { checkoutRoot } from "./engine-lease.mjs";

const TITLES = { sue: "SUE", ape: "APE", art: "ART" };
// The live CLI of the checkout the hearing runs in, named from a call so no engine snapshot carries Dredd and all it imports
// (engine-store.mjs pathLiteralsOf follows a join of plain names after a bare variable, so the root goes through a call).
const dreddIn = (root) => path.join(path.resolve(root), "dredd", "dredd.mjs");

/** The run's kind as Dredd adopts it: ART's design review, APE's power users, or plain SUE. Pure. */
function runKind(spec) {
  return spec?.art ? "art" : spec?.ape ? "ape" : "sue";
}

/** The hearing's command line for one finished run: the ask, the page, the run it adopts, detached. Pure. */
function hearingArgs(spec, root) {
  const kind = runKind(spec);
  const url = String(spec.url ?? "").trim();
  const ask = `${TITLES[kind]} filed these problems${url ? ` on ${url}` : ""}. Rule which are real before anything gets repaired`;
  return [
    dreddIn(root),
    ask,
    ...(url ? ["--url", url] : ["--no-page"]),
    "--run",
    `${kind}:${spec.runId}`,
    "--hearing",
    "--detach",
  ];
}

/** Dredd's detached hearing on `argv`, hidden: `{ docket, at }`, or `{ error }` in Dredd's own words. */
function detachHearing(argv, { root, spawn }) {
  // Dredd runs on node: under bun, the node on PATH (dredd/dredd.mjs does the same for its own children).
  const node = process.versions.bun ? "node" : process.execPath;
  const r = spawn(node, argv, { cwd: root, encoding: "utf8", windowsHide: true, timeout: 5 * 60_000 });
  const docket = /^Docket: (.+)$/m.exec(String(r.stdout ?? ""))?.[1]?.trim() ?? null;
  if (docket) return { docket, at: new Date().toISOString() };
  return { error: String(r.stderr || r.stdout || r.error?.message || `exit ${r.status}`).trim().slice(-300) };
}

/**
 * Start the hearing over a finished run, hidden. Dredd's `--detach` prints the docket in seconds and leaves the hearing
 * running in the background. Returns `{ docket, at }` for the run's status, or `{ error }` when Dredd would not start
 * one (the run's findings then stay claims nobody has ruled on, and its status says why). `spawn` is the test seam.
 */
export function handToTheRoom(spec, { root = checkoutRoot(), spawn = spawnSync } = {}) {
  return detachHearing(hearingArgs(spec, root), { root, spawn });
}

/**
 * A field run's waves before the room together (lib/field.mjs): ONE docket whose field is every finished run, with the
 * field's decisions written into it (`--field <field.json>`), never one hearing per wave. Same answer as handToTheRoom.
 */
export function handFieldToTheRoom({ url, runs, ask, fieldFile = null }, { root = checkoutRoot(), spawn = spawnSync } = {}) {
  const argv = [
    dreddIn(root),
    ask,
    "--url",
    url,
    "--run",
    runs.map((r) => `${r.kind}:${r.runId}`).join(","),
    ...(fieldFile ? ["--field", fieldFile] : []),
    "--hearing",
    "--detach",
  ];
  return detachHearing(argv, { root, spawn });
}
