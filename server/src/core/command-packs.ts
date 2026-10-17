// server/src/core/command-packs.ts — a team's slash commands and skills, pulled from git into every account
// (docs/COMMAND-PACKS.md).
//
// WHY (owner, 2026-10-16): a team keeps its Claude Code commands (`commands/*.md`) and skills
// (`skills/<name>/SKILL.md`) in a git repo, and every account AgentHydra runs should have them, kept current,
// without anyone copying files by hand into each config folder (AgentHydra's own `/orchestrate` was copied that
// way, docs/CLAUDE-CONFIG-LAYOUT.md).
//
// A pack is a git URL and an optional branch. Each is pulled into a cache folder this code owns, then its files
// are copied into every target: a Claude config dir gets `commands/` and `skills/` as they are, a Codex home gets
// the top-level commands as `prompts/` (Codex's slash commands, one folder deep) and the skills as `skills/`.
//
// What it never does (the copy rules, each held by server/tests/command-packs.test.ts):
// - Replace a file it did not write. Each target keeps a record of what this code wrote there and the SHA-256 it
//   wrote (`.agenthydra-command-packs.json`); a file with no record is the person's (`keptOwn`), and so is a whole
//   skill folder whose SKILL.md is theirs.
// - Replace a copy someone edited. A file whose content no longer matches the record stays as it is (`edited`),
//   and when the pack drops it, it is left as theirs.
// - Write or remove through a link. CliMayte links the owner's own skills into account folders
//   (climayte-owner-sync.ts); a pack file written through one would land in the owner's own skill.
// - Lose a pack's copies because the pack could not be pulled this time: a pack with no checkout on this PC
//   keeps every copy it wrote, untouched, until it can be read again or is taken off the list.

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import {
  access,
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  rmdir,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export interface CommandPack {
  /** Anything `git clone` takes: an https or ssh URL, or a path on this PC. */
  url: string
  /** The branch to follow; the repo's default branch when absent. */
  branch?: string | null
}

export type PackTargetKind = 'claude' | 'codex'

/** One folder a pack is copied into: a Claude config dir or a Codex home. */
export interface PackTarget {
  kind: PackTargetKind
  dir: string
  /** How Settings names it (an account's name or number). */
  label: string
}

export interface PackStatus {
  url: string
  branch: string | null
  /** The commit the copies come from, or null when this PC has no checkout of the pack. */
  head: string | null
  /** Why the last pull failed (the copies then come from the checkout already here, if any), or null. */
  error: string | null
  /** Its commands (paths under `commands/`) and skill names. */
  commands: string[]
  skills: string[]
  /** Its commands and skills an earlier pack in the list already gives, which it does not. */
  shadowed: string[]
}

export interface TargetSync {
  kind: PackTargetKind
  dir: string
  label: string
  written: string[]
  updated: string[]
  removed: string[]
  /** Copies a person edited, kept as they are. */
  edited: string[]
  /** The person's own files (or skill folders, `skills/<name>/`) under a pack's name, never touched. */
  keptOwn: string[]
  /** Files this code keeps in the folder after the run. */
  files: number
  error: string | null
}

export interface CommandPackRun {
  at: number
  packs: PackStatus[]
  targets: TargetSync[]
}

/** The record each target keeps of what this code wrote there. */
const MANIFEST = '.agenthydra-command-packs.json'

/** One command or skill of a pack, its files relative to the pack's root. */
interface PackItem {
  kind: 'command' | 'skill'
  /** `commands/<path>.md` or `skills/<name>/`, as Settings shows it. */
  key: string
  /** The path under `commands/` (a command) or the skill's name. */
  name: string
  files: Array<{ rel: string; src: string; sha: string }>
  pack: string
}

/** One item as a target lays it out. */
interface Unit {
  key: string
  /** The skill's folder in the target (`skills/<name>`), or null for a command. */
  root: string | null
  files: Array<{ rel: string; src: string; sha: string }>
  pack: string
}

interface Manifest {
  files: Record<string, { sha: string; pack: string }>
}

const GIT_TIMEOUT_MS = 120_000
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/

async function sha256(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

/** A file's SHA-256, `not-a-file` for a folder (someone else's, so never written over), or null when nothing is
 *  there. */
async function shaAt(path: string): Promise<string | null> {
  try {
    return (await lstat(path)).isFile() ? await sha256(path) : 'not-a-file'
  } catch {
    return null
  }
}

/** Why a pack entry cannot be pulled, or null. A URL or branch that starts with `-` would be read as an option. */
export function packProblem(pack: CommandPack): string | null {
  const url = pack.url?.trim() ?? ''
  if (!url) return 'The URL is empty.'
  if (url.startsWith('-')) return 'A URL cannot start with "-".'
  if (/^ext::/i.test(url))
    return 'The ext:: transport runs a command; use an https, ssh or file URL.'
  if (/[\r\n]/.test(url)) return 'A URL is one line.'
  const branch = pack.branch?.trim()
  if (branch && (!BRANCH_RE.test(branch) || branch.startsWith('-') || branch.includes('..')))
    return `"${branch}" is not a branch name.`
  return null
}

/** The cache folder a pack is pulled into: one per URL and branch. */
export function packCacheKey(pack: CommandPack): string {
  return createHash('sha256')
    .update(`${pack.url.trim()}#${pack.branch?.trim() ?? ''}`)
    .digest('hex')
    .slice(0, 16)
}

function git(args: string[], cwd?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'protocol.ext.allow=never', ...args],
      {
        cwd,
        timeout: GIT_TIMEOUT_MS,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        // Never ask: a pull runs in the background, and a prompt for a password there would wait forever. A
        // private repo is pulled with the credentials git already has on this PC.
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
      },
      (err, stdout, stderr) => {
        if (err) {
          const said = `${stderr}`.trim().split(/\r?\n/).filter(Boolean).pop()
          reject(new Error(said || err.message))
        } else resolve(`${stdout}`.trim())
      },
    )
  })
}

const hasCheckout = (dir: string): Promise<boolean> =>
  access(join(dir, '.git')).then(
    () => true,
    () => false,
  )

/** Pull a pack into its cache folder. A failed pull keeps the checkout already there, and says why. */
async function pullPack(
  pack: CommandPack,
  cacheRoot: string,
): Promise<{ dir: string | null; head: string | null; error: string | null }> {
  const problem = packProblem(pack)
  if (problem) return { dir: null, head: null, error: problem }
  const url = pack.url.trim()
  const branch = pack.branch?.trim() || null
  const dir = join(cacheRoot, packCacheKey(pack))
  let error: string | null = null
  try {
    if (await hasCheckout(dir)) {
      await git(['fetch', '--depth', '1', 'origin', branch ?? 'HEAD'], dir)
      await git(['reset', '--hard', '-q', 'FETCH_HEAD'], dir)
    } else {
      await rm(dir, { recursive: true, force: true })
      await mkdir(cacheRoot, { recursive: true })
      await git([
        'clone',
        '-q',
        '--depth',
        '1',
        '--single-branch',
        ...(branch ? ['--branch', branch] : []),
        '--',
        url,
        dir,
      ])
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err)
  }
  if (!(await hasCheckout(dir))) return { dir: null, head: null, error }
  const head = await git(['rev-parse', 'HEAD'], dir).catch(() => null)
  return { dir, head, error }
}

/** Plain files under `dir`, relative to it with `/`, skipping dot entries and links. */
async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith('.') || e.isSymbolicLink()) continue
    const rel = prefix ? `${prefix}/${e.name}` : e.name
    if (e.isDirectory()) out.push(...(await walk(join(dir, e.name), rel)))
    else if (e.isFile()) out.push(rel)
  }
  return out
}

/** A checkout's commands (`commands/**\/*.md`) and skills (`skills/<name>/` with a SKILL.md). */
async function readPack(checkout: string, pack: string): Promise<PackItem[]> {
  const items: PackItem[] = []
  const file = async (rel: string) => {
    const src = join(checkout, rel)
    return { rel, src, sha: await sha256(src) }
  }
  for (const rel of await walk(join(checkout, 'commands'))) {
    if (!rel.toLowerCase().endsWith('.md')) continue
    items.push({
      kind: 'command',
      key: `commands/${rel}`,
      name: rel,
      files: [await file(`commands/${rel}`)],
      pack,
    })
  }
  const skillsDir = join(checkout, 'skills')
  let names: string[] = []
  try {
    names = (await readdir(skillsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    // A pack with no skills.
  }
  for (const name of names) {
    if ((await shaAt(join(skillsDir, name, 'SKILL.md'))) === null) continue
    const files: PackItem['files'] = []
    for (const rel of await walk(join(skillsDir, name)))
      files.push(await file(`skills/${name}/${rel}`))
    items.push({ kind: 'skill', key: `skills/${name}/`, name, files, pack })
  }
  return items
}

/** The items as a target of `kind` lays them out. Codex takes top-level commands only, as prompts. */
function unitsFor(kind: PackTargetKind, items: PackItem[]): Unit[] {
  const units: Unit[] = []
  for (const item of items) {
    if (item.kind === 'skill') {
      units.push({ key: item.key, root: `skills/${item.name}`, files: item.files, pack: item.pack })
      continue
    }
    if (kind === 'claude') {
      units.push({ key: item.key, root: null, files: item.files, pack: item.pack })
      continue
    }
    if (item.name.includes('/')) continue
    const rel = `prompts/${item.name}`
    units.push({
      key: rel,
      root: null,
      files: item.files.map((f) => ({ ...f, rel })),
      pack: item.pack,
    })
  }
  return units
}

async function readManifest(dir: string): Promise<Manifest> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, MANIFEST), 'utf8')) as Manifest
    if (parsed && typeof parsed.files === 'object' && parsed.files) return parsed
  } catch {
    // None yet, or unreadable: nothing in the folder is this code's, so nothing is replaced or removed.
  }
  return { files: {} }
}

/** True when a folder on the way from `dir` to `rel` is a link (a junction on Windows). */
async function throughLink(dir: string, rel: string): Promise<boolean> {
  const parts = rel.split('/').slice(0, -1)
  let at = dir
  for (const part of parts) {
    at = join(at, part)
    try {
      if ((await lstat(at)).isSymbolicLink()) return true
    } catch {
      return false
    }
  }
  return false
}

/** Remove folders left empty under a pack root (`commands/`, `prompts/`, `skills/`), never the root itself. */
async function pruneEmpty(dir: string, rel: string): Promise<void> {
  const parts = rel.split('/')
  for (let n = parts.length - 1; n >= 2; n--) {
    const folder = join(dir, ...parts.slice(0, n))
    try {
      if ((await readdir(folder)).length > 0) return
      await rmdir(folder)
    } catch {
      return
    }
  }
}

async function writeCopy(dir: string, rel: string, src: string): Promise<void> {
  const dst = join(dir, rel)
  await mkdir(dirname(dst), { recursive: true })
  await copyFile(src, dst)
}

/** Make one target hold the units, by the rules at the top of this file. `unavailable` are the packs that
 *  could not be read this run: their copies are left exactly as they are. */
async function syncTarget(
  target: PackTarget,
  units: Unit[],
  unavailable: Set<string>,
): Promise<TargetSync> {
  const result: TargetSync = {
    kind: target.kind,
    dir: target.dir,
    label: target.label,
    written: [],
    updated: [],
    removed: [],
    edited: [],
    keptOwn: [],
    files: 0,
    error: null,
  }
  try {
    if (!(await stat(target.dir)).isDirectory()) throw new Error('not a folder')
    const manifest = await readManifest(target.dir)
    let dirty = false
    const record = (rel: string, sha: string, pack: string) => {
      const rec = manifest.files[rel]
      if (rec?.sha === sha && rec.pack === pack) return
      manifest.files[rel] = { sha, pack }
      dirty = true
    }
    const wanted = new Set<string>()
    for (const unit of units) {
      if (unit.root) {
        // A skill is the person's whole when its folder is reached through a link, or holds a SKILL.md this
        // code never wrote that is not the pack's.
        const skillMd = `${unit.root}/SKILL.md`
        const own = unit.files.find((f) => f.rel === skillMd)
        const there = await shaAt(join(target.dir, skillMd))
        const ours = manifest.files[skillMd] !== undefined
        const foreignFolder =
          there === null && !ours && (await shaAt(join(target.dir, unit.root))) !== null
        if (
          (await throughLink(target.dir, skillMd)) ||
          foreignFolder ||
          (there !== null && !ours && there !== own?.sha)
        ) {
          result.keptOwn.push(`${unit.root}/`)
          continue
        }
      }
      for (const f of unit.files) {
        wanted.add(f.rel)
        const rec = manifest.files[f.rel]
        if (rec && rec.pack !== unit.pack && unavailable.has(rec.pack)) continue
        if (await throughLink(target.dir, f.rel)) {
          result.keptOwn.push(f.rel)
          continue
        }
        const there = await shaAt(join(target.dir, f.rel))
        if (there === f.sha) {
          record(f.rel, f.sha, unit.pack)
        } else if (there === null) {
          await writeCopy(target.dir, f.rel, f.src)
          record(f.rel, f.sha, unit.pack)
          result.written.push(f.rel)
        } else if (rec && there === rec.sha) {
          await writeCopy(target.dir, f.rel, f.src)
          record(f.rel, f.sha, unit.pack)
          result.updated.push(f.rel)
        } else if (rec) {
          result.edited.push(f.rel)
        } else {
          result.keptOwn.push(f.rel)
        }
      }
    }
    for (const [rel, rec] of Object.entries(manifest.files)) {
      if (wanted.has(rel) || unavailable.has(rec.pack)) continue
      delete manifest.files[rel]
      dirty = true
      if (await throughLink(target.dir, rel)) continue
      const path = join(target.dir, rel)
      // A copy someone edited is theirs once the pack lets it go.
      if ((await shaAt(path)) !== rec.sha) continue
      await unlink(path)
      result.removed.push(rel)
      await pruneEmpty(target.dir, rel)
    }
    result.files = Object.keys(manifest.files).length
    if (dirty) await writeFile(join(target.dir, MANIFEST), JSON.stringify(manifest, null, 1))
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err)
  }
  return result
}

/** Remove cache folders of packs no longer listed. */
async function pruneCache(cacheRoot: string, packs: CommandPack[]): Promise<void> {
  const keep = new Set(packs.map(packCacheKey))
  let entries: string[] = []
  try {
    entries = await readdir(cacheRoot)
  } catch {
    return
  }
  for (const name of entries)
    if (/^[0-9a-f]{16}$/.test(name) && !keep.has(name))
      await rm(join(cacheRoot, name), { recursive: true, force: true })
}

/** Pull every pack, then make every target hold them, one at a time (a run never floods the disk or the
 *  daemon's loop). The first pack in the list wins a name two packs share. */
export async function syncCommandPacks(opts: {
  packs: CommandPack[]
  targets: PackTarget[]
  cacheRoot: string
}): Promise<CommandPackRun> {
  const statuses: PackStatus[] = []
  const items: PackItem[] = []
  const taken = new Set<string>()
  const unavailable = new Set<string>()
  for (const pack of opts.packs) {
    const url = pack.url.trim()
    const pulled = await pullPack(pack, opts.cacheRoot)
    const status: PackStatus = {
      url,
      branch: pack.branch?.trim() || null,
      head: pulled.head,
      error: pulled.error,
      commands: [],
      skills: [],
      shadowed: [],
    }
    statuses.push(status)
    if (!pulled.dir) {
      unavailable.add(url)
      continue
    }
    for (const item of await readPack(pulled.dir, url)) {
      if (taken.has(item.key)) {
        status.shadowed.push(item.key)
        continue
      }
      taken.add(item.key)
      items.push(item)
      if (item.kind === 'command') status.commands.push(item.name)
      else status.skills.push(item.name)
    }
  }
  await pruneCache(opts.cacheRoot, opts.packs)
  const targets: TargetSync[] = []
  for (const t of opts.targets)
    targets.push(await syncTarget(t, unitsFor(t.kind, items), unavailable))
  return { at: Date.now(), packs: statuses, targets }
}
