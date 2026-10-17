// The streaming-input prompt of a chat's query(): an AsyncIterable<SDKUserMessage> that stays open for
// the chat's life. push() a message at any time (the CLI queues it behind a running turn); close() ends it.

import { randomUUID, type UUID } from 'node:crypto'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import { MAX_PICTURE_SIDE, type ImageRef } from '@shared/protocol'
import { cachedPicture, type MediaCache } from '../media/cache'
import { filesOnlyNote, pictureLine } from './system-text'

export interface QueuedInput {
  text: string
  images?: ImageRef[]
}

/** From this many pictures in one message, none goes inline: only their path lines, each opened with Read when needed. */
export const FILES_ONLY_FROM = 10

type ContentBlock = Exclude<SDKUserMessage['message']['content'], string>[number]

/**
 * One SDKUserMessage as sdk.d.ts wants it: origin human, images as base64 blocks before the text. With the media cache,
 * each picture is saved there and the text gets its `[Image: source: <path>]` line, so the model can hand it to a
 * helper (a sub-agent, CliMayte, HSwarm read only text); a picture over MAX_PICTURE_SIDE, or every picture of a
 * message with FILES_ONLY_FROM or more, goes as its line only, with a note saying so. A line the text has already (a
 * send journaled and sent again) is not added twice.
 */
export function buildUserMessage(input: QueuedInput, uuid: string = randomUUID(), media: MediaCache | null = null): SDKUserMessage {
  const { inline, text } = claudeInput(input, media)
  const blocks: ContentBlock[] = []
  for (const img of inline) {
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: img.mediaType as 'image/png', data: img.dataBase64! },
    })
  }
  if (text) blocks.push({ type: 'text', text })
  return {
    type: 'user',
    message: { role: 'user', content: blocks },
    parent_tool_use_id: null,
    origin: { kind: 'human' },
    // A named id comes from the send queue's saved file, so it is a plain string: the SDK types it as a UUID.
    uuid: uuid as UUID,
  }
}

/** The pictures a Claude chat gets inline and the text it gets with their path lines (buildUserMessage). */
export function claudeInput(input: QueuedInput, media: MediaCache | null): { inline: ImageRef[]; text: string } {
  const pictures = (input.images ?? []).filter((img) => !!img.dataBase64)
  if (!media || !pictures.length) return { inline: pictures, text: input.text }
  const all = pictures.length >= FILES_ONLY_FROM
  const inline: ImageRef[] = []
  const lines: string[] = []
  const filesOnly: string[] = []
  for (const img of pictures) {
    const pic = cachedPicture(img, media)
    // Not a picture the cache keeps: inline as before, with no line to name it.
    if (!pic) {
      inline.push(img)
      continue
    }
    const line = pictureLine(pic.path)
    if (!input.text.includes(line)) lines.push(line)
    if (all || Math.max(pic.width ?? 0, pic.height ?? 0) > MAX_PICTURE_SIDE) filesOnly.push(pic.file)
    else inline.push(img)
  }
  const note = filesOnly.length ? filesOnlyNote(filesOnly, all || filesOnly.length === pictures.length) : ''
  const text = [input.text, ...lines, note && !input.text.includes(note) ? note : ''].filter(Boolean).join('\n')
  return { inline, text }
}

export class InputQueue implements AsyncIterable<SDKUserMessage> {
  private items: SDKUserMessage[] = []
  private waiter: ((r: IteratorResult<SDKUserMessage>) => void) | null = null
  private closed = false

  /** `media`: the cache each picture is saved in and named from (buildUserMessage); null sends pictures inline only. */
  constructor(private readonly media: MediaCache | null = null) {}

  /** Queues a message and returns it (its uuid comes back on the SDK's replies as user_message_uuid); `uuid` names it, else a new one. */
  push(input: QueuedInput, uuid?: string): SDKUserMessage {
    if (this.closed) throw new Error('input queue is closed')
    const msg = buildUserMessage(input, uuid, this.media)
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: msg, done: false })
    } else {
      this.items.push(msg)
    }
    return msg
  }

  /** Ends the iteration once what is already queued has been taken. */
  close(): void {
    this.closed = true
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w({ value: undefined, done: true })
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  get pending(): number {
    return this.items.length
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        const head = this.items.shift()
        if (head) return Promise.resolve({ value: head, done: false })
        if (this.closed) return Promise.resolve({ value: undefined, done: true })
        const { promise, resolve } = Promise.withResolvers<IteratorResult<SDKUserMessage>>()
        this.waiter = resolve
        return promise
      },
      return: () => {
        this.close()
        return Promise.resolve({ value: undefined, done: true })
      },
    }
  }
}
