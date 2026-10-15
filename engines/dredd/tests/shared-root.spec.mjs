// shared-root - Dredd finds the fleet's shared checkouts (the zswarm, Odin) wherever this checkout was cloned.
// The failure it ends (2026-09-22): the repo on a Desktop, the zswarm at D:/NEWProjects/shared/zswarm, and every
// Boardroom turn dying "zswarm checkout not found" because the only place looked was the repo's own parent.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { localSharedPath, sharedCheckout } from "../lib/shared-root.mjs";

function layout(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-shared-"));
  const engineRoot = path.join(dir, "desk", "Connections");
  const fleetRoot = path.join(dir, "fleet");
  mkdirSync(engineRoot, { recursive: true });
  mkdirSync(fleetRoot, { recursive: true });
  try {
    return fn({ dir, engineRoot, fleetRoot });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a checkout beside the repo wins, as it always did", () =>
  layout(({ dir, engineRoot, fleetRoot }) => {
    mkdirSync(path.join(dir, "desk", "zswarm"));
    mkdirSync(path.join(fleetRoot, "zswarm"));
    assert.equal(sharedCheckout("zswarm", { engineRoot, fleetRoot }), path.join(dir, "desk", "zswarm"));
  }));

test("a repo cloned anywhere else finds the checkout in the fleet's shared folder", () =>
  layout(({ engineRoot, fleetRoot }) => {
    mkdirSync(path.join(fleetRoot, "zswarm"));
    assert.equal(sharedCheckout("zswarm", { engineRoot, fleetRoot }), path.join(fleetRoot, "zswarm"));
  }));

test("the override wins over both, and nothing found names the sibling it looked for first", () =>
  layout(({ dir, engineRoot, fleetRoot }) => {
    mkdirSync(path.join(fleetRoot, "zswarm"));
    assert.equal(sharedCheckout("zswarm", { engineRoot, fleetRoot, override: "X:/mine" }), "X:/mine");
    assert.equal(sharedCheckout("odin", { engineRoot, fleetRoot }), path.join(dir, "desk", "odin"));
  }));

test("a bench path under the fleet folder moves beside the repo only when it lives there", () =>
  layout(({ dir, engineRoot, fleetRoot }) => {
    const fleet = fleetRoot.replace(/\\/g, "/");
    assert.equal(localSharedPath(`${fleet}/odin/odin.py`, { engineRoot, fleetRoot }), `${fleet}/odin/odin.py`);
    mkdirSync(path.join(dir, "desk", "odin"));
    assert.equal(
      localSharedPath(`${fleet}/odin/odin.py`, { engineRoot, fleetRoot }),
      path.join(dir, "desk", "odin", "odin.py").replace(/\\/g, "/"),
    );
    assert.equal(localSharedPath("dredd/x.mjs", { engineRoot, fleetRoot }), "dredd/x.mjs");
  }));
