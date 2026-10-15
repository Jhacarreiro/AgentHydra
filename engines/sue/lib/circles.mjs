/**
 * circles - is she going round in circles?
 * =========================================
 * What it is: `circleWatch` keeps her last CIRCLE_WINDOW moves on the page, each reduced to a
 * `moveKey` (the same control pressed, the same words typed in any order, the same address), and a
 * fingerprint of every page a look showed her (`pageFingerprint`: the address, how many things are
 * on it, and a 16-character SHA-256 of the words she read). It answers three questions after each:
 *
 *   - the same move again: the 5th, 8th and 12th time one move, on the page her last look showed,
 *     is in her last 20 (`REPEAT_STEPS`);
 *   - back and forth: her last moves are a run of 2 to 4 moves repeated whole (A B A B, A B C A B C),
 *     reported when the run has gone round 2, 3 and 4 times (`CYCLE_STEPS`), so a Sue toggling between
 *     two controls is nudged at her 4th move, not her 9th. The same-move answer wins when both fire;
 *   - a page that does not move: the 5th, 8th and 12th look in a row that shows the same page as the
 *     one before it although she made a move on it in between that should change it: a click, a
 *     point, a key, an address (`UNCHANGED_STEPS`). A look after only typing, attaching or scrolling,
 *     or after no move at all, is her filling in or reading, never counted.
 *
 * Each answer carries a nudge in her own words that grows firmer, and never blocks the move.
 *
 * Why it exists: a visitor who presses the same button five times, or whose page does not change
 * across five moves, is telling us about the site - a button that does nothing, a form that silently
 * rejects what she typed. SUE filed dead-end, bored and captcha findings but had no signal for this,
 * so a Sue could spend her whole turn budget on one broken control and the report said nothing.
 * The body files it as `going-in-circles` with the control and the address.
 *
 * Adapted from browser-use browser_use/agent/views.py ActionLoopDetector (MIT, Copyright (c) 2024
 * Gregor Zunic). Adapted for Connections SUE: written fresh for her moves and her perceived page.
 * Cycle detection adapted from tester-army/e2e packages/e2e/src/agent/loop-guards.ts (Apache-2.0,
 * Copyright TesterArmy): written fresh for her moves.
 */
import { createHash } from "node:crypto";

export const CIRCLE_WINDOW = 20;
export const REPEAT_STEPS = [5, 8, 12];
export const UNCHANGED_STEPS = [5, 8, 12];
export const CYCLE_STEPS = [2, 3, 4];
export const MAX_CYCLE_PERIOD = 4;

/** The moves that act on the page. Reading, her diary, her inbox and leaving are never circling. */
const CIRCLE_MOVES = new Set(["click", "type", "press", "point", "attach", "scroll", "go_to", "go_back", "go_forward", "reload"]);

/**
 * The moves she makes expecting the page to change. Typing, attaching and scrolling are not: a typed
 * value is not in the words her look reads, so five filled fields would read as one unchanged page,
 * and scrolling a short page is only her reading.
 */
const PAGE_MOVES = new Set(["click", "press", "point", "go_to", "go_back", "go_forward", "reload"]);

/** Whether a `moveKey` is a move she expects to change the page (`PAGE_MOVES`). */
export const movesThePage = (key) => PAGE_MOVES.has(String(key ?? "").split("|")[0]);

const squash = (value) =>
  String(value ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
const sortedWords = (value) => squash(value).split(" ").filter(Boolean).sort().join(" ");

/**
 * Her numbered target read as the control she SAW (`shownAs`, number -> name), so pressing the same
 * button after a new look renumbered it is still the same move. Words she named stay her words.
 */
function controlOf(target, shownAs) {
  const numbered = /^\s*\[?(\d+)\]?\s*$/.exec(String(target ?? ""));
  if (numbered) {
    const seen = shownAs?.get?.(Number(numbered[1]));
    return seen ? squash(seen) : `#${numbered[1]}`;
  }
  return squash(target);
}

/**
 * One move as a comparable key, or null for a move that is not on the page. Click by the control
 * she saw, typing by its words in any order, a spot in her picture to a 20-pixel square, go_to by
 * the whole address.
 */
export function moveKey(name, args = {}, shownAs = null) {
  if (!CIRCLE_MOVES.has(name)) return null;
  const a = args ?? {};
  switch (name) {
    case "click":
      return `click|${squash(a.how || "click")}|${controlOf(a.target, shownAs)}|${a.onto == null ? "" : controlOf(a.onto, shownAs)}`;
    case "type":
      return `type|${controlOf(a.target, shownAs)}|${a.field ? `field:${squash(a.field)}` : sortedWords(a.text)}`;
    case "attach":
      return `attach|${squash(a.file)}|${a.target == null ? "" : controlOf(a.target, shownAs)}`;
    case "press":
      return `press|${squash(a.key)}`;
    case "point":
      return `point|${squash(a.action)}|${Math.round(Number(a.x) / 20)}|${Math.round(Number(a.y) / 20)}`;
    case "scroll":
      return `scroll|${squash(a.direction)}`;
    case "go_to":
      return `go_to|${String(a.address ?? "").trim()}`;
    default:
      return name;
  }
}

/**
 * A move key fit for a finding: the words she typed are dropped (they can be her own details) and
 * an address keeps no query or fragment (it can carry a sign-in token), as the trace keeps it.
 */
export function moveLabel(key) {
  const text = String(key ?? "");
  if (text.startsWith("type|")) return text.split("|").slice(0, 2).join("|");
  if (text.startsWith("go_to|")) return text.replace(/[?#].*$/, "");
  return text;
}

/** The page as she saw it: address, how many things on it, and a short hash of its words. */
export function pageFingerprint(url, elementCount, text) {
  const hash = createHash("sha256")
    .update(String(text ?? ""))
    .digest("hex")
    .slice(0, 16);
  return `${String(url ?? "")}|${Number(elementCount) || 0}|${hash}`;
}

/**
 * The back-and-forth her last moves end in, or null: the shortest run of 2 to MAX_CYCLE_PERIOD moves
 * that her moves repeat whole, and how many times round (`times`). A run that is itself one move
 * repeated (A A) or a shorter run twice (A B A B as a run of 4) is not a run of its own length, so
 * A B A B reads as A B twice, never as anything longer.
 */
function cycleOf(keys) {
  for (let period = 2; period <= MAX_CYCLE_PERIOD; period += 1) {
    if (keys.length < period * 2) break;
    const run = keys.slice(-period);
    const shorter = [];
    for (let d = 1; d < period; d += 1) if (period % d === 0) shorter.push(d);
    if (shorter.some((d) => run.every((k, i) => k === run[i % d]))) continue;
    let repeated = 0;
    for (let i = keys.length - 1; i - period >= 0 && keys[i] === keys[i - period]; i -= 1) repeated += 1;
    const span = repeated + period;
    if (span % period === 0 && span / period >= 2) return { period, times: span / period };
  }
  return null;
}

/** What her hands say, firmer each step. `times` is the count that crossed a step. */
export function circlesNudge(why, times) {
  if (why === "cycle") {
    return [
      `You keep going back and forth between the same things (${times} times now). Maybe that is not the way: try something different.`,
      `${times} times round the same few moves. It is not getting you anywhere: try another way, or write down what is wrong.`,
      `${times} times round the same moves. A person would stop here: try a different way, or give_up.`,
    ][times >= 4 ? 2 : times >= 3 ? 1 : 0];
  }
  const firm = times >= 12 ? 2 : times >= 8 ? 1 : 0;
  if (why === "page-unchanged") {
    return [
      `The page has looked the same after your last ${times} moves. Maybe it is not taking what you do: try something different.`,
      `Still the same page after ${times} moves. Whatever you are doing here is not moving you on: try another way, or write down what is wrong.`,
      `${times} moves and this page has not changed at all. A person would stop here: try a different way, or give_up.`,
    ][firm];
  }
  return [
    `You have now done that same thing ${times} times and it does not seem to get you anywhere. Maybe try something different.`,
    `That is ${times} times the same thing. It is not working: try another way, or write down what is wrong.`,
    `${times} times the same thing. A person would stop here: try a different way, or give_up.`,
  ][firm];
}

/**
 * One visit's watch. `move(key)` after each move she made on the page, `page(fingerprint)` after
 * each look; each returns `{ why, times, nudge }` when a step is crossed, else null. A back-and-forth
 * also carries `cycle`, the move keys of one round in the order she made them.
 *
 * A repeat counts on the page she last looked at: "Next" pressed through five different steps of a
 * form, or through a carousel she watches change, is moving on, not circling. Scrolling is reading
 * down a page, never a repeat. Only a move that should change the page (`movesThePage`) counts for
 * the unchanged-page question: filling a form field by field, looking after each, is not circling.
 */
export function circleWatch({
  window = CIRCLE_WINDOW,
  repeatSteps = REPEAT_STEPS,
  unchangedSteps = UNCHANGED_STEPS,
  cycleSteps = CYCLE_STEPS,
} = {}) {
  const recent = [];
  const recentMoves = [];
  let lastPage = null;
  let unchanged = 0;
  let actedSinceLook = false;
  return {
    move(moved) {
      if (!moved) return null;
      if (movesThePage(moved)) actedSinceLook = true;
      if (moved.startsWith("scroll|")) return null;
      const key = `${moved}@${lastPage ?? ""}`;
      recent.push(key);
      recentMoves.push(moved);
      if (recent.length > window) {
        recent.shift();
        recentMoves.shift();
      }
      const times = recent.filter((k) => k === key).length;
      if (repeatSteps.includes(times)) return { why: "same-move", times, nudge: circlesNudge("same-move", times) };
      const cycle = cycleOf(recent);
      return cycle && cycleSteps.includes(cycle.times)
        ? { why: "cycle", times: cycle.times, nudge: circlesNudge("cycle", cycle.times), cycle: recentMoves.slice(-cycle.period) }
        : null;
    },
    page(fingerprint) {
      const acted = actedSinceLook;
      actedSinceLook = false;
      if (fingerprint !== lastPage) {
        lastPage = fingerprint;
        unchanged = 0;
        return null;
      }
      if (!acted) return null;
      unchanged += 1;
      return unchangedSteps.includes(unchanged)
        ? { why: "page-unchanged", times: unchanged, nudge: circlesNudge("page-unchanged", unchanged) }
        : null;
    },
  };
}
