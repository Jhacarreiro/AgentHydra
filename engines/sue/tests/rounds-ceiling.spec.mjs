// The ceiling cutoff (the Chair, 2026-10-03: "a reasonable cutoff, so we don't end up running till infinity attempting to
// achieve a score that is potentially technically impossible"): a series still without a new best after its ceiling check
// is AT CEILING, and `start` refuses until the build or the plan changes.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { renderTrend, seriesKey, trend, writeRound } from "../lib/rounds.mjs";
import { planHashOf, start } from "../round.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "sue-ceiling-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const target = { stars: 4.5, finishShare: 5 / 6, inARow: 2 };
const REF_AT = "2026-10-02T00:00:00Z";
const day = (n) => `2026-10-${String(n).padStart(2, "0")}T00:00:00Z`;
const row = (n, stars, finished, at = day(n)) => ({ id: `r${n}`, round: n, at, stars, finished, people: 6 });

test("three rounds after the reference round with no new best, under target, are AT CEILING", () => {
  const rows = [row(1, 3.5, 4, day(1)), row(3, 3, 4, day(3)), row(4, 3, 4, day(4)), row(5, 3, 3, day(5))];
  const t = trend(rows, target, { referenceAt: REF_AT });
  assert.equal(t.state, "ceiling");
  assert.equal(t.roundsSinceCeilingCheck, 3);
  const text = renderTrend(t, target).join("\n");
  assert.match(
    text,
    /STATE {4}AT CEILING: this panel's best for this page is 3\.5 stars, 4 of 6 finished \(round 1\); 3 rounds since the ceiling check with no new best/,
  );
  assert.match(text, /NEXT .*ship the best build.*new build.*plan/);
});

test("the same rounds before any reference round are still stuck", () => {
  const rows = [row(3, 3.5, 4), row(4, 3, 4), row(5, 3, 4), row(6, 3, 3)];
  assert.equal(trend(rows, target).state, "stuck");
  assert.equal(trend(rows, target, { referenceAt: day(30) }).state, "stuck");
});

test("a new best after the reference round resets it", () => {
  const rows = [row(1, 3.5, 4), row(3, 3, 4), row(4, 3.8, 4), row(5, 3, 4)];
  assert.notEqual(trend(rows, target, { referenceAt: REF_AT }).state, "ceiling");
});

test("a series that met its target is done, never at ceiling", () => {
  const rows = [row(1, 3.5, 4), row(3, 4.6, 5), row(4, 4.6, 5), row(5, 4.6, 5)];
  assert.equal(trend(rows, target, { referenceAt: REF_AT }).state, "done");
});

test("a ceiling check run before the series' first round still ends the series after three flat rounds", () => {
  const at = (n) => `2026-10-05T0${n}:00:00Z`;
  const rows = [row(1, 3.5, 4, at(1)), row(2, 3.4, 4, at(2)), row(3, 3.5, 4, at(3)), row(4, 3.45, 4, at(4))];
  const t4 = { stars: 4, finishShare: 5 / 6, inARow: 2 };
  const t = trend(rows, t4, { referenceAt: "2026-10-04T00:00:00Z" });
  assert.equal(t.state, "ceiling");
  assert.equal(t.roundsSinceCeilingCheck, 3);
  assert.notEqual(trend(rows.slice(0, 3), t4, { referenceAt: "2026-10-04T00:00:00Z" }).state, "ceiling");
});

// ---- start ----
const SERIES = "capped";
function ceilingPlan(withReuse) {
  const dir = mkdtempSync(path.join(ROOT, "plan-"));
  const plan = {
    file: path.join(dir, "plan.json"),
    series: SERIES,
    workspace: path.join(dir, "ws"),
    state: path.join(dir, "tmp", "sue-round"),
    demo: "http://localhost:1/",
    intent: "try it",
    students: [{ persona: "a", seat: "" }],
    reference: { url: "https://ref.example", series: "capped-ref" },
    ...(withReuse ? { reuse: { builds: [{ url: "https://site.example/", header: "x-build" }] } } : {}),
  };
  writeRound(plan.workspace, seriesKey("capped-ref"), row(1, 4, 5, REF_AT));
  const ids = { builds: withReuse ? { "https://site.example/": "b1" } : undefined, planHash: planHashOf(plan) };
  writeRound(plan.workspace, seriesKey(SERIES), row(1, 3.5, 4, day(1)));
  [3, 4, 5, 6].forEach((n, i) =>
    writeRound(plan.workspace, seriesKey(SERIES), { ...row(n, 3, 4, day(n)), ...(i === 3 ? { ceilingId: ids } : {}) }),
  );
  return plan;
}

async function tryStart(plan, opts, { build = "b1" } = {}) {
  const calls = { run: 0, fetched: [] };
  const fetch = async (url, init) => {
    calls.fetched.push(`${init?.method} ${url}`);
    return { ok: true, headers: { get: () => build }, body: null };
  };
  const run = async () => {
    calls.run += 1;
    return { ok: true, runId: "run-a" };
  };
  const lines = [];
  const log = console.log;
  const exit = process.exit;
  console.log = (...a) => lines.push(a.join(" "));
  let exited = null;
  process.exit = (code) => {
    exited = code;
    throw new Error("exit");
  };
  try {
    await start(plan, { critics: false, ...opts }, { run, fetch });
  } catch (err) {
    if (err.message !== "exit") throw err;
  } finally {
    console.log = log;
    process.exit = exit;
  }
  return { calls, lines: lines.join("\n"), exited };
}

test("start on a series at ceiling with the same build and plan refuses: nothing runs, no demo reset", async () => {
  const plan = ceilingPlan(true);
  const r = await tryStart(plan, {});
  assert.equal(r.exited, 1);
  assert.equal(r.calls.run, 0);
  assert.equal(
    r.calls.fetched.some((f) => f.includes("localhost:1")),
    false,
  );
  console.log(r.lines.split("\n").find((l) => l.startsWith("AT CEILING")));
  assert.match(r.lines, /AT CEILING: this panel's best for this page is 3\.5 stars, 4 of 6 finished \(round 1\)/);
  assert.match(r.lines, /--despite-ceiling/);
});

test("start lets the round go when the build id changed", async () => {
  const r = await tryStart(ceilingPlan(true), {}, { build: "b2" });
  assert.equal(r.exited, null);
  assert.equal(r.calls.run, 1);
  assert.match(r.lines, /AT CEILING lifted: the build changed/);
});

test("start lets the round go when the plan changed", async () => {
  const plan = ceilingPlan(true);
  plan.intent = "try something else";
  const r = await tryStart(plan, {});
  assert.equal(r.calls.run, 1);
  assert.match(r.lines, /AT CEILING lifted: the plan changed/);
});

test("--despite-ceiling starts and prints the reason", async () => {
  const r = await tryStart(ceilingPlan(false), { despiteCeiling: "owner wants one more" });
  assert.equal(r.calls.run, 1);
  assert.match(r.lines, /AT CEILING overridden: owner wants one more/);
});

test("a plan with no reuse block refuses on the plan hash alone", async () => {
  const r = await tryStart(ceilingPlan(false), {});
  assert.equal(r.exited, 1);
  assert.equal(r.calls.run, 0);
});
