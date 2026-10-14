import { afterEach, beforeEach, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packFor, TOTAL_CAP } from '../src/hydra-core/pack'
import { scratch } from './hydra-core-fixture'

const CWD = 'C:/Users/me/project'
const CHAT = 'chat-example-owner'
const NOTE = 'Example Owner runs the example-shop repositories, keys and servers.'
const now = new Date('2026-10-14T10:00:00.000Z')
let dir = ''

beforeEach(() => {
  dir = scratch()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function pack(session: string): string {
  return packFor(dir, { chat: CHAT, session, cwd: CWD, prompt: 'check the deploy script' }, now)
    .text
}

test('a present owner-context file is attached once, at the top of the pack', () => {
  writeFileSync(join(dir, 'owner-context.md'), `${NOTE}\n`)
  const text = pack('session-example-a')
  expect(text.split(NOTE).length - 1).toBe(1)
  expect(
    text.startsWith(`Hydra Core attached for this chat and message:\n\nOwner context:\n\n${NOTE}`),
  ).toBe(true)
})

test('an absent or blank owner-context file leaves the pack exactly as before', () => {
  const absent = pack('session-example-a')
  expect(absent).not.toContain('Owner context')
  writeFileSync(join(dir, 'owner-context.md'), ' \n\n')
  expect(pack('session-example-b')).toBe(absent)
})

test('an oversized owner-context file is cut to the cap with a marker', () => {
  writeFileSync(join(dir, 'owner-context.md'), `${'x'.repeat(5000)}\nTAIL-MARK\n`)
  const text = pack('session-example-a')
  expect(text).toMatch(/\[cut at \d+ of \d+ characters; the rest is in owner-context\.md\]/)
  expect(text).not.toContain('TAIL-MARK')
  expect(text).not.toContain('x'.repeat(2001))
  expect(text.length).toBeLessThanOrEqual(TOTAL_CAP)
})
