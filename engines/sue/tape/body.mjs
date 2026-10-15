/**
 * tape/body.mjs - a Sue's body with NO browser: she visits a recorded tape (tape/FORMAT.md) instead of the site.
 *
 * What it is: the same MCP surface as body.mjs (`toolSpecs`, one list), the same answers, the same trace.jsonl
 * rows (`traceRow`), the same interview.json and body.json, served from a tape folder. She starts on the
 * manifest's start screen for her device; `look` is perceive(screen.inventory, persona) said through body.mjs's
 * own `lookText`, with screens/<id>.png as her picture; a click or a pick is matched to the screen's control (by
 * the number she was shown, or her words, the way the live body resolves a target) and then to edges.json
 * (device, from, control key, typed variant), whose `to` is her next screen. Her clock is charged exactly as on
 * a live visit (reading, a move 1.5 s, a wait its seconds), so `round.mjs times` stays comparable. The tape's site is
 * shown on HER origin (target.startUrl's), never on the loopback port it was recorded on: every page URL and link she
 * is shown and her trace records is mapped there (`herUrl`); a URL on any other origin is left as it is.
 *
 * The tape is a read-through cache (Lift/docs/TAPE-PANEL.md section 1): a tap with no recorded edge, or onto a screen
 * whose stamp changed, is played LIVE by the tape's recorder (tape/recorder.mjs, one process per tape, started by the
 * first miss; tape/ask.mjs talks to it), which saves the screen and edge as tape/record.mjs writes them. She is
 * answered from the tape as if it had been there, her visit row says `recorded`, and the next Sue making the same move
 * is answered with no browser. This body never writes the tape and never opens a browser.
 *
 * A move that is still not answered (no live site, a screen the recorder cannot reach by replaying her path, a browser
 * that will not start, a typed value no variant matches, a tape that was full, a point at a spot, a key, an address, a
 * tab, a file) leaves her screen as it is, answers as the live body answers a move that changed nothing, and its trace
 * row says `offTape: true` with `offTapeReason` (the recorder's plain reason when it was asked and could not);
 * report.mjs counts them per Sue. What the tape cannot do at all is listed in its spec (tests/tape-body.spec.mjs).
 *
 * Why it exists: a recorded site can be visited by a whole panel in seconds, with no browser and no live server,
 * and a backtest sees how much of each visit the tape covered.
 *
 * Who depends on it: cannon.mjs picks it as her body file under `--tape` (round.mjs start --tape, or a plan's
 * `tape`); lib/body-relay.mjs spawns it over stdio like any body file that is not body.mjs. Depends on body.mjs
 * (its pure exports, never its browser), lib/perception.mjs, lib/clock.mjs, lib/findings.mjs, lib/circles.mjs,
 * tape/record.mjs `loadTape`, tape/pick-edge.mjs, tape/ask.mjs.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { isMainModule } from "../../lib/shared/is-main-module.mjs";
import {
  CLICK_HOWS,
  IDENTITY_FIELDS,
  KEYBOARD_CAME_UP,
  KEYBOARD_WENT_AWAY,
  LEFT,
  NOTE_KINDS,
  OPEN_LIST_CHOICES,
  PICTURE_JPEG,
  STOPPED_BEFORE_DOING_IT,
  TYPED_SAID_MAX,
  WAIT_HOW_LONG,
  clockFacts,
  freshWordsOf,
  lookText,
  optionIndex,
  optionWords,
  pickByWords,
  pictureFrame,
  plainTarget,
  sueAskOf,
  toolSpecs,
  traceRow,
  waitSeconds,
  wrapUpNotice,
} from "../body.mjs";
import { isArtPersona } from "../lib/personas.mjs";
import { moveEnded, moveStarted } from "../lib/activity.mjs";
import { CIRCLE_WINDOW, circleWatch, moveKey, moveLabel, movesThePage, pageFingerprint } from "../lib/circles.mjs";
import { createClock, legsOf } from "../lib/clock.mjs";
import {
  OTP_REQUEST_TEXT,
  areaChange,
  ART_KINDS,
  artNoteExtra,
  attentionNoteExtra,
  birthdayPartFor,
  birthdayPartName,
  codesNotGiven,
  createFindings,
  exitFor,
  exitSentence,
  filedHereAt,
  filedPage,
  fileNote,
  interviewExtras,
  isAdScenario,
  isApeScenario,
  isCaptchaElement,
  isHiddenField,
  isPaymentField,
  journalNudge,
  judgesScreens,
  missedLanding,
  missingInterviewKeys,
  probeForLook,
  probeNoteExtra,
  problemNote,
  readFiled,
  shapeAdInterview,
  shapeApeInterview,
  shapeArtAnswers,
  shapeInterview,
  truthTexts,
  urlAllowed,
} from "../lib/findings.mjs";
import { sawThePage } from "../lib/focus-hands.mjs";
import { HOP_KIND, hopUrl } from "../lib/hop-trace.mjs";
import { createStdioMcpServer } from "../lib/mcp-stdio.mjs";
import { perceive, seenName, seenWords, selectChoices } from "../lib/perception.mjs";
import { railsFor, refusalSentence, refusedBy } from "../lib/rails.mjs";
import { isLiveSite } from "../lib/site-owner.mjs";
import { askRecorder, siteReachable } from "./ask.mjs";
import { pickEdge } from "./pick-edge.mjs";
import { loadTape, originOf, reOrigin, startKeyOf } from "./record.mjs";
import { appendVisit } from "./visits.mjs";

export { pickEdge };

const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const refusal = (value) => ({ content: [{ type: "text", text: String(value) }], isError: true });
const stderrLog = (...parts) => process.stderr.write(`[sue-tape-body] ${parts.join(" ")}\n`);
const NO_PAGE_MOVES = new Set(["note", "give_up", "done", "exit_interview"]);
/** The moves whose touch raises a phone's keyboard when it lands in a box (body.mjs KEYBOARD_RAISERS). */
const KEYBOARD_RAISERS = new Set(["click", "type", "point", "press"]);
const TEXT_BOXES = new Set(["input", "textarea"]);
/** Moves the tape has no recording for: answered as a move that changed nothing, and counted off the tape. */
const OFF_TAPE_MOVES = new Set(["attach", "press", "point", "go_to", "tabs", "rotate", "open_email", "judge_email"]);

/** `sue.json` may carry persona/target/scenario as objects or as ids; ids go through lib/personas.mjs. */
async function hydrate(value, loaderName) {
  if (value && typeof value === "object") return value;
  const personas = await import("../lib/personas.mjs");
  return personas[loaderName](String(value));
}

/**
 * The config the tape was recorded with (`manifest.config.file`): its `stampOf(screen)` (null when it has none), whether it
 * can start the site itself, and where the site is. Null `config` when the tape names no config file.
 */
async function configFor(manifest) {
  const file = manifest.config?.file;
  const mod = file ? await import(pathToFileURL(file).href) : null;
  const config = mod ? (mod.default ?? mod) : null;
  return {
    config,
    stampOf: typeof config?.stampOf === "function" ? config.stampOf : null,
    hasStart: typeof config?.start === "function",
    siteUrl: config?.startUrl ?? manifest.startUrl ?? null,
  };
}

/** A file's size and mtime as one string: changes when the recorder (tape/recorder.mjs) rewrites it. Null when it is not there. */
function signatureOf(file) {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** Which of the tape's devices she is: a phone persona the phone, a 1366-wide target the Chromebook, else the desktop. */
export function tapeDeviceFor(persona, target, manifest) {
  const starts = manifest.starts ?? {};
  const wanted =
    persona?.dials?.device === "phone" ? "phone" : Number(target?.viewport?.width) === 1366 && starts.chromebook ? "chromebook" : "desktop";
  if (starts[wanted]) return wanted;
  const same = Object.keys(starts).find((d) => (manifest.devices?.[d]?.as ?? d) === (wanted === "phone" ? "phone" : "desktop"));
  return same ?? Object.keys(starts)[0];
}

/**
 * The recorded inventory as she sees it scrolled `y` CSS pixels down: every rect and block moves up by `y`,
 * which is exactly what perceive reads to leave out what she scrolled past. A text block's `aboveFold` is its
 * bottom being on screen; a picture block (which carries its `top` too) is on screen when any of it is.
 */
export function scrolledInventory(inventory, y) {
  if (!y) return inventory;
  const h = Number(inventory.viewport?.h) || 0;
  const shifted = (b) => {
    if (typeof b.bottom !== "number") return b;
    const bottom = b.bottom - y;
    if (b.kind === "picture" && typeof b.top === "number") {
      const top = b.top - y;
      return { ...b, top, bottom, aboveFold: top < h && bottom > 0 };
    }
    return { ...b, bottom, aboveFold: bottom > 0 && bottom <= h };
  };
  return {
    ...inventory,
    scroll: { ...(inventory.scroll ?? {}), y: (Number(inventory.scroll?.y) || 0) + y },
    blocks: (inventory.blocks ?? []).map(shifted),
    elements: (inventory.elements ?? []).map((el) =>
      el.rect ? { ...el, rect: { ...el.rect, y: el.rect.y - y }, aboveFold: el.rect.y - y < h && el.rect.y - y + el.rect.h > 0 } : el,
    ),
  };
}

export async function createTapeBody({ sueDir, log = stderrLog }) {
  const sue = JSON.parse(readFileSync(path.join(sueDir, "sue.json"), "utf8"));
  if (!sue.tape) throw new Error("tape body: sue.json has no `tape` folder");
  const maxTurns = Number.isInteger(sue.maxTurns) ? sue.maxTurns : null;
  const chatBrain = sue.brain === "chat";
  const persona = await hydrate(sue.persona, "loadPersona");
  const target = await hydrate(sue.target, "loadTarget");
  const scenario = await hydrate(sue.scenario, "loadScenario");
  const tape = loadTape(path.resolve(sue.tape));
  const tapeDevice = tapeDeviceFor(persona, target, tape.manifest);
  const facts = tape.manifest.devices?.[tapeDevice] ?? {};
  const device = (facts.as ?? tapeDevice) === "phone" ? "phone" : "desktop";
  const identity = sue.identity ?? {};
  const allowedHosts = [...(target.allowedHosts ?? [])];
  const shotsDir = path.join(sueDir, "shots");
  mkdirSync(shotsDir, { recursive: true });
  const findings = createFindings(sueDir);
  // The run's ledger of typed problems, read and written exactly as the live body does (lib/findings.mjs).
  const runDir = path.dirname(sueDir);
  const truths = truthTexts(target, scenario);
  const clock = createClock(persona, { legs: legsOf(scenario) });
  const rails = railsFor({
    refuseClicks: target.refuseClicks,
    borrowed: Boolean(sue.session),
    freeHands: false,
    keepRefuseClicks: Array.isArray(target.sessionParts) && target.sessionParts.length > 0,
    noCommit: target.noCommit === true,
    liveSite: isLiveSite(target),
  });
  const judged = judgesScreens(target, scenario);
  const ad = isAdScenario(scenario);
  const ape = isApeScenario(scenario);
  // A designer (lib/personas.mjs isArtPersona) writes polish and keep lines and answers the team's questions.
  const art = isArtPersona(persona);
  const frame = pictureFrame(facts.viewport ?? { width: 1280, height: 800 }, target.canvas ? 1 : (facts.deviceScaleFactor ?? 1));
  const screens = new Map();
  const screenOf = (id) => {
    if (!screens.has(id)) screens.set(id, tape.screen(id));
    return screens.get(id);
  };
  const { stampOf, hasStart, siteUrl } = await configFor(tape.manifest);
  /**
   * Is this screen's recorded stamp no longer what its files make now? Read fresh every time: a file edited while a round
   * runs makes the very next arrival stale. A stamp the tape holds but no config can compute is an error, not a pass.
   * A screen that looks stale is read again from disk first: the recorder may have re-recorded it since this Sue cached it.
   */
  const isStale = (id) => {
    const stale = (screen) => {
      if (!screen.stamp) return false;
      if (!stampOf) throw new Error(`tape screen ${id} has a stamp but the tape's config (manifest.config.file) gives no stampOf`);
      return stampOf(screen) !== screen.stamp;
    };
    if (!stale(screenOf(id))) return false;
    screens.delete(id);
    pictures.delete(id);
    try {
      return stale(screenOf(id));
    } catch {
      return true; // the screen is gone from the tape: a re-record has replaced it
    }
  };

  /** The edges as the recorder last wrote them: read again when edges.json changes, never otherwise. */
  const edgesFile = path.join(tape.dir, "edges.json");
  const edgesSeen = { signature: signatureOf(edgesFile), edges: tape.edges };
  const edgesNow = () => {
    const signature = signatureOf(edgesFile);
    if (signature !== edgesSeen.signature) {
      try {
        edgesSeen.edges = JSON.parse(readFileSync(edgesFile, "utf8"));
        edgesSeen.signature = signature;
      } catch {
        // the recorder renames a finished file into place, so this is not a half write; keep what we have
      }
    }
    return edgesSeen.edges;
  };

  /** A screen the recorder re-recorded under a new id: the old id, and the id her path leads to now. */
  const aliases = new Map();
  const screenJson = (id) => path.join(tape.dir, "screens", `${id}.json`);
  function canon(id) {
    let current = id;
    for (let hops = 0; aliases.has(current) && hops < 8; hops += 1) current = aliases.get(current);
    if (!id || existsSync(screenJson(current))) return current;
    const pathKey = (screens.get(current) ?? screens.get(id))?.pathKey;
    if (!pathKey) return current;
    try {
      const manifest = JSON.parse(readFileSync(path.join(tape.dir, "manifest.json"), "utf8"));
      const found = Object.entries(manifest.screens ?? {}).find(
        ([known, entry]) => entry.pathKey === pathKey && existsSync(screenJson(known)),
      );
      if (found) {
        aliases.set(current, found[0]);
        return found[0];
      }
    } catch {
      // no manifest to read: the id stays as it was
    }
    return current;
  }
  /** The round this Sue belongs to when her sue.json says (a whole number), else null: never guessed. */
  const round = Number.isInteger(sue.round) ? sue.round : null;
  /** One row per arrival on a screen, into the tape folder every Sue of the round shares. */
  const logVisit = (screenId, how) =>
    appendVisit(tape.dir, {
      round,
      sueId: sue.sueId ?? path.basename(sueDir),
      runId: sue.runId ?? null,
      device: tapeDevice,
      screen: screenId,
      how,
    });

  const noteArrival = (rawId) => {
    const id = canon(rawId);
    const stale = isStale(id);
    logVisit(id, stale ? "stale" : "tape");
    state.staleLogged = stale;
  };

  const state = {
    screenId: null, // her own start, found below once the recorder can be asked for it
    scrollY: 0,
    back: [],
    forward: [],
    /** What she typed per box (control key) and the boxes she ticked on this page: what picks a recorded variant. */
    fills: new Map(),
    checks: new Set(),
    /** The box her last touch left the focus in, and her phone's keyboard. */
    focus: null,
    kbUp: false,
    clickable: new Map(),
    shownAs: new Map(),
    openList: null,
    scrolledSinceLook: false,
    looks: 0,
    toolCalls: 0,
    outcome: null,
    outcomeAt: null,
    finalUrl: null,
    closed: false,
    interviewed: false,
    patienceExhausted: false,
    emailTypedAt: null,
    otpRequestedAt: null,
    codeSubmittedAt: null,
    noted: new Set(),
    circles: circleWatch(),
    lastCircleMove: null,
    sinceNote: 0,
    probesFired: new Set(),
    pendingProbes: [],
    lastLookName: null,
    lastLookText: null,
    filedShown: new Map(),
    areasSeen: new Set(),
    exitsReached: [],
    readUrl: null,
    readKeys: new Set(),
    offTape: 0,
    /** The stale row for the screen she is on is written (once per arrival). */
    staleLogged: false,
  };
  const screen = () => screenOf(state.screenId);
  /**
   * Her own origin: the tape's site is shown to her where the live one stands (target.startUrl), never on the loopback
   * port it was recorded on (a screen keeps its URL and its links on that port; the tape's keys and ids are origin-free).
   */
  const herOrigin = (() => {
    try {
      return originOf(target.startUrl ?? target.url);
    } catch {
      return null;
    }
  })();
  /** A URL on the origin this screen was recorded on, as the same path, query and hash on hers; any other URL as it is. */
  const herUrl = (url) => {
    if (!herOrigin || !url) return url;
    try {
      return reOrigin(url, originOf(screen().url), herOrigin);
    } catch {
      return url;
    }
  };
  const pageUrl = () => (state.screenId ? herUrl(screen().url) : "");
  /**
   * A page-load row (lib/hop-trace.mjs), as the live body writes one. No jar and no page storage on a tape, so the
   * login markers are the empty answer. A server redirect on the way to a page is not on the tape, so it has no hop
   * row here; the load after it is `by: "her"` too, where the live row says `by: "site"`.
   */
  const hopRow = (move) =>
    findings.trace({
      at: new Date().toISOString(),
      kind: HOP_KIND,
      tab: 1,
      url: hopUrl(pageUrl()),
      how: "load",
      by: "her",
      move,
      cxActive: "no",
      cxActiveOn: [],
      sessionKeys: [],
      readMs: 0,
    });
  /** What she sees of the recorded screen: scrolled, with its address bar and every link on her origin. */
  const inventoryNow = () => {
    const inventory = scrolledInventory(screen().inventory, state.scrollY);
    return {
      ...inventory,
      url: herUrl(inventory.url),
      elements: (inventory.elements ?? []).map((el) => (el.href ? { ...el, href: herUrl(el.href) } : el)),
    };
  };
  const elementById = (id) => (inventoryNow().elements ?? []).find((el) => String(el.id) === String(id)) ?? null;
  const controlOf = (el) => (screen().controls ?? []).find((c) => String(c.sueId) === String(el.id) && c.kind !== "choose") ?? null;
  const bodyNote = (kind, textValue, extra) => findings.note({ source: "body", kind, text: textValue, url: pageUrl(), extra });
  const noteOnce = (kind, textValue, extra) => {
    const key = `${kind}::${pageUrl()}`;
    if (state.noted.has(key)) return;
    state.noted.add(key);
    bodyNote(kind, textValue, extra);
  };
  const patienceGone = () => {
    if (!state.patienceExhausted)
      bodyNote("patience-exhausted", "patience gone; every further tool answers: call give_up", {
        visitSeconds: Math.round(clock.elapsedSeconds()),
      });
    state.patienceExhausted = true;
  };
  const noteCircling = (circled, move) => {
    if (!circled) return null;
    const control = move ? moveLabel(move) : null;
    noteOnce(
      "going-in-circles",
      circled.why === "page-unchanged"
        ? `the page did not change across ${circled.times} of her moves${control ? ` (last: ${control})` : ""}`
        : circled.why === "cycle"
          ? `she went back and forth between ${circled.cycle.map(moveLabel).slice(0, -1).join(", ")} and ${moveLabel(circled.cycle.at(-1))} ${circled.times} times`
          : `the same move ${circled.times} times in her last ${CIRCLE_WINDOW} on one page: ${control}`,
      { why: circled.why, times: circled.times, control },
    );
    return circled.nudge;
  };
  /** A move the tape has no answer for: her screen stays, and her trace row says why. */
  const offTape = (result, reason) => ({ ...result, _offTape: reason });

  /** She is on `id` now: a new URL is a new page (attention refilled, the area change said), as body.mjs pageChangeSaid. */
  function arriveAt(rawId, { remember = true } = {}) {
    const id = canon(rawId);
    const before = pageUrl();
    if (remember && id !== state.screenId) {
      state.back.push({ id: state.screenId, scrollY: state.scrollY });
      state.forward = [];
    }
    const changedScreen = id !== state.screenId;
    state.screenId = id;
    if (changedScreen) {
      state.scrollY = 0;
      state.focus = null;
    }
    const after = pageUrl();
    if (after === before) return changedScreen ? " The page changed." : "";
    state.fills = new Map();
    state.checks = new Set();
    state.openList = null;
    clock.newPage();
    const moved = areaChange(before, after);
    if (!moved) return " The page changed.";
    const seenBefore = state.areasSeen.has(moved.to);
    state.areasSeen.add(moved.from);
    state.areasSeen.add(moved.to);
    bodyNote("sent-to-another-area", `${moved.from} -> ${moved.to}${seenBefore ? " (she had been there already)" : ""}`, {
      from: moved.from,
      to: moved.to,
      returning: seenBefore,
    });
    return ` The page changed. ${moved.sentence}`;
  }

  /** The picture of this screen at the size she is told: screens/<id>.png, shrunk or grown to `frame`, as jpeg. */
  const pictures = new Map();
  async function screenshot() {
    state.looks += 1;
    const file = path.join(shotsDir, `look-${String(state.looks).padStart(4, "0")}.jpg`);
    if (!pictures.has(state.screenId)) {
      let buffer = null;
      try {
        const { default: sharp } = await import("sharp");
        buffer = await sharp(readFileSync(path.join(tape.dir, "screens", `${state.screenId}.png`)))
          .resize(frame.width, frame.height, { fit: "fill" })
          .jpeg(PICTURE_JPEG)
          .toBuffer();
      } catch (err) {
        log("no picture for", state.screenId, err?.message ?? err);
      }
      pictures.set(state.screenId, buffer);
    }
    const buffer = pictures.get(state.screenId);
    if (buffer) writeFileSync(file, buffer);
    return {
      file: buffer ? file : null,
      base64: buffer ? buffer.toString("base64") : null,
      hash: buffer ? createHash("sha1").update(buffer).digest("hex") : null,
    };
  }

  /** body.mjs resolveTarget over the recorded screen: her number from the last look, or her words. */
  function resolveTarget(rawTarget) {
    const targetArg = plainTarget(rawTarget);
    if (
      (typeof rawTarget === "string" || typeof rawTarget === "number") &&
      !/^\s*\[\d+\]\s*$/.test(String(rawTarget)) &&
      /^\d+$/.test(String(targetArg)) &&
      state.openList &&
      state.openList.url === pageUrl()
    ) {
      const list = elementById(state.openList.id);
      if (list && list.role === "select" && optionIndex(selectChoices(list), String(targetArg)) != null)
        return { el: list, label: `"${seenName(list)}"`, choice: String(targetArg) };
    }
    if (typeof targetArg === "number" || /^\d+$/.test(String(targetArg))) {
      const n = Number(targetArg);
      const id = state.clickable.get(n);
      if (id == null) return { error: `There is no [${n}] in what you last saw. Call look first.` };
      const el = elementById(id);
      if (!el) return { error: `[${n}] is not on the page any more. Call look again.` };
      const was = state.shownAs.get(n);
      if (was != null && seenName(el) !== was) return { error: `[${n}] "${was}" is not on the page any more. Call look again.` };
      if (el.behindOverlay)
        return {
          error: `[${n}] "${seenName(el)}" is behind "${String(el.behindOverlay).slice(0, 80)}" now - deal with that first (finish it or close it), then try again.`,
        };
      const offScreen =
        state.scrolledSinceLook && el.rect && (el.rect.y + el.rect.h <= 0 || el.rect.y >= (inventoryNow().viewport?.h ?? 0));
      if (offScreen)
        return { error: `[${n}] "${was ?? seenName(el)}" is not on your screen now: you have scrolled since you last looked. Call look.` };
      return { el, label: `[${n}]` };
    }
    const wanted = String(targetArg ?? "")
      .trim()
      .toLowerCase();
    if (!wanted) return { error: "Say which element: a number from your last look, or its text." };
    const seen = (inventoryNow().elements ?? []).filter((candidate) => !candidate.hidden);
    const reachable = seen.filter((candidate) => !candidate.behindOverlay);
    const found = (el) => ({ el, label: `"${seenName(el)}"` });
    const hasChoice = (candidate) => candidate.role === "select" && optionIndex(selectChoices(candidate), String(targetArg)) != null;
    const open = state.openList;
    const openList =
      open && open.url === pageUrl()
        ? reachable.find((c) => String(c.id) === String(open.id) && c.role === "select" && c.name === open.name)
        : null;
    if (openList && hasChoice(openList)) return found(openList);
    const pick = pickByWords(seen, wanted);
    if (pick?.el) return found(pick.el);
    const lists = reachable.filter(hasChoice);
    if (lists.length === 1) return found(lists[0]);
    if (lists.length > 1) {
      const numberOf = (id) => [...state.clickable].find(([, shown]) => String(shown) === String(id))?.[0] ?? null;
      const named = lists.map((list) => `${numberOf(list.id) != null ? `[${numberOf(list.id)}] ` : ""}"${seenName(list)}"`).join(", ");
      return {
        error: `"${targetArg}" is a choice in more than one drop-down list: ${named}. Click the list you mean first (by its number), then click "${targetArg}" and it goes into that list.`,
      };
    }
    if (pick?.blocked)
      return { error: `"${targetArg}" is behind "${String(pick.blocked).slice(0, 80)}" - deal with that dialog first, then click it.` };
    return { error: `Nothing on the page says "${targetArg}". Call look and pick a number.` };
  }

  /** body.mjs railStop: a robot check, a box she cannot see, card details, and lib/rails.mjs. */
  function railStop(el, label, what, { passive = false } = {}) {
    if (isCaptchaElement(el)) {
      noteOnce("captcha-challenge", `${what} was aimed at the robot check (${el.name}) - refused, never solved`);
      return { ...refusal(`${label} is a robot check. You cannot do that here; look for another way, or give_up.`), _refused: "captcha" };
    }
    if (isHiddenField(el))
      return { ...refusal(`${label} is not a thing you can see. Call look and pick a visible one.`), _refused: "hidden-field" };
    if (passive) return null;
    if (TEXT_BOXES.has(el.role) && isPaymentField(el))
      return { ...refusal(`${label} asks for card details. You never type those here.`), _refused: "payment-field" };
    const railed = refusedBy(rails, el.name, { role: el.role, href: el.href, submits: el.submits === true });
    if (!railed) return null;
    noteOnce(`refused-${railed}`, `${what} on ${label} "${String(el.name ?? "").slice(0, 80)}" was refused by the ${railed} rail`);
    return { ...refusal(refusalSentence(railed, label)), _refused: railed };
  }

  function absoluteHref(href) {
    if (!href) return null;
    try {
      return new URL(String(href), pageUrl() || target.startUrl).href;
    } catch {
      return String(href);
    }
  }

  function reachExit(url, how) {
    const exit = exitFor(url, target.exits);
    if (!exit) return null;
    if (!state.exitsReached.includes(exit.id)) {
      state.exitsReached.push(exit.id);
      bodyNote("reached-exit", `${exit.name || exit.id} (${how})`, { exit: exit.id, href: String(url).slice(0, 300) });
    }
    return exitSentence(exit);
  }

  /** The live site's answer, asked at most every 30 s: a tape whose site is down is answered off the tape, as it always was. */
  const liveSite = { siteUp: null, siteAt: 0, noBrowserAt: 0 };
  async function siteIsUp() {
    if (liveSite.siteUp === null || Date.now() - liveSite.siteAt > 30_000) {
      liveSite.siteUp = Boolean(siteUrl) && (await siteReachable(siteUrl, 2_000));
      liveSite.siteAt = Date.now();
    }
    return liveSite.siteUp;
  }

  /**
   * The screen she begins on: the tape's start for her own target URL (made relative to its origin, so the live demo's
   * and the tape's copy of the same seat are one start). A start the tape does not have is a miss: the recorder opens it
   * on its own origin and saves it. Throws a plain error when it cannot, since she has nowhere to begin.
   */
  async function startScreenId() {
    const byUrl = () => tape.manifest.starts?.[tapeDevice] ?? {};
    const given = target.startUrl ?? target.url;
    const key = given ? startKeyOf(given) : null;
    if (key === null) {
      const only = Object.values(byUrl());
      if (only.length === 1) return only[0];
      throw new Error("tape body: the target names no start URL (target.startUrl) and the tape has more than one start");
    }
    if (byUrl()[key]) return byUrl()[key];
    if (!hasStart && !(await siteIsUp()))
      throw new Error(`tape body: the tape has no start ${key} on ${tapeDevice} and its site is not answering to record it`);
    const reply = await askRecorder(tape.dir, {
      device: tapeDevice,
      start: key,
      round,
      sueId: sue.sueId ?? path.basename(sueDir),
      runId: sue.runId ?? null,
    });
    if (!reply.ok)
      throw new Error(`tape body: the tape has no start ${key} on ${tapeDevice} and the recorder could not record it (${reply.reason})`);
    tape.manifest = loadTape(tape.dir).manifest;
    const id = byUrl()[key] ?? reply.screen;
    if (!id) throw new Error(`tape body: the recorder recorded start ${key} but the tape does not list it`);
    return id;
  }

  /** Why the tape cannot answer her tap (`no-edge`, `typed-no-variant`, `stale`), or null when it can. */
  function tapeMiss(controlKey) {
    if (isStale(state.screenId)) return "stale";
    const picked = pickEdge(edgesNow(), {
      device: tapeDevice,
      from: state.screenId,
      control: controlKey,
      fills: state.fills,
      checks: state.checks,
    });
    if (!picked.edge) return picked.reason;
    // an edge with no target (a tap nothing took, a dropped screen, a way off the site) is a recorded answer
    return picked.edge.to != null && isStale(picked.edge.to) ? "stale" : null;
  }

  /**
   * Her tap is a miss: ask the tape's recorder to play it live and save it (tape/read-through.mjs). Null when the tape
   * answers it, or there is no live site to ask; else the recorder's reply (`{ ok: true, recorded, from, to }` or
   * `{ ok: false, reason }`), after which the tape she reads is the one the recorder wrote.
   */
  async function goLive(controlKey) {
    state.screenId = canon(state.screenId);
    const reason = tapeMiss(controlKey);
    if (!reason) return null;
    if (!hasStart && !(await siteIsUp())) return null;
    if (liveSite.noBrowserAt && Date.now() - liveSite.noBrowserAt < 30_000) return { ok: false, reason: "no-browser" };
    const reply = await askRecorder(tape.dir, {
      device: tapeDevice,
      from: state.screenId,
      fromPath: screen().pathKey,
      control: controlKey,
      fills: [...state.fills],
      checks: [...state.checks],
      reason,
      round,
      sueId: sue.sueId ?? path.basename(sueDir),
      runId: sue.runId ?? null,
    });
    if (!reply.ok) {
      if (reply.reason === "no-browser") liveSite.noBrowserAt = Date.now();
      log("tape miss not played live:", reply.reason, reply.detail ?? "");
      return reply;
    }
    edgesSeen.signature = null;
    if (reply.from !== state.screenId) aliases.set(state.screenId, reply.from);
    state.screenId = reply.from;
    for (const id of [reply.from, reply.to]) {
      screens.delete(id);
      pictures.delete(id);
    }
    return reply;
  }

  /**
   * Her tap on a recorded control: the edge it took on the recording, or off the tape with why. `said` is the
   * live body's sentence for the tap, `label` how she named it, `el` what she tapped. A tap the tape cannot answer is
   * played live first (`played`: the recorder's reply when the caller already asked, null when it found nothing to ask).
   */
  async function take(controlKey, { said, label, el, suffix = " Call look to see what happened." }, played = undefined) {
    const answer = played === undefined ? await goLive(controlKey) : played;
    const whyNot = (reason) => (answer && !answer.ok ? answer.reason : reason);
    const here = state.screenId;
    if (isStale(here)) {
      if (!state.staleLogged) logVisit(here, "stale");
      state.staleLogged = true;
      return offTape(text(`${said}${suffix}`), whyNot("stale"));
    }
    const picked = pickEdge(edgesNow(), { device: tapeDevice, from: here, control: controlKey, fills: state.fills, checks: state.checks });
    const edge = picked.edge;
    if (edge && edge.to == null && edge.error && !edge.dropped)
      return refusal(`You tried ${label} but nothing would take the click (${edge.error}). Call look.`);
    clock.charge({ actions: 1 });
    if (!edge || edge.dropped || edge.to == null) {
      logVisit(here, "no-edge");
      return offTape(text(`${said}${suffix}`), whyNot(!edge ? picked.reason : edge.dropped ? "tape-full" : "no-edge"));
    }
    if (isStale(edge.to)) {
      logVisit(edge.to, "stale");
      return offTape(text(`${said}${suffix}`), whyNot("stale"));
    }
    logVisit(edge.to, answer?.ok && answer.recorded ? "recorded" : "tape");
    state.staleLogged = false;
    if (state.emailTypedAt && OTP_REQUEST_TEXT.test(String(el.name ?? ""))) state.otpRequestedAt = Date.now();
    return text(`${said}${arriveAt(edge.to)}${suffix}`);
  }

  function recordOutcome(outcome) {
    state.outcome = outcome;
    state.outcomeAt = new Date().toISOString();
    state.finalUrl = pageUrl();
    const pattern = missedLanding({ outcome, url: state.finalUrl, scenario, target });
    if (pattern) bodyNote("wrong-destination", `ended at ${state.finalUrl}, expected ${pattern.source}`, { expected: pattern.source });
  }

  function bodyState() {
    return {
      sueId: sue.sueId,
      device,
      browserMode: "tape",
      sharedBrowser: false,
      tape: tape.dir,
      tapeDevice,
      offTape: state.offTape,
      outcome: state.outcome,
      outcomeAt: state.outcomeAt,
      finalUrl: state.finalUrl ?? pageUrl(),
      interviewed: state.interviewed,
      toolCalls: state.toolCalls,
      looks: state.looks,
      emailTypedAt: state.emailTypedAt ? new Date(state.emailTypedAt).toISOString() : null,
      otpRequestedAt: state.otpRequestedAt ? new Date(state.otpRequestedAt).toISOString() : null,
      doorRefusedAt: null,
      codeSubmittedAt: state.codeSubmittedAt ? new Date(state.codeSubmittedAt).toISOString() : null,
      emailsOpened: 0,
      emailsJudged: [],
      firstInboxCheckAt: null,
      otpEmailLatencyMs: null,
      patienceExhausted: state.patienceExhausted,
      exitsReached: state.exitsReached,
      clock: clockFacts(clock),
    };
  }

  async function shutdown() {
    if (state.closed) return;
    state.closed = true;
    try {
      writeFileSync(path.join(sueDir, "body.json"), `${JSON.stringify(bodyState(), null, 2)}\n`, "utf8");
    } catch (err) {
      log("body.json not written:", err?.message ?? err);
    }
  }

  /** A box her touch left the focus in raises a phone's keyboard; any other touch, or a new screen, takes it down. */
  function focusOn(el) {
    state.focus = el && TEXT_BOXES.has(el.role) ? String(el.id) : null;
  }

  const handlers = {
    async look() {
      const inventory = inventoryNow();
      const view = perceive(inventory, persona);
      state.clickable =
        view.clickable instanceof Map ? view.clickable : new Map(Object.entries(view.clickable ?? {}).map(([k, v]) => [Number(k), v]));
      state.shownAs = new Map([...state.clickable].map(([n, id]) => [n, seenName(elementById(id))]));
      state.scrolledSinceLook = false;
      if (state.readUrl !== pageUrl()) {
        state.readUrl = pageUrl();
        state.readKeys = new Set();
      }
      clock.read(freshWordsOf(view, state.readKeys));
      const interactiveAbove = (inventory.elements ?? []).filter((el) => el.aboveFold && !el.hidden && !el.disabled);
      if (interactiveAbove.length === 0) noteOnce("dead-end", "nothing to click above the fold");
      const circleNudge = noteCircling(
        state.circles.page(pageFingerprint(pageUrl(), (inventory.elements ?? []).length, view.text)),
        state.lastCircleMove,
      );
      if (view.stats?.tinyText > 0)
        noteOnce("tiny-text", `${view.stats.tinyText} text nodes below ${persona.dials?.legibleMinPx}px`, { count: view.stats.tinyText });
      if (view.stats?.overHead > 0)
        noteOnce("reading-grade-over-head", `${view.stats.overHead} blocks above grade ${persona.dials?.readingGrade}`, {
          count: view.stats.overHead,
        });
      if (inventory.captcha?.present && inventory.captcha.interactive)
        noteOnce("captcha-challenge", `${inventory.captcha.kind ?? "captcha"} challenge shown - never solved`, {
          kind: inventory.captcha.kind ?? null,
        });
      const shot = await screenshot();
      state.lastLookName = shot.file ? path.basename(shot.file) : null;
      state.lastLookText = view.text;
      clock.picture(shot.hash, { canvas: Boolean(target.canvas) });
      const mood = clock.state();
      const moodLine = mood === "bored" || mood === "exhausted" ? clock.mood() : "";
      if (mood === "bored") noteOnce("bored", "attention spent on this page without a click");
      if (mood === "exhausted") patienceGone();
      const filedHere = filedHereAt({ runDir, sueId: path.basename(sueDir), url: pageUrl(), shown: state.filedShown, truths });
      const body = lookText(view.text, { keyboardUp: state.kbUp, mood, moodLine, circleNudge, filedHere, frame });
      const content = [];
      if (shot.base64) content.push({ type: "image", data: shot.base64, mimeType: "image/jpeg" });
      content.push({ type: "text", text: body });
      return { content, _screenshot: shot.file, _shotHash: shot.hash, _pageText: view.text, _filedHere: filedHere };
    },

    async click({ target: targetArg, how = "click", onto }) {
      const hand = String(how ?? "click").toLowerCase();
      if (!CLICK_HOWS.includes(hand)) return refusal(`how is one of: ${CLICK_HOWS.join(", ")}.`);
      if (hand === "drag" && (onto == null || onto === ""))
        return refusal("Say where to drop it: onto, a number from your last look or its words.");
      const found = resolveTarget(targetArg);
      if (found.error) return refusal(found.error);
      const { el, label, choice } = found;
      const stopped = railStop(el, label, "a click", { passive: hand === "hover" });
      if (stopped) return stopped;
      const href = absoluteHref(el.href);
      if (href && !urlAllowed(href, allowedHosts) && hand !== "hover") {
        const handedOff = hand === "click" || hand === "double-click" ? reachExit(href, `a click on ${label}`) : null;
        if (handedOff) {
          clock.charge({ actions: 1 });
          return { ...text(`You clicked ${label} "${seenName(el)}". ${handedOff}`), _refused: "exit" };
        }
        bodyNote("left-site", `a ${hand === "click" ? "click" : hand} on ${label} would have gone to ${href} - refused`, { href });
        return {
          ...refusal(
            `${label} goes to a different website. ${hand === "click" || hand === "double-click" ? "You stay here." : "You leave it alone and stay here."}`,
          ),
          _refused: "off-host",
        };
      }
      if (hand !== "click") {
        clock.charge({ actions: 1 });
        const name = `${label} "${seenName(el)}"`;
        const did = {
          "double-click": `You double-clicked ${name}.`,
          "right-click": `You right-clicked ${name}.`,
          hover: `You rested the pointer on ${name} without clicking.`,
          drag: `You dragged ${name}.`,
        }[hand];
        return offTape(text(`${did} Call look to see what happened.`), `click-${hand}`);
      }
      if (el.disabled) {
        clock.charge({ actions: 1 });
        return text(`${label} is greyed out, so pressing it does nothing yet. Call look.`);
      }
      const control = controlOf(el);
      if (el.role === "select") {
        const wanted = choice ?? optionWords(targetArg);
        const choiceRailed = wanted ? refusedBy(rails, wanted, { role: "select" }) : null;
        if (choiceRailed) {
          noteOnce(`refused-${choiceRailed}`, `a pick of "${wanted.slice(0, 80)}" in ${label} was refused by the ${choiceRailed} rail`);
          return { ...refusal(refusalSentence(choiceRailed, `"${wanted}"`)), _refused: choiceRailed };
        }
        const choices = selectChoices(el);
        const index = wanted
          ? optionIndex(
              choices.map((c) => ({ label: c, value: c })),
              wanted,
            )
          : null;
        if (index != null) return pickChoice(el, control, choices[index]);
        state.openList = { id: el.id, name: el.name, url: pageUrl() };
        const said = choices.slice(0, OPEN_LIST_CHOICES).map((c) => `"${c}"`);
        if (choices.length > OPEN_LIST_CHOICES) said.push("...");
        const example = choices.find((c) => c !== el.selected) ?? choices[0];
        return text(
          `${label} is a drop-down list${el.selected ? ` showing "${el.selected}"` : ""}. ${
            choices.length
              ? `You open it. Its choices: ${said.join(", ")}. Pick one by clicking its words, for example click "${example}", and it goes into this list.`
              : "It has no choices in it."
          }`,
        );
      }
      state.openList = null;
      const said = `You clicked ${label} "${seenName(el)}".`;
      if (control?.role === "checkbox" || el.role === "checkbox") {
        if (state.checks.has(control?.key)) state.checks.delete(control?.key);
        else if (control) state.checks.add(control.key);
      }
      focusOn(el);
      if (!control || control.kind === "field") {
        // A box takes her tap and the focus; nothing on the recording moves for it.
        clock.charge({ actions: 1 });
        return control
          ? text(`${said} Call look to see what happened.`)
          : offTape(text(`${said} Call look to see what happened.`), "not-recorded");
      }
      if (control.kind === "leaves") {
        clock.charge({ actions: 1 });
        return offTape(text(`${said} Call look to see what happened.`), "leaves");
      }
      return take(control.key, { said, label, el });
    },

    async type({ target: targetArg, text: textArg, field }) {
      const found = resolveTarget(targetArg);
      if (found.error) return refusal(found.error);
      const { el, label } = found;
      if (isHiddenField(el))
        return { ...refusal(`${label} is not a box you can see. Call look and pick a visible one.`), _refused: "hidden-field" };
      if (isPaymentField(el))
        return { ...refusal(`${label} asks for card details. You never type those here.`), _refused: "payment-field" };
      if (String(el.inputType ?? "").toLowerCase() === "file")
        return refusal(`${label} is for picking a file from your computer, not for typing. Use attach with one of your files.`);
      const control = controlOf(el);
      let value = textArg;
      let secret = false;
      if (field != null) {
        const sub = substitute(String(field), control);
        if (sub.error) return refusal(sub.error);
        value = sub.value;
        secret = Boolean(sub.secret);
      }
      if (value == null || value === "") return refusal("Give me `text` to type, or a `field` such as my-email.");
      if (field == null && target.mailbox?.kind !== "none" && codesNotGiven(String(value), sue.errand).length)
        return refusal("Do not type the code yourself. Use field: the-code-from-my-email and the body will read it out of your inbox.");
      const birthdayPart = field === "my-birthday" ? birthdayPartName(el, String(value)) : null;
      if (field === "my-birthday") value = birthdayPartFor(el, String(value));
      if (isCaptchaElement(el)) {
        noteOnce("captcha-challenge", `typing was aimed at the robot check (${el.name}) - refused, never solved`);
        return { ...refusal(`${label} is a robot check. You never fill it in; look for another way, or give_up.`), _refused: "captcha" };
      }
      if (el.role === "select") {
        const choiceRailed = refusedBy(rails, String(value), { role: "select" });
        if (choiceRailed) {
          noteOnce(
            `refused-${choiceRailed}`,
            `typing "${String(value).slice(0, 80)}" into ${label} was refused by the ${choiceRailed} rail`,
          );
          return { ...refusal(refusalSentence(choiceRailed, `"${value}"`)), _refused: choiceRailed };
        }
        const choices = selectChoices(el);
        const index = optionIndex(
          choices.map((c) => ({ label: c, value: c })),
          String(value),
        );
        if (index == null) return refusal(`You could not type into ${label} (no option "${value}"). Call look.`);
        return pickChoice(el, control, choices[index], { typed: true });
      }
      if (!control || control.kind !== "field") {
        clock.charge({ actions: 1 });
        return offTape(
          refusal(`${label} "${seenName(el)}" is not a box to type in, so your typing went nowhere. Call look.`),
          "type-on-a-control",
        );
      }
      clock.charge({ actions: 1 });
      if (field === "my-email") state.emailTypedAt = Date.now();
      if (field === "the-code-from-my-email" && state.codeSubmittedAt == null) state.codeSubmittedAt = Date.now();
      state.fills.set(control.key, String(value));
      if (el.role === "textarea") el.filled = String(value);
      focusOn(el);
      const said = String(value);
      const shown = secret
        ? "the code from your email"
        : birthdayPart
          ? `the ${birthdayPart} of your birthday, "${said}",`
          : field
            ? `your ${String(field).replace(/^my-/, "").replace(/-/g, " ")}`
            : `"${said.length > TYPED_SAID_MAX ? `${said.slice(0, TYPED_SAID_MAX)}..." (and the rest of what you typed)` : `${said}"`}`;
      return text(`You typed ${shown} into ${label} "${seenName(el)}".`);
    },

    async scroll({ direction }) {
      const dir = String(direction ?? "down").toLowerCase();
      if (!["down", "up", "top"].includes(dir)) return refusal("Scroll down, up, or to the top.");
      const recorded = screen().inventory;
      const max = Math.max(0, Number(recorded.scroll?.max) || 0);
      const h = Number(recorded.viewport?.h) || 0;
      const step = Math.round(h * 0.9);
      state.scrollY = dir === "top" ? 0 : Math.max(0, Math.min(max, state.scrollY + (dir === "up" ? -step : step)));
      clock.charge({ actions: 1 });
      state.scrolledSinceLook = true;
      const where =
        max === 0
          ? " There is nothing more to scroll."
          : state.scrollY >= max
            ? " You are at the bottom."
            : state.scrollY === 0
              ? " You are at the top."
              : "";
      return text(`You scrolled ${dir === "top" ? "to the top" : dir}.${where} Call look.`);
    },

    async go_back() {
      if (state.kbUp) {
        state.focus = null;
        clock.charge({ actions: 1 });
        return text("You put your keyboard away. Call look.");
      }
      clock.charge({ actions: 1 });
      const prior = state.back.pop();
      if (!prior) return text("There is nowhere to go back to.");
      state.forward.push({ id: state.screenId, scrollY: state.scrollY });
      const changed = arriveAt(prior.id, { remember: false });
      if (changed) noteArrival(prior.id);
      state.scrollY = prior.scrollY;
      return text(changed ? "You went back. Call look." : "There is nowhere to go back to.");
    },

    async go_forward() {
      clock.charge({ actions: 1 });
      const next = state.forward.pop();
      if (!next) return text("There is nowhere to go forward to.");
      state.back.push({ id: state.screenId, scrollY: state.scrollY });
      const changed = arriveAt(next.id, { remember: false });
      if (changed) noteArrival(next.id);
      return text(changed ? "You went forward. Call look." : "There is nowhere to go forward to.");
    },

    async reload() {
      clock.charge({ actions: 1 });
      state.scrollY = 0;
      return text("You reloaded the page. Call look.");
    },

    async wait({ seconds }) {
      const secs = waitSeconds(seconds);
      if (secs == null) return { ...refusal(WAIT_HOW_LONG), _refused: "no-seconds" };
      clock.charge({ waitMs: secs * 1000 });
      return text(`You waited ${secs} second${secs === 1 ? "" : "s"}.`);
    },

    async check_email() {
      clock.charge({ actions: 1 });
      return { ...text("Your inbox is empty. Nothing new."), _mail: 0 };
    },

    async attach({ file }) {
      return offTape(refusal(`Your file "${String(file ?? "")}" cannot be put into this page here. Call look.`), "attach");
    },
    async press({ key }) {
      clock.charge({ actions: 1 });
      return offTape(text(`You pressed ${String(key ?? "").trim() || "Space"}. Call look.`), "press");
    },
    async point({ action = "click", x, y }) {
      clock.charge({ actions: 1 });
      return offTape(
        text(`You did ${action} at ${Math.round(Number(x) || 0)},${Math.round(Number(y) || 0)}. Call look to see what happened.`),
        "point",
      );
    },
    async go_to() {
      return offTape(refusal("You can only go where this page takes you here. Call look and pick something on it."), "go_to");
    },
    async tabs({ action = "list" }) {
      const title = screen().title || "a page with no title";
      if (String(action).toLowerCase() === "list")
        return offTape(text(`You have 1 tab open:\n[1] ${title} (the one you are looking at)`), "tabs");
      return offTape(refusal("That is your only tab; closing it would end your visit. Call give_up if you are leaving."), "tabs");
    },
    async rotate() {
      clock.charge({ actions: 1 });
      return offTape(text("Your phone stays upright here. Call look."), "rotate");
    },
    async open_email() {
      return offTape(refusal("Call check_email first to see what is in your inbox."), "open_email");
    },
    async judge_email() {
      return offTape(refusal("Say which email by its number from your last check_email."), "judge_email");
    },

    async note({ kind, text: line, why, fix, severity, problem, same }) {
      const k = String(kind ?? "thought").toLowerCase();
      if (!NOTE_KINDS.has(k) && !(art && ART_KINDS.includes(k)))
        return refusal(`kind must be one of: ${[...NOTE_KINDS, ...(art ? ART_KINDS : [])].join(", ")}.`);
      const designed = art ? artNoteExtra({ kind: k, why, fix, severity, seconds: clock.elapsedSeconds() }) : null;
      if (designed?.refused) return refusal(designed.refused);
      const decided = problemNote({
        kind: k,
        problem,
        same,
        ledger: readFiled(runDir),
        page: filedPage(pageUrl()),
        look: state.lastLookName,
        screenText: state.lastLookText,
      });
      if (decided.refused) return refusal(decided.refused);
      const probe = probeNoteExtra(state.pendingProbes.shift());
      const attention = attentionNoteExtra({ kind: k, why, fix, severity, seconds: clock.elapsedSeconds() });
      const extra = probe || attention || designed ? { ...probe, ...attention, ...designed } : null;
      const { said } = fileNote({ findings, sueDir, decided, kind: k, text: line, url: pageUrl(), extra });
      return text(said);
    },

    async give_up({ why }) {
      findings.note({ source: "brain", kind: "gave-up", text: String(why ?? ""), url: pageUrl() });
      recordOutcome("gave-up");
      return text("You are leaving. Now call exit_interview and answer every question.");
    },

    async done({ what }) {
      findings.note({ source: "brain", kind: "done", text: String(what ?? ""), url: pageUrl() });
      recordOutcome("done");
      return text("Good. Now call exit_interview and answer every question.");
    },

    async exit_interview(answers) {
      const missing = missingInterviewKeys(answers, judged, ad, ape).filter((k) => !(k === "whyStopped" && state.outcome === "done"));
      if (missing.length) return refusal(`Please also answer: ${missing.join(", ")}. Send every answer in one exit_interview call.`);
      if (!state.outcome) recordOutcome("interviewed");
      const extras = interviewExtras(scenario, judged, ad, ape).map(([key]) => key);
      const unseen = !sawThePage(sueDir);
      const shapedAsGiven = ape ? shapeApeInterview(answers, extras) : ad ? shapeAdInterview(answers, extras) : shapeInterview(answers, extras, judged);
      const shaped = art ? shapeArtAnswers(shapedAsGiven) : shapedAsGiven;
      writeFileSync(
        path.join(sueDir, "interview.json"),
        `${JSON.stringify({ ...shaped, ...(unseen ? { unseen: true } : {}) }, null, 2)}\n`,
        "utf8",
      );
      state.interviewed = true;
      await shutdown();
      return text(`Thank you. ${LEFT}`);
    },
  };

  /** A choice of a drop-down: its recorded `choose` move, said the way the live body says a pick. */
  async function pickChoice(el, control, option, { typed = false } = {}) {
    state.openList = null;
    if (control) state.fills.set(control.key, option);
    const said = typed
      ? `You typed "${option}" into "${seenName(el)}".`
      : `You picked "${option}" from the list${seenWords(el) && seenWords(el) !== option ? ` "${seenWords(el)}"` : ""}.`;
    const chooseKey = control ? `${control.key}=${option}` : null;
    let recorded =
      Boolean(chooseKey) && edgesNow().some((e) => e.device === tapeDevice && e.from === state.screenId && e.control === chooseKey);
    let played;
    if (!recorded && chooseKey && (screen().controls ?? []).some((c) => c.kind === "choose" && c.key === chooseKey)) {
      played = await goLive(chooseKey);
      recorded = Boolean(played?.ok);
    }
    if (!recorded) {
      clock.charge({ actions: 1 });
      return offTape(text(`${said}${typed ? "" : " Call look."}`), played && !played.ok ? played.reason : "no-edge");
    }
    return take(chooseKey, { said, label: `"${seenName(el)}"`, el, suffix: typed ? "" : " Call look." }, played);
  }

  /** Her identity for `field:`; the code from her email is the one the recording typed into this box. */
  function substitute(fieldName, control) {
    switch (fieldName) {
      case "my-email":
        return { value: identity.email };
      case "my-phone":
        return { value: identity.phone ?? target.identityPhone };
      case "my-first-name":
        return { value: identity.firstName };
      case "my-last-name":
        return { value: identity.lastName };
      case "my-full-name":
        return { value: identity.fullName ?? `${identity.firstName ?? ""} ${identity.lastName ?? ""}`.trim() };
      case "my-birthday":
        return { value: identity.birthdate };
      case "the-code-from-my-email": {
        const typed = control
          ? edgesNow()
              .filter((e) => e.device === tapeDevice && e.from === state.screenId)
              .flatMap((e) => e.typed ?? [])
              .find((t) => t.key === control.key && t.value != null)
          : null;
        if (typed) return { value: typed.value, secret: true };
        return { error: "There is no code in your email yet. Call check_email, or wait a little and try again." };
      }
      default:
        return { error: `Unknown field "${fieldName}". Use one of: ${[...IDENTITY_FIELDS].join(", ")}.` };
    }
  }

  function wrap(name, run) {
    const move = async (args = {}, batch = null) => {
      const startedAt = Date.now();
      // Her turns are counted as on a live visit (body.mjs wrap): a chat brain's notes and SUE's asks are free.
      if (!(chatBrain && name === "note")) state.toolCalls += 1;
      let result;
      if (state.closed) result = text(LEFT);
      else if (state.outcome && name !== "exit_interview" && name !== "note")
        result = refusal(
          `You said you were ${state.outcome === "done" ? "finished" : "leaving"}. Call exit_interview now, with every answer.`,
        );
      else if (clock.state() === "exhausted" && !["give_up", "done", "exit_interview", "note"].includes(name)) {
        patienceGone();
        result = refusal(`${clock.mood()} ${STOPPED_BEFORE_DOING_IT}`);
      } else {
        try {
          const kbWasUp = state.kbUp;
          const screenBefore = state.screenId;
          const urlBefore = pageUrl();
          const circleKey = moveKey(name, args, state.shownAs);
          result = await run(args ?? {});
          if (pageUrl() !== urlBefore) hopRow(name);
          if (circleKey && !result.isError) {
            if (movesThePage(circleKey)) state.lastCircleMove = circleKey;
            const circleNudge = noteCircling(state.circles.move(circleKey), circleKey);
            if (circleNudge) result = { ...result, content: [...result.content, { type: "text", text: circleNudge }] };
          }
          if (device === "phone" && !NO_PAGE_MOVES.has(name)) {
            if (state.screenId !== screenBefore || !state.focus) state.kbUp = false;
            else if (KEYBOARD_RAISERS.has(name) && !result.isError && state.focus) state.kbUp = true;
            if (name !== "go_back" && state.kbUp !== kbWasUp)
              result = {
                ...result,
                content: [...result.content, { type: "text", text: state.kbUp ? KEYBOARD_CAME_UP : KEYBOARD_WENT_AWAY }],
              };
          }
        } catch (err) {
          log(name, "threw:", err?.stack ?? err);
          result = refusal(`Something went wrong in your hands (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
        }
      }
      if (chatBrain && sueAskOf(result)) state.toolCalls -= 1;
      if (!result.isError && !state.closed) {
        const probe = probeForLook({
          url: pageUrl(),
          looks: state.looks,
          arrived: Boolean(target.arrival),
          canvas: Boolean(target.canvas),
          scenario,
          fired: state.probesFired,
        });
        if (probe) {
          state.probesFired.add(probe.id);
          state.pendingProbes.push({ id: probe.id, url: pageUrl() });
          result = { ...result, content: [...result.content, { type: "text", text: probe.text }] };
        }
      }
      if (name === "note") state.sinceNote = 0;
      else if (!["exit_interview", "done", "give_up"].includes(name)) state.sinceNote += 1;
      const nudge = journalNudge(state.sinceNote);
      if (nudge && !result.isError) result = { ...result, content: [...result.content, { type: "text", text: nudge }] };
      const wrapUp = state.closed || state.outcome ? "" : wrapUpNotice(state.toolCalls, maxTurns);
      if (wrapUp && !["done", "give_up", "exit_interview"].includes(name)) {
        if (!state.wrapUpNoted) bodyNote("turns-nearly-out", `${maxTurns - state.toolCalls} moves left of ${maxTurns}; told to wrap up`);
        state.wrapUpNoted = true;
        result = { ...result, content: [...result.content, { type: "text", text: wrapUp }] };
      }
      const offTapeReason = result._offTape ?? (OFF_TAPE_MOVES.has(name) ? name : null);
      if (offTapeReason) state.offTape += 1;
      const row = traceRow(name, args, result, {
        ms: Date.now() - startedAt,
        clock,
        url: pageUrl(),
        title: state.closed ? "" : (screen().title ?? ""),
      });
      findings.trace({ ...row, ...(offTapeReason ? { offTape: true, offTapeReason } : {}), ...(batch ? { batch } : {}) });
      return result.isError ? { content: result.content, isError: true } : { content: result.content };
    };
    return async (given = {}) => {
      // The relay's `do` names its batch in `_batch`; the row carries it as it is written (lib/body-relay.mjs runDo).
      const { _batch: batch = null, ...args } = given ?? {};
      moveStarted(sueDir, name);
      try {
        return await move(args, batch);
      } finally {
        moveEnded(sueDir);
      }
    };
  }

  const tools = toolSpecs(device, { interview: scenario?.interview, judged, art }).map(([name, description, inputSchema]) => ({
    name,
    description,
    inputSchema,
    handler: wrap(name, handlers[name]),
  }));
  state.screenId = await startScreenId();
  noteArrival(state.screenId);
  hopRow("arrive");
  writeFileSync(path.join(sueDir, "ready"), `${new Date().toISOString()}\n`, "utf8");
  log(`${sue.sueId ?? path.basename(sueDir)} ready on tape ${tape.dir}: ${tapeDevice}, start ${state.screenId}`);
  return {
    sueId: sue.sueId ?? path.basename(sueDir),
    device,
    tools,
    shutdown,
    screenId: () => state.screenId,
    lastInventory: () => inventoryNow(),
  };
}

function sueDirFromArgv(argv) {
  const at = argv.indexOf("--sue");
  const dir = at >= 0 ? argv[at + 1] : null;
  if (!dir) throw new Error("usage: node tape/body.mjs --sue <sueDir>");
  return path.resolve(dir);
}

/** The standalone tape body: one Sue, her MCP over this process's stdio, gone when her brain closes stdin. */
async function main() {
  const body = await createTapeBody({ sueDir: sueDirFromArgv(process.argv.slice(2)) });
  const server = createStdioMcpServer({
    name: "sue",
    version: "1.0.0",
    tools: body.tools,
    onClose: async () => {
      stderrLog("stdin closed; the brain is gone");
      await body.shutdown();
      process.exit(0);
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, async () => {
      await body.shutdown();
      process.exit(0);
    });
  }
  server.start();
}

if (isMainModule(import.meta.main, import.meta.url)) {
  main().catch((err) => {
    stderrLog("fatal:", err?.stack ?? err);
    process.exit(1);
  });
}
