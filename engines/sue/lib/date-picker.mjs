/**
 * date-picker - a phone's own date and time picker, for a Sue whose headless browser draws none.
 *
 * On a real phone a native date, time, datetime-local or month input opens the phone's picker and
 * the person picks. In the harness nothing is drawn and `fill` refuses anything but an ISO string, so
 * a Sue who typed "10062026" into "Starts" was told the box took "" and quit (runs 20261004-232658-ef53
 * and 20261004-232709-9ce9). Here the picker is the hand: tapping the box says it opened, and typing
 * into it reads the common human formats, sets the value the way a picker does (the native value setter,
 * then real `input` and `change` events, so a framework sees it) and says what the picker shows.
 */

/** The native input types a phone answers with its own picker. */
export const PICKER_TYPES = new Set(["date", "time", "datetime-local", "month"]);

/** The time a datetime-local gets when she gave only a date and the box was empty. */
export const DEFAULT_TIME = "19:00";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_SHORT = MONTHS.map((m) => m.slice(0, 3));
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_WORDS = new Set([
  "sun",
  "sunday",
  "mon",
  "monday",
  "tue",
  "tues",
  "tuesday",
  "wed",
  "wednesday",
  "thu",
  "thur",
  "thurs",
  "thursday",
  "fri",
  "friday",
  "sat",
  "saturday",
]);
const FILLER = new Set(["at", "on", "of", "the", "@"]);

const pad = (n) => String(n).padStart(2, "0");

/** The picker kind of an input type, or null for a box a phone gives a keyboard. */
export function pickerKind(inputType) {
  const kind = String(inputType ?? "").toLowerCase();
  return PICKER_TYPES.has(kind) ? kind : null;
}

function monthIndex(word) {
  if (!/^[a-z]+$/.test(word) || word.length < 3) return -1;
  const i = MONTH_SHORT.indexOf(word.slice(0, 3));
  if (i < 0) return -1;
  return MONTHS[i].startsWith(word) || word === "sept" ? i : -1;
}

function realDate(y, m, d) {
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m - 1 && at.getUTCDate() === d;
}

function clock(h, min, ampm) {
  if (min < 0 || min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    return { h: (h % 12) + (ampm === "pm" ? 12 : 0), min };
  }
  return h >= 0 && h <= 23 ? { h, min } : null;
}

/**
 * Reads what she typed: `{ y, m, d, time }`, each null when she did not give it, or null when it is
 * not a date and time at all. `kind` decides what a bare four-digit number is (a year or a time).
 */
function read(raw, kind) {
  let s = String(raw)
    .trim()
    .toLowerCase()
    .replace(/^(\d{4}-\d{2}-\d{2})t/, "$1 ")
    .replace(/,/g, " ")
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, "$1")
    .replace(/\b([ap])\.m\.?/g, "$1m")
    .replace(/\bnoon\b/g, "12:00")
    .replace(/\bmidnight\b/g, "00:00")
    .replace(/(\d)\s+(am|pm)\b/g, "$1$2");
  const out = { y: null, m: null, d: null, time: null };
  const tokens = s.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  for (const token of tokens) {
    let hit;
    if (FILLER.has(token) || WEEKDAY_WORDS.has(token)) continue;
    const named = monthIndex(token);
    if (named >= 0 && out.m == null) {
      out.m = named + 1;
    } else if ((hit = token.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/))) {
      out.y = Number(hit[1]);
      out.m = Number(hit[2]);
      if (hit[3]) out.d = Number(hit[3]);
    } else if ((hit = token.match(/^(\d{1,2})[/.-](\d{4})$/))) {
      out.m = Number(hit[1]);
      out.y = Number(hit[2]);
    } else if ((hit = token.match(/^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/))) {
      out.m = Number(hit[1]);
      out.d = Number(hit[2]);
      if (hit[3]) out.y = hit[3].length === 2 ? 2000 + Number(hit[3]) : Number(hit[3]);
    } else if ((hit = token.match(/^(\d{2})(\d{2})(\d{4})$/)) && out.m == null) {
      out.m = Number(hit[1]);
      out.d = Number(hit[2]);
      out.y = Number(hit[3]);
    } else if ((hit = token.match(/^(\d{4})(\d{2})(\d{2})$/)) && out.m == null) {
      out.y = Number(hit[1]);
      out.m = Number(hit[2]);
      out.d = Number(hit[3]);
    } else if ((hit = token.match(/^(\d{1,2}):(\d{2})(?::\d{2})?(am|pm)?$/)) && !out.time) {
      out.time = clock(Number(hit[1]), Number(hit[2]), hit[3]);
      if (!out.time) return null;
    } else if ((hit = token.match(/^(\d{1,2})(am|pm)$/)) && !out.time) {
      out.time = clock(Number(hit[1]), 0, hit[2]);
      if (!out.time) return null;
    } else if (
      (hit = token.match(/^(\d{1,2})(\d{2})(am|pm)?$/)) &&
      !out.time &&
      !(out.m != null && out.y == null && token.length === 4 && !hit[3] && kind !== "time")
    ) {
      out.time = clock(Number(hit[1]), Number(hit[2]), hit[3]);
      if (!out.time) return null;
    } else if (/^\d{4}$/.test(token) && out.y == null) {
      out.y = Number(token);
    } else if (/^\d{1,2}$/.test(token) && out.d == null && kind !== "month" && kind !== "time") {
      out.d = Number(token);
    } else if (/^\d{1,2}$/.test(token) && kind === "time" && !out.time) {
      out.time = clock(Number(token), 0, null);
      if (!out.time) return null;
    } else {
      return null;
    }
  }
  return out;
}

/** "Tue Oct 6 2026" */
function dateWords(y, m, d) {
  const day = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${day} ${MONTH_SHORT[m - 1][0].toUpperCase()}${MONTH_SHORT[m - 1].slice(1)} ${d} ${y}`;
}

/** "7:00 PM" */
function timeWords(h, min) {
  return `${h % 12 || 12}:${pad(min)} ${h >= 12 ? "PM" : "AM"}`;
}

/** What a picker's value reads like to a person: "Tue Oct 6 2026, 7:00 PM". Empty value is "nothing". */
export function pickerWords(kind, value) {
  const v = String(value ?? "");
  let hit;
  if (kind === "date" && (hit = v.match(/^(\d{4})-(\d{2})-(\d{2})$/))) return dateWords(+hit[1], +hit[2], +hit[3]);
  if (kind === "time" && (hit = v.match(/^(\d{2}):(\d{2})/))) return timeWords(+hit[1], +hit[2]);
  if (kind === "month" && (hit = v.match(/^(\d{4})-(\d{2})$/)))
    return `${MONTHS[+hit[2] - 1][0].toUpperCase()}${MONTHS[+hit[2] - 1].slice(1)} ${hit[1]}`;
  if (kind === "datetime-local" && (hit = v.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/)))
    return `${dateWords(+hit[1], +hit[2], +hit[3])}, ${timeWords(+hit[4], +hit[5])}`;
  return null;
}

const WHAT = { date: "date", time: "time", "datetime-local": "date and time", month: "month" };
const EXAMPLE = {
  date: 'for example "Oct 6 2026" or "10/06/2026"',
  time: 'for example "7pm" or "19:00"',
  "datetime-local": 'for example "Oct 6 2026 7pm", "10/06/2026 19:00" or "10062026 0700PM"',
  month: 'for example "Oct 2026" or "10/2026"',
};

/** What she is told when a tap lands on a picker box: the phone's picker opened, and how to answer it. */
export function pickerOpenedSentence(kind, label, value) {
  const now = pickerWords(kind, value);
  return `Your phone's ${WHAT[kind]} picker opened for ${label}${now ? `, showing ${now}` : ", showing nothing yet"}. Type the ${WHAT[kind]} you want with type, ${EXAMPLE[kind]}, and the picker sets it.`;
}

/** What she is told when what she typed is not a date and time. The field is left as it was. */
export function pickerDidNotUnderstand(kind) {
  return `The picker did not understand that, try ${EXAMPLE[kind].replace(/^for example /, "e.g. ")}.`;
}

/**
 * The value a picker of `kind` ends up with for what she typed, given what it showed before
 * (`current`, "" when empty): `{ value, defaultedTime }`, or null when it is not understood.
 * `now` is the clock; a date with no year is this year, or next when this year's has gone by.
 */
export function parsePickerInput(raw, kind, current = "", now = new Date()) {
  const read1 = read(raw, kind);
  if (!read1) return null;
  const { m, d, time } = read1;
  let { y } = read1;
  const have = String(current ?? "");
  const [curDate = "", curTime = ""] = kind === "datetime-local" ? have.split("T") : [have, ""];
  if (kind === "time") {
    if (!time || m != null || d != null || y != null) return null;
    return { value: `${pad(time.h)}:${pad(time.min)}`, defaultedTime: false };
  }
  if (kind === "month") {
    if (m == null || m < 1 || m > 12 || time) return null;
    if (y == null) y = m < now.getMonth() + 1 ? now.getFullYear() + 1 : now.getFullYear();
    return { value: `${y}-${pad(m)}`, defaultedTime: false };
  }
  // date and datetime-local: a time alone changes only the time of a date already there.
  let date = null;
  if (m != null && d != null) {
    if (y == null) {
      y = now.getFullYear();
      if (new Date(Date.UTC(y, m - 1, d)) < new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))) y += 1;
    }
    if (m < 1 || m > 12 || !realDate(y, m, d)) return null;
    date = `${y}-${pad(m)}-${pad(d)}`;
  } else if (m != null || d != null || y != null) {
    return null;
  }
  if (kind === "date") return date && !time ? { value: date, defaultedTime: false } : null;
  if (!date && !time) return null;
  if (!date && !/^\d{4}-\d{2}-\d{2}$/.test(curDate)) return null; // a time with no day to put it on
  let defaultedTime = false;
  let at = time ? `${pad(time.h)}:${pad(time.min)}` : /^\d{2}:\d{2}/.test(curTime) ? curTime.slice(0, 5) : null;
  if (!at) {
    at = DEFAULT_TIME;
    defaultedTime = true;
  }
  return { value: `${date ?? curDate}T${at}`, defaultedTime };
}

/** Runs IN THE PAGE: sets the value through the native setter and fires input then change; returns what the box holds. */
export function setPickerValue(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
}

/** The sentence after a good set: what the picker shows now, in words, and that a default time was filled. */
export function pickerSetSentence(kind, label, name, shown, defaultedTime) {
  const words = pickerWords(kind, shown) ?? `"${shown}"`;
  return `The picker set ${name || label} to ${words}.${defaultedTime ? ` You gave only a date, so it filled in ${timeWords(...DEFAULT_TIME.split(":").map(Number))} for the time.` : ""}`;
}
