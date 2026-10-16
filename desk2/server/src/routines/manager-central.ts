// The manager's central store (routines/central.ts says what a central routine is). <desk home>/routines-store.json names
// the store; without it nothing here runs. A copy of each routine document is kept in <desk home>/routines/central/, so
// the routines run from it while the store cannot be reached; it is read again from the store at most every 5 minutes
// (at once when the page asks for a fresh look), and a look turns it into entries and proposals beside the local files.
// The owner's approve, discard and edit, and any caller's central propose, write the store first and then the copy. The
// run board under the same repo key (claims and the run log) is routines/manager-board.ts's.

import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { RoutineProposal, RoutineProposalRequest, RoutineStoreStatus } from '@shared/routines'
import { renameOver, writeFlushed } from '../write-flushed'
import {
  approvedText,
  approverKey,
  checkApproval,
  definitionOf,
  definitionOn,
  DOC_FOLDER,
  FORMAT,
  parseDoc,
  parseStoreConfig,
  placementOf,
  renderDoc,
  type ApproverKey,
  type RoutineDoc,
  type Runner,
  type StoreConfig,
  type TrustedKey,
} from './central'
import { ROUTINE_ID, type CentralMark, type Entry } from './manifest'
import { message } from './proc'
import type { RunEvent } from './runs'
import { crainiumRunBoard, crainiumStore, RUNS_TOOL, StoreError, type RoutineStore, type RunBoard } from './store-crainium'

export const STORE_FILE = 'routines-store.json'
export const KEY_FILE = 'routines-approver.key'
/** The store is read again at most this often, unless the page asks for a fresh look. */
export const CENTRAL_EVERY_MS = 5 * 60_000

interface CachedDoc {
  path: string
  docSha: string
  text: string
}

export interface Central {
  config: StoreConfig
  runner: Runner
  trusted: TrustedKey[]
  key: ApproverKey
  store: RoutineStore
  cacheDir: string
  /** This computer's copy of each routine document, by id. */
  docs: Map<string, CachedDoc>
  readAt: number | null
  error: string | null
  lastTry: number | null
  refreshing: Promise<boolean> | null
  /** How many writes this computer made to the store: a read that saw one start under it is not kept. */
  writes: number
  problems: { id: string; reason: string }[]
  /** The run board (routines/manager-board.ts): claims and the run log, under the store's repo key. */
  board: RunBoard
  /** The run log's newest run of each routine, as its events, from the board's last answer. */
  boardEvents: unknown[]
  /** The run events this computer reported that the board's last answer did not hold yet, by id. */
  ownEvents: Map<string, RunEvent>
  /** Those the board has not taken yet: sent again before the next read. */
  unsent: Map<string, RunEvent>
  /** An ended event that waits for its run's description, by `<id>@<startedAt>`. */
  describing: Map<string, RunEvent>
  runsReadAt: number | null
  runsError: string | null
  runsLastTry: number | null
  runsReading: Promise<void> | null
}

/** One call of one of the person's Connections tools. */
export type ConnectionsCall = (tool: string, params: Record<string, unknown>) => Promise<string>

/** The central store routines-store.json names, ready to read: null when there is none, or why the file does not check out. */
export function openCentral(home: string, call: ConnectionsCall, platform: NodeJS.Platform): { central: Central | null; error: string | null } {
  let raw: string
  try {
    raw = readFileSync(join(home, STORE_FILE), 'utf8')
  } catch {
    return { central: null, error: null }
  }
  let config: StoreConfig
  try {
    config = parseStoreConfig(raw, platform)
  } catch (err) {
    return { central: null, error: `${STORE_FILE} does not check out: ${message(err)}` }
  }
  const key = approverKey(join(home, KEY_FILE))
  const runner: Runner = { id: config.runner, labels: config.labels, zone: Intl.DateTimeFormat().resolvedOptions().timeZone, home: homedir().replace(/\\/g, '/'), repos: config.repos }
  const cacheDir = join(home, 'routines', 'central')
  const central: Central = {
    config,
    runner,
    trusted: [{ name: config.approverName, key: key.public }, ...config.approvers],
    key,
    store: crainiumStore((params) => call('docs', params), config.repo),
    cacheDir,
    docs: loadCopies(cacheDir),
    readAt: null,
    error: null,
    lastTry: null,
    refreshing: null,
    writes: 0,
    problems: [],
    board: crainiumRunBoard((params) => call(RUNS_TOOL, params), config.repo),
    boardEvents: [],
    ownEvents: new Map(),
    unsent: new Map(),
    describing: new Map(),
    runsReadAt: null,
    runsError: null,
    runsLastTry: null,
    runsReading: null,
  }
  central.readAt = readAtOf(cacheDir)
  return { central, error: null }
}

const indexFile = (dir: string): string => join(dir, 'index.json')

function readAtOf(dir: string): number | null {
  try {
    const at = (JSON.parse(readFileSync(indexFile(dir), 'utf8')) as { readAt?: unknown }).readAt
    return typeof at === 'number' ? at : null
  } catch {
    return null
  }
}

/** The copies on this computer: index.json names each document's path and sha, <id>.md holds its text. */
function loadCopies(dir: string): Map<string, CachedDoc> {
  const docs = new Map<string, CachedDoc>()
  let index: Record<string, { path?: unknown; docSha?: unknown }> = {}
  try {
    index = (JSON.parse(readFileSync(indexFile(dir), 'utf8')) as { docs?: typeof index }).docs ?? {}
  } catch {
    return docs
  }
  for (const [id, d] of Object.entries(index)) {
    if (!ROUTINE_ID.test(id) || typeof d?.path !== 'string' || typeof d.docSha !== 'string') continue
    try {
      docs.set(id, { path: d.path, docSha: d.docSha, text: readFileSync(join(dir, `${id}.md`), 'utf8') })
    } catch {
      // A copy whose text is gone is read again from the store.
    }
  }
  return docs
}

const writeText = (file: string, text: string): void => {
  const tmp = `${file}.${process.pid}.tmp`
  writeFlushed(tmp, text)
  renameOver(tmp, file)
}

/** Writes the copies and their index; a copy no longer held is removed. Best effort: a failed write is read again later. */
function saveCopies(c: Central): void {
  try {
    mkdirSync(c.cacheDir, { recursive: true })
    for (const [id, d] of c.docs) writeText(join(c.cacheDir, `${id}.md`), d.text)
    writeText(indexFile(c.cacheDir), `${JSON.stringify({ readAt: c.readAt, docs: Object.fromEntries([...c.docs].map(([id, d]) => [id, { path: d.path, docSha: d.docSha }])) }, null, 2)}\n`)
    for (const f of readdirSync(c.cacheDir)) if (f.endsWith('.md') && !c.docs.has(f.slice(0, -3))) rmSync(join(c.cacheDir, f), { force: true })
  } catch (err) {
    console.error('[routines] the central copies did not save:', message(err))
  }
}

/** The routine id of a document path routines/<id>.md, or null for any other path. */
const idOfPath = (path: string): string | null => {
  const id = path.startsWith(DOC_FOLDER) && path.endsWith('.md') ? path.slice(DOC_FOLDER.length, -'.md'.length) : ''
  return ROUTINE_ID.test(id) ? id : null
}

/** Reads the store into the copies, at most every CENTRAL_EVERY_MS unless forced; one read at a time. True when a document
 *  changed, came or went. A store that does not answer leaves the copies as they were, with its reason. */
export function refreshCentral(c: Central, force: boolean, now: number): Promise<boolean> {
  if (c.refreshing) return c.refreshing
  if (!force && c.lastTry !== null && now - c.lastTry < CENTRAL_EVERY_MS) return Promise.resolve(false)
  c.lastTry = now
  const writes = c.writes
  c.refreshing = (async () => {
    try {
      const next = new Map<string, CachedDoc>()
      for (const d of await c.store.list()) {
        const id = idOfPath(d.path)
        if (!id) continue
        const held = c.docs.get(id)
        if (held?.docSha === d.sha) next.set(id, held)
        else {
          const got = await c.store.get(d.path)
          next.set(id, { path: d.path, docSha: got.sha, text: got.text })
        }
      }
      // A write of this computer's while the store was read: what was read may be older than it, so the next look reads again.
      if (c.writes !== writes) {
        c.lastTry = null
        return true
      }
      const changed = next.size !== c.docs.size || [...next].some(([id, d]) => c.docs.get(id)?.docSha !== d.docSha)
      c.docs = next
      c.readAt = now
      c.error = null
      saveCopies(c)
      return changed
    } catch (err) {
      c.error = `the store did not answer: ${message(err)}`
      return false
    }
  })().finally(() => (c.refreshing = null))
  return c.refreshing
}

/** The proposal a document is, to show: its routine, why, and that it is central. */
function proposalOf(doc: RoutineDoc, why: string): RoutineProposal {
  return { ...definitionOf(doc), why, source: 'central', runsOn: doc.runsOn }
}

/** The copies as a look reads them: each approved routine as an entry (run here when pinned here or shared with this runner,
 *  else listed as elsewhere), each other document as a proposal. A document that is not a routine, or has the id of one of
 *  this computer's routine or proposal files (`localIds`: the file is the one listed and run), goes to `problems`, never
 *  listed. Only a schedule routine is shared: a status or Windows-task one has no slot to claim, so it is pinned or broken. */
export function centralEntries(c: Central, localIds: Set<string>): { entries: Entry[]; proposals: RoutineProposal[] } {
  const entries: Entry[] = []
  const proposals: RoutineProposal[] = []
  c.problems = []
  for (const [id, cached] of [...c.docs].sort(([a], [b]) => a.localeCompare(b))) {
    if (localIds.has(id)) {
      c.problems.push({ id, reason: `a file on this computer (routines/${id}.json or a proposal) has the same id, and the file is the one listed here` })
      continue
    }
    let doc: RoutineDoc
    try {
      doc = parseDoc(id, cached.text)
    } catch (err) {
      c.problems.push({ id, reason: message(err) })
      continue
    }
    const approval = checkApproval(doc, c.trusted)
    if (!approval.ok) {
      proposals.push(proposalOf(doc, doc.why ?? `Not approved yet: ${approval.why}.`))
      continue
    }
    const zone = typeof doc.front.timeZone === 'string' ? { timeZone: doc.front.timeZone } : {}
    const central: CentralMark = { path: cached.path, docSha: cached.docSha, runsOn: doc.runsOn, ...placementOf(doc.runsOn, c.runner), ...zone }
    try {
      if (central.placement === 'shared' && doc.front.schedule === undefined)
        throw new Error(`it runs on any runner labelled ${doc.runsOn.join(', ')}, and only a schedule routine is shared between runners: name the runner it runs on in its runsOn`)
      entries.push({ id, def: central.placement === 'elsewhere' ? definitionOf(doc) : definitionOn(doc, c.runner), broken: null, central })
    } catch (err) {
      entries.push({ id, def: null, broken: message(err), name: doc.name, central })
    }
  }
  return { entries, proposals }
}

/** GET /api/routines `store`. */
export function storeStatus(c: Central | null, error: string | null): RoutineStoreStatus | null {
  if (c)
    return {
      repo: c.config.repo,
      runner: c.runner.id,
      labels: c.runner.labels,
      approverKey: c.key.public,
      readAt: c.readAt,
      error: c.error,
      problems: c.problems,
      runsReadAt: c.runsReadAt,
      runsError: c.runsError,
    }
  return error ? { repo: '', runner: '', labels: [], approverKey: '', readAt: null, error, problems: [], runsReadAt: null, runsError: null } : null
}

/** A refused central action: its HTTP status and reason. */
export interface Refusal {
  status: 400 | 404 | 409 | 502
  error: string
}

/** A store refusal as the page reads it: a document that moved on since this computer read it is a 409. */
function storeRefusal(err: unknown, path: string): Refusal {
  if (err instanceof StoreError && err.code === 'docs_changed')
    return { status: 409, error: `${path} changed in the store since this computer read it: look again, then decide` }
  return { status: 502, error: `the store did not take it: ${message(err)}` }
}

/** Writes a document to the store and the copy. Null when it landed, else the refusal. */
async function write(c: Central, id: string, path: string, text: string, baseSha: string | null): Promise<Refusal | null> {
  let sha: string
  try {
    sha = await c.store.put(path, text, baseSha)
  } catch (err) {
    return storeRefusal(err, path)
  }
  c.writes++
  c.docs.set(id, { path, docSha: sha, text })
  saveCopies(c)
  return null
}

const nowIso = (ms: number): string => new Date(ms).toISOString()

/** A central proposal's document, refused when it does not check out; then written to the store as a new document. */
export async function proposeCentral(c: Central, raw: RoutineProposalRequest, localIds: Set<string>): Promise<Refusal | null> {
  const { id, name, why, prompt, store: _store, ...rest } = raw as RoutineProposalRequest & Record<string, unknown>
  if (typeof id !== 'string' || !ROUTINE_ID.test(id)) return { status: 400, error: 'the proposal is refused: its id is 1 to 40 of a-z, 0-9 and -, starting with a letter or digit' }
  if ('approval' in rest) return { status: 400, error: 'the proposal is refused: a proposal carries no approval; only the owner approves' }
  const front: Record<string, unknown> = { kind: 'routine', format: FORMAT, title: name, ...rest, why, runsOn: rest.runsOn ?? [c.runner.id] }
  if (front.schedule !== undefined && front.timeZone === undefined) front.timeZone = c.runner.zone
  let doc: RoutineDoc
  try {
    doc = parseDoc(id, renderDoc(front, typeof prompt === 'string' ? prompt : ''))
    if (!doc.why) throw new Error('"why" must be a non-empty string')
  } catch (err) {
    return { status: 400, error: `the proposal is refused: ${message(err)}` }
  }
  if (c.docs.has(id) || localIds.has(id)) return { status: 409, error: `"${id}" already exists as a routine or a proposal` }
  const refused = await write(c, id, `${DOC_FOLDER}${id}.md`, renderDoc(doc.front, doc.body), null)
  return refused?.status === 409 ? { status: 409, error: `"${id}" already exists in the store` } : refused
}

/** The copy of a central document and the routine in it; a refusal when there is none, or it no longer checks out. */
function docFor(c: Central, id: string, missing: string): { cached: CachedDoc; doc: RoutineDoc } | Refusal {
  const cached = c.docs.get(id)
  if (!cached) return { status: 404, error: missing }
  try {
    return { cached, doc: parseDoc(id, cached.text) }
  } catch (err) {
    return { status: 409, error: `${cached.path} does not check out: ${message(err)}` }
  }
}

/** The owner's yes to a central proposal: this computer's key signs what it holds now, and the store gets it back. */
export async function approveCentral(c: Central, id: string, localIds: Set<string>, now: number): Promise<Refusal | null> {
  const found = docFor(c, id, `no proposal "${id}" is waiting`)
  if ('status' in found) return found
  if (localIds.has(id)) return { status: 409, error: `a routine "${id}" already exists on this computer` }
  if (checkApproval(found.doc, c.trusted).ok) return { status: 409, error: `"${id}" is approved already` }
  return write(c, id, found.cached.path, approvedText(found.doc, c.key, c.config.approverName, nowIso(now)), found.cached.docSha)
}

/** The owner's no to a central proposal: its document leaves the store's list (the store keeps its versions). */
export async function discardCentral(c: Central, id: string, now: number): Promise<Refusal | null> {
  const found = docFor(c, id, `no proposal "${id}" is waiting`)
  if ('status' in found) return found
  if (checkApproval(found.doc, c.trusted).ok) return { status: 409, error: `"${id}" is an approved routine, not a proposal` }
  try {
    await c.store.retire(found.cached.path, `discarded by ${c.config.approverName} in Settings > Managers > Routines, ${nowIso(now)}`)
  } catch (err) {
    return storeRefusal(err, found.cached.path)
  }
  c.writes++
  c.docs.delete(id)
  saveCopies(c)
  return null
}

/** The owner's edit of a central routine: the keys `set` names (its name is the title, its prompt the body; a cwd set by
 *  hand replaces a workdir; null removes one), checked, signed by this computer's key as the owner's, and written back. */
export async function editCentral(c: Central, id: string, set: Record<string, unknown>, now: number): Promise<Refusal | null> {
  const found = docFor(c, id, `no routine "${id}" is registered here or in the store`)
  if ('status' in found) return found
  const front = { ...found.doc.front }
  let body = found.doc.body
  for (const [key, value] of Object.entries(set)) {
    if (key === 'prompt') {
      body = typeof value === 'string' ? value : ''
      continue
    }
    if (key === 'cwd') delete front.workdir
    const k = key === 'name' ? 'title' : key
    if (value === null) delete front[k]
    else front[k] = value
  }
  let next: RoutineDoc
  try {
    next = parseDoc(id, renderDoc(front, body))
  } catch (err) {
    return { status: 409, error: `"${id}" was not saved: ${message(err)}` }
  }
  return write(c, id, found.cached.path, approvedText(next, c.key, c.config.approverName, nowIso(now)), found.cached.docSha)
}
