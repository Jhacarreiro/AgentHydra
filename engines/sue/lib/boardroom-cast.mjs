/**
 * boardroom-cast - any person in the workspace's Boardroom can be sent as a Sue, for one run.
 * ============================================================================================
 *
 * WHAT: `castBoardroomPeople(ws, requested, { door })` looks up each name in a run's `personas` that is neither
 * this folder's person nor a roster kind in the workspace's Boardroom (by id, slug or name, the oldest of a
 * name first, the rule the Boardroom's own finder uses) and returns her as a cast visitor: her brief is her
 * voice, her body is borrowed from a roster kind (`like`, default bob), and her errand is the run's intent
 * (sue.mjs gives a cast visitor without errands the intent). `personas` comes back with each found name
 * swapped for her cast id, so the run's `personas` and `cast` agree.
 *
 * WHY: Owner, 2026-09-26: "Sue is just a singular personality", and everywhere personas are used should pull
 * from yours. A person made in Studio or at the Boardroom table has no Sue body (no dials, no errands), so the
 * Boardroom's Sue list leaves her out and a run could not send her. She rides the run inline (target.cast),
 * never copied into .sue/personas: the workspace's 200-odd board seats are advisers, not this page's
 * visitors, and a folder that pulled them all down would send them to every page.
 *
 * THE DOOR: `door(tool, body)` answers `{ ok, status, body, text }` (lib/people.mjs says whose). Never throws:
 * an unreachable Boardroom leaves the names as they were, and the run's own refusal names what it could not
 * find.
 */
import { listPersonas } from "./personas.mjs";
import { listWorkspacePersonas, slugFor } from "./workspace.mjs";

const CAST_ID_MAX = 40;

function matches(person, asked) {
  const want = asked.toLowerCase();
  return (
    person?.id === asked ||
    person?.slug === asked ||
    String(person?.name ?? "").toLowerCase() === want ||
    slugFor(person?.name ?? "", 64) === slugFor(asked, 64)
  );
}

function castIdFor(name, taken) {
  const base = slugFor(name, CAST_ID_MAX) || "board-person";
  let id = taken.has(base) ? slugFor(`${base.slice(0, CAST_ID_MAX - 6)}-board`, CAST_ID_MAX) : base;
  for (let n = 2; taken.has(id); n += 1) id = slugFor(`${base.slice(0, CAST_ID_MAX - 4)}-${n}`, CAST_ID_MAX);
  taken.add(id);
  return id;
}

export async function castBoardroomPeople(ws, requested, { door, like = "bob" }) {
  const names = (typeof requested === "string" ? requested.split(",") : Array.isArray(requested) ? requested : [])
    .map((n) => String(n).trim())
    .filter(Boolean);
  const roster = listPersonas();
  const known = new Set([...listWorkspacePersonas(ws).map((p) => p.id), ...roster]);
  const asked = names.filter((n) => !known.has(n));
  if (!asked.length) return { personas: requested, cast: [], found: [], why: null };
  let answer;
  try {
    answer = await door("boardroom_personas_list", {});
  } catch (err) {
    return {
      personas: requested,
      cast: [],
      found: [],
      why: `the Boardroom could not be reached: ${String(err?.message ?? err).slice(0, 240)}`,
    };
  }
  const people = answer?.ok && Array.isArray(answer.body?.personas) ? answer.body.personas : null;
  if (!people)
    return {
      personas: requested,
      cast: [],
      found: [],
      why: `the Boardroom did not list its people: ${String(answer?.text || "no answer").slice(0, 240)}`,
    };
  const oldestFirst = [...people].sort((a, b) => String(a?.createdAt ?? "").localeCompare(String(b?.createdAt ?? "")));
  const taken = new Set(known);
  const cast = [];
  const found = [];
  const swapped = names.map((name) => {
    if (known.has(name)) return name;
    const person = oldestFirst.find((p) => matches(p, name) && String(p?.brief ?? "").trim().length >= 40);
    if (!person) return name;
    const id = castIdFor(person.name, taken);
    cast.push({ id, displayName: person.name, extends: like, voice: String(person.brief).trim() });
    found.push({ asked: name, name: person.name, boardroomId: person.id, castId: id });
    return id;
  });
  return { personas: swapped, cast, found, why: null };
}
