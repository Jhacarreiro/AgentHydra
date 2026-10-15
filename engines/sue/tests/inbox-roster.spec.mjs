/**
 * inbox-roster.spec - an inbox_test starts with the roster it was handed, the way a run does.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { listPersonas } from "../lib/personas.mjs";
import { readyPeople } from "../sue.mjs";

const PROBE = { id: "inbox-roster-probe" };

test("an inbox_test installs the people it is handed, as a run does", async () => {
  const ready = await readyPeople("inbox_test", { people: [{ doc: PROBE, builtIn: true }], minds: {} });
  assert.equal(ready.door, null);
  assert.deepEqual(listPersonas(), ["inbox-roster-probe"]);
});
