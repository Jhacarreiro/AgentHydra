/**
 * process-priority - the shared Sue browser runs below normal priority on Windows, so a shared
 * browser never slows the person's own work.
 *
 * Called by browser-host.mjs at the start of its own `serve`, before Chrome launches: Windows gives a
 * child the priority class of its creator, so Chrome and its renderers inherit BELOW_NORMAL. A host
 * only ever lowers itself, so no process SUE did not start is touched. Elsewhere it is a no-op.
 */
import os from "node:os";

/** Returns true when the process was lowered; false on any platform where priority is left alone. */
export function lowerOwnPriority({ platform = process.platform, setPriority = os.setPriority } = {}) {
  if (platform !== "win32") return false;
  setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
  return true;
}
