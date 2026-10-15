// rest-on-text.mjs - paced mode: when a Sue's thought names text on the page, her pointer rests on that text the way a
// reader's does while rereading it. Matching and planning are pure; restOnThought runs the moves on her page.
import { LEAVE_SPOT } from "./reading-pace.mjs";

const STOP = new Set(
  (
    "a an and are as at be by can could do does for from get has have how if in is it its of on or so that the their " +
    "them then there these they this to was what when which who why will with would you your not but just really much " +
    "many more than about into out up i me my we our means mean"
  ).split(" "),
);

const CANDIDATE_SELECTOR =
  "p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, td, th, summary, label, a[href], button, [role=button], [role=link]";

export const REST_ON_TEXT_KINDS = new Set(["thought", "confusion"]);
export const REST_MIN_MS = 2_000;
export const REST_MAX_MS = 20_000;
const MIN_ELEMENT_WORDS = 2;
const MAX_HEADING_WORDS = 3;
const MIN_COVERAGE = 0.75;

export function wordsOf(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

function keyWords(value) {
  return wordsOf(value).filter((w) => !STOP.has(w) && (w.length >= 3 || /\d/.test(w)));
}

function sameWord(a, b) {
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 3 && long.startsWith(short) && long.length - short.length <= 3;
}

function betterMatch(a, b) {
  if (a.coverage !== b.coverage) return a.coverage > b.coverage;
  if (a.link !== b.link) return a.link;
  return a.length < b.length;
}

/**
 * The on-page element whose key words the thought names, or null. Every key word of the element (at least two, 75%
 * of them) must appear in the thought, so a paraphrase that keeps the phrase matches and a shared common word does not.
 */
export function matchThought(thought, candidates) {
  const said = keyWords(thought);
  if (!said.length) return null;
  let best = null;
  for (const c of candidates ?? []) {
    const words = keyWords(c.text);
    if (words.length < MIN_ELEMENT_WORDS) continue;
    const hit = words.filter((w) => said.some((s) => sameWord(s, w))).length;
    const coverage = hit / words.length;
    if (hit < MIN_ELEMENT_WORDS || coverage < MIN_COVERAGE) continue;
    const score = { c, coverage, link: c.link === true, length: String(c.text).length };
    if (!best || betterMatch(score, best)) best = score;
  }
  if (!best) return null;
  return { index: best.c.i, link: best.c.link === true, above: best.c.above === true, text: best.c.text };
}

/** True when the thought repeats `run` or more consecutive words of the element's text, in order. */
export function quotesRun(thought, text, run = 3) {
  const said = wordsOf(thought).join(" ");
  const words = wordsOf(text);
  for (let i = 0; i + run <= words.length; i += 1) if (` ${said} `.includes(` ${words.slice(i, i + run).join(" ")} `)) return true;
  return false;
}

/**
 * The element a thought rests on: one in the viewport first. An element above it is only gone back to when the thought
 * quotes three consecutive words of it; a loose shared keyword never scrolls her back up the page.
 */
export function matchThoughtInView(thought, candidates) {
  const list = candidates ?? [];
  const seen = matchThought(
    thought,
    list.filter((c) => c.above !== true),
  );
  if (seen) return seen;
  return matchThought(
    thought,
    list.filter((c) => c.above === true && quotesRun(thought, c.text, 3)),
  );
}

const QUOTED_RE = /"([^"]+)"|(?<![\p{L}\p{N}])'([^']+)'(?![\p{L}\p{N}])|“([^”]+)”|‘([^’]+)’/gu;

/** The phrases a thought quotes (two words or more), in the order she said them. */
export function quotedPhrases(thought) {
  const out = [];
  for (const m of String(thought ?? "").matchAll(QUOTED_RE)) {
    const phrase = (m[1] ?? m[2] ?? m[3] ?? m[4] ?? "").trim();
    if (wordsOf(phrase).length >= 2) out.push(phrase);
  }
  return out;
}

function smallestBlockHolding(phrase, candidates) {
  const needle = ` ${wordsOf(phrase).join(" ")} `;
  let best = null;
  for (const c of candidates) {
    if (!` ${wordsOf(c.text).join(" ")} `.includes(needle)) continue;
    if (!best || String(c.text).length < String(best.text).length) best = c;
  }
  return best;
}

/**
 * The block holding the words a thought quotes: the last quoted phrase wins, unless its block is one the look already
 * rested on, then the one before. Null when no quoted phrase is on the page, so the keyword match decides.
 */
export function matchQuotedInView(thought, candidates, rests = []) {
  const list = candidates ?? [];
  const inView = list.filter((c) => c.above !== true);
  const above = list.filter((c) => c.above === true);
  for (const phrase of quotedPhrases(thought).reverse()) {
    const c = smallestBlockHolding(phrase, inView) ?? smallestBlockHolding(phrase, above);
    if (!c || restedBlockOf(c.text, rests)) continue;
    return { index: c.i, link: c.link === true, above: c.above === true, text: c.text };
  }
  return null;
}

/** A phrase she lingers on or is puzzled by: its reading time at her pace plus a short pause (4 s at most), 1.5 s at least. */
export const UNSURE_REST_MIN_MS = 1_500;
export const UNSURE_REST_MAX_MS = 12_000;
export function unsureRestMs(phrase, { wordsPerMinute, pauseMs = 1_000 } = {}) {
  const wpm = Number(wordsPerMinute) > 0 ? Number(wordsPerMinute) : 200;
  const ms = (wordsOf(phrase).length * 60_000) / wpm + Math.min(4_000, Math.max(0, pauseMs));
  return Math.round(Math.min(UNSURE_REST_MAX_MS, Math.max(UNSURE_REST_MIN_MS, ms)));
}

/** Her thought read at the persona's pace, kept between 2 s and 20 s: the time she takes to think it through. */
export function thinkRestMs(thought, { wordsPerMinute } = {}) {
  const wpm = Number(wordsPerMinute) > 0 ? Number(wordsPerMinute) : 200;
  const ms = (wordsOf(thought).length * 60_000) / wpm;
  return Math.round(Math.min(REST_MAX_MS, Math.max(REST_MIN_MS, ms)));
}

/** The moves for one rest: scroll back up to a reread if the element is above the viewport, then point and rest. */
export function restPlan(match, { thinkMs }) {
  if (!match) return [];
  const steps = [];
  if (match.above) steps.push({ do: "scroll-up", index: match.index });
  steps.push({ do: "point", index: match.index, on: match.link ? "link" : "text" });
  steps.push({ do: "rest", index: match.index, ms: thinkMs });
  return steps;
}

/** The phrase she is unsure about, if it is quoted from the screen she is looking at; otherwise null (never invented). */
export function unsureOnScreen(phrase, screenText) {
  const said = String(phrase ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (said.length < 3 || said.length > 120) return null;
  const page = String(screenText ?? "")
    .replace(/\s+/g, " ")
    .toLowerCase();
  return page.includes(said.toLowerCase()) ? said : null;
}

function collectCandidates(selector) {
  const out = [];
  const height = window.innerHeight;
  document.querySelectorAll(selector).forEach((el, i) => {
    // A pointer left on a control reads as "hovered, did not click": no rest target is ever a control or inside one.
    if (
      el.closest("a, button, [role=button], [role=link], input, select, textarea, label, summary, [onclick], [tabindex], [contenteditable]")
    )
      return;
    const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
    if (text.length < 3 || text.length > 300) return;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0 || r.top >= height) return;
    out.push({ i, text, link: el.matches("a[href], button, [role=button], [role=link]"), above: r.bottom <= 0 });
  });
  return out;
}

/**
 * Find the phrase's own words on the page (in the browser): the text node range that holds them, scrolled to the middle
 * of the viewport when it is out of view, and the spot on it where a pointer would sit. Null when it is not there or
 * something covers it.
 */
function locatePhrase([phrase, probe = false]) {
  const skip = "input, textarea, select, [contenteditable], script, style, noscript";
  const nodes = [];
  let joined = "";
  // Text nodes inside one inline run ("$9.99" then <small>/month</small>) read as one word, as innerText has them.
  const blockOf = (el) => {
    let e = el;
    while (e.parentElement && getComputedStyle(e).display.startsWith("inline")) e = e.parentElement;
    return e;
  };
  let prevBlock = null;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const parent = n.parentElement;
    if (!parent || parent.closest(skip)) continue;
    const style = getComputedStyle(parent);
    if (style.display === "none" || style.visibility === "hidden") continue;
    const block = blockOf(parent);
    if (block !== prevBlock && joined && !joined.endsWith(" ")) joined += " ";
    prevBlock = block;
    nodes.push({ n, start: joined.length });
    joined += n.nodeValue;
  }
  const words = phrase
    .trim()
    .split(/\s+/)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const re = new RegExp(words.join("\\s+"), "gi");
  const at = (offset) => {
    let hit = nodes[0];
    for (const entry of nodes) if (entry.start <= offset) hit = entry;
    return hit ? { node: hit.n, offset: Math.min(hit.n.nodeValue.length, offset - hit.start) } : null;
  };
  const rectOf = (m) => {
    const a = at(m.index);
    const b = at(m.index + m[0].length - 1);
    if (!a || !b) return null;
    const range = document.createRange();
    range.setStart(a.node, a.offset);
    range.setEnd(b.node, Math.min(b.node.nodeValue.length, b.offset + 1));
    const r = [...range.getClientRects()].find((q) => q.width > 0 && q.height > 0);
    return r ? { r, host: a.node.parentElement, range } : null;
  };
  const found = [...joined.matchAll(re)].map(rectOf).filter(Boolean);
  if (!found.length) return null;
  const inView = (r) => r.top >= 0 && r.bottom <= window.innerHeight;
  if (probe) {
    const f = found.find((x) => inView(x.r)) ?? found.find((x) => x.r.top < 0) ?? found[0];
    return { top: f.r.top };
  }
  let pick = found.find((f) => inView(f.r)) ?? found[0];
  if (!inView(pick.r)) {
    pick.host.scrollIntoView({ block: "center", behavior: "instant" });
    const again = [...pick.range.getClientRects()].find((q) => q.width > 0 && q.height > 0);
    if (!again) return null;
    pick = { ...pick, r: again };
  }
  const control = "a, button, [role=button], input, select, textarea, label, summary, [onclick], [tabindex]";
  const hostIsControl = Boolean(pick.host.closest(control));
  const spotOnText = () => {
    const rects = [...pick.range.getClientRects()].filter((q) => q.width > 0 && q.height > 0);
    for (const q of rects.length ? rects : [pick.r]) {
      for (const f of [0.5, 0.25, 0.75]) {
        const x = Math.min(window.innerWidth - 1, Math.max(0, q.left + q.width * f));
        const y = Math.min(window.innerHeight - 1, Math.max(0, (q.top + q.bottom) / 2));
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(pick.host.contains(hit) || hit.contains(pick.host))) continue;
        if (hit.closest(control) && !hostIsControl) continue; // a link beside the words is not the words
        return { x, y };
      }
    }
    return null;
  };
  const spot = spotOnText();
  if (spot) return spot;
  pick.host.scrollIntoView({ block: "center", behavior: "instant" });
  return spotOnText();
}

function scrollToReread([selector, index]) {
  const el = document.querySelectorAll(selector)[index];
  if (el) el.scrollIntoView({ block: "center", behavior: "instant" });
}

function pointAt([selector, index]) {
  const el = document.querySelectorAll(selector)[index];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const control = "a, button, [role=button], [role=link], input, select, textarea, label, summary, [onclick], [tabindex]";
  const y = Math.min(window.innerHeight - 1, Math.max(0, (r.top + r.bottom) / 2));
  for (const f of [0.5, 0.15, 0.3, 0.7, 0.85]) {
    const x = Math.min(window.innerWidth - 1, Math.max(0, r.left + r.width * f));
    const hit = document.elementFromPoint(x, y);
    if (hit && el.contains(hit) && !hit.closest(control)) return { x, y };
  }
  return null;
}

/** True when the block of text is one the look already rested on (the same words, or one holds the other). */
export function restedBlockOf(text, rests) {
  const flat = String(text ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  return (rests ?? []).some((r) => {
    const block = String(r.text).toLowerCase().replace(/\s+/g, " ").trim();
    return block.includes(flat) || flat.includes(block);
  });
}

/**
 * Run the rest on her page. A thought rests on the block holding the words it quotes first, then on the block it names
 * without quotes, never on a block of three words or fewer (a heading, a name or a label). A thought with neither parks
 * her pointer off the text for its thinking time. Returns the real milliseconds she spent on the thought (0 only when
 * the thought is empty or the element was covered or gone), so the caller charges the SUE clock only for what happened.
 * A block the look already rested on is not rested on again: her pointer goes off the text for the same time (one stay
 * there, not a return visit).
 */
export async function restOnThought(page, thought, { wordsPerMinute, maxMs = REST_MAX_MS, rests = [], unsure = null, pauseMs } = {}) {
  if (!thought) return 0;
  if (unsure) {
    const rested = await restOnPhrase(page, unsure, { wordsPerMinute, maxMs, pauseMs, readAs: thought });
    if (rested > 0) return rested;
  }
  const candidates = await page.evaluate(collectCandidates, CANDIDATE_SELECTOR).catch(() => []);
  const thinkMs = Math.min(thinkRestMs(thought, { wordsPerMinute }), maxMs);
  if (thinkMs <= 0) return 0;
  const longBlocks = candidates.filter((c) => wordsOf(c.text).length > MAX_HEADING_WORDS);
  const match = matchQuotedInView(thought, candidates, rests) ?? matchThoughtInView(thought, longBlocks);
  if (!match || restedBlockOf(match.text, rests)) {
    await leaveText(page);
    await page.waitForTimeout(thinkMs).catch(() => {});
    return thinkMs;
  }
  let rested = 0;
  try {
    for (const step of restPlan(match, { thinkMs })) {
      if (step.do === "scroll-up") {
        await page.evaluate(scrollToReread, [CANDIDATE_SELECTOR, step.index]);
      } else if (step.do === "point") {
        const spot = await page.evaluate(pointAt, [CANDIDATE_SELECTOR, step.index]);
        if (!spot) return 0;
        await page.mouse.move(spot.x, spot.y, { steps: 10 });
      } else {
        await page.waitForTimeout(step.ms);
        rested += step.ms;
      }
    }
  } catch {
    // the page closed mid-rest: the visit is ending anyway
  }
  await leaveText(page);
  return rested;
}

/** After a rest her pointer heads off the text, as plain reading's does, so a long wait is never read as a dwell. */
async function leaveText(page) {
  const leave = await page.evaluate(LEAVE_SPOT).catch(() => null);
  if (leave) await page.mouse.move(leave.x, leave.y, { steps: 10 }).catch(() => {});
}

/** She scrolls back up with the wheel to words she read on an earlier screen, until their line is at or below the top edge. */
export async function scrollBackTo(page, phrase) {
  const { width, height } = page.viewportSize() ?? { width: 1280, height: 720 };
  await page.mouse.move(width / 2, height / 2, { steps: 5 }).catch(() => {});
  for (let i = 0; i < 40; i += 1) {
    const at = await page.evaluate(locatePhrase, [phrase, true]).catch(() => null);
    if (!at || at.top >= 0) return;
    await page.mouse.wheel(0, -300);
    await page.waitForTimeout(150);
  }
}

/**
 * She is unsure of this phrase: her pointer goes to the words themselves (wherever they sit in the page, scrolled
 * into view when need be) and stays for the whole rest. Returns the real milliseconds rested, 0 when the words are not
 * there to rest on. `readAs` is the longer text she read before stopping on the phrase (reading time is charged for it).
 */
export async function restOnPhrase(page, phrase, { wordsPerMinute, maxMs = UNSURE_REST_MAX_MS, pauseMs, readAs = phrase } = {}) {
  if (!phrase) return 0;
  const thinkMs =
    readAs === phrase
      ? Math.min(unsureRestMs(phrase, { wordsPerMinute, pauseMs }), maxMs)
      : Math.min(thinkRestMs(readAs, { wordsPerMinute }) + Math.min(4_000, Math.max(0, pauseMs ?? 0)), maxMs);
  if (thinkMs <= 0) return 0;
  let rested = 0;
  try {
    const spot = await page.evaluate(locatePhrase, [phrase]);
    if (!spot) return 0;
    await page.mouse.move(spot.x, spot.y, { steps: 10 });
    await page.waitForTimeout(thinkMs);
    rested = thinkMs;
  } catch {
    // the page closed mid-rest: the visit is ending anyway
  }
  await leaveText(page);
  return rested;
}
