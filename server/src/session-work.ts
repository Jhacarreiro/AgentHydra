// server/src/session-work.ts - the repository a session worked in when it ran in a folder that is in no
// repository, for the spend report's "Cost by project" card (analytics.ts readSessionProjects).
//
// A chat started in a folder above the checkouts (one holding many repositories) has that folder as its
// cwd, and project-repo.ts finds no repository there: measured 2026-10-17 on the owner's PC, two such
// folders held $77.3K of $352K all-time, a fifth of the spend tied to no repository. The paths its tool
// calls touched say where it worked:
//  * a Claude transcript (a sub-agent's included, under its parent's session): every tool_use's
//    file_path, notebook_path and path, a relative one against the line's cwd, and the line's cwd of a
//    Bash or PowerShell call (the shell's folder, which a `cd` moves);
//  * a Codex rollout: each call's workdir (a shell call's, or one inside an exec script) and every file a
//    patch names, a relative one against the turn's cwd.
// Each path is a vote for the repository it is in; a path in none votes for nothing. A session is
// credited to the repository more than half of its votes name, and stays the folder with no such
// majority. On that PC the rule placed $56.7K of the $77.3K (82% of one folder, 62% of the other). Counting
// only edits placed about the same ($57.0K; the two disagree on 54 sessions), while counting the votes for
// no repository against the majority placed $30.6K: a session reads its agent's own config files too.
//
// A file is read once: session_work_read keeps how far, so a later pass reads only what the ledger ingested
// since (the kit's cursor offset). The votes are kept per file and repository root in session_work_vote.

import { open } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { timeSlice } from './core/loop-yield'
import { db } from './db'
import { type Lines, linesFrom, splitLines } from './kit/lines'
import type { KitStore } from './kit/store'
import { type ZipEntry, zipEntries, zipEntryStream } from './kit/zip-entries'
import { isAbsoluteCwd, repoOf, reposOf } from './project-repo'
import { pages, ROLLOUT, transcriptSession } from './session-cwds'

/** The tool_use input fields that name a file or folder. */
const PATH_FIELDS = ['file_path', 'notebook_path', 'path'] as const
/** Tools whose call runs in the line's cwd. */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell'])
/** Bytes read from a transcript at a time. */
const CHUNK = 1024 * 1024
const WRITE_BATCH = 200
/** What a Claude transcript line holding a tool call carries; the rest (the results, most of the bytes)
 *  is skipped without being decoded. */
const TOOL_USE = Buffer.from('"tool_use"')

/** The folders a transcript line's tool calls name: a file's folder, a folder itself, a shell's cwd. */
function claudeVotes(line: string, vote: (dir: string) => void): void {
  let j: { cwd?: unknown; message?: { content?: unknown } }
  try {
    j = JSON.parse(line)
  } catch {
    return
  }
  const cwd = typeof j.cwd === 'string' && isAbsoluteCwd(j.cwd) ? j.cwd : null
  const content = j.message?.content
  if (!Array.isArray(content)) return
  for (const c of content as {
    type?: unknown
    name?: unknown
    input?: Record<string, unknown>
  }[]) {
    if (c?.type !== 'tool_use' || !c.input) continue
    for (const f of PATH_FIELDS) {
      const v = c.input[f]
      if (typeof v !== 'string' || !v) continue
      const p = isAbsoluteCwd(v) ? v : cwd ? resolve(cwd, v) : null
      // `path` (Grep, Glob, most MCP tools) is usually a folder already.
      if (p) vote(f === 'path' ? p : dirname(p))
    }
    if (cwd && typeof c.name === 'string' && SHELL_TOOLS.has(c.name)) vote(cwd)
  }
}

/** A `workdir` key (quoted or not) and its string, in a call's JSON arguments or an exec script. */
const WORKDIR = /\bworkdir"?\s*:\s*"((?:[^"\\]|\\.)*)"/g
/** A patch's file line, up to its line break: a real one, or a `\n` escape inside a script's string. */
const PATCHED = /\*\*\* (?:Add|Update|Delete) File: (.+?)(?=(?<!\\)\\n|\r?\n|$)/gm

/** The folders a Codex call's text names, relative ones against `cwd`. */
function codexCallVotes(text: string, cwd: string | null, vote: (dir: string) => void): void {
  const at = (p: string) => (isAbsoluteCwd(p) ? p : cwd ? resolve(cwd, p) : null)
  for (const m of text.matchAll(WORKDIR)) {
    let wd: unknown
    try {
      wd = JSON.parse(`"${m[1]}"`)
    } catch {
      continue
    }
    const p = typeof wd === 'string' && wd ? at(wd) : null
    if (p) vote(p)
  }
  for (const m of text.matchAll(PATCHED)) {
    // Inside a script's string literal every backslash is doubled; a path never holds two in a row.
    const f = (m[1] ?? '').trim().replace(/\\\\/g, '\\')
    const p = f ? at(f) : null
    if (p) vote(dirname(p))
  }
}

interface RolloutState {
  /** The cwd of the turn in force: session_meta's, then each turn_context's. */
  cwd: string | null
}

function codexVotes(line: string, st: RolloutState, vote: (dir: string) => void): void {
  if (!line.includes('"cwd"') && !line.includes('_call"')) return
  let j: { type?: unknown; payload?: Record<string, unknown> }
  try {
    j = JSON.parse(line)
  } catch {
    return
  }
  const p = j.payload
  if (!p) return
  if (j.type === 'session_meta' || j.type === 'turn_context') {
    if (typeof p.cwd === 'string' && isAbsoluteCwd(p.cwd)) st.cwd = p.cwd
    return
  }
  if (j.type !== 'response_item') return
  // A shell call's arguments are JSON; an exec or apply_patch call's input is a script or a patch.
  const text =
    p.type === 'function_call' ? p.arguments : p.type === 'custom_tool_call' ? p.input : null
  if (typeof text === 'string') codexCallVotes(text, st.cwd, vote)
}

/** Each complete line of `path` from byte `from` holding `mark`, and the offset past the last complete
 *  line (a trailing line without its newline is a write in progress, left for the next pass). */
async function scanLines(
  path: string,
  from: number,
  mark: Buffer,
  onLine: (text: string) => void,
): Promise<number> {
  const file = await open(path, 'r')
  const slice = timeSlice()
  try {
    const buf = Buffer.allocUnsafe(CHUNK)
    let carry = Buffer.alloc(0)
    let pos = from // the file offset of carry's first byte
    for (;;) {
      const { bytesRead } = await file.read(buf, 0, CHUNK, pos + carry.length)
      if (!bytesRead) return pos
      const data = carry.length
        ? Buffer.concat([carry, buf.subarray(0, bytesRead)])
        : buf.subarray(0, bytesRead)
      const last = data.lastIndexOf(0x0a)
      if (last >= 0) {
        for (let at = 0; ; ) {
          const m = data.indexOf(mark, at)
          if (m < 0 || m > last) break
          const end = data.indexOf(0x0a, m)
          onLine(data.toString('utf8', data.lastIndexOf(0x0a, m) + 1, end))
          at = end + 1
          if (slice.due()) await slice.pause()
        }
        pos += last + 1
      }
      // A copy: `buf` is read into again.
      carry = Buffer.from(data.subarray(last + 1))
      if (slice.due()) await slice.pause()
    }
  } finally {
    await file.close()
  }
}

/** The complete lines of a rollout from byte `from`: a file, or `<zip>!<entry>` of a packed archive
 *  (inflated from its start, since a deflate stream cannot be entered midway). */
function rolloutFrom(
  key: string,
  from: number,
  zips: Map<string, Map<string, ZipEntry>>,
): Lines | null {
  const packed = /^(.*\.zip)!(.+)$/i.exec(key)
  if (!packed) return linesFrom(key, from)
  const [, zip = '', name = ''] = packed
  let entries = zips.get(zip)
  if (!entries) {
    entries = new Map(zipEntries(zip).map((e) => [e.name, e]))
    zips.set(zip, entries)
  }
  const e = entries.get(name)
  const bytes = e ? zipEntryStream(zip, e) : null
  return bytes ? splitLines(bytes, 0) : null
}

/** A rollout's votes from byte `from`, and the offset past its last complete line. */
async function rolloutLines(
  key: string,
  from: number,
  st: RolloutState,
  vote: (dir: string) => void,
  zips: Map<string, Map<string, ZipEntry>>,
): Promise<number> {
  const lines = rolloutFrom(key, from, zips)
  if (!lines) return from
  let end = from
  const slice = timeSlice()
  for await (const l of lines) {
    // The lines of an archive before `from` were counted already.
    if (l.end <= from) continue
    end = l.end
    codexVotes(l.text, st, vote)
    if (slice.due()) await slice.pause()
  }
  return end
}

type Read = [key: string, session: string, bytes: number, cwd: string]
type Vote = [key: string, session: string, root: string, n: number]

function writeWork(reads: Read[], votes: Vote[]): void {
  if (!reads.length) return
  const r = db.query(
    'insert or replace into session_work_read (key, session_id, bytes, cwd) values (?, ?, ?, ?)',
  )
  const v = db.query(
    `insert into session_work_vote (key, session_id, root, n) values (?, ?, ?, ?)
     on conflict (key, root) do update set n = n + excluded.n`,
  )
  db.transaction(() => {
    for (const x of votes) v.run(...x)
    for (const x of reads) r.run(...x)
  })()
  reads.length = 0
  votes.length = 0
}

/**
 * One pass: of the sessions `cwds` places in a folder that is in no repository, every file the ledger
 * read further than the last pass did is read from where that pass stopped, and the repositories its
 * tool calls' paths are in are counted. Returns the files read.
 */
export async function learnSessionWork(
  kit: KitStore,
  cwds: ReadonlyMap<string, string>,
): Promise<number> {
  const repos = await reposOf(new Set(cwds.values()))
  const loose = new Set<string>()
  for (const [session, cwd] of cwds) if (!repos.get(cwd)) loose.add(session)
  if (!loose.size) return 0
  const done = new Map<string, { bytes: number; cwd: string }>()
  for await (const r of pages<{ r: number; key: string; bytes: number; cwd: string }>(
    db,
    'select rowid as r, key, bytes, cwd from session_work_read where rowid > ? order by rowid',
  ))
    done.set(r.key, r)
  // The ledger session of each rollout (a sub-agent's is its parent's).
  const rolloutSession = new Map<string, string>()
  for await (const row of pages<{ r: number; key: string; value: string }>(
    kit.db,
    "select rowid as r, key, value from meta where key like 'ingest_state:%' and rowid > ? order by rowid",
  )) {
    const key = row.key.slice('ingest_state:'.length)
    const session = ROLLOUT.test(key) ? /"session":"([^"]+)"/.exec(row.value)?.[1] : undefined
    if (session && loose.has(session)) rolloutSession.set(key, session)
  }
  const roots = new Map<string, string | null>()
  const zips = new Map<string, Map<string, ZipEntry>>()
  const reads: Read[] = []
  const votes: Vote[] = []
  let n = 0
  for await (const { path, offset } of pages<{ r: number; path: string; offset: number }>(
    kit.db,
    'select rowid as r, path, offset from ingest_cursor where rowid > ? order by rowid',
  )) {
    if (!path.endsWith('.jsonl')) continue
    const rollout = ROLLOUT.test(path)
    const session = rollout
      ? rolloutSession.get(path)
      : /[\\/]projects[\\/]/.test(path)
        ? transcriptSession(path)
        : undefined
    if (!session || !loose.has(session)) continue
    const had = done.get(path)
    if (had && had.bytes >= offset) continue
    const dirs = new Map<string, number>()
    const vote = (dir: string) => dirs.set(dir, (dirs.get(dir) ?? 0) + 1)
    const st: RolloutState = { cwd: had?.cwd || null }
    let bytes: number
    try {
      bytes = rollout
        ? await rolloutLines(path, had?.bytes ?? 0, st, vote, zips)
        : await scanLines(path, had?.bytes ?? 0, TOOL_USE, (line) => claudeVotes(line, vote))
    } catch {
      // gone or unreadable: marked as read this far, so it is not tried again until the ledger moves on
      bytes = offset
    }
    const byRoot = new Map<string, number>()
    for (const [dir, k] of dirs) {
      let root = roots.get(dir)
      if (root === undefined) {
        root = (await repoOf(dir))?.root ?? null
        roots.set(dir, root)
      }
      if (root) byRoot.set(root, (byRoot.get(root) ?? 0) + k)
    }
    for (const [root, k] of byRoot) votes.push([path, session, root, k])
    reads.push([path, session, bytes, st.cwd ?? ''])
    n++
    if (reads.length >= WRITE_BATCH) writeWork(reads, votes)
  }
  writeWork(reads, votes)
  return n
}

/** Every session session_work_vote credits to a repository: the root more than half of its votes name. */
export async function workedRoots(): Promise<Map<string, string>> {
  const per = new Map<string, Map<string, { root: string; n: number }>>()
  for await (const r of pages<{ r: number; s: string; root: string; n: number }>(
    db,
    'select rowid as r, session_id as s, root, n from session_work_vote where rowid > ? order by rowid',
  )) {
    let m = per.get(r.s)
    if (!m) {
      m = new Map()
      per.set(r.s, m)
    }
    // One root however its files spelt it (a drive letter's case differs between sources).
    const k = r.root.toLowerCase()
    const v = m.get(k) ?? { root: r.root, n: 0 }
    v.n += r.n
    m.set(k, v)
  }
  const out = new Map<string, string>()
  for (const [s, m] of per) {
    let total = 0
    let best: { root: string; n: number } | null = null
    for (const v of m.values()) {
      total += v.n
      if (!best || v.n > best.n) best = v
    }
    if (best && best.n * 2 > total) out.set(s, best.root)
  }
  return out
}

/** How often a pass may start behind the spend report. */
const LEARN_EVERY_MS = 10 * 60_000
let learnedAt = 0
let learning: Promise<number> | null = null

/** Start a pass in the background unless one runs or ran within LEARN_EVERY_MS. `onLearned` is told
 *  when it read anything, so the caller's kept map can be read again. */
export function learnSessionWorkInBackground(
  kit: KitStore,
  cwds: () => ReadonlyMap<string, string>,
  onLearned: () => void,
): void {
  if (learning || Date.now() - learnedAt < LEARN_EVERY_MS) return
  learnedAt = Date.now()
  learning = learnSessionWork(kit, cwds())
    .then((n) => {
      if (n > 0) onLearned()
      return n
    })
    .catch(() => 0)
    .finally(() => {
      learning = null
    })
}
