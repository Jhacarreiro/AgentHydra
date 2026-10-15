/**
 * people-home - the engines read every person from the people store's folders (docs/PEOPLE.md), never from the repo.
 * ====================================================================================================================
 * The store (server/src/people-store) keeps each person at `<people home>/<family>/<slug>/{persona.json, brief.md}`;
 * "This PC" is that folder, and the Connections home syncs into it. The engines read the same folders, so a stranger's
 * install runs with their own people and the owner's with his.
 *
 *   Sue (a visitor or a critic)  family `expert`, slug `sue-<id>`: persona.json = { name, oneLiner, sue: <Sue doc> },
 *                                brief.md = the critic's mind
 *   Dredd seat                   family `dredd-seat`: persona.json = the seat (id, name, rooms, jev, keywords, ...),
 *                                brief.md = what the seat says
 *   Boardroom member / manager   families `board` / `manager`
 *
 * The folder is AGENTHYDRA_PEOPLE_HOME when set, else ~/.agenthydra/people.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const SUE_SLUG_PREFIX = "sue-";

export function peopleRoot(env = process.env) {
  const own = String(env.AGENTHYDRA_PEOPLE_HOME || "").trim();
  return own ? path.resolve(own) : path.join(os.homedir(), ".agenthydra", "people");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every person of `family`, `{ slug, persona, brief, updatedAt }`, slug order. A missing folder is no people. */
export function readFamily(family, env = process.env) {
  const dir = path.join(peopleRoot(env), family);
  let slugs = [];
  try {
    slugs = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const slug of slugs) {
    const folder = path.join(dir, slug);
    const persona = readJson(path.join(folder, "persona.json"));
    if (!persona || typeof persona !== "object") continue;
    const briefFile = path.join(folder, typeof persona.brief === "string" && persona.brief ? persona.brief : "brief.md");
    let updatedAt = new Date(0).toISOString();
    try {
      updatedAt = fs.statSync(path.join(folder, "persona.json")).mtime.toISOString();
    } catch {
      // a person whose file vanished mid-read keeps the epoch
    }
    out.push({ slug, persona, brief: readText(briefFile), updatedAt });
  }
  return out;
}

/** Write one person in the store's folder format. */
export function writePerson(family, slug, persona, brief = null, env = process.env) {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(slug)) throw new Error(`not a person slug: ${slug}`);
  const dir = path.join(peopleRoot(env), family, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "persona.json"), `${JSON.stringify(persona, null, 2)}\n`);
  if (brief !== null) fs.writeFileSync(path.join(dir, "brief.md"), brief);
}

/** The Sue people, `{ doc, updatedAt, builtIn?, mindChars? }` each, as the engines' people list shapes them. */
export function sueList(env = process.env) {
  return readFamily("expert", env)
    .filter((p) => p.slug.startsWith(SUE_SLUG_PREFIX) && p.persona.sue && typeof p.persona.sue === "object")
    .map((p) => ({
      doc: p.persona.sue,
      updatedAt: p.updatedAt,
      ...(p.persona.builtIn === true ? { builtIn: true } : {}),
      ...(p.brief ? { mindChars: p.brief.length } : {}),
    }));
}

export function sueMind(id, env = process.env) {
  const hit = readFamily("expert", env).find((p) => p.slug === `${SUE_SLUG_PREFIX}${id}`);
  return hit?.brief ?? null;
}

export function saveSue(doc, { builtIn = false, mind = null } = {}, env = process.env) {
  const previous = readFamily("expert", env).find((p) => p.slug === `${SUE_SLUG_PREFIX}${doc.id}`);
  const persona = {
    name: doc.displayName || doc.name || doc.id,
    title: "Sue",
    oneLiner: String(doc.oneLiner || doc.summary || doc.about || `${doc.id}, a person who tries the site.`).slice(0, 159),
    keywords: Array.isArray(doc.keywords) ? doc.keywords : [],
    tier: "employee",
    modes: ["consult"],
    cost: "low",
    ...(builtIn ? { builtIn: true } : {}),
    sue: doc,
  };
  writePerson("expert", `${SUE_SLUG_PREFIX}${doc.id}`, persona, mind ?? previous?.brief ?? null, env);
}

/**
 * A door over the folders in the Boardroom door's shapes (`door(tool, body)` answers `{ ok, status, body, text }`), so
 * lib/people.mjs reads and saves the same way whether people are handed over or read here.
 */
export function homeDoor(env = process.env) {
  const answer = (body) => ({ ok: true, status: 200, body, text: JSON.stringify(body) });
  return async (tool, body = {}) => {
    if (tool === "boardroom_personas_sue_list") return answer({ personas: sueList(env) });
    if (tool === "boardroom_personas_sue_mind") {
      const mind = sueMind(body.sueId, env);
      return mind === null ? { ok: false, status: 404, body: { error: "no_mind" }, text: "no mind" } : answer({ mind });
    }
    if (tool === "boardroom_personas_sue_save") {
      for (const item of body.personas ?? []) if (item?.doc?.id) saveSue(item.doc, { builtIn: body.builtIn === true }, env);
      return answer({ personas: sueList(env), refused: [] });
    }
    return { ok: false, status: 404, body: { error: "unknown_tool" }, text: `unknown tool ${tool}` };
  };
}

/** Dredd's seats: the `dredd-seat` folders, seat order by id, each persona.json being the seat itself. */
export function readSeats(env = process.env) {
  return readFamily("dredd-seat", env)
    .map((p) => ({ ...p.persona, id: p.persona.id ?? p.slug }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export function readBoard(env = process.env) {
  return readFamily("board", env).map((p) => ({ slug: p.slug, ...p.persona, brief: p.brief }));
}

/**
 * The seat words as a store with `list` and `get` (dredd/lib/connections-board.mjs): each `dredd-seat` person is a tier
 * "seat" row whose `sue.seat` is its seat id; its brief.md is the brief and `playbook` in persona.json the playbook.
 */
export function seatStore(env = process.env) {
  const rowOf = (p) => ({
    id: `seat-${p.slug}`,
    name: p.persona.name ?? p.slug,
    modeled_on: p.persona.modeledOn ?? null,
    seat_title: p.persona.seatTitle ?? p.persona.title ?? "",
    one_liner: p.persona.oneLiner ?? "",
    brief: p.brief ?? "",
    playbook: typeof p.persona.playbook === "string" ? p.persona.playbook : "",
    updated_at: p.updatedAt,
    sue: { tier: "seat", seat: p.persona.id ?? p.slug },
  });
  return {
    async list() {
      return { rows: readFamily("dredd-seat", env).map((p) => ({ id: `seat-${p.slug}`, seat: p.persona.id ?? p.slug })) };
    },
    async get(id) {
      const hit = readFamily("dredd-seat", env).find((p) => `seat-${p.slug}` === id);
      if (!hit) throw new Error(`no seat person ${id}`);
      return rowOf(hit);
    },
  };
}
