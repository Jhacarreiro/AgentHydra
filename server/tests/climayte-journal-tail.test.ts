import { afterAll, expect, spyOn, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  appendJournal,
  type CliMayteJournalEntry,
  formatJournalLine,
  type JournalFilter,
  previousJournal,
  readJournal,
} from '../src/climayte-journal'

const root = mkdtempSync(join(tmpdir(), 'ah-journal-tail-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const BASE = Date.UTC(2026, 0, 1)
const entry = (n: number, extra: Partial<CliMayteJournalEntry> = {}): CliMayteJournalEntry => ({
  ts: new Date(BASE + n * 1_000).toISOString(),
  id: `worker-${n % 7}`,
  group: `group-${n % 3}`,
  title: 'Synthetic journal task',
  event: 'done',
  attempt: n,
  ...extra,
})
const lines = (rows: CliMayteJournalEntry[]): string =>
  rows.map((e) => JSON.stringify(e)).join('\n')

function fixture(name: string, current?: string, previous?: string): string {
  const dir = join(root, name)
  mkdirSync(dir)
  const path = join(dir, 'journal.jsonl')
  if (current !== undefined) writeFileSync(path, current)
  if (previous !== undefined) writeFileSync(previousJournal(path), previous)
  return path
}

/** The original whole-file reader, kept independent as the result/order/limit oracle. */
function before(path: string, filter: JournalFilter = {}): CliMayteJournalEntry[] {
  const limit = Math.min(5_000, Math.max(1, Math.floor(filter.limit ?? 30)))
  let after: number | null = null
  if (filter.since !== undefined && filter.since !== '') {
    const s = filter.since
    const n = typeof s === 'number' ? s : /^\d+$/.test(s) ? Number(s) : Date.parse(s)
    after = Number.isFinite(n) ? n : null
  }
  const pick = (file: string): CliMayteJournalEntry[] => {
    let text: string
    try {
      text = readFileSync(file, 'utf8')
    } catch {
      return []
    }
    const found: CliMayteJournalEntry[] = []
    for (const line of text.split('\n')) {
      if (!line || (filter.id && !line.includes(filter.id))) continue
      if (filter.group && !line.includes(filter.group)) continue
      let e: CliMayteJournalEntry
      try {
        e = JSON.parse(line)
      } catch {
        continue
      }
      if (filter.id && e.id !== filter.id) continue
      if (filter.group && e.group !== filter.group) continue
      if (after !== null && !(Date.parse(e.ts) > after)) continue
      found.push(e)
    }
    return found
  }
  let found = pick(path)
  if (found.length < limit) found = [...pick(previousJournal(path)), ...found]
  return found.slice(-limit)
}

test('journal tail preserves default, clamped, fractional and NaN limits', () => {
  const current = Array.from({ length: 45 }, (_, i) => entry(i + 100))
  const previous = Array.from({ length: 40 }, (_, i) => entry(i))
  const path = fixture('limits', lines(current), lines(previous))
  const limits = [undefined, 0, -1, -Infinity, 1, 2.9, 30, 70, Infinity, NaN]
  for (const limit of limits) {
    expect(readJournal(path, { limit })).toEqual(before(path, { limit }))
  }
  expect(readJournal(path)).toEqual(current.slice(-30))
  // NaN intentionally keeps all current rows and does not include the previous file.
  expect(readJournal(path, { limit: NaN })).toEqual(current)

  const large = Array.from({ length: 6_003 }, (_, i) => entry(i))
  const capped = fixture('limit-cap', lines(large))
  expect(readJournal(capped, { limit: Infinity })).toEqual(large.slice(-5_000))
})

test('journal tail keeps exact filters, malformed lines, CRLF and no final newline', () => {
  const rows = [
    entry(1, { id: 'wanted', group: 'target', title: 'Unicode \u{1f33f} e\u0301' }),
    entry(2, { id: 'wanted-extra', group: 'target-extra', notice: 'wanted target' }),
    entry(3, { id: 'wanted', group: 'other', ts: 'unparseable timestamp' }),
    entry(4, { id: 'other', group: 'target', notice: 'wanted' }),
    entry(5, { id: 'wanted', group: 'target' }),
  ]
  const path = fixture(
    'filters',
    [
      '',
      JSON.stringify(rows[0]),
      '{not-json',
      JSON.stringify(rows[1]),
      '  ',
      JSON.stringify(rows[2]),
      JSON.stringify(rows[3]),
      '{"unfinished":',
      JSON.stringify(rows[4]),
    ].join('\r\n'),
    lines([entry(0, { id: 'wanted', group: 'target' })]),
  )
  const filters: JournalFilter[] = [
    {},
    { id: 'wanted' },
    { group: 'target' },
    { id: 'wanted', group: 'target', limit: 2 },
    { id: 'missing' },
    { id: '', group: '' },
    { since: BASE + 1_000 },
    { since: String(BASE + 1_000) },
    { since: new Date(BASE + 1_000).toISOString() },
    { since: 'invalid' },
    { since: '' },
    { since: NaN },
    { since: Infinity },
    { group: 'target', since: BASE + 1_000, limit: 1 },
  ]
  for (const filter of filters) expect(readJournal(path, filter)).toEqual(before(path, filter))
})

test('journal tail scans past older timestamps and sparse nonmatching rows', () => {
  const current = Array.from({ length: 2_100 }, (_, i) => entry(i, { group: 'other' }))
  current[0] = entry(6, { id: 'sparse', group: 'target' })
  current[300] = entry(1, { id: 'sparse', group: 'target' })
  current[600] = entry(8, { id: 'sparse', group: 'target' })
  current[2_099] = entry(2, { id: 'sparse', group: 'target' })
  const previous = [entry(9, { id: 'sparse', group: 'target' })]
  const path = fixture('sparse', lines(current), lines(previous))
  const filter = { id: 'sparse', group: 'target', since: BASE + 5_000, limit: 3 }
  expect(readJournal(path, filter)).toEqual(before(path, filter))
  expect(readJournal(path, filter).map((e) => e.attempt)).toEqual([9, 6, 8])
  // File order wins over timestamp order, including the rotated file.
  expect(readJournal(path, { ...filter, limit: 2 }).map((e) => e.attempt)).toEqual([6, 8])
})

test('journal tail fills from the previous file only when needed and handles missing files', () => {
  const previous = Array.from({ length: 11 }, (_, i) => entry(i))
  const current = [entry(30), entry(31)]
  const path = fixture('rotated', lines(current), lines(previous))
  for (const filter of [
    { limit: 1 },
    { limit: 4 },
    { limit: 30 },
    { group: 'group-1', limit: 4 },
  ]) {
    expect(readJournal(path, filter)).toEqual(before(path, filter))
  }
  expect(readJournal(fixture('missing-current', undefined, lines(previous)), { limit: 3 })).toEqual(
    previous.slice(-3),
  )
  expect(readJournal(fixture('missing-previous', lines(current)))).toEqual(current)
  expect(readJournal(fixture('both-missing'))).toEqual([])
  expect(readJournal(fixture('empty-current', '', lines(previous)), { limit: 1 })).toEqual(
    previous.slice(-1),
  )

  const parse = spyOn(JSON, 'parse')
  try {
    expect(readJournal(path, { limit: 1 })).toEqual(current.slice(-1))
    expect(parse).toHaveBeenCalledTimes(1)
  } finally {
    parse.mockRestore()
  }
})

test('journal tail retains per-read title elision in the returned oldest-first order', () => {
  const path = fixture(
    'titles',
    lines([
      entry(0, { id: 'repeat', title: 'Discarded title' }),
      entry(1, { id: 'repeat', title: 'First returned title' }),
      entry(2, { id: 'different', title: 'Different title' }),
      entry(3, { id: 'repeat', title: 'Repeated title' }),
    ]),
  )
  for (let i = 0; i < 2; i++) {
    const found = readJournal(path, { limit: 3 })
    const formatted = found.map((e) => formatJournalLine(e, new Date(BASE)))
    expect(formatted[0]).toContain("repeat 'First returned title'")
    expect(formatted[1]).toContain("different 'Different title'")
    expect(formatted[2]).not.toContain('Repeated title')
    expect(formatted[2]).toContain(' repeat done')
  }
})

test('journal append and rotation retain their existing file and read contracts', () => {
  const path = fixture('append')
  const first = entry(1)
  const second = entry(2)
  appendJournal(path, first)
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(first)}\n`)
  appendJournal(path, second, 1)
  expect(readFileSync(previousJournal(path), 'utf8')).toBe(`${JSON.stringify(first)}\n`)
  expect(readFileSync(path, 'utf8')).toBe(`${JSON.stringify(second)}\n`)
  expect(readJournal(path, { limit: 2 })).toEqual([first, second])
})

test('a 21,000-row journal parses only the newest 30 returned rows', () => {
  const rows = Array.from({ length: 21_000 }, (_, i) => entry(i, { notice: 'x'.repeat(75) }))
  const path = fixture('parse-cost', `${lines(rows)}\n`)
  const parse = spyOn(JSON, 'parse')
  try {
    const wanted = before(path)
    expect(parse).toHaveBeenCalledTimes(21_000)
    parse.mockClear()
    const found = readJournal(path)
    expect(found).toEqual(wanted)
    expect(found).toEqual(rows.slice(-30))
    expect(parse).toHaveBeenCalledTimes(30)
  } finally {
    parse.mockRestore()
  }
})
