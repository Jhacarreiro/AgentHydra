// The people store as the app uses it: which home the person chose (This PC or CrAInium), the working copy on this PC,
// the CrAInium door, sync (on start, debounced after a change, or on demand) and the status Settings shows.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createCrainiumHome, type DoorStatus, doorStatus, findDoor } from './crainium-home'
import { backupDir, type SyncResult, syncPeople } from './sync'
import { agentHydraDir, createThisPcHome } from './this-pc'
import {
  type HomeKind,
  type Learning,
  type PeopleHome,
  type PersonRecord,
  type PersonSummary,
  parseId,
} from './types'

export interface PeopleConfig {
  home: HomeKind
  lastSync: SyncResult | null
}

export interface PeopleStatus {
  home: HomeKind
  /** Whether the CrAInium door is here and answering; `reason` says why not, in plain words. */
  crainium: DoorStatus
  syncing: boolean
  lastSyncAt: string | null
  /** Plain words, or null when the last sync was fine. */
  error: string | null
}

export interface PeopleServiceOptions {
  home?: string
  /** The door's argv. Default: found from the settings file or the private checkout; null means no door. */
  door?: string[] | null
  doorTimeoutMs?: number
  /** Rebuilds the Hydra Core catalog after a pull. Default runs hydra-core/catalog/build.mjs. */
  rebuild?: () => Promise<void>
  debounceMs?: number
}

const STATUS_CACHE_MS = 15_000
const NO_DOOR = 'CrAInium is not set up on this PC. This PC keeps your people.'

const REPO_BUILD = resolve(import.meta.dir, '../../../hydra-core/catalog/build.mjs')

export function rebuildCatalog(): Promise<void> {
  return new Promise((done, fail) => {
    const p = spawn('node', [REPO_BUILD], { stdio: 'ignore', windowsHide: true })
    p.on('error', fail)
    p.on('exit', (code) => (code === 0 ? done() : fail(new Error(`build exited ${code}`))))
  })
}

export function createPeopleService(opts: PeopleServiceOptions = {}) {
  const configFile = join(agentHydraDir(opts.home), 'people-store.json')
  const local = createThisPcHome({ home: opts.home })
  const readConfig = (): PeopleConfig => {
    try {
      const c = JSON.parse(readFileSync(configFile, 'utf8')) as Partial<PeopleConfig>
      return {
        // a saved 'connections' home (retired) reads as This PC
        home: c.home === 'crainium' ? 'crainium' : 'pc',
        lastSync: c.lastSync ?? null,
      }
    } catch {
      // floor-ok: no config yet means the default home, This PC
      return { home: 'pc', lastSync: null }
    }
  }
  const writeConfig = (c: PeopleConfig): void => {
    mkdirSync(agentHydraDir(opts.home), { recursive: true })
    writeFileSync(configFile, `${JSON.stringify(c, null, 2)}\n`)
  }
  const door = (): string[] | null => (opts.door !== undefined ? opts.door : findDoor(opts))
  let syncing: Promise<SyncResult> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let cached: { at: number; status: DoorStatus } | null = null

  async function crainiumStatus(): Promise<DoorStatus> {
    if (cached && Date.now() - cached.at < STATUS_CACHE_MS) return cached.status
    const status = await doorStatus(door(), opts.doorTimeoutMs ?? 8000)
    cached = { at: Date.now(), status }
    return status
  }

  async function syncNow(): Promise<SyncResult> {
    if (syncing) return syncing
    const run = async (): Promise<SyncResult> => {
      const cfg = readConfig()
      const argv = door()
      let res: SyncResult
      if (cfg.home !== 'crainium')
        res = { at: new Date().toISOString(), pulled: 0, pushed: 0, backedUp: 0, error: null }
      else if (!argv)
        res = { at: new Date().toISOString(), pulled: 0, pushed: 0, backedUp: 0, error: NO_DOOR }
      else
        res = await syncPeople({
          local,
          remote: createCrainiumHome(argv, opts.doorTimeoutMs),
          backupDir: backupDir(opts.home),
          afterPull: opts.rebuild ?? rebuildCatalog,
        })
      if (cfg.home === 'crainium') writeConfig({ ...readConfig(), lastSync: res })
      return res
    }
    syncing = run().finally(() => {
      syncing = null
    })
    return syncing
  }

  /** A change to a person: push soon (debounced). Never throws; a failure lands in the status. */
  function changed(): void {
    if (readConfig().home !== 'crainium') return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => void syncNow(), opts.debounceMs ?? 3000)
    if (typeof timer === 'object' && 'unref' in timer) timer.unref()
  }

  return {
    local,
    syncNow,
    changed,
    config: readConfig,
    async status(): Promise<PeopleStatus> {
      const cfg = readConfig()
      return {
        home: cfg.home,
        crainium: await crainiumStatus(),
        syncing: syncing !== null,
        lastSyncAt: cfg.lastSync?.at ?? null,
        error: cfg.home === 'crainium' ? (cfg.lastSync?.error ?? null) : null,
      }
    },
    /** Choose where the people live. CrAInium without a door is refused in words; This PC always works. */
    async setHome(home: HomeKind): Promise<PeopleStatus> {
      if (home === 'crainium' && !door()) throw new Error(NO_DOOR)
      writeConfig({ ...readConfig(), home })
      if (home === 'crainium') void syncNow()
      return this.status()
    },
    /** Pull on start: quietly, and only when the person chose CrAInium. */
    async syncOnStart(): Promise<void> {
      if (readConfig().home !== 'crainium') return
      await syncNow()
    },
    list: (): Promise<PersonSummary[]> => local.list(),
    get: (id: string): Promise<PersonRecord | null> => local.get(id),
    async put(record: PersonRecord): Promise<void> {
      if (!parseId(record.id)) throw new Error(`not a person id: ${record.id}`)
      await local.put({ ...record, updatedAt: new Date().toISOString() })
      changed()
    },
    async delete(id: string): Promise<void> {
      // Deleting a person here never reaches CrAInium: a pull would bring them back, which is the safe side.
      await local.delete(id)
    },
    async addLearning(id: string, text: string): Promise<Learning | null> {
      const r = await local.get(id)
      if (!r) return null
      const learning: Learning = {
        id: `l-${Date.now().toString(36)}`,
        text,
        at: new Date().toISOString(),
      }
      await local.put({ ...r, learnings: [...r.learnings, learning], updatedAt: learning.at })
      changed()
      return learning
    },
  }
}

export type PeopleService = ReturnType<typeof createPeopleService>

let shared: PeopleService | null = null
export const peopleService = (): PeopleService => (shared ??= createPeopleService())
export type { PeopleHome }
