import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'
import type { CliMayteTokens } from './climayte-lib'
import { parseUsageLine } from './usage-tokens'

/** The file operations of one scan; injectable for short reads and changes during a read. */
export interface FirstRequestFileIO {
  open(path: string): number
  size(fd: number): number
  read(fd: number, buffer: Buffer, length: number, position: number): number
  close(fd: number): void
}

const files: FirstRequestFileIO = {
  open: (path) => openSync(path, 'r'),
  size: (fd) => fstatSync(fd).size,
  read: (fd, buffer, length, position) => readSync(fd, buffer, 0, length, position),
  close: closeSync,
}

const READ_BYTES = 64 * 1024

/** The first assistant request's usage in [startedAt, endedAt], in file order. Read only through
 *  that line instead of decoding and splitting a whole long session. The open file's initial size
 *  bounds this read; appends belong to a later scan. A truncated file stops at its new EOF.
 *  A long line is decoded incrementally, preserving UTF-8 across chunks without retaining raw
 *  byte pieces or concatenating another line-sized byte buffer. */
export function firstRequestFromFile(
  path: string,
  startedAt: number,
  endedAt: number,
  io: FirstRequestFileIO = files,
): CliMayteTokens | null {
  const pick = (line: string): CliMayteTokens | null => {
    const turn = parseUsageLine(line)
    if (!turn || !(turn.ts >= startedAt && turn.ts <= endedAt)) return null
    const u = turn.usage
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheCreation }
  }
  const fd = io.open(path)
  try {
    const size = io.size(fd)
    const buffer = Buffer.allocUnsafe(Math.min(READ_BYTES, size))
    const parts: string[] = []
    let decoder: StringDecoder | undefined
    for (let position = 0; position < size; ) {
      const n = io.read(fd, buffer, Math.min(buffer.length, size - position), position)
      if (!n) break
      position += n
      const read = buffer.subarray(0, n)
      let start = 0
      for (;;) {
        const end = read.indexOf(10, start)
        if (end < 0) break
        const part = read.subarray(start, end)
        let line: string
        if (decoder) {
          parts.push(decoder.end(part))
          line = parts.join('')
          parts.length = 0
          decoder = undefined
        } else line = part.toString('utf8')
        const found = pick(line)
        if (found) return found
        start = end + 1
      }
      if (start < n) {
        decoder ??= new StringDecoder('utf8')
        parts.push(decoder.write(read.subarray(start)))
      }
    }
    // A valid last JSON record without a newline counted in the whole-file reader too.
    if (!decoder) return null
    parts.push(decoder.end())
    const line = parts.join('')
    parts.length = 0
    decoder = undefined
    return pick(line)
  } finally {
    io.close(fd)
  }
}
