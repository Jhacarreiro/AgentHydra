import { expect, spyOn, test } from 'bun:test'
import { storeKeyOf } from '../src/session-locator'
import { collapseSubagents } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

function file(
  id: string,
  parentId: string | null = null,
  over: Partial<TranscriptFile> = {},
): TranscriptFile {
  return {
    session_id: id,
    parentId,
    source: 'opencode',
    tool: 'opencode',
    path: 'C:/example/opencode.db',
    project: 'example',
    mtime_ms: 1,
    size_bytes: 1,
    archived: false,
    ...over,
  }
}

// Original full-map walker: same concatenated keys, duplicate winner and initial cycle guard.
function legacy(files: TranscriptFile[]) {
  if (!files.some((entry) => entry.parentId))
    return { rows: files, counts: new Map<string, number>() }
  const key = (entry: TranscriptFile, id: string) => `${storeKeyOf(entry)}:${id}`
  const byId = new Map(files.map((entry) => [key(entry, entry.session_id), entry]))
  const rows: TranscriptFile[] = []
  const counts = new Map<string, number>()
  for (const entry of files) {
    let owner: TranscriptFile | null = null
    if (entry.parentId) {
      const seen = new Set([key(entry, entry.session_id)])
      let parent = byId.get(key(entry, entry.parentId))
      while (parent) {
        if (seen.has(key(parent, parent.session_id))) break
        if (!parent.parentId) {
          owner = parent
          break
        }
        seen.add(key(parent, parent.session_id))
        parent = byId.get(key(parent, parent.parentId))
      }
    }
    if (!owner) rows.push(entry)
    else {
      const id = `${owner.source}:${storeKeyOf(owner)}:${owner.session_id}`
      counts.set(id, (counts.get(id) ?? 0) + 1)
    }
  }
  return { rows, counts }
}

function parity(files: TranscriptFile[]) {
  const expected = legacy(files)
  const actual = collapseSubagents(files)
  expect(actual.rows).toHaveLength(expected.rows.length)
  expect(actual.rows.every((row, i) => row === expected.rows[i])).toBe(true)
  expect([...actual.counts]).toEqual([...expected.counts])
  return actual
}

test('85k unrelated transcript ids are not indexed when parentage belongs to a different store', () => {
  let reads = 0
  const unrelated = Array.from({ length: 85_000 }, (_, i) => {
    const entry = file(`example-${i}`, null, {
      source: 'claude',
      tool: 'claude',
      path: 'C:/example/transcript.jsonl',
    })
    Object.defineProperty(entry, 'session_id', {
      get: () => {
        reads++
        return `example-${i}`
      },
    })
    return entry
  })
  const root = file('root')
  const files = [...unrelated, root, file('child', 'root'), file('leaf', 'child')]
  const expected = legacy(files)
  const oldReads = reads
  reads = 0
  const actual = collapseSubagents(files)
  const newReads = reads
  expect(oldReads).toBe(unrelated.length)
  expect(newReads).toBe(0)
  expect(actual.rows).toHaveLength(unrelated.length + 1)
  expect(actual.rows.every((row, i) => row === expected.rows[i])).toBe(true)
  expect([...actual.counts]).toEqual([...expected.counts])
})

test('scoped lookup preserves physical stores, shared-format namespaces, duplicates, cycles and orphan order', () => {
  const a = 'C:/example/a.db'
  const b = 'C:/example/b.db'
  const fixtures = [
    [],
    [file('root'), file('orphan', 'missing')],
    [file('a', 'b'), file('b', 'a'), file('leaf', 'a')],
    [file('root'), file('same', 'branch'), file('branch', 'same'), file('same', 'root')],
    [file('root'), file('same', 'root'), file('same', 'same'), file('branch', 'same')],
    [
      file('root', null, { path: a }),
      file('child', 'root', { path: a }),
      file('root', null, { path: b }),
    ],
    [
      file('root', null, { source: 'hermes', tool: 'hermes', path: a }),
      file('child', 'root', { source: 'hermes', tool: 'hermes', path: b }),
    ],
    [
      file('root', null, { source: 'codex', tool: 'shared', path: 'C:/example/rollout.jsonl' }),
      file('child', 'root', { path: 'shared' }),
    ],
  ]
  for (const fixture of fixtures) parity(fixture)
  const untouched = [file('no-parent'), file('empty-parent', '')]
  expect(parity(untouched).rows).toBe(untouched)
})

test('inactive store prefixes still participate in legacy colon-concatenated key collisions', () => {
  const a = 'C:/example/a'
  const ab = `${a}:b`
  const root = file('root', null, { path: a })
  const shadow = file('c', null, { path: ab })
  const result = parity([
    root,
    file('b:c', 'root', { path: a }),
    shadow,
    file('leaf', 'b:c', { path: a }),
  ])
  expect(result.rows).toEqual([root, shadow])
  expect(result.counts.get(`opencode:${ab}:c`)).toBe(1)
  const shorter = file('b:c', null, { path: a })
  expect(parity([shorter, file('leaf', 'c', { path: ab })]).rows).toEqual([shorter])
})

test('store and parent mutations are read again on each call without retaining eligibility', () => {
  const root = file('root')
  const child = file('child', 'root')
  const unrelated = file('other', null, { source: 'claude', path: 'C:/example/other.jsonl' })
  const files = [unrelated, root, child]
  expect(parity(files).rows).toEqual([unrelated, root])
  child.path = 'C:/example/second.db'
  expect(parity(files).rows).toEqual(files)
  root.path = child.path
  expect(parity(files).rows).toEqual([unrelated, root])
  child.parentId = 'missing'
  expect(parity(files).rows).toEqual(files)
  child.parentId = 'root'
  root.parentId = 'child'
  expect(parity(files).rows).toEqual(files)
  files.splice(1, 1)
  expect(parity(files).rows).toEqual(files)
})

test('many active and unrelated namespaces do not require every namespace pair to be compared', () => {
  const files: TranscriptFile[] = []
  for (let i = 0; i < 1000; i++) {
    const path = `C:/example/active-${i}.db`
    files.push(file('root', null, { path }), file('child', 'root', { path }))
    files.push(file('root', null, { path: `C:/example/unrelated-${i}.db` }))
  }
  const expected = legacy(files)
  const startsWith = String.prototype.startsWith
  let comparisons = 0
  const spy = spyOn(String.prototype, 'startsWith').mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    comparisons++
    return startsWith.call(this, search, position)
  })
  let actual: ReturnType<typeof collapseSubagents>
  try {
    actual = collapseSubagents(files)
  } finally {
    spy.mockRestore()
  }
  expect(actual!.rows.every((row, i) => row === expected.rows[i])).toBe(true)
  expect(actual!.rows).toHaveLength(expected.rows.length)
  expect([...actual!.counts]).toEqual([...expected.counts])
  expect(comparisons).toBeLessThan(files.length * 4)
})
