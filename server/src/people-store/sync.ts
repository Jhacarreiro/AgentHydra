// Sync between This PC and a second home: newer wins per person, the losing copy goes to a backup folder, and a
// failure is reported, never thrown at the app and never a reason to delete a local file.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHydraDir } from './this-pc'
import type { PeopleHome, PersonRecord } from './types'

export interface SyncResult {
  at: string
  pulled: number
  pushed: number
  backedUp: number
  error: string | null
}

export const backupDir = (home?: string): string => join(agentHydraDir(home), 'people-backup')

function backUp(dir: string, side: 'pc' | 'crainium', r: PersonRecord): void {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const folder = join(dir, stamp)
  mkdirSync(folder, { recursive: true })
  writeFileSync(
    join(folder, `${side}--${r.id.replace('/', '--')}.json`),
    `${JSON.stringify(r, null, 2)}\n`,
  )
}

const time = (r: { updatedAt: string }): number => {
  const t = Date.parse(r.updatedAt)
  return Number.isNaN(t) ? 0 : t
}

export interface SyncOptions {
  local: PeopleHome
  remote: PeopleHome
  backupDir: string
  /** Called once after a pull changed local people (rebuilds the Hydra Core catalog). */
  afterPull?: () => Promise<void> | void
}

// The newer copy wins; the losing copy is backed up before it is overwritten.
async function resolveConflict(
  o: SyncOptions,
  a: PersonRecord,
  b: PersonRecord,
  res: SyncResult,
): Promise<void> {
  if (time(a) > time(b)) {
    backUp(o.backupDir, 'crainium', b)
    await o.remote.put(a)
    res.pushed++
  } else {
    backUp(o.backupDir, 'pc', a)
    await o.local.put(b)
    res.pulled++
  }
}

async function syncOne(o: SyncOptions, id: string, res: SyncResult): Promise<void> {
  const [a, b] = await Promise.all([o.local.get(id), o.remote.get(id)])
  if (a && !b) {
    await o.remote.put(a)
    res.pushed++
  } else if (b && !a) {
    await o.local.put(b)
    res.pulled++
  } else if (a && b && time(a) !== time(b)) {
    await resolveConflict(o, a, b, res)
    res.backedUp++
  }
}

async function rebuildCatalog(o: SyncOptions, res: SyncResult): Promise<void> {
  try {
    await o.afterPull?.()
  } catch (e) {
    res.error = `Pulled ${res.pulled}, but the catalog did not rebuild: ${e instanceof Error ? e.message : String(e)}`
  }
}

export async function syncPeople(o: SyncOptions): Promise<SyncResult> {
  const res: SyncResult = {
    at: new Date().toISOString(),
    pulled: 0,
    pushed: 0,
    backedUp: 0,
    error: null,
  }
  try {
    const [mine, theirs] = await Promise.all([o.local.list(), o.remote.list()])
    const ids = new Set([...mine.map((p) => p.id), ...theirs.map((p) => p.id)])
    for (const id of [...ids].sort()) {
      await syncOne(o, id, res)
    }
    if (res.pulled > 0) await rebuildCatalog(o, res)
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
  }
  return res
}
