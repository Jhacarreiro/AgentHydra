/**
 * people.spec - what lib/people.mjs promises beyond a fetch: a save is only "saved" when Connections kept THIS copy, and a
 * folder's leftover person files are moved into Connections and deleted, never left behind or lost (Owner, 2026-09-28:
 * "There should not be a single local personality in the workspace").
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { adoptFolderPeople, keptCopy, savePersonaAnswer } from "../lib/people.mjs";
import { sentPeople } from "../lib/personas.mjs";
import { installTestPeople } from "./fixtures/people.mjs";

const RAY = {
  id: "broker-ray",
  displayName: "Ray",
  extends: "bob",
  voice: "You are Ray, a broker who reads every listing twice before he calls.",
};

test("keptCopy says saved only when Connections answered back the very copy this save sent", () => {
  const sent = { doc: RAY, updatedAt: "2026-09-28T10:00:00.000Z" };
  assert.deepEqual(keptCopy([{ doc: RAY, updatedAt: "2026-09-28T10:00:00Z" }], sent), { saved: true });
  const lost = keptCopy([{ doc: RAY, updatedAt: "2026-09-28T11:00:00.000Z" }], sent);
  assert.equal(lost.saved, false, "a newer copy there won, with no refusal");
  assert.match(lost.why, /kept a newer copy/);
  assert.equal(keptCopy([], sent).saved, false);
});

// 2026-10-07: newcomer-priya-gamers came back ok:true while the Boardroom refused her, because newcomer-priya-self-hosters
// already had the displayName "Newcomer Priya" on that board (one person per name, boardroom schema 0028).
test("save_persona answers ok:false, naming the clash, when Connections refuses a second person of the same displayName", async () => {
  const board = new Map();
  const door = async (_tool, body) => {
    const refused = [];
    for (const { doc, updatedAt } of body.personas) {
      const taken = [...board.values()].some((p) => p.doc.id !== doc.id && p.doc.displayName === doc.displayName);
      if (taken) refused.push({ id: doc.id, why: "someone else on this board already has this name" });
      else board.set(doc.id, { doc, updatedAt });
    }
    return { ok: true, status: 200, body: { personas: [...board.values()], refused } };
  };
  const made = (id) => ({ ok: true, persona: { ...RAY, id, displayName: "Newcomer Priya" } });

  const first = await savePersonaAnswer(door, made("newcomer-priya-self-hosters"));
  assert.equal(first.ok, true);
  assert.deepEqual(first.inConnections, { saved: true });

  const second = await savePersonaAnswer(door, made("newcomer-priya-gamers"));
  assert.equal(second.ok, false, "a person Connections did not keep is never ok");
  assert.equal(second.inConnections.saved, false);
  assert.match(second.error, /newcomer-priya-gamers \("Newcomer Priya"\): someone else on this board already has this name/);
  assert.deepEqual([...board.keys()], ["newcomer-priya-self-hosters"]);
});

test("a folder's old person files move into Connections and are deleted; one Connections refused stays, named", async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "sue-adopt-"));
  try {
    const dir = path.join(folder, ".sue", "personas");
    fs.mkdirSync(path.join(dir, "portraits"), { recursive: true });
    fs.writeFileSync(path.join(dir, "broker-ray.json"), JSON.stringify(RAY));
    fs.writeFileSync(path.join(dir, "bad-bea.json"), JSON.stringify({ ...RAY, id: "bad-bea" }));
    fs.writeFileSync(path.join(dir, "notes.json"), "not json");
    fs.writeFileSync(path.join(dir, "portraits", "broker-ray.webp"), "a picture");
    const calls = [];
    const door = async (tool, body) => {
      calls.push({ tool, ids: body.personas.map((p) => p.doc.id) });
      return {
        ok: true,
        body: {
          personas: [{ doc: RAY, updatedAt: body.personas[0].updatedAt }],
          refused: [{ id: "bad-bea", why: "someone else on this board already has this name" }],
        },
      };
    };
    const out = await adoptFolderPeople(folder, door);
    assert.deepEqual(out.moved, ["broker-ray"]);
    assert.deepEqual(out.kept.map((k) => k.file).sort(), ["bad-bea.json", "notes.json"]);
    assert.deepEqual(calls, [{ tool: "boardroom_personas_sue_save", ids: ["bad-bea", "broker-ray"] }]);
    assert.deepEqual(fs.readdirSync(dir).sort(), ["bad-bea.json", "notes.json", "portraits"], "moved gone, refused kept, pictures kept");
    assert.deepEqual(await adoptFolderPeople(path.join(folder, "nowhere"), door), { moved: [], kept: [] });
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test("sentPeople answers each person whole, the copy a run sends (the workspace's over a built-in), and names who is not there", () => {
  const ownBob = { id: "bob", extends: "bob", voice: "You are Bob, edited for this workspace, and it is this copy a run sends." };
  installTestPeople([{ doc: RAY }, { doc: ownBob }]);
  try {
    const { people, missing } = sentPeople(["broker-ray", "bob", "casual-cassie", "nobody-here"]);
    assert.deepEqual(
      people.map((p) => [p.id, p.builtIn]),
      [
        ["broker-ray", false],
        ["bob", false],
        ["casual-cassie", true],
      ],
    );
    assert.deepEqual(people[0].doc, RAY, "whole, never a summary");
    assert.equal(people[1].doc.voice, ownBob.voice, "the workspace's copy of a built-in is the one a run sends");
    assert.deepEqual(missing, ["nobody-here"], "never dropped quietly");
    assert.ok(
      sentPeople().people.some((p) => p.id === "broker-ray"),
      "no ids: everyone",
    );
  } finally {
    installTestPeople();
  }
});

test("savePeople batches under the per-call size and reports exactly who was saved and who was refused", async () => {
  const { savePeople, SUE_SAVE_BATCH } = await import("../lib/people.mjs");
  const items = Array.from({ length: SUE_SAVE_BATCH * 2 + 5 }, (_, i) => ({ doc: { id: `p-${i}` }, updatedAt: "t" }));
  const sizes = [];
  const door = async (_tool, body) => {
    sizes.push(body.personas.length);
    return { ok: true, status: 200, body: { personas: [], refused: body.personas.some((p) => p.doc.id === "p-150") ? [{ id: "p-150", why: "full" }] : [] } };
  };
  const out = await savePeople(door, items);
  assert.deepEqual(sizes, [SUE_SAVE_BATCH, SUE_SAVE_BATCH, 5]);
  assert.equal(out.saved.length, items.length - 1);
  assert.deepEqual(out.refused, [{ id: "p-150", why: "full" }]);

  const failing = async (_tool, body) => (body.personas[0].doc.id === "p-100" ? { ok: false, status: 409, body: {} } : { ok: true, status: 200, body: { personas: [], refused: [] } });
  const err = await savePeople(failing, items).catch((e) => e);
  assert.equal(err.saved.length, SUE_SAVE_BATCH);
  assert.equal(err.notSaved.length, SUE_SAVE_BATCH + 5);
});
