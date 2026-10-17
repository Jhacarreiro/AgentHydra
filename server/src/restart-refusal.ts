// server/src/restart-refusal.ts: what holds a person's daemon restart back (/api/daemon/restart, and a
// source build's /api/update/apply). Its own module so a test can ask it without booting the daemon.
import { climayteRunningCount } from './climayte-stops'

/** Why restarting now would lose work, or null: a CliMayte worker this daemon spawned itself (before runners,
 *  2026-09-30), whose CLI the restart kills. `force` restarts past it. Nothing else holds a restart (2026-10-17, owner:
 *  "each thing can be restarted individually"): Free batches are saved and the next daemon carries them on (mcp-free.ts
 *  adoptFreeBatches), and a chat move runs under a runner and is taken on the same way (orchestrator.ts
 *  adoptOrchestratorRuns). */
export function restartRefusal(force: boolean): string | null {
  const climayte = climayteRunningCount()
  if (climayte > 0 && !force)
    return `${climayte} CliMayte worker(s) run inside this daemon - pass force:true to restart past them (each resumes its session after the restart, but its current step starts over)`
  return null
}
