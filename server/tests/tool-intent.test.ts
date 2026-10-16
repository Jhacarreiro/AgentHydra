import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTools } from '../src/mcp-find'
import { type Embedder, ToolIntent, toolHead, toolText } from '../src/tool-intent'

// A fake model that understands meaning without sharing words: each axis is a concept, and a text
// lights the axes whose words it uses. The asks below share no word with the tool they should find.
const CONCEPTS = [
  ['heavy', 'cluttered', 'screen', 'visitor', 'page', 'costs', 'looking', 'buttons'],
  ['money', 'spend', 'quota', 'left', 'usage', 'remaining', 'allowance'],
  ['reboot', 'restart', 'relaunch', 'daemon', 'service', 'bounce'],
]
const vectorOf = (text: string) => {
  const low = text.toLowerCase()
  return CONCEPTS.map((c) => (c.some((w) => low.includes(w)) ? 1 : 0.01))
}

function fakeEmbedder(log: { query: string[]; passage: string[] } = { query: [], passage: [] }) {
  const e: Embedder = {
    model: 'fake/concepts-v1',
    embed: async (texts, kind) => {
      log[kind].push(...texts)
      return texts.map(vectorOf)
    },
  }
  return { e, log }
}

const tool = (name: string, description: string, props: Record<string, string> = {}) => ({
  name,
  description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(
      Object.entries(props).map(([k, d]) => [k, { type: 'string', description: d }]),
    ),
    required: [],
  },
  run: async () => ({ ran: name }),
})

const TOOLS = [
  tool('price_tag', 'Says what a page costs the person looking at it: words, buttons, fields.', {
    page: 'Which page to price.',
  }),
  tool('check_my_usage', 'Reads how much quota this account has left.'),
  tool('daemon_restart', 'MUTATES: restart the daemon onto new code.'),
  tool('list_chats', 'Lists every chat on this PC.'),
]

const scratch = () => mkdtempSync(join(tmpdir(), 'tool-intent-'))

const hydraFind = (intent: ToolIntent) =>
  findTools(
    () => TOOLS as never,
    () => new Set(['check_my_usage']),
    intent,
  ).find((t) => t.name === 'hydra_find')!.run as (
    a: Record<string, unknown>,
  ) => Promise<{ tools: { name: string }[]; ranking: string; reason?: string }>

describe('toolText', () => {
  test('carries the name as words, the description and every parameter with its description', () => {
    const text = toolText(TOOLS[0] as never)
    expect(text).toContain('price tag')
    expect(text).toContain('what a page costs the person looking')
    expect(text).toContain('page: Which page to price.')
  })
  test('the head is the name as words and the first sentence only, without the MUTATES: tag', () => {
    expect(toolHead(TOOLS[0] as never)).toBe(
      'price tag\nSays what a page costs the person looking at it: words, buttons, fields.',
    )
    expect(toolHead(TOOLS[2] as never)).toBe('daemon restart\nrestart the daemon onto new code.')
  })
})

describe('hydra_find by intent', () => {
  test('an ask that shares no word with a tool still finds it first', async () => {
    const { e } = fakeEmbedder()
    const out = await hydraFind(new ToolIntent(() => e, { dir: scratch() }))({
      query: 'is this screen too cluttered for a visitor',
    })
    expect(out.ranking).toBe('intent+words')
    expect(out.tools[0]?.name).toBe('price_tag')
    const bounce = await hydraFind(new ToolIntent(() => e, { dir: scratch() }))({
      query: 'bounce the background service',
    })
    expect(bounce.tools[0]?.name).toBe('daemon_restart')
  })

  test('without a model it searches by words and says why', async () => {
    const out = await hydraFind(
      new ToolIntent(() => ({ unavailable: 'no model here' }), { dir: scratch() }),
    )({ query: 'restart the daemon' })
    expect(out.ranking).toBe('words')
    expect(out.reason).toContain('no model here')
    expect(out.tools[0]?.name).toBe('daemon_restart')
  })

  test('a model that throws falls back to words and names the error', async () => {
    const broken: Embedder = {
      model: 'fake/broken',
      embed: async () => {
        throw new Error('onnx exploded')
      },
    }
    const out = await hydraFind(new ToolIntent(() => broken, { dir: scratch() }))({
      query: 'restart the daemon',
    })
    expect(out.ranking).toBe('words')
    expect(out.reason).toContain('onnx exploded')
    expect(out.tools[0]?.name).toBe('daemon_restart')
  })

  test('a model still loading answers by words now and by intent once it is ready', async () => {
    let release: (e: Embedder) => void = () => {}
    const ready = new Promise<Embedder>((r) => {
      release = r
    })
    const intent = new ToolIntent(() => ready, { dir: scratch(), waitMs: 20 })
    const first = await hydraFind(intent)({ query: 'restart the daemon' })
    expect(first.ranking).toBe('words')
    expect(first.reason).toContain('loading')
    release(fakeEmbedder().e)
    await intent.warm(TOOLS as never)
    const later = await hydraFind(intent)({ query: 'bounce the background service' })
    expect(later.ranking).toBe('intent+words')
    expect(later.tools[0]?.name).toBe('daemon_restart')
  })
})

describe('the vector cache', () => {
  test('embeds each tool head and whole text once, re-embeds only a changed one, and keeps them on disk', async () => {
    const dir = scratch()
    const { e, log } = fakeEmbedder()
    const intent = new ToolIntent(() => e, { dir })
    // a tool with no parameters and a one-sentence description has a head that is its whole text: embedded once
    const texts = new Set(TOOLS.flatMap((t) => [toolHead(t as never), toolText(t as never)]))
    await intent.search(TOOLS as never, 'quota left')
    expect(log.passage.length).toBe(texts.size)
    expect(new Set(log.passage).size).toBe(texts.size)
    expect(log.query).toEqual(['quota left'])

    await intent.search(TOOLS as never, 'quota left')
    expect(log.passage.length).toBe(texts.size)

    const changed = [
      ...TOOLS.slice(0, 3),
      tool('list_chats', 'Lists every chat on this PC, newest first.'),
    ]
    await intent.search(changed as never, 'quota left')
    expect(log.passage.length).toBe(texts.size + 1)
    expect(log.passage.at(-1)).toContain('newest first')

    expect(existsSync(join(dir, 'fake-concepts-v1.json'))).toBe(true)
    const again = fakeEmbedder()
    await new ToolIntent(() => again.e, { dir }).search(changed as never, 'quota left')
    expect(again.log.passage).toEqual([])
  })

  test('ranks every tool by meaning, closest first', async () => {
    const { e } = fakeEmbedder()
    const out = await new ToolIntent(() => e, { dir: scratch() }).search(
      TOOLS as never,
      'how much allowance is remaining',
    )
    if (!('hits' in out)) throw new Error(out.reason)
    expect(out.hits[0]?.name).toBe('check_my_usage')
    expect(out.hits.length).toBe(TOOLS.length)
  })
})
