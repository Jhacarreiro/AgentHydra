// Who sent which picture where: one row per picture per message sent into a chat, appended to <home>/media/index.jsonl
// beside the cache that holds the file. A row names the file (the cache's `<sha256>.<ext>`), its size, the size the
// window shrank it from, this PC, the account, the folder, the chat, its session, the message, who sent it and the
// engine that took it. Append-only and flushed to the disk as the cache's own writes are; a row that cannot be written
// is reported on the server log and dropped, never failing the send it describes.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import type { ImageRef } from '@shared/protocol'
import { timedSync } from '../engine/sync-block'
import { cachedPicture, type MediaCache } from './cache'

export const PICTURE_INDEX = 'index.jsonl'

/** What took the message: a Claude chat (the SDK), a CliMayte worker, a pinned Codex or ChatGPT chat, another service. */
export type PictureEngine = 'claude' | 'worker' | 'codex' | 'chatgpt' | 'service'

/** The message a send's pictures went out in, as every one of its rows names it. */
export interface PictureSend {
  /** The account or instance as the chat names it (its label), and its id; null while a pinned service has placed none. */
  account: string | null
  accountId: string | null
  workspace: string
  chatId: string
  sessionId: string | null
  messageId: string | null
  /** 'owner' for his own sends; the agent or peer a send names (a note's `[From] Not from the user.`). */
  sender: string
  engine: PictureEngine
}

export interface PictureRow extends PictureSend {
  ts: string
  file: string
  bytes: number
  width: number | null
  height: number | null
  originalWidth?: number
  originalHeight?: number
  pc: string
}

/** The rows for a message's pictures: those the cache keeps, each once per time it is sent. */
export function pictureRows(images: readonly ImageRef[], cache: MediaCache, send: PictureSend, now: number = Date.now()): PictureRow[] {
  const ts = new Date(now).toISOString()
  const pc = hostname()
  return images.flatMap((img) => {
    const pic = cachedPicture(img, cache)
    if (!pic) return []
    const row: PictureRow = { ts, file: pic.file, bytes: pic.ref.bytes ?? 0, width: pic.width, height: pic.height, pc, ...send }
    if (img.originalWidth && img.originalHeight) Object.assign(row, { originalWidth: img.originalWidth, originalHeight: img.originalHeight })
    return [row]
  })
}

/** Appends a message's rows to the cache's index. Never throws: a failed write is logged and the send goes on. */
export function indexPictures(images: readonly ImageRef[] | undefined, cache: MediaCache | null, send: PictureSend, now?: number): void {
  if (!images?.length || !cache) return
  try {
    const rows = pictureRows(images, cache, send, now)
    if (rows.length) appendFlushed(join(cache.dir, PICTURE_INDEX), rows.map((r) => `${JSON.stringify(r)}\n`).join(''))
  } catch (err) {
    console.warn(`[media] the picture index was not written for chat ${send.chatId}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function appendFlushed(file: string, text: string): void {
  timedSync('pictureIndex', () => {
    mkdirSync(dirname(file), { recursive: true })
    const fd = openSync(file, 'a')
    try {
      writeSync(fd, text)
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  })
}
