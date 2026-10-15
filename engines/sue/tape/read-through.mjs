/**
 * tape/read-through.mjs - the tape as a read-through cache (Lift/docs/TAPE-PANEL.md section 1, 2026-10-03): a move the
 * tape has no answer for (no recorded edge, or a screen whose stamp changed) is played LIVE in a headless browser at the
 * Sue's tape device, and the screen it reaches and the edge to it are saved into the tape exactly as tape/record.mjs
 * writes them (stamp included), so the next Sue making the same move from the same screen is answered from the tape
 * with no browser.
 *
 * WHO CALLS IT: tape/recorder.mjs, the one process that owns a tape's browsers and is the only writer of its screens,
 * edges.json and manifest.json (the Sues' tape bodies ask it through tape/ask.mjs). It is a plain function of a tape
 * folder here, so the recorder is only the socket and the lock around it.
 *
 * HOW A MOVE IS PLAYED: the live page is put on her screen by replaying her screen's path from the start it began on (the
 * steps the tape already holds, `pathKeyOf` names the start and them), never by opening a URL; each replayed step is bound
 * to the control of the live screen that has the same key. The one URL ever opened is a start: a Sue whose own start the
 * tape does not have yet (`request.start`, relative to the tape's origin) is put on it, and that screen is saved as that start. A screen that cannot be reached exactly (a step finds no control,
 * a step fails, or the screen reached is not the one she is on) is answered `unreachable`, never a guessed screen.
 *
 * FEW BROWSERS, ONE WRITER: plays are queued per device (one browser per device, launched on its first play), and the
 * answer is looked up again, fresh from disk, when a play's turn comes, so two Sues missing on the same move leave one
 * screen, one edge and one browser launch. The tape is written in one synchronous block (screens first, then
 * edges.json, then manifest.json, each through a temp file and a rename).
 *
 * A TAP THAT FAILS live (nothing would take the click) is saved as an error edge, as record.mjs writes one, so every
 * later Sue is answered from it; a failed replay of her path (`unreachable`) is never saved. A play that does not
 * finish in `deadlineMs` (SUE_TAPE_PLAY_DEADLINE_MS) is answered `timeout`, and its browser is closed.
 *
 * A STALE SCREEN re-recorded replaces the old one, and the old and new pictures are compared (tape/changed.mjs) into
 * `changes.jsonl`, so a screen that moved and should not have is seen.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { writeAtomic } from "./atomic.mjs";
import { pictureDiff } from "./changed.mjs";
import { logEvent } from "./lock.mjs";
import { pickEdge } from "./pick-edge.mjs";
import { loadConfig, loadTape, originOf, saveScreen, screenIdOf, screenRecord, walk } from "./record.mjs";

export const changesPath = (tapeDir) => path.join(tapeDir, "changes.jsonl");
const DEFAULT_MAX_SCREENS = 200;
/** A play is a whole replay of her path plus a tap; the asking Sue gives up at ask.mjs's own, longer, timeout. */
/** How long closing waits for a browser or site that is still coming up. */
const CLOSE_WAIT_MS = 5_000;
const DEFAULT_PLAY_DEADLINE_MS = Number(process.env.SUE_TAPE_PLAY_DEADLINE_MS) || 120_000;

const firstLine = (err) => String(err?.message ?? err).split("\n")[0];
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const jsonOf = (value) => `${JSON.stringify(value, null, 1)}\n`;

/** The typed boxes of an edge as record.mjs writes them: `{ key, value }` or `{ key, check }`. */
const edgeTypedOf = (move) =>
  move.typed ? move.typed.map(({ key, value, check }) => ({ key, ...(check ? { check } : { value }) })) : undefined;
/** Every start screen of the manifest, over all devices and start URLs. */
const startIdsOf = (manifest) => Object.values(manifest.starts ?? {}).flatMap((byUrl) => Object.values(byUrl));
const typedName = (typed) => JSON.stringify((typed ?? []).map((t) => [t.key, t.check ? true : t.value]));

/**
 * The move a Sue's tap is, on the live screen's own controls: the control, and what she typed into the form's boxes
 * and ticked before it (boxes the live screen no longer has are left out, as a form that lost a box has no box to fill).
 */
function moveFor(control, controls, { fills = [], checks = [] }) {
  const own = control.kind === "choose" ? control.key.slice(0, -`=${control.option}`.length) : control.key;
  const typed = [];
  for (const [key, value] of fills) {
    if (key === own || key === control.key) continue;
    const box = controls.find((c) => c.key === key && c.kind === "field");
    if (box) typed.push({ key, sueId: box.sueId, role: box.role === "select" ? "select" : box.role, value: String(value) });
  }
  for (const key of checks) {
    if (key === control.key) continue;
    const box = controls.find((c) => c.key === key && c.role === "checkbox");
    if (box) typed.push({ key, sueId: box.sueId, role: "checkbox", check: true });
  }
  return {
    key: control.key,
    sueId: control.sueId,
    kind: control.kind,
    role: control.role,
    ...(control.option != null ? { option: control.option } : {}),
    ...(typed.length ? { typed } : {}),
  };
}

/** Where the Chromium is: `SUE_TAPE_CHROMIUM` (a file that must exist) or the one the repo's launcher finds. */
function chromiumPath() {
  const named = process.env.SUE_TAPE_CHROMIUM;
  if (named) {
    if (!existsSync(named)) throw new Error(`SUE_TAPE_CHROMIUM names no file: ${named}`);
    return named;
  }
  const found = resolveChromiumPath();
  if (!found) throw new Error("no Chromium on this machine (browser-launch.mjs resolved null)");
  return found;
}

/** A read-through over the tape folder `tapeDir`: `play(request)` and `close()`. */
export function createReadThrough({ tapeDir, log = () => {}, deadlineMs = DEFAULT_PLAY_DEADLINE_MS }) {
  let configPromise = null;
  let sitePromise = null;
  const browsers = new Map(); // device -> Promise<Browser>
  const failures = new Map(); // device -> why its browser could not start
  const queues = new Map(); // device -> the play that last queued
  const running = new Set(); // the plays that have not answered: `{ expire }` each

  const configOf = () => (configPromise ??= loadConfig(loadTape(tapeDir).manifest.config?.file ?? null).then((r) => r.config));

  /** The site the tape was recorded from, as it runs now: the config's own server when it has one. */
  const siteOf = () =>
    (sitePromise ??= (async () => {
      const config = await configOf();
      const server = typeof config.start === "function" ? await config.start() : null;
      const startUrl = server?.url ?? config.startUrl ?? loadTape(tapeDir).manifest.startUrl;
      if (!startUrl) throw new Error("no start URL: the manifest has none and the config gives none");
      return { server, startUrl, origin: originOf(startUrl), allowedHosts: config.allowedHosts ?? [new URL(startUrl).hostname] };
    })().catch((err) => {
      sitePromise = null;
      throw err;
    }));

  /** The device's browser, launched on first need; null (and why, in `failures`) when it cannot start. */
  async function browserFor(device) {
    if (failures.has(device)) return null;
    if (!browsers.has(device)) {
      browsers.set(
        device,
        (async () => {
          const executablePath = chromiumPath();
          logEvent(tapeDir, "browser-launch", { device });
          const browser = await chromium.launch({ headless: true, executablePath, args: browserArgsFor("headless") });
          browser.on("disconnected", () => {
            if (browsers.get(device) === launched) browsers.delete(device); // the next play launches another
          });
          return browser;
        })(),
      );
    }
    const launched = browsers.get(device);
    try {
      return await launched;
    } catch (err) {
      browsers.delete(device);
      failures.set(device, firstLine(err));
      logEvent(tapeDir, "browser-failed", { device, detail: firstLine(err) });
      return null;
    }
  }

  /** The device's browser closed, so a walk in it ends; the next play launches another. */
  function closeBrowser(device) {
    const launched = browsers.get(device);
    browsers.delete(device);
    launched?.then((b) => b.close()).catch(() => {});
  }

  const isFresh = (config, screen) => !screen.stamp || typeof config.stampOf !== "function" || config.stampOf(screen) === screen.stamp;
  const screenFile = (id, ext = "json") => path.join(tapeDir, "screens", `${id}.${ext}`);

  /** The screen the Sue is on: by id, else by the walk that named it (an id a re-record has replaced). */
  function resolveFrom(tape, request) {
    if (request.from && existsSync(screenFile(request.from))) return tape.screen(request.from);
    const byPath = Object.entries(tape.manifest.screens ?? {}).find(([, s]) => s.pathKey === request.fromPath);
    return byPath && existsSync(screenFile(byPath[0])) ? tape.screen(byPath[0]) : null;
  }

  /** The old picture of a screen against the new one, kept as a file beside the tape's screens. `was` names the old one. */
  async function compare(oldId, newId, shot) {
    const was = { was: oldId };
    try {
      const diff = await pictureDiff(screenFile(oldId, "png"), shot);
      const file = `changes/${newId}-${Date.now()}.png`;
      mkdirSync(path.join(tapeDir, "changes"), { recursive: true });
      writeAtomic(path.join(tapeDir, file), diff.png);
      return { ...was, changedPixels: diff.changedPixels, fraction: diff.fraction, sameSize: diff.sameSize, picture: file };
    } catch (err) {
      return { ...was, unavailable: true, detail: firstLine(err) };
    }
  }

  /**
   * Save what the live walk found, in ONE synchronous block over what is on disk now (another device's play may have
   * written since this one began): the re-recorded `from` (stale only), the target screen, the edge, the manifest.
   */
  function commit({ request, device, config, site, from, fromCapture, move, result, diffs }) {
    const manifestFile = path.join(tapeDir, "manifest.json");
    const edgesFile = path.join(tapeDir, "edges.json");
    const manifest = readJson(manifestFile);
    let edges = readJson(edgesFile);
    const limit = manifest.limits?.maxScreens ?? DEFAULT_MAX_SCREENS;
    const known = () => manifest.screens ?? (manifest.screens = {});
    const entryOf = (rec) => ({ device, url: rec.url, depth: rec.depth, pathKey: rec.pathKey, settle: rec.settle });
    const rows = [];
    const doomed = new Set(); // screens whose files go, after the new ones are in place

    let fromId = from.id;
    if (fromCapture) {
      const rec = screenRecord(fromCapture, {
        device,
        start: from.start,
        steps: from.steps,
        parent: from.parent,
        allowedHosts: site.allowedHosts,
        origin: site.origin,
      });
      if (rec.id === from.id || !existsSync(screenFile(rec.id))) saveScreen(tapeDir, rec, fromCapture.shot, config);
      if (rec.id !== from.id) {
        edges = edges.filter((e) => e.from !== from.id).map((e) => (e.to === from.id ? { ...e, to: rec.id } : e));
        delete known()[from.id];
        for (const byUrl of Object.values(manifest.starts ?? {}))
          for (const [url, id] of Object.entries(byUrl)) if (id === from.id) byUrl[url] = rec.id;
        doomed.add(from.id);
        fromId = rec.id;
      }
      known()[rec.id] = entryOf(rec);
      rows.push({ screen: rec.id, diff: diffs.from });
    }

    const typed = edgeTypedOf(move);
    const sameMove = (e) => e.device === device && e.from === fromId && e.control === move.key && typedName(e.typed) === typedName(typed);
    const oldEdge = edges.find(sameMove);
    let to = null;
    let dropped = false;
    if (!result.tap) {
      const rec = screenRecord(result, {
        device,
        start: from.start,
        steps: [...from.steps, move],
        parent: fromId,
        allowedHosts: site.allowedHosts,
        origin: site.origin,
      });
      const here = existsSync(screenFile(rec.id));
      to = rec.id;
      if (here && isFresh(config, readJson(screenFile(rec.id)))) {
        // another walk already recorded this screen, and it is as the files make it now: keep it as it is
      } else if (!here && Object.values(known()).filter((s) => s.device === device).length >= limit) {
        to = null;
        dropped = true;
      } else {
        saveScreen(tapeDir, rec, result.shot, config);
        known()[rec.id] = entryOf(rec);
        if (diffs.target) rows.push({ screen: rec.id, diff: diffs.target });
      }
    }
    const edge = {
      device,
      from: fromId,
      move: move.key,
      control: move.key,
      ...(typed ? { typed } : {}),
      to,
      ...(dropped ? { dropped: "max-screens" } : {}),
      ...(result.tap ? { error: result.error } : {}),
    };
    if (oldEdge) edges = edges.map((e) => (e === oldEdge ? edge : e));
    else edges.push(edge);
    if (oldEdge?.to && oldEdge.to !== to) {
      const stale = existsSync(screenFile(oldEdge.to)) && !isFresh(config, readJson(screenFile(oldEdge.to)));
      const kept = edges.some((e) => e.to === oldEdge.to) || startIdsOf(manifest).includes(oldEdge.to);
      if (stale && !kept) {
        delete known()[oldEdge.to];
        edges = edges.filter((e) => e.from !== oldEdge.to);
        doomed.add(oldEdge.to);
      }
    }

    const all = Object.values(known());
    manifest.stats = { ...manifest.stats, screens: all.length, edges: edges.length, followedEdges: edges.filter((e) => e.to).length };
    writeAtomic(edgesFile, jsonOf(edges));
    writeAtomic(manifestFile, jsonOf(manifest));
    for (const id of doomed) for (const ext of ["json", "png"]) rmSync(screenFile(id, ext), { force: true });
    for (const row of rows)
      appendFileSync(
        changesPath(tapeDir),
        `${JSON.stringify({ at: new Date().toISOString(), screen: row.screen, round: request.round ?? null, sueId: request.sueId ?? null, diff: row.diff })}\n`,
      );
    return { from: fromId, to, dropped, error: result.tap ? result.error : undefined };
  }

  /** The walk's start URL for a start key (a path relative to the tape's origin), on the origin the site runs at now. */
  const startUrlOf = (site, start) => new URL(start, site.origin).href;

  /**
   * A Sue's own start the tape does not have: the one place a URL is opened. The start URL is opened on the site's
   * origin and the screen it shows is saved as that start (`manifest.starts[device][start]`).
   */
  async function runStart(request, ctl) {
    const device = request.device;
    const start = request.start;
    const tape = loadTape(tapeDir);
    const config = await configOf();
    const known = tape.manifest.starts?.[device]?.[start];
    if (known && existsSync(screenFile(known)) && isFresh(config, tape.screen(known))) return { ok: true, recorded: false, screen: known };

    let site;
    try {
      site = await siteOf();
    } catch (err) {
      return { ok: false, reason: "no-site", detail: firstLine(err) };
    }
    const browser = await browserFor(device);
    if (!browser) return { ok: false, reason: "no-browser", detail: failures.get(device) };
    const result = await walk(browser, device, startUrlOf(site, start), [], config, {
      resolve: { allowedHosts: site.allowedHosts, origin: site.origin },
    }).catch((err) => ({ error: firstLine(err), crashed: true }));
    if (result.error) {
      if (!browser.isConnected()) return { ok: false, reason: "no-browser", detail: "the browser went away mid-walk" };
      return { ok: false, reason: "start-failed", detail: result.error };
    }
    if (ctl.expired) return { ok: false, reason: "timeout" };

    const manifestFile = path.join(tapeDir, "manifest.json");
    const manifest = readJson(manifestFile);
    const rec = screenRecord(result, { device, start, steps: [], parent: null, allowedHosts: site.allowedHosts, origin: site.origin });
    const here = existsSync(screenFile(rec.id));
    const screens = manifest.screens ?? (manifest.screens = {});
    if (!here || !isFresh(config, readJson(screenFile(rec.id)))) {
      const limit = manifest.limits?.maxScreens ?? DEFAULT_MAX_SCREENS;
      if (!here && Object.values(screens).filter((s) => s.device === device).length >= limit)
        return { ok: false, reason: "tape-full", detail: "the tape is full for this device" };
      saveScreen(tapeDir, rec, result.shot, config);
      screens[rec.id] = { device, url: rec.url, depth: rec.depth, pathKey: rec.pathKey, settle: rec.settle };
    }
    const byUrl = (manifest.starts ??= {})[device] ?? (manifest.starts[device] = {});
    byUrl[start] = rec.id;
    manifest.stats = { ...manifest.stats, screens: Object.keys(screens).length };
    writeAtomic(manifestFile, jsonOf(manifest));
    logEvent(tapeDir, "start", { device, start, screen: rec.id, sueId: request.sueId ?? null });
    return { ok: true, recorded: true, screen: rec.id };
  }

  /** One play, when its device's turn comes. */
  async function run(request, ctl) {
    if (request.start != null) return runStart(request, ctl);
    const device = request.device;
    const tape = loadTape(tapeDir);
    const config = await configOf();
    const from = resolveFrom(tape, request);
    if (!from) return { ok: false, reason: "unreachable", detail: "her screen is not on the tape" };
    if (typeof from.start !== "string") return { ok: false, reason: "unreachable", detail: "her screen names no start" };

    const fromFresh = isFresh(config, from);
    if (fromFresh) {
      // Answered by what is on the tape now: another Sue's play of this very move already recorded it.
      const picked = pickEdge(tape.edges, {
        device,
        from: from.id,
        control: request.control,
        fills: new Map(request.fills ?? []),
        checks: new Set(request.checks ?? []),
      });
      const to = picked.edge?.to;
      if (to && existsSync(screenFile(to)) && isFresh(config, tape.screen(to))) return { ok: true, recorded: false, from: from.id, to };
      if (picked.edge && picked.edge.to === null && picked.edge.error) return { ok: true, recorded: false, from: from.id, to: null };
    }

    let site;
    try {
      site = await siteOf();
    } catch (err) {
      return { ok: false, reason: "no-site", detail: firstLine(err) };
    }
    const browser = await browserFor(device);
    if (!browser) return { ok: false, reason: "no-browser", detail: failures.get(device) };

    let fromCapture = null;
    let move = null;
    const plan = async ({ inventory, controls, capture }) => {
      const reached = screenIdOf(inventory, site.origin);
      if (fromFresh && reached !== from.id)
        return { error: `the screen reached by her path is not the one she is on (${reached}, not ${from.id})`, unreachable: true };
      if (!fromFresh) fromCapture = await capture();
      const control = controls.find((c) => c.key === request.control && (c.kind === "tap" || c.kind === "choose"));
      if (!control) return { error: `her screen has no control "${request.control}" now`, unreachable: true };
      move = moveFor(control, controls, request);
      return { move };
    };
    const result = await walk(browser, device, startUrlOf(site, from.start), from.steps, config, {
      resolve: { allowedHosts: site.allowedHosts, origin: site.origin },
      next: plan,
    }).catch((err) => ({ error: firstLine(err), crashed: true }));
    if (result.error && !browser.isConnected()) return { ok: false, reason: "no-browser", detail: "the browser went away mid-walk" };
    // A tap that fails is an answer (the control would not take the click) and is saved; a path that could not be replayed is not.
    if (result.error && !(result.tap && move)) return { ok: false, reason: "unreachable", detail: result.error };
    if (ctl.expired) return { ok: false, reason: "timeout" };

    // The pictures are compared before the tape is written, so the write itself is one synchronous block.
    const diffs = {};
    if (fromCapture) {
      const newFrom = screenRecord(fromCapture, {
        device,
        start: from.start,
        steps: from.steps,
        parent: from.parent,
        allowedHosts: site.allowedHosts,
        origin: site.origin,
      });
      diffs.from = await compare(from.id, newFrom.id, fromCapture.shot);
    }
    if (!result.tap) {
      const fresh = loadTape(tapeDir);
      const typed = edgeTypedOf(move);
      const oldEdge = fresh.edges.find(
        (e) => e.device === device && e.from === from.id && e.control === move.key && typedName(e.typed) === typedName(typed),
      );
      const newTarget = screenRecord(result, {
        device,
        start: from.start,
        steps: [...from.steps, move],
        parent: from.id,
        allowedHosts: site.allowedHosts,
        origin: site.origin,
      });
      const replaced = [oldEdge?.to, newTarget.id].find((id) => id && existsSync(screenFile(id)) && !isFresh(config, fresh.screen(id)));
      if (replaced) diffs.target = await compare(replaced, newTarget.id, result.shot);
    }
    if (ctl.expired) return { ok: false, reason: "timeout" };

    const saved = commit({ request, device, config, site, from, fromCapture, move, result, diffs });
    logEvent(tapeDir, "play", {
      device,
      from: saved.from,
      to: saved.to,
      control: request.control,
      sueId: request.sueId ?? null,
      ...(saved.error ? { error: saved.error } : {}),
    });
    if (saved.dropped) return { ok: false, reason: "tape-full", detail: "the tape is full for this device" };
    return { ok: true, recorded: true, from: saved.from, to: saved.to, ...(saved.error ? { error: saved.error } : {}) };
  }

  /**
   * Play a missed move live and save it (queued behind the plays already waiting for the same device). A play that has
   * not answered by its deadline is answered `timeout` and its device's browser is closed, so the walk in it ends and a
   * hung page never keeps the recorder alive.
   */
  function play(request) {
    const device = request?.device;
    const turn = (queues.get(device) ?? Promise.resolve()).then(() => {
      const ctl = { expired: false };
      let timer;
      let expire;
      const expiry = new Promise((resolve) => {
        expire = () => {
          if (ctl.expired) return;
          ctl.expired = true;
          log(`play past its deadline (${deadlineMs} ms): closing the ${device} browser`);
          closeBrowser(device);
          resolve({ ok: false, reason: "timeout", detail: `the play did not finish in ${deadlineMs} ms` });
        };
        timer = setTimeout(expire, deadlineMs);
      });
      const entry = { expire };
      running.add(entry);
      const answered = run(request, ctl).catch((err) => {
        log("play failed:", err?.stack ?? err);
        return { ok: false, reason: "recorder-error", detail: firstLine(err) };
      });
      return Promise.race([answered, expiry]).finally(() => {
        clearTimeout(timer);
        running.delete(entry);
      });
    });
    queues.set(device, turn);
    return turn;
  }

  async function close() {
    for (const entry of [...running]) entry.expire(); // a play still waiting is answered now, not waited on
    await Promise.allSettled([...queues.values()]);
    // A browser or site that never came up is not waited on: the recorder has to be able to leave.
    const within = (promise) => Promise.race([promise.catch(() => {}), new Promise((resolve) => setTimeout(resolve, CLOSE_WAIT_MS))]);
    await within(Promise.allSettled([...browsers.values()].map((p) => p.then((b) => b.close()))));
    browsers.clear();
    if (sitePromise) await within(sitePromise.then((site) => site.server?.stop?.()));
    sitePromise = null;
  }

  return { play, close };
}
