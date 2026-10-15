/**
 * sue-marker.spec - a Sue's browser announces itself on every origin, before page code, with the
 * run and her Sue id (and `borrowed` on a lent login) and nothing else; and the product's one reader
 * (isSueBrowser) sees it.
 *
 * No browser: the init script is a plain function Playwright serializes, so it is run here against
 * a stand-in window, and the context is a recorder of what `addInitScript` was handed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { isSueBrowser, SUE_BROWSER_GLOBAL, SUE_BROWSER_STORAGE_KEY } from "../../lib/shared/sue-browser-marker.mjs";
import { installSueMarker, markSueBrowser } from "../lib/sue-marker.mjs";

function recordingContext() {
  const scripts = [];
  return { scripts, addInitScript: async (fn, arg) => scripts.push({ fn, arg }) };
}

function standInWindow({ storage = true } = {}) {
  const store = new Map();
  const localStorage = {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
  };
  const win = {};
  Object.defineProperty(win, "localStorage", {
    get() {
      if (!storage) throw new Error("SecurityError: no storage on an opaque origin");
      return localStorage;
    },
  });
  return { win, store };
}

async function runInPage(win, script) {
  const previous = globalThis.window;
  globalThis.window = win;
  try {
    script.fn(script.arg);
  } finally {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  }
}

test("installs one init script that sets the window marker and the storage marker to { run, id } only", async () => {
  const context = recordingContext();
  const marker = await installSueMarker(context, { run: "20260928-101500-ab12", id: "sue-1117-grandma" });
  assert.deepEqual(marker, { run: "20260928-101500-ab12", id: "sue-1117-grandma" });
  assert.equal(context.scripts.length, 1);
  assert.equal(context.scripts[0].fn, markSueBrowser);

  const { win, store } = standInWindow();
  await runInPage(win, context.scripts[0]);
  assert.deepEqual(win[SUE_BROWSER_GLOBAL], { run: "20260928-101500-ab12", id: "sue-1117-grandma" });
  assert.deepEqual(JSON.parse(store.get(SUE_BROWSER_STORAGE_KEY)), { run: "20260928-101500-ab12", id: "sue-1117-grandma" });
  assert.equal(isSueBrowser(win), true);
});

test("carries nothing but the run and the Sue id, whatever else the caller hands it", async () => {
  const context = recordingContext();
  await installSueMarker(context, { run: "r", id: "sue-1-x", email: "sue-1-x-ab12@example.com", displayName: "Grandma June" });
  assert.deepEqual(Object.keys(context.scripts[0].arg.marker), ["run", "id"]);
});

test("says `borrowed` only on a lent human login, so analytics moves nothing of that person's", async () => {
  const lent = recordingContext();
  await installSueMarker(lent, { run: "r", id: "sue-3-z", borrowed: true });
  assert.deepEqual(lent.scripts[0].arg.marker, { run: "r", id: "sue-3-z", borrowed: true });
  const own = recordingContext();
  await installSueMarker(own, { run: "r", id: "sue-3-z", borrowed: false });
  assert.deepEqual(Object.keys(own.scripts[0].arg.marker), ["run", "id"]);
});

test("still marks the window on an origin with no storage (about:blank, data:)", async () => {
  const context = recordingContext();
  await installSueMarker(context, { run: "r", id: "sue-2-y" });
  const { win } = standInWindow({ storage: false });
  await runInPage(win, context.scripts[0]);
  assert.deepEqual(win[SUE_BROWSER_GLOBAL], { run: "r", id: "sue-2-y" });
  assert.equal(isSueBrowser(win), true);
});

test("a person's window is not a Sue's", () => {
  assert.equal(isSueBrowser(standInWindow().win), false);
  assert.equal(isSueBrowser(undefined), false);
});
