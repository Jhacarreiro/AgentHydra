#!/usr/bin/env node
/**
 * body - ONE MCP server, ONE browser, ONE person
 * ===============================================
 * What it is: the per-Sue body from SPEC.md. The Claude CLI that is her brain launches this file as
 * `node body.mjs --sue <sueDir>` through her `mcp.json`; it reads `<sueDir>/sue.json`, opens a
 * persistent Chromium profile at her persona's viewport, and serves the tools in SPEC.md's table
 * over stdio (`toolSpecs` below is the one list): `look`, `click` (and double-click, right-click,
 * hover, drag onto), `type`, `attach` (one of her own files, through a page's file picker), `press`
 * (any key, Ctrl/Shift/Alt held), `point`, `scroll`, `go_back`,
 * `go_forward`, `reload`, `go_to`, `tabs`, `wait`, `check_email`, `note`, `give_up`, `done`,
 * `exit_interview` - the hands a first-time person has in a browser, on every target (the owner,
 * 2026-09-21). Her eyes are `lib/perception.mjs` (the dials decide what she is handed), her
 * patience is `lib/clock.mjs`, her diary is `lib/findings.mjs`, her rails are `lib/rails.mjs`.
 * A focus-group Sue (`focusGroup: true` in sue.json) also has `room`, `say` and `vote`, and hears
 * the others between her moves: `lib/focus-hands.mjs` (Owner, 2026-09-23).
 *
 * Why it exists: every persona number has to change something MECHANICAL, and this is where it
 * does. The brain never sees a selector, a URL it did not type, our code, or a dial as a number;
 * it sees `[3] a small picture button with no words` and a clock that is running out. The body also
 * holds the whole sandbox (SPEC.md § Rails): it refuses hidden fields, payment fields, CAPTCHA
 * widgets and any host outside the target's allow-list, substitutes her REAL identity for `field:`
 * so the brain never has to remember it, and reads the sign-in code out of her real inbox without
 * ever printing it. Because the body enforces all of that, her tool calls need no permission prompt.
 *
 * Who depends on it: `sue/cannon.mjs` (writes `sue.json`, waits on `<sueDir>/ready` for a
 * stampede, reads `interview.json` / `findings.jsonl` / `trace.jsonl` / `body.json` afterwards),
 * `sue/reap.mjs` (reopens the same profile dir to delete the account), `sue/report.mjs`.
 *
 * Plain node v22 ESM, NEVER bun: bun hangs Playwright's chromium launch on this box
 * (`.arkitect/runners/flow-walk.mjs` header). Chromium comes from the arkitect's ONE resolver.
 * Logs ONLY to stderr - stdout is the JSON-RPC channel.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { chromium, devices } from "playwright-core";

import { resolveChromiumPath } from "../lib/shared/browser-launch.mjs";
import { moveEnded, moveStarted } from "./lib/activity.mjs";
import { CIRCLE_WINDOW, circleWatch, moveKey, moveLabel, movesThePage, pageFingerprint } from "./lib/circles.mjs";
import { createClock, legsOf } from "./lib/clock.mjs";
import { inboxFactsFor } from "./lib/inbox-facts.mjs";
import { fillMerge } from "./lib/inbox-test.mjs";
import { INBOX_HOST, installInboxPage, isInboxUrl, messageIdOf, messageUrl, phoneBuzz } from "./lib/inbox-page.mjs";
import {
  BROWSER_LOST_TEXT,
  BROWSER_REOPENED,
  OTP_REQUEST_TEXT,
  SUE_BROWSER_LOST,
  SUE_DOOR_REFUSED,
  ATTENTION_KINDS,
  ART_KINDS,
  ART_NOTE_ADDENDUM,
  addressMailDir,
  areaChange,
  artNoteExtra,
  attentionNoteExtra,
  birthdayPartFor,
  birthdayPartName,
  birthdayAsTyped,
  browserArgsFor,
  browserModeFor,
  codesNotGiven,
  createFindings,
  echoesHttpError,
  exitFor,
  isSignedOutRefresh,
  exitSentence,
  filedHereAt,
  filedPage,
  fileNote,
  interviewExtras,
  interviewKeys,
  isAdScenario,
  isApeScenario,
  isCaptchaElement,
  isHiddenField,
  isPaymentField,
  journalNudge,
  judgesScreens,
  missedLanding,
  siteUrlOf,
  missingInterviewKeys,
  probeForLook,
  productMail,
  inboxBody,
  probeNoteExtra,
  problemNote,
  readFiled,
  readInbox,
  receivedAgo,
  sanitizeArgs,
  seedArrival,
  seedDecoys,
  shapeAdInterview,
  shapeApeInterview,
  shapeArtAnswers,
  shapeInterview,
  singleCode,
  startUrlFor,
  sueDoorRefused,
  truthTexts,
  urlAllowed,
} from "./lib/findings.mjs";
import { createStdioMcpServer } from "./lib/mcp-stdio.mjs";
import { createRest } from "./lib/rest.mjs";
import { createSlowWaitJudge } from "./lib/slow-waits.mjs";
import {
  FOCUS_LEFT_PAGE,
  FOCUS_OUT_OF_TIME,
  ROOM_MOVES,
  createFocusHands,
  sawThePage,
  focusToolSpecs,
  seatNameFor,
  withBiggestProblem,
} from "./lib/focus-hands.mjs";
import {
  CAPTCHA_FRAME,
  armMenuWatch,
  fieldAt,
  goToVerdict,
  keyPressTargets,
  keysNamed,
  noteSeen,
  railsFor,
  readHold,
  readKey,
  readMenuWatch,
  refusalSentence,
  refusedBy,
  refusedKey,
  spotUnder,
  urlsIn,
} from "./lib/rails.mjs";
import { readSessions } from "./lib/sessions.mjs";
import { isLiveSite } from "./lib/site-owner.mjs";
import { endVisit, scrollLikeAReader } from "./lib/reader-motion.mjs";
import {
  keepPageFocused,
  LEAVE_SPOT,
  PACE_DIALS,
  paceWaitMs,
  readingModeOf,
  restWhileReading,
  screenOnly,
  seededRandom,
  weighMs,
} from "./lib/reading-pace.mjs";
import {
  REST_ON_TEXT_KINDS,
  restedBlockOf,
  restOnPhrase,
  restOnThought,
  scrollBackTo,
  unsureOnScreen,
  wordsOf,
} from "./lib/rest-on-text.mjs";
import { createHopTrace } from "./lib/hop-trace.mjs";
import { createPageTrace } from "./lib/page-trace.mjs";
import { ARGUS_PIXEL_HOST_PATTERN, learnArgusRow, readArgusIds } from "./lib/argus-ids.mjs";
import { PHONE_ONLY_TOOLS, isArtPersona, knownAddressesOf, networkConditionsFor, timezoneFor } from "./lib/personas.mjs";
import { installSignupDoor, readSueSignupKey } from "./lib/signup-door.mjs";
import { installSueMarker } from "./lib/sue-marker.mjs";
import { trackTextChanges, waitForTextToSettle } from "./lib/text-settle.mjs";
import {
  parsePickerInput,
  pickerDidNotUnderstand,
  pickerKind,
  pickerOpenedSentence,
  pickerSetSentence,
  setPickerValue,
} from "./lib/date-picker.mjs";
import { INVENTORY_SCRIPT, perceive, seenName, seenWords, selectChoices } from "./lib/perception.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

/**
 * A phone Sue holds a REAL phone: Playwright's own registry entry for a Pixel 7, with its Android
 * Chrome user agent, screen, pixel density and touch, so a site that asks what it is talking to hears
 * one consistent answer (until 2026-09-22 she was a 390x844 window announcing desktop Windows Chrome).
 * Android because Chromium IS Android's browser. An iPhone Sue needs WebKit, the engine every iPhone
 * browser runs (Chrome included), which is a separate browser install.
 */
const PHONE = "Pixel 7";
// ARGUS (infra/shared/analytics/bot-user-agent.ts PROBE_UA) reads this token as "a SUE visitor, not a customer".
const SUE_UA_TOKEN = "ConnectionsSUE/1";
const PHONE_SIDEWAYS = devices[`${PHONE} landscape`].viewport;
const VIEWPORTS = { phone: devices[PHONE].viewport, desktop: { width: 1440, height: 900 } };
/**
 * Her phone's on-screen keyboard, in CSS pixels: a Gboard with its suggestion strip, upright and
 * sideways. It comes up when SHE taps or types into a text box and covers the bottom of her screen,
 * the way it does on every phone (Owner, 2026-09-22: "typing into a keyboard brings up the text
 * box, which we need").
 */
const KEYBOARD = { upright: 330, sideways: 190 };
/** The hands that can bring the keyboard up: the ones that touch or type. */
const KEYBOARD_RAISERS = new Set(["click", "type", "point", "press"]);

/** A picture of her keyboard, `width` x `height` device pixels: QWERTY rows, the way Gboard looks. */
function keyboardSvg(width, height) {
  const strip = Math.round(height * 0.14);
  const gap = Math.max(2, Math.round(width * 0.012));
  const rowH = (height - strip - gap * 5) / 4;
  const keyW = (width - gap * 11) / 10;
  const key = (x, y, w, label) =>
    `<rect x="${x}" y="${y}" width="${w}" height="${rowH}" rx="${Math.round(rowH * 0.15)}" fill="#ffffff"/>` +
    `<text x="${x + w / 2}" y="${y + rowH * 0.66}" font-family="Arial, sans-serif" font-size="${Math.round(rowH * (label.length > 1 ? 0.3 : 0.45))}" text-anchor="middle" fill="#202124">${label}</text>`;
  const keys = [];
  ["qwertyuiop", "asdfghjkl", "zxcvbnm"].forEach((letters, row) => {
    const y = strip + gap + row * (rowH + gap);
    const lead = row === 1 ? keyW / 2 : row === 2 ? keyW * 1.5 + gap : 0;
    [...letters].forEach((ch, i) => keys.push(key(gap + lead + i * (keyW + gap), y, keyW, ch)));
    if (row === 2) keys.push(key(gap, y, keyW * 1.5, "shift"), key(width - gap - keyW * 1.5, y, keyW * 1.5, "del"));
  });
  const y = strip + gap + 3 * (rowH + gap);
  keys.push(
    key(gap, y, keyW * 1.5, "?123"),
    key(gap * 2 + keyW * 1.5, y, keyW, ","),
    key(gap * 3 + keyW * 2.5, y, keyW * 5 + gap * 4, ""),
    key(gap * 8 + keyW * 7.5, y, keyW, "."),
    key(gap * 9 + keyW * 8.5, y, keyW * 1.5 + gap, "go"),
  );
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="#e8eaed"/>${keys.join("")}</svg>`;
}
/**
 * A `canvas: true` target is PLAYED, not read: its board is pixels with no buttons in them. Every
 * target has `point` and the whole keyboard now; a canvas one also gets a picture that is 1:1 with
 * the page: CSS-pixel shots, and a 1280x800 desktop, the largest a model is shown without being
 * shrunk (1440x900 arrives about 4% smaller).
 */
const CANVAS_DESKTOP = { width: 1280, height: 800 };
/** A target's own `viewport` ({width, height}) sizes a desktop screen (the tape's 1366x768 Chromebook); none, as before. */
export const viewportFor = (device, target) =>
  device === "desktop" && target?.viewport ? target.viewport : target?.canvas && device === "desktop" ? CANVAS_DESKTOP : VIEWPORTS[device];
const POINTER_ACTIONS = [
  "click",
  "double-click",
  "right-click",
  "hold",
  "hold-right-click",
  "drag",
  "right-drag",
  "zoom-in",
  "zoom-out",
  "hover",
];
/** Pointer actions that press nothing, so a numbered thing under them needs no `click`. */
const PASSIVE_POINTER = new Set(["hover", "zoom-in", "zoom-out"]);
/** What `click` can do to a numbered thing: the hand's element-level moves. */
export const CLICK_HOWS = ["click", "double-click", "right-click", "hover", "drag"];
/** How many choices opening a drop-down says; a person scrolls a long list, and 60 covers a language picker. */
export const OPEN_LIST_CHOICES = 60;
const TEXT_BOXES = new Set(["input", "textarea"]);
/**
 * The input types that take what a person types: the only inputs a `type` tap fallback may land on.
 * An input[type=submit|button|reset|image] still wears role `input` (perception.mjs) but the tap
 * PRESSES it, so it is refused like any other control, where no click rail would run.
 */
const TEXT_INPUT_TYPES = new Set([
  "text",
  "search",
  "email",
  "url",
  "tel",
  "password",
  "number",
  "date",
  "datetime-local",
  "month",
  "week",
  "time",
]);

/**
 * The largest picture a brain is shown WITHOUT being shrunk (Anthropic's documented limits: a
 * 1568-pixel long edge, about 1.15 megapixels). A bigger one is shrunk on the way in, and every spot
 * she names in it would miss by that much, so the body shrinks it first and knows the exact size.
 */
const BRAIN_PICTURE = { longEdge: 1568, pixels: 1_150_000 };
/**
 * A computer screen's picture (one picture pixel per CSS pixel) is capped lower still: 1280 on the
 * long side, so a 1440x900 screen is handed as 1280x800 and a 1280x800 canvas game stays exactly 1:1.
 * Measured 2026-09-24 on a text-heavy help page (tests/pictures.spec.mjs): 1356x847 was 84 KB (112k
 * base64 characters, ~1531 image tokens); 1280x800 through PICTURE_JPEG is 54 KB (72k, ~1365), and
 * its 11 px footnotes still read (the owner that day: hundreds of Sues, as cheaply as possible). A
 * phone's device-scale picture keeps the brain's own limits above.
 */
const SCREEN_PICTURE_LONG_EDGE = 1280;
/** How every picture the body makes is encoded: mozjpeg at the same quality is ~30% smaller for the same look (same measurement). */
export const PICTURE_JPEG = { quality: 55, mozjpeg: true };

/**
 * Chrome's own failed-load page (`chrome-error://chromewebdata/`), which a timed-out or refused
 * navigation leaves up. It is the website failing to answer, never a Sue leaving it: it must never
 * be filed as `left-site`, nor read as a blank `dead-end`.
 */
export function isLoadFailureUrl(url) {
  return String(url ?? "").startsWith("chrome-error:");
}

/**
 * The start page, tried once more when the first try fails: one timeout used to end the whole visit,
 * because the body set its `navigated` flag before the goto, so no tool ever tried the front door
 * again and the resulting error page was filed as a Sue who left the site (finding
 * sue-body-start-never-retried). `goto` is `page.goto(startUrl, ...)`; returns the last error, or
 * null once it loaded. Never more than `attempts` (default two), so a down site costs two timeouts,
 * not one per move.
 */
export async function openStartPage(goto, attempts = 2) {
  let lastError = null;
  for (let tryNumber = 0; tryNumber < attempts; tryNumber += 1) {
    try {
      await goto();
      return null;
    } catch (err) {
      lastError = err;
    }
  }
  return lastError;
}

/**
 * A target the way she wrote it, made the way the page knows it: `"Get started"` (quoted, as she
 * reads it in a look), `[6]` (the number as a look prints it) and `Get started` are one button.
 * Live run 20260922-055009-dd24: "quoting the button name broke it, had to drop the quotes".
 */
export function plainTarget(target) {
  if (typeof target !== "string") return target;
  let t = target.trim();
  const bracketed = /^\[(\d+)\]$/.exec(t);
  if (bracketed) return bracketed[1];
  const quotes = /^["'“‘](.*)["'”’]$/s.exec(t);
  if (quotes && quotes[1].trim()) t = quotes[1].trim();
  return t;
}

/**
 * Which of HER files she means (`files`: the names the cannon copied into her folder): the exact
 * name, else the one name that matches with case ignored, quotes and any folder she typed dropped.
 * `{ name }`, or `{ error }` in her words naming what she does have. Only a name on her own list is
 * ever returned, so no path she types can reach anything outside her folder.
 */
export function pickHerFile(files, wanted) {
  const mine = (files ?? []).filter((name) => typeof name === "string" && name);
  const said = String(plainTarget(wanted ?? "") ?? "").trim();
  const bare = said.split(/[\\/]/).pop() ?? "";
  if (!mine.length) return { error: "You have no files of your own on this computer, so there is nothing to attach." };
  if (!bare) return { error: `Say which of your files: ${mine.join(", ")}.` };
  if (mine.includes(bare)) return { name: bare };
  const alike = mine.filter((name) => name.toLowerCase() === bare.toLowerCase());
  if (alike.length === 1) return { name: alike[0] };
  return { error: `You do not have a file called "${bare}". Your files: ${mine.join(", ")}.` };
}

/**
 * Runs IN THE PAGE (`locator.evaluate(isRichTextBox)`): a box a framework editor draws itself - a
 * contenteditable block or a [role=textbox] - rather than a native input or textarea. Discord's
 * composer is one: Playwright's fill() puts the words in the DOM without a key event, the editor's
 * own state stays empty, and Enter sends nothing (run 20260922-113917-5468, sue-3398-mod-teen).
 */
export function isRichTextBox(node) {
  if (!node || /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)) return false;
  return node.isContentEditable === true || String(node.getAttribute("role") ?? "").toLowerCase() === "textbox";
}

/**
 * The rail `type`'s last-resort TAP meets when `fill()` will not take the words. The tap only puts
 * the keyboard in a box for her keys, so it is allowed on a text box alone: any other role - a button,
 * a link, a checkbox, a drop-down - is refused, because a tap there PRESSES the control, and a tap is
 * not a click, so none of a click's rails (destructive, session, real-change, off-host) would run.
 * A robot check is refused even in a text box, and so is a control that leaves the site. The whole of
 * `railStop` is never reused here: its real-change rail would refuse typing into a text box on a
 * borrowed account. The rail's name, or null when the tap is allowed. `href` is the element's address
 * already made absolute against the page she is on.
 */
export function typeTapRail(el, { href = null, allowedHosts = [] } = {}) {
  const role = el?.role;
  if (role !== "textarea" && !(role === "input" && TEXT_INPUT_TYPES.has(String(el.inputType ?? "text").toLowerCase())))
    return "not-a-text-box";
  if (isCaptchaElement(el)) return "captcha";
  if (href && !urlAllowed(href, allowedHosts)) return "off-host";
  return null;
}

/**
 * What `type` tells her when the thing she aimed at takes no words. A drop-down drawn from a button
 * (perception's `listTrigger`) is named as the list it is: told only "not a box to type in", a Sue
 * pressed the kit's birthday Month picker, saw nothing she understood, and filed the form as broken
 * (run 20260922-224205-261f, old-sue: "The Month box I pressed and nothing opened").
 */
export function notABoxSaid(el, label) {
  return el?.listTrigger
    ? `${label} "${seenName(el)}" is a drop-down list, not a box to type in. Click it to open its choices, then click the one you want.`
    : `${label} "${seenName(el)}" is not a box to type in, so a click there is refused. Call look.`;
}

/**
 * Runs IN THE PAGE (`locator.evaluateHandle(fileBoxOf)`): the file box a thing she named IS or
 * stands for - itself, the box its <label> is for, the ONE file box inside it, or the box of the label
 * it sits in - or null. A styled upload button usually hides the real box behind it.
 */
export function fileBoxOf(node) {
  const isFileBox = (n) => Boolean(n) && n.tagName === "INPUT" && String(n.type).toLowerCase() === "file";
  if (isFileBox(node)) return node;
  if (node.tagName === "LABEL" && isFileBox(node.control)) return node.control;
  const inside = [...(node.querySelectorAll?.("input") ?? [])].filter(isFileBox);
  if (inside.length === 1) return inside[0];
  const label = node.closest?.("label");
  return label && isFileBox(label.control) ? label.control : null;
}

/** What her hands say when a plain click or key opened the computer's window to pick a file. */
export function chooserSentence(hasFiles) {
  return hasFiles
    ? "A window to pick a file from your computer opened, and you closed it without picking one. To put one of your files in, call attach with the file's name: leave target out and it goes into the window you just opened, or name the thing that opens it."
    : "A window to pick a file from your computer opened; you have no files of your own for this, so you closed it.";
}

/**
 * The option she named when she clicks a drop-down list by words, or null when she named the box by
 * its number. Read through plainTarget like every other target: the hint she is given shows the
 * choice in quotes, so a Sue types `"#get-help"` with the quotes, and no option is called that.
 */
export function optionWords(target) {
  const words = plainTarget(target);
  return typeof words === "string" && words && !/^\d+$/.test(words) ? words : null;
}

/** Words the way a person matches them by eye: accents and case ignored, spaces tidied ("Español" is "espanol"). */
export function foldWords(words) {
  return String(words ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Which of a drop-down's options a hand picks for `wanted`: the exact label, then the exact value,
 * then the ONE label that matches with accents and case folded, then (a month number against month
 * names under a placeholder) by position. `options` are `{ label, value }` or bare labels. The
 * option's index, or null when none is meant or two fold alike (never a guess between them). A Sue
 * typing "Espanol" or "Francais" on a keyboard without accents never matched "Español" and the list
 * never changed (run 20260922-063426-626a).
 */
export function optionIndex(options, wanted) {
  const list = (options ?? []).map((o) =>
    o && typeof o === "object"
      ? { label: String(o.label ?? "").trim(), value: o.value == null ? null : String(o.value) }
      : { label: String(o ?? "").trim(), value: null },
  );
  const said = String(wanted ?? "");
  const byLabel = list.findIndex((o) => o.label === said);
  if (byLabel >= 0) return byLabel;
  const byValue = list.findIndex((o) => o.value != null && o.value === said);
  if (byValue >= 0) return byValue;
  const folded = foldWords(said);
  if (folded) {
    const alike = list.flatMap((o, index) => (foldWords(o.label) === folded ? [index] : []));
    if (alike.length) return alike.length === 1 ? alike[0] : null;
  }
  const month = Number(said);
  return Number.isInteger(month) && month >= 1 && month <= 12 && month < list.length ? month : null;
}

/**
 * The control the words name among the elements she could SEE (`wanted` is already lowercased by
 * resolveTarget). An EXACT name beats one that merely contains the words: "Delete" must not land on
 * an earlier "Delete account". A control perception withheld for standing behind a dialog or scrim
 * is never picked - the click hits the scrim, and handOn's two 8-second retries then file the button
 * as broken, the false defect behindOverlay exists to stop (perception.mjs). When that dialog holds
 * the only match, `{ blocked }` names it, so she is told to deal with it instead of hearing that
 * nothing on the page says the words. `{ el }`, `{ blocked }` or null.
 */
export function pickByWords(elements, wanted) {
  const says = (candidate) => seenWords(candidate).toLowerCase();
  const reachable = (elements ?? []).filter((candidate) => !candidate.hidden && !candidate.behindOverlay);
  const el = reachable.find((candidate) => says(candidate) === wanted) ?? reachable.find((candidate) => says(candidate).includes(wanted));
  if (el) return { el };
  const behind = (elements ?? []).find((candidate) => candidate.behindOverlay && says(candidate).includes(wanted));
  return behind ? { blocked: behind.behindOverlay } : null;
}

/**
 * `pickByWords`'s rule for a NUMBER: her `[n]` came from a look taken before a dialog opened, and the
 * dialog now stands in front of it (`behindOverlay`, read afresh). The refusal names the dialog at
 * once; the hand used to wait out an 8-second timeout on the scrim and say only "could not type",
 * and elaine, whose Starts date picker was still open over Ends, filed "the date picker ate my input"
 * as a blocker (run 20260922-224205-261f). The sentence, or null when nothing is in front of it.
 */
export function numberBlocked(el, n) {
  if (!el?.behindOverlay) return null;
  return `[${n}] "${seenName(el)}" is behind "${String(el.behindOverlay).slice(0, 80)}" now - deal with that first (finish it or close it), then try again.`;
}

/** The number a page writes at the start of an element's name ("1 Apple" is the page's 1), or null. */
export const ownNumber = (name) => /^\s*(\d+)\b/.exec(String(name ?? ""))?.[1] ?? null;

/** Her last few moves are reserved for leaving properly: done or give_up, then exit_interview. */
export const WRAP_UP_MOVES = 5;

/**
 * The line every answer carries once she is near the brain's turn budget (`maxTurns` in sue.json,
 * cannon's `turnsFor`), or "" before then. Without it a Sue still browsing at her last turn is cut
 * off mid-page and her whole verdict is lost (run 20260922-054554-992a: 75 turns, no interview).
 * Tool calls are counted, and a turn can carry several, so this fires early, never late.
 */
export function wrapUpNotice(toolCalls, maxTurns) {
  if (!Number.isInteger(maxTurns) || maxTurns <= 0) return "";
  const left = Math.max(maxTurns - toolCalls, 1);
  if (left > WRAP_UP_MOVES) return "";
  return `You only have time for about ${left} more thing${left === 1 ? "" : "s"} here. Wrap up now: call done or give_up, then exit_interview, so what you thought is not lost.`;
}

/**
 * The refusals that are SUE talking, not the site answering: each answers a move no person in her place could have
 * made, and tells her the one she can. A call her hands cannot read (a wait with no seconds, an address that is none, a
 * tab, an email or a spot by a number or place she does not have, an opinion of an email she has not opened, or in no
 * words), a thing she was never shown (a box she cannot see, an address no link or page showed her), or the wrong hand
 * for what is there (a spot on her own keyboard or on a numbered thing, typing on what is no box, pasting the machine's
 * clipboard, closing her only tab). Like her hands' which-one question, they cost a chat-brain Sue no turn (wrap). A
 * rail that holds back what her hand really reached is the world answering a move she made, and keeps its turn: a link
 * or a frame on another website, a robot check, a card box, a delete, a send, a sign-out, a form sent again.
 */
export const SUE_ASKS = new Set([
  "no-seconds",
  "no-address",
  "not-an-address",
  "unknown-address",
  "no-tab",
  "only-tab",
  "no-email",
  "unopened-email",
  "no-opinion",
  "no-spot",
  "hidden-field",
  "keyboard",
  "numbered",
  "not-a-text-box",
  "clipboard",
  "unsure-owed",
]);

/** What SUE asked her in answer to a move (her hands' which-one question, or a refusal in SUE_ASKS), or null. */
export const sueAskOf = (result, handsAsked = false) =>
  handsAsked ? "which-one" : SUE_ASKS.has(result?._refused) ? result._refused : null;

/**
 * The words a look charges her for: only what is NEW to her on this page, so glancing again at a page
 * she has read costs a glance, not a re-read. `readKeys` is the page's set of blocks already read, and
 * is added to. `readBlocks` is absent only from an older perception; then the whole look is new.
 */
export function freshWordsOf(view, readKeys) {
  const blocks = Array.isArray(view.stats?.readBlocks) ? view.stats.readBlocks : null;
  let freshWords = blocks ? 0 : (view.stats?.wordsShown ?? 0);
  for (const b of blocks ?? []) {
    if (readKeys.has(b.key)) continue;
    readKeys.add(b.key);
    freshWords += b.words;
  }
  return freshWords;
}

const CONSIDERED_OWED =
  'Before you leave, say which button or link you weighed last and decided not to press (for example Get Premium or Invite): add considered: <its number>, or considered: "none" if you never weighed one.';
const PUZZLE_ASK =
  'Which words or numbers on this screen did you read most carefully, whatever the reason (deciding if it is enough for you, comparing, checking a price, or puzzled)? Your next move needs lingered: "<them, quoted exactly as they read here>". Why is yours to say in a note. Never invent them. Is there a number, limit or term here you could not judge for your own situation, or would want explained before you decide? Is there wording on this screen you had to read twice to follow, or a line that promises something without saying how it helps with your own problem? Quote it as unsure: "<exact words>" on that same move, or unsure: "none" if nothing does. Also unsure: if what you read on this screen contradicts something you read earlier on this page (a price, a limit, a promise), quote the EARLIER words exactly; you will go back up to them. A move without unsure is refused.';
const CONSIDERED_ASK =
  'Weighed a button or link and decided not to press it? Say its number as considered: <number> on your next move. Leaving (done or give_up) needs it: the last one you weighed, or "none".';

const LINGERED_OWED =
  'Before this move, say which words or numbers on this screen you read most carefully: add lingered: "<them, quoted as they read>". Why is yours to say in a note.';
export const UNSURE_OWED =
  'Before this move, also say if this screen has a number, limit or term you could not judge for your own situation, or would want explained before you decide, or wording on this screen you had to read twice to follow, or a line that promises something without saying how it helps with your own problem: add unsure: "<those exact words>", or unsure: "none" if nothing does. If this screen contradicts something you read earlier on this page, quote the earlier words as unsure.';
const LINGERED_NO_NONE =
  'This screen has text, so lingered cannot be "none": quote the words you read most carefully, exactly as they read.';
const NOT_ON_SCREEN =
  "Those words are not on this screen. Quote the words you read most carefully, exactly as they read here; never invent them.";
const EXIT_BEFORE_ENDING =
  "End the visit first: call done (you finished) or give_up (you are leaving), with considered and unsure on it. Then call exit_interview.";
const NOTHING_UNSURE = "Nothing unsure written: it is only for a phrase quoted from the screen she is reading.";
/** Fewer words than this on a screen is a blank or loading page: nothing worth reading. */
const MIN_WORDS_TO_READ = 8;
const UNSURE_EXEMPT = new Set(["look", "tools", "see", "note", "exit_interview", "done", "give_up"]);
const isNone = (v) => typeof v === "string" && v.trim().toLowerCase() === "none";

/**
 * The words a look hands her around what she can see (`seen`, perceive's text): a thumb miss, a tab
 * that opened, her phone buzzing, her keyboard, her mood, her tiredness, going in circles, and her
 * picture's size. Pure, so a body with no browser (tape/body.mjs) says a look exactly the same way.
 */
export function lookText(
  seen,
  {
    thumbMissed = "",
    newTab = false,
    buzz = "",
    keyboardUp = false,
    fullScreen = false,
    mood,
    moodLine = "",
    circleNudge = null,
    filedHere = null,
    frame,
    puzzleAsk = false,
  },
) {
  let body = seen;
  if (fullScreen) body = `The browser shows: Press Esc to exit full screen.\n\n${body}`;
  if (thumbMissed) body = `${thumbMissed.trim()}\n\n${body}`;
  if (newTab) body = `A new tab opened a moment ago, and it is the one you are looking at now.\n\n${body}`;
  if (buzz) body = `${buzz}\n\n${body}`;
  if (keyboardUp) body = `Your keyboard is up and covers the bottom of your screen (go_back puts it away).\n\n${body}`;
  if (mood === "bored" || mood === "exhausted") body = `${moodLine}\n\n${body}`;
  if (mood === "exhausted") body = `${body}\n\n${NAME_YOUR_TIREDNESS} ${DONE_CALL_GIVE_UP}`;
  if (circleNudge) body = `${body}\n\n${circleNudge}`;
  // Problems other Sues of this run filed on this page (lib/findings.mjs filedHereLine), only when one is new to her.
  if (filedHere) body = `${body}\n\n${filedHere}`;
  const picture = `Your picture is ${frame.width} wide and ${frame.height} tall. Whatever is in it without a number, you reach with point.`;
  return puzzleAsk
    ? `${body}\n\n${picture}\n\n${CONSIDERED_ASK}
${PUZZLE_ASK}`
    : `${body}\n\n${picture}`;
}

/** Her clock as a trace row and body.json carry it. */
export const clockFacts = (clock) => ({
  elapsedSeconds: clock.elapsedSeconds(),
  attentionLeft: clock.attentionLeft(),
  patienceLeft: clock.patienceLeft(),
  state: clock.state(),
});

/**
 * One trace.jsonl row for a move: what she did (a typed address keeps where, never its query), how long
 * it took, her clock, where she was, what she saw and was told. Shared with tape/body.mjs, so a tape
 * visit's rows carry exactly a live visit's keys.
 */
export function traceRow(name, args, result, { ms, clock, url, title }) {
  const summary = result.content.find((c) => c.type === "text")?.text ?? "";
  return {
    tool: name,
    // A typed address can carry a sign-in token in its query; the trace keeps where, never that.
    // `url` is go_to's other name for it.
    args: sanitizeArgs(
      name,
      name === "go_to"
        ? {
            ...args,
            address: String(args?.address ?? "").replace(/[?#].*$/, "?[hidden]"),
            ...(args?.url != null ? { url: String(args.url).replace(/[?#].*$/, "?[hidden]") } : {}),
          }
        : args,
    ),
    ms,
    clock: clockFacts(clock),
    url,
    title,
    ...(result._screenshot ? { screenshot: result._screenshot } : {}),
    ...(result._shotHash ? { shotHash: result._shotHash } : {}),
    ...(result._pageText ? { pageText: String(result._pageText).slice(0, 4000) } : {}),
    // The run's filed problems her look listed (lib/findings.mjs filedHereLine), whole: `result` keeps only 200 characters.
    ...(result._filedHere ? { filedHere: result._filedHere } : {}),
    ...(result._refused ? { refused: result._refused } : {}),
    ...(result._mail != null ? { messages: result._mail } : {}),
    result: name === "check_email" ? `${result._mail ?? 0} messages` : summary.slice(0, 200),
    isError: Boolean(result.isError),
  };
}

/**
 * The picture she is handed for a viewport shot at `pixelsPerCss` (1 for a CSS shot, the device
 * scale otherwise): its size, whether the body shrinks it, and how many picture pixels one CSS pixel
 * is, so `point` turns her spot back into the page's own coordinates.
 */
export function pictureFrame(viewport, pixelsPerCss = 1) {
  const w = viewport.width * pixelsPerCss;
  const h = viewport.height * pixelsPerCss;
  const longEdge = pixelsPerCss === 1 ? Math.min(BRAIN_PICTURE.longEdge, SCREEN_PICTURE_LONG_EDGE) : BRAIN_PICTURE.longEdge;
  const s = Math.min(1, longEdge / Math.max(w, h), Math.sqrt(BRAIN_PICTURE.pixels / (w * h)));
  const width = Math.floor(w * s);
  const height = Math.floor(h * s);
  return { width, height, shrunk: width !== w || height !== h, perCssX: width / viewport.width, perCssY: height / viewport.height };
}
export const NOTE_KINDS = new Set(["confusion", "annoyance", "delight", "broken", "question", "thought", ...ATTENTION_KINDS]);
export const IDENTITY_FIELDS = new Set([
  "my-email",
  "my-phone",
  "my-first-name",
  "my-last-name",
  "my-full-name",
  "my-birthday",
  "the-code-from-my-email",
]);
export const LEFT = "You have left. Stop.";
export const DONE_CALL_GIVE_UP = "You are done. Call give_up.";
/**
 * The gate's answer once her patience is gone. It must say SHE stopped: "You are done." alone was
 * read as the click failing - on 2026-09-21 Maria gave up saying "the page stopped responding to my
 * clicks", a product defect the site never had, filed by SUE's own gate. On 2026-09-28 a Dredd
 * hearing's visitor was refused this way and her next note, a DROP, still said "the site stopped
 * responding to clicks - every action bounced", so it also tells her what to say when she says why.
 */
export const NAME_YOUR_TIREDNESS =
  "When you say why you stopped, in a note or in give_up, name your own tiredness (you ran out of patience), never the site: the site did not stop responding, you stopped.";
export const STOPPED_BEFORE_DOING_IT = `You have had enough of this visit, so you stop before doing that: nothing on the page failed, you simply did not do it. ${NAME_YOUR_TIREDNESS} Call give_up.`;
/**
 * SUE's own browser died under her (`browserLost`), which is SUE's machine and never the site: four
 * runs lost theirs at once on 2026-09-23 (13:02-13:04 UTC) and every Sue then blamed the site for
 * "Target page, context or browser has been closed". How many fresh browsers one Sue is given before
 * she is told to leave, the moves that need no page (they never reopen one), and what she is told.
 */
export const MAX_REOPENS = 2;
// A focus-group Sue's room, say and vote (lib/focus-hands.mjs) need no page either; only she is served them.
const NO_PAGE_MOVES = new Set(["note", "give_up", "done", "exit_interview", ...ROOM_MOVES]);
/** Her moves that never take her tab anywhere: a hop during one of them is the site moving her on its own (lib/hop-trace.mjs `by`). */
const STILL_MOVES = new Set(["look", "scroll", "rotate", "wait", "check_email", "judge_email", "tabs", ...NO_PAGE_MOVES]);
export function browserReopenedSentence({ startedOver }) {
  return `${BROWSER_REOPENED} That was your own computer, not the website. You are back ${startedOver ? "at the link you came on" : "on the page you were on"}. Call look to see it.`;
}
export const BROWSER_GONE =
  "Your browser closed and will not open again. That is your own computer, not the website. Call give_up, and say your browser closed.";
export const KEYBOARD_CAME_UP = "Your phone's keyboard came up and covers the bottom of your screen (go_back puts it away).";
export const KEYBOARD_WENT_AWAY = "Your phone's keyboard went away.";
const NAV_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 8_000;
/** One hand's whole try (two 8 s attempts and a scroll, 18 s) plus a few seconds: past it, the move answers instead of waiting on the page. */
const HAND_TIMEOUT_MS = 24_000;
export const HAND_TIMED_OUT = "the page stayed busy and would not take it";
/** How long her page storage read after a move may take (`snapshotSession`) before its last reading stands. */
const STORAGE_READ_MS = 1_500;
/** How much of what she typed her hands say back before "(and the rest of what you typed)": a note, never an essay. */
export const TYPED_SAID_MAX = 300;

/** A standalone body's log: stderr, because stdout is the JSON-RPC wire. A hosted body is handed her own file instead. */
const stderrLog = (...parts) => process.stderr.write(`[sue-body] ${parts.join(" ")}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * How long her `wait` waits: her seconds, at most 30, or null when she did not say (none, words, 0 or less). A wait
 * that does not say is SUE asking back (`WAIT_HOW_LONG`, no time, no turn), never a 0 s wait: in Reel Buddy rounds
 * 20261008-220832-d841 and 20261009-122820-7417, 70 of 74 waits came with no seconds, waited 0 s and still cost a
 * move, so a Sue watching her video being made spent her moves where no time had passed and gave up "too slow".
 */
export function waitSeconds(seconds) {
  const secs = Number(seconds);
  return Number.isFinite(secs) && secs > 0 ? Math.min(30, secs) : null;
}
export const WAIT_HOW_LONG = "Say how long you wait: wait { seconds: <1 to 30> }. You have not waited yet, and no time passed.";
const text = (value) => ({ content: [{ type: "text", text: String(value) }] });
const refusal = (value) => ({ content: [{ type: "text", text: String(value) }], isError: true });

/** How an exit-interview answer is written, where it is not words (`toolSpecs`). */
const ANSWER_SHAPES = {
  confidence: " (1-5)",
  madeAccount: " (bool)",
  emailCodeExperience: " {waitedSeconds, wasClear, notes}",
  endedUpWhereExpected: " {yes, where}",
  easyToUnderstand: " (1-10)",
  trust: " (1-10)",
  wouldComeBack: " (1-10)",
  uiStars: " (1-5, how the screens look and feel)",
  starsOutOfFive: " (1-5, the rating you would really leave)",
  everComingBack: " {yes, why} (false means you are done with this website for good)",
  isThisTrash: " {yes, why}",
};

/** The same, for an ad viewer's answers (`watches: "ad"`); a key not here is written as `ANSWER_SHAPES` has it. */
const AD_ANSWER_SHAPES = {
  stopScrolling: " {yes, why}",
  feltLike: " {kind, why}",
  believeIt: " {yes, why}",
  nextMove: " {move, why}",
  starsOutOfFive: " (1-5, how much you want to see more ads like this)",
};

/** The same, for a power user's answers (`ape: true`, lib/findings.mjs APE_QUESTIONS); a key not here is written as `ANSWER_SHAPES` has it. */
const APE_ANSWER_SHAPES = {
  lostWork: " {yes, what}",
  annoyanceScore: " (1-10)",
  wouldUseDaily: " {yes, why}",
  starsOutOfFive: " (1-5, the rating you would really leave)",
};

/** A tool's input: an object of these properties, extra keys tolerated (a brain adds them). */
const obj = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: true });

/**
 * THE tool table: `[name, description, inputSchema]` for every tool the body serves, the same on
 * every target, canvas or not (Owner, 2026-09-21: her hands are a first-time person's everywhere).
 * Exported so a spec reads the one list; `main` pairs each with its handler. A desktop Sue is not
 * served the phone-only hands (`rotate`); no device given is the whole table. A scenario's own
 * exit-interview questions (`interview`, `{ key: question }`) join `exit_interview` as optional answers.
 * A focus-group Sue (`focusGroup`) is also served `room`, `say` and `vote` (lib/focus-hands.mjs) and
 * asked the room's one extra question (`BIGGEST_PROBLEM_KEY`); without it the table is unchanged.
 */
export function toolSpecs(device, { interview, focusGroup = false, judged = false, ad = false, ape = false, art = false } = {}) {
  const extras = interviewExtras({ interview: focusGroup ? withBiggestProblem(interview) : interview }, judged, ad, ape);
  return [
    ["look", "Look at the page: a screenshot and what you can read and click, numbered [1], [2]...", obj({})],
    [
      "click",
      "Click element [n] from your last look, or the first thing whose text matches. how: click (the default), double-click, right-click, hover (rest the pointer on it), or drag (drag it onto another element; say which with `onto`, a number or its text).",
      obj({ target: { type: ["number", "string"] }, how: { type: "string", enum: CLICK_HOWS }, onto: { type: ["number", "string"] } }, [
        "target",
      ]),
    ],
    [
      "type",
      "Type into element [n]. Give `text`, or a `field`: my-email, my-phone, my-first-name, my-last-name, my-full-name, my-birthday, the-code-from-my-email.",
      obj({ target: { type: ["number", "string"] }, text: { type: "string" }, field: { type: "string", enum: [...IDENTITY_FIELDS] } }, [
        "target",
      ]),
    ],
    [
      "attach",
      "Put one of your own files into the page. file: its name, from your files. target: the element [n] that opens a window to pick a file (an upload button, a file box, a drop area); leave it out only right after such a window opened from your own click.",
      obj({ file: { type: "string" }, target: { type: ["number", "string"] } }, ["file"]),
    ],
    [
      "press",
      'Press a key, with Ctrl, Shift or Alt in front if held: Enter, Tab, E, Ctrl+A, Shift+Tab, Escape, Space. A tap moves a game\'s character for one frame, so to move in a game HOLD the key: give holdMs (100 to 5000), e.g. key D with holdMs 800 walks right for 0.8 s. To hold several keys together (run and jump) give keys: ["D", "Space"] with holdMs.',
      obj({ key: { type: "string" }, keys: { type: "array", items: { type: "string" } }, holdMs: { type: "number" } }, []),
    ],
    [
      "point",
      "Point at a spot in your last picture (x across, y down, in its pixels) for what is drawn there or has no number: click, double-click, right-click, hold (press and hold, a long-press on a phone), hold-right-click, drag or right-drag to toX,toY, zoom-in, zoom-out, or hover. holdMs (100 to 5000) keeps a hold down that long, and keeps a drag held on its last spot before letting go: to hold an on-screen joystick right, drag from its middle to its right edge with holdMs 800.",
      obj(
        {
          action: { type: "string", enum: POINTER_ACTIONS },
          x: { type: "number" },
          y: { type: "number" },
          toX: { type: "number" },
          toY: { type: "number" },
          holdMs: { type: "number" },
        },
        ["action", "x", "y"],
      ),
    ],
    ["scroll", "Scroll one screen: down, up, or top.", obj({ direction: { type: "string", enum: ["down", "up", "top"] } }, ["direction"])],
    ["go_back", "Go back to the previous page.", obj({})],
    ["go_forward", "Go forward again, after going back.", obj({})],
    ["reload", "Reload the page.", obj({})],
    [
      "go_to",
      "Type a web address into the address bar and go there. Only an address you have seen written on a page or in an email, or a website's front door by its name.",
      obj({ address: { type: "string" } }, ["address"]),
    ],
    [
      "tabs",
      "Your open tabs, by their titles: list them, switch to one, or close one (tab is its number from the list).",
      obj({ action: { type: "string", enum: ["list", "switch", "close"] }, tab: { type: "number" } }, ["action"]),
    ],
    ["rotate", "Turn your phone sideways, or back upright.", obj({})],
    ["wait", "Wait for something to happen. seconds: how long you wait, 1 to 30.", obj({ seconds: { type: "number" } }, ["seconds"])],
    ["check_email", "Open your email inbox and see what is there, newest first, each with its number.", obj({})],
    [
      "open_email",
      "Open one email from your inbox, by its number from check_email, the way it really looks - in your Mail tab. Then call look to read it.",
      obj({ which: { type: "number" } }, ["which"]),
    ],
    [
      "judge_email",
      "Say what you honestly thought of an email you opened: was it clear, did it look trustworthy, was it too long, would you have deleted it. Use its number.",
      obj({ which: { type: "number" }, whatIThought: { type: "string" } }, ["which", "whatIThought"]),
    ],
    [
      "note",
      "Write a diary line. kind: confusion, annoyance, delight, broken, question, thought, drop (the moment attention breaks: you would look away or leave) or hook (the moment something grabbed you). A drop or hook may also say why (the mechanism), fix (the change that would keep people) and severity (1 dips, 2 some leave, 3 most leave). When a confusion, annoyance or broken line is about something on the website that is wrong, it also carries problem, the plain facts anyone could check, written the moment they are on your screen: title (what is wrong, under 80 characters), defect (issue: it stops or misleads a person, such as a step that fails, wrong data, a button that does nothing or a page that lands in the wrong place; warning: it looks wrong and blocks nothing), severity (5: what you came to do is impossible, something you entered is lost, or money or security is wrong; 4: a main feature is broken but there is a way round it, or a price or a quantity is wrong; 3: a lesser feature is broken, or other words or numbers are wrong; 2: cosmetic; 1: trivial; a warning is a 1 or a 2), expected (what you expected, one sentence), actual (what the screen shows instead, quoting its words) and steps (1 to 20 short moves from your first screen that reach it). text stays your own words. A problem your hands list as already written down is not written again: when you run into it, say so in text with same: its number, and no problem." +
        " Also kind: lingered (paced reading only: the exact words on this screen you read most carefully; her pointer rests on them) or unsure (the same, for words that puzzle you), or considered (paced reading only: text is the number of a button or link you looked at and decided not to press; your pointer rests on it, then leaves)." +
        (art ? ART_NOTE_ADDENDUM : ""),
      obj(
        {
          kind: { type: "string" },
          text: { type: "string" },
          why: { type: "string" },
          fix: { type: "string" },
          severity: { type: "number" },
          problem: {
            type: "object",
            properties: {
              title: { type: "string" },
              defect: { type: "string", enum: ["issue", "warning"] },
              severity: { type: "number" },
              expected: { type: "string" },
              actual: { type: "string" },
              steps: { type: "array", items: { type: "string" } },
            },
          },
          same: { type: "number" },
        },
        ["kind", "text"],
      ),
    ],
    ...(focusGroup ? focusToolSpecs() : []),
    ["give_up", "Leave the site without finishing. Say why. Then call exit_interview.", obj({ why: { type: "string" } }, ["why"])],
    [
      "done",
      "You think you finished what you came to do. Say what. Then call exit_interview.",
      obj({ what: { type: "string" } }, ["what"]),
    ],
    [
      "exit_interview",
      `Answer every question, then you are finished: ${interviewKeys(judged, ad, ape)
        .map((key) => `${key}${(ape && APE_ANSWER_SHAPES[key]) || (ad && AD_ANSWER_SHAPES[key]) || ANSWER_SHAPES[key] || ""}`)
        .join(", ")}.${extras.length ? ` This visit also asks: ${extras.map(([key]) => key).join(", ")}.` : ""}`,
      obj(Object.fromEntries(extras.map(([key, question]) => [key, { description: String(question).trim() }]))),
    ],
  ].filter(([name]) => device !== "desktop" || !PHONE_ONLY_TOOLS.has(name));
}

// ---------------------------------------------------------------------------------------------
// Boot: sue.json, persona/target/scenario, the browser
// ---------------------------------------------------------------------------------------------

function sueDirFromArgv(argv) {
  const at = argv.indexOf("--sue");
  const dir = at >= 0 ? argv[at + 1] : null;
  if (!dir) throw new Error("usage: node body.mjs --sue <sueDir>");
  return path.resolve(dir);
}

/** `sue.json` may carry persona/target/scenario as objects or as ids; ids go through lib/personas.mjs. */
async function hydrate(value, loaderName) {
  if (value && typeof value === "object") return value;
  const personas = await import("./lib/personas.mjs");
  return personas[loaderName](String(value));
}

/**
 * Pick a `<select>` option the way a hand does and say what the list holds afterwards: `{ label,
 * stuck, shows }` (`label` the option she meant, `shows` what the box now reads, `stuck` whether they
 * are the same). `optionIndex` finds the option from her words (its label, its value, its label with
 * accents and case folded, a month by number). Clicking an option's text does nothing to a native
 * select in Chrome, and `selectOption` fires `input` and `change` inside ONE script, so the page
 * never gets a frame between them. A person's pick does: `input`, the page re-renders, then
 * `change`. That gap is where the sign-up birthday Month reset itself to empty (AppTextField,
 * 2026-10-05) while every Sue "picked April". So she focuses the box and presses keys (Home, then
 * Arrow Down once per enabled option before hers), the browser fires the events as it does for a
 * hand, and she reads the box again a frame later; a pick the page undid is the caller's finding.
 */
/**
 * Her whole birthday typed as keys into a focused Month select. True when the select then shows her
 * month (the page read her keys as a date); false when it did not, or the keys could not be sent.
 */
async function typeWholeBirthday(locator, page, typed, monthName) {
  try {
    await locator.focus({ timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.type(typed);
    const shows = await locator.evaluate((select) => select.selectedOptions[0]?.label ?? "", undefined, { timeout: ACTION_TIMEOUT_MS });
    return foldWords(shows) === foldWords(monthName);
  } catch {
    return false;
  }
}

/**
 * Her whole birthday on a phone, where a split date field's Month is the system picker: nothing can be
 * typed into it, so she picks her month with a tap and then types the day and year into their boxes,
 * tapping each one the keyboard is not already in. The sentence telling her what each box holds, or
 * null when no day and year boxes sit beside the Month (then only the month is picked, below).
 * trainer-marcus and soap-tariq (round 15, 2026-10-06, both phones) were told only the month went in.
 */
async function pickWholeBirthdayOnPhone(locator, page, isoDate, monthName, seen) {
  const group = locator.locator('xpath=ancestor::*[.//input[@autocomplete="bday-day"] and .//input[@autocomplete="bday-year"]][1]');
  if (!(await group.count().catch(() => 0))) return null;
  try {
    return await fillBirthdayParts(locator, page, group, isoDate, monthName, seen);
  } catch {
    return null;
  }
}

async function fillBirthdayParts(locator, page, group, isoDate, monthName, seen) {
  const [year, , day] = String(isoDate).split("-");
  const parts = [
    ["Day", group.locator('input[autocomplete="bday-day"]').first(), String(Number(day))],
    ["Year", group.locator('input[autocomplete="bday-year"]').first(), year],
  ];
  // A tap opens the picker, so the page hears a touch before the pick, as AppBirthdayField listens for.
  await locator.dispatchEvent("pointerdown", { pointerType: "touch", isPrimary: true }, { timeout: ACTION_TIMEOUT_MS });
  await locator.selectOption({ label: monthName }, { timeout: ACTION_TIMEOUT_MS });
  for (const [, box, digits] of parts) {
    if (await box.inputValue({ timeout: 1_000 })) await box.fill("", { timeout: ACTION_TIMEOUT_MS });
    const inIt = await box.evaluate((input) => input === document.activeElement, undefined, { timeout: ACTION_TIMEOUT_MS });
    if (!inIt) await box.tap({ timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.type(digits);
  }
  const month = await locator.evaluate((select) => select.selectedOptions[0]?.label ?? "", undefined, { timeout: ACTION_TIMEOUT_MS });
  const held = await Promise.all(parts.map(([, box]) => box.inputValue({ timeout: 1_000 }).catch(() => "")));
  const typed = parts.map(([name, , digits]) => `"${digits}" into ${name}`).join(" and ");
  const all = foldWords(month) === foldWords(monthName) && parts.every(([, , digits], i) => held[i] === digits);
  return all
    ? `You picked "${monthName}" from ${seen}, then typed ${typed}. All three show your birthday.`
    : `You picked "${monthName}" from ${seen}, then typed ${typed}. The boxes show Month "${month}", Day "${held[0]}", Year "${held[1]}".`;
}

async function selectByLabelOrValue(locator, value, page) {
  const options = await locator.evaluate(
    (select) => Array.from(select.options ?? [], (o) => ({ label: o.label, value: o.value, disabled: o.disabled })),
    undefined,
    { timeout: ACTION_TIMEOUT_MS },
  );
  const index = optionIndex(options, value);
  if (index == null) throw new Error(`no option "${value}"`);
  const label = String(options[index].label ?? value).trim();
  const steps = options.slice(0, index).filter((o) => !o.disabled).length;
  if (options[index].disabled) throw new Error(`option "${value}" is greyed out`);
  const readBox = () =>
    locator.evaluate(
      (select) =>
        new Promise((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve({ index: select.selectedIndex, text: select.selectedOptions[0]?.label ?? "" })),
          ),
        ),
      undefined,
      { timeout: ACTION_TIMEOUT_MS },
    );
  if ((await readBox()).index !== index) {
    await locator.focus({ timeout: ACTION_TIMEOUT_MS });
    await page.keyboard.press("Home");
    for (let step = 0; step < steps; step++) await page.keyboard.press("ArrowDown");
  }
  const now = await readBox();
  return { label, stuck: now.index === index, shows: String(now.text).trim() };
}

/**
 * A Sue's viewport and touch profile - the only browser facts her persona decides.
 *
 * A fresh CONTEXT is as isolated as a fresh profile for everything a Sue can observe: its own
 * cookies, storage and cache, nothing carried from any sibling. That is what makes the shared
 * browser below sound rather than a shortcut.
 */
export function contextOptions(device, target) {
  if (device !== "phone") {
    const chrome = /Chrome\/([\d.]+)/.exec(devices[PHONE].userAgent)?.[1] ?? "141.0.0.0";
    const userAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome} Safari/537.36 ${SUE_UA_TOKEN}`;
    return { viewport: viewportFor(device, target), isMobile: false, hasTouch: false, deviceScaleFactor: 1, userAgent };
  }
  const { defaultBrowserType: _chromiumAnyway, ...phone } = devices[PHONE];
  return { ...phone, userAgent: `${phone.userAgent} ${SUE_UA_TOKEN}` };
}

/** The resource type a response's content type says it is, when it is a picture, a sound, a video or a font; else null. */
export function streamedAs(contentType) {
  const kind = String(contentType ?? "")
    .toLowerCase()
    .split("/")[0]
    .trim();
  if (kind === "image") return "image";
  if (kind === "audio" || kind === "video") return "media";
  if (kind === "font") return "font";
  return null;
}

/**
 * A phone Sue's fingers on the glass, sent through CDP because Playwright has no multi-touch: `frames`
 * is where each finger is, first to last (`[[x, y], ...]` a frame), held `holdMs` on the first. Her
 * taps, long-presses and drags go here, never through the mouse: a game branches on pointerType, so
 * a phone Sue with a mouse was testing its desktop code (SUE post-mortem, 2026-09-26).
 */
async function touch(page, frames, holdMs = 0, endHoldMs = 0) {
  const cdp = await page.context().newCDPSession(page);
  const points = (frame) => frame.map(([x, y], id) => ({ x, y, id }));
  try {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points(frames[0]) });
    if (holdMs) await page.waitForTimeout(holdMs);
    for (const frame of frames.slice(1)) {
      await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points(frame) });
      await page.waitForTimeout(16);
    }
    // A finger left on the last spot: an on-screen joystick pushed in a direction and held there.
    if (endHoldMs) await page.waitForTimeout(endHoldMs);
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** One finger sliding from `from` to `to` in twelve steps, as `touch` frames. */
const slide = (from, to) =>
  Array.from({ length: 13 }, (_, i) => [[from[0] + ((to[0] - from[0]) * i) / 12, from[1] + ((to[1] - from[1]) * i) / 12]]);

/**
 * A phone Sue zooms the way a thumb and finger do: two touches spreading (in) or closing (out)
 * around the spot. It was a mouse wheel, which a phone has not got, so a touch game heard 3.6 wheel
 * notches instead of a pinch and every phone wave reported "pinch barely zooms" (Nexas Code, waves 3
 * and 4, 2026-09-23).
 */
function pinch(page, x, y, factor) {
  const start = factor > 1 ? 70 : 180;
  return touch(
    page,
    Array.from({ length: 11 }, (_, i) => {
      const gap = start * factor ** (i / 10);
      return [
        [x - gap / 2, y],
        [x + gap / 2, y],
      ];
    }),
  );
}

/** A thumb pad is about 7 mm across, about 40 CSS px on a phone; its centre lands up to a quarter of that off her aim. */
export const THUMB_PAD_PX = 40;
/** How long a long-press holds the glass: a phone's own long-press is 500 ms, a person's is longer. */
export const LONG_PRESS_MS = 700;

/**
 * Where her `n`th tap really lands when she aims at `[x, y]`: a small offset inside a quarter of a
 * thumb pad, the same for the same tap every run. A 48 px button always takes it; a 12 px one is
 * missed about half the time, which is the thing a phone's small targets do to a real thumb.
 */
export function thumbSpot([x, y], n) {
  const u = (k) => (Math.imul(n + 1, k) >>> 0) / 2 ** 32;
  const angle = 2 * Math.PI * u(0x9e3779b1);
  const r = (THUMB_PAD_PX / 4) * Math.sqrt(u(0x85ebca6b));
  return [Math.max(0, x + r * Math.cos(angle)), Math.max(0, y + r * Math.sin(angle))];
}

/** What a Pixel's own browser says it runs on; the user agent alone left `navigator.platform` saying Win32. */
const PHONE_PLATFORM = () => Object.defineProperty(Navigator.prototype, "platform", { get: () => "Linux armv81", configurable: true });

/** The page-side door the body tells her keyboard through (`tellPageKeyboard`); not enumerable, so a page's own `for…in` over window never meets it. */
const KEYBOARD_DOOR = "__sueKeyboard";

/** The page-side count of print windows a page asked for since her hands last read it (`quietPrint`). */
export const PRINT_DOOR = "__suePrints";

/**
 * Runs IN THE PAGE (`context.addInitScript`), in every browser of hers: `window.print()` returns at
 * once instead of opening the browser's print preview. That preview is modal and never closes in a
 * driven browser, so the click that opened it never returned and every later move of hers queued
 * behind it (Packing Buddy, 2026-09-29: 3 of 5 Sues sat on "working, click" for 10+ minutes and could
 * not even call done). Each call is counted, read-and-cleared through the door, so her hands say the
 * print window opened.
 */
export function quietPrint(door) {
  let asked = 0;
  Object.defineProperty(window, door, {
    value: () => {
      const seen = asked;
      asked = 0;
      return seen;
    },
    enumerable: false,
  });
  window.print = function print() {
    asked += 1;
  };
}

/** The page-side count of sounds a page played since her hands last read it (`heardSounds`). */
export const SOUND_DOOR = "__sueSounds";

/**
 * Runs IN THE PAGE (`context.addInitScript`): she has no ears, so a sound the page plays is counted
 * where it starts (a Web Audio source's `start`, an unmuted media element's `play`), starts within a
 * quarter second of each other are one sound (a chime is two tones), and the count is read and
 * cleared through the door, so her hands say a sound played. Without it a critic filed "no answer
 * made any sound I could tell" while Lift chimed on every answer (lift-v2 rounds 15 and 16).
 */
export function heardSounds(door) {
  let sounds = 0;
  let last = -Infinity;
  const heard = () => {
    const now = performance.now();
    if (now - last > 250) sounds += 1;
    last = now;
  };
  Object.defineProperty(window, door, {
    value: () => {
      const played = sounds;
      sounds = 0;
      return played;
    },
    enumerable: false,
  });
  const source = globalThis.AudioScheduledSourceNode?.prototype;
  if (source?.start) {
    const start = source.start;
    source.start = function (...args) {
      heard();
      return start.apply(this, args);
    };
  }
  const media = globalThis.HTMLMediaElement?.prototype;
  if (media?.play) {
    const play = media.play;
    media.play = function (...args) {
      if (!this.muted && this.volume > 0) heard();
      return play.apply(this, args);
    };
  }
}

/**
 * Runs IN THE PAGE (`context.addInitScript`): her keyboard, the way a real phone tells a page about it.
 * Chrome for Android keeps the layout viewport's size with the keyboard up and fires no window
 * `resize`, but it DOES shrink `visualViewport.height` by the keyboard, move `visualViewport.offsetTop`
 * as her view slides down the page, and fire `resize` and `scroll` on `window.visualViewport`. A page
 * that lifts its bottom bar with those reads as covered without them (to-do 5fa997a2). Only the top
 * frame is ever told: a frame's own visual viewport does not shrink for the keyboard.
 */
function keyboardViewport(door) {
  const proto = globalThis.VisualViewport?.prototype;
  if (!proto || window !== window.top) return;
  const native = (name) => Object.getOwnPropertyDescriptor(proto, name).get;
  const [height, offsetTop, pageTop] = [native("height"), native("offsetTop"), native("pageTop")];
  let covered = 0; // CSS pixels of the screen under the keyboard; 0 while it is down
  let pan = 0; // how far her view has slid down the page past where the page's own scroll puts it
  Object.defineProperty(proto, "height", {
    get: function () {
      return Math.max(0, height.call(this) - covered);
    },
    configurable: true,
  });
  Object.defineProperty(proto, "offsetTop", {
    get: function () {
      return offsetTop.call(this) + pan;
    },
    configurable: true,
  });
  Object.defineProperty(proto, "pageTop", {
    get: function () {
      return pageTop.call(this) + pan;
    },
    configurable: true,
  });
  Object.defineProperty(window, door, {
    value: (next) => {
      const resized = next.covered !== covered;
      const scrolled = next.pan !== pan;
      covered = next.covered;
      pan = next.pan;
      if (resized) window.visualViewport.dispatchEvent(new Event("resize"));
      if (scrolled) window.visualViewport.dispatchEvent(new Event("scroll"));
    },
    enumerable: false,
  });
}

/** Everything a phone context hears before any page code runs: the platform it runs on, and its keyboard. */
export async function dressAsPhone(context) {
  await context.addInitScript(PHONE_PLATFORM);
  await context.addInitScript(keyboardViewport, KEYBOARD_DOOR);
}

/**
 * ⛔ ONE BROWSER PER WAVE, ONE CONTEXT PER SUE - never one browser per Sue (owner directive, the owner,
 * 2026-09-21: "you are killin my pc ... find a better cleaner way").
 *
 * A 25-wide wave of `launchPersistentContext` cost ~300 MB per Sue and took this 48 GB box from
 * 14.4 GB free to 6.9 GB, and two Sues in that run reported the page "vanished" - a Chrome tab the
 * OS killed under pressure, filed as a product bug it was not. So the cannon starts ONE browser
 * server for the wave and passes its `browserWsEndpoint` in `sue.json`; each body connects and takes
 * its own context, which is a few tens of MB.
 *
 * `wsEndpoint` absent (a hand-run body, the reaper, a fixture in tests) still launches its own
 * persistent profile exactly as before - the shared path is an optimisation, never a requirement.
 */
/**
 * Runs IN THE PAGE, before any of the page's own code (`context.addInitScript`): puts a lent
 * session's saved page storage back, on its own origin only. Discord's web app reads its sign-in from
 * localStorage as it starts and then hides the store from the page, so it has to be there first.
 */
function restoreStorage(origins) {
  const mine = origins.find((o) => o.origin === location.origin);
  if (!mine) return;
  try {
    for (const { name, value } of mine.localStorage) localStorage.setItem(name, value);
  } catch {
    // best-effort: a sandboxed frame has no storage; the top page on the origin is the one that signs in
  }
}

/**
 * Puts her saved page storage back into a fresh browser of her own before any page of hers opens.
 * One throwaway tab visits each origin, answered by an empty page (never the site), and writes that
 * origin's items once. Nothing is written again later, so a sign-out she makes afterwards stays
 * signed out. The wave's server takes the same thing natively (`storageState` on `newContext`); a
 * persistent profile cannot, and `setStorageState` would first wipe the profile's own IndexedDB.
 */
async function seedStorage(context, origins) {
  if (!origins.length) return;
  const tab = await context.newPage();
  try {
    await tab.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: "<html></html>" }));
    for (const { origin, localStorage: items } of origins) {
      await tab.goto(origin, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
      await tab.evaluate((entries) => {
        for (const { name, value } of entries) localStorage.setItem(name, value);
      }, items);
    }
  } finally {
    await tab.close().catch(() => {}); // best-effort: the storage is written; a tab that already went is the goal
  }
}

/** `origins`: page storage a reopened browser starts with (`reopenBrowser`); empty on her first browser. */
async function launchBrowser(persona, profileDir, target, wsEndpoint, origins = [], log = stderrLog) {
  const device = persona?.dials?.device === "phone" ? "phone" : "desktop";
  const mode = browserModeFor(target);
  // Her clock is her own: a Sue in Ohio reads Eastern time, not this PC's zone (lib/personas.mjs timezoneFor).
  const timezoneId = timezoneFor(persona);
  const zone = timezoneId ? { timezoneId } : {};
  if (wsEndpoint) {
    const browser = await chromium.connect(wsEndpoint, { timeout: NAV_TIMEOUT_MS });
    const context = await browser.newContext({
      ...contextOptions(device, target),
      ...zone,
      ...(origins.length ? { storageState: { cookies: [], origins } } : {}),
    });
    await context.addInitScript(quietPrint, PRINT_DOOR);
    await context.addInitScript(heardSounds, SOUND_DOOR);
    await context.addInitScript(trackTextChanges);
    if (device === "phone") await dressAsPhone(context);
    return { context, device, mode, browser, shared: true };
  }
  const executablePath = resolveChromiumPath();
  if (!executablePath) throw new Error("no Chromium on this machine (browser-launch.mjs resolved null)");
  mkdirSync(profileDir, { recursive: true });
  const viewport = viewportFor(device, target);
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: mode === "headless",
    executablePath,
    ...contextOptions(device, target),
    ...zone,
    args: [...browserArgsFor(mode), ...(mode === "headless" ? [] : [`--window-size=${viewport.width},${viewport.height}`])],
    timeout: NAV_TIMEOUT_MS,
  });
  // A reopen that cannot put her storage back still gives her a browser, as it did before storage came back.
  await seedStorage(context, origins).catch((err) => log("her page storage was not put back:", err?.message ?? err));
  await context.addInitScript(quietPrint, PRINT_DOOR);
  await context.addInitScript(heardSounds, SOUND_DOOR);
  await context.addInitScript(trackTextChanges);
  if (device === "phone") await dressAsPhone(context);
  return { context, device, mode, browser: null, shared: false };
}

// ---------------------------------------------------------------------------------------------
// The body
// ---------------------------------------------------------------------------------------------

/**
 * ONE Sue's body, in whatever process holds it: `main` below wraps it in her own stdio MCP server
 * (`node body.mjs --sue <dir>`, the process-per-Sue path every older caller still uses), and
 * lib/body-host.mjs holds many of them in one node process, one browser context each (the owner,
 * 2026-09-24: hundreds of Sues from one Chrome, as cheaply as possible - a body process was 137 MB
 * of private memory before she did anything, 71 MB of it playwright-core loading again per Sue).
 * Everything that is HERS (cookies, storage, rails, clock, diary) lives in this closure, so two of
 * them in one process share nothing but the code. `log` is where her lines go: stderr standalone,
 * her own `body.stderr.log` when hosted. Resolves once her browser is up and `ready` is written, to
 * `{ sueId, device, tools, shutdown }`; `tools` are `{ name, description, inputSchema, handler }`.
 */
export async function createSueBody({ sueDir, log = stderrLog }) {
  const sue = JSON.parse(readFileSync(path.join(sueDir, "sue.json"), "utf8"));
  const readingMode = readingModeOf(sue.reading);
  /** The brain's turn budget, so her last moves go to leaving properly (`wrapUpNotice`). */
  const maxTurns = Number.isInteger(sue.maxTurns) ? sue.maxTurns : null;
  /** The calling chat's agents drive her: nothing caps their turns but her wrap-up line, so only her moves count. */
  const chatBrain = sue.brain === "chat";
  /** `handTimeoutMs` in her sue.json overrides the default, as `maxTurns` does. */
  const handTimeoutMs = Number.isFinite(sue.handTimeoutMs) && sue.handTimeoutMs > 0 ? sue.handTimeoutMs : HAND_TIMEOUT_MS;
  const persona = await hydrate(sue.persona, "loadPersona");
  const target = await hydrate(sue.target, "loadTarget");
  const scenario = await hydrate(sue.scenario, "loadScenario");
  // A focus-group Sue (`focusGroup: true`, written by the cannon for a focus-group run) sits at a
  // table with the others in the run dir above hers: lib/focus-hands.mjs is her room, say and vote,
  // and what she hears between her moves. `null` for every other Sue, so nothing below changes for her.
  const focus =
    sue.focusGroup === true
      ? createFocusHands({
          runDir: path.dirname(sueDir),
          sueId: sue.sueId ?? path.basename(sueDir),
          sueDir,
          fallbackName: seatNameFor({ displayName: persona.displayName, sueId: sue.sueId ?? path.basename(sueDir) }),
        })
      : null;
  const identity = sue.identity ?? {};
  // Her own inbox is a page she may always open (lib/inbox-page.mjs): a reserved `.invalid` name
  // served from her mail folder, so every rail reads it exactly like the site, and nothing leaves the box.
  const allowedHosts = [...(target.allowedHosts ?? []), INBOX_HOST];
  const mailDir = addressMailDir(sue.mailDir, identity.email);
  const shotsDir = path.join(sueDir, "shots");
  mkdirSync(shotsDir, { recursive: true });

  const findings = createFindings(sueDir);
  // The run's ledger of typed problems sits beside her folder (lib/findings.mjs FILED_FILE); her look lists the
  // titles filed on her page, never one that would hand her the ground truth her report is graded on.
  const runDir = path.dirname(sueDir);
  const truths = truthTexts(target, scenario);
  const clock = createClock(persona, { legs: legsOf(scenario) });
  const profileDir = sue.browserProfileDir ?? path.join(sueDir, "profile");
  const launched = await launchBrowser(persona, profileDir, target, sue.browserWsEndpoint, [], log);
  const { device, mode } = launched;
  // `let`: when SUE's own browser dies under her, `reopenBrowser` swaps in a fresh one, and every
  // closure below reads these bindings, so each of them reaches the new browser with no other change.
  let { context, browser, shared } = launched;
  // Her 'network' dial (personas.mjs `networkConditionsFor`): `null` for "fast" means no throttling
  // and `throttlePage` below is a no-op, so a Sue with no network dial never pays for a CDP session.
  const networkConditions = networkConditionsFor(persona);
  // Which slow requests are findings (lib/slow-waits.mjs): what she waited on, past her own line's latency, once each.
  const slowWait = createSlowWaitJudge({ networkLatencyMs: networkConditions?.latency ?? 0 });
  // The requests a move of hers started: a slow one is the site's answer to what she did. One the
  // page starts while her brain thinks between moves was never waited on (a chat brain thinks ~10 s a
  // move, and run 20260928-133054-9af5 filed 36 slow-response rows, none of them an answer to her).
  const askedByHer = new WeakSet();
  // A Sue a message sent (`start: "inbox"`) finds it already in her inbox: her first screen is it.
  if (target.arrival) {
    if (!mailDir) throw new Error('start: "inbox" needs her own mailbox to put the message in, and this Sue has none');
    seedArrival(mailDir, fillMerge(target.arrival, { ...inboxFactsFor(persona.id), first_name: identity.firstName }).email);
    if (target.decoys) seedDecoys(mailDir);
  }
  // A signed-in Sue (`cannon --as <name>`) arrives with the session a human saved through
  // `login.mjs`: the product's own cookies, and the page storage the target names (Discord's sign-in
  // lives there), loaded here, never shown to the brain. A target whose visit crosses sites
  // (`sessionParts`) hands her one saved session per site, carried together (`readSessions`).
  const lent = sue.session ? readSessions(sue.session) : null;
  if (sue.session && !lent)
    throw new Error(`the saved session at ${[sue.session].flat().join(", ")} is missing or unreadable; run login.mjs again`);
  // The JANITOR's path: the ORIGINAL Sue's own cookies and page storage, saved at her shutdown
  // (`storage-state.json`), so a cleanup pass signs in where she finished instead of signed out. It
  // is HER account, so the rails stay exactly as they were - never `sue.session`, which means a LENT
  // human account whose SESSION_RAIL would refuse the very delete she came to do.
  const restored = sue.restoreState ? readSessions(sue.restoreState) : null;
  if (sue.restoreState && !restored) throw new Error(`the saved state at ${sue.restoreState} is missing or unreadable`);
  // `blockRequests`: what a Sue must never load. ARGUS's pixel is NOT in it by default: a Sue's visit is
  // labelled `dataset: sue` and human reads exclude it, so her pixel is wanted. A target that must not
  // reach ARGUS says `blockArgus: true`.
  // Remembered so the page's own "Failed to load resource: net::ERR_FAILED" for a request WE blocked
  // is not filed as the product's console error (it was, on every signed-in page, 2026-09-21).
  const blockedUrls = new Set();
  /**
   * Everything her browser carries before her first page, in one place: run here, and again,
   * unchanged, on the fresh browser `reopenBrowser` starts when SUE's own browser dies under her, so
   * a reopened browser can never be missing a rail the first one had.
   */
  async function prepareContext(ctx) {
    // Her browser says it is a Sue's before any page code runs (lib/sue-marker.mjs): the run and
    // her Sue id, never her email or her persona's name, and `borrowed` on a lent human login. The product keeps her out of human signals
    // by it (Owner, 2026-09-28: Sues are a separate dataset).
    await installSueMarker(ctx, {
      run: sue.runId ?? null,
      id: sue.sueId ?? path.basename(sueDir),
      borrowed: Boolean(sue.session),
      scenario: scenario.id,
      persona: persona.id,
    });
    // The signup door (lib/signup-door.mjs + the aegis-auth-request-otp Lambda): on THIS machine's
    // key only, her own request-otp POST carries it and the accounts widget renders Cloudflare's
    // always-pass test key, so she can register without ever touching a CAPTCHA. No key file, no door:
    // the real widget shows and she records the challenge exactly as before. Installed before the
    // first navigation so the init script is in place on every page she opens.
    const door = await installSignupDoor(ctx, {
      key: readSueSignupKey(),
      identityEmail: identity.email,
      log: (...a) => log("door:", ...a),
    });
    if (door.installed) log("signup door installed for", identity.email ?? "no address");
    await installInboxPage(ctx, {
      readMessages: () => readInbox(mailDir),
      receivedLabelOf: (m) => receivedAgo(m._stamp),
      onEvent: (id, event) =>
        appendFileSync(path.join(mailDir, `${id}.events.jsonl`), `${JSON.stringify({ ...event, at: new Date().toISOString() })}\n`),
    });
    for (const saved of [lent, restored]) {
      if (!saved) continue;
      await ctx.addCookies(saved.cookies);
      if (saved.origins.length) await ctx.addInitScript(restoreStorage, saved.origins);
    }
    if (readingMode) await ctx.addInitScript(keepPageFocused);
    for (const pattern of [...(target.blockArgus === true ? [ARGUS_PIXEL_HOST_PATTERN] : []), ...(target.blockRequests ?? [])])
      await ctx.route(pattern, (route) => {
        blockedUrls.add(route.request().url());
        return route.abort();
      });
  }
  await prepareContext(context);
  const rails = railsFor({
    refuseClicks: target.refuseClicks,
    borrowed: Boolean(sue.session),
    freeHands: lent?.freeHands === true,
    keepRefuseClicks: Array.isArray(target.sessionParts) && target.sessionParts.length > 0,
    noCommit: target.noCommit === true,
    liveSite: isLiveSite(target),
  });
  const startUrl = startUrlFor(target, scenario, { sueId: sue.sueId, runId: sue.runId });
  const judged = judgesScreens(target, scenario);
  const ad = isAdScenario(scenario);
  const ape = isApeScenario(scenario);
  // A designer (lib/personas.mjs isArtPersona) writes polish and keep lines and answers the team's questions.
  const art = isArtPersona(persona);

  const state = {
    /** Her taps so far (`thumbSpot` lands each by its number), and what the last one hit instead of what she aimed at. */
    taps: 0,
    thumbMissed: "",
    /** She scrolled after her last look, so a number from it may name something no longer on her screen (`offScreenNow`). */
    scrolledSinceLook: false,
    /** Real milliseconds she has spent reading in paced mode this visit (`PACE_DIALS.visitCapMs` caps it). */
    pacedSpentMs: 0,
    lingeredFor: null,
    /** A phone Sue turned sideways (`rotate`): every tab she has, and every one she opens, is held that way. */
    turned: false,
    /**
     * Her phone's keyboard: up or not, the tab it came up on, how far her view has slid down the
     * page to keep the box she is typing in above it (`pan`, CSS px), and whether the page asked to
     * be squeezed instead (`resizes`: `interactive-widget=resizes-content`).
     */
    kb: { up: false, page: null, pan: 0, resizes: false },
    /** Documents loaded in any of her tabs so far: a move that saw one land acted on a page that is gone. */
    pageLoads: 0,
    page: context.pages()[0] ?? (await context.newPage()),
    inventory: null,
    clickable: new Map(),
    /**
     * The tab her numbers were read on. A number is a stamp on ONE page: the mail tab's [1] pressed
     * whatever carried that stamp on the site's tab (run 20260922-133522-bbfb, sue-3844-shop-owner).
     */
    clickablePage: null,
    /** What each number read as at her last look, so a number whose thing has gone is never reused. */
    shownAs: new Map(),
    /** `<n>:<name>` when she was just asked which of two things she meant by n (the page's own n or her [n]). */
    askedWhich: null,
    /** True while the move under way is answered by her hands' which-one question, which is SUE asking (`sueAskOf`). */
    handsAsked: false,
    /**
     * The drop-down she just opened (clicked by its number or its name): `{ id, name, url }`. A
     * choice she names next goes into THIS list, as it does when a real list is open, never into
     * the first look-alike list on the page that has the same choice.
     */
    openList: null,
    looks: 0,
    navigated: false,
    outcome: null,
    outcomeAt: null,
    finalUrl: null,
    closed: false,
    /** True only once `exit_interview` wrote `interview.json`; a crashed or maxTurns-cut brain leaves it false. */
    interviewed: false,
    patienceExhausted: false,
    emailTypedAt: null,
    otpRequestedAt: null,
    /**
     * When a look first showed the site's anti-bot refusal after she asked for a code, with no code
     * in her inbox: OUR Sue sign-up door turned her away (`sueDoorRefused`). A SUE-side event the
     * report keeps apart from the site's defects; it was the whole "email code is broken" morning
     * of 2026-09-22.
     */
    doorRefusedAt: null,
    /**
     * When she typed a code READ OUT OF HER OWN INBOX into a box on the page. It is the one hard,
     * product-agnostic fact that a sign-up actually completed: the site mailed a code to an address
     * only she can read, and she put it back. Recorded because `madeAccount` used to come ONLY from
     * the exit interview, so a Sue cut off by the turn budget one action after entering her code
     * was reported as "stopped before sign-in" over a real, live account (measured 2026-09-21: two
     * Sues, two rows in AEGIS `identities`, a report that said zero).
     */
    codeSubmittedAt: null,
    firstInboxCheckAt: null,
    lastInboxCheckAt: null,
    otpEmailLatencyMs: null,
    lastToolEndedAt: Date.now(),
    toolCalls: 0,
    noted: new Set(),
    /** Her last moves and pages, to tell a control that does nothing from a page that moves on (`lib/circles.mjs`). */
    circles: circleWatch(),
    lastCircleMove: null,
    /** Things she has done since her last diary line - the `journalNudge` counter. */
    sinceNote: 0,
    /** P25: probe ids already asked this visit (`probeForLook`), and the ones asked but not yet
     *  tagged onto a `note` (`probeNoteExtra`) - oldest first, so her next line gets the oldest one. */
    probesFired: new Set(),
    pendingProbes: [],
    /** Her latest picture's name and words: a typed problem carries the look she decided on (lib/findings.mjs problemNote). */
    lastLookName: null,
    lastLookText: null,
    looksByPage: new Map(),
    /** Per page (filedPage), the highest ledger number her look has already listed, so the list never repeats. */
    filedShown: new Map(),
    /** Every area of the site she has been in, so a return trip reads as being bounced around. */
    areasSeen: new Set(),
    /** A tab that opened after the action's own answer went out; her next look says so. */
    unannouncedTab: false,
    /** Her Mail tab (open_email), the ids behind the numbers her last check_email showed, and what she did with each email. */
    mailPage: null,
    expectingMailTab: false,
    inboxIds: [],
    emailsOpened: new Set(),
    emailsJudged: [],
    /** Emails her phone has already buzzed for (`phoneBuzz`), so each arrival is announced once. */
    mailAnnounced: new Set(),
    /** Ids of the target's declared exits she reached, in order (`exitFor`); the report's hand-off count. */
    exitsReached: [],
    /** The page she is reading and the blocks she has already read on it, so a second look is not a re-read. */
    readUrl: null,
    readKeys: new Set(),
    /** Every web address she has SEEN this visit (`addressKey` -> href): what `go_to` may open (THE SUE LAW). */
    seen: new Map(),
    /** The picture she was last handed (`pictureFrame`), so `point` reads her spot in its pixels. */
    frame: null,
    /** New tabs still arriving; `settle` waits for them so the hand that opened one can say so. */
    opening: new Set(),
    /** Each tab's last main-frame navigation method: a page that came from a POST is not silently re-sent by reload. */
    navMethod: new WeakMap(),
    /** True while `attach` itself waits for a window to pick a file, so the default handler leaves it to attach. */
    attaching: false,
    /** A window to pick a file that a plain hand opened and the body closed: `{ chooser, page }`; attach with no target picks into it. */
    chooser: null,
    /** Set when such a window opened during this move, so the move's answer says so. */
    chooserOpened: false,
    /** When SUE's own browser died under her and her next move has not reopened it yet (`browserLost`), and the page she was on. */
    browserLostAt: null,
    lostUrl: null,
    /** Fresh browsers `reopenBrowser` has started for her; past MAX_REOPENS the browser is gone for good. */
    reopens: 0,
    browserGone: false,
    /**
     * Her cookies after her last move (`snapshotSession`). A dead browser answers nothing, so this is
     * what a reopened browser signs her back in with, and what `shutdown` saves for the janitor when
     * it cannot ask the browser - before it, a Sue whose browser died left no `storage-state.json`
     * and the account she made could never be cleaned up.
     */
    cookies: [],
    /**
     * Her page storage the same way, origin -> localStorage items, for the target's own hosts only.
     * Each move reads the page she is on; an origin she left keeps its last reading. Many sites keep
     * their sign-in here, not in a cookie: a reopen that brought back cookies alone signed three
     * Sues out of Tavern Bag, and each blamed the site (run 20260923-143342-ca73).
     */
    storage: new Map(),
    /**
     * Who is moving her right now, for the hop trace (lib/hop-trace.mjs `by`): the move running
     * (`{ seq, name }`, set by `wrap`), or a page the body itself is opening for her (`navigatingAs`).
     * Each gets a fresh `seq` from `moveSeq`, so one move claims one hop per tab and no more.
     */
    moving: null,
    navBy: null,
    moveSeq: 0,
    argusSeen: new Set(),
  };
  // Her own files (the cannon copied them into her folder, `files` names them): the whole reach of `attach`.
  const herFiles = Array.isArray(sue.files) ? sue.files.filter((name) => typeof name === "string" && name) : [];
  const herFilesDir = path.join(sueDir, "files");
  // Addresses she already has (a bookmark, a link a co-owner sent her): the address bar takes them the
  // way it takes an address she read on a page, and only inside the allowed hosts like any other.
  for (const href of knownAddressesOf(target, scenario)) noteSeen(state.seen, href);
  const defaultProtocol = (() => {
    try {
      return new URL(target.startUrl).protocol;
    } catch {
      return "https:";
    }
  })();
  const pixelsPerCss = target.canvas ? 1 : contextOptions(device, target).deviceScaleFactor;
  /** The picture a look hands her now, from the page's own viewport. */
  const frameNow = () =>
    pictureFrame(device === "phone" ? heldViewport() : (state.page.viewportSize() ?? viewportFor(device, target)), pixelsPerCss);

  const pageUrl = () => {
    try {
      return state.page.url();
    } catch {
      return "";
    }
  };
  const pageTitle = () => state.page.title().catch(() => "");
  const bodyNote = (kind, textValue, extra) => findings.note({ source: "body", kind, text: textValue, url: pageUrl(), extra });
  /** A pick the page undid: the list went back to what it showed. Filed once as a finding and told to her in words. */
  const selectDidNotStick = (box, picked, shows) => {
    noteOnce("select-did-not-stick", `a pick of "${picked}" in ${box} did not stay: the list went back to showing "${shows || "nothing"}"`);
    return `You picked "${picked}" from ${box}, but it did not stay: the list still shows "${shows || "nothing"}". Call look.`;
  };
  /** One finding of a kind per page URL - a `look` repeated on the same page must not re-file it. */
  const noteOnce = (kind, textValue, extra) => {
    const key = `${kind}::${pageUrl()}`;
    if (state.noted.has(key)) return;
    state.noted.add(key);
    bodyNote(kind, textValue, extra);
  };
  /**
   * Her patience is gone: the body files that drop itself, once, on the page she was on and at the
   * second her clock stopped, so the report's attention section carries the real drop (her patience,
   * not the page) whatever she writes about it after (report.mjs `buildAttention`, `sueSideOf`).
   */
  const patienceGone = () => {
    if (!state.patienceExhausted) {
      bodyNote("patience-exhausted", "patience gone; every further tool answers: call give_up", {
        visitSeconds: Math.round(clock.elapsedSeconds()),
      });
    }
    state.patienceExhausted = true;
  };
  /**
   * She is going round in circles (`circleWatch`): filed once per page as `going-in-circles`, with
   * the move she keeps making and where, and her nudge handed back for her answer. It never blocks
   * the move: the finding is about the site (a control that does nothing, a form that silently
   * refuses), the nudge is only what a person would feel.
   */
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
  /** What Enter or Space would press from where the focus is (lib/rails.mjs). */
  const whatAKeyPresses = (key) => state.page.evaluate(keyPressTargets, key).catch(() => []);
  /**
   * An off-host URL that is one of the target's declared exits: recorded once per exit as
   * `reached-exit` (never `left-site`), and the sentence her hands say is returned. Null when the URL
   * is not an exit, so the caller falls through to the ordinary off-site refusal.
   */
  const reachExit = (url, how) => {
    const exit = exitFor(url, target.exits);
    if (!exit) return null;
    if (!state.exitsReached.includes(exit.id)) {
      state.exitsReached.push(exit.id);
      bodyNote("reached-exit", `${exit.name || exit.id} (${how})`, { exit: exit.id, href: String(url).slice(0, 300) });
    }
    return exitSentence(exit);
  };

  // --- automatic findings: the body notices these without the brain ---------------------------
  /** The size her screen is now: a phone turned sideways is its landscape size, the way it really is. */
  const heldViewport = () => (state.turned ? PHONE_SIDEWAYS : viewportFor(device, target));

  // --- her phone's keyboard -----------------------------------------------------------------
  // Modelled on what Chrome for Android (since 108) and iPhone Safari both do by default: the PAGE
  // keeps its size and is never told, her VIEW shrinks to the part above the keyboard, and the box
  // she is typing in is scrolled up into that part - slid into it when it cannot scroll (a bar fixed
  // to the bottom). So a bar fixed to the bottom sits behind the keyboard until she scrolls to it,
  // exactly as on a real phone, and the box she is typing in is never hidden (a simple
  // cover-the-bottom picture would have filed that as a bug). The page is told what a phone tells it
  // (`keyboardViewport`): `visualViewport` shrinks by the keyboard and moves with her view, with its
  // `resize` and `scroll` events, so a page that lifts its bar above the keyboard is not filed as
  // covered. A page that asks to be squeezed instead (`interactive-widget=resizes-content`) gets that,
  // and its real viewport change tells it.

  const keyboardHeight = () => (state.turned ? KEYBOARD.sideways : KEYBOARD.upright);
  /** How much of her screen, from its top, is page and not keyboard. */
  const aboveKeyboard = () => heldViewport().height - keyboardHeight();

  /** Tell the page where her keyboard is now, through its `visualViewport` (a squeezed page's own size already told it). */
  async function tellPageKeyboard(page = state.kb.page) {
    if (!page || page.isClosed()) return;
    const told = state.kb.up && !state.kb.resizes;
    await page
      .evaluate(
        ([door, next]) => window[door]?.(next),
        [KEYBOARD_DOOR, { covered: told ? keyboardHeight() : 0, pan: told ? state.kb.pan : 0 }],
      )
      .catch(() => {}); // a page mid-navigation starts its next document with the keyboard down, which is what it is
  }

  /** The text box that has the focus, frames included, and where it is; null when none does. */
  function readFocus(page) {
    return page
      .evaluate(() => {
        const NO_KEYS = new Set([
          "checkbox",
          "radio",
          "button",
          "submit",
          "reset",
          "file",
          "image",
          "range",
          "color",
          "hidden",
          "date",
          "time",
          "datetime-local",
          "month",
        ]);
        let el = document.activeElement;
        let dy = 0;
        while (el && el.tagName === "IFRAME") {
          let inner;
          try {
            inner = el.contentDocument?.activeElement ?? null;
          } catch {
            inner = null; // a frame from another site keeps its focus to itself
          }
          if (!inner || inner === el.contentDocument?.body) return null;
          dy += el.getBoundingClientRect().top;
          el = inner;
        }
        if (!el || el.disabled || el.readOnly) return null;
        const typed = el.tagName === "INPUT" && !NO_KEYS.has(String(el.type || "text").toLowerCase());
        if (!(typed || el.tagName === "TEXTAREA" || el.isContentEditable)) return null;
        const r = el.getBoundingClientRect();
        const meta = document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "";
        return { top: r.top + dy, bottom: r.bottom + dy, resizesContent: /interactive-widget\s*=\s*resizes-content/i.test(meta) };
      })
      .catch(() => null); // a page mid-navigation has no focus to read; the keyboard goes down with it
  }

  /** The native date, time or month box that has the focus: its kind, label and value; null when none does. */
  function readPicker(page) {
    return page
      .evaluate(() => {
        const el = document.activeElement;
        if (el?.tagName !== "INPUT" || el.disabled || el.readOnly) return null;
        const label = el.labels?.[0]?.textContent?.trim() || el.getAttribute("aria-label") || el.name || "";
        return { type: String(el.type || "").toLowerCase(), label, value: el.value };
      })
      .then((r) => (r && pickerKind(r.type) ? { kind: pickerKind(r.type), label: r.label, value: r.value } : null))
      .catch(() => null); // a page mid-navigation has no focus to read
  }

  /** After a tap: the phone's picker opened on a date box, and how she answers it ("" when it did not). */
  async function pickerOpenNow() {
    const open = await readPicker(state.page);
    return open ? ` ${pickerOpenedSentence(open.kind, open.label ? `"${open.label}"` : "the box", open.value)}` : "";
  }

  /** Put the box she is typing in above the keyboard, the way the phone's browser does. */
  async function placeKeyboard(focus) {
    const screen = heldViewport();
    const visible = aboveKeyboard();
    state.kb.resizes = focus.resizesContent;
    state.kb.pan = 0;
    if (focus.resizesContent) await state.page.setViewportSize({ width: screen.width, height: visible });
    // Scroll every scroller the box sits in until it clears the keyboard (a scroll margin the size
    // of the keyboard, for one scroll, is exactly "as far up as it takes").
    await state.page
      .evaluate(
        (room) => {
          const el = document.activeElement;
          if (!el?.scrollIntoView) return;
          const was = el.style.scrollMarginBottom;
          el.style.scrollMarginBottom = `${room}px`;
          el.scrollIntoView({ block: "nearest" });
          el.style.scrollMarginBottom = was;
        },
        focus.resizesContent ? 16 : keyboardHeight() + 16,
      )
      .catch(() => {}); // best-effort: a box in a frame is not scrolled from here; the slide below still shows it
    if (focus.resizesContent) return;
    // The page hears the keyboard before her view settles: a page that lifts a bar, or scrolls her box
    // itself, does so now, and where her box ends up is read after it has.
    await tellPageKeyboard(state.page);
    const now = (await readFocus(state.page)) ?? focus;
    // What no scroll could move (fixed to the bottom of the screen, a page too short) her view slides down to.
    if (now.bottom > visible) state.kb.pan = Math.min(keyboardHeight(), Math.ceil(now.bottom - visible + 8));
    if (state.kb.pan) await tellPageKeyboard(state.page);
  }

  async function lowerKeyboard() {
    const { page, resizes } = state.kb;
    state.kb = { up: false, page: null, pan: 0, resizes: false };
    if (resizes && page && !page.isClosed()) await page.setViewportSize(heldViewport());
    else await tellPageKeyboard(page);
  }

  /**
   * After every move: the keyboard comes up when her own touch or typing left a text box focused,
   * follows her to the next box, and goes down when no box has the focus or she is on another tab.
   */
  async function syncKeyboard(raised) {
    if (device !== "phone" || state.closed || !state.page || state.page.isClosed()) return;
    const focus = await readFocus(state.page);
    if (state.kb.up && (state.kb.page !== state.page || !focus)) return lowerKeyboard();
    if (!focus || !raised) return;
    state.kb.up = true;
    state.kb.page = state.page;
    await placeKeyboard(focus);
  }

  /**
   * With the keyboard up she reaches a numbered thing the way a person does: scrolls it up into the
   * part of the screen she can still see, and where no scroll moves it (a bar fixed to the bottom of
   * the screen) slides her view down to it - on a real phone that bar sits behind the keyboard until
   * she scrolls to the end. A thing that WAS behind the keyboard is noted: the keyboard was in her way.
   */
  async function reachAboveKeyboard(locator, label) {
    if (!state.kb.up || state.kb.resizes) return;
    const visible = aboveKeyboard();
    const from = state.kb.pan;
    const seen = await locator
      .evaluate(
        (node, [top, bottom]) => {
          const mid = () => {
            const r = node.getBoundingClientRect();
            return r.top + r.height / 2;
          };
          const before = mid();
          if (before >= top && before < bottom) return { before, after: before };
          const was = [window.scrollX, window.scrollY];
          node.scrollIntoView({ block: "center" });
          window.scrollBy(0, mid() - (top + bottom) / 2);
          // A scroll that did not move it at all (fixed to the screen) is put back as it was.
          if (Math.abs(mid() - before) < 1) window.scrollTo(was[0], was[1]);
          return { before, after: mid() };
        },
        [from, from + visible],
      )
      .catch(() => null); // a thing that went away under her is found missing by the hand that follows
    if (!seen) return;
    const screenBottom = heldViewport().height;
    if (seen.before >= from + visible && seen.before < screenBottom)
      bodyNote("keyboard-in-the-way", `${label} was behind her phone's keyboard; she had to scroll to reach it`);
    if (seen.after >= from + visible) state.kb.pan = Math.min(keyboardHeight(), Math.ceil(seen.after - visible + 24));
    else if (seen.after < from) state.kb.pan = Math.max(0, Math.floor(seen.after - 24));
    if (state.kb.pan !== from) await tellPageKeyboard();
  }

  /** Her screen with the keyboard up: the part of the page above it, and the keyboard below. */
  async function keyboardShot() {
    const screen = heldViewport();
    const visible = aboveKeyboard();
    const page = await state.page
      .screenshot({ type: "png", scale: "device", clip: { x: 0, y: state.kb.pan, width: screen.width, height: visible } })
      .catch(() => null); // a tab closing under her takes no picture; the look says so the way it always has
    if (!page) return null;
    const { default: sharp } = await import("sharp");
    const width = Math.round(screen.width * pixelsPerCss);
    const top = Math.round(visible * pixelsPerCss);
    const height = Math.round(screen.height * pixelsPerCss);
    return sharp({ create: { width, height, channels: 3, background: "#ffffff" } })
      .composite([
        { input: await sharp(page).resize(width, top, { fit: "fill" }).png().toBuffer(), top: 0, left: 0 },
        { input: Buffer.from(keyboardSvg(width, height - top)), top, left: 0 },
      ])
      .jpeg(PICTURE_JPEG)
      .toBuffer();
  }

  /**
   * The network dial, per page, over CDP (`Network.emulateNetworkConditions`) - Playwright has no
   * post-launch throttle knob, and this is the one DevTools call that gives her one. `networkConditions`
   * null (persona dials.network absent, or "fast") makes this a no-op. Callers await it BEFORE the
   * page's first navigation where they control that ordering (the first tab, the mail tab); a tab
   * Chrome opens on its own (a target=_blank link) can already be mid-navigation by the time the
   * `context.on("page", ...)` handler runs, so that tab's very first request may escape the throttle.
   */
  async function throttlePage(page) {
    if (!networkConditions) return;
    const cdp = await context.newCDPSession(page);
    await cdp.send("Network.emulateNetworkConditions", { offline: false, ...networkConditions });
  }

  // Her tab stops painting while her brain thinks and paints again before her next move runs
  // (lib/rest.mjs: measured, headless only, never frozen). `context` is read each time, so a
  // reopened browser rests the same way.
  const restSessions = new WeakMap();
  /** One CDP session per tab, shared by her resting tab and her hop trace. Opened on the tab's own context. */
  const cdpFor = (page) => {
    if (!restSessions.has(page)) restSessions.set(page, page.context().newCDPSession(page));
    return restSessions.get(page);
  };
  const rest = createRest({ enabled: mode === "headless", pages: () => (state.closed ? [] : context.pages()), sessionFor: cdpFor, log });
  // Every page her tabs pass through, and the login pointer at each, one line in her trace per hop
  // (lib/hop-trace.mjs; run 20260923-191716-e508 could not tell where a signed-in Sue lost her session).
  const hops = createHopTrace({
    write: (row) => findings.trace(row),
    mover: () =>
      state.navBy ??
      (state.moving && !STILL_MOVES.has(state.moving.name) ? { seq: state.moving.seq, by: "her", move: state.moving.name } : null),
    cdpFor,
    storageAllowed: (url) => urlAllowed(url, allowedHosts),
    log: (...parts) => log("hops:", ...parts),
  });
  // What her pages logged, failed on, and what started each document load (lib/page-trace.mjs).
  const pageTrace = createPageTrace({
    write: (row) => findings.trace(row),
    cdpFor,
    blockedUrls,
    log: (...parts) => log("page trace:", ...parts),
  });
  /** A page the BODY opens for her (her link, a reopened browser, back off an off-site page), so its hop line says who moved her. */
  async function navigatingAs(by, move, go) {
    state.navBy = { seq: ++state.moveSeq, by, move };
    try {
      return await go();
    } finally {
      state.navBy = null;
    }
  }

  // A lent or restored session is already signed in; otherwise she is, once her OTP verifies.
  let signedInHere = Boolean(sue.session || sue.restoreState);
  function watch(page) {
    hops.watch(page);
    pageTrace.watch(page);
    // A tab opened while the phone is sideways opens sideways, as it does on a real phone.
    if (state.turned) page.setViewportSize(heldViewport()).catch((err) => log("rotate: a new tab did not turn:", err?.message ?? err));
    // A new document takes her keyboard down, as a phone's browser does on a page load. Left up, the
    // body kept its old pan over a page that had never been told of it (a fresh document starts with
    // its visual viewport whole), so a page that lifts its bar read as covered - and a box the new
    // page focuses by itself kept "the keyboard" up under her (adversarial review, 2026-09-23).
    page.on("domcontentloaded", () => {
      state.pageLoads += 1;
      if (state.kb.up && state.kb.page === page)
        lowerKeyboard().catch((err) => log("keyboard: could not put it away on a new page:", err?.message ?? err));
    });
    // Only OUR pages' errors are findings: a hand-off that briefly lands on another site (an exit's
    // redirect, before the body goes back) logs that site's 403s, which are not this product's defect.
    page.on("console", (msg) => {
      if (msg.type() !== "error" || !urlAllowed(page.url(), allowedHosts)) return;
      if (blockedUrls.has(msg.location()?.url)) return;
      if (echoesHttpError(msg.text(), msg.location()?.url, allowedHosts)) return; // filed as its http-error
      bodyNote("console-error", msg.text().slice(0, 500));
    });
    page.on("pageerror", (err) => {
      if (urlAllowed(page.url(), allowedHosts)) bodyNote("console-error", `Uncaught: ${String(err?.message ?? err).slice(0, 500)}`);
    });
    page.on("response", (res) => {
      const url = res.url();
      if (res.status() < 300 && url.includes("/auth/verify-otp")) signedInHere = true;
      if (!urlAllowed(url, allowedHosts) || res.status() < 400) return;
      if (isSignedOutRefresh({ status: res.status(), method: res.request().method(), url, signedIn: signedInHere })) return;
      bodyNote("http-error", `${res.status()} ${res.request().method()} ${url.slice(0, 300)}`, { status: res.status(), request: url });
    });
    page.on("requestfinished", async (req) => {
      const url = req.url();
      if (!urlAllowed(url, allowedHosts) || !askedByHer.has(req)) return;
      const timing = req.timing();
      const ms = timing ? Math.round(timing.responseEnd) : -1;
      // A game's sounds and pictures fetched by script are still sounds and pictures: judged by what
      // came back, they stream in behind her like any <img> (lib/slow-waits.mjs WAITED_ON).
      const contentType = (await req.response().catch(() => null))?.headers()["content-type"] ?? "";
      const resourceType = streamedAs(contentType) ?? req.resourceType();
      const slow = slowWait({ resourceType, method: req.method(), url, ms });
      if (slow) bodyNote("slow-response", slow.text, slow.extra);
    });
    page.on("load", async () => {
      const nav = await page
        .evaluate(() => {
          const e = performance.getEntriesByType("navigation")[0];
          return e ? Math.round(Math.max(e.loadEventEnd, e.domContentLoadedEventEnd, e.responseEnd)) : null;
        })
        .catch(() => null);
      if (nav != null && nav > 4000) bodyNote("slow-navigation", `load took ${nav}ms`, { ms: nav });
    });
    page.on("request", (req) => {
      if (state.moving || state.navBy) askedByHer.add(req);
      if (req.isNavigationRequest() && req.frame() === page.mainFrame()) state.navMethod.set(page, req.method());
    });
    // A plain click, point or key that opens the computer's window to pick a file: with a listener
    // here Playwright never shows the real window (headed, it would open on the operator's screen and
    // the click would hang behind it), so nothing is picked - the window is closed - and her answer
    // says so and points her at attach (`chooserSentence`). `attach` waits for its own window.
    page.on("filechooser", (chooser) => {
      if (state.attaching) return;
      state.chooser = { chooser, page };
      state.chooserOpened = true;
    });
    // A tab that closes itself (or that she closed) hands her the newest tab still open.
    page.on("close", () => {
      if (state.page !== page) return;
      const open = context.pages().filter((p) => !p.isClosed());
      if (open.length) state.page = open.at(-1);
    });
  }
  // Her first tab, throttled before `ensureStarted`'s own `goto` ever fires - the one page where
  // "before its first navigation" is fully guaranteed, since that navigation happens later, on her
  // first move.
  await throttlePage(state.page);
  watch(state.page);
  const onNewTab = (opened) => {
    // Her own Mail tab (open_email) is opened by the BODY, and is still about:blank for an instant
    // before it loads her inbox page - which this handler would close as off-site. It is claimed
    // synchronously, before any await, so the race cannot be lost.
    if (state.expectingMailTab) {
      state.expectingMailTab = false;
      return;
    }
    // A target=_blank link or a popup: stay inside the sandbox, and follow it only when it is ours.
    const arriving = (async () => {
      // As early as possible for a tab we did not open ourselves - see throttlePage's own note:
      // Chrome may already be mid-navigation by the time this handler runs, so her very first request
      // on this tab can still escape the throttle.
      await throttlePage(opened).catch(() => {}); // best-effort: a tab that closes itself before this lands is not worth a crash over
      await opened.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {}); // best-effort: a new tab that never finishes loading is still judged by its URL on the next line
      if (!urlAllowed(opened.url(), allowedHosts)) {
        if (!reachExit(opened.url(), "a new tab"))
          bodyNote("left-site", `a new tab opened to ${opened.url()} - closed, off the allowed hosts`);
        await opened.close().catch(() => {}); // best-effort: closing an off-site tab is cleanup; a tab that already closed itself is the goal
        return;
      }
      watch(opened);
      state.page = opened;
      // On a busy machine the tab can arrive after the action's own answer went out. Her next look
      // says so, rather than silently showing her a different page (newTabSaid clears it when the
      // action's answer already did).
      state.unannouncedTab = true;
      clock.newPage();
    })();
    state.opening.add(arriving);
    arriving.finally(() => state.opening.delete(arriving));
  };

  /**
   * SUE's own browser died under her - never the site (see MAX_REOPENS). A context closes however its
   * browser goes (killed, crashed, the wave's shared server gone), so its `close` is the one signal.
   * Recorded ONCE, as the `SUE_BROWSER_LOST` body note the report opens its set-apart window at
   * (`browserLostWindows`); her next move reopens it. Our own close (`shutdown`) and a context a
   * reopen already replaced are not a loss.
   */
  function browserLost(ctx, how) {
    if (state.closed || ctx !== context || state.browserLostAt) return;
    state.browserLostAt = Date.now();
    state.lostUrl = pageUrl();
    log("her browser was lost:", how);
    bodyNote(SUE_BROWSER_LOST, `SUE's own browser ${how} under her mid-visit - SUE's machine, not the site`);
  }
  function armContext(ctx) {
    // Traced from its first request, before onNewTab waits for it to load: a tab's own first hops are the chain.
    ctx.on("page", hops.watch);
    ctx.on("page", onNewTab);
    ctx.on("close", () => browserLost(ctx, "closed"));
    ctx.browser()?.on("disconnected", () => browserLost(ctx, "closed"));
  }
  armContext(context);

  /**
   * Her cookies and the page storage of the page she is on, after a move, while her browser can
   * still answer (`state.cookies`, `state.storage`). The storage is ONE read of the current page,
   * never `context.storageState()`, which can open helper tabs her new-tab handler would take for
   * hers. The read is bounded, so a page that will not answer costs her a moment, not her move.
   */
  async function snapshotSession() {
    if (state.closed || state.browserLostAt || state.browserGone) return;
    const cookies = await context.cookies().catch(() => null); // a browser dying mid-move answers nothing; the last good snapshot stands
    if (cookies) state.cookies = cookies;
    const page = state.page;
    if (!page || page.isClosed() || !/^https?:/.test(page.url()) || !urlAllowed(page.url(), target.allowedHosts ?? [])) return;
    const read = page
      .evaluate(() => {
        const items = [];
        for (let i = 0; i < localStorage.length; i += 1) {
          const name = localStorage.key(i);
          items.push({ name, value: localStorage.getItem(name) });
        }
        return { origin: location.origin, items };
      })
      .catch(() => null); // a page mid-navigation or with no storage answers nothing; its last reading stands
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(null), STORAGE_READ_MS);
    });
    const got = await Promise.race([read, late]);
    clearTimeout(timer);
    if (got && /^https?:/.test(got.origin) && urlAllowed(got.origin, target.allowedHosts ?? [])) state.storage.set(got.origin, got.items);
  }

  /** Her last page storage in storageState's `origins` shape, only the origins that still hold something. */
  const savedOrigins = () =>
    [...state.storage].filter(([, items]) => items.length).map(([origin, items]) => ({ origin, localStorage: items }));

  /**
   * A fresh browser for her, dressed exactly like the first (`prepareContext`), signed in with her
   * last cookies and her last page storage, back on the page she was on (or the link she came on when
   * that page is not one she may open). The wave's shared server first; when THAT is what died, her
   * own browser on her own profile, the way a hand-run body starts one. `{ startedOver }`, or null
   * once MAX_REOPENS are spent.
   */
  async function reopenBrowser() {
    const where = state.lostUrl;
    state.browserLostAt = null;
    state.lostUrl = null;
    if (state.reopens >= MAX_REOPENS) return null;
    state.reopens += 1;
    const origins = savedOrigins();
    let fresh = null;
    if (sue.browserWsEndpoint)
      fresh = await launchBrowser(persona, profileDir, target, sue.browserWsEndpoint, origins, log).catch((err) => {
        log("the wave's browser is gone too; starting her own:", err?.message ?? err);
        return null;
      });
    fresh ??= await launchBrowser(persona, profileDir, target, null, origins, log);
    ({ context, browser, shared } = fresh);
    await prepareContext(context);
    if (state.cookies.length) await context.addCookies(state.cookies);
    // Everything that pointed into the dead browser points at nothing now. Her tab is taken BEFORE
    // the new-tab handler is armed, as on her first browser: a fresh context from the wave's server
    // has no tab, and the one the body opened was told to her as "a new tab opened", watched twice,
    // and counted on her clock as a page she moved to.
    state.page = context.pages()[0] ?? (await context.newPage());
    armContext(context);
    Object.assign(state, {
      mailPage: null,
      kb: { up: false, page: null, pan: 0, resizes: false },
      inventory: null,
      clickable: new Map(),
      clickablePage: null,
      shownAs: new Map(),
      askedWhich: null,
      openList: null,
      chooser: null,
      frame: null,
      readUrl: null,
      readKeys: new Set(),
    });
    await throttlePage(state.page);
    watch(state.page);
    if (where && urlAllowed(where, allowedHosts)) {
      const failed = await openStartPage(() =>
        navigatingAs("body", "reopen", () => state.page.goto(where, { waitUntil: "load", timeout: NAV_TIMEOUT_MS })),
      );
      if (!failed) return { startedOver: false };
    }
    // Her next move opens the link she came on, exactly as her first move did.
    state.navigated = false;
    return { startedOver: true };
  }

  /** Her answer once her browser died: it reopened and she is told so, or it is gone for good. */
  async function afterBrowserLost() {
    const back = await reopenBrowser().catch((err) => {
      log("her browser would not reopen:", err?.stack ?? err);
      return null;
    });
    if (back) return text(browserReopenedSentence(back));
    state.browserGone = true;
    return refusal(BROWSER_GONE);
  }
  /**
   * A real browser is on a new tab the instant a link opens one; her hands answer only after her tab
   * has moved too. When what she is about to act on is an <a> or <form> aimed at a new window (a target
   * that is not _self, _parent or _top), start listening for that tab BEFORE the action and hold the
   * answer for it after (`newTabLanded`). Anything else costs nothing. `probe` runs in the page and
   * gets the element she acts on (or the one in focus).
   */
  const NEW_TAB_WAIT_MS = 2_500;
  const opensNewTab = (el) => {
    const t = el?.closest?.("a[target],area[target],form[target],button[formtarget],input[formtarget]");
    const target = (t?.getAttribute("formtarget") || t?.getAttribute("target") || "").trim().toLowerCase();
    return Boolean(target) && !["_self", "_parent", "_top"].includes(target);
  };
  const newTabComing = async (probe) => {
    const aimed = await probe().catch(() => false); // best-effort: a page mid-navigation has no element to ask; she is then told what happened by her next look
    if (!aimed) return null;
    // Listening starts before the action, but the wait's clock starts after it: a tap can itself take seconds.
    const watching = { ctx: context, opened: false, onPage: null };
    watching.arrived = new Promise((resolve) => {
      watching.onPage = () => {
        watching.opened = true;
        resolve();
      };
      context.once("page", watching.onPage);
    });
    return watching;
  };
  const newTabLanded = async (watching) => {
    if (!watching) return;
    let timer;
    const timeout = new Promise((resolve) => (timer = setTimeout(resolve, NEW_TAB_WAIT_MS)));
    await Promise.race([watching.arrived, timeout]);
    clearTimeout(timer);
    watching.ctx.off("page", watching.onPage);
    if (watching.opened) await Promise.all([...state.opening]);
  };
  /** What her hands say when the thing she did opened a new tab and she is now looking at it. */
  const newTabSaid = (tabBefore) => {
    if (state.page === tabBefore) return "";
    state.unannouncedTab = false;
    return " It opened in a new tab, and that tab is the one you are looking at now.";
  };
  /** The right-click's answer when only the browser's own menu would have opened: nothing she could see. */
  const menuSaid = (answer) =>
    answer === "browser"
      ? " Nothing you could see happened: the page has no menu of its own there, and the browser's own little menu never shows in your picture."
      : "";

  // --- page helpers ---------------------------------------------------------------------------
  async function ensureStarted() {
    if (state.navigated) return null;
    // Retry the start page once before giving up on it: a single timeout used to end the visit. The
    // flag is still set here, so a down site costs two timeouts and never blocks every move for 45 s.
    const failed = await openStartPage(() =>
      navigatingAs("her", "arrive", () => state.page.goto(startUrl, { waitUntil: "load", timeout: NAV_TIMEOUT_MS })),
    );
    state.navigated = true;
    if (!failed) {
      clock.newPage();
      return null;
    }
    bodyNote("http-error", `start page did not load: ${String(failed?.message ?? failed).slice(0, 300)}`);
    return `The page is taking forever and has not loaded (${String(failed?.message ?? failed).split("\n")[0]}).`;
  }

  /** `INVENTORY_SCRIPT` is a function's source; a bare string evaluate yields the function, not its result. */
  async function runInventory() {
    let inventory = await state.page.evaluate(INVENTORY_SCRIPT).catch(() => null);
    if (!inventory || typeof inventory !== "object" || !Array.isArray(inventory.blocks)) {
      inventory = await state.page.evaluate(`(${INVENTORY_SCRIPT})()`);
    }
    state.inventory = inventory;
    return inventory;
  }

  /** How many times one look reads a page that keeps becoming another document under it. */
  const LOOK_READS = 3;
  /** Which document the page holds now (its time origin, one per document), or null while it has none to ask. */
  const documentOf = () => state.page.evaluate(() => performance.timeOrigin).catch(() => null);

  /**
   * A crossfade photographed half-way is two screens on top of each other. Seven Sues filed the
   * accounts sign-in chooser as "see-through, the text all overlapping" (runs 20260922-133522-*):
   * her look landed 250 ms into a fade that a person's eye only meets at its end. So she waits for
   * the page's FINITE animations and transitions to finish (a spinner loops forever and is not
   * waited on), never longer than 3 s. With `scroll`, also until nothing has scrolled for 120 ms.
   * The cap was 2 s until SUE round 8 of series lift-v2 (2026-10-04): Lift's level-up on the class
   * page ends 2.7 s after it paints (the bar fills, then "Level 5!" lands from opacity 0), her look
   * came first, saw an empty band, and she filed a false drop, "no level-up moment".
   * Returns what was STILL moving when the cap passed ({ name, remainingMs } each; empty when the page
   * came to rest), so the look can say it was taken mid-motion (`look-mid-motion`).
   */
  const STILLNESS_CAP_MS = 3000;
  function waitForStillness(scroll) {
    return state.page
      .evaluate(
        async ({ withScroll, capMs }) => {
          const deadline = performance.now() + capMs;
          const moving = () =>
            document.getAnimations().filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming?.().endTime));
          while (moving().length && performance.now() < deadline) await new Promise((r) => setTimeout(r, 50));
          const stillMoving = moving().map((a) => ({
            name: a.animationName ?? a.transitionProperty ?? "an animation",
            remainingMs: Math.max(0, Math.round((a.effect.getComputedTiming().endTime - (a.currentTime ?? 0)) / (a.playbackRate || 1))),
          }));
          if (!withScroll) return stillMoving;
          // A scroll a page glides on requestAnimationFrame is not an animation the page can list,
          // and a look half-way down it shows whatever it is passing: two Sues who clicked the
          // homepage's "Warm intros" were photographed 236 ms into a 720 ms glide, in the middle of
          // the price table, and filed "thrown into a table of 13 tools" (run 20260922-133522-c2bd).
          let lastScroll = performance.now();
          const heard = () => (lastScroll = performance.now());
          document.addEventListener("scroll", heard, { capture: true, passive: true });
          while (performance.now() - lastScroll < 120 && performance.now() < deadline) await new Promise((r) => setTimeout(r, 40));
          document.removeEventListener("scroll", heard, { capture: true });
          return stillMoving;
        },
        { withScroll: Boolean(scroll), capMs: STILLNESS_CAP_MS },
      )
      .catch(() => []); // best-effort: a page mid-navigation has no document to ask; the look that follows reads it as it stands
  }

  async function settle() {
    await state.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {}); // best-effort: settling is a courtesy wait; a page that never fires load is still read as it stands
    await sleep(250);
    await waitForStillness(true);
    if (state.opening.size) await Promise.all([...state.opening]);
  }

  /** What her hands say when the move made the page ask for its print window (`quietPrint`). */
  async function printSaid() {
    const asked = await state.page.evaluate((door) => window[door]?.() ?? 0, PRINT_DOOR).catch(() => 0);
    if (!asked) return "";
    bodyNote("reached-print", "the page opened its print window (window.print)");
    return " The page opened its print window, where a real browser shows the print preview. It does not hold you up: carry on, or call done if printing was what you came to do.";
  }

  /** What her hands say when the move made the page play a sound (`heardSounds`): she has no ears of her own. */
  async function soundSaid() {
    const played = await state.page.evaluate((door) => window[door]?.() ?? 0, SOUND_DOOR).catch(() => 0);
    if (!played) return "";
    return played === 1 ? " A short sound played." : ` ${played} short sounds played.`;
  }

  /** After any move: what her hands say about a print window it opened, a sound it played, then where the page went. */
  async function afterAction(before) {
    return (await printSaid()) + (await soundSaid()) + (await pageChangeSaid(before));
  }

  /** After anything that may have navigated: refuse to stay off-host, reset attention on a new page. */
  async function pageChangeSaid(before) {
    const after = pageUrl();
    if (after === before) return "";
    if (!urlAllowed(after, allowedHosts)) {
      const handedOff = reachExit(after, "a redirect");
      if (!handedOff) bodyNote("left-site", `navigated to ${after} - went back, off the allowed hosts`);
      await navigatingAs("body", "back-off-site", () => state.page.goBack({ waitUntil: "load", timeout: NAV_TIMEOUT_MS })).catch(() => {}); // best-effort: going back off an off-site page is best-effort; the next step re-reads where the page is
      return handedOff ? ` ${handedOff} You are back on the page you came from.` : " That went to a different website, so you came back.";
    }
    clock.newPage();
    // She cannot see the hostname, so being thrown across the site is invisible unless her hands say
    // so. The finding is mechanical (the area changed); what she makes of it is the diary's job.
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

  /**
   * A `canvas: true` game is ONE url for the whole match, so `afterAction` never sees a new page
   * there and every wait she spent watching her fleet fly came out of one attention span: a 13-year-
   * old sent her fleet, waited 25 s twice, and was told "You are bored and irritated with this page"
   * by the tool, not the game (NexusCode-2D, run 20260921-152735-8bbc). So on a canvas target a press
   * that changed the picture refills her attention the way a new page does. `wait` never refills.
   * `pictureNow` is null off a canvas target, so a plain page pays nothing for it.
   */
  async function pictureNow() {
    if (!target.canvas) return null;
    const buffer = await state.page.screenshot({ type: "jpeg", quality: 30, scale: "css" }).catch(() => null);
    return buffer ? createHash("sha1").update(buffer).digest("hex") : null;
  }

  /** After a press on a canvas target: `pictureBefore` from `pictureNow`, `changed` from `afterAction`. */
  async function playedOn(pictureBefore, changed) {
    if (!pictureBefore || changed) return; // off a canvas, or the url moved (afterAction refilled it already)
    const after = await pictureNow();
    if (after && after !== pictureBefore) clock.newPage();
  }

  /** The inventory hands back the attribute as written (often relative); the allow-list needs a host. */
  function absoluteHref(href) {
    if (!href) return null;
    try {
      return new URL(String(href), pageUrl() || target.startUrl).href;
    } catch {
      return String(href);
    }
  }

  function elementById(id) {
    return (state.inventory?.elements ?? []).find((el) => String(el.id) === String(id)) ?? null;
  }

  /**
   * Whether a numbered thing she saw has since scrolled wholly off her screen. contractor-luis looked
   * at the bottom of Pass, scrolled to the top and clicked [4] for the free start in front of him; [4]
   * was still "Get Business Plus", the body scrolled back to it and pressed it, and he filed a $199.99
   * checkout he never chose (run 20260927-090530-2886). Only after her own scroll: a number she was
   * given below the fold, with nothing moved since, is one she read and may still reach for.
   */
  async function offScreenNow(locator) {
    if (!state.scrolledSinceLook) return false;
    const box = await locator
      .evaluate((node) => {
        const r = node.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, h: innerHeight, w: innerWidth };
      })
      .catch(() => null);
    return !!box && (box.bottom <= 0 || box.top >= box.h || box.right <= 0 || box.left >= box.w);
  }

  /** The number her last look gave the element with this data-sue-id, or null. */
  function numberOf(id) {
    for (const [n, shownId] of numbersHere()) if (String(shownId) === String(id)) return n;
    return null;
  }

  /** Her numbers, when they were read on the tab she is looking at; another tab's numbers are dropped. */
  function numbersHere() {
    if (state.clickablePage !== state.page) {
      state.clickable = new Map();
      state.shownAs = new Map();
      state.clickablePage = state.page;
    }
    return state.clickable;
  }

  /**
   * Her numbered element by its stamp: on the page (a locator pierces open shadow roots), else in a
   * same-origin frame set into it, where perception read and stamped it too (`page.frames()`).
   */
  async function sueLocator(id) {
    const selector = `[data-sue-id="${id}"]`;
    const onPage = state.page.locator(selector).first();
    if ((await onPage.count().catch(() => 0)) > 0) return onPage;
    for (const frame of state.page.frames()) {
      if (frame === state.page.mainFrame()) continue;
      const inFrame = frame.locator(selector).first();
      if ((await inFrame.count().catch(() => 0)) > 0) return inFrame;
    }
    return onPage;
  }

  /**
   * `[n]` from the last look (by the stable data-sue-id, kept across inventory runs) or, by words:
   * a choice in the drop-down she just opened, else the visible element whose accessible name says
   * the text exactly (failing that, one that contains it) and was not withheld for hiding behind a
   * dialog, else the one drop-down on the page that has that choice. A choice two lists
   * share, with neither open, is refused and both lists named: guessing put a Sue's channel in the
   * wrong one of four look-alike pickers (run 20260922-063426-626a).
   */
  async function resolveTarget(rawTarget) {
    const targetArg = plainTarget(rawTarget);
    // An open list whose choices are numbers (a standard array: 15, 14, 13...): "14" as words is the
    // choice she was just told to click, not element [14]. Tavern Bag wave 12 (2026-09-23): three Sues
    // picking ability scores landed on other steps, because every pick hit a numbered step pill.
    // A bare JSON number counts too: wave 13 (run 20260923-080921-d3ff) was told `click "15"` and
    // sent 15, which pressed step 8. Only a bracketed [14] still names the element.
    if (
      (typeof rawTarget === "string" || typeof rawTarget === "number") &&
      !/^\s*\[\d+\]\s*$/.test(String(rawTarget)) &&
      /^\d+$/.test(String(targetArg)) &&
      state.openList &&
      state.openList.url === pageUrl()
    ) {
      await runInventory();
      const list = (state.inventory.elements ?? []).find(
        (c) =>
          !c.hidden &&
          !c.behindOverlay &&
          String(c.id) === String(state.openList.id) &&
          c.role === "select" &&
          c.name === state.openList.name,
      );
      if (list && optionIndex(selectChoices(list), String(targetArg)) != null)
        return { el: list, locator: await sueLocator(list.id), label: `"${seenName(list)}"`, choice: String(targetArg) };
    }
    if (typeof targetArg === "number" || /^\d+$/.test(String(targetArg))) {
      const n = Number(targetArg);
      if (state.clickablePage && state.clickablePage !== state.page && state.clickable.size)
        return { error: `Your numbers are from another tab. Call look first to see this one.` };
      const id = numbersHere().get(n);
      if (id == null) return { error: `There is no [${n}] in what you last saw. Call look first.` };
      let el = elementById(id);
      let locator = await sueLocator(id);
      if (!el || (await locator.count()) === 0) {
        await runInventory();
        el = elementById(id);
        locator = await sueLocator(id);
        if (!el || (await locator.count()) === 0) return { error: `[${n}] is not on the page any more. Call look again.` };
      }
      // The number now names a DIFFERENT thing: the card she saw expired and the speed button took its
      // stamp (Nexas round 8, Derek clicked [2] "Call back" and got "1 x"). Her hand never lands there.
      const was = state.shownAs.get(n);
      if (was != null && seenName(el) !== was) return { error: `[${n}] "${was}" is not on the page any more. Call look again.` };
      // The page's own numbers are not hers: an answer a page keys 3 can be her [4] (Lift's choices carry 1, 2, 3). When
      // her [n] is one the page keys with another number and the page's own n is another of hers, she is asked which she
      // means, once; the same number again is her [n] (SUE lift-v2 round 13: the retention doctor meant the page's 3,
      // clicked [3], and her hand landed on the page's 1).
      const named = was ?? seenName(el);
      const keyed = ownNumber(named);
      if (keyed != null && keyed !== String(n) && state.askedWhich !== `${n}:${named}`) {
        const other = [...state.shownAs].find(([m, name]) => m !== n && ownNumber(name) === String(n));
        if (other) {
          state.askedWhich = `${n}:${named}`;
          state.handsAsked = true;
          return {
            error: `Two things answer to ${n}: your [${n}] is "${named}", and the page's own ${n} is your [${other[0]}] "${other[1]}". Click the one you mean; ${n} again means your [${n}].`,
          };
        }
      }
      state.askedWhich = null;
      // A dialog her own last move opened (a date picker) may stand in front of it now, and only a
      // fresh read of the page knows (`numberBlocked`); the element she saw stays the one acted on.
      await runInventory();
      const blocked = numberBlocked(elementById(id), n);
      if (blocked) return { error: blocked };
      if (await offScreenNow(locator))
        return { error: `[${n}] "${was ?? seenName(el)}" is not on your screen now: you have scrolled since you last looked. Call look.` };
      return { el, locator, label: `[${n}]` };
    }
    const wanted = String(targetArg ?? "")
      .trim()
      .toLowerCase();
    if (!wanted) return { error: "Say which element: a number from your last look, or its text." };
    await runInventory();
    const seen = (state.inventory.elements ?? []).filter((candidate) => !candidate.hidden);
    // A control behind a dialog or scrim was given no number by perceive(): she could not hit it.
    const reachable = seen.filter((candidate) => !candidate.behindOverlay);
    const found = async (el) => ({ el, locator: await sueLocator(el.id), label: `"${seenName(el)}"` });
    const hasChoice = (candidate) => candidate.role === "select" && optionIndex(selectChoices(candidate), String(targetArg)) != null;
    const open = state.openList;
    const openList =
      open && open.url === pageUrl()
        ? reachable.find((c) => String(c.id) === String(open.id) && c.role === "select" && c.name === open.name)
        : null;
    if (openList && hasChoice(openList)) return found(openList);
    // She can only type a name she could SEE and hit: a hidden label never matches, an exact name
    // beats one that contains it, and a covered control is refused by its dialog (pickByWords).
    const pick = pickByWords(seen, wanted);
    if (pick?.el) return found(pick.el);
    const lists = reachable.filter(hasChoice);
    if (lists.length === 1) return found(lists[0]);
    if (lists.length > 1) {
      const named = lists.map((list) => `${numberOf(list.id) != null ? `[${numberOf(list.id)}] ` : ""}"${seenName(list)}"`).join(", ");
      return {
        error: `"${targetArg}" is a choice in more than one drop-down list: ${named}. Click the list you mean first (by its number), then click "${targetArg}" and it goes into that list.`,
      };
    }
    if (pick?.blocked)
      return { error: `"${targetArg}" is behind "${String(pick.blocked).slice(0, 80)}" - deal with that dialog first, then click it.` };
    return { error: `Nothing on the page says "${targetArg}". Call look and pick a number.` };
  }

  async function screenshot() {
    state.looks += 1;
    const file = path.join(shotsDir, `look-${String(state.looks).padStart(4, "0")}.jpg`);
    const frame = frameNow();
    let buffer = state.kb.up
      ? await keyboardShot()
      : await state.page.screenshot({ type: "jpeg", quality: 55, scale: target.canvas ? "css" : "device" }).catch(() => null);
    // Shrunk HERE to the size the brain would shrink it to anyway, so the size she is told is the
    // size she sees and a spot she names lands where she saw it.
    if (buffer && frame.shrunk) {
      const { default: sharp } = await import("sharp");
      buffer = await sharp(buffer).resize(frame.width, frame.height, { fit: "fill" }).jpeg(PICTURE_JPEG).toBuffer();
    }
    if (buffer) writeFileSync(file, buffer);
    state.frame = frame;
    // The hash rides the trace, so the report can tell a screen that never moved under her hands
    // (`frozenLooks`) even after the shots themselves are cleared away.
    return {
      file: buffer ? file : null,
      base64: buffer ? buffer.toString("base64") : null,
      hash: buffer ? createHash("sha1").update(buffer).digest("hex") : null,
    };
  }

  /** Her identity for `field:`; the code comes from the newest mail that shows exactly one six-digit run. */
  function substitute(field) {
    switch (field) {
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
        for (const message of productMail(readInbox(mailDir))) {
          const code = singleCode(message.text);
          if (!code) continue;
          if (state.otpEmailLatencyMs == null && state.otpRequestedAt) {
            state.otpEmailLatencyMs = Math.max(0, message._stamp - state.otpRequestedAt);
          }
          return { value: code, secret: true };
        }
        return { error: "There is no code in your email yet. Call check_email, or wait a little and try again." };
      }
      default:
        return { error: `Unknown field "${field}". Use one of: ${[...IDENTITY_FIELDS].join(", ")}.` };
    }
  }

  function recordOutcome(outcome) {
    state.outcome = outcome;
    state.outcomeAt = new Date().toISOString();
    const openUrls = context.pages().flatMap((p) => (p.isClosed() ? [] : [p.url()]));
    state.finalUrl = siteUrlOf(pageUrl(), openUrls, isInboxUrl);
    const pattern = missedLanding({ outcome, url: state.finalUrl, scenario, target });
    if (pattern) {
      bodyNote("wrong-destination", `ended at ${state.finalUrl}, expected ${pattern.source}`, { expected: pattern.source });
    }
  }

  function bodyState() {
    return {
      sueId: sue.sueId,
      device,
      browserMode: mode,
      sharedBrowser: Boolean(shared),
      outcome: state.outcome,
      outcomeAt: state.outcomeAt,
      finalUrl: state.finalUrl ?? pageUrl(),
      interviewed: state.interviewed,
      toolCalls: state.toolCalls,
      looks: state.looks,
      emailTypedAt: state.emailTypedAt ? new Date(state.emailTypedAt).toISOString() : null,
      otpRequestedAt: state.otpRequestedAt ? new Date(state.otpRequestedAt).toISOString() : null,
      doorRefusedAt: state.doorRefusedAt ? new Date(state.doorRefusedAt).toISOString() : null,
      codeSubmittedAt: state.codeSubmittedAt ? new Date(state.codeSubmittedAt).toISOString() : null,
      emailsOpened: state.emailsOpened.size,
      emailsJudged: state.emailsJudged,
      firstInboxCheckAt: state.firstInboxCheckAt ? new Date(state.firstInboxCheckAt).toISOString() : null,
      otpEmailLatencyMs: state.otpEmailLatencyMs,
      patienceExhausted: state.patienceExhausted,
      exitsReached: state.exitsReached,
      clock: clockFacts(clock),
    };
  }

  async function shutdown() {
    if (state.closed) return;
    state.closed = true;
    rest.stop();
    // Her last hops are still being read: their lines are written before her browser goes, never after.
    await hops.settle();
    hops.stop();
    pageTrace.finish();
    try {
      writeFileSync(path.join(sueDir, "body.json"), `${JSON.stringify(bodyState(), null, 2)}\n`, "utf8");
    } catch (err) {
      log("body.json not written:", err?.message ?? err);
    }
    findings.trace({ at: new Date().toISOString(), kind: "end", ...(await readArgusIds(state.page)) });
    // ⛔ SAVE THE SIGNED-IN STATE BEFORE THE CONTEXT GOES. On the shared-browser path her context is a
    // throwaway, so the profile dir a janitor would reuse is empty and she could never sign in
    // (measured 2026-09-22: deletion was never requested). The reaper reads this file back into her
    // own fresh context, so a cleanup pass starts where the original Sue finished.
    try {
      const saved = await context.storageState().catch((err) => {
        // Her browser died under her (`browserLost`) and cannot answer: her last cookies and page
        // storage still let a janitor sign in and delete the account she made.
        log("storage-state from her browser failed, saving her last cookies and page storage:", err?.message ?? err);
        return { cookies: state.cookies, origins: savedOrigins() };
      });
      writeFileSync(path.join(sueDir, "storage-state.json"), `${JSON.stringify(saved, null, 2)}\n`, "utf8");
    } catch (err) {
      log("storage-state.json not written:", err?.message ?? err);
    }
    // Best-effort, after body.json is written; a context that already closed is the goal.
    // On the SHARED path, close her context and only DISCONNECT from the browser - the wave's
    // server belongs to the cannon and her siblings are still using it.
    await endVisit(context); // pagehide + beacon wait + close, bounded: the pixel flushes engagement time before the context goes
    await context.close().catch(() => {}); // already closed by endVisit unless it hung: already gone is the goal
    // `shared` means we connected to the cannon's browser server, so close() only DISCONNECTS us -
    // the other Sues on that server keep theirs. Same muzzle, same reason: already gone is the goal.
    if (shared && browser) await browser.close().catch(() => {});
  }

  // --- her hands: the rails every hand meets, and the element-level moves -----------------------

  /**
   * The rails a hand on `el` meets, whatever the hand is (click and every variant, a drop): a robot
   * check, a box that is not there to see, a box for card details, and lib/rails.mjs (what deletes,
   * and on a borrowed account whatever changes something real). A refusal result, or null.
   * Recorded, never silent. `fileBox` is attach's alone: a page's own file box is usually hidden
   * behind the button that opens it, so for a box of type file (and nothing else) the hidden-field
   * rail does not stop THAT hand; every other rail here still does.
   */
  function railStop(el, label, what, { fileBox = false, passive = false } = {}) {
    if (isCaptchaElement(el)) {
      noteOnce("captcha-challenge", `${what} was aimed at the robot check (${el.name}) - refused, never solved`);
      return { ...refusal(`${label} is a robot check. You cannot do that here; look for another way, or give_up.`), _refused: "captcha" };
    }
    if (isHiddenField(el) && !(fileBox && String(el.inputType ?? "").toLowerCase() === "file"))
      return { ...refusal(`${label} is not a thing you can see. Call look and pick a visible one.`), _refused: "hidden-field" };
    // A passive hand (hover) presses nothing, so it meets no press rail - the captcha and hidden-field
    // checks above still stand, matching how `point` treats a passive pointer.
    if (passive) return null;
    if (TEXT_BOXES.has(el.role) && isPaymentField(el)) {
      return { ...refusal(`${label} asks for card details. You never type those here.`), _refused: "payment-field" };
    }
    const railed = refusedBy(rails, el.name, { role: el.role, href: el.href, submits: el.submits === true });
    if (!railed) return null;
    noteOnce(`refused-${railed}`, `${what} on ${label} "${String(el.name ?? "").slice(0, 80)}" was refused by the ${railed} rail`);
    return { ...refusal(refusalSentence(railed, label)), _refused: railed };
  }

  /**
   * Do `act` to the element, scrolling it into view and trying once more if it will not take it. The failure's first line, or null.
   * The whole try is raced against `handTimeoutMs`: a hand stuck under a heavy page transition answers HAND_TIMED_OUT
   * instead of wedging the move (run 20261005-142442-96ec). A click whose scroll failed gets one coordinate click at the
   * element's last known box.
   */
  async function handOn(locator, act) {
    const attempt = async () => {
      try {
        await act(locator);
        return null;
      } catch (err) {
        const box = await locator.boundingBox({ timeout: 1_000 }).catch(() => null); // best-effort: the fallback's aim; none means no fallback
        await locator.scrollIntoViewIfNeeded({ timeout: 2_000 }).catch(() => {}); // best-effort: a scroll before the retry; the retry itself reports whether the element is reachable
        try {
          await act(locator);
          return null;
        } catch (retryErr) {
          const scrollFailed = /scrollIntoViewIfNeeded/.test(`${err?.message} ${retryErr?.message}`);
          if (box && scrollFailed) {
            const pointed = await state.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2).then(
              () => true,
              () => false,
            );
            if (pointed) return null;
          }
          return String(err?.message ?? err).split("\n")[0];
        }
      }
    };
    let timer;
    const late = new Promise((resolve) => {
      timer = setTimeout(() => resolve(HAND_TIMED_OUT), handTimeoutMs);
    });
    try {
      return await Promise.race([attempt(), late]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * A phone's thumb on `el` (`thumbSpot`): `times` taps, one held `hold` ms, or a drag `onto` another
   * thing. `thumb` is a spot `point` already landed (`at`) and what she aimed at there (`aimedId`).
   * What it hit when that was not what she aimed at goes to `state.thumbMissed`, said by the move
   * and by her next look, so a thumb miss is seen, not imagined.
   */
  async function thumbOn(locator, el, { times = 1, hold = 0, onto = null, thumb = null } = {}) {
    const middle = async (l) => {
      await l.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      const box = await l.boundingBox({ timeout: ACTION_TIMEOUT_MS });
      if (!box) throw new Error("it is not on the screen");
      return [box.x + box.width / 2, box.y + box.height / 2];
    };
    const at = thumb?.at ?? thumbSpot(await middle(locator), (state.taps += 1));
    await missedBy(thumb ? thumb.aimedId : el.id, at);
    const frames = onto ? slide(at, await middle(onto)) : [[at]];
    for (let i = 0; i < times; i++) await touch(state.page, frames, hold);
  }

  /** What her thumb landed on at `at`, said in `state.thumbMissed` when it is not `aimedId` (a frame is never judged). */
  async function missedBy(aimedId, at) {
    const under = await state.page.evaluate(spotUnder, at).catch(() => null);
    const hit = under?.id ? elementById(under.id) : null;
    state.thumbMissed =
      !under || under.frame || String(under.id ?? "") === String(aimedId ?? "")
        ? ""
        : ` Your thumb missed: it landed on ${hit ? `"${seenName(hit)}"` : "nothing"} instead.`;
    if (state.thumbMissed) bodyNote("thumb-miss", state.thumbMissed.trim(), { aimed: aimedId ?? null, hit: under.id ?? null });
  }

  /**
   * " It says ... now." (or "") when the thing under her hand is greyed out NOW, else null. Her number
   * carries what it was at her look, and a page can grey a button out after that: a sign-up code box
   * that sends itself on its last digit left the body pressing a disabled "Verifying..." button until
   * two 8 s waits ran out, and she was told nothing would take the click while the page was signing
   * her in (run 20260922-133522-c2bd, sue-3668-bob). Read live, so one enabled since is pressable too.
   */
  async function greyedOutNow(el, locator) {
    const greyed = await locator.isDisabled({ timeout: 1_000 }).catch(() => Boolean(el.disabled));
    if (!greyed) return null;
    const words = String(await locator.innerText({ timeout: 1_000 }).catch(() => ""))
      .replace(/\s+/g, " ")
      .trim();
    return words && words !== seenWords(el) ? ` It says "${words}" now.` : "";
  }

  /** `click` with a `how` other than click: double-click, right-click, hover, or drag onto `drop`. */
  async function otherHand(hand, { el, locator, label, drop, thumb }) {
    const greyed = hand === "hover" ? null : await greyedOutNow(el, locator);
    if (greyed != null) {
      clock.charge({ actions: 1 });
      return text(`${label} is greyed out, so doing that to it does nothing yet.${greyed} Call look.`);
    }
    const before = pageUrl();
    const tabBefore = state.page;
    if (hand === "right-click") await state.page.evaluate(armMenuWatch).catch(() => {}); // best-effort: without the watch she is simply not told the browser's menu stayed invisible
    // A phone double-taps, long-presses for a right-click, and drags with a finger; it has no hover.
    const acts =
      device === "phone"
        ? {
            "double-click": (l) => thumbOn(l, el, { times: 2, thumb }),
            "right-click": (l) => thumbOn(l, el, { hold: LONG_PRESS_MS, thumb }),
            hover: (l) => l.hover({ timeout: ACTION_TIMEOUT_MS }),
            drag: (l) => thumbOn(l, el, { onto: drop.locator, thumb }),
          }
        : {
            "double-click": (l) => l.dblclick({ timeout: ACTION_TIMEOUT_MS }),
            "right-click": (l) => l.click({ button: "right", timeout: ACTION_TIMEOUT_MS }),
            hover: (l) => l.hover({ timeout: ACTION_TIMEOUT_MS }),
            drag: (l) => l.dragTo(drop.locator, { timeout: ACTION_TIMEOUT_MS }),
          };
    state.thumbMissed = "";
    const tabComing = hand === "double-click" ? await newTabComing(() => locator.evaluate(opensNewTab, null, { timeout: 1_000 })) : null;
    const failed = await handOn(locator, acts[hand]);
    if (failed) return refusal(`You tried to ${hand} ${label} but nothing would take it (${failed}). Call look.`);
    const menu = hand === "right-click" ? await state.page.evaluate(readMenuWatch).catch(() => "page") : "page";
    clock.charge({ actions: 1 });
    if (hand === "double-click" && state.emailTypedAt && OTP_REQUEST_TEXT.test(String(el.name ?? ""))) state.otpRequestedAt = Date.now();
    await newTabLanded(tabComing);
    await settle();
    const changed = await afterAction(before);
    const name = `${label} "${seenName(el)}"`;
    const did = {
      "double-click": `You double-clicked ${name}.`,
      "right-click": `You right-clicked ${name}.${menuSaid(menu)}`,
      hover: `You rested the pointer on ${name} without clicking.`,
      drag: `You dragged ${name} onto ${drop?.label} "${seenName(drop?.el)}".`,
    }[hand];
    return text(`${did}${state.thumbMissed}${newTabSaid(tabBefore)}${changed} Call look to see what happened.`);
  }

  /** The inventory entry for what has the keyboard's focus, or null: a typed character meets the `type` rails through it. */
  async function focusedBox() {
    await runInventory();
    const id = await state.page
      .evaluate(() => document.activeElement?.closest?.("[data-sue-id]")?.getAttribute("data-sue-id") ?? null)
      .catch(() => null);
    return id ? elementById(id) : null;
  }

  /**
   * What a hand at `spot` (CSS pixels), or the keyboard with no spot, really lands in, down through
   * any frames set into the page: `{ captcha }` or `{ offHost }` for a frame it must never reach
   * into (a robot check, or a different website such as a card processor's box), else `fieldAt`'s
   * facts where it lands, or null. The inventory never sees inside a frame, so a raw pointer or a
   * key sent into one would otherwise pass the field rails unread.
   */
  async function landsIn(spot) {
    let frame = state.page.mainFrame();
    let at = spot ?? null;
    for (let depth = 0; depth < 4; depth += 1) {
      const facts = await frame.evaluate(fieldAt, at).catch(() => null);
      if (!facts?.frame) return facts;
      const handle = await frame
        .evaluateHandle((s) => (s ? document.elementFromPoint(s[0], s[1]) : document.activeElement), at)
        .catch(() => null);
      const inner = await handle
        ?.asElement()
        ?.contentFrame()
        .catch(() => null);
      await handle?.dispose().catch(() => {}); // best-effort: a handle left undisposed is only freed with the page
      const address = inner?.url() || facts.frame;
      if (CAPTCHA_FRAME.test(facts.frame) || CAPTCHA_FRAME.test(address)) return { captcha: address };
      if (!urlAllowed(address, allowedHosts)) return { offHost: address };
      if (!inner) return facts;
      frame = inner;
      if (at) at = [at[0] - facts.left, at[1] - facts.top];
    }
    return null;
  }

  /** The refusal for where a raw hand landed (`landsIn`), said as `where` ("That spot", "The box you are in"), or null. Recorded, never silent. */
  function landStop(landed, where, what) {
    if (landed?.captcha) {
      noteOnce("captcha-challenge", `${what} was aimed at the robot check - refused, never solved`);
      return { ...refusal(`${where} is a robot check. You cannot do that here; look for another way, or give_up.`), _refused: "captcha" };
    }
    if (landed?.offHost) {
      noteOnce("refused-off-host-frame", `${what} went into a frame from ${landed.offHost} - off the allowed hosts, refused`);
      return { ...refusal(`${where} is part of a different website set inside this page. You stay here.`), _refused: "off-host-frame" };
    }
    if (landed?.field && isHiddenField(landed))
      return { ...refusal(`${where} is not a thing you can see. Call look and pick a visible one.`), _refused: "hidden-field" };
    if (landed?.field && isPaymentField(landed))
      return { ...refusal(`${where} asks for card details. You never type those here.`), _refused: "payment-field" };
    return null;
  }

  // --- the tools --------------------------------------------------------------------------------
  const readRandom = seededRandom(sue.sueId ?? path.basename(sueDir));

  /** An unsure phrase read on any screen of this page during this visit, the latest first; null when it is nowhere on the page. */
  const unsureOnEarlierScreen = (line) => {
    for (const text of [...(state.looksByPage.get(pageUrl()) ?? [])].reverse()) {
      const phrase = unsureOnScreen(line, text);
      if (phrase) return phrase;
    }
    return null;
  };

  /**
   * The words she read most carefully on this screen, filed as a note of `kind` (lingered, or unsure when they puzzle
   * her) and rested on; null when they are not on that screen. `rest: false` files without a second rest.
   */
  const fileLingered = async (line, kind = "lingered", { rest = true, readAs, seededPause = false } = {}) => {
    const onScreen = unsureOnScreen(line, state.lastLookText);
    const phrase = onScreen ?? (kind === "unsure" ? unsureOnEarlierScreen(line) : null);
    if (!phrase) return null;
    fileNote({ findings, sueDir, decided: {}, kind, text: phrase, url: pageUrl() });
    if (!rest) return phrase;
    if (!onScreen) await scrollBackTo(state.page, phrase);
    // Lingered words on a block her pointer already rested on while she read this screen: that one rest is her stay there,
    // a second would be a return visit, not more reading. An unsure phrase always gets its rest: going back to the words
    // that puzzle her is what a puzzled person does, and that pause is the signal.
    if (kind !== "unsure" && restedBlockOf(phrase, state.readingRests)) return phrase;
    const rested = await restOnPhrase(state.page, phrase, {
      wordsPerMinute: persona?.dials?.wordsPerMinute,
      maxMs: PACE_DIALS.visitCapMs - state.pacedSpentMs,
      // an unsure phrase, or words given on done (which owe no rest, so they get the same seeded pause), pauses 2-4 s
      pauseMs: kind === "unsure" || seededPause ? 2_000 + readRandom() * 2_000 : 1_000,
      ...(readAs ? { readAs, maxMs: Math.min(8_000, PACE_DIALS.visitCapMs - state.pacedSpentMs) } : {}),
    });
    // Her re-reading of words the look already charged her attention for: it counts against the visit's paced time,
    // never again against her attention (run 20261011-134704-9afe: one rest left the next screen unread).
    state.pacedSpentMs += rested;
    clock.rested(rested / 1000);
    return phrase;
  };

  /**
   * She looked at a control and decided not to press it: her pointer goes onto it, rests for the time it takes to
   * read its words and the ones around it that decide it (1.5 s at least), then goes to empty space without a click.
   * `stay` keeps it there when her very next move clicks that control. Returns a line for her, or null.
   */
  const considerControl = async (target, { stay = false } = {}) => {
    if (target == null || String(target).trim() === "") return null;
    const found = await resolveTarget(target);
    if (found.error) return `Not weighed: ${found.error}`;
    // She weighed it on an earlier screen and has since scrolled: bring it back, as a person looks back up at it.
    await found.locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    const spot = await found.locator
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        const x = Math.round(r.left + r.width / 2);
        const y = Math.round(r.top + r.height / 2);
        if (x < 0 || y < 0 || x >= window.innerWidth || y >= window.innerHeight) return null;
        const hit = document.elementFromPoint(x, y);
        if (!hit || !(el.contains(hit) || hit.contains(el))) return null;
        // Its own words and the one line next to them that decides it (the line after, else the line before).
        const own = (el.innerText || "").trim();
        let block = el;
        for (let i = 0; i < 5 && block.parentElement && block.parentElement !== document.body; i += 1) {
          block = block.parentElement;
          if ((block.innerText || "").split(String.fromCharCode(10)).filter((l) => l.trim()).length >= 2) break;
        }
        const lines = (block.innerText || "")
          .split(/\n+/)
          .map((l) => l.trim())
          .filter(Boolean);
        const exact = lines.findIndex((l) => l === own);
        const at = exact >= 0 ? exact : lines.findIndex((l) => l.includes(own));
        const near = at < 0 ? "" : (lines[at + 1] ?? lines[at - 1] ?? "");
        return { x, y, words: `${own} ${near}`.slice(0, 400) };
      })
      .catch(() => null);
    if (!spot) return "Not weighed: that control is not on your screen.";
    const weighed = weighMs(wordsOf(spot.words).length, { wordsPerMinute: persona?.dials?.wordsPerMinute, random: readRandom });
    await state.page.mouse.move(spot.x, spot.y, { steps: 10 });
    await state.page.waitForTimeout(weighed);
    state.pacedSpentMs += weighed;
    clock.rested(weighed / 1000);
    if (!stay) {
      const leave = await state.page.evaluate(LEAVE_SPOT).catch(() => null);
      if (leave) await state.page.mouse.move(leave.x, leave.y, { steps: 10 }).catch(() => {});
    }
    return null;
  };

  /** A `considered` carried by a move: weighed before the move runs; a click on that same control keeps the pointer on it. */
  const takeConsidered = async (name, args) => {
    if (!readingMode || args?.considered == null || String(args.considered).trim() === "" || isNone(String(args.considered))) return null;
    let stay = false;
    if (name === "click" && args.target != null && String(args.how ?? "click").toLowerCase() === "click") {
      const [a, b] = [await resolveTarget(args.considered), await resolveTarget(args.target)];
      stay = Boolean(a.el && b.el && String(a.el.id) === String(b.el.id));
    }
    return considerControl(args.considered, { stay });
  };

  const handlers = {
    async look() {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      // Chrome's own failed-load page is not the product's site and not a Sue wandering off it: the
      // start page never came up. File the load failure and answer, so an error page is never read as
      // left-site or as a blank dead-end.
      if (isLoadFailureUrl(pageUrl())) {
        noteOnce("http-error", `the page did not load (${pageUrl()})`);
        return text("The website is not answering and the page never loaded. Call give_up if it will not come up.");
      }
      if (!urlAllowed(pageUrl(), allowedHosts)) {
        bodyNote("left-site", `found the page at ${pageUrl()} - went back, off the allowed hosts`);
        await navigatingAs("body", "back-off-site", () => state.page.goBack({ waitUntil: "load", timeout: NAV_TIMEOUT_MS })).catch(
          () => {},
        ); // best-effort: going back off an off-site page is best-effort; the next step re-reads where the page is
      }
      await syncKeyboard(false); // the page itself may have moved the focus off her box since her last move
      // A screen change that waits on a network answer starts its fade AFTER her click's settle has
      // returned, so the look waits out any fade still running itself: esl-maria photographed the
      // accounts signup step mid-crossfade and filed "words on top of words" (run 20260922-224205-1d7b).
      // A page still loading has started none of its animations yet, so there is nothing to wait out:
      // the look first waits for it to load. Lift's Finish saves, then goes to the class page; the
      // retention doctor's look came while that page was loading, before its level-up had started, and
      // she filed a false "no level-up moment" (SUE round 10 of series lift-v2, 2026-10-04).
      // What she reads and what she sees are one page. Lift's last answer saves and then goes to the class page; the
      // retention doctor's look began on the lesson, read its words, and took its picture after the class page had
      // replaced it, mid-level-up: the lesson's words under the class page's address, and "the bar looks about as
      // full as before" (SUE round 17 of series lift-v2, 2026-10-04). A look whose page became another document
      // between the reading and the picture reads the new one, from its load on; its stale picture is overwritten.
      let stillMoving;
      let inventory;
      let shot = null;
      for (let read = 1; ; read += 1) {
        await state.page.waitForLoadState("load", { timeout: 5_000 }).catch(() => {}); // best-effort, as in settle(): a page that never fires load is still read as it stands
        stillMoving = await waitForStillness(false);
        const textWaitMs = await waitForTextToSettle(state.page).catch(() => 0); // best-effort: a page mid-navigation has no text to watch; the look reads it as it stands
        clock.charge({ waitMs: textWaitMs });
        const before = await documentOf();
        const last = read === LOOK_READS;
        // A page mid-navigation has no document to read: only the last read lets that failure reach her.
        inventory = last ? await runInventory() : await runInventory().catch(() => null);
        if (inventory) shot = await screenshot();
        if (inventory && before !== null && (await documentOf()) === before) break;
        if (last) {
          noteOnce("look-page-moved", `the page became another document during each of ${LOOK_READS} reads of one look`);
          break;
        }
        if (shot) {
          if (shot.file) rmSync(shot.file, { force: true }); // a next picture that fails never leaves this page's under her number
          state.looks -= 1; // the next picture takes this one's number
        }
        shot = null;
      }
      if (stillMoving.length) {
        const which = stillMoving.map((m) => `${m.name} still had ${m.remainingMs} ms to run`).join(", and ");
        noteOnce("look-mid-motion", `the look was taken while ${which} (the stillness cap is ${STILLNESS_CAP_MS} ms)`, {
          moving: stillMoving,
        });
      }
      const view = perceive(readingMode ? screenOnly(inventory) : inventory, persona);
      // She read this much of the page: move the viewport that far, like a reader (the pixel counts scroll events).
      // Paced reading keeps the viewport where it is: she reads what is on screen and scrolls only by her own move.
      if (!readingMode) {
        const shownOf = view.stats?.wordsTotal > 0 ? view.stats.wordsShown / view.stats.wordsTotal : 0;
        await scrollLikeAReader(state.page, shownOf);
      }
      state.lastLookName = shot?.file ? path.basename(shot.file) : null;
      state.lastLookText = view.text;
      state.looksByPage.set(pageUrl(), [...(state.looksByPage.get(pageUrl()) ?? []), view.text]);
      state.clickable =
        view.clickable instanceof Map ? view.clickable : new Map(Object.entries(view.clickable ?? {}).map(([k, v]) => [Number(k), v]));
      state.shownAs = new Map([...state.clickable].map(([n, id]) => [n, seenName(elementById(id))]));
      state.clickablePage = state.page;
      state.scrolledSinceLook = false;
      // What she has now SEEN, for the address bar: this page, the links this look actually showed
      // her (numbered: never one past where she stopped reading, scrolled past, or hidden), and any
      // address written in the words she read.
      noteSeen(state.seen, pageUrl());
      const shown = new Set([...state.clickable.values()].map(String));
      for (const el of inventory.elements ?? []) if (el.href && shown.has(String(el.id))) noteSeen(state.seen, absoluteHref(el.href));
      for (const href of urlsIn(view.text, defaultProtocol)) noteSeen(state.seen, href);
      // Charge only what is NEW to her on this page: glancing again at a page she has read costs a
      // glance, not a re-read. `readBlocks` is absent only from an older perception; then the whole
      // look is new, as it always was.
      if (state.readUrl !== pageUrl()) {
        state.readUrl = pageUrl();
        state.readKeys = new Set();
      }
      const freshWords = freshWordsOf(view, state.readKeys);
      if (readingMode) {
        const attentionMs = Number(persona.dials?.attentionSeconds) > 0 ? clock.attentionLeft() * 1000 : Infinity;
        const waitMs = paceWaitMs(freshWords, {
          mode: readingMode,
          spentMs: state.pacedSpentMs,
          attentionMs,
          wordsPerMinute: persona?.dials?.wordsPerMinute,
        });
        state.pacedSpentMs += waitMs;
        state.readingRests = await restWhileReading(state.page, waitMs, {
          random: readRandom,
          wordsPerMinute: persona?.dials?.wordsPerMinute,
        });
      }
      clock.read(freshWords);

      const interactiveAbove = (inventory.elements ?? []).filter((el) => el.aboveFold && !el.hidden && !el.disabled);
      if (interactiveAbove.length === 0) noteOnce("dead-end", "nothing to click above the fold");
      // The same page again after she did something on it: her moves are not moving the site.
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
      if (inventory.captcha?.present && inventory.captcha.interactive) {
        noteOnce("captcha-challenge", `${inventory.captcha.kind ?? "captcha"} challenge shown - never solved`, {
          kind: inventory.captcha.kind ?? null,
        });
      }
      if (!state.doorRefusedAt && sueDoorRefused({ saw: view.text, otpRequestedAt: state.otpRequestedAt, inbox: readInbox(mailDir) })) {
        state.doorRefusedAt = Date.now();
        bodyNote(
          SUE_DOOR_REFUSED,
          'asked for a code; the page says "Unable to process this request" and no code reached her inbox. Our Sue sign-up door refused her (key or robot check), not the site',
        );
      }

      // A canvas game never changes page: a picture her own hand changed refills her attention instead.
      clock.picture(shot.hash, { canvas: Boolean(target.canvas) });
      const thumbMissed = state.thumbMissed;
      state.thumbMissed = "";
      const newTab = state.unannouncedTab;
      state.unannouncedTab = false;
      const buzz = phoneBuzz(readInbox(mailDir), state.mailAnnounced);
      const mood = clock.state();
      const moodLine = mood === "bored" || mood === "exhausted" ? clock.mood() : "";
      if (mood === "bored") noteOnce("bored", "attention spent on this page without a click");
      if (mood === "exhausted") patienceGone();
      // A focus-group Sue already hears every diary line at the table (focus.heardNote), so only a lone Sue is listed the run's filings.
      const filedHere = focus
        ? null
        : filedHereAt({ runDir, sueId: path.basename(sueDir), url: pageUrl(), shown: state.filedShown, truths });
      const body = lookText(view.text, {
        thumbMissed,
        newTab,
        buzz,
        keyboardUp: state.kb.up,
        fullScreen: await state.page.evaluate(() => Boolean(document.fullscreenElement)).catch(() => false),
        mood,
        moodLine,
        circleNudge,
        filedHere,
        frame: state.frame ?? frameNow(),
        puzzleAsk: Boolean(readingMode),
      });
      const content = [];
      if (shot.base64) content.push({ type: "image", data: shot.base64, mimeType: "image/jpeg" });
      content.push({ type: "text", text: body });
      // The page's own words ride to the trace (never to her): the trace keeps 200 characters of what she was told, and a
      // hearing's drafter needs the screens she saw whole (sue.mjs screensSeen). So does the filed list, which comes last.
      return { content, _screenshot: shot.file, _shotHash: shot.hash, _pageText: view.text, _filedHere: filedHere };
    },

    /**
     * A hand on a numbered thing. `how` is click (the default), double-click, right-click, hover, or
     * drag it `onto` another numbered thing. Every rail a click meets, every variant that presses
     * meets; a hover presses nothing, so it meets only the captcha and hidden-field checks.
     */
    async click({ target: targetArg, how = "click", onto }, thumb = null, spot = null) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const hand = String(how ?? "click").toLowerCase();
      if (!CLICK_HOWS.includes(hand)) return refusal(`how is one of: ${CLICK_HOWS.join(", ")}.`);
      if (hand === "drag" && (onto == null || onto === ""))
        return refusal("Say where to drop it: onto, a number from your last look or its words.");
      const found = await resolveTarget(targetArg);
      if (found.error) return refusal(found.error);
      const { el, locator, label, choice } = found;
      const stopped = railStop(el, label, "a click", { passive: PASSIVE_POINTER.has(hand) });
      if (stopped) return stopped;
      await reachAboveKeyboard(locator, label);
      let drop = null;
      if (hand === "drag") {
        drop = await resolveTarget(onto);
        if (drop.error) return refusal(drop.error);
        if (drop.el.id === el.id) return refusal(`${label} cannot be dropped onto itself. Say where to drop it.`);
        const dropStopped = railStop(drop.el, drop.label, "a drop");
        if (dropStopped) return dropStopped;
      }
      const href = absoluteHref(el.href);
      // A hover presses nothing and follows no link, so it is not an exit and meets no off-host rail,
      // exactly as `point` treats a passive pointer.
      if (href && !urlAllowed(href, allowedHosts) && !PASSIVE_POINTER.has(hand) && hand !== "click" && hand !== "double-click") {
        bodyNote("left-site", `a ${hand} on ${label} would have gone to ${href} - refused`, { href });
        return { ...refusal(`${label} goes to a different website. You leave it alone and stay here.`), _refused: "off-host" };
      }
      if (href && !urlAllowed(href, allowedHosts) && !PASSIVE_POINTER.has(hand)) {
        // A declared exit is still never followed (the rail), but it is progress, not wandering off.
        const handedOff = reachExit(href, `a click on ${label}`);
        if (handedOff) {
          clock.charge({ actions: 1 });
          return { ...text(`You clicked ${label} "${seenName(el)}". ${handedOff}`), _refused: "exit" };
        }
        bodyNote("left-site", `a click on ${label} would have gone to ${href} - refused`, { href });
        return { ...refusal(`${label} goes to a different website. You stay here.`), _refused: "off-host" };
      }
      if (hand !== "click") return otherHand(hand, { el, locator, label, drop, thumb });
      const greyed = await greyedOutNow(el, locator);
      if (greyed != null) {
        clock.charge({ actions: 1 });
        return text(`${label} is greyed out, so pressing it does nothing yet.${greyed} Call look.`);
      }
      // A drop-down list: a hand picks an option from it, and a click on the closed box can never
      // do that in a real browser under automation. Clicking it by an option's words picks that
      // option; clicking it by number (or its name) opens it: every choice is said, and the choice
      // she names next goes into this list.
      if (el.role === "select") {
        // `choice`: resolveTarget read a number as a choice of the list she has open (a standard array).
        const wanted = choice ?? optionWords(targetArg);
        // The choice's own words meet the rails that read every role (what deletes, what signs the
        // lent session out); they rode in the list's name until the name became its label.
        const choiceRailed = wanted ? refusedBy(rails, wanted, { role: "select" }) : null;
        if (choiceRailed) {
          noteOnce(`refused-${choiceRailed}`, `a pick of "${wanted.slice(0, 80)}" in ${label} was refused by the ${choiceRailed} rail`);
          return { ...refusal(refusalSentence(choiceRailed, `"${wanted}"`)), _refused: choiceRailed };
        }
        if (wanted) {
          try {
            const { label: picked, stuck, shows } = await selectByLabelOrValue(locator, wanted, state.page);
            state.openList = null;
            clock.charge({ actions: 1 });
            await settle();
            if (!stuck) return text(selectDidNotStick(label, picked, shows));
            return text(
              `You picked "${picked}" from the list${seenWords(el) && seenWords(el) !== picked ? ` "${seenWords(el)}"` : ""}. Call look.`,
            );
          } catch {
            // Her words named the box, not one of its options: fall through to the list of choices.
          }
        }
        state.openList = { id: el.id, name: el.name, url: pageUrl() };
        const choices = selectChoices(el);
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
      const before = pageUrl();
      const tabBefore = state.page;
      const pictureBefore = await pictureNow();
      state.thumbMissed = "";
      const tabComing = await newTabComing(() => locator.evaluate(opensNewTab, null, { timeout: 1_000 }));
      const failed = await handOn(
        locator,
        device === "phone"
          ? (l) => thumbOn(l, el, { thumb })
          : spot
            ? () => state.page.mouse.click(...spot)
            : (l) => l.click({ timeout: ACTION_TIMEOUT_MS }),
      );
      if (failed) return refusal(`You tried ${label} but nothing would take the click (${failed}). Call look.`);
      clock.charge({ actions: 1 });
      if (state.emailTypedAt && OTP_REQUEST_TEXT.test(String(el.name ?? ""))) state.otpRequestedAt = Date.now();
      await newTabLanded(tabComing);
      await settle();
      const changed = await afterAction(before);
      await playedOn(pictureBefore, changed);
      const pickerOpened = device === "phone" ? await pickerOpenNow() : "";
      return text(
        `You clicked ${label} "${seenName(el)}".${state.thumbMissed}${newTabSaid(tabBefore)}${changed}${pickerOpened} Call look to see what happened.`,
      );
    },

    async type({ target: targetArg, text: textArg, field }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const found = await resolveTarget(targetArg);
      if (found.error) return refusal(found.error);
      const { el, locator, label } = found;
      if (isHiddenField(el))
        return { ...refusal(`${label} is not a box you can see. Call look and pick a visible one.`), _refused: "hidden-field" };
      if (isPaymentField(el))
        return { ...refusal(`${label} asks for card details. You never type those here.`), _refused: "payment-field" };
      if (String(el.inputType ?? "").toLowerCase() === "file")
        return refusal(`${label} is for picking a file from your computer, not for typing. Use attach with one of your files.`);
      await reachAboveKeyboard(locator, label);
      let value = textArg;
      let secret = false;
      if (field != null) {
        const sub = substitute(String(field));
        if (sub.error) return refusal(sub.error);
        value = sub.value;
        secret = Boolean(sub.secret);
      }
      if (value == null || value === "") return refusal("Give me `text` to type, or a `field` such as my-email.");
      // Only HAND-TYPED text is screened for a guessed code. A `field:` value is the body's own
      // (her address, her phone, her birthday) and is never refused - the first live Sue was
      // refused her own email address for the six digits its run id carried (2026-09-21).
      // A target whose mailbox kind is "none" sends no codes at all, so six digits there are just a
      // number: rbittorrent's playtest (2026-09-25) refused "500000" typed into an upload speed limit.
      // And a code her errand hands her is hers, never a guess (findings.mjs codesNotGiven).
      if (field == null && target.mailbox?.kind !== "none" && codesNotGiven(String(value), sue.errand).length) {
        return refusal("Do not type the code yourself. Use field: the-code-from-my-email and the body will read it out of your inbox.");
      }
      // A birthday asked for in PARTS (a month select, a day box, a year box - AEGIS's signup form
      // is one) gets the part that box is for, not the whole ISO date: two live Sues on 2026-09-21
      // typed "1948-03-14" into "day", saw garbage, called the form broken and gave up.
      let birthdayPart = field === "my-birthday" ? birthdayPartName(el, String(value)) : null;
      // Except at a computer, where a person types her whole birthday into the first box, Month, as
      // keys, and a split date field fills the day and year from them (AppBirthdayField does). Set
      // without a key, only the month went in: bob and coach-tamika (2026-10-06) were told so.
      const wholeBirthday =
        birthdayPart === "month" && el.role === "select" && device === "desktop" ? birthdayAsTyped(String(value)) : null;
      // On a phone the Month is the system picker: she picks it, then fills the day and year boxes.
      const phoneBirthday = birthdayPart === "month" && el.role === "select" && device === "phone" ? String(value) : null;
      let pickedWhole = null;
      if (field === "my-birthday") value = birthdayPartFor(el, String(value));
      if (isCaptchaElement(el)) {
        noteOnce("captcha-challenge", `typing was aimed at the robot check (${el.name}) - refused, never solved`);
        return { ...refusal(`${label} is a robot check. You never fill it in; look for another way, or give_up.`), _refused: "captcha" };
      }
      // A drop-down's choice is a choice wherever the hand comes from: typing on a select puts that
      // option in the list, so its words meet the same session and destructive rails a click's pick
      // meets (click, above). Every other role's words are her own and are never refused.
      if (el.role === "select") {
        const choiceRailed = refusedBy(rails, String(value), { role: "select" });
        if (choiceRailed) {
          noteOnce(
            `refused-${choiceRailed}`,
            `typing "${String(value).slice(0, 80)}" into ${label} was refused by the ${choiceRailed} rail`,
          );
          return { ...refusal(refusalSentence(choiceRailed, `"${value}"`)), _refused: choiceRailed };
        }
      }
      const before = pageUrl();
      // A native date, time or month box answers with the phone's own picker, which a headless browser
      // never draws: what she types is read as a person's date and time and set the way a picker sets it.
      const pickKind = device === "phone" && el.role === "input" ? pickerKind(el.inputType) : null;
      if (pickKind) {
        const current = await locator.inputValue({ timeout: 1_000 }).catch(() => "");
        const parsed = parsePickerInput(value, pickKind, current);
        if (!parsed) {
          clock.charge({ actions: 1 });
          return text(
            `You typed "${String(value).slice(0, TYPED_SAID_MAX)}" into ${label} "${seenName(el)}". ${pickerDidNotUnderstand(pickKind)} It still shows ${current || "nothing"}.`,
          );
        }
        let shown;
        try {
          shown = await locator.evaluate(setPickerValue, parsed.value, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
          return refusal(`The picker would not open for ${label} (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
        }
        clock.charge({ actions: 1 });
        await settle();
        const changed = await afterAction(before);
        return text(`${pickerSetSentence(pickKind, label, seenName(el), shown, parsed.defaultedTime)}${changed}`);
      }
      // A box a framework editor draws (contenteditable, role=textbox: a chat app's composer) only
      // believes words that arrive as keys, so it gets her real keystrokes: click in, select what is
      // there (her words replace it, as fill() does in a native box), type. A native input or
      // textarea keeps fill(). A failure here is reported, never retried, so nothing is typed twice.
      const rich = el.role !== "select" && (await locator.evaluate(isRichTextBox).catch(() => false));
      if (rich) {
        try {
          await locator.click({ timeout: ACTION_TIMEOUT_MS });
          await state.page.keyboard.press("ControlOrMeta+A");
          // A typed newline is an Enter key, which would send the message past the rails; Enter is
          // its own press, where the rails read it.
          await state.page.keyboard.type(String(value).replace(/[\r\n]+/g, " "));
        } catch (err) {
          return refusal(`You could not type into ${label} (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
        }
      } else {
        try {
          // A plain select ignores a typed date; she then picks the month, and is told only it went in.
          const typedWhole = wholeBirthday != null && (await typeWholeBirthday(locator, state.page, wholeBirthday, value));
          if (!typedWhole && phoneBirthday != null)
            pickedWhole = await pickWholeBirthdayOnPhone(locator, state.page, phoneBirthday, String(value), `${label} "${seenName(el)}"`);
          if (typedWhole) {
            value = wholeBirthday;
            birthdayPart = null;
          } else if (pickedWhole) {
            birthdayPart = null;
          } else if (el.role === "select") {
            const { label: picked, stuck, shows } = await selectByLabelOrValue(locator, String(value), state.page);
            if (!stuck) return text(selectDidNotStick(label, picked, shows));
          } else await locator.fill(String(value), { timeout: ACTION_TIMEOUT_MS });
        } catch {
          // The tap into the box is a real click on it, so it meets the rails a click meets: only a
          // text box may be tapped, and never a robot check or a control that leaves the site. Without
          // this, a fill() that always fails on a button or link fell through to an unrailed click, and
          // a mis-aimed word match on a "Delete server" button pressed it (review 2026-09-22).
          const tapHref = absoluteHref(el.href);
          const tapRail = typeTapRail(el, { href: tapHref, allowedHosts });
          if (tapRail === "captcha") {
            noteOnce("captcha-challenge", `typing on ${label} was aimed at the robot check - refused, never solved`);
            return {
              ...refusal(`${label} is a robot check. You cannot do that here; look for another way, or give_up.`),
              _refused: "captcha",
            };
          }
          if (tapRail === "off-host") {
            bodyNote("left-site", `typing on ${label} would have clicked through to ${tapHref} - refused`, { href: tapHref });
            return { ...refusal(`${label} goes to a different website. You stay here.`), _refused: "off-host" };
          }
          if (tapRail) return { ...refusal(notABoxSaid(el, label)), _refused: tapRail };
          try {
            await locator.click({ timeout: ACTION_TIMEOUT_MS });
          } catch (err) {
            return refusal(
              `You could not type into ${label} "${seenName(el)}" (${String(err?.message ?? err).split("\n")[0]}). Call look.`,
            );
          }
          // A tap on a thing that is not a box leaves the keys going nowhere, and she sees no box to
          // type in: a button aimed at with a number from before a dialog opened was answered with a
          // timeout, and a Sue filed the form as refusing her typing (run 20260922-133522-5354).
          if (el.role !== "select" && !(await readFocus(state.page)))
            return refusal(`${label} "${seenName(el)}" is not a box to type in, so your typing went nowhere. Call look.`);
          // A typed newline is an Enter key, which would submit the form past the rails; Enter is
          // its own press, where the rails read it.
          await state.page.keyboard.type(String(value).replace(/[\r\n]+/g, " "));
        }
      }
      clock.charge({ actions: 1 });
      if (field === "my-email") state.emailTypedAt = Date.now();
      if (field === "the-code-from-my-email" && state.codeSubmittedAt == null) state.codeSubmittedAt = Date.now();
      // What the box holds now, read before anything settles: a box with a length limit takes the
      // first letters and drops the rest, and a person sees that in the box.
      const held = TEXT_BOXES.has(el.role) && !secret ? await locator.inputValue({ timeout: 1_000 }).catch(() => null) : null;
      await settle();
      const changed = await afterAction(before);
      if (pickedWhole) return text(`${pickedWhole}${changed}`);
      // Her words in full: cutting them at 60 characters made a Sue read her own note back without
      // its last word and file the notes box as cutting her off (run 20260922-133522-5354).
      const said = String(value);
      const shown = secret
        ? "the code from your email"
        : birthdayPart
          ? `the ${birthdayPart} of your birthday, "${said}",`
          : wholeBirthday && said === wholeBirthday
            ? `your birthday, "${said}",`
            : field
              ? `your ${String(field).replace(/^my-/, "").replace(/-/g, " ")}`
              : `"${said.length > TYPED_SAID_MAX ? `${said.slice(0, TYPED_SAID_MAX)}..." (and the rest of what you typed)` : `${said}"`}`;
      const tookLess = held != null && held.length < said.length && said.startsWith(held) ? ` The box only took "${held}".` : "";
      return text(`You typed ${shown} into ${label} "${seenName(el)}".${tookLess}${changed}`);
    },

    /**
     * One of HER files into the page (`pickHerFile`: only a name the cannon copied into her folder).
     * On a numbered thing: a file box itself, or the one it stands for (its label's, the one inside
     * it - usually hidden behind a styled button), takes the file directly; anything else is clicked
     * while the body waits for the window to pick a file, and the file is picked in it. Every rail a
     * click meets applies to the thing she named; the hidden-field rail alone steps aside, and only
     * for a box of type file (`railStop`'s `fileBox`). With no target, the window her own last hand
     * opened (the default handler in `watch`) takes it, if it is still on the page she is on.
     */
    async attach({ target: targetArg, file }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const picked = pickHerFile(herFiles, file);
      if (picked.error) return refusal(picked.error);
      const filePath = path.join(herFilesDir, picked.name);
      if (!existsSync(filePath))
        return refusal(`Your file "${picked.name}" is not on your computer any more. Your files: ${herFiles.join(", ")}.`);
      const before = pageUrl();
      const tabBefore = state.page;
      let into;
      if (targetArg == null || targetArg === "") {
        const open = state.chooser;
        const stillThere =
          open && open.page === state.page && !open.page.isClosed()
            ? await open.chooser
                .element()
                .evaluate((node) => node.isConnected)
                .catch(() => false)
            : false;
        if (!stillThere)
          return refusal(
            "No window to pick a file is open. Say which thing opens one: target, a number from your last look (an upload button, a file box or a drop area).",
          );
        try {
          await open.chooser.setFiles(filePath, { timeout: ACTION_TIMEOUT_MS });
        } catch (err) {
          return refusal(`Your file would not go in (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
        }
        state.chooser = null;
        into = "in the window to pick a file";
      } else {
        const found = await resolveTarget(targetArg);
        if (found.error) return refusal(found.error);
        const { el, locator, label } = found;
        if (el.role === "select")
          return refusal(
            `${label} is a drop-down list, not a place for a file. Call look and pick the thing that opens a window to pick a file.`,
          );
        const stopped = railStop(el, label, "attaching a file", { fileBox: true });
        if (stopped) return stopped;
        if (el.disabled) {
          clock.charge({ actions: 1 });
          return text(`${label} is greyed out, so it takes no file yet. Call look.`);
        }
        const href = absoluteHref(el.href);
        if (href && !urlAllowed(href, allowedHosts)) {
          bodyNote("left-site", `attaching a file with ${label} would have gone to ${href} - refused`, { href });
          return { ...refusal(`${label} goes to a different website. You stay here.`), _refused: "off-host" };
        }
        await reachAboveKeyboard(locator, label);
        const handle = await locator.evaluateHandle(fileBoxOf).catch(() => null);
        const box = handle?.asElement() ?? null;
        if (box) {
          try {
            await box.setInputFiles(filePath, { timeout: ACTION_TIMEOUT_MS });
          } catch (err) {
            return refusal(`Your file would not go into ${label} (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
          } finally {
            await handle.dispose().catch(() => {}); // best-effort: a handle left undisposed is only freed with the page
          }
        } else {
          await handle?.dispose().catch(() => {}); // best-effort: as above
          state.attaching = true;
          let chooser;
          let failed;
          try {
            const opening = state.page.waitForEvent("filechooser", { timeout: ACTION_TIMEOUT_MS }).catch(() => null);
            failed = await handOn(locator, (l) => l.click({ timeout: ACTION_TIMEOUT_MS }));
            chooser = failed ? null : await opening;
          } finally {
            state.attaching = false;
          }
          if (failed) return refusal(`You tried ${label} but nothing would take the click (${failed}). Call look.`);
          if (!chooser) {
            clock.charge({ actions: 1 });
            await settle();
            const changed = await afterAction(before);
            return refusal(
              `You clicked ${label} "${seenName(el)}", but no window to pick a file opened, so your file went nowhere.${newTabSaid(tabBefore)}${changed} Call look.`,
            );
          }
          try {
            await chooser.setFiles(filePath, { timeout: ACTION_TIMEOUT_MS });
          } catch (err) {
            return refusal(
              `A window to pick a file opened, but your file would not go in (${String(err?.message ?? err).split("\n")[0]}). Call look.`,
            );
          }
        }
        into = `with ${label} "${seenName(el)}"`;
      }
      clock.handsMoved();
      clock.charge({ actions: 1 });
      await settle();
      const changed = await afterAction(before);
      return text(`You attached your file "${picked.name}" ${into}.${newTabSaid(tabBefore)}${changed} Call look to see what happened.`);
    },

    /**
     * A key tapped, or HELD: `holdMs` (100 to 5000) keeps it down that long before it comes up, and `keys` (or
     * "D+Space" in `key`) holds several together, so a Sue in a game can walk and jump. A tap moves a character for
     * one frame; a held key is what a person does. Every key named meets every rail a lone tap meets.
     */
    async press({ key, keys, holdMs }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const reads = keysNamed(key, keys).map(readKey);
      if (!reads.length || reads.some((r) => !r))
        return refusal(
          'Name a key, with Ctrl, Shift or Alt in front if you hold them: Enter, Tab, E, Ctrl+A, Shift+Tab, Escape, Space. To hold keys down, give holdMs (100 to 5000) and, for several together, keys: ["D", "Space"].',
        );
      const hold = readHold(holdMs);
      const label = reads.map((r) => r.combo.trim() || "Space").join(" + ");
      for (const said of reads) {
        const keyRail = refusedKey(rails, said);
        if (keyRail) {
          noteOnce(`refused-${keyRail}`, `pressing ${said.combo} was refused by the ${keyRail} rail`);
          return { ...refusal(refusalSentence(keyRail, `pressing ${said.combo} here`)), _refused: keyRail };
        }
        // A character lands in whatever box has the focus: the `type` rails read it, or one key at a
        // time would walk past them into a hidden box or a card box. A focus inside a frame set into
        // the page (a card processor's box) has no number, so the rails read it through the frame.
        const lands = said.printable || said.key === "Enter" || said.key === "Space";
        const box = lands ? await focusedBox() : null;
        if (said.printable && box && isHiddenField(box))
          return { ...refusal("The box you are in is not one you can see. Call look and pick a visible one."), _refused: "hidden-field" };
        if (said.printable && box && TEXT_BOXES.has(box.role) && isPaymentField(box))
          return { ...refusal("The box you are in asks for card details. You never type those here."), _refused: "payment-field" };
        if (lands && !box) {
          const stopped = landStop(await landsIn(null), "The box you are in", `pressing ${said.combo}`);
          if (stopped) return stopped;
        }
        // Enter in a form presses its submit button, and Enter or Space on a focused button presses
        // that: the rails read those the way they read a click, or a key would walk past them.
        if (said.key === "Enter" || said.key === "Space") {
          const pressed = await whatAKeyPresses([...said.held, said.key].join("+"));
          const railed = pressed.map((p) => refusedBy(rails, p.name, p)).find(Boolean);
          if (railed) {
            const name = pressed.find((p) => refusedBy(rails, p.name, p))?.name ?? "";
            noteOnce(
              `refused-${railed}`,
              `${said.combo} would have pressed "${String(name).slice(0, 80)}" - refused by the ${railed} rail`,
            );
            return {
              ...refusal(refusalSentence(railed, `pressing ${said.combo.trim() || "Space"} here (it presses "${name}")`)),
              _refused: railed,
            };
          }
          // A form sent with Enter asks for the code without a click: record the request moment here
          // too, or the report funnel counts a Sue who asked and read a code as never having asked.
          if (said.key === "Enter" && state.emailTypedAt && pressed.some((p) => OTP_REQUEST_TEXT.test(String(p.name ?? ""))))
            state.otpRequestedAt = Date.now();
        }
      }
      const before = pageUrl();
      const tabBefore = state.page;
      const pictureBefore = await pictureNow();
      const tabComing = reads.some((r) => r.key === "Enter")
        ? await newTabComing(async () => (await state.page.evaluateHandle(() => document.activeElement)).evaluate(opensNewTab))
        : null;
      if (hold == null && reads.length === 1) await state.page.keyboard.press(reads[0].combo);
      else {
        // Down in the order named (modifiers first), a real wait, then up in reverse, even if the page throws, so a key is never left stuck.
        const names = [];
        for (const r of reads) for (const k of [...r.held, r.key === "Space" ? " " : r.key]) if (!names.includes(k)) names.push(k);
        const down = [];
        try {
          for (const k of names) {
            await state.page.keyboard.down(k);
            down.push(k);
          }
          if (hold) await sleep(hold);
        } finally {
          for (const k of down.reverse()) await state.page.keyboard.up(k).catch(() => {});
        }
      }
      // Playwright's Escape never reaches the browser's own Esc, which is what ends a full screen a person entered.
      if (hold == null && reads.length === 1 && reads[0].key === "Escape" && !reads[0].held.length)
        await state.page.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
      clock.handsMoved();
      clock.charge({ actions: 1 });
      await newTabLanded(tabComing);
      await settle();
      const changed = await afterAction(before);
      await playedOn(pictureBefore, changed);
      const said =
        hold || reads.length > 1 ? `You held ${label}${hold ? ` for ${(hold / 1000).toFixed(1)} s` : ""}` : `You pressed ${label}`;
      return text(`${said}.${newTabSaid(tabBefore)}${changed} Call look.`);
    },

    /**
     * A hand on the picture, on every target: for what is drawn, or has no number. A press over
     * something `look` numbers is refused and named, so every button still goes through `click` and
     * its rails; a press over an un-numbered thing meets the field rails by what it lands in, down
     * through any frame (`landsIn`: a robot check, a different website, a hidden box, a card box),
     * and the other rails by its words (`spotUnder`). Hovering and zooming press nothing, so they go anywhere.
     */
    async point({ action = "click", x, y, toX, toY, holdMs }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const how = String(action).toLowerCase();
      if (!POINTER_ACTIONS.includes(how)) return refusal(`action is one of: ${POINTER_ACTIONS.join(", ")}.`);
      const frame = state.frame ?? frameNow();
      const { width, height } = frame;
      const spot = (px, py) => [Number(px), Number(py)];
      const inside = ([px, py]) => px >= 0 && py >= 0 && px < width && py < height;
      const drags = how.endsWith("drag");
      if (!inside(spot(x, y)) || (drags && !inside(spot(toX, toY))))
        return {
          ...refusal(
            `Give x and y${drags ? ", and toX and toY," : ""} as a spot in your picture, which is ${width} wide and ${height} tall.`,
          ),
          _refused: "no-spot",
        };
      // Her spot is in her picture's pixels; the page's own are CSS pixels, and with her keyboard up
      // the top of her picture is `pan` down the page and its bottom is the keyboard.
      const onScreen = ([px, py]) => [px / frame.perCssX, py / frame.perCssY];
      if (state.kb.up && [spot(x, y), ...(drags ? [spot(toX, toY)] : [])].some((s) => onScreen(s)[1] >= aboveKeyboard()))
        return {
          ...refusal("That spot is your keyboard. To write something, use type; go_back puts the keyboard away."),
          _refused: "keyboard",
        };
      const pan = state.kb.up ? state.kb.pan : 0;
      const onPage = (s) => {
        const [cx, cy] = onScreen(s);
        return [cx, cy + pan];
      };
      const aimed = onPage(spot(x, y));
      const to = onPage(spot(toX, toY));
      await runInventory();
      const presses = !PASSIVE_POINTER.has(how);
      // A phone's thumb lands near her spot, not on it (`thumbSpot`): the rails read where it lands.
      const thumb =
        device === "phone" && presses
          ? {
              aimedId: (await state.page.evaluate(spotUnder, aimed).catch(() => null))?.id ?? null,
              at: thumbSpot(aimed, (state.taps += 1)),
            }
          : null;
      const from = thumb?.at ?? aimed;
      for (const at of drags ? [from, to] : [from]) {
        const under = await state.page.evaluate(spotUnder, at).catch(() => null);
        if (under?.frame && CAPTCHA_FRAME.test(under.frame)) {
          noteOnce("captcha-challenge", "a pointer was aimed at the robot check - refused, never solved");
          return {
            ...refusal("That spot is a robot check. You cannot do that here; look for another way, or give_up."),
            _refused: "captcha",
          };
        }
        // What a press really lands in, frames included: a card processor's box, a hidden box, or a
        // different website set into the page never takes her hand, numbered or not.
        if (presses) {
          const stopped = landStop(await landsIn(at), "That spot", `a pointer ${how}`);
          if (stopped) return stopped;
        }
        const hit = under?.id ? elementById(under.id) : null;
        // A press and hold has no click door, so a numbered thing under it meets the spot rails below
        // and is held: sending her to click, which cannot hold, was a dead end.
        if (hit && presses && how !== "hold") {
          let n = [...numbersHere()].find(([, id]) => String(id) === String(under.id))?.[0];
          // A control her last look did not number (she had stopped reading before it) gets its number
          // here: sending her to click or type a thing with no number was a dead end (a Discord Sue
          // pointed at the message box three times and gave up, run 20260922-113917-5468).
          if (n == null) {
            n = Math.max(0, ...state.clickable.keys()) + 1;
            state.clickable.set(n, under.id);
          }
          // Named by what is under her finger NOW: a spot tap has just read it. Named as her last look saw it,
          // a bell whose count went 10 to 9 was refused as "not on the page any more" and never pressed
          // (Nexas phone wave 20, the casual, run 20260926-065806-80fd).
          state.shownAs?.set(n, seenName(hit));
          // A tap on a numbered thing presses it, through the door click uses (its rails, its live
          // greyed-out read, its report). Answering "That spot is [2], reach it with click" pressed
          // nothing, and a Sue who had tapped a sign-up form's month box filed "The Month box won't
          // open" (run 20260922-171336-afb4, sue-4353-old-sue). A hold or a drag still names the number.
          if (!drags && CLICK_HOWS.includes(how)) return handlers.click({ target: n, how }, thumb, thumb ? null : aimed);
          const typesIn =
            /box to type in/.test(seenName(hit)) || ["input", "textarea", "textbox", "searchbox", "combobox"].includes(hit.role);
          return {
            ...refusal(
              `That spot is [${n}] "${seenName(hit)}", which you reach with ${typesIn ? "type (or click)" : "click (it can also double-click, right-click, hover, or drag it onto something)"} using [${n}].`,
            ),
            _refused: "numbered",
          };
        }
        const railed = presses ? refusedBy(rails, under?.name, { role: "button", href: under?.href }) : null;
        if (railed) {
          noteOnce(
            `refused-${railed}`,
            `a pointer ${how} on "${String(under?.name ?? "").slice(0, 80)}" was refused by the ${railed} rail`,
          );
          return { ...refusal(refusalSentence(railed, `that spot${hit ? ` ("${seenName(hit).slice(0, 60)}")` : ""}`)), _refused: railed };
        }
        // A pointer on the words that ask for the code is a request too: a spot-level click has no
        // click tool call to record it, so the report funnel would under-count it.
        if (presses && !drags && !how.includes("right") && state.emailTypedAt && OTP_REQUEST_TEXT.test(String(under?.name ?? "")))
          state.otpRequestedAt = Date.now();
      }
      const mouse = state.page.mouse;
      const before = pageUrl();
      const tabBefore = state.page;
      const rightClicks = how === "right-click" || how === "hold-right-click";
      if (rightClicks) await state.page.evaluate(armMenuWatch).catch(() => {}); // best-effort: without the watch she is simply not told the browser's menu stayed invisible
      const pictureBefore = presses ? await pictureNow() : null;
      const tabComing = presses
        ? await newTabComing(async () =>
            (await state.page.evaluateHandle(([px, py]) => document.elementFromPoint(px, py), from)).evaluate(opensNewTab),
          )
        : null;
      // A press and hold, and a held right-click, keep the button (or the finger) down LONG_PRESS_MS.
      const holds = how === "hold" || rightClicks;
      // `holdMs` (100 to 5000) keeps a hold down that long, and keeps a drag's button or finger down on its last
      // spot that long before letting go: an on-screen joystick pushed one way and held there.
      const held = readHold(holdMs);
      const pressMs = how === "hold" || how === "hold-right-click" ? (held ?? LONG_PRESS_MS) : LONG_PRESS_MS;
      const dragHold = drags ? (held ?? 0) : 0;
      if (thumb) {
        // A phone taps, double-taps, long-presses for a hold or a right-click and drags with a finger.
        await missedBy(thumb.aimedId, from);
        for (let i = how === "double-click" ? 2 : 1; i > 0; i--)
          await touch(state.page, drags ? slide(from, to) : [[from]], holds ? pressMs : 0, dragHold);
      } else {
        await mouse.move(...from);
        if (how === "click") await mouse.click(...from);
        else if (how === "hold") await mouse.click(...from, { delay: pressMs });
        else if (how === "double-click") await mouse.dblclick(...from);
        else if (how === "right-click") await mouse.click(...from, { button: "right" });
        else if (how === "hold-right-click") await mouse.click(...from, { button: "right", delay: pressMs });
        else if (how === "zoom-in" || how === "zoom-out") {
          if (device === "phone") await pinch(state.page, ...from, how === "zoom-in" ? 2.5 : 0.4);
          else await mouse.wheel(0, how === "zoom-in" ? -360 : 360);
        } else if (drags) {
          const button = how === "right-drag" ? "right" : "left";
          await mouse.down({ button });
          await mouse.move(...to, { steps: 12 });
          if (dragHold) await sleep(dragHold);
          await mouse.up({ button });
        }
      }
      const menu = rightClicks ? await state.page.evaluate(readMenuWatch).catch(() => "page") : "page";
      clock.handsMoved();
      clock.charge({ actions: 1 });
      await newTabLanded(tabComing);
      await settle();
      const changed = await afterAction(before);
      await playedOn(pictureBefore, changed);
      const said = `${Math.round(x)},${Math.round(y)}${drags ? ` to ${Math.round(toX)},${Math.round(toY)}` : ""}`;
      return text(
        `You did ${how} at ${said}.${thumb ? state.thumbMissed : ""}${menuSaid(menu)}${newTabSaid(tabBefore)}${changed} Call look to see what happened.`,
      );
    },

    async scroll({ direction }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const dir = String(direction ?? "down").toLowerCase();
      if (!["down", "up", "top"].includes(dir)) return refusal("Scroll down, up, or to the top.");
      // What a wheel would move: an open dialog's own scroller, else the page, else the biggest
      // scrolling panel. Scrolling only the window left every panel that scrolls inside itself
      // "cut off" to her (NexusCode's Controls list, 2026-09-21).
      const at = await state.page
        .evaluate((d) => {
          const doc = document.scrollingElement || document.documentElement;
          const scrolls = (el) => /(auto|scroll)/.test(getComputedStyle(el).overflowY) && el.scrollHeight > el.clientHeight + 2;
          const biggest = (root) =>
            [...root.querySelectorAll("*")]
              .filter((el) => scrolls(el) && el.getBoundingClientRect().height > 0)
              .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0] ?? null;
          const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], dialog[open]')];
          // A finger or a wheel moves the scroller UNDER it, and when that one is at its end the
          // swipe carries on to the one around it. Picking the biggest scrolling panel instead told
          // eight Sues on MyConnect's phone editor "You are at the bottom" four swipes running while
          // the screen never moved (identical shots), and they filed the editor as broken (run
          // 20260922-115216-aa5f). So the middle of her screen decides first, walking outwards to the
          // first scroller that can still move her way; the old order is only the fallback.
          const canMove = (el) => (d === "top" || d === "up" ? el.scrollTop > 0 : el.scrollTop < el.scrollHeight - el.clientHeight - 1);
          const underFinger = () => {
            for (let el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2); el; el = el.parentElement) {
              if (el === document.body || el === document.documentElement) break;
              if (scrolls(el) && canMove(el)) return el;
            }
            return null;
          };
          const box =
            dialogs.map(biggest).find(Boolean) ??
            underFinger() ??
            (doc.scrollHeight > doc.clientHeight + 2 ? doc : null) ??
            biggest(document) ??
            doc;
          if (d === "top") box.scrollTo(0, 0);
          else box.scrollBy(0, (d === "up" ? -1 : 1) * box.clientHeight * 0.9);
          return { y: Math.round(box.scrollTop), max: Math.round(Math.max(0, box.scrollHeight - box.clientHeight)) };
        }, dir)
        .catch(() => null);
      clock.charge({ actions: 1 });
      state.scrolledSinceLook = true;
      await sleep(300);
      const where = !at
        ? ""
        : at.max === 0
          ? " There is nothing more to scroll."
          : at.y >= at.max
            ? " You are at the bottom."
            : at.y === 0
              ? " You are at the top."
              : "";
      return text(`You scrolled ${dir === "top" ? "to the top" : dir}.${where} Call look.`);
    },

    async go_back() {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      // On a phone, back with the keyboard up puts the keyboard away and goes nowhere, as Android's does.
      // Only the box lets go of the focus, as a phone's keyboard-dismiss does: never Escape and never the
      // browser's back, which closed a whole editor with a date box open (run 20261004-232709-9ce9, elena).
      const pickerOpen = device === "phone" && !state.kb.up ? await readPicker(state.page) : null;
      if (state.kb.up || pickerOpen) {
        await state.page.evaluate(() => document.activeElement?.blur?.()).catch(() => {}); // best-effort: a page mid-navigation has no focus to let go of
        await lowerKeyboard();
        clock.charge({ actions: 1 });
        return text(pickerOpen ? "You closed the date and time picker. Call look." : "You put your keyboard away. Call look.");
      }
      const before = pageUrl();
      await state.page.goBack({ waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => {}); // best-effort: the Back action reports by comparing URLs below, so a failed goBack reads as 'nothing happened'
      clock.charge({ actions: 1 });
      // The tab's first entry is the browser's own blank page, never a place she was: in life, Back from the page
      // she arrived on returns to whatever sent her (the ad, the search, the message). Put the page back and say so,
      // or she files a blank white tab as the site breaking (2026-09-27, two Sues on example.com).
      if (/^about:blank/.test(pageUrl()) && !/^about:blank/.test(before)) {
        await state.page.goForward({ waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => {}); // best-effort: back onto the page she was on; the next look shows where she is
        await settle();
        return text(
          "Going back from here would leave this website for wherever sent you, so you stay on this page. If you are finished here, say so. Call look.",
        );
      }
      await settle();
      const changed = await afterAction(before);
      return text(changed ? "You went back. Call look." : "There is nowhere to go back to.");
    },

    async go_forward() {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const before = pageUrl();
      await state.page.goForward({ waitUntil: "load", timeout: NAV_TIMEOUT_MS }).catch(() => {}); // best-effort: the Forward action reports by comparing URLs below, so a failed goForward reads as 'nothing happened'
      clock.charge({ actions: 1 });
      await settle();
      const changed = await afterAction(before);
      return text(changed ? "You went forward. Call look." : "There is nowhere to go forward to.");
    },

    async reload() {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      // A page that came from a form she sent: a browser asks before sending it again, and the
      // honest answer for a Sue is no - a second send is a second sign-up, post or payment.
      if (state.navMethod.get(state.page) === "POST") {
        return {
          ...refusal("The browser asks whether to send the form on this page again. You say no, so the page stays as it is."),
          _refused: "resend-form",
        };
      }
      const before = pageUrl();
      try {
        await state.page.reload({ waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        clock.charge({ actions: 1 });
        return text(`You reloaded, and the page is taking forever to come back (${String(err?.message ?? err).split("\n")[0]}).`);
      }
      clock.charge({ actions: 1 });
      await settle();
      const changed = await afterAction(before);
      return text(`You reloaded the page.${changed} Call look.`);
    },

    /**
     * Typing an address into the address bar. THE SUE LAW (lib/rails.mjs `goToVerdict`): only an
     * address she has seen this visit, or a known site's bare front door, and only on the allowed
     * hosts. A refusal is recorded the way every other rail's is, except "not-an-address": what she
     * typed was no address at all, which is her brain's slip and never the site's problem (run
     * 20260928-133054-5e00 sent { url } and the report counted "refused-not-an-address" as a finding).
     * So `url` is taken for `address`, and a call with neither is told the argument's name.
     */
    async go_to({ address, url }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const typed = [address, url].find((a) => typeof a === "string" && a.trim());
      if (!typed)
        return { ...refusal('Give the address to type as address, for example go_to { address: "example.com" }.'), _refused: "no-address" };
      address = typed;
      const verdict = goToVerdict(address, { seen: state.seen, allowedHosts, startUrl: target.startUrl });
      if (verdict.refused === "off-host") {
        const handedOff = reachExit(verdict.href, "an address she typed");
        if (handedOff) {
          clock.charge({ actions: 1 });
          return { ...text(`You typed the address. ${handedOff}`), _refused: "exit" };
        }
        bodyNote("left-site", `go_to ${String(verdict.href).slice(0, 300)} would have left the allowed hosts - refused`, {
          href: verdict.href,
        });
        return { ...refusal(verdict.sentence), _refused: "off-host" };
      }
      if (verdict.refused) {
        if (verdict.refused !== "not-an-address")
          noteOnce(`refused-${verdict.refused}`, `go_to "${String(address ?? "").slice(0, 120)}" was refused: ${verdict.refused}`);
        return { ...refusal(verdict.sentence), _refused: verdict.refused };
      }
      const before = pageUrl();
      try {
        await state.page.goto(verdict.url, { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        clock.charge({ actions: 1 });
        return text(`You typed the address, and the page is taking forever to load (${String(err?.message ?? err).split("\n")[0]}).`);
      }
      clock.charge({ actions: 1 });
      await settle();
      const changed = await afterAction(before);
      return text(`You typed the address and went there.${changed || " It is the page you were already on."} Call look.`);
    },

    /** Her open tabs, by their titles: list them, switch to one, close one. Only tabs on the allowed hosts stay open. */
    async tabs({ action = "list", tab }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const open = context.pages().filter((p) => !p.isClosed());
      const titleOf = async (p) => (await p.title().catch(() => "")) || "a page with no title";
      const what = String(action ?? "list").toLowerCase();
      if (what === "list") {
        const lines = await Promise.all(
          open.map(async (p, i) => `[${i + 1}] ${await titleOf(p)}${p === state.page ? " (the one you are looking at)" : ""}`),
        );
        return text(`You have ${open.length} tab${open.length === 1 ? "" : "s"} open:\n${lines.join("\n")}`);
      }
      if (what !== "switch" && what !== "close") return { ...refusal("action is list, switch or close."), _refused: "no-tab" };
      const n = Number(tab);
      const picked = Number.isInteger(n) ? open[n - 1] : null;
      if (!picked)
        return {
          ...refusal(`Say which tab by its number, 1 to ${open.length}. Call tabs with action list to see them.`),
          _refused: "no-tab",
        };
      if (what === "switch") {
        if (!urlAllowed(picked.url(), allowedHosts)) {
          bodyNote("left-site", `a tab on ${picked.url()} - closed, off the allowed hosts`);
          await picked.close().catch(() => {}); // best-effort: closing an off-site tab is cleanup; a tab that already closed itself is the goal
          return { ...refusal("That tab was on a different website, so you closed it."), _refused: "off-host" };
        }
        if (picked !== state.page) {
          state.page = picked;
          await picked.bringToFront().catch(() => {}); // best-effort: headless has no front; the body reads state.page either way
          clock.newPage();
        }
        clock.charge({ actions: 1 });
        return text(`You are looking at tab [${n}] "${await titleOf(picked)}" now. Call look.`);
      }
      if (open.length === 1)
        return {
          ...refusal("That is your only tab; closing it would end your visit. Call give_up if you are leaving."),
          _refused: "only-tab",
        };
      const wasHere = picked === state.page;
      await picked.close();
      if (wasHere)
        state.page = context
          .pages()
          .filter((p) => !p.isClosed())
          .at(-1);
      clock.charge({ actions: 1 });
      return text(`You closed tab [${n}].${wasHere ? ` You are looking at "${await titleOf(state.page)}" now.` : ""} Call look.`);
    },

    /**
     * Turning her phone. The page hears exactly what a real phone tells it: a landscape viewport, an
     * `orientationchange`, and `screen.orientation` reading landscape-primary at 90 degrees (Playwright
     * sets the orientation with the viewport on a mobile context; measured 2026-09-22).
     */
    async rotate() {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      state.turned = !state.turned;
      for (const page of context.pages()) if (!page.isClosed()) await page.setViewportSize(heldViewport());
      if (state.kb.up) {
        // The keyboard turns with the phone: its sideways height, and the box she is typing in above it again.
        const focus = await readFocus(state.page);
        if (focus) await placeKeyboard(focus);
        else await lowerKeyboard();
      }
      clock.charge({ actions: 1 });
      await settle();
      return text(`You turned your phone ${state.turned ? "sideways" : "back upright"}. Call look.`);
    },

    async wait({ seconds }) {
      const secs = waitSeconds(seconds);
      if (secs == null) return { ...refusal(WAIT_HOW_LONG), _refused: "no-seconds" };
      await sleep(secs * 1000);
      clock.charge({ waitMs: secs * 1000 });
      return text(`You waited ${secs} second${secs === 1 ? "" : "s"}.`);
    },

    async check_email() {
      const now = Date.now();
      if (!state.firstInboxCheckAt) state.firstInboxCheckAt = now;
      // Opening her inbox is a tap. The time since her last move is her brain's thinking, not hers (a
      // chat brain's came to 19 s for one check, run 20260928-063510-a514). A wait for a mail is
      // `wait`'s, and how slow the mail was is `otpEmailLatencyMs`.
      clock.charge({ actions: 1 });
      const messages = readInbox(mailDir);
      if (state.otpRequestedAt && state.otpEmailLatencyMs == null) {
        const arrived = productMail(messages).find((m) => m._stamp >= state.otpRequestedAt && singleCode(m.text));
        if (arrived) state.otpEmailLatencyMs = Math.max(0, arrived._stamp - state.otpRequestedAt);
      }
      state.lastInboxCheckAt = now;
      // A link in a mail she read is an address she has SEEN (go_to may open it).
      for (const m of messages) for (const href of urlsIn(m.text, defaultProtocol)) noteSeen(state.seen, href);
      if (messages.length === 0) return { ...text("Your inbox is empty. Nothing new."), _mail: 0 };
      // The numbers are stable for what she saw HERE: open_email and judge_email resolve them
      // through these ids, so a new mail arriving in between cannot shift "email 2" under her.
      state.inboxIds = messages.map((m) => messageIdOf(m));
      for (const id of state.inboxIds) state.mailAnnounced.add(id);
      const inbox = messages.map((m, i) => ({
        number: i + 1,
        from: m.from ?? "",
        subject: m.subject ?? "",
        receivedAgo: receivedAgo(m._stamp, now),
        opened: state.emailsOpened.has(messageIdOf(m)),
        body: inboxBody(m),
      }));
      const unread = inbox.filter((m) => !m.opened).length;
      const hint = unread
        ? `\n\nOpen any of them with open_email (which: its number) to see it the way it really looks, then say what you thought with judge_email.`
        : "";
      return { ...text(`${JSON.stringify(inbox, null, 2)}${hint}`), _mail: inbox.length };
    },

    async open_email({ which }) {
      const stalled = await ensureStarted();
      if (stalled) return text(stalled);
      const n = Number(which);
      const id = Number.isInteger(n) ? state.inboxIds[n - 1] : null;
      if (!id) {
        return {
          ...refusal(
            state.inboxIds.length
              ? `Say which email by its number, 1 to ${state.inboxIds.length}, from your last check_email.`
              : "Call check_email first to see what is in your inbox.",
          ),
          _refused: "no-email",
        };
      }
      const record = readInbox(mailDir).find((m) => messageIdOf(m) === id);
      if (!record) return refusal("That email is not in your inbox any more. Call check_email.");
      let mail = state.mailPage && !state.mailPage.isClosed() ? state.mailPage : null;
      if (!mail) {
        state.expectingMailTab = true;
        mail = await context.newPage();
        state.expectingMailTab = false;
        state.mailPage = mail;
        watch(mail);
        await throttlePage(mail); // the Mail tab's own goto is right below, so this is fully before her first navigation
      }
      try {
        await mail.goto(messageUrl(id), { waitUntil: "load", timeout: NAV_TIMEOUT_MS });
      } catch (err) {
        return refusal(`Your email would not open (${String(err?.message ?? err).split("\n")[0]}). Call check_email and try again.`);
      }
      state.page = mail;
      await mail.bringToFront().catch(() => {}); // best-effort: headless has no front; the body reads state.page either way
      clock.newPage();
      clock.charge({ actions: 1 });
      state.emailsOpened.add(id);
      return text(
        `You opened "${record.subject ?? "(no subject)"}" from ${record.from ?? "an unknown sender"}. It is in your Mail tab. ` +
          `Call look to read it the way it looks, then judge_email (which: ${n}). Use tabs to go back to the website.`,
      );
    },

    async judge_email({ which, whatIThought }) {
      const n = Number(which);
      const id = Number.isInteger(n) ? state.inboxIds[n - 1] : null;
      const record = id ? readInbox(mailDir).find((m) => messageIdOf(m) === id) : null;
      if (!record) return { ...refusal("Say which email by its number from your last check_email."), _refused: "no-email" };
      // "Did they see the signup email themselves, literally?" (Owner, 2026-09-22) - so an opinion of
      // an email she never opened is refused: it would be an opinion of a paragraph in a list.
      if (!state.emailsOpened.has(id))
        return {
          ...refusal(`Open it first with open_email (which: ${n}), and look at it, so you judge what it really looks like.`),
          _refused: "unopened-email",
        };
      const said = String(whatIThought ?? "").trim();
      if (said.length < 12)
        return { ...refusal("Say what you actually thought of it, in your own words - a sentence at least."), _refused: "no-opinion" };
      const judged = { from: record.from ?? "", subject: record.subject ?? "", whatIThought: said };
      // Written to her diary the moment she says it: the exit interview also asks, but a Sue the turn
      // budget cuts off never reaches it, and both live runs on 2026-09-21 lost every email opinion that way.
      findings.note({
        source: "brain",
        kind: "email",
        text: said,
        url: messageUrl(id),
        extra: { from: judged.from, subject: judged.subject },
      });
      state.emailsJudged = [...state.emailsJudged.filter((e) => e.subject !== judged.subject || e.from !== judged.from), judged];
      state.sinceNote = 0;
      return text("Noted what you thought of that email.");
    },

    async note({ kind, text: line, why, fix, severity, problem, same, unsure }) {
      const k = String(kind ?? "thought").toLowerCase();
      if (k === "considered") {
        if (!readingMode) return text("Nothing weighed: considered is for paced reading.");
        return text((await considerControl(line)) ?? "Noted that you weighed that control and left it.");
      }
      if (k === "lingered" || k === "unsure") {
        if (!readingMode) return text(NOTHING_UNSURE);
        if (isNone(line)) {
          if (k === "lingered" && state.lastLookText != null && wordsOf(state.lastLookText).length >= MIN_WORDS_TO_READ)
            return text(LINGERED_NO_NONE);
          if (k === "lingered") state.lingeredFor = state.lastLookText;
          return text(k === "unsure" ? "Nothing unsure, nothing written." : "Noted.");
        }
        const answered = state.lingeredFor === state.lastLookText;
        const phrase = await fileLingered(line, k, { rest: !answered });
        if (!phrase) return text(k === "unsure" ? NOTHING_UNSURE : NOT_ON_SCREEN);
        state.lingeredFor = state.lastLookText;
        return text(k === "unsure" ? `Noted that you are unsure about "${phrase}".` : `Noted that you lingered on "${phrase}".`);
      }
      if (!NOTE_KINDS.has(k) && !(art && ART_KINDS.includes(k)))
        return refusal(
          `kind must be one of: ${[...NOTE_KINDS, "lingered", "unsure", "considered", ...(art ? ART_KINDS : [])].join(", ")}.`,
        );
      // A designer's polish or keep line is checked first, so a refused one leaves no row (lib/findings.mjs artNoteExtra).
      const designed = art ? artNoteExtra({ kind: k, why, fix, severity, seconds: clock.elapsedSeconds() }) : null;
      if (designed?.refused) return refusal(designed.refused);
      // A typed problem or a `same` sighting is decided before anything is written, so a refused one leaves
      // no row, no ledger line and her pending probe still pending (lib/findings.mjs problemNote).
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
      // Her NEXT note after a probe fired carries it, oldest first - so a first-look probe answered
      // several moves later still reaches the report, tagged with where it was asked. A drop or hook
      // also carries its why/fix/severity and the seconds into the visit her clock has spent, which is
      // what lets the report print the attention timeline in order (lib/findings.mjs attentionNoteExtra).
      const probe = probeNoteExtra(state.pendingProbes.shift());
      const attention = attentionNoteExtra({ kind: k, why, fix, severity, seconds: clock.elapsedSeconds() });
      const extra = probe || attention || designed ? { ...probe, ...attention, ...designed } : null;
      // A problem filed while SUE itself is at fault (her browser lost under her and not yet back, or, from its refusal
      // on, our sign-up door) stays on the ledger but is never listed to another Sue: it would steer her off a step as
      // the site's fault. Listing too little only leaves another Sue to file her own, as before the ledger.
      const sueSide = state.browserLostAt ? SUE_BROWSER_LOST : state.doorRefusedAt ? SUE_DOOR_REFUSED : null;
      const { said } = fileNote({ findings, sueDir, decided, kind: k, text: line, url: pageUrl(), extra, sueSide });
      if (readingMode && REST_ON_TEXT_KINDS.has(k) && state.page) {
        const puzzle = typeof unsure === "string" && !isNone(unsure) ? unsureOnScreen(unsure, state.lastLookText) : null;
        const rested = await restOnThought(state.page, line, {
          wordsPerMinute: persona?.dials?.wordsPerMinute,
          maxMs: PACE_DIALS.visitCapMs - state.pacedSpentMs,
          rests: state.readingRests,
          unsure: puzzle,
          pauseMs: 2_000 + readRandom() * 2_000,
        });
        if (puzzle && rested > 0) state.unsureRested = { screen: state.lastLookText, phrase: puzzle };
        state.pacedSpentMs += rested;
        clock.charge({ waitMs: rested });
      }
      // In a focus group the room hears her diary as she writes it (the owner: "they hear each other's journal").
      if (focus) focus.heardNote(k, String(line ?? ""), pageUrl());
      return text(said);
    },

    async give_up({ why }) {
      findings.note({ source: "brain", kind: "gave-up", text: String(why ?? ""), url: pageUrl() });
      recordOutcome("gave-up");
      if (focus) {
        focus.leftPage("gave-up", String(why ?? ""));
        return text(FOCUS_LEFT_PAGE);
      }
      return text("You are leaving. Now call exit_interview and answer every question.");
    },

    async done({ what }) {
      findings.note({ source: "brain", kind: "done", text: String(what ?? ""), url: pageUrl() });
      recordOutcome("done");
      if (focus) {
        focus.leftPage("done", String(what ?? ""));
        return text(FOCUS_LEFT_PAGE);
      }
      return text("Good. Now call exit_interview and answer every question.");
    },

    async exit_interview(answers) {
      // A focus-group Sue gives hers once she has voted and the room agreed (or she sat out the
      // table's time). Her last moves of the turn budget pass anyway: a lost interview is worse than
      // an early one (run 20260922-054554-992a lost a whole verdict to the budget).
      const gate = focus && !wrapUpNotice(state.toolCalls, maxTurns) ? focus.exitGate() : null;
      if (gate) return refusal(gate);
      // When hands died, write the interview from her diary/journal without requiring full answers
      const frozenByHandsDeath = Boolean(state.browserGone || state.browserLostAt);
      // Paced, with her browser alive and time left, the visit must be ended first: done or give_up carry the unsure and
      // considered answers and the rests on them, and shutdown's page end then flushes the pixel. A turn budget about to
      // run out, or a dead browser, still lets her interview through.
      if (
        readingMode &&
        !focus &&
        !state.outcome &&
        !frozenByHandsDeath &&
        !wrapUpNotice(state.toolCalls, maxTurns) &&
        clock.state() !== "exhausted"
      )
        return refusal(EXIT_BEFORE_ENDING);
      const missing = missingInterviewKeys(answers, judged, ad, ape).filter((k) => !(k === "whyStopped" && state.outcome === "done"));
      if (missing.length && !frozenByHandsDeath)
        return refusal(`Please also answer: ${missing.join(", ")}. Send every answer in one exit_interview call.`);
      if (!state.outcome) recordOutcome("interviewed");
      const extras = interviewExtras(focus ? { interview: withBiggestProblem(scenario?.interview) } : scenario, judged, ad, ape).map(
        ([key]) => key,
      );
      // A Sue who never looked at the page answers from what she heard, not what she saw: her interview is kept apart as
      // unseen, and no verdict counts its stars (report.mjs starOf).
      const unseen = !sawThePage(sueDir);
      const shapedAsGiven = ape
        ? shapeApeInterview(answers, extras)
        : ad
          ? shapeAdInterview(answers, extras)
          : shapeInterview(answers, extras, judged);
      const shaped = art ? shapeArtAnswers(shapedAsGiven) : shapedAsGiven;
      const interviewData = { ...shaped, ...(unseen ? { unseen: true } : {}) };
      if (frozenByHandsDeath) interviewData.frozenByHandsDeath = true;
      writeFileSync(path.join(sueDir, "interview.json"), `${JSON.stringify(interviewData, null, 2)}\n`, "utf8");
      state.interviewed = true;
      if (focus) focus.left();
      await shutdown();
      return text(`Thank you. ${LEFT}`);
    },

    // A focus-group Sue's moves at the table; served only to her (toolSpecs `focusGroup`).
    ...(focus ? { room: focus.room, say: focus.say, vote: focus.vote } : {}),
  };

  /** The screen she is on still has no answer to "what did you read most carefully?", and this move is one that owes it. */
  const owesLingered = (name) =>
    Boolean(readingMode) &&
    !UNSURE_EXEMPT.has(name) &&
    !ROOM_MOVES.has(name) &&
    state.lastLookText != null &&
    state.lingeredFor !== state.lastLookText;

  /** Why the lingered this move carries is no answer (missing, "none" on a screen with text, or not on the screen), or null. */
  const lingeredRefusal = (name, args) => {
    if (!owesLingered(name)) return null;
    const said = String(args?.lingered ?? "").trim();
    if (!said) return LINGERED_OWED;
    if (isNone(said) && wordsOf(state.lastLookText).length >= MIN_WORDS_TO_READ) return LINGERED_NO_NONE;
    if (!isNone(said) && !unsureOnScreen(said, state.lastLookText)) return NOT_ON_SCREEN;
    const puzzle = String(args?.unsure ?? "").trim();
    if (!puzzle) return UNSURE_OWED;
    return isNone(puzzle) || unsureOnEarlierScreen(puzzle) ? null : NOT_ON_SCREEN;
  };

  /** done and give_up in paced reading owe `unsure` too: a phrase quoted from the screen, or "none". */
  const endUnsureRefusal = (name, args) => {
    if (!readingMode || (name !== "done" && name !== "give_up") || state.lastLookText == null) return null;
    const puzzle = String(args?.unsure ?? "").trim();
    if (!puzzle) return UNSURE_OWED;
    return isNone(puzzle) || unsureOnEarlierScreen(puzzle) ? null : NOT_ON_SCREEN;
  };

  /** Her answer carried by a move: the words she lingered on are filed and rested on; unsure, when given, marks them a puzzle. */
  const takeLingered = async (name, args) => {
    // done and give_up never owe it, but words she gives there are still rested on, before the visit ends.
    const endsVisit =
      (name === "done" || name === "give_up") && readingMode && state.lastLookText != null && state.lingeredFor !== state.lastLookText;
    const endsWithWords =
      endsVisit &&
      ((typeof args?.lingered === "string" && args.lingered.trim()) ||
        (typeof args?.unsure === "string" && args.unsure.trim() && !isNone(args.unsure)));
    if (!owesLingered(name) && !endsWithWords) return null;
    const screen = state.lastLookText;
    const said = String(args?.lingered ?? "");
    // The phrase she is unsure of sits inside the words she read: one rest on the block (the pixel reports only the first
    // rest on a block, so a separate lingered rest first would hide the unsure one), as long as reading them plus her pause.
    const flat = (v) => String(v).toLowerCase().replace(/\s+/g, " ").trim();
    const puzzleText = typeof args?.unsure === "string" ? args.unsure : "";
    const oneRest = !isNone(puzzleText) && Boolean(puzzleText.trim()) && !isNone(said) && flat(said).includes(flat(puzzleText));
    if (said.trim() && !isNone(said)) await fileLingered(said, "lingered", { rest: !oneRest, seededPause: endsVisit });
    state.lingeredFor = screen;
    const puzzle = typeof args?.unsure === "string" ? args.unsure : "";
    if (!puzzle.trim() || isNone(puzzle)) return null;
    const restedWithThought = state.unsureRested?.screen === screen && state.unsureRested.phrase === unsureOnScreen(puzzle, screen);
    return (await fileLingered(puzzle, "unsure", {
      rest: !restedWithThought && (puzzle.trim() !== said.trim() || oneRest),
      ...(oneRest ? { readAs: said } : {}),
    }))
      ? null
      : NOTHING_UNSURE;
  };

  /** done and give_up in paced reading owe `considered`: the control she weighed last and did not press, or none. */
  const consideredRefusal = (name, args) => {
    if (!readingMode || (name !== "done" && name !== "give_up") || state.lastLookText == null) return null;
    return String(args?.considered ?? "").trim() ? null : CONSIDERED_OWED;
  };

  /** Every call: the gates, the handler, one trace row. */
  function wrap(name, run) {
    const move = async (args = {}, batch = null) => {
      // Awake before anything reads or touches her page: what she sees and does is never the resting tab.
      await rest.wake();
      const startedAt = Date.now();
      // A note is her journal, which SUE itself asks for every few moves (journalNudge): on the chat brain it costs her
      // no turn, as it costs her no time. Counted, a quarter of Emily's and DeShawn's moves were notes, and the wrap-up
      // line sent them home with patience left in every round of lift-v2 from 14 on (round 22: Emily with 38 of her
      // 150 s). A CLI brain's --max-turns is a hard cut that counts every turn, so there a note still counts.
      if (!(chatBrain && name === "note")) state.toolCalls += 1;
      state.handsAsked = false;
      // A focus-group Sue's first move, whatever it is, sits her down at the table (once).
      if (focus && !state.closed) focus.joined();
      let result;
      if (state.closed) result = text(LEFT);
      else if (state.outcome && name !== "exit_interview" && name !== "note" && !ROOM_MOVES.has(name)) {
        // In a focus group the website is behind her but the table is not: she is sent there instead.
        result = refusal(
          focus
            ? FOCUS_LEFT_PAGE
            : `You said you were ${state.outcome === "done" ? "finished" : "leaving"}. Call exit_interview now, with every answer.`,
        );
      } else if (!NO_PAGE_MOVES.has(name) && state.browserGone) {
        result = refusal(BROWSER_GONE);
      } else if (!NO_PAGE_MOVES.has(name) && state.browserLostAt) {
        // It died between her moves: this move reopens it and tells her, and does nothing else.
        result = await afterBrowserLost();
      } else if (clock.state() === "exhausted" && !["give_up", "done", "exit_interview", "note"].includes(name) && !ROOM_MOVES.has(name)) {
        patienceGone();
        result = refusal(`${clock.mood()} ${STOPPED_BEFORE_DOING_IT}`);
      } else if (consideredRefusal(name, args)) {
        result = { ...refusal(consideredRefusal(name, args)), _refused: "unsure-owed" };
      } else if (endUnsureRefusal(name, args)) {
        result = { ...refusal(endUnsureRefusal(name, args)), _refused: "unsure-owed" };
      } else if (lingeredRefusal(name, args)) {
        result = { ...refusal(lingeredRefusal(name, args)), _refused: "unsure-owed" };
      } else {
        try {
          // She arrives ON the link, so it opens on her first move whatever that move is. Only the
          // page tools used to open it, so a Sue whose first move was check_email sat on a blank tab,
          // typed the site's name herself and spent her whole visit off the link (live run
          // 20260922-055009-dd24: "no mention anywhere yet of a free trial").
          // A focus group's room moves are no page move either: the table needs no website open.
          const stalled = state.navigated || name === "note" || ROOM_MOVES.has(name) ? null : await ensureStarted();
          const keyboardWasUp = state.kb.up;
          const loadsBefore = state.pageLoads;
          // Read as the control she saw BEFORE the move: a move may renumber what she was shown.
          const circleKey = moveKey(name, args, state.shownAs);
          const unsureLine = (await takeLingered(name, args)) ?? (await takeConsidered(name, args));
          result = stalled ? text(stalled) : await run(args ?? {});
          if (unsureLine && !result.isError) result = { ...result, content: [...result.content, { type: "text", text: unsureLine }] };
          // A move the site took (never one a rail refused: that is SUE, not the site) joins her last
          // moves; the fifth time the same one, she hears it and the report gets `going-in-circles`.
          if (circleKey && !stalled && !result.isError) {
            // The unchanged-page finding names the last move that should have changed the page.
            if (movesThePage(circleKey)) state.lastCircleMove = circleKey;
            const circleNudge = noteCircling(state.circles.move(circleKey), circleKey);
            if (circleNudge) result = { ...result, content: [...result.content, { type: "text", text: circleNudge }] };
          }
          // Her touch or typing raises the keyboard only on the page she touched: a box the NEXT page
          // focuses by itself after her move loaded it does not (autofocus opens no keyboard on a phone).
          await syncKeyboard(KEYBOARD_RAISERS.has(name) && !result.isError && state.pageLoads === loadsBefore);
          // She hears her keyboard come and go with the move that did it, as she would see it. A month
          // select that took "March" left no box focused, the keyboard went down unannounced, and a Sue
          // pressed back to put it away: that left the sign-up form and threw away her name (run
          // 20260922-171336-afb4, sue-4353-old-sue). go_back says its own.
          if (name !== "go_back" && state.kb.up !== keyboardWasUp)
            result = {
              ...result,
              content: [...result.content, { type: "text", text: state.kb.up ? KEYBOARD_CAME_UP : KEYBOARD_WENT_AWAY }],
            };
        } catch (err) {
          log(name, "threw:", err?.stack ?? err);
          // Playwright can reject her move before the context's own `close` lands.
          if (BROWSER_LOST_TEXT.test(String(err?.message ?? err))) browserLost(context, "closed");
          result = refusal(`Something went wrong in your hands (${String(err?.message ?? err).split("\n")[0]}). Call look.`);
        }
        // It died DURING this move: whatever the move answered was about a dead browser, never the site.
        if (state.browserLostAt && !NO_PAGE_MOVES.has(name)) result = await afterBrowserLost();
        else await snapshotSession();
      }
      // SUE talking costs her no turn, as it costs her no time: her hands asking which one she meant, or a refusal of a
      // move no person in her place could have made (SUE_ASKS). Counted, the which-one question sent Emily home with 44
      // of her 150 s of patience left (lift-v2 rounds 19-21), and every wait that did not say how long brought Reel
      // Buddy's watchers closer to the wrap-up line before their video was made. A CLI brain's --max-turns is a hard cut
      // that counts every turn, so there every move counts, as its notes do.
      if (chatBrain && sueAskOf(result, state.handsAsked)) state.toolCalls -= 1;
      // Her move opened the computer's window to pick a file, and the body closed it: she is told,
      // once, the way she would see it open and go.
      if (state.chooserOpened) {
        state.chooserOpened = false;
        result = { ...result, content: [...result.content, { type: "text", text: chooserSentence(herFiles.length > 0) }] };
      }
      // P25: the first-look probe (and any scenario.probes) - a line on her own look result, asked
      // once, in her own voice, then straight back to her errand. Never a model call of SUE's own.
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
      // A focus-group Sue hears the room between her moves on the website, the way a person hears
      // the others talking across the table: the moderator's call in (once), then the newest lines.
      if (focus && !state.closed && !NO_PAGE_MOVES.has(name)) {
        const heard = [focus.gatherNotice(), focus.overheard()].filter(Boolean);
        if (heard.length) result = { ...result, content: [...result.content, ...heard.map((line) => ({ type: "text", text: line }))] };
      }
      if (name === "note") state.sinceNote = 0;
      else if (!["exit_interview", "done", "give_up"].includes(name) && !ROOM_MOVES.has(name)) state.sinceNote += 1;
      const nudge = journalNudge(state.sinceNote);
      if (nudge && !result.isError) result = { ...result, content: [...result.content, { type: "text", text: nudge }] };
      // At the focus group's table (she has left the website) her last moves go to her vote and her
      // interview; every other Sue's wrap-up is exactly as before.
      const wrapUp = state.closed
        ? ""
        : state.outcome
          ? focus && wrapUpNotice(state.toolCalls, maxTurns)
            ? FOCUS_OUT_OF_TIME
            : ""
          : wrapUpNotice(state.toolCalls, maxTurns);
      if (wrapUp && !["done", "give_up", "exit_interview"].includes(name)) {
        if (!state.wrapUpNoted) bodyNote("turns-nearly-out", `${maxTurns - state.toolCalls} moves left of ${maxTurns}; told to wrap up`);
        state.wrapUpNoted = true;
        result = { ...result, content: [...result.content, { type: "text", text: wrapUp }] };
      }

      const url = pageUrl();
      const title = state.closed ? "" : await pageTitle();
      findings.trace({ ...traceRow(name, args, result, { ms: Date.now() - startedAt, clock, url, title }), ...(batch ? { batch } : {}) });
      if (name === "look" && !state.closed) {
        const learned = await learnArgusRow(state.page, state.argusSeen);
        if (learned) findings.trace(learned);
      }
      state.lastToolEndedAt = Date.now();
      if (!state.closed) rest.settle();
      return result.isError ? { content: result.content, isError: true } : { content: result.content };
    };
    // Her move is the one moving her until its row is written: a hop it started says so (lib/hop-trace.mjs `by`).
    return async (given = {}) => {
      // The relay's `do` names its batch in `_batch`; the row carries it as it is written (lib/body-relay.mjs runDo).
      const { _batch: batch = null, ...args } = given ?? {};
      state.moving = { seq: ++state.moveSeq, name };
      // The page says what she is doing this moment: this move, then thinking once it ends (lib/activity.mjs).
      moveStarted(sueDir, name);
      try {
        return await move(args, batch);
      } finally {
        state.moving = null;
        moveEnded(sueDir);
      }
    };
  }

  const tools = toolSpecs(device, { interview: scenario?.interview, focusGroup: Boolean(focus), judged, ad, ape, art }).map(
    ([name, description, inputSchema]) => ({ name, description, inputSchema, handler: wrap(name, handlers[name]) }),
  );

  writeFileSync(path.join(sueDir, "ready"), `${new Date().toISOString()}\n`, "utf8");
  log(
    `${sue.sueId ?? path.basename(sueDir)} ready: ${device} ${viewportFor(device, target).width}x${viewportFor(device, target).height}, ${identity.email ?? "no address"}`,
  );
  // `lastInventory`: what her last look read, exactly as INVENTORY_SCRIPT returned it (the tape's selftest compares it).
  return { sueId: sue.sueId ?? path.basename(sueDir), device, tools, shutdown, lastInventory: () => state.inventory };
}

/** The standalone body: one Sue, her MCP over this process's stdio, gone when her brain closes stdin. */
async function main() {
  const body = await createSueBody({ sueDir: sueDirFromArgv(process.argv.slice(2)) });
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
