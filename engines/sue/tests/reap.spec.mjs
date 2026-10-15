/**
 * reap.spec - the reaper reaps only the accounts the ledger has not closed.
 * ========================================================================
 *
 * WHAT: `node --test sue/tests/reap.spec.mjs`. accountsFromManifest reads a run's manifest and
 * crosses it with accounts-ledger.jsonl; no janitor is spawned, no browser, no network.
 *
 * WHY IT EXISTS: the ledger is the only defence between a test identity and a real user base, and
 * which accounts a reap walks was untested (sue-run-untested-reaper-and-runner, 2026-09-22).
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { runDir, stateRoot } from "../lib/run-dir.mjs";
import { accountLooksGone, accountsFromManifest, reapRefusal } from "../reap.mjs";

const RUN = "20260922-120000-abcd";

function useHome(home) {
  const prior = process.env.SUE_HOME;
  process.env.SUE_HOME = home;
  return () => {
    if (prior === undefined) delete process.env.SUE_HOME;
    else process.env.SUE_HOME = prior;
  };
}

test("accountsFromManifest walks the ledger's open accounts for THIS run, not every planned Sue", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-reap-"));
  const restore = useHome(home);
  try {
    fs.mkdirSync(runDir(RUN), { recursive: true });
    fs.writeFileSync(
      path.join(runDir(RUN), "manifest.json"),
      JSON.stringify({
        target: "deal-flow",
        sues: [
          { sueId: "sue-1140-a", persona: "grandma", address: "sue-1140@example.com" },
          { sueId: "sue-1141-b", persona: "bob", address: "sue-1141@example.com" },
          { sueId: "sue-1142-c", persona: "elaine", address: "sue-1142@example.com" },
        ],
      }),
    );
    fs.mkdirSync(stateRoot(), { recursive: true });
    const ledger = [
      { address: "sue-1140@example.com", sueId: "sue-1140-a", runId: RUN, deletedAt: "2026-09-22T01:00:00.000Z" },
      { address: "sue-1141@example.com", sueId: "sue-1141-b", runId: RUN, deletedAt: null },
      { address: "sue-9000@example.com", sueId: "sue-9000-z", runId: "20260922-000000-zzzz", deletedAt: null },
    ];
    fs.writeFileSync(path.join(stateRoot(), "accounts-ledger.jsonl"), `${ledger.map((l) => JSON.stringify(l)).join("\n")}\n`);
    const accounts = accountsFromManifest(RUN);
    assert.deepEqual(
      accounts.map((a) => a.address),
      ["sue-1141@example.com"],
      "a planned Sue with no ledger row is not an account; a deleted row is out; another run's row is out",
    );
    assert.equal(accounts[0].persona, "bob", "persona is joined from the manifest");
    assert.equal(accounts[0].sueId, "sue-1141-b");
    assert.equal(accounts[0].target, "deal-flow");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    restore();
  }
});

test("a missing manifest is a clear error, never a silent empty reap", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-reap-"));
  const restore = useHome(home);
  try {
    assert.throws(() => accountsFromManifest(RUN), /manifest/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    restore();
  }
});

test("accountLooksGone ignores a janitor's madeAccount:false - a natural answer is not evidence", () => {
  assert.equal(accountLooksGone({ madeAccount: false }), false);
});

test("accountLooksGone still reads her own words for a gone account", () => {
  assert.equal(accountLooksGone({ mostConfusing: "the account is gone now" }), true);
});

test("a real reap refuses without --delete-dataset, since deleting a Sue account erases her dataset rows (Owner, 2026-09-28)", () => {
  assert.match(reapRefusal({ run: RUN }), /REFUSED/);
  assert.match(reapRefusal({ all: true }), /--delete-dataset/);
  assert.equal(reapRefusal({ run: RUN, dryRun: true }), null);
  assert.equal(reapRefusal({ all: true, deleteDataset: true }), null);
});
