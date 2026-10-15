// reading-pace.mjs - the paced reading mode (`reading: "paced"`): a Sue reads one screen at a time and the browser
// waits the real seconds that screen takes to read. The viewport rests, her pointer drifts over the text she is
// reading, and the page stays visible and focused until her visit ends. Default runs never reach the browser helpers.

export const READING_MODES = ["paced"];

export const PACE_DIALS = Object.freeze({ wordsPerMinute: 200, screenCapMs: 45_000, visitCapMs: 300_000 });

export function readingModeOf(value) {
  if (value === undefined || value === null || value === "" || value === false) return null;
  if (READING_MODES.includes(value)) return value;
  throw new Error(`reading takes ${READING_MODES.join(" or ")}, got ${JSON.stringify(value)}`);
}

export function screenReadMs(words, { wordsPerMinute, attentionMs = Infinity, screenCapMs = PACE_DIALS.screenCapMs } = {}) {
  const wpm = Number(wordsPerMinute) > 0 ? Number(wordsPerMinute) : PACE_DIALS.wordsPerMinute;
  const readMs = (Math.max(0, Number(words) || 0) * 60_000) / wpm;
  return Math.max(0, Math.min(readMs, Math.max(0, attentionMs), screenCapMs));
}

export function paceWaitMs(
  words,
  { mode, spentMs = 0, attentionMs, wordsPerMinute, screenCapMs, visitCapMs = PACE_DIALS.visitCapMs } = {},
) {
  if (mode !== "paced") return 0;
  const visitLeftMs = Math.max(0, visitCapMs - spentMs);
  return Math.min(screenReadMs(words, { wordsPerMinute, attentionMs, screenCapMs }), visitLeftMs);
}

export function screenOnly(inventory) {
  return {
    ...inventory,
    screenOnly: true,
    // Whether the page goes on below her screen: a block left out that is not one she scrolled past. perceive() then
    // names her screen's edge even when it falls between two blocks (Raise Buddy re-visit 24: a card cut there read empty).
    moreBelow: (inventory.blocks ?? []).some((b) => b.aboveFold !== true && Number(b.bottom) > 0),
    blocks: (inventory.blocks ?? []).filter((b) => b.aboveFold === true),
    elements: (inventory.elements ?? []).filter((e) => e.aboveFold === true),
  };
}

export function keepPageFocused() {
  const define = (name, value) => {
    try {
      Object.defineProperty(document, name, { get: () => value, configurable: true });
    } catch {
      // the page already defines it
    }
  };
  define("visibilityState", "visible");
  define("hidden", false);
  document.hasFocus = () => true;
}

/**
 * Where her pointer goes when a reading or rest ends: empty page space, never on a link, button or field (a pointer
 * parked on a call to action reads as "hovered, did not click" before she comes back to click it). Null when the page
 * has no empty point in view.
 */
export const LEAVE_SPOT = () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const control = "a, button, [role=button], input, select, textarea, label, summary, [onclick], [tabindex]";
  const empty = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return Boolean(el) && !el.closest(control);
  };
  const tries = [
    [w / 2, 4],
    [w / 4, 4],
    [(3 * w) / 4, 4],
    [4, h / 2],
    [w - 4, h / 2],
    [4, 4],
    [w - 4, 4],
    [w / 2, h - 4],
  ];
  for (let y = 4; y < h; y += 40) for (let x = 4; x < w; x += 40) tries.push([x, y]);
  for (const [x, y] of tries) {
    const point = { x: Math.round(Math.min(w - 1, Math.max(0, x))), y: Math.round(Math.min(h - 1, Math.max(0, y))) };
    if (empty(point.x, point.y)) return point;
  }
  return null;
};

/**
 * How long she weighs a control: the time to read its own words and the one nearest deciding line, plus a 1 s decision
 * pause, held between 1.5 s and 7 s, then a seeded per-Sue multiplier of 0.7 to 1.6 AFTER those bounds, so no two Sues
 * share a time and none sits on the ceiling.
 */
export function weighMs(words, { wordsPerMinute, random = Math.random } = {}) {
  const wpm = Number(wordsPerMinute) > 0 ? Number(wordsPerMinute) : PACE_DIALS.wordsPerMinute;
  const base = Math.min(7_000, Math.max(1_500, (words * 60_000) / wpm + 1_000));
  return Math.round(base * (0.7 + random() * 0.9));
}

/** A small seeded random: the same Sue seed gives the same run, a different Sue another. */
export function seededRandom(seed) {
  let a = 0;
  for (const ch of String(seed ?? "sue")) a = (Math.imul(a, 31) + ch.charCodeAt(0)) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The text she can read on this screen, in reading order: each item's centre and its own word count. */
const READING_ITEMS = () => {
  const skip = "input, textarea, select, option, button, a, form, [contenteditable], [role=textbox], [role=combobox], [role=searchbox]";
  const h = window.innerHeight;
  const w = window.innerWidth;
  const clamp = (v, max) => Math.max(1, Math.min(max - 1, v));
  const items = [];
  for (const el of document.body ? document.body.querySelectorAll("*") : []) {
    if (el.closest(skip)) continue;
    let own = "";
    for (const n of el.childNodes) if (n.nodeType === 3) own += ` ${n.textContent}`;
    const words = own.trim().split(/\s+/).filter(Boolean).length;
    if (words < 2) continue;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0) || r.bottom <= 0 || r.top >= h) continue;
    const x = (clamp(r.left, w) + clamp(r.right, w)) / 2;
    const y = (clamp(r.top, h) + clamp(r.bottom, h)) / 2;
    const hit = document.elementFromPoint(x, y);
    if (!hit || hit.closest(skip)) continue;
    items.push({ x, y, words, top: r.top, left: r.left, right: r.right, bottom: r.bottom, text: own.replace(/\s+/g, " ").trim() });
  }
  items.sort((a, b) => a.top - b.top || a.left - b.left);
  return items.slice(0, 80);
};

/**
 * Reading order: top to bottom, but side-by-side columns (blocks whose vertical ranges overlap and whose horizontal
 * ranges do not) are read one column at a time, left to right, each top to bottom. A page of one column keeps plain
 * top-then-left order; ties fall to the order in the page.
 */
export function orderReadingItems(items) {
  const list = (items ?? []).map((item, dom) => ({ item, dom }));
  const reading = (a, b) => a.item.top - b.item.top || a.item.left - b.item.left || a.dom - b.dom;
  list.sort(reading);
  const boxed = list.every(({ item }) => [item.top, item.left, item.right, item.bottom].every(Number.isFinite));
  if (!boxed) return list.map(({ item }) => item);
  // Blocks that share horizontal ground are one column.
  const columnsOf = (band) => {
    const parent = band.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    for (let i = 0; i < band.length; i += 1)
      for (let j = i + 1; j < band.length; j += 1)
        if (band[i].item.left < band[j].item.right && band[j].item.left < band[i].item.right) parent[find(j)] = find(i);
    const columns = new Map();
    band.forEach((entry, i) => {
      const root = find(i);
      if (!columns.has(root)) columns.set(root, []);
      columns.get(root).push(entry);
    });
    return [...columns.values()].map((entries) => ({
      entries: entries.sort(reading),
      left: Math.min(...entries.map((e) => e.item.left)),
      right: Math.max(...entries.map((e) => e.item.right)),
    }));
  };
  // Bands: runs of blocks whose vertical ranges chain into each other.
  const bands = [];
  let bandBottom = -Infinity;
  for (const entry of list) {
    if (!bands.length || entry.item.top >= bandBottom) {
      bands.push([entry]);
      bandBottom = entry.item.bottom;
    } else {
      bands.at(-1).push(entry);
      bandBottom = Math.max(bandBottom, entry.item.bottom);
    }
  }
  // Rows of two columns that happen to end on the same line are still the same two columns: a band that stays inside the
  // columns of the one before it (each of its blocks over exactly one of them) continues them.
  const merged = [];
  for (const band of bands) {
    const columns = merged.length ? columnsOf(merged.at(-1)) : [];
    const within =
      columns.length >= 2 && columnsOf(band).every((c) => columns.filter((p) => c.left < p.right && p.left < c.right).length === 1);
    if (within) merged.at(-1).push(...band);
    else merged.push([...band]);
  }
  const ordered = [];
  for (const band of merged) {
    const columns = columnsOf(band).sort((a, b) => a.left - b.left || a.entries[0].dom - b.entries[0].dom);
    for (const column of columns) ordered.push(...column.entries.map(({ item }) => item));
  }
  return ordered;
}

/**
 * How long she stays on each item: the item's own reading time at her pace, each stretched or shortened by up to 30%
 * (seeded by `random`), the whole fitted to `ms`. Items past the budget are not reached; a budget left over is spread
 * over the ones read. A short item gets a short stay.
 */
export function planReadingStays(items, ms, { random = Math.random, wordsPerMinute = PACE_DIALS.wordsPerMinute } = {}) {
  const budget = Math.max(0, Math.round(Number(ms) || 0));
  const wpm = Number(wordsPerMinute) > 0 ? Number(wordsPerMinute) : PACE_DIALS.wordsPerMinute;
  const stays = [];
  let spent = 0;
  for (let index = 0; index < (items ?? []).length && spent < budget; index += 1) {
    const own = ((items[index].words * 60_000) / wpm) * (0.7 + random() * 0.6);
    const stay = Math.min(Math.max(200, Math.round(own)), budget - spent);
    stays.push({ index, ms: stay });
    spent += stay;
  }
  if (stays.length && spent < budget) {
    const scale = budget / spent;
    let total = 0;
    for (const s of stays) {
      s.ms = Math.round(s.ms * scale);
      total += s.ms;
    }
    stays.at(-1).ms += budget - total;
  }
  return stays;
}

/** No one sits on one line that long: a stay is held to a seeded cap between these two (two stays on one block still read as a dwell under 10 s), and the rest of the time passes with the pointer parked. */
export const MAX_STAY_MS = 5_000;
export const MIN_STAY_CAP_MS = 2_500;

/** The pixel counts a pointer stop as a rest (a dwell on the block) from this long. */
export const MIN_REST_MS = 1_500;

/** The stays held to `maxStayMs` each, and the time that is left over (spent with the pointer parked off the text). */
export function capStays(stays, ms, { random = Math.random, minMs = MIN_STAY_CAP_MS, maxMs = MAX_STAY_MS } = {}) {
  // Each stay has its own cap, drawn from a seeded range, so capped stays spread the way uncapped ones do.
  const capped = (stays ?? []).map((s) => ({ ...s, ms: Math.min(s.ms, Math.round(minMs + random() * (maxMs - minMs))) }));
  const used = capped.reduce((sum, s) => sum + s.ms, 0);
  return { stays: capped, leftoverMs: Math.max(0, Math.round(Number(ms) || 0) - used) };
}

/**
 * Hold the viewport still for `ms` while the pointer goes through the text on screen in reading order, staying on
 * each piece as long as its own words take to read. When the reading ends it moves off the text toward the top of the
 * viewport, as a hand heads for the tab bar. Never scrolls, never touches a field or a control. A page that closed
 * mid-wait ends the wait. Returns the blocks she rested on long enough to count: [{ text, ms }].
 */
export async function restWhileReading(page, ms, { random = Math.random, wordsPerMinute } = {}) {
  let moved = false;
  const rests = [];
  try {
    const items = orderReadingItems((await page.evaluate(READING_ITEMS).catch(() => null)) ?? []);
    const { stays, leftoverMs } = capStays(planReadingStays(items, ms, { random, wordsPerMinute }), ms, { random });
    if (!stays.length) await page.waitForTimeout(Math.max(0, ms));
    for (const stay of stays) {
      const at = items[stay.index];
      await page.mouse.move(at.x, at.y, { steps: 10 }).catch(() => {});
      moved = true;
      await page.waitForTimeout(stay.ms);
      if (stay.ms >= MIN_REST_MS && at.text) rests.push({ text: at.text, ms: stay.ms });
    }
    if (moved) {
      const leave = await page.evaluate(LEAVE_SPOT).catch(() => null);
      if (leave) await page.mouse.move(leave.x, leave.y, { steps: 10 }).catch(() => {});
      if (leftoverMs > 0) await page.waitForTimeout(leftoverMs);
    }
  } catch {
    // the page is gone: the visit is ending anyway
  }
  return rests;
}
