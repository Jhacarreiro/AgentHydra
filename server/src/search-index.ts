// server/src/search-index.ts — the conversation index: find any session instantly, without
// putting a copy of your work on your disk.
//
// WHY THIS EXISTS, AND WHY IT IS SMALL. A content search streams every transcript and gives up
// after seven seconds, which on a real store (1,423 sessions, 4.4 GB) reaches about a fifth of it.
// A full-text index over the whole corpus was declined, correctly: it lands somewhere around
// 200 MB of second copies of files the user already has.
//
// Measured on that store, though, the corpus is not what it looks like:
//
//     tool results (file reads, greps, build logs) ... 343 MB   88%
//     assistant replies .............................. 24 MB    6%
//     human turns .................................... 22 MB    6%
//
// Nearly all of it is tool output: copies of files that are already on the disk, in a repo, under
// version control. Nobody searches a transcript for a grep result. They search it for a
// CONVERSATION they had. So this indexes conversation only, which measured 35 MB of text and, held
// CONTENTLESS (the index alone, no stored copy of the text), comes to ~12 MB on disk. That is
// 0.3% of the store it covers, smaller than the app's own binary, rebuildable from the transcripts
// at any moment, and deletable without losing a thing.
//
// THREE PROPERTIES IT MUST KEEP:
//
//   1. NEVER A DEPENDENCY. Missing, stale, corrupt or switched off, the streaming scan still
//      answers exactly as it did before. This file can be deleted mid-flight and search keeps
//      working, slower.
//   2. NEVER SILENTLY PARTIAL. The index covers conversation, not tool output, and matches whole
//      words rather than arbitrary substrings. Both are real limits, so every answer says which
//      path produced it and the caller can force the exhaustive scan.
//   3. NEVER IN THE WAY. Building it costs ~20 s the first time. That happens in the background,
//      never inside a request, and a search issued before it is ready simply takes the
//      non-indexed streaming scan described in property 1 above, which is permanent.
//
// One file, `search-index.db`, in the app's data dir, with journalling set to `delete` so it stays
// exactly one file: "you can delete it whenever you like" has to survive someone actually doing it.

import { Database, type Statement } from 'bun:sqlite'
import { rmSync, statSync } from 'node:fs'
import { open as open_ } from 'node:fs/promises'
import { join } from 'node:path'
import { DATA_DIR } from './config'
import { dedupeKey } from './session-locator'
import { isCodexInjectedUserText } from './transcript'
import type { SearchIndexStatus, SessionSource } from './types'

let indexPath = join(DATA_DIR, 'search-index.db')

/** Where the index lives. A function, not a constant, because the test drives it at a scratch
 *  path and the daemon must never be able to point at the wrong file by import order. */
export const searchIndexPath = (): string => indexPath

/** Bump to force a rebuild when the extraction or schema changes meaning. */
const SCHEMA_VERSION = 4

/**
 * A session's identity, store included (audit AH-35).
 *
 * Used to be `${source}:${sessionId}` alone, which collapses two different PRODUCTS that share a
 * format and a session id (Kilo and MiMo Code are both `source: 'opencode'`, two Hermes profiles
 * are both `tool: 'hermes'`) into one row — the second store indexed just overwrote the first's.
 * `dedupeKey` (session-locator.ts) is the one place that identity is computed everywhere else in
 * this codebase, so this index uses it too rather than inventing a second key format. Bumping
 * SCHEMA_VERSION above forces every row to be rebuilt under the new key rather than mixing old and
 * new formats silently.
 *
 * Plus the ACCOUNT, for a store split per account (2026-10-17). A CLI account keeps its chats in its
 * own folder (cli-transcripts.ts) and a moved or relaunched chat keeps its session id, so one id sat in
 * two or more accounts' folders 1,305 times on the owner's PC; under dedupeKey alone those copies were
 * one row, re-indexed from whichever file was seen last on every pass. A row with no account keeps the
 * key it always had, so the main folder's rows are not rebuilt.
 */
export function searchIndexKey(f: IndexableFile): string {
  const key = dedupeKey(f)
  return f.instance ? `${key}\0${f.instance.ref}` : key
}
const docKey = searchIndexKey

/**
 * Whether the index can read this file's conversation: a Claude transcript or a Codex rollout. Every
 * other store (an HSwarm job, a DeepSeek Harness file, a foreign adapter's database) has to be decoded
 * first, which only the scan does; indexing one recorded an EMPTY row that then counted as covered,
 * which is how 1,197 HSwarm jobs (56% of the files in scope on the owner's PC, 2026-10-17) sat in the
 * index as sessions it could never match. The search scans those files itself.
 */
export function searchIndexReads(f: { source: SessionSource }): boolean {
  return f.source === 'claude' || f.source === 'codex'
}

/**
 * One FTS insert of a huge body holds the daemon's loop (bun:sqlite is synchronous), so a body is
 * stored as several rows of at most SEGMENT_CHARS. FTS rowid = docRowid * SEGMENT_STRIDE + n, so
 * `rowid / SEGMENT_STRIDE` maps a hit back to its document. Consecutive segments overlap by
 * SEGMENT_OVERLAP chars so a phrase that straddles a cut is still found. Queries only need the set
 * of documents, so several hits in one document collapse in the Set.
 */
export const SEGMENT_CHARS = 256 * 1024
const SEGMENT_OVERLAP = 512
const SEGMENT_STRIDE = 65536
const DELETE_CHUNK = 4

/** Split on whitespace boundaries into overlapping pieces of at most `max` chars. */
export function segmentBody(text: string, max = SEGMENT_CHARS): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let start = 0
  while (start < text.length) {
    let end = Math.min(start + max, text.length)
    if (end < text.length) {
      const ws = Math.max(text.lastIndexOf(' ', end), text.lastIndexOf('\n', end))
      if (ws > start + SEGMENT_OVERLAP * 2) end = ws
    }
    out.push(text.slice(start, end))
    if (end >= text.length) break
    let next = end - SEGMENT_OVERLAP
    const ws = Math.max(text.indexOf(' ', next), text.indexOf('\n', next))
    next = ws >= 0 && ws < end ? ws : end
    start = next
  }
  return out
}

let db: Database | null = null

/**
 * After a failed open, no retry until this time. This used to be a permanent latch: one failed
 * open and the index stayed off for the rest of the process, every query falling back to the scan
 * with no way back short of a restart. A transient cause (GitHub's Windows runner, 2026-09-12: one
 * open that took 6.6 s and failed, on a fresh file an antivirus pass was still holding) therefore
 * switched the index off for good. A genuinely corrupt file must still not be re-opened on every
 * query, so the answer is a cooldown, not "try every time".
 */
const OPEN_RETRY_MS = 30_000
let openBlockedUntil = 0
let now = (): number => Date.now()

function open(): Database | null {
  if (db) return db
  if (now() < openBlockedUntil) return null
  try {
    db = new Database(indexPath, { create: true })
    // bun:sqlite's default busy timeout is 0: a file another process holds for a moment (a Windows
    // scanner on a fresh file, the 2026-10-10 runner) fails the open at once with "database is
    // locked", and the cooldown below then answers nothing for 30 s. Wait for the lock instead.
    db.exec('pragma busy_timeout = 2000')
    // One file, always: a WAL sidecar would make "just delete search-index.db" a corruption bug.
    // (`truncate` was measured 2026-10-17: half the commit time of a first build on Windows, but its
    // connection keeps the journal open, so another process writing in `delete` mode then fails its
    // commit with SQLITE_IOERR_DELETE. Fewer, larger commits (COMMIT_EVERY_MS) are used instead.)
    db.exec('pragma journal_mode = delete')
    db.exec('pragma synchronous = normal')
    db.exec('create table if not exists meta (k text primary key, v text not null)')
    const version = Number(
      (db.query('select v from meta where k = ?').get('schema') as { v?: string } | null)?.v ?? 0,
    )
    // A version bump rebuilds everything, and the doc table's shape is part of it (v4 added the
    // incremental-update columns), so it is dropped rather than emptied.
    if (version !== SCHEMA_VERSION) db.exec('drop table if exists doc')
    // done_bytes: end of the last complete transcript line already indexed; nseg: FTS segments held.
    db.exec(`
      create table if not exists doc (
        rowid      integer primary key,
        key        text    not null unique,
        source     text    not null,
        path       text    not null,
        mtime_ms   real    not null,
        size_bytes integer not null,
        done_bytes integer not null default 0,
        nseg       integer not null default 0
      );
    `)
    // contentless_delete=1 is what makes this incremental: a changed transcript can be dropped by
    // rowid and re-inserted without the index having kept the old text to hand back.
    db.exec(
      "create virtual table if not exists conv using fts5(body, tokenize='unicode61', content='', contentless_delete=1)",
    )
    // The index's own word list, read-only. Typo repair suggests only words this returns, so a
    // suggestion can never be a word the index does not hold.
    db.exec("create virtual table if not exists conv_vocab using fts5vocab(conv, 'row')")
    if (version !== SCHEMA_VERSION) {
      db.exec('delete from conv')
      db.query('insert or replace into meta (k, v) values (?, ?)').run(
        'schema',
        String(SCHEMA_VERSION),
      )
    }
    // Until 2026-10-10 a Codex rollout was recorded with none of its words (only Claude's lines were
    // read), so the index claimed Codex sessions it could never match. Those rows are dropped once;
    // the next refresh reads them again. Claude's rows are kept: a full rebuild would re-read them all.
    if (
      (db.query('select v from meta where k = ?').get('codex_text') as { v?: string } | null)?.v !==
      '1'
    ) {
      const conn = db
      // IMMEDIATE: this transaction reads before it writes. A deferred one asks for the write lock only
      // at its first write, and if another connection is writing by then SQLite answers "database is
      // locked" at once, never waiting out busy_timeout. The open then failed and the cooldown switched
      // the index off for 30 s (the root suite, 2026-10-11: a fresh index opened beside a writer).
      conn
        .transaction(() => {
          const dropSegments = conn.query('delete from conv where rowid >= ? and rowid < ?')
          for (const { rowid } of conn
            .query("select rowid from doc where source = 'codex'")
            .all() as Array<{ rowid: number }>)
            dropSegments.run(rowid * SEGMENT_STRIDE, (rowid + 1) * SEGMENT_STRIDE)
          conn.exec("delete from doc where source = 'codex'")
          conn.query('insert or replace into meta (k, v) values (?, ?)').run('codex_text', '1')
        })
        .immediate()
    }
    return db
  } catch {
    // A corrupt or unwritable index is not an error the user should ever see: it just means the
    // scan answers instead, and the next attempt waits out the cooldown.
    openBlockedUntil = now() + OPEN_RETRY_MS
    db = null
    return null
  }
}

/** True once the index file is open. A search consults the index only then (session-search.ts). */
export const searchIndexIsOpen = (): boolean => db !== null

/**
 * Open the index outside any search, and start keeping it current: the daemon does this once it is
 * listening. The open is synchronous and waits out busy_timeout statement by statement for a held file,
 * which a search must never pay. The keeper (session-search.ts startSearchIndexKeeper) refreshes it
 * off every request, a pass a minute; it reopens the index itself if this open failed. It is imported
 * here, when called, because session-search imports this file.
 */
export function openSearchIndex(): boolean {
  const ok = open() !== null
  void import('./session-search').then((m) => m.startSearchIndexKeeper()).catch(() => {})
  return ok
}

/** Close and forget the handle, so the file can be replaced or deleted underneath us. */
function close() {
  try {
    db?.close()
  } catch {
    /* already gone */
  }
  db = null
  docCache = null
}

/** What the index holds per session, as of the last write: read once per write, not once per search. */
let docCache: Map<string, KnownDoc> | null = null

function knownDocs(conn: Database): Map<string, KnownDoc> {
  if (docCache) return docCache
  const rows = new Map<string, KnownDoc>()
  for (const row of conn
    .query('select rowid, key, source, mtime_ms, size_bytes, done_bytes, nseg from doc')
    .all() as Array<KnownDoc & { key: string }>)
    rows.set(row.key, row)
  docCache = rows
  return rows
}

/** A Codex rollout's `response_item` payload: a message, or some other record we do not read. */
type CodexPayload = { type?: string; role?: string; content?: unknown }

/** The fields of a transcript line this index reads; every other field is ignored. */
type ConversationRecord = {
  type?: string
  message?: { content?: unknown }
  payload?: CodexPayload
}

/**
 * The searchable half of a transcript: what the person said and what the model said back.
 *
 * Tool results are deliberately dropped. They are 88% of the text and the least useful 88%: a
 * `tool_result` is a copy of a file the user already has, and indexing it is what turns a 12 MB
 * index into a 200 MB one.
 */
function pushConversationLine(line: string, out: string[]): void {
  const ev = parseConversationLine(line)
  if (!ev) return
  // A Codex rollout says it as `response_item` messages: input_text from the person, output_text back.
  // The runtime's own context, sent as user-role blocks, is left out as the transcript view leaves it out.
  if (ev.type === 'response_item') {
    pushCodexMessage(ev.payload, out)
    return
  }
  if (ev.type !== 'user' && ev.type !== 'assistant') return
  pushClaudeMessage(ev.message?.content, out)
}

/** The record on a line, or null for a line that is not a JSON object. */
function parseConversationLine(line: string): ConversationRecord | null {
  if (line.charCodeAt(0) !== 123 /* '{' */) return null
  try {
    return JSON.parse(line)
  } catch {
    return null // partial trailing write, or a record we do not understand
  }
}

/** A Codex message from the person or the model: its text blocks, in order. */
function pushCodexMessage(p: CodexPayload | undefined, out: string[]): void {
  if (p?.type !== 'message') return
  if (p.role !== 'user' && p.role !== 'assistant') return
  if (!Array.isArray(p.content)) return
  for (const block of p.content) pushCodexBlock(block, p.role, out)
}

/** One block of a Codex message: its text, unless it is not text or is the runtime's own context. */
function pushCodexBlock(
  block: { type?: string; text?: unknown } | null,
  role: string | undefined,
  out: string[],
): void {
  if (block?.type !== 'input_text' && block?.type !== 'output_text') return
  if (typeof block.text !== 'string') return
  if (role === 'user' && isCodexInjectedUserText(block.text)) return
  out.push(block.text)
}

/** A Claude message: a plain string, or a content list whose text blocks are kept. */
function pushClaudeMessage(content: unknown, out: string[]): void {
  if (typeof content === 'string') {
    out.push(content)
    return
  }
  if (!Array.isArray(content)) return
  for (const block of content) {
    // `text` only: thinking is filtered out of the transcript view too, and tool_use/tool_result
    // are the bulk this index exists to skip.
    if (block?.type === 'text' && typeof block.text === 'string') out.push(block.text)
  }
}

export function conversationText(jsonl: string): string {
  const out: string[] = []
  for (const line of jsonl.split('\n')) pushConversationLine(line, out)
  return out.join('\n')
}

/** conversationText for a big transcript on the daemon's loop: same result, but it hands the loop
 *  back every ~15 ms so a 100 MB session parse never freezes every route. */
export async function conversationTextAsync(jsonl: string): Promise<string> {
  const out: string[] = []
  let slice = performance.now()
  for (const line of jsonl.split('\n')) {
    pushConversationLine(line, out)
    if (performance.now() - slice > 15) {
      await new Promise<void>((r) => setImmediate(r))
      slice = performance.now()
    }
  }
  return out.join('\n')
}

/**
 * Can this query be answered from the index at all?
 *
 * The index tokenises on word boundaries, so it finds words and phrases, not arbitrary substrings:
 * scanning for "indowsHi" matches `windowsHide` and the index does not. Rather than guess whether a
 * given query is "word-shaped" and be silently wrong, the rule is blunt and checkable: a regex
 * search never uses the index, and a plain search does. The response says which path ran, and the
 * caller can always demand the exhaustive one.
 */
export function queryUsableByIndex(query: string, regex: boolean | undefined): boolean {
  if (regex) return false
  return query.trim().length > 0
}

/** The query's words: lowercased, with every non-word character a separator. Every rung of the
 *  search ladder builds from this one split, so the rungs cannot disagree about what the words are. */
function queryWords(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
}

/** Each word as its own quoted token, so FTS5 operator syntax inside a word stays inert. */
const quoteWord = (word: string) => `"${word}"`

/** The words as ONE adjacent phrase: the first rung, so "rate limit" still means those words in
 *  that order and an exact phrase keeps its ranking. */
const phraseOf = (words: string[]) => `"${words.join(' ')}"`

/** Turn a user's plain search into the FTS5 MATCH expression for its phrase, safely.
 *
 *  Everything that is not a word character becomes a separator, and the whole thing is quoted as
 *  ONE phrase. Quoting also makes FTS5 operator syntax (`OR`, `NEAR`, `*`, `-`) inert rather than a
 *  parse error or a surprise. searchIndexCandidates falls back to the looser rungs when this finds
 *  nothing. */
export function toMatchExpression(query: string): string | null {
  const words = queryWords(query)
  if (words.length === 0) return null // nothing but punctuation: the index cannot help
  return phraseOf(words)
}

export interface IndexRefreshResult {
  indexed: number
  removed: number
  /** Sessions re-indexed over an existing row (their old FTS rows were deleted). */
  replaced: number
  /** Sessions still needing work when a budget cut the pass short. */
  remaining: number
  ms: number
}

/** Files the index should hold, as the caller already knows them. */
export interface IndexableFile {
  session_id: string
  source: SessionSource
  path: string
  mtime_ms: number
  size_bytes: number
  /** Product identity, forwarded to dedupeKey() so two products sharing `source` + session id
   *  (e.g. Kilo and MiMo Code, both `source: 'opencode'`) never collapse to one indexed row. */
  tool?: string
  /** The account whose own store holds the file (a CLI account, a Codex instance): part of the key,
   *  see searchIndexKey. */
  instance?: { ref: string }
}

let refreshing = false

/** True while a refresh is running or queued, so a background caller does not queue another. */
export const isRefreshing = () => refreshing

/**
 * Bring the index in line with the files on disk, incrementally.
 *
 * A session is re-read only when its mtime or size moved, which after the first pass is a handful
 * of files rather than 1,211. `budgetMs` bounds one pass so a first build on a huge store makes
 * progress in slices instead of holding anything for a minute.
 */
interface StaleFileStatements {
  dropRow: Statement
  insertDoc: Statement
  insertFts: Statement
  markDone: Statement
  /** Run plain SQL (begin / commit / rollback) on the index connection. */
  exec: (sql: string) => void
  /** Delete FTS rows with rowid in [lo, hi). */
  dropFtsRange: Statement
  topFtsRow: Statement
  nextRowId: () => number
}

/** Delete every FTS segment of one document, a few at a time so no statement is long. */
async function dropSegments(stmts: StaleFileStatements, docRowid: number): Promise<void> {
  const lo = docRowid * SEGMENT_STRIDE
  const hi = lo + SEGMENT_STRIDE
  const top = (stmts.topFtsRow.get(lo, hi) as { n: number | null } | null)?.n
  if (top == null) return
  for (let at = lo; at <= top; at += DELETE_CHUNK) {
    stmts.dropFtsRange.run(at, Math.min(at + DELETE_CHUNK, hi))
    if (top - lo >= DELETE_CHUNK) await new Promise<void>((r) => setImmediate(r))
  }
}

const NL = String.fromCharCode(10)
const READ_CHUNK = 4 * 1024 * 1024
/** Past this many segments an appended-to session is rebuilt from scratch instead of growing one
 *  tiny segment per append (the rowid stride allows 65536). */
const MAX_APPEND_SEGMENTS = 512

/**
 * The conversation text of `path` from byte `start`, read in READ_CHUNK pieces and handing the loop
 * back every ~15 ms. The whole-file `Bun.file().text()` + `split` this replaces held the loop
 * ~250 ms on a 429 MB transcript (CPU profile: String.prototype.split, then JSON.parse).
 * `end` is the byte after the last COMPLETE line, so a later call can resume there.
 */
async function conversationTextFrom(
  path: string,
  start: number,
): Promise<{ text: string; end: number }> {
  const fh = await open_(path, 'r')
  try {
    const out: string[] = []
    let pos = start
    let carry: Buffer = Buffer.alloc(0)
    let slice = performance.now()
    const eat = async (region: Buffer) => {
      for (const line of region.toString('utf8').split(NL)) {
        pushConversationLine(line, out)
        if (performance.now() - slice > 15) {
          await new Promise<void>((r) => setImmediate(r))
          slice = performance.now()
        }
      }
    }
    for (;;) {
      const chunk = Buffer.allocUnsafe(READ_CHUNK)
      const { bytesRead } = await fh.read(chunk, 0, READ_CHUNK, pos)
      if (bytesRead === 0) break
      pos += bytesRead
      const got = chunk.subarray(0, bytesRead)
      const buf = carry.length ? Buffer.concat([carry, got]) : got
      const nl = buf.lastIndexOf(10)
      if (nl < 0) {
        carry = Buffer.from(buf)
        continue
      }
      await eat(buf.subarray(0, nl))
      carry = Buffer.from(buf.subarray(nl + 1))
    }
    const end = pos - carry.length
    // A complete last line with no newline yet: indexed now, re-read next time.
    if (carry.length) await eat(carry)
    return { text: out.join(NL), end }
  } finally {
    await fh.close()
  }
}

/** True when the byte before `offset` is a newline: the indexed prefix still ends a whole line. */
async function prefixIntact(path: string, offset: number): Promise<boolean> {
  if (offset <= 0) return false
  const fh = await open_(path, 'r')
  try {
    const b = Buffer.alloc(1)
    const { bytesRead } = await fh.read(b, 0, 1, offset - 1)
    return bytesRead === 1 && b[0] === 10
  } finally {
    await fh.close()
  }
}

type KnownDoc = {
  rowid: number
  source: string
  mtime_ms: number
  size_bytes: number
  done_bytes: number
  nseg: number
}

/** Index (or reindex) one stale file, split out of refreshSearchIndex so the pass loop reads as
 *  the schedule and this reads as the per-file work. A session that only grew is extended from its
 *  last indexed byte as new segments; anything else is rebuilt. Never throws — an unreadable or
 *  unindexable file just stays stale and is retried on the next pass. */
async function indexOneStaleFile(
  f: IndexableFile,
  known: Map<string, KnownDoc>,
  stmts: StaleFileStatements,
  result: IndexRefreshResult,
): Promise<void> {
  const key = docKey(f)
  const existing = known.get(key)
  let inSavepoint = false
  try {
    const append =
      existing !== undefined &&
      f.size_bytes > existing.size_bytes &&
      existing.nseg > 0 &&
      existing.nseg < MAX_APPEND_SEGMENTS &&
      existing.done_bytes <= f.size_bytes &&
      (await prefixIntact(f.path, existing.done_bytes))
    const from = append ? existing.done_bytes : 0
    const { text, end } = await conversationTextFrom(f.path, from)
    const rowid = existing?.rowid ?? stmts.nextRowId()
    let first = 0
    // A savepoint inside the pass's transaction (refreshSearchIndex opens it IMMEDIATE and commits it
    // every COMMIT_EVERY_MS): every commit is a journal fsync, and on Windows those commits (not the
    // FTS work) were the statements that stalled the loop past 100 ms, one per file. The savepoint
    // keeps a file that fails half-way from leaving half its rows.
    stmts.exec('savepoint one_file')
    inSavepoint = true
    if (append) {
      first = existing.nseg
    } else if (existing) {
      await dropSegments(stmts, rowid)
      stmts.dropRow.run(rowid)
      result.replaced++
    }
    if (!append) stmts.insertDoc.run(rowid, key, f.source, f.path, f.mtime_ms, f.size_bytes)
    const segments = text ? segmentBody(text) : []
    for (const [n, seg] of segments.entries()) {
      stmts.insertFts.run(rowid * SEGMENT_STRIDE + first + n, seg)
      if (segments.length > 1) await new Promise<void>((r) => setImmediate(r))
    }
    stmts.markDone.run(f.mtime_ms, f.size_bytes, end, first + segments.length, rowid)
    if (append) result.replaced++
    stmts.exec('release one_file')
    inSavepoint = false
    result.indexed++
  } catch {
    if (inSavepoint) {
      try {
        stmts.exec('rollback to one_file')
        stmts.exec('release one_file')
      } catch {
        /* nothing open */
      }
    }
    // vanished or unreadable mid-pass, or one unindexable session: it stays stale, retried next time
  }
}

/** FTS segments past which a refresh that deleted rows triggers `optimize`. Measured 12 on a
 *  58.7 MB file that should be ~12 MB; a healthy index sits at a handful. */
export const OPTIMIZE_SEGMENTS = 8
/** Free-list share of the file past which VACUUM runs (checked after optimize frees its pages). */
export const VACUUM_FREE_RATIO = 0.25
/**
 * Past this file size neither `optimize` nor VACUUM runs. Both rewrite the whole index in one
 * synchronous statement on the daemon's only thread: on the 45 MB index of 2026-10-13/14 an optimize
 * held it 3.6 s and 4.4 s (daemon.log STALL lines, innermost frame upkeepSearchIndex), and the tray
 * watchdog kills a daemon that misses three health probes 5 s apart. A big index is left to FTS5's own
 * automerge, which merges a little inside each insert, and freed pages are reused by the next inserts.
 */
export const UPKEEP_MAX_BYTES = 32 * 1024 * 1024
const UPKEEP_DELAY_MS = 1000

export interface UpkeepResult {
  segments: number
  optimized: boolean
  freeRatio: number
  vacuumed: boolean
}

/**
 * Compact the index: FTS `optimize` when segments exceed OPTIMIZE_SEGMENTS, then VACUUM when the
 * free list exceeds VACUUM_FREE_RATIO, on a file of at most UPKEEP_MAX_BYTES. Does nothing (returns
 * null) while a refresh is writing or when the index cannot be opened; never throws.
 */
export function upkeepSearchIndex(): UpkeepResult | null {
  if (refreshing) return null
  const conn = open()
  if (!conn) return null
  const out: UpkeepResult = { segments: 0, optimized: false, freeRatio: 0, vacuumed: false }
  try {
    const count = () =>
      Number(
        (conn.query('select count(distinct segid) as n from conv_idx').get() as { n: number }).n,
      )
    out.segments = count()
    const pages = (p: string) =>
      Number((conn.query(`pragma ${p}`).get() as Record<string, number>)[p])
    const small = pages('page_count') * pages('page_size') <= UPKEEP_MAX_BYTES
    if (small && out.segments > OPTIMIZE_SEGMENTS) {
      conn.exec("insert into conv(conv) values ('optimize')")
      out.optimized = true
    }
    const total = pages('page_count')
    out.freeRatio = total > 0 ? pages('freelist_count') / total : 0
    if (small && out.freeRatio > VACUUM_FREE_RATIO) {
      conn.exec('vacuum')
      out.vacuumed = true
    }
  } catch {
    // Upkeep is best-effort; a failure leaves the index as it was.
  }
  return out
}

let upkeepTimer: ReturnType<typeof setTimeout> | null = null

/** Queue upkeep off the request path; retried shortly if a refresh is writing at the time. */
function scheduleUpkeep() {
  if (upkeepTimer) return
  upkeepTimer = setTimeout(() => {
    upkeepTimer = null
    if (refreshing) return scheduleUpkeep()
    upkeepSearchIndex()
  }, UPKEEP_DELAY_MS)
  upkeepTimer.unref?.()
}

/** How long the pass's write transaction stays open before it commits and starts another. One commit
 *  per file was ~21,800 journal creations, fsyncs and deletions for the CLI accounts' first build alone,
 *  and on this PC under load a commit measured 165 ms on average (510 ms the worst), on the daemon's
 *  thread. A pass is cut by its budget, so this is a few commits a pass. */
const COMMIT_EVERY_MS = 2000
/** Readable sessions a pass may drop at once without question. Past this, a pass whose file list lost
 *  more than half of what the index holds keeps them: that is a store that could not be read this time
 *  (a CLI account registry refused as corrupt lists no accounts at all), not 20,000 deleted chats, and
 *  dropping them would cost a re-read of every one when it comes back. A row with no file is never
 *  searched (the search asks only about files it lists), so keeping it costs nothing but its bytes. */
const MASS_DROP_MIN = 200

let queue: Promise<unknown> = Promise.resolve()
let queued = 0

/**
 * Bring the index in line with `files` (every file the search reads: a session missing from it is
 * dropped), incrementally. Passes run one at a time: a call made during a pass waits for it.
 */
export function refreshSearchIndex(
  files: IndexableFile[],
  opts: { budgetMs?: number } = {},
): Promise<IndexRefreshResult> {
  queued++
  refreshing = true
  // The flag is cleared before the caller's await resumes, so a caller can run upkeep right after.
  const run = queue
    .then(() => refreshPass(files, opts))
    .finally(() => {
      if (--queued === 0) refreshing = false
    })
  queue = run.catch(() => {})
  return run
}

async function refreshPass(
  files: IndexableFile[],
  opts: { budgetMs?: number },
): Promise<IndexRefreshResult> {
  const started = performance.now()
  const deadline = opts.budgetMs ? started + opts.budgetMs : Number.POSITIVE_INFINITY
  const result: IndexRefreshResult = { indexed: 0, removed: 0, replaced: 0, remaining: 0, ms: 0 }
  const conn = open()
  if (!conn) return result

  // One write transaction at a time, committed every COMMIT_EVERY_MS. IMMEDIATE, as in open(): a
  // rebuild reads its old segments before deleting them, and a deferred transaction that has read is
  // refused at once, not made to wait, when another process writes.
  let txAt = -1
  const begin = () => {
    if (txAt >= 0) return
    conn.exec('begin immediate')
    txAt = performance.now()
  }
  const commit = (force: boolean) => {
    if (txAt < 0 || (!force && performance.now() - txAt < COMMIT_EVERY_MS)) return
    conn.exec('commit')
    txAt = -1
    docCache = null
  }
  try {
    const known = new Map(knownDocs(conn))

    const wanted = new Set<string>()
    const stale: IndexableFile[] = []
    for (const f of files) {
      if (!searchIndexReads(f)) continue
      const key = docKey(f)
      wanted.add(key)
      const have = known.get(key)
      if (!have || have.mtime_ms !== f.mtime_ms || have.size_bytes !== f.size_bytes) stale.push(f)
    }

    const dropRow = conn.query('delete from doc where rowid = ?')
    const dropFtsRange = conn.query('delete from conv where rowid >= ? and rowid < ?')
    const topFtsRow = conn.query('select max(rowid) as n from conv where rowid >= ? and rowid < ?')
    const nextRowId = () =>
      Number(
        (conn.query('select coalesce(max(rowid), 0) + 1 as n from doc').get() as { n: number }).n,
      )
    const insertDoc = conn.query(
      'insert into doc (rowid, key, source, path, mtime_ms, size_bytes) values (?, ?, ?, ?, ?, ?)',
    )
    const insertFts = conn.query('insert into conv (rowid, body) values (?, ?)')
    const markDone = conn.query(
      'update doc set mtime_ms = ?, size_bytes = ?, done_bytes = ?, nseg = ? where rowid = ?',
    )
    const stmts: StaleFileStatements = {
      dropRow,
      dropFtsRange,
      topFtsRow,
      insertDoc,
      insertFts,
      markDone,
      exec: (sql) => conn.exec(sql),
      nextRowId,
    }

    // Sessions the index holds that are no longer on disk. A row of a store the index cannot read
    // (an empty one an older build recorded, see searchIndexReads) always goes.
    const gone = [...known].filter(([key]) => !wanted.has(key))
    const readableGone = gone.filter(([, row]) =>
      searchIndexReads(row as { source: SessionSource }),
    )
    const keepReadable = readableGone.length > MASS_DROP_MIN && readableGone.length * 2 > known.size
    let dropSlice = performance.now()
    for (const [, row] of gone) {
      if (keepReadable && searchIndexReads(row as { source: SessionSource })) continue
      begin()
      dropRow.run(row.rowid)
      await dropSegments(stmts, row.rowid)
      result.removed++
      commit(false)
      if (performance.now() - dropSlice > 15) {
        await new Promise<void>((r) => setImmediate(r))
        dropSlice = performance.now()
      }
    }

    // Newest first: if a budget cuts the pass short, the sessions someone is most likely to search
    // for are the ones already covered.
    stale.sort((a, b) => b.mtime_ms - a.mtime_ms)
    for (const [i, f] of stale.entries()) {
      if (performance.now() > deadline) {
        result.remaining = stale.length - i
        break
      }
      begin()
      await indexOneStaleFile(f, known, stmts, result)
      commit(false)
    }

    begin()
    conn
      .query('insert or replace into meta (k, v) values (?, ?)')
      .run('built_at', String(Date.now()))
    commit(true)
  } catch {
    // Any failure leaves whatever was already committed in place; the scan covers the rest.
    if (txAt >= 0) {
      try {
        conn.exec('rollback')
      } catch {
        /* closed under us (dropSearchIndex) */
      }
    }
  } finally {
    docCache = null
    result.ms = performance.now() - started
  }
  // A re-indexed session deletes its old FTS rows too, so `indexed` counts when rows existed.
  if (result.removed + result.replaced > 0) scheduleUpkeep()
  return result
}

const andOf = (words: string[]) => words.map(quoteWord).join(' AND ')
const orOf = (words: string[]) => words.map(quoteWord).join(' OR ')

/** Session keys whose conversation matches one MATCH expression, optionally from one source. */
function keysMatching(conn: Database, match: string, source?: SessionSource): Set<string> {
  const rows = conn
    .query(
      source
        ? 'select d.key as key from conv c join doc d on d.rowid = c.rowid / 65536 where conv match ? and d.source = ?'
        : 'select d.key as key from conv c join doc d on d.rowid = c.rowid / 65536 where conv match ?',
    )
    .all(...(source ? [match, source] : [match])) as Array<{ key: string }>
  return new Set(rows.map((r) => r.key))
}

/** Edit distance between two words, two rows at a time: words are short, so this is cheap. */
function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const subst = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, subst)
    }
    prev = cur
  }
  return prev[b.length]
}

/** How alike a typo and a word must be, as 1 - distance / longer length. 0.8 is one wrong letter in
 *  a five-letter word, and one in a four-letter word is too many to guess at. */
const TYPO_MIN_SIMILARITY = 0.8

/** The closest word the index itself holds to `word`, or null. Candidates share its first letter
 *  and are within two letters in length, which keeps the vocabulary scan small. */
function closestIndexedWord(conn: Database, word: string): string | null {
  const head = word.codePointAt(0) ?? 0
  const rows = conn
    .query(
      'select term, doc from conv_vocab where term >= ? and term < ? and length(term) between ? and ? and doc > 0',
    )
    .all(
      String.fromCodePoint(head),
      String.fromCodePoint(head + 1),
      word.length - 2,
      word.length + 2,
    ) as Array<{ term: string; doc: number }>
  let best: { term: string; score: number; doc: number } | null = null
  for (const { term, doc } of rows) {
    const score = 1 - levenshtein(word, term) / Math.max(word.length, term.length)
    if (score < TYPO_MIN_SIMILARITY) continue
    // Ties go to the word more sessions use: a typo of "tests" is more likely "test" than "texts".
    if (!best || score > best.score || (score === best.score && doc > best.doc)) {
      best = { term, score, doc }
    }
  }
  return best?.term ?? null
}

/** The words with each one the index has no postings for swapped for its closest indexed word, or
 *  null when nothing needed or could be swapped. */
function repairedWords(conn: Database, words: string[]): string[] | null {
  let changed = false
  const out = words.map((word) => {
    if (conn.query('select 1 from conv where conv match ? limit 1').get(quoteWord(word))) {
      return word
    }
    const fix = closestIndexedWord(conn, word)
    if (fix === null) return word
    changed = true
    return fix
  })
  return changed ? out : null
}

/** A looser rung of the ladder answered: the session has `words` (each of them for 'all-words', the
 *  index's own spelling of a typo for 'repaired', at least one for 'any-word'), not the phrase. */
export interface RelaxedMatch {
  rung: 'all-words' | 'repaired' | 'any-word'
  words: string[]
}

export interface IndexCandidates {
  keys: Set<string>
  /** null when the phrase itself answered. Otherwise the caller matches each transcript against
   *  these words, since none of the sessions need hold the phrase. */
  relaxed: RelaxedMatch | null
}

/**
 * Session keys whose CONVERSATION matches, or null when the index cannot answer.
 *
 * Null is the important return: it means "ask the scanner", not "no matches". Every caller has to
 * keep those apart, which is the same distinction the search budget flag exists for. `exact` keeps
 * to the phrase (a case-sensitive search asked for exactly that).
 */
export function searchIndexCandidates(
  query: string,
  opts: { regex?: boolean; source?: SessionSource; exact?: boolean } = {},
): IndexCandidates | null {
  if (!queryUsableByIndex(query, opts.regex)) return null
  const words = queryWords(query)
  if (words.length === 0) return null // nothing but punctuation: the index cannot help
  const conn = open()
  if (!conn) return null
  try {
    // The retrieval ladder, adapted from the idea in stablyai/orca's AI vault search (MIT); the code
    // here is written fresh. The first rung with any hit answers, so a looser rung never adds noise
    // to a tighter one that already found something. Typo repair runs before OR so a misspelt word
    // beside a common one is not rescued by the common word's hits alone.
    const phrase = keysMatching(conn, phraseOf(words), opts.source)
    if (phrase.size > 0 || opts.exact) return { keys: phrase, relaxed: null }
    const multi = words.length > 1
    const rungs: Array<[string, RelaxedMatch]> = []
    if (multi) rungs.push([andOf(words), { rung: 'all-words', words }])
    const fixed = repairedWords(conn, words)
    if (fixed) {
      const repaired: RelaxedMatch = { rung: 'repaired', words: fixed }
      rungs.push([phraseOf(fixed), repaired])
      if (multi) rungs.push([andOf(fixed), repaired])
    }
    if (multi) rungs.push([orOf(words), { rung: 'any-word', words }])
    for (const [match, relaxed] of rungs) {
      const keys = keysMatching(conn, match, opts.source)
      if (keys.size > 0) return { keys, relaxed }
    }
    return { keys: new Set(), relaxed: null }
  } catch {
    return null // a damaged index: fall back, never throw
  }
}

/** How many of `files` the index already covers at their current mtime/size. */
export function searchIndexCoverage(files: IndexableFile[]): { covered: number; stale: number } {
  const conn = open()
  if (!conn) return { covered: 0, stale: files.length }
  const held = searchIndexHolds(files)
  const covered = held ? held.filter((bytes) => bytes === Number.POSITIVE_INFINITY).length : 0
  return { covered, stale: files.length - covered }
}

/**
 * How much of each file, as it is on disk now, the index holds: `Infinity` for all of it (its row is at
 * the file's current mtime and size), the byte offset where the unindexed part starts for a file that
 * only grew since it was indexed (a running chat), and 0 for none (never indexed, rewritten, or a store
 * the index cannot read). Null when the index is not open; this never opens it (a search must not, see
 * session-search.ts).
 *
 * This is what lets a search use the index whatever share of the store is current: before 2026-10-17
 * the index answered only when 98% of the files in scope were exactly current, and every chat that had
 * appended a line since the last refresh, or HSwarm job written, counted against that, so after a few
 * quiet hours it stood aside entirely and a 7 s scan read 54 of 2,119 files.
 */
export function searchIndexHolds(files: IndexableFile[]): number[] | null {
  const conn = db
  if (!conn) return null
  try {
    const known = knownDocs(conn)
    return files.map((f) => {
      if (!searchIndexReads(f)) return 0
      const have = known.get(docKey(f))
      if (!have) return 0
      if (have.mtime_ms === f.mtime_ms && have.size_bytes === f.size_bytes)
        return Number.POSITIVE_INFINITY
      // Transcripts are appended to: one that grew still starts with what was indexed. A file of the
      // same size or smaller was rewritten, and the index's copy of it says nothing.
      if (f.size_bytes > have.size_bytes && have.done_bytes > 0) return have.done_bytes
      return 0
    })
  } catch {
    return null
  }
}

export function searchIndexStatus(): SearchIndexStatus {
  let exists = false
  let sizeBytes = 0
  try {
    const st = statSync(indexPath, { throwIfNoEntry: false })
    exists = st !== undefined
    sizeBytes = st?.size ?? 0
  } catch {
    /* raced with a delete */
  }
  const conn = exists ? open() : null
  let sessions = 0
  let builtAt: number | null = null
  if (conn) {
    try {
      sessions = Number(
        (conn.query('select count(*) as n from doc').get() as { n: number } | null)?.n ?? 0,
      )
      const at = (conn.query('select v from meta where k = ?').get('built_at') as { v?: string })?.v
      builtAt = at ? Number(at) : null
    } catch {
      /* unreadable: report it as empty rather than failing the settings page */
    }
  }
  return { exists, sizeBytes, sessions, builtAt, refreshing }
}

/** Delete the index. It rebuilds itself from the transcripts, so this loses nothing but time. */
export function dropSearchIndex(): boolean {
  close()
  try {
    rmSync(indexPath, { force: true })
    // A journal left by a write cut off mid-way would otherwise be replayed into the NEW file.
    rmSync(`${indexPath}-journal`, { force: true })
    openBlockedUntil = 0
    return true
  } catch {
    return false
  }
}

/** Test seam: point the index at a scratch file and forget any open handle, and any upkeep queued for
 *  the old file: left to fire, it opened the next test's file a second later, in the middle of that test. */
export function setSearchIndexPathForTests(path: string) {
  close()
  if (upkeepTimer) clearTimeout(upkeepTimer)
  upkeepTimer = null
  openBlockedUntil = 0
  indexPath = path
}

/** Test seam: the clock the open cooldown reads, so a test can wait 30 s without waiting. */
export function setSearchIndexClockForTests(clock: (() => number) | null) {
  now = clock ?? (() => Date.now())
}
