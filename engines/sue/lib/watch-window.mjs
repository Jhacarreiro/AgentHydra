/**
 * watch-window - Sue's window on this computer, which a person opens with `sue watch`.
 * =============================================================================================
 *
 * Owner (Owner, 2026-09-22): "Sue shouldn't ever really be a page a human goes to ... a Chrome
 * wrapper that we ship that you could start on your PC so the user could see the sessions." Since
 * 2026-10-09 (the owner): a wave an AI starts runs headless. It starts no Manager for its window, no
 * toolbar icon and no window. A person looks with `sue watch`, which opens the window (or finds the one
 * already open) and points it at the latest wave. The Manager page's own waves are watched on that page.
 *
 * The wrapper is the person's OWN Chrome (or Edge) as an app window (`--app=`: its own window, no
 * tabs, no address bar) on the Manager page, so there is no second browser to ship, sign and patch.
 * Once the person installs Sue (her page offers it), the window opens as that installed app instead,
 * which is the only kind of window Chrome lets draw its own title bar (Owner, 2026-09-23: "is there a
 * reason that this app has to have a standard Chrome header?").
 * Each Sue still runs in her own throwaway browser that the cannon starts and deletes; this window
 * only watches them.
 *
 * SOURCE ONLY (the Chair, 2026-09-25: "We use the source code only ever"): nothing here launches a compiled
 * Sue app. The Manager below is always sue/manager.mjs from this checkout, on this node.
 *
 * A FILE OR AN IDEA needs the Manager to serve it (lib/material.mjs), so a run that shows one starts
 * the Manager with no toolbar icon and no window (`startHeadlessManager`). The window is never opened by
 * a run, and Sue's toolbar icon is only the Manager's own (lib/tray.mjs), shown when a person starts it.
 *
 * Small files in the Sue state folder carry what the page cannot know on its own:
 *   page-seen.json  when a Manager page last asked anything, so a second wave does not open a
 *                   second window while one is already watching
 *   focus.json      the workspace and run the latest wave started, so the page jumps to it
 *   manager.json    the running Manager's process, version and whether its toolbar icon is up
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { checkoutRoot } from "./engine-lease.mjs";
import { stateRoot } from "./run-dir.mjs";
import { workspaceId } from "./workspaces.mjs";

export const MANAGER_PORT = 47470;
/** Sue's own address - her own window, not a page inside Studio (Owner, 2026-09-22). */
export const MANAGER_PAGE = "https://app.example.com";
/**
 * A page that asked the Manager anything this recently is on screen: no second window. Minutes, not
 * seconds: a minimized window still says it is here, but Chrome wakes a hidden page about once a
 * minute at most, so a shorter window read a minimized Sue as closed and opened another one.
 */
export const PAGE_WATCHING_MS = 3 * 60_000;
/**
 * ⛔ ONE WINDOW, and this lock is what makes that true rather than intended (2026-09-22: the owner closed
 * about thirty windows in one go). The page-seen check alone is not enough - a window that opened but
 * has not connected yet, a Manager too old to note a page, a blocked local-network prompt, or ten
 * sessions starting waves in the same minute all read as "nobody is watching", and then every wave
 * opens another window. A window that was opened this recently counts as the window.
 */
export const WINDOW_OPENED_MS = 10 * 60_000;
/** How long a wave's jump stays good; a window opened later lands wherever the page would anyway. */
export const FOCUS_TTL_MS = 10 * 60_000;

const RUN_ID = /^\d{8}-\d{6}-[0-9a-f]{4}$/;
const WORKSPACE_ID = /^[0-9a-f]{12}$/;

const windowDir = () => path.join(stateRoot(), "manager");
const seenFile = () => path.join(windowDir(), "page-seen.json");
const focusFile = () => path.join(windowDir(), "focus.json");
const openedFile = () => path.join(windowDir(), "window-opened.json");
const managerFile = () => path.join(windowDir(), "manager.json");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

export function notePageSeen(now = Date.now()) {
  writeJson(seenFile(), { at: now });
}

/** The window closed: nothing is watching, and no window is still opening. */
export function notePageGone() {
  for (const file of [seenFile(), openedFile()]) fs.rmSync(file, { force: true });
}

export function pageWatching(now = Date.now()) {
  const at = readJson(seenFile())?.at;
  return typeof at === "number" && now - at < PAGE_WATCHING_MS;
}

/** True when a window was opened recently enough to still be the one on screen. */
export function windowOpen(now = Date.now()) {
  const at = readJson(openedFile())?.at;
  return typeof at === "number" && now - at < WINDOW_OPENED_MS;
}

export function noteWindowOpened(now = Date.now()) {
  writeJson(openedFile(), { at: now });
}

/**
 * Claim window-opened.json, the 'one window' lock, with no await anywhere in the call: the file
 * itself is the lock, so two `sue run` calls racing in the gap before a window opens cannot both
 * read "no window" and both open one. `fs.openSync(..., 'wx')` makes the claim atomic, and a claim
 * whose file is older than WINDOW_OPENED_MS is a window long gone and is taken over. Freshness reads
 * the file's mtime, not its contents, so a claimer that has created the file but not yet written it
 * still counts as holding the lock. True when THIS caller claimed it, false when a live window
 * already does - the answer `windowOpen()` used to give, decided in one step.
 */
export function claimWindowOpened() {
  const file = openedFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (;;) {
    try {
      const fd = fs.openSync(file, "wx");
      try {
        fs.writeSync(fd, JSON.stringify({ at: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return true;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
      try {
        if (Date.now() - fs.statSync(file).mtimeMs < WINDOW_OPENED_MS) return false;
        fs.rmSync(file, { force: true });
      } catch {
        /* released between the stat and the remove: try again */
      }
    }
  }
}

/** The running Manager says who it is: its process, port, version and whether its toolbar icon is up. */
export function noteManagerUp({ port, version, tray }, pid = process.pid) {
  writeJson(managerFile(), { pid, port, version, tray: Boolean(tray) });
}

/**
 * Her toolbar icon ended: say so in this Manager's own record only. After a hand-over the old Manager's
 * icon ends as it quits, when the record already names its successor, which keeps its own.
 */
export function noteTrayGone(pid = process.pid) {
  const record = readJson(managerFile());
  if (record?.pid === pid) writeJson(managerFile(), { ...record, tray: false });
}

/** The Manager is ending: forget it, unless another one has since taken its place. */
export function noteManagerDown(pid = process.pid) {
  if (readJson(managerFile())?.pid === pid) fs.rmSync(managerFile(), { force: true });
}

/** `picked`: the person chose this run from the toolbar menu, so an open window turns to it (a wave
 *  an AI starts never moves a window already open). */
export function noteFocus({ folder, runId, picked = false }, now = Date.now()) {
  writeJson(focusFile(), { workspaceId: workspaceId(folder), runId, at: now, ...(picked ? { picked: true } : {}) });
}

/** The latest wave's `{ workspaceId, runId, at }` while it is fresh, else null. */
export function readFocus(now = Date.now()) {
  const f = readJson(focusFile());
  if (!f || typeof f.at !== "number" || now - f.at > FOCUS_TTL_MS) return null;
  if (!WORKSPACE_ID.test(String(f.workspaceId)) || !RUN_ID.test(String(f.runId))) return null;
  return { workspaceId: f.workspaceId, runId: f.runId, at: new Date(f.at).toISOString(), ...(f.picked === true ? { picked: true } : {}) };
}

/** The person's own Chrome, else Edge (on every Windows PC, the same engine), on this OS. */
export function findOwnBrowser(env = process.env, exists = fs.existsSync) {
  const win = [
    path.join(env.PROGRAMFILES ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe") : null,
    path.join(env["PROGRAMFILES(X86)"] ?? "C:/Program Files (x86)", "Microsoft/Edge/Application/msedge.exe"),
    path.join(env.PROGRAMFILES ?? "C:/Program Files", "Microsoft/Edge/Application/msedge.exe"),
  ];
  const mac = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  const linux = ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/microsoft-edge", "/usr/bin/chromium"];
  const candidates = process.platform === "win32" ? win : process.platform === "darwin" ? mac : linux;
  return candidates.find((p) => p && exists(p)) ?? null;
}

/** Chromium's id alphabet: the first 16 bytes of a SHA-256, in hex, spelled with the letters a-p. */
export function chromiumIdFor(bytes) {
  const hex = crypto.createHash("sha256").update(bytes).digest().subarray(0, 16).toString("hex");
  return [...hex].map((digit) => String.fromCharCode(97 + Number.parseInt(digit, 16))).join("");
}

/**
 * Sue's id as an installed app, computed the way Chromium does from her manifest id (the origin's
 * "/", the `id` in manifest-sue.webmanifest): the id's own SHA-256, spelled in the id alphabet.
 */
export function installedAppId(page = MANAGER_PAGE) {
  return chromiumIdFor(crypto.createHash("sha256").update(new URL("/", page).href).digest());
}

/** Where the browser at `browser` keeps its profiles on Windows, or null without LOCALAPPDATA. */
function browserUserData(browser, env) {
  if (!env.LOCALAPPDATA) return null;
  return /microsoft[\\/]edge/i.test(browser)
    ? path.join(env.LOCALAPPDATA, "Microsoft", "Edge", "User Data")
    : path.join(env.LOCALAPPDATA, "Google", "Chrome", "User Data");
}

/**
 * The browser profile Sue is installed in, as `{ profile, appId }`, or null when she is not. Chrome
 * and Edge keep an installed app's icons under `<profile>/Web Applications/Manifest Resources/<app
 * id>`, so that folder is the install. The default profile is asked first.
 */
export function findInstalledApp(browser, page = MANAGER_PAGE, env = process.env, fsApi = fs) {
  const userData = browserUserData(browser, env);
  if (!userData || !fsApi.existsSync(userData)) return null;
  const appId = installedAppId(page);
  const profiles = fsApi
    .readdirSync(userData)
    .filter((name) => name === "Default" || /^Profile \d+$/.test(name))
    .sort((a, b) => (a === "Default" ? -1 : b === "Default" ? 1 : Number(a.slice(8)) - Number(b.slice(8))));
  const profile = profiles.find((name) => fsApi.existsSync(path.join(userData, name, "Web Applications", "Manifest Resources", appId)));
  return profile ? { profile, appId } : null;
}

/**
 * The page in the person's own browser: as the installed Sue app when she is installed (her own
 * title bar, once the person turns it on in the bar), else as an app window. False when there is no
 * Chromium browser. `browser`, `installed` and `run` are injectable so a spec never opens a window.
 */
export function openWindow(
  page = MANAGER_PAGE,
  { browser = findOwnBrowser(), installed = findInstalledApp, run = spawn } = {},
) {
  if (!browser) return false;
  const app = installed(browser, page);
  const args = app ? [`--profile-directory=${app.profile}`, `--app-id=${app.appId}`] : [`--app=${page}`];
  run(browser, args, { detached: true, stdio: "ignore" }).unref();
  return true;
}

export function managerListening(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: "127.0.0.1", port });
    const done = (answer) => {
      socket.destroy();
      resolve(answer);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/**
 * Start the local Manager, hidden, logging to the state folder. `open: false` starts it with no window and
 * `tray: false` with no toolbar icon. Always the checkout's manager.mjs, also when a snapshot of this code
 * asks (lib/engine-store.mjs): the Manager moves itself onto the checkout's new code (lib/manager-refresh.mjs),
 * a snapshot never does.
 */
export function startManager({ port = MANAGER_PORT, page = MANAGER_PAGE, open = true, tray = true } = {}) {
  fs.mkdirSync(windowDir(), { recursive: true });
  const log = fs.openSync(path.join(windowDir(), "manager.log"), "a");
  const args = [path.join(checkoutRoot(), "sue", "manager.mjs"), "--port", String(port), "--page", page];
  if (!open) args.push("--no-open");
  if (!tray) args.push("--no-tray");
  spawn(process.execPath, args, { detached: true, windowsHide: true, stdio: ["ignore", log, log] }).unref();
}

/**
 * A run that shows a file or an idea needs the Manager to serve it (lib/material.mjs). It starts the Manager
 * with no window and no toolbar icon, and waits until it listens: true when it does, false when it did not
 * come up within `waitMs`. `start` is injectable so a spec never starts a real one.
 */
export async function startHeadlessManager({ port = MANAGER_PORT, page = MANAGER_PAGE, start = startManager, waitMs = 5_000 } = {}) {
  start({ port, page, open: false, tray: false });
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if (await managerListening(port, 250)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

/**
 * `sue watch`: open Sue's window, or find the one already open, pointed at the latest wave. A Manager that
 * is not running starts with its window. Returns what it did, for the command's answer. `start` is
 * injectable so a spec never starts a real one.
 */
export async function showWatcher({ port = MANAGER_PORT, page = MANAGER_PAGE, start = startManager } = {}) {
  if (pageWatching()) return "watching";
  // The lock, claimed before any await: a live window is the window, connected or not, and a racing
  // `sue watch` that loses the claim opens nothing.
  if (!claimWindowOpened()) return "window-open";
  if (await managerListening(port)) {
    return openWindow(page) ? "opened" : "no-browser";
  }
  start({ port, page, open: true });
  return "started";
}
