// Reference rounds: a plan's star bar is measured against a reference series the same people rate. The ceiling check
// (`round.mjs start --reference`) is scored on the reference product's own doneWhen, kept in the reference's series,
// and printed as the new bar; it never starts a review table over the reference product.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { report, roundRuns } from "../round.mjs";
import { meetsTarget, readRounds, renderTrend, seriesKey, targetOf, trend, writeRound } from "../lib/rounds.mjs";

const ROOT = mkdtempSync(path.join(tmpdir(), "sue-ref-"));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const plan = { target: { stars: 4.5, starsVs: { series: "ref", within: 0.2 } } };
let n = 0;
const ws = () => mkdtempSync(path.join(ROOT, `ws-${(n += 1)}-`));
const row = (id, stars) => ({ id, at: `2026-10-0${id}T00:00:00Z`, stars, finished: 5, people: 6 });

describe("starsVs", () => {
  test("the bar is the reference's latest stars minus within", () => {
    const w = ws();
    writeRound(w, seriesKey("ref"), row("1", 3.5));
    writeRound(w, seriesKey("ref"), row("2", 3.83));
    assert.equal(targetOf(plan, w).stars, 3.63);
  });
  test("falls back to target.stars with no reference round", () => {
    assert.equal(targetOf(plan, ws()).stars, 4.5);
  });
  test("a round meets the target on the relative bar, and the line says reference", () => {
    const w = ws();
    writeRound(w, seriesKey("ref"), row("1", 3.83));
    const target = targetOf(plan, w);
    const r = row("1", 3.67);
    assert.equal(meetsTarget(r, target), true);
    assert.equal(meetsTarget(r), false);
    const text = renderTrend(trend([r], target), target).join("\n");
    assert.match(text, /3\.67 stars vs the reference's 3\.83 \(bar 3\.63\)/);
  });
});

describe("a reference round", () => {
  test("is refused before any run when the plan's reference names no series", () => {
    const p = { students: [{ persona: "kid-a", seat: "/" }], reference: { url: "https://ref.example" } };
    assert.throws(() => roundRuns(p, { reference: true }), /reference\.series/);
  });

  test("is scored on the reference's doneWhen, kept in its series, sets the bar, and starts no table", async () => {
    const w = ws();
    const dir = mkdtempSync(path.join(ROOT, "plan-"));
    const refPlan = {
      file: path.join(dir, "plan.json"),
      series: "main",
      workspace: w,
      state: path.join(dir, "tmp", "sue-round"),
      doneWhen: ["the main product's end"],
      target: { stars: 4.5, starsVs: { series: "ref", within: 0.2 } },
      reference: { url: "https://ref.example", series: "ref", doneWhen: ["You won"] },
    };
    writeRound(w, seriesKey("main"), row("1", 3.2));
    const resetAt = "2026-10-03T10:00:00.000Z";
    mkdirSync(refPlan.state, { recursive: true });
    writeFileSync(
      path.join(refPlan.state, "last-reference.json"),
      JSON.stringify({ series: "ref", kind: "people", reference: true, resetAt, runs: [{ name: "kid-a", runId: "r1" }] }),
    );
    const runsDir = path.join(dir, "runs");
    const sueDir = path.join(runsDir, "r1", "sue-1-kid-a");
    mkdirSync(sueDir, { recursive: true });
    writeFileSync(path.join(sueDir, "trace.jsonl"), `${JSON.stringify({ tool: "look", pageText: "Level 9. You won!" })}\n`);
    writeFileSync(path.join(sueDir, "interview.json"), JSON.stringify({ starsOutOfFive: 4 }));

    let tables = 0;
    await report(
      refPlan,
      { table: true, reference: true },
      { run: async () => ({ ok: true, complete: true }), runsDir, startTable: async () => (tables += 1) },
    );

    const [ref] = readRounds(w, seriesKey("ref"));
    assert.equal(ref.id, resetAt);
    assert.equal(ref.series, "ref");
    assert.equal(ref.finished, 1, "finished on the reference's own doneWhen");
    assert.equal(ref.stars, 4);
    assert.deepEqual(
      readRounds(w, seriesKey("main")).map((r) => r.stars),
      [3.2],
      "the main series is untouched",
    );
    assert.equal(tables, 0, "no review table over the reference product");
    assert.equal(targetOf(refPlan, w).stars, 3.8, "the reference's stars are the bar");
  });
});
