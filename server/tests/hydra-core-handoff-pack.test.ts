// server/tests/hydra-core-handoff-pack.test.ts - what a new session's pack carries from the chat it continues (its
// seats and consults), where long folder rules are cut, and which id a hydra.md lead is logged under.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { packFor } from '../src/hydra-core/pack'
import { chatPaths } from '../src/hydra-core/paths'
import { placeChat } from '../src/hydra-core/placement'
import { scratch } from './hydra-core-fixture'

const T = new Date('2019-10-24T09:00:00Z')
const CWD = 'C:/Users/me/app'
const ID_SHAPE = /^(?:person|instrument|worker|knowledge|skill):[a-z0-9-]+$/

let dir = ''

beforeEach(() => {
  dir = scratch()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const slotReq = (chat: string, session: string) => ({
  chat,
  session,
  fresh: true,
  cwd: CWD,
  prompt: 'where are we, what is next?',
  placement: 'slot' as const,
})

describe("a new session's pack carries no seat or consult lines without the people add-on", () => {
  test('files left in the chat folder are not read into the pack', () => {
    const files = chatPaths(dir, 'consulting')
    mkdirSync(files.root, { recursive: true })
    writeFileSync(
      join(files.root, 'consults.json'),
      JSON.stringify({ 'person:example-one': 'w-0a1b2c3d' }),
    )
    writeFileSync(
      files.seats,
      JSON.stringify({ 'person:example-two': { chat: 'desk-9', title: 'Seat' } }),
    )
    const text = placeChat(dir, slotReq('consulting', 'new-session'), T).text
    expect(text).not.toContain('w-0a1b2c3d')
    expect(text).not.toContain('desk-9')
    expect(
      packFor(dir, { chat: 'consulting', session: 's2', cwd: CWD, prompt: 'where are we?' }, T)
        .text,
    ).not.toContain('core_use { chat: "consulting"')
  })

  test('a chat with no seats and no consults gets no consult lines', () => {
    const text = placeChat(dir, slotReq('quiet', 'new-session'), T).text
    expect(text).not.toContain('Consults')
    expect(text).not.toContain('Seats in this chat')
  })
})

describe('folder rules are cut at a line or heading, and say so (C1 finding 5)', () => {
  test('a cut never ends mid-word and names the headings it left out', () => {
    const rules = join(dir, 'long-rules.md')
    const sections = Array.from({ length: 40 }, (_, i) =>
      [
        `## Section ${i + 1}`,
        ...Array.from(
          { length: 12 },
          (_, j) => `Rule ${i + 1}.${j + 1}: keep arithmetic plain and every word whole here.`,
        ),
      ].join('\n'),
    )
    const body = sections.join('\n\n')
    writeFileSync(rules, body)
    writeFileSync(
      join(dir, 'catalog', 'hand-long.json'),
      JSON.stringify([
        {
          id: 'knowledge:long-rules',
          kind: 'knowledge',
          name: 'Long Rules',
          when: 'Long folder rules',
          tags: ['repo'],
          folders: [CWD],
          cost: 'free',
          how: 'read them',
          load: { type: 'file', path: rules },
        },
      ]),
    )
    const pack = packFor(dir, { chat: 'c', session: 's', cwd: CWD, prompt: 'hello' }, T)
    const at = pack.text.indexOf('\n[cut at')
    expect(at).toBeGreaterThan(0)
    const kept = pack.text.slice(0, at)
    const last = kept.split('\n').at(-1) ?? ''
    const sourceLines = new Set(body.split('\n'))
    // The kept text ends on a whole line of the file (or the blank line before a heading).
    expect(last === '' || sourceLines.has(last)).toBe(true)
    const note = pack.text.slice(at).split('\n')[1] ?? ''
    // The first heading left out is the one right after the cut; a long tail is counted, not listed.
    const shown = kept.trimEnd().split('\n').at(-1) ?? ''
    const next = body.slice(body.indexOf(shown) + shown.length).match(/^## .+$/m)?.[0]
    expect(next).toBeDefined()
    expect(note).toContain(`left out: ${next}`)
    expect(note).toMatch(/ and \d+ more;/)
    expect(note).toContain(`the rest is in ${rules}`)
  })
})

describe('a hydra.md lead is logged under a catalog-shaped id (C5 finding 6)', () => {
  const leadMd = (name: string, path: string) =>
    `# hydra.md\n## Lead (become)\n${name} - Planner. Full text: ${path}\n## Scope log\n`

  test('a manager lead missing from the catalog takes its person id from the brief folder', () => {
    const brief = join(dir, 'managers', 'pat-planner', 'brief.md')
    mkdirSync(join(dir, 'managers', 'pat-planner'), { recursive: true })
    writeFileSync(brief, 'Pat Example: the planner brief.\n')
    const files = chatPaths(dir, 'led')
    mkdirSync(files.root, { recursive: true })
    writeFileSync(files.hydraMd, leadMd('Pat', brief))
    const pack = packFor(dir, { chat: 'led', session: 's', cwd: CWD, prompt: 'plan it' }, T)
    expect(pack.text).toContain('Pat Example: the planner brief.')
    expect(pack.lead).toBe('person:pat-planner')
    expect(pack.ids).toContain('person:pat-planner')
    for (const id of pack.ids) expect(id).toMatch(ID_SHAPE)
  })

  test('a lead with no catalog entry and no manager folder logs no made-up id', () => {
    const brief = join(dir, 'loose-brief.md')
    writeFileSync(brief, 'Loose Example: a brief outside any manager folder.\n')
    const files = chatPaths(dir, 'loose')
    mkdirSync(files.root, { recursive: true })
    writeFileSync(files.hydraMd, leadMd('Loose', brief))
    const pack = packFor(dir, { chat: 'loose', session: 's', cwd: CWD, prompt: 'plan it' }, T)
    expect(pack.text).toContain('Loose Example: a brief outside any manager folder.')
    expect(pack.lead).toBeNull()
    for (const id of pack.ids) expect(id).toMatch(ID_SHAPE)
    const placed = placeChat(dir, slotReq('loose', 'n'), T)
    for (const id of placed.ids) expect(id).toMatch(ID_SHAPE)
  })
})
