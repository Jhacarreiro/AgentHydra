import { expect, test } from 'bun:test'
import { tcpOwnerPid } from '../src/core/process'
import { createTcpTableReader, type TcpRow } from '../src/core/win-tcp-table'

type TableCall = Parameters<typeof createTcpTableReader>[0]
const SMALL_BYTES = 4 + 24
const MAX_BYTES = 16 * 1024 * 1024
const row = (pid: number, localPort = 42_000, state = 5): TcpRow => ({ pid, localPort, state })
function writeRows(buf: Uint8Array, size: Uint32Array, rows: TcpRow[]): number {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  view.setUint32(0, rows.length, true)
  for (const [i, r] of rows.entries()) {
    const at = 4 + i * 24
    view.setUint32(at, r.state, true)
    view.setUint32(at + 8, ((r.localPort & 0xff) << 8) | (r.localPort >> 8), true)
    view.setUint32(at + 20, r.pid, true)
  }
  size[0] = 4 + rows.length * 24
  return 0
}

test('warm reads make one fresh native call, reset capacity, and return independent identities', () => {
  const calls: Array<{ buf: Uint8Array | null; inputSize: number }> = []
  let pid = 100
  const read = createTcpTableReader((buf, size) => {
    calls.push({ buf, inputSize: size[0]! })
    if (!buf) {
      size[0] = SMALL_BYTES
      return 122
    }
    return writeRows(buf, size, [row(pid++)])
  })
  const first = read()!
  const second = read()!
  expect(calls).toHaveLength(3)
  expect(calls[0]).toEqual({ buf: null, inputSize: 0 })
  expect(calls[1]!.buf).toBe(calls[2]!.buf)
  expect(calls[1]!.inputSize).toBe(calls[1]!.buf!.byteLength)
  expect(calls[2]!.inputSize).toBe(calls[1]!.buf!.byteLength)
  expect(first).toEqual([row(100)])
  expect(second).toEqual([row(101)])
  expect(first).not.toBe(second)
  expect(first[0]).not.toBe(second[0])
  first[0]!.pid = 999
  expect(read()).toEqual([row(102)])
  expect(second).toEqual([row(101)])
})

test('growth between fresh reads retries a new buffer and keeps the four-call limit', () => {
  let reads = 0
  let probes = 0
  let grow = false
  const buffers: Uint8Array[] = []
  const read = createTcpTableReader((buf, size) => {
    if (!buf) {
      probes++
      size[0] = SMALL_BYTES
      return 122
    }
    buffers.push(buf)
    reads++
    if (grow && buf.byteLength < 12_004) {
      size[0] = 12_004
      return 122
    }
    return writeRows(buf, size, [row(reads)])
  })
  expect(read()).toEqual([row(1)])
  grow = true
  expect(read()).toEqual([row(3)])
  expect(read()).toEqual([row(4)])
  expect(probes).toBe(1)
  expect(buffers[0]).toBe(buffers[1])
  expect(buffers[1]).not.toBe(buffers[2])
  expect(buffers[2]).toBe(buffers[3])

  let calls = 0
  let allocations = 0
  const neverFits = createTcpTableReader(
    (buf, size) => {
      calls++
      size[0] = buf ? buf.byteLength + 24 : SMALL_BYTES
      return 122
    },
    (bytes) => {
      allocations++
      return new Uint8Array(bytes)
    },
  )
  expect(neverFits()).toBeNull()
  expect(calls).toBe(5) // One probe and four table attempts, as before.
  expect(allocations).toBe(4)
})

test('native failures, stale success headers and short success bodies never return old rows', () => {
  const invalid: TableCall[] = [
    () => 5,
    () => {
      throw new Error('Synthetic native failure')
    },
    (_buf, size) => {
      size[0] = SMALL_BYTES
      return 0
    },
    (buf, size) => {
      writeRows(buf!, size, [row(777)])
      size[0] = 4
      return 0
    },
    (buf, size) => {
      writeRows(buf!, size, [row(777)])
      size[0] = buf!.byteLength + 1
      return 0
    },
    (buf, size) => {
      writeRows(buf!, size, [row(777)])
      size[0] = 0
      return 0
    },
    (buf, size) => {
      writeRows(buf!, size, [])
      new DataView(buf!.buffer, buf!.byteOffset).setUint32(0, 0xffff_ffff, true)
      return 0
    },
  ]
  for (const fail of invalid) {
    let failure: TableCall | null = null
    const read = createTcpTableReader((buf, size) => {
      if (!buf) {
        size[0] = SMALL_BYTES
        return 122
      }
      if (failure) return failure(buf, size)
      return writeRows(buf, size, [row(100)])
    })
    expect(read()).toEqual([row(100)])
    failure = fail
    expect(read()).toBeNull()
    failure = null
    expect(read()).toEqual([row(100)])
  }
})

test('pathological reported sizes are refused before allocation, including a warm growth reply', () => {
  for (const required of [0, 3, MAX_BYTES + 1, 0xffff_ffff]) {
    let allocations = 0
    const read = createTcpTableReader(
      (_buf, size) => {
        size[0] = required
        return 122
      },
      (bytes) => {
        allocations++
        return new Uint8Array(bytes)
      },
    )
    expect(read()).toBeNull()
    expect(allocations).toBe(0)
  }
  let grow = false
  let allocations = 0
  const read = createTcpTableReader(
    (buf, size) => {
      if (!buf) {
        size[0] = SMALL_BYTES
        return 122
      }
      if (grow) {
        size[0] = 0xffff_ffff
        return 122
      }
      return writeRows(buf, size, [row(100)])
    },
    (bytes) => {
      allocations++
      return new Uint8Array(bytes)
    },
  )
  expect(read()).toEqual([row(100)])
  grow = true
  expect(read()).toBeNull()
  expect(allocations).toBe(1)
})

test('large successful buffers are not retained between requests', () => {
  let probes = 0
  let allocations = 0
  const read = createTcpTableReader(
    (buf, size) => {
      if (!buf) {
        probes++
        size[0] = 1024 * 1024
        return 122
      }
      return writeRows(buf, size, [row(100)])
    },
    (bytes) => {
      allocations++
      expect(bytes).toBeLessThanOrEqual(MAX_BYTES)
      return new Uint8Array(bytes)
    },
  )
  expect(read()).toEqual([row(100)])
  expect(read()).toEqual([row(100)])
  expect(probes).toBe(2)
  expect(allocations).toBe(2)
})

test('decoding and the stale-header guard respect a buffer view byte offset', () => {
  const allocations: Uint8Array[] = []
  const read = createTcpTableReader(
    (buf, size) => {
      if (!buf) {
        size[0] = SMALL_BYTES
        return 122
      }
      return writeRows(buf, size, [row(123, 65_530)])
    },
    (bytes) => {
      const base = new Uint8Array(bytes + 32).fill(0x45)
      allocations.push(base)
      return base.subarray(16, bytes + 16)
    },
  )
  expect(read()).toEqual([row(123, 65_530)])
  expect(read()).toEqual([row(123, 65_530)])
  expect(allocations).toHaveLength(1)
  expect([...allocations[0]!.subarray(0, 16)]).toEqual(Array(16).fill(0x45))
  expect([...allocations[0]!.subarray(-16)]).toEqual(Array(16).fill(0x45))
})

test('empty tables, unavailable native calls and allocation failures keep null-versus-empty semantics', () => {
  const empty = createTcpTableReader((buf, size) => {
    if (!buf) {
      size[0] = 4
      return 122
    }
    return writeRows(buf, size, [])
  })
  expect(empty()).toEqual([])
  expect(empty()).toEqual([])
  expect(createTcpTableReader(() => 0)()).toBeNull()
  const probe: TableCall = (_buf, size) => {
    size[0] = SMALL_BYTES
    return 122
  }
  expect(
    createTcpTableReader(probe, () => {
      throw new Error('Synthetic allocation failure')
    })(),
  ).toBeNull()
  expect(createTcpTableReader(probe, () => new Uint8Array(3))()).toBeNull()
})

test('the current caller-owner predicate sees fresh exact port/state/pid rows and ambiguous owners', () => {
  let rows = [row(100), row(100), row(999, 42_000, 2), row(200, 42_001)]
  const read = createTcpTableReader((buf, size) => {
    if (!buf) {
      size[0] = 4 + rows.length * 24
      return 122
    }
    return writeRows(buf, size, rows)
  })
  expect(read()).toEqual(rows)
  expect(tcpOwnerPid(read()!, 42_000)).toBe(100)
  expect(tcpOwnerPid(read()!, 42_001)).toBe(200)
  expect(tcpOwnerPid(read()!, 42_002)).toBeNull()
  rows = [row(300), row(400)]
  expect(tcpOwnerPid(read()!, 42_000)).toBeNull()
  rows = [row(500)]
  expect(tcpOwnerPid(read()!, 42_000)).toBe(500)
})
