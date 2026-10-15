/**
 * runner-exit.spec - a cannon that never launched a Sue is a REFUSAL, never an empty finished run.
 * ==================================================================================================
 *
 * WHAT: `node --test sue/tests/runner-exit.spec.mjs`. `refusalFromExit` maps a non-zero cannon
 * exit with no Sue dirs to `state: "refused"` plus the reason: 75 is the account cap or the fairjob
 * memory gate, and every other code speaks for itself in the last REFUSING lines of the run log,
 * falling back to the last lines written at all. Exit 0 is never a refusal, and the caller only asks
 * when no Sue dir exists - both guards live in `runner` itself.
 *
 * WHY IT EXISTS: the runner read only exit 2 as a refusal, so a capped run (75) or a mistyped run (64)
 * booked itself onto the scoreboard as finished-with-errors with 0 Sues and an empty why.
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import "./fixtures/people.mjs";
import { refusalFromExit } from "../sue.mjs";

test("exit 75 with no Sue dirs reads as not started (cap or memory), and keeps the cannon's own line", () => {
  const log = '[cannon] refusing to start more "first-visit" Sues: this run has made 0 account(s) and --max-accounts is 0\n';
  const r = refusalFromExit(75, log);
  assert.equal(r.state, "refused");
  assert.deepEqual(r.why, [
    "not started (cap or memory)",
    '[cannon] refusing to start more "first-visit" Sues: this run has made 0 account(s) and --max-accounts is 0',
  ]);
});

test("a refusal with words in the log keeps the last two of them, trimmed, with no label", () => {
  const log = [
    "[cannon] preflight: the brain answered, the login is good",
    "",
    "[cannon] REFUSING to start: the brain cannot talk - auth: not signed in",
    "  [cannon] sign the CLI back in for this login, then run the cannon again",
    "[cannon] something later that is not a refusal",
  ].join("\n");
  const r = refusalFromExit(2, log);
  assert.equal(r.state, "refused");
  assert.deepEqual(r.why, [
    "[cannon] REFUSING to start: the brain cannot talk - auth: not signed in",
    "[cannon] sign the CLI back in for this login, then run the cannon again",
  ]);
});

test("bad arguments (64) fall back to whatever the cannon last wrote, so the why is never empty", () => {
  const log = "[cannon] --scenario needs a value\nusage: node sue/cannon.mjs --target <file>\n";
  assert.deepEqual(refusalFromExit(64, log).why, ["[cannon] --scenario needs a value", "usage: node sue/cannon.mjs --target <file>"]);
});

test("a silent non-zero exit still names the code instead of leaving an empty why", () => {
  assert.deepEqual(refusalFromExit(3, ""), { state: "refused", why: ["cannon exited 3 without starting a Sue"] });
  assert.deepEqual(refusalFromExit(75, null), {
    state: "refused",
    why: ["not started (cap or memory)", "cannon exited 75 without starting a Sue"],
  });
});
