import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { contentWords } from '../mcp-find'
import { type CatalogEntry, ID as ID_SHAPE, loadCatalog, loadRef, loadText } from './catalog'
import { doubted, type Feedback, readFeedback, stale } from './feedback'
import { detailOf, rankEntries, terms } from './find'
import { leadName, parseHydra } from './hydra-md'
import {
  LAUNCH_BUDGET_MS,
  type LeadPick,
  leadNote,
  MESSAGE_BUDGET_MS,
  mayHaveMoved,
  pickLead,
  recordLead,
  setLateLead,
  substantive,
  takeLateLead,
  wordLead,
} from './lead'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { clearLeadOwed, readSent, setLeadOwed, writeSent } from './sent'
import { folderKnowledgeOf, mainRules } from './tree'

export const TOTAL_CAP = 9500
const INLINE_MATCHES = 3
const MATCH_MIN = 4
/** A match is pasted in full only this strong (a name hit or several); weaker ones go as one-line pointers. */
const INLINE_MIN = 20
/** What a slot or file chat gets per message from the hook: strong matches only, at most this many characters. */
export const MATCH_CAP = 2000
/** Per message: at most this many full texts, then at most MATCH_POINTERS one-line pointers. */
const MATCH_INLINE = 3
const MATCH_POINTERS = 3
/** A per-message match needs a word of the message in its name or title (or this score), two distinct content
 *  words of the message, and a message of at least MATCH_WORDS content words. */
const MATCH_STRONG = 10
const MATCH_WORDS = 3
/** What a match sent as a pointer also needs, since there a take (loading or picking it) is observable: one more
 *  than MATCH_MIN when it was rejected more often than taken, and for knowledge, a take within STALE_OFFERS offers.
 *  Text pasted in full (reading it is the use) and exempt entries (pinned rulings, folder rules) never are. */
function pointable(fb: Feedback | null, e: CatalogEntry, score: number): boolean {
  if (e.kind === 'knowledge' && stale(fb, e)) return false
  return !doubted(fb, e) || score >= MATCH_MIN + 1
}

const ALSO_MATCHING = 'Also matching (core_find { need, chat } loads any of them):'

/** The `<core>/ASK` setting: absent or anything but `off` means a slot or file chat picks its own lead through
 *  core_scope, so no model picks or shifts one (the owner's ruling 2026-10-15). */
export function asksOf(dir: string): boolean {
  const file = join(dir, 'ASK')
  return !existsSync(file) || readFileSync(file, 'utf8').trim() !== 'off'
}

export type PackMode = 'first' | 'full' | 'delta'

export interface PlacedRequest {
  chat: string
  session: string
  cwd: string
  prompt: string
  placement: 'slot' | 'file'
  /** The model's pick, made before the build by pickForMatch; absent, the build moves no lead and ranks by words. */
  pick?: LeadPick
}

export interface Placed {
  placement: string
  hash: string
  ids: string[]
  chars: number
  started: string[]
  /** The chat's lead (a catalog id, or null for none), kept from its first launch. */
  lead?: string | null
  /** The chat's first owner message, kept from its first launch: what its pack's matches are ranked on. */
  prompt?: string
}

export interface PackRequest {
  chat: string
  session: string
  cwd: string
  prompt: string
  full?: boolean
  /** The chat's lead, fixed: a catalog id, or null for none. Absent, the lead is ranked on the prompt (a hydra.md lead wins either way). */
  lead?: string | null
  /** A slot's cap (the system prompt): the lead's brief is placed before the folder rules fill it. Absent, TOTAL_CAP. */
  cap?: number
  /** Build the text only: no sent.json and no log line (the slot writes its own). */
  dry?: boolean
  /** How long the lead pick may wait for the model; absent, a dry build (a launch) waits LAUNCH_BUDGET_MS, any
   *  other pack MESSAGE_BUDGET_MS, since the hook is waiting for it. */
  leadMs?: number
  /** The model's pick, made before the build by pickForPack; absent, the word ranker picks. The build itself never
   *  waits on the network. */
  pick?: LeadPick
}

export interface Pack {
  mode: PackMode
  text: string
  ids: string[]
  /** The ids whose full text the pack pasted (folder rules, inline knowledge, the lead's brief): not offers. */
  pasted: string[]
  bytes: number
  ms: number
  /** The lead the pack used: its catalog id (a hydra.md lead missing from the catalog: person:<manager folder>), else null. */
  lead: string | null
  /** What the pack did to the lead brief the chat owes: set it (the id, sent as a pointer), clear it (null), or neither. */
  owed?: string | null
}

interface Sections {
  folder: string
  lead: string
  seats: string
  inline: string[]
  pointers: string[]
}

const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** An entry filed under folders, none of which holds the chat's folder, belongs to another project; one filed
 *  nowhere fits every folder. */
function foreignTo(cwd: string): (e: CatalogEntry) => boolean {
  const here = norm(cwd)
  return (e) => {
    const folders = e.folders ?? []
    return (
      folders.length > 0 &&
      !(here && folders.some((f) => here === norm(f) || here.startsWith(`${norm(f)}/`)))
    )
  }
}

/** The chat's seats and consults, as the people add-on lines them (nothing without it). Required on first use rather than
 *  imported: people-host brings the server core, which the Desk server's typecheck of this pack code does not take. */
function seatsLine(
  dir: string,
  chat: string,
  entries: CatalogEntry[],
  files: { root: string; hydraMd: string },
): string {
  const { peopleAddon } = require('../people-host') as typeof import('../people-host')
  return peopleAddon()?.seatsLine?.({ dir, chat, entries, files }) ?? ''
}

/** Lines a cut may list as left out, and the characters each may take. */
const CUT_HEADS = 6
const CUT_HEAD_CHARS = 60
/** How far before the last line end a heading may sit and still be the cut point, so a section is not split. */
const HEADING_SLACK = 1500
const HEADING = /^(?:#{1,3} |--- \S+ \(.*\) ---$)/
/**
 * The head of `body` that fits `room` with a note saying where it was cut and which headings it left out. The cut
 * falls on a heading when one is near, else on a line end, else on a space; only one unbroken run of text is cut
 * mid-word.
 */
function cutHead(body: string, room: number, where: string): { text: string; kept: number } {
  if (body.length <= room) return { text: body, kept: body.length }
  const lineCount = body.split('\n').length
  const note = (n: number) => {
    const line = body.slice(0, n).split('\n').length
    const heads = body
      .slice(n)
      .split('\n')
      .filter((l) => HEADING.test(l))
      .map((l) => (l.length > CUT_HEAD_CHARS ? `${l.slice(0, CUT_HEAD_CHARS - 3)}...` : l))
    const left = heads.length
      ? `; left out: ${heads.slice(0, CUT_HEADS).join(', ')}${heads.length > CUT_HEADS ? ` and ${heads.length - CUT_HEADS} more` : ''}`
      : ''
    return `\n[cut at line ${line} of ${lineCount} (${n} of ${body.length} characters)${left}; the rest is in ${where}]`
  }
  const fits = (n: number) => n + note(n).length <= room
  // Every note fits in this much, so only cut points inside the last stretch need trying.
  const most = room - note(0).length
  const floor = Math.max(0, Math.floor(most / 2))
  const points = (re: RegExp): number[] => {
    const out: number[] = []
    for (let m = re.exec(body); m && m.index <= room; m = re.exec(body))
      if (m.index >= floor) out.push(m.index)
    return out.reverse()
  }
  const best = (list: number[]) => list.find((n) => n > 0 && fits(n))
  const line = best(points(/\n/g))
  const heading =
    line === undefined
      ? undefined
      : best(points(/\n(?=#{1,3} |--- \S)/g).filter((n) => n <= line && line - n <= HEADING_SLACK))
  let kept = heading ?? line ?? best(points(/\s/g))
  if (kept === undefined) {
    kept = Math.max(0, room - note(room).length)
    if (/[\uD800-\uDBFF]/.test(body[kept - 1] ?? '')) kept--
    while (kept > 0 && !fits(kept)) kept--
  }
  if (kept <= 0) return { text: '', kept: 0 }
  return { text: body.slice(0, kept) + note(kept), kept }
}

function hydraLead(file: string): { name: string; path: string } | null {
  if (!existsSync(file)) return null
  const doc = parseHydra(readFileSync(file, 'utf8'))
  if (!doc?.lead) return null
  const path = /Full text: (.+)$/.exec(doc.lead)?.[1]?.trim() ?? ''
  return { name: leadName(doc), path }
}

function hydraLeadEntry(
  entries: CatalogEntry[],
  path: string,
  name: string,
): CatalogEntry | undefined {
  const people = entries.filter((e) => e.kind === 'person')
  return people.find((e) => loadRef(e) === path) ?? people.find((e) => e.name === name)
}

const MANAGER_BRIEF = /[\\/]managers[\\/]([a-z0-9][a-z0-9-]*)[\\/]brief\.md$/i

/**
 * A hydra.md lead's catalog id: its catalog entry's, else the person id its manager folder names (a manager's id is
 * person:<folder>, so a lead the catalog does not list still keeps its real id), else null.
 */
function hydraLeadId(
  entries: CatalogEntry[],
  hydra: { name: string; path: string },
): string | null {
  const known = hydraLeadEntry(entries, hydra.path, hydra.name)?.id
  if (known) return known
  const id = `person:${MANAGER_BRIEF.exec(hydra.path)?.[1]?.toLowerCase() ?? ''}`
  return ID_SHAPE.test(id) ? id : null
}

function leadFileText(path: string): string {
  if (!path) return ''
  if (!isAbsolute(path) || !existsSync(path)) return `(lead text not readable: ${path})`
  return readFileSync(path, 'utf8')
}

function entryBlock(e: CatalogEntry): string {
  return `--- ${e.id} (${loadRef(e)}) ---\n${loadText(e)}`
}

function matchParts(inline: string[], pointers: string[]): string[] {
  return [
    inline.length ? `Rulings and knowledge for this message:\n\n${inline.join('\n\n')}` : '',
    pointers.length ? `${ALSO_MATCHING}\n${pointers.join('\n')}` : '',
  ].filter(Boolean)
}

export function readPlaced(file: string): Placed | null {
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8')) as Partial<Placed>
    if (typeof data.placement !== 'string' || typeof data.hash !== 'string') return null
    return {
      placement: data.placement,
      hash: data.hash,
      ids: Array.isArray(data.ids) ? data.ids.filter((id) => typeof id === 'string') : [],
      chars: typeof data.chars === 'number' ? data.chars : 0,
      started: Array.isArray(data.started)
        ? data.started.filter((id) => typeof id === 'string')
        : [],
      ...(typeof data.lead === 'string' || data.lead === null ? { lead: data.lead } : {}),
      ...(typeof data.prompt === 'string' ? { prompt: data.prompt } : {}),
    }
  } catch {
    return null
  }
}

/**
 * What Agent Hydra attaches to a chat message: the folder's rules and the matching knowledge, the lead, and a
 * closing line the first time. The text stays within TOTAL_CAP so Claude Code does not save it to a file (a slot,
 * in the system prompt, passes its own cap and gets the lead brief before the folder rules fill it).
 * Later messages get only what this session has not been sent yet.
 */
/** The reader types the pack helpers take, so they stay in step with what the readers return. */
type CatalogMap = ReturnType<typeof loadCatalog>['entries']
type FeedbackRead = ReturnType<typeof readFeedback>
type HydraLead = NonNullable<ReturnType<typeof hydraLead>>
type ChatFiles = ReturnType<typeof chatPaths>
type SentMap = ReturnType<typeof readSent>

interface PackLead {
  id: string | null
  name: string
  text: string
  ref?: string
}

/** The matches a pack may use: knowledge strong enough to paste in full, and the rest as one-line pointers. */
function packMatches(
  entries: CatalogEntry[],
  prompt: string,
  feedback: FeedbackRead,
  keep: (e: CatalogEntry) => boolean,
) {
  const matches = rankEntries(entries, prompt, { feedback }).filter(
    (s) => s.score >= MATCH_MIN && s.entry.kind !== 'person' && keep(s.entry),
  )
  const inline = matches
    .filter((s) => s.entry.kind === 'knowledge' && s.score >= INLINE_MIN)
    .slice(0, INLINE_MATCHES)
    .map((s) => s.entry)
  const rest = matches.map((s) => s.entry).filter((e) => !inline.includes(e))
  const scoreOf = new Map(matches.map((s) => [s.entry.id, s.score]))
  return { inline, rest, scoreOf }
}

function entryLead(e: CatalogEntry): PackLead {
  return { id: e.id, name: e.name, text: loadText(e) }
}

/**
 * The lead a pack pastes or points to, and the id it is logged under. A hydra.md lead comes first; a fixed lead or the
 * model's pick (else the word ranker) follows, on a first or full pack only.
 */
function packLead(
  req: PackRequest,
  mode: PackMode,
  hydra: HydraLead | null,
  fixed: boolean,
  entries: CatalogEntry[],
  catalog: CatalogMap,
  feedback: FeedbackRead,
  fresh: (id: string) => boolean,
): { hydraId: string | null; lead: PackLead | null } {
  if (hydra) {
    // A hydra.md lead with no catalog id is pasted with a first or full pack and never logged under a made-up id.
    const hydraId = hydraLeadId(entries, hydra)
    const take = hydraId ? fresh(hydraId) : mode !== 'delta'
    const lead = take
      ? { id: hydraId, name: hydra.name, text: leadFileText(hydra.path), ref: hydra.path }
      : null
    return { hydraId, lead }
  }
  // A first pack takes the model's pick made before it (pickForPack); a later one keeps to the word ranker.
  const personaId = fixed
    ? undefined
    : mode !== 'delta' && req.pick
      ? (req.pick.id ?? undefined)
      : wordLead(entries, req.prompt, feedback)?.id
  const persona = personaId ? catalog.get(personaId) : undefined
  const chosen = fixed && req.lead ? catalog.get(req.lead) : undefined
  if (chosen && fresh(chosen.id)) return { hydraId: null, lead: entryLead(chosen) }
  if (persona && fresh(persona.id)) return { hydraId: null, lead: entryLead(persona) }
  return { hydraId: null, lead: null }
}

function leadPointerLine(chat: string, lead: PackLead): string {
  if (!lead.id) return `Lead for this message: ${lead.name}. Read the brief at ${lead.ref}.`
  return `Lead for this message: ${lead.name}. Load the brief with core_use { chat: "${chat}", id: "${lead.id}", mode: "become" }.`
}

function packFrame(mode: PackMode, chat: string, parts: string[]): string {
  if (mode === 'delta')
    return parts.length ? ['Hydra Core, new for this message:', ...parts].join('\n\n') : ''
  return [
    'Hydra Core attached for this chat and message:',
    ...parts,
    `More is one core_find { need: "<what you need>", chat: "${chat}" } away; no other manager call is needed.`,
  ].join('\n\n')
}

function sectionParts(s: Sections): string[] {
  return [s.folder, ...matchParts(s.inline, s.pointers), s.lead, s.seats].filter(Boolean)
}

/**
 * The folder rules that fit the cap beside the reserved lead text: the block (cut where the room ends) and the ids
 * the cut kept in full.
 */
function fitFolder(
  folder: CatalogEntry[],
  cwd: string,
  cap: number,
  reserved: string,
  frame: (parts: string[]) => string,
): { text: string; ids: string[] } {
  if (!folder.length) return { text: '', ids: [] }
  const prefix = `Folder rules for ${cwd}:\n\n`
  const blocks = folder.map(entryBlock)
  const cut = cutHead(
    blocks.join('\n\n'),
    cap - frame(reserved ? [prefix, reserved] : [prefix]).length,
    folder.map(loadRef).join(', '),
  )
  if (cut.kept <= 0) return { text: '', ids: [] }
  let end = -2
  const ends = blocks.map((b) => (end += b.length + 2))
  return {
    text: prefix + cut.text,
    ids: folder.filter((_, i) => ends[i] <= cut.kept).map((e) => e.id),
  }
}

/**
 * The lead in full when it fits the sections so far, else as its pointer; `owed` is the lead brief the chat still has
 * to load (null when it was pasted, undefined when neither fits).
 */
function fitLead(
  s: Sections,
  lead: PackLead | null,
  leadFull: string,
  leadPointer: string,
  fits: (s: Sections) => boolean,
): { s: Sections; owed: string | null | undefined } {
  if (!lead) return { s, owed: undefined }
  if (fits({ ...s, lead: leadFull })) return { s: { ...s, lead: leadFull }, owed: null }
  if (fits({ ...s, lead: leadPointer }))
    return { s: { ...s, lead: leadPointer }, owed: lead.id ?? undefined }
  return { s, owed: undefined }
}

/** The inline matches that fit; the ones that do not go on to the pointers. */
function fitInline(
  s: Sections,
  inline: CatalogEntry[],
  fits: (s: Sections) => boolean,
): { s: Sections; ids: string[]; overflow: CatalogEntry[] } {
  let current = s
  const ids: string[] = []
  const overflow: CatalogEntry[] = []
  for (const e of inline) {
    const next = { ...current, inline: [...current.inline, entryBlock(e)] }
    if (fits(next)) {
      current = next
      ids.push(e.id)
    } else overflow.push(e)
  }
  return { s: current, ids, overflow }
}

function fitPointers(
  s: Sections,
  candidates: CatalogEntry[],
  feedback: FeedbackRead,
  scoreOf: Map<string, number>,
  fits: (s: Sections) => boolean,
): { s: Sections; ids: string[] } {
  let current = s
  const ids: string[] = []
  for (const e of candidates) {
    if (!pointable(feedback, e, scoreOf.get(e.id) ?? 0)) continue
    const line = `- ${e.id} - ${e.when} (${loadRef(e)})`
    const next = { ...current, pointers: [...current.pointers, line] }
    if (fits(next)) {
      current = next
      ids.push(e.id)
    }
  }
  return { s: current, ids }
}

/** Keeps what a built pack sent: the lead brief it owes or clears, the session's sent ids, and its log line. */
function recordPack(
  dir: string,
  req: PackRequest,
  files: ChatFiles,
  sent: SentMap,
  seen: Set<string>,
  pack: Pack,
  now: Date,
): void {
  if (pack.owed === null) clearLeadOwed(sent)
  else if (pack.owed) setLeadOwed(sent, pack.owed)
  const record = pack.mode === 'delta' ? [...seen, ...pack.ids] : pack.ids
  sent[req.session] = [...new Set(record)]
  writeSent(files.sent, sent, req.session, now)
  appendLog(
    dir,
    {
      event: 'pack',
      chat: req.chat,
      session: req.session,
      mode: pack.mode,
      ids: pack.ids,
      pasted: pack.pasted,
      bytes: pack.bytes,
      ms: pack.ms,
    },
    now,
  )
}

/**
 * What Agent Hydra attaches to a chat message: the folder's rules and the matching knowledge, the lead, and a
 * closing line the first time. The text stays within TOTAL_CAP so Claude Code does not save it to a file (a slot,
 * in the system prompt, passes its own cap and gets the lead brief before the folder rules fill it).
 * Later messages get only what this session has not been sent yet.
 */
export function packFor(dir: string, req: PackRequest, now = new Date()): Pack {
  const started = performance.now()
  const files = chatPaths(dir, req.chat)
  const catalog = loadCatalog(dir).entries
  const entries = [...catalog.values()]
  const sent = readSent(files.sent)
  const first = !(req.session in sent)
  const mode: PackMode = req.full ? 'full' : first ? 'first' : 'delta'
  const seen = new Set(mode === 'delta' ? sent[req.session] : [])
  const fresh = (id: string) => !seen.has(id)

  const folderAll = folderKnowledgeOf(entries, req.cwd)
  const main = mainRules(folderAll)
  const mainIds = new Set(main.map((e) => e.id))
  const folder = main.filter((e) => fresh(e.id))
  const foreign = foreignTo(req.cwd)

  const feedback = readFeedback(dir)
  const { inline, rest, scoreOf } = packMatches(
    entries,
    req.prompt,
    feedback,
    (e) => !mainIds.has(e.id) && !foreign(e) && fresh(e.id),
  )

  const hydra = hydraLead(files.hydraMd)
  const fixed = !hydra && req.lead !== undefined
  const { hydraId, lead } = packLead(req, mode, hydra, fixed, entries, catalog, feedback, fresh)

  const frame = (parts: string[]) => packFrame(mode, req.chat, parts)
  const cap = req.cap ?? TOTAL_CAP
  const fits = (s: Sections) => frame(sectionParts(s)).length <= cap
  const leadFull = lead ? `Lead for this message: ${lead.name}\n\n${lead.text}`.trimEnd() : ''
  const leadPointer = lead ? leadPointerLine(req.chat, lead) : ''
  // A slot keeps room for the lead's brief (its pointer when the brief alone is too long) before the folder rules
  // fill it: every manager brief is longer than the attach cap, so rules first left the lead a pointer.
  const reserved = req.cap && lead ? (frame([leadFull]).length <= cap ? leadFull : leadPointer) : ''

  const folderRules = fitFolder(folder, req.cwd, cap, reserved, frame)
  const withLead = fitLead(
    { folder: folderRules.text, lead: '', seats: '', inline: [], pointers: [] },
    lead,
    leadFull,
    leadPointer,
    fits,
  )
  let s = withLead.s
  const seats = mode === 'delta' ? '' : seatsLine(dir, req.chat, entries, files)
  if (seats && fits({ ...s, seats })) s = { ...s, seats }
  const inlined = fitInline(s, inline, fits)
  const pointed = fitPointers(inlined.s, [...inlined.overflow, ...rest], feedback, scoreOf, fits)
  s = pointed.s

  const text = frame(sectionParts(s))
  const leadId = lead?.id
  const pasted = [
    ...folderRules.ids,
    ...inlined.ids,
    ...(s.lead === leadFull && leadId ? [leadId] : []),
  ]
  const ids = [
    ...folderRules.ids,
    ...inlined.ids,
    ...pointed.ids,
    ...(s.lead && leadId ? [leadId] : []),
  ]
  const bytes = Buffer.byteLength(text, 'utf8')
  const ms = Math.round(performance.now() - started)
  const used = hydra ? hydraId : (lead?.id ?? (fixed ? (req.lead ?? null) : null))
  const pack: Pack = { mode, text, ids, pasted, bytes, ms, lead: used, owed: withLead.owed }
  if (!req.dry) recordPack(dir, req, files, sent, seen, pack, now)
  return pack
}

/** Whether a pack ranks its lead on the prompt: no hydra.md lead, no fixed lead, and a first or full pack. */
export function packNeedsPick(dir: string, req: PackRequest): boolean {
  const files = chatPaths(dir, req.chat)
  const first = !(req.session in readSent(files.sent))
  return !hydraLead(files.hydraMd) && req.lead === undefined && (!!req.full || first)
}

/**
 * The model's lead pick a pack needs, made before the synchronous build (a launch may wait LAUNCH_BUDGET_MS, the hook
 * MESSAGE_BUDGET_MS): undefined when the build ranks no lead (a hydra.md lead, a fixed lead, a later message).
 */
export async function pickForPack(
  dir: string,
  req: PackRequest,
  now = new Date(),
): Promise<LeadPick | undefined> {
  if (!packNeedsPick(dir, req)) return undefined
  return pickLead(
    [...loadCatalog(dir).entries.values()],
    req.prompt,
    req.leadMs ?? (req.dry ? LAUNCH_BUDGET_MS : MESSAGE_BUDGET_MS),
    { log: { dir, chat: req.chat, at: now } },
  )
}

export interface Match {
  text: string
  ids: string[]
  chars: number
}

function matchText(inline: string[], pointers: string[]): string {
  return [
    'Hydra Core, new for this message:',
    inline.join('\n\n'),
    pointers.length ? `${ALSO_MATCHING}\n${pointers.join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n\n')
}

/** Whether matchFor builds the full pack for this message: the session neither started with it nor was sent it. */
function packsWhole(dir: string, req: PlacedRequest): boolean {
  const files = chatPaths(dir, req.chat)
  const inPrompt = readPlaced(files.placed)?.started.includes(req.session) ?? false
  return !inPrompt && !(req.session in readSent(files.sent))
}

/**
 * The model's pick a per-message match needs, made before the synchronous build within the hook's budget: the full
 * pack's lead, or whether the work moved to another manager's field (only when the cheap gate in shiftDue opens).
 */
export async function pickForMatch(
  dir: string,
  req: PlacedRequest,
  now = new Date(),
): Promise<LeadPick | undefined> {
  // The chat picks its own lead through core_scope: no model pick or shift.
  if (asksOf(dir)) return undefined
  if (packsWhole(dir, req))
    return pickForPack(
      dir,
      { chat: req.chat, session: req.session, cwd: req.cwd, prompt: req.prompt },
      now,
    )
  const catalog = loadCatalog(dir).entries
  const entries = [...catalog.values()]
  if (!shiftDue(dir, req, entries, catalog)) return undefined
  const files = chatPaths(dir, req.chat)
  const current = currentLead(files, entries, catalog, readPlaced(files.placed))
  return pickLead(entries, req.prompt, MESSAGE_BUDGET_MS, {
    current,
    log: { dir, chat: req.chat, at: now },
    late: (pick) => lateShift(dir, req, current?.id ?? null, pick, catalog),
  })
}

/**
 * Per-message matches for a slot or file chat, at most MATCH_CAP characters. A session that started with the
 * pack (placement.json `started`) gets only what the pack did not hold; any other session gets the full pack
 * on its first message, then only what it has not been sent.
 */
/** The ranked hits a message may draw on: strong enough, with two distinct words of the message in their name or text. */
type MessageHits = ReturnType<typeof rankEntries>

function messageHits(
  prompt: string,
  entries: CatalogEntry[],
  feedback: FeedbackRead,
  keep: (e: CatalogEntry) => boolean,
): MessageHits {
  if (contentWords(prompt).length < MATCH_WORDS) return []
  const need = terms(prompt, true)
  return rankEntries(entries, prompt, { content: true, feedback }).filter((s) => {
    if (s.score < MATCH_MIN || s.entry.kind === 'person' || !keep(s.entry)) return false
    const d = detailOf(s.entry, need)
    return (d.strong || s.score >= MATCH_STRONG) && new Set(d.hits).size >= 2
  })
}

interface PickedMatches {
  inline: string[]
  pointers: string[]
  ids: string[]
  pasted: string[]
  scores: Record<string, number>
}

const oneDecimal = (n: number) => Math.round(n * 10) / 10

/** Pastes a hit's full text when its text is not empty and the message still fits the cap with it. */
function pasteMatch(
  picked: PickedMatches,
  entry: CatalogEntry,
  score: number,
  cap: number,
): boolean {
  if (!loadText(entry).trim()) return false
  const block = entryBlock(entry)
  if (matchText([...picked.inline, block], picked.pointers).length > cap) return false
  picked.inline.push(block)
  picked.ids.push(entry.id)
  picked.pasted.push(entry.id)
  picked.scores[entry.id] = oneDecimal(score)
  return true
}

/** Points to a hit as one line, when it may be pointed to, there is room for a pointer, and the line fits the cap. */
function pointMatch(
  picked: PickedMatches,
  entry: CatalogEntry,
  score: number,
  feedback: FeedbackRead,
  cap: number,
): void {
  if (picked.pointers.length >= MATCH_POINTERS || !pointable(feedback, entry, score)) return
  const line = `- ${entry.id} - ${entry.when} (${loadRef(entry)})`
  if (matchText(picked.inline, [...picked.pointers, line]).length > cap) return
  picked.pointers.push(line)
  picked.ids.push(entry.id)
  picked.scores[entry.id] = oneDecimal(score)
}

function fillMatches(hits: MessageHits, feedback: FeedbackRead, cap: number): PickedMatches {
  const picked: PickedMatches = { inline: [], pointers: [], ids: [], pasted: [], scores: {} }
  for (const { entry, score } of hits) {
    if (picked.ids.length >= MATCH_INLINE) break
    if (!pasteMatch(picked, entry, score, cap)) pointMatch(picked, entry, score, feedback, cap)
  }
  return picked
}

/** The message's text with the lead-shift note first, its own "new for this message" heading dropped. */
function shiftedText(note: string, adds: string): string {
  return [note, adds.replace(/^Hydra Core, new for this message:\n\n/, '')]
    .filter(Boolean)
    .join('\n\n')
}

export function matchFor(dir: string, req: PlacedRequest, now = new Date()): Match {
  const files = chatPaths(dir, req.chat)
  const sent = readSent(files.sent)
  const placed = readPlaced(files.placed)
  const asks = asksOf(dir)
  if (packsWhole(dir, req)) {
    // Asking, the pack ranks no lead (a hydra.md lead still wins): the chat picks its own through core_scope.
    const lead = asks ? null : undefined
    const pack = packFor(
      dir,
      {
        chat: req.chat,
        session: req.session,
        cwd: req.cwd,
        prompt: req.prompt,
        lead,
        pick: req.pick,
      },
      now,
    )
    return { text: pack.text, ids: pack.ids, chars: pack.text.length }
  }

  const catalog = loadCatalog(dir).entries
  const entries = [...catalog.values()]
  // What the chat's slot holds is never sent again, in any session of the chat.
  const seen = new Set([...(sent[req.session] ?? []), ...(placed?.ids ?? [])])
  const folderAll = folderKnowledgeOf(entries, req.cwd)
  const mainIds = new Set(mainRules(folderAll).map((e) => e.id))
  const foreign = foreignTo(req.cwd)

  // Asking, no lead shift runs: the chat's own core_scope pick is its lead.
  const shift = asks ? null : leadShift(dir, req, entries, catalog, now)
  if (shift) seen.add(shift.to)
  const cap = shift
    ? Math.max(0, Math.min(MATCH_CAP, TOTAL_CAP - shift.note.length - 2))
    : MATCH_CAP

  const feedback = readFeedback(dir)
  const hits = messageHits(
    req.prompt,
    entries,
    feedback,
    (e) => !mainIds.has(e.id) && !foreign(e) && !seen.has(e.id),
  )
  const picked = fillMatches(hits, feedback, cap)
  const adds = picked.ids.length ? matchText(picked.inline, picked.pointers) : ''
  const text = shift ? shiftedText(shift.note, adds) : adds
  const sentIds = [...picked.ids, ...(shift ? [shift.to] : [])]

  if (sentIds.length || req.session in sent) {
    sent[req.session] = [...new Set([...(sent[req.session] ?? []), ...sentIds])]
    writeSent(files.sent, sent, req.session, now)
  }
  appendLog(
    dir,
    {
      event: 'placement',
      phase: 'message',
      chat: req.chat,
      session: req.session,
      placement: req.placement,
      chars: text.length,
      ids: picked.ids,
      pasted: picked.pasted,
      scores: picked.scores,
      ...(shift ? { lead: shift.to } : {}),
    },
    now,
  )
  return { text, ids: sentIds, chars: text.length }
}

/**
 * The daemon's answer to the hook (/api/core/pack): the model's pick is awaited first, then the synchronous build
 * runs, so the daemon serves every other route while the pick waits.
 */
export async function packAnswer(
  dir: string,
  req: Omit<PackRequest, 'pick'> & { placement?: unknown },
  now = new Date(),
): Promise<Pack | Match> {
  const { placement, ...rest } = req
  if (placement === 'slot' || placement === 'file') {
    const placed: PlacedRequest = { ...rest, placement }
    return matchFor(dir, { ...placed, pick: await pickForMatch(dir, placed, now) }, now)
  }
  return packFor(dir, { ...rest, pick: await pickForPack(dir, rest, now) }, now)
}

/** The chat's current lead: its hydra.md lead, else the one its slot was built with. */
function currentLead(
  files: ReturnType<typeof chatPaths>,
  entries: CatalogEntry[],
  catalog: Map<string, CatalogEntry>,
  placed: Placed | null,
): CatalogEntry | null {
  const hydra = hydraLead(files.hydraMd)
  if (hydra) return hydraLeadEntry(entries, hydra.path, hydra.name) ?? null
  return placed?.lead ? (catalog.get(placed.lead) ?? null) : null
}

/** The cheap gate before a lead-shift call: a substantive owner message the current lead may no longer fit. A
 *  slot's own lead on the very text its launch picked it on is not asked again. */
function shiftDue(
  dir: string,
  req: PlacedRequest,
  entries: CatalogEntry[],
  catalog: Map<string, CatalogEntry>,
): boolean {
  if (!substantive(req.prompt)) return false
  const files = chatPaths(dir, req.chat)
  const placed = readPlaced(files.placed)
  if (!hydraLead(files.hydraMd) && placed?.prompt?.trim() === req.prompt.trim()) return false
  return mayHaveMoved(entries, currentLead(files, entries, catalog, placed), req.prompt)
}

/**
 * A shift check's model answer that came back after the hook's budget: a move off the lead the check started from
 * becomes the chat's lead in hydra.md, and its note is owed to the next message. A pick that agrees with the
 * current lead, or lands after the lead changed meanwhile, changes nothing.
 */
function lateShift(
  dir: string,
  req: PlacedRequest,
  from: string | null,
  pick: LeadPick,
  catalog: Map<string, CatalogEntry>,
): void {
  if (pick.path !== 'model' || !pick.id || pick.id === from) return
  const to = catalog.get(pick.id)
  if (!to) return
  const files = chatPaths(dir, req.chat)
  const current = currentLead(files, [...catalog.values()], catalog, readPlaced(files.placed))
  if ((current?.id ?? null) !== from) return
  const now = new Date()
  recordLead(files.hydraMd, to, now)
  setLateLead(files.root, { from, to: to.id })
  appendLog(
    dir,
    {
      event: 'lead-shift',
      chat: req.chat,
      session: req.session,
      from,
      to: to.id,
      ms: pick.ms,
      late: true,
    },
    now,
  )
}

/**
 * On a substantive owner message, whether the work moved to another manager's field: a cheap word check first,
 * then the model within the hook's budget (an answer after it moves the lead for the next message: lateShift). A
 * move becomes the chat's lead in hydra.md, so the next launch's slot carries the new brief, and the message that
 * learns of it gets a lead-change note.
 */
function leadShift(
  dir: string,
  req: PlacedRequest,
  entries: CatalogEntry[],
  catalog: Map<string, CatalogEntry>,
  now: Date,
): { to: string; note: string } | null {
  const files = chatPaths(dir, req.chat)
  const owed = takeLateLead(files.root)
  const placed = readPlaced(files.placed)
  const current = currentLead(files, entries, catalog, placed)
  // The chat never saw a late move, so a note names the lead it last knew.
  const known =
    owed && owed.to === current?.id
      ? owed.from
        ? (catalog.get(owed.from) ?? null)
        : null
      : current
  const pick = req.pick
  // Only the model moves a lead: the word ranker's guess is too weak to override one already chosen.
  const to =
    pick?.path === 'model' &&
    pick.id &&
    pick.id !== current?.id &&
    shiftDue(dir, req, entries, catalog)
      ? catalog.get(pick.id)
      : undefined
  if (to) {
    const note = leadNote(known, to, req.chat)
    recordLead(files.hydraMd, to, now)
    appendLog(
      dir,
      {
        event: 'lead-shift',
        chat: req.chat,
        session: req.session,
        from: current?.id ?? null,
        to: to.id,
        ms: pick?.ms,
        chars: note.length,
      },
      now,
    )
    return { to: to.id, note: `Hydra Core, new for this message:\n\n${note}` }
  }
  // Owed while the late move still stands and no launch has rebuilt the slot around it.
  if (!owed || !current || owed.to !== current.id || placed?.lead === current.id) return null
  const note = leadNote(known, current, req.chat, true)
  return { to: current.id, note: `Hydra Core, new for this message:\n\n${note}` }
}
