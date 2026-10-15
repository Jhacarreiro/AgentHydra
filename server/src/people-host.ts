// server/src/people-host.ts - AgentHydra's side of the people add-on. The add-on is the module people/agenthydra.mjs in the
// private sue-dredd checkout; it exports peopleAddon(host) and answers the seams below, each optional. The host gives it
// only AgentHydra's generic services. Nothing here knows a person. Where the add-on module is absent, every seam is
// inert, and the in-repo people code answers only while it still lives here (inRepoPeople).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { loadAddon } from './addon-loader'
import type { Hook } from './climayte-signal'
import { APP_ROOT } from './config'
import { type DeskChat, deskChats, deskPost, replyWhenDone, transcriptItems } from './desk-client'
import type { CatalogEntry } from './hydra-core/catalog'
import { coreDir } from './hydra-core-mode'
import type { HydraTool } from './mcp-client'
import { type AddonOpts, peopleAddonPresent } from './people-addon'
import { agentHydraDir } from './people-store/this-pc'
import { findSueDredd } from './sue-dredd-home'

export const PEOPLE_ENTRY = join('people', 'agenthydra.mjs')
const PEOPLE_EXPORT = 'peopleAddon'
export const PEOPLE_CATALOG_FILE = 'generated-people.json'

export type PeopleOpts = AddonOpts & { coreDir?: string }

export interface PeopleHost {
  agentHydraDir: string
  coreDir: string
  desk: {
    chats: () => Promise<DeskChat[]>
    post: (path: string, body: unknown) => Promise<Record<string, unknown>>
    transcript: (chatId: string) => Promise<{ kind?: string; text?: string }[]>
    replyWhenDone: typeof replyWhenDone
  }
  verdicts: (worker: string) => unknown
  log: (line: string) => void
}

export interface LeadAsk {
  message: string
  entries: CatalogEntry[]
  current: string | null
  budgetMs: number
}

export interface FaceChat {
  id: string
  managerSlug?: string | null
  sessionId?: string | null
  parentId?: string | null
}

export interface PersonaFace {
  slug: string
  name: string
  title?: string | null
  oneLiner?: string | null
  photoUrl?: string | null
  role?: 'lead' | 'seat'
}

export interface PeopleAddon {
  tools?: HydraTool[]
  start?: () => void
  /** The lead's slug, or null for none. */
  lead?: (ask: LeadAsk) => Promise<{ slug: string } | null>
  face?: (chat: FaceChat) => PersonaFace | null
  routes?: (app: Hono) => void
  catalogEntries?: () => CatalogEntry[]
  routerHooks?: (ownerDir: string) => Array<{ hooks: Hook[] }>
  chatNote?: () => string | null
}

let loaded: { opts: PeopleOpts; addon: PeopleAddon | null } | null = null
let memo: Promise<PeopleAddon | null> | undefined
let verdictsOf: ((worker: string) => unknown) | undefined

/** Where the add-on's verdicts come from (CliMayte workers), set by the server before the add-on starts. */
export function registerPeopleVerdicts(read: (worker: string) => unknown): void {
  verdictsOf = read
}

/** Whether the add-on module is on this PC (the presence the seams check; `opts` defaults to the last load's). */
export function peopleModulePresent(opts: PeopleOpts | undefined = loaded?.opts): boolean {
  return findSueDredd(PEOPLE_ENTRY, opts?.env ?? process.env, opts?.appRoot ?? APP_ROOT) !== null
}

/** The in-repo people code answers a seam the add-on does not answer, on a PC with the add-on (step 3 of the plan
 *  deletes each part as it moves into the add-on). */
export function inRepoPeople(opts: PeopleOpts | undefined = loaded?.opts): boolean {
  return peopleAddonPresent(opts)
}

/** The add-on as loaded by the last loadPeopleAddon, or null before a load and when the module is absent. */
export function peopleAddon(): PeopleAddon | null {
  return loaded?.addon ?? null
}

/** Forgets the last load, so the seams read this PC again (a test's cleanup, so its fake add-on stays its own). */
export function forgetPeopleAddon(): void {
  loaded = null
  memo = undefined
}

function hostFor(opts: PeopleOpts): PeopleHost {
  return {
    agentHydraDir: agentHydraDir(opts.home),
    coreDir: opts.coreDir ?? coreDir(),
    desk: {
      chats: deskChats,
      post: deskPost,
      transcript: transcriptItems,
      replyWhenDone,
    },
    verdicts: (worker) => verdictsOf?.(worker),
    log: (line) => console.error(`[people] ${line}`),
  }
}

function writeCatalog(dir: string, entries: CatalogEntry[]): void {
  mkdirSync(join(dir, 'catalog'), { recursive: true })
  writeFileSync(join(dir, 'catalog', PEOPLE_CATALOG_FILE), JSON.stringify(entries, null, 2) + '\n')
}

/** Loads the add-on for `opts` (uncached) and makes it the one the seams see. Its catalog entries are written to
 *  <core>/catalog/generated-people.json, and that file is removed when the module is absent. */
export async function loadPeopleAddon(opts: PeopleOpts = {}): Promise<PeopleAddon | null> {
  const host = hostFor(opts)
  const addon = peopleModulePresent(opts)
    ? await loadAddon<PeopleAddon>(PEOPLE_ENTRY, PEOPLE_EXPORT, host, opts)
    : null
  loaded = { opts, addon }
  const catalog = join(host.coreDir, 'catalog', PEOPLE_CATALOG_FILE)
  if (!addon?.catalogEntries) rmSync(catalog, { force: true })
  else writeCatalog(host.coreDir, addon.catalogEntries())
  return addon
}

/** The add-on for this PC, loaded once. */
export function getPeopleAddon(): Promise<PeopleAddon | null> {
  memo ??= loadPeopleAddon()
  return memo
}
