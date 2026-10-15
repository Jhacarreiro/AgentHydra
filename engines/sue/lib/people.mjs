/**
 * people - every Sue person comes from Connections when a process needs her, and lives in its memory, never in a file.
 * ====================================================================================================================
 *
 * WHY: Owner, 2026-09-28: "There should not be a single local personality in the workspace. They all should be stored
 * in Connections. Not because they have to, not because of some sort of dumb rule, but because Connections is
 * obviously superior." A Sue person is a Boardroom persona: the built-in roster (the Boardroom's built_in rows) and
 * this workspace's own people come back together from one free call to the Boardroom's Sue list, and a critic's mind
 * is her playbook, answered by its sue/mind door. So a person made on another computer, in Studio or at a board is
 * the one a run sends, and a workspace carries no copy to fall out of step.
 *
 * THE DOOR: `door(tool, body)` answers `{ ok, status, body, text }`: the local MCP's `callBoardroom`
 * (26b-tools-sue.mjs) or dredd/lib/mcp.mjs `api("boardroom", ...)`, on the member's own key, whose workspace
 * is the one this folder is bound to. `openPeopleDoor` answers the two reads (the list, a mind) from the persona store
 * instead (lib/people-store.mjs, persona store plan task 2), in the same shapes and the same scope; a save still goes
 * to the Boardroom, because Sue's own people carry real Cognito owner_subs and the store writes only `owner:<owner>` rows.
 *
 * HOW THEY REACH A RUN: whoever starts SUE fetches them (`fetchPeople`) and hands them over in its args (`people`,
 * `minds`); sue.mjs installs them (lib/personas.mjs `installPeople`) before it plans, and hands a run's own people to
 * its cannon in a file the runner deletes when the run ends. A terminal that hands over none has them fetched here
 * through a local MCP (`openPeopleDoor`).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { homeDoor } from "../../lib/people-home.mjs";
import { installPeople } from "./personas.mjs";

/** The Boardroom's Sue save takes 1 to 100 people a call (services/boardroom/lambda/src/personas-routes.ts SUE_WRITE_MAX). */
export const SUE_SAVE_BATCH = 100;

export function wordsOf(answer) {
  const body = answer?.body;
  if (body?.error) return `${body.error}${body.message ? `: ${body.message}` : ""}`;
  return String(answer?.text || "no answer").slice(0, 300);
}

/** The Sue list's whole answer: this workspace's people and the built-ins, `{ doc, updatedAt, builtIn?, mindChars? }` each. */
export async function fetchPeopleList(door) {
  const answer = await door("boardroom_personas_sue_list", { builtIns: true });
  const people = answer?.ok && Array.isArray(answer.body?.personas) ? answer.body.personas : null;
  if (!people) throw new Error(`no people list came back: ${wordsOf(answer)}`);
  return people;
}

/**
 * The minds of the critics among `people` (only those in `ids` when it is given), `{ id: text }`. A critic whose mind
 * does not come down is named in `missing`, never guessed at: the loader refuses her by name if a run sends her.
 */
export async function fetchMinds(door, people, ids = null) {
  const want = Array.isArray(ids) ? new Set(ids) : null;
  const critics = people.map((p) => p?.doc).filter((doc) => doc?.critic === true && (!want || want.has(doc.id)));
  const minds = {};
  const missing = [];
  // Side by side: one call per critic, answered in the critics' own order.
  const answers = await Promise.all(critics.map(({ id }) => door("boardroom_personas_sue_mind", { sueId: id })));
  for (const [i, { id }] of critics.entries()) {
    const answer = answers[i];
    const mind = answer?.ok && typeof answer.body?.mind === "string" ? answer.body.mind : null;
    if (mind?.trim()) minds[id] = mind;
    else missing.push({ id, why: mind === null ? wordsOf(answer) : `Connections holds no mind for ${id}` });
  }
  return { minds, missing };
}

/** A run's people: the whole list, and the minds of its critics (`ids` narrows which). `{ people, minds, missing }`. */
export async function fetchPeople(door, { ids = null, minds = true } = {}) {
  const people = await fetchPeopleList(door);
  const got = minds ? await fetchMinds(door, people, ids) : { minds: {}, missing: [] };
  return { people, ...got };
}

/**
 * Save `items` (`{ doc, updatedAt }`, a doc as lib/workspace.mjs `buildPersona` makes it) to Connections, where the
 * newer copy wins. Answers the whole list the save came back with, and who it refused. Throws the Boardroom's words.
 */
export async function savePeople(door, items, { builtIn = false } = {}) {
  let answer = null;
  const refused = [];
  const idOf = (item) => item?.doc?.id ?? null;
  for (let i = 0; i < items.length; i += SUE_SAVE_BATCH) {
    const personas = items.slice(i, i + SUE_SAVE_BATCH);
    answer = await door("boardroom_personas_sue_save", builtIn ? { personas, builtIn: true } : { personas });
    if (!answer?.ok) {
      // A whole batch refused (the workspace is at its cap, or a call failed): the batches before it were saved, say so.
      const refusedIds = new Set(refused.map((r) => r.id));
      const sent = items
        .slice(0, i)
        .map(idOf)
        .filter((id) => !refusedIds.has(id));
      const error = new Error(
        `Connections did not save them: ${wordsOf(answer)} (saved ${sent.length} of ${items.length}; not sent: ${items.slice(i).map(idOf).join(", ")})`,
      );
      error.saved = sent;
      error.notSaved = [...refused.map((r) => r.id), ...items.slice(i).map(idOf)];
      throw error;
    }
    refused.push(...(Array.isArray(answer.body?.refused) ? answer.body.refused : []));
  }
  const refusedIds = new Set(refused.map((r) => r.id));
  const saved = items.map(idOf).filter((id) => !refusedIds.has(id));
  return { people: Array.isArray(answer?.body?.personas) ? answer.body.personas : [], refused, saved, total: items.length };
}

/**
 * Whether Connections kept the copy of her a save sent, read off the list the save answered: newer copy wins there, and a
 * copy that lost (a newer edit in Studio, or a computer whose clock runs ahead) is answered back unchanged with no
 * refusal, so "saved" is only said when her copy's time is the one this save sent. `{ saved, why? }`.
 */
export function keptCopy(answered, { doc, updatedAt }) {
  const back = (Array.isArray(answered) ? answered : []).find((p) => p?.doc?.id === doc.id);
  if (!back) return { saved: false, why: "Connections did not answer her back" };
  if (Date.parse(back.updatedAt) !== Date.parse(updatedAt))
    return {
      saved: false,
      why: `Connections kept a newer copy of her (changed ${back.updatedAt}): change that one, or check this computer's clock`,
    };
  return { saved: true };
}

/**
 * Save the person `save_persona` or `edit_persona` made (`answer.persona`) to Connections, and answer for her:
 * `inConnections` says `{ saved, why? }`, and a copy Connections did not keep answers `ok: false` with the reason. On
 * 2026-10-07 five people whose displayName someone else on their board already had (one person per name, boardroom
 * schema 0028) were refused, and save_persona still answered ok.
 */
export async function savePersonaAnswer(door, answer) {
  const copy = { doc: answer.persona, updatedAt: new Date().toISOString() };
  const saved = await savePeople(door, [copy], { builtIn: answer.builtIn === true });
  const refused = saved.refused.find((r) => r?.id === copy.doc.id);
  const inConnections = refused ? { saved: false, why: refused.why } : keptCopy(saved.people, copy);
  if (inConnections.saved) return { ...answer, inConnections };
  return {
    ...answer,
    ok: false,
    error: `Connections did not save ${copy.doc.id} ("${copy.doc.displayName}"): ${inConnections.why}`,
    inConnections,
  };
}

/**
 * A door to the member's Boardroom through a local MCP (dredd/lib/mcp.mjs), for a process nobody handed people
 * to: a terminal, or the Sue Manager's page starting a wave. `{ door, close, mcp }`: `mcp` is the local MCP itself, so
 * the same process reads its workspace's websites through it (lib/owned-sites.mjs) instead of opening a second one.
 */
/**
 * The workspace the people door's MCP is pinned to: the one that LAUNCHED the run (Owner, 2026-10-02: "When you spin up a
 * Sue in this workspace, it should start a Sue in this workspace"). SUE_LAUNCH_WORKSPACE names it; failing that a
 * scratch `root` under the temp folder (a round's sue-round<N>) is swapped for CONNECTIONS_WORKSPACE or the cwd, so the
 * MCP never registers a scratch folder that would be auto-bound to the account default. A real folder stays itself.
 */
export function launchWorkspace(root, env = process.env) {
  if (env.SUE_LAUNCH_WORKSPACE) return path.resolve(env.SUE_LAUNCH_WORKSPACE);
  return isScratchFolder(root) ? path.resolve(env.CONNECTIONS_WORKSPACE || process.cwd()) : root;
}

/** A folder under the temp folder: a round's scratch copy, never a workspace anyone means to keep. */
function isScratchFolder(folder) {
  const rel = path.relative(os.tmpdir(), path.resolve(folder));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Why `sue run --workspace <folder>` is refused, or null. A scratch folder under the temp folder would register as a
 * Connections workspace of its own (Owner, 2026-10-02): the run starts from the repo that launched it instead.
 */
export function scratchWorkspaceRefusal(folder, env = process.env) {
  const ws = path.resolve(folder);
  if (!isScratchFolder(ws)) return null;
  const launch = env.SUE_LAUNCH_WORKSPACE || env.CONNECTIONS_WORKSPACE;
  if (launch && path.resolve(launch) === ws) return null;
  const from = launch ? `run it from ${path.resolve(launch)}` : "run it from the repo itself (pass --workspace <repo>)";
  return `${ws} is a scratch folder under the temp folder, so it would register as a Connections workspace of its own. ${from}. Nothing was started.`;
}

/** The people door: the people store's folders (lib/people-home.mjs), the same on every install. */
export async function openPeopleDoor() {
  return { door: homeDoor(), close: async () => {}, mcp: null };
}

/**
 * Install this process's people: the ones `args` hands over (`args.people`, `args.minds`), else the ones fetched
 * through a local MCP for `root`. Returns what was installed, in counts.
 */
export async function readyPeople(args, { root, ids = null, minds = true, openDoor = openPeopleDoor } = {}) {
  if (Array.isArray(args?.people)) {
    installPeople(args.people, { minds: args.minds ?? {} });
    return { from: "handed", people: args.people.length, minds: Object.keys(args.minds ?? {}) };
  }
  const { door, close } = await openDoor({ root });
  try {
    const got = await fetchPeople(door, { ids, minds });
    installPeople(got.people, { minds: got.minds });
    return { from: "connections", people: got.people.length, minds: Object.keys(got.minds), missing: got.missing };
  } finally {
    await close();
  }
}

/**
 * Move a folder's leftover person files into Connections (Owner, 2026-09-28: "There should not be a single local
 * personality in the workspace"). Each `.sue/personas/<id>.json` an older SUE wrote is saved to the folder's workspace as
 * a copy dated by its file (the newer copy wins there), and every file Connections then answers back is deleted: a file
 * older than Connections' copy is only a stale copy. A file that is not a person, or that Connections refused, stays and
 * is named with the reason, so nothing is lost. Portraits stay (pictures, not people). Never throws: `{ moved, kept }`.
 */
export async function adoptFolderPeople(folder, door) {
  const dir = path.join(folder, ".sue", "personas");
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch {
    return { moved: [], kept: [] };
  }
  const items = [];
  const kept = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const doc = JSON.parse(fs.readFileSync(file, "utf8"));
      if (!doc || typeof doc.id !== "string") throw new Error("not a person");
      items.push({ file, copy: { doc, updatedAt: fs.statSync(file).mtime.toISOString() } });
    } catch (err) {
      kept.push({ file: name, why: String(err?.message ?? err).slice(0, 200) });
    }
  }
  if (!items.length) return { moved: [], kept };
  let answer;
  try {
    answer = await savePeople(
      door,
      items.map((item) => item.copy),
    );
  } catch (err) {
    const why = String(err?.message ?? err).slice(0, 200);
    return { moved: [], kept: [...kept, ...items.map((item) => ({ file: path.basename(item.file), why }))] };
  }
  const moved = [];
  for (const { file, copy } of items) {
    const refused = answer.refused.find((r) => r?.id === copy.doc.id);
    if (refused || !answer.people.some((p) => p?.doc?.id === copy.doc.id)) {
      kept.push({ file: path.basename(file), why: refused?.why ?? "Connections did not answer her back" });
      continue;
    }
    fs.rmSync(file, { force: true });
    moved.push(copy.doc.id);
  }
  return { moved, kept };
}

/** How long the Sue Manager keeps a folder's people before it asks Connections again: its page asks every few seconds. */
export const FOLDER_PEOPLE_TTL_MS = 60_000;
const folderPeople = new Map();

/**
 * A folder's people as Connections holds them (the Sue list, no minds), for the Sue Manager, which shows many folders
 * and so asks per folder through that folder's own local MCP binding. Kept `FOLDER_PEOPLE_TTL_MS`; `fresh` asks again.
 */
export async function peopleOfFolder(folder, { openDoor = openPeopleDoor, now = Date.now, fresh = false } = {}) {
  const hit = folderPeople.get(folder);
  if (!fresh && hit && now() - hit.at < FOLDER_PEOPLE_TTL_MS) return hit.people;
  const { door, close } = await openDoor({ root: folder });
  try {
    await adoptFolderPeople(folder, door);
    const people = await fetchPeopleList(door);
    folderPeople.set(folder, { at: now(), people });
    return people;
  } finally {
    await close();
  }
}

/**
 * Save `items` to Connections through `folder`'s own binding (the Sue Manager, for Studio's Sue page), and forget the
 * folder's kept people so the next read is Connections' own. Answers savePeople's `{ people, refused }`.
 */
export async function saveFolderPeople(folder, items, { openDoor = openPeopleDoor } = {}) {
  const { door, close } = await openDoor({ root: folder });
  try {
    const answer = await savePeople(door, items);
    folderPeople.delete(folder);
    return answer;
  } finally {
    await close();
  }
}
