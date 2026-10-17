// A picture sent into a chat: the Claude chat's model gets its path line beside the inline block while the transcript
// shows the message as typed with the picture once, and every send writes one row per picture to the media cache's
// index (media/picture-index.ts), which never fails the send.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ImageRef, TranscriptItem } from '@shared/protocol'
import { ChatManager } from '../../../src/engine/chat-manager'
import type { PictureRow } from '../../../src/media/picture-index'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { ACCOUNT_68, fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
const oldHome = process.env.HYDRA_DESK_HOME
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (oldHome === undefined) delete process.env.HYDRA_DESK_HOME
  else process.env.HYDRA_DESK_HOME = oldHome
})

async function until(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await new Promise((r) => setTimeout(r, 5))
  expect(ok()).toBe(true)
}

/** An invented PNG header naming its size; `seed` gives each its own bytes. */
function png(width: number, height: number, seed = 0): ImageRef {
  const head = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0)
  head.writeUInt32BE(13, 8)
  head.write('IHDR', 12, 'ascii')
  head.writeUInt32BE(width, 16)
  head.writeUInt32BE(height, 20)
  return { mediaType: 'image/png', dataBase64: Buffer.concat([head, Buffer.alloc(24, seed)]).toString('base64'), name: 'shot.png' }
}

function boot(newChats: 'sdk' | 'climayte') {
  const home = mkdtempSync(join(tmpdir(), 'desk-picture-index-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const cwd = join(home, 'proj')
  mkdirSync(cwd, { recursive: true })
  const q = fakeQueries()
  const b = fakeBridge()
  const bridge = { ...b.bridge, listAccounts: async () => [ACCOUNT_68] }
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => ({ ...DEFAULT_SETTINGS }), bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats })
  managers.push(m)
  const rows = (): PictureRow[] => {
    try {
      return readFileSync(join(home, 'media', 'index.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    } catch {
      return []
    }
  }
  return { m, q, b, home, cwd, rows }
}

const users = (m: ChatManager, id: string) => m.listItems(id).filter((i): i is Extract<TranscriptItem, { kind: 'user' }> => i.kind === 'user')

test('a Claude chat gets the path line beside the picture, shows the message as typed, and indexes it once', async () => {
  const { m, q, cwd, rows } = boot('sdk')
  const shrunk = { ...png(2000, 1125, 1), originalWidth: 3840, originalHeight: 2160 }
  const chat = await m.create({ cwd, prompt: 'what is on this screen?', images: [shrunk], accountId: ACCOUNT_68.id })
  await until(() => q.all.length === 1 && q.last().sent.length === 1)

  const content = q.last().sent[0]!.message.content as { type: string; text?: string }[]
  expect(content.map((c) => c.type)).toEqual(['image', 'text'])
  expect(content[1]!.text).toMatch(/^what is on this screen\?\n\[Image: source: .+[\\/][0-9a-f]{64}\.png\]$/)

  const [item] = users(m, chat.id)
  expect(item).toMatchObject({ text: 'what is on this screen?', images: [expect.objectContaining({ url: expect.stringMatching(/^\/api\/media\//) })] })
  expect(item!.images).toHaveLength(1)

  const [row, ...more] = rows()
  expect(more).toEqual([])
  // The file the line names (read before toMatchObject, which leaves its matchers in what it was given).
  expect(content[1]!.text).toContain(row!.file)
  expect(row).toMatchObject({
    file: expect.stringMatching(/^[0-9a-f]{64}\.png$/),
    width: 2000,
    height: 1125,
    originalWidth: 3840,
    originalHeight: 2160,
    account: ACCOUNT_68.label,
    accountId: ACCOUNT_68.id,
    workspace: cwd,
    chatId: chat.id,
    messageId: item!.id,
    sender: 'owner',
    engine: 'claude',
  })
  expect(typeof row!.pc).toBe('string')
})

test('a worker chat indexes its pictures as the worker’s, the sender a note names, and a broken index never fails the send', async () => {
  const { m, b, cwd, home, rows } = boot('climayte')
  const chat = await m.create({ cwd, prompt: 'first' })
  await until(() => !!m.get(chat.id).workerId)
  await m.send(chat.id, '[Reviewer · Ada] Not from the user. Two pictures of the bug.', [png(800, 600, 1), png(900, 700, 2)])
  expect(b.state.sentToWorker.at(-1)!.text.match(/\[Image: source: /g)).toHaveLength(2)
  expect(rows().map((r) => [r.engine, r.sender, r.width])).toEqual([
    ['worker', 'Reviewer · Ada', 800],
    ['worker', 'Reviewer · Ada', 900],
  ])

  // The index cannot be written (a folder stands in its place): the message goes all the same.
  rmSync(join(home, 'media', 'index.jsonl'))
  mkdirSync(join(home, 'media', 'index.jsonl'))
  await m.send(chat.id, 'one more', [png(640, 480, 3)])
  expect(b.state.sentToWorker.at(-1)!.text).toStartWith('one more\n[Image: source: ')
})
