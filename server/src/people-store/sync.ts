// Sync between This PC and a second home: newer wins per person, the losing copy goes to a backup folder, and a
// failure is reported, never thrown at the app and never a reason to delete a local file.
//
// A person's time here is its files' newest mtime, which a git checkout, a copy or a restore moves without changing
// a word. So each sync keeps what every person synced as (a hash of the content, never the text): a copy here
// that still is that content is unchanged here, and never outranks the other home's, whatever its time says.
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
  /** Where what each person last synced as is kept (id to content hash; see the header). Left out: none is, and
   *  the newer time always wins. */
  baseFile?: string
}

const canonical = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === 'object'
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
        )
      : v

/** A record's content, whatever its time, its keys' order or its files' order. */
function contentHash(r: PersonRecord): string {
  const files = [...(r.files ?? [])].sort((x, y) => x.path.localeCompare(y.path))
  const content = { persona: r.persona, brief: r.brief, learnings: r.learnings, files }
  return createHash('sha256')
    .update(JSON.stringify(canonical(content)))
    .digest('hex')
}

function readBase(file: string | undefined): Map<string, string> {
  if (!file) return new Map()
  try {
    const v = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    return new Map(Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch {
    // floor-ok: no base file yet means no person has synced with one
    return new Map()
  }
}

// The newer copy wins, but a copy here unchanged since the last sync never does: the other home's moved. The losing
// copy is backed up before it is overwritten. Returns the copy both homes now hold.
async function resolveConflict(
  o: SyncOptions,
  a: PersonRecord,
  b: PersonRecord,
  res: SyncResult,
  unchangedHere: boolean,
): Promise<PersonRecord> {
  if (!unchangedHere && time(a) > time(b)) {
    backUp(o.backupDir, 'crainium', b)
    await o.remote.put(a)
    res.pushed++
    return a
  }
  backUp(o.backupDir, 'pc', a)
  await o.local.put(b)
  res.pulled++
  return b
}

async function syncOne(
  o: SyncOptions,
  id: string,
  res: SyncResult,
  base: Map<string, string>,
): Promise<void> {
  const [a, b] = await Promise.all([o.local.get(id), o.remote.get(id)])
  if (a && !b) {
    await o.remote.put(a)
    res.pushed++
    base.set(id, contentHash(a))
  } else if (b && !a) {
    await o.local.put(b)
    res.pulled++
    base.set(id, contentHash(b))
  } else if (a && b && time(a) !== time(b)) {
    const held = await resolveConflict(o, a, b, res, base.get(id) === contentHash(a))
    res.backedUp++
    base.set(id, contentHash(held))
  } else if (a && b && contentHash(a) === contentHash(b)) base.set(id, contentHash(a))
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
  const base = readBase(o.baseFile)
  try {
    const [mine, theirs] = await Promise.all([o.local.list(), o.remote.list()])
    const ids = new Set([...mine.map((p) => p.id), ...theirs.map((p) => p.id)])
    for (const id of [...ids].sort()) {
      await syncOne(o, id, res, base)
    }
    if (res.pulled > 0) await rebuildCatalog(o, res)
  } catch (e) {
    res.error = e instanceof Error ? e.message : String(e)
  }
  if (o.baseFile) {
    try {
      writeFileSync(o.baseFile, `${JSON.stringify(Object.fromEntries(base), null, 2)}\n`)
    } catch (e) {
      res.error ??= `Synced, but what each person synced as was not saved: ${e instanceof Error ? e.message : String(e)}`
    }
  }
  return res
}
