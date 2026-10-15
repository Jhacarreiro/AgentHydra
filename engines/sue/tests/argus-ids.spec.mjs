// argus-ids: a Sue's trace names the ARGUS visit she made, and an absent id never fails a hop.
// Run: node --test sue/tests/argus-ids.spec.mjs

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { analyticsView } from "../analytics-view.mjs";
import { argusSidsIn, isArgusRow, learnArgusRow, pickArgusIds, readArgusIds, readArgusIdsInPage } from "../lib/argus-ids.mjs";
import { sueMarker } from "../lib/sue-marker.mjs";
import { fillSueIds, startUrlFor } from "../lib/findings.mjs";
import { loadSue } from "../report.mjs";

test("a start URL takes this Sue's ids in place of the placeholders, before it is parsed", () => {
  const ids = { sueId: "sue 7", runId: "run/9" };
  assert.equal(fillSueIds("https://app.test/x/{sueId}?r={runId}", ids), "https://app.test/x/sue%207?r=run%2F9");
  assert.equal(fillSueIds("https://app.test/plain", ids), "https://app.test/plain");
  assert.equal(startUrlFor({ startUrl: "https://app.test/a/{sueId}" }, {}, ids), "https://app.test/a/sue%207");
  assert.equal(startUrlFor({ startUrl: "https://app.test" }, { startPath: "/go/{runId}" }, ids), "https://app.test/go/run%2F9");
});

test("the session id comes from sessionStorage, the anonymous id from localStorage before the cookie", () => {
  assert.deepEqual(pickArgusIds({ session: "s1", local: "a1", cookie: "c1" }), { argus_sid: "s1", argus_anon: "a1" });
  assert.deepEqual(pickArgusIds({ session: null, local: null, cookie: "c1" }), { argus_sid: null, argus_anon: "c1" });
  assert.deepEqual(pickArgusIds({}), { argus_sid: null, argus_anon: null });
});

test("the in-page read takes argus_anon from the cookie jar when storage has none", () => {
  const saved = {
    sessionStorage: globalThis.sessionStorage,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
    document: globalThis.document,
  };
  globalThis.window = { sessionStorage: { getItem: () => "sid-9" }, localStorage: { getItem: () => null } };
  globalThis.document = { cookie: "theme=dark; argus_anon=anon-7; other=1" };
  try {
    assert.deepEqual(readArgusIdsInPage(), { session: "sid-9", local: null, cookie: "anon-7" });
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("a page that cannot answer gives nulls, never a thrown error", async () => {
  const broken = {
    evaluate: async () => {
      throw new Error("navigated away");
    },
  };
  assert.deepEqual(await readArgusIds(broken), { argus_sid: null, argus_anon: null });
  assert.deepEqual(await readArgusIds({}), { argus_sid: null, argus_anon: null });
});

test("a page that hangs is cut at the timeout and reads as absent", async () => {
  const hung = { evaluate: () => new Promise(() => {}) };
  assert.deepEqual(await readArgusIds(hung, 20), { argus_sid: null, argus_anon: null });
});

test("a page that answers is read through the picker", async () => {
  const page = { evaluate: async () => ({ session: "sid-1", local: "anon-1", cookie: null }) };
  assert.deepEqual(await readArgusIds(page), { argus_sid: "sid-1", argus_anon: "anon-1" });
});

test("summary lists each ARGUS session id once, in order, and skips rows without one", () => {
  const trace = [
    JSON.stringify({ kind: "hop", argus_sid: "s-a" }),
    JSON.stringify({ kind: "hop", argus_sid: null }),
    JSON.stringify({ tool: "click", argus_sid: "s-b" }),
    JSON.stringify({ kind: "hop", argus_sid: "s-a" }),
    "{ torn",
    "",
  ].join("\n");
  assert.deepEqual(argusSidsIn(trace), ["s-a", "s-b"]);
  assert.deepEqual(argusSidsIn(""), []);
});

test("an end row's id never counts toward a Sue's ARGUS sessions, even when it is the only one", () => {
  assert.deepEqual(argusSidsIn(JSON.stringify({ kind: "end", argus_sid: "s-x" })), []);
});

test("a look learns the page's ARGUS session id once, as an argus row, and a failed read adds nothing", async () => {
  let sid = null;
  const page = { evaluate: async () => ({ session: sid, local: "a-1", cookie: null }) };
  const seen = new Set();
  assert.equal(await learnArgusRow(page, seen, "t1"), null);
  sid = "sid-late";
  const row = await learnArgusRow(page, seen, "t2");
  assert.deepEqual(row, { at: "t2", kind: "argus", argus_sid: "sid-late", argus_anon: "a-1" });
  assert.equal(isArgusRow(row), true);
  assert.equal(await learnArgusRow(page, seen, "t3"), null);
  assert.equal(await learnArgusRow({ evaluate: async () => Promise.reject(new Error("gone")) }, seen, "t4"), null);
});

test("the marker carries the scenario and persona ids beside run and id, and only when given", () => {
  assert.deepEqual(sueMarker({ run: "r1", id: "sue-3", scenario: "signup", persona: "casual-cassie" }), {
    run: "r1",
    id: "sue-3",
    scenario: "signup",
    persona: "casual-cassie",
  });
  assert.deepEqual(sueMarker({ run: "r1", id: "sue-3" }), { run: "r1", id: "sue-3" });
});

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// A visit as body.mjs writes it: the pixel sets its id after load, one look reads it, then the page may die before the end row.
async function visitRun({ died }) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-visit-"));
  roots.push(runDir);
  let sid = null;
  let dead = false;
  const page = {
    evaluate: async () => {
      if (dead) throw new Error("target closed");
      return { session: sid, local: null, cookie: null };
    },
  };
  const seen = new Set();
  const trace = [{ at: "t1", kind: "hop", url: "https://x.test/", argus_sid: null, argus_anon: null }];
  sid = "S-died";
  const look = await learnArgusRow(page, seen, "t2");
  if (look) trace.push(look);
  dead = died;
  trace.push({ at: "t3", kind: "end", ...(await readArgusIds(page)) });
  const sueDir = path.join(runDir, "sue-3-died");
  fs.mkdirSync(sueDir);
  const text = trace.map((row) => JSON.stringify(row)).join("\n") + "\n";
  fs.writeFileSync(path.join(sueDir, "trace.jsonl"), text);
  fs.writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 3 }));
  fs.writeFileSync(path.join(sueDir, "findings.jsonl"), "");
  fs.writeFileSync(path.join(sueDir, "summary.json"), JSON.stringify({ persona: "sue-3-died", argusSids: argusSidsIn(text) }));
  return runDir;
}
const visitEvents = [{ occurred_at: "2026-10-11T14:00:00.000Z", page_path: "/", session_id: "S-died", event_type: "pageview", event_name: "page_view", props: {} }];

test("a pixel id that appears after load and is read on a look still joins the Sue when her browser dies before the end row", async () => {
  const view = await analyticsView({ runId: "r1", dir: await visitRun({ died: true }), events: visitEvents, write: false });
  const sue = view.sues.find((s) => s.sueId === "sue-3-died");
  assert.equal(sue.seen, true);
  assert.deepEqual(sue.argusSids, ["S-died"]);
});

test("the same visit ending normally joins once, and its end row adds no second id", async () => {
  const view = await analyticsView({ runId: "r1", dir: await visitRun({ died: false }), events: visitEvents, write: false });
  const sue = view.sues.find((s) => s.sueId === "sue-3-died");
  assert.equal(sue.seen, true);
  assert.deepEqual(sue.argusSids, ["S-died"]);
});

test("a visit's closing ARGUS row is neither a move nor a hop in the report", () => {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "argus-end-"));
  roots.push(runDir);
  const sueDir = path.join(runDir, "sue-1-cassie");
  fs.mkdirSync(sueDir);
  fs.writeFileSync(
    path.join(sueDir, "trace.jsonl"),
    [
      JSON.stringify({ at: "t1", tool: "click", args: { ref: "e1" } }),
      JSON.stringify({ at: "t2", kind: "hop", url: "https://app.test/", tab: 1 }),
      JSON.stringify({ at: "t3", kind: "argus", argus_sid: "s-a", argus_anon: "a-1" }),
      JSON.stringify({ at: "t4", kind: "end", argus_sid: "s-a", argus_anon: "a-1" }),
    ].join("\n") + "\n",
  );
  const sue = loadSue(runDir, "sue-1-cassie");
  assert.deepEqual(
    sue.trace.map((row) => row.tool),
    ["click"],
  );
  assert.equal(sue.hops.length, 1);
  assert.equal(sue.hops[0].kind, "hop");
});
