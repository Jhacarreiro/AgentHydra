import { expect, test } from 'bun:test'
import { createBasicProcessTable } from '../src/core/win-basic-process-table'

const INITIAL_BYTES = 256 * 1024
const MAX_BYTES = 8 * 1024 * 1024
const BASE = 0x1_2345_0000
const LENGTH_MISMATCH = 0xc0000004 | 0
const BUFFER_TOO_SMALL = 0xc0000023 | 0
type Query = Parameters<typeof createBasicProcessTable>[0]
type FixtureRow = { pid: number | bigint; ppid?: number | bigint; name: string }

const data = (buffer: Uint8Array) =>
  new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
const aligned = (bytes: number) => Math.ceil(bytes / 8) * 8

/** Invented x64 SYSTEM_BASICPROCESS_INFORMATION records; every name is inside its record. */
function writeRows(buffer: Uint8Array, returned: Uint32Array, rows: FixtureRow[]) {
  buffer.fill(0)
  const view = data(buffer)
  const offsets: number[] = []
  let offset = 0
  for (const [index, row] of rows.entries()) {
    offsets.push(offset)
    const nameBytes = row.name.length * 2
    const maximum = nameBytes ? nameBytes + 2 : 0
    const stride = aligned(48 + maximum)
    view.setUint32(offset, index + 1 < rows.length ? stride : 0, true)
    view.setBigUint64(offset + 8, BigInt(row.pid), true)
    view.setBigUint64(offset + 16, BigInt(row.ppid ?? 0), true)
    // This is a sequence number, not another PID or pointer, and must not affect the rows.
    view.setBigUint64(offset + 24, 0xffff_ffff_ffff_ffffn, true)
    view.setUint16(offset + 32, nameBytes, true)
    view.setUint16(offset + 34, maximum, true)
    view.setBigUint64(offset + 40, nameBytes ? BigInt(BASE + offset + 48) : 0n, true)
    for (let unit = 0; unit < row.name.length; unit++)
      view.setUint16(offset + 48 + unit * 2, row.name.charCodeAt(unit), true)
    offset += stride
  }
  returned[0] = offset
  return { offsets, bytes: offset }
}

const reader = (query: Query) => createBasicProcessTable(query, () => BASE)

test('basic process rows preserve native order, counted UTF-16, PID zero and uint32 identities', () => {
  const rows: FixtureRow[] = [
    { pid: 80, ppid: 20, name: 'Example-worker.exe' },
    { pid: 0, name: '' },
    { pid: 20, ppid: 0xffff_ffff, name: '程序-🙂.exe' },
    { pid: 0xffff_ffff, ppid: 80, name: 'x'.repeat(259) },
  ]
  const read = reader((buffer, returned) => {
    writeRows(buffer, returned, rows)
    return 0
  })
  expect(read()).toEqual([
    { pid: 80, ppid: 20, name: 'Example-worker.exe' },
    { pid: 0, ppid: 0, name: '[System Process]' },
    { pid: 20, ppid: 0xffff_ffff, name: '程序-🙂.exe' },
    { pid: 0xffff_ffff, ppid: 80, name: 'x'.repeat(259) },
  ])
})

test('each successful query is fresh and returns independently owned rows while reusing storage', () => {
  const buffers: Uint8Array[] = []
  let pid = 100
  const read = reader((buffer, returned) => {
    buffers.push(buffer)
    writeRows(buffer, returned, [{ pid: pid++, ppid: 50, name: 'Example.exe' }])
    return 0
  })
  const first = read()!
  const second = read()!
  expect(buffers).toHaveLength(2)
  expect(buffers[0]!.byteLength).toBe(INITIAL_BYTES)
  expect(buffers[1]).toBe(buffers[0])
  expect(first).toEqual([{ pid: 100, ppid: 50, name: 'Example.exe' }])
  expect(second).toEqual([{ pid: 101, ppid: 50, name: 'Example.exe' }])
  expect(first).not.toBe(second)
  expect(first[0]).not.toBe(second[0])
  first[0]!.pid = 999
  first[0]!.name = 'Changed only in caller'
  expect(read()).toEqual([{ pid: 102, ppid: 50, name: 'Example.exe' }])
  expect(second).toEqual([{ pid: 101, ppid: 50, name: 'Example.exe' }])
})

test('malformed record chains, strings and identities refuse the whole table, then recover fresh', () => {
  type Damage = (buffer: Uint8Array, returned: Uint32Array, second: number) => void
  const invalid: Array<[string, Damage]> = [
    ['next is smaller than a record', (b, _r, at) => data(b).setUint32(at, 40, true)],
    ['next is not eight-byte aligned', (b, _r, at) => data(b).setUint32(at, 49, true)],
    ['next leaves the returned range', (b, r, at) => data(b).setUint32(at, aligned(r[0]!), true)],
    ['next has no following header', (b, r, at) => data(b).setUint32(at, r[0]! - at, true)],
    ['odd counted string length', (b, _r, at) => data(b).setUint16(at + 32, 3, true)],
    [
      'odd maximum string length',
      (b, _r, at) => {
        const view = data(b)
        view.setUint16(at + 34, view.getUint16(at + 32, true) + 1, true)
      },
    ],
    ['maximum is shorter than length', (b, _r, at) => data(b).setUint16(at + 34, 2, true)],
    [
      'maximum extends beyond returned bytes',
      (b, r, at) => data(b).setUint16(at + 34, r[0]!, true),
    ],
    ['null pointer with a nonempty name', (b, _r, at) => data(b).setBigUint64(at + 40, 0n, true)],
    [
      'pointer precedes the allocation',
      (b, _r, at) => data(b).setBigUint64(at + 40, BigInt(BASE - 2), true),
    ],
    [
      'pointer reaches the returned end',
      (b, r, at) => data(b).setBigUint64(at + 40, BigInt(BASE + r[0]!), true),
    ],
    [
      'pointer outside numeric precision',
      (b, _r, at) => data(b).setBigUint64(at + 40, 0xffff_ffff_ffff_ffffn, true),
    ],
    [
      'name points into a different record',
      (b, _r, at) => {
        data(b).setUint16(32, 36, true)
        data(b).setUint16(34, 38, true)
        data(b).setBigUint64(40, BigInt(BASE + at + 48), true)
      },
    ],
    [
      'pointer is not UTF-16 aligned',
      (b, _r, at) => data(b).setBigUint64(at + 40, BigInt(BASE + at + 49), true),
    ],
    ['embedded zero in a counted name', (b, _r, at) => data(b).setUint16(at + 48, 0, true)],
    [
      'empty name for a nonzero PID',
      (b, _r, at) => {
        data(b).setUint16(at + 32, 0, true)
        data(b).setUint16(at + 34, 0, true)
        data(b).setBigUint64(at + 40, 0n, true)
      },
    ],
    ['PID exceeds uint32', (b, _r, at) => data(b).setBigUint64(at + 8, 0x1_0000_0000n, true)],
    [
      'parent PID exceeds uint32',
      (b, _r, at) => data(b).setBigUint64(at + 16, 0x1_0000_0000n, true),
    ],
    ['duplicate PID', (b, _r, at) => data(b).setBigUint64(at + 8, 11n, true)],
    [
      'returned length is zero',
      (_b, r) => {
        r[0] = 0
      },
    ],
    [
      'returned length is shorter than one header',
      (_b, r) => {
        r[0] = 47
      },
    ],
    [
      'returned length truncates a later header',
      (_b, r, at) => {
        r[0] = at + 47
      },
    ],
    [
      'returned length exceeds capacity',
      (b, r) => {
        r[0] = b.byteLength + 1
      },
    ],
  ]
  for (const [label, damage] of invalid) {
    let broken = false
    const read = reader((buffer, returned) => {
      const { offsets } = writeRows(buffer, returned, [
        { pid: 11, name: 'Example-first.exe' },
        { pid: 22, ppid: 11, name: 'Example-second.exe' },
      ])
      if (broken) damage(buffer, returned, offsets[1]!)
      return 0
    })
    const expected = [
      { pid: 11, ppid: 0, name: 'Example-first.exe' },
      { pid: 22, ppid: 11, name: 'Example-second.exe' },
    ]
    expect(read(), label).toEqual(expected)
    broken = true
    expect(read(), label).toBeNull()
    broken = false
    expect(read(), label).toEqual(expected)
  }
  const tooLong = reader((buffer, returned) => {
    writeRows(buffer, returned, [{ pid: 33, name: 'x'.repeat(260) }])
    return 0
  })
  expect(tooLong()).toBeNull()
})

test('both length statuses grow bounded storage and a warm call reuses the successful buffer', () => {
  const calls: Uint8Array[] = []
  const read = reader((buffer, returned) => {
    calls.push(buffer)
    if (calls.length === 1) {
      returned[0] = 2 * INITIAL_BYTES
      return LENGTH_MISMATCH
    }
    if (calls.length === 2) {
      returned[0] = 4 * INITIAL_BYTES
      return BUFFER_TOO_SMALL
    }
    writeRows(buffer, returned, [{ pid: 44, name: 'Example-grown.exe' }])
    return 0
  })
  expect(read()).toEqual([{ pid: 44, ppid: 0, name: 'Example-grown.exe' }])
  expect(calls).toHaveLength(3)
  expect(calls[0]!.byteLength).toBe(INITIAL_BYTES)
  expect(calls[1]!.byteLength).toBeGreaterThanOrEqual(2 * INITIAL_BYTES)
  expect(calls[2]!.byteLength).toBeGreaterThanOrEqual(4 * INITIAL_BYTES)
  expect(calls[1]).not.toBe(calls[0])
  expect(calls[2]).not.toBe(calls[1])
  expect(read()).toEqual([{ pid: 44, ppid: 0, name: 'Example-grown.exe' }])
  expect(calls[3]).toBe(calls[2])
  expect(calls.every((buffer) => buffer.byteLength <= MAX_BYTES)).toBe(true)
})

test('growth exhausts after three queries, accepts the exact cap and refuses larger requests', () => {
  let growing = true
  const calls: Uint8Array[] = []
  const read = reader((buffer, returned) => {
    calls.push(buffer)
    if (growing) {
      returned[0] = buffer.byteLength + 8
      return LENGTH_MISMATCH
    }
    writeRows(buffer, returned, [{ pid: 55, name: 'Example-recovered.exe' }])
    return 0
  })
  expect(read()).toBeNull()
  expect(calls).toHaveLength(3)
  growing = false
  expect(read()).toEqual([{ pid: 55, ppid: 0, name: 'Example-recovered.exe' }])
  expect(calls).toHaveLength(4)
  expect(calls.every((buffer) => buffer.byteLength <= MAX_BYTES)).toBe(true)

  let capCalls = 0
  const atCap = reader((buffer, returned) => {
    capCalls++
    if (capCalls === 1) {
      returned[0] = MAX_BYTES
      return BUFFER_TOO_SMALL
    }
    expect(buffer.byteLength).toBe(MAX_BYTES)
    writeRows(buffer, returned, [{ pid: 66, name: 'Example-cap.exe' }])
    return 0
  })
  expect(atCap()).toEqual([{ pid: 66, ppid: 0, name: 'Example-cap.exe' }])
  expect(capCalls).toBe(2)
  for (const required of [MAX_BYTES + 1, 0xffff_ffff]) {
    let count = 0
    const overCap = reader((buffer, returned) => {
      count++
      expect(buffer.byteLength).toBe(INITIAL_BYTES)
      returned[0] = required
      return LENGTH_MISMATCH
    })
    expect(overCap()).toBeNull()
    expect(count).toBe(1)
  }
})

test('only explicitly unsupported classes disable future queries', () => {
  for (const status of [0xc0000002, 0xc0000003, 0xc00000bb]) {
    let calls = 0
    const read = reader(() => {
      calls++
      return status | 0
    })
    expect(read()).toBeNull()
    expect(read()).toBeNull()
    expect(calls).toBe(1)
  }
  for (const failure of [0xc0000001 | 0, 0xc0000022 | 0, -1]) {
    let calls = 0
    const read = reader((buffer, returned) => {
      if (++calls === 1) return failure
      writeRows(buffer, returned, [{ pid: 77, name: 'Example-retry.exe' }])
      return 0
    })
    expect(read()).toBeNull()
    expect(read()).toEqual([{ pid: 77, ppid: 0, name: 'Example-retry.exe' }])
    expect(calls).toBe(2)
  }
})

test('a throwing query or missing success length returns null and permits a fresh retry', () => {
  for (const fail of ['throw', 'zero output'] as const) {
    let calls = 0
    const read = reader((buffer, returned) => {
      calls++
      if (calls === 2) {
        if (fail === 'throw') throw new Error('Synthetic query failure')
        return 0
      }
      writeRows(buffer, returned, [{ pid: calls, name: 'Example-fresh.exe' }])
      return 0
    })
    expect(read()).toEqual([{ pid: 1, ppid: 0, name: 'Example-fresh.exe' }])
    expect(read(), fail).toBeNull()
    expect(read()).toEqual([{ pid: 3, ppid: 0, name: 'Example-fresh.exe' }])
  }
})

test('partial informational statuses never make a populated buffer authoritative', () => {
  for (const status of [0x103, 0x105, 0x40000000]) {
    let calls = 0
    const read = reader((buffer, returned) => {
      writeRows(buffer, returned, [{ pid: 91, name: 'Example-partial.exe' }])
      return ++calls === 1 ? status : 0
    })
    expect(read()).toBeNull()
    expect(read()).toEqual([{ pid: 91, ppid: 0, name: 'Example-partial.exe' }])
  }
})
