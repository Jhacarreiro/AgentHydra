import { closeSync, openSync, readSync } from 'node:fs'

/** The file's bytes from `from` to `to`. */
export function readFrom(file: string, from: number, to: number): Buffer {
  const fd = openSync(file, 'r')
  try {
    const buf = Buffer.alloc(Math.max(0, to - from))
    let got = 0
    while (got < buf.length) {
      const n = readSync(fd, buf, got, buf.length - got, from + got)
      if (n === 0) break
      got += n
    }
    return got === buf.length ? buf : buf.subarray(0, got)
  } finally {
    closeSync(fd)
  }
}
