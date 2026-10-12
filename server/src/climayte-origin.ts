// Who dispatched a CliMayte worker, as ids and a title, for the shared queue (core/climayte-queue-sync)
// and the CliMayte list and detail the Desk and AgentHydra windows read. Only the ids and the title
// leave the server: a chat origin also holds its Claude home and transcript path, never sent here.
import type { CliMayteOrigin } from './climayte-ping'

export interface CliMayteOriginFields {
  /** The chat that dispatched it, or the session of the worker that did. */
  originSessionId: string | null
  /** The worker that dispatched it, when a worker did. */
  originWorkerId: string | null
  /** The chat's title (a chat origin only); null when unknown. */
  originTitle: string | null
}

export interface OriginLookup {
  /** The session of a worker that dispatched another worker. */
  sessionOf(workerId: string): string | null
  /** The title of a chat that dispatched a worker. */
  titleOf(sessionId: string): string | null
}

/** Ids only: with no lookups, a chat origin keeps its session id and a worker origin its worker id. */
export const NO_ORIGIN_LOOKUP: OriginLookup = { sessionOf: () => null, titleOf: () => null }

export function originFields(
  origin: CliMayteOrigin | undefined,
  lookup: OriginLookup = NO_ORIGIN_LOOKUP,
): CliMayteOriginFields {
  const workerId = origin?.kind === 'worker' ? origin.workerId : null
  return {
    originSessionId:
      origin?.kind === 'chat' ? origin.sessionId : workerId ? lookup.sessionOf(workerId) : null,
    originWorkerId: workerId,
    originTitle: origin?.kind === 'chat' ? lookup.titleOf(origin.sessionId) : null,
  }
}
