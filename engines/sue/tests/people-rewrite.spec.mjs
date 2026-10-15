// Spec for the persona rewrite: prompt, parse, keep-or-revert decision, revert item.
import assert from "node:assert/strict";
import { test } from "node:test";

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildRewritePrompt, decideRewrite, parseRewrite, revertItem, rewritePersona } from "../lib/people-rewrite.mjs";

const doc = { id: "ray", displayName: "Ray", voice: "short and blunt", errands: ["find the cheapest tow"], dials: { patience: 2 } };

test("the prompt carries the current doc, the direction and the id rule", () => {
  const text = buildRewritePrompt({ doc, direction: "open with the errand, not the backstory" });
  assert.ok(text.includes('"displayName": "Ray"'));
  assert.ok(text.includes("open with the errand, not the backstory"));
  assert.match(text, /keep the id/i);
});

test("parse accepts a bare JSON doc with the same id", () => {
  const next = parseRewrite(JSON.stringify({ ...doc, voice: "terser" }), "ray");
  assert.equal(next.voice, "terser");
  assert.equal(next.id, "ray");
});

test("parse accepts a fenced JSON doc", () => {
  const text = "```json\n" + JSON.stringify(doc) + "\n```";
  assert.equal(parseRewrite(text, "ray").displayName, "Ray");
});

test("parse refuses a doc whose id changed", () => {
  assert.throws(() => parseRewrite(JSON.stringify({ ...doc, id: "other" }), "ray"), /id/);
});

test("parse refuses text that is not JSON", () => {
  assert.throws(() => parseRewrite("sorry, no", "ray"), /JSON/);
});

test("parse refuses a doc without a displayName", () => {
  assert.throws(() => parseRewrite(JSON.stringify({ id: "ray" }), "ray"), /displayName/);
});

test("a rewrite is kept only when the A/B says better", () => {
  assert.equal(decideRewrite({ verdict: "better" }).keep, true);
  for (const verdict of ["worse", "same", "unmeasured"]) {
    const d = decideRewrite({ verdict });
    assert.equal(d.keep, false, verdict);
    assert.match(d.why, /revert/);
  }
});

test("the revert item restores the prior doc with a timestamp newer than now", () => {
  const now = "2026-10-14T10:00:00.000Z";
  const item = revertItem(doc, now);
  assert.deepEqual(item.doc, doc);
  assert.ok(Date.parse(item.updatedAt) > Date.parse(now));
});

function fakeDoor() {
  const saves = [];
  const door = async (name, args) => {
    saves.push(args.personas[0]);
    return { ok: true };
  };
  return { door, saves };
}

test("a rewrite the A/B does not read better is saved, then the prior doc is saved back with a newer timestamp, and the ledger says so", async () => {
  const { door, saves } = fakeDoor();
  const dir = mkdtempSync(path.join(tmpdir(), "rewrite-"));
  const ledgerFile = path.join(dir, "ledger.jsonl");
  const now = "2026-10-14T10:00:00.000Z";
  const ask = async () => ({ ...doc, voice: "terser" });
  const out = await rewritePersona({ door, prior: doc, direction: "be terser", ask, ledgerFile, now });
  assert.equal(out.kept, false);
  assert.equal(saves.length, 2);
  assert.equal(saves[0].doc.voice, "terser");
  assert.equal(saves[1].doc.voice, "short and blunt");
  assert.ok(Date.parse(saves[1].updatedAt) > Date.parse(saves[0].updatedAt));
  const row = JSON.parse(readFileSync(ledgerFile, "utf8").trim());
  assert.equal(row.kind, "persona-rewrite");
  assert.equal(row.decision, "reverted");
  assert.equal(row.persona, "ray");
});

test("a rewrite the A/B reads better is kept with one save and no revert", async () => {
  const { door, saves } = fakeDoor();
  const ask = async () => ({ ...doc, voice: "terser" });
  const out = await rewritePersona({ door, prior: doc, direction: "be terser", ask, verdict: "better", now: "2026-10-14T10:00:00.000Z" });
  assert.equal(out.kept, true);
  assert.equal(saves.length, 1);
  assert.equal(out.row.decision, "kept");
});

test("the verdict can come from a persona comparison (comparePersonaDocs): a better one keeps the rewrite, a unresolved one reverts it and says why", async () => {
  const ask = async () => ({ ...doc, voice: "terser" });
  const kept = await rewritePersona({
    door: fakeDoor().door,
    prior: doc,
    direction: "be terser",
    ask,
    comparison: { verdict: "better", why: "notes up past the dead zone" },
    now: "2026-10-14T10:00:00.000Z",
  });
  assert.equal(kept.kept, true);
  assert.equal(kept.row.verdict, "better");
  const reverted = await rewritePersona({
    door: fakeDoor().door,
    prior: doc,
    direction: "be terser",
    ask,
    comparison: { verdict: "unresolved", why: "the newest docs have one round" },
    now: "2026-10-14T10:00:00.000Z",
  });
  assert.equal(reverted.kept, false);
  assert.equal(reverted.row.verdict, "unresolved");
  assert.match(reverted.row.why, /one round/);
});
