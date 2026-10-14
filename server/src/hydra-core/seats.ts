// server/src/hydra-core/seats.ts - a seat: one persona's Desk sub-chat under a Prime chat, opened once and resumed.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { pickDeskChat } from '../mcp-find'
import { deskChats, deskPost, managerName, transcriptItems } from '../mcp-managers'
import { type CatalogEntry, loadText } from './catalog'
import { chatPaths } from './paths'

export interface Seat {
  chat: string
  title: string
}

type Seats = Record<string, Seat>

function readSeats(file: string): Seats {
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Seats) : {}
}

function writeSeats(file: string, seats: Seats): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(seats, null, 2)}\n`)
}

/** The manager whose slug is the persona's id after the colon, when its persona.json exists. */
function managerSlugOf(e: CatalogEntry): string | undefined {
  const slug = e.id.slice(e.id.indexOf(':') + 1)
  try {
    managerName(slug)
    return slug
  } catch {
    return undefined
  }
}

export function seatOf(dir: string, chat: string, e: CatalogEntry): Seat | undefined {
  return readSeats(chatPaths(dir, chat).seats)[e.id]
}

/** The persona's seat under the Prime chat: opened with `text` as its first message, or `text` sent to the seat already open. */
export async function openOrSend(
  dir: string,
  chat: string,
  e: CatalogEntry,
  text: string,
  cwd: string | undefined,
): Promise<{ seat: Seat; sentAfter: number | null }> {
  const parent = pickDeskChat(await deskChats(), chat)
  const file = chatPaths(dir, chat).seats
  const seats = readSeats(file)
  const known = seats[e.id]
  if (known) {
    const sentAfter = (await transcriptItems(known.chat)).length
    await deskPost(`/api/chats/${encodeURIComponent(known.chat)}/messages`, { text })
    return { seat: known, sentAfter }
  }
  const folder = cwd || parent.cwd
  if (!folder) throw new Error('no folder: pass cwd, the calling chat has none')
  const slug = managerSlugOf(e)
  const topic = parent.title?.trim()
  const title = (topic ? `${e.name} · ${topic}` : e.name).slice(0, 200)
  const prompt = slug
    ? text
    : [`You are now a seat in this chat as ${e.name}: ${e.when}.`, loadText(e), text].join('\n\n')
  const created = await deskPost('/api/chats', {
    cwd: folder,
    title,
    prompt,
    parentId: parent.id,
    ...(slug ? { managerSlug: slug } : {}),
  })
  const seat = { chat: String(created.id), title: String(created.title ?? title) }
  writeSeats(file, { ...seats, [e.id]: seat })
  return { seat, sentAfter: 0 }
}
