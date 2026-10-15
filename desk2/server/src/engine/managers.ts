// The managers Desk shows on a chat: each manager's persona and avatar come from people/manager/<slug>/ or the legacy
// ~/.agenthydra/managers/<slug>/ (server/src/manager-folders.ts), and sessions/<claude session id>.json in the legacy folder
// names the manager a session is on.

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { MANAGER_SLUG, managerFile, managerHomes, managersDir } from '../../../../server/src/manager-folders'
import { managerStats } from './manager-stats'

export const AVATAR_TYPES = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif' }
export type AvatarExt = keyof typeof AVATAR_TYPES

export type ManagerAvatar = { path: string; ext: AvatarExt; contentType: string; photo: number }

export type CurrentManager = { slug: string; name: string; title: string | null; oneLiner: string | null; photo: number | null; statsLine: string | null }

function readObject(path: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function personaOf(slug: string): Record<string, unknown> | null {
  if (!MANAGER_SLUG.test(slug)) return null
  const file = managerFile(slug, 'persona.json')
  return file ? readObject(file) : null
}

export function managerName(slug: string): string | null {
  return text(personaOf(slug)?.name)
}

/** The newest `<name>.png`, `.jpg`, `.webp` or `.gif` in a folder; photo is its mtime in whole ms. */
export function newestAvatar(dir: string, name: string): ManagerAvatar | null {
  let newest: ManagerAvatar | null = null
  for (const ext of Object.keys(AVATAR_TYPES) as AvatarExt[]) {
    const path = join(dir, `${name}.${ext}`)
    const st = statSync(path, { throwIfNoEntry: false })
    if (!st?.isFile()) continue
    const photo = Math.floor(st.mtimeMs)
    if (!newest || photo > newest.photo) newest = { path, ext, contentType: AVATAR_TYPES[ext], photo }
  }
  return newest
}

/** The newest avatar.png, .jpg, .webp or .gif in the manager's folder; photo is its mtime in whole ms. */
export function managerAvatar(slug: string): ManagerAvatar | null {
  if (!MANAGER_SLUG.test(slug)) return null
  for (const dir of managerHomes(slug)) {
    const avatar = newestAvatar(dir, 'avatar')
    if (avatar) return avatar
  }
  return null
}

function sessionManager(sessionId: string): string | null {
  if (!/^[\w-]+$/.test(sessionId)) return null
  return text(readObject(join(managersDir(), 'sessions', `${sessionId}.json`))?.manager)
}

/** How long a manager's label is reused before its folder is read again: a persona or photo changed by hand shows
 *  within this, and forgetManager (a photo saved in Desk) drops it at once. Every chat on a manager shares one read. */
const LABEL_MS = 5000
const labels = new Map<string, { at: number; label: Omit<CurrentManager, 'slug'> | null }>()

function labelOf(slug: string): Omit<CurrentManager, 'slug'> | null {
  const key = managerHomes(slug).join('|')
  const hit = labels.get(key)
  const now = Date.now()
  if (hit && now - hit.at < LABEL_MS) return hit.label
  const persona = personaOf(slug)
  const name = text(persona?.name)
  const label = name
    ? { name, title: text(persona?.title), oneLiner: text(persona?.oneLiner), photo: managerAvatar(slug)?.photo ?? null, statsLine: managerStats(slug)?.line ?? null }
    : null
  labels.set(key, { at: now, label })
  return label
}

/** The manager's folder changed: its next label is read from the disk. */
export function forgetManager(slug: string): void {
  labels.delete(managerHomes(slug).join('|'))
}

export function currentManager(
  pin: string | null | undefined,
  sessionId: string | null | undefined,
): CurrentManager | null {
  const slug = pin || (sessionId ? sessionManager(sessionId) : null)
  if (!slug) return null
  const label = labelOf(slug)
  return label ? { slug, ...label } : null
}
