import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type FirstRequestFileIO, firstRequestFromFile } from '../src/climayte-first-request'
import { attemptSpend, type CliMayteTokens } from '../src/climayte-lib'
import { KitStore } from '../src/kit/store'
import { parseUsageLine } from '../src/usage-tokens'

const root = mkdtempSync(join(tmpdir(), 'ah-first-request-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))
const BASE = Date.UTC(2026, 0, 1)
const TOKENS = { input: 10, output: 4, cacheRead: 20, cacheWrite: 30 }
const usage = (at: number, input = TOKENS.input): string =>
  JSON.stringify({
    type: 'assistant',
    timestamp: new Date(at).toISOString(),
    message: {
      model: 'synthetic-model',
      usage: {
        input_tokens: input,
        output_tokens: TOKENS.output,
        cache_read_input_tokens: TOKENS.cacheRead,
        cache_creation_input_tokens: TOKENS.cacheWrite,
      },
    },
  })

/** The original firstRequest loop, independent of the file reader. */
function before(text: string, start: number, end: number): CliMayteTokens | null {
  for (const line of text.split('\n')) {
    const turn = parseUsageLine(line)
    if (!turn || !(turn.ts >= start && turn.ts <= end)) continue
    const u = turn.usage
    return { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheCreation }
  }
  return null
}

function fixture(name: string, bytes: string | Buffer): string {
  const path = join(root, name)
  writeFileSync(path, bytes)
  return path
}

function memoryFile(initial: Buffer, maxRead = Infinity) {
  let bytes = initial
  let closed = 0
  let hook: (() => void) | undefined
  const reads: { position: number; requested: number; actual: number }[] = []
  const io: FirstRequestFileIO = {
    open: () => 1,
    size: () => bytes.length,
    read: (_fd, buffer, length, position) => {
      hook?.()
      const n = Math.max(0, Math.min(length, maxRead, bytes.length - position))
      bytes.copy(buffer, 0, position, position + n)
      reads.push({ position, requested: length, actual: n })
      return n
    },
    close: () => {
      closed++
    },
  }
  return {
    io,
    reads,
    get closed() {
      return closed
    },
    replace(next: Buffer) {
      bytes = next
    },
    beforeRead(fn?: () => void) {
      hook = fn
    },
  }
}

test('first request preserves inclusive windows, file order, malformed lines and final records', () => {
  const text = [
    '{not json',
    JSON.stringify({
      type: 'user',
      timestamp: new Date(BASE).toISOString(),
      message: { usage: {} },
    }),
    usage(BASE - 1, 1),
    usage(BASE + 4_000, 2),
    usage(BASE, 3),
    usage(BASE + 1_000, 4),
    '{"type":"assistant","timestamp":"bad","message":{"usage":{}}}',
    usage(BASE + 2_000, 5),
    '{"unfinished":',
  ].join('\r\n')
  const windows = [
    [BASE, BASE + 5_000],
    [BASE, BASE],
    [BASE + 1_000, BASE + 1_000],
    [BASE + 2_000, BASE + 2_000],
    [BASE + 3_000, BASE + 3_500],
    [BASE + 5_000, BASE],
    [NaN, Infinity],
  ]
  for (const [i, ending] of ['', '\n', '\r\n'].entries()) {
    const path = fixture(`windows-${i}.jsonl`, text + ending)
    for (const [start, end] of windows) {
      expect(firstRequestFromFile(path, start!, end!)).toEqual(before(text + ending, start!, end!))
    }
  }
  const final = usage(BASE)
  expect(firstRequestFromFile(fixture('no-newline.jsonl', final), BASE, BASE)).toEqual(TOKENS)
  expect(firstRequestFromFile(fixture('empty.jsonl', ''), BASE, BASE)).toBeNull()
})

test('first request preserves UTF-8 when a multibyte character crosses a chunk boundary', () => {
  const prefix = `${usage(BASE).slice(0, -1)},"note":"`
  const text = `${prefix}${'x'.repeat(65_535 - Buffer.byteLength(prefix))}\u{1f33f}e\u0301"}\r\n`
  const path = fixture('unicode.jsonl', text)
  const parse = spyOn(JSON, 'parse')
  try {
    expect(firstRequestFromFile(path, BASE, BASE)).toEqual(TOKENS)
    expect(parse.mock.calls[0]?.[0]).toBe(text.slice(0, -1))
  } finally {
    parse.mockRestore()
  }
  // A short read can split every multi-byte sequence differently from the 64 KiB boundary.
  const f = memoryFile(Buffer.from(`${usage(BASE).slice(0, -1)},"note":"\u{1f33f}e\u0301"}`), 3)
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toEqual(TOKENS)
  expect(f.closed).toBe(1)
})

test('a giant multi-chunk line keeps the shared usage parser and malformed-line rules', () => {
  const giant = 'text with "quotes" and \\ slashes '.repeat(35_000)
  const turn = JSON.stringify({
    type: 'assistant',
    timestamp: new Date(BASE).toISOString(),
    message: {
      model: 'synthetic-model',
      content: [{ type: 'text', text: giant }],
      usage: { input_tokens: 123, output_tokens: 7, cache_creation_input_tokens: 50 },
    },
  })
  const text = `${turn.slice(0, -1)}\n${turn}\n${usage(BASE, 999)}`
  const path = fixture('giant.jsonl', text)
  expect(firstRequestFromFile(path, BASE, BASE)).toEqual(before(text, BASE, BASE))
  expect(firstRequestFromFile(path, BASE, BASE)).toEqual({
    input: 123,
    output: 7,
    cacheRead: 0,
    cacheWrite: 50,
  })
})

test('giant lines preserve malformed UTF-8 across chunks without a line-sized Buffer.concat', () => {
  const head = `{"type":"assistant","timestamp":"${new Date(BASE).toISOString()}","pad":"`
  const middle = '","message":{"model":"'
  const prefix = head + 'x'.repeat(65_535 - Buffer.byteLength(head + middle)) + middle
  // The unfinished three-byte sequence crosses the 64 KiB boundary. Invalid leading,
  // continuation and surrogate encodings follow inside the small, retained model field.
  const invalid = Buffer.from([0xe2, 0x82, 0x41, 0xc0, 0xaf, 0xed, 0xa0, 0x80])
  const tail =
    '","usage":{"input_tokens":123,"output_tokens":7}},"tail":"' + 'z'.repeat(250_000) + '"}\n'
  const bytes = Buffer.concat([Buffer.from(prefix), invalid, Buffer.from(tail)])
  const path = fixture('giant-invalid-utf8.jsonl', bytes)
  const parse = spyOn(JSON, 'parse')
  try {
    const wanted = before(bytes.toString('utf8'), BASE, BASE)
    const wantedParses = parse.mock.calls.map((call) => call[0])
    parse.mockClear()
    // Construct the fixture and oracle before spying: this checks the actual file reader only.
    const concat = spyOn(Buffer, 'concat')
    let found: CliMayteTokens | null
    let concatenations: number
    try {
      found = firstRequestFromFile(path, BASE, BASE)
      concatenations = concat.mock.calls.length
    } finally {
      concat.mockRestore()
    }
    expect(found).toEqual(wanted)
    expect(found).toEqual({ input: 123, output: 7, cacheRead: 0, cacheWrite: 0 })
    expect(parse.mock.calls.map((call) => call[0])).toEqual(wantedParses)
    expect(concatenations).toBe(0)
  } finally {
    parse.mockRestore()
  }
})

test('the initial file size bounds appends and a later scan sees the new request', () => {
  const original = Buffer.from(`${usage(BASE - 1)}\n`)
  const appended = Buffer.from(`${usage(BASE)}\n`)
  const f = memoryFile(original, 19)
  f.beforeRead(() => {
    f.beforeRead()
    f.replace(Buffer.concat([original, appended]))
  })
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toBeNull()
  expect(f.reads.reduce((sum, r) => sum + r.actual, 0)).toBe(original.length)
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toEqual(TOKENS)
  expect(f.closed).toBe(2)
})

test('short reads and truncation stop at actual EOF without padding or stale usage', () => {
  const kept = Buffer.from(`${usage(BASE - 1)}\n`)
  const original = Buffer.concat([kept, Buffer.from(`${usage(BASE)}\n`)])
  const f = memoryFile(original, 17)
  f.beforeRead(() => {
    f.beforeRead()
    f.replace(kept)
  })
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toEqual(
    before(kept.toString(), BASE, BASE),
  )
  expect(f.reads.at(-1)?.actual).toBe(0)
  expect(f.closed).toBe(1)

  f.replace(Buffer.from(usage(BASE).slice(0, -1)))
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toBeNull()
  f.replace(Buffer.from(usage(BASE, 777)))
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toEqual({ ...TOKENS, input: 777 })
})

test('file failures close acquired handles and remain caller-visible', () => {
  const f = memoryFile(Buffer.from(usage(BASE)))
  expect(() =>
    firstRequestFromFile('synthetic', BASE, BASE, {
      ...f.io,
      open: () => {
        throw new Error('open failed')
      },
    }),
  ).toThrow('open failed')
  expect(f.closed).toBe(0)
  expect(() =>
    firstRequestFromFile('synthetic', BASE, BASE, {
      ...f.io,
      size: () => {
        throw new Error('stat failed')
      },
    }),
  ).toThrow('stat failed')
  expect(f.closed).toBe(1)
  expect(() =>
    firstRequestFromFile('synthetic', BASE, BASE, {
      ...f.io,
      read: () => {
        throw new Error('read failed')
      },
    }),
  ).toThrow('read failed')
  expect(f.closed).toBe(2)
})

test('a first request near the start reads one 64 KiB chunk instead of a 32 MiB transcript', () => {
  const trailing = `${JSON.stringify({ type: 'user', message: { content: 'x'.repeat(1_000) } })}\n`
  const bytes = Buffer.from(`${usage(BASE)}\n${trailing.repeat(33_000)}`)
  expect(bytes.length).toBeGreaterThan(32 * 1024 * 1024)
  const wanted = before(bytes.toString('utf8'), BASE, BASE)
  const f = memoryFile(bytes)
  expect(firstRequestFromFile('synthetic', BASE, BASE, f.io)).toEqual(wanted)
  expect(f.reads).toEqual([{ position: 0, requested: 65_536, actual: 65_536 }])
  expect(f.closed).toBe(1)
})

test('attemptSpend retains first-request and missing/unreadable transcript behavior', () => {
  const dir = join(root, 'integration')
  const projects = join(dir, 'projects', 'synthetic-project')
  mkdirSync(projects, { recursive: true })
  const file = join(projects, 'synthetic-session.jsonl')
  const text = `${usage(BASE - 1)}\n${usage(BASE)}\n${usage(BASE + 1)}`
  writeFileSync(file, text)
  const store = new KitStore(':memory:')
  try {
    const read = () => attemptSpend(dir, 'cli:synthetic', 'synthetic-session', BASE, BASE, store)
    expect(read()).toMatchObject({
      first: before(readFileSync(file, 'utf8'), BASE, BASE),
      found: true,
    })
    expect(attemptSpend(dir, 'cli:synthetic', 'missing-session', BASE, BASE, store)).toMatchObject({
      first: null,
      found: false,
    })
    rmSync(file)
    // An existing path that cannot be read as a transcript still reports no first request.
    mkdirSync(file)
    expect(read()).toMatchObject({ first: null, found: true })
  } finally {
    store.close()
  }
})
