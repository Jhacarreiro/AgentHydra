import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findTools } from '../src/mcp-find'
import {
  type Embedder,
  loadStaticEmbedder,
  staticTable,
  ToolIntent,
  toolHead,
  toolText,
  wordPieces,
  wordPieceVocab,
} from '../src/tool-intent'

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

// A tiny model2vec-shaped model: a WordPiece vocabulary and one row per piece.
const PIECES = ['[UNK]', 'restart', 'the', 'service', '##s', 'cafe', '.', 'quota']
const tokenizerJson = JSON.stringify({
  model: {
    type: 'WordPiece',
    unk_token: '[UNK]',
    continuing_subword_prefix: '##',
    max_input_chars_per_word: 100,
    vocab: Object.fromEntries(PIECES.map((p, i) => [p, i])),
  },
})
const ROWS = [
  [0, 0, 0],
  [1, 0, 0], // restart
  [0, 0, 0.5], // the
  [0, 1, 0], // service
  [0, 0.5, 0], // ##s
  [0, 0, 1], // cafe
  [0, 0, 0.25], // .
  [0, 0, -1], // quota
]
function safetensors(rows: number[][]): Uint8Array {
  const data = new Float32Array(rows.flat())
  const header = JSON.stringify({
    __metadata__: {},
    embeddings: {
      dtype: 'F32',
      shape: [rows.length, rows[0].length],
      data_offsets: [0, data.byteLength],
    },
  })
  const head = new TextEncoder().encode(header)
  const out = new Uint8Array(8 + head.length + data.byteLength)
  new DataView(out.buffer).setBigUint64(0, BigInt(head.length), true)
  out.set(head, 8)
  out.set(new Uint8Array(data.buffer), 8 + head.length)
  return out
}
const sha256 = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex')

describe('the static model', () => {
  const vocab = wordPieceVocab(tokenizerJson)

  test('splits text into the longest pieces the vocabulary has, BERT style', () => {
    // lowercased, accents stripped, punctuation its own word, a suffix as a ## piece, an unknown word dropped
    expect(wordPieces('Restart the SERVICES, café.', vocab)).toEqual([1, 2, 3, 4, 5, 6])
    expect(wordPieces('restart zebra', vocab)).toEqual([1])
  })

  test("a text's vector is the normalized mean of its pieces' rows, the same for asks and tool texts", async () => {
    const e = await loadStaticEmbedder(
      {
        repo: 'test/tiny',
        revision: 'abc1234',
        files: {
          'model.safetensors': sha256(safetensors(ROWS)),
          'tokenizer.json': sha256(tokenizerJson),
        },
      },
      scratch(),
      async (url) =>
        new Response(url.endsWith('tokenizer.json') ? tokenizerJson : safetensors(ROWS)),
    )
    const [ask] = await e.embed(['restart service'], 'query')
    const [tool] = await e.embed(['restart service'], 'passage')
    expect(ask).toEqual(tool)
    expect(ask[0]).toBeCloseTo(Math.SQRT1_2, 2)
    expect(ask[1]).toBeCloseTo(Math.SQRT1_2, 2)
    expect(ask[2]).toBeCloseTo(0, 2)
  })

  test('the table is kept 8-bit, one scale per row', () => {
    const t = staticTable(safetensors(ROWS))
    expect(t.dim).toBe(3)
    expect(t.rows).toBeInstanceOf(Int8Array)
    expect(t.rows[7 * 3 + 2] * t.scales[7]).toBeCloseTo(-1, 2)
    expect(t.rows[2 * 3 + 2] * t.scales[2]).toBeCloseTo(0.5, 2)
  })

  test('downloads each file once at the pinned revision, and refuses one whose sha256 is not the pinned one', async () => {
    const dir = scratch()
    const spec = {
      repo: 'test/tiny',
      revision: 'abc1234',
      files: {
        'model.safetensors': sha256(safetensors(ROWS)),
        'tokenizer.json': sha256(tokenizerJson),
      },
    }
    const asked: string[] = []
    const get = async (url: string) => {
      asked.push(url)
      return new Response(url.endsWith('tokenizer.json') ? tokenizerJson : safetensors(ROWS))
    }
    await loadStaticEmbedder(spec, dir, get)
    expect(asked).toEqual([
      'https://huggingface.co/test/tiny/resolve/abc1234/tokenizer.json',
      'https://huggingface.co/test/tiny/resolve/abc1234/model.safetensors',
    ])
    await loadStaticEmbedder(spec, dir, get)
    expect(asked.length).toBe(2)

    // a file on disk that is not the pinned one is fetched again, and a fetched one that is not is refused
    writeFileSync(join(dir, 'tokenizer.json'), '{}')
    await expect(
      loadStaticEmbedder(spec, dir, async () => new Response('{"tampered":true}')),
    ).rejects.toThrow('sha256')
    expect(existsSync(join(dir, 'tokenizer.json.tmp'))).toBe(false)
  })
})
