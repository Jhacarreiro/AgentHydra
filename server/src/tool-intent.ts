// server/src/tool-intent.ts - hydra_find by intent: every tool's text embedded on this PC, an ask matched by meaning.
//
// Until 2026-10-16 hydra_find matched words only, so an ask put in other words than a tool's own ("is this screen
// too busy" against "what a page costs the person looking") found nothing, and the owner asked for every tool's
// description and parameter descriptions to be embedded so the search finds a tool by what the agent means. Each
// tool's name, description and parameter descriptions (toolText) are embedded with a static model (LOCAL_MODEL: a
// table of one vector per word piece, about 31 MB downloaded once into DATA_DIR/models), the ask is embedded the same
// way, and mcp-find.ts fuses the meaning ranking with its word ranking. No model runs: a text's vector is a lookup
// and a mean, so a search takes milliseconds and the table is the only memory it holds.
//
// The vectors are kept in memory and in DATA_DIR/tool-intent/<model>.json, keyed by a hash of each tool's text, so a
// restart embeds nothing and a changed tool is the only one embedded again. Before the table is downloaded (the first
// ask on a PC), while it loads, or when it fails, hydra_find answers by words and its `reason` says why.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import type { McpEngineTool } from './mcp-stdio.mjs'

export interface Embedder {
  /** Names the model and how it is run; vectors are only comparable within one model string. */
  model: string
  embed(texts: string[], kind: 'query' | 'passage'): Promise<number[][]>
}

/** A loaded model, or why there is none. */
export type EmbedderLoad = Embedder | { unavailable: string }

export interface IntentHit {
  name: string
  cosine: number
}

/** How long one hydra_find waits for the model before answering by words (the model keeps loading behind it). */
export const INTENT_WAIT_MS = 4000
const BATCH = 32

/** What is embedded for a tool: its name as words, its description, and each parameter with its description. */
export function toolText(t: McpEngineTool): string {
  const props =
    (t.inputSchema as { properties?: Record<string, { description?: string }> } | undefined)
      ?.properties ?? {}
  const params = Object.entries(props).map(([k, p]) =>
    p?.description ? `${k}: ${p.description}` : k,
  )
  return [t.name.replace(/_/g, ' '), t.description ?? '', ...params].join('\n')
}

/** A tool's head: its name as words and the first sentence of its description. Embedded beside toolText because a
 *  long description (modes, flags, rails) waters its meaning down: on the bench, price_tag ranked 48th of 131 by its
 *  whole text for "is this signup screen too cluttered", and the head alone found 25 of 33 asks first against 17. */
export function toolHead(t: McpEngineTool): string {
  const d = (t.description ?? '').replace(/^MUTATES:\s*/, '')
  const end = d.search(/[.!?](\s|$)/)
  return `${t.name.replace(/_/g, ' ')}\n${end > 0 ? d.slice(0, end + 1) : d}`
}

/** How a tool's two closeness scores (to its head and to its whole text) become one. Picked on the bench. */
export type Combine = 'max' | 'sum' | 'head'
export const COMBINE: Combine = 'max'

/** How much of a text's mean closeness to every other tool is taken off its closeness to an ask. A short, generic
 *  text sits near everything (a hub) and won asks it had nothing to do with: add_queue_item, which refuses every call,
 *  came first for "is this signup screen too cluttered". A quarter off took the bench from 29 to 31 of 35 in the top 3. */
export const HUB = 0.25

/** Each tool's head then its whole text, in tool order: the texts embedded for `tools`. */
const toolTexts = (tools: McpEngineTool[]) => tools.flatMap((t) => [toolHead(t), toolText(t)])

const hashOf = (text: string) => createHash('sha1').update(text).digest('hex')
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))
// float32 precision, so a vector read back from disk is the vector that was written
const round7 = (v: number[]) => v.map((x) => Math.round(x * 1e7) / 1e7)

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

export class ToolIntent {
  private loading: Promise<EmbedderLoad> | null = null
  private cacheModel = ''
  private cache = new Map<string, number[]>()
  private filling: Promise<void> = Promise.resolve()

  constructor(
    private readonly load: () => EmbedderLoad | Promise<EmbedderLoad>,
    private readonly opts: { dir: string | null; waitMs?: number; combine?: Combine },
  ) {}

  /** The model, loaded once; a load that throws (a failed download) is tried again on the next ask. */
  private model(): Promise<EmbedderLoad> {
    this.loading ??= Promise.resolve()
      .then(this.load)
      .catch((e: unknown) => {
        this.loading = null
        return { unavailable: `the intent model did not load: ${errorText(e)}` }
      })
    return this.loading
  }

  private file(model: string): string | null {
    return this.opts.dir ? join(this.opts.dir, `${model.replace(/[^a-z0-9.]+/gi, '-')}.json`) : null
  }

  /** The in-memory vectors for `model`, read from disk the first time. */
  private vectors(model: string): Map<string, number[]> {
    if (this.cacheModel === model) return this.cache
    this.cacheModel = model
    this.cache = new Map()
    const file = this.file(model)
    if (file && existsSync(file)) {
      try {
        const saved = JSON.parse(readFileSync(file, 'utf8')) as {
          model?: string
          vectors?: Record<string, number[]>
        }
        if (saved.model === model)
          for (const [k, v] of Object.entries(saved.vectors ?? {})) this.cache.set(k, v)
      } catch (e) {
        // A cache, so an unreadable one is rebuilt (the next fill overwrites it), and said.
        console.warn(
          `[agenthydra] tool intent cache ${file} unreadable, rebuilding: ${errorText(e)}`,
        )
      }
    }
    return this.cache
  }

  private save(model: string, keys: string[]): void {
    const file = this.file(model)
    if (!file || !this.opts.dir) return
    const cache = this.vectors(model)
    const vectors = Object.fromEntries(
      keys.filter((k) => cache.has(k)).map((k) => [k, cache.get(k)]),
    )
    mkdirSync(this.opts.dir, { recursive: true })
    writeFileSync(`${file}.tmp`, JSON.stringify({ model, vectors }))
    renameSync(`${file}.tmp`, file)
  }

  /** The vector of each text, embedding only the texts not seen before; one fill at a time, so two first asks embed once. */
  private async textVectors(e: Embedder, texts: string[]): Promise<number[][]> {
    const keys = texts.map(hashOf)
    const fill = this.filling.then(async () => {
      const cache = this.vectors(e.model)
      const textOf = new Map(keys.map((k, i) => [k, texts[i]]))
      const missing = [...textOf.keys()].filter((k) => !cache.has(k))
      if (!missing.length) return
      for (let i = 0; i < missing.length; i += BATCH) {
        const batch = missing.slice(i, i + BATCH)
        const out = await e.embed(
          batch.map((k) => textOf.get(k) ?? ''),
          'passage',
        )
        batch.forEach((k, j) => {
          cache.set(k, round7(out[j]))
        })
      }
      this.save(e.model, [...textOf.keys()])
    })
    // The next fill waits for this one, failed or not; this call's caller awaits `fill` and gets its error.
    this.filling = fill.catch(() => {}) // floor-ok: the error reaches the caller through `await fill` below
    await fill
    const cache = this.vectors(e.model)
    return keys.map((k) => cache.get(k) ?? [])
  }

  private hubKey: number[][] | null = null
  private hubValues: number[] = []

  /** Each text's mean closeness to the other tools' texts of its kind (heads to heads, whole texts to whole texts),
   *  worked out once per set of vectors. */
  private hubness(vectors: number[][]): number[] {
    if (this.hubKey?.length === vectors.length && this.hubKey.every((v, i) => v === vectors[i]))
      return this.hubValues
    this.hubKey = vectors
    this.hubValues = vectors.map((v, i) => {
      let sum = 0
      let n = 0
      for (let j = i % 2; j < vectors.length; j += 2)
        if (j !== i) {
          sum += cosine(v, vectors[j])
          n++
        }
      return n ? sum / n : 0
    })
    return this.hubValues
  }

  private async rank(
    tools: McpEngineTool[],
    query: string,
  ): Promise<{ hits: IntentHit[] } | { reason: string }> {
    const loaded = await this.model()
    if ('unavailable' in loaded) return { reason: loaded.unavailable }
    try {
      const vectors = await this.textVectors(loaded, toolTexts(tools))
      const hub = this.hubness(vectors)
      const [q] = await loaded.embed([query], 'query')
      const combine = this.opts.combine ?? COMBINE
      const hits = tools
        .map((t, i) => {
          const head = cosine(q, vectors[2 * i]) - HUB * hub[2 * i]
          const whole = cosine(q, vectors[2 * i + 1]) - HUB * hub[2 * i + 1]
          const c =
            combine === 'head' ? head : combine === 'sum' ? head + whole : Math.max(head, whole)
          return { name: t.name, cosine: Math.round(c * 1e4) / 1e4 }
        })
        .sort((a, b) => b.cosine - a.cosine || a.name.localeCompare(b.name))
      return { hits }
    } catch (e) {
      return { reason: `intent search failed: ${errorText(e)}` }
    }
  }

  /** Every tool ranked by meaning against `query`, closest first; or why not, within the wait. */
  async search(
    tools: McpEngineTool[],
    query: string,
  ): Promise<{ hits: IntentHit[] } | { reason: string }> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const late = new Promise<{ reason: string }>((resolve) => {
      timer = setTimeout(
        () =>
          resolve({
            reason:
              'intent search is still loading its model (the first use downloads about 31 MB); this answer is by words',
          }),
        this.opts.waitMs ?? INTENT_WAIT_MS,
      )
    })
    try {
      return await Promise.race([this.rank(tools, query), late])
    } finally {
      clearTimeout(timer)
    }
  }

  /** Loads the model and embeds `tools` ahead of the first ask; resolves to why not, or null when ready. */
  async warm(tools: McpEngineTool[]): Promise<string | null> {
    const loaded = await this.model()
    if ('unavailable' in loaded) return loaded.unavailable
    try {
      await this.textVectors(loaded, toolTexts(tools))
      return null
    } catch (e) {
      return `intent search failed: ${errorText(e)}`
    }
  }
}

/** A model2vec model on Hugging Face, pinned to one revision, each file by its sha256. */
export interface StaticModelSpec {
  repo: string
  revision: string
  files: { 'tokenizer.json': string; 'model.safetensors': string }
}

/** potion-base-8M (model2vec, MIT): one fixed vector per word piece, distilled from bge-base. On the bench it found
 *  29 of 35 asks in the top 3 against 31 for the bge-small model it replaced (2026-10-16), at 3 ms a search instead
 *  of 54, about 8 MB of memory instead of 110, and no inference library, so the release runs it too. */
export const LOCAL_MODEL: StaticModelSpec = {
  repo: 'minishlab/potion-base-8M',
  revision: 'bf8b056651a2c21b8d2565580b8569da283cab23',
  files: {
    'tokenizer.json': 'e67e803f624fb4d67dea1c730d06e1067e1b14d830e2c2202569e3ef0f70bb50',
    'model.safetensors': 'f65d0f325faadc1e121c319e2faa41170d3fa07d8c89abd48ca5358d9a223de2',
  },
}

type Fetch = (url: string) => Promise<Response>
const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

/** One of the spec's files from `dir`, downloaded at the pinned revision when missing or not the pinned bytes; a
 *  download that is not the pinned bytes is refused and nothing is written. */
async function modelFile(
  spec: StaticModelSpec,
  dir: string,
  name: keyof StaticModelSpec['files'],
  get: Fetch,
): Promise<Buffer> {
  const file = join(dir, name)
  if (existsSync(file)) {
    const saved = readFileSync(file)
    if (sha256(saved) === spec.files[name]) return saved
  }
  const url = `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${name}`
  const res = await get(url)
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`)
  const bytes = Buffer.from(await res.arrayBuffer())
  if (sha256(bytes) !== spec.files[name]) throw new Error(`${url}: sha256 is not the pinned one`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(`${file}.tmp`, bytes)
  renameSync(`${file}.tmp`, file)
  return bytes
}

export interface WordPieceVocab {
  pieces: Map<string, number>
  unk: number | undefined
  prefix: string
  maxChars: number
}

export function wordPieceVocab(tokenizerJson: string): WordPieceVocab {
  const m = (
    JSON.parse(tokenizerJson) as {
      model?: {
        type?: string
        vocab?: Record<string, number>
        unk_token?: string
        continuing_subword_prefix?: string
        max_input_chars_per_word?: number
      }
    }
  ).model
  if (m?.type !== 'WordPiece' || !m.vocab)
    throw new Error('tokenizer.json is not a WordPiece tokenizer')
  const pieces = new Map(Object.entries(m.vocab))
  return {
    pieces,
    unk: m.unk_token === undefined ? undefined : pieces.get(m.unk_token),
    prefix: m.continuing_subword_prefix ?? '##',
    maxChars: m.max_input_chars_per_word ?? 100,
  }
}

// BERT's words: each ASCII symbol and each Unicode punctuation mark alone, else a run of letters and digits.
const WORDS = /[\p{P}!-/:-@[-`{-~]|[^\s\p{P}!-/:-@[-`{-~]+/gu

/** A text as word-piece ids, the way BERT's uncased tokenizer splits it (lowercased, accents stripped, punctuation
 *  apart, each word as its longest known pieces); a word with no known split is dropped, as model2vec drops [UNK]. */
export function wordPieces(text: string, v: WordPieceVocab): number[] {
  const clean = text
    .replace(/[\p{Cc}\p{Cf}�]/gu, (c) => (/\s/.test(c) ? ' ' : ''))
    .replace(/\p{Ideographic}/gu, ' $& ')
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .toLowerCase()
  const ids: number[] = []
  for (const word of clean.match(WORDS) ?? []) {
    const chars = Array.from(word)
    if (chars.length > v.maxChars) continue
    const split: number[] = []
    for (let start = 0; start < chars.length; ) {
      let end = chars.length
      let id: number | undefined
      for (; end > start; end--) {
        id = v.pieces.get((start ? v.prefix : '') + chars.slice(start, end).join(''))
        if (id !== undefined) break
      }
      if (id === undefined) {
        split.length = 0
        break
      }
      split.push(id)
      start = end
    }
    ids.push(...split)
  }
  return ids.filter((id) => id !== v.unk)
}

/** The table: one row per word piece, 8-bit with a scale per row (a quarter of the float table's memory, and the
 *  same bench result). */
export interface StaticTable {
  dim: number
  rows: Int8Array
  scales: Float32Array
}

/** The one 2-D F32 tensor of a model2vec safetensors file, as a StaticTable. */
export function staticTable(bytes: Uint8Array): StaticTable {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headerLength = Number(view.getBigUint64(0, true))
  const header = JSON.parse(
    new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)),
  ) as Record<string, { dtype?: string; shape?: number[]; data_offsets?: [number, number] }>
  const tensor = Object.entries(header).find(([k]) => k !== '__metadata__')?.[1]
  if (tensor?.dtype !== 'F32' || tensor.shape?.length !== 2 || !tensor.data_offsets)
    throw new Error('model.safetensors does not hold one 2-D F32 table')
  const [count, dim] = tensor.shape
  const base = 8 + headerLength + tensor.data_offsets[0]
  const at = (i: number) => view.getFloat32(base + i * 4, true)
  const rows = new Int8Array(count * dim)
  const scales = new Float32Array(count)
  for (let r = 0; r < count; r++) {
    let max = 0
    for (let d = 0; d < dim; d++) max = Math.max(max, Math.abs(at(r * dim + d)))
    const scale = max / 127 || 1
    scales[r] = scale
    for (let d = 0; d < dim; d++) rows[r * dim + d] = Math.round(at(r * dim + d) / scale)
  }
  return { dim, rows, scales }
}

/** The spec's model, downloaded into `dir` the first time. */
export async function loadStaticEmbedder(
  spec: StaticModelSpec,
  dir: string,
  get: Fetch = fetch,
): Promise<Embedder> {
  const vocab = wordPieceVocab((await modelFile(spec, dir, 'tokenizer.json', get)).toString('utf8'))
  const table = staticTable(await modelFile(spec, dir, 'model.safetensors', get))
  return staticEmbedder(`${spec.repo}@${spec.revision.slice(0, 7)}-q8`, vocab, table)
}

/** A text's vector is the normalized mean of its pieces' rows, the same for an ask as for a tool text, so a search is
 *  a table lookup. Built apart from the loader so the closures hold the table and not the 31 MB file it was read from. */
function staticEmbedder(model: string, vocab: WordPieceVocab, table: StaticTable): Embedder {
  const { dim, rows, scales } = table
  for (const id of vocab.pieces.values())
    if (id >= scales.length)
      throw new Error(`tokenizer.json names piece ${id}, past the table's ${scales.length} rows`)
  const vectorOf = (text: string) => {
    const sum = new Float64Array(dim)
    for (const id of wordPieces(text, vocab))
      for (let d = 0; d < dim; d++) sum[d] += rows[id * dim + d] * scales[id]
    let norm = 0
    for (const x of sum) norm += x * x
    norm = Math.sqrt(norm) || 1
    return Array.from(sum, (x) => x / norm)
  }
  return { model, embed: async (texts) => texts.map(vectorOf) }
}

export async function loadLocalEmbedder(): Promise<EmbedderLoad> {
  if (process.env.AGENTHYDRA_TOOL_INTENT === '0')
    return { unavailable: 'intent search is off (AGENTHYDRA_TOOL_INTENT=0)' }
  return loadStaticEmbedder(LOCAL_MODEL, join(DATA_DIR, 'models', LOCAL_MODEL.repo))
}

let shared: ToolIntent | null = null

/** The one intent index this process uses: the local model, vectors under DATA_DIR/tool-intent. */
export function sharedToolIntent(): ToolIntent {
  shared ??= new ToolIntent(loadLocalEmbedder, { dir: join(DATA_DIR, 'tool-intent') })
  return shared
}

/** Daemon start: load the model and embed every tool in the background, so the first hydra_find ranks by intent. */
export function warmToolIntentInBackground(tools: McpEngineTool[]): void {
  const started = Date.now()
  void sharedToolIntent()
    .warm(tools)
    .then((why) => {
      if (why) console.warn(`[agenthydra] hydra_find searches by words only: ${why}`)
      else
        console.log(
          `[agenthydra] hydra_find intent index ready: ${tools.length} tools in ${Date.now() - started} ms`,
        )
    })
}
