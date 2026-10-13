import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { emptyDoc, renderHydra } from '../src/hydra-core/hydra-md'
import { chatPaths } from '../src/hydra-core/paths'
import { answer, scope } from '../src/hydra-core/tree'
import { scratch, startChat } from './hydra-core-fixture'

let dir = ''
const chat = 'chat-example-tree'
const now = new Date('2026-10-13T10:00:00.000Z')

beforeEach(() => {
  dir = scratch()
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

test('a full run walks q1 to q9 and writes hydra.md with the lead, the knowledge and the plan', () => {
  startChat(dir, chat, 'Rebuild the dashboard layout')
  const first = scope(dir, chat, now)
  expect(first).toMatchObject({ run: 1, step: 'q1', context: { hydraMd: { exists: false } } })
  expect(answer(dir, chat, { answer: 'yes: rebuild the dashboard layout' }, now)).toMatchObject({
    step: 'q3',
  })
  expect(answer(dir, chat, { answer: 'delegate' }, now)).toMatchObject({ step: 'q4' })
  expect(answer(dir, chat, { answer: '3' }, now)).toMatchObject({ step: 'q5' })
  expect(answer(dir, chat, { answer: '2' }, now)).toMatchObject({ step: 'q6' })
  const q6 = answer(dir, chat, { answer: 'dashboard' }, now)
  expect(q6).toMatchObject({ step: 'q6pick' })
  expect(q6.matches).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'person:iris-ui', n: 1 })]),
  )
  expect(answer(dir, chat, { answer: '1' }, now)).toMatchObject({ step: 'q7' })
  expect(answer(dir, chat, { answer: 'none' }, now)).toMatchObject({ step: 'q8' })
  expect(answer(dir, chat, { answer: 'dashboard' }, now)).toMatchObject({ step: 'q8pick' })
  expect(answer(dir, chat, { answer: '1' }, now)).toMatchObject({ step: 'q9' })
  const done = answer(
    dir,
    chat,
    { answer: 'Lay out the grid, then test it with two visitors.' },
    now,
  )
  expect(done).toMatchObject({ verdict: 'hydra' })

  const md = readFileSync(chatPaths(dir, chat).hydraMd, 'utf8')
  expect(md).toContain('Updated: 2026-10-13T10:00:00.000Z  Tier: 3  Team: 2')
  expect(md).toContain('## Lead (become)\nIris Example - UI designer. Full text: ')
  expect(md).toContain(
    '## Knowledge\n- knowledge:brand-notes - Colours and type rules for the dashboard; ',
  )
  expect(md).toContain('## Plan\nLay out the grid, then test it with two visitors.')
  expect(md).toContain(
    '- 2026-10-13T10:00:00.000Z "Rebuild the dashboard layout" -> hydra (q1 yes; q3 delegate; q4 tier; q5 team; q6 lead; q6pick picks; q7 none; q8 need; q8pick picks; q9 plan)',
  )
})

test('no needs nothing more: the verdict is go and no hydra.md is written', () => {
  startChat(dir, chat, 'Fix the typo')
  scope(dir, chat, now)
  expect(answer(dir, chat, { answer: 'no' }, now)).toMatchObject({
    verdict: 'go',
    say: 'Go do it.',
  })
  expect(existsSync(chatPaths(dir, chat).hydraMd)).toBe(false)
  expect(() => answer(dir, chat, { answer: 'no' }, now)).toThrow('no run for this chat')
})

test('myself with no hydra.md writes nothing and returns the go verdict', () => {
  startChat(dir, chat, 'Fix the typo')
  scope(dir, chat, now)
  answer(dir, chat, { answer: 'yes: fix the typo in the readme' }, now)
  expect(answer(dir, chat, { answer: 'myself' }, now)).toMatchObject({ verdict: 'go', picks: [] })
  expect(existsSync(chatPaths(dir, chat).hydraMd)).toBe(false)
})

test('an unreadable answer gets one retry with an example, then the fallback applies', () => {
  startChat(dir, chat, 'Rebuild the dashboard layout')
  scope(dir, chat, now)
  const retry = answer(dir, chat, { answer: 'maybe' }, now)
  expect(retry).toMatchObject({ step: 'q1' })
  expect(String(retry.retry)).toContain('Example:')
  expect(answer(dir, chat, { answer: 'maybe' }, now)).toMatchObject({ step: 'q3' })
})

test('with an existing hydra.md, q2 mid adds the picks and appends a scope line', () => {
  startChat(dir, chat, 'Add a footer')
  mkdirSync(chatPaths(dir, chat).root, { recursive: true })
  writeFileSync(chatPaths(dir, chat).hydraMd, renderHydra(emptyDoc(new Date(0))))
  expect(scope(dir, chat, now).context).toMatchObject({ hydraMd: { exists: true } })
  expect(answer(dir, chat, { answer: 'yes: a footer' }, now)).toMatchObject({ step: 'q2' })
  expect(answer(dir, chat, { answer: 'mid' }, now)).toMatchObject({ verdict: 'go', added: [] })
  expect(readFileSync(chatPaths(dir, chat).hydraMd, 'utf8')).toContain('-> go (q1 yes; q2 mid)')
})

test("q1 offers a folder's main rules entry and counts its other rules instead of listing them", () => {
  const repo = join(dir, 'example-repo')
  const rule = (n: number) => ({
    id: `knowledge:rule-example-${n}`,
    kind: 'knowledge',
    name: `Example rule ${n}`,
    when: `Rule ${n} for the example repo`,
    tags: ['rule'],
    cost: 'free',
    how: `read rule ${n}`,
    folders: [repo],
    load: { type: 'none' },
  })
  const main = {
    ...rule(0),
    id: 'knowledge:repo-example',
    name: 'Example repo rules',
    tags: ['repo', 'rules'],
  }
  writeFileSync(
    join(dir, 'catalog', 'hand-folder.json'),
    JSON.stringify([rule(1), rule(2), rule(3), rule(4), main]),
  )
  startChat(dir, chat, 'why is the signup page slow?')
  writeFileSync(chatPaths(dir, chat).cwd, join(repo, 'web'))
  const context = scope(dir, chat, now).context as {
    folderKnowledge: { id: string }[]
    folderMore?: { count: number; find: string }
  }
  expect(context.folderKnowledge.map((e) => e.id)).toEqual(['knowledge:repo-example'])
  expect(context.folderMore?.count).toBe(4)
  expect(context.folderMore?.find).toContain('core_find')
})
