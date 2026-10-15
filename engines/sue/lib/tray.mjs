/**
 * tray - Sue's icon in the Windows toolbar (the notification area), for as long as her Manager runs.
 * ==================================================================================================
 *
 * Owner ask (Owner, 2026-09-23): "Whenever an AI starts it, it shouldn't open it up. It should be
 * able to stay collapsed to the toolbar. Additionally, if I close Sue, it should say shrunk to the
 * toolbar and it should default trigger to the toolbar." So a wave an AI starts no longer puts a
 * window on the screen by default: the icon appears, and a click on it opens the window. Closing
 * the window leaves Sue here and the icon says so (manager.mjs decides when; lib/settings.mjs says
 * whether the person wants that).
 *
 * The icon is lib/tray.ps1, a small PowerShell NotifyIcon, because Windows ships everything it
 * needs: no native module to build, sign or patch. The Manager is its parent and talks to it over
 * its pipes, one JSON line per message; when the Manager exits its pipe closes and the icon goes
 * with it. Windows only: elsewhere `trayAvailable()` is false and a wave opens the window as before.
 */
import { loadTarget, targetPath } from "../../lib/target.mjs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "tray.ps1");
/** Sue's own favicon from the page she is shown on (the same checkout: sue runs from it). */
export const TRAY_ICON = targetPath(loadTarget().favicon);
/** The Manager page's document title: what the icon looks for to bring her window back. */
export const SUE_WINDOW_TITLE = "Sue";

/** Whether this computer has a toolbar for Sue to shrink to. */
export function trayAvailable(platform = process.platform) {
  return platform === "win32";
}

/**
 * Start the icon. `onOpen(runId)` runs when the person asks for the window and none is on screen (the
 * icon brings back one that is), with the run id when they chose a running wave's row in the menu
 * (null for Open Sue); `onShow(runId)` when they chose a wave's row and the icon raised her window,
 * which should turn to that run; `onQuit` when they choose Quit Sue; `onGone` if the icon's process
 * ends on its own (the Manager keeps serving the page either way). `spawnImpl` lets a spec stand in
 * a fake process.
 */
export function startTray({
  onOpen,
  onShow,
  onQuit,
  onGone = () => {},
  spawnImpl = spawn,
  icon = TRAY_ICON,
  windowTitle = SUE_WINDOW_TITLE,
} = {}) {
  const child = spawnImpl(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-STA",
      "-WindowStyle",
      "Hidden",
      "-File",
      SCRIPT,
      "-Icon",
      icon,
      "-WindowTitle",
      windowTitle,
    ],
    { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
  );
  let alive = true;
  let buffered = "";
  let resolveReady;
  const ready = new Promise((resolve) => (resolveReady = resolve));
  child.stdout.setEncoding?.("utf8");
  child.stdout.on("data", (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop() ?? "";
    for (const line of lines) {
      const word = line.trim();
      if (word === "ready") resolveReady(true);
      else if (word === "open") onOpen?.(null);
      // A running wave's row in the menu: open Sue at that run, or turn her raised window to it.
      else if (/^open \d{8}-\d{6}-[0-9a-f]{4}$/.test(word)) onOpen?.(word.slice(5));
      else if (/^show \d{8}-\d{6}-[0-9a-f]{4}$/.test(word)) onShow?.(word.slice(5));
      else if (word === "quit") onQuit?.();
    }
  });
  // A note it could not show is not worth stopping the Manager over; the log keeps it.
  child.stderr.on("data", (chunk) => console.error(`tray: ${String(chunk).trim()}`));
  child.on("error", (err) => console.error(`tray: ${err?.message ?? err}`));
  child.on("exit", (code) => {
    alive = false;
    resolveReady(false);
    onGone(code);
  });
  const send = (message) => {
    if (!alive || child.stdin.destroyed) return;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  return {
    ready,
    get alive() {
      return alive;
    },
    /** A note beside the icon. */
    say(title, text) {
      send({ say: { title, text } });
    },
    /** The icon's hover text. */
    tip(text) {
      send({ tip: text });
    },
    /**
     * The waves running now, listed in the icon's menu, newest first: `[{ runId, host, done, total }]`,
     * empty when idle; `more` counts the waves running beyond the list, shown as one row.
     */
    runs(list, more = 0) {
      send({ runs: list, more });
    },
    /** Remove the icon: its input ends, it clears itself and exits. */
    close() {
      if (!child.stdin.destroyed) child.stdin.end();
    },
  };
}
