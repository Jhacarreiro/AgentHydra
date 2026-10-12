// server/tests/climayte-unsaved.test.ts — which of a worker's changed files a passing check still finds
// uncommitted (climayte-unsaved.ts), in a real temporary git repository.
import { afterAll, describe, expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  editedPaths,
  failsOnlyOnOthersFiles,
  outputPaths,
  saysNoCommit,
  uncommittedOf,
} from '../src/climayte-unsaved'

const root = mkdtempSync(join(tmpdir(), 'ah-climayte-unsaved-'))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const git = (cwd: string, ...args: string[]) =>
  spawnSync(
    'git',
    ['-c', 'user.name=Example Owner', '-c', 'user.email=owner@example.com', ...args],
    { cwd, encoding: 'utf8' },
  )

const toolLine = (name: string, input: Record<string, unknown>, at: string) =>
  JSON.stringify({
    type: 'assistant',
    timestamp: at,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name, input }] },
  })

describe('editedPaths', () => {
  test('names what Edit, Write, MultiEdit and NotebookEdit changed, never what Read opened', () => {
    const at = '2020-10-05T12:00:00.000Z'
    const later = '2020-10-05T12:05:00.000Z'
    const text = [
      '{"cut first line',
      toolLine('Read', { file_path: '/repo/read-only.ts' }, at),
      toolLine('Write', { file_path: '/repo/new.ts', content: 'x' }, at),
      toolLine('Edit', { file_path: 'src/rel.ts', old_string: 'a', new_string: 'b' }, at),
      toolLine('MultiEdit', { file_path: '/repo/multi.ts', edits: [] }, at),
      toolLine('NotebookEdit', { notebook_path: '/repo/book.ipynb' }, at),
      toolLine('Edit', { file_path: '/repo/new.ts', old_string: 'x', new_string: 'y' }, later),
    ].join('\n')
    const got = editedPaths(text, join(root, 'base'))
    expect([...got.keys()].map((p) => p.replaceAll('\\', '/'))).toEqual([
      expect.stringMatching(/\/repo\/new\.ts$/),
      `${join(root, 'base', 'src', 'rel.ts').replaceAll('\\', '/')}`,
      expect.stringMatching(/\/repo\/multi\.ts$/),
      expect.stringMatching(/\/repo\/book\.ipynb$/),
    ])
    // The newest write to a file is the one kept.
    expect([...got.values()][0]).toBe(Date.parse(later))
  })
})

describe('uncommittedOf', () => {
  const repo = join(root, 'repo')
  mkdirSync(join(repo, 'src'), { recursive: true })
  git(repo, 'init', '-q')
  writeFileSync(join(repo, '.gitignore'), 'scratch.log\n')
  writeFileSync(join(repo, 'src', 'kept.ts'), 'one\n')
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '-m', 'start')

  test('lists changed and untracked files the session wrote, not committed, ignored or peer-changed ones', async () => {
    const now = Date.now()
    writeFileSync(join(repo, 'src', 'kept.ts'), 'two\n') // tracked, changed
    mkdirSync(join(repo, 'src', 'fresh'), { recursive: true })
    writeFileSync(join(repo, 'src', 'fresh', 'new.ts'), 'new\n') // untracked, in an untracked folder
    writeFileSync(join(repo, 'saved.ts'), 'saved\n')
    git(repo, 'add', 'saved.ts')
    git(repo, 'commit', '-q', '-m', 'saved') // committed: clean
    writeFileSync(join(repo, 'scratch.log'), 'log\n') // ignored
    writeFileSync(join(repo, 'peer.ts'), 'peer\n') // changed by someone else after the session wrote it
    const peerTime = new Date(now + 120_000)
    utimesSync(join(repo, 'peer.ts'), peerTime, peerTime)
    writeFileSync(join(root, 'outside.ts'), 'elsewhere\n') // outside the repository

    const edits = new Map<string, number>(
      ['src/kept.ts', 'src/fresh/new.ts', 'saved.ts', 'scratch.log', 'peer.ts'].map((p) => [
        join(repo, p),
        now,
      ]),
    )
    edits.set(join(root, 'outside.ts'), now)
    expect(await uncommittedOf(join(repo, 'src'), edits)).toEqual([
      'src/fresh/new.ts',
      'src/kept.ts',
    ])
    // Four git commands, two here and two in uncommittedOf: each 0.5-3.4 s on a box at ~90% CPU
    // (2026-10-11), where bun's 5 s default ran out.
  }, 30_000)

  test('outside a repository there is nothing to hold it to', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain, { recursive: true })
    writeFileSync(join(plain, 'a.ts'), 'a\n')
    expect(await uncommittedOf(plain, new Map([[join(plain, 'a.ts'), Date.now()]]))).toEqual([])
  })
})

describe('saysNoCommit', () => {
  test('commit decides; left out, the words of the prompt or the brief file it names do', async () => {
    const dir = join(root, 'briefs')
    mkdirSync(dir, { recursive: true })
    const brief = join(dir, 'R17-S.md').replaceAll('\\', '/')
    writeFileSync(
      brief,
      '# R17-S\n**Do NOT run git commit, git add or git push: leave every change uncommitted; the orchestrator lands it.**\n',
    )
    const rules = join(dir, 'CLAUDE.md').replaceAll('\\', '/')
    writeFileSync(rules, 'Do not commit until the gate is green.\n')
    // The rb-r17 builders' prompt, 2026-10-12, word for word but its path: one to no file, so its own
    // words decide.
    const rb17 = `Read and carry out the brief ${join(dir, 'gone', 'R17-S.md')} exactly. It names the files you own, the test to write first, and the check to pass. Do NOT run git commit, git add or git push. Report what the brief's Check section asks for.`
    const cases: Array<[string, string, boolean | undefined, boolean]> = [
      ['the rb-r17 prompt', rb17, undefined, true],
      ['a brief file that forbids committing', `Carry out the brief ${brief}.`, undefined, true],
      ['commit: false on a plain prompt', 'build the page', false, true],
      ['commit: true over no-commit words', 'draft it, do not commit it', true, false],
      ['a plain prompt', 'build the page and test it', undefined, false],
      [
        'a rule about what never to commit',
        'never commit secrets; build the page',
        undefined,
        false,
      ],
      [
        "the repository's own rules are no brief",
        `Follow the brief in ${rules}.`,
        undefined,
        false,
      ],
    ]
    for (const [name, prompt, commit, expected] of cases)
      expect([name, await saysNoCommit({ prompt, cwd: dir, commit })]).toEqual([name, expected])
  })
})

describe('failsOnlyOnOthersFiles', () => {
  const mine = ['C:/Work/Repo/src/Foo.vue', 'C:/Work/Repo/desk2/hydra/src/bar.ts']
  // Another session's uncommitted work in the same checkout, repo-relative as git prints it.
  const dirty = ['src/Peer.ts', 'src/NotFoo.vue', 'desk2/hydra/src/QuickApp.vue', 'src/Foo.vue']
  test("a failed check is not the task's only when it fails on another session's uncommitted files", () => {
    const cases: Array<[string, string, boolean]> = [
      ['its own file, repo-relative with a position', 'src/foo.vue(3,5): error TS2322', false],
      ['its own file, nested with a line', 'FAIL desk2/hydra/src/bar.ts:12', false],
      ['a file named by its basename', 'bar.ts:1:1 lint', false],
      ['one of its files among others', 'src/peer.ts:1 and src/foo.vue:2', false],
      ["only a peer's file", 'src/peer.ts(9,1): error', true],
      ['a backslash path of a peer', '.\\src\\peer.ts:4', true],
      ["a peer's file printed from a subfolder", 'src/QuickApp.vue(3,1): error TS2322', true],
      ['a path that only ends like its file', 'src/notfoo.vue:1', true],
      // The task's own change broke a test nobody else touched: that is the task's fail.
      ['an unchanged test its change broke', 'FAIL src/foo.test.ts > adds', false],
      ['no file named', 'Expected 3 received 4, e.g. v1.2 timed out', false],
    ]
    for (const [name, output, expected] of cases)
      expect([name, failsOnlyOnOthersFiles(output, mine, dirty)]).toEqual([name, expected])
  })

  test('outputPaths reads positions off and ignores version numbers', () => {
    expect(outputPaths('a/B.TS:3 x\\y.vue(1,2) v1.2 e.g')).toEqual(['a/b.ts', 'x/y.vue'])
  })
})
