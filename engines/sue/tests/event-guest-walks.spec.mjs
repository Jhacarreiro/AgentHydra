/**
 * event-guest-walks.spec - the T-72h guest walk fails when the guest never got through Create account.
 * ====================================================================================================
 *
 * WHAT: `node --test sue/tests/event-guest-walks.spec.mjs`. Feeds `judge()` the `sue.mjs report`
 * shape of a walk that read the page, filed no site failure, and stopped before the sign-up finished.
 *
 * WHY IT EXISTS: ACCAP Houston's sign-up form was broken for a week (the birthday month reset to empty,
 * bf514998e8), and a walk that never opens Create account cannot see that. A walk passes only when she
 * really made her account on the way to the last RSVP or ticket step.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { judge } from "../lib/guest-walk-judge.mjs";

const finished = { state: "finished" };
const report = (whereTheyStopped) => ({ complete: true, sues: 1, problemsFound: [], theirWords: [], whereTheyStopped });

test("a walk that stopped before the sign-up finished FAILS - the form may be broken", () => {
  const result = judge(finished, report({ "before-code-request": 1 }));
  assert.equal(result.passed, false);
  assert.match(result.summary, /Create account/);
});

test("a walk that made her account and reached the last step passes", () => {
  assert.equal(judge(finished, report({ ended: 1 })).passed, true);
});
