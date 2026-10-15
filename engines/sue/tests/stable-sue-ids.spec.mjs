// stable-sue-ids.spec.mjs - pins the fix for finding
// "MEDIUM - data-sue-id is positional and restamped on every inventory run, so [n] can land on a
// different control with the same name" (docs/todo/improvements/tooling/sue-opus55-review-
// findings-2026-09-22.md). A control now KEEPS the id it was first given, so a `sue-<n>` number no
// longer tracks document order; the inventory therefore stamps each entry with that run's
// document-order rank (`order`) and perceive() merges the two arrays by it. The behaviour that only
// needs a browser is the id being left in place across runs (inside INVENTORY_SCRIPT); the half a
// caller can observe without one is this merge, and that is what is pinned here.
import assert from "node:assert/strict";
import { test } from "node:test";

import { perceive } from "../lib/perception.mjs";

const persona = { dials: { readingGrade: 20, wordsPerLook: 0, legibleMinPx: 0, techProwess: 3 } };

test("perceive ranks an inventory by its per-run order, not by the trailing number of a stable id", () => {
  // A chat page where the newest message was stamped AFTER the Reply button below it: the block got
  // the higher id (sue-7) while the button kept the lower one (sue-1) it drew on the first run. The
  // ids are stable now, so they no longer say which is higher on the page - `order` does.
  const inventory = {
    url: "https://example.test/chat",
    title: "Chat",
    viewport: { w: 1200, h: 800 },
    blocks: [{ id: "sue-7", order: 1, kind: "paragraph", text: "Newest message from Ada", fontPx: 16, wordCount: 4, bottom: 40 }],
    elements: [
      {
        id: "sue-1",
        order: 2,
        role: "button",
        name: "Reply",
        rect: { x: 0, y: 60, w: 80, h: 30 },
        hasVisibleText: true,
        seenText: "Reply",
      },
    ],
  };

  const { text, clickable } = perceive(inventory, persona);
  const messageAt = text.indexOf("Newest message from Ada");
  const replyAt = text.indexOf("[1] Reply");
  assert.ok(messageAt >= 0, `the message should be shown:\n${text}`);
  assert.ok(replyAt >= 0, `the Reply button should be numbered [1]:\n${text}`);
  assert.ok(messageAt < replyAt, `document order puts the message above the Reply button, but the low id won:\n${text}`);
  assert.equal(clickable.get(1), "sue-1", "the numbered [1] still names the button by its stable id");
});

test("an inventory with no per-run order still ranks by the id's trailing number", () => {
  // An older or hand-built inventory (no `order` on any entry) must keep ranking the way it did
  // before ids stopped being restamped: by the number in the id.
  const inventory = {
    url: "https://example.test/chat",
    title: "Chat",
    viewport: { w: 1200, h: 800 },
    blocks: [{ id: "sue-7", kind: "paragraph", text: "Newest message from Ada", fontPx: 16, wordCount: 4, bottom: 40 }],
    elements: [
      { id: "sue-1", role: "button", name: "Reply", rect: { x: 0, y: 60, w: 80, h: 30 }, hasVisibleText: true, seenText: "Reply" },
    ],
  };

  const { text } = perceive(inventory, persona);
  const messageAt = text.indexOf("Newest message from Ada");
  const replyAt = text.indexOf("[1] Reply");
  assert.ok(messageAt >= 0 && replyAt >= 0, text);
  assert.ok(replyAt < messageAt, `the lower id ranks first without an order field:\n${text}`);
});
