import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TranscriptItem } from '@shared/protocol'
import { ChatStore } from '../src/engine/store'

const fixtures: Array<{ home: string; store: ChatStore }> = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'chat-store-lines-'))
  const store = new ChatStore(home)
  fixtures.push({ home, store })
  return { home, store, file: store.itemsFile('example-chat') }
}
function removeScratch(home: string) {
  const target = resolve(home)
  if (
    !target.startsWith(resolve(tmpdir()) + sep) ||
    !basename(target).startsWith('chat-store-lines-')
  )
    throw new Error('Refusing unexpected scratch cleanup')
  rmSync(target, { recursive: true, force: true })
}
afterEach(async () => {
  for (const { home, store } of fixtures.splice(0)) {
    await store.settledItems()
    store.flush()
    await store.settled()
    removeScratch(home)
  }
})

const item = (id: string, text: string): TranscriptItem => ({
  kind: 'assistant_text',
  id,
  ts: 1,
  text,
})
const line = (id: string, text: string) => JSON.stringify(item(id, text))

test('owned raw lines retain first-seen order and last valid values across appends and torn tails', () => {
  const { store, file } = fixture()
  writeFileSync(
    file,
    [
      line('a', 'old'),
      line('b', 'initial'),
      '{malformed',
      line('a', 'latest'),
      '{"id":5}',
      line('c', 'tail'),
    ].join('\n'),
  )
  const first = store.loadItems('example-chat')
  expect(first).toEqual([item('a', 'latest'), item('b', 'initial'), item('c', 'tail')])
  ;(first[0] as Extract<TranscriptItem, { kind: 'assistant_text' }>).text = 'Caller edit'
  expect(store.loadItems('example-chat')[0]).toEqual(item('a', 'latest'))
  appendFileSync(
    file,
    '\n' + [line('b', 'updated'), line('d', 'new'), line('a', 'newest'), '{"id":'].join('\n'),
  )
  expect(store.loadItems('example-chat')).toEqual([
    item('a', 'newest'),
    item('b', 'updated'),
    item('c', 'tail'),
    item('d', 'new'),
  ])
  expect(store.loadItems('example-chat')).toEqual([
    item('a', 'newest'),
    item('b', 'updated'),
    item('c', 'tail'),
    item('d', 'new'),
  ])
})

test('file replacement, removal and pending updates preserve Unicode, raw escapes and overlay order', async () => {
  const { store, file } = fixture()
  const text =
    'Synthetic é🙂 ' + String.fromCharCode(0xd800) + ' end ' + String.fromCharCode(0xdc00)
  writeFileSync(file, line('a', 'old') + '\n' + line('b', 'old') + '\n')
  store.loadItems('example-chat')
  writeFileSync(file, line('a', text) + '\n')
  expect(store.loadItems('example-chat')).toEqual([item('a', text)])
  const invalid = Buffer.from([0xed, 0xa0, 0x80, 0xff])
  writeFileSync(
    file,
    Buffer.concat([
      Buffer.from('{"kind":"assistant_text","id":"a","ts":1,"text":"'),
      invalid,
      Buffer.from('"}\n'),
    ]),
  )
  expect(store.loadItems('example-chat')).toEqual([item('a', invalid.toString('utf8'))])
  store.appendItem('example-chat', item('a', 'Pending ' + text))
  store.appendItem('example-chat', item('c', 'New pending'))
  expect(store.loadItems('example-chat')).toEqual([
    item('a', 'Pending ' + text),
    item('c', 'New pending'),
  ])
  await store.settledItems()
  expect(store.loadItems('example-chat')).toEqual([
    item('a', 'Pending ' + text),
    item('c', 'New pending'),
  ])
  store.deleteChat('example-chat')
  expect(store.loadItems('example-chat')).toEqual([])
})

test('only superseded-version-heavy chunks copy final winners; unique reads, valid tails and cache hits stay uncopied', async () => {
  const { home } = fixture()
  const source = JSON.stringify(
    pathToFileURL(resolve(import.meta.dir, '../src/engine/store.ts')).href,
  )
  const child = Bun.spawn(
    [
      process.execPath,
      '-e',
      `
    import { spyOn } from 'bun:test'
    import * as fs from 'node:fs'
    const { ChatStore } = await import(${source})
    const store = new ChatStore(${JSON.stringify(home)})
    const path = store.itemsFile('copy-fixture')
    const text = 'x'.repeat(64 * 1024)
    const line = (id, suffix) => JSON.stringify({ kind: 'assistant_text', id, ts: 1, text: text + suffix })
    fs.writeFileSync(path, Array.from({ length: 128 }, (_, i) => line('a', String(i))).join('\\n') + '\\n' + line('b', 'tail'))
    const from = Buffer.from
    let copies = 0, copiedChars = 0
    const copy = spyOn(Buffer, 'from').mockImplementation((value, ...args) => {
      if (typeof value === 'string' && args[0] === 'utf8') { copies++; copiedChars += value.length }
      return from(value, ...args)
    })
    try {
      const first = store.loadItems('copy-fixture')
      const initial = { copies, copiedChars }
      if (first.length !== 2 || !first[0].text.endsWith('127') || !first[1].text.endsWith('tail')) throw new Error('Wrong initial winners')
      store.loadItems('copy-fixture')
      const hit = copies
      const unique = store.itemsFile('unique-fixture')
      fs.writeFileSync(unique, Array.from({ length: 128 }, (_, i) => line('unique-' + i, String(i))).join('\\n') + '\\n')
      if (store.loadItems('unique-fixture').length !== 128) throw new Error('Unique items were lost')
      const uniqueCopies = copies
      store.loadItems('unique-fixture')
      const uniqueHitCopies = copies
      fs.appendFileSync(path, '\\n' + Array.from({ length: 64 }, (_, i) => line('a', String(i))).join('\\n') + '\\n')
      const next = store.loadItems('copy-fixture')
      if (next.length !== 2 || !next[0].text.endsWith('63') || !next[1].text.endsWith('tail')) throw new Error('Wrong incremental winners')
      const totalCopies = copies, totalCopiedChars = copiedChars
      const unicode = 'Synthetic é🙂 ' + String.fromCharCode(0xd800) + ' end ' + String.fromCharCode(0xdc00)
      const encodedPath = store.itemsFile('encoded-fixture')
      const encodedLine = JSON.stringify({ kind: 'assistant_text', id: 'encoded', ts: 1, text: unicode })
      fs.writeFileSync(encodedPath, (encodedLine + '\\n').repeat(4))
      const beforeUnicode = copies
      const encoded = store.loadItems('encoded-fixture')
      const unicodeCopies = copies - beforeUnicode
      if (encoded.length !== 1 || encoded[0].text !== unicode) throw new Error('Copied Unicode code units changed')
      const rawUnicodeExact = store.lineCache.get(encodedPath).lines.get('encoded') === encodedLine
      const bad = Buffer.concat([
        Buffer.from('{"kind":"assistant_text","id":"invalid","ts":1,"text":"'),
        Buffer.from([0xed, 0xa0, 0x80, 0xff]), Buffer.from('"}\\n')
      ])
      const invalidPath = store.itemsFile('invalid-fixture')
      fs.writeFileSync(invalidPath, Buffer.concat(Array(4).fill(bad)))
      const beforeInvalid = copies
      const invalid = store.loadItems('invalid-fixture')
      const invalidCopies = copies - beforeInvalid
      if (invalid.length !== 1 || invalid[0].text !== Buffer.from([0xed, 0xa0, 0x80, 0xff]).toString('utf8')) throw new Error('Copied replacement characters changed')
      const rawInvalidExact = store.lineCache.get(invalidPath).lines.get('invalid') === bad.toString('utf8').slice(0, -1)
      console.log(JSON.stringify({ initial, hit, uniqueCopies, uniqueHitCopies, totalCopies, copiedChars: totalCopiedChars,
        unicodeCopies, invalidCopies, rawUnicodeExact, rawInvalidExact }))
    } finally { copy.mockRestore() }
  `,
    ],
    {
      cwd: resolve(import.meta.dir, '..'),
      env: { ...process.env, HYDRA_DESK_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
      windowsHide: true,
      timeout: 15_000,
    },
  )
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (code !== 0) throw new Error(`Synthetic line ownership fixture failed: ${err || out}`)
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
    initial: { copies: number; copiedChars: number }
    hit: number
    uniqueCopies: number
    uniqueHitCopies: number
    totalCopies: number
    copiedChars: number
    unicodeCopies: number
    invalidCopies: number
    rawUnicodeExact: boolean
    rawInvalidExact: boolean
  }
  expect(result.initial.copies).toBe(1)
  expect(result.initial.copiedChars).toBeLessThan(66 * 1024)
  expect(result.hit).toBe(1)
  expect(result.uniqueCopies).toBe(1)
  expect(result.uniqueHitCopies).toBe(1)
  // The old valid tail is re-read with the appended changed record, once each.
  expect(result.totalCopies).toBe(3)
  expect(result.copiedChars).toBeLessThan(198 * 1024)
  expect(result.unicodeCopies).toBe(1)
  expect(result.invalidCopies).toBe(1)
  expect(result.rawUnicodeExact).toBe(true)
  expect(result.rawInvalidExact).toBe(true)
}, 20_000)
