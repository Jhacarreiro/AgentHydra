// Usage-ledger ingest for GitHub Copilot Chat in VS Code (Code, Insiders, VSCodium): source `vscode-copilot`.
//
// WHERE: `<User>/workspaceStorage/<hash>/chatSessions/<session>.jsonl`, a window with a folder (named in
// `<hash>/workspace.json`), and `<User>/globalStorage/emptyWindowChatSessions/`, a window with none. A chat
// is an operation log, VS Code's ObjectMutationLog (chat/common/model/objectMutationLog.ts): kind 0 is the
// whole chat, kind 1 sets a value at a path, kind 2 pushes onto the array at a path (with `i`, everything
// from that index is removed first), kind 3 deletes one. Past 512 entries VS Code REWRITES the file as one
// kind 0 line. An older chat is one `.json` document of the kind 0 shape.
//
// WHAT COUNTS: every request the log ever showed is one call, id `vscode-copilot:<session>:<request>`. One a
// later edit removed was still sent: measured 2026-10-17, the logs showed 2,863 requests where the chats
// kept 2,731. Tokens only where VS Code or Copilot wrote them, never estimated. Output is the request's
// `completionTokens` (VS Code's sum of what the model reported over the request's calls), else Copilot's
// result.metadata.outputTokens; input is the newest call's prompt (`promptTokens`, else
// result.metadata.promptTokens). A tool loop's earlier prompts are recorded nowhere, so a long agent
// request's input reads low. A history summary Copilot made inside a request (result.metadata.summaries) is
// a model call of its own with its own usage, id `vscode-copilot:<session>:summary:<round>`. Measured
// 2026-10-17: 925 of the 2,731 requests carry a count, about 0.02B tokens. This source is here so every
// tool is counted, not for its volume. Copilot bills premium requests; list_usd prices the tokens anyway,
// like every other source.
//
// READING: a log is read on from where the last sweep stopped, with the replayed chat kept in meta (only
// what is counted: each request's id, time, model and counts). A rewrite shows as the bytes just before
// that offset no longer matching, and the log is then read from the top: safe, as every event is
// written by id.
import { type FileHandle, stat as fsStat, open, readdir, readFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { agentTool, rootsFor } from '../agent-catalog'
import { pricesAsOf, priceTokens } from '../pricing'
import { emptyModelSpend, weighTurnCounts } from '../usage-foreign'
import { linesFrom } from './lines'
import { type KitStore, type UsageEventInput, yieldLoop } from './store'

export const COPILOT_SOURCE = 'vscode-copilot'
/** Bump to read every log again from the top (a change to what is extracted). */
export const COPILOT_INGEST_VERSION = 1
/** The bytes before a resume offset kept to tell an appended log from a rewritten one. */
const TAIL_BYTES = 64
/** A kind 0 line runs to megabytes: read in larger chunks than the stream's 64 KB. */
const CHUNK_BYTES = 1 << 20

/** The VS Code `User` folders on this machine (the catalog's `vscode-copilot` roots, VSCODE_COPILOT_DIR). */
export function copilotRoots(): string[] {
  const tool = agentTool(COPILOT_SOURCE)
  return tool ? rootsFor(tool).map((r) => r.root) : []
}

export interface CopilotIngestOptions {
  pc?: string | null
  /** Called per chat file: events written, or null when it was unchanged or unreadable. */
  onFile?: (path: string, events: number | null) => void
}

/** One sweep over a `User` folder. Returns events written. */
export async function ingestCopilot(
  store: KitStore,
  root: string,
  opts: CopilotIngestOptions = {},
): Promise<number> {
  let n = 0
  for (const log of await chatFiles(root)) {
    const written = log.path.endsWith('.jsonl')
      ? await ingestLog(store, log, opts)
      : await ingestDocument(store, log, opts)
    opts.onFile?.(log.path, written)
    if (written === null) continue // unchanged: a stat, not worth a loop turn
    n += written
    await yieldLoop()
  }
  return n
}

interface Summary {
  /** Copilot's toolCallRoundId: a summary is carried on by the requests after it, under the same id. */
  id: string
  model: string | null
  input: number
  cacheRead: number
  output: number
}

interface CountedResult {
  promptTokens?: number
  outputTokens?: number
  resolvedModel?: string
  summaries?: Summary[]
}

interface CountedRequest {
  requestId?: string
  timestamp?: number
  modelId?: string
  completionTokens?: number
  promptTokens?: number
  result?: CountedResult
}

const KEPT = [
  'requestId',
  'timestamp',
  'modelId',
  'completionTokens',
  'promptTokens',
  'result',
] as const
type Kept = (typeof KEPT)[number]
const isKept = (k: unknown): k is Kept => (KEPT as readonly unknown[]).includes(k)

interface Chat {
  session: string
  /** `workingDirectory`, a URI, where the chat names one. */
  workdir: string | null
  requests: CountedRequest[]
}

/** What a log's meta keeps between sweeps. */
interface SavedLog {
  chat: Chat
  /** Summary ids already written: one is carried by every later request. */
  sums: string[]
  /** Base64 of the TAIL_BYTES before the cursor's offset. */
  tail: string
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
const pos = (v: number | undefined): number | undefined => (v && v > 0 ? v : undefined)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' ? (v as Record<string, unknown>) : {}

function countedSummary(v: unknown): Summary | null {
  const s = obj(v)
  const id = str(s.toolCallRoundId)
  if (!id) return null
  const u = obj(s.usage)
  const prompt = num(u.prompt_tokens) ?? 0
  const cached = Math.min(prompt, num(obj(u.prompt_tokens_details).cached_tokens) ?? 0)
  return {
    id,
    model: str(s.model) ?? null,
    // Like OpenAI's, prompt_tokens includes the cached part.
    input: prompt - cached,
    cacheRead: cached,
    output: num(u.completion_tokens) ?? 0,
  }
}

function countedResult(v: unknown): CountedResult | undefined {
  if (!v || typeof v !== 'object') return undefined
  const md = obj((v as { metadata?: unknown }).metadata)
  const usage = obj((v as { usage?: unknown }).usage)
  const summaries: Summary[] = []
  for (const s of [...(Array.isArray(md.summaries) ? md.summaries : []), md.summary]) {
    const c = countedSummary(s)
    if (c) summaries.push(c)
  }
  return {
    promptTokens: num(md.promptTokens) ?? num(usage.promptTokens),
    outputTokens: num(md.outputTokens) ?? num(usage.completionTokens),
    resolvedModel: str(md.resolvedModel),
    ...(summaries.length ? { summaries } : {}),
  }
}

function setField(r: CountedRequest, k: Kept, v: unknown): void {
  if (k === 'requestId' || k === 'modelId') r[k] = str(v)
  else if (k === 'result') r.result = countedResult(v)
  else r[k] = num(v)
}

function countedRequest(v: unknown): CountedRequest {
  const raw = obj(v)
  const r: CountedRequest = {}
  for (const k of KEPT) setField(r, k, raw[k])
  return r
}

function countedChat(v: unknown, session: string): Chat {
  const c = obj(v)
  return {
    session: str(c.sessionId) ?? session,
    workdir: str(c.workingDirectory) ?? null,
    requests: (Array.isArray(c.requests) ? c.requests : []).map(countedRequest),
  }
}

/** One log line: `{ kind, k, v, i }`. */
interface Op {
  kind?: unknown
  k?: unknown
  v?: unknown
  i?: unknown
}

/**
 * Replays ops onto the counted chat. Only the paths that carry what is counted are followed: a request's
 * response, text and attachments (most of a log's bytes) are dropped on arrival. Every request an op
 * reaches is remembered, a removed one included, so its last state is written.
 */
export class CopilotReplay {
  readonly touched = new Set<CountedRequest>()
  constructor(public chat: Chat) {}

  apply(op: Op): void {
    if (op.kind === 0) {
      this.chat = countedChat(op.v, this.chat.session)
      for (const r of this.chat.requests) this.touched.add(r)
      return
    }
    const k = Array.isArray(op.k) ? (op.k as unknown[]) : null
    if (!k?.length) return
    if (k[0] !== 'requests') {
      if (k.length === 1 && k[0] === 'workingDirectory')
        this.chat.workdir = op.kind === 1 ? (str(op.v) ?? null) : null
      return
    }
    const reqs = this.chat.requests
    if (k.length === 1) {
      if (op.kind === 2) {
        if (typeof op.i === 'number') reqs.splice(op.i)
        for (const v of Array.isArray(op.v) ? op.v : []) this.add(reqs, reqs.length, v)
      } else if (op.kind === 1) {
        reqs.length = 0
        for (const v of Array.isArray(op.v) ? op.v : []) this.add(reqs, reqs.length, v)
      }
      return
    }
    const i = k[1]
    if (typeof i !== 'number') return
    if (k.length === 2) {
      if (op.kind === 1) this.add(reqs, i, op.v)
      return
    }
    const r = reqs[i]
    const field = k[2]
    // A deeper path is inside a field set whole (the schema writes `result` as one value) or not counted.
    if (!r || k.length !== 3 || !isKept(field)) return
    setField(r, field, op.kind === 1 ? op.v : undefined)
    this.touched.add(r)
  }

  private add(reqs: CountedRequest[], at: number, v: unknown): void {
    const r = countedRequest(v)
    reqs[at] = r
    this.touched.add(r)
  }
}

/** Only these lines can change what is counted; the rest, most of a log's bytes, are never parsed. A line
 *  in a layout this does not know is parsed anyway. */
const COUNTED_OP =
  /^\{"kind":(?:0|[123],"k":\["(?:requests"(?:\]|,\d+(?:\]|,"(?:requestId|timestamp|modelId|completionTokens|promptTokens|result)"\]))|workingDirectory"\]))/

function wanted(text: string): boolean {
  if (!text.startsWith('{"kind":')) return text.trim().length > 0
  return COUNTED_OP.test(text)
}

function parseOp(text: string): Op | null {
  try {
    const op = JSON.parse(text) as unknown
    return op && typeof op === 'object' ? (op as Op) : null
  } catch {
    return null
  }
}

/**
 * The model a request names, spelt as the rest of the ledger spells it: the vendor path dropped
 * (`copilot/gpt-5.4`, `anthropic/<key>/claude-opus-4-7`), a BYOK key's own prefix too, and Claude's version
 * written with a dash, as Anthropic writes it (`claude-sonnet-4.6` is `claude-sonnet-4-6`). Copilot's `auto`
 * is the model it picked, where the result names it, less the snapshot date the API answers with
 * (`gpt-5.4-2026-03-05` is `gpt-5.4`).
 */
export function copilotModel(modelId: string | undefined, resolved?: string): string {
  if (!modelId) return 'unknown'
  const id =
    /(^|\/)auto$/.test(modelId) && resolved ? resolved.replace(/-\d{4}-\d{2}-\d{2}$/, '') : modelId
  let m = id.slice(id.lastIndexOf('/') + 1).replace(/^byok-[a-z]+\./i, '')
  if (/^claude-/i.test(m)) m = m.replace(/(\d)\.(\d)/g, '$1-$2')
  return m
}

/** Who served it: Copilot's own models are `github-copilot`; a BYOK key or another extension's provider is
 *  that vendor (`byok-openai/...` is `openai`). */
export function copilotProvider(modelId: string | undefined): string {
  const vendor = modelId?.split('/')[0]?.toLowerCase() ?? ''
  if (vendor.startsWith('byok-')) return vendor.slice('byok-'.length)
  if (!vendor || !modelId?.includes('/') || vendor === 'copilot' || vendor.startsWith('github.'))
    return 'github-copilot'
  return vendor
}

interface Counts {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** list_usd of one call; null when the model has no price. */
function listUsd(model: string, c: Counts, at: number): number | null {
  const spend = {
    ...emptyModelSpend(),
    input: c.input,
    cacheRead: c.cacheRead,
    output: c.output,
    turns: 1,
  }
  const p = priceTokens({ [model]: spend }, at, c.input + c.cacheRead)
  return p.unpriced.length > 0 ? null : p.costUsd
}

function callEvent(
  id: string,
  ts: number,
  session: string,
  model: string,
  provider: string,
  c: Counts,
  pc: string | null,
): UsageEventInput {
  return {
    id,
    ts,
    pc,
    session,
    agent: 'main',
    source: COPILOT_SOURCE,
    model,
    provider,
    input: c.input,
    output: c.output,
    cache_read: c.cacheRead,
    cache_write_5m: 0,
    list_usd: listUsd(model, c, ts),
    price_ver: pricesAsOf(),
    weighted: weighTurnCounts(model, c),
  }
}

/** The events of every request the replay reached, and of each summary not written before. */
export function copilotEvents(
  replay: CopilotReplay,
  sums: Set<string>,
  pc: string | null,
  fallbackTs: number,
): UsageEventInput[] {
  const { session } = replay.chat
  const out: UsageEventInput[] = []
  for (const r of replay.touched) {
    if (!r.requestId) continue // nothing stable to key it by (none seen on 2026-10-17)
    const ts = r.timestamp ?? fallbackTs
    const model = copilotModel(r.modelId, r.result?.resolvedModel)
    const provider = copilotProvider(r.modelId)
    const c: Counts = {
      input: pos(r.promptTokens) ?? pos(r.result?.promptTokens) ?? 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: pos(r.completionTokens) ?? pos(r.result?.outputTokens) ?? 0,
    }
    out.push(
      callEvent(`${COPILOT_SOURCE}:${session}:${r.requestId}`, ts, session, model, provider, c, pc),
    )
    for (const s of r.result?.summaries ?? []) {
      if (sums.has(s.id)) continue
      sums.add(s.id)
      const sm = s.model ? copilotModel(s.model) : model
      const sc: Counts = { input: s.input, cacheRead: s.cacheRead, cacheWrite: 0, output: s.output }
      out.push(
        callEvent(
          `${COPILOT_SOURCE}:${session}:summary:${s.id}`,
          ts,
          session,
          sm,
          provider,
          sc,
          pc,
        ),
      )
    }
  }
  return out
}

interface ChatFile {
  path: string
  /** `workspaceStorage/<hash>`, or null for an empty window's chat. */
  workspace: string | null
}

const CHAT_FILE = /\.jsonl?$/i

async function names(dir: string): Promise<string[]> {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function chatFiles(root: string): Promise<ChatFile[]> {
  const out: ChatFile[] = []
  const storage = join(root, 'workspaceStorage')
  for (const hash of await names(storage)) {
    const dir = join(storage, hash, 'chatSessions')
    for (const n of await names(dir))
      if (CHAT_FILE.test(n)) out.push({ path: join(dir, n), workspace: join(storage, hash) })
  }
  const empty = join(root, 'globalStorage', 'emptyWindowChatSessions')
  for (const n of await names(empty))
    if (CHAT_FILE.test(n)) out.push({ path: join(empty, n), workspace: null })
  return out
}

/** The folder a `file:` URI names, its drive letter upper-cased; null for a remote window (WSL, SSH, a
 *  container), which names no folder on this PC. */
function uriPath(uri: string | null | undefined): string | null {
  if (!uri?.startsWith('file:')) return null
  try {
    return fileURLToPath(uri).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
  } catch {
    return null
  }
}

/** The folder a workspace window had open: its folder, or the folder of its `.code-workspace` file. */
async function workspaceFolder(workspace: string | null): Promise<string | null> {
  if (!workspace) return null
  try {
    const w = obj(JSON.parse(await readFile(join(workspace, 'workspace.json'), 'utf8')))
    const folder = uriPath(str(w.folder))
    if (folder) return folder
    const file = uriPath(str(w.workspace))
    return file ? dirname(file) : null
  } catch {
    return null
  }
}

/** Where a chat ran, kept as `copilot_cwd:<session>` for the Cost by project card (session-cwds.ts). */
async function keepCwd(store: KitStore, chat: Chat, log: ChatFile): Promise<void> {
  const cwd = uriPath(chat.workdir) ?? (await workspaceFolder(log.workspace))
  if (cwd && store.getMeta(cwdKey(chat.session)) !== cwd) store.setMeta(cwdKey(chat.session), cwd)
}

export const cwdKey = (session: string) => `copilot_cwd:${session}`
const stateKey = (path: string) => `ingest_state:${path}`
const sessionOf = (path: string) => basename(path).replace(CHAT_FILE, '')

async function stat(path: string): Promise<{ size: number; mtime: number } | null> {
  try {
    const s = await fsStat(path)
    return { size: s.size, mtime: Math.floor(s.mtimeMs) }
  } catch {
    return null
  }
}

async function tailAt(path: string, offset: number): Promise<string> {
  const from = Math.max(0, offset - TAIL_BYTES)
  let fh: FileHandle
  try {
    fh = await open(path, 'r')
  } catch {
    return ''
  }
  try {
    const buf = Buffer.alloc(offset - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    return buf.subarray(0, bytesRead).toString('base64')
  } catch {
    return ''
  } finally {
    await fh.close()
  }
}

const unchanged = (c: ReturnType<KitStore['getCursor']>, st: { size: number; mtime: number }) =>
  !!c && c.version === COPILOT_INGEST_VERSION && c.size === st.size && c.mtime === st.mtime

/** Where a log's read picks up: the saved offset and chat, or the top when either is missing, from another
 *  version, past the end, or the bytes before the offset changed (VS Code rewrote the log). */
async function resume(
  store: KitStore,
  path: string,
  cur: ReturnType<KitStore['getCursor']>,
  size: number,
): Promise<{ offset: number; saved: SavedLog | null }> {
  const top = { offset: 0, saved: null }
  if (!cur || cur.version !== COPILOT_INGEST_VERSION || cur.offset <= 0 || cur.offset > size)
    return top
  const raw = store.getMeta(stateKey(path))
  if (!raw) return top
  try {
    const saved = JSON.parse(raw) as SavedLog
    return saved.tail === (await tailAt(path, cur.offset)) ? { offset: cur.offset, saved } : top
  } catch {
    return top
  }
}

async function ingestLog(
  store: KitStore,
  log: ChatFile,
  opts: CopilotIngestOptions,
): Promise<number | null> {
  const st = await stat(log.path)
  if (!st) return null
  const cur = store.getCursor(log.path)
  if (unchanged(cur, st)) return null
  const { offset, saved } = await resume(store, log.path, cur, st.size)
  const replay = new CopilotReplay(
    saved?.chat ?? { session: sessionOf(log.path), workdir: null, requests: [] },
  )
  const sums = new Set(saved?.sums ?? [])
  let end = offset
  for await (const l of linesFrom(log.path, offset, CHUNK_BYTES)) {
    end = l.end
    if (!wanted(l.text)) continue
    const op = parseOp(l.text)
    if (op) replay.apply(op)
  }
  const events = copilotEvents(replay, sums, opts.pc ?? null, st.mtime)
  await store.upsertEventsAsync(events)
  const next: SavedLog = { chat: replay.chat, sums: [...sums], tail: await tailAt(log.path, end) }
  store.setMeta(stateKey(log.path), JSON.stringify(next))
  await keepCwd(store, replay.chat, log)
  store.setCursor({ path: log.path, ...st, offset: end, version: COPILOT_INGEST_VERSION })
  return events.length
}

/** An older chat, one JSON document: read whole whenever it changes. */
async function ingestDocument(
  store: KitStore,
  log: ChatFile,
  opts: CopilotIngestOptions,
): Promise<number | null> {
  const st = await stat(log.path)
  if (!st) return null
  if (unchanged(store.getCursor(log.path), st)) return null
  let doc: unknown
  try {
    doc = JSON.parse(await readFile(log.path, 'utf8'))
  } catch {
    return null // locked or half written: no cursor, so the next sweep reads it again
  }
  const replay = new CopilotReplay({ session: sessionOf(log.path), workdir: null, requests: [] })
  replay.apply({ kind: 0, v: doc })
  const events = copilotEvents(replay, new Set(), opts.pc ?? null, st.mtime)
  await store.upsertEventsAsync(events)
  await keepCwd(store, replay.chat, log)
  store.setCursor({ path: log.path, ...st, offset: st.size, version: COPILOT_INGEST_VERSION })
  return events.length
}
