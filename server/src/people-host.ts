// server/src/people-host.ts - AgentHydra's side of the people add-on. The add-on is the module people/agenthydra.mjs in the
// private sue-dredd checkout; it exports peopleAddon(host) and answers the seams below, each optional. The host gives it
// only AgentHydra's generic services. Nothing here knows a person. Where the add-on module is absent, every seam is
// inert, and the in-repo people code answers only while it still lives here (inRepoPeople).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hono } from 'hono'
import { loadAddon } from './addon-loader'
import type { Hook } from './climayte-signal'
import { APP_ROOT, CONFIG_DIR } from './config'
import { type DeskChat, deskChats, deskPost, replyWhenDone, transcriptItems } from './desk-client'
import type { ChatOfCaller } from './hydra-core/caller'
import { type CatalogEntry, loadCatalog, loadRef, loadText } from './hydra-core/catalog'
import {
  addPick,
  emptyDoc,
  leadLine,
  leadName,
  parseHydra,
  renderHydra,
} from './hydra-core/hydra-md'
import { appendLog } from './hydra-core/log'
import { chatPaths } from './hydra-core/paths'
import { addSeatChat } from './hydra-core/seat-chats'
import type { Daemon, UseArgs } from './hydra-core/use'
import { coreDir, coreModeOn } from './hydra-core-mode'
import { completionsApi, type HydraTool } from './mcp-client'
import { pickDeskChat } from './mcp-find'
import { type AddonOpts, peopleAddonPresent } from './people-addon'
import type { PeopleStatus } from './people-store/service'
import { agentHydraDir } from './people-store/this-pc'
import { priceTokens } from './pricing'
import { findSueDredd } from './sue-dredd-home'
import { findTranscript, findTranscriptAsync, isCommandWrapperText } from './transcript'
import { readTurnUsage } from './usage-tokens'

export const PEOPLE_ENTRY = join('people', 'agenthydra.mjs')
const PEOPLE_EXPORT = 'peopleAddon'
export const PEOPLE_CATALOG_FILE = 'generated-people.json'

export type PeopleOpts = AddonOpts & { coreDir?: string }

export interface PlacementInput {
  session: string
  deskChat: string | null
  lead?: string | null
  prev?: string | null
  source: string
  message: number
  cwd: string
  promptChars: number
}

export interface PeopleHost {
  agentHydraDir: string
  coreDir: string
  configDir: string
  desk: {
    chats: () => Promise<DeskChat[]>
    post: (path: string, body: unknown) => Promise<Record<string, unknown>>
    transcript: (chatId: string) => Promise<{ kind?: string; text?: string }[]>
    replyWhenDone: typeof replyWhenDone
    pick: (chats: DeskChat[], ref: string) => DeskChat
  }
  transcripts: {
    find: typeof findTranscript
    findAsync: typeof findTranscriptAsync
    isCommandWrapper: typeof isCommandWrapperText
  }
  pricing: { priceTokens: typeof priceTokens }
  usage: { readTurnUsage: typeof readTurnUsage }
  coreModeOn: typeof coreModeOn
  completions: typeof completionsApi
  onPlacement: (listener: (input: PlacementInput, now: Date) => void) => void
  verdicts: (worker: string) => unknown
  log: (line: string) => void
  currentCoreDir: () => string
  catalogBuilder: string
  catalog: { load: typeof loadCatalog }
  hydraMd: { parse: typeof parseHydra; leadName: typeof leadName }
  /** The core's chat files, log, seat-chat map and catalog text, for the add-on's persona modes. */
  core: {
    chatPaths: typeof chatPaths
    appendLog: typeof appendLog
    addSeatChat: typeof addSeatChat
    loadText: typeof loadText
    loadRef: typeof loadRef
    hydraMd: {
      render: typeof renderHydra
      empty: typeof emptyDoc
      addPick: typeof addPick
      leadLine: typeof leadLine
    }
  }
  peopleStore: () => Promise<PeopleStoreHandle>
  deskServices: () => DeskServices
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
  photo?: number | null
  photoUrl?: string | null
  statsLine?: string | null
  role?: 'lead' | 'seat'
  persona?: true
}

/** The Desk services the add-on's routes call; Desk registers them (registerDeskServices) before the add-on loads. */
export interface DeskServices {
  notOwnPage: (headers: Headers, what: string) => string | null
  writeFlushed: (path: string, data: string | Uint8Array) => void
  renameOver: (from: string, to: string) => void
  sniff: (bytes: Uint8Array) => string | null
  managerChanged: (slug: string) => void
}

export interface PeopleStoreHandle {
  syncOnStart: () => Promise<void>
  status: () => Promise<PeopleStatus>
  setHome: (home: 'pc' | 'crainium') => Promise<unknown>
  syncNow: () => Promise<unknown>
}

/** One persona-mode call core_use hands the add-on (the caller gates and the chat are already resolved). */
export interface UseModeAsk {
  dir: string
  mode: 'become' | 'consult' | 'hire'
  entry: CatalogEntry
  args: UseArgs
  /** The chat a seat opens under; null for become, and for a consult or hire from a non-Prime or untraced caller. */
  chat: ChatOfCaller | null
  daemon: Daemon
  now: Date
}

export interface SeatsAsk {
  dir: string
  chat: string
  entries: CatalogEntry[]
  files: { root: string; hydraMd: string }
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
  /** The manager's display name for a slug, or null when the slug is no manager. */
  managerName?: (slug: string) => string | null
  /** The answer to a persona mode (become, consult, hire), or null when the add-on does not answer it. */
  useMode?: (ask: UseModeAsk) => Promise<unknown | null>
  /** The handoff pack's lines about the chat's seats and consults, or null for none. */
  seatsLine?: (ask: SeatsAsk) => string | null
  /** Ends what start began (the daemon is going away). */
  stop?: () => void
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

let placementListeners: Array<(input: PlacementInput, now: Date) => void> = []

/** Tells the add-on's placement listeners about one routed message (the seam that places a chat calls this). */
export function reportPlacement(input: PlacementInput, now: Date): void {
  for (const listener of placementListeners) listener(input, now)
}

function hostFor(opts: PeopleOpts): PeopleHost {
  return {
    agentHydraDir: agentHydraDir(opts.home),
    coreDir: opts.coreDir ?? coreDir(),
    configDir: CONFIG_DIR,
    desk: {
      chats: deskChats,
      post: deskPost,
      transcript: transcriptItems,
      replyWhenDone,
      pick: pickDeskChat,
    },
    transcripts: {
      find: findTranscript,
      findAsync: findTranscriptAsync,
      isCommandWrapper: isCommandWrapperText,
    },
    pricing: { priceTokens },
    usage: { readTurnUsage },
    coreModeOn,
    completions: completionsApi,
    onPlacement: (listener) => {
      placementListeners.push(listener)
    },
    verdicts: (worker) => verdictsOf?.(worker),
    log: (line) => console.error(`[people] ${line}`),
    currentCoreDir: () => opts.coreDir ?? coreDir(),
    catalogBuilder: join(APP_ROOT, 'hydra-core', 'catalog', 'build.mjs'),
    catalog: { load: loadCatalog },
    hydraMd: { parse: parseHydra, leadName },
    core: {
      chatPaths,
      appendLog,
      addSeatChat,
      loadText,
      loadRef,
      hydraMd: { render: renderHydra, empty: emptyDoc, addPick, leadLine },
    },
    peopleStore: async () => (await import('./people-store/service')).peopleService(),
    deskServices: requireDeskServices,
  }
}

let deskServices: DeskServices | undefined

/** Desk registers the services its people routes call, before the add-on loads (Desk's plugin that loads the add-on). */
export function registerDeskServices(services: DeskServices): void {
  deskServices = services
}

function requireDeskServices(): DeskServices {
  if (!deskServices) throw new Error('the Desk services were not registered')
  return deskServices
}

function writeCatalog(dir: string, entries: CatalogEntry[]): void {
  mkdirSync(join(dir, 'catalog'), { recursive: true })
  writeFileSync(join(dir, 'catalog', PEOPLE_CATALOG_FILE), `${JSON.stringify(entries, null, 2)}\n`)
}

/** Loads the add-on for `opts` (uncached) and makes it the one the seams see. Its catalog entries are written to
 *  <core>/catalog/generated-people.json, and that file is removed when the module is absent. */
export async function loadPeopleAddon(opts: PeopleOpts = {}): Promise<PeopleAddon | null> {
  const host = hostFor(opts)
  placementListeners = []
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
  if (loaded) return Promise.resolve(loaded.addon)
  memo ??= loadPeopleAddon()
  return memo
}
