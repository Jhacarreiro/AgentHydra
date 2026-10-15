/**
 * doctor.spec - the live doctor rows (--doctor --live) and the one-call brain preflight, with no network.
 * ============================================================================================================
 *
 * WHAT: `node --test dredd/tests/doctor.spec.mjs`. Drives lib/doctor.mjs's brainPreflight and
 * liveDoctorRows with injected `ask` / `jev` functions, so a real model and a real Jev call are never
 * needed to pin the behaviour.
 *
 * WHY: P7 (proposal review of MiroFish, 2026-09-23) - a night of dead keys went unseen by the static
 * doctor because it only counts files on disk. These rows round-trip the brain, Jev and the vision leg
 * for real, and must fail closed (never a silent "ok") when any of them does not answer.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { brainPreflight, liveDoctorRows } from "../lib/doctor.mjs";

test("brainPreflight: a structured answer is ok; a flaky leg gets one retry before this reports failure", async () => {
  const calls = [];
  const structured = async (spec) => {
    calls.push(spec);
    return { status: "ok", model: "gemini-3.8-flash", seconds: 1.2, data: { ok: true, note: "hi" } };
  };
  const good = await brainPreflight({ ask: structured });
  assert.equal(good.ok, true);
  assert.equal(good.model, "gemini-3.8-flash");
  assert.equal(good.structured, true);
  assert.equal(good.error, null);
  assert.equal(calls.length, 1, "no retry when the first call lands");
  assert.equal(calls[0].model, "auto");
  assert.ok(calls[0].schema.required.includes("ok") && calls[0].schema.required.includes("note"), "the two-key schema");

  let n = 0;
  const flakyThenGood = async () => {
    n += 1;
    return n === 1
      ? { status: "error", error: "ask.py did not answer in 45 s" }
      : { status: "ok", model: "deepseek", seconds: 3.4, data: { ok: true, note: "second try" } };
  };
  const retried = await brainPreflight({ ask: flakyThenGood });
  assert.equal(retried.ok, true);
  assert.equal(n, 2, "one retry, not more");

  const alwaysDown = async () => ({ status: "error", error: "no key pool" });
  const dead = await brainPreflight({ ask: alwaysDown });
  assert.equal(dead.ok, false);
  assert.equal(dead.structured, false);
  assert.match(dead.error, /no key pool/);
});

test("liveDoctorRows: rows 1 and 2 always run, keyed off the injected ask and Jev", async () => {
  const ask = async () => ({ status: "ok", model: "gemini-3.8-flash", seconds: 0.9, data: { ok: true, note: "hi" } });
  const jev = async (items) => {
    assert.equal(items.length, 1);
    assert.equal(items[0].type, "yesno");
    return {
      answers: { "doctor-probe": { answer: "yes", confidence: 0.9 } },
      summary: { model: "typesafe" },
      unanswered: [],
      reason: null,
    };
  };
  const rows = await liveDoctorRows({ ask, jev, env: { DREDD_VISION: "off" } });
  assert.deepEqual(
    rows.map((r) => r.name),
    ["live: brain (auto)", "live: Jev"],
    "no opus / claude -p row under any env, and no vision row with DREDD_VISION=off",
  );
  assert.equal(rows[0].ok, true);
  assert.match(rows[0].detail, /gemini-3\.8-flash answered structured in 0\.9s/);
  assert.equal(rows[1].ok, true);
  assert.equal(rows[1].needed, false, "Jev is a fallback source, never a blocker");
  assert.match(rows[1].detail, /Jev answered/);

  const deadJev = async () => ({ answers: null, reason: "no TypeSafe key" });
  const rowsDeadJev = await liveDoctorRows({ ask, jev: deadJev, env: { DREDD_VISION: "off" } });
  const jevRow = rowsDeadJev.find((r) => r.name === "live: Jev");
  assert.equal(jevRow.ok, false);
  assert.match(jevRow.detail, /no TypeSafe key/);
});

test("liveDoctorRows: no sealed claude -p row under any env, including DREDD_BRAIN=opus", async () => {
  const calls = [];
  const ask = async (spec) => {
    calls.push(spec);
    return { status: "ok", model: "gemini-3.8-flash", seconds: 1.2, data: spec.schema ? { ok: true, note: "hi" } : undefined };
  };
  const jev = async () => ({ answers: { "doctor-probe": { answer: "yes" } }, summary: {}, unanswered: [], reason: null });
  for (const env of [{ DREDD_VISION: "off" }, { DREDD_BRAIN: "opus", DREDD_VISION: "off" }]) {
    const rows = await liveDoctorRows({ ask, jev, env });
    assert.deepEqual(
      rows.map((r) => r.name),
      ["live: brain (auto)", "live: Jev"],
      "the opus / claude -p row never appears",
    );
  }
  assert.ok(calls.length >= 2, "the brain row still runs");
  assert.ok(
    calls.every((c) => c.schema),
    "every call is the schema round trip, no plain claude -p line",
  );
});

test("liveDoctorRows: the vision row is on by default, off with DREDD_VISION=off, and names a NoVisionLeg refusal", async () => {
  const jev = async () => ({ answers: { "doctor-probe": { answer: "yes" } }, summary: {}, unanswered: [], reason: null });
  let sawImages = null;
  const seeing = async (spec) => {
    if (spec.images) {
      sawImages = spec.images;
      return { status: "ok", model: "gemini-3.8-flash", seconds: 2.1, data: { sees: true } };
    }
    return { status: "ok", model: "gemini-3.8-flash", seconds: 0.5, data: { ok: true, note: "n" } };
  };
  const rows = await liveDoctorRows({ ask: seeing, jev, env: {} });
  const visionRow = rows.find((r) => r.name === "live: vision (tiny PNG)");
  assert.ok(visionRow, "vision is on by default");
  assert.equal(visionRow.ok, true);
  assert.equal(visionRow.needed, false, "vision is a labelled second opinion, never a blocker");
  assert.match(visionRow.detail, /gemini-3\.8-flash saw it in 2\.1s/);
  assert.equal(sawImages?.length, 1, "a real PNG path was handed to the leg");

  const refusing = async (spec) =>
    spec.images
      ? { status: "error", error: "NoVisionLeg: no model with eyes answered" }
      : { status: "ok", model: "x", seconds: 1, data: { ok: true, note: "n" } };
  const refusedRows = await liveDoctorRows({ ask: refusing, jev, env: {} });
  const refusedRow = refusedRows.find((r) => r.name === "live: vision (tiny PNG)");
  assert.equal(refusedRow.ok, false);
  assert.match(refusedRow.detail, /refused: NoVisionLeg/);

  const off = await liveDoctorRows({ ask: seeing, jev, env: { DREDD_VISION: "off" } });
  assert.ok(!off.some((r) => r.name === "live: vision (tiny PNG)"));
});
