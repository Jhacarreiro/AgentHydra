// A catalog with no manager person has no lead to offer, so the lead question is skipped.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { answer, scope } from '../src/hydra-core/tree'
import { scratch, startChat } from './hydra-core-fixture'

let dir = ''
const chat = 'chat-example-no-leads'
const now = new Date('2026-10-15T10:00:00.000Z')

beforeEach(() => {
  dir = scratch()
  const file = join(dir, 'catalog', 'hand-fixture.json')
  const entries = JSON.parse(readFileSync(file, 'utf8')) as { family?: string }[]
  writeFileSync(file, JSON.stringify(entries.filter((e) => e.family !== 'manager')))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('with no manager in the catalog the lead question is skipped and no lead is offered', () => {
  startChat(dir, chat, 'pricing numbers for the page')
  scope(dir, chat, now)
  const q = answer(dir, chat, { answer: 'yes 3: pricing numbers for the page' }, now)
  expect(q.step).not.toBe('q6pick')
  const ids = ((q.matches ?? []) as { family?: string }[]).map((m) => m.family)
  expect(ids).not.toContain('manager')
})
