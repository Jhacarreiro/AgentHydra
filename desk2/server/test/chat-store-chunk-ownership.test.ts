import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { TranscriptItem } from '@shared/protocol'
import { ChatStore } from '../src/engine/store'

const homes: string[] = []
function fixture() {
  const home = mkdtempSync(join(tmpdir(), 'chat-store-owner-'))
  homes.push(home)
  return { home, store: new ChatStore(home) }
}
afterEach(() => {
  for (const home of homes.splice(0)) {
    const target = resolve(home)
    if (
      !target.startsWith(resolve(tmpdir()) + sep) ||
      !basename(target).startsWith('chat-store-owner-')
    )
      throw new Error('Refusing unexpected scratch cleanup')
    rmSync(target, { recursive: true, force: true })
  }
})
const item = (id: string, text: string): TranscriptItem => ({
  kind: 'assistant_text',
  id,
  ts: 1,
  text,
})
const line = (id: string, text: string) => JSON.stringify(item(id, text)) + '\n'

test('later appends detach only the old chunk survivors, keep ownership bounded and skip owner work on cache hits', async () => {
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
    const path = store.itemsFile('owner-fixture')
    const unicode = 'é🙂 ' + String.fromCharCode(0xd800) + ' end ' + String.fromCharCode(0xdc00)
    const original = i => 'Original-' + i + '-' + unicode + 'x'.repeat(40 * 1024)
    const line = (i, text) => JSON.stringify({ kind: 'assistant_text', id: 'item-' + i, ts: 1, text }) + '\\n'
    fs.writeFileSync(path, Array.from({ length: 32 }, (_, i) => line(i, original(i))).join(''))
    const from = Buffer.from, get = WeakMap.prototype.get, del = WeakMap.prototype.delete, set = WeakMap.prototype.set
    let copies = 0, copiedChars = 0, lookups = 0, ownerDrops = 0, lines, owners
    const ownerSets = []
    const copySpy = spyOn(Buffer, 'from').mockImplementation((value, ...args) => {
      if (typeof value === 'string' && args[0] === 'utf8') { copies++; copiedChars += value.length }
      return from(value, ...args)
    })
    const getSpy = spyOn(WeakMap.prototype, 'get').mockImplementation(function(key) {
      const value = get.call(this, key)
      if (key === lines) { lookups++; owners = value }
      return value
    })
    const deleteSpy = spyOn(WeakMap.prototype, 'delete').mockImplementation(function(key) {
      if (key === lines) ownerDrops++
      return del.call(this, key)
    })
    const setSpy = spyOn(WeakMap.prototype, 'set').mockImplementation(function(key, value) {
      if (key instanceof Map && value instanceof Map) ownerSets.push(key)
      return set.call(this, key, value)
    })
    const assert = (value, message) => { if (!value) throw new Error(message) }
    const values = () => store.loadItems('owner-fixture')
    try {
      values()
      lines = store.lineCache.get(path).lines
      assert(copies === 0, 'A unique initial chunk was copied')
      values()
      assert(lookups === 0 && copies === 0, 'A cache hit walked ownership')
      fs.appendFileSync(path, Array.from({ length: 8 }, (_, i) => line(i + 1, 'Updated-' + (i + 1))).join(''))
      values()
      assert(copies === 0, 'A still-mostly-current chunk was copied')
      assert(owners.size === 24 && [...new Set(owners.values())].every(chunk =>
        Object.keys(chunk).sort().join(',') === 'chars,ids,kept' && Array.isArray(chunk.ids)), 'Owner retained unexpected data')
      fs.appendFileSync(path, Array.from({ length: 23 }, (_, i) => line(i + 9, 'Updated-' + (i + 9))).join(''))
      const updated = values()
      assert(copies === 1 && copiedChars < 42 * 1024, 'Copied anything except the old remaining line')
      assert(updated.length === 32 && updated[0].text === original(0), 'Old survivor changed')
      assert(updated.every((row, i) => row.id === 'item-' + i && (i === 0 || row.text === 'Updated-' + i)), 'Order or newer-owner values changed')
      const chunks = new Set(owners.values())
      const ownership = { entries: owners.size, chunks: chunks.size,
        sourceChars: [...chunks].reduce((sum, chunk) => sum + chunk.chars, 0) }
      assert(ownership.entries === 0 && ownership.chunks === 0 && ownerDrops === 1, 'Obsolete chunk bookkeeping stayed live')
      const beforeHit = { copies, lookups }
      values()
      assert(copies === beforeHit.copies && lookups === beforeHit.lookups, 'A hit touched owner metadata')
      // A duplicate-heavy replacement batch owns all new values outright. Its
      // old owners and ID arrays must leave the weak bookkeeping immediately.
      fs.appendFileSync(path, Array.from({ length: 32 }, (_, i) => [line(i, 'Earlier-' + i), line(i, 'Earlier-' + i), line(i, 'Final-' + i)].join('')).join(''))
      const final = values()
      assert(final.every((row, i) => row.id === 'item-' + i && row.text === 'Final-' + i), 'Final duplicate winners changed')
      assert(copies === 33 && ownerDrops === 1 && !owners, 'Retired owners or wrong-copy count')
      const shortPath = store.itemsFile('short-fixture')
      fs.writeFileSync(shortPath, Array.from({ length: 20000 }, (_, i) => line(i, 'Short-' + i + '-' + 'x'.repeat(128))).join(''))
      assert(store.loadItems('short-fixture').length === 20000, 'Short records were lost')
      const shortLines = store.lineCache.get(shortPath).lines
      const shortOwnerEntries = ownerSets.includes(shortLines) ? -1 : 0
      assert(shortOwnerEntries === 0 && copies === 33, 'Low-value short records gained metadata or copies')
      lines = shortLines; lookups = 0
      store.loadItems('short-fixture')
      assert(lookups === 0 && copies === 33, 'Short-record cache hit touched ownership')
      console.log(JSON.stringify({ initialCopies: 0, survivorCopies: beforeHit.copies, ownership, hitOwnerReads: 0, finalCopies: copies, ownerDrops, shortOwnerEntries }))
    } finally { setSpy.mockRestore(); deleteSpy.mockRestore(); getSpy.mockRestore(); copySpy.mockRestore() }
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
  if (code !== 0) throw new Error(`Synthetic chunk ownership fixture failed: ${err || out}`)
  const result = JSON.parse(out.trim().split('\n').at(-1)!) as {
    initialCopies: number
    survivorCopies: number
    ownership: { entries: number; chunks: number; sourceChars: number }
    hitOwnerReads: number
    finalCopies: number
    ownerDrops: number
    shortOwnerEntries: number
  }
  expect(result.initialCopies).toBe(0)
  expect(result.survivorCopies).toBe(1)
  expect(result.ownership.entries).toBe(0)
  expect(result.ownership.chunks).toBe(0)
  expect(result.ownership.sourceChars).toBeLessThan(8192)
  expect(result.hitOwnerReads).toBe(0)
  expect(result.finalCopies).toBe(33)
  expect(result.ownerDrops).toBe(1)
  expect(result.shortOwnerEntries).toBe(0)
}, 20_000)

test('cache eviction, whole-file replacement and deletion keep owner state separate from the next read', () => {
  const { store } = fixture()
  const path = store.itemsFile('first')
  writeFileSync(path, line('a', 'original a') + line('b', 'original b'))
  store.loadItems('first')
  for (let i = 0; i < 21; i++) {
    const id = 'other-' + i
    writeFileSync(store.itemsFile(id), line('same-id', 'other ' + i))
    expect(store.loadItems(id)).toEqual([item('same-id', 'other ' + i)])
  }
  appendFileSync(path, line('a', 'updated a') + '{malformed\n')
  expect(store.loadItems('first')).toEqual([item('a', 'updated a'), item('b', 'original b')])
  writeFileSync(path, line('c', 'replacement'))
  expect(store.loadItems('first')).toEqual([item('c', 'replacement')])
  store.deleteChat('first')
  expect(store.loadItems('first')).toEqual([])
  writeFileSync(path, line('a', 'created again'))
  expect(store.loadItems('first')).toEqual([item('a', 'created again')])
})
