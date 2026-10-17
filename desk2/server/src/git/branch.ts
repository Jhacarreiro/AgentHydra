// The current git branch of a folder, for the session rail's Environment card. Read with one `git symbolic-ref` per folder,
// kept BRANCH_FRESH_MS and shared by every chat in it, so a screen never starts git: a chat asks when it opens and when a
// turn ends, and gets the kept answer in between.
import { runGit } from './git'

const BRANCH_FRESH_MS = 30_000
const BRANCH_KEPT = 100

const kept = new Map<string, { at: number; branch: string | null }>()
const reading = new Map<string, Promise<string | null>>()

/** The folder's branch (null outside a repository, on a detached head, or where git cannot run). `now` is for tests. */
export function branchOf(cwd: string, now: () => number = Date.now): Promise<string | null> {
  const hit = kept.get(cwd)
  if (hit && now() - hit.at < BRANCH_FRESH_MS) return Promise.resolve(hit.branch)
  const pending = reading.get(cwd)
  if (pending) return pending
  const read = runGit(cwd, ['symbolic-ref', '--short', '-q', 'HEAD'])
    .then((r) => {
      const name = r.code === 0 ? r.stdout.toString('utf8').trim() : ''
      return name || null // a detached head (or no repository) exits non-zero
    })
    .catch(() => null) // a folder gone or git missing: no branch
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
