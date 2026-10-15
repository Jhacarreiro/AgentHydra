/**
 * tape/record.mjs - the RECORDER: walks a site headless at each device size, breadth first, tapping every
 * control on every screen (every answer choice, the wrong ones too), and keeps each settled screen once: its
 * screenshot, its inventory exactly as INVENTORY_SCRIPT returned it, its controls, and where each tap led. The
 * on-disk shape is tape/FORMAT.md; the student panel reads only that.
 *
 * WHEN IT RUNS: a tape is recorded as students reach it, never crawled up front (Lift/docs/TAPE-PANEL.md section 1,
 * 2026-10-03). `recordTape` is the bounded crawl the selftest and an explicit `tape.mjs record` run; `saveScreen`
 * is the one way a screen is written, for that crawl and for recording a screen on a miss.
 *
 * HOW A SCREEN IS REACHED: every child is recorded in a fresh context that replays its steps from the start, never
 * by opening its URL (in-memory and localStorage state, a quiz's score, exist only on the walk), so no screen
 * inherits state from a sibling's walk. Each walk reads the inventory on every screen it passes, as a live Sue's
 * look does, so the stamps the inventory leaves on the page (`data-sue-id`) are the ones she would leave.
 *
 * WHERE IT RAN DOES NOT NAME IT: screen ids and control keys read every URL on the start's origin relative to it,
 * so a local server that got another port records the same ids and keys.
 *
 * DEPENDS ON: tape/device.mjs (context, settle, capture, act), lib/perception.mjs (`selectChoices`), the browser
 * launch body.mjs uses. Called by sue/tape.mjs and tape/selftest.mjs.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../../lib/shared/browser-launch.mjs";
import { browserArgsFor } from "../lib/findings.mjs";
import { selectChoices } from "../lib/perception.mjs";
import { writeAtomic } from "./atomic.mjs";
import {
  act,
  arrive,
  deviceFacts,
  deviceSpec,
  inventoryOf,
  openDevicePage,
  releaseClock,
  settle,
  screenshotOf,
  SETTLE_BUDGET_MS,
} from "./device.mjs";

export const TAPE_FORMAT = "sue-tape/1";
const DEFAULT_MAX_SCREENS = 200;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_CONCURRENCY = 4;

// --- the screen's name -------------------------------------------------------------------------------------

/** JSON with its keys sorted, so the same inventory always hashes the same. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/** `http://127.0.0.1:5173` of a start URL: what every URL on a tape is read relative to. */
export const originOf = (startUrl) => new URL(startUrl).origin;

/** Every occurrence of `origin` in a string, where no more port digits follow it. */
const originPattern = (origin) => new RegExp(`${origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`, "g");

/** A start URL as a tape keys it: its path, query and hash relative to its own origin (`/demo/as/student?n=7`), whatever host and port served it. */
export const startKeyOf = (url, origin = originOf(url)) => relativeUrl(new URL(url).href, origin);

/** A URL on the start's origin as its path (`/s?n=2#/play/1`); any other URL as it is. */
export function relativeUrl(url, origin) {
  const s = String(url);
  if (!origin || !s.startsWith(origin)) return s;
  const rest = s.slice(origin.length);
  if (rest === "") return "/";
  return /^[/?#]/.test(rest) ? rest : s;
}

/** A URL on origin `from` as the same path, query and hash on origin `to`; any other URL as it is. */
export function reOrigin(url, from, to) {
  const s = String(url);
  const rel = relativeUrl(s, from);
  return !to || rel === s ? s : `${to}${rel}`;
}

/**
 * The inventory as it names a screen: every `id` key dropped (the stamps depend on the walk that reached a screen,
 * never on what the screen is) and the start's origin cut from every string (the port a local server got).
 */
function nameOf(value, pattern) {
  if (Array.isArray(value)) return value.map((v) => nameOf(v, pattern));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .filter(([k]) => k !== "id")
        .map(([k, v]) => [k, nameOf(v, pattern)]),
    );
  return typeof value === "string" && pattern ? value.replace(pattern, "") : value;
}

/** A screen's id: the first 16 hex of the sha256 of its inventory, stamps left out, URLs relative to `origin`. */
export function screenIdOf(inventory, origin = null) {
  return createHash("sha256")
    .update(canonicalJson(nameOf(inventory, origin ? originPattern(origin) : null)))
    .digest("hex")
    .slice(0, 16);
}

// --- what can be done on a screen -----------------------------------------------------------------------------

const FIELD_ROLES = new Set(["input", "textarea"]);

function absolute(href, base) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * The page facts the inventory does not carry: which form each control belongs to, and which boxes must be
 * filled (`required`). Keyed by `data-sue-id`.
 */
export async function formsOf(page) {
  return page
    .evaluate(() => {
      const forms = [...document.forms];
      const out = {};
      for (const el of document.querySelectorAll("[data-sue-id]")) {
        const form = el.form ?? el.closest?.("form") ?? null;
        out[el.getAttribute("data-sue-id")] = { form: form ? forms.indexOf(form) : -1, required: Boolean(el.required) };
      }
      return out;
    })
    .catch(() => ({}));
}

/**
 * Every control of a screen, each with a `key` that names it the same way on any tape (role, words, link relative
 * to `origin`, and how many like it came before), and a `kind`: `tap`, `choose` (one entry per choice of a list),
 * `field` (a box that is typed into, never tapped), `offsite` (a link off the allowed hosts, never followed),
 * `leaves` (mailto:, tel:), or `disabled`.
 */
export function controlsOf(inventory, forms, allowedHosts, origin = null) {
  const seen = new Map();
  const controls = [];
  for (const el of inventory.elements ?? []) {
    if (el.hidden || el.behindOverlay || el.covered) continue;
    const href = el.href ? absolute(el.href, inventory.url) : null;
    const base = `${el.role}:${String(el.name ?? "").slice(0, 120)}${href ? `@${relativeUrl(href, origin)}` : ""}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const common = {
      key: n > 1 ? `${base}#${n}` : base,
      sueId: el.id,
      role: el.role,
      name: el.name ?? "",
      ...(href ? { href } : {}),
      rect: el.rect ?? null,
      form: forms[el.id]?.form ?? -1,
      required: Boolean(forms[el.id]?.required),
    };
    if (el.disabled) controls.push({ ...common, kind: "disabled" });
    else if (FIELD_ROLES.has(el.role)) controls.push({ ...common, kind: "field", inputType: el.inputType ?? null });
    else if (el.role === "select") {
      controls.push({ ...common, kind: "field", inputType: "select" });
      for (const option of selectChoices(el)) controls.push({ ...common, key: `${common.key}=${option}`, kind: "choose", option });
    } else if (href && !/^https?:/i.test(href) && !/^javascript:/i.test(href)) controls.push({ ...common, kind: "leaves" });
    else if (href && /^https?:/i.test(href) && !allowedHosts.includes(new URL(href).hostname))
      controls.push({ ...common, kind: "offsite" });
    else controls.push({ ...common, kind: "tap" });
  }
  return controls;
}

/** A value each picker box takes as it is (Playwright sets these, and refuses one not in its type's own form). */
const PICKER_VALUES = {
  date: "1990-01-01",
  time: "09:30",
  "datetime-local": "1990-01-01T09:30",
  month: "1990-01",
  week: "1990-W01",
  range: "50",
  color: "#336699",
};
/** Boxes no move types into: a list is chosen from (`choose`), a file is attached, the rest are tapped or unseen. */
const UNTYPED = new Set(["select", "file", "checkbox", "radio", "hidden", "submit", "button", "reset", "image"]);

/**
 * What a box is given when the config says nothing: a value its type takes, and only for a free-text box one its
 * words ask for. The type is read first, so a list named "Country code" or a time box named "Start time" never
 * gets words.
 */
export function defaultTyped(field) {
  const type = String(field.inputType ?? "text").toLowerCase();
  if (UNTYPED.has(type)) return null;
  if (PICKER_VALUES[type]) return PICKER_VALUES[type];
  if (type === "email") return "tape@sue.test";
  if (type === "tel") return "+12065550100";
  if (type === "number") return "7";
  if (type === "password") return "Tape-password-1";
  if (type === "url") return "https://example.com";
  const words = `${field.name ?? ""}`.toLowerCase();
  if (/e-?mail/.test(words)) return "tape@sue.test";
  if (/phone/.test(words)) return "+12065550100";
  if (/birth|yyyy/.test(words)) return "1990-01-01";
  if (/code/.test(words)) return "000000";
  if (/name/.test(words)) return "Sam";
  return "hello";
}

/**
 * The moves out of a screen: one per tap control, per choice, and per typed variant. A tap on a control in a
 * form first fills that form's boxes (and ticks its required boxes); a button outside any form fills the boxes
 * outside any form. `config.typed({ field, screen, device })` gives a box's value: a string, an array of strings
 * (one move per value, e.g. a right and a wrong answer), or null to leave it empty.
 */
async function movesOf(screen, config) {
  const fields = screen.controls.filter((c) => c.kind === "field");
  const moves = [];
  for (const control of screen.controls) {
    if (control.kind !== "tap" && control.kind !== "choose") continue;
    if (config.skip?.(control, screen)) continue;
    const mine = fields.filter(
      (f) => f !== control && (control.form >= 0 ? f.form === control.form : f.form < 0 && control.role === "button"),
    );
    const ticks = screen.controls.filter(
      (c) => c.kind === "tap" && c.role === "checkbox" && c.required && c !== control && control.form >= 0 && c.form === control.form,
    );
    const values = [];
    for (const field of mine) {
      const given = config.typed ? await config.typed({ field, screen, device: screen.device }) : undefined;
      const value = given === undefined ? defaultTyped(field) : given;
      if (value == null || (Array.isArray(value) && !value.length)) continue;
      values.push({ field, options: Array.isArray(value) ? value.map(String) : [String(value)] });
    }
    const variants = Math.max(1, ...values.map((v) => v.options.length));
    for (let variant = 0; variant < variants; variant++) {
      const typed = [
        ...values.map(({ field, options }) => ({
          key: field.key,
          sueId: field.sueId,
          role: field.role === "select" ? "select" : field.role,
          value: options[Math.min(variant, options.length - 1)],
        })),
        ...ticks.map((tick) => ({ key: tick.key, sueId: tick.sueId, role: "checkbox", check: true })),
      ];
      moves.push({
        key: control.key,
        sueId: control.sueId,
        kind: control.kind,
        role: control.role,
        ...(control.option != null ? { option: control.option } : {}),
        ...(typed.length ? { typed } : {}),
        ...(variants > 1 ? { variant } : {}),
      });
    }
  }
  return moves;
}

/** A move's name on a tape: its control and, when it has several, which variant. */
export const moveName = (move) => (move.variant != null ? `${move.key}~${move.variant}` : move.key);
/** A screen's path's name: device, the start it began on (relative to the tape's origin) and every move, the same for the same walk on any tape. */
export const pathKeyOf = (device, start, steps) => [`${device}@${start}`, ...steps.map(moveName)].join(" > ");

// --- one walk --------------------------------------------------------------------------------------------------

/**
 * A replayed step bound to the controls of the screen the walk is on now: the control by its `key` (the `data-sue-id`
 * stamps of the recording belong to the walk that made them), and every typed box by its key too. `{ step }`, or
 * `{ error }` naming what is not on the screen.
 */
function rebind(step, controls) {
  const control = controls.find((c) => c.key === step.key && (c.kind === "tap" || c.kind === "choose"));
  if (!control) return { error: `the control "${step.key}" is not on the screen` };
  const typed = [];
  for (const t of step.typed ?? []) {
    const box = controls.find((c) => c.key === t.key && (c.kind === "field" || c.role === "checkbox"));
    if (!box) return { error: `the box "${t.key}" is not on the screen` };
    typed.push({ ...t, sueId: box.sueId });
  }
  return { step: { ...step, sueId: control.sueId, ...(step.typed ? { typed } : {}) } };
}

/**
 * Walk one path in a fresh context and capture where it ends: the start, then each move, the inventory read on
 * every screen it passes. Returns the captured screen, or `{ error, atStep }` when a move failed.
 *
 * A read-through (tape/read-through.mjs) passes `opts`: `resolve: { allowedHosts, origin }` binds each replayed step to
 * the live screen's controls by key (a step that finds no control is an error, never a click on another element), and
 * `next({ inventory, controls, capture })` is asked once the path is replayed, to say the one move to play from the
 * screen reached (`{ move }`) or to refuse it (`{ error, unreachable: true }`); `capture()` reads that screen as it
 * stands. With no `opts` this is the crawl's walk, as it always was.
 */
export async function walk(browser, device, startUrl, steps, config, { resolve = null, next = null } = {}) {
  const screen = await openDevicePage(browser, device, config);
  const budgetMs = config.settleMs ?? SETTLE_BUDGET_MS;
  try {
    await arrive(screen, startUrl);
    let settled = await settle(screen, { budgetMs });
    let inventory = await inventoryOf(screen.page);
    const read = async () => ({
      inventory,
      shot: await screenshotOf(screen.page),
      forms: await formsOf(screen.page),
      settled,
      url: screen.page.url(),
    });
    const controlsNow = async () => controlsOf(inventory, await formsOf(screen.page), resolve.allowedHosts, resolve.origin);
    for (let i = 0; i < steps.length; i++) {
      let step = steps[i];
      if (resolve) {
        const bound = rebind(step, await controlsNow());
        if (bound.error) return { error: bound.error, atStep: i };
        step = bound.step;
      }
      try {
        await act(screen, step);
      } catch (err) {
        return { error: String(err?.message ?? err).split("\n")[0], atStep: i };
      }
      settled = await settle(screen, { budgetMs });
      inventory = await inventoryOf(screen.page);
    }
    if (next) {
      const planned = await next({ inventory, controls: await controlsNow(), capture: read });
      if (planned.error) return planned;
      try {
        await act(screen, planned.move);
      } catch (err) {
        return { error: String(err?.message ?? err).split("\n")[0], atStep: steps.length, tap: true };
      }
      settled = await settle(screen, { budgetMs });
      inventory = await inventoryOf(screen.page);
    }
    return await read();
  } finally {
    await releaseClock(screen.cdp);
    await screen.close();
  }
}

// --- one screen on disk ----------------------------------------------------------------------------------------

/** A screen as it is saved: with the `stamp` the config computes for it (what its files make now), when there is one. */
export function withStamp(screen, config) {
  return typeof config.stampOf === "function" ? { ...screen, stamp: config.stampOf(screen) } : screen;
}

/**
 * A captured walk as a tape screen: named by its inventory, its controls read, both relative to `origin`.
 * `start` is the start URL (relative to `origin`) its walk began on and `steps` replay it from there; `parent` is the
 * screen the last step was taken on.
 */
export function screenRecord(captured, { device, start, steps, parent, allowedHosts, origin }) {
  return {
    id: screenIdOf(captured.inventory, origin),
    device,
    start,
    url: captured.url,
    title: captured.inventory.title ?? "",
    depth: steps.length,
    steps,
    pathKey: pathKeyOf(device, start, steps),
    parent,
    inventory: captured.inventory,
    controls: controlsOf(captured.inventory, captured.forms ?? {}, allowedHosts, origin),
    settle: captured.settled,
  };
}

/** Write one screen into the tape at `out`: screens/<id>.png and screens/<id>.json, stamped. Returns what was saved. */
export function saveScreen(out, screen, shot, config = {}) {
  const dir = path.join(out, "screens");
  mkdirSync(dir, { recursive: true });
  const saved = withStamp(screen, config);
  writeAtomic(path.join(dir, `${screen.id}.png`), shot);
  writeAtomic(path.join(dir, `${screen.id}.json`), `${JSON.stringify(saved, null, 1)}\n`);
  return saved;
}

/** Loads a recorded tape: its manifest, its edges, and a reader for one screen. A tape of the older one-start-per-device shape is refused. */
export function loadTape(dir) {
  const manifest = JSON.parse(readFileSync(path.join(dir, "manifest.json"), "utf8"));
  for (const [device, start] of Object.entries(manifest.starts ?? {}))
    if (typeof start !== "object" || start === null)
      throw new Error(
        `${dir}: this tape keeps one start screen per device (manifest.starts.${device} is "${start}"), the older shape, so every Sue would begin on the same screen. Record it again: bun sue/tape.mjs record --out <dir> (tape/FORMAT.md, "starts")`,
      );
  const edges = JSON.parse(readFileSync(path.join(dir, "edges.json"), "utf8"));
  const screen = (id) => JSON.parse(readFileSync(path.join(dir, "screens", `${id}.json`), "utf8"));
  return { dir, manifest, edges, screen };
}

// --- the whole recording ---------------------------------------------------------------------------------------

/** Loads a config module (`--config`): its default export, or its named exports. */
export async function loadConfig(file) {
  if (!file) return { config: {}, file: null };
  const resolved = path.resolve(file);
  const mod = await import(pathToFileURL(resolved).href);
  return { config: mod.default ?? mod, file: resolved };
}

/**
 * Record a tape, a bounded crawl. `url` is the start (a config's `start()` may supply it), `devices` the device
 * names, `out` the tape folder. Resolves to the manifest. `log` gets one line per level. Whatever it started (the
 * config's server, the browser) is closed on every way out, an error before the first walk included.
 */
export async function recordTape({
  url,
  devices = ["phone", "chromebook", "desktop"],
  out,
  config = {},
  configFile = null,
  maxScreens,
  maxDepth,
  concurrency,
  log = () => {},
}) {
  const started = Date.now();
  const limits = {
    maxScreens: maxScreens ?? config.maxScreens ?? DEFAULT_MAX_SCREENS,
    maxDepth: maxDepth ?? config.maxDepth ?? DEFAULT_MAX_DEPTH,
  };
  const workers = concurrency ?? config.concurrency ?? DEFAULT_CONCURRENCY;
  const screens = new Map(); // id -> saved screen
  const edges = [];
  const starts = {};
  let recorded = 0;
  let server = null;
  let browser = null;
  let startUrl = null;
  try {
    server = typeof config.start === "function" ? await config.start() : null;
    startUrl = url ?? server?.url ?? config.startUrl;
    if (!startUrl) throw new Error("no start URL: give --url, or a config with startUrl or start()");
    for (const device of devices) deviceSpec(device);
    const origin = originOf(startUrl);
    const start = startKeyOf(startUrl, origin);
    const allowedHosts = config.allowedHosts ?? [new URL(startUrl).hostname];
    const inScope = (u) => (config.scope ? config.scope(u) : allowedHosts.includes(new URL(u).hostname));
    mkdirSync(path.join(out, "screens"), { recursive: true });

    const executablePath = resolveChromiumPath();
    if (!executablePath) throw new Error("no Chromium on this machine (browser-launch.mjs resolved null)");
    browser = await chromium.launch({ headless: true, executablePath, args: browserArgsFor("headless") });

    await Promise.all(
      devices.map(async (device) => {
        let count = 0;

        /** Keep a captured screen; returns its id (a known one when deduped) or null when the tape is full. */
        const keep = (captured, steps, parent) => {
          const screen = screenRecord(captured, { device, start, steps, parent, allowedHosts, origin });
          if (screens.has(screen.id)) return { id: screen.id, isNew: false };
          if (count >= limits.maxScreens) return { id: null, isNew: false };
          count += 1;
          screens.set(screen.id, saveScreen(out, screen, captured.shot, config));
          return { id: screen.id, isNew: true };
        };

        const first = await walk(browser, device, startUrl, [], config);
        if (first.error) throw new Error(`${device}: the start did not open (${first.error})`);
        recorded += 1;
        const startId = keep(first, [], null).id;
        starts[device] = { [start]: startId };
        let level = [screens.get(startId)];
        for (let depth = 0; depth < limits.maxDepth && level.length; depth++) {
          const jobs = [];
          for (const parent of level) {
            if (!inScope(parent.url)) continue;
            for (const move of await movesOf(parent, config)) jobs.push({ parent, move });
          }
          const results = new Array(jobs.length);
          let next = 0;
          await Promise.all(
            Array.from({ length: Math.min(workers, jobs.length) }, async () => {
              while (next < jobs.length) {
                const i = next++;
                recorded += 1;
                results[i] = await walk(browser, device, startUrl, [...jobs[i].parent.steps, jobs[i].move], config).catch((err) => ({
                  error: String(err?.message ?? err).split("\n")[0],
                }));
              }
            }),
          );
          const nextLevel = [];
          jobs.forEach(({ parent, move }, i) => {
            const result = results[i];
            const edge = {
              device,
              from: parent.id,
              move: moveName(move),
              control: move.key,
              ...(move.variant != null ? { variant: move.variant } : {}),
              ...(move.typed ? { typed: move.typed.map(({ key, value, check }) => ({ key, ...(check ? { check } : { value }) })) } : {}),
            };
            if (result.error) {
              edges.push({ ...edge, to: null, error: result.error });
              return;
            }
            const { id, isNew } = keep(result, [...parent.steps, move], parent.id);
            edges.push({ ...edge, to: id, ...(id ? {} : { dropped: "max-screens" }) });
            if (isNew) nextLevel.push(screens.get(id));
          });
          log(`${device}: depth ${depth + 1}, ${jobs.length} moves, ${nextLevel.length} new screens (${count} kept)`);
          level = nextLevel;
        }
        // The links never followed are edges too, so a student's tap on one is answered from the tape.
        for (const screen of [...screens.values()].filter((s) => s.device === device))
          for (const c of screen.controls.filter((c) => c.kind === "offsite" || c.kind === "leaves"))
            edges.push({ device, from: screen.id, move: c.key, control: c.key, to: null, [c.kind]: c.href });
      }),
    );
  } finally {
    await browser?.close().catch(() => {}); // a browser that already went is closed
    await server?.stop?.();
  }

  writeFileSync(path.join(out, "edges.json"), `${JSON.stringify(edges, null, 1)}\n`);
  const all = [...screens.values()];
  const manifest = {
    format: TAPE_FORMAT,
    recordedAt: new Date().toISOString(),
    startUrl,
    devices: Object.fromEntries(devices.map((d) => [d, deviceFacts(d)])),
    starts,
    config: configFile ? { file: configFile, sha256: createHash("sha256").update(readFileSync(configFile)).digest("hex") } : null,
    settleBudgetMs: config.settleMs ?? SETTLE_BUDGET_MS,
    limits,
    stats: {
      screens: all.length,
      edges: edges.length,
      followedEdges: edges.filter((e) => e.to).length,
      walks: recorded,
      midAnimation: all.filter((s) => s.settle?.midAnimation).length,
      settleTimedOut: all.filter((s) => s.settle?.timedOut).length,
      wallMs: Date.now() - started,
    },
    screens: Object.fromEntries(
      all.map((s) => [s.id, { device: s.device, url: s.url, depth: s.depth, pathKey: s.pathKey, settle: s.settle }]),
    ),
  };
  writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(manifest, null, 1)}\n`);
  return manifest;
}
