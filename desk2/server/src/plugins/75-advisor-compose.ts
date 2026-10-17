// POST /api/advisor/compose { chatId, system, prompt, configDir? } -> { text } | 502: the Urgency Advisor's one short model call
// (engine/advisor-compose.ts says which model and why). AgentHydra's server calls it; the owner's own Claude logins pay.
// configDir is the account the chat's worker runs on now (a worker-backed chat has none of its own); without it the chat's
// account is used. When that call fails, one other account with room is tried before giving up.
import type { Hono } from 'hono'
import type { ChatSummary } from '@shared/protocol'
import type { ServerContext } from '../context'
import { composeWithFallback, sdkComposer } from '../engine/advisor-compose'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { type Bridge, bridge } from '../bridge'
import { chatQueryImpl } from '../host/client'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const compose = sdkComposer(
    chatQueryImpl({ home: ctx.home, orphanMinutes: () => ctx.settings().idleCloseMinutes }),
    ctx.deps.env as Record<string, string | undefined> | undefined,
    () => claudeCodeBinaryFor(ctx.home).path(),
  )
  app.post('/api/advisor/compose', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { chatId?: unknown; system?: unknown; prompt?: unknown; configDir?: unknown } | null
    if (!b || typeof b.chatId !== 'string' || typeof b.system !== 'string' || typeof b.prompt !== 'string') return c.json({ error: 'chatId, system and prompt are required strings' }, 400)
    const res = await app.request(`/api/chats/${encodeURIComponent(b.chatId)}`)
    if (!res.ok) return c.json({ error: 'no such chat' }, 404)
    const chat = (await res.json()) as ChatSummary
    const given = typeof b.configDir === 'string' && b.configDir ? b.configDir : null
    const result = await composeWithFallback(
      compose,
      { system: b.system, prompt: b.prompt, cwd: chat.cwd },
      given ?? chat.account.configDir ?? null,
      async () => {
        const picked = await ((ctx.deps.bridge as Bridge | undefined) ?? bridge()).pickAccount()
        return picked?.configDir ?? null
      },
    )
    if ('text' in result) return c.json({ text: result.text })
    console.warn(`[advisor-compose] chat=${chat.id} failed: ${result.reason}`)
    return c.json({ error: 'the model gave no text', reason: result.reason }, 502)
  })
}
