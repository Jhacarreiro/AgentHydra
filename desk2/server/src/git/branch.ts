// The current git branch of a folder, for the session rail's Environment card: the HEAD file of the repository the folder is
// in (its nearest `.git`; a worktree's through its `gitdir:` line), kept BRANCH_FRESH_MS and shared by every chat in it. A
// chat asks when it opens and when a turn ends, and gets the kept answer in between.
//
// It ran `git symbolic-ref` until 2026-10-17: a child process that went on working in the chat's folder after the chat had
// asked, unawaited. Windows refuses to remove a folder a process works in, so every desk2 test that removed its chat's
// folder after opening it failed with EBUSY (windows-latest CI, red from 91a3826e on), and each chat open started git.
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const BRANCH_FRESH_MS = 30_000
const BRANCH_KEPT = 100

const kept = new Map<string, { at: number; branch: string | null }>()
const reading = new Map<string, Promise<string | null>>()

/** The branch HEAD names in the repository `cwd` is in, as `git symbolic-ref --short HEAD` gives it; null for a detached
 *  head (HEAD holds a commit id) or a folder in no repository. */
async function readBranch(cwd: string): Promise<string | null> {
  for (let dir = resolve(cwd); ; ) {
    const dotGit = join(dir, '.git')
    const st = await stat(dotGit).catch(() => null)
    if (st) {
      let gitDir = dotGit
      if (st.isFile()) {
        const to = /^gitdir:\s*(.+?)\s*$/m.exec(await readFile(dotGit, 'utf8'))?.[1]
        if (!to) return null
        gitDir = resolve(dir, to)
      }
      const ref = /^ref:\s*(\S+)/.exec(await readFile(join(gitDir, 'HEAD'), 'utf8'))?.[1]
      return ref ? ref.replace(/^refs\/heads\//, '') : null
    }
    const up = dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

/** The folder's branch (null outside a repository, on a detached head, or where its HEAD cannot be read). `now` is for tests. */
export function branchOf(cwd: string, now: () => number = Date.now): Promise<string | null> {
  const hit = kept.get(cwd)
  if (hit && now() - hit.at < BRANCH_FRESH_MS) return Promise.resolve(hit.branch)
  const pending = reading.get(cwd)
  if (pending) return pending
  const read = readBranch(cwd)
    .catch(() => null) // a folder gone or a HEAD unreadable: no branch
    .then((branch) => {
      kept.delete(cwd)
      kept.set(cwd, { at: now(), branch })
      while (kept.size > BRANCH_KEPT) kept.delete(kept.keys().next().value!)
      reading.delete(cwd)
      return branch
    })
  reading.set(cwd, read)
  return read
}

/** Forgets what was kept (a test's). */
export function resetBranchCache(): void {
  kept.clear()
  reading.clear()
}
