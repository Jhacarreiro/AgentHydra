// server/src/core/codex-owner-agents.ts — the owner's global Codex instructions for every Codex instance.
//
// WHY (2026-10-15): Codex reads its global instructions from `$CODEX_HOME/AGENTS.md`, and an instance
// runs with CODEX_HOME set to its own folder (`~/.agenthydra/codex-instances/<id>`), which had none. So a
// chat on an added Codex account got none of the rules the owner keeps in the default home's AGENTS.md:
// one patched a deploy checkout by hand, and that app took no update for hours.
//
// The owner's AGENTS.md is COPIED into the instance (as CliMayte copies CLAUDE.md into a worker's
// account, climayte-owner-sync.ts): again only when the owner's changed, and never over one the
// instance holds of its own. A copy this code made is known by the stamp kept beside it. An older file
// whose whole text is inside the owner's (a block someone pasted into each home by hand) is replaced
// too: the owner's file already says all of it, so nothing is lost.

import { copyFileSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const STAMP = '.agenthydra-owner-agents.json'

interface Stamp {
  /** The AGENTS.md this code wrote (size:mtime of the copy). */
  copy: string | null
  /** The owner's AGENTS.md (size:mtime) that copy was made from. */
  src: string | null
}

export type OwnerAgentsSync =
  | 'copied'
  | 'unchanged'
  | 'kept-own'
  | 'no-source'
  | 'owner-home'
  | 'failed'

function stampOf(file: string): string | null {
  try {
    const s = statSync(file)
    return `${s.size}:${Math.round(s.mtimeMs)}`
  } catch {
    return null
  }
}

function readStamp(home: string): Stamp | null {
  try {
    return JSON.parse(readFileSync(join(home, STAMP), 'utf8')) as Stamp
  } catch {
    return null
  }
}

const text = (file: string) => readFileSync(file, 'utf8').replace(/\r\n/g, '\n').trim()

const samePath = (a: string, b: string) =>
  process.platform === 'win32'
    ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
    : resolve(a) === resolve(b)

/** Make `instanceHome`'s AGENTS.md the owner's (`ownerHome`'s). Never throws: an instance without the
 *  owner's rules is worse, but not a reason to refuse its launch. */
export function syncOwnerAgents(ownerHome: string, instanceHome: string): OwnerAgentsSync {
  if (samePath(ownerHome, instanceHome)) return 'owner-home'
  const src = join(ownerHome, 'AGENTS.md')
  const dst = join(instanceHome, 'AGENTS.md')
  try {
    const srcNow = stampOf(src)
    if (srcNow === null) return 'no-source'
    const stamp = readStamp(instanceHome)
    const dstNow = stampOf(dst)
    const ours = dstNow !== null && dstNow === stamp?.copy
    if (ours && srcNow === stamp?.src) return 'unchanged'
    if (dstNow !== null && !ours && !text(src).includes(text(dst))) return 'kept-own'
    copyFileSync(src, dst)
    writeFileSync(
      join(instanceHome, STAMP),
      JSON.stringify({ copy: stampOf(dst), src: srcNow } satisfies Stamp),
    )
    return 'copied'
  } catch (err) {
    console.error(`[codex-instances] could not give ${instanceHome} the owner's AGENTS.md:`, err)
    return 'failed'
  }
}
