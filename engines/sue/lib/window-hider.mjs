/**
 * window-hider - keeps a headed wave's Chrome windows out of the Windows taskbar and Alt+Tab.
 * ============================================================================================
 *
 * Why: a headed wave (Cloudflare refuses headless Chrome on `*.example.com`) parks every window at
 * -32000,-32000 (lib/findings.mjs `browserArgsFor`). Parked is off the screen, not out of the shell:
 * each window is still an ordinary app window with a taskbar button named after the site's page, and
 * a click on it shows nothing, so it looks like a stray to close. On 2026-09-23 they were closed
 * from there, under Sues who were using them:
 *   - 13:02:48.6-13:02:50.1 UTC, 14 pages in 6 separate waves' browsers inside 1.5 s (0e06, 5aa3,
 *     0950, 9530, f678, 4286), while a Sue whose window opened at 13:03:36 (34d9 elaine) was untouched;
 *   - 19:56 and 19:58 UTC, Tavern Bag ca73 and PinkyRest 0e2a at the same seconds, twice, while the
 *     headless Nexas Code wave eee2 (nine Sues, no windows at all) ran on untouched; the same again at
 *     16:37 (a1ee lost, headless 82d2 untouched), 20:53 and 21:01-21:03 (a5f6), 23:53:44 (486b).
 * Each time the browser itself lived: the body's reopen onto the same wave server worked. Sending a
 * parked window the taskbar's close (WM_SYSCOMMAND SC_CLOSE) gives exactly that: Playwright says
 * "Target page, context or browser has been closed", the context and browser stay up, and a fresh
 * context works. No script on this machine closes windows (searched ~/.claude and this repo), and no
 * process was killed (no exit, no crash report, no reaper entry at those seconds).
 *
 * What: lib/window-hider.ps1, one small PowerShell per process while a headed Sue is out, marks every
 * top-level Chrome window in that process's tree as a tool window and deletes its taskbar button, once
 * a second. The cannon's `runSue` holds it (createWindowHiderHold), so a wave and the reaper's janitor
 * (reap.mjs calls runSue itself) are both covered. The window stays shown (off-screen), so the page
 * stays `visible` to the site. Windows only; a headless wave has no windows and gets none.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "window-hider.ps1");

/** Whether a run in browser `mode` (lib/findings.mjs `browserModeFor`) has windows the shell could close. */
export function wantsWindowHider(mode, platform = process.platform) {
  return platform === "win32" && mode !== "headless";
}

/** The helper's command line: hidden, no profile, over `rootPid`'s process tree. */
export function hiderCommand({ rootPid, script = SCRIPT }) {
  return [
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden", "-File", script, "-RootPid", String(rootPid)],
  ];
}

/**
 * Starts the helper over `rootPid` (the process running Sues, the cannon or the reaper: every body
 * and browser under it is covered, a wave's shared one and any a body opens itself). `onHidden(line)`
 * hears each window it hid and `onError(line)` anything the helper complains about, so a broken
 * helper is said, not silent. Returns `{ stop }`, or null off Windows. The helper also ends by itself
 * when `rootPid` exits, and as that process's child it goes with it either way.
 */
export function startWindowHider({
  rootPid,
  platform = process.platform,
  spawnImpl = spawn,
  onHidden = () => {},
  onError = () => {},
  script = SCRIPT,
} = {}) {
  if (platform !== "win32") return null;
  const [command, args] = hiderCommand({ rootPid, script });
  const child = spawnImpl(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.on?.("error", (err) => onError(`the window hider did not start: ${err?.message ?? err}`)); // the wave runs as it did before
  const lines = (stream, hear) => {
    if (!stream) return;
    readline.createInterface({ input: stream }).on("line", (line) => {
      const said = line.trim();
      if (said) hear(said);
    });
  };
  lines(child.stdout, onHidden);
  lines(child.stderr, onError);
  return {
    stop() {
      if (child.exitCode === null) child.kill();
    },
  };
}

/**
 * One helper per process, shared by every Sue in it. `hold(mode)` is called as a Sue sets out with
 * her browser mode (lib/findings.mjs `browserModeFor`): the first Sue whose browser draws windows
 * starts the helper over `rootPid`'s tree, and the release it hands back stops it after the last
 * one is done. Every parked window SUE opens belongs to a Sue who is out (the wave's shared browser
 * draws a window only for a Sue's own context, and a body that opens its own browser is a Sue), so
 * whoever runs Sues is covered by holding it where a Sue runs. A headless Sue, or a machine that is
 * not Windows, holds nothing. Releasing twice is one release.
 */
export function createWindowHiderHold({ start = startWindowHider, platform = process.platform, rootPid = process.pid, onError } = {}) {
  let holders = 0;
  let hider = null;
  return function hold(mode) {
    if (!wantsWindowHider(mode, platform)) return () => {};
    holders += 1;
    if (holders === 1) hider = start({ rootPid, platform, onError });
    let released = false;
    return () => {
      if (released) return;
      released = true;
      holders -= 1;
      if (holders > 0) return;
      hider?.stop();
      hider = null;
    };
  };
}
