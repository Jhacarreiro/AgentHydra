/**
 * Recording tape for Lift inside a class: FutureThatWorks portal demo from local builds.
 * See tape.mjs usage; Checkouts: LIFT_DIR, FTW_PORTAL_DIR.
 * Each walk runs against its own demo state, isolated via prepareContext's sue_tape_walk cookie.
 */
import { createHash, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

const liftDir = () => process.env.LIFT_DIR || "D:/NEWProjects/active/Lift";
const portalDir = () => process.env.FTW_PORTAL_DIR || "D:/NEWProjects/active/FutureThatWorks/portal";
const load = (dir, file) => import(pathToFileURL(path.join(dir, file)).href);

const WALK_COOKIE_NAME = "sue_tape_walk";
const MAX_WALK_PAIRS = 64;
/** How a walk's saves reach the portal screens, in the stamp: change it with that behaviour, so screens recorded under the old one go stale. */
const PORTAL_STATE = "saves-reach-the-walks-pair";

/**
 * Stamp of a screen: sha256 over Lift's shared files (every site/student/*.js and *.css, every site/assets/*.css,
 * sorted) and, when the screen is a lesson (`#/play/<id>`, `#/play/<id>/class`, `#/play/<id>/skip`), that lesson's
 * pack: site/content/packs/<id>.json, or site/content/packs/es/<id>.json when the screen's page language is Spanish.
 * A screen outside /lift/student/ (the portal's class page, its home card) is the portal's own page, so it also hashes
 * every file under the portal's src/ (sorted by path, FTW_PORTAL_DIR read at call time) and PORTAL_STATE: a portal
 * change, or a change in whether a walk's saves reach the portal, makes those screens stale. Lift's screens keep the stamp they had.
 * A missing folder or pack is an error, never a skipped file: a stamp over less than the real files would call a
 * changed screen fresh. The checkout is read at call time so a spec can point LIFT_DIR at a copy.
 */
export function stampOf(screen) {
  const root = liftDir();
  const hash = createHash("sha256");
  const feed = (rel) => {
    hash.update(`${rel}|`);
    hash.update(readFileSync(path.join(root, rel)));
    hash.update("|");
  };
  for (const [folder, pattern] of [
    ["site/student", /\.(js|css)$/],
    ["site/assets", /\.css$/],
  ])
    for (const name of readdirSync(path.join(root, folder))
      .filter((f) => pattern.test(f))
      .sort())
      feed(`${folder}/${name}`);
  const lesson = /#\/play\/([^/?#]+)/.exec(screen.url ?? "")?.[1];
  if (lesson) feed(`site/content/packs/${String(screen.inventory?.lang ?? "").startsWith("es") ? "es/" : ""}${lesson}.json`);
  if (!new URL(screen.url ?? "", "http://x").pathname.startsWith("/lift/student/")) {
    hash.update(`${PORTAL_STATE}|`);
    const src = path.join(portalDir(), "src");
    for (const rel of filesUnder(src)) {
      hash.update(`portal/${rel}|`);
      hash.update(readFileSync(path.join(src, rel)));
      hash.update("|");
    }
  }
  return hash.digest("hex");
}

/** Every file under `dir`, as forward-slash paths relative to it, sorted. A missing `dir` is an error. */
function filesUnder(dir, prefix = "") {
  const found = [];
  for (const entry of readdirSync(path.join(dir, prefix), { withFileTypes: true }))
    if (entry.isDirectory()) found.push(...filesUnder(dir, `${prefix}${entry.name}/`));
    else if (entry.isFile()) found.push(`${prefix}${entry.name}`);
  return found.sort();
}

const SILENCE = (() => {
  const n = 1600;
  const b = Buffer.alloc(44 + n * 2);
  b.write("RIFF", 0);
  b.writeUInt32LE(36 + n * 2, 4);
  b.write("WAVEfmt ", 8);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20);
  b.writeUInt16LE(1, 22);
  b.writeUInt32LE(8000, 24);
  b.writeUInt32LE(16000, 28);
  b.writeUInt16LE(2, 32);
  b.writeUInt16LE(16, 34);
  b.write("data", 36);
  b.writeUInt32LE(n * 2, 40);
  return b;
})();

let lessonOne = null;

export async function start() {
  const { serveSite } = await load(liftDir(), "tools/serve-site.mjs");
  const lift = await serveSite(liftDir(), "");
  try {
    return await startPortal(lift);
  } catch (err) {
    lift.close(); // the portal never came up: the Lift server it would have fronted is closed with it
    throw err;
  }
}

/** The portal in front of Lift's own server, on a port of its own; the tape's ids never carry that port. */
async function startPortal(lift) {
  const { default: worker } = await load(portalDir(), "src/index.js");
  const { makeD1 } = await load(portalDir(), "test/d1-shim.mjs");
  const { ensureDemo } = await load(portalDir(), "src/routes/access.js");
  const { LESSONS } = await load(portalDir(), "src/lessons/index.js");
  lessonOne = LESSONS[0].id;

  // Each walk gets its own {db, demo} pair, seeded by the portal's own ensureDemo (fixed dice seed) under a clock frozen
  // at one instant for the whole recorder, so every pair starts byte-identical. Seeds run one at a time: the frozen
  // clock is process-wide. A Map keeps insertion order: delete + set marks a pair most recent, the oldest is dropped.
  const walkPairs = new Map(); // walkId -> Promise<{ db, demo }>
  const seedBase = Date.now();
  let seeding = Promise.resolve();
  const freshPair = (liftBase) => {
    const made = seeding.then(async () => {
      const pair = { db: makeD1(), demo: makeD1() };
      const realNow = Date.now;
      Date.now = () => seedBase;
      try {
        await ensureDemo({ LIFT_ORIGIN: liftBase, DB: pair.demo, DEMO: "1" });
      } finally {
        Date.now = realNow;
      }
      return pair;
    });
    seeding = made.catch(() => {});
    return made;
  };
  const pairFor = (walkId) => {
    const pair = walkPairs.get(walkId) ?? freshPair(lift.base);
    walkPairs.delete(walkId);
    walkPairs.set(walkId, pair);
    if (walkPairs.size > MAX_WALK_PAIRS) walkPairs.delete(walkPairs.keys().next().value);
    return pair;
  };

  const server = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const origin = `http://127.0.0.1:${server.address().port}`;

      // a request without the walk cookie uses the shared default pair
      const walkId = /(?:^|;\s*)sue_tape_walk=([^;]+)/.exec(req.headers.cookie ?? "")?.[1] ?? "default";
      const { db, demo } = await pairFor(walkId);
      const env = {
        LIFT_ORIGIN: lift.base,
        DB: db,
        DEMO_DB: demo,
        DEMO_HOST: "127.0.0.1",
        SESSION_SECRET: "local-tape-only",
        PUBLIC_ORIGIN: origin,
      };
      const request = new Request(`${origin}${req.url}`, {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) => [].concat(v).map((x) => [k, x])),
        body: !["GET", "HEAD"].includes(req.method) && chunks.length ? Buffer.concat(chunks) : undefined,
      });
      const response = await worker.fetch(request, env, { waitUntil() {} });
      const headers = [];
      response.headers.forEach((v, k) => {
        if (k !== "set-cookie") headers.push([k, v]);
      });
      for (const c of response.headers.getSetCookie()) headers.push(["set-cookie", c]);
      res.writeHead(response.status, headers.flat());
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`tape portal error: ${err.message}`);
    }
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/demo/as/student?n=2`,
    async stop() {
      await new Promise((ok) => server.close(ok));
      lift.close();
    },
  };
}

/** The class page and lesson 1; the student's own path, other lessons and other pages are kept but not explored. */
export function scope(url) {
  const u = new URL(url);
  if (u.pathname === "/s") return true;
  // the portal names a lesson `ai.what-is-ai`; Lift plays it at the class's band as `ai-what-is-ai-c`
  return u.pathname.startsWith("/lift/student/") && u.hash.startsWith(`#/play/${lessonOne.replace(/\./g, "-")}-`);
}

// Each walk gets a unique cookie so the portal isolates it to its own demo database pair.
export async function prepareContext(context) {
  const walkId = randomUUID();
  await context.addCookies([
    { name: WALK_COOKIE_NAME, value: walkId, domain: "127.0.0.1", path: "/", sameSite: "Lax", secure: false, httpOnly: false },
  ]);
}

// The class round's student reads in English on the default theme: the language and theme switches would record
// every screen again in each combination, so they are not tapped.
export const skip = (control) => /^(link:(Español|English)@|button:(Light or dark|Claro u oscuro))/.test(control.key);

// lesson 1 is five or six questions, each an answer and a Next, then its finish: deeper than the default 8
export const maxDepth = 16;

// /s/lift/state is not stubbed: Lift's save reaches the portal, which keeps it in this walk's own demo pair (the cookie), so
// the class page a Finish lands on shows the lesson's XP. A stub that swallowed the save (from before each walk had its own
// pair) left that page on the old XP, level and lessons-done count.
export const routes = [{ url: "**/api/say", fulfill: { status: 200, contentType: "audio/wav", body: SILENCE } }];

// a seeded Math.random, so a lesson that shuffles its choices shuffles them the same way on every walk
export const initScript = () => {
  let s = 20261003;
  Math.random = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
};

export const timezoneId = "America/Chicago";
