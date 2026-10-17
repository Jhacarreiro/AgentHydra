// server/src/desk-client.ts - the Desk window's chat routes as the server's own callers use them: list the chats, post to
// a route, read a transcript and wait for a turn to end. Generic to AgentHydra; the people add-on uses it through its host.
import { JSON_HEADERS } from './mcp-client'
import { deskBase } from './mcp-find'

export interface DeskChat {
  id: string
  sessionId?: string | null
  title?: string
  cwd?: string
  status?: string
  lastError?: string | null
}

export interface TranscriptItem {
  kind?: string
  text?: string
}

const UNREACHABLE = (base: string) =>
  `the Desk window does not answer at ${base}; is AgentHydra 2.0 open?`

export async function deskChats(): Promise<DeskChat[]> {
  const base = deskBase()
  const res = await fetch(`${base}/api/chats`).catch(() => null)
  if (!res?.ok) throw new Error(UNREACHABLE(base))
  const chats: unknown = await res.json().catch(() => null)
  if (!Array.isArray(chats))
    throw new Error(`unexpected answer from ${base}/api/chats (not a list of chats)`)
  return chats as DeskChat[]
}

export async function deskPost(path: string, body: unknown): Promise<Record<string, unknown>> {
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

export async function transcriptItems(chatId: string): Promise<TranscriptItem[]> {
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

/** Whether a chat's turn has ended and answered what was sent after `sentAfter` (null for a read). A sent message is
 *  answered only once the assistant spoke after it (or the chat errored): Desk flips a new or idle chat to working a
 *  beat after the prompt lands in the transcript. */
export function turnAnswered(
  chat: Pick<DeskChat, 'status' | 'lastError'> | undefined,
  items: { kind?: string }[],
  sentAfter: number | null,
): boolean {
  const working = chat?.status === 'working' || chat?.status === 'starting'
  const fresh = sentAfter === null ? items : items.slice(sentAfter)
  const lastUser = fresh.map((i) => i.kind).lastIndexOf('user')
  const answered =
    sentAfter === null ||
    (lastUser >= 0 &&
      (fresh.slice(lastUser).some((i) => i.kind === 'assistant_text') || !!chat?.lastError))
  return !working && answered
}

/** Waits for the chat's turn to end and answers its final reply. `sentAfter` is the transcript length before a message
 *  this call sent (null for a read): only items after it count, and the turn must have taken that message. */
export async function replyWhenDone(
  chat: DeskChat,
  sentAfter: number | null,
  seconds: number,
): Promise<{ chat: string; title?: string; status: 'done' | 'working'; reply?: string }> {
  const deadline = Date.now() + seconds * 1000
  for (;;) {
    const current = (await deskChats()).find((c) => c.id === chat.id)
    const items = await transcriptItems(chat.id)
    if (turnAnswered(current, items, sentAfter)) {
      const fresh = sentAfter === null ? items : items.slice(sentAfter)
      const reply = fresh.filter((i) => i.kind === 'assistant_text').at(-1)?.text ?? ''
      return { chat: chat.id, title: chat.title, status: 'done', reply }
    }
    if (Date.now() >= deadline) return { chat: chat.id, title: chat.title, status: 'working' }
    await new Promise((r) => setTimeout(r, 1000))
  }
}
