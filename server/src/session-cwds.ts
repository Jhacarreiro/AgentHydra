// server/src/session-cwds.ts - where the sessions ran that session_stats and session_scan_cache never
// saw, for the spend report's "Cost by project" card (analytics.ts readSessionProjects).
//
// Those two tables hold the sessions AgentHydra's own scans read. The usage ledger (kit/) counts more:
// CliMayte's config folders, every Codex rollout (a sub-agent's under its PARENT session id, and the ones
// that live only in packed zips) and every HSwarm job. Measured 2026-10-17 on the owner's PC, that spend
// ($57.9K all-time) all grouped under "unknown". Each source names its cwd itself:
//  * a Claude transcript (CliMayte included) on its lines' `cwd`; the ledger's session is the file's own
//    id (`<project>/<session>.jsonl`, `<project>/<session>/subagents/<agent>.jsonl`), the kit's
//    ingest_cursor lists every file it read;
//  * a Codex rollout on its first line (session_meta, payload.cwd); the kit's `ingest_state:<file or
//    zip!entry>` meta names the ledger session of each;
//  * a Copilot Chat log in the folder its VS Code window had open, which the ingest keeps in the kit's
//    meta (`copilot_cwd:<session>`);
//  * HSwarm's own store (hswarm.sqlite `utilizations`) on each job's caller_session and caller_cwd, the
//    session the ledger keys HSwarm's calls by. A caller that moved folders gets the one it ran most
//    jobs from.
// Each file is read ONCE (its head only) and what it said is kept in session_cwd_seen, so a pass after
// the first reads only files the ledger met since. The spend report never waits for a pass: it reads
// the table, and starts a pass behind it at most every LEARN_EVERY_MS.

import { Database } from 'bun:sqlite'
import { open, stat } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { timeSlice, yieldToLoop } from './core/loop-yield'
import { db } from './db'
import { hswarmHome } from './hswarm'
import type { KitStore } from './kit/store'
import { type ZipEntry, zipEntries, zipEntryHead } from './kit/zip-entries'
import { isAbsoluteCwd } from './project-repo'

export interface CwdSources {
  /** The usage ledger: its cursors list the Claude transcripts, its meta the Codex rollouts. */
  kit: KitStore
  /** HSwarm's own store, or null to leave HSwarm out. */
  hswarmDb: string | null
}

export function defaultCwdSources(kit: KitStore): CwdSources {
  return { kit, hswarmDb: join(hswarmHome(), 'hswarm.sqlite') }
}

export interface LearnSummary {
  claude: number
  codex: number
  copilot: number
  hswarm: number
}

/** How much of a file is read for its cwd, growing only while what was read names none. A rollout's first
 *  line runs ~23 KB with its cwd ~400 bytes in, and a transcript's first lines carry it (measured
 *  2026-10-17): the first step finds nearly all, where a 256 KB first read was ~600 times the bytes. */
const HEAD_STEPS = [16 * 1024, 256 * 1024, 2 * 1024 * 1024]
/** A file this old that names no cwd never will: it is marked so it is not read again. */
const SETTLED_MS = 60 * 60_000
/** A rollout file, or a packed one (`<zip>!rollout-...jsonl`). */
const ROLLOUT = /(^|[\\/!])rollout-[^\\/]*\.jsonl$/
const PAGE = 2000
const WRITE_BATCH = 200

/** The first `bytes` of a file, off the event loop (a pass reads thousands); null when it cannot be read. */
async function readHead(path: string, bytes: number): Promise<Buffer | null> {
  const file = await open(path, 'r').catch(() => null)
  if (!file) return null
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await file.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } catch {
    return null
  } finally {
    await file.close()
  }
}

/** The complete lines of a head, and the cut line after them ('' when the head ends on a line break). */
function headLines(buf: Buffer): { lines: string[]; cut: string } {
  const end = buf.lastIndexOf(0x0a)
  return end < 0
    ? { lines: [], cut: buf.toString('utf8') }
    : { lines: buf.toString('utf8', 0, end).split('\n'), cut: buf.toString('utf8', end + 1) }
}

/** The first `"cwd":"..."` a cut line names: the line's own field, which comes before its long parts. */
function cwdField(text: string): string | null {
  const m = /"cwd":"((?:[^"\\]|\\.)*)"/.exec(text)
  if (!m) return null
  try {
    const cwd = JSON.parse(`"${m[1]}"`)
    return typeof cwd === 'string' && cwd ? cwd : null
  } catch {
    return null
  }
}

/** The first `cwd` a Claude transcript's lines carry, or null. */
export async function transcriptCwd(path: string): Promise<string | null> {
  for (const bytes of HEAD_STEPS) {
    const buf = await readHead(path, bytes)
    if (!buf) return null
    const { lines, cut } = headLines(buf)
    for (const line of lines) {
      if (!line.includes('"cwd"')) continue
      try {
        const cwd = (JSON.parse(line) as { cwd?: unknown }).cwd
        if (typeof cwd === 'string' && cwd) return cwd
      } catch {
        // a damaged line: the next one says the same
      }
    }
    const cwd = cwdField(cut)
    if (cwd || buf.length < bytes) return cwd
  }
  return null
}

/** The session the ledger keys a Claude transcript by (kit/ingest-claude.ts), from its path. */
export function transcriptSession(path: string): string {
  const parts = path.split(/[\\/]/)
  const i = parts.lastIndexOf('subagents')
  return i > 0 ? (parts[i - 1] as string) : basename(path, '.jsonl')
}

/** payload.cwd of a rollout's first line (session_meta), or null. */
function rolloutCwdIn(buf: Buffer | null): string | null {
  if (!buf) return null
  const { lines, cut } = headLines(buf)
  const first = lines[0]
  if (first === undefined) return cwdField(cut)
  try {
    const cwd = (JSON.parse(first) as { payload?: { cwd?: unknown } }).payload?.cwd
    return typeof cwd === 'string' && cwd ? cwd : null
  } catch {
    return null
  }
}

/** The cwd a Codex rollout started in: a file, or `<zip>!<entry>` of a packed archive. */
export async function rolloutCwd(
  key: string,
  zips = new Map<string, Map<string, ZipEntry>>(),
): Promise<string | null> {
  const packed = /^(.*\.zip)!(.+)$/i.exec(key)
  if (!packed) {
    for (const bytes of HEAD_STEPS) {
      const buf = await readHead(key, bytes)
      const cwd = rolloutCwdIn(buf)
      if (cwd || !buf || buf.length < bytes) return cwd
    }
    return null
  }
  const [, zip = '', name = ''] = packed
  let entries = zips.get(zip)
  if (!entries) {
    entries = new Map(zipEntries(zip).map((e) => [e.name, e]))
    zips.set(zip, entries)
  }
  const e = entries.get(name)
  if (!e) return null
  for (const bytes of HEAD_STEPS) {
    const cwd = rolloutCwdIn(zipEntryHead(zip, e, bytes))
    if (cwd || e.compressedSize <= bytes) return cwd
  }
  return null
}

type Row = [source: string, key: string, session: string, cwd: string]

function writeSeen(rows: Row[]): void {
  if (!rows.length) return
  const q = db.query(
    'insert or replace into session_cwd_seen (source, key, session_id, cwd, n) values (?, ?, ?, ?, 1)',
  )
  db.transaction(() => {
    for (const r of rows) q.run(...r)
  })()
  rows.length = 0
}

function seenKeys(source: string): Set<string> {
  const out = new Set<string>()
  for (const r of db
    .query<{ key: string }, [string]>('select key from session_cwd_seen where source = ?')
    .all(source))
    out.add(r.key)
  return out
}

/** Every row of `sql` (which takes the last rowid and selects `rowid as r` in rowid order), a page at a
 *  time with a turn handed back between pages. */
async function* pages<T extends { r: number }>(h: Database, sql: string): AsyncGenerator<T> {
  const q = h.query<T, [number, number]>(`${sql} limit ?`)
  for (let last = 0; ; ) {
    const rows = q.all(last, PAGE)
    for (const row of rows) yield row
    if (rows.length < PAGE) return
    last = (rows[rows.length - 1] as T).r
    await yieldToLoop()
  }
}

/** Claude transcripts the ledger read whose session nothing else places. */
async function learnClaude(
  kit: KitStore,
  known: ReadonlySet<string>,
  now: number,
): Promise<number> {
  const seen = seenKeys('claude')
  const out: Row[] = []
  let n = 0
  const slice = timeSlice()
  for await (const { path } of pages<{ r: number; path: string }>(
    kit.db,
    'select rowid as r, path from ingest_cursor where rowid > ? order by rowid',
  )) {
    if (!path.endsWith('.jsonl') || ROLLOUT.test(path) || seen.has(path)) continue
    if (!/[\\/]projects[\\/]/.test(path)) continue
    const session = transcriptSession(path)
    if (known.has(session)) continue
    const cwd = await transcriptCwd(path)
    // A new file may not have written its first cwd yet: it is read again on a later pass.
    if (!cwd && now - ((await stat(path).catch(() => null))?.mtimeMs ?? 0) < SETTLED_MS) continue
    out.push(['claude', path, session, cwd ?? ''])
    n++
    if (out.length >= WRITE_BATCH) writeSeen(out)
    if (slice.due()) await slice.pause()
  }
  writeSeen(out)
  return n
}

/** Codex rollouts the ledger read whose session nothing else places. */
async function learnCodex(kit: KitStore, known: ReadonlySet<string>): Promise<number> {
  const seen = seenKeys('codex')
  const zips = new Map<string, Map<string, ZipEntry>>()
  const out: Row[] = []
  let n = 0
  const slice = timeSlice()
  for await (const row of pages<{ r: number; key: string; value: string }>(
    kit.db,
    "select rowid as r, key, value from meta where key like 'ingest_state:%' and rowid > ? order by rowid",
  )) {
    const key = row.key.slice('ingest_state:'.length)
    if (!ROLLOUT.test(key) || seen.has(key)) continue
    const session = /"session":"([^"]+)"/.exec(row.value)?.[1]
    if (!session || known.has(session)) continue
    out.push(['codex', key, session, (await rolloutCwd(key, zips)) ?? ''])
    n++
    if (out.length >= WRITE_BATCH) writeSeen(out)
    if (slice.due()) await slice.pause()
  }
  writeSeen(out)
  return n
}

/** Copilot Chat sessions whose session nothing else places. The ingest kept each one's folder in the
 *  ledger's meta (`copilot_cwd:<session>`, kit/ingest-copilot.ts), so no file is opened here. */
async function learnCopilot(kit: KitStore, known: ReadonlySet<string>): Promise<number> {
  const seen = seenKeys('vscode-copilot')
  const out: Row[] = []
  let n = 0
  for await (const row of pages<{ r: number; key: string; value: string }>(
    kit.db,
    "select rowid as r, key, value from meta where key like 'copilot\\_cwd:%' escape '\\' and rowid > ? order by rowid",
  )) {
    const session = row.key.slice('copilot_cwd:'.length)
    if (seen.has(session) || known.has(session)) continue
    out.push(['vscode-copilot', session, session, row.value])
    n++
    if (out.length >= WRITE_BATCH) writeSeen(out)
  }
  writeSeen(out)
  return n
}

/** HSwarm jobs since the last pass, counted per caller session and cwd. */
async function learnHswarm(path: string): Promise<number> {
  let h: Database
  try {
    // Read-only never creates the file: a PC without HSwarm throws here.
    h = new Database(path, { readonly: true })
  } catch {
    return 0
  }
  try {
    const mark =
      db
        .query<{ value: number }, []>("select value from session_cwd_mark where source = 'hswarm'")
        .get()?.value ?? 0
    const top =
      h.query<{ m: number | null }, []>('select max(rowid) as m from utilizations').get()?.m ?? 0
    if (top < mark) {
      // A store started over: its rowids mean nothing against the old mark.
      db.query("delete from session_cwd_seen where source = 'hswarm'").run()
    }
    const from = top < mark ? 0 : mark
    const votes = new Map<string, { session: string; cwd: string; n: number }>()
    let last = from
    const q = h.query<{ r: number; s: string | null; c: string | null }, [number, number]>(
      'select rowid as r, caller_session as s, caller_cwd as c from utilizations where rowid > ? order by rowid limit ?',
    )
    for (;;) {
      const rows = q.all(last, PAGE * 5)
      for (const { r, s, c } of rows) {
        last = r
        if (!s || !c) continue
        const k = `${s}\n${c}`
        const v = votes.get(k) ?? { session: s, cwd: c, n: 0 }
        v.n++
        votes.set(k, v)
      }
      if (rows.length < PAGE * 5) break
      await yieldToLoop()
    }
    const add = db.query(
      `insert into session_cwd_seen (source, key, session_id, cwd, n) values ('hswarm', ?, ?, ?, ?)
       on conflict (source, key) do update set n = n + excluded.n`,
    )
    db.transaction(() => {
      for (const [k, v] of votes) add.run(k, v.session, v.cwd, v.n)
      db.query("insert or replace into session_cwd_mark (source, value) values ('hswarm', ?)").run(
        last,
      )
    })()
    return votes.size
  } catch {
    // no utilizations table (an older HSwarm), or a busy store: the next pass tries again
    return 0
  } finally {
    h.close()
  }
}

/**
 * One pass over every source: the files the ledger met since the last pass whose session `known` does
 * not hold already are read for their cwd, and HSwarm's new jobs are counted. Returns rows written.
 */
export async function learnSessionCwds(
  src: CwdSources,
  known: ReadonlySet<string>,
  now = Date.now(),
): Promise<LearnSummary> {
  return {
    claude: await learnClaude(src.kit, known, now),
    codex: await learnCodex(src.kit, known),
    copilot: await learnCopilot(src.kit, known),
    hswarm: src.hswarmDb ? await learnHswarm(src.hswarmDb) : 0,
  }
}

/** Every session session_cwd_seen places, by session id: the cwd most of its rows name. */
export async function learnedSessionCwds(): Promise<Map<string, string>> {
  const votes = new Map<string, Map<string, { cwd: string; n: number }>>()
  for await (const r of pages<{ r: number; s: string; c: string; n: number }>(
    db,
    "select rowid as r, session_id as s, cwd as c, n from session_cwd_seen where cwd <> '' and rowid > ? order by rowid",
  )) {
    if (!isAbsoluteCwd(r.c)) continue
    let per = votes.get(r.s)
    if (!per) {
      per = new Map()
      votes.set(r.s, per)
    }
    const k = r.c.toLowerCase()
    const v = per.get(k) ?? { cwd: r.c, n: 0 }
    v.n += r.n
    per.set(k, v)
  }
  const out = new Map<string, string>()
  for (const [s, per] of votes) {
    let best: { cwd: string; n: number } | null = null
    for (const v of per.values()) if (!best || v.n > best.n) best = v
    if (best) out.set(s, best.cwd)
  }
  return out
}

/** How often a pass may start behind the spend report. */
const LEARN_EVERY_MS = 10 * 60_000
let learnedAt = 0
let learning: Promise<LearnSummary> | null = null

/** Start a pass in the background unless one runs or ran within LEARN_EVERY_MS. `onLearned` is told
 *  when it placed anything, so the caller's kept map can be read again. */
export function learnSessionCwdsInBackground(
  src: CwdSources,
  known: () => ReadonlySet<string>,
  onLearned: () => void,
): void {
  if (learning || Date.now() - learnedAt < LEARN_EVERY_MS) return
  learnedAt = Date.now()
  learning = learnSessionCwds(src, known())
    .then((s) => {
      if (s.claude + s.codex + s.copilot + s.hswarm > 0) onLearned()
      return s
    })
    .catch(() => ({ claude: 0, codex: 0, copilot: 0, hswarm: 0 }))
    .finally(() => {
      learning = null
    })
}
