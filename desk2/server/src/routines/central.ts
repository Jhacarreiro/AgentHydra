// Central routines (shared/routines.ts, "CENTRAL ROUTINES"): a routine kept in a central store that every computer reading
// the store sees, instead of a file on one PC. Each is one document, routines/<id>.md: a JSON front matter (JSON is YAML,
// so a store that reads YAML front matter reads it too) holding the routine's keys, and the document's body as its prompt.
// A document runs only once a person approved it: its `approval` is an Ed25519 signature, by a key the runner trusts, over
// the routine's id and the sha of everything in it but the approval and its display line, so any change after the approval
// stops it until it is approved again. Pure but for the approver key's file: the store and the manager's use of it are in
// routines/store-crainium.ts and routines/manager-central.ts.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import type { RoutineDefinition } from '@shared/routines'
import { checkDefinition, ROUTINE_ID, type Placement } from './manifest'

export const FORMAT = 'routine/1'
/** The folder of a store that holds its routine documents. */
export const DOC_FOLDER = 'routines/'
const WHY_MAX = 500
/** A runsOn label: a runner's name or a label one carries. Lowercase letters, digits, '.', '_' and '-'. */
const LABEL = /^[a-z0-9][a-z0-9._-]{0,62}$/
/** A docs repo key, owner/name, as the CrAInium keys its documents. */
const REPO = /^[a-z0-9][\w.-]{0,99}\/[\w.-]{1,100}$/
const KEY = /^ed25519:[A-Za-z0-9_-]{43}$/

/** The local contract's keys a routine document's front matter carries (its name is `title`, its prompt the body). `group` and
 *  `campaigns` (shared/routines.ts, GROUP AND CAMPAIGNS) are contract keys too. Rollout order: a Desk older than this code
 *  refuses a document that carries either one ('unknown key'), so every runner gets this code before any document carries
 *  them (one runner today). */
const CONTRACT_KEYS = ['askedBy', 'schedule', 'status', 'windowsTask', 'run', 'cwd', 'timeoutMinutes', 'until', 'describe', 'modes', 'group', 'campaigns']
const CENTRAL_KEYS = ['kind', 'format', 'title', 'description', 'why', 'timeZone', 'workdir', 'runsOn', 'eachRunner', 'approval']
/** What an approval does not sign: the approval itself, the one-line description a store's page shows, and the group and
 *  campaigns a routine works for, so setting them leaves the routine approved and running. */
const UNSIGNED = ['approval', 'description', 'group', 'campaigns']

export interface Approval {
  by: string
  at: string
  key: string
  sha: string
  sig: string
}

/** A key a runner trusts approvals from, and whose it is. */
export interface TrustedKey {
  name: string
  key: string
}

/** The approver key of this computer: its private half, and its public half as an `ed25519:` string. */
export interface ApproverKey {
  private: KeyObject
  public: string
}

/** One routine document, checked as a document (whether this computer can run it is definitionOn's question). */
export interface RoutineDoc {
  id: string
  front: Record<string, unknown>
  body: string
  /** What an approval signs: sha256 of the canonical front matter (without approval and description) and body. */
  sha: string
  name: string
  runsOn: string[]
  /** Every runner carrying its labels runs it for itself, with no claim: work each computer does on its own data. */
  eachRunner: boolean
  why: string | null
  approval: Approval | null
}

/** This computer as a runner: its name, the labels it carries (its name and its system among them), its clock's time zone
 *  (a proposal's default), its home folder (for ~/), and where its checkouts of the repos a routine's workdir names are. */
export interface Runner {
  id: string
  labels: string[]
  zone: string
  home: string
  repos: Record<string, string>
}

/** <desk home>/routines-store.json: the store this computer reads routines from, and how it runs them. */
export interface StoreConfig {
  /** The CrAInium docs repo key the routine documents live under. */
  repo: string
  runner: string
  labels: string[]
  repos: Record<string, string>
  approvers: TrustedKey[]
  /** The name an approval made on this computer carries. */
  approverName: string
}

const nonEmpty = (v: unknown, key: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" must be a non-empty string`)
  return v.trim()
}

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

/** JSON with every object's keys sorted and nothing undefined: the same value always gives the same text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`
  if (isRecord(v))
    return `{${Object.keys(v)
      .filter((k) => v[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`)
      .join(',')}}`
  return JSON.stringify(v)
}

/** What an approval of this front matter and body signs. */
export function contentSha(front: Record<string, unknown>, body: string): string {
  const signed = Object.fromEntries(Object.entries(front).filter(([k]) => !UNSIGNED.includes(k)))
  return createHash('sha256').update(canonical({ front: signed, body })).digest('hex')
}

/** A document's text: its front matter as one JSON object between --- lines, then its body. */
export function renderDoc(front: Record<string, unknown>, body: string): string {
  return `---\n${JSON.stringify(front, null, 2)}\n---\n${body ? `\n${body}\n` : ''}`
}

/** A document's front matter and body (Windows line ends made plain, the body trimmed). Throws with the reason. */
export function splitDoc(text: string): { front: Record<string, unknown>; body: string } {
  const lf = text.replace(/\r\n/g, '\n')
  if (!lf.startsWith('---\n')) throw new Error('a routine document starts with its front matter between --- lines')
  const end = lf.indexOf('\n---', 3)
  if (end === -1) throw new Error('its front matter has no closing --- line')
  let front: unknown
  try {
    front = JSON.parse(lf.slice(4, end))
  } catch {
    throw new Error('its front matter is not one JSON object')
  }
  if (!isRecord(front)) throw new Error('its front matter is not one JSON object')
  const nl = lf.indexOf('\n', end + 1)
  return { front, body: nl === -1 ? '' : lf.slice(nl + 1).trim() }
}

function labelsOf(v: unknown): string[] {
  if (!Array.isArray(v) || !v.length || !v.every((l) => typeof l === 'string' && LABEL.test(l)))
    throw new Error('"runsOn" must be a list of runner labels (lowercase letters, digits, ".", "_" and "-"), naming the computer it runs on')
  return [...new Set(v as string[])]
}

/** A workdir: a repo key and a folder in that repo's checkout ("" for its root), never leaving it. */
export function workdirOf(v: unknown): { repo: string; path: string } {
  if (!isRecord(v) || typeof v.repo !== 'string' || !REPO.test(v.repo.toLowerCase()) || typeof v.path !== 'string')
    throw new Error('"workdir" must be { "repo": "owner/name", "path": "a folder in it" }')
  const path = v.path.replace(/\\/g, '/').replace(/^\.\/|\/+$/g, '')
  if (isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith('/') || path.split('/').includes('..'))
    throw new Error('"workdir" path is a folder inside the repo: relative, never ".."')
  return { repo: v.repo.toLowerCase(), path }
}

function zoneOf(v: unknown): string {
  if (typeof v !== 'string' || !v) throw new Error('"timeZone" must be an IANA time zone, e.g. "America/Chicago"')
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: v })
  } catch {
    throw new Error(`"timeZone" "${v}" is not a time zone this computer knows`)
  }
  return v
}

function approvalOf(v: unknown): Approval {
  if (!isRecord(v)) throw new Error('"approval" must be an object')
  const [by, at, key, sha, sig] = ['by', 'at', 'key', 'sha', 'sig'].map((k) => v[k])
  if (typeof by !== 'string' || typeof at !== 'string' || !Number.isFinite(Date.parse(at)) || typeof key !== 'string' || !KEY.test(key))
    throw new Error('"approval" must say by, at (an ISO time) and key (ed25519:...)')
  if (typeof sha !== 'string' || !/^[0-9a-f]{64}$/.test(sha) || typeof sig !== 'string' || !/^[A-Za-z0-9_-]{86}$/.test(sig))
    throw new Error('"approval" must carry the sha it signed and its signature')
  return { by, at, key, sha, sig }
}

/** Where a routine document says it runs, as text: its workdir, its cwd as written, or nothing. */
function placeText(front: Record<string, unknown>): string | undefined {
  if (front.workdir !== undefined) {
    const w = workdirOf(front.workdir)
    return w.path ? `${w.repo}: ${w.path}` : w.repo
  }
  return typeof front.cwd === 'string' ? front.cwd : undefined
}

/** The local contract's object for a document, with `cwd` as given (where it runs here, or only where it says). */
function contractOf(doc: Pick<RoutineDoc, 'front' | 'body' | 'name'>, cwd: string | undefined): Record<string, unknown> {
  const o: Record<string, unknown> = { name: doc.name }
  for (const k of CONTRACT_KEYS) if (k !== 'cwd' && doc.front[k] !== undefined) o[k] = doc.front[k]
  if (doc.front.run === undefined && doc.front.windowsTask === undefined) o.prompt = doc.body
  if (cwd !== undefined) o.cwd = cwd
  return o
}

/** A routine document's text, checked as a document: its own keys, and the local contract's checks of the routine in it,
 *  wherever it runs. Throws with the reason. */
export function parseDoc(id: string, text: string): RoutineDoc {
  if (!ROUTINE_ID.test(id)) throw new Error('the id is the document name: 1 to 40 of a-z, 0-9 and -, starting with a letter or digit')
  const { front, body } = splitDoc(text)
  for (const key of Object.keys(front)) if (!CONTRACT_KEYS.includes(key) && !CENTRAL_KEYS.includes(key)) throw new Error(`unknown key "${key}"`)
  if (front.kind !== 'routine') throw new Error('"kind" must be "routine"')
  if (front.format !== FORMAT) throw new Error(`"format" must be "${FORMAT}", the only one this AgentHydra reads`)
  const name = nonEmpty(front.title, 'title')
  const runsOn = labelsOf(front.runsOn)
  if (front.eachRunner !== undefined && typeof front.eachRunner !== 'boolean') throw new Error('"eachRunner" must be true or false')
  const eachRunner = front.eachRunner === true
  const why = front.why === undefined ? null : nonEmpty(front.why, 'why')
  if (why !== null && why.length > WHY_MAX) throw new Error(`"why" must be at most ${WHY_MAX} characters`)
  if (front.description !== undefined && typeof front.description !== 'string') throw new Error('"description" must be a string')
  if (front.schedule !== undefined && front.timeZone === undefined)
    throw new Error('a schedule routine names its "timeZone" (e.g. "America/Chicago"): computers in other zones read the same document')
  if (front.timeZone !== undefined) {
    if (front.schedule === undefined) throw new Error('"timeZone" is for a schedule routine')
    zoneOf(front.timeZone)
  }
  if (front.workdir !== undefined && front.cwd !== undefined) throw new Error('a routine has "workdir" (a folder in a repo) or "cwd" (a folder on its computer), not both')
  const approval = front.approval === undefined ? null : approvalOf(front.approval)
  checkDefinition(id, contractOf({ front, body, name }, placeText(front)))
  return { id, front, body, sha: contentSha(front, body), name, runsOn, eachRunner, why, approval }
}

/** A path with a leading ~/ in this runner's home folder, forward slashes. */
const homeOf = (s: string, home: string): string => (s === '~' ? home : s.startsWith('~/') ? join(home, s.slice(2)).replace(/\\/g, '/') : s)

/** The folder a document's routine runs in on this runner, or none. Throws when this runner cannot say where. */
function cwdOn(front: Record<string, unknown>, runner: Runner): string | undefined {
  if (front.workdir !== undefined) {
    const w = workdirOf(front.workdir)
    const root = runner.repos[w.repo]
    if (!root) throw new Error(`this computer has no checkout of ${w.repo}: name its folder under "repos" in routines-store.json`)
    return (w.path ? join(root, w.path) : root).replace(/\\/g, '/')
  }
  if (typeof front.cwd !== 'string') return undefined
  const cwd = homeOf(front.cwd, runner.home)
  if (!isAbsolute(cwd)) throw new Error(`"cwd" ${front.cwd} is not a full path on this computer (or one starting with ~/)`)
  return cwd
}

/** The routine a document defines, as this runner runs it: its folder found here and ~/ in its commands made this home (its
 *  schedule keeps the document's timeZone wherever it runs). Throws with the reason this runner cannot run it. */
export function definitionOn(doc: RoutineDoc, runner: Runner): RoutineDefinition {
  const def = checkDefinition(doc.id, contractOf(doc, cwdOn(doc.front, runner)))
  if (def.run) def.run = def.run.map((a) => homeOf(a, runner.home))
  if (def.status) def.status = def.status.map((a) => homeOf(a, runner.home))
  if (def.modes) def.modes = { ...def.modes, set: def.modes.set.map((a) => homeOf(a, runner.home)) }
  return def
}

/** The routine a document defines, to show: its folder as the document says it, not found on any computer. */
export function definitionOf(doc: RoutineDoc): RoutineDefinition {
  return checkDefinition(doc.id, contractOf(doc, placeText(doc.front)))
}

/** Where a routine whose runsOn is these labels runs, seen from this runner. It runs only on a runner that carries every label
 *  it names: `here` when one of them is this runner's name (pinned: no other runner runs it, so it needs no claim) or when
 *  it is an eachRunner routine (every such runner runs its own, so none claims), `shared` when neither (any runner carrying
 *  them may run it, one per slot by a claim on the run board), else `elsewhere`, with why. */
export function placementOf(runsOn: string[], runner: Runner, eachRunner = false): { placement: Placement; why: string | null } {
  if (!runsOn.every((l) => runner.labels.includes(l))) return { placement: 'elsewhere', why: `it runs on ${runsOn.join(', ')}, not on this computer` }
  return { placement: eachRunner || runsOn.includes(runner.id) ? 'here' : 'shared', why: null }
}

/** The part of `path` inside folder `root` ('' for the folder itself), forward slashes, or null when it is not inside. A
 *  root with a drive letter compares without case, as Windows does. */
function relativeIn(path: string, root: string): string | null {
  const plain = (s: string): string => s.replace(/\\/g, '/').replace(/\/+$/, '')
  const [p, r] = [plain(path), plain(root)]
  const fold = /^[A-Za-z]:/.test(r) ? (s: string): string => s.toLowerCase() : (s: string): string => s
  if (!r) return null
  if (fold(p) === fold(r)) return ''
  return fold(p).startsWith(`${fold(r)}/`) ? p.slice(r.length + 1) : null
}

/** A path in this runner's home as ~/ (the form every runner reads as its own home), else the path as it is. */
const tildeOf = (s: string, home: string): string => {
  const rel = relativeIn(s, home)
  return rel === null ? s : rel ? `~/${rel}` : '~'
}

/** Where a local routine's folder goes in its document: the workdir of the checkout "repos" names that holds it (the deepest
 *  one), else a ~/ cwd when it is in this runner's home. Throws when it is in neither: a document names no machine path. */
function placeOf(cwd: string, runner: Runner): { workdir: { repo: string; path: string } } | { cwd: string } {
  let best: { repo: string; path: string; depth: number } | null = null
  for (const [repo, root] of Object.entries(runner.repos)) {
    const path = relativeIn(cwd, root)
    if (path !== null && (!best || root.length > best.depth)) best = { repo, path, depth: root.length }
  }
  if (best) return { workdir: { repo: best.repo, path: best.path } }
  if (relativeIn(cwd, runner.home) !== null) return { cwd: tildeOf(cwd, runner.home) }
  throw new Error(`its folder ${cwd} is in no checkout routines-store.json's "repos" names: name the checkout that holds it there, then move it`)
}

/** The document a local routine becomes when the owner moves it to the store (Settings' Move to central): its keys as its file
 *  has them, its name as the title and its prompt as the body, pinned to this runner (runsOn its name) so it runs here as it
 *  did, a schedule in this computer's time zone, and no machine path: its folder as placeOf says, and a command argument in
 *  this runner's home as ~/. Throws when its folder cannot be named so. */
export function documentOf(def: RoutineDefinition, runner: Runner, why: string): { front: Record<string, unknown>; body: string } {
  const { id: _id, name, prompt, cwd, ...rest } = def
  const front: Record<string, unknown> = { kind: 'routine', format: FORMAT, title: name, ...rest, why, runsOn: [runner.id] }
  if (def.schedule !== undefined) front.timeZone = runner.zone
  if (cwd !== undefined) Object.assign(front, placeOf(cwd, runner))
  const tilde = (argv: string[]): string[] => argv.map((a) => tildeOf(a, runner.home))
  if (def.run) front.run = tilde(def.run)
  if (def.status) front.status = tilde(def.status)
  if (def.modes) front.modes = { ...def.modes, set: tilde(def.modes.set) }
  return { front, body: prompt ?? '' }
}

/** The bytes an approval signs. */
function approvalMessage(id: string, sha: string, at: string, by: string): Buffer {
  return Buffer.from(JSON.stringify([FORMAT, id, sha, at, by]), 'utf8')
}

function publicKeyOf(key: string): KeyObject | null {
  if (!KEY.test(key)) return null
  try {
    return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key.slice('ed25519:'.length) }, format: 'jwk' })
  } catch {
    return null
  }
}

/** Whether a document is approved by a key this runner trusts, for exactly what it holds now; else why not. */
export function checkApproval(doc: RoutineDoc, trusted: TrustedKey[]): { ok: true; by: string } | { ok: false; why: string } {
  const a = doc.approval
  if (!a) return { ok: false, why: 'nobody has approved it yet' }
  if (a.sha !== doc.sha) return { ok: false, why: 'it changed after it was approved' }
  if (!trusted.some((t) => t.key === a.key)) return { ok: false, why: `it was approved by ${a.by} with a key this computer does not trust` }
  const pub = publicKeyOf(a.key)
  if (!pub || !verify(null, approvalMessage(doc.id, doc.sha, a.at, a.by), pub, Buffer.from(a.sig, 'base64url')))
    return { ok: false, why: 'its approval signature does not check out' }
  return { ok: true, by: a.by }
}

/** A document's text approved by this computer's key, for what it holds now. */
export function approvedText(doc: RoutineDoc, key: ApproverKey, by: string, at: string): string {
  const sig = sign(null, approvalMessage(doc.id, doc.sha, at, by), key.private).toString('base64url')
  return renderDoc({ ...doc.front, approval: { by, at, key: key.public, sha: doc.sha, sig } }, doc.body)
}

/** This computer's approver key, from its file, made (owner-readable only) the first time it is asked for. */
export function approverKey(file: string): ApproverKey {
  let pem: string
  try {
    pem = readFileSync(file, 'utf8')
  } catch {
    const made = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    mkdirSync(dirname(file), { recursive: true })
    try {
      writeFileSync(file, made, { mode: 0o600, flag: 'wx' })
      pem = made
    } catch {
      pem = readFileSync(file, 'utf8') // another Desk made it first
    }
  }
  const priv = createPrivateKey(pem)
  const x = (createPublicKey(priv).export({ format: 'jwk' }) as { x: string }).x
  return { private: priv, public: `ed25519:${x}` }
}

/** This system's runner label. */
export function systemLabel(platform: NodeJS.Platform): string {
  return platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform
}

/** A computer name as a runner label: lowercase, anything else made '-'. */
export function runnerName(name: string = hostname()): string {
  const label = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 63)
  return label || 'this-computer'
}

/** routines-store.json's text, checked. Throws with the reason. */
export function parseStoreConfig(raw: string, platform: NodeJS.Platform): StoreConfig {
  let o: unknown
  try {
    o = JSON.parse(raw)
  } catch {
    throw new Error('it is not JSON')
  }
  if (!isRecord(o)) throw new Error('it must hold one JSON object')
  const store = o.store
  if (!isRecord(store) || store.kind !== 'crainium' || typeof store.repo !== 'string' || !REPO.test(store.repo.toLowerCase()))
    throw new Error('"store" must be { "kind": "crainium", "repo": "owner/name" }, the CrAInium docs repo the routines live under')
  const runner = o.runner === undefined ? runnerName() : String(o.runner)
  if (!LABEL.test(runner)) throw new Error('"runner" must be a label: lowercase letters, digits, ".", "_" and "-"')
  const labels = o.labels === undefined ? [] : o.labels
  if (!Array.isArray(labels) || !labels.every((l) => typeof l === 'string' && LABEL.test(l))) throw new Error('"labels" must be a list of labels')
  const repos: Record<string, string> = {}
  if (o.repos !== undefined) {
    if (!isRecord(o.repos)) throw new Error('"repos" must map "owner/name" to the folder of its checkout on this computer')
    for (const [k, v] of Object.entries(o.repos)) {
      if (!REPO.test(k.toLowerCase()) || typeof v !== 'string' || !isAbsolute(v)) throw new Error(`"repos" entry "${k}" must map owner/name to a full folder path`)
      repos[k.toLowerCase()] = v.replace(/\\/g, '/')
    }
  }
  const approvers = o.approvers === undefined ? [] : o.approvers
  if (!Array.isArray(approvers) || !approvers.every((a) => isRecord(a) && typeof a.name === 'string' && typeof a.key === 'string' && KEY.test(a.key)))
    throw new Error('"approvers" must be a list of { "name", "key": "ed25519:..." }')
  const approverName = o.approverName === undefined ? `the owner of ${runner}` : nonEmpty(o.approverName, 'approverName')
  return {
    repo: store.repo.toLowerCase(),
    runner,
    labels: [...new Set([runner, systemLabel(platform), ...(labels as string[])])],
    repos,
    approvers: (approvers as TrustedKey[]).map((a) => ({ name: a.name, key: a.key })),
    approverName,
  }
}
