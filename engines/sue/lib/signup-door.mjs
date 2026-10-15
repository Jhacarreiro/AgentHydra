/**
 * signup-door.mjs - the BROWSER half of the Sue signup door.
 * ==================================================================================================
 *
 * WHAT: a standalone module the body wires in right after `launchBrowser`, so a simulated user
 * (sue) can register on Connections even though the accounts signup shows a Cloudflare
 * Turnstile widget - and a Sue never solves a CAPTCHA.
 *
 * The SERVER half (another agent's work) teaches the `aegis-auth-request-otp` Lambda to SKIP
 * Turnstile verification when a `POST /auth/request-otp` arrives with header `x-sue-key` equal to a
 * secret and the email is a Sue address (no daily cap, since 2026-09-23). This module builds the client
 * half in two pieces, both installed on the Playwright `context` before the first navigation:
 *
 *   (a) an init script that - only on an accounts host - patches `window.turnstile.render` IN PLACE
 *       the moment Cloudflare's api.js has loaded (never pre-creating `window.turnstile`, which
 *       api.js reads as "already loaded" and then refuses to initialize), so the widget renders
 *       with Cloudflare's documented always-pass INVISIBLE test sitekey (`1x00000000000000000000BB`)
 *       instead of the page's own sitekey. The page draws its widget `interaction-only`, so a real
 *       visitor whose check passes sees no box at all, and neither does she. (The visible test key
 *       `...AA` drew a red "For testing only, report to site owner" box no real visitor ever meets:
 *       14 of 24 round-19 Sues named it as a trust blocker, 2026-10-06.) Every other turnstile
 *       method (execute/reset/remove) is the real object's own, untouched.
 *
 *   (b) a route on the request-otp endpoint OF AN ACCOUNTS HOST (https, loopback excepted) that,
 *       ONLY for a POST whose JSON body's email is her own address, continues the request with the
 *       `x-sue-key` header added. Every other request is continued untouched, and a request-otp
 *       path on any other host is never even routed.
 *
 * ⛔ THE KEY NEVER LEAVES THIS MODULE. It is read from a file, never logged, never handed to the
 * brain, never injected into the page's JS, never put in a screenshot/trace, and it rides on exactly
 * ONE request - the request-otp POST for her own email. `readSueSignupKey` returns the trimmed value
 * or null; a null key installs NOTHING (the door is simply closed, and she meets the real Turnstile).
 *
 * WHO DEPENDS ON IT: `sue/body.mjs` (wired in by the main session, not here), and the spec
 * `sue/tests/signup-door.spec.mjs`. Plain node v22 ESM; the pure helpers below are exported so
 * the spec can exercise the host and match logic without a browser.
 */

import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Cloudflare's documented dummy sitekey that ALWAYS passes with an INVISIBLE widget: what a real
 * visitor whose check passes sees under the page's `interaction-only` appearance (nothing).
 * https://developers.cloudflare.com/turnstile/troubleshooting/testing/ - this is Cloudflare's own
 * public test key, not a secret, so it is safe to inline and safe to hand the page's render call.
 */
export const TEST_SITEKEY = "1x00000000000000000000BB";

/**
 * The path the accounts SPA posts the signup OTP to. `getApiBase()` returns an ORIGIN
 * (`api.example.com` in prod, same-origin in dev) and `cognito-auth.ts` appends this
 * path, so the pathname is exactly this - see services/accounts/web/src/lib/auth/cognito-auth.ts.
 */
export const REQUEST_OTP_PATHNAME = "/auth/request-otp";

/**
 * The header the key rides on - the SERVER half reads the same name (SUE_KEY_HEADER in
 * services/accounts/lambda/src/auth-request-otp/turnstile-gate.ts). Exported so the signup live
 * probe (.arkitect/your-checks/live/signup-live-probe.mjs) sends the key under this one spelling.
 */
export const SUE_KEY_HEADER = "x-sue-key";

/**
 * The hosts on which the Turnstile wrap is allowed to fire. The three real accounts origins
 * (accounts anchors to the backend host `api.example.com`, plus its two website-domain
 * aliases) and loopback for the offline fixture. Kept in ONE place and passed verbatim into the init
 * script so the in-page guard and `isAccountsHost` can never disagree.
 */
export const ACCOUNTS_HOSTS = Object.freeze([
  "app.example.com",
  "example.org",
  "api.example.com",
  "localhost",
  "127.0.0.1",
]);

/**
 * Default location of the signup key on disk. `SUE_SIGNUP_KEY_FILE` overrides it; otherwise
 * `~/.connections/sue/signup-key`. Read at install time only.
 */
export function defaultSignupKeyFile() {
  return process.env.SUE_SIGNUP_KEY_FILE || path.join(os.homedir(), ".connections", "sue", "signup-key");
}

/**
 * Read the Sue signup key from disk. Returns the trimmed value, or null when the file is missing,
 * unreadable, or empty/whitespace. NEVER logs the value or the reason - a missing key is a normal
 * state (the door stays closed), not an error to surface.
 *
 * @param {{ file?: string }} [opts]
 * @returns {string|null}
 */
export function readSueSignupKey({ file } = {}) {
  const target = file || defaultSignupKeyFile();
  let raw;
  try {
    raw = readFileSync(target, "utf8");
  } catch {
    return null;
  }
  const trimmed = String(raw).trim();
  return trimmed.length ? trimmed : null;
}

/**
 * Normalize a hostname for comparison: string, trimmed, lowercased.
 * @param {unknown} hostname
 */
function normalizeHost(hostname) {
  return String(hostname ?? "")
    .trim()
    .toLowerCase();
}

/**
 * True iff `hostname` is one of the accounts hosts the wrap is allowed to fire on. Pure; exported for
 * the spec. `window.location.hostname` never carries a port, so a bare host compare is exact.
 * @param {string} hostname
 */
export function isAccountsHost(hostname) {
  return ACCOUNTS_HOSTS.includes(normalizeHost(hostname));
}

/** Loopback hosts: the only ones allowed to receive the key over plain http (the offline fixture). */
const LOOPBACK_HOSTS = Object.freeze(["localhost", "127.0.0.1"]);

/**
 * True iff `url` is the request-otp endpoint ON AN ACCOUNTS HOST - the only destination the key may
 * travel to. Pure; exported for the spec, and used by BOTH the Playwright route matcher and
 * `shouldCarryKey`, so neither can match a pathname on some other host. `context.route` sees every
 * request in the context (a third-party page, an ad, a redirect target), so a pathname-only match
 * would hand the key to any host that exposes `/auth/request-otp` (found by a skeptic). Also demands
 * https, except on loopback, so the key never rides a plaintext hop to a real host.
 *
 * @param {string|URL} url
 * @returns {boolean}
 */
export function isKeyTarget(url) {
  let parsed;
  try {
    parsed = new URL(String(url));
  } catch {
    return false;
  }
  if (parsed.pathname !== REQUEST_OTP_PATHNAME) return false;
  const host = normalizeHost(parsed.hostname);
  if (!isAccountsHost(host)) return false;
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && LOOPBACK_HOSTS.includes(host);
}

/**
 * True iff this request is the signup OTP POST for `identityEmail` - the ONLY request that may carry
 * the key. Pure; exported for the spec. Anything that is not a POST, not the request-otp path on an
 * accounts host (`isKeyTarget`), or whose JSON body's `email` (trimmed, case-insensitive) is not
 * exactly her address returns false, including a body that is missing or not JSON.
 *
 * @param {{ method?: string, url?: string, postData?: string|null, identityEmail?: string }} req
 * @returns {boolean}
 */
export function shouldCarryKey({ method, url, postData, identityEmail } = {}) {
  if (String(method ?? "").toUpperCase() !== "POST") return false;
  const wanted = normalizeHost(identityEmail); // same normalize (trim + lowercase) an email wants
  if (!wanted) return false;
  if (!isKeyTarget(url)) return false;

  if (typeof postData !== "string" || !postData.length) return false;
  let body;
  try {
    body = JSON.parse(postData);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object") return false;
  const bodyEmail = normalizeHost(body.email);
  return Boolean(bodyEmail) && bodyEmail === wanted;
}

/**
 * The init-script body, defined at module scope so it is a pure function of its serializable arg and
 * carries no closure over the key (the key must never reach the page). Runs in the PAGE, before any
 * page script, on every navigation. Fires only on an accounts host; anywhere else it leaves the page
 * alone.
 *
 * ⛔ IT MUST NOT TOUCH THE `window.turnstile` BINDING BEFORE api.js RUNS. Cloudflare's real api.js
 * opens with `"turnstile" in window` as its duplicate-load probe, and when that is already true it
 * warns "Turnstile already has been loaded" and never assigns `window.turnstile` at all. An earlier
 * version pre-created the property with `Object.defineProperty` (a setter waiting for the assignment),
 * which made the probe true on a first load, so the real widget never initialized and the SPA threw
 * "Cloudflare Turnstile failed to initialize". Found by a skeptic against the live CDN script.
 *
 * So instead it listens, in the CAPTURE phase on `document`, for the `load` event of any script
 * element. api.js is a classic script that assigns `window.turnstile` synchronously while it
 * executes, and a script's `load` event fires right after that, reaching a document capture
 * listener BEFORE the element's own `onload`, the handler the SPA's `ensureTurnstileScriptLoaded`
 * awaits. So `render` is patched IN PLACE on the real object before the SPA can call it: the patched
 * `render` swaps in the always-pass TEST sitekey and calls the real one, and every other method is
 * the real object's own, untouched. (A `load` capture listener on `window` would never fire: an
 * element's load event does not propagate to the Window.) Idempotent: a later script load, or a
 * Cloudflare upgrade that replaces the object, re-patches only an unpatched `render`.
 *
 * @param {{ testSitekey: string, accountsHosts: string[] }} arg
 */
function turnstileWrapInitScript({ testSitekey, accountsHosts }) {
  try {
    const host = String(location.hostname || "")
      .trim()
      .toLowerCase();
    if (!accountsHosts.includes(host)) return;

    const ours = new WeakSet();
    const patch = () => {
      const api = window.turnstile; // a plain read: never creates the property
      if (!api || typeof api.render !== "function" || ours.has(api.render)) return;
      const realRender = api.render;
      const render = function render(container, options) {
        return realRender.call(api, container, { ...options, sitekey: testSitekey });
      };
      ours.add(render);
      try {
        api.render = render;
      } catch {
        // fall through to defineProperty below
      }
      if (api.render !== render) {
        try {
          Object.defineProperty(api, "render", { value: render, configurable: true, writable: true, enumerable: true });
        } catch {
          // A frozen api object: leave it real, she meets the real widget.
        }
      }
    };

    document.addEventListener(
      "load",
      (event) => {
        const target = event.target;
        if (target && target.tagName === "SCRIPT") patch();
      },
      true,
    );
  } catch {
    // Leave the page's own Turnstile untouched - a broken wrap must never break the real signup.
  }
}

/**
 * Install the signup door on a Playwright BrowserContext. Call BEFORE the first navigation.
 *
 * - `key` null -> installs nothing, returns { installed: false }. The door is closed; she meets the
 *   real Turnstile and the endpoint gets no header.
 * - otherwise installs (a) the Turnstile wrap init script and (b) the request-otp route, and returns
 *   { installed: true }.
 *
 * @param {import('playwright-core').BrowserContext} context
 * @param {{ key: string|null, identityEmail: string, log?: (line: string) => void }} opts
 * @returns {Promise<{ installed: boolean }>}
 */
export async function installSignupDoor(context, { key, identityEmail, log } = {}) {
  const note = typeof log === "function" ? log : () => {};
  if (!key) return { installed: false };

  await context.addInitScript(turnstileWrapInitScript, { testSitekey: TEST_SITEKEY, accountsHosts: [...ACCOUNTS_HOSTS] });

  await context.route(
    (url) => isKeyTarget(url),
    async (route) => {
      const request = route.request();
      if (shouldCarryKey({ method: request.method(), url: request.url(), postData: request.postData(), identityEmail })) {
        note("carried the key for one request");
        return route.continue({ headers: { ...request.headers(), [SUE_KEY_HEADER]: key } });
      }
      return route.continue();
    },
  );

  note("signup door installed");
  return { installed: true };
}
