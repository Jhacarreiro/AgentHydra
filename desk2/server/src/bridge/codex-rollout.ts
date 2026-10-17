// A Codex chat's rollout file, and how full its context window is, read-only. Codex writes every thread to
// <codex home>/sessions/<yyyy>/<mm>/<dd>/rollout-<started>-<thread id>.jsonl, and after each turn a `token_count` event
// whose `info` holds the last turn's `last_token_usage` and the model's `model_context_window`: unlike Claude Code's file,
// enough for a share. Desk reaches an outside Codex chat's transcript through AgentHydra's tail, which carries neither.

import { statSync } from 'node:fs'
import { open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { readTail, TAIL_BYTES } from './session-jsonl'

/** A thread id that can only name a rollout: no dots, no separators. */
const THREAD_ID = /^[A-Za-z0-9-]{8,80}$/

const newestFirst = async (dir: string): Promise<string[]> => (await readdir(dir).catch(() => [] as string[])).sort().reverse()

/** The thread's rollout under any of the homes, or null: its day folder (the newest first), or archived_sessions/, where Codex
 *  moves an archived thread's file, flat (an Unassigned chat is archived on its account). */
export async function findCodexRollout(threadId: string, homes: readonly string[]): Promise<string | null> {
  if (!THREAD_ID.test(threadId)) return null
  const tail = `-${threadId}.jsonl`
  const inDir = async (dir: string) => {
    const hit = (await readdir(dir).catch(() => [] as string[])).find((f) => f.startsWith('rollout-') && f.endsWith(tail))
    return hit ? join(dir, hit) : null
  }
  for (const home of homes) {
    const root = join(home, 'sessions')
    for (const y of await newestFirst(root))
      for (const m of await newestFirst(join(root, y)))
        for (const d of await newestFirst(join(root, y, m))) {
          const hit = await inDir(join(root, y, m, d))
          if (hit) return hit
        }
    const archived = await inDir(join(home, 'archived_sessions'))
    if (archived) return archived
  }
  return null
}

/** The tokens in context after the thread's last turn, the model's window (null when its event names none) and the thread's
 *  running total so far (`total_token_usage`; null when the event has none), from the newest `token_count` event with a last
 *  turn's usage; null when the file's end has none. */
export function lastCodexContext(path: string): { tokens: number; window: number | null; total: number | null } | null {
  const size = statSync(path).size
  for (const max of [256 * 1024, TAIL_BYTES]) {
    const lines = readTail(path, max).split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!
      if (!line.includes('"token_count"')) continue
      try {
        const rec = JSON.parse(line) as { payload?: { type?: unknown; info?: { last_token_usage?: { total_tokens?: unknown }; total_token_usage?: { total_tokens?: unknown }; model_context_window?: unknown } | null } }
        const info = rec.payload?.type === 'token_count' ? rec.payload.info : null
        const tokens = info?.last_token_usage?.total_tokens
        if (typeof tokens !== 'number' || !(tokens > 0)) continue
        const window = info?.model_context_window
        const total = info?.total_token_usage?.total_tokens
        return { tokens, window: typeof window === 'number' && window > 0 ? window : null, total: typeof total === 'number' && total > 0 ? total : null }
      } catch {
        // the tail's first line may be cut
      }
    }
    if (size <= max) break
  }
  return null
}

/** The event_msg types that open and close a Codex turn: every turn starts with `task_started` and ends with `task_complete`, or
 *  `turn_aborted` when it was stopped (read 2026-10-14 over the 40 newest rollouts: 176 started, 174 complete, 1 aborted, 1 open). */
const TURN_MARK = /"type":"(task_started|task_complete|turn_aborted)"/
export const TURN_TAIL_BYTES = 256 * 1024

/** Whether the thread's last turn is still open: its newest turn mark is `task_started`. A tail holding no mark at all, from a
 *  file longer than the tail, is a turn whose own output has filled the tail since it started, so open too. */
export function codexTurnOpen(path: string): boolean {
  const size = statSync(path).size
  const lines = readTail(path, TURN_TAIL_BYTES).split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!
    if (!line.includes('"event_msg"')) continue
    const mark = TURN_MARK.exec(line)?.[1]
    if (!mark) continue
    try {
      if ((JSON.parse(line) as { payload?: { type?: unknown } }).payload?.type !== mark) continue
    } catch {
      continue // the tail's first line may be cut
    }
    return mark === 'task_started'
  }
  return size > TURN_TAIL_BYTES
}

/** A turn's opening mark as the rollout's bytes hold it: an event whose own type it is (one nesting the type deeper is not a
 *  mark, as in codexTurnOpen). Its quotes are JSON's own: inside a message's text they are escaped (\"), so a message that
 *  mentions the mark never counts. Read 2026-10-17 over the 12 newest rollouts: the same count as parsing each line. */
const TURN_STARTED = Buffer.from('"payload":{"type":"task_started"')
const COUNT_READ_BYTES = 4 * 1024 * 1024
/** Per rollout: the bytes counted, the turns in them, and their last bytes, where a mark the next read completes begins. */
const counted = new Map<string, { size: number; turns: number; carry: Buffer }>()
const COUNTED_KEPT = 200

/** The thread's turns: its rollout's `task_started` marks over the whole file, as Codex counts them, where AgentHydra's usage does
 *  not count Codex and the transcript Desk holds is only the thread's newest part (2026-10-17: a 124-turn thread read "15 turns",
 *  the prompts in its loaded page). Kept per file, so a count reads only what was appended since the last one (a long thread's
 *  rollout runs to hundreds of MB); a file that shrank was replaced, and is counted again. */
export async function codexTurnCount(path: string): Promise<number> {
  const size = (await stat(path)).size
  let at = counted.get(path)
  if (!at || size < at.size) at = { size: 0, turns: 0, carry: Buffer.alloc(0) }
  let { turns, carry } = at
  let pos = at.size
  if (pos < size) {
    const fh = await open(path, 'r')
    try {
      const chunk = Buffer.allocUnsafe(Math.min(COUNT_READ_BYTES, size - pos))
      while (pos < size) {
        const { bytesRead } = await fh.read(chunk, 0, Math.min(chunk.length, size - pos), pos)
        if (!bytesRead) break
        pos += bytesRead
        const bytes = Buffer.concat([carry, chunk.subarray(0, bytesRead)])
        for (let i = bytes.indexOf(TURN_STARTED); i !== -1; i = bytes.indexOf(TURN_STARTED, i + TURN_STARTED.length)) turns++
        // Shorter than the mark, so no mark is counted twice; copied, so the chunk is not held.
        carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - (TURN_STARTED.length - 1))))
      }
    } finally {
      await fh.close()
    }
  }
  counted.delete(path)
  counted.set(path, { size: pos, turns, carry })
  while (counted.size > COUNTED_KEPT) counted.delete(counted.keys().next().value!)
  return turns
}
