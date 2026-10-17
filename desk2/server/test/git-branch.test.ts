// branchOf: one HEAD read per folder inside its fresh window, shared by chats in the same folder.
import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { branchOf, resetBranchCache } from '../src/git/branch'
import { runGit } from '../src/git/git'

const temps: string[] = []
afterEach(() => {
  resetBranchCache()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('the branch is read once per folder while fresh, and read again once stale', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-branch-'))
  temps.push(dir)
  await runGit(dir, ['init', '-q', '-b', 'topic-one'])
  let clock = 1_000
  expect(await branchOf(dir, () => clock)).toBe('topic-one')
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/topic-two\n') // what `git symbolic-ref HEAD` writes, without a spawn
  expect(await branchOf(dir, () => clock)).toBe('topic-one') // kept, HEAD not read again
  clock += 60_000
  expect(await branchOf(dir, () => clock)).toBe('topic-two')
}, 20_000)

test('a worktree and a subfolder name the branch of the checkout they are in', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-worktree-'))
  temps.push(dir)
  // A linked worktree's `.git` is a file naming its own git dir, whose HEAD is the worktree's branch.
  const gitDir = join(dir, 'main', '.git', 'worktrees', 'wt')
  mkdirSync(gitDir, { recursive: true })
  writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/feature/rail\n')
  mkdirSync(join(dir, 'wt', 'src'), { recursive: true })
  writeFileSync(join(dir, 'wt', '.git'), 'gitdir: ../main/.git/worktrees/wt\n')
  expect(await branchOf(join(dir, 'wt', 'src'))).toBe('feature/rail')
  // A detached head holds a commit id: no branch.
  writeFileSync(join(gitDir, 'HEAD'), 'a3da0e61f00dfeedfacecafe0000000000000000\n')
  resetBranchCache()
  expect(await branchOf(join(dir, 'wt'))).toBeNull()
})

test('a folder outside a repository has no branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-nobranch-'))
  temps.push(dir)
  expect(await branchOf(dir)).toBeNull()
})
