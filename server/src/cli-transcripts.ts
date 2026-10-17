// server/src/cli-transcripts.ts - the CLI accounts' own transcripts, as rows the body search reads.
//
// ⛔ WHY (2026-10-17). A CLI account runs Claude Code with its own CLAUDE_CONFIG_DIR
// (`<CONFIG_DIR>/cli-instances/<id>`, core/cli-instances.ts), so every chat it has (CliMayte's workers
// included) is written under THAT folder's `projects/`, never under ~/.claude/projects. The transcript
// index (transcript.ts) globs ~/.claude/projects, the chat sync's viewer and the catalog's roots, so the
// search reached none of them: measured that day, 21,794 top-level transcripts (28 GB) in 75 accounts,
// against 515 in the main folder. A search for a word said in a CliMayte chat answered "no hits".
//
// They are search rows only. The session list, analytics and tail_session keep reading transcript.ts:
// listing 21,794 worker chats there would bury the conversations, and the kit already counts these
// accounts' spend from their own folders (kit/ingest-claude.ts). A row carries the account it was found
// in (`instance`, ref `cli:<id>`), which the search reports on each hit and keys the index by, because
// the same session id sits in several accounts once a chat is moved or relaunched (1,305 ids here).
//
// Cost: the folders come from the shared folder tree (core/folder-tree.ts), which the kit's sweep walks
// too, and a transcript is stat'd again only while it is being written (within HOT_MS) or on a full
// pass every FULL_RESTAT_MS: measured, a full stat of the 21,794 files is ~1 s of wall time and ~4 CPU-s.
// Subagent transcripts (`<project>/<session>/subagents/...`) are left out, as the main folder's are.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { listCliInstances } from './core/cli-instances'
import { walkFolderTree } from './core/folder-tree'
import { fsSlot } from './core/fs-slots'
import { timeSlice } from './core/loop-yield'
import { mapPool } from './core/map-pool'
import type { TranscriptFile } from './transcript'

/** How old a listing may be before a caller starts another in the background. */
const TTL_MS = 3 * 60_000
/** A transcript last written longer ago than this is trusted between full passes. */
const HOT_MS = 60 * 60_000
/** Every this often, every transcript is stat'd again whatever its age. */
const FULL_RESTAT_MS = 15 * 60_000
const STAT_WIDTH = 6

const statCache = new Map<string, { mtimeMs: number; size: number }>()
let lastFullAt = 0
let snapshot: { at: number; files: TranscriptFile[] } | null = null
let running: Promise<TranscriptFile[]> | null = null

/**
 * The last listing, at once; one older than TTL_MS starts a fresh one in the background. Empty until the
 * first listing lands: a search never waits for one (the daemon's keeper lists them at boot).
 */
export function listCliTranscriptFiles(): TranscriptFile[] {
  if (!snapshot || Date.now() - snapshot.at >= TTL_MS)
    void refreshCliTranscriptFiles().catch(() => {})
  return snapshot?.files ?? []
}

/** A finished listing no older than TTL_MS: the last one, or a new one waited for. What the index
 *  refresh reads, since it drops every session it is not handed and so must never get "not listed yet". */
export async function ensureCliTranscriptFiles(): Promise<TranscriptFile[]> {
  if (snapshot && Date.now() - snapshot.at < TTL_MS) return snapshot.files
  return refreshCliTranscriptFiles()
}

/** List them again now (callers already waiting share one listing). */
export function refreshCliTranscriptFiles(): Promise<TranscriptFile[]> {
  if (running) return running
  running = build().finally(() => {
    running = null
  })
  return running
}

interface Found {
  path: string
  project: string
  sessionId: string
}

async function build(): Promise<TranscriptFile[]> {
  const now = Date.now()
  const full = now - lastFullAt >= FULL_RESTAT_MS
  const files: TranscriptFile[] = []
  const seen = new Set<string>()
  const slice = timeSlice()
  for (const inst of listCliInstances()) {
    const instance = { ref: `cli:${inst.id}`, num: inst.num, name: inst.name }
    const found: Found[] = []
    for (const [dir, folder] of await walkFolderTree(join(inst.configDir, 'projects'))) {
      // `<project>/<session-id>.jsonl` is a session; anything deeper belongs to one (its subagents).
      if (!folder.rel || folder.rel.includes('/')) continue
      for (const name of folder.files) {
        if (!name.endsWith('.jsonl')) continue
        found.push({ path: join(dir, name), project: folder.rel, sessionId: name.slice(0, -6) })
      }
      if (slice.due()) await slice.pause()
    }
    const sizes = new Array<{ mtimeMs: number; size: number } | null>(found.length)
    const needStat: number[] = []
    for (const [i, f] of found.entries()) {
      seen.add(f.path)
      const known = statCache.get(f.path)
      if (known && !full && now - known.mtimeMs > HOT_MS) sizes[i] = known
      else needStat.push(i)
    }
    await mapPool(needStat, STAT_WIDTH, async (i) => {
      const path = (found[i] as Found).path
      try {
        const st = await fsSlot(() => stat(path))
        const entry = { mtimeMs: st.mtimeMs, size: st.size }
        statCache.set(path, entry)
        sizes[i] = entry
      } catch {
        statCache.delete(path) // gone between the listing and the stat
      }
    })
    for (const [i, f] of found.entries()) {
      const st = sizes[i]
      if (!st) continue
      files.push({
        session_id: f.sessionId,
        source: 'claude',
        path: f.path,
        project: f.project,
        mtime_ms: st.mtimeMs,
        size_bytes: st.size,
        archived: false,
        tool: 'claude-code',
        instance,
      })
    }
    if (slice.due()) await slice.pause()
  }
  for (const path of statCache.keys()) if (!seen.has(path)) statCache.delete(path)
  if (full) lastFullAt = now
  snapshot = { at: Date.now(), files }
  return files
}
