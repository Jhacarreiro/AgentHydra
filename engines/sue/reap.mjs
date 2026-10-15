#!/usr/bin/env node
/**
 * reap.mjs - sends a janitor Sue back into every account a cannon run created, so a test identity
 * never outlives the test.
 * ============================================================================================
 *
 * WHY THIS EXISTS: `state/accounts-ledger.jsonl` is a real identity store (SPEC.md's own words:
 * "a real identity store and the cap is the only thing between 'test' and 'pollution'"). Deleting
 * those accounts by hand does not scale past a handful of Sues, and a script that DELETES an
 * account is exactly the class of thing this repo insists on VERIFYING rather than trusting - so
 * this does not call any delete endpoint itself. It sends a real `dev-dan` Sue back through the
 * product's own delete-account flow, reusing the ORIGINAL Sue's `browserProfileDir` so the janitor
 * is still signed in, and reports what she says happened.
 *
 * ⛔ HER WORD ALONE WAS NEVER ENOUGH (2026-09-22). This file used to close the ledger row on the exit
 * interview. Four janitors answered "gone", four rows were closed, and the accounts plane still held
 * all four identities with `account_deletion_requested_at` NULL - the delete had never even been
 * REQUESTED. A cleanup tool that reports success over accounts it did not delete is worse than one
 * that reports nothing, so from that day `deletedAt` was written only after a second, independent
 * check - and until todo 4c0e16d5, that check did not exist, so every reap said UNVERIFIED forever.
 *
 * ⛔ THE VERIFIER NOW EXISTS (todo 4c0e16d5): after a janitor SAYS an account is gone, `reapOne` spawns
 * `node sue/mailroom.mjs --probe-account <email>` (the reaper holds no AWS credential by design,
 * only mailroom.mjs does - the probe runs in ITS process, the answer comes back over stdout as one
 * JSON line). `shouldCloseLedgerRow` is the pure decision: close (write `deletedAt`) only when the
 * identity store itself says `exists:false` or `deletionRequestedAt` is set; otherwise the row stays
 * open and the log says UNVERIFIED with the probe's own answer attached, never a guess.
 *
 * WHAT IT DEPENDS ON: `cannon.mjs`'s pinned export `runSue({ runId, persona, scenario, target,
 * identity, browserProfileDir, brain, model }) -> { sueId, sueDir, result }` - the import below
 * is dynamic so a moment where cannon.mjs is mid-edit or absent never blocks `report.mjs`'s tests
 * (which never touch this file) from loading. It reads a run's manifest through `lib/run-dir.mjs`'s
 * `readManifest` and `runDir` (so `SUE_HOME` relocates this file exactly like the
 * cannon, the body and the mailroom) and `<sue>/sue.json` (a pinned file contract). It reads the
 * account ledger through that same module's `readAccountLedger`, whose `{ address, sueId, runId,
 * createdAt, deletedAt }` row shape is pinned in SPEC.md. It still READS `deletedAt` when picking who
 * to reap, so a row the probe closed drops out of the next reap on its own; `--all` re-sends a
 * janitor to every account the ledger has not yet PROVEN closed.
 *
 * Usage:
 *   node reap.mjs --run <runId>       reap every not-yet-deleted account this run's manifest lists
 *   node reap.mjs --all               reap every not-yet-deleted account in the whole ledger
 *   node reap.mjs --run <runId> --dry-run   print who would be reaped, spawn nothing
 *   node reap.mjs ... --brain <chat|openrouter|deepseek> --model <model>   passed straight through to runSue
 *
 * ⛔ THE JANITOR THINKS IN THE CHAT THAT RUNS THE REAP, NEVER ON A CLI LOGIN AND NEVER ON A KEY UNASKED
 * (the Chair, 2026-09-23: "you're not allowed to use CLI logins"; then "I don't think they should need api keys
 * ... unless the desktop instance has deemed say, a zswarm necessary"). The default is `chat`: each janitor
 * waits for one agent of that chat, driven through a relay like a cannon Sue, so run the reap in the
 * background and start her agent when the log names her brief. `openrouter` / `deepseek` are the key pools,
 * used only when the chat passes one with --brain.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertBrain, SUE_BRAIN_REASON } from "./lib/claude-cli.mjs";
import { brainErrorFrom } from "./lib/findings.mjs";
import { loadPersona, loadScenario, loadTarget, peopleAreInstalled } from "./lib/personas.mjs";
import { readyPeople } from "./lib/people.mjs";
import { appendLedgerClosure, newRunId, readAccountLedger, readManifest, runDir as sueRunDir, writeManifest } from "./lib/run-dir.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const SUE_ROOT = path.dirname(fileURLToPath(import.meta.url));
const MAILROOM = path.join(SUE_ROOT, "mailroom.mjs");

/** The janitor's default brain: the chat that runs the reap, one of its own agents per janitor (the Chair, 2026-09-23:
 *  "I don't think they should need api keys ... unless the desktop instance has deemed say, a zswarm necessary"). */
export const JANITOR_BRAIN = "chat";

/** `--brain` for a janitor: the chat unless the chat names a key pool itself (`openrouter` / `deepseek`). */
export function janitorBrain(brain) {
  if (brain == null || brain === "") return JANITOR_BRAIN;
  return assertBrain(String(brain).trim());
}
function readJson(filePath, fallback) {
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------------------------
// who needs reaping
// ---------------------------------------------------------------------------------------------

export function accountsFromManifest(runId) {
  const manifest = readManifest(runId); // throws with a clear message when the manifest is absent
  // ⛔ THE LEDGER IS THE GUEST LIST, NOT THE PLAN (2026-09-22). `manifest.sues` lists every PLANNED
  // Sue, and most never reach the signup door - a 25-Sue first-visit run with zero accounts still got
  // 25 janitors, 25 Opus brains and browsers against the live product with nothing to delete. The
  // ledger only ever holds Sues who really signed up, so it is the source of truth, and the manifest
  // is joined only for `persona` and `target` (the ledger's `{ address, sueId, runId, createdAt,
  // deletedAt }` shape carries neither).
  const plannedByAddress = new Map((manifest.sues || []).map((s) => [s.address, s]));
  return readAccountLedger()
    .filter((row) => row.runId === runId && !row.deletedAt)
    .map((row) => {
      const planned = plannedByAddress.get(row.address) || {};
      // `sueId` names her run folder (the manifest fills it for an old row that has none); `ledgerSueId`
      // is the ledger row's own value, the only one closeLedgerRow may match on.
      return {
        address: row.address,
        sueId: row.sueId ?? planned.sueId,
        ledgerSueId: row.sueId,
        runId,
        persona: planned.persona,
        target: manifest.target,
      };
    });
}

function accountsFromLedger() {
  return readAccountLedger()
    .filter((row) => !row.deletedAt)
    .map((row) => ({ address: row.address, sueId: row.sueId, ledgerSueId: row.sueId, runId: row.runId }));
}

// ---------------------------------------------------------------------------------------------
// one janitor visit
// ---------------------------------------------------------------------------------------------

/** Mechanical check: her own exit-interview words say the account is gone. Never trusts a green
 * process exit alone - a janitor who gave up mid-flow proved nothing. */
export function accountLooksGone(interview) {
  if (!interview) return false;
  const haystack = [interview.whatDoTheySell, interview.oneSentenceToAFriend, interview.mostConfusing, interview.whyStopped]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return /\b(deleted|gone|removed|closed( my)? account|account is gone|no longer exists)\b/.test(haystack);
}

// ---------------------------------------------------------------------------------------------
// the verifier (todo 4c0e16d5) - a janitor's claim is checked against the identity store itself
// ---------------------------------------------------------------------------------------------

/** Spawns the mailroom's `--probe-account` the same way `cannon.mjs`'s own `preflightMailroom`
 * spawns `--probe`: reads the LAST line on stdout that looks like JSON (a stray log line ahead of it
 * cannot break the read) and parses it. Never throws - a spawn failure or unparsable output comes
 * back as the same `{ ok:false, error }` shape the child itself would have printed, so the caller
 * always has one shape to branch on. */
export function probeAccount(email, { spawn = spawnSync, env = process.env } = {}) {
  const r = spawn(process.execPath, [MAILROOM, "--probe-account", email], { windowsHide: true, encoding: "utf8", timeout: 60_000, env });
  const line = String(r.stdout || "")
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.startsWith("{"))
    .pop();
  try {
    return JSON.parse(line);
  } catch {
    return {
      ok: false,
      error:
        r.error?.message ||
        String(r.stderr || "")
          .trim()
          .slice(0, 300) ||
        `exit ${r.status}`,
    };
  }
}

/** THE PURE DECISION, and the whole point of this file's existence: a janitor's claim closes nothing
 * by itself - only the identity store does. Closes the ledger row when the probe says the address is
 * GONE (`exists:false`) or the delete was at least REQUESTED (`deletionRequestedAt` set, e.g. a
 * grace-period delete the product has not finished yet); an unverifiable probe (refused, errored, or
 * `exists:true` with no deletion on record) always keeps the row open. No AWS, no I/O - unit-tested in
 * `sue/tests/reap-probe.spec.mjs`. */
export function shouldCloseLedgerRow(probe) {
  if (!probe || probe.ok !== true) return false;
  return probe.exists === false || Boolean(probe.deletionRequestedAt);
}

/** Closes exactly one row - the one for THIS address, ledger sueId and runId, never a blind match on
 * address alone (the same Sue address can recur across runs) - by appending a closure line
 * (`appendLedgerClosure`), never by rewriting the file under a cannon that may be appending to it.
 * False when no open row matches, which the caller must report rather than call verified. */
export function closeLedgerRow(account, deletedAt) {
  const key = { address: account.address, sueId: "ledgerSueId" in account ? account.ledgerSueId : account.sueId, runId: account.runId };
  const open = readAccountLedger().find(
    (row) => !row.deletedAt && row.address === key.address && (row.sueId ?? null) === (key.sueId ?? null) && row.runId === key.runId,
  );
  if (!open) return false;
  appendLedgerClosure({ ...key, deletedAt });
  return true;
}

export async function reapOne(
  account,
  {
    brain = JANITOR_BRAIN,
    model,
    dryRun,
    runSue: runSueOverride,
    startMailroom: startMailroomOverride,
    probeAccount: probeAccountOverride,
    createRelay: createRelayOverride,
  } = {},
) {
  if (dryRun) {
    console.error(`[dry-run] would reap ${account.address} (${account.sueId}, run ${account.runId})`);
    return { skipped: true };
  }

  const originalSueDir = path.join(sueRunDir(account.runId), account.sueId);
  const originalSue = readJson(path.join(originalSueDir, "sue.json"), {});
  const identity = originalSue.identity || { email: account.address };
  const browserProfileDir = originalSue.browserProfileDir || path.join(originalSueDir, "profile");
  // ⛔ THE PROFILE IS NOT THE SIGN-IN, ANY MORE. Since the shared browser landed, every Sue runs in a
  // throwaway CONTEXT, so the profile dir the janitor used to reuse is empty and she could never sign
  // in or delete anything (measured 2026-09-22: deletion was never requested). Her body saves her
  // signed-in state on the way out (`storage-state.json`); that file hands the janitor the SAME
  // session, never `session` - a lent human account whose SESSION_RAIL would refuse the very delete
  // she came to do.
  const savedState = path.join(originalSueDir, "storage-state.json");
  const restoreState = existsSync(savedState) ? savedState : null;
  // `sue.json`'s own `target` is already the full loaded object (cannon.mjs's writeSueFiles); the
  // manifest fallback only ever carries the bare id, so that leg loads it the same way the cannon
  // does. runSue reaches into `persona.dials`/`persona.model`/`scenario.expectedLandingPattern`, so
  // both of those must be real objects too - never the bare ids SPEC.md's prose shorthand uses.
  const target =
    originalSue.target && typeof originalSue.target === "object" ? originalSue.target : loadTarget(originalSue.target || account.target);
  // The janitor is a built-in person in Connections, fetched here when nobody handed this process its people.
  if (!peopleAreInstalled()) await readyPeople({}, { root: process.cwd(), ids: ["dev-dan"], minds: false });
  const persona = loadPersona("dev-dan");
  const scenario = loadScenario("delete-account");

  // Dynamic on purpose: cannon.mjs is a sibling module (own owner, own build), and importing it
  // eagerly at the top of the file would make report.mjs's test lane fail to even load this file
  // when cannon.mjs has not landed yet.
  // `pathToFileURL`, never the bare path: on Windows an absolute path is `c:\...` and node's ESM
  // loader reads `c:` as a URL SCHEME - ERR_UNSUPPORTED_ESM_URL_SCHEME, on every single reap. The
  // reaper is the only thing that deletes a Sue's account, so this silently left every test identity
  // alive (measured 2026-09-22, four accounts).
  const runSue = runSueOverride ?? (await import(pathToFileURL(path.join(SUE_ROOT, "cannon.mjs")).href)).runSue;
  // The cannon's own mailroom wiring, reused rather than re-typed here: the janitor signs in with the
  // saved state above, but a product that still demands a fresh code needs her inbox filled while she
  // runs. `startMailroom` is only reached outside a test that injects its own.
  const startMailroom = startMailroomOverride ?? (await import(pathToFileURL(path.join(SUE_ROOT, "cannon.mjs")).href)).startMailroom;

  // ⛔ THE JANITOR LIVES IN HER OWN RUN, NEVER THE ONE SHE IS CLEANING. Passing `account.runId`
  // here dropped a `sue-<n>-dev-dan` folder into the very run being reaped, so `sue status`, the
  // Manager and any report re-run counted janitors as visitors of the original run (measured
  // 2026-09-22). `reap-<original>-<stamp>` is also where her own `mail/<address>` lands (runSue
  // derives it from the run id), so the original run's mail is never mixed with a janitor's.
  const janitorRunId = `reap-${account.runId}-${newRunId()}`;
  // ⛔ A JANITOR WHO CANNOT READ HER CODE CANNOT SIGN IN. The run's mailroom died with the cannon, so
  // reap starts one of its own FOR THE JANITOR'S RUN - not `account.runId`, because her body reads
  // `<janitorRun>/mail/<address>` and nowhere else.
  const mailroom = startJanitorMailroom(janitorRunId, { address: account.address, target, startMailroom });
  // On the chat brain the janitor waits for an agent of the chat that runs this reap, exactly like a cannon Sue: her
  // brief is listed in her run's chat-brains.json and her hands come through the relay (hand.mjs finds it by run id).
  let relay = null;
  let janitor;
  try {
    if (brain === "chat") {
      const createRelay =
        createRelayOverride ?? (await import(pathToFileURL(path.join(SUE_ROOT, "lib", "body-relay.mjs")).href)).createBodyRelay;
      mkdirSync(sueRunDir(janitorRunId), { recursive: true });
      relay = createRelay({ runDir: sueRunDir(janitorRunId), bodyFile: path.join(SUE_ROOT, "body.mjs") });
      await relay.listen();
      console.error(
        `[sue-reap] the janitor for ${account.address} waits for this chat: start one agent (model sonnet) told only to read the brief ` +
          `listed in ${path.join(sueRunDir(janitorRunId), "chat-brains.json")} (by its full path) and do what it says, with this line in its prompt: ${SUE_BRAIN_REASON}; undriven for an hour, she is let go`,
      );
    }
    janitor = await runSue({
      runId: janitorRunId,
      persona,
      scenario,
      target,
      identity,
      browserProfileDir,
      restoreState,
      brain,
      model,
      relay,
    });
  } finally {
    await relay?.close();
    mailroom?.kill();
  }
  const { sueId: janitorSueId, sueDir: janitorDir, result } = janitor;

  // ⛔ A JANITOR WHO NEVER WOKE UP IS NOT EVIDENCE ABOUT THE PRODUCT. Without this, a brain that
  // could not log in produced the identical line to a product that refused to delete the account
  // ("NOT confirmed gone"), so on 2026-09-22 an expired OAuth session read as four accounts the
  // delete flow would not remove. Say which one happened, and never mark the ledger on a dead brain.
  const brainError = brainErrorFrom(result);
  if (brainError) return { janitorSueId, gone: false, brainError: `${brainError.kind}: ${brainError.message}` };

  const interview = readJson(path.join(janitorDir, "interview.json"), null);
  const gone = accountLooksGone(interview);
  if (!gone) return { janitorSueId, gone, interview };

  // ⛔ HER WORD STILL ONLY EARNS A CHECK, NOT A CLOSE (todo 4c0e16d5). The probe runs in mailroom.mjs's
  // OWN process (it holds the AWS credential, this one never does) and answers over stdout; the same
  // `mailroomEnv` the cannon spawns its mailroom with, so a named profile vs. a vault lease is resolved
  // identically here.
  const probeFn = probeAccountOverride ?? probeAccount;
  const mailroomEnv = (await import(pathToFileURL(path.join(SUE_ROOT, "cannon.mjs")).href)).mailroomEnv;
  const probe = probeFn(account.address, { env: mailroomEnv(process.env) });
  const probeConfirmed = shouldCloseLedgerRow(probe);
  const ledgerClosed = probeConfirmed ? closeLedgerRow(account, new Date().toISOString()) : false;
  const verified = probeConfirmed && ledgerClosed;
  return { janitorSueId, gone, interview, verified, probeConfirmed, ledgerClosed, probe };
}

/** Start a mailroom for the janitor's own run, when the target's mail is the kind one reads.
 * The cannon is the only other writer of a manifest and it is not running here, so this writes the
 * janitor run's manifest first: a mailroom polls the addresses a manifest names, and without one the
 * janitor's inbox would stay empty and a code sign-in could never complete. Returns the child
 * (`.kill()` stops it), or null when there is nothing to start. */
function startJanitorMailroom(janitorRunId, { address, target, startMailroom }) {
  if (!startMailroom || target?.mailbox?.kind !== "ses-inbound") return null;
  writeManifest(janitorRunId, {
    runId: janitorRunId,
    target: target.id ?? null,
    scenario: "delete-account",
    mailbox: target.mailbox,
    addresses: [address],
    started: new Date().toISOString(),
    finished: null,
  });
  return startMailroom(janitorRunId, () => {});
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { dryRun: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--run") args.run = argv[(i += 1)];
    else if (arg === "--all") args.all = true;
    else if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--delete-dataset") args.deleteDataset = true;
    else if (arg === "--brain") args.brain = argv[(i += 1)];
    else if (arg === "--model") args.model = argv[(i += 1)];
    else if (arg === "--help" || arg === "-h") args.help = true;
  }
  return args;
}

function printUsage() {
  console.error(
    "usage: node reap.mjs --run <runId> | --all  [--dry-run] [--delete-dataset] [--brain chat|openrouter|deepseek] [--model <model>]",
  );
}

/**
 * A Sue's records are a DATASET, kept apart from the human one (Owner, 2026-09-28, docs/reference/SUE_DATASET.md).
 * Deleting her account erases her rows in every plane, so a real reap destroys dataset rows: it runs only when the
 * caller says so with --delete-dataset. A dry run needs no flag. Returns the refusal line, or null to proceed.
 */
export function reapRefusal(args) {
  if (args.dryRun || args.deleteDataset) return null;
  return "[sue-reap] REFUSED: deleting a Sue account erases her rows in every plane, and Sue data is kept as its own dataset (docs/reference/SUE_DATASET.md). Pass --delete-dataset to reap anyway, or --dry-run to see who would go.";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || (!args.run && !args.all)) {
    printUsage();
    process.exitCode = args.help ? 0 : 1;
    return;
  }
  const refusal = reapRefusal(args);
  if (refusal) {
    console.error(refusal);
    process.exitCode = 1;
    return;
  }

  const accounts = args.run ? accountsFromManifest(args.run) : accountsFromLedger();
  if (accounts.length === 0) {
    console.error("[sue-reap] nothing to reap");
    return;
  }

  // The janitor's brain is named here, never inherited from SUE_BRAIN: the chat that runs the reap by default, a key
  // pool only when that chat asks for one with --brain.
  args.brain = janitorBrain(args.brain);
  console.error(
    `[sue-reap] the janitors think with --brain ${args.brain} (${args.brain === "chat" ? "this chat's own agents" : "a key pool this chat chose"}, never a CLI login)`,
  );

  let reaped = 0;
  let claimed = 0;
  let verified = 0;
  let brainDead = 0;
  for (const account of accounts) {
    console.error(`[sue-reap] reaping ${account.address} (${account.sueId})`);
    // Sequential, deliberately: each janitor drives a real browser against the real product, and
    // this repo's own rails (fairjob, the account caps) are for the cannon's signup traffic, not
    // for a cleanup pass that should be gentle and easy to read in the log as it goes.
    const outcome = await reapOne(account, args);
    if (outcome.skipped) continue;
    reaped += 1;
    if (outcome.brainError) {
      brainDead += 1;
      console.error(
        `[sue-reap] the janitor never woke up for ${account.address} (${outcome.brainError}) - this says NOTHING about the delete flow; fix the login and reap again`,
      );
    } else if (outcome.gone) {
      // ⛔ HER WORD IS A CLAIM, NOT A DELETION - it was wrong on every account checked on 2026-09-22.
      // `reapOne` now runs the identity-store probe itself (todo 4c0e16d5) and only closes the ledger
      // row when THAT answers `exists:false` or names a `deletionRequestedAt` - this line just reports
      // which of the two happened.
      claimed += 1;
      if (outcome.verified) {
        verified += 1;
        console.error(`[sue-reap] VERIFIED ${account.address} - the identity store confirms it, ledger row CLOSED`);
      } else if (outcome.probeConfirmed && !outcome.ledgerClosed) {
        console.error(`[sue-reap] probe confirmed deletion, but ledger row NOT found: ${account.address}`);
      } else {
        console.error(
          `[sue-reap] the janitor SAYS ${account.address} is gone - UNVERIFIED, ledger row left OPEN ` +
            `(probe answered ${JSON.stringify(outcome.probe)})`,
        );
      }
    } else {
      console.error(`[sue-reap] NOT confirmed gone: ${account.address} - left deletedAt null, will retry next reap`);
    }
  }
  console.error(
    `[sue-reap] done: ${reaped} janitor visits, ${claimed} account(s) she SAYS are gone, ${verified} verified against the identity store`,
  );
  if (brainDead) {
    // Exit non-zero: a reap where no janitor could even log in must not read as a clean sweep to a
    // script, a cron or an agent skimming the last line.
    console.error(
      `[sue-reap] ⛔ ${brainDead} janitor(s) never woke up - nothing was proven about the delete flow, and no ledger row was touched.`,
    );
    process.exitCode = 1;
  }
}

const isMain = isMainModule(import.meta.main, import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
