import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyDoc, renderHydra } from '../src/hydra-core/hydra-md'
import { chatPaths } from '../src/hydra-core/paths'
import { answer, scope } from '../src/hydra-core/tree'
import { scratch, startChat } from './hydra-core-fixture'

let dir = ''
const chat = 'chat-example-walt'
const now = new Date('2019-10-22T10:00:00.000Z')

function addGatekeeper(): void {
  writeFileSync(
    join(dir, 'catalog', 'hand-gate.json'),
    JSON.stringify([
      {
        id: 'person:walt-on-task',
        kind: 'person',
        name: 'Gatekeeper Example',
        tier: 'manager',
        family: 'manager',
        when: 'Invented gatekeeper for tests',
        tags: [],
        modes: ['consult'],
        cost: 'low',
        how: 'ask',
        load: { type: 'file', path: join(dir, 'brand-notes.md') },
      },
    ]),
  )
}

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function withDoc(message: string): void {
  startChat(dir, chat, message)
  mkdirSync(chatPaths(dir, chat).root, { recursive: true })
  writeFileSync(chatPaths(dir, chat).hydraMd, renderHydra(emptyDoc(new Date(0))))
}

test('without a gatekeeper in the catalog the big-idea question is skipped', () => {
  withDoc('Add a footer')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: a footer' }, now)
  expect(answer(dir, chat, { answer: 'new' }, now)).toMatchObject({ step: 'q3' })
})

test('after new, the big-idea question is asked; no moves on to q3', () => {
  addGatekeeper()
  withDoc('Add a footer')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: a footer' }, now)
  const q2 = answer(dir, chat, { answer: 'new' }, now)
  expect(q2).toMatchObject({ step: 'q2b' })
  expect(String(q2.question)).toContain('big new idea')
  expect(answer(dir, chat, { answer: 'no' }, now)).toMatchObject({ step: 'q3' })
})

test('yes holds the work and names the gatekeeper; a want-to-do-it message lets the next run go', () => {
  addGatekeeper()
  withDoc('Invent a brand new tide planner')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: a planner' }, now)
  answer(dir, chat, { answer: 'new' }, now)
  const held = answer(dir, chat, { answer: 'yes' }, now)
  expect(held).toMatchObject({ verdict: 'hold', walt: 'person:walt-on-task' })
  expect(existsSync(chatPaths(dir, chat).walt)).toBe(true)
  startChat(dir, chat, 'I want to do it, build it')
  const next: Record<string, unknown> = scope(dir, chat, now)
  expect(String(next.walt)).toContain('may go ahead')
  expect(existsSync(chatPaths(dir, chat).walt)).toBe(false)
  answer(dir, chat, { answer: 'yes: a planner' }, now)
  expect(answer(dir, chat, { answer: 'new' }, now)).toMatchObject({ step: 'q3' })
})

test('a message that does not want it tells the chat to save the idea and stop', () => {
  addGatekeeper()
  withDoc('Invent a brand new tide planner')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: a planner' }, now)
  answer(dir, chat, { answer: 'new' }, now)
  answer(dir, chat, { answer: 'yes' }, now)
  startChat(dir, chat, 'Not now, maybe later')
  const next: Record<string, unknown> = scope(dir, chat, now)
  expect(String(next.walt)).toContain('idea-list')
})
