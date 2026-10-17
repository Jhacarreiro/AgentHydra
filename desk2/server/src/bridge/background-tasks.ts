// An outside Claude Code session's background tasks that still run, read from its own .jsonl (owner, 2026-10-16: a
// Desktop chat whose turn had ended while its background shell had run for 18 minutes was drawn as not running, "a
// lighter gray than the others, which means you apparently believe it's inactive"). external.ts read such a chat only by
// its hook row, of which this PC had none, or by whether its transcript was written in the last 30 s, and a background
// task writes nothing to the transcript until it ends.
//
// WHERE IT COMES FROM. Claude Code records each background task's start and end in the session's transcript:
// - started: the launching tool's result carries `toolUseResult.backgroundTaskId` (Bash with run_in_background), or a
//   `taskId` beside `status: 'async_launched'` (Workflow, a background Agent) or beside `timeoutMs` (Monitor);
// - ended: a <task-notification> naming the task with a <status>, or a Monitor's last event (system-text.ts
//   parseTaskNotification reads both), or a TaskStop result "Successfully stopped task: <id>" (most stopped tasks get no
//   notification: of 26 stops in one 250 MB transcript read 2026-10-16, 2 were notified).
// A task runs inside its engine's process, so mapExternal counts only the tasks started since the session's live engine
// started (AgentHydra's pid-checked live registry): one an engine left when it exited, or one an earlier engine of the
// same session started, has ended whatever the transcript says. Tasks that never end by themselves (long-lived.ts: a
// local server; a persistent Monitor) do not count, as for Desk's own chats (chat-manager.ts noteTask).
//
// HOW MUCH IT READS. A file is first read from its last TAIL_BYTES (8 MB), then only the bytes appended since, kept by
// size; a file that shrank, or grew by more than TAIL_BYTES since its last read, is read afresh from its tail. A task
// started further back than that window is not seen. Only lines holding one of the markers are parsed.

import { open, stat } from 'node:fs/promises'
import type { AhLiveSession } from './client'
import { parseTaskNotification } from '../engine/system-text'
import { isLongLived } from '../engine/long-lived'
import { TAIL_BYTES } from './session-tail'

/** A background task the transcript says was started and has not said ended. */
export interface OpenTask {
  taskId: string
  /** When its launching tool's result was written (ms). */
  startedAt: number
}

/** One transcript's fold: the tasks open so far, and the launching calls whose result has not come yet. */
export interface BackgroundScan {
  open: Map<string, OpenTask>
  /** Tool use id -> the launching call's command and description, read for the long-lived rule when its result comes. */
  launches: Map<string, { command: string; description: string }>
}

/** Launching calls kept while their result has not come (a result always follows its call within the same turn). */
const LAUNCHES_KEPT = 64

const STOPPED = /^Successfully stopped task:\s*([\w-]+)/
const NOTIFICATION = /<task-notification>([\s\S]*?)<\/task-notification>/g

export function newScan(): BackgroundScan {
  return { open: new Map(), launches: new Map() }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** Every string in a parsed line that holds a <task-notification>: a queue-operation's content, a user message's text or blocks, an attachment's prompt. */
function notificationTexts(v: unknown, out: string[], depth = 0): void {
  if (typeof v === 'string') {
    if (v.includes('<task-notification>')) out.push(v)
  } else if (depth < 6 && v && typeof v === 'object') {
    for (const x of Array.isArray(v) ? v : Object.values(v)) notificationTexts(x, out, depth + 1)
  }
}

function noteLaunches(scan: BackgroundScan, line: Record<string, unknown>): void {
  const content = isObj(line.message) ? line.message.content : undefined
  if (!Array.isArray(content)) return
  for (const b of content) {
    if (!isObj(b) || b.type !== 'tool_use' || !isObj(b.input)) continue
    if (b.input.run_in_background !== true && b.name !== 'Monitor') continue
    scan.launches.set(str(b.id), { command: str(b.input.command), description: str(b.input.description) })
    if (scan.launches.size > LAUNCHES_KEPT) scan.launches.delete(scan.launches.keys().next().value!)
  }
}

/** The task a tool result started, with its launching call when that was seen; null for any other result. */
function startedTask(line: Record<string, unknown>): { taskId: string; persistent: boolean; toolUseId: string } | null {
  const r = line.toolUseResult
  if (!isObj(r)) return null
  const taskId = str(r.backgroundTaskId) || (r.status === 'async_launched' || typeof r.timeoutMs === 'number' ? str(r.taskId) || str(r.agentId) : '')
  if (!taskId) return null
  const content = isObj(line.message) ? line.message.content : undefined
  const block = Array.isArray(content) ? content.find((b) => isObj(b) && b.type === 'tool_result') : undefined
  return { taskId, persistent: r.persistent === true, toolUseId: isObj(block) ? str(block.tool_use_id) : '' }
}

/** Folds one transcript line into the scan. Lines without a marker are not parsed. */
export function foldLine(scan: BackgroundScan, text: string): void {
  const launch = text.includes('"run_in_background":true') || text.includes('"name":"Monitor"')
  const result = text.includes('"backgroundTaskId"') || text.includes('"taskId"') || text.includes('Successfully stopped task')
  const notice = text.includes('<task-notification>')
  if (!launch && !result && !notice) return
  let line: unknown
  try {
    line = JSON.parse(text)
  } catch {
    return // a line cut at the window's start, or one still being written
  }
  if (!isObj(line)) return
  if (launch) noteLaunches(scan, line)
  if (result) {
    const started = startedTask(line)
    if (started) {
      const call = scan.launches.get(started.toolUseId)
      scan.launches.delete(started.toolUseId)
      if (!started.persistent && !(call && isLongLived(call))) {
        const at = Date.parse(str(line.timestamp))
        scan.open.set(started.taskId, { taskId: started.taskId, startedAt: Number.isFinite(at) ? at : 0 })
      }
    }
    const stopped = isObj(line.toolUseResult) ? STOPPED.exec(str(line.toolUseResult.message)) : null
    if (stopped) scan.open.delete(stopped[1]!)
  }
  if (notice) {
    const texts: string[] = []
    notificationTexts(line, texts)
    for (const t of texts)
      for (const m of t.matchAll(NOTIFICATION))
        for (const part of parseTaskNotification(m[1]!)) if (part.kind === 'task' && part.task.status) scan.open.delete(part.task.taskId)
  }
}

/** Folds whole lines of transcript text (no line cut in two). */
export function foldText(scan: BackgroundScan, text: string): void {
  for (const line of text.split('\n')) if (line) foldLine(scan, line)
}

/**
 * The tasks of `tasks` that run now: none without a live engine, and only those started since it started (a task dies
 * with the engine that ran it).
 */
export function runningTasks(tasks: readonly OpenTask[] | undefined, engine: Pick<AhLiveSession, 'startedAt'> | undefined): OpenTask[] {
  if (!tasks?.length || !engine) return []
  return tasks.filter((t) => t.startedAt >= engine.startedAt)
}

interface Kept {
  path: string
  /** Where the next read starts: just past the last whole line read. */
  offset: number
  scan: BackgroundScan
}

/** Reads `[from, to)` of `path` and folds its whole lines; returns the offset just past the last whole line. */
async function foldRange(path: string, from: number, to: number, scan: BackgroundScan, skipFirst: boolean): Promise<number> {
  const fh = await open(path, 'r')
  try {
    const buf = Buffer.alloc(to - from)
    const { bytesRead } = await fh.read(buf, 0, buf.length, from)
    const end = buf.lastIndexOf(0x0a, bytesRead - 1)
    if (end < 0) return from // no whole line yet
    const start = skipFirst ? buf.indexOf(0x0a) + 1 : 0
    if (start <= end) foldText(scan, buf.toString('utf8', start, end))
    return from + end + 1
  } finally {
    await fh.close()
  }
}

/**
 * Each live engine's open background tasks, by session id, kept between calls so a transcript is only read where it
 * grew. One file at a time: Bun starts an I/O thread for every fs call in flight and keeps it for the server's life.
 */
export function createBackgroundTasks(o: { windowBytes?: number } = {}) {
  const window = o.windowBytes ?? TAIL_BYTES
  const kept = new Map<string, Kept>()

  async function read(live: readonly Pick<AhLiveSession, 'sessionId' | 'transcriptPath'>[]): Promise<Map<string, OpenTask[]>> {
    const out = new Map<string, OpenTask[]>()
    const ids = new Set(live.map((l) => l.sessionId))
    for (const id of kept.keys()) if (!ids.has(id)) kept.delete(id)
    for (const l of live) {
      const path = l.transcriptPath
      if (!path) continue
      try {
        const { size } = await stat(path)
        let k = kept.get(l.sessionId)
        if (!k || k.path !== path || size < k.offset || size - k.offset > window) {
          const from = Math.max(0, size - window)
          k = { path, offset: from, scan: newScan() }
          kept.set(l.sessionId, k)
          if (size > from) k.offset = await foldRange(path, from, size, k.scan, from > 0)
        } else if (size > k.offset) k.offset = await foldRange(path, k.offset, size, k.scan, false)
        if (k.scan.open.size) out.set(l.sessionId, [...k.scan.open.values()])
      } catch {
        // floor-ok: a transcript that went away or cannot be read leaves its session to go by its hook row and recency
        kept.delete(l.sessionId)
      }
    }
    return out
  }

  return { read }
}
