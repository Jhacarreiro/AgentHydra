// The end of a session's .jsonl, read as text. A leaf module: the engine's handoff and the transcript
// reader both need it, and session-jsonl imports the engine, so it cannot live there without a cycle.

import { openSync, readSync, closeSync, statSync } from 'node:fs'

/** How much of a transcript's end is read: enough for a long session's recent turns. What is before it the window asks
 *  for on its own (sessionJsonlOlder): a 56 MB session showed only its last 8 MiB, none of the owner's messages
 *  (owner, 2026-10-11: "it won't let me scroll up to ... the top. It just stops"). */
export const TAIL_BYTES = 8 * 1024 * 1024

/** The last `max` bytes of a file as text (the first line may be cut; parseJsonl skips it). */
export function readTail(path: string, max = TAIL_BYTES): string {
  const size = statSync(path).size
  const start = Math.max(0, size - max)
  const buf = Buffer.alloc(size - start)
  const fd = openSync(path, 'r')
  try {
    let read = 0
    while (read < buf.length) {
      const n = readSync(fd, buf, read, buf.length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buf.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
