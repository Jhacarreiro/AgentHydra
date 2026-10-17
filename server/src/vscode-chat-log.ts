// server/src/vscode-chat-log.ts — VS Code's chat files, replayed: shared by the session list (foreign-sessions.ts)
// and the usage ledger (kit/ingest-copilot.ts), so the two cannot disagree about what a chat holds.
//
// Since 2025 VS Code writes each Copilot chat as an operation log, its ObjectMutationLog
// (chat/common/model/objectMutationLog.ts), one JSON entry per line: kind 0 is the whole chat, kind 1 sets a
// value at a path, kind 2 pushes onto the array at a path (with `i`, the array is first cut to that length;
// `v` may be absent, a cut alone), kind 3 deletes, which VS Code replays as setting undefined. Past 512
// entries VS Code rewrites the file as one kind 0 line. An older chat is one `.json` document of the kind 0
// shape. Measured 2026-10-17 on the owner's PC: 944 logs, 47,218 entries, no kind 3 at all, and pushes onto a
// request's `response` the largest share.
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

/** One log line: `{ kind, k, v, i }`. */
export interface ChatOp {
  kind?: unknown
  k?: unknown
  v?: unknown
  i?: unknown
}

export type ChatPath = ReadonlyArray<string | number>

/**
 * What a replay keeps of a value as it lands at `path`: kind 0's whole chat at [], a set or deleted value at
 * its path, each pushed element at the index it takes. Undefined keeps nothing there. The ledger keeps only
 * what it counts; the session list keeps everything.
 */
export type ChatKeep = (path: ChatPath, v: unknown) => unknown

const keepAll: ChatKeep = (_, v) => v

const isPath = (k: unknown): k is Array<string | number> =>
  Array.isArray(k) &&
  k.length > 0 &&
  k.every((s) => typeof s === 'string' || (typeof s === 'number' && Number.isInteger(s) && s >= 0))

/**
 * Applies one entry to the replayed chat and returns it (kind 0 replaces it). Never throws: an entry whose
 * path runs through something the replay does not hold (dropped by `keep`, or a log that began mid-way) is
 * skipped, where VS Code itself would fail the whole read.
 */
export function applyChatOp(state: unknown, op: ChatOp, keep: ChatKeep = keepAll): unknown {
  if (op.kind === 0) return keep([], op.v)
  if (op.kind !== 1 && op.kind !== 2 && op.kind !== 3) return state
  const k = op.k
  if (!isPath(k)) return state
  let parent: unknown = state
  for (const seg of k.slice(0, -1)) {
    if (!parent || typeof parent !== 'object') return state
    parent = (parent as Record<string | number, unknown>)[seg]
  }
  if (!parent || typeof parent !== 'object') return state
  const at = parent as Record<string | number, unknown>
  const key = k[k.length - 1] as string | number
  if (op.kind === 2) {
    const arr = Array.isArray(at[key]) ? (at[key] as unknown[]) : []
    if (typeof op.i === 'number' && Number.isInteger(op.i) && op.i >= 0 && op.i < arr.length)
      arr.length = op.i
    for (const v of Array.isArray(op.v) ? op.v : []) arr.push(keep([...k, arr.length], v))
    at[key] = arr
    return state
  }
  const v = keep(k, op.kind === 1 ? op.v : undefined)
  // An undefined property is the same chat as an absent one, so an object drops the key; an array keeps
  // the slot, as VS Code does, so the indexes after it still mean what later entries think they mean.
  if (v === undefined && !Array.isArray(at)) delete at[key]
  else at[key] = v
  return state
}

export function parseChatOp(line: string): ChatOp | null {
  try {
    const op = JSON.parse(line) as unknown
    return op && typeof op === 'object' ? (op as ChatOp) : null
  } catch {
    // A half-written last line: VS Code is usually mid-write while a sweep runs.
    return null
  }
}

/** The folder a `file:` URI names, its drive letter upper-cased; null for a remote window (WSL, SSH, a
 *  container), which names no folder on this PC. */
export function uriPath(uri: string | null | undefined): string | null {
  if (!uri?.startsWith('file:')) return null
  try {
    return fileURLToPath(uri).replace(/^([a-z]):/, (_, d: string) => `${d.toUpperCase()}:`)
  } catch {
    return null
  }
}

/** The folder a workspace window had open, from its `workspaceStorage/<hash>/workspace.json`: its folder,
 *  or the folder of its `.code-workspace` file. */
export function workspaceJsonFolder(text: string): string | null {
  try {
    const w = JSON.parse(text) as { folder?: unknown; workspace?: unknown }
    const folder = typeof w.folder === 'string' ? uriPath(w.folder) : null
    if (folder) return folder
    const file = typeof w.workspace === 'string' ? uriPath(w.workspace) : null
    return file ? dirname(file) : null
  } catch {
    return null
  }
}
