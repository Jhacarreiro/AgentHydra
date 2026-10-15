/**
 * tape-lift-stamp.spec - the Lift tape config's stamp (tape/examples/lift-class.mjs stampOf): a screen outside
 * /lift/student/ is the portal's own page, so it goes stale when a file under the portal's src/ changes; a Lift screen
 * does not. Input: temp copies of both checkouts (LIFT_DIR, FTW_PORTAL_DIR). No browser, no server.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { stampOf } from "../tape/examples/lift-class.mjs";

const scratch = mkdtempSync(path.join(tmpdir(), "sue-tape-stamp-"));
const saved = { LIFT_DIR: process.env.LIFT_DIR, FTW_PORTAL_DIR: process.env.FTW_PORTAL_DIR };
after(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

const put = (file, text) => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
};

test("a portal file change makes a portal screen stale and leaves a Lift screen's stamp alone", () => {
  const lift = path.join(scratch, "lift");
  const portal = path.join(scratch, "portal");
  put(path.join(lift, "site", "student", "app.js"), "export const a = 1;\n");
  put(path.join(lift, "site", "assets", "x.css"), "body { color: red; }\n");
  put(path.join(portal, "src", "index.js"), "export default {};\n");
  put(path.join(portal, "src", "lessons", "index.js"), "export const LESSONS = [];\n");
  process.env.LIFT_DIR = lift;
  process.env.FTW_PORTAL_DIR = portal;

  const portalScreen = { url: "http://127.0.0.1:5/demo/as/student?n=7" };
  const liftScreen = { url: "http://127.0.0.1:5/lift/student/index.html" };
  const before = { portal: stampOf(portalScreen), lift: stampOf(liftScreen) };
  assert.notEqual(before.portal, before.lift, "a portal screen is stamped over the portal too");

  put(path.join(portal, "src", "lessons", "index.js"), "export const LESSONS = [1];\n");
  assert.notEqual(stampOf(portalScreen), before.portal, "a nested portal file changed: the portal screen is stale");
  assert.equal(stampOf(liftScreen), before.lift, "a Lift screen does not read the portal");

  put(path.join(lift, "site", "student", "app.js"), "export const a = 2;\n");
  assert.notEqual(stampOf(liftScreen), before.lift, "a Lift file still changes a Lift screen");
});
