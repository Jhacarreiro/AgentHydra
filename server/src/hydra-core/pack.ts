import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { contentWords } from '../mcp-find'
import { type CatalogEntry, loadCatalog, loadRef, loadText } from './catalog'
import { detailOf, rankEntries, terms } from './find'
import { leadName, parseHydra } from './hydra-md'
import {
  LAUNCH_BUDGET_MS,
  leadNote,
  MESSAGE_BUDGET_MS,
  mayHaveMoved,
  pickLead,
  recordLead,
  substantive,
  wordLead,
} from './lead'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { seatOf } from './seats'
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
const ALSO_MATCHING = 'Also matching (core_find { need, chat } loads any of them):'

export type PackMode = 'first' | 'full' | 'delta'

export interface PlacedRequest {
  chat: string
  session: string
  cwd: string
  prompt: string
  placement: 'slot' | 'file'
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
}

export interface Pack {
  mode: PackMode
  text: string
  ids: string[]
  bytes: number
  ms: number
  /** The lead the pack used: its catalog id (`lead:<name>` for a hydra.md lead not in the catalog), else null. */
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

/** The personas seated under this chat, read through the seat roster, so a handoff knows whom it consulted. */
function seatsLine(dir: string, chat: string, entries: CatalogEntry[]): string {
  const seated = entries.filter(
    (e) => e.kind === 'person' && seatOf(dir, { key: chat, aliases: [] }, e),
  )
  if (!seated.length) return ''
  return `Seats in this chat: ${seated.map((e) => `${e.name} (${e.id})`).join(', ')}; resume one with core_use { chat: "${chat}", id: "<person id>", mode: "consult" }.`
}

function cutHead(body: string, room: number, where: string): { text: string; kept: number } {
  if (body.length <= room) return { text: body, kept: body.length }
  const note = (n: number) =>
    `\n[cut at ${n} of ${body.length} characters; the rest is in ${where}]`
  let kept = Math.max(0, room - note(room).length)
  if (/[\uD800-\uDBFF]/.test(body[kept - 1] ?? '')) kept--
  if (kept === 0) return { text: '', kept: 0 }
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

  const matches = rankEntries(entries, req.prompt).filter(
    (s) =>
      s.score >= MATCH_MIN &&
      s.entry.kind !== 'person' &&
      !mainIds.has(s.entry.id) &&
      !foreign(s.entry) &&
      fresh(s.entry.id),
  )
  const inline = matches
    .filter((s) => s.entry.kind === 'knowledge' && s.score >= INLINE_MIN)
    .slice(0, INLINE_MATCHES)
    .map((s) => s.entry)
  const rest = matches.map((s) => s.entry).filter((e) => !inline.includes(e))

  const hydra = hydraLead(files.hydraMd)
  const fixed = !hydra && req.lead !== undefined
  // A first pack asks the model (a launch may wait longer than the hook); a later one keeps to the word ranker.
  const personaId =
    hydra || fixed
      ? undefined
      : mode === 'delta'
        ? wordLead(entries, req.prompt)?.id
        : pickLead(
            entries,
            req.prompt,
            req.leadMs ?? (req.dry ? LAUNCH_BUDGET_MS : MESSAGE_BUDGET_MS),
            {
              log: { dir, chat: req.chat, at: now },
            },
          ).id
  const persona = personaId ? catalog.get(personaId) : undefined
  const chosen = fixed && req.lead ? catalog.get(req.lead) : undefined
  let lead: { id: string; name: string; text: string } | null = null
  if (hydra) {
    const id = hydraLeadEntry(entries, hydra.path, hydra.name)?.id ?? `lead:${hydra.name}`
    if (fresh(id)) lead = { id, name: hydra.name, text: leadFileText(hydra.path) }
  } else if (chosen && fresh(chosen.id))
    lead = { id: chosen.id, name: chosen.name, text: loadText(chosen) }
  else if (persona && fresh(persona.id))
    lead = { id: persona.id, name: persona.name, text: loadText(persona) }

  const frame = (parts: string[]) =>
    mode === 'delta'
      ? parts.length
        ? ['Hydra Core, new for this message:', ...parts].join('\n\n')
        : ''
      : [
          'Hydra Core attached for this chat and message:',
          ...parts,
          `More is one core_find { need: "<what you need>", chat: "${req.chat}" } away; no other manager call is needed.`,
        ].join('\n\n')
  const parts = (s: Sections) =>
    [s.folder, ...matchParts(s.inline, s.pointers), s.lead, s.seats].filter(Boolean)
  const cap = req.cap ?? TOTAL_CAP
  const fits = (s: Sections) => frame(parts(s)).length <= cap
  const leadFull = lead ? `Lead for this message: ${lead.name}\n\n${lead.text}`.trimEnd() : ''
  const leadPointer = lead
    ? `Lead for this message: ${lead.name}. Load the brief with core_use { chat: "${req.chat}", id: "${lead.id}", mode: "become" }.`
    : ''
  // A slot keeps room for the lead's brief (its pointer when the brief alone is too long) before the folder rules
  // fill it: every manager brief is longer than the attach cap, so rules first left the lead a pointer.
  const reserved = req.cap && lead ? (frame([leadFull]).length <= cap ? leadFull : leadPointer) : ''

  let s: Sections = { folder: '', lead: '', seats: '', inline: [], pointers: [] }
  const ids: string[] = []

  if (folder.length) {
    const prefix = `Folder rules for ${req.cwd}:\n\n`
    const blocks = folder.map(entryBlock)
    const cut = cutHead(
      blocks.join('\n\n'),
      cap - frame(reserved ? [prefix, reserved] : [prefix]).length,
      folder.map(loadRef).join(', '),
    )
    if (cut.kept > 0) {
      s.folder = prefix + cut.text
      let end = -2
      const ends = blocks.map((b) => (end += b.length + 2))
      ids.push(...folder.filter((_, i) => ends[i] <= cut.kept).map((e) => e.id))
    }
  }

  let owed: string | null | undefined
  if (lead) {
    if (fits({ ...s, lead: leadFull })) {
      s = { ...s, lead: leadFull }
      owed = null
    } else if (fits({ ...s, lead: leadPointer })) {
      s = { ...s, lead: leadPointer }
      owed = lead.id
    }
  }

  const seats = mode === 'delta' ? '' : seatsLine(dir, req.chat, entries)
  if (seats && fits({ ...s, seats })) s = { ...s, seats }

  const overflow: CatalogEntry[] = []
  const inlineIds: string[] = []
  for (const e of inline) {
    const next = { ...s, inline: [...s.inline, entryBlock(e)] }
    if (fits(next)) {
      s = next
      inlineIds.push(e.id)
    } else overflow.push(e)
  }

  const pointerIds: string[] = []
  for (const e of [...overflow, ...rest]) {
    const next = { ...s, pointers: [...s.pointers, `- ${e.id} - ${e.when} (${loadRef(e)})`] }
    if (fits(next)) {
      s = next
      pointerIds.push(e.id)
    }
  }

  const text = frame(parts(s))
  ids.push(...inlineIds, ...pointerIds, ...(s.lead && lead ? [lead.id] : []))
  const bytes = Buffer.byteLength(text, 'utf8')
  const ms = Math.round(performance.now() - started)
  const used = hydra
    ? (hydraLeadEntry(entries, hydra.path, hydra.name)?.id ?? `lead:${hydra.name}`)
    : (lead?.id ?? (fixed ? (req.lead ?? null) : null))
  if (req.dry) return { mode, text, ids, bytes, ms, lead: used, owed }

  if (owed === null) clearLeadOwed(sent)
  else if (owed) setLeadOwed(sent, owed)
  const record = mode === 'delta' ? [...seen, ...ids] : ids
  sent[req.session] = [...new Set(record)]
  writeSent(files.sent, sent)
  appendLog(dir, { event: 'pack', chat: req.chat, session: req.session, mode, ids, bytes, ms }, now)
  return { mode, text, ids, bytes, ms, lead: used, owed }
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

/**
 * Per-message matches for a slot or file chat, at most MATCH_CAP characters. A session that started with the
 * pack (placement.json `started`) gets only what the pack did not hold; any other session gets the full pack
 * on its first message, then only what it has not been sent.
 */
export function matchFor(dir: string, req: PlacedRequest, now = new Date()): Match {
  const files = chatPaths(dir, req.chat)
  const sent = readSent(files.sent)
  const placed = readPlaced(files.placed)
  const inPrompt = placed?.started.includes(req.session) ?? false
  if (!inPrompt && !(req.session in sent)) {
    const pack = packFor(
      dir,
      { chat: req.chat, session: req.session, cwd: req.cwd, prompt: req.prompt },
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

  const shift = leadShift(dir, req, entries, catalog, now)
  if (shift) seen.add(shift.to)
  const cap = shift
    ? Math.max(0, Math.min(MATCH_CAP, TOTAL_CAP - shift.note.length - 2))
    : MATCH_CAP

  const need = terms(req.prompt, true)
  const scores: Record<string, number> = {}
  const hits =
    contentWords(req.prompt).length < MATCH_WORDS
      ? []
      : rankEntries(entries, req.prompt, { content: true }).filter((s) => {
          if (
            s.score < MATCH_MIN ||
            s.entry.kind === 'person' ||
            mainIds.has(s.entry.id) ||
            foreign(s.entry) ||
            seen.has(s.entry.id)
          )
            return false
          const d = detailOf(s.entry, need)
          return (d.strong || s.score >= MATCH_STRONG) && new Set(d.hits).size >= 2
        })
  const inline: string[] = []
  const pointers: string[] = []
  const ids: string[] = []
  for (const { entry, score } of hits) {
    if (ids.length >= MATCH_INLINE) break
    if (loadText(entry).trim()) {
      const next = matchText([...inline, entryBlock(entry)], pointers)
      if (next.length <= cap) {
        inline.push(entryBlock(entry))
        ids.push(entry.id)
        scores[entry.id] = Math.round(score * 10) / 10
        continue
      }
    }
    if (pointers.length < MATCH_POINTERS) {
      const line = `- ${entry.id} - ${entry.when} (${loadRef(entry)})`
      if (matchText(inline, [...pointers, line]).length <= cap) {
        pointers.push(line)
        ids.push(entry.id)
        scores[entry.id] = Math.round(score * 10) / 10
      }
    }
  }
  const adds = ids.length ? matchText(inline, pointers) : ''
  const text = shift
    ? [shift.note, adds.replace(/^Hydra Core, new for this message:\n\n/, '')]
        .filter(Boolean)
        .join('\n\n')
    : adds
  const sentIds = [...ids, ...(shift ? [shift.to] : [])]

  if (sentIds.length) {
    sent[req.session] = [...new Set([...(sent[req.session] ?? []), ...sentIds])]
    writeSent(files.sent, sent)
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
      ids,
      scores,
      ...(shift ? { lead: shift.to } : {}),
    },
    now,
  )
  return { text, ids: sentIds, chars: text.length }
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

/**
 * On a substantive owner message, whether the work moved to another manager's field: a cheap word check first,
 * then the model within the hook's budget (a timeout keeps the current lead). A move becomes the chat's lead in
 * hydra.md, so the next launch's slot carries the new brief, and this message gets a lead-change note.
 */
function leadShift(
  dir: string,
  req: PlacedRequest,
  entries: CatalogEntry[],
  catalog: Map<string, CatalogEntry>,
  now: Date,
): { to: string; note: string } | null {
  if (!substantive(req.prompt)) return null
  const files = chatPaths(dir, req.chat)
  const current = currentLead(files, entries, catalog, readPlaced(files.placed))
  if (!mayHaveMoved(entries, current, req.prompt)) return null
  const pick = pickLead(entries, req.prompt, MESSAGE_BUDGET_MS, {
    log: { dir, chat: req.chat, at: now },
  })
  // Only the model moves a lead: the word ranker's guess is too weak to override one already chosen.
  if (pick.path !== 'model' || !pick.id || pick.id === current?.id) return null
  const to = catalog.get(pick.id)
  if (!to) return null
  const note = leadNote(current, to, req.chat)
  recordLead(files.hydraMd, to, now)
  appendLog(
    dir,
    {
      event: 'lead-shift',
      chat: req.chat,
      session: req.session,
      from: current?.id ?? null,
      to: to.id,
      ms: pick.ms,
      chars: note.length,
    },
    now,
  )
  return { to: to.id, note: `Hydra Core, new for this message:\n\n${note}` }
}
