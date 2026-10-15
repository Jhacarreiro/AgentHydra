/**
 * workspaces - which Sue workspaces this computer has, and which Connections workspace each one is.
 * ================================================================================================
 *
 * Owner ask (Owner, 2026-09-22): "the SU manager should probably have the ability to change
 * workspaces because maybe different workspaces have different SUs." They do already: a Sue
 * workspace is a project folder with a `.sue/` store (lib/workspace.mjs) holding its own people,
 * pages, journals and scoreboard. What this file adds is the map the Manager needs:
 *
 *   folder -> Connections workspace  the Connections MCP binds each folder to a Studio project in
 *                                    ~/.connections/workspace-bindings.json ({ [folder]: { projectId } },
 *                                    services/studio/local-mcp/src-impl/02-auth-device-flow.mjs), so
 *                                    the Studio header's workspace switcher picks the same thing here
 *   run -> folder                    a run on a workspace's page records that page's file
 *                                    (manifest.targetFile = <folder>/.sue/target.<page>.json); a run on
 *                                    a roster target (a slug, or a file under sue/targets)
 *                                    belongs to the folder Sue is installed in
 *
 * A folder is a Sue workspace when its `.sue/` holds a page or a person, or when a run came from it.
 * A linked git worktree (a `.git` FILE, not a directory) is a copy of another checkout, never a
 * workspace of its own, so it is left out even when the MCP bound it.
 *
 * Pure reads, no writes. The ids handed to a browser are hashes of the folder path, so the page
 * never needs a path of this computer to name a workspace.
 */
import { loadTargets, targetRoot } from "../../lib/target.mjs";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { checkoutRoot } from "./engine-lease.mjs";
import { ownPeople, personPortraitFile } from "./personas.mjs";
import {
  STORE_DIR,
  listRosterPersonas,
  listWorkspacePersonas,
  ownPersonPortraitFile,
  pageRunTally,
  readJournal,
  readRunsLog,
  readScoreboard,
} from "./workspace.mjs";

/** The checkout Sue is installed in: roster runs belong to it (the checkout a snapshot was taken of, from a snapshot). */
export const ENGINE_FOLDER = targetRoot();
const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const TARGET_FILE = /^target(\..+)?\.json$/;

/**
 * The MCP's own spelling of a folder (normalizeWorkspacePath in
 * services/studio/local-mcp/src-impl/00-header-and-workspace.mjs, which keys the bindings file):
 * symlinks resolved when the folder exists, forward slashes, a WSL mount as its drive, lower-case
 * drive, no trailing slash. The MCP is one zero-dependency bundle fetched at runtime, so it cannot
 * be imported here; tests/workspaces.spec.mjs pins the rules.
 */
export function canonicalFolder(p) {
  const given = path.resolve(String(p));
  const known = CANONICAL.get(given);
  if (known) return known;
  let s = given;
  let found = false;
  try {
    s = fs.realpathSync(s);
    found = true;
  } catch {
    /* not there (yet): the spelling as given */
  }
  s = s
    .replace(/\\/g, "/")
    .replace(/^\/mnt\/([a-zA-Z])(?=\/|$)/, (_m, d) => `${d.toLowerCase()}:`)
    .replace(/\/+$/, "");
  s = /^[A-Za-z]:/.test(s) ? s[0].toLowerCase() + s.slice(1) : s;
  // A folder that is not there yet is looked up again next time; one that is keeps its spelling.
  if (found) CANONICAL.set(given, s);
  return s;
}

/*
 * The Manager answers its page from these reads many times a minute, and on a busy computer every
 * file read is slow: measured 2026-09-23 with the CPU full, one hello took 18 s and one workspace's
 * runs 48 s, because each request read all 543 run manifests again and looked up each run's folder
 * on disk. So a folder's real spelling is looked up once, and a file is parsed again only when its
 * size or time changed (a finished run's manifest never changes, so it is not even looked at).
 */
const CANONICAL = new Map();
const PARSED = new Map();

/** A JSON file, parsed again only when it changed; `final(value)` true means it never will. */
export function readJsonFresh(file, final = () => false) {
  const hit = PARSED.get(file);
  if (hit && hit.final) return hit.value;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    PARSED.delete(file);
    return null;
  }
  if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.value;
  const value = readJson(file);
  PARSED.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, value, final: value != null && final(value) });
  return value;
}

/** Two spellings of one folder compare equal: Windows paths are case-insensitive. */
export function folderKey(folder, platform = process.platform) {
  const s = canonicalFolder(folder);
  return platform === "win32" ? s.toLowerCase() : s;
}

/** The shape {@link workspaceId} mints: twelve hex of a sha1. */
export const WORKSPACE_ID_PATTERN = /^[0-9a-f]{12}$/;

export function workspaceId(folder) {
  return crypto.createHash("sha1").update(folderKey(folder)).digest("hex").slice(0, 12);
}

/**
 * The folders whose binding a folder answers to, nearest first: itself, then the checkout it sits
 * in, because the MCP binds a subfolder of a checkout as the checkout (gitToplevelFor), and a
 * harness worktree as its primary checkout. Found by walking up to the first `.git`, no git call.
 */
function bindingCandidates(folder) {
  const out = [folder];
  for (let dir = path.resolve(folder); ;) {
    if (fs.existsSync(path.join(dir, ".git"))) {
      out.push(dir);
      const primary = /^(.*)[\\/]\.claude[\\/]worktrees[\\/][^\\/]+$/.exec(dir)?.[1];
      if (primary) out.push(primary);
      return out;
    }
    const up = path.dirname(dir);
    if (up === dir) return out;
    dir = up;
  }
}

/** The Studio project a folder is bound to, the way the MCP would find it; null when none. */
export function projectFor(folder, bindings) {
  const byKey = new Map([...bindings].map(([f, id]) => [folderKey(f), id]));
  for (const candidate of bindingCandidates(folder)) {
    const id = byKey.get(folderKey(candidate));
    if (id) return id;
  }
  return null;
}

/**
 * The Connections workspace (Studio project) a folder's Sue runs belong to, when the caller names none: a target in this
 * checkout (targets/*.json) whose root is the folder and that declares `projectId`, else the project the Connections
 * MCP bound the folder to, the same one the sue door read from the signed-in workspace (26b-tools-sue.mjs). Null when
 * neither knows.
 */
export function workspaceProject(folder, { targets = loadTargets(), bindings = readBindings() } = {}) {
  const key = folderKey(canonicalFolder(folder));
  const own = targets.find(
    (t) => typeof t?.projectId === "string" && t.projectId.trim() && typeof t.root === "string" && folderKey(canonicalFolder(t.root)) === key,
  );
  return own ? own.projectId.trim() : projectFor(folder, bindings);
}

export function bindingsFile() {
  return path.join(os.homedir(), ".connections", "workspace-bindings.json");
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** canonical folder -> Studio project id, from the MCP's binding file. A missing file is no bindings. */
export function readBindings(file = bindingsFile()) {
  const raw = readJson(file) ?? {};
  const out = new Map();
  for (const [folder, row] of Object.entries(raw)) {
    if (row && typeof row.projectId === "string" && row.projectId) out.set(canonicalFolder(folder), row.projectId);
  }
  return out;
}

/** The folder a run belongs to (see the header). */
export function runFolder(manifest, engineFolder = ENGINE_FOLDER) {
  const file = typeof manifest?.targetFile === "string" ? manifest.targetFile : null;
  if (file && path.basename(path.dirname(file)) === STORE_DIR) return canonicalFolder(path.dirname(path.dirname(file)));
  // A target file in the engine's own roster (sue/targets/<name>/target.json) is a roster
  // target like a slug is; any other path is a product's own target file, beside its people.
  // A snapshot's copy of that roster (<store>/<id>/sue/targets/..., lib/engine-store.mjs), which a
  // roster errand's wave reads its target from, is the roster too.
  const rosterRoot = folderKey(engineFolder) === folderKey(ENGINE_FOLDER) ? checkoutRoot() : engineFolder;
  const roster = `${folderKey(path.join(rosterRoot, "sue", "targets"))}/`;
  const snapshotRoster = /\/[0-9a-f]{16}\/sue\/targets\//i;
  if (file && !folderKey(file).startsWith(roster) && !snapshotRoster.test(folderKey(file))) return canonicalFolder(path.dirname(file));
  return canonicalFolder(engineFolder);
}

function isLinkedWorktree(folder) {
  try {
    return fs.statSync(path.join(folder, ".git")).isFile();
  } catch {
    return false;
  }
}

function storeOf(folder) {
  return path.join(folder, STORE_DIR);
}

function storeHasSomething(folder) {
  const store = storeOf(folder);
  // Its people are in Connections (lib/people.mjs); a folder shows once SUE has been pointed at a page or sent someone.
  return listDir(store).some((f) => TARGET_FILE.test(f)) || listDir(path.join(store, "journal")).some((f) => f.endsWith(".jsonl"));
}

/*
 * A finished run's manifest never changes, yet a Manager that just restarted read every one of them
 * again before its first page could answer: 5 to 16 s for MonkeyWerx's 543 runs (2026-09-23, the
 * tray's "open" right after a restart). So the few fields anything reads off a FINISHED manifest are
 * kept in one file beside the runs, loaded once, and only a run that is not in it is read from disk.
 * Keyed by runId, and written only for a finished run, so it cannot go stale; a run folder that is
 * gone drops out of it the next time it is written.
 */
export const SETTLED_MANIFESTS_FILE = "settled-manifests.json";
const SETTLED_FIELDS = ["targetFile", "target", "startUrl", "started", "finished"];
const SETTLED = new Map();

function settledManifests(runsDir) {
  let known = SETTLED.get(runsDir);
  if (!known) {
    const saved = readJson(path.join(runsDir, SETTLED_MANIFESTS_FILE))?.runs;
    known = new Map(saved && typeof saved === "object" ? Object.entries(saved) : []);
    SETTLED.set(runsDir, known);
  }
  return known;
}

function keepSettled(runsDir, known, runIds) {
  const runs = {};
  for (const runId of runIds) if (known.has(runId)) runs[runId] = known.get(runId);
  const file = path.join(runsDir, SETTLED_MANIFESTS_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify({ runs }));
    fs.renameSync(tmp, file);
  } catch {
    // A read-only or busy disk only costs the next restart its cold read.
    fs.rmSync(tmp, { force: true });
  }
}

/**
 * Every run folder under `runsDir` with the workspace folder it belongs to, newest first.
 * A manifest is read once it changes (a finished one once, and after a restart not at all), so this
 * is one directory listing.
 */
export function runsByFolder(runsDir, engineFolder = ENGINE_FOLDER) {
  const out = [];
  const known = settledManifests(runsDir);
  let added = false;
  const runIds = listDir(runsDir)
    .filter((n) => RUN_ID.test(n))
    .sort()
    .reverse();
  for (const runId of runIds) {
    let manifest = known.get(runId);
    if (!manifest) {
      manifest = readJsonFresh(path.join(runsDir, runId, "manifest.json"), (m) => Boolean(m.finished));
      if (manifest?.finished) {
        known.set(runId, Object.fromEntries(SETTLED_FIELDS.filter((k) => manifest[k] !== undefined).map((k) => [k, manifest[k]])));
        added = true;
      }
    }
    if (manifest) out.push({ runId, folder: runFolder(manifest, engineFolder), manifest });
  }
  if (added) keepSettled(runsDir, known, runIds);
  return out;
}

/**
 * The Sue workspaces on this computer: `{ id, name, folder, projectId, isEngine, runs, lastRunAt }`,
 * the engine's own checkout first, then by most recent run. `folder` never leaves this computer.
 */
export function discoverWorkspaces({ runsDir, bindings = readBindings(), engineFolder = ENGINE_FOLDER } = {}) {
  const engine = canonicalFolder(engineFolder);
  const runs = runsByFolder(runsDir, engineFolder);
  // Keyed case-insensitively on Windows, so two spellings of one folder are one row (the first
  // spelling seen names it).
  const byFolder = new Map();
  const add = (folder) => {
    const key = folderKey(folder);
    if (!byFolder.has(key)) byFolder.set(key, { folder, runs: 0, lastRunAt: null });
    return byFolder.get(key);
  };
  add(engine);
  for (const { folder, manifest } of runs) {
    const row = add(folder);
    row.runs += 1;
    const at = manifest.started ?? null;
    if (at && (!row.lastRunAt || at > row.lastRunAt)) row.lastRunAt = at;
  }
  for (const folder of bindings.keys()) if (storeHasSomething(folder)) add(folder);
  const engineKey = folderKey(engine);
  return [...byFolder.entries()]
    .filter(([key, { folder }]) => key === engineKey || (fs.existsSync(folder) && !isLinkedWorktree(folder)))
    .map(([key, { folder, runs: count, lastRunAt }]) => ({
      id: workspaceId(folder),
      name: path.basename(folder),
      folder,
      projectId: projectFor(folder, bindings),
      isEngine: key === engineKey,
      runs: count,
      lastRunAt,
    }))
    .sort((a, b) => Number(b.isEngine) - Number(a.isEngine) || String(b.lastRunAt ?? "").localeCompare(String(a.lastRunAt ?? "")));
}

/**
 * The addresses this workspace has already sent people to, for the wave form to offer: every page
 * file's start link and every page on its scoreboard, deduped. A new wave may name any other address
 * too; `sue run` writes its page file the first time.
 */
export function workspaceStartUrls(workspace) {
  const store = storeOf(workspace.folder);
  const urls = new Set();
  for (const f of listDir(store).filter((n) => TARGET_FILE.test(n))) {
    const url = readJsonFresh(path.join(store, f))?.startUrl;
    if (typeof url === "string" && /^https?:\/\//.test(url)) urls.add(url);
  }
  for (const p of Object.values(readScoreboard(workspace.folder)?.pages ?? {})) {
    if (typeof p?.url === "string" && /^https?:\/\//.test(p.url)) urls.add(p.url);
  }
  return [...urls].sort();
}

/**
 * The people a wave from this workspace may send, as Connections answered them to this process (the Manager
 * installs the folder's people first, lib/people.mjs `peopleOfFolder`): the roster, with this workspace's own
 * people winning by id (`own: true`), each with how her visits here have gone. `sue run` takes both kinds.
 * A roster person Sue's loader refuses carries its words in `problem` (lib/workspace.mjs listRosterPersonas).
 * `portrait` says she has a painted card: a roster person's in personas/portraits, the folder's own in its .sue store.
 */
export function workspacePeople(workspace, roster = listRosterPersonas()) {
  const own = listWorkspacePersonas(workspace.folder);
  const ownDials = (id) => ownPeople().find((p) => p.id === id)?.dials ?? {};
  const rows = [
    ...own.map((p) => ({
      id: p.id,
      displayName: p.displayName ?? p.id,
      device: ownDials(p.id).device ?? roster.find((r) => r.id === p.like)?.device,
      own: true,
      likeId: p.like,
      portrait: ownPersonPortraitFile(workspace.folder, p.id) !== null,
    })),
    ...roster
      .filter((r) => !own.some((p) => p.id === r.id))
      .map((r) => ({
        id: r.id,
        displayName: r.displayName ?? r.id,
        device: r.device,
        own: false,
        likeId: null,
        portrait: personPortraitFile(r.id) !== null,
        ...(r.problem ? { problem: r.problem } : {}),
      })),
  ];
  return rows
    .map((row) => {
      const visits = readJournal(workspace.folder, row.id, 1000);
      const stars = visits.map((v) => v.stars).filter((n) => typeof n === "number");
      return {
        ...row,
        device: row.device === "phone" ? "phone" : "desktop",
        visits: visits.length,
        lastVisitAt: visits[0]?.at ?? null,
        averageStars: stars.length ? Math.round((stars.reduce((x, y) => x + y, 0) / stars.length) * 10) / 10 : null,
      };
    })
    .sort((a, b) => Number(b.own) - Number(a.own) || b.visits - a.visits || a.displayName.localeCompare(b.displayName));
}

/** Every roster problem this process has logged: persona id and the loader's words. */
const LOGGED_PROBLEMS = new Set();

/**
 * For the Manager's own log: each person Sue's loader refuses (a `problem` from `workspacePeople`),
 * once per distinct persona and reason for this process's life, however often the page asks. Returns
 * `people` as it was.
 */
export function logRosterProblems(people, { seen = LOGGED_PROBLEMS, log = console } = {}) {
  for (const person of people) {
    if (!person.problem) continue;
    const key = `${person.id}\n${person.problem}`;
    if (seen.has(key)) continue;
    seen.add(key);
    log.error(`Sue's roster: ${person.id} cannot be sent: ${person.problem}`);
  }
  return people;
}

/** One person's visits in this workspace, newest first, as her journal keeps them. Text only. */
export function personVisits(workspace, personId, limit = 50) {
  return readJournal(workspace.folder, personId, limit).map((v) => ({
    at: v.at ?? null,
    runId: typeof v.runId === "string" ? v.runId : null,
    page: typeof v.page?.url === "string" ? v.page.url : null,
    intent: v.intent == null ? null : String(v.intent),
    outcome: v.outcome ?? null,
    stars: typeof v.stars === "number" ? v.stars : null,
    threeWords: v.threeWords == null ? null : String(v.threeWords),
    madeAccount: Boolean(v.madeAccount),
    comingBack: typeof v.everComingBack?.yes === "boolean" ? v.everComingBack.yes : null,
    mostConfusing: v.mostConfusing == null ? null : String(v.mostConfusing),
    whyStopped: v.whyStopped == null ? null : String(v.whyStopped),
    said: (Array.isArray(v.diary) ? v.diary : [])
      .slice(0, 12)
      .map((d) => String(d?.said ?? ""))
      .filter(Boolean),
  }));
}

/** This workspace's pages as its scoreboard keeps them, most-run first. */
export function workspacePages(workspace) {
  const pages = readScoreboard(workspace.folder)?.pages ?? {};
  const sentLog = readRunsLog(workspace.folder);
  return Object.entries(pages)
    .map(([key, p]) => {
      const history = Array.isArray(p.history) ? p.history : [];
      const last = history.at(-1) ?? null;
      return {
        key,
        url: typeof p.url === "string" ? p.url : null,
        runs: typeof p.runs === "number" ? p.runs : history.length,
        // Every wave sent at the page, finished or not, so a page Sues keep being sent at shows (Owner, 2026-09-23).
        sent: pageRunTally(sentLog, key),
        sues: typeof p.sues === "number" ? p.sues : null,
        averageStars: typeof p.averageStarsAllTime === "number" ? p.averageStarsAllTime : (last?.averageStars ?? null),
        lastRunAt: last?.at ?? null,
        sueVersion: last?.sueVersion ?? null,
        history: history
          .slice(-20)
          .map((h) => ({
            runId: h.runId ?? null,
            at: h.at ?? null,
            sueVersion: h.sueVersion ?? null,
            sues: h.sues ?? null,
            averageStars: h.averageStars ?? null,
            madeAccountShare: h.madeAccountShare ?? null,
            finishedShare: h.finishedShare ?? null,
            neverComingBackShare: h.neverComingBackShare ?? null,
          })),
      };
    })
    .sort((a, b) => b.runs - a.runs);
}
