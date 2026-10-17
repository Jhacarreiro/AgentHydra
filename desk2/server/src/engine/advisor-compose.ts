// The Urgency Advisor's one short model call (server/src/urgency-advisor.ts asks for it over POST /api/advisor/compose).
// Chat text is private, so it goes the route Desk already uses to title chats from their text (chat-title.ts):
// one Haiku 5.5 query on the chat's own login, no tools, one turn. Never HydraSwarm or another provider.

import type { Options } from '@anthropic-ai/claude-agent-sdk'
import type { QueryImpl } from './chat-runtime'
import { TITLE_MODEL } from './chat-title'
import { pinHaikuModel } from './haiku-pin'

export const COMPOSE_TIMEOUT_MS = 45_000
export const COMPOSE_PROMPT_CHARS = 9000
const REASON_CHARS = 300

export interface ComposeRequest {
  system: string
  prompt: string
  cwd: string
  /** The account's config folder (null = the default login). */
  configDir: string | null
}

export type ComposeResult = { text: string } | { reason: string }

/** The model's text, or why there is none. Never throws. */
export type Composer = (req: ComposeRequest) => Promise<ComposeResult>

export function sdkComposer(queryImpl: QueryImpl, env: Record<string, string | undefined> | undefined, binaryPath: () => string | null): Composer {
  return async (req) => {
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), COMPOSE_TIMEOUT_MS)
    let reason = 'the CLI ended without a result'
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
          const said = ('result' in m ? m.result : m.errors.join('; ')).trim()
          if (m.subtype === 'success' && !m.is_error) {
            if (said) text = said
            else reason = 'the model replied with empty text'
          } else {
            reason = `${m.subtype}${m.is_error ? ' with an error' : ''}: ${said}`.slice(0, REASON_CHARS)
          }
          return
        }
      })()
      const timedOut = new Promise<void>((r) => abort.signal.addEventListener('abort', () => r()))
      await Promise.race([run, timedOut])
      if (abort.signal.aborted) {
        void run.catch(() => {})
        return { reason: `no answer within ${COMPOSE_TIMEOUT_MS / 1000} s` }
      }
      return text ? { text } : { reason }
    } catch (err) {
      return { reason: `the CLI failed: ${String((err as Error)?.message ?? err).slice(0, REASON_CHARS)}` }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** The chosen account's call first; when it fails, one other account the picker names (never the same folder again). */
export async function composeWithFallback(
  compose: Composer,
  req: Omit<ComposeRequest, 'configDir'>,
  first: string | null,
  pick: () => Promise<string | null>,
): Promise<ComposeResult> {
  const one = await compose({ ...req, configDir: first })
  if ('text' in one) return one
  const other = await pick()
  if (!other || other === first) return one
  const two = await compose({ ...req, configDir: other })
  if ('text' in two) return two
  return { reason: `${one.reason}; then another account: ${two.reason}` }
}
