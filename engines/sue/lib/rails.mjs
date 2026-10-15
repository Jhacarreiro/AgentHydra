/**
 * What a Sue's hand refuses to press, whatever the brain decided.
 *
 * Two rails. A target's own `refuseClicks` names what deletes or removes on that product. And every
 * signed-in Sue (`cannon --as <name>`) also carries SUE's own rail, because she is on a BORROWED,
 * real account on a live product: anything that changes something real there (posts or publishes,
 * sends, saves, creates or generates a key, invites, pays, subscribes, copies a secret to the
 * lender's clipboard) is refused. With only a destructive rail, two signed-in Sues minted live
 * access tokens on the lender's account and one pressed "Post" twice on his real Discord server.
 *
 * A target that says `noCommit: true` puts that real-change rail on EVERY Sue it launches, signed in
 * or not. An anonymous Sue on a public page can still write into somebody else's product: an RSVP on
 * a real host's event puts a Sue address on a real guest list (queued 2026-09-22 before any events
 * wave; `targets/connections-events.json` is the first target that needs it).
 *
 * On somebody else's live website (lib/site-owner.mjs) every Sue carries the widest rail, free hands
 * or not: LIVE_SITE_RAIL's words, and any press that submits a form (`submits`), because a sent form
 * there reaches a real person (a performer's booking site, docket 20260925-185147-ed76). She still
 * opens every form and judges it up to the Send button; only the send is refused.
 *
 * A THROWAWAY account saved with `login.mjs --free-hands` lifts both: a human made it for Sues, so
 * they may post, save, create and delete there. One rail stays on every signed-in Sue, free hands or
 * not: signing out or deleting the account ends the session every other Sue in the run is using, and
 * so do changing its password or turning on two-factor sign-in (Discord ends every saved sign-in for
 * both) and leaving the one server the account was lent for.
 *
 * The borrowed rail reads what a hand PRESSES (buttons and the like: a page's own options, menu
 * items and switches too), never links, tabs, check boxes, drop-down choices or text boxes:
 * following a link inside the site only loads a page, and ticking a box changes nothing until
 * something is saved, which the rail refuses.
 *
 * Her other hands carry the same rails (body.mjs): a key reads what it would press (`keyPressTargets`)
 * and a paste is refused everywhere (`refusedKey`: her clipboard is the machine's); the address bar
 * opens only an address she has seen or a front door she knows (`goToVerdict`, THE SUE LAW); and a
 * pointer names what is under it (`spotUnder`) so a press there meets the same rails as a click.
 */
import { urlAllowed } from "./findings.mjs";

export const BORROWED_ACCOUNT_RAIL =
  /\b(post|publish|send|save|submit|create|generate|new (token|key)|invite|add (the )?bot|install|rsvp|register|reserve|attend|pay|buy|purchase|order|subscribe|upgrade|start (a |the |your )?(free )?trial|check ?out|confirm|authori[sz]e|transfer|redeem|renew|copy)\b/i;

/**
 * On somebody else's live website (lib/site-owner.mjs) a press that sends anything reaches a real
 * person: the real-change words plus a sign-up and a donation. The words are the second line of
 * defence; the first is structural, any press that submits a form (`submits`, read in the page),
 * whatever its button says. "Get a quote", "Enquire" or "Book" are left to that structural rail on
 * purpose: on most sites those buttons only open the form, and she still judges the form.
 */
export const LIVE_SITE_RAIL = new RegExp(`${BORROWED_ACCOUNT_RAIL.source.slice(0, -3)}|sign ?up|donate)\\b`, "i");

/** Ends the lent session for every Sue sharing it: by its words, or by a link to a sign-out route. */
export const SESSION_RAIL =
  /\b(sign(ing)? ?out|log ?out|log off|(delete|disable|close|deactivate) (my |your |this )?account|(change|reset) (my |your |the )?password|enable (two-factor|2fa|authenticator)|leave (the |this )?(server|workspace|team|group))\b/i;
const SESSION_HREF = /\/(log-?out|sign-?out)\b/i;

/**
 * `{ destructive, realChange, session }`: regexes, or null where that rail does not apply.
 * `keepRefuseClicks`: the target's own list holds even with free hands. A target whose Sues carry
 * sessions from several sites sets it, because free hands granted for one site must not lift what
 * the combined target says is never to be pressed on any of them. `noCommit`: the target's own
 * `noCommit: true`, which puts the real-change rail on a Sue with no session too. `liveSite`:
 * somebody else's live website, where the wider LIVE_SITE_RAIL and the form-submit rail hold on
 * every Sue, free hands or not - a throwaway account does not make the people behind a stranger's
 * site any less real.
 */
export function railsFor({
  refuseClicks = null,
  borrowed = false,
  freeHands = false,
  keepRefuseClicks = false,
  noCommit = false,
  liveSite = false,
} = {}) {
  return {
    destructive: refuseClicks && (!freeHands || keepRefuseClicks) ? new RegExp(refuseClicks, "i") : null,
    realChange: liveSite ? LIVE_SITE_RAIL : (borrowed || noCommit) && !freeHands ? BORROWED_ACCOUNT_RAIL : null,
    session: borrowed ? SESSION_RAIL : null,
    liveSite: Boolean(liveSite),
  };
}

/**
 * What a hand on it does not press. A tab only shows its panel, as a link only loads a page. A page's
 * own widgets that DO act when chosen are presses, read like a button: an [role=option] in a
 * command search, a menu item, a switch (run 20260922-063426-626a numbered them for the first time).
 * A box to type in (role "input") is not one either: a press on "Invite by email" only focuses it,
 * yet it was filed as refused-real-change (finding 2026-09-22). Its Enter presses a real submit
 * button, which keyPressTargets reads as a press.
 */
const NOT_A_PRESS = new Set(["link", "checkbox", "radio", "select", "textarea", "tab", "input"]);

/**
 * Which rail stops a press on something named `name`: "session", "live-site", "destructive",
 * "real-change", or null. `submits`: the press sends a form (the inventory's and keyPressTargets'
 * reading), refused on a live site whatever the button says or whether it says anything.
 */
export function refusedBy(rails, name, { role = "button", href = null, submits = false } = {}) {
  const words = String(name ?? "");
  if (rails?.session && (rails.session.test(words) || SESSION_HREF.test(String(href ?? "")))) return "session";
  if (rails?.liveSite && submits) return "live-site";
  if (!words.trim()) return null;
  if (rails?.destructive?.test(words)) return "destructive";
  if (!NOT_A_PRESS.has(role) && rails?.realChange?.test(words)) return rails.liveSite ? "live-site" : "real-change";
  return null;
}

/**
 * Runs IN THE PAGE (`page.evaluate(keyPressTargets, key)`), so it may use nothing from this module.
 * What Enter or Space would press from where the focus is: the focused button (or option, menu item,
 * switch) itself, the item a focused search box or list points at, a focused link on Enter, or, on
 * Enter in a box, that form's submit buttons or, with no form, a synthetic "send" for a box that
 * takes text. `[{ name, role }]`, empty when the key presses nothing.
 */
export function keyPressTargets(key) {
  // `key` may carry what is held ("Control+Enter"): Ctrl or Alt with Enter in a text area is how
  // most message boxes send, so a held Enter there is read like Enter in a one-line box.
  const parts = String(key).split("+");
  const held = parts.slice(0, -1).some((m) => m !== "Shift");
  const base = parts.at(-1);
  const el = document.activeElement;
  if (!el || el === document.body) return [];
  const nameOf = (node) =>
    (
      (node.innerText || "").trim() ||
      node.getAttribute("aria-label") ||
      node.getAttribute("value") ||
      node.getAttribute("title") ||
      ""
    ).trim();
  const tag = el.tagName.toLowerCase();
  const type = (el.getAttribute("type") || "").toLowerCase();
  // A page's own widget acts on Enter or Space like a button: an option, a menu item, a switch. A
  // search box or list that points at one of its items (aria-activedescendant) chooses that one:
  // on Enter, and on Space where Space does not type a space.
  const WIDGETS = ["option", "menuitem", "menuitemcheckbox", "menuitemradio", "switch"];
  const widgetRole = (node) => (node.getAttribute("role") || "").trim().toLowerCase();
  const typesText =
    tag === "textarea" || el.isContentEditable || (tag === "input" && !["checkbox", "radio", "button", "submit", "reset"].includes(type));
  const pointedId = el.getAttribute("aria-activedescendant");
  const pointed = pointedId ? document.getElementById(pointedId) : null;
  const chosen =
    pointed && WIDGETS.includes(widgetRole(pointed)) && (base === "Enter" || !typesText)
      ? [{ name: nameOf(pointed), role: widgetRole(pointed) }]
      : [];
  if (WIDGETS.includes(widgetRole(el))) return [{ name: nameOf(el), role: widgetRole(el) }];
  // A search form only fetches a page of results: sending it messages nobody. Anything else a form
  // sends (`submits`) the live-site rail refuses whatever its button says (lib/rails.mjs refusedBy).
  const sendsForm = (form) =>
    Boolean(form) &&
    !(
      (form.getAttribute("role") || "").toLowerCase() === "search" ||
      form.closest("[role=search]") ||
      form.querySelector('input[type="search"]') ||
      [...form.querySelectorAll("input[name]")].some((i) => /^(q|s|query|search|keywords?)$/i.test(i.getAttribute("name") || ""))
    );
  if (tag === "button" || el.getAttribute("role") === "button" || (tag === "input" && ["submit", "button"].includes(type))) {
    const submitType = tag === "button" ? (el.getAttribute("type") || "submit").toLowerCase() : type;
    return [{ name: nameOf(el), role: "button", ...(submitType === "submit" && sendsForm(el.form) ? { submits: true } : {}) }];
  }
  if (tag === "a") return base === "Enter" ? [{ name: nameOf(el), role: "link", href: el.getAttribute("href") }] : [];
  if (base !== "Enter" || (tag === "textarea" && !held)) return chosen;
  // A formless box that takes text (an input, a textarea, a contenteditable or role=textbox composer)
  // has no submit button to read, yet Enter in it may send what she typed. A synthetic "send" press
  // stands in, so the borrowed rail reads it like a Send button (the real Discord incident).
  if (!el.form) return typesText || widgetRole(el) === "textbox" ? [...chosen, { name: "send", role: "button" }] : chosen;
  const sends = sendsForm(el.form);
  const buttons = [...el.form.querySelectorAll('button:not([type]), button[type="submit"], input[type="submit"]')].map((b) => ({
    name: nameOf(b),
    role: "button",
    ...(sends ? { submits: true } : {}),
  }));
  // Enter in a form with no submit button still sends it (implicit submission): a nameless press
  // that only the form-submit rail reads, so a borrowed Sue's Enter in a search box is untouched.
  return [...chosen, ...(buttons.length ? buttons : sends ? [{ name: "", role: "button", submits: true }] : [])];
}

/** What her hands tell her when a rail stopped them. */
export function refusalSentence(which, label) {
  if (which === "session") {
    return `You stop your hand: ${label} would sign you out of the account you were lent, and other people are using it at the same moment. Carry on without it.`;
  }
  if (which === "destructive") {
    return `You stop your hand: ${label} would delete or remove something, and you are not doing that today. Look for another way.`;
  }
  if (which === "clipboard") return "There is nothing of yours copied to paste here. Type it instead.";
  if (which === "live-site") {
    return `You stop your hand: this is somebody else's real website, and ${label} would send something to the real people behind it. Nothing on the page failed; you chose not to press it. Write in your diary what you were about to send and whether you would really have pressed it, then carry on with what you can see or call done.`;
  }
  return `You stop your hand: you are trying this out on somebody else's real account, and ${label} would change something real on it. Nothing on the page failed; you chose not to press it. Say whether you would have pressed it and what you expected to happen, then carry on with what you can see or call done.`;
}

// ---------------------------------------------------------------------------------------------
// The keyboard: one key, with Ctrl, Shift or Alt held, on every target
// ---------------------------------------------------------------------------------------------

const HELD = { ctrl: "Control", control: "Control", shift: "Shift", alt: "Alt" };
const HELD_PREFIX = /^(ctrl|control|shift|alt)\s*\+\s*(?=.)/i;
const NAMED_KEYS = ["Enter", "Escape", "Tab", "Backspace", "Delete", "Space", "Home", "End", "PageUp", "PageDown"];
const ARROWS = ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight"];
const KEY_WORDS = {
  esc: "Escape",
  return: "Enter",
  del: "Delete",
  up: "ArrowUp",
  down: "ArrowDown",
  left: "ArrowLeft",
  right: "ArrowRight",
};

/**
 * "ctrl+a", "E", "Shift+Tab", "Ctrl++" in Playwright's words: `{ combo, key, held, printable }`, or
 * null when it is not one key. A letter comes out the way a real keyboard sends it: small unless
 * Shift is held, so Ctrl+A is `Control+a` exactly as a browser reports it. `printable` is true when
 * the key types a character into whatever has the focus (nothing but Shift held).
 */
export function readKey(said) {
  let rest = String(said ?? "").trim();
  const held = [];
  for (let m = HELD_PREFIX.exec(rest); m; m = HELD_PREFIX.exec(rest)) {
    const mod = HELD[m[1].toLowerCase()];
    if (!held.includes(mod)) held.push(mod);
    rest = rest.slice(m[0].length);
  }
  if (!rest) return null;
  let key = [...NAMED_KEYS, ...ARROWS].find((k) => k.toLowerCase() === rest.toLowerCase()) ?? KEY_WORDS[rest.toLowerCase()] ?? null;
  const character = !key && /^[!-~]$/.test(rest);
  if (character) key = /^[a-z]$/i.test(rest) ? (held.includes("Shift") ? rest.toUpperCase() : rest.toLowerCase()) : rest;
  if (!key) return null;
  const sent = key === "Space" && !held.length ? " " : key;
  return { combo: [...held, sent].join("+"), key, held, printable: character && !held.some((m) => m !== "Shift") };
}

/** Longest and shortest a Sue holds a key or a finger, in ms: a game reads a hold in frames, and a minute-long hold is a stuck hand. */
export const HOLD_MIN_MS = 100;
export const HOLD_MAX_MS = 5000;

/** `holdMs` as a clamped whole number of ms, or null when she gave none (a tap) or something that is not a number of ms. */
export function readHold(holdMs) {
  if (holdMs == null || holdMs === "") return null;
  const ms = Number(holdMs);
  if (!Number.isFinite(ms) || ms <= 0) return null;
  return Math.min(HOLD_MAX_MS, Math.max(HOLD_MIN_MS, Math.round(ms)));
}

/**
 * The keys one `press` names, as strings for `readKey`: a `keys` list, else `key`. "Ctrl+A" and "Ctrl++" are one key; a
 * string that is not one key is read as several held together ("D+Space", "Shift+D+Space": a modifier goes on the key
 * after it). Each comes back unchecked, so `readKey` and `refusedKey` judge every one exactly as they judge a lone tap.
 */
export function keysNamed(key, keys) {
  if (Array.isArray(keys) && keys.length) return keys.map(String);
  // A shell relay hands a list over as one string ("D,Space"): read it as keys held together.
  const whole = String(key || (typeof keys === "string" ? keys.replace(/\s*,\s*/g, "+") : "") || "").trim();
  if (!whole || readKey(whole)) return [whole];
  const out = [];
  let prefix = "";
  for (const part of whole.split(/\s*\+\s*/)) {
    if (HELD[part.toLowerCase()]) prefix += `${part}+`;
    else {
      out.push(`${prefix}${part}`);
      prefix = "";
    }
  }
  if (prefix) out.push(prefix.slice(0, -1));
  return out;
}

/**
 * Which rail stops a key: "clipboard" for a paste on every target (a Sue's clipboard is the
 * machine's, and what the operator last copied must never land in a product), "real-change" for a
 * copy or cut on a borrowed account (the borrowed rail already refuses a Copy button for the same
 * reason), else null.
 */
export function refusedKey(rails, read) {
  if (!read) return null;
  const ctrl = read.held.includes("Control");
  const letter = String(read.key).toLowerCase();
  if (ctrl && letter === "v") return "clipboard";
  if (ctrl && (letter === "c" || letter === "x") && rails?.realChange && !rails.liveSite) return "real-change";
  return null;
}

// ---------------------------------------------------------------------------------------------
// The address bar (go_to): THE SUE LAW, a Sue never skips a step a first-time human would take
// ---------------------------------------------------------------------------------------------
//
// A first-time human cannot type an address they have never seen. So `go_to` opens only (a) an
// address she has SEEN this visit (a link or an address written on a page she looked at, a page she
// was on, a link in an email she read), or (b) the bare front door of a site she knows by name (a
// host the target names exactly, the start page's, or one she has seen an address on). It stays
// inside the allowed hosts like every other way of moving.

const WEB = /^https?:$/;
const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
const NOT_WEB_SCHEME = /^(javascript|data|about|file|mailto|blob|chrome|view-source|ftp|ws|wss):/i;

/** What she typed, as a URL: an address with no scheme gets the start page's. Null when it is not an address. */
export function readAddress(typed, defaultProtocol = "https:") {
  const raw = String(typed ?? "").trim();
  if (!raw || /\s/.test(raw)) return null;
  const whole = WITH_SCHEME.test(raw) || NOT_WEB_SCHEME.test(raw) ? raw : `${defaultProtocol}//${raw.replace(/^\/+/, "")}`;
  try {
    return new URL(whole);
  } catch {
    return null;
  }
}

/** Where an address points: host (with port), path without a trailing slash, query. Never the scheme or the #part. */
export function addressKey(url) {
  const u = url instanceof URL ? url : readAddress(url);
  return u ? `${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}${u.search}` : null;
}

/** Remember one address she has seen; only web addresses count. */
export function noteSeen(seen, href) {
  const u = readAddress(href);
  if (u && WEB.test(u.protocol)) seen.set(addressKey(u), u.href);
}

const WRITTEN_ADDRESS =
  /\bhttps?:\/\/[^\s<>"'()[\]{}]+|\b(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,24}(?::\d{2,5})?(?:\/[^\s<>"'()[\]{}]*)?/gi;

/** Every web address written in some words (a page's text, an email): full URLs and bare `site.com/path`. */
export function urlsIn(words, defaultProtocol = "https:") {
  const found = [];
  for (const match of String(words ?? "").matchAll(WRITTEN_ADDRESS)) {
    const u = readAddress(match[0].replace(/[.,;:!?]+$/, ""), defaultProtocol);
    if (u && WEB.test(u.protocol)) found.push(u.href);
  }
  return found;
}

function hostOf(href) {
  try {
    return new URL(String(href)).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * `{ url }` to open, or `{ refused, sentence, href? }`. `seen` maps `addressKey` -> the href she saw.
 * Refused as "not-an-address" (no web address), "unknown-address" (THE SUE LAW), or "off-host"
 * (the sandbox; the body turns a declared exit into a hand-off, as it does for a click).
 */
export function goToVerdict(typed, { seen = new Map(), allowedHosts = [], startUrl = "" } = {}) {
  const defaultProtocol = hostOf(startUrl) ? new URL(startUrl).protocol : "https:";
  const url = readAddress(typed, defaultProtocol);
  if (!url || !WEB.test(url.protocol)) {
    return { refused: "not-an-address", sentence: "That is not a web address you could type into the address bar." };
  }
  const seenHref = seen.get(addressKey(url));
  const knownHosts = new Set(
    [
      ...allowedHosts.map((h) => String(h ?? "").toLowerCase()).filter((h) => h && !h.startsWith("*.")),
      hostOf(startUrl),
      ...[...seen.values()].map(hostOf),
    ].filter(Boolean),
  );
  const frontDoor = url.pathname.replace(/\/+$/, "") === "" && !url.search && knownHosts.has(url.host.toLowerCase());
  if (!seenHref && !frontDoor) {
    return { refused: "unknown-address", sentence: "You do not know that address; you would have to find a link to it." };
  }
  const href = seenHref ?? url.href;
  if (!urlAllowed(href, allowedHosts))
    return { refused: "off-host", href, sentence: "That address is a different website. You stay here." };
  return { url: href };
}

// ---------------------------------------------------------------------------------------------
// The pointer: what is under a spot she points at
// ---------------------------------------------------------------------------------------------

/** A robot check served in a frame, by its address: never pointed at, same as a numbered one. */
export const CAPTCHA_FRAME = /captcha|turnstile|challenges\.cloudflare\.com|arkoselabs|geetest/i;

/**
 * Runs IN THE PAGE (`page.evaluate(spotUnder, [x, y])`), so it may use nothing from this module.
 * What a pointer at x,y (CSS pixels) is over: the numbered thing there, if any (`id`), the words of
 * the nearest thing with a hand cursor (what a press there would press, for the rails), the link it
 * sits in, and a frame's address.
 */
export function spotUnder([x, y]) {
  let hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  // Down into a web component's open shadow root, where her numbered control really sits.
  while (hit.shadowRoot) {
    const inner = hit.shadowRoot.elementFromPoint(x, y);
    if (!inner || inner === hit) break;
    hit = inner;
  }
  let presses = hit;
  while (presses && presses !== document.body && getComputedStyle(presses).cursor !== "pointer")
    presses = presses.parentElement ?? presses.parentNode?.host ?? null;
  const words =
    presses && presses !== document.body
      ? (presses.getAttribute("aria-label") || presses.innerText || presses.getAttribute("title") || "").trim().slice(0, 160)
      : "";
  return {
    id: hit.closest("[data-sue-id]")?.getAttribute("data-sue-id") ?? null,
    name: words,
    href: hit.closest("a")?.getAttribute("href") ?? null,
    frame: hit.tagName === "IFRAME" ? hit.getAttribute("src") || "" : "",
  };
}

/**
 * Runs IN A FRAME (`frame.evaluate(fieldAt, spot)`), so it may use nothing from this module. What a
 * hand at `spot` (CSS pixels inside that frame) lands on, or with no spot what has the keyboard's
 * focus, in the words the field rails read (`isHiddenField`, `isPaymentField`): `field` when it
 * takes typing, and for a frame set into the page its address and where its inside starts, so the
 * body can reach in. The inventory never looks inside a frame; this is how the rails do.
 */
export function fieldAt(spot) {
  const el = spot ? document.elementFromPoint(spot[0], spot[1]) : document.activeElement;
  if (!el) return null;
  const tag = el.tagName;
  const style = getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const label = (el.labels && el.labels[0] && el.labels[0].innerText) || el.getAttribute("aria-label") || "";
  // A control that takes no typing is not a field: a see-through range, check box or file box laid
  // over the picture of a handle is what a real hand drags or clicks (vectormagik's compare slider
  // was refused as a hidden field, 2026-09-27). The honeypot a hidden-field rail exists for is a box
  // you type into.
  const untyped = /^(range|checkbox|radio|button|submit|reset|image|file|color)$/i;
  return {
    field:
      /^(TEXTAREA|SELECT)$/.test(tag) || (tag === "INPUT" && !untyped.test(el.getAttribute("type") || "")) || el.isContentEditable === true,
    hidden: style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0 || rect.width < 2 || rect.height < 2,
    inputType: el.getAttribute("type") || "",
    autocomplete: el.getAttribute("autocomplete") || "",
    name: el.getAttribute("name") || "",
    placeholder: el.getAttribute("placeholder") || "",
    labelText: String(label).trim().slice(0, 160),
    frame: tag === "IFRAME" || tag === "FRAME" ? el.src || location.href : "",
    left: rect.left + el.clientLeft,
    top: rect.top + el.clientTop,
  };
}

/**
 * Runs IN THE PAGE just before a right-click: watches whether the page answers it with a menu of
 * its own. Last in line on `window`, it also stops the browser's own menu, which never shows in her
 * picture and, headed, would open on the operator's screen. `readMenuWatch` reads the answer.
 */
export function armMenuWatch() {
  const old = window.__sueMenuWatch;
  if (old) window.removeEventListener("contextmenu", old.listener);
  const watch = { reached: false, pageOwn: false };
  watch.listener = (event) => {
    watch.reached = true;
    watch.pageOwn = event.defaultPrevented;
    if (!event.defaultPrevented) event.preventDefault();
  };
  window.addEventListener("contextmenu", watch.listener);
  Object.defineProperty(window, "__sueMenuWatch", { value: watch, configurable: true, enumerable: false, writable: true });
}

/** Runs IN THE PAGE after the right-click: "browser" when only the browser would have answered it, else "page". */
export function readMenuWatch() {
  const watch = window.__sueMenuWatch;
  if (!watch) return "page";
  window.removeEventListener("contextmenu", watch.listener);
  delete window.__sueMenuWatch;
  return watch.reached && !watch.pageOwn ? "browser" : "page";
}
