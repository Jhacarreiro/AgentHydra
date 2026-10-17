// Complete lines of an append-only log read from a byte offset: the Codex rollouts (ingest-foreign.ts) and
// the Copilot Chat operation logs (ingest-copilot.ts) are both read this way, a sweep at a time.
import { createReadStream } from 'node:fs'

export type Lines = AsyncGenerator<{ text: string; end: number }>

/** Complete lines from `offset`, each with the byte offset just past it. A trailing line without its
 *  newline is a write in progress and is left for the next sweep. */
export function linesFrom(path: string, offset: number, chunkBytes?: number): Lines {
  return splitLines(
    createReadStream(path, { start: offset, ...(chunkBytes ? { highWaterMark: chunkBytes } : {}) }),
    offset,
  )
}

/** A byte stream that starts at `offset`, cut into complete lines. */
export async function* splitLines(chunks: AsyncIterable<Buffer>, offset: number): Lines {
  let carry: Buffer = Buffer.alloc(0)
  let pos = offset
  for await (const chunk of chunks) {
    carry = carry.length ? Buffer.concat([carry, chunk as Buffer]) : (chunk as Buffer)
    let nl = carry.indexOf(0x0a)
    let from = 0
    while (nl >= 0) {
      pos += nl + 1 - from
      yield { text: carry.toString('utf8', from, nl), end: pos }
      from = nl + 1
      nl = carry.indexOf(0x0a, from)
    }
    carry = carry.subarray(from)
  }
}
