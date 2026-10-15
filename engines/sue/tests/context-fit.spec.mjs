/**
 * context-fit.spec - a local brain's Sue is seated only where her prompt fits the loaded context.
 * ===============================================================================================
 *
 * WHAT IT GUARDS: a 170 KB critic mind overflowed a 32k window and every Sue she sat in died at her first turn;
 * the seat check must skip her for the next fitting cast visitor, and read the loaded context from LM Studio.
 * WHO DEPENDS ON IT: nothing imports it; `node --test sue/tests/context-fit.spec.mjs`.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import { loadedContextTokens, seatWithinContext } from "../lib/context-fit.mjs";

const bytesOf = (sizes) => (id) => sizes[id] ?? 0;

test("a persona whose prompt overflows is replaced by the next cast visitor; the others keep their seats", () => {
  const seated = seatWithinContext({
    ids: ["critic", "elaine"],
    castCandidates: [{ id: "elaine" }, { id: "bob" }],
    mindBytesOf: bytesOf({ critic: 150_000 }),
    contextTokens: 32_768,
  });
  assert.deepEqual(seated.ids, ["bob", "elaine"]);
  assert.equal(seated.skips.length, 1);
  assert.equal(seated.skips[0].id, "critic");
  assert.equal(seated.skips[0].replacedBy, "bob");
  assert.ok(seated.skips[0].promptTokens > 32_768);
});

test("a persona who overflows with no cast visitor left to seat is refused, never seated", () => {
  assert.throws(
    () =>
      seatWithinContext({
        ids: ["critic"],
        castCandidates: [],
        mindBytesOf: bytesOf({ critic: 150_000 }),
        contextTokens: 32_768,
      }),
    /no other persona to seat/,
  );
});

test("the loaded context is read from LM Studio's loaded model, and an unloaded model is refused", async () => {
  const listing = (state) => async () => ({
    ok: true,
    json: async () => ({ data: [{ id: "qwen3-vl-30b-a3b-instruct", state, loaded_context_length: 32_768 }] }),
  });
  const baseUrl = "http://127.0.0.1:1234";
  const model = "qwen3-vl-30b-a3b-instruct";
  assert.equal(await loadedContextTokens({ baseUrl, model, fetchImpl: listing("loaded") }), 32_768);
  await assert.rejects(loadedContextTokens({ baseUrl, model, fetchImpl: listing("not-loaded") }), /is not loaded/);
});
