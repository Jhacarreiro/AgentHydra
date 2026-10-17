// Pictures into a Claude chat: a picture's size read from its header, the path line each one gets beside its inline
// block (and alone when it is too big, or one of a big batch), and the transcript read back from the session showing
// each picture once with none of those lines. The pictures are invented headers, never real screenshots.

import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk'
import type { ImageRef, TranscriptItem } from '@shared/protocol'
import { buildUserMessage, FILES_ONLY_FROM } from '../../src/engine/input-queue'
import { historyToItems } from '../../src/engine/normalize'
import { createMediaCache } from '../../src/media/cache'
import { imageSize } from '../../src/media/image-size'

const temps: string[] = []
const temp = (tag: string) => {
  const d = mkdtempSync(join(tmpdir(), `desk-pictures-${tag}-`))
  temps.push(d)
  return d
}
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

/** A PNG's signature and IHDR naming its size, then filler (`seed` makes each picture's bytes its own). */
function png(width: number, height: number, seed = 0): Buffer {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return Buffer.concat([head, Buffer.alloc(24, seed)])
}
const webp = (chunk: string, body: number[]) => Buffer.concat([Buffer.from('RIFF\0\0\0\0WEBP', 'latin1'), Buffer.from(chunk, 'latin1'), Buffer.alloc(4), Buffer.from(body), Buffer.alloc(16)])
const ref = (bytes: Buffer, name?: string): ImageRef => ({ mediaType: 'image/png', dataBase64: bytes.toString('base64'), ...(name ? { name } : {}) })

type Block = { type: string; text?: string; source?: { data: string } }
const blocks = (msg: SDKUserMessage) => msg.message.content as Block[]
const textOf = (msg: SDKUserMessage) => blocks(msg).find((b) => b.type === 'text')?.text ?? ''
const inline = (msg: SDKUserMessage) => blocks(msg).filter((b) => b.type === 'image').length
const lines = (text: string) => text.match(/^\[Image: source: .+\]$/gm) ?? []

describe('a picture size from its header', () => {
  test.each([
    ['PNG', png(2400, 1350), { width: 2400, height: 1350 }],
    ['GIF', Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x30, 0x0c, 0xd0, 0x07]), Buffer.alloc(8)]), { width: 3120, height: 2000 }],
    // Fill bytes and a table segment before the frame header, as encoders write them.
    [
      'JPEG',
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, 0xff, 0xc4, 0x00, 0x03, 0x00, 0xff, 0xc2, 0x00, 0x11, 0x08, 0x0b, 0xb8, 0x0f, 0xa0, 0x03, ...Array(12).fill(0)]),
      { width: 4000, height: 3000 },
    ],
    ['WebP (VP8)', webp('VP8 ', [0, 0, 0, 0x9d, 0x01, 0x2a, 0xd0, 0x07, 0xe8, 0x03]), { width: 2000, height: 1000 }],
    ['WebP (VP8L)', webp('VP8L', [0x2f, ...[(2100 - 1) | ((900 - 1) << 14)].flatMap((n) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255])]), { width: 2100, height: 900 }],
    ['WebP (VP8X)', webp('VP8X', [0, 0, 0, 0, 0x6f, 0x0e, 0x00, 0x37, 0x08, 0x00]), { width: 3696, height: 2104 }],
  ])('%s', (_kind, bytes, size) => {
    expect(imageSize(new Uint8Array(bytes))).toEqual(size)
  })

  test('null for bytes that are no picture, or a header cut short', () => {
    expect(imageSize(new Uint8Array(Buffer.from('not a picture at all, only words')))).toBeNull()
    expect(imageSize(new Uint8Array(png(2400, 1350).subarray(0, 20)))).toBeNull()
    expect(imageSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull()
  })
})

describe('the message a Claude chat is sent', () => {
  test('each picture goes inline with its path line, the cached file the line names', () => {
    const media = createMediaCache(join(temp('lines'), 'media'))
    const msg = buildUserMessage({ text: 'look at these', images: [ref(png(800, 600, 1)), ref(png(1920, 1080, 2))] }, undefined, media)
    expect(inline(msg)).toBe(2)
    const text = textOf(msg)
    expect(text.startsWith('look at these\n')).toBe(true)
    expect(lines(text)).toHaveLength(2)
    for (const line of lines(text)) expect(line).toMatch(new RegExp(`^\\[Image: source: ${media.dir.replace(/\\/g, '\\\\')}[\\\\/][0-9a-f]{64}\\.png\\]$`))
    expect(text).not.toContain('saved as file')
  })

  test('a picture over 2000 px goes as its path line only, and the note names it', () => {
    const media = createMediaCache(join(temp('big'), 'media'))
    const msg = buildUserMessage({ text: 'two shots', images: [ref(png(1000, 800, 1)), ref(png(3840, 2160, 2))] }, undefined, media)
    expect(inline(msg)).toBe(1)
    const text = textOf(msg)
    expect(lines(text)).toHaveLength(2)
    expect(text).toMatch(/\(Not shown inline, too big: [0-9a-f]{64}\.png\. Open it with Read/)
    // Exactly 2000 still goes inline.
    expect(inline(buildUserMessage({ text: '', images: [ref(png(2000, 2000, 3))] }, undefined, media))).toBe(1)
  })

  test(`${FILES_ONLY_FROM} pictures or more go as path lines only, with one note`, () => {
    const media = createMediaCache(join(temp('batch'), 'media'))
    const many = Array.from({ length: FILES_ONLY_FROM }, (_, i) => ref(png(640, 480, i)))
    const msg = buildUserMessage({ text: 'the whole run', images: many }, undefined, media)
    expect(inline(msg)).toBe(0)
    expect(lines(textOf(msg))).toHaveLength(FILES_ONLY_FROM)
    expect(textOf(msg).match(/^\(The 10 pictures above are saved as files, not shown inline: open each with Read/gm)).toHaveLength(1)
    expect(inline(buildUserMessage({ text: 'one fewer', images: many.slice(1) }, undefined, media))).toBe(FILES_ONLY_FROM - 1)
  })

  test('sent again (a journaled send after a restart), the text keeps one line per picture', () => {
    const media = createMediaCache(join(temp('again'), 'media'))
    const first = buildUserMessage({ text: 'look', images: [ref(png(800, 600))] }, undefined, media)
    const again = buildUserMessage({ text: textOf(first), images: [ref(png(800, 600))] }, undefined, media)
    expect(textOf(again)).toBe(textOf(first))
  })
})

describe('read back from the session', () => {
  const record = (msg: SDKUserMessage) => ({ type: 'user', uuid: `u-${Math.random().toString(36).slice(2)}`, timestamp: '2020-10-03T10:00:00.000Z', message: msg.message })
  const userItem = (items: TranscriptItem[]) => items.find((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')!

  test('a picture sent inline with its line shows once, and no line shows', () => {
    const sent = createMediaCache(join(temp('sent'), 'media'))
    const msg = buildUserMessage({ text: 'look at this', images: [ref(png(800, 600, 1), 'shot.png')] }, undefined, sent)
    const item = userItem(historyToItems([record(msg)], { media: sent }))
    expect(item.text).toBe('look at this')
    expect(item.images).toHaveLength(1)
    // Read where the cached file is gone (another PC, a cleared cache): the inline copy still stands for it.
    rmSync(sent.dir, { recursive: true, force: true })
    const elsewhere = userItem(historyToItems([record(msg)], { media: createMediaCache(join(temp('elsewhere'), 'media')) }))
    expect(elsewhere).toMatchObject({ text: 'look at this', images: [expect.objectContaining({ mediaType: 'image/png' })] })
    expect(elsewhere.images).toHaveLength(1)
  })

  test('pictures sent as files only show as pictures, without the note', () => {
    const media = createMediaCache(join(temp('files-only'), 'media'))
    const many = Array.from({ length: 12 }, (_, i) => ref(png(640, 480, i)))
    const batch = buildUserMessage({ text: 'twelve', images: many }, undefined, media)
    const mixed = buildUserMessage({ text: 'one big', images: [ref(png(900, 700, 40)), ref(png(4000, 3000, 41))] }, undefined, media)
    const items = historyToItems([record(batch), record(mixed)], { media }).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')
    expect(items.map((i) => [i.text, i.images?.length])).toEqual([
      ['twelve', 12],
      ['one big', 2],
    ])
  })
})
