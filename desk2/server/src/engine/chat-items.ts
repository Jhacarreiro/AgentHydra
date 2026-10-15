// The transcript items a chat carries into a fork, an import or a session's end, and the pictures they name.

import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { TranscriptItem } from '@shared/protocol'
import { isLongLived } from './long-lived'

/** Copies the pictures a Desk file names (/api/media/<sha256>.<ext>, content-addressed) that `to` does not have. */
export function copyMedia(text: string, from: string, to: string): void {
  const names = new Set([...text.matchAll(/\/api\/media\/([0-9a-f]{64}\.[a-z0-9]+)/g)].map((m) => m[1]!))
  if (!names.size) return
  mkdirSync(to, { recursive: true })
  for (const name of names) {
    const src = join(from, name)
    if (existsSync(src) && !existsSync(join(to, name))) copyFileSync(src, join(to, name))
  }
}

/** A request item no runtime can answer any more (copied into a fork, or left by a dead process) is expired. */
export function settled(item: TranscriptItem): TranscriptItem {
  if ((item.kind === 'permission' || item.kind === 'question' || item.kind === 'plan' || item.kind === 'elicitation') && item.state === 'pending') return { ...item, state: 'expired' }
  return item
}

/** What a task item settled by Hydra Desk says: the session that ran it is gone, so is the task. */
export const TASK_SESSION_ENDED = 'Stopped: the session that started it ended.'

/**
 * A task still 'running' whose session ended, settled 'stopped' with TASK_SESSION_ENDED; `at` (when the end was
 * seen) gives its duration. A long-lived one (a local server, long-lived.ts) is left as it is, and so is the rest.
 */
export function endedTask(item: TranscriptItem, at?: number): TranscriptItem {
  if (item.kind !== 'task' || item.status !== 'running' || isLongLived(item)) return item
  return { ...item, status: 'stopped', summary: TASK_SESSION_ENDED, ...(at !== undefined ? { durationMs: Math.max(0, at - item.ts) } : {}) }
}
