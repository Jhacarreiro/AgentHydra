#!/usr/bin/env node
/**
 * login - a human signs in once; every Sue after that arrives signed in as him.
 * ==============================================================================
 *
 * WHAT: `node sue/login.mjs --target <id|path/to/target.json> --as <name>` opens a normal,
 * VISIBLE browser window at the target's `signIn.url`, waits (up to 15 minutes) until the target's
 * `signIn.probe` answers 200 from inside that window, then saves ONLY the target host's cookies to
 * `state/sessions/<targetId>/<name>.json` and closes. The cannon's `--as <name>` hands that session
 * to every Sue in the run. The window keeps its own profile (`<name>.profile/` beside the file), so
 * the identity provider remembers him and the next capture is usually one click.
 *
 * `--free-hands`: the account is a throwaway made for Sues, so they may press anything on it
 * (post, save, create, delete). Saved with the session; see `writeSession` and `lib/rails.mjs`.
 * Without it every Sue on the account looks and tries but never commits.
 *
 * WHY IT EXISTS: see `lib/sessions.mjs` - Example App Next signs in only through Discord, a Sue can
 * never make a Discord account, and the owner offered his own sign-in (2026-09-21). The human types his
 * own password into the identity provider's own page; this script never sees it, never prints a
 * cookie value, and keeps nothing but the product's session.
 *
 * Plain node v22, never bun (bun hangs Playwright's chromium launch on this box).
 */
import process from "node:process";

import { chromium } from "playwright-core";

import { resolveChromiumPath } from "../lib/shared/browser-launch.mjs";
import { loadTarget } from "./lib/personas.mjs";
import {
  describeSession,
  keepTargetCookies,
  loginProfileDir,
  mustSignUpForReal,
  probeSaysSignedIn,
  sessionFile,
  sessionHosts,
  writeSession,
} from "./lib/sessions.mjs";
import { isMainModule } from "../lib/shared/is-main-module.mjs";

const WAIT_MS = 15 * 60_000;
const log = (msg) => process.stderr.write(`[sue-login] ${msg}\n`);

function parseArgs(argv) {
  const o = { target: null, as: null, freeHands: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--target") o.target = argv[++i];
    else if (argv[i] === "--as") o.as = argv[++i];
    else if (argv[i] === "--free-hands") o.freeHands = true;
    else throw new Error(`unknown flag ${argv[i]}`);
  }
  if (!o.target || !o.as) throw new Error("usage: node sue/login.mjs --target <id|path.json> --as <name> [--free-hands]");
  return o;
}

async function signedIn(page, target) {
  const host = sessionHosts(target)[0];
  let here;
  try {
    here = new URL(page.url()).hostname;
  } catch {
    return false;
  }
  if (here !== host) return false;
  const probe = target.signIn?.probe;
  if (!probe) return true;
  const answer = await page
    .evaluate((p) => fetch(p, { credentials: "include" }).then(async (r) => ({ status: r.status, body: await r.text() })), probe)
    .catch(() => null);
  return Boolean(answer) && probeSaysSignedIn(target, answer.status, answer.body);
}

export async function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
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
  const executablePath = resolveChromiumPath();
  if (!executablePath) throw new Error("no Chromium on this machine");
  const context = await chromium.launchPersistentContext(loginProfileDir(target.id, opts.as), {
    headless: false,
    executablePath,
    viewport: null,
    args: ["--window-size=1100,900", "--mute-audio"],
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(target.signIn?.url || target.startUrl, { waitUntil: "load", timeout: 60_000 }).catch(() => {}); // best-effort: a slow first load still leaves the window open for him to sign in by hand
    log(`sign in to ${target.id} in the window that just opened; waiting up to ${WAIT_MS / 60_000} minutes`);
    const deadline = Date.now() + WAIT_MS;
    let ok = false;
    while (Date.now() < deadline) {
      for (const p of context.pages()) {
        if (await signedIn(p, target)) ok = true;
      }
      if (ok) break;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    if (!ok) {
      log("gave up waiting: nobody signed in, nothing saved");
      return 3;
    }
    const kept = keepTargetCookies(await context.cookies(), target);
    if (!kept.length) {
      log(`signed in, but ${sessionHosts(target)[0]} set no cookie of its own; nothing saved`);
      return 4;
    }
    writeSession(file, kept, { freeHands: opts.freeHands });
    const d = describeSession({ cookies: kept });
    // Names, hosts and expiry only: a cookie VALUE is a credential and is never printed.
    log(
      `saved ${d.cookies} cookie(s) (${d.names.join(", ")}) for ${d.hosts.join(", ")}, good until ${d.expiresAt ?? "the browser closes"} -> ${file}`,
    );
    log(
      opts.freeHands
        ? "free hands: Sues on this account may press anything"
        : "guarded: Sues on this account look and try but never commit",
    );
    return 0;
  } finally {
    await context.close().catch(() => {}); // best-effort: the window may already be closed by hand
  }
}

// Only when it IS the script being run: importing this module (a spec reading `main`) must never
// open a browser window. pathToFileURL, never a hand-built "file://" string - see login-chrome.mjs.
if (isMainModule(import.meta.main, import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      log(err?.message ?? String(err));
      process.exit(1);
    },
  );
}
