// dredd/lib/connections-board.mjs - Dredd's critics, seated on the Connections Boardroom.
//
// Owner, Owner, 2026-09-22: delete the boardroom Dredd ran for itself; Connections' Boardroom runs any
// member's own model natively, and "just like Sue, you store all of your personalities always in
// connections, but can use your local models". So a seat (dredd/seats/*.json) is a Connections
// BOARD MEMBER in the signed-in account, the room is a Connections BOARDROOM, and every sitting is a
// real meeting there, thought by Dredd's own brain (lib/brain.mjs) through the plane's prompt/answer
// doors. Nothing about the round is decided here: who speaks, what each is told and how an answer is
// read are the plane's.
//
// ⛔ FOUND ON THE BOARDROOM, NEVER REMEMBERED (Owner, 2026-09-26: "I thought Dredd was just a manager").
// Until then a seat's id lived in a file on each PC, and a PC that missed (a second machine, a wiped
// file, one 404 that wiped them all) made every critic again: the connections workspace held 256 rows
// for 28 people and 18 "Dredd - product room"s, six seating the same five. Now every sitting asks the
// plane with `reuse: true`: the workspace's person of that name comes back as they are (free), and only
// a person nobody has made yet is made (a credit). Rooms the same way, by name and exact seating. So
// every PC finds the same people and the same rooms. The seat files are still where Dredd's critics
// are written, so a seat whose text changed is pushed as an UPDATE (free) to the person found; the
// local file (tmp/dredd/connections-board.json) only remembers which content this PC last pushed, so
// an unchanged seat costs no upload. Losing it costs one free update per seat, never a person.
//
// ⛔ A SEAT'S WORDS LIVE IN THE PERSONA STORE, NEVER IN THE SEAT FILE (Owner, 2026-09-28: "There should not be a
// single local personality in the workspace"; 2026-10-15: every persona's text on the SSH server, read from there). A
// seat file says only who sits where (id, name, rooms, jev, keywords). Its brief, playbook, seat title, one-liner and
// "modeled on" are its tier "seat" row in the persona store (store/store.mjs: sue_personas on the SSH server, sue.seat
// the seat id), read without Connections; store/import-seats.mjs copied them once off the Connections workspace
// (SEATS_HOME). The sitting itself is still a Connections meeting, so the board member of that name in the workspace
// the MCP is bound to is made from, and brought up to, the store's words. What a sitting derives itself (a mind's
// verified KB, SUE's person at the table) is `push`ed as before.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { seatStore } from "../../lib/people-home.mjs";

const SERVICE = "boardroom";

/** The Connections workspace the seats' words were imported from (boardroomWords). DREDD_SEATS_HOME points elsewhere. */
export const SEATS_HOME = process.env.DREDD_SEATS_HOME || "";

/** A board member's words, as opposed to who they are called. */
const WORD_FIELDS = ["modeledOn", "seatTitle", "oneLiner", "brief", "playbook"];

/**
 * The persona a seat becomes, cut to the plane's own column ceilings (it refuses anything longer). `limits` is the
 * plane's TEXT_LIMITS, handed in by the caller (boardroom.mjs, under bun) so this file stays plain JavaScript that
 * `node --test` can load.
 */
export function personaFields(seat, limits) {
  const cut = (value, max) => String(value || "").slice(0, max);
  return {
    name: cut(seat.name, limits.personaName),
    modeledOn: cut(seat.modeledOn, limits.personaModeledOn) || null,
    seatTitle: cut(seat.seatTitle, limits.personaSeatTitle),
    oneLiner: cut(seat.oneLiner, limits.personaOneLiner),
    brief: cut(seat.brief, limits.personaBrief),
    playbook: cut(seat.playbook, limits.personaPlaybook),
    ...(seat.photoUrl ? { photoUrl: seat.photoUrl } : {}),
  };
}

function hashOf(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 12);
}

/** { [personaId]: hash of the fields this PC last pushed to that person }. Unreadable is empty: it only saves uploads. */
function readPushed(file) {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")).pushed || {};
  } catch {
    return {};
  }
}

function writePushed(file, pushed) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify({ pushed }, null, 2));
}

/** The plane's room-name ceiling (TEXT_LIMITS.roomName). */
const ROOM_NAME_MAX = 80;

/** "Dredd product: Design Critic, Copy Editor, ..." - who sits in it, cut to the plane's ceiling. */
export function roomName(label, seats) {
  const who = seats.map((s) => String(s.name || s.slug).replace(/^The /, "")).join(", ");
  const name = `Dredd ${label}: ${who}`;
  return name.length <= ROOM_NAME_MAX ? name : `${name.slice(0, ROOM_NAME_MAX - 1)}…`;
}

/** Whether the plane handed back something that already existed (read off a cut string's head too). */
function wasReused(res) {
  if (res?.body && typeof res.body === "object") return res.body.reused === true;
  const head = typeof res?.body === "string" ? res.body.slice(0, 200) : res?.head || "";
  return /"reused"\s*:\s*true/.test(head);
}

/** A refusal in the member's words when the plane gave one (a credit refusal carries `message`), else the code. */
export function refusalText(res) {
  const b = res.body || {};
  return String(b.message || b.error || res.text || `answered ${res.status}`);
}

async function callRes(mcp, tool, body) {
  const res = await mcp.api(SERVICE, tool, body);
  if (!res.ok) {
    const err = new Error(`${tool}: ${refusalText(res)}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

async function call(mcp, tool, body) {
  return (await callRes(mcp, tool, body)).body;
}

/**
 * The id of the `entity` ("room", "meeting", "persona") a call just made. The plane echoes what it made, and a room of
 * mind seats echoes every member's playbook, so the MCP's 200k cap cuts the answer; the plane serializes `id` first, so
 * a cut answer's head still carries it (mcp.mjs keeps the head of a truncated 2xx). The local MCP can also hand the
 * body over as a raw JSON STRING it cut at ~197k characters (a minds room's echo, 2026-09-24): every minds sitting
 * made a room whose id it could not read, failed, and left the room behind. That string's head is read the same way.
 * Null when none has it.
 */
export function madeId(res, entity) {
  const whole = res?.body?.[entity]?.id;
  if (whole) return whole;
  const head = typeof res?.body === "string" ? res.body.slice(0, 4000) : res?.head || "";
  const m = new RegExp(`"${entity}"\\s*:\\s*\\{\\s*"id"\\s*:\\s*"([0-9a-f-]{36})"`).exec(head);
  return m ? m[1] : null;
}

/** Make a meeting in `roomId` and return its id, read from a cut answer when the echo was too long. */
export async function openMeeting(mcp, roomId) {
  const res = await mcp.api(SERVICE, "boardroom_meetings_create", { boardroomId: roomId });
  return { res, id: res.ok ? madeId(res, "meeting") : null };
}

/** A workspace's own board members by name (`companyId` null is the one the MCP is bound to), built-ins left out. */
async function rosterOf(mcp, companyId) {
  const res = await callRes(mcp, "boardroom_personas_list", companyId ? { compact: true, companyId } : { compact: true });
  const people = Array.isArray(res.body?.personas) ? res.body.personas : null;
  if (!people) throw new Error("boardroom_personas_list: the plane answered without a roster");
  const byName = new Map();
  for (const p of people) if (!p.builtIn && !byName.has(p.name)) byName.set(p.name, p);
  return byName;
}

/**
 * Home's board members by name, and whether home refused this workspace. A workspace bound to another company is
 * refused home's roster (`not_a_member`) under the same account (NexusCode-2D, 2026-09-28, board #5304), so it reads
 * its own members instead: the copies an earlier sitting made from home's words. Home's words still reach it through
 * the engine checkout's own binding (`mcp.engine`, lib/mcp.mjs), a workspace home admits: `reader` is the MCP that
 * reads home's people. With neither, a workspace keeps the copies it has, and DREDD_SEATS_HOME can name another home.
 */
async function homeRoster(mcp, home) {
  try {
    return { byName: await rosterOf(mcp, home), refused: false, reader: mcp };
  } catch (error) {
    if (!/\bnot_a_member\b/.test(error.message)) throw error;
    const engine = typeof mcp.engine === "function" ? await mcp.engine() : null;
    if (engine) {
      try {
        return { byName: await rosterOf(engine, home), refused: false, reader: engine };
      } catch (refused) {
        if (!/\bnot_a_member\b/.test(refused.message)) throw refused;
      }
    }
    return { byName: await rosterOf(mcp, null), refused: true, reader: mcp };
  }
}

/** A seat this workspace has no copy of, when home refused to show it its own. */
function refusedSeat(name, home) {
  return `${name} is not a board member in this workspace, and the Connections workspace (${home}) refused it (not_a_member): copy the member here, or set DREDD_SEATS_HOME to a workspace that has it`;
}

/** One board member whole, brief and playbook included. */
export async function wholePerson(mcp, id) {
  const person = (await callRes(mcp, "boardroom_personas_get", { id })).body?.persona;
  if (!person || typeof person.brief !== "string") {
    throw new Error("boardroom_personas_get: the plane answered without the whole person (an answer over 200,000 characters is cut)");
  }
  return person;
}

/** The home board member called `name`, whole, read off the Boardroom. Throws when home has none. */
export async function boardroomWords(mcp, name, { home = SEATS_HOME } = {}) {
  const { byName, refused, reader } = await homeRoster(mcp, home);
  const found = byName.get(name);
  if (!found) {
    throw new Error(
      refused ? refusedSeat(name, home) : `${name} is not a board member in the Connections workspace, the seats' words are imported from`,
    );
  }
  return wholePerson(reader, found.id);
}

/** The seats' words: the people store's `dredd-seat` folders (lib/people-home.mjs). */
const sshStore = { list: (q) => seatStore().list(q), get: (id) => seatStore().get(id) };

/** A tier "seat" store row in the shape a board member's words came in. */
function memberOf(row) {
  return {
    id: row.id,
    name: row.name,
    modeledOn: row.modeled_on ?? null,
    seatTitle: row.seat_title || "",
    oneLiner: row.one_liner || "",
    brief: row.brief || "",
    playbook: row.playbook || "",
    updatedAt: row.updated_at,
  };
}

/**
 * The words of the seats `seatIds`, by seat id: the store's tier "seat" rows (store.list), each read whole by its id
 * (store.get) and matched on sue.seat. A seat the store lacks is absent. `store` points a test at a fake with the same
 * `list` and `get`.
 */
export async function storeSeats(seatIds, store = sshStore) {
  const { rows } = await store.list({ tier: "seat" });
  const bySeat = new Map();
  for (const item of rows) {
    if (!seatIds.includes(item.seat) || bySeat.has(item.seat)) continue;
    const row = await store.get(item.id);
    if (row.sue?.tier === "seat" && row.sue.seat === item.seat) bySeat.set(item.seat, memberOf(row));
  }
  return bySeat;
}

function notStored(seatId) {
  return `seat ${seatId} has no words in the persona store (a tier "seat" row with sue.seat ${seatId}): add it as a dredd-seat person in the people store (docs/PEOPLE.md)`;
}

/** A seat's own words, read where they live: its row in the persona store. Throws when the store has none. */
export async function seatWords(seatId, { store = sshStore } = {}) {
  const found = (await storeSeats([seatId], store)).get(seatId);
  if (!found) throw new Error(notStored(seatId));
  return found;
}

/**
 * Seats `seats` (at most the plane's MAX_SEATS, `maxSeats`; the caller benches the rest) at one Connections
 * boardroom and returns { roomId, personaIdOf: Map<seat slug, persona id>, made, updated }. `label` names the room
 * ("product" / "tooling"). Each person and the room are found in the workspace the MCP is bound to, or made there
 * once. A person is matched by NAME in that workspace, so two seat folders judged in one workspace that name
 * the same critic share one person.
 *
 * A seat's `push` names the words this sitting derived and owes Connections (loadSeats). A seat that derives all of
 * them (a mind: its KB) is found by name or made from them. Any other seat's words are its row in the persona store
 * (`store.list` by tier "seat" once a sitting, then `store.get` per seat): this workspace's member of that name is made from them, or brought up to them when
 * this PC has not pushed exactly them, with what the sitting derives over them. A seat the store lacks stops by name.
 */
export async function seatOnConnections(mcp, seats, { cacheFile, label, limits, maxSeats, store = sshStore }) {
  if (seats.length > maxSeats) throw new Error(`the Connections Boardroom seats ${maxSeats}; ${seats.length} were asked for`);
  const pushed = readPushed(cacheFile);
  const personaIdOf = new Map();
  let made = 0;
  let updated = 0;
  let here = null;
  let stored = null;
  for (const seat of seats) {
    const fields = personaFields(seat, limits);
    const owes = Array.isArray(seat.push) ? seat.push : WORD_FIELDS;
    const owed = Object.fromEntries(owes.map((key) => [key, fields[key]]));
    let hash = hashOf(owed);
    let id;
    if (WORD_FIELDS.every((key) => owes.includes(key))) {
      // Asked with its playbook empty: the plane echoes a new member back whole, and a mind seat's playbook (a verified
      // KB, up to 400k) pushed that echo past the MCP's 200k cap, so the id was unreadable while the member had been
      // made (2026-09-23). The short echo always carries the id; the playbook follows as an update.
      const res = await callRes(mcp, "boardroom_personas_create", { ...fields, playbook: "", reuse: true });
      id = madeId(res, "persona");
      if (!id) throw new Error("boardroom_personas_create: the plane answered without a persona id");
      const reused = wasReused(res);
      if (!reused) made += 1;
      // A person found is pushed this seat's text unless this PC already pushed exactly it; a person just made only
      // lacks the playbook.
      if (pushed[id] !== hash && (reused || fields.playbook)) {
        await call(mcp, "boardroom_personas_update", reused ? { id, ...fields } : { id, playbook: fields.playbook });
        if (reused) updated += 1;
      }
    } else {
      // Every seat whose words are not all derived, read in one pass.
      stored ??= await storeSeats(
        seats.filter((s) => !(Array.isArray(s.push) && WORD_FIELDS.every((key) => s.push.includes(key)))).map((s) => s.slug),
        store,
      );
      const words = stored.get(seat.slug);
      if (!words) throw new Error(notStored(seat.slug));
      // The store's words, less what this sitting pushes itself, with what it pushes over them.
      const copied = Object.fromEntries(WORD_FIELDS.filter((key) => !owes.includes(key)).map((key) => [key, personaFields(words, limits)[key]]));
      const all = { ...copied, ...owed };
      hash = hashOf(all);
      here ??= await rosterOf(mcp, null);
      const mine = here.get(fields.name) ?? null;
      let fresh = false;
      if (mine) id = mine.id;
      else {
        // The plane makes nobody without a brief, and a long playbook's echo passes the MCP's cap: it follows as an update.
        const res = await callRes(mcp, "boardroom_personas_create", { ...all, name: fields.name, playbook: "", reuse: true });
        id = madeId(res, "persona");
        if (!id) throw new Error("boardroom_personas_create: the plane answered without a persona id");
        fresh = !wasReused(res);
        if (fresh) made += 1;
      }
      if (fresh) {
        if (all.playbook) await call(mcp, "boardroom_personas_update", { id, playbook: all.playbook });
      } else if (pushed[id] !== hash) {
        await call(mcp, "boardroom_personas_update", { id, ...all });
        updated += 1;
      }
    }
    pushed[id] = hash;
    writePushed(cacheFile, pushed);
    personaIdOf.set(seat.slug, id);
  }
  const res = await callRes(mcp, "boardroom_rooms_create", {
    name: roomName(label, seats),
    personaIds: seats.map((s) => personaIdOf.get(s.slug)),
    reuse: true,
  });
  const roomId = madeId(res, "room");
  if (!roomId) throw new Error("boardroom_rooms_create: the plane answered without a room id");
  return { roomId, personaIdOf, made, updated };
}

/** The write-up in the four headings the plane reads a member-run write-up by (WRAP_UP_ANSWER_HEADINGS). */
export function wrapUpAnswerText({ title, minutes, plan, closing_line }) {
  return [`# Title`, title || "", `# Minutes`, minutes || "", `# Plan`, plan || "", `# Closing line`, closing_line || ""].join("\n");
}

/** Evidence cut into member lines the plane accepts (it refuses a line over its cap). */
export function evidenceLines(text, maxChars) {
  const lines = [];
  let rest = String(text || "").trim();
  while (rest) {
    if (rest.length <= maxChars) {
      lines.push(rest);
      break;
    }
    const cut = rest.lastIndexOf("\n", maxChars);
    const at = cut > maxChars / 2 ? cut : maxChars;
    lines.push(rest.slice(0, at).trim());
    rest = rest.slice(at).trim();
  }
  return lines;
}
