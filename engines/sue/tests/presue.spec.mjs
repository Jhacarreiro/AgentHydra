// Pre-sue (lib/presue.mjs): who of SUE's people may be asked about a page, how Jev's answers decide who goes, the drafts
// made when too few fit (checked by Jev, never overwriting a saved person), the floor with no Jev, and an honest save.
// Jev, the brain and the page reader are injected; nothing here reaches the network or Connections.
import assert from "node:assert/strict";
import { test } from "node:test";

import { installTestPeople } from "./fixtures/people.mjs";
import { presueCandidates, runPresue, saveOnboarded, withPresue } from "../lib/presue.mjs";
import { wantsPresue } from "../sue.mjs";

const URL = "https://oplink.example.test/tool";
const INTENT = "your foreman shared a jobsite link and you need to signal the crane from your phone";
const person = (id, extra = {}) => ({
  doc: {
    id,
    displayName: `Own ${id}`,
    extends: "bob",
    voice: `You are ${id}, a person in SUE's own specs who works with their hands for a living.`,
    errands: ["You came because somebody at work said this would save you trouble today."],
    ...extra,
  },
});
installTestPeople([
  person("crane-op", { for: ["oplink.example.test"] }),
  person("other-site", { for: ["elsewhere.example.test"] }),
  person("any-site"),
  person("site-critic", { critic: true, interview: { worst: "What would make a person leave?" } }),
]);

/** A Jev that answers each `fit:<id>` from `p` (anyone unlisted 0.05), recording every call. */
function fakeJev(p, calls = []) {
  return async (items) => {
    calls.push(items);
    return { answers: Object.fromEntries(items.map((i) => [i.id, { probabilities: { yes: p[i.id.slice(4)] ?? 0.05 } }])), unanswered: [] };
  };
}

test("candidates: built-ins and the people written for this site or for none; never a critic, another site's person or a child", () => {
  const ids = presueCandidates({ url: URL, intent: INTENT }).map((c) => c.id);
  for (const id of ["crane-op", "any-site", "bob", "elaine"]) assert.ok(ids.includes(id), `${id} may go`);
  for (const id of ["other-site", "site-critic", "child", "kid-kai"]) assert.ok(!ids.includes(id), `${id} may not`);
  const kids = presueCandidates({ url: URL, intent: "kids aged 9 to 11 practise their times tables here" }).map((c) => c.id);
  assert.ok(kids.includes("child") && !kids.includes("bob"), "a kids ask asks about the children only");
});

test("enough fit: the ones at the bar go strongest first, from one Jev call on one shared state, and nobody is drafted", async () => {
  const calls = [];
  let drafted = 0;
  const r = await runPresue({
    url: URL,
    intent: INTENT,
    jev: fakeJev({ "crane-op": 0.88, "any-site": 0.6, elaine: 0.5, bob: 0.49 }, calls),
    brain: async () => (drafted++, { status: "ok", data: { visitors: [] } }),
  });
  assert.deepEqual(r.send, ["crane-op", "any-site", "elaine"]);
  assert.equal(r.judge, "jev");
  assert.equal(drafted, 0);
  assert.equal(calls.length, 1);
  assert.equal(new Set(calls[0].map((i) => i.state)).size, 1, "every question shares the page as its state");
  assert.equal(r.closest[0].id, "bob", "the best one under the bar is named");
});

test("too few fit: the missing kinds are drafted, Jev re-checks each, and a draft never takes a saved person's id", async () => {
  let asked = null;
  const r = await runPresue({
    url: URL,
    intent: INTENT,
    jev: fakeJev({ "crane-op": 0.9, "rigger-luis": 0.85, "any-site-2": 0.8, "baker-hana": 0.12 }),
    brain: async (spec) => {
      asked = spec;
      return {
        status: "ok",
        model: "fake",
        data: {
          visitors: [
            {
              id: "rigger-luis",
              displayName: "Rigger Luis",
              body: "bob",
              voice: "You are Luis, 40, a rigger and signal person on high-rise jobs.",
              errand: "Your foreman sent this link and you have to signal the crane with it today.",
            },
            {
              id: "any-site",
              displayName: "Site foreman",
              body: "elaine",
              voice: "You are Rosa, 40, a site foreman who runs the crew on a tower job.",
              errand: "You want to know if the crew can start a jobsite from this link before the lift.",
            },
            {
              id: "baker-hana",
              displayName: "Baker Hana",
              body: "elaine",
              voice: "You are Hana, 40, a home baker who sells cakes on Instagram.",
              errand: "Somebody shared this link and you are curious what it is for at all.",
            },
          ],
        },
      };
    },
  });
  assert.match(asked.prompt, /Own crane-op/, "the brain is told who is already going");
  assert.deepEqual(
    r.onboarded.map((v) => v.id),
    ["rigger-luis", "any-site-2"],
  );
  assert.ok(
    r.onboarded.every((v) => v.for?.includes("oplink.example.test")),
    "each is written for this site",
  );
  assert.match(r.refused.find((x) => x.id === "baker-hana")?.why ?? "", /Jev did not find her/);
  assert.deepEqual(r.send, ["crane-op", "rigger-luis", "any-site-2"]);
});

test("a field run's scope is said to Jev's fit question and to the brain that drafts, so the visitors fit that kind of product", async () => {
  const calls = [];
  let prompt = null;
  const scope = "health or medical: patients, carers or clinicians use it for symptoms, care, treatment or health records";
  await runPresue({
    url: URL,
    intent: INTENT,
    scope,
    jev: fakeJev({ "crane-op": 0.9 }, calls),
    brain: async (spec) => ((prompt = spec.prompt), { status: "ok", data: { visitors: [] } }),
  });
  assert.ok(
    calls[0].every((item) => item.state.includes(`What kind of product this is: ${scope}`)),
    "every fit question reads the scope",
  );
  assert.ok(prompt.includes(`What kind of product this is: ${scope}`), "the drafting brain reads the scope");
});

test("no Jev: the people saved for this site fit and nobody else, and the answer says why", async () => {
  const r = await runPresue({ url: URL, intent: INTENT, jev: async () => ({ answers: null, reason: "no key" }) });
  assert.equal(r.judge, "floor");
  assert.match(r.judgeNote, /no key/);
  assert.deepEqual(
    r.fit.map((x) => x.id),
    ["crane-op"],
  );
  assert.match(r.onboardNote, /no brain/);
  assert.deepEqual(r.send, ["crane-op"]);
});

test("a drafting timeout that leaves nobody to send refuses the run, never handing it the roster", async () => {
  const r = await runPresue({
    url: URL,
    intent: INTENT,
    jev: async (items) => ({ answers: Object.fromEntries(items.map((i) => [i.id, { probabilities: { yes: 0.05 } }])) }),
    brain: async () => ({ status: "error", error: "ask timeout exhausted across Swarm routes" }),
  });
  assert.deepEqual(r.send, []);
  assert.throws(() => withPresue({ url: URL, intent: INTENT }, r), /nobody.*ask timeout exhausted across Swarm routes/);
  assert.deepEqual(withPresue({ url: URL, intent: INTENT, personas: "any-site" }, r).personas, "any-site", "named people are the caller's");
});

test("saveOnboarded: a person Connections refused or answered with a newer copy is never called saved", async () => {
  const docs = ["kept-one", "refused-one", "newer-one"].map((id) => person(id).doc);
  const answer = {
    ok: true,
    body: {
      personas: [
        { doc: docs[0], updatedAt: "2026-10-05T12:00:00.000Z" },
        { doc: docs[2], updatedAt: "2026-10-06T00:00:00.000Z" },
      ],
      refused: [{ id: "refused-one", why: "someone else on this board already has this name" }],
    },
  };
  const saved = await saveOnboarded(async () => answer, docs, { now: () => "2026-10-05T12:00:00.000Z" });
  assert.deepEqual(
    saved.map((s) => [s.id, s.saved]),
    [
      ["kept-one", true],
      ["refused-one", false],
      ["newer-one", false],
    ],
  );
});

test("wantsPresue: a link run that names nobody is pre-sued; named people, a cast, an errand or presue false stay the caller's", () => {
  const link = { url: URL, intent: INTENT };
  assert.equal(wantsPresue("run", link), true);
  assert.equal(wantsPresue("focus_group", link), true);
  assert.equal(wantsPresue("_start", link), false, "the Manager page never waits on it");
  assert.equal(wantsPresue("run", { ...link, personas: ["bob"] }), false);
  assert.equal(wantsPresue("run", { ...link, cast: [] }), false);
  assert.equal(wantsPresue("run", { ...link, presue: false }), false);
  assert.equal(wantsPresue("run", { target: "connections", scenario: "first-visit" }), false);
  assert.equal(wantsPresue("run", { ...link, intent: "too short" }), false);
});
