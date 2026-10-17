// The optional Windows 11 basic process snapshot: PID, parent and name without collecting
// per-thread statistics. All buffers are checked before use; null asks the caller for Toolhelp.
// SYSTEM_BASICPROCESS_INFORMATION (x64):
// https://learn.microsoft.com/windows/win32/api/winternl/nf-winternl-ntquerysysteminformation#systembasicprocessinformation
import type { NativeProcess } from './win-process-table'

const INITIAL_BYTES = 256 * 1024
const MAX_BYTES = 8 * 1024 * 1024
const HEADER_BYTES = 48
const utf16 = new TextDecoder('utf-16le')

type Query = (buffer: Uint8Array, returned: Uint32Array) => number

/** A reusable, bounded query. Unsupported Windows versions stop probing; other failures retry
 *  on the next fresh table read, while the caller uses its original fallback for this read. */
export function createBasicProcessTable(query: Query, addressOf: (b: Uint8Array) => number) {
  let buffer: Uint8Array | null = null
  const returned = new Uint32Array(1)
  let unsupported = false
  return (): NativeProcess[] | null => {
    if (unsupported) return null
    try {
      buffer ??= new Uint8Array(INITIAL_BYTES)
      for (let attempt = 0; attempt < 3; attempt++) {
        returned[0] = 0
        const status = query(buffer, returned) >>> 0
        if (status === 0xc0000002 || status === 0xc0000003 || status === 0xc00000bb) {
          unsupported = true
          buffer = null
          return null
        }
        if (status === 0xc0000004 || status === 0xc0000023) {
          const required = returned[0] ?? 0
          if (required > MAX_BYTES) return null
          const size = Math.min(MAX_BYTES, Math.max(buffer.length * 2, required + 16 * 1024))
          if (size <= buffer.length) return null
          buffer = new Uint8Array(size)
          continue
        }
        if (status !== 0) return null
        return parse(buffer, addressOf(buffer), returned[0] ?? 0)
      }
    } catch {
      // An unavailable FFI, allocation failure or unreadable snapshot is not "none running".
    }
    return null
  }
}

function parse(buffer: Uint8Array, base: number, used: number): NativeProcess[] | null {
  if (!Number.isSafeInteger(base) || base <= 0 || used < HEADER_BYTES || used > buffer.length)
    return null
  const view = new DataView(buffer.buffer, buffer.byteOffset, used)
  const rows: NativeProcess[] = []
  const seen = new Set<number>()
  for (let offset = 0; ; ) {
    if (offset + HEADER_BYTES > used) return null
    const next = view.getUint32(offset, true)
    if (next && (next < HEADER_BYTES || next % 8 || offset + next + HEADER_BYTES > used))
      return null
    const end = next ? offset + next : used
    const pid64 = view.getBigUint64(offset + 8, true)
    const ppid64 = view.getBigUint64(offset + 16, true)
    if (pid64 > 0xffffffffn || ppid64 > 0xffffffffn) return null
    const pid = Number(pid64)
    if (seen.has(pid)) return null
    seen.add(pid)
    const length = view.getUint16(offset + 32, true)
    const maximum = view.getUint16(offset + 34, true)
    // Toolhelp has 260 WCHARs including its terminator. An unfamiliar longer name uses that
    // existing boundary rather than guessing how it would truncate a process image name.
    if (length % 2 || maximum % 2 || length > maximum || length > 518) return null
    let start = 0
    if (maximum) {
      const address = view.getBigUint64(offset + 40, true) - BigInt(base)
      if (address < 0n || address > BigInt(used)) return null
      start = Number(address)
      if (start % 2 || start < offset + HEADER_BYTES || start + maximum > end) return null
    }
    let name: string
    if (!length) {
      if (pid !== 0) return null
      name = '[System Process]'
    } else {
      name = utf16.decode(buffer.subarray(start, start + length))
      if (!name || name.includes('\0')) return null
    }
    rows.push({ pid, ppid: Number(ppid64), name })
    if (!next) return rows
    offset += next
  }
}
