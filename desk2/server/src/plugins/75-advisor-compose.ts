// POST /api/advisor/compose { chatId, system, prompt } -> { text } | 502: the Urgency Advisor's one short model call
// (engine/advisor-compose.ts says which model and why). AgentHydra's server calls it; the chat's own login pays.
import type { Hono } from 'hono'
import type { ChatSummary } from '@shared/protocol'
import type { ServerContext } from '../context'
import { sdkComposer } from '../engine/advisor-compose'
import { claudeCodeBinaryFor } from '../engine/claude-code-binary'
import { chatQueryImpl } from '../host/client'

export default function plugin(app: Hono, ctx: ServerContext): void {
  const compose = sdkComposer(
    chatQueryImpl({ home: ctx.home, orphanMinutes: () => ctx.settings().idleCloseMinutes }),
    ctx.deps.env as Record<string, string | undefined> | undefined,
    () => claudeCodeBinaryFor(ctx.home).path(),
  )
  app.post('/api/advisor/compose', async (c) => {
    const b = (await c.req.json().catch(() => null)) as { chatId?: unknown; system?: unknown; prompt?: unknown } | null
    if (!b || typeof b.chatId !== 'string' || typeof b.system !== 'string' || typeof b.prompt !== 'string') return c.json({ error: 'chatId, system and prompt are required strings' }, 400)
    const res = await app.request(`/api/chats/${encodeURIComponent(b.chatId)}`)
    if (!res.ok) return c.json({ error: 'no such chat' }, 404)
    const chat = (await res.json()) as ChatSummary
    const text = await compose({ system: b.system, prompt: b.prompt, cwd: chat.cwd, configDir: chat.account.configDir ?? null })
    return text ? c.json({ text }) : c.json({ error: 'the model gave no text' }, 502)
  })
}
