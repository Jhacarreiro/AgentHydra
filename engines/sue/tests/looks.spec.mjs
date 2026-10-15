import assert from "node:assert/strict";
import { test } from "node:test";

import { lookTimes } from "../lib/looks.mjs";

test("each look is named by its picture and timed by the move that took it", () => {
  const rows = [
    { at: "2026-09-24T10:00:00.000Z", tool: "look", screenshot: "C:\\runs\\r\\sue-1\\shots\\look-0001.jpg" },
    { at: "2026-09-24T10:00:05.000Z", tool: "tap" },
    { at: "2026-09-24T10:00:09.000Z", tool: "look", screenshot: "/runs/r/sue-1/shots/look-0002.jpg" },
  ];
  assert.deepEqual(lookTimes(rows), [
    { name: "look-0001.jpg", at: "2026-09-24T10:00:00.000Z" },
    { name: "look-0002.jpg", at: "2026-09-24T10:00:09.000Z" },
  ]);
});

test("a picture that is not a look, a row with no time, and a repeat are left out", () => {
  const rows = [
    { at: "2026-09-24T10:00:00.000Z", screenshot: "/shots/look-0001.jpg" },
    { at: "2026-09-24T10:00:01.000Z", screenshot: "/shots/look-0001.jpg" },
    { at: "2026-09-24T10:00:02.000Z", screenshot: "/shots/avatar.png" },
    { screenshot: "/shots/look-0002.jpg" },
  ];
  assert.deepEqual(lookTimes(rows), [{ name: "look-0001.jpg", at: "2026-09-24T10:00:00.000Z" }]);
  assert.deepEqual(lookTimes(undefined), []);
});
