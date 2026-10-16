import { afterEach, expect, spyOn, test } from 'bun:test'
import { claudeParentId } from '../src/transcript'

type Store = Parameters<typeof claudeParentId>[1]
const store: Store = {
  root: '/synthetic',
  tool: 'claude-code',
  glob: '**/*.jsonl',
  idFrom: 'basename',
  idPrefix: '',
  sessionFile: '',
}
const spies: { mockRestore(): void }[] = []
afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore()
})

// The previous parser is an oracle for all path shapes, including legacy empty components.
function former(rel: string, store: Store): string | null {
  const parts = rel.split(/[\\/]/)
  const name = parts.at(-1) ?? ''
  if (store.sessionFile) {
    let owner = -1
    if (store.idPrefix)
      for (let i = parts.length - 1; i >= 0; i--)
        if ((parts[i] ?? '').startsWith(store.idPrefix)) {
          owner = i
          break
        }
    if (owner < 0) return null
    if (name === store.sessionFile && owner === parts.length - 2) return null
    const raw = parts[owner]!
    return raw.startsWith(store.idPrefix) ? raw.slice(store.idPrefix.length) : raw
  }
  return parts.length <= 2 ? null : (parts[1] ?? null)
}

test('ordinary paths retain exact project/session ownership for both separator styles and empty segments', () => {
  const paths = [
    '',
    'file.jsonl',
    'project/file.jsonl',
    'project\\file.jsonl',
    'project/session/subagents/agent.jsonl',
    'project\\session\\subagents\\agent.jsonl',
    'project/session\\subagents/agent.jsonl',
    '/session/agent.jsonl',
    '\\session\\agent.jsonl',
    'project//agent.jsonl',
    'project\\\\agent.jsonl',
    'project/\\agent.jsonl',
    'project/session/',
    'project/session\\',
    'project/',
    '/',
    '//',
    '\\\\',
    '项目/会话/subagents/任务.jsonl',
    'project/\ud800/agent.jsonl',
    'project/' + 'x'.repeat(4000) + '/sub/agent.jsonl',
  ]
  for (const path of paths) {
    expect(claudeParentId(path, store)).toBe(former(path, store))
    expect(claudeParentId(path, { ...store, idFrom: 'parent-dir', idPrefix: 'unused-' })).toBe(
      former(path, store),
    )
  }
})

test('generated mixed path shapes match the previous parser', () => {
  let seed = 917
  const next = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed % max
  }
  const separators = ['/', '\\', '//', '\\\\', '/\\', '\\/']
  const components = ['', 'project', 'session', 'subagents', 'agent.jsonl', '会话', 'run-example']
  for (let example = 0; example < 10_000; example++) {
    let rel = components[next(components.length)]!
    const depth = next(9)
    for (let i = 0; i < depth; i++)
      rel += separators[next(separators.length)]! + components[next(components.length)]!
    expect(claudeParentId(rel, store)).toBe(former(rel, store))
  }
})

test('named-session stores keep nearest prefixed ancestor and session-file rules unchanged', () => {
  const named: Store = {
    ...store,
    tool: 'cowork',
    idFrom: 'parent-dir',
    idPrefix: 'run-',
    sessionFile: 'audit.jsonl',
  }
  const paths = [
    'run-one/audit.jsonl',
    'project/run-one/audit.jsonl',
    'project/run-one/claude/projects/session/subagents/agent.jsonl',
    'project/run-one/nested/run-two/audit.jsonl',
    'project/run-one/nested/run-two/child.jsonl',
    'project\\run-one\\nested/run-two\\child.jsonl',
    'project/missing/audit.jsonl',
    'project/run-one//audit.jsonl',
    'run-file.jsonl',
    'run-one\\audit.jsonl',
  ]
  for (const path of paths) {
    expect(claudeParentId(path, named)).toBe(former(path, named))
    expect(claudeParentId(path, { ...named, idPrefix: '' })).toBe(
      former(path, { ...named, idPrefix: '' }),
    )
  }
})

test('ordinary parent lookup avoids allocating split arrays for cached history', () => {
  const paths = Array.from(
    { length: 6500 },
    (_, i) => `project-${i % 37}/session-${i % 100}/subagents/agent-${i}.jsonl`,
  )
  const split = spyOn(String.prototype, 'split')
  spies.push(split)
  const actual = paths.map((path) => claudeParentId(path, store))
  const newSplits = split.mock.calls.length
  split.mockClear()
  const expected = paths.map((path) => former(path, store))
  const oldSplits = split.mock.calls.length
  split.mockRestore()
  expect(actual).toEqual(expected)
  expect(newSplits).toBe(0)
  expect(oldSplits).toBe(paths.length)
})
