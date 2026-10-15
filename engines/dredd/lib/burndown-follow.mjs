import { loadTarget, targetPath } from "../../lib/target.mjs";
// dredd/lib/burndown-follow.mjs - following a burn-down list to done. The owner, 2026-10-10: the experts' answers merge
// into one ordered list "that the AI would then follow". lib/claim-diagnosis.mjs writes the list (burndown.json) and
// reviews one item's repair; this keeps each item's state in burndown-status.json beside it (a rerun of the experts
// rewrites burndown.json, never this file) and drives the loop:
//
//   open -> building -> built -> reviewed:SOLVED
//                         `--> reviewed:PARTLY | reviewed:NOT SOLVED -> reopened -> building -> built -> ...
//
// A reopened item's brief carries every review's NEXT lines, in the experts' words, as its follow-up. A review no
// expert answered (the plane refused, the brain failed) changes nothing: the item stays built for the next review.
// The review sees the item's screens captured headless by scripts/ui/phone-render.mjs at 390x844 and 1280x800.
import { execFileSync } from "node:child_process";
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { BURNDOWN_JSON, BURNDOWN_MD, readBurndownFile, reviewItem, sitSittings } from "./claim-diagnosis.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = targetRoot();
export const STATUS_JSON = "burndown-status.json";
/** Each review's captures and its copy of review-<item>.json/.md: follow/<item>-r<n>/ in the docket. */
export const FOLLOW_DIR = "follow";
export const FOLLOW_SCRIPT = path.join(HERE, "..", "follow-burndown.mjs");
export const PHONE_RENDER = targetPath(loadTarget().phoneRender);
/** The counts every review reads beside the pictures: what stands on each screen before any tap (scripts/ui/first-screen.js). */
export const FIRST_SCREEN = targetPath(loadTarget().firstScreen);
/** The wide view captured beside phone-render's own 390x844 phone view: the size the burn-down's briefs name. */
export const DESKTOP_VIEW = "1280x800";
/** At most this many of an item's pages are captured; --path names others. */
export const CAPTURE_MAX_PATHS = 3;
const TODO = new Set(["open", "reopened"]);

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};
const short = (sha) => String(sha || "").slice(0, 7);

/** The docket's status file, or an empty board. A file that is there but unreadable throws: it never resets to all open. */
export function readStatus(docketDir) {
  const file = path.join(docketDir, STATUS_JSON);
  if (!existsSync(file)) return { docket: docketDir, items: {} };
  return JSON.parse(readFileSync(file, "utf8"));
}

export function writeStatus(docketDir, state) {
  const file = path.join(docketDir, STATUS_JSON);
  const { orphans, ...kept } = state;
  const out = { ...kept, ...(orphans?.length ? { orphans } : {}), updatedAt: new Date().toISOString() };
  // A temporary file of this process's own: two writers sharing one name wrote into each other's.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
  renameSync(tmp, file);
}

/** How long a command waits for another to finish with the status file, and the age past which a lock is a dead holder's. */
const LOCK_WAIT_MS = 30_000;
const LOCK_STALE_MS = 60_000;
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Runs `fn` (a read of the status file, a change and its write, all synchronous) holding the docket's lock, a file
 * made with O_EXCL beside the status file, so commands following one docket at once never write over each other.
 * Without it, four `built` runs started together kept only the last one's build, every time (Raise Buddy docket
 * ab1012-7d91, 2026-10-11). A lock older than LOCK_STALE_MS is a crashed holder's and is taken over.
 */
export function withStatusLock(docketDir, fn) {
  const lock = path.join(docketDir, `${STATUS_JSON}.lock`);
  const until = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    try {
      // The holder's own clock goes inside: a file's times are not trusted for staleness (NTFS gives a name deleted and
      // made again within seconds its old creation time).
      const fd = openSync(lock, "wx");
      writeSync(fd, String(Date.now()));
      closeSync(fd);
      break;
    } catch (err) {
      // Windows answers EPERM (or EACCES, EBUSY) while a lock its holder just deleted is still pending deletion: held too.
      if (!["EEXIST", "EPERM", "EACCES", "EBUSY"].includes(err?.code)) throw err;
      let age;
      try {
        const since = Number(readFileSync(lock, "utf8"));
        age = since > 0 ? Date.now() - since : 0; // empty: made a moment ago, its time not written yet
      } catch {
        continue; // released between the two calls: try again at once
      }
      if (age > LOCK_STALE_MS) {
        try {
          unlinkSync(lock);
        } catch {
          // another holder took the stale lock first: retry
        }
        continue;
      }
      if (Date.now() > until)
        throw new Error(`${lock} is held by another follow-burndown command; try again when it has finished`, { cause: err });
      pause(25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already removed by a takeover: nothing to release
    }
  }
}

/** What makes an item the same item across a rewrite of the list: its claims, or its title when it has none. */
const identity = (x) => (x.claims?.length ? `claims:${[...x.claims].sort().join(",")}` : `title:${x.title}`);
const overlap = (a = [], b = []) => {
  const union = new Set([...a, ...b]).size;
  if (!union || !a.length || !b.length) return 0;
  const A = new Set(a);
  return b.filter((x) => A.has(x)).length / union;
};

/**
 * The status entries keyed by the CURRENT list's ids. A rerun of the experts renumbers the list, so an entry follows its
 * claims: the item with the same claims, else the one sharing at least half of them. An entry still under its own id
 * with its item's claims is that item's before any of this: two items may name the same claims (Raise Buddy docket
 * ab1012-7d91, 2026-10-11: B3 and B5 both answer C2, C6 and C9), and matching on claims alone gave B5's entry to B3.
 * An entry no item matches is kept as an orphan, shown on the board and never applied to another item. Pure.
 */
export function reconcile(burn, state) {
  const entries = Object.entries(state.items || {});
  const taken = new Set();
  const items = {};
  const score = {
    own: (k, e, item) => (k === item.id && identity(e) === identity(item) ? 1 : 0),
    same: (k, e, item) => (identity(e) === identity(item) ? 1 : 0),
    overlap: (k, e, item) => overlap(e.claims, item.claims),
  };
  for (const pass of ["own", "same", "overlap"]) {
    for (const item of burn.items) {
      if (items[item.id]) continue;
      let pick = null;
      let best = pass === "overlap" ? 0.5 - 1e-9 : 0;
      for (const [k, e] of entries) {
        if (taken.has(k)) continue;
        const s = score[pass](k, e, item);
        if (s > best) [pick, best] = [k, s];
      }
      if (!pick) continue;
      taken.add(pick);
      const e = state.items[pick];
      items[item.id] =
        pick === item.id
          ? e
          : {
              ...e,
              title: item.title,
              claims: item.claims,
              history: [
                ...(e.history || []),
                { at: burn.finishedAt ?? null, from: e.status, to: e.status, why: `renumbered from ${pick}` },
              ],
            };
    }
  }
  const orphans = [...(state.orphans || []), ...entries.filter(([k]) => !taken.has(k)).map(([id, e]) => ({ id, ...e }))];
  return { ...state, items, orphans };
}

/** The item `id` names in the list (case-blind), or a throw that lists what the list holds. */
export function findItem(burn, id) {
  const want = String(id || "").toUpperCase();
  const item = burn.items.find((x) => x.id.toUpperCase() === want);
  if (!item) throw new Error(`no item ${id} in ${BURNDOWN_JSON} (it has ${burn.items.map((x) => x.id).join(", ")})`);
  return item;
}

/** An item held on a kept call reads as held, whatever review left its status: `next` passes over it until a build. */
export const statusOf = (state, item) => (state.items[item.id]?.held ? "held" : (state.items[item.id]?.status ?? "open"));

function entry(state, item) {
  state.items[item.id] ??= { status: "open", title: item.title, claims: item.claims, builds: [], reviews: [], history: [] };
  return state.items[item.id];
}

function move(e, to, why, at) {
  e.history.push({ at, from: e.status, to, ...(why ? { why } : {}) });
  e.status = to;
}

/** The first item, in the list's own order, still to build: open, or reopened by a review. Pure. */
export function nextItem(burn, state) {
  return burn.items.find((x) => TODO.has(statusOf(state, x))) ?? null;
}

/** Hands an open or reopened item to a builder: it is building, and `next` passes over it. */
export function takeItem(state, item, { at }) {
  const e = entry(state, item);
  if (e.held || !TODO.has(e.status)) throw new Error(`${item.id} is ${e.held ? "held" : e.status}: only an open or reopened item is handed to a builder`);
  move(e, "building", null, at);
  return e;
}

/** A build landed for the item: `build` is { commit, short, repo, subject, committedAt }. A second build before the review adds to it. */
export function recordBuilt(state, item, build, { at }) {
  const e = entry(state, item);
  if (e.status === "reviewed:SOLVED") throw new Error(`${item.id} is already solved (review ${e.reviews.length}): nothing to build`);
  e.builds.push({ ...build, at });
  if (e.held) {
    e.history.push({ at, from: e.status, to: e.status, why: `hold cleared by build ${build.short}` });
    delete e.held;
  }
  move(e, "built", `${build.short} ${build.subject || ""}`.trim(), at);
  return e;
}

/**
 * The experts' review of the item's newest build. SOLVED closes it; PARTLY or NOT SOLVED reopens it, its experts' NEXT
 * lines becoming the follow-up its next brief carries; NO VERDICT (no expert answered) leaves it built. `review` is
 * reviewItem's result; `meta` adds { after, file, served, errors, url, paths }.
 */
export function recordReview(state, item, review, { at, ...meta }) {
  const e = entry(state, item);
  if (e.status !== "built" && !e.held) throw new Error(`${item.id} is ${e.status}: only a built item is reviewed`);
  const build = e.builds.at(-1) ?? null;
  const row = {
    n: e.reviews.length + 1,
    verdict: review.verdict,
    commit: build?.commit ?? null,
    at,
    seats: Object.fromEntries(
      Object.entries(review.seats || {}).map(([seat, s]) => [seat, { verdict: s.verdict ?? null, why: s.problems?.P1?.why ?? "" }]),
    ),
    next: review.next || [],
    broke: review.broke || [],
    cost_usd: review.cost_usd ?? null,
    seconds: review.seconds ?? null,
    ...meta,
  };
  e.reviews.push(row);
  if (review.verdict === "NO VERDICT") {
    const why = meta.errors?.length ? `: ${meta.errors[0]}` : "";
    e.history.push({ at, from: e.status, to: e.status, why: `review ${row.n} had no verdict${why}` });
    return e;
  }
  move(e, `reviewed:${review.verdict}`, `review ${row.n} of ${short(row.commit)}`, at);
  if (review.verdict !== "SOLVED") move(e, "reopened", `${row.next.length} NEXT line(s) from the experts`, at);
  else if (e.held) {
    e.history.push({ at, from: e.status, to: e.status, why: "hold cleared: solved on review" });
    delete e.held;
  }
  return e;
}

/**
 * Keeps a call the experts judged against (a repair whose NEXT would undo another item's SOLVED spec, or a deliberate design
 * call): the item keeps its review's status, reads as held with the reason, and `next` passes over it until a build clears
 * the hold. A review of the same build may still run, and reads the reason as a KEPT CALL. Pure over state.
 */
export function holdItem(state, item, reason, { at }) {
  const e = entry(state, item);
  if (e.status === "reviewed:SOLVED") throw new Error(`${item.id} is already solved: nothing to hold`);
  e.held = { reason, at };
  e.history.push({ at, from: e.status, to: e.status, why: `held: ${reason}` });
  return e;
}

/** The page paths a screen names ("/box/:id — Edit" gives "/box/:id"), the way two items' screens are compared. Pure. */
export function pagesOf(screen) {
  const parts = String(screen || "").split(/,|→|->|\s+and\s+/);
  return [...new Set(parts.map((p) => p.trim().split(/\s+/)[0]).filter((p) => p?.startsWith("/")))];
}

/**
 * The other items of the docket whose pages overlap this item's: the repairs on the same screens, which the review is told
 * are judged under their own items. Each is { id, status, title, spec } where spec is the first sentence of its fix. Pure.
 */
export function othersOf(burn, state, item) {
  const mine = new Set(pagesOf(item.screen));
  return burn.items
    .filter((x) => x.id !== item.id && pagesOf(x.screen).some((p) => mine.has(p)))
    .map((x) => ({ id: x.id, status: statusOf(state, x), title: x.title, spec: String(x.fix || "").split(/(?<=\.)\s/)[0].trim() }));
}

/** Records a kept call for the item, under the docket's lock, re-reading the status file first. */
export function followRule({ docketDir, itemId, reason, now = () => Date.now() }) {
  if (!String(reason || "").trim()) throw new Error('rule needs --keep "<reason>": the call the experts judged against, and why it stands');
  const burn = needBurndown(docketDir);
  const item = findItem(burn, itemId);
  return withStatusLock(docketDir, () => {
    const state = reconcile(burn, readStatus(docketDir));
    const e = holdItem(state, item, String(reason).trim(), { at: new Date(now()).toISOString() });
    writeStatus(docketDir, state);
    return { item, entry: e };
  });
}

/** The item's own section of burndown.md, without its "Proof owed" paragraph (the follow loop owes that proof itself). */
export function itemSection(md, item) {
  const lines = String(md).split(/\r?\n/);
  const start = lines.findIndex((l) => l.startsWith(`## ${item.id} - `));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
  const body = lines.slice(start, end < 0 ? undefined : end).join("\n");
  return body.replace(/\n+Proof owed:[\s\S]*$/, "").trimEnd();
}

/** The follow-up a reopened item carries: every review that did not solve it, its NEXT and BROKE lines in the experts' words. Pure. */
export function followUpLines(e) {
  const lines = [];
  for (const r of (e?.reviews || []).filter((x) => x.verdict === "PARTLY" || x.verdict === "NOT SOLVED")) {
    lines.push(
      "",
      `## Follow-up: review ${r.n} of ${short(r.commit) || "the build"} came back ${r.verdict} (${r.at})`,
      "",
      "The item's experts judged the screen after that build against this brief. It is not done: build what they name next, and keep what already works.",
    );
    if (r.after?.length) lines.push(`Their AFTER pictures: ${r.after.join(", ")}`);
    if (r.next.length) lines.push("", "Next, in the experts' words:", ...r.next.map((x) => `- ${x.seat}: ${x.next}`));
    if (r.broke.length) lines.push("", "What the build broke, or changed under Keep:", ...r.broke.map((x) => `- ${x.seat}: ${x.broke}`));
    const seats = Object.entries(r.seats || {});
    if (seats.length)
      lines.push(
        "",
        "Each expert's reading:",
        ...seats.map(([s, v]) => `- ${s}: ${v.verdict ?? "no verdict"}${v.why ? ` - ${v.why}` : ""}`),
      );
  }
  return lines;
}

/** The standalone brief for a builder: the item's burndown.md section, its follow-ups, and how the build is recorded. */
export function briefFor(docketDir, burn, state, item) {
  const md = existsSync(path.join(docketDir, BURNDOWN_MD)) ? readFileSync(path.join(docketDir, BURNDOWN_MD), "utf8") : "";
  const section = itemSection(md, item);
  if (!section) throw new Error(`no "## ${item.id} - " section in ${path.join(docketDir, BURNDOWN_MD)}: write the list again`);
  const e = state.items[item.id];
  const n = burn.items.indexOf(item) + 1;
  const script = path.relative(ROOT, FOLLOW_SCRIPT).replace(/\\/g, "/");
  return [
    `# Burn-down item ${item.id} (${n} of ${burn.items.length}, ${statusOf(state, item)})`,
    "",
    section,
    ...followUpLines(e),
    "",
    "## How it is built",
    "",
    "Subtract before you add. Whatever the repair puts on the screen before any tap is paid for by what it takes away (the item's Screen cost); a new answer goes behind a tap where the person looked for it, not into a permanent line. Keep the one thing the screen is for first and let the rest step back. Use the product's shared primitives, and anything that opens, closes or expands animates on its shared motion.",
    "",
    "## When it is built",
    "",
    "Land it in the product and report the commit. The orchestrator records the build and has the item's experts judge fresh screenshots of it (in Connections):",
    `\`bun ${script} built --docket ${docketDir} --item ${item.id} --commit <sha> --repo <the product's checkout>\``,
    `\`bun ${script} review --docket ${docketDir} --item ${item.id} [--url <where the build is served>]\``,
    "",
  ].join("\n");
}

/** The board: one line per item in list order, with its build and its last review. Pure. */
export function boardLines(burn, state) {
  const count = {};
  for (const x of burn.items) count[statusOf(state, x)] = (count[statusOf(state, x)] ?? 0) + 1;
  const lines = [
    `Burn-down ${burn.docket}: ${burn.items.length} item(s); ${Object.entries(count)
      .map(([s, k]) => `${k} ${s}`)
      .join(", ")}`,
    "",
  ];
  for (const x of burn.items) {
    const e = state.items[x.id];
    const st = statusOf(state, x);
    const b = e?.builds?.at(-1);
    const r = e?.reviews?.at(-1);
    const detail = [
      ...(st === "building" ? [`since ${e.history.at(-1)?.at ?? "?"}`] : []),
      ...(b ? [`built ${b.short}`] : []),
      ...(r ? [`review ${r.n} ${r.verdict}${r.errors?.length ? ` (${r.errors[0].slice(0, 120)})` : ""}`] : []),
      ...(st === "reopened" ? [`${r?.next?.length ?? 0} NEXT line(s)`] : []),
      ...(st === "held" ? [`held: ${e.held.reason}`] : []),
    ];
    lines.push(
      `${x.id.padEnd(4)} ${st.padEnd(19)} [sev ${x.severity}] ${x.screen}: ${x.title}${detail.length ? ` | ${detail.join("; ")}` : ""}`,
    );
  }
  for (const o of state.orphans || []) {
    lines.push(`(orphan) ${o.id} ${o.status}: "${o.title}" (${(o.claims || []).join(", ")}) matches no item in the rewritten list`);
  }
  return lines;
}

/** The pages an item's screen names that can be opened as they stand: "/print", not "/box/:id" nor "label slot picker". Pure. */
export function screenPaths(screen) {
  const parts = String(screen || "").split(/,|→|->|\s+and\s+/);
  const paths = parts.map((p) => p.trim().split(/\s+/)[0]).filter((p) => p?.startsWith("/") && !p.includes("/:"));
  return [...new Set(paths)].slice(0, CAPTURE_MAX_PATHS);
}

/**
 * A page under the product URL. A bare path keeps the product URL's own query, since the query is how a product shows
 * its sample data ("/print" under "https://app.example/?demo" opens "/print?demo", not an empty app); a path with its own
 * query keeps that one. Pure.
 */
function pageUrl(page, base) {
  const u = new URL(page, base);
  const b = new URL(base);
  if (!String(page).includes("?") && b.search && u.origin === b.origin) u.search = b.search;
  return u.href;
}

/** A PNG's height in pixels, read from its header (null for anything else). */
function pngHeight(file) {
  const buf = Buffer.alloc(24);
  const fd = openSync(file, "r");
  try {
    readSync(fd, buf, 0, 24, 0);
  } finally {
    closeSync(fd);
  }
  return buf.toString("latin1", 1, 4) === "PNG" ? buf.readUInt32BE(20) : null;
}

/**
 * git in the product's checkout: the full sha, subject and date of `commit`, and the claim ids its message names (C85),
 * or a throw naming what git said.
 */
export function resolveCommit(repo, commit) {
  const git = (...a) => execFileSync("git", ["-C", repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  let sha;
  try {
    sha = git("rev-parse", "--verify", `${commit}^{commit}`);
  } catch (err) {
    const said = String(err.stderr || err.message)
      .trim()
      .split("\n")[0];
    throw new Error(`no commit ${commit} in ${repo}: ${said}`, { cause: err });
  }
  const [subject, committedAt] = git("log", "-1", "--format=%s%n%cI", sha).split("\n");
  const claims = [...new Set(git("log", "-1", "--format=%B", sha).match(/\bC\d+\b/g) || [])];
  return { commit: sha, short: short(sha), repo: path.resolve(repo), subject, committedAt, claims };
}

/**
 * A commit that names claims belongs to an item answering one of them: a rerun of the experts renumbers the list under
 * the builder (Packing Buddy's B17 became B14 and B16 while f1e8b94 was being built). Throws naming the items that do.
 */
function checkClaims(burn, item, build) {
  if (!build.claims.length || build.claims.some((c) => item.claims.includes(c))) return;
  const theirs = burn.items.filter((x) => x.claims.some((c) => build.claims.includes(c)) || x.already_changed?.commit === build.short);
  throw new Error(
    `${build.short} names ${build.claims.join(", ")}, none of which ${item.id} answers ("${item.title}": ${item.claims.join(", ") || "no claim"}). ` +
      `${theirs.length ? `The items that do: ${theirs.map((x) => `${x.id} (${x.claims.filter((c) => build.claims.includes(c)).join(", ") || `ALREADY CHANGED in ${build.short}`}) ${x.title}`).join("; ")}.` : "No item answers them."}`,
  );
}

/** Whether a local server's checkout holds the build: its HEAD contains the commit, and how many files are dirty. */
export function servedFacts(url, build) {
  const u = new URL(url);
  if (!["localhost", "127.0.0.1"].includes(u.hostname))
    return { url, checked: false, why: "a deployed site: the build it serves is not read" };
  if (!build?.repo) return { url, checked: false, why: "no checkout recorded with the build" };
  const git = (...a) => execFileSync("git", ["-C", build.repo, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], windowsHide: true }).trim();
  const head = git("rev-parse", "HEAD");
  let contains = true;
  try {
    git("merge-base", "--is-ancestor", build.commit, head);
  } catch {
    contains = false;
  }
  return {
    url,
    checked: true,
    repo: build.repo,
    head: short(head),
    contains,
    dirty: git("status", "--porcelain").split("\n").filter(Boolean).length,
  };
}

/**
 * The item's pages captured headless through phone-render (the fleet's one capture door): 390x844 on a touch phone and
 * DESKTOP_VIEW on a fine pointer, each page's whole-document shot too when it runs past the window. `run` is the command
 * door (lib/collect.mjs runAsync). Resolves the PNG paths; throws with phone-render's own words when it fails.
 */
export async function captureScreens({ root = ROOT, run, url, paths, args = [], outDir, name }) {
  const base = new URL(url);
  const local = ["localhost", "127.0.0.1"].includes(base.hostname);
  const targets = paths.map((p, i) => ({ url: pageUrl(p, base), name: `${name}-${i + 1}` }));
  mkdirSync(outDir, { recursive: true });
  const urlsFile = path.join(outDir, "urls.json");
  writeFileSync(urlsFile, `${JSON.stringify(targets, null, 2)}\n`);
  const where = local ? ["--local", base.port || "80"] : ["--live"];
  const argv = [
    PHONE_RENDER,
    ...where,
    "--urls",
    urlsFile,
    "--viewport",
    DESKTOP_VIEW,
    "--out",
    outDir,
    "--eval-file",
    FIRST_SCREEN,
    ...args,
  ];
  const r = await run("bun", argv, { cwd: root, timeoutMs: 10 * 60_000 });
  const said = `${r.stdout || ""}\n${r.stderr || ""}`.trim().slice(-800);
  const stepShots = args
    .filter((x, i) => args[i - 1] === "--step" && /^shot:/.test(x))
    .map((x) =>
      x
        .slice(5)
        .trim()
        .replace(/[^\w-]+/g, "-"),
    );
  if (r.status !== 0)
    throw new Error(`phone-render could not capture ${targets.map((t) => t.url).join(", ")} (exit ${r.status ?? r.error}): ${said}`);
  const shots = [];
  for (const t of targets) {
    for (const view of ["", `-${DESKTOP_VIEW}`]) {
      const shot = path.join(outDir, `${t.name}${view}.png`);
      if (!existsSync(shot)) throw new Error(`phone-render exited 0 and left no ${shot}: ${said}`);
      // A recipe's own `--step "shot:<label>"` frames (the page before a tap opened something) come before the end state.
      for (const label of stepShots) {
        const mid = path.join(outDir, `${t.name}${view}-${label}.png`);
        if (!existsSync(mid)) throw new Error(`phone-render exited 0 and left no ${mid}: ${said}`);
        shots.push(mid);
      }
      shots.push(shot);
      const full = path.join(outDir, `${t.name}${view}-full.png`);
      if (existsSync(full) && pngHeight(full) > pngHeight(shot)) shots.push(full);
    }
  }
  return shots;
}

/**
 * Hands out the next item, or the one `itemId` names (a reopened item back to its builder): { item, brief }, or null
 * when nothing is left to build. `take` marks it building.
 */
export function followNext({ docketDir, itemId = null, take = false, now = () => Date.now() }) {
  const burn = needBurndown(docketDir);
  return withStatusLock(docketDir, () => {
    const state = reconcile(burn, readStatus(docketDir));
    const item = itemId ? findItem(burn, itemId) : nextItem(burn, state);
    if (!item) return null;
    const brief = briefFor(docketDir, burn, state, item);
    if (take) {
      takeItem(state, item, { at: new Date(now()).toISOString() });
      writeStatus(docketDir, state);
    }
    return { item, brief };
  });
}

/** True when `older` is a strict ancestor of `newer` in `repo`; false when git cannot answer. */
function isStrictAncestor(repo, older, newer) {
  if (older === newer) return false;
  try {
    execFileSync("git", ["-C", repo, "merge-base", "--is-ancestor", older, newer], { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Records a build of the item: the commit must exist in the product's checkout `repo`. A commit that is a strict
 * ancestor of the item's last build in the same repo is refused (an old note must not replace a newer build) unless `force`.
 */
export function followBuilt({ docketDir, itemId, commit, repo, force = false, now = () => Date.now() }) {
  if (!commit || !repo) throw new Error("built needs --commit <sha> and --repo <the product's checkout>");
  const burn = needBurndown(docketDir);
  const item = findItem(burn, itemId);
  const build = resolveCommit(repo, commit);
  checkClaims(burn, item, build);
  return withStatusLock(docketDir, () => {
    const state = reconcile(burn, readStatus(docketDir));
    const recorded = (state.items?.[item.id]?.builds ?? []).findLast((b) => b.repo === build.repo);
    if (!force && recorded && state.items[item.id].status !== "reviewed:SOLVED" &&isStrictAncestor(build.repo, build.commit, recorded.commit)) {
      throw new Error(
        `${item.id}: ${build.short} is older than the recorded build ${recorded.short}; not recorded (pass --force to record an older build on purpose)`,
      );
    }
    const e = recordBuilt(state, item, build, { at: new Date(now()).toISOString() });
    writeStatus(docketDir, state);
    return { item, entry: e };
  });
}

/**
 * The review of a built item: its pages captured from `url` (default the list's product URL, or the last review's), or
 * the `after` shots given; then reviewItem asks the item's experts; the verdict is recorded and PARTLY or NOT SOLVED
 * reopens it. `captureOnly` stops after the capture (no expert asked, nothing recorded), to check a recipe first.
 * `sitReview` is reviewItem's sitting door (default the Connections Boardroom through sitSittings).
 */
export async function followReview({
  root = ROOT,
  docketDir,
  itemId,
  url = null,
  paths = null,
  args = null,
  after = null,
  captureOnly = false,
  run = null,
  sitReview = null,
  log = () => {},
  now = () => Date.now(),
}) {
  const burn = needBurndown(docketDir);
  const state = reconcile(burn, readStatus(docketDir));
  const item = findItem(burn, itemId);
  const e = state.items[item.id];
  const judgeable = statusOf(state, item) === "built" || (statusOf(state, item) === "held" && e.builds.length > 0);
  if (!judgeable) {
    throw new Error(
      `${item.id} is ${statusOf(state, item)}: record its build first (built --item ${item.id} --commit <sha> --repo <checkout>)`,
    );
  }
  const n = e.reviews.length + 1;
  const outDir = path.join(docketDir, FOLLOW_DIR, `${item.id}-r${n}`);
  mkdirSync(outDir, { recursive: true });
  let shots = (after || []).filter(Boolean);
  let capture = null;
  let served = null;
  if (!shots.length) {
    capture = {
      url: url || e.capture?.url || burn.url,
      paths: paths?.length ? paths : e.capture?.paths?.length ? e.capture.paths : screenPaths(item.screen),
      args: args ?? e.capture?.args ?? [],
    };
    if (!capture.url) throw new Error(`${BURNDOWN_JSON} names no product URL: pass --url <where the build is served>`);
    if (!capture.paths.length)
      throw new Error(`${item.id}'s screen "${item.screen}" names no page to open as it stands: pass --path /the/page`);
    served = servedFacts(capture.url, e.builds.at(-1));
    if (served.contains === false) {
      throw new Error(
        `${served.repo} is at ${served.head}, which does not hold ${short(e.builds.at(-1).commit)}: ${capture.url} is not serving the build`,
      );
    }
    log(`capturing ${capture.paths.map((p) => pageUrl(p, capture.url)).join(", ")} at 390x844 and ${DESKTOP_VIEW}`);
    shots = await captureScreens({ root, run, ...capture, outDir, name: item.id });
  }
  if (captureOnly) return { item, entry: e, shots, served };
  const measured = capture ? measuredReadings(readJson(path.join(outDir, "facts.json"))) : [];
  const errors = [];
  const door = sitReview || ((list, o) => sitSittings({ root, run, outDir: o.outDir, label: "repair review", sittings: list }));
  const watched = async (list, o) => {
    mkdirSync(o.outDir, { recursive: true });
    await door(list, o);
    for (const s of list) {
      const a = readJson(path.join(o.outDir, `${s.id}.answers.json`));
      if (a?.error) errors.push(`${s.seat}: ${a.error}`);
    }
  };
  const others = othersOf(burn, state, item);
  const kept = e.held?.reason ?? null;
  const review = await reviewItem({ root, docketDir, itemId: item.id, after: shots, measured, others, kept, run, sitReview: watched, log, now });
  for (const ext of ["json", "md"]) copyFileSync(path.join(docketDir, `review-${item.id}.${ext}`), path.join(outDir, `review.${ext}`));
  // The capture and the sittings took minutes: builds another process recorded meanwhile are in the file now, so the
  // review is recorded into a fresh read of it and nothing else is written back.
  const fresh = withStatusLock(docketDir, () => {
    const state = reconcile(burn, readStatus(docketDir));
    if (capture) entry(state, item).capture = capture;
    recordReview(state, item, review, {
      at: new Date(now()).toISOString(),
      after: shots,
      file: path.join(outDir, "review.md"),
      ...(capture ? { url: capture.url, paths: capture.paths } : {}),
      ...(served ? { served } : {}),
      ...(errors.length ? { errors } : {}),
    });
    writeStatus(docketDir, state);
    return state;
  });
  return { item, entry: fresh.items[item.id], review };
}

/**
 * phone-render's facts.json as the experts' readings: each page's view's `measured` boxes, `stepEvals` and `evals`, named
 * by page, view (390x844 or the desktop size) and source. Pure; no facts (no capture) gives none.
 */
export function measuredReadings(facts) {
  const sizes = { phone: "390x844", desktop: DESKTOP_VIEW };
  const out = [];
  for (const page of facts?.pages || []) {
    for (const [id, row] of Object.entries(page.views || {})) {
      const view = sizes[id] ?? id;
      for (const e of row.evals || []) out.push({ page: page.url, view, source: `--eval-file ${e.file}`, result: e.result });
      for (const s of row.stepEvals || []) out.push({ page: page.url, view, source: `--step eval:${s.file}`, result: s.result });
      for (const [selector, boxes] of Object.entries(row.measured || {})) out.push({ page: page.url, view, source: `--measure ${selector}`, result: boxes });
    }
  }
  return out;
}

/** The board, as lines. */
export function followStatus({ docketDir }) {
  const burn = needBurndown(docketDir);
  return boardLines(burn, reconcile(burn, readStatus(docketDir)));
}

function needBurndown(docketDir) {
  const burn = readBurndownFile(docketDir);
  if (!burn)
    throw new Error(`no ${BURNDOWN_JSON} in ${docketDir}: the experts write it (bun dredd/diagnose-claims.mjs --docket <dir>)`);
  return burn;
}
