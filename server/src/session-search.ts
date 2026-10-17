// Advanced session BODY search: streams each transcript JSONL file line-by-line (constant
// memory even for gigantic files) instead of buffering it whole, unlike sessions.ts's scanMeta()
// (bounded 12MB tail read) or transcript.ts's readTailBytes() (bounded byte-tail read). Kept in
// its own module so the fast/simple metadata list path (sessions.ts, GET /api/sessions) stays
// completely untouched; this is a separate, slower, opt-in code path.
import safeRegex from 'safe-regex2'
import { ensureCliTranscriptFiles, listCliTranscriptFiles } from './cli-transcripts'
import { readDshSession } from './dsh-sessions'
import { readForeignSession } from './foreign-sessions'
import { listHermesSearchEvents } from './hermes-sessions'
import { readHSwarmSession } from './hswarm-sessions'
import { instanceSessionMap } from './instance-sessions'
import { listOpenCodeSearchEventsAsync } from './opencode-sessions'
import {
  type IndexRefreshResult,
  isRefreshing,
  refreshSearchIndex,
  searchIndexCandidates,
  searchIndexHolds,
  searchIndexIsOpen,
  searchIndexKey,
} from './search-index'
import { dedupeKey } from './session-locator'
import {
  ensureTranscriptIndex,
  eventToTailEventsForSource,
  instanceScopeMatches,
  listTranscriptFiles,
  type TranscriptFile,
} from './transcript'
import type {
  SessionSearchAccount,
  SessionSearchResponse,
  SessionSearchResult,
  SessionSource,
} from './types'

export type { SessionSearchResponse, SessionSearchResult }

export interface SearchOptions {
  query: string
  regex?: boolean
  caseSensitive?: boolean
  /** Scope to one instance: a Claude Desktop dir name, "default", "other", or a Codex instance's
   *  name / `codex:<id>` / `#7`. Same semantics as listSessions(). */
  instance?: string
  /** Scope to one provider. Omitted means all supported stores. */
  source?: SessionSource
  /** Only these sessions, as `${source}:${session_id}` keys: the list's own answer for a set of
   *  scopes (the sidebar's "Only this view"). Applied on top of `instance` / `source`. */
  allow?: ReadonlySet<string>
  /** Max sessions returned, newest-first. */
  limit?: number
  /** Max snippets collected per session before moving on. */
  perFileLimit?: number
  /** Wall-clock budget for the whole search; returns partial results past this, never hangs. */
  budgetMs?: number
  /**
   * Which path to take.
   *
   * 'auto' (the default) uses the conversation index whenever it is open, reading itself only what
   * the index does not hold yet, and the streaming scan otherwise. 'scan' forces the exhaustive path:
   * every byte of every transcript, tool output included. That is the escape hatch for the index's
   * two real limits, so it is a parameter rather than a hidden heuristic.
   */
  mode?: 'auto' | 'scan'
}

const DEFAULT_LIMIT = 50
const DEFAULT_PER_FILE_LIMIT = 5
const DEFAULT_BUDGET_MS = 7000
const CONCURRENCY = 6
const SNIPPET_LEN = 160
const MAX_REGEX_LENGTH = 200

/**
 * Which physical store each result came from, keyed by object identity rather than a public field.
 *
 * `SessionSearchResult` deliberately carries no path — session-locator.ts's whole point is that a
 * raw filesystem or database path is never a public identifier — so this is the one place that
 * identity survives for internal use (sortByActivity, below). Set once at construction, read once per
 * request; nothing here is ever serialized into a response. The store's NAME and its account are
 * public (`store`, `account`), set from the row this keeps (nameStores).
 */
const resultStoreKey = new WeakMap<SessionSearchResult, string>()
const resultRow = new WeakMap<SessionSearchResult, StoreRow>()

/** What names a result's store: a transcript row, or a database store's identity. */
type StoreRow = Pick<TranscriptFile, 'source' | 'session_id' | 'tool' | 'instance' | 'remote'> & {
  mtime_ms?: number
}

/** Remember where a result came from (its store key for ordering, its row for naming the store). */
function remember(hit: SessionSearchResult, key: string, row: StoreRow): void {
  resultStoreKey.set(hit, key)
  resultRow.set(hit, row)
}

/**
 * The store a transcript is in, as a hit names it: 'claude' (~/.claude/projects, Claude Code's main
 * folder), 'cli' (a CLI account's own folder, CliMayte's workers included), 'remote' (another PC's chat
 * the chat sync keeps here), or the product (`codex`, `opencode`, `zswarm`, ...).
 */
function storeOf(row: StoreRow): string {
  if (row.instance?.ref.startsWith('cli:')) return 'cli'
  if (row.remote) return 'remote'
  if (row.source === 'claude' && (row.tool ?? 'claude-code') === 'claude-code') return 'claude'
  return row.tool ?? row.source
}

/** The account a transcript belongs to, when known: the account whose own store holds it (a CLI
 *  account, a Codex instance), or the Claude Desktop instance a main-folder chat was had in. */
function accountOf(row: StoreRow, desktop: Map<string, string>): SessionSearchAccount | null {
  if (row.instance)
    return {
      ref: row.instance.ref,
      num: row.instance.num > 0 ? row.instance.num : null,
      name: row.instance.name,
    }
  const label = row.source === 'claude' && !row.remote ? desktop.get(row.session_id) : undefined
  return label ? { ref: null, num: null, name: label } : null
}

/** Name every result's store and account, once the list is final. */
function nameStores(results: SessionSearchResult[]): void {
  if (results.length === 0) return
  const desktop = instanceSessionMap()
  for (const r of results) {
    const row = resultRow.get(r)
    if (!row) continue
    r.store = storeOf(row)
    r.account = accountOf(row, desktop)
  }
}

function compact(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

function snippetAround(text: string, index: number, len: number): string {
  const t = compact(text)
  // recompute the match index against the compacted string is unreliable, so just center
  // a window on the original index, clamped to the compacted length
  const half = Math.floor(len / 2)
  const start = Math.max(0, Math.min(index, t.length) - half)
  const end = Math.min(t.length, start + len)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < t.length ? '…' : ''
  return `${prefix}${t.slice(start, end)}${suffix}`
}

type Matcher = (haystack: string) => number // returns match index, or -1

function buildMatcher(opts: SearchOptions): Matcher {
  const { query, regex, caseSensitive } = opts
  if (regex) {
    // A deadline cannot interrupt a synchronous RegExp.exec once catastrophic backtracking has
    // started. Reject structurally unsafe (or unreasonable) patterns before compiling; the
    // wall-clock budget below then bounds the ordinary multi-file work around each match.
    if (query.length > MAX_REGEX_LENGTH)
      throw new Error(`regular expression must be at most ${MAX_REGEX_LENGTH} characters`)
    if (!safeRegex(query)) throw new Error('unsafe regular expression')
    const re = new RegExp(query, caseSensitive ? '' : 'i')
    return (haystack: string) => {
      const m = re.exec(haystack)
      return m ? m.index : -1
    }
  }
  const needle = caseSensitive ? query : query.toLowerCase()
  return (haystack: string) => {
    const h = caseSensitive ? haystack : haystack.toLowerCase()
    return h.indexOf(needle)
  }
}

/** Where the first of `words` (lowercased, as the index splits them) appears, case-insensitively. */
function anyWordMatcher(words: string[]): Matcher {
  return (haystack: string) => {
    const h = haystack.toLowerCase()
    let first = -1
    for (const w of words) {
      const at = h.indexOf(w)
      if (at >= 0 && (first < 0 || at < first)) first = at
    }
    return first
  }
}

/** Streams a file's lines with constant memory via Bun's native ReadableStream, decoding and
 *  splitting on '\n' manually (mirrors dispatch.ts's `for await (const chunk of proc.stdout)`
 *  pump idiom, different source, same shape). Never buffers the whole file into memory.
 *
 *  Exported because session-usage.ts needs the same constant-memory read over a single transcript
 *  (the largest on a real machine is ~40 MB, which is not a thing to hold in the daemon's heap).
 *
 *  `fromByte` starts the read there instead, which must be the start of a line: the search reads only
 *  what a running chat wrote after the conversation index last read it (searchIndexHolds). */
export async function* streamLines(path: string, fromByte = 0): AsyncGenerator<string> {
  const file = Bun.file(path)
  const stream = (fromByte > 0 ? file.slice(fromByte) : file).stream()
  const decoder = new TextDecoder()
  let buf = ''
  for await (const chunk of stream as ReadableStream<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true })
    let idx = buf.indexOf('\n')
    while (idx >= 0) {
      yield buf.slice(0, idx)
      buf = buf.slice(idx + 1)
      idx = buf.indexOf('\n')
    }
  }
  buf += decoder.decode()
  if (buf) yield buf
}

/** Extracts the displayable text for one parsed JSONL event (same filter used for the
 *  transcript view, via the provider-aware event converter), so body search matches what's shown,
 *  not raw JSON noise like tool-call ids or base64. */
function displayableText(tf: TranscriptFile, ev: any): string[] {
  const tes = eventToTailEventsForSource(tf.source, ev)
  return tes.map((e) => e.text).filter(Boolean)
}

/** One file's outcome. `stoppedEarly` means the wall-clock budget ran out PART-WAY THROUGH this
 *  file, so its match count is an undercount and a miss proves nothing — the caller has to be able
 *  to say so rather than reporting a confident zero. */
interface FileSearchOutcome {
  hit: SessionSearchResult | null
  stoppedEarly: boolean
}

/** Exported for the unit test: this is where the deadline is actually noticed, and the flag it
 *  raises is what stops an empty result from being read as "the text is not on this machine".
 *  A foreign store is not JSONL, and streaming it line by line found NOTHING — every line failed
 *  JSON.parse and was skipped, so a Cursor or Zed conversation containing the query reported a
 *  confident zero. Those rows were already in this sweep (only OpenCode is excluded above), so the
 *  miss was silent: the session was listed, searched, and declared clean. Ask its adapter instead,
 *  exactly as the transcript view and the exporter already do. */
function searchForeignFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
): FileSearchOutcome {
  let matchCount = 0
  const snippets: string[] = []
  try {
    for (const ev of readForeignSession(tf.tool ?? '', tf.path)) {
      const idx = matcher(ev.text)
      if (idx === -1) continue
      matchCount++
      if (snippets.length < perFileLimit) snippets.push(snippetAround(ev.text, idx, SNIPPET_LEN))
    }
  } catch {
    return { hit: null, stoppedEarly: false }
  }
  // No deadline check: an adapter reads a whole conversation in one call, so there is no
  // part-way point to stop at and nothing to under-report. `stoppedEarly` stays false because it
  // means "this file's count is an undercount", which here it never is.
  if (matchCount === 0) return { hit: null, stoppedEarly: false }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: tf.cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  remember(hit, searchIndexKey(tf), tf)
  return { stoppedEarly: false, hit }
}

/** DeepSeek Harness: the same shape as the foreign branch above, and for the same reason — the
 *  conversation has to be decoded before there is any text to match. One decode per file, which is
 *  what every other reader of this store already pays. */
function searchDshFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
): FileSearchOutcome {
  let matchCount = 0
  const snippets: string[] = []
  const content = readDshSession(tf.path)
  if (!content) return { hit: null, stoppedEarly: false }
  for (const ev of content.events) {
    const idx = matcher(ev.text)
    if (idx === -1) continue
    matchCount++
    if (snippets.length < perFileLimit) snippets.push(snippetAround(ev.text, idx, SNIPPET_LEN))
  }
  if (matchCount === 0) return { hit: null, stoppedEarly: false }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: tf.cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  remember(hit, searchIndexKey(tf), tf)
  // Whole-conversation read, so there is no part-way point and nothing to under-report.
  return { hit, stoppedEarly: false }
}

/** HSwarm's jobs (source `'zswarm'`): same shape as the DSH branch above, and for the same reason -
 *  job.json's tasks/results have to be turned into a transcript before there is any text to match
 *  (see readHSwarmSession). Unlike DSH the file is plain JSON, but it is still one decode-then-scan,
 *  not a line stream, so it belongs beside dsh here rather than in the generic loop below. */
function searchHSwarmFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
): FileSearchOutcome {
  let matchCount = 0
  const snippets: string[] = []
  const content = readHSwarmSession(tf.path)
  if (!content) return { hit: null, stoppedEarly: false }
  for (const ev of content.events) {
    const idx = matcher(ev.text)
    if (idx === -1) continue
    matchCount++
    if (snippets.length < perFileLimit) snippets.push(snippetAround(ev.text, idx, SNIPPET_LEN))
  }
  if (matchCount === 0) return { hit: null, stoppedEarly: false }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: tf.cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  remember(hit, searchIndexKey(tf), tf)
  // Whole-conversation read, so there is no part-way point and nothing to under-report.
  return { hit, stoppedEarly: false }
}

/** One line's contribution to a file search: the cwd it revealed (if any, first-hit-wins so the
 *  caller only adopts it when it doesn't already have one), how many matches it added, and the
 *  snippets worth keeping. Pulled out of searchOneFile so the per-line parse/match branching
 *  doesn't live inside the streaming loop. */
function matchSearchLine(
  rawLine: string,
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
  snippetsSoFar: number,
): { cwd: string | null; matches: number; snippets: string[] } | null {
  const line = rawLine.trim()
  if (!line) return null
  let ev: any
  try {
    ev = JSON.parse(line)
  } catch {
    return null
  }
  const cwd =
    (typeof ev?.cwd === 'string' && ev.cwd) ||
    (typeof ev?.payload?.cwd === 'string' && ev.payload.cwd) ||
    null

  const snippets: string[] = []
  let matches = 0
  for (const text of displayableText(tf, ev)) {
    const idx = matcher(text)
    if (idx === -1) continue
    matches++
    if (snippetsSoFar + snippets.length < perFileLimit)
      snippets.push(snippetAround(text, idx, SNIPPET_LEN))
    break // one match counted per event line is enough signal; avoid double-counting blocks
  }
  return { cwd, matches, snippets }
}

/** `fromByte`: read from there to the end (a JSONL transcript's unindexed tail), not the whole file. */
export async function searchOneFile(
  tf: TranscriptFile,
  matcher: Matcher,
  perFileLimit: number,
  deadline: number,
  fromByte = 0,
): Promise<FileSearchOutcome> {
  if (tf.source === 'foreign') return searchForeignFile(tf, matcher, perFileLimit)
  // DeepSeek Harness IS one file per session, so it belongs in this sweep rather than in a
  // separate store pass — but the file is zstd, and streaming it as lines would fail every
  // JSON.parse and report the same confident zero the foreign branch above exists to prevent.
  if (tf.source === 'dsh') return searchDshFile(tf, matcher, perFileLimit)
  if (tf.source === 'zswarm') return searchHSwarmFile(tf, matcher, perFileLimit)

  let matchCount = 0
  const snippets: string[] = []
  let cwd = ''
  let stoppedEarly = false

  try {
    for await (const rawLine of streamLines(tf.path, fromByte)) {
      if (performance.now() > deadline) {
        stoppedEarly = true
        break
      }
      const result = matchSearchLine(rawLine, tf, matcher, perFileLimit, snippets.length)
      if (!result) continue
      if (!cwd && result.cwd) cwd = result.cwd
      matchCount += result.matches
      snippets.push(...result.snippets)
      if (snippets.length >= perFileLimit && matchCount >= perFileLimit * 4) break // this file is clearly a hit; stop early
    }
  } catch {
    return { hit: null, stoppedEarly } // unreadable/vanished file, skip silently, best-effort
  }

  if (matchCount === 0) return { hit: null, stoppedEarly }
  const hit: SessionSearchResult = {
    session_id: tf.session_id,
    source: tf.source,
    cwd: cwd || tf.project,
    project: tf.project,
    match_count: matchCount,
    truncated: snippets.length < matchCount,
    snippets,
  }
  remember(hit, searchIndexKey(tf), tf)
  return { stoppedEarly, hit }
}

/**
 * OpenCode-format stores, plural (audit AH-34): Kilo, MiMo Code and IcodeMate each keep their own
 * database in this same schema, and reading only the default one made every other product's
 * sessions unsearchable even though they were indexed and listed just fine. Same shape as
 * searchHermes below — build the store set from what the transcript index already resolved, then
 * loop each store's own reader — because a database is not a file this loop can stream.
 *
 * The internal `found` map is keyed by dedupeKey, not the bare session id (audit AH-35): two of
 * these stores can share a session id (Kilo and MiMo Code are both `source: 'opencode'`), and a
 * bare-id key would let the second store's events silently merge into the first's result.
 */
async function searchOpenCode(
  matcher: Matcher,
  perFileLimit: number,
  limit: number,
): Promise<SessionSearchResult[]> {
  const stores = new Map<string, string>() // dbPath -> tool (e.g. 'opencode', 'kilo', 'mimocode')
  for (const f of listTranscriptFiles())
    if (f.source === 'opencode') stores.set(f.path, f.tool ?? 'opencode')

  const found = new Map<string, SessionSearchResult>()
  for (const [dbPath, tool] of stores) {
    let seen = 0
    for (const event of await listOpenCodeSearchEventsAsync(dbPath)) {
      if (++seen % 400 === 0) await new Promise<void>((r) => setImmediate(r))
      const idx = matcher(event.text)
      if (idx === -1) continue
      const key = dedupeKey({
        source: 'opencode',
        tool,
        path: dbPath,
        session_id: event.session_id,
      })
      let result = found.get(key)
      if (!result) {
        if (found.size >= limit) continue
        result = {
          session_id: event.session_id,
          source: 'opencode',
          cwd: event.cwd,
          project: event.project,
          match_count: 0,
          truncated: false,
          snippets: [],
        }
        found.set(key, result)
        remember(result, key, { source: 'opencode', tool, session_id: event.session_id })
      }
      result.match_count++
      if (result.snippets.length < perFileLimit)
        result.snippets.push(snippetAround(event.text, idx, SNIPPET_LEN))
      result.truncated = result.snippets.length < result.match_count
    }
  }
  return [...found.values()]
}

/**
 * Hermes, same shape as searchOpenCode above but over every store this machine has, not just one —
 * a Hermes profile is a wholly separate database, so its sessions turn up nowhere in a single-path
 * lookup. Reuses the paths and profile groupings the transcript index already resolved rather than
 * re-walking the filesystem a second time to find the same stores.
 */
function searchHermes(
  matcher: Matcher,
  perFileLimit: number,
  limit: number,
): SessionSearchResult[] {
  // dbPath -> profile grouping (TranscriptFile.project) + product identity (TranscriptFile.tool)
  const stores = new Map<string, { project: string; tool: string }>()
  for (const f of listTranscriptFiles())
    if (f.source === 'hermes') stores.set(f.path, { project: f.project, tool: f.tool ?? 'hermes' })

  const found = new Map<string, SessionSearchResult>()
  for (const [dbPath, { project, tool }] of stores) {
    for (const event of listHermesSearchEvents(dbPath, project)) {
      const idx = matcher(event.text)
      if (idx === -1) continue
      // Two Hermes profiles both report tool: 'hermes' (session-locator.ts) — the database path is
      // what actually distinguishes them, which is exactly what dedupeKey's storeKey resolves to
      // for a database-backed format. A bare session-id key would merge them (audit AH-35).
      const key = dedupeKey({ source: 'hermes', tool, path: dbPath, session_id: event.session_id })
      let result = found.get(key)
      if (!result) {
        if (found.size >= limit) continue
        result = {
          session_id: event.session_id,
          source: 'hermes',
          cwd: event.cwd,
          project: event.project,
          match_count: 0,
          truncated: false,
          snippets: [],
        }
        found.set(key, result)
        remember(result, key, { source: 'hermes', tool, session_id: event.session_id })
      }
      result.match_count++
      if (result.snippets.length < perFileLimit)
        result.snippets.push(snippetAround(event.text, idx, SNIPPET_LEN))
      result.truncated = result.snippets.length < result.match_count
    }
  }
  return [...found.values()]
}

/** A tiny fixed-size worker pool: runs `items` through `fn` with at most `concurrency` in
 *  flight at once, so many small files don't serialize needlessly while large ones stream. */
async function pooledMap<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/** Nothing searched, nothing found — the shape a blank query answers with. */
const EMPTY_RESPONSE: SessionSearchResponse = {
  results: [],
  searched: 'scan',
  conversationOnly: false,
  budgetExhausted: false,
  limitReached: false,
  filesSearched: 0,
  filesTotal: 0,
  budgetMs: 0,
}

/** One pass of background indexing after a search found the index cold, bounded so it never competes
 *  for long with the searches after it. The daemon's keeper (startSearchIndexKeeper) does the steady
 *  work; this is for a process that has none (a script, a test). */
const INDEX_REFRESH_BUDGET_MS = 20_000

/**
 * Every file the search reads, for the index: the transcript index's and the CLI accounts' own, each
 * from a finished listing (never an empty "not listed yet").
 *
 * ⛔ NEVER A SEARCH'S SCOPED LIST. A refresh drops every session it is not handed, and until
 * 2026-10-17 the warm-up after a cold search was handed that search's own files: one search with
 * `instance=`, `source=` or `view=1` emptied the index of everything else, so the next search found it
 * cold again and scanned.
 */
async function everySearchFile(): Promise<TranscriptFile[]> {
  const [main, cli] = await Promise.all([ensureTranscriptIndex(), ensureCliTranscriptFiles()])
  return [...main, ...cli]
}

/** One refresh over every file, unless one is already running or queued (null then). */
async function refreshWholeIndex(budgetMs: number): Promise<IndexRefreshResult | null> {
  if (isRefreshing()) return null
  return refreshSearchIndex(await everySearchFile(), { budgetMs })
}

function warmIndexInBackground() {
  if (isRefreshing()) return
  void refreshWholeIndex(INDEX_REFRESH_BUDGET_MS).catch(() => {})
}

/** How often the daemon brings the index up to date, and how long one pass may run. */
const KEEP_EVERY_MS = 60_000
const KEEP_PASS_MS = 8_000
/** While a backlog remains (the first build, ~30 GB of transcripts on the owner's PC), the next pass
 *  comes this soon instead: about a third of one core until it is through, then a pass a minute. */
const KEEP_BACKLOG_MS = 15_000
let keeper: ReturnType<typeof setTimeout> | null = null

/**
 * Keep the conversation index current from the daemon, off every request.
 *
 * ⛔ WHY (2026-10-17). Nothing did. The index was refreshed only by a search that had just found it too
 * stale to answer, 20 s at a time, so between searches every chat that appended a line and every HSwarm
 * job written made it staler, and the next search after a few quiet hours scanned instead: on the
 * owner's PC 152 of the 2,119 files in scope changed in 12 hours, against the 42 the old 98% rule
 * allowed, and `search_sessions` read 54 of 2,119 files in its 7 s and missed a word said in a chat.
 * A pass only reads what changed (a running chat's new bytes, a new chat), so after the first build it
 * costs a few files a minute.
 */
export function startSearchIndexKeeper(firstDelayMs = 15_000): void {
  if (keeper) return
  const schedule = (ms: number) => {
    keeper = setTimeout(() => void pass(), ms)
    keeper.unref?.()
  }
  const pass = async () => {
    let backlog = false
    try {
      backlog = ((await refreshWholeIndex(KEEP_PASS_MS))?.remaining ?? 0) > 0
    } catch {
      // The next pass tries again; a search scans what the index does not hold meanwhile.
    }
    schedule(backlog ? KEEP_BACKLOG_MS : KEEP_EVERY_MS)
  }
  schedule(firstDelayMs)
}

/**
 * What the index can do for this search: how much of each file it holds (searchIndexHolds) when it is
 * open and holds any of them, 'cold' when the scan answers alone and the index is warmed after, null
 * when it never applies (a forced scan, or nothing in scope).
 *
 * A search never opens the index. bun:sqlite is synchronous, and an open of a file another process
 * holds waits out busy_timeout statement by statement: on GitHub's Windows runner the first search of
 * a run spent 7.2 s of its 7 s budget opening a fresh index file, then scanned nothing and missed a
 * one-file match (2026-10-13). The daemon opens it once listening (openSearchIndex).
 */
function indexPlan(opts: SearchOptions, files: TranscriptFile[]): number[] | 'cold' | null {
  if ((opts.mode ?? 'auto') !== 'auto' || files.length === 0) return null
  if (!searchIndexIsOpen()) return 'cold'
  const held = searchIndexHolds(files)
  return held?.some((bytes) => bytes > 0) ? held : 'cold'
}

/** Newest-active first, the order both paths return results in.
 *
 *  Keyed by store, not `${source}:${session_id}` (audit AH-35): two stores sharing a format and a
 *  session id (Kilo/MiMo Code, two Hermes profiles, a chat copied into two CLI accounts) would
 *  otherwise borrow each other's mtime. A file-backed result carries its own (remember); a database
 *  store's is looked up by the key it was built with, and one missing from both sorts as idle. */
function sortByActivity(results: SessionSearchResult[]): SessionSearchResult[] {
  let byStore: Map<string, number> | null = null
  const activityOf = (r: SessionSearchResult) => {
    const own = resultRow.get(r)?.mtime_ms
    if (own !== undefined) return own
    const key = resultStoreKey.get(r)
    if (key === undefined) return 0
    byStore ??= new Map(listTranscriptFiles().map((file) => [dedupeKey(file), file.mtime_ms]))
    return byStore.get(key) ?? 0
  }
  return results.sort((a, b) => activityOf(b) - activityOf(a))
}

/** Every file the search can read: the transcript index's, and the CLI accounts' own folders
 *  (cli-transcripts.ts), which the session list does not show. */
function allSearchFiles(): TranscriptFile[] {
  return [...listTranscriptFiles(), ...listCliTranscriptFiles()]
}

const isCliAccountRow = (f: TranscriptFile) => f.instance?.ref.startsWith('cli:') === true

/*
 * Streams every transcript's BODY content looking for `query`, newest files first. Constant
 * memory per file (streamLines), a small worker pool for cross-file concurrency, a per-file
 * early-exit once a file is clearly a match, and an overall wall-clock budget so a huge
 * history or a slow regex returns partial results instead of hanging the request.
 *
 * RETURNS A RESPONSE, NOT A BARE ARRAY, because the budget above makes "no matches" and "gave up
 * after 7 seconds" indistinguishable otherwise. An agent that reads an empty array as proof the
 * text does not exist anywhere is worse off than one that was never given the search at all, so
 * every caller now gets `budgetExhausted` and the file counts behind it.
 */
/** Every transcript file in scope for this search, OpenCode and Hermes excluded (each is searched
 *  separately — see `searchOpenCode`/`searchHermes` — because neither is a file this loop can
 *  stream), newest-first. */
function resolveSearchFiles(opts: SearchOptions): TranscriptFile[] {
  let files = allSearchFiles().filter(
    (file) => file.source !== 'opencode' && file.source !== 'hermes',
  )
  if (opts.source) files = files.filter((file) => file.source === opts.source)
  if (opts.instance) {
    const scope = opts.instance
    const imap = instanceSessionMap()
    files = files.filter((f) => {
      // Same precedence the session list uses (see instanceFieldsFor in sessions.ts): a store that
      // splits per ACCOUNT already names its own on the row, so it never falls through to the
      // Claude Desktop map — which holds no Codex ids and would reject every one of them.
      if (f.instance) return scope !== 'other' && instanceScopeMatches(f, scope)
      return scope === 'other'
        ? f.source === 'claude' && !imap.has(f.session_id)
        : f.source === 'claude' && imap.get(f.session_id) === scope
    })
  }
  const allow = opts.allow
  // The list's own rows: a CLI account's chats are not rows of it, though a copy can share an id.
  if (allow)
    files = files.filter((f) => !isCliAccountRow(f) && allow.has(`${f.source}:${f.session_id}`))
  return files.slice().sort((a, b) => b.mtime_ms - a.mtime_ms)
}

/** What a newest-first scan over some files found, and why it stopped. */
interface ScanOutcome {
  hits: SessionSearchResult[]
  filesSearched: number
  /** A file was abandoned part-way through when the clock ran out. */
  stoppedMidFile: boolean
  /** Whole batches were never opened because the clock ran out. */
  outOfTime: boolean
  /** Files were left unopened because `room` hits were found. */
  limitReached: boolean
}

/** Read `files` newest-first in batches, stopping once `room` of them matched or the clock runs out.
 *  Batches, so dispatching stops once the room is used without giving up the pool's concurrency. */
async function scanNewestFirst(
  files: TranscriptFile[],
  matcher: Matcher,
  room: number,
  perFileLimit: number,
  deadline: number,
): Promise<ScanOutcome> {
  const batchSize = CONCURRENCY * 3
  const out: ScanOutcome = {
    hits: [],
    filesSearched: 0,
    stoppedMidFile: false,
    outOfTime: false,
    limitReached: false,
  }
  for (let start = 0; start < files.length; start += batchSize) {
    // Deadline first: hitting the CAP is a different answer from running out of TIME, and the
    // caller reports them differently ("your limit" vs "results may be incomplete").
    if (performance.now() > deadline) {
      out.outOfTime = true
      break
    }
    if (out.hits.length >= room) {
      out.limitReached = true
      break
    }
    const batch = files.slice(start, start + batchSize)
    const results = await pooledMap(batch, CONCURRENCY, (tf) =>
      searchOneFile(tf, matcher, perFileLimit, deadline),
    )
    out.filesSearched += batch.length
    for (const r of results) {
      if (r.stoppedEarly) out.stoppedMidFile = true
      if (r.hit) out.hits.push(r.hit)
    }
  }
  return out
}

/**
 * The fast path: the conversation index says WHICH sessions, and only those are read. Called when the
 * index is open and holds any file in scope; returns null when it cannot answer this query (a regex, a
 * damaged index), meaning the caller must fall through to searchViaScan.
 *
 * The index holds no text of its own, so snippets and match counts still come from the real
 * transcripts. That keeps one source of truth for what a match looks like, and it is why the
 * index is small rather than a copy of everything it covers.
 *
 * WHAT THE INDEX DOES NOT HOLD YET IS READ HERE TOO, so the answer never depends on how current it is
 * (2026-10-17; before, anything under 98% current made the whole index stand aside):
 *   - a file that only grew since it was indexed (a running chat): just its new bytes;
 *   - a file it has not read (new since the last pass, rewritten, or a store it cannot read, such as an
 *     HSwarm job): the whole file, newest first, within the budget, which `budgetExhausted` reports.
 *
 * Narrowing by the substring matcher afterwards is deliberate, not redundant: the index matches
 * words case-insensitively, so it OVER-selects relative to a substring search, and running the
 * real matcher over the candidates keeps the answer identical in shape to what a scan would say.
 */
async function searchViaIndex(
  opts: SearchOptions,
  query: string,
  matcher: Matcher,
  files: TranscriptFile[],
  held: number[],
  found: SessionSearchResult[],
  limit: number,
  perFileLimit: number,
  deadline: number,
  budgetMs: number,
): Promise<SessionSearchResponse | null> {
  const answer = searchIndexCandidates(query, {
    regex: opts.regex,
    source: opts.source,
    exact: opts.caseSensitive,
  })
  if (!answer) return null
  const { relaxed } = answer
  const named: TranscriptFile[] = []
  const tails: Array<{ file: TranscriptFile; from: number }> = []
  const unread: TranscriptFile[] = []
  for (const [i, file] of files.entries()) {
    const bytes = held[i] ?? 0
    if (bytes > 0 && answer.keys.has(searchIndexKey(file))) named.push(file)
    else if (bytes === Number.POSITIVE_INFINITY) continue
    else if (bytes > 0) tails.push({ file, from: bytes })
    else unread.push(file)
  }

  let ranOut = false
  const exact: SessionSearchResult[] = []
  const loose: SessionSearchResult[] = []
  const take = (outcomes: FileSearchOutcome[], into: SessionSearchResult[]) => {
    for (const o of outcomes) {
      if (o.stoppedEarly) ranOut = true
      if (o.hit) into.push(o.hit)
    }
  }
  // 1. What running chats wrote since the index last read them: a few KB each.
  take(
    await pooledMap(tails, CONCURRENCY, (t) =>
      searchOneFile(t.file, matcher, perFileLimit, deadline, t.from),
    ),
    exact,
  )
  // 2. The sessions the index names. A looser rung answered (all the words apart, a typo the index
  // spells otherwise, any word): none of these sessions need hold the phrase, so the substring matcher
  // would throw every one away. Their snippets are read for the words that answered instead.
  const room = Math.max(0, limit - found.length - (relaxed ? 0 : exact.length))
  const reading = named.slice(0, room)
  const namedMatcher = relaxed ? anyWordMatcher(relaxed.words) : matcher
  take(
    await pooledMap(reading, CONCURRENCY, (tf) =>
      searchOneFile(tf, namedMatcher, perFileLimit, deadline),
    ),
    relaxed ? loose : exact,
  )
  // 3. The files the index has not read.
  const scan = await scanNewestFirst(
    unread,
    matcher,
    Math.max(0, limit - found.length - exact.length),
    perFileLimit,
    deadline,
  )
  // A looser rung's sessions stand only when nothing anywhere held the phrase itself.
  const useLoose = relaxed !== null && found.length + exact.length + scan.hits.length === 0
  const sorted = sortByActivity([...found, ...exact, ...scan.hits, ...(useLoose ? loose : [])])
  return {
    results: sorted.slice(0, limit),
    searched: 'index',
    // The honest caveat: what the index answered for is complete over what was SAID, silent about
    // tool output.
    conversationOnly: true,
    budgetExhausted: ranOut || scan.stoppedMidFile || scan.outOfTime,
    limitReached:
      ((relaxed === null || useLoose) && named.length > reading.length) ||
      scan.limitReached ||
      sorted.length > limit,
    // The index covered every file it holds; `reading.length` is only how many transcripts had to be
    // re-read for snippets. Reporting that smaller number would tell an agent the search reached 5 of
    // 1,359 sessions, which is the opposite of what happened. Files it does not hold count once read.
    filesSearched: files.length - unread.length + scan.filesSearched,
    filesTotal: files.length,
    budgetMs,
    ...(useLoose && relaxed ? { relaxed } : {}),
  }
}

/** The slow path: a newest-first scan over every file in scope, stopping once `limit` is hit or the
 *  clock runs out. */
async function searchViaScan(
  files: TranscriptFile[],
  matcher: Matcher,
  found: SessionSearchResult[],
  limit: number,
  perFileLimit: number,
  deadline: number,
  budgetMs: number,
): Promise<SessionSearchResponse> {
  const scan = await scanNewestFirst(files, matcher, limit, perFileLimit, deadline)
  const sorted = sortByActivity([...found, ...scan.hits])
  return {
    results: sorted.slice(0, limit),
    searched: 'scan',
    conversationOnly: false,
    // Either a file was abandoned part-way through, or whole batches were never opened because the
    // clock ran out. Both mean a miss is not evidence of absence. Files left unopened because the
    // LIMIT was hit are a different thing entirely, and are reported as `limitReached`.
    budgetExhausted: scan.stoppedMidFile || scan.outOfTime,
    // Trimming to `limit` is also a cap: OpenCode's rows are collected outside the file loop, so the
    // list can exceed the limit without the loop ever having noticed.
    limitReached: scan.limitReached || sorted.length > limit,
    filesSearched: scan.filesSearched,
    filesTotal: files.length,
    budgetMs,
  }
}

export async function searchSessionBodies(opts: SearchOptions): Promise<SessionSearchResponse> {
  const query = opts.query.trim()
  if (!query) return EMPTY_RESPONSE

  const matcher = buildMatcher(opts)
  const limit = opts.limit ?? DEFAULT_LIMIT
  const perFileLimit = opts.perFileLimit ?? DEFAULT_PER_FILE_LIMIT
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS
  const deadline = performance.now() + budgetMs

  await ensureTranscriptIndex() // so the sync lookups below never meet a cold cache
  const files = resolveSearchFiles(opts)

  const found: SessionSearchResult[] = []
  const includeOpenCode = (!opts.source || opts.source === 'opencode') && !opts.instance
  if (includeOpenCode) found.push(...(await searchOpenCode(matcher, perFileLimit, limit)))
  const includeHermes = (!opts.source || opts.source === 'hermes') && !opts.instance
  if (includeHermes) found.push(...searchHermes(matcher, perFileLimit, limit))

  if (opts.allow) {
    const allow = opts.allow
    const kept = found.filter((r) => allow.has(`${r.source}:${r.session_id}`))
    found.length = 0
    found.push(...kept)
  }

  const plan = indexPlan(opts, files)
  const answer =
    (Array.isArray(plan)
      ? await searchViaIndex(
          opts,
          query,
          matcher,
          files,
          plan,
          found,
          limit,
          perFileLimit,
          deadline,
          budgetMs,
        )
      : null) ??
    (await searchViaScan(files, matcher, found, limit, perFileLimit, deadline, budgetMs))
  // After this search has answered, never before its scan: the warm-up opens and writes the index
  // synchronously, which inside the search would spend its budget (see indexPlan).
  if (plan === 'cold') setImmediate(() => warmIndexInBackground())
  nameStores(answer.results)
  return answer
}
