// body-start-retry.spec.mjs - spec for the retried start page and the load-failure URL (review finding
// sue-body-start-never-retried). ensureStarted used to set its `navigated` flag before the goto, so a
// single timeout or refused navigation ended the whole visit; the next look then landed on Chrome's
// own chrome-error://chromewebdata/ page, which urlAllowed rejects, and the body filed a `left-site`
// finding a Sue never caused. `openStartPage` retries the front door once and `isLoadFailureUrl` names
// that error page for what it is. No browser needed: both are pure functions.
import assert from "node:assert/strict";
import { test } from "node:test";

import { isLoadFailureUrl, openStartPage } from "../body.mjs";

test("a failed first load is retried once, and the retry can succeed", async () => {
  let calls = 0;
  const goto = async () => {
    calls += 1;
    if (calls === 1) throw new Error("net::ERR_TIMED_OUT");
  };
  const failed = await openStartPage(goto);
  assert.equal(calls, 2, "the start page must be tried a second time after the first failure");
  assert.equal(failed, null, "a retry that loads must report success, not the first timeout");
});

test("a first-try success is not retried", async () => {
  let calls = 0;
  const goto = async () => {
    calls += 1;
  };
  const failed = await openStartPage(goto);
  assert.equal(calls, 1, "a start page that loads on the first try must not be fetched twice");
  assert.equal(failed, null);
});

test("a down site costs two timeouts, never one per move, and the last error is returned", async () => {
  const errors = [];
  let calls = 0;
  const goto = async () => {
    calls += 1;
    const err = new Error(`timeout ${calls}`);
    errors.push(err);
    throw err;
  };
  const failed = await openStartPage(goto);
  assert.equal(calls, 2, "the default is exactly two attempts, so a dead site is bounded");
  assert.equal(failed, errors[1], "the error returned must be the last one, for the http-error note");
});

test("the attempt count is the caller's, for a test or a slower door", async () => {
  let calls = 0;
  const goto = async () => {
    calls += 1;
    throw new Error("nope");
  };
  const failed = await openStartPage(goto, 3);
  assert.equal(calls, 3);
  assert.match(String(failed?.message), /nope/);
});

test("Chrome's own failed-load page is a load failure, never a left-site", () => {
  assert.equal(isLoadFailureUrl("chrome-error://chromewebdata/"), true);
  assert.equal(isLoadFailureUrl("chrome-error://chromewebdata/#"), true);
  assert.equal(isLoadFailureUrl("https://example.com/"), false);
  assert.equal(isLoadFailureUrl("about:blank"), false);
  assert.equal(isLoadFailureUrl(undefined), false, "a missing URL must not read as a load failure");
  assert.equal(isLoadFailureUrl(null), false);
});
