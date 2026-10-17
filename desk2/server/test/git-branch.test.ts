// branchOf: one git read per folder inside its fresh window, shared by chats in the same folder.
import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
  expect(await branchOf(dir, () => clock)).toBe('topic-one') // kept, git not asked again
  clock += 60_000
  expect(await branchOf(dir, () => clock)).toBe('topic-two')
  // Three git spawns: past Bun's 5 s default on a loaded Windows box (5006 ms in the full suite, 2026-10-17).
}, 20_000)

test('a folder outside a repository has no branch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'desk-nobranch-'))
  temps.push(dir)
  expect(await branchOf(dir)).toBeNull()
})
