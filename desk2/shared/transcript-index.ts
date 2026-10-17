// The index of a whole transcript, built from the same items the transcript route answers, so a window that holds only
// the newest page still knows every message, the live checklist and the background tasks (shared/protocol.ts TranscriptIndex).
import type { ToolTally, TranscriptIndex, TranscriptItem } from '@shared/protocol'

/** The window's Finished list keeps this many finished tasks (web tasks/logic.ts FINISHED_CAP is its own, larger, cap). */
export const RECENT_TASKS = 20

type TaskItem = Extract<TranscriptItem, { kind: 'task' }>
const TASK_STATUSES = new Set<string>(['running', 'completed', 'failed', 'stopped'])
/** Bound optional detachment work; the preview itself is never truncated. */
const FIRST_LINE_COPY_MAX = 4096

const firstLine = (s: string): string => {
  let start = 0
  for (;;) {
    const end = s.indexOf('\n', start)
    const line = s.slice(start, end < 0 ? s.length : end).trim()
    // A short first line can retain a whole old pasted prompt. Copy its exact UTF-16 units only
    // when most of the source is discarded; single-line and mostly-kept text need no extra copy.
    if (line) return line.length <= FIRST_LINE_COPY_MAX && s.length > 2 * line.length ? line.split('').join('') : line
    if (end < 0) return ''
    start = end + 1
  }
}

/** How often each tool was called and how many of those calls failed, the most called first (then by name). */
export function tallyTools(items: readonly TranscriptItem[]): ToolTally[] {
  const by = new Map<string, ToolTally>()
  for (const item of items) {
    if (item.kind !== 'tool_use') continue
    const t = by.get(item.name) ?? { name: item.name, calls: 0, errors: 0 }
    t.calls++
    if (item.status === 'error') t.errors++
    by.set(item.name, t)
  }
  return [...by.values()].sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name))
}

/** A quiet stretch longer than this, with no tool running, is the session waiting (on the person, a permission, a
 *  background task or a ping), not working: a model's own step between two moments of a turn is shorter. */
export const IDLE_GAP_MS = 10 * 60_000

/** Kinds whose stamp says nothing about when the session worked: the live checklist is one item stamped again at each
 *  change, and a background task runs on after its turn ends. */
const UNTIMED = new Set<TranscriptItem['kind']>(['todos', 'task'])

/**
 * How long the session was working, in ms: its turns, not the time since it began (owner, 2026-10-16: "total time active").
 * Each prompt (the person's message, or one a program typed in, kind 'note') starts a turn, which then counts every tool's
 * run and every quiet stretch up to IDLE_GAP_MS between its moments; the wait before a prompt never counts. A turn its
 * engine closed with a result (a Desk chat's) counts the results' own durations instead, which are exact. A Claude Code
 * .jsonl has no results, and a background task's notice that wakes it starts no prompt: the gap rule leaves that wait out.
 */
export function activeTime(items: readonly TranscriptItem[]): number {
  let total = 0
  let measured = 0 // this turn's result durations
  let worked = 0 // this turn's working time by the gap rule
  let last: number | null = null // the latest moment of this turn so far
  for (const item of items) {
    if (UNTIMED.has(item.kind)) continue
    if ((item.kind === 'user' && !item.parentToolUseId) || item.kind === 'note') {
      total += measured > 0 ? measured : worked
      measured = worked = 0
      last = item.ts
      continue
    }
    if (item.kind === 'result') {
      measured += Math.max(0, item.durationMs)
      continue
    }
    const end = item.kind === 'tool_use' ? Math.max(item.ts, item.endedAt ?? item.ts) : item.ts
    const from = last ?? item.ts
    if (item.ts > from && item.ts - from <= IDLE_GAP_MS) worked += item.ts - from
    worked += Math.max(0, end - Math.max(item.ts, from))
    last = Math.max(from, end)
  }
  return total + (measured > 0 ? measured : worked)
}

/** What the whole items hold: user messages (kind 'user', as the transcript draws them), the newest `todos` item, the
 *  running background tasks and the last RECENT_TASKS finished ones (kind 'task' with a settled status, as panelLists reads them),
 *  how often each tool was called and how long the session was working. */
export function buildTranscriptIndex(items: readonly TranscriptItem[]): TranscriptIndex {
  const userMessages: TranscriptIndex['userMessages'] = []
  const runningTasks: TaskItem[] = []
  const finished: TaskItem[] = []
  let latestTodos: TranscriptItem | null = null
  let lastUserText = ''
  items.forEach((item, position) => {
    if (item.kind === 'user') {
      userMessages.push({ id: item.id, position, firstLine: firstLine(item.text), images: item.images?.length ?? 0 })
      lastUserText = item.text
    } else if (item.kind === 'todos') {
      latestTodos = item
    } else if (item.kind === 'task' && TASK_STATUSES.has(item.status ?? '')) {
      if (item.status === 'running') runningTasks.push(item)
      else finished.push(item)
    }
  })
  return { total: items.length, userMessages, latestTodos, runningTasks, recentTasks: finished.slice(-RECENT_TASKS), lastUserText, tools: tallyTools(items), activeMs: activeTime(items) }
}
