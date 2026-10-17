// Settings → Command packs (docs/COMMAND-PACKS.md): the shapes AgentHydra's /api/command-packs answers
// (server/src/command-packs.ts, server/src/core/command-packs.ts) and the words its rows show.

export interface CommandPack {
  url: string
  branch?: string | null
}

export interface PackStatus {
  url: string
  branch: string | null
  head: string | null
  error: string | null
  commands: string[]
  skills: string[]
  shadowed: string[]
}

export interface TargetSync {
  kind: 'claude' | 'codex'
  dir: string
  label: string
  written: string[]
  updated: string[]
  removed: string[]
  edited: string[]
  keptOwn: string[]
  files: number
  error: string | null
}

export interface CommandPacksView {
  packs: CommandPack[]
  run: { at: number; packs: PackStatus[]; targets: TargetSync[] } | null
  busy: boolean
  everyMin: number
}

/** A pack's short name: `owner/repo` of a URL, or a folder's own name. */
export function packName(url: string): string {
  const path = url
    .trim()
    .replace(/\.git$/i, '')
    .replace(/[\\/]+$/, '')
  const parts = path.split(/[\\/:]+/).filter(Boolean)
  const remote = /^[a-z][a-z0-9+.-]*:\/\//i.test(path) || /^[\w.-]+@[\w.-]+:/.test(path)
  return remote && parts.length >= 3 ? parts.slice(-2).join('/') : (parts.at(-1) ?? path)
}

/** A pack's key: its URL and branch, as the list and the last run both name it. */
export const packKey = (url: string, branch?: string | null) => `${url.trim()}#${branch?.trim() || ''}`

/** The last run's status of each pack, by packKey. */
export function statusesByKey(view: CommandPacksView): Map<string, PackStatus> {
  return new Map((view.run?.packs ?? []).map((p) => [packKey(p.url, p.branch), p]))
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`

/** What a pack gives, as its row says it. */
export function packCounts(status: PackStatus | null): string {
  if (!status) return 'Not pulled yet'
  return `${plural(status.commands.length, 'command')} · ${plural(status.skills.length, 'skill')}`
}

/** "synced 4 min ago" from a run's time. */
export function syncedAgo(at: number, now = Date.now()): string {
  const min = Math.floor((now - at) / 60_000)
  if (min < 1) return 'synced just now'
  if (min < 60) return `synced ${min} min ago`
  const h = Math.floor(min / 60)
  return `synced ${h} h ago`
}

/** The section's status line: packs, what they give, and how many accounts hold them. */
export function summaryLine(view: CommandPacksView, now = Date.now()): string {
  if (!view.packs.length) return 'No packs'
  const parts = [plural(view.packs.length, 'pack')]
  if (view.run) {
    const commands = view.run.packs.reduce((n, p) => n + p.commands.length, 0)
    const skills = view.run.packs.reduce((n, p) => n + p.skills.length, 0)
    parts.push(plural(commands, 'command'), plural(skills, 'skill'), plural(view.run.targets.length, 'account'))
    parts.push(syncedAgo(view.run.at, now))
  }
  return parts.join(' · ')
}

/** Accounts that have something to say: a copy edited there, a file of the person's own under a pack's name,
 *  or a folder that could not be written. */
export function accountNotes(view: CommandPacksView): TargetSync[] {
  return (view.run?.targets ?? []).filter((t) => t.edited.length || t.keptOwn.length || t.error)
}
