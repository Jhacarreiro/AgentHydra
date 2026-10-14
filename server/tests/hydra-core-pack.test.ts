import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { FOLDER_CAP, packFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { scratch } from './hydra-core-fixture'

const CWD = 'C:/Users/me/project'
let dir = ''

beforeEach(() => {
  dir = scratch()
  const rules = join(dir, 'project-rules.md')
  const side = join(dir, 'side-rules.md')
  writeFileSync(rules, 'PROJECT RULE TEXT\n')
  writeFileSync(side, 'SIDE RULE TEXT\n')
  const folder = [
    {
      id: 'knowledge:project-rules',
      kind: 'knowledge',
      name: 'Project Rules',
      when: 'Working rules for the project',
      tags: ['repo'],
      folders: [CWD],
      cost: 'free',
      how: 'read the project rules',
      load: { type: 'file', path: rules },
    },
    {
      id: 'knowledge:side-rules',
      kind: 'knowledge',
      name: 'Side Rules',
      when: 'Notes that only sometimes apply',
      tags: [],
      folders: [CWD],
      cost: 'free',
      how: 'read the side rules',
      load: { type: 'file', path: side },
    },
  ]
  writeFileSync(join(dir, 'catalog', 'hand-folder.json'), JSON.stringify(folder))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const req = (prompt: string, extra: { session?: string; full?: boolean } = {}) => ({
  chat: 'chat-1',
  session: extra.session ?? 'sess-1',
  cwd: CWD,
  prompt,
  ...(extra.full ? { full: true } : {}),
})

test('the first pack has the folder rules, the matching knowledge in full, and the closing line', () => {
  const pack = packFor(dir, req('redo the brand colours on the dashboard'))
  expect(pack.mode).toBe('first')
  expect(pack.text).toContain('PROJECT RULE TEXT')
  expect(pack.text).not.toContain('SIDE RULE TEXT')
  expect(pack.text).toContain('Brand notes: full text.')
  expect(pack.text).toContain('core_find { need: "<what you need>", chat: "chat-1" }')
  expect(pack.ids).toContain('knowledge:project-rules')
  expect(pack.ids).toContain('knowledge:brand-notes')
  expect(pack.bytes).toBe(Buffer.byteLength(pack.text, 'utf8'))
  expect(pack.ms).toBeGreaterThanOrEqual(0)
})

test('a repeated message in the same session sends only what was not sent before', () => {
  packFor(dir, req('redo the brand colours on the dashboard'))
  const again = packFor(dir, req('brand colours again'))
  expect(again.mode).toBe('delta')
  expect(again.text).toBe('')
  expect(again.ids).toEqual([])
  expect(again.text).not.toContain('PROJECT RULE TEXT')
  expect(again.text).not.toContain('core_find')
})

test('a delta carries only the new matches, under the delta header, with no closing line', () => {
  packFor(dir, req('redo the brand colours on the dashboard'))
  const next = packFor(dir, req('take a screenshot of the page'))
  expect(next.mode).toBe('delta')
  expect(next.text.startsWith('Hydra Core, new for this message:')).toBe(true)
  expect(next.text).toContain('instrument:screen-capture')
  expect(next.text).not.toContain('PROJECT RULE TEXT')
  expect(next.text).not.toContain('More is one core_find')
  expect(next.ids).not.toContain('knowledge:project-rules')
})

test('a new session is a first pack again, and a full request resends the folder rules', () => {
  packFor(dir, req('brand colours'))
  expect(packFor(dir, req('brand colours', { session: 'sess-2' })).mode).toBe('first')
  const full = packFor(dir, req('brand colours', { full: true }))
  expect(full.mode).toBe('full')
  expect(full.text).toContain('PROJECT RULE TEXT')
  expect(full.text).toContain('core_find')
})

test('the folder rules and the lead are capped and the cut is named', () => {
  writeFileSync(join(dir, 'big-rules.md'), 'x'.repeat(40 * 1024))
  writeFileSync(
    join(dir, 'catalog', 'hand-big.json'),
    JSON.stringify([
      {
        id: 'knowledge:big-rules',
        kind: 'knowledge',
        name: 'Big Rules',
        when: 'Very long rules',
        tags: ['repo'],
        folders: [CWD],
        cost: 'free',
        how: 'read them',
        load: { type: 'file', path: join(dir, 'big-rules.md') },
      },
    ]),
  )
  const pack = packFor(dir, req('hello'))
  expect(pack.text).toContain('[cut at')
  expect(Buffer.byteLength(pack.text, 'utf8')).toBeLessThan(FOLDER_CAP + 4096)
})

test('a pack is logged with its mode, ids, bytes and time', () => {
  packFor(dir, req('redo the brand colours'))
  const line = readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').at(-1) ?? ''
  const entry = JSON.parse(line)
  expect(entry).toMatchObject({ event: 'pack', chat: 'chat-1', session: 'sess-1', mode: 'first' })
  expect(entry.ids).toContain('knowledge:project-rules')
  expect(typeof entry.bytes).toBe('number')
  expect(typeof entry.ms).toBe('number')
})

test('the sent record lives beside the chat and lists each session', () => {
  packFor(dir, req('brand colours'))
  const sent = JSON.parse(readFileSync(chatPaths(dir, 'chat-1').sent, 'utf8'))
  expect(Object.keys(sent)).toEqual(['sess-1'])
  expect(sent['sess-1']).toContain('knowledge:project-rules')
  expect(existsSync(join(dir, 'chats', 'chat-1', 'sent.json'))).toBe(true)
})

test('a message with nothing matching and no folder rules sends the closing line only', () => {
  const pack = packFor(dir, { ...req('zzz qqq'), cwd: 'C:/Users/other' })
  expect(pack.mode).toBe('first')
  expect(pack.ids).toEqual([])
  expect(pack.text).toContain('core_find')
})
