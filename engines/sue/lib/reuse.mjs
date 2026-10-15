// sue/lib/reuse.mjs - identity reuse for rounds. A student's visit costs about a minute of model time; when nothing that
// decides it has changed since her last FRESH visit, re-running her only re-samples the same thing, so that visit
// stands for the round (the record says so; see round.mjs start and report).
//
// The identity of a visit is five parts plus the live builds, all byte-equal or no reuse:
//   parts   { engine, driver, hands, docs, args }, each a sha256: the engine id, the sue-driver definition's bytes, the
//           hands MCP's files (by content), her persona docs as Connections answers them (hers, the one she `extends`,
//           and for a critic her MIND, the playbook), and the run's own args;
//   builds  the live build id of every site the plan names (`reuse.builds: [{ url, header }]`), read from a HEAD.
// The cheap parts (engine, driver, hands, args) are compared first, with the build HEADs already in flight while they
// are hashed; the people are fetched, once and in process, only when some student's cheap parts and the builds both
// still match, so a round where something changed spends no time on the parts that cannot matter.
// A plan with no `reuse` block never reuses. Pure but for the file reads and the injected fetch and door.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { fetchMinds, fetchPeopleList } from "./people.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SUE_DIR = path.join(HERE, "..");
export const REUSE_FILE = "reuse.json";
const FETCH_MS = 5000;

const sha = (data) => createHash("sha256").update(data).digest("hex");

/** JSON with every object's keys sorted, so equal values hash equal whatever order they were built in. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => value[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** The hands MCP's files, `{ name: sha256 }`: hands-mcp.mjs and every relative import under it, by content, each named
 *  from the checkout it sits in, so the same files staged as an older engine name and hash the same. */
export function handsFiles(entry = path.join(SUE_DIR, "hands-mcp.mjs")) {
  const root = path.resolve(path.dirname(entry), "..");
  const out = {};
  const walk = (file) => {
    const key = path.relative(root, file).replace(/\\/g, "/");
    if (key in out || !existsSync(file)) return;
    const text = readFileSync(file);
    out[key] = sha(text);
    for (const m of text.toString("utf8").matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+\.m?js)["']/g))
      walk(path.resolve(path.dirname(file), m[1]));
  };
  walk(entry);
  return out;
}

/** Where the driver definition is: the plan's `reuse.driver`, else the owner's own sue-driver agent. */
export const driverFile = (plan) => plan.reuse?.driver || path.join(os.homedir(), ".claude", "agents", "sue-driver.md");

/** The live build id of each `{ url, header }`, all fetched side by side. `{ builds: { url: value } }` or `{ why }`. */
export async function fetchBuilds(entries, fetchFn = globalThis.fetch) {
  const one = async ({ url, header }) => {
    let last = `${url} sent no ${header} header`;
    for (const method of ["HEAD", "GET"]) {
      try {
        const res = await fetchFn(url, { method, redirect: "follow", signal: AbortSignal.timeout(FETCH_MS) });
        res.body?.cancel?.().catch?.(() => {});
        const value = res.headers?.get?.(header);
        if (res.ok && value) return { url, value };
        last = res.ok ? `${url} sent no ${header} header` : `${url} answered HTTP ${res.status}`;
      } catch (err) {
        return { url, why: `${url} did not answer (${String(err?.message ?? err).slice(0, 80)})` };
      }
    }
    return { url, why: last };
  };
  const got = await Promise.all((entries || []).map(one));
  const bad = got.find((g) => g.why);
  if (bad) return { why: bad.why };
  return { builds: Object.fromEntries(got.map((g) => [g.url, g.value])) };
}

/** The run's own args as round.mjs builds them, whatever decides what she does on the page. */
export const argsOf = (run, { intent, interview, tape, expect, createAccounts }) => ({
  url: run.url,
  lang: run.lang,
  intent,
  // Only when set, so a run without one hashes as it always did; a changed expect never reuses an old visit.
  ...(expect ? { expect } : {}),
  ...(createAccounts === false ? { createAccounts: false } : {}),
  interview: run.critic ? null : interview || null,
  critic: Boolean(run.critic),
  room: Boolean(run.room),
  personas: run.personas,
  tape: tape || null,
});

export const CHEAP_PARTS = ["engine", "driver", "hands", "args"];
const WHAT_CHANGED = {
  engine: "the engine changed",
  driver: "the driver definition changed",
  hands: "the hands MCP's files changed",
  args: "a run's own brief or settings changed",
};

/** One run's whole identity hash, over its parts. */
export const inputsHash = (parts) => sha(canonical(parts));

/**
 * One run's docs part: her persona doc, the doc it `extends`, and for a critic her mind, canonical-JSON hashed. `people`
 * is `{ id: doc }` (the Sue list), `minds` is `{ id: text }`. `{ hash }`; `{ why }` when a person is missing (the whole
 * round has no reuse); `{ hash: null }` when only a critic's mind was not fetched (that run cannot be matched).
 */
export function docsPart(run, people, minds) {
  const docs = {};
  let unknown = false;
  const take = (id) => {
    const doc = people[id];
    if (!doc) return `no person named ${id}`;
    docs[id] = doc;
    if (doc.critic === true) {
      if (typeof minds?.[id] === "string") docs[`${id}:mind`] = minds[id];
      else unknown = true;
    }
    return null;
  };
  for (const id of run.personas) {
    const why = take(id);
    if (why) return { why };
    const parent = people[id].extends;
    if (typeof parent === "string" && !docs[parent]) {
      const parentWhy = take(parent);
      if (parentWhy) return { why: parentWhy };
    }
  }
  return { hash: unknown ? null : sha(canonical(docs)) };
}

const whoOf = (sueFolder) => sueFolder.replace(/^sue-\d+-/, "");
const same = (a, b) => canonical(a) === canonical(b);

/** Every FRESH visit of `who` in the series that has a reuse.json with `parts`, newest first: `{ round, id, runId, rec }`.
 *  A row's `reused` people were not fresh there, so their folders there are skipped: the chain always ends at a real
 *  fresh visit. A reuse.json without `parts` (written before parts existed) is no visit at all. */
export function visitsOf(rows, runsDir, who) {
  const out = [];
  for (const row of [...rows].sort((x, y) => String(y.at || y.id).localeCompare(String(x.at || x.id)))) {
    if ((row.reused || []).includes(who)) continue;
    for (const runId of row.runIds || []) {
      const dir = path.join(runsDir, runId);
      let folders;
      try {
        folders = readdirSync(dir).filter((d) => d.startsWith("sue-") && whoOf(d) === who);
      } catch {
        continue;
      }
      for (const f of folders) {
        let rec;
        try {
          rec = JSON.parse(readFileSync(path.join(dir, f, REUSE_FILE), "utf8"));
        } catch {
          continue;
        }
        if (rec?.round === row.id && rec.parts && typeof rec.parts === "object") out.push({ round: row.round, id: row.id, runId, rec });
      }
    }
  }
  return out;
}

const timed = (fn) => {
  const t = Date.now();
  const value = fn();
  return [value, Date.now() - t];
};

/**
 * The Sue list as `{ id: doc }`, and the minds of the critics among `ids` (side by side), from one door. `minds` is given
 * when the warm holder's one identity call already brought them (it asked for a superset of `ids`).
 */
async function peopleOf(door, ids, listP = null, given = null) {
  const list = Object.fromEntries((await (listP ?? fetchPeopleList(door))).map((p) => [p?.doc?.id, p]));
  const docs = Object.fromEntries(Object.entries(list).map(([id, p]) => [id, p.doc]));
  const { minds } = given ? { minds: given } : await fetchMinds(door, Object.values(list), ids);
  return { docs, minds, updated: Object.fromEntries(Object.entries(list).map(([id, p]) => [id, Date.parse(p.updatedAt)])) };
}

/**
 * What identity reuse finds for a round's runs: `{ found, parts, buildsP, ms, why }`.
 *  found   per run, the fresh visit she can reuse (`{ round, id, runId }`) or null;
 *  parts   per run, her parts (docs null when the people were not fetched, or her mind was not);
 *  buildsP the build HEADs' promise, started first, for the identity a fresh round records;
 *  ms      where the time went: { builds, people, engine, hands };
 *  why     one line saying why nothing can be reused, or null.
 * `handsEntry` is the hands-mcp.mjs her visits will run: a staged engine's own, else this checkout's.
 * `door(tool, body)` is the Boardroom door (injected by the specs); without one `openDoor()` opens it, and only when a
 * student still has a candidate. The people are fetched once: the Sue list (built-ins and the `extends` parents in the
 * same answer) and the minds of the candidate critics side by side.
 */
export async function findReuse(
  plan,
  runs,
  rows,
  runsDir,
  { argsFor, fetchFn, door, openDoor, engineId, warm, engineSpec = null, handsEntry },
) {
  const ms = { builds: 0, people: 0, engine: 0, hands: 0 };
  const t0 = Date.now();
  // The warm holder (people-door.mjs), asked first and only when no door was injected: a live process that answers within
  // a moment keeps one open door and its own connections; none means this start opens its own, as it always did.
  const warmP =
    !door && warm
      ? Promise.resolve()
          .then(warm)
          .catch(() => null)
      : Promise.resolve(null);
  // A holder that offers it answers the builds, the engine id (when `engineSpec` says the default is in use), the Sue list and
  // the critics' minds in ONE local call, side by side inside it, every part live now. Its request needs `visits`, which is
  // computed below before anything is awaited; this callback only runs after that, so it is always set by then.
  let visits;
  const identP = warmP.then((w) => {
    if (!w?.identity) return null;
    const asking = runs.flatMap((r, i) => (visits[i].length ? [r] : []));
    const people = asking.length
      ? { ids: asking.flatMap((r) => r.personas), critics: asking.filter((r) => r.critic).flatMap((r) => r.personas) }
      : null;
    return w.identity({ builds: plan.reuse.builds, engine: engineSpec, people }).catch(() => null);
  });
  // Started before any hashing, so the network overlaps the CPU work. Through the holder it is still a live HEAD each time.
  const buildsP = identP
    .then(async (i) => {
      if (i?.builds) return i.builds;
      const w = await warmP;
      return w?.builds
        ? w.builds(plan.reuse.builds).catch(() => fetchBuilds(plan.reuse.builds, fetchFn))
        : fetchBuilds(plan.reuse.builds, fetchFn);
    })
    .then((b) => {
      ms.builds = Date.now() - t0;
      return b;
    });
  let doorP = null;
  let listP = null;
  let tp = 0;
  let via = null;
  const closeDoor = async () => (await doorP?.catch(() => null))?.close?.();
  const none = (why, parts = runs.map(() => null)) => ({ found: runs.map(() => null), parts, buildsP, ms, why });
  // Whether anyone has an earlier fresh visit at all needs no hashing: if so the door warms up (and the holder's first list
  // is asked) while the engine is hashed below, and is dropped unused if a cheap part then shows nothing can match.
  visits = runs.map((r) => (r.room ? [] : visitsOf(rows, runsDir, r.personas[0])));
  if (visits.some((v) => v.length)) {
    tp = Date.now();
    doorP = door
      ? Promise.resolve({ door, close: async () => {} })
      : warmP.then((w) => {
          if (!w) {
            via = "cold";
            return openDoor();
          }
          via = "warm";
          return { door: w.door, close: async () => {} };
        });
    doorP.catch(() => {});
    if (!door) {
      listP = doorP.then(async (d) => {
        if (via !== "warm") return null;
        const i = await identP;
        return i?.list ?? fetchPeopleList(d.door);
      });
      listP.catch(() => {});
    }
  }
  await new Promise((resolve) => setImmediate(resolve)); // let the HEADs and the door leave before the CPU work starts
  let driver;
  try {
    driver = readFileSync(driverFile(plan));
  } catch {
    await closeDoor();
    return none(`the driver definition ${driverFile(plan)} cannot be read`);
  }
  let hands;
  try {
    [hands, ms.hands] = timed(() => handsFiles(handsEntry));
  } catch {
    await closeDoor();
    return none("the hands MCP's files cannot be read");
  }
  let engine;
  // The holder's engine id is its own live stat of every file of the closure (null: its code moved, so this process hashes).
  const te = Date.now();
  const held = engineSpec ? (await identP)?.engine : null;
  if (held) [engine, ms.engine] = [held, Date.now() - te];
  else [engine, ms.engine] = timed(() => engineId());
  const common = { engine: sha(String(engine)), driver: sha(driver), hands: sha(canonical(hands)) };
  const parts = runs.map((r) => ({ ...common, docs: null, args: sha(canonical(argsFor(r))) }));

  const candidates = visits.map((vs, i) => vs.filter((v) => CHEAP_PARTS.every((k) => v.rec.parts[k] === parts[i][k])));
  if (!candidates.some((c) => c.length)) {
    await closeDoor();
    const changed = new Set();
    for (const [i, vs] of visits.entries()) if (vs[0]) for (const k of CHEAP_PARTS) if (vs[0].rec.parts[k] !== parts[i][k]) changed.add(k);
    return none(changed.size ? [...changed].map((k) => WHAT_CHANGED[k]).join(" and ") : "no earlier fresh visit to compare with", parts);
  }

  // The door has been opening while the builds are waited on; a build that differs closes it unused.
  const b = await buildsP;
  if (b.why) {
    await closeDoor();
    return none(b.why, parts);
  }
  const live = candidates.map((c) => c.filter((v) => same(v.rec.builds, b.builds)));
  if (!live.some((c) => c.length)) {
    await closeDoor();
    return none("a live build id changed", parts);
  }

  let got;
  try {
    got = await peopleOf(
      (await doorP).door,
      runs.flatMap((r, i) => (live[i].length ? r.personas : [])),
      (await listP) ? listP : null,
      (await identP)?.list ? (await identP).minds : null,
    );
  } catch (err) {
    return none(`the people were not answered (${String(err?.message ?? err).slice(0, 120)})`, parts);
  } finally {
    ms.people = Date.now() - tp;
    if (via) ms.via = via;
    await closeDoor();
  }
  const found = runs.map(() => null);
  for (const [i, r] of runs.entries()) {
    const d = docsPart(r, got.docs, got.minds);
    if (d.why) return none(d.why, parts);
    parts[i].docs = d.hash;
    const v = d.hash && live[i].find((x) => x.rec.parts.docs === d.hash);
    if (v) found[i] = { round: v.round, id: v.id, runId: v.runId };
  }
  return { found, parts, buildsP, ms, why: null };
}

/**
 * Fills a finished round's missing docs parts (a round that fetched no people at start, because something cheaper had
 * already changed) from one in-process fetch, so its visits can be reused later. A person edited since the round began
 * is not recorded: her docs may not be the ones her visit was walked with. Returns how many runs were filled.
 */
export async function fillDocs(state, door) {
  // A state row names her run by her persona (a room never has parts to fill: it is never reused).
  const need = state.runs
    .filter((r) => r.parts && r.parts.docs === null && r.runId && !r.reused && !r.room)
    .map((r) => ({ ...r, personas: [r.name] }));
  if (!need.length) return 0;
  const began = Date.parse(state.resetAt);
  let filled = 0;
  try {
    const got = await peopleOf(
      door,
      need.flatMap((r) => r.personas),
    );
    for (const r of need) {
      const d = docsPart(r, got.docs, got.minds);
      const edited = r.personas.some((id) => got.updated[id] > began || got.updated[got.docs[id]?.extends] > began);
      if (!d.hash || edited) continue;
      const row = state.runs.find((x) => x.name === r.name);
      row.parts.docs = d.hash;
      row.inputs = inputsHash(row.parts);
      filled += 1;
    }
  } catch {
    // The docs stay null: that visit is simply never matched.
  }
  return filled;
}

/** Writes reuse.json into each of a finished round's FRESH visits (never a reused one's). Returns how many. */
export function writeReuse(state, row, runsDir, now = new Date()) {
  let n = 0;
  for (const r of state.runs) {
    if (!r.runId || r.reused || !r.parts) continue;
    const dir = path.join(runsDir, r.runId);
    let folders;
    try {
      folders = readdirSync(dir).filter((d) => d.startsWith("sue-"));
    } catch {
      continue;
    }
    for (const f of folders) {
      // A visit that ended without her exit interview gave no rating: it never stands for her in a later round.
      if (!existsSync(path.join(dir, f, "interview.json"))) continue;
      writeFileSync(
        path.join(dir, f, REUSE_FILE),
        JSON.stringify({ inputs: r.inputs, parts: r.parts, builds: state.identity.builds, round: row.id, at: now.toISOString() }, null, 2),
      );
      n += 1;
    }
  }
  return n;
}
