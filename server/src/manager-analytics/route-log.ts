import { appendJsonl, ROUTES_FILE } from './store'

export interface RouteLogInput {
  /** The CLI session the message went to. */
  session: string
  /** The Desk chat's id; null for a chat outside the Desk. */
  deskChat: string | null
  /** The lead's catalog id (person:<slug>); null or empty writes nothing. */
  lead: string | null | undefined
  /** The lead the chat had before this message. */
  prev?: string | null
  /** How the lead was picked: the model, or the word ranker. */
  source: string
  /** Nth message the chat's sessions have been launched for. */
  message: number
  cwd: string
  promptChars: number
}

/**
 * One routes.jsonl row for a message, in the shape the retired managers/router.mjs wrote, so collect, judge and rsi
 * read it unchanged. Never throws and never waits: a failed write is logged and dropped. Returns whether a row went.
 */
export function logRoute(input: RouteLogInput, now = new Date()): boolean {
  const manager = input.lead?.replace(/^person:/, '')
  if (!manager) return false
  try {
    appendJsonl(ROUTES_FILE, [
      {
        v: 1,
        at: now.toISOString(),
        session: input.session,
        manager,
        decision: input.prev && input.prev !== input.lead ? 'swap' : 'stay',
        why: 'Hydra Core lead',
        source: input.source,
        p: null,
        message: input.message,
        pinned: false,
        deskChat: input.deskChat,
        cwd: input.cwd,
        transcriptPath: null,
        promptChars: input.promptChars,
      },
    ])
    return true
  } catch (err) {
    console.error('[hydra-core] routes row dropped:', err)
    return false
  }
}
