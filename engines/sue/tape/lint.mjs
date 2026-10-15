/**
 * tape/lint.mjs - mechanical checks over a recorded tape, in seconds, with no browser.
 *
 *   node sue/tape.mjs lint <tape> [--rules <module>] [--personas a,b] [--json]
 *
 * WHY: most of what a simulated student complains about on a page is a measurement (print too small, a tap target
 * too small for a thumb, a control past the screen's edge, the result of a tap below the fold, more words than one
 * reader takes in, two counts that disagree). A tape already holds those measurements, so a script finds them
 * before a round of browsers does.
 *
 * Every check reads only what a tape holds: one screen's inventory (tape/FORMAT.md, the INVENTORY_SCRIPT's
 * blocks and elements), its controls, the tape's edges, and `perceive(inventory, persona)` for the people named
 * with --personas. Nothing is guessed from a URL and nothing needs a browser. A check that needs two screens reads
 * the other one through the tape (`tape.screens`, `tape.edgesFrom(id)`, `tape.edgesTo(id)`).
 *
 * A hit: { check, level, screen, device, pathKey, target, measured, limit, why, persona? }. `target` names the
 * control or block; `why` is one line naming the kind of complaint the check prevents. Exit 1 when any hit is at
 * error level.
 *
 * A site's own checks come from `--rules <module>`: its default export (or named `rules`) is an array of
 *   { id, level?: "error"|"warning", why, check(ctx) }
 * where `ctx = { screen, device, tape, personas }` and `check` returns an array of
 *   { target, measured, limit, why?, level?, screen? }   (a hit on another screen names it in `screen`)
 * See tape/examples/lift-rules.mjs.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { perceive } from "../lib/perception.mjs";
import { isGradeable, readingGradeOf } from "../lib/readability.mjs";

/** Smallest print anyone reads without zooming, when no persona says otherwise (CSS px). */
export const MIN_PRINT_PX = 12;
/** A thumb's target on a touch screen, WCAG 2.5.5 (CSS px, both sides). */
export const MIN_TAP_PX = 44;
/** A first action must start this far above the bottom of the screen (Lift's walk: `b.y + 30 > vh`). */
export const FIRST_ACTION_MARGIN_PX = 30;
/** A control more than this many screens down the page is out of reach (Lift's walk: `box.y > vh * 3`). */
export const FAR_DOWN_SCREENS = 3;
/** Edge slack before something counts as past the screen's edge (Lift's walk: `r.right > W + 2`). */
const EDGE_SLACK_PX = 2;

const LIVE_KINDS = new Set(["tap", "choose"]);
const LEVEL_RANK = { error: 0, warning: 1, info: 2 };

/** Read a tape from disk: its manifest, every screen, and its edges, with the helpers a check needs. */
export function loadTape(dir) {
  const read = (...parts) => JSON.parse(fs.readFileSync(path.join(dir, ...parts), "utf8"));
  if (!fs.existsSync(path.join(dir, "manifest.json"))) throw new Error(`not a tape: no manifest.json in ${dir}`);
  const manifest = read("manifest.json");
  const edges = fs.existsSync(path.join(dir, "edges.json")) ? read("edges.json") : [];
  const screens = {};
  for (const id of Object.keys(manifest.screens ?? {})) {
    const file = path.join(dir, "screens", `${id}.json`);
    if (fs.existsSync(file)) screens[id] = JSON.parse(fs.readFileSync(file, "utf8"));
  }
  return {
    dir,
    manifest,
    screens,
    edges,
    edgesFrom: (id) => edges.filter((e) => e.from === id),
    edgesTo: (id) => edges.filter((e) => e.to === id),
  };
}

const textOf = (item) => String(item.text ?? "").slice(0, 60);
const nameOf = (el) => String(el.name || el.seenText || el.labelText || el.role || "").slice(0, 60);
const visible = (el) => !el.hidden && !el.covered && !el.behindOverlay;
const isTouch = (tape, device) => Boolean(tape.manifest.devices?.[device]?.hasTouch) || device === "phone";

/** The blocks of `screen` whose words are not on `parent` at all: what a tap put on the screen. */
export function newBlocks(screen, parent) {
  const worded = (blocks) => (blocks ?? []).filter((b) => b.wordCount > 0);
  const had = new Set(worded(parent?.inventory?.blocks).map((b) => b.text));
  return worded(screen.inventory?.blocks)
    .filter((b) => !had.has(b.text))
    .sort((a, b) => a.order - b.order);
}

/** The screens a tap on `from` led to, as [{ edge, from, to }] on the same device, a screen that changed only. */
export function tapResults(tape, screen) {
  return tape
    .edgesTo(screen.id)
    .filter((e) => e.from !== e.to && tape.screens[e.from] && tape.screens[e.from].device === screen.device)
    .map((e) => ({ edge: e, from: tape.screens[e.from] }));
}

// Generic checks. Each takes ctx = { screen, device, tape, personas } and returns hits without the shared fields.

/** Print under 12px anywhere on the page: nobody reads it, a kid on a phone least of all. */
function textTooSmall({ screen }) {
  const hits = [];
  for (const block of screen.inventory.blocks ?? [])
    if (block.fontPx > 0 && block.fontPx < MIN_PRINT_PX)
      hits.push({ target: `"${textOf(block)}"`, measured: block.fontPx, limit: MIN_PRINT_PX });
  for (const el of screen.inventory.elements ?? [])
    if (visible(el) && el.hasVisibleText && el.fontPx > 0 && el.fontPx < MIN_PRINT_PX)
      hits.push({ target: `${el.role} "${nameOf(el)}"`, measured: el.fontPx, limit: MIN_PRINT_PX });
  return hits;
}

/** A control smaller than a thumb on a touch screen: mis-taps and "I couldn't press it". */
function tapTargetSmall({ screen, device, tape }) {
  if (!isTouch(tape, device)) return [];
  return (screen.controls ?? [])
    .filter((c) => c.rect && (c.kind === "tap" || c.kind === "choose" || c.kind === "field"))
    .filter((c) => Math.min(c.rect.w, c.rect.h) < MIN_TAP_PX)
    .map((c) => ({ target: `${c.role} "${String(c.name).slice(0, 60)}"`, measured: Math.min(c.rect.w, c.rect.h), limit: MIN_TAP_PX }));
}

/** A control that runs past the screen's right or left edge: sideways scrolling, a button half cut off. */
function widerThanScreen({ screen }) {
  const w = screen.inventory.viewport?.w;
  if (!w) return [];
  const hits = [];
  for (const el of screen.inventory.elements ?? []) {
    if (!visible(el) || !el.rect || el.rect.w <= 0) continue;
    const right = el.rect.x + el.rect.w;
    if (right > w + EDGE_SLACK_PX) hits.push({ target: `${el.role} "${nameOf(el)}"`, measured: right, limit: w });
    else if (el.rect.x < -EDGE_SLACK_PX) hits.push({ target: `${el.role} "${nameOf(el)}"`, measured: el.rect.x, limit: 0 });
  }
  return hits;
}

/** Things to do, and not one of them starts on the first screenful: the student scrolls to find the button. */
function firstActionBelowFold({ screen }) {
  const h = screen.inventory.viewport?.h;
  const live = (screen.controls ?? []).filter((c) => c.rect && LIVE_KINDS.has(c.kind));
  if (!h || !live.length) return [];
  const top = Math.min(...live.map((c) => c.rect.y));
  if (top + FIRST_ACTION_MARGIN_PX <= h) return [];
  const first = live.find((c) => c.rect.y === top);
  return [{ target: `${first.role} "${String(first.name).slice(0, 60)}"`, measured: top + FIRST_ACTION_MARGIN_PX, limit: h }];
}

/** A control far down a long page, past three screens of scrolling. */
function controlFarDown({ screen }) {
  const h = screen.inventory.viewport?.h;
  if (!h) return [];
  return (screen.controls ?? [])
    .filter((c) => c.rect && LIVE_KINDS.has(c.kind) && c.rect.y > h * FAR_DOWN_SCREENS)
    .map((c) => ({ target: `${c.role} "${String(c.name).slice(0, 60)}"`, measured: c.rect.y, limit: h * FAR_DOWN_SCREENS }));
}

/** A counter ("2/6") a tap moved is not the result; the result is the first thing added with other words. */
const COUNTER_ONLY = /^\s*\d+\s*(\/|of)\s*\d+\s*$/i;

/** A tap changed the screen, and the first thing it added with words of its own sits below the fold: the result is not seen. */
function resultBelowFold({ screen, tape }) {
  const h = screen.inventory.viewport?.h;
  if (!h) return [];
  const hits = [];
  for (const { edge, from } of tapResults(tape, screen)) {
    const result = newBlocks(screen, from).find((b) => !COUNTER_ONLY.test(String(b.text ?? "")));
    if (!result || result.aboveFold) continue;
    hits.push({ target: `after ${edge.control ?? edge.move}: "${textOf(result)}"`, measured: result.bottom, limit: h });
  }
  return hits;
}

/** A button with no words, no label: a picture a student has to guess at. */
function iconWithoutWords({ screen }) {
  return (screen.inventory.elements ?? [])
    .filter((el) => visible(el) && el.iconOnly)
    .map((el) => ({ target: `${el.role} (picture only) "${nameOf(el)}"`, measured: 0, limit: 1 }));
}

/** A tap that left the screen exactly as it was: the control looks dead. */
function tapChangesNothing({ screen, tape }) {
  return tape
    .edgesFrom(screen.id)
    .filter((e) => e.to === e.from && !e.error && !e.typed?.length)
    .map((e) => ({ target: String(e.control ?? e.move), measured: 0, limit: 1 }));
}

/** Greyed-out controls and nothing live on the screen: it reads as stuck. */
function stuckScreen({ screen }) {
  const controls = screen.controls ?? [];
  const disabled = controls.filter((c) => c.kind === "disabled");
  if (!disabled.length || controls.some((c) => LIVE_KINDS.has(c.kind) || c.kind === "field")) return [];
  return [
    {
      target: disabled
        .map((c) => String(c.name))
        .join(", ")
        .slice(0, 60),
      measured: disabled.length,
      limit: 0,
    },
  ];
}

/** The generic checks, each { id, level, why, check(ctx) }, the same shape a rules module exports. */
export const GENERIC = [
  { id: "text-too-small", level: "error", why: 'print under 12px is skipped or unreadable ("the words were tiny")', check: textTooSmall },
  {
    id: "tap-target-small",
    level: "error",
    why: 'a control under 44px is hard to hit with a thumb ("I kept missing the button")',
    check: tapTargetSmall,
  },
  {
    id: "wider-than-screen",
    level: "error",
    why: 'a control past the screen\'s edge is cut off or scrolls sideways ("it goes off the side")',
    check: widerThanScreen,
  },
  {
    id: "first-action-below-fold",
    level: "error",
    why: 'nothing to tap starts on the first screenful ("why do I have to scroll to find it")',
    check: firstActionBelowFold,
  },
  {
    id: "result-below-fold",
    level: "error",
    why: 'what a tap added sits below the fold ("I didn\'t see if I was right")',
    check: resultBelowFold,
  },
  {
    id: "control-far-down",
    level: "warning",
    why: "a control more than three screens down the page is out of reach",
    check: controlFarDown,
  },
  {
    id: "icon-without-words",
    level: "warning",
    why: 'a picture-only button is a guess ("what does this button do")',
    check: iconWithoutWords,
  },
  {
    id: "tap-changes-nothing",
    level: "warning",
    why: 'a tap that changes nothing looks broken ("it did nothing")',
    check: tapChangesNothing,
  },
  { id: "stuck-screen", level: "warning", why: "greyed-out choices and nothing to press read as stuck", check: stuckScreen },
];

// Persona checks: perceive() is the one place a reader's limits live, so the numbers come from its stats.

function worstGradeBlock(inventory) {
  let worst = null;
  for (const block of inventory.blocks ?? []) {
    if (!isGradeable(block.text)) continue;
    const grade = readingGradeOf(block.text, inventory.lang);
    if (!worst || grade > worst.grade) worst = { block, grade };
  }
  return worst;
}

function personaChecks(screen, persona) {
  const dials = persona.dials ?? {};
  const seen = perceive(screen.inventory, persona).stats;
  const hits = [];
  if (seen.tinyText > 0) {
    // the items perceive() counts as tiny: blocks still on the page, and visible controls that carry words
    const small = [
      ...(screen.inventory.blocks ?? []).filter((b) => b.fontPx > 0 && !(b.bottom <= 0)),
      ...(screen.inventory.elements ?? []).filter((el) => visible(el) && el.hasVisibleText),
    ]
      .filter((i) => i.fontPx > 0 && i.fontPx < dials.legibleMinPx)
      .sort((a, b) => a.fontPx - b.fontPx)[0];
    hits.push({
      check: "print-too-small-for-reader",
      target: `${seen.tinyText} item(s), smallest "${textOf(small ?? {}) || nameOf(small ?? {})}"`,
      measured: small?.fontPx ?? 0,
      limit: dials.legibleMinPx,
      why: `print ${persona.id ?? "the reader"} cannot make out (her legible minimum) is skipped`,
    });
  }
  if (seen.overHead > 0) {
    const worst = worstGradeBlock(screen.inventory);
    hits.push({
      check: "words-over-reading-grade",
      target: `${seen.overHead} block(s), worst "${textOf(worst?.block ?? {})}"`,
      measured: worst?.grade ?? 0,
      limit: dials.readingGrade,
      why: 'words above the reader\'s grade are skimmed, not understood ("too many hard words")',
    });
  }
  if (seen.truncated) {
    hits.push({
      check: "more-words-than-a-look",
      target: `${seen.wordsTotal} words on the screen`,
      measured: seen.wordsTotal,
      limit: dials.wordsPerLook,
      why: 'the reader stops before the end of the page ("i am not reading all that")',
    });
  }
  return hits;
}

/** Resolve --personas entries: a persona JSON file, or a roster id (fetched like every SUE process does). */
export async function resolvePersonas(spec, docs = []) {
  const names = String(spec ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const personas = [...docs];
  const roster = [];
  for (const name of names) {
    if (/[\\/]/.test(name) || name.toLowerCase().endsWith(".json")) personas.push(JSON.parse(fs.readFileSync(path.resolve(name), "utf8")));
    else roster.push(name);
  }
  if (roster.length) {
    const { loadPersona, peopleAreInstalled } = await import("../lib/personas.mjs");
    if (!peopleAreInstalled()) {
      const { readyPeople } = await import("../lib/people.mjs");
      await readyPeople({}, { root: process.cwd(), ids: roster, minds: false });
    }
    for (const id of roster) personas.push(loadPersona(id));
  }
  for (const p of personas)
    if (!p?.dials) throw new Error(`persona ${p?.id ?? "?"} has no dials (readingGrade, wordsPerLook, legibleMinPx)`);
  return personas;
}

/** Load a --rules module: an array of { id, level?, why, check(ctx) }. */
async function loadRules(file) {
  if (!file) return [];
  const abs = path.resolve(file);
  if (!fs.existsSync(abs)) throw new Error(`rules module not found: ${abs}`);
  const mod = await import(pathToFileURL(abs).href);
  const rules = mod.rules ?? mod.default;
  if (!Array.isArray(rules)) throw new Error(`rules module ${abs} must export an array of checks (default or "rules")`);
  for (const r of rules) if (!r?.id || typeof r.check !== "function") throw new Error(`a rule in ${abs} needs an id and a check(ctx)`);
  return rules;
}

/** Every hit on a tape, worst first. `personas` are persona documents (with `dials`). */
export async function lintTape(tape, { rules = [], personas = [] } = {}) {
  const hits = [];
  const add = (screen, rule, hit, persona) =>
    hits.push({
      check: hit.check ?? rule.id,
      level: hit.level ?? rule.level ?? "error",
      screen: hit.screen ?? screen.id,
      device: (hit.screen && tape.screens[hit.screen]?.device) || screen.device,
      pathKey: (hit.screen && tape.screens[hit.screen]?.pathKey) || screen.pathKey,
      target: hit.target,
      measured: hit.measured,
      limit: hit.limit,
      why: hit.why ?? rule.why,
      ...(persona ? { persona: persona.id ?? null } : {}),
    });
  for (const id of Object.keys(tape.screens)) {
    const screen = tape.screens[id];
    const ctx = { screen, device: screen.device, tape, personas };
    for (const rule of [...GENERIC, ...rules]) for (const hit of rule.check(ctx) ?? []) add(screen, rule, hit);
    for (const persona of personas) for (const hit of personaChecks(screen, persona)) add(screen, { level: "error" }, hit, persona);
  }
  // how far past its limit a hit is, so the worst of a check comes first
  const over = (h) => (h.limit ? Math.abs(h.measured - h.limit) / Math.abs(h.limit) : Math.abs(h.measured));
  return hits.sort((a, b) => a.check.localeCompare(b.check) || over(b) - over(a));
}

/** Print hits grouped by check, the check with most errors first, short. */
function printHits(hits, log) {
  const groups = new Map();
  for (const h of hits) (groups.get(h.check) ?? groups.set(h.check, []).get(h.check)).push(h);
  const order = [...groups.entries()].sort(
    (a, b) =>
      Math.min(...a[1].map((h) => LEVEL_RANK[h.level])) - Math.min(...b[1].map((h) => LEVEL_RANK[h.level])) || b[1].length - a[1].length,
  );
  for (const [check, list] of order) {
    log(`${check} (${list.length}, ${list[0].level}): ${list[0].why}`);
    for (const h of list.slice(0, 8))
      log(`  ${h.device} ${h.screen} ${h.target} | ${h.measured} vs ${h.limit}${h.persona ? ` | ${h.persona}` : ""}`);
    if (list.length > 8) log(`  ... ${list.length - 8} more (use --json)`);
  }
}

/** The `lint` command: returns the exit code (1 when any hit is an error). */
export async function lint(tapeDir, { rulesPath, personas, personaDocs = [], json = false, log = console.log } = {}) {
  const tape = loadTape(tapeDir);
  const hits = await lintTape(tape, { rules: await loadRules(rulesPath), personas: await resolvePersonas(personas, personaDocs) });
  if (json) log(JSON.stringify(hits, null, 1));
  else if (hits.length) printHits(hits, log);
  else log("no hits");
  return hits.some((h) => h.level === "error") ? 1 : 0;
}
