// The people store as the app uses it: which home the person chose, the working copy on this PC, the LunarWerx people
// server home, sync (on start, on sign-in, debounced after a change, or on demand) and the status Settings shows.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { ConnectionsAccount } from './connections-signin'
import {
  createPeopleServerAdapter,
  NOT_CONFIGURED,
  type PeopleServerAdapter,
} from './people-server-home'
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
  /** False when AGENTHYDRA_API_URL is not set: the status says so and This PC keeps working. */
  configured: boolean
  signedIn: boolean
  account: ConnectionsAccount | null
  syncing: boolean
  lastSyncAt: string | null
  /** Plain words, or null when the last sync was fine. */
  error: string | null
  note: string | null
}

export type HomeAdapter = Omit<PeopleServerAdapter, 'home'> & { home(): PeopleHome }

export interface PeopleServiceOptions {
  home?: string
  adapter?: HomeAdapter
  /** Rebuilds the Hydra Core catalog after a pull. Default runs hydra-core/catalog/build.mjs. */
  rebuild?: () => Promise<void>
  debounceMs?: number
}

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
        home: c.home === 'connections' ? 'connections' : 'pc',
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
  const adapter = opts.adapter ?? createPeopleServerAdapter({ home: opts.home })
  let syncing: Promise<SyncResult> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null

  async function syncNow(): Promise<SyncResult> {
    if (syncing) return syncing
    const run = async (): Promise<SyncResult> => {
      const cfg = readConfig()
      const a = adapter
      let res: SyncResult
      if (cfg.home !== 'connections')
        res = { at: new Date().toISOString(), pulled: 0, pushed: 0, backedUp: 0, error: null }
      else if (!a.configured)
        res = {
          at: new Date().toISOString(),
          pulled: 0,
          pushed: 0,
          backedUp: 0,
          error: NOT_CONFIGURED,
        }
      else
        res = await syncPeople({
          local,
          remote: a.home(),
          backupDir: backupDir(opts.home),
          afterPull: opts.rebuild ?? rebuildCatalog,
        })
      if (cfg.home === 'connections') writeConfig({ ...readConfig(), lastSync: res })
      return res
    }
    syncing = run().finally(() => {
      syncing = null
    })
    return syncing
  }

  /** A change to a person: push soon (debounced). Never throws; a failure lands in the status. */
  function changed(): void {
    if (readConfig().home !== 'connections') return
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
      const a = adapter
      let account: ConnectionsAccount | null = null
      let signedIn = false
      let error = cfg.home === 'connections' ? (cfg.lastSync?.error ?? null) : null
      try {
        signedIn = await a.signedIn()
        account = signedIn ? await a.account() : null
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
      return {
        home: cfg.home,
        configured: a.configured,
        signedIn,
        account,
        syncing: syncing !== null,
        lastSyncAt: cfg.lastSync?.at ?? null,
        error,
        note: a.configured ? null : NOT_CONFIGURED,
      }
    },
    /** Choose where the people live. The people server without a URL is refused in words; This PC always works. */
    async setHome(home: HomeKind): Promise<PeopleStatus> {
      if (home === 'connections' && !adapter.configured) throw new Error(NOT_CONFIGURED)
      writeConfig({ ...readConfig(), home })
      if (home === 'connections' && (await adapter.signedIn().catch(() => false))) void syncNow()
      return this.status()
    },
    async signIn(): Promise<PeopleStatus> {
      await adapter.signIn()
      void syncNow()
      return this.status()
    },
    async signOut(): Promise<PeopleStatus> {
      await adapter.signOut()
      return this.status()
    },
    /** Pull on start: quietly, and only when the person chose Connections and is signed in. */
    async syncOnStart(): Promise<void> {
      if (readConfig().home !== 'connections') return
      if (await adapter.signedIn().catch(() => false)) await syncNow()
    },
    list: (): Promise<PersonSummary[]> => local.list(),
    get: (id: string): Promise<PersonRecord | null> => local.get(id),
    async put(record: PersonRecord): Promise<void> {
      if (!parseId(record.id)) throw new Error(`not a person id: ${record.id}`)
      await local.put({ ...record, updatedAt: new Date().toISOString() })
      changed()
    },
    async delete(id: string): Promise<void> {
      // Deleting a person here never reaches the people server: a pull would bring them back, which is the safe side.
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
