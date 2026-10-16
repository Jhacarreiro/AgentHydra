import { expect, test } from 'bun:test'
import { storeKeyOf } from '../src/session-locator'
import { collapseSubagents } from '../src/sessions'
import type { TranscriptFile } from '../src/transcript'

function file(
  session_id: string,
  parentId: string | null = null,
  over: Partial<TranscriptFile> = {},
): TranscriptFile {
  return {
    session_id,
    parentId,
    source: 'opencode',
    tool: 'opencode',
    path: 'C:/synthetic/opencode.db',
    project: 'synthetic',
    mtime_ms: 1,
    size_bytes: 1,
    archived: false,
    ...over,
  }
}

// The pre-optimization walker is deliberately kept as the semantic oracle. In particular, its
// last duplicate key wins, cycle keys include the initial row, and an unowned chain keeps all rows.
function legacyCollapse(files: TranscriptFile[]) {
  if (!files.some((f) => f.parentId)) return { rows: files, counts: new Map<string, number>() }
  const key = (tf: Pick<TranscriptFile, 'source' | 'tool' | 'path'>, id: string) =>
    `${storeKeyOf({ source: tf.source, tool: tf.tool, path: tf.path, session_id: id })}:${id}`
  const byId = new Map(files.map((f) => [key(f, f.session_id), f]))
  const ownerOf = (f: TranscriptFile): TranscriptFile | null => {
    const seen = new Set([key(f, f.session_id)])
    let parent = f.parentId ? byId.get(key(f, f.parentId)) : undefined
    while (parent) {
      if (seen.has(key(parent, parent.session_id))) return null
      if (!parent.parentId) return parent
      seen.add(key(parent, parent.session_id))
      parent = byId.get(key(parent, parent.parentId))
    }
    return null
  }
  const rows: TranscriptFile[] = []
  const counts = new Map<string, number>()
  for (const f of files) {
    const owner = f.parentId ? ownerOf(f) : null
    if (!owner) rows.push(f)
    else {
      const key = `${owner.source}:${storeKeyOf(owner)}:${owner.session_id}`
      counts.set(key, (counts.get(key) ?? 0) + 1)
    }
  }
  return { rows, counts }
}

function parity(files: TranscriptFile[]) {
  const expected = legacyCollapse(files)
  const actual = collapseSubagents(files)
  expect(actual.rows).toEqual(expected.rows)
  expect(actual.rows.every((row, index) => row === expected.rows[index])).toBe(true)
  expect([...actual.counts]).toEqual([...expected.counts])
  return actual
}

test('generated graphs preserve ancestry, row order, scopes, orphans and cyclic or duplicate keys', () => {
  let seed = 317
  const next = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  for (let example = 0; example < 120; example++) {
    const files = Array.from({ length: 40 }, (_, index) => {
      const source = (['opencode', 'hermes', 'claude'] as const)[next(3)]!
      const scope = next(4)
      return file(`id-${next(12)}`, next(5) ? `id-${next(15)}` : null, {
        source,
        tool: source === 'claude' ? 'example-fork' : source,
        path: `C:/synthetic/store-${scope}/state.db`,
        mtime_ms: index,
      })
    })
    parity(files)
  }
})

test('an earlier duplicate keeps its alternate cycle guard even after canonical ancestry was memoized', () => {
  const root = file('root')
  const branch = file('branch', 'same')
  const alternate = file('same', 'branch', { mtime_ms: 2 })
  const canonical = file('same', 'root', { mtime_ms: 3 })
  expect(parity([root, branch, alternate, canonical]).rows).toEqual([root, alternate])
  const oldRoot = file('same', 'root')
  const cyclicCanonical = file('same', 'same', { mtime_ms: 4 })
  expect(parity([root, oldRoot, cyclicCanonical, branch]).rows).toEqual([
    root,
    cyclicCanonical,
    branch,
  ])
  // Preserve even the legacy concatenated-key aliases; this pass changes no identity rules.
  parity([
    file('root', null, { path: 'C:/synthetic/a' }),
    file('b:c', 'root', { path: 'C:/synthetic/a' }),
    file('c', 'missing', { path: 'C:/synthetic/a:b' }),
    file('leaf', 'b:c', { path: 'C:/synthetic/a' }),
  ])
})

test('each call observes in-place parent, store and record changes without cross-request caching', () => {
  const root = file('root')
  const child = file('child', 'root')
  const files = [root, child]
  expect(parity(files).rows).toEqual([root])
  child.parentId = 'missing'
  expect(parity(files).rows).toEqual(files)
  child.parentId = 'root'
  child.path = 'C:/synthetic/other.db'
  expect(parity(files).rows).toEqual(files)
  root.path = child.path
  expect(parity(files).rows).toEqual([root])
  files.splice(0, 1)
  expect(parity(files).rows).toEqual([child])
  files.unshift(root)
  root.parentId = 'child'
  expect(parity(files).rows).toEqual(files)
})

function measured(files: TranscriptFile[]) {
  let reads = 0
  for (const f of files) {
    const parent = f.parentId
    Object.defineProperty(f, 'parentId', {
      configurable: true,
      enumerable: true,
      get: () => {
        reads++
        return parent
      },
    })
  }
  const expected = legacyCollapse(files)
  const before = reads
  reads = 0
  const actual = collapseSubagents(files)
  const after = reads
  expect(actual.rows).toEqual(expected.rows)
  expect([...actual.counts]).toEqual([...expected.counts])
  return { before, after }
}

test('deep ancestry resolves in linear parent reads instead of revisiting each complete chain', () => {
  const length = 512
  const files = Array.from({ length }, (_, index) =>
    file(`node-${index}`, index ? `node-${index - 1}` : null),
  ).reverse()
  const reads = measured(files)
  expect(reads.before).toBeGreaterThan(length * length)
  expect(reads.after).toBeLessThan(length * 8)
  console.info(
    `[subagent-ancestry] ${length} nested rows: parent reads ${reads.before} -> ${reads.after}`,
  )
})

test('shared fanout, missing ancestors and cycles resolve once per canonical path', () => {
  const depth = 80
  const leaves = 1200
  for (const ending of ['root', 'missing', 'cycle']) {
    const chain = Array.from({ length: depth }, (_, index) =>
      file(
        `node-${index}`,
        index
          ? `node-${index - 1}`
          : ending === 'root'
            ? null
            : ending === 'missing'
              ? 'gone'
              : `node-${depth - 1}`,
      ),
    )
    const fanout = Array.from({ length: leaves }, (_, index) =>
      file(`leaf-${index}`, `node-${depth - 1}`),
    )
    const reads = measured([...fanout, ...chain])
    expect(reads.before).toBeGreaterThan(leaves * depth)
    expect(reads.after).toBeLessThan((leaves + depth) * 8)
  }
})
