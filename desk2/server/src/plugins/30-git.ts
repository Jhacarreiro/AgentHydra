// Git status, one file's diff, and folder browsing (SPEC.md REST rows /api/git, /api/git/diff,
// /api/folders/browse). Bad input and git failures answer 400 with the real reason.

import type { Context, Hono } from 'hono'
import type { ServerContext } from '../context'
import { browse, BrowseError } from '../git/browse'
import { GitError, gitDiff, gitStatus, mergeConflictFiles } from '../git/git'

function badRequest(err: unknown): string | null {
  return err instanceof GitError || err instanceof BrowseError ? err.message : null
}

// Runs one route's work and answers a git or browse failure as a 400 with its reason; anything else rethrows.
async function answer(c: Context, work: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await work())
  } catch (err) {
    const msg = badRequest(err)
    if (msg) return c.json({ error: msg }, 400)
    throw err
  }
}

export default function plugin(app: Hono, _ctx: ServerContext): void {
  app.get('/api/git', (c) => answer(c, () => gitStatus(c.req.query('cwd') ?? '')))

  // Asked on the Changes pane's timer; the answer is cached per pair of commits in git.ts.
  app.get('/api/git/merge-conflicts', (c) => answer(c, () => mergeConflictFiles(c.req.query('cwd') ?? '')))

  app.get('/api/git/diff', (c) =>
    answer(c, async () => ({ diff: await gitDiff(c.req.query('cwd') ?? '', c.req.query('path') ?? '') })),
  )

  app.get('/api/folders/browse', (c) => answer(c, () => browse(c.req.query('path') ?? '')))
}
