// The Urgency Advisor's one short model call (server/src/urgency-advisor.ts asks for it over POST /api/advisor/compose).
// Chat text is private, so it goes the route Desk already uses to title chats from their text (chat-title.ts):
// one Haiku 5.5 query on the chat's own login, no tools, one turn. Never HydraSwarm or another provider.

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { QueryImpl } from './chat-runtime'
import { TITLE_MODEL } from './chat-title'
import { pinHaikuModel } from './haiku-pin'

export const COMPOSE_TIMEOUT_MS = 45_000
export const COMPOSE_PROMPT_CHARS = 9000

export interface ComposeRequest {
  system: string
  prompt: string
  cwd: string
  /** The chat's account config folder (null = the default login). */
  configDir: string | null
}

/** The model's text, or null on any failure or timeout. Never throws. */
export type Composer = (req: ComposeRequest) => Promise<string | null>

export function sdkComposer(queryImpl: QueryImpl, env: Record<string, string | undefined> | undefined, binaryPath: () => string | null): Composer {
  return async (req) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), COMPOSE_TIMEOUT_MS)
    try {
      const childEnv: Record<string, string | undefined> = { ...(env ?? process.env) }
      if (req.configDir) childEnv.CLAUDE_CONFIG_DIR = req.configDir
      else delete childEnv.CLAUDE_CONFIG_DIR
      pinHaikuModel(childEnv)
      const binary = binaryPath()
      const options: Options = {
        cwd: req.cwd,
        env: childEnv,
        model: TITLE_MODEL,
        effort: 'low',
        tools: [],
        maxTurns: 1,
        settingSources: [],
        persistSession: false,
        systemPrompt: req.system.slice(0, COMPOSE_PROMPT_CHARS),
        abortController: abort,
        ...(binary ? { pathToClaudeCodeExecutable: binary } : {}),
      }
      const q = queryImpl({ prompt: req.prompt.slice(0, COMPOSE_PROMPT_CHARS), options })
      let text: string | null = null
      const run = (async () => {
        for await (const m of q) {
          if (m.type !== 'result') continue
          if (m.subtype === 'success' && !m.is_error && m.result.trim()) text = m.result.trim()
          return
        }
      })()
      const timedOut = new Promise<void>((r) => abort.signal.addEventListener('abort', () => r()))
      await Promise.race([run, timedOut])
      if (abort.signal.aborted) {
        void run.catch(() => {})
        return null
      }
      return text
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }
}
