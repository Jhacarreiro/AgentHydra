// server/src/project-repo.ts - the git repository a folder belongs to, for the spend report's
// "Cost by project" card (analytics.ts buildSpendReport).
//
// Grouping by raw cwd split one project into its worktrees (`<repo>\.wt\train37`), its subfolders and
// whatever folder a chat happened to start in. A cwd here counts as the repository of its nearest
// ancestor holding `.git`: a directory, or a `gitdir:` file. A worktree's gitdir has a `commondir`
// leading back to the main repository, so every worktree counts as its main checkout. The key is the
// origin remote's `owner/name` (any host), so two clones of one repository are one project; a
// repository with no remote is its own folder, shown by name. A folder in no repository stays the
// folder here; a session started in a parent folder of checkouts is credited to the repository its
// tool calls worked in by session-work.ts.

import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'

export interface RepoRef {
  /** What the spend groups on (compared case-insensitively): the origin's `owner/name`, else `root`. */
  key: string
  /** What the card shows: `owner/name`, or the root folder's name for a repository with no remote. */
  label: string
  /** The main checkout's folder (for a worktree, the repository it belongs to). */
  root: string
}

/** A cwd the report can look up: a drive or UNC path, or a POSIX absolute path. A decoded store key
 *  with no real cwd behind it ("codex", "c3f2747d/a510/...") is not one. */
export function isAbsoluteCwd(p: string | null | undefined): p is string {
  return !!p && /^(?:[A-Za-z]:[\\/]|[\\/])/.test(p)
}

/**
 * `owner/name` of a remote URL: `https://host/owner/name.git`, `ssh://git@host:22/owner/name`,
 * `git@host:owner/name.git`. A deeper path (a GitLab group) keeps its last two parts. Null for a
 * local path or `file://` remote, which names a folder on some disk rather than a repository.
 */
export function remoteSlug(url: string): string | null {
  const u = url.trim().replace(/[\\/]+$/, '')
  const path =
    /^[a-z][a-z0-9+.-]*:\/\/[^/]+\/(.+)$/i.exec(u)?.[1] ??
    // scp-like `[user@]host:path`; a one-letter "host" is a Windows drive.
    /^(?:[^@/\s]+@)?[^:/\\\s]{2,}:(?!\/\/)(.+)$/.exec(u)?.[1]
  if (!path) return null
  const parts = path
    .split('/')
    .filter(Boolean)
    .map((p) => p.replace(/\.git$/i, ''))
    .filter(Boolean)
  return parts.length ? parts.slice(-2).join('/') : null
}

/** The URL of the `origin` remote in a git config file, else of its first remote; null with none. */
export function originUrl(config: string): string | null {
  let remote: string | null = null
  const urls = new Map<string, string>()
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[\s*([^\s\]"]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(line)
    if (head) {
      remote = head[1]?.toLowerCase() === 'remote' && head[2] != null ? head[2] : null
      continue
    }
    const kv = /^url\s*=\s*(.*)$/i.exec(line)
    if (remote !== null && kv && !urls.has(remote)) urls.set(remote, kv[1]?.trim() ?? '')
  }
  return urls.get('origin') || [...urls.values()].find(Boolean) || null
}

const readText = (p: string): Promise<string | null> => readFile(p, 'utf8').catch(() => null)

/** The repository whose checkout `dir` is, from its `.git` entry; null when `dir` has none. */
async function repoAt(dir: string): Promise<RepoRef | null> {
  const dotGit = join(dir, '.git')
  const st = await stat(dotGit).catch(() => null)
  if (!st) return null
  let common = dotGit
  let root = dir
  if (st.isFile()) {
    // A worktree, a submodule or a separate git dir: `gitdir: <path>`, relative to `dir` or absolute.
    const to = /^gitdir:\s*(.+)$/m.exec((await readText(dotGit)) ?? '')?.[1]?.trim()
    if (!to) return null
    const gitDir = resolve(dir, to)
    const back = (await readText(join(gitDir, 'commondir')))?.trim()
    if (back) {
      // A worktree: its main repository's git dir, whose checkout is the folder above it (a bare
      // repository is its own root).
      common = resolve(gitDir, back)
      root = basename(common).toLowerCase() === '.git' ? dirname(common) : common
    } else common = gitDir
  } else if (!st.isDirectory()) return null
  const url = originUrl((await readText(join(common, 'config'))) ?? '')
  const slug = url ? remoteSlug(url) : null
  if (slug) return { key: slug, label: slug, root }
  return { key: root, label: basename(root).replace(/\.git$/i, '') || root, root }
}

/** Repositories were looked up again after this long: a remote added, a folder made a repository. */
const REPO_TTL_MS = 30 * 60_000
const byDir = new Map<string, { at: number; repo: RepoRef | null }>()
const dirKey = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)

/** The repository `cwd` is in (its nearest ancestor with `.git`), else null. A folder that is gone
 *  (a removed worktree) still counts as the repository of the nearest ancestor that is left. */
export async function repoOf(cwd: string, now = Date.now()): Promise<RepoRef | null> {
  if (!isAbsoluteCwd(cwd)) return null
  // A Windows path read on another OS would resolve under the process's own folder.
  if (process.platform !== 'win32' && !cwd.startsWith('/')) return null
  const walked: string[] = []
  let dir = resolve(cwd)
  let found: RepoRef | null = null
  for (;;) {
    const hit = byDir.get(dirKey(dir))
    if (hit && now - hit.at < REPO_TTL_MS) {
      found = hit.repo
      break
    }
    walked.push(dir)
    found = await repoAt(dir)
    if (found) break
    const up = dirname(dir)
    if (up === dir) break
    dir = up
  }
  for (const d of walked) byDir.set(dirKey(d), { at: now, repo: found })
  return found
}

/** repoOf for many cwds, one after another: the folders above them are shared, so each is looked at once. */
export async function reposOf(cwds: Iterable<string>): Promise<Map<string, RepoRef | null>> {
  const out = new Map<string, RepoRef | null>()
  for (const cwd of cwds) if (!out.has(cwd)) out.set(cwd, await repoOf(cwd))
  return out
}

/** Forget every looked-up folder. For tests, which build repositories in scratch folders. */
export function resetRepoCache(): void {
  byDir.clear()
}
