// vendored from Connections packages/connections-arkitect/src/core/process-tree.mjs @ dd3d47a7ad
import { spawnSync } from "node:child_process";

/**
 * `taskkill` exit 128 is Windows' "the process ... not found" - the direct analogue of POSIX
 * ESRCH. Deliberately NOT a catch-all for non-zero: exit 1 is access-denied / a genuine refusal
 * and must still throw, or a cleanup that really failed would be silently swallowed.
 */
const TASKKILL_NOT_FOUND = 128;
const isNotFoundStatus = (status) => status === TASKKILL_NOT_FOUND;
// `spawnSync` with no `timeout` blocks the calling thread FOREVER if the `taskkill` process itself
// wedges (observed in the wild on overloaded Windows CI hosts). This function is the last resort
// invoked when a timed-out or aborted subprocess needs its whole tree killed - a hang here is not a
// slow cleanup, it is the entire caller (in self-update's case, the syntax-check timeout path) frozen
// with no further timeout above it to rescue it.
const TASKKILL_TIMEOUT_MS = 10_000;

/** Platform-specific process-tree termination with injectable seams for tests. */
export function createProcessTreeKiller({ platform = process.platform, spawnSyncImpl = spawnSync, killImpl = process.kill } = {}) {
  return function killProcessTree(pid) {
    if (!Number.isInteger(pid) || pid <= 0) throw new TypeError("process-tree cleanup requires a positive integer pid");
    if (platform === "win32") {
      const result = spawnSyncImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      if (result?.error) throw new Error(`taskkill failed for process tree ${pid}: ${result.error.message}`, { cause: result.error });
      // A timeout kills the child with `killSignal` (default SIGTERM) and reports it here rather than
      // via `.error` - checked before the not-found/exit-code branches below, which a timed-out call
      // never legitimately reaches (`.status` is null, not 0 and not 128).
      if (result?.signal) {
        throw new Error(`taskkill timed out for process tree ${pid} after ${TASKKILL_TIMEOUT_MS}ms (terminated with ${result.signal})`);
      }
      // ★ ALREADY GONE IS NOT A FAILURE - and this asymmetry was disarming checks (2026-07-26).
      // The POSIX branch below already returns false when both kills report ESRCH: there was
      // nothing left to terminate, which is the SUCCESSFUL end state of a cleanup, not an error.
      // Windows had no such branch, so `taskkill` exit 128 ("the process ... not found") - the
      // ordinary outcome when a timed-out child has already exited on its own, and a guaranteed
      // race whenever a subprocess dies between the timeout firing and the kill landing - was
      // raised as PROCESS_CLEANUP_FAILED. runProcessSync turns that into a thrown error, the
      // runner records a throwing check as CRASHED, and a crashed check reports NOTHING. Under
      // the suite's 8 parallel workers on Windows that lost exactly one check per full run, a
      // DIFFERENT one each time (observed: sms-channel-twilio-only, then a clean rerun) - which
      // reads as flake and is actually permanent, rotating loss of coverage.
      if (isNotFoundStatus(result?.status)) return false;
      if (result?.status !== 0) throw new Error(`taskkill exited ${result?.status ?? "without status"} for process tree ${pid}`);
      return true;
    }
    try {
      killImpl(-pid, "SIGKILL");
      return true;
    } catch (groupError) {
      try {
        killImpl(pid, "SIGKILL");
        return true;
      } catch (processError) {
        if (groupError?.code === "ESRCH" && processError?.code === "ESRCH") return false;
        throw new AggregateError([groupError, processError], `failed to terminate process tree ${pid}`, { cause: processError });
      }
    }
  };
}

const killTree = createProcessTreeKiller();
export const killProcessTree = (pid) => killTree(pid);
