// server/src/mcp-managers.ts - manager_open, manager_ask and manager_read: a Manager Hydra manager opens sub-manager chats
// under the Desk chat it runs in, and talks to them through the Desk window's own routes.
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { type HydraTool, JSON_HEADERS, S, str } from './mcp-client'
import { deskBase, pickDeskChat } from './mcp-find'

const MANAGER_SLUG = /^[a-z0-9][a-z0-9-]{0,80}$/
const DEFAULT_WAIT = 30
const MAX_WAIT = 35

interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
  status?: string
}

interface TranscriptItem {
  kind?: string
  text?: string
}

/** A manager's display name from its persona.json (the same folder Manager Hydra keeps its managers in). */
export function managerName(slug: string): string {
  if (!MANAGER_SLUG.test(slug)) throw new Error(`"${slug}" is not a manager slug`)
  const dir =
    process.env.AGENTHYDRA_MANAGERS_DIR?.trim() || join(homedir(), '.agenthydra', 'managers')
  let persona: unknown
  try {
    persona = JSON.parse(readFileSync(join(dir, slug, 'persona.json'), 'utf8'))
  } catch {
    throw new Error(`no manager "${slug}": it has no persona.json`)
  }
  const name =
    persona && typeof persona === 'object' ? (persona as { name?: unknown }).name : undefined
  if (typeof name !== 'string' || !name.trim())
    throw new Error(`manager "${slug}" has no name in its persona.json`)
  return name.trim()
}

const UNREACHABLE = (base: string) =>
  `the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`

async function deskChats(): Promise<DeskChat[]> {
  const base = deskBase()
  const res = await fetch(`${base}/api/chats`).catch(() => null)
  if (!res?.ok) throw new Error(UNREACHABLE(base))
  const chats: unknown = await res.json().catch(() => null)
  if (!Array.isArray(chats))
    throw new Error(`unexpected answer from ${base}/api/chats (not a list of chats)`)
  return chats as DeskChat[]
}

async function deskPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const base = deskBase()
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(body),
  }).catch(() => null)
  if (!res) throw new Error(UNREACHABLE(base))
  const answer = (await res.json().catch(() => ({}))) as Record<string, unknown>
  if (!res.ok) throw new Error(`Desk refused: ${String(answer.error ?? res.status)}`)
  return answer
}

async function transcriptItems(chatId: string): Promise<TranscriptItem[]> {
  const base = deskBase()
  const res = await fetch(`${base}/api/chats/${encodeURIComponent(chatId)}/transcript`).catch(
    () => null,
  )
  if (!res?.ok) throw new Error(UNREACHABLE(base))
  const items: unknown = await res.json().catch(() => null)
  if (!Array.isArray(items))
    throw new Error(`unexpected transcript from ${base} (not a list of items)`)
  return items as TranscriptItem[]
}

function waitSeconds(a: Record<string, unknown>): number {
  const n = Number(a.wait_seconds)
  return Math.min(MAX_WAIT, Math.max(0, Number.isFinite(n) ? n : DEFAULT_WAIT))
}

/** Waits for the chat's turn to end and answers its final reply. `sentAfter` is the transcript length before a message
 *  this call sent (null for a read): only items after it count, and the turn must have taken that message. */
async function replyWhenDone(
  chat: DeskChat,
  sentAfter: number | null,
  seconds: number,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const current = (await deskChats()).find((c) => c.id === chat.id)
    const items = await transcriptItems(chat.id)
    const fresh = sentAfter === null ? items : items.slice(sentAfter)
    const working = current?.status === 'working' || current?.status === 'starting'
    const taken = sentAfter === null || fresh.some((i) => i.kind === 'user')
    if (!working && taken) {
      const reply = fresh.filter((i) => i.kind === 'assistant_text').at(-1)?.text ?? ''
      return { chat: chat.id, title: chat.title, status: 'done', reply }
    }
    if (Date.now() >= deadline) return { chat: chat.id, title: chat.title, status: 'working' }
    await new Promise((r) => setTimeout(r, 1000))
  }
}

export const MANAGER_TOOLS: HydraTool[] = [
  {
    name: 'manager_open',
    callerChat: 'deskChat',
    listed: true,
    description:
      "MUTATES: opens a sub-manager chat for a manager (a Manager Hydra manager, named by its slug) under THIS Hydra Desk chat, which the sidebar nests directly below it, and sends it the first prompt. The chat runs with that manager's persona. Its title is '<Name> · <title>' (the manager's name, then the topic); cwd defaults to this chat's folder. Answers the new chat's id and title; then use manager_ask or manager_read to follow it. Refused outside a Desk chat, or for a slug with no persona.json.",
    inputSchema: S(
      {
        manager: {
          type: 'string',
          description: 'The manager: its slug, the name of its folder under the managers folder.',
        },
        prompt: { type: 'string', description: 'The first message the sub-manager chat gets.' },
        title: { type: 'string', description: 'The topic, shown after the manager name.' },
        cwd: {
          type: 'string',
          description: "The folder the chat works in. Default: this chat's folder.",
        },
      },
      ['manager', 'prompt'],
    ),
    run: async (a: Record<string, unknown>) => {
      const parentRef = str(a.deskChat).trim() || process.env.HYDRA_DESK_CHAT_ID?.trim() || ''
      if (!parentRef)
        throw new Error(
          'this process is not a Desk chat (no HYDRA_DESK_CHAT_ID): manager_open opens a chat under the calling Desk chat',
        )
      const slug = str(a.manager).trim()
      const name = managerName(slug)
      const prompt = str(a.prompt).trim()
      if (!prompt) throw new Error('prompt is required: the first message the new chat gets')
      const parent = pickDeskChat(await deskChats(), parentRef)
      const cwd = str(a.cwd).trim() || parent.cwd || ''
      if (!cwd) throw new Error('no folder: pass cwd, the calling chat has none')
      const topic = str(a.title).trim()
      const title = (topic ? `${name} · ${topic}` : name).slice(0, 200)
      const created = await deskPost('/api/chats', {
        cwd,
        title,
        prompt,
        parentId: parent.id,
        managerSlug: slug,
      })
      return { chat: created.id, title: created.title ?? title }
    },
  },
  {
    name: 'manager_ask',
    listed: true,
    description:
      'MUTATES: sends a message to a sub-manager chat (a Hydra Desk chat, named by its Desk id, session id or title fragment) and waits up to wait_seconds (at most 35) for its turn to end. Answers {status: "done", reply} with the chat\'s final reply text, or {status: "working"} when it is still going: call manager_read later for the reply.',
    inputSchema: S(
      {
        chat: {
          type: 'string',
          description: 'The chat: Desk chat id, Claude session id, or part of its title.',
        },
        message: { type: 'string', description: 'The message to send.' },
        wait_seconds: {
          type: 'number',
          description: 'How long to wait for the reply, up to 35. Default 30.',
        },
      },
      ['chat', 'message'],
    ),
    run: async (a: Record<string, unknown>) => {
      const message = str(a.message).trim()
      if (!message) throw new Error('message is required')
      const chat = pickDeskChat(await deskChats(), str(a.chat))
      const sentAfter = (await transcriptItems(chat.id)).length
      await deskPost(`/api/chats/${encodeURIComponent(chat.id)}/messages`, { text: message })
      return replyWhenDone(chat, sentAfter, waitSeconds(a))
    },
  },
  {
    name: 'manager_read',
    listed: true,
    description:
      'Reads a sub-manager chat (a Hydra Desk chat, named by its Desk id, session id or title fragment) without sending anything: waits up to wait_seconds (at most 35) for its turn to end, then answers {status: "done", reply} with its latest reply text, or {status: "working"} while it is still going. Read-only.',
    inputSchema: S(
      {
        chat: {
          type: 'string',
          description: 'The chat: Desk chat id, Claude session id, or part of its title.',
        },
        wait_seconds: {
          type: 'number',
          description: 'How long to wait for the turn to end, up to 35. Default 30.',
        },
      },
      ['chat'],
    ),
    run: async (a: Record<string, unknown>) => {
      const chat = pickDeskChat(await deskChats(), str(a.chat))
      return replyWhenDone(chat, null, waitSeconds(a))
    },
  },
]
