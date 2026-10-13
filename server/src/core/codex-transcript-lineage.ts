import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { isPathInside, normalizeInstancePath } from './paths'

/** Where a paginated rollout's earlier rows live: the first `end_byte_offset` bytes of another
 * rollout of `thread_id`, whose last row there has ordinal `end_ordinal_exclusive - 1`. */
interface HistoryBase {
  thread_id: string
  end_ordinal_exclusive: number
  end_byte_offset: number
}

export interface CodexHistorySegment {
  path: string
  /** Bytes of this rollout the history uses: all of the newest, the boundary prefix of the rest. */
  bytes: number
  sha256: string
}

export interface CodexHistory {
  /** The chat's whole history as one self-contained rollout that needs no other file. */
  text: string
  /** Every rollout it was read from, oldest first; the last is the chat's own transcript. */
  segments: CodexHistorySegment[]
  /** Ordinal of the last row, so rows a copy gains later can be told from the copied history. */
  lastOrdinal: number
}

const MAX_SEGMENTS = 64

function firstRow(
  bytes: Buffer,
  path: string,
): { type?: string; payload?: Record<string, unknown> } {
  const end = bytes.indexOf(10)
  try {
    return JSON.parse(bytes.subarray(0, end < 0 ? bytes.length : end).toString('utf8'))
  } catch {
    throw new Error(`The transcript ${path} has no readable metadata.`)
  }
}

function historyBase(meta: { payload?: Record<string, unknown> }): HistoryBase | null {
  const base = meta.payload?.history_base as Partial<HistoryBase> | undefined
  if (!base) return null
  if (
    typeof base.thread_id !== 'string' ||
    !Number.isSafeInteger(base.end_ordinal_exclusive) ||
    !Number.isSafeInteger(base.end_byte_offset) ||
    base.end_byte_offset! <= 0
  )
    throw new Error('The transcript names an unreadable earlier history.')
  return base as HistoryBase
}

/** The row that ends exactly at `end`, or null when `end` is not a row boundary. */
function rowEndingAt(bytes: Buffer, end: number): { ordinal?: unknown } | null {
  if (end > bytes.length || bytes[end - 1] !== 10) return null
  const start = bytes.lastIndexOf(10, end - 2) + 1
  try {
    return JSON.parse(bytes.subarray(start, end - 1).toString('utf8'))
  } catch {
    return null
  }
}

function rollouts(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true })
    .map(String)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => join(dir, entry))
}

/** The one rollout in this home that holds `base`: it belongs to the named thread and its bytes
 * end a row with the named ordinal exactly at the named offset. Names alone are not trusted: a
 * thread's own continuation shares its id, and Codex itself reports a cycle when two match. */
function findBase(codexHome: string, base: HistoryBase, seen: Set<string>): string {
  const home = realpathSync(codexHome)
  const matches = ['sessions', 'archived_sessions']
    .flatMap((dir) => rollouts(join(codexHome, dir)))
    .filter((path) => path.includes(base.thread_id) && !seen.has(normalizeInstancePath(path)))
    .filter((path) => {
      const bytes = readFileSync(path)
      const row = rowEndingAt(bytes, base.end_byte_offset)
      return (
        isPathInside(home, realpathSync(path)) &&
        firstRow(bytes, path).payload?.id === base.thread_id &&
        row?.ordinal === base.end_ordinal_exclusive - 1
      )
    })
  if (matches.length !== 1)
    throw new Error(
      matches.length
        ? 'More than one transcript matches this chat’s earlier history. Nothing was copied.'
        : 'The earlier history this chat continues is missing from its account. Nothing was copied.',
    )
  return matches[0]!
}

function rowsOf(text: string): string[] {
  return text.split('\n').filter((line) => line.trim())
}

/** Read a Codex chat's complete displayed history. A paginated rollout can continue an earlier
 * one (`history_base`), which another CODEX_HOME cannot resolve: copying only the newest file
 * imported 5 of 7 turns (2026-10-13), and current Codex refuses such a copy outright. The result
 * keeps the newest metadata at ordinal 0, without the link, followed by every earlier row up to
 * each boundary and then the newest rows, untouched; ordinals keep their gaps where the dropped
 * metadata rows stood, which Codex accepts (measured: 7 of 7 turns, 517 of 517 items). */
export function readCodexHistory(transcriptPath: string, codexHome: string): CodexHistory {
  const chain: { path: string; bytes: Buffer; used: number }[] = []
  const seen = new Set<string>()
  let path = transcriptPath
  let used: number | null = null
  for (;;) {
    const key = normalizeInstancePath(path)
    if (seen.has(key) || chain.length >= MAX_SEGMENTS)
      throw new Error('This chat’s earlier history loops back on itself. Nothing was copied.')
    seen.add(key)
    const bytes = readFileSync(path)
    chain.push({ path, bytes, used: used ?? bytes.length })
    const base = historyBase(firstRow(bytes, path))
    if (!base) break
    path = findBase(codexHome, base, seen)
    used = base.end_byte_offset
  }
  const segments = chain
    .map(({ path, bytes, used }) => ({
      path,
      bytes: used,
      sha256: createHash('sha256').update(bytes.subarray(0, used)).digest('hex'),
    }))
    .reverse()
  const newest = chain[0]!
  if (chain.length === 1) {
    const text = newest.bytes.toString('utf8')
    const last = rowsOf(text).at(-1)
    return { text, segments, lastOrdinal: last ? (JSON.parse(last).ordinal ?? -1) : -1 }
  }
  const meta = JSON.parse(rowsOf(newest.bytes.toString('utf8'))[0]!)
  meta.ordinal = 0
  delete meta.payload.history_base
  const rows = chain
    .slice()
    .reverse()
    .flatMap(({ bytes, used }) => rowsOf(bytes.subarray(0, used).toString('utf8')).slice(1))
  let previous = 0
  for (const row of rows) {
    const ordinal = JSON.parse(row).ordinal
    if (!Number.isSafeInteger(ordinal) || ordinal <= previous)
      throw new Error('This chat’s history rows are out of order. Nothing was copied.')
    previous = ordinal
  }
  return {
    text: `${[JSON.stringify(meta), ...rows].join('\n')}\n`,
    segments,
    lastOrdinal: previous,
  }
}
