// server/src/command-packs.ts — the daemon's side of command packs (docs/COMMAND-PACKS.md): the list a person
// keeps in Settings, the accounts it reaches, and the pull every ten minutes. The copying itself, and every rule
// about whose file is whose, is core/command-packs.ts.
//
// The list belongs to the person, not the app (as helpers.json does): `<CONFIG_DIR>/command-packs.json`. The
// pulled checkouts are a cache, `<DATA_DIR>/command-packs/<key>/`, safe to delete.
//
// The accounts it reaches: the default Claude config dir (`~/.claude`, which every Claude Desktop instance's
// Code tab also uses, docs/CLAUDE-CONFIG-LAYOUT.md), every CLI instance's config dir, and every Codex home,
// the default one included. Only a folder that exists: a PC without Codex gets no `~/.codex`.

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { CLAUDE_PROJECTS_ROOT, CONFIG_DIR, DATA_DIR } from './config'
import { listCliInstances } from './core/cli-instances'
import { codexInstanceStores } from './core/codex-instances'
import {
  type CommandPack,
  type CommandPackRun,
  type PackTarget,
  packProblem,
  syncCommandPacks,
} from './core/command-packs'
import { writeJsonStoreAtomic } from './core/json-store'
import { pathKey } from './path-key'

const STORE = join(CONFIG_DIR, 'command-packs.json')
const CACHE_ROOT = join(DATA_DIR, 'command-packs')
export const COMMAND_PACKS_EVERY_MS = 10 * 60_000
/** Fewer than a person would keep; a bound on what one save can make the daemon pull. */
const MAX_PACKS = 20

export interface CommandPacksView {
  packs: CommandPack[]
  /** The last run's result, or null before the first one since the daemon started. */
  run: CommandPackRun | null
  busy: boolean
  everyMin: number
}

let last: CommandPackRun | null = null
/** Runs asked for and not yet finished. Counted when asked, not when started: a save's answer is built before the
 *  queued run starts, and must already say busy, or Settings waits its slow poll to see the result. */
let pending = 0
let chain: Promise<unknown> = Promise.resolve()

/** The saved list. A missing or unreadable file is no packs. */
export function readCommandPacks(): CommandPack[] {
  try {
    const parsed = JSON.parse(readFileSync(STORE, 'utf8')) as { packs?: unknown }
    if (!Array.isArray(parsed.packs)) return []
    return parsed.packs
      .filter((p): p is CommandPack => typeof (p as CommandPack)?.url === 'string')
      .map((p) => ({ url: p.url, branch: p.branch ?? null }))
  } catch {
    return []
  }
}

/** Save the list a person set, or say what is wrong with it (nothing is saved then). */
export function saveCommandPacks(input: unknown): { ok: true } | { ok: false; error: string } {
  if (!Array.isArray(input)) return { ok: false, error: 'packs must be a list.' }
  if (input.length > MAX_PACKS) return { ok: false, error: `At most ${MAX_PACKS} packs.` }
  const packs: CommandPack[] = []
  const seen = new Set<string>()
  for (const raw of input) {
    const url = typeof raw?.url === 'string' ? raw.url.trim() : ''
    const branch = typeof raw?.branch === 'string' && raw.branch.trim() ? raw.branch.trim() : null
    const pack = { url, branch }
    const problem = packProblem(pack)
    if (problem) return { ok: false, error: `${url || 'A pack'}: ${problem}` }
    const key = `${url}#${branch ?? ''}`
    if (seen.has(key)) return { ok: false, error: `${url} is in the list twice.` }
    seen.add(key)
    packs.push(pack)
  }
  writeJsonStoreAtomic(STORE, { packs })
  return { ok: true }
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** Every account folder on this PC a pack reaches, each once. */
export function commandPackTargets(): PackTarget[] {
  const out: PackTarget[] = []
  const seen = new Set<string>()
  const add = (kind: PackTarget['kind'], dir: string, label: string) => {
    const key = pathKey(resolve(dir))
    if (seen.has(key) || !isDir(dir)) return
    seen.add(key)
    out.push({ kind, dir, label })
  }
  add('claude', dirname(CLAUDE_PROJECTS_ROOT), 'Claude (default, and Desktop)')
  try {
    for (const i of listCliInstances()) add('claude', i.configDir, `#${i.num} ${i.name}`)
  } catch (err) {
    console.error('[command-packs] could not list the CLI instances:', err)
  }
  try {
    for (const s of codexInstanceStores())
      add('codex', s.codexHome, s.num ? `#${s.num} ${s.name} (Codex)` : `${s.name} (Codex)`)
  } catch (err) {
    console.error('[command-packs] could not list the Codex homes:', err)
  }
  return out
}

/** Pull every pack and copy it into every account, one run at a time: a run asked for while one is going
 *  starts when it ends, with the list as it is then. */
export function runCommandPacks(): Promise<CommandPackRun> {
  pending++
  const next = chain.then(async () => {
    try {
      const packs = readCommandPacks()
      const run = await syncCommandPacks({
        packs,
        targets: commandPackTargets(),
        cacheRoot: CACHE_ROOT,
      })
      last = run
      const n = (pick: (t: CommandPackRun['targets'][number]) => string[]) =>
        run.targets.reduce((sum, t) => sum + pick(t).length, 0)
      const moved = n((t) => t.written) + n((t) => t.updated) + n((t) => t.removed)
      if (moved)
        console.log(
          `[command-packs] ${n((t) => t.written)} written, ${n((t) => t.updated)} updated, ${n((t) => t.removed)} removed across ${run.targets.length} accounts`,
        )
      for (const p of run.packs) if (p.error) console.warn(`[command-packs] ${p.url}: ${p.error}`)
      return run
    } finally {
      pending--
    }
  })
  chain = next.catch(() => {})
  return next
}

export function commandPacksView(): CommandPacksView {
  return {
    packs: readCommandPacks(),
    run: last,
    busy: pending > 0,
    everyMin: COMMAND_PACKS_EVERY_MS / 60_000,
  }
}

/** The pull every ten minutes, first a little after the daemon starts. Returns its stop. A PC that never
 *  saved a list runs once (to read what each account holds) and then does nothing. */
export function startCommandPacks(): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null
  const arm = (ms: number) => {
    timer = setTimeout(() => void loop(), ms)
    timer.unref?.()
  }
  const loop = async () => {
    try {
      if (existsSync(STORE) || last === null) await runCommandPacks()
    } catch (err) {
      console.error(
        `[command-packs] run failed: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    if (!stopped) arm(COMMAND_PACKS_EVERY_MS)
  }
  arm(30_000)
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}
