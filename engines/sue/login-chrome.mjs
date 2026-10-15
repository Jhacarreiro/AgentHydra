#!/usr/bin/env node
/**
 * login-chrome - the same capture as login.mjs, in the human's OWN Chrome.
 * ==============================================================================
 *
 * WHAT: `node sue/login-chrome.mjs --target <id|path.json> --as <name> [--free-hands]` starts
 * the machine's real Chrome with a profile of its own (`<name>.chrome/` beside the session file) and
 * a debugging port, opens the target's `signIn.url`, and watches from outside until the target's
 * probe answers signed-in. Then it saves ONLY the target host's cookies, exactly as login.mjs does,
 * plus the page-storage items the target names (`signIn.localStorage`: Discord's web app keeps its
 * sign-in there), says which account it saved, and closes Chrome. Nothing types for him and no
 * cookie or storage value is ever printed.
 *
 * WHY IT EXISTS: Discord refuses to sign anyone in from a Playwright-launched browser (it carries
 * the automation flag), so `login.mjs` could not capture a Example App Next session at all. Real
 * Chrome, attached to afterwards over its debugging port, is an ordinary browser to the identity
 * provider. The profile is its own directory, so his everyday Chrome and its accounts are untouched
 * and a second, throwaway account can be signed in beside them.
 *
 * A SAVED LOGIN (`--profile <name> --site <url> [--free-hands]`, lib/profiles.mjs) is the same
 * window for any site, with no target and no probe: he signs in, closes the window, and the last look
 * at the site's own cookies and page storage is saved under that name for any wave to arrive with.
 * The Sue Manager's Logins tab starts exactly this.
 *
 * Plain node v22, never bun (bun hangs Playwright's chromium launch on this box).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";

import { chromium } from "playwright-core";

import { loadTarget } from "./lib/personas.mjs";
import { assertProfileName, keepSiteCookies, onSite, profileChromeDir, profileSite, saveProfile } from "./lib/profiles.mjs";
import {
  describeSession,
  keepTargetCookies,
  keepTargetStorage,
  mustSignUpForReal,
  probeSession,
  sessionFile,
  writeSession,
} from "./lib/sessions.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

/** How long the window waits for him by default; `--wait <minutes>` when he may not be at the screen yet. */
const WAIT_MS = 15 * 60_000;
const log = (msg) => process.stderr.write(`[sue-login-chrome] ${msg}\n`);

const CHROME_CANDIDATES = [
  `${process.env.PROGRAMFILES ?? "C:/Program Files"}/Google/Chrome/Application/chrome.exe`,
  `${process.env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)"}/Google/Chrome/Application/chrome.exe`,
  `${process.env.LOCALAPPDATA ?? ""}/Google/Chrome/Application/chrome.exe`,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
];

/** The installed Chrome, or null. Never Chromium: the point of this script is a browser Discord trusts. */
export function findChrome(candidates = CHROME_CANDIDATES, exists = (p) => fs.existsSync(p)) {
  return candidates.find((candidate) => candidate && exists(candidate)) ?? null;
}

/** The profile Chrome signs in with, beside the session file, so the next capture is one click. */
export function chromeProfileDir(targetId, name) {
  return sessionFile(targetId, name).replace(/\.json$/, ".chrome");
}

export function chromeArgs({ profileDir, port, url }) {
  return [
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--new-window",
    url,
  ];
}

/**
 * Quit Chrome for real through the debugging protocol. `browser.close()` on a connectOverCDP browser
 * only drops the websocket: the detached Chrome stays running with --remote-debugging-port open over
 * the profile that holds the captured session, so any local process could read its cookies. The CDP
 * Browser.close command is what actually shuts the browser down.
 */
export async function closeBrowserByCdp(browser) {
  const cdp = await browser.newBrowserCDPSession();
  try {
    await cdp.send("Browser.close");
  } finally {
    await cdp.detach().catch(() => {}); // best-effort: Browser.close may already have severed it
  }
}

/**
 * Kill the spawned Chrome and the helpers it forked. The child is detached, so on Windows a plain
 * kill of its pid leaves the renderers and their debugging port behind; taskkill /T reaches the
 * whole tree. On POSIX the child is its own process group, so the negative pid does the same.
 */
export function killChromeTree(pid, { spawnChild = spawn, platform = process.platform } = {}) {
  if (!pid) return;
  const [command, args] = platform === "win32" ? ["taskkill", ["/PID", String(pid), "/T", "/F"]] : ["kill", ["-9", `-${pid}`]];
  const killer = spawnChild(command, args, { stdio: "ignore" });
  killer.on?.("error", () => {}); // best-effort: Chrome may already have quit
  killer.unref?.();
}

/** Whatever happened, quit the browser and make sure the process tree is gone before returning. */
async function shutdownChrome(browser, child) {
  if (browser) await closeBrowserByCdp(browser).catch(() => {});
  killChromeTree(child?.pid);
}

/**
 * The target origin's localStorage, read over the debugging protocol from a tab already on that
 * origin. Discord deletes the page's own `window.localStorage` once its code starts, so the page
 * cannot be asked; the protocol reads the store underneath. `[{ name, value }]`, empty when the
 * target names no items or no tab is on the origin yet.
 */
export async function readOriginStorage(context, target) {
  if (!target?.signIn?.localStorage?.length) return [];
  const origin = new URL(target.startUrl).origin;
  const page = context.pages().find((p) => originOf(p) === origin);
  return page ? domStorageItems(context, page, origin) : [];
}

/**
 * A saved login's page storage: every origin on the site that has a tab open, read the same way.
 * `[{ origin, localStorage: [{ name, value }] }]`, only origins that hold something.
 */
export async function readSiteStorage(context, site) {
  const seen = new Map();
  for (const page of context.pages()) {
    const origin = originOf(page);
    if (!origin || seen.has(origin) || !onSite(new URL(origin).hostname, site)) continue;
    seen.set(origin, await domStorageItems(context, page, origin).catch(() => []));
  }
  return [...seen].filter(([, items]) => items.length).map(([origin, localStorage]) => ({ origin, localStorage }));
}

function originOf(page) {
  try {
    const { origin, protocol } = new URL(page.url());
    return protocol === "https:" || protocol === "http:" ? origin : null;
  } catch {
    return null;
  }
}

async function domStorageItems(context, page, origin) {
  const cdp = await context.newCDPSession(page);
  try {
    // Chrome names a store by storageKey now and by securityOrigin before; an empty answer under one
    // name is not proof the other is empty too, so the first that has anything wins.
    for (const storageId of [
      { storageKey: `${origin}/`, isLocalStorage: true },
      { securityOrigin: origin, isLocalStorage: true },
    ]) {
      const answer = await cdp.send("DOMStorage.getDOMStorageItems", { storageId }).catch(() => null);
      if (answer?.entries?.length) return answer.entries.map(([name, value]) => ({ name, value }));
    }
    return [];
  } finally {
    await cdp.detach().catch(() => {}); // best-effort: the tab may have closed under us
  }
}

function freePort(from = 9400) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", () => (from < 9500 ? resolve(freePort(from + 1)) : reject(new Error("no free port"))));
    server.listen(from, "127.0.0.1", () => {
      server.close(() => resolve(from));
    });
  });
}

async function waitForDebugger(port, deadline) {
  while (Date.now() < deadline) {
    const answer = await fetch(`http://127.0.0.1:${port}/json/version`).catch(() => null);
    if (answer?.ok) return (await answer.json()).webSocketDebuggerUrl;
    await new Promise((r) => setTimeout(r, 500));
  }
  return null;
}

const USAGE = [
  "usage: node sue/login-chrome.mjs --target <id|path.json> --as <name> [--free-hands] [--wait <minutes>]",
  "       node sue/login-chrome.mjs --profile <name> --site <url> [--free-hands] [--wait <minutes>]",
].join("\n");

export function parseArgs(argv) {
  const o = { target: null, as: null, profile: null, site: null, freeHands: false, waitMs: WAIT_MS };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = argv[++i];
    else if (argv[i] === "--as") o.as = argv[++i];
    else if (argv[i] === "--profile") o.profile = argv[++i];
    else if (argv[i] === "--site") o.site = argv[++i];
    else if (argv[i] === "--free-hands") o.freeHands = true;
    else if (argv[i] === "--wait") o.waitMs = Math.max(1, Number(argv[++i]) || 0) * 60_000;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  const saved = Boolean(o.profile || o.site);
  if (saved ? !(o.profile && o.site) || o.target || o.as : !o.target || !o.as) throw new Error(USAGE);
  return o;
}

/**
 * A saved login: his own Chrome on the site, polled every two seconds for the site's cookies and the
 * page storage of its open tabs, and the last look saved once he closes the window (or the wait runs
 * out). No probe: nothing can tell from outside whether an arbitrary site is signed in, so the person
 * who signs in is the proof, and the Logins tab shows what was kept.
 */
async function captureProfile(opts) {
  const name = assertProfileName(opts.profile);
  const site = profileSite(opts.site);
  const chrome = findChrome();
  if (!chrome) throw new Error("no Google Chrome on this machine to sign in with");
  const profileDir = profileChromeDir(name);
  fs.mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  // windowsHide: false on purpose: this is the Chrome a person signs in through, so its window must be seen.
  const child = spawn(chrome, chromeArgs({ profileDir, port, url: site.url }), { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  log(`Chrome is opening ${site.url}; sign in there, then close the window. Waiting up to ${opts.waitMs / 60_000} minutes.`);

  const deadline = Date.now() + opts.waitMs;
  let browser = null;
  let closed = false;
  let last = null;
  try {
    const wsUrl = await waitForDebugger(port, Math.min(deadline, Date.now() + 60_000));
    if (!wsUrl) throw new Error(`Chrome never opened its debugging port ${port}`);
    browser = await chromium.connectOverCDP(wsUrl);
    browser.on("disconnected", () => {
      closed = true;
    });
    // Closing the window may leave Chrome running a moment with no tab; two empty looks in a row is closed.
    let empty = 0;
    while (!closed && Date.now() < deadline) {
      const context = browser.contexts()[0];
      const pages = context?.pages() ?? [];
      empty = pages.length ? 0 : empty + 1;
      if (empty >= 2) break;
      if (context && pages.length) {
        const cookies = keepSiteCookies(await context.cookies().catch(() => []), site);
        const origins = await readSiteStorage(context, site).catch(() => []);
        if (cookies.length || origins.length) last = { cookies, origins };
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!last) {
      log(`nothing to save: ${site.domain} set no cookie and no page storage. Nothing was kept.`);
      return 3;
    }
    if (!closed && Date.now() >= deadline) log(`the window was still open after ${opts.waitMs / 60_000} minutes: saving what it had`);
    const d = saveProfile(name, { site: site.url, ...last, freeHands: opts.freeHands });
    // Counts, hosts and expiry only: a cookie or storage VALUE is a credential and is never printed.
    log(
      `saved login "${name}": ${d.cookies} cookie(s) and ${d.storage} page-storage item(s) for ${d.hosts.join(", ") || site.domain}, lasting until ${d.lastsUntil ?? "the browser closes"}`,
    );
    log(opts.freeHands ? "free hands: Sues on this login may press anything" : "guarded: Sues look and try but never commit");
    return 0;
  } finally {
    await shutdownChrome(closed ? null : browser, child);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.profile) return captureProfile(opts);
  const target = loadTarget(opts.target);
  // A target whose session is made of PARTS (`sessionParts`) is never signed in to as a whole: every
  // run reads each part's own session folder, so a session saved here would be written and never read.
  if (Array.isArray(target.sessionParts) && target.sessionParts.length) {
    throw new Error(
      `target "${target.id}" borrows its session in parts (${target.sessionParts.map((p) => p.id).join(", ")}); sign in to each part's own target file instead: ${target.sessionParts.map((p) => p.target).join(", ")}`,
    );
  }
  // A site whose sign-up mail the mailroom reads never gets a saved session: every Sue there makes her own account.
  if (mustSignUpForReal(target)) {
    throw new Error(`target "${target.id}": Sues make their own account here through the real sign-up, so no session is saved for them`);
  }
  const file = sessionFile(target.id, opts.as);
  const chrome = findChrome();
  if (!chrome) throw new Error("no Google Chrome on this machine; use login.mjs instead");

  const profileDir = chromeProfileDir(target.id, opts.as);
  fs.mkdirSync(path.dirname(profileDir), { recursive: true });
  const port = await freePort();
  const url = target.signIn?.url || target.startUrl;
  const child = spawn(chrome, chromeArgs({ profileDir, port, url }), { detached: true, stdio: "ignore", windowsHide: false });
  child.unref();
  log(`Chrome is opening ${url}; sign in there. Waiting up to ${opts.waitMs / 60_000} minutes.`);

  const deadline = Date.now() + opts.waitMs;
  let browser = null;
  try {
    const wsUrl = await waitForDebugger(port, Math.min(deadline, Date.now() + 60_000));
    if (!wsUrl) throw new Error(`Chrome never opened its debugging port ${port}`);
    browser = await chromium.connectOverCDP(wsUrl);

    while (Date.now() < deadline) {
      const context = browser.contexts()[0];
      const all = context ? await context.cookies().catch(() => []) : [];
      const kept = keepTargetCookies(all, target);
      const origins = context ? keepTargetStorage(await readOriginStorage(context, target).catch(() => []), target) : [];
      if (kept.length || origins.length) {
        const probe = await probeSession(target, { cookies: kept, origins });
        if (probe.ok) {
          writeSession(file, kept, { freeHands: opts.freeHands, origins });
          const d = describeSession({ cookies: kept, origins });
          // Names, hosts and expiry only: a cookie or storage VALUE is a credential and is never printed.
          const storage = d.storage.length ? ` and page storage (${d.storage.join(", ")})` : "";
          log(
            `saved ${d.cookies} cookie(s) (${d.names.join(", ")})${storage} for ${d.hosts.join(", ")}, good until ${d.expiresAt ?? "the browser closes"} -> ${file}`,
          );
          if (probe.account) log(`signed in as ${probe.account}`);
          log(opts.freeHands ? "free hands: Sues on this account may press anything" : "guarded: Sues look and try but never commit");
          return 0;
        }
      }
      await new Promise((r) => setTimeout(r, 2_000));
    }
    log("gave up waiting: nobody signed in, nothing saved");
    return 3;
  } finally {
    await shutdownChrome(browser, child);
  }
}

// pathToFileURL, never a hand-built "file://" string: on Windows that spelling has three slashes
// and a drive letter, so a hand-built one never matches and the script would do nothing.
if (isMainModule(import.meta.main, import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(err?.message ?? String(err));
      process.exit(1);
    },
  );
}
