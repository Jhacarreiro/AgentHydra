// ArchAIngel (owner, 2026-10-11: "the always-on agent parts will pretty much need to run in Agent Hydra ... Kind of like
// how we have the babysitter, we'll essentially have ... the ArchAIngel ... I don't really want, like, API keys in the
// cloud ... leveraging all of the things inside Agent Hydra, like CLI, free accounts"). A third watcher beside the
// babysitter: it runs the user's standing agents (long-lived improvement agents that live on this PC as a command), each
// on its own pace, hidden, and shows what they did. ArchAIngel asks no model itself: an agent's own command does the
// work through what AgentHydra already has. The server keeps it (server/src/plugins/73-archaingel.ts, deciding in
// server/src/archaingel/); GET /api/archaingel answers what it saw last, Settings > Managers draws it, and
// AgentHydra's MCP tool `archaingel` reads the same answer. Plain types only.
//
// THE AGENT CONTRACT. An agent registers with one file: <desk home>/archaingel/agents/<id>.json (the desk home is
// ctx.home, ~/.hydra-desk-2 on the live install). The id is the file name without .json and matches
// ^[a-z0-9][a-z0-9-]{0,39}$. The body is:
//   {
//     "name": "Example Agent",
//     "tick": ["python", "C:/Users/me/agents/tick.py"],
//     "status": ["python", "C:/Users/me/agents/status.py"],
//     "cwd": "C:/Users/me/agents",
//     "timeoutMinutes": 120
//   }
// "tick" and "status" are argv lists run with no shell, the program first. "cwd" and "timeoutMinutes" are optional:
// the timeout defaults to 120 minutes and must be 5 to 360. A file that does not parse or fails these checks is listed
// as 'broken' with its reason, and is never run.
//
// THE STATUS. The status command prints ONE JSON object on stdout within 60 seconds. ArchAIngel reads only:
//   next_tick_at  an ISO string, or null (null = due now)
//   last_tick_at  an ISO string, or null
//   off           true = never tick it (optional)
//   headline      one line for the page, cut to 160 characters (optional)
//   totals        an object of name -> number, shown as counts (optional)
//   settings      an object of name -> string | number | boolean, shown read-only; the agent owns them (optional)
// A status command that fails, times out or prints no object makes the agent 'broken' with the reason. Nothing is
// ticked on a guess.
//
// THE TICK. The tick command runs one sortie. Exit 0 = ok. Exit 75 = busy (the agent's own lock is held by another run):
// recorded as 'busy', not a failure. Any other exit = failed. Its stdout and stderr are appended to
// <desk home>/archaingel/logs/<id>.log, moved to <id>.log.1 first once that passes 2 MB. The run record keeps the last
// non-empty output line.
//
// THE LOOP. The first look is 60 seconds after start, then one every ARCHAINGEL_EVERY_MS. A tick starts for an agent
// when ArchAIngel is on, the agent is not off, no tick of it is running, it is due (next_tick_at null or in the past),
// and at least 15 minutes passed since its last tick ended. While ArchAIngel is off it still reads each status, so the
// page stays current, and starts nothing. A manual run ticks an agent now, skipping the due time and the 15 minutes,
// but never an agent that is off, broken or running.

/** How often it looks at the standing agents. */
export const ARCHAINGEL_EVERY_MS = 5 * 60_000

/** How a tick ended: ok (exit 0), busy (exit 75), failed, timed-out (killed past its timeout), or interrupted (AgentHydra stopped mid-tick). */
export type ArchAIngelOutcome = 'ok' | 'busy' | 'failed' | 'timed-out' | 'interrupted'

/**
 * Where a standing agent stands:
 * idle      not due yet (its status says when)
 * due       due, but ArchAIngel is off or its last tick ended under 15 minutes ago: it waits
 * running   a tick of it is running now
 * off       its status says off: never ticked
 * broken    its manifest or its status does not check out (the reason says which)
 */
export type ArchAIngelState = 'idle' | 'due' | 'running' | 'off' | 'broken'

/** One tick, as the page and the memory keep it. Times in ms. */
export interface ArchAIngelRun {
  startedAt: number
  endedAt: number
  outcome: ArchAIngelOutcome
  exitCode: number | null
  /** The last non-empty output line, cut to 300 characters (the error, when nothing was printed). */
  lastLine: string
}

/** A tick running now: when it started and the process it is. */
export interface ArchAIngelRunning {
  startedAt: number
  pid: number | null
}

/** One standing agent, as the last look saw it. */
export interface ArchAIngelAgent {
  id: string
  name: string
  state: ArchAIngelState
  reason: string
  /** From its status: one line, cut to 160 characters. */
  headline: string | null
  totals: Record<string, number> | null
  /** From its status: at most 12 entries, names cut to 40 and string values to 120 characters; ArchAIngel never reads them. */
  settings: Record<string, string | number | boolean> | null
  /** When its last tick ended, ms, or null when none is known. */
  lastTickAt: number | null
  /** When its status says it is next due, ms, or null (due now). */
  nextTickAt: number | null
  running: ArchAIngelRunning | null
  /** Its last ticks, newest first (at most 30). */
  runs: ArchAIngelRun[]
}

/** GET /api/archaingel. */
export interface ArchAIngelStatus {
  enabled: boolean
  everyMs: number
  checkedAt: number | null
  /** When it looks next. It looks while off too, starting nothing. */
  nextCheckAt: number | null
  agents: ArchAIngelAgent[]
  /** Why the last look failed as a whole, or null. */
  error: string | null
}

/** POST /api/archaingel: turn it on or off (saved in Settings), and/or tick one agent now. */
export interface ArchAIngelRequest {
  enabled?: boolean
  run?: string
}
