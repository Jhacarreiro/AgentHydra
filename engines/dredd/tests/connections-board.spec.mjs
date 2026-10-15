// connections-board - Dredd's seats as Connections board members, FOUND on the Boardroom every sitting (Owner, 2026-09-26):
// a create asks the plane to hand back the scope's person of that name, a room likewise, so a second PC makes nobody.
// The local file only remembers what content this PC last pushed. No network: a fake MCP that keeps a workspace.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  boardroomWords,
  evidenceLines,
  madeId,
  personaFields,
  roomName,
  seatOnConnections,
  seatWords,
  wrapUpAnswerText,
} from "../lib/connections-board.mjs";
import { reapAfterEach } from "./_scratch.mjs";

const LIMITS = {
  personaName: 60,
  personaModeledOn: 120,
  personaSeatTitle: 120,
  personaOneLiner: 400,
  personaBrief: 60000,
  personaPlaybook: 400000,
};

const seat = (slug, brief = `You are ${slug}.`) => ({
  slug,
  name: slug.toUpperCase(),
  modeledOn: null,
  seatTitle: "",
  oneLiner: "",
  brief,
  playbook: "",
});

/** Ids are unique across every fake, the way the plane's are. */
let n = 0;

/** One workspace on the plane: people by name and rooms by name + seating, the way `reuse: true` finds them. */
function workspace(companyId = "ws-here") {
  return { companyId, people: new Map(), rooms: [] };
}

/** A fake local MCP over `ws`: answers the boardroom endpoints the way the plane does, and records every call. */
function fakeMcp(ws = workspace(), others = []) {
  const calls = [];
  const every = [ws, ...others];
  const whose = (companyId) => (companyId ? every.find((w) => w.companyId === companyId) : ws);
  return {
    calls,
    ws,
    async api(service, tool, body) {
      calls.push({ service, tool, body });
      if (tool === "boardroom_personas_create") {
        const found = body.reuse ? ws.people.get(body.name.toLowerCase()) : null;
        if (found) return { ok: true, status: 200, body: { reused: true, persona: { id: found.id } } };
        // The plane makes a person from a name and a brief, or a copy (openapi-boardroom-paths: name + brief | copyFrom).
        if (!body.copyFrom && !String(body.brief ?? "").trim()) return { ok: false, status: 400, body: { error: "brief_required" } };
        const person = { id: `p-${++n}`, companyId: ws.companyId, updatedAt: "2026-09-28T12:00:00.000Z", ...body };
        ws.people.set(body.name.toLowerCase(), person);
        return { ok: true, status: 200, body: { ...(body.reuse ? { reused: false } : {}), persona: { id: person.id } } };
      }
      if (tool === "boardroom_personas_update") {
        for (const w of every) for (const p of w.people.values()) if (p.id === body.id) Object.assign(p, body);
        return { ok: true, status: 200, body: {} };
      }
      if (tool === "boardroom_personas_list") {
        const w = whose(body.companyId);
        if (w?.refuses) return { ok: false, status: 403, body: { error: "not_a_member" } };
        const personas = [...(w?.people.values() ?? [])].map(({ brief: _b, playbook: _p, ...card }) => card);
        return { ok: true, status: 200, body: { personas } };
      }
      if (tool === "boardroom_personas_get") {
        const person = every.flatMap((w) => [...w.people.values()]).find((p) => p.id === body.id);
        return person
          ? { ok: true, status: 200, body: { persona: person } }
          : { ok: false, status: 404, body: { error: "persona_not_found" } };
      }
      if (tool === "boardroom_rooms_create") {
        const key = `${body.name}|${body.personaIds.join(",")}`;
        const found = body.reuse ? ws.rooms.find((r) => r.key === key) : null;
        if (found) return { ok: true, status: 200, body: { reused: true, room: { id: found.id } } };
        const room = { id: `r-${++n}`, key };
        ws.rooms.push(room);
        return { ok: true, status: 200, body: { reused: false, room: { id: room.id } } };
      }
      return { ok: false, status: 404, body: { error: "unknown_route" } };
    },
  };
}

const scratchDirs = reapAfterEach([]);

/** A PC's own pushed-content file, in a fresh folder: a second call is a second PC. */
function aPc() {
  const dir = mkdtempSync(path.join(tmpdir(), "dredd-board-"));
  scratchDirs.push(dir);
  return path.join(dir, "connections-board.json");
}

const opts = (cacheFile) => ({ cacheFile, label: "product", limits: LIMITS, maxSeats: 5 });
const tools = (mcp) => mcp.calls.map((c) => c.tool);

test("a seat is found on the Boardroom: a second PC with no memory of its own makes nobody and sits in the same room", async () => {
  const seats = [seat("design-critic"), seat("copy-editor")];
  const ws = workspace();
  const first = fakeMcp(ws);
  const a = await seatOnConnections(first, seats, opts(aPc()));
  assert.equal(a.made, 2);
  assert.ok(
    first.calls.every((c) => c.tool === "boardroom_personas_update" || c.body.reuse === true),
    "every create asks to reuse",
  );

  const second = fakeMcp(ws);
  const b = await seatOnConnections(second, seats, opts(aPc()));
  assert.equal(b.made, 0);
  assert.equal(ws.people.size, 2, "still one of each person");
  assert.equal(ws.rooms.length, 1, "still one room");
  assert.equal(b.roomId, a.roomId);
  assert.equal(b.personaIdOf.get("design-critic"), a.personaIdOf.get("design-critic"));
});

test("the same PC again pushes nothing it already pushed", async () => {
  const seats = [seat("design-critic")];
  const ws = workspace();
  const pc = aPc();
  await seatOnConnections(fakeMcp(ws), seats, opts(pc));
  const again = fakeMcp(ws);
  const out = await seatOnConnections(again, seats, opts(pc));
  assert.deepEqual(tools(again), ["boardroom_personas_create", "boardroom_rooms_create"]);
  assert.equal(out.updated, 0);
});

test("a big playbook is filled by an update after the member is made empty, so the id is always readable", async () => {
  // The plane echoes a new member back whole; a 270k playbook pushed that echo past the MCP's 200k cap and the id
  // was lost while the member existed (2026-09-23). The fake answers a create that carries a big playbook the way
  // the MCP did - cut, no body - so only the empty-first create can succeed.
  const mcp = fakeMcp();
  const inner = mcp.api;
  mcp.api = async (service, tool, body) => {
    if (tool === "boardroom_personas_create" && (body.playbook || "").length > 1000) {
      mcp.calls.push({ service, tool, body });
      return { ok: true, status: 200, body: null, truncated: true, text: "cut" };
    }
    return inner(service, tool, body);
  };
  const big = { ...seat("mind-rory"), playbook: `## Entry\n${"x".repeat(5000)}` };
  const pc = aPc();
  const res = await seatOnConnections(mcp, [big], opts(pc));
  assert.deepEqual(tools(mcp), ["boardroom_personas_create", "boardroom_personas_update", "boardroom_rooms_create"]);
  assert.equal(mcp.calls[0].body.playbook, "", "made with its playbook empty");
  assert.equal(mcp.calls[1].body.playbook, big.playbook, "then filled");
  assert.equal(res.made, 1);
  const again = fakeMcp(mcp.ws);
  await seatOnConnections(again, [big], opts(pc));
  assert.deepEqual(tools(again), ["boardroom_personas_create", "boardroom_rooms_create"], "found, and not filled twice");
});

test("a changed brief is an update (free) of the person found, never a second board member", async () => {
  const ws = workspace();
  const pc = aPc();
  await seatOnConnections(fakeMcp(ws), [seat("design-critic")], opts(pc));
  const mcp = fakeMcp(ws);
  const out = await seatOnConnections(mcp, [seat("design-critic", "You are sharper now.")], opts(pc));
  assert.deepEqual(tools(mcp), ["boardroom_personas_create", "boardroom_personas_update", "boardroom_rooms_create"]);
  assert.equal(mcp.calls[1].body.brief, "You are sharper now.");
  assert.equal(out.updated, 1);
  assert.equal(out.made, 0);
  assert.equal(ws.people.size, 1);
});

test("a refused create names the plane's own words (a credit refusal carries a sentence)", async () => {
  const mcp = {
    api: async () => ({
      ok: false,
      status: 402,
      body: { error: "person_credits_exhausted", message: "You're out of usage for now, so the board member was not added." },
    }),
  };
  await assert.rejects(
    seatOnConnections(mcp, [seat("design-critic")], opts(aPc())),
    /out of usage for now, so the board member was not added/,
  );
});

test("more seats than the plane seats is refused before anything is made", async () => {
  const mcp = fakeMcp();
  const six = ["a", "b", "c", "d", "e", "f"].map((s) => seat(s));
  await assert.rejects(seatOnConnections(mcp, six, opts(aPc())), /seats 5/);
  assert.deepEqual(tools(mcp), []);
});

test("roomName names the room by who sits in it, within the plane's 80 characters", () => {
  const five = ["The Design Critic", "The Copy Editor", "Grandma Sue", "The Architect", "The Product Engineer"].map((name) => ({ name }));
  const name = roomName("product", five);
  assert.ok(name.startsWith("Dredd product: Design Critic, Copy Editor, Grandma Sue"));
  assert.ok(name.length <= 80);
  assert.equal(roomName("tooling", [{ name: "The Operator" }]), "Dredd tooling: Operator");
});

test("personaFields cuts every field to the plane's ceiling", () => {
  const long = seat("x".repeat(200));
  long.modeledOn = "m".repeat(500);
  const fields = personaFields(long, LIMITS);
  assert.equal(fields.name.length, 60);
  assert.equal(fields.modeledOn.length, 120);
  assert.equal(personaFields(seat("a"), LIMITS).modeledOn, null);
});

test("evidenceLines splits on a line break under the cap, and keeps everything", () => {
  const text = Array.from({ length: 50 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const lines = evidenceLines(text, 400);
  assert.ok(lines.every((l) => l.length <= 400));
  assert.equal(lines.join("\n").replace(/\s+/g, ""), text.replace(/\s+/g, ""));
  assert.deepEqual(evidenceLines("", 400), []);
});

test("wrapUpAnswerText writes the four headings the plane reads a write-up by", () => {
  const text = wrapUpAnswerText({ title: "T", minutes: "M", plan: "P", closing_line: "C" });
  assert.deepEqual(
    text.split("\n").filter((l) => l.startsWith("# ")),
    ["# Title", "# Minutes", "# Plan", "# Closing line"],
  );
});

test("madeId reads the id off a body the MCP handed over as a cut JSON string", () => {
  // A minds room echoes every seat's playbook, so the local MCP returns its body as a raw JSON STRING cut at ~197k
  // characters rather than an object (measured 2026-09-24). The plane serializes id first, so the string's head
  // still carries it; before this every minds sitting made a room it could not read the id of and failed.
  const id = "046e27a0-0302-4ccf-8dab-8a2701270125";
  const cut = `{"room":{"id":"${id}","name":"Dredd - minds room","seats":[{"persona":{"playbook":"${"x".repeat(5000)}`;
  assert.equal(madeId({ ok: true, status: 200, body: cut }, "room"), id);
  assert.equal(madeId({ ok: true, status: 200, body: { room: { id } } }, "room"), id);
  assert.equal(madeId({ ok: true, status: 200, body: '{"error":"x"}' }, "room"), null);
});

test("a room whose echo arrives as a cut string is still read", async () => {
  const id = "b70db671-534b-4254-85be-107d82198772";
  const mcp = fakeMcp();
  const real = mcp.api;
  mcp.api = async (service, tool, body) => {
    if (tool !== "boardroom_rooms_create") return real(service, tool, body);
    mcp.calls.push({ service, tool, body });
    return { ok: true, status: 200, body: `{"reused":true,"room":{"id":"${id}","seats":[{"persona":{"brief":"${"y".repeat(9000)}` };
  };
  const out = await seatOnConnections(mcp, [seat("design-critic")], opts(aPc()));
  assert.equal(out.roomId, id);
});

// Owner, 2026-09-28: "There should not be a single local personality in the workspace"; 2026-10-15: every persona's
// text on the SSH server, read from there. A seat file names who sits; the words are the seat's tier "seat" row in the
// persona store, and a sitting pushes only what it derives over them.
function fakeStore(...rows) {
  const store = {
    lists: 0,
    rows: rows.map(({ seat: id, ...words }, i) => ({
      id: `s-${i + 1}`,
      slug: `seat-${id}`,
      modeled_on: null,
      seat_title: "",
      one_liner: "",
      playbook: "",
      updated_at: "2026-10-15T10:00:00.000Z",
      sue: { tier: "seat", owner: "owner", seat: id },
      ...words,
    })),
    async list({ tier }) {
      store.lists += 1;
      const rows = store.rows.filter((r) => r.sue.tier === tier).map((r) => ({ id: r.id, slug: r.slug, tier: r.sue.tier, seat: r.sue.seat }));
      return { count: rows.length, rows };
    },
    async get(id) {
      const row = store.rows.find((r) => r.id === id);
      if (!row) throw new Error(`no persona ${id}`);
      return row;
    },
  };
  return store;
}
const named = (slug, extra = {}) => ({ slug, name: slug.toUpperCase(), push: [], ...extra });
const fromStore = (cacheFile, store) => ({ ...opts(cacheFile), store });

test("a seat's words come from the store into a workspace that lacks the member, read once a sitting and never off Connections", async () => {
  const store = fakeStore(
    { seat: "design-critic", name: "DESIGN-CRITIC", brief: "You judge rhythm.", playbook: "## Rhythm\nOne grid.", seat_title: "Critic" },
    { seat: "copy-editor", name: "COPY-EDITOR", brief: "You cut every third word." },
  );
  const mcp = fakeMcp();
  const out = await seatOnConnections(mcp, [named("design-critic"), named("copy-editor")], fromStore(aPc(), store));
  const made = mcp.ws.people.get("design-critic");
  assert.equal(made.brief, "You judge rhythm.");
  assert.equal(made.seatTitle, "Critic");
  assert.equal(made.playbook, "## Rhythm\nOne grid.", "the playbook follows as an update");
  assert.equal(out.made, 2);
  assert.equal(store.lists, 1, "one list a sitting");
  assert.ok(!tools(mcp).includes("boardroom_personas_get"));
});

test("the store's words replace this workspace's member once per change, and an unchanged seat costs no update", async () => {
  const store = fakeStore({ seat: "copy-editor", name: "COPY-EDITOR", brief: "You cut every third word." });
  const here = workspace();
  here.people.set("copy-editor", { id: "c-2", name: "COPY-EDITOR", companyId: "ws-here", brief: "old" });
  const pc = aPc();
  const first = await seatOnConnections(fakeMcp(here), [named("copy-editor")], fromStore(pc, store));
  assert.equal(here.people.get("copy-editor").brief, "You cut every third word.");
  assert.equal(first.updated, 1);
  const again = fakeMcp(here);
  const out = await seatOnConnections(again, [named("copy-editor")], fromStore(pc, store));
  assert.equal(out.personaIdOf.get("copy-editor"), "c-2");
  assert.deepEqual(tools(again), ["boardroom_personas_list", "boardroom_rooms_create"]);
  store.rows[0].brief = "You cut every second word.";
  await seatOnConnections(fakeMcp(here), [named("copy-editor")], fromStore(pc, store));
  assert.equal(here.people.get("copy-editor").brief, "You cut every second word.");
});

test("a seat the store has no words for stops by name rather than being invented", async () => {
  const store = fakeStore({ seat: "architect", name: "ARCHITECT", brief: "You read the checks." });
  store.rows.push({ ...store.rows[0], id: "s-x", sue: { tier: "owner", owner: "owner", seat: "nobody" } });
  await assert.rejects(seatOnConnections(fakeMcp(), [named("nobody")], fromStore(aPc(), store)), /seat nobody has no words in the persona store/);
});

test("what a sitting derives (SUE's person at the table) is pushed over the store's words, once per change", async () => {
  const store = fakeStore({ seat: "grandma-sue", name: "GRANDMA-SUE", brief: "stale", playbook: "stale", seat_title: "Visitor" });
  const here = workspace();
  here.people.set("grandma-sue", { id: "c-4", name: "GRANDMA-SUE", companyId: "ws-here", brief: "stale" });
  const sue = named("grandma-sue", {
    brief: "You are Sue, 78.\n\nAt the table you say it plainly.",
    playbook: "## What you notice",
    push: ["brief", "playbook"],
  });
  const pc = aPc();
  await seatOnConnections(fakeMcp(here), [sue], fromStore(pc, store));
  assert.equal(here.people.get("grandma-sue").brief, sue.brief);
  assert.equal(here.people.get("grandma-sue").seatTitle, "Visitor");
  const again = fakeMcp(here);
  await seatOnConnections(again, [sue], fromStore(pc, store));
  assert.ok(!tools(again).includes("boardroom_personas_update"), "an unchanged derivation is not pushed twice");
});

// Packing Buddy, 2026-10-11: the ruling panel stopped before it sat, Grandma Sue being absent from the workspace; her
// copy took the stored words less the ones the sitting derives, so the create carried no brief and the plane refused it.
test("a derived seat this workspace lacks is made with the brief the sitting derived, the store's other words copied", async () => {
  const store = fakeStore({ seat: "grandma-sue", name: "GRANDMA-SUE", brief: "stale", playbook: "stale", seat_title: "Visitor" });
  const sue = named("grandma-sue", { brief: "You are Sue, 78.", playbook: "## What you notice", push: ["brief", "playbook"] });
  const mcp = fakeMcp();
  const out = await seatOnConnections(mcp, [sue], fromStore(aPc(), store));
  const made = mcp.ws.people.get("grandma-sue");
  assert.equal(out.personaIdOf.get("grandma-sue"), made.id);
  assert.equal(made.brief, "You are Sue, 78.");
  assert.equal(made.playbook, "## What you notice");
  assert.equal(made.seatTitle, "Visitor");
});

test("seatWords reads a seat's own words whole from the store by seat id, in a board member's shape", async () => {
  const store = fakeStore({ seat: "design-critic", name: "The Design Critic", brief: "You judge rhythm.", modeled_on: "Rams", one_liner: "Less" });
  const words = await seatWords("design-critic", { store });
  assert.deepEqual(
    { name: words.name, modeledOn: words.modeledOn, oneLiner: words.oneLiner, brief: words.brief, playbook: words.playbook },
    { name: "The Design Critic", modeledOn: "Rams", oneLiner: "Less", brief: "You judge rhythm.", playbook: "" },
  );
  await assert.rejects(seatWords("the-architect", { store }), /persona store/);
});

// The import's reader (store/import-seats.mjs). NexusCode-2D, 2026-09-28 (board #5304): a workspace bound to another
// company is refused home's roster (`not_a_member`); Project Hydra, 2026-10-10: the engine checkout's binding reads it.
const HOME = "ws-home";
function homeWith(...people) {
  const home = workspace(HOME);
  for (const p of people) home.people.set(p.name.toLowerCase(), { companyId: HOME, updatedAt: "2026-09-28T10:00:00.000Z", ...p });
  return home;
}

test("boardroomWords reads a member whole from home, through the engine checkout's binding when home refuses this one", async () => {
  const member = { id: "h-5", name: "The Design Critic", brief: "You judge rhythm.", playbook: "Look at the grid." };
  assert.equal((await boardroomWords(fakeMcp(workspace(), [homeWith(member)]), "The Design Critic", { home: HOME })).brief, "You judge rhythm.");
  const refusing = Object.assign(homeWith(member), { refuses: true });
  const here = fakeMcp(workspace(), [refusing]);
  here.engine = async () => fakeMcp(workspace("ws-engine"), [{ ...refusing, refuses: false }]);
  assert.equal((await boardroomWords(here, "The Design Critic", { home: HOME })).playbook, "Look at the grid.");
  await assert.rejects(boardroomWords(fakeMcp(workspace(), [refusing]), "The Design Critic", { home: HOME }), /DREDD_SEATS_HOME/);
});
