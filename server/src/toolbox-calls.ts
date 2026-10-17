/**
 * The daemon calls a toolbox run makes while it runs under a runner (orchestrator.ts outlivesDaemon:
 * a chat move, an acting sweep, a fan_out spawn), and the restart's hold on them.
 *
 * A move outlives a daemon restart, but each of its steps is a call into the daemon (import the chat,
 * archive its source, stamp its settings), and a restart exits the daemon with whatever it is
 * serving: a call cut half-way can leave a chat half-moved, the very thing the move's runner exists
 * to prevent. hydralib marks a move's calls with the run's operation id. Before a relaunch hands over,
 * parkToolboxCalls stops taking new ones (answered 503 with RESTARTING_HEADER: nothing ran, so
 * hydralib sends it again, to the next daemon) and waits, bounded, for those already inside a route.
 */

import type { MiddlewareHandler } from 'hono'

/** Sent by hydralib on every call of a toolbox run the daemon started under a runner. */
export const OPERATION_HEADER = 'x-agenthydra-operation'
/** On a 503: this daemon is handing over and did not run the call. */
export const RESTARTING_HEADER = 'x-agenthydra-restarting'

/** The longest a restart waits for a move's call already under way: the longest such call a move
 *  makes on its own clock is the native archive's 45 s (nativearchivelib.HTTP_TIMEOUT_SECS). */
export const PARK_WAIT_MS = 60_000

let parked = false
let inside = 0
const waiting = new Set<() => void>()

export function toolboxCallGate(): MiddlewareHandler {
  return async (c, next) => {
    if (!c.req.header(OPERATION_HEADER)) return next()
    if (parked)
      return c.json(
        {
          ok: false,
          restarting: true,
          error: 'AgentHydra is restarting; this call did not run. Send it again in a second.',
        },
        503,
        { [RESTARTING_HEADER]: '1', 'retry-after': '1' },
      )
    inside++
    try {
      await next()
    } finally {
      inside--
      if (inside === 0) for (const done of waiting) done()
    }
  }
}

/** Stop taking a move's calls and wait for those under way, at most `maxWaitMs`. Resolves how many
 *  were still inside a route when it stopped waiting (0 when all finished). */
export async function parkToolboxCalls(maxWaitMs = PARK_WAIT_MS): Promise<number> {
  parked = true
  if (inside === 0) return 0
  await new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer)
      waiting.delete(done)
      resolve()
    }
    const timer = setTimeout(done, maxWaitMs)
    waiting.add(done)
  })
  return inside
}

/** A handover that did not happen: this daemon goes on serving, so it takes a move's calls again. */
export function resumeToolboxCalls(): void {
  parked = false
}
