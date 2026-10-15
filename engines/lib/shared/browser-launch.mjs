// vendored from Connections packages/connections-arkitect/agnostic/engines/render/browser-launch.mjs @ dd3d47a7ad
/**
 * Browser launch - the ONE resolver for "give me a real Chrome to drive"
 * =======================================================================
 * Promoted on its EIGHTH occurrence (reuse-first, late): the same
 * `CHROMIUM_PATH ?? [ …four Windows install paths… ].find(existsSync)` ladder was
 * copy-pasted into seven runners plus `mobile-audit-engine`, each with a slightly
 * different candidate ORDER and a different fallback - so a machine where only Edge
 * exists, or where the playwright chromium build number moves, fixes one runner and
 * silently leaves the others un-launchable. Classic dock-per-port drift: the
 * improvement lands in one place and the rest never receive it.
 *
 * The candidate order matters and is deliberate:
 *   1. `CHROMIUM_PATH` - an explicit operator/CI override always wins.
 *   2. the ms-playwright chromium builds - CI installs these, and they are the
 *      version this repo's puppeteer-core protocol expectations were written against.
 *      Discovered by GLOB, not by a pinned build number: `chromium-1223` was hardcoded
 *      in every copy and rots on the next playwright bump.
 *   3. system Chrome, then Edge - the developer-workstation path.
 *
 * Node builtins + puppeteer-core only.
 */
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

import { readdirSync as scanReaddirSync } from "./scan-directory.mjs";

const isWindows = process.platform === "win32";

/** Every ms-playwright `chromium-*` build on this machine, newest build number first. */
function playwrightChromiumCandidates() {
  const roots = isWindows
    ? [path.join(process.env.LOCALAPPDATA || "", "ms-playwright")]
    : [
        path.join(process.env.HOME || "", ".cache", "ms-playwright"),
        path.join(process.env.HOME || "", "Library", "Caches", "ms-playwright"),
      ];
  const found = [];
  for (const root of roots) {
    if (!root || !existsSync(root)) continue;
    let entries;
    try {
      entries = scanReaddirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const builds = entries
      .filter((e) => e.isDirectory() && /^chromium(_headless_shell)?-\d+$/.test(e.name))
      .sort((a, b) => Number.parseInt(b.name.split("-").at(-1), 10) - Number.parseInt(a.name.split("-").at(-1), 10));
    for (const build of builds) {
      found.push(
        path.join(root, build.name, "chrome-win64", "chrome.exe"),
        path.join(root, build.name, "chrome-linux", "chrome"),
        path.join(root, build.name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
      );
    }
  }
  return found;
}

const SYSTEM_CANDIDATES = isWindows
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
  : [
      "/usr/bin/google-chrome",
      "/usr/bin/chromium-browser",
      "/usr/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ];

/**
 * Absolute path to a drivable Chrome/Chromium, or `null` when none is installed.
 * `null` is a legitimate answer, not an error: a capture runner should report
 * "no browser on this machine" as no-data rather than crash the audit.
 */
export function resolveChromiumPath() {
  const candidates = [process.env.CHROMIUM_PATH, ...playwrightChromiumCandidates(), ...SYSTEM_CANDIDATES];
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null;
}

/**
 * Launch options for puppeteer-core with the resolved browser filled in.
 * `headless: true` (LEGACY headless) is the default on purpose - the "new" headless
 * renderer WEDGES on this repo's heavy authenticated workspace DOM (documented in
 * docs/how-to/DEV_LOGIN.md § Headless visual checking); legacy renders it fine and
 * every public/plane surface renders under either.
 */
export function chromiumLaunchOptions(overrides = {}) {
  const executablePath = resolveChromiumPath();
  return {
    headless: true,
    args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"],
    timeout: 45_000,
    ...(executablePath ? { executablePath } : {}),
    ...overrides,
  };
}
