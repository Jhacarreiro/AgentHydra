/**
 * between-sues.spec - a target's own clean-up step runs between Sues that share one account.
 * ==========================================================================================
 *
 * WHAT: `node --test sue/tests/between-sues.spec.mjs`. `runBetweenSues` runs the target's
 * `betweenSues` script beside the target file, hands it SUE_SESSIONS_DIR, reports success, and
 * reports (never throws) a script that fails.
 *
 * WHY IT EXISTS: every Discord Sue on Example App Next is the same member, and one arrived with four
 * tickets the Sues before her left open (run 20260922-103543-925c).
 *
 * WHO DEPENDS ON IT: nothing imports it.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import "./fixtures/people.mjs";
import { runBetweenSues } from "../cannon.mjs";

test("the target's step runs beside its file with the sessions folder, and a failing one is reported, not thrown", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "sue-between-"));
  try {
    fs.writeFileSync(
      path.join(home, "reset.mjs"),
      'import fs from "node:fs"; fs.writeFileSync("ran.txt", process.env.SUE_SESSIONS_DIR ?? ""); console.log("closed 2");\n',
    );
    fs.writeFileSync(path.join(home, "broken.mjs"), 'console.error("no staff session"); process.exit(3);\n');

    assert.equal(runBetweenSues({ home, betweenSues: "reset.mjs" }, { sessionsDir: "/sessions/here" }), true);
    assert.equal(
      fs.readFileSync(path.join(home, "ran.txt"), "utf8"),
      "/sessions/here",
      "it ran in the target's folder and got the sessions folder",
    );

    assert.equal(runBetweenSues({ home, betweenSues: "broken.mjs" }, { sessionsDir: "/sessions/here" }), false);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
