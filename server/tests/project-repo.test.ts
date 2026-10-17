// server/tests/project-repo.test.ts - which repository a cwd counts as on the "Cost by project" card.
//
// THE FAILURE THIS PINS. The card grouped spend by raw cwd, so one repository was several rows (its
// worktrees under `.wt\`, its subfolders) and two clones of it were two. A cwd now counts as the
// repository of its nearest ancestor with `.git`, keyed by the origin's owner/name; a worktree counts as
// its main repository; a folder in no repository stays the folder. Every repository here is built in a
// scratch folder.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  isAbsoluteCwd,
  originUrl,
  remoteSlug,
  repoOf,
  reposOf,
  resetRepoCache,
} from '../src/project-repo'

const root = mkdtempSync(join(tmpdir(), 'ah-project-repo-'))
afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})
beforeEach(() => resetRepoCache())

const config = (remotes: Record<string, string>) =>
  [
    '[core]',
    '\trepositoryformatversion = 0',
    ...Object.entries(remotes).flatMap(([name, url]) => [
      `[remote "${name}"]`,
      `\turl = ${url}`,
      `\tfetch = +refs/heads/*:refs/remotes/${name}/*`,
    ]),
  ].join('\n')

/** A checkout at `dir` whose .git folder has `remotes`. */
function makeRepo(dir: string, remotes: Record<string, string> = {}): string {
  mkdirSync(join(dir, '.git'), { recursive: true })
  writeFileSync(join(dir, '.git', 'config'), config(remotes))
  return dir
}

describe('remote URL to owner/name', () => {
  test('https, ssh and scp-like URLs of any host', () => {
    expect(remoteSlug('https://github.com/Example-Owner/Widget.git')).toBe('Example-Owner/Widget')
    expect(remoteSlug('https://git.example.com/owner/name/')).toBe('owner/name')
    expect(remoteSlug('ssh://git@git.example.com:2222/owner/name.git')).toBe('owner/name')
    expect(remoteSlug('git@github.com:owner/name.git')).toBe('owner/name')
    expect(remoteSlug('https://gitlab.example.com/group/sub/name.git')).toBe('sub/name')
  })

  test('a local path or file:// remote names no repository', () => {
    expect(remoteSlug('C:/Users/me/repos/name')).toBeNull()
    expect(remoteSlug('../name.git')).toBeNull()
    expect(remoteSlug('file:///C:/Users/me/repos/name')).toBeNull()
  })

  test('origin is preferred, else the first remote', () => {
    expect(
      originUrl(
        config({ upstream: 'https://example.com/a/up', origin: 'https://example.com/a/mine' }),
      ),
    ).toBe('https://example.com/a/mine')
    expect(originUrl(config({ fork: 'git@example.com:b/fork.git' }))).toBe(
      'git@example.com:b/fork.git',
    )
    expect(originUrl(config({}))).toBeNull()
  })

  test('only a real path is a cwd', () => {
    expect(isAbsoluteCwd('C:\\Users\\me\\proj')).toBe(true)
    expect(isAbsoluteCwd('/home/me/proj')).toBe(true)
    expect(isAbsoluteCwd('codex')).toBe(false)
    expect(isAbsoluteCwd('c3f2747d/a510/4fef')).toBe(false)
    expect(isAbsoluteCwd('unknown')).toBe(false)
  })
})

describe('cwd to repository', () => {
  test('a subfolder counts as its repository, keyed by the origin', async () => {
    const repo = makeRepo(join(root, 'widget'), {
      origin: 'https://github.com/example-owner/widget.git',
    })
    const sub = join(repo, 'src', 'deep')
    mkdirSync(sub, { recursive: true })
    expect(await repoOf(repo)).toEqual({
      key: 'example-owner/widget',
      label: 'example-owner/widget',
      root: repo,
    })
    expect((await repoOf(sub))?.key).toBe('example-owner/widget')
  })

  test('a worktree counts as its main repository, wherever it lives', async () => {
    const main = makeRepo(join(root, 'engine'), {
      origin: 'git@example.com:example-owner/engine.git',
    })
    for (const [wt, at] of [
      ['train37', join(main, '.wt', 'train37')],
      ['outside', join(root, 'engine-outside')],
    ] as const) {
      const gitDir = join(main, '.git', 'worktrees', wt)
      mkdirSync(gitDir, { recursive: true })
      writeFileSync(join(gitDir, 'commondir'), '../..\n')
      mkdirSync(join(at, 'crate'), { recursive: true })
      writeFileSync(join(at, '.git'), `gitdir: ${gitDir}\n`)
      const r = await repoOf(join(at, 'crate'))
      expect(r?.key).toBe('example-owner/engine')
      expect(r?.root).toBe(main)
    }
  })

  test('a removed worktree folder still counts as the repository above it', async () => {
    const main = makeRepo(join(root, 'gone-parent'), {
      origin: 'https://example.com/o/gone-parent',
    })
    expect((await repoOf(join(main, '.wt', 'deleted-long-ago')))?.key).toBe('o/gone-parent')
  })

  test('a repository with no remote is its folder, shown by name', async () => {
    const repo = makeRepo(join(root, 'Scratchy'))
    const two = makeRepo(join(root, 'other', 'Scratchy'))
    expect(await repoOf(join(repo))).toEqual({ key: repo, label: 'Scratchy', root: repo })
    // Two unrelated repositories of one name stay two projects.
    expect((await repoOf(two))?.key).toBe(two)
  })

  test('a folder in no repository is none, and a decoded store key is never looked up', async () => {
    const plain = join(root, 'plain', 'folder')
    mkdirSync(plain, { recursive: true })
    expect(await repoOf(plain)).toBeNull()
    const got = await reposOf([plain, 'codex', 'unknown'])
    expect([...got.values()]).toEqual([null, null, null])
  })

  test.if(process.platform === 'win32')('Windows cwds of any case are one repository', async () => {
    const repo = makeRepo(join(root, 'CaseRepo'), { origin: 'https://example.com/o/caserepo' })
    expect((await repoOf(repo.toUpperCase()))?.key).toBe('o/caserepo')
    expect((await repoOf(repo.toLowerCase()))?.key).toBe('o/caserepo')
  })
})
