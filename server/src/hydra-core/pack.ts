import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type CatalogEntry, LEAD_TIERS, loadCatalog, loadRef, loadText } from './catalog'
import { rankEntries } from './find'
import { leadName, parseHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths, ownerContextPath } from './paths'
import { clearLeadOwed, readSent, setLeadOwed, writeSent } from './sent'
import { folderKnowledgeOf, mainRules } from './tree'

export const TOTAL_CAP = 9500
const INLINE_MATCHES = 3
const MATCH_MIN = 4
/** A match is pasted in full only this strong (a name hit or several); weaker ones go as one-line pointers. */
const INLINE_MIN = 20
const LEAD_MIN = 4
/** What a slot or file chat gets per message from the hook: strong matches only, at most this many characters. */
export const MATCH_CAP = 2000
/** Per message: at most this many full texts, then at most MATCH_POINTERS one-line pointers. */
const MATCH_INLINE = 5
const MATCH_POINTERS = 5
const ALSO_MATCHING = 'Also matching (core_find { need, chat } loads any of them):'
const OWNER_CAP = 2000

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
}

export interface PackRequest {
  chat: string
  session: string
  cwd: string
  prompt: string
  full?: boolean
}

export interface Pack {
  mode: PackMode
  text: string
  ids: string[]
  bytes: number
  ms: number
}

interface Sections {
  folder: string
  lead: string
  inline: string[]
  pointers: string[]
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

function ownerContext(dir: string): string {
  const file = ownerContextPath(dir)
  if (!existsSync(file)) return ''
  const body = readFileSync(file, 'utf8').trim()
  if (!body) return ''
  return `Owner context:\n\n${cutHead(body, OWNER_CAP, 'owner-context.md').text}`
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
    }
  } catch {
    return null
  }
}

/**
 * What Agent Hydra attaches to a chat message: the folder's rules and the matching knowledge, the lead, and a
 * closing line the first time. The text stays within TOTAL_CAP so Claude Code does not save it to a file.
 * Later messages get only what this session has not been sent yet.
 */
export function packFor(dir: string, req: PackRequest, now = new Date()): Pack {
  const started = performance.now()
  const files = chatPaths(dir, req.chat)
  const entries = [...loadCatalog(dir).entries.values()]
  const sent = readSent(files.sent)
  const first = !(req.session in sent)
  const mode: PackMode = req.full ? 'full' : first ? 'first' : 'delta'
  const seen = new Set(mode === 'delta' ? sent[req.session] : [])
  const fresh = (id: string) => !seen.has(id)
  const owner = ownerContext(dir)

  const folderAll = folderKnowledgeOf(entries, req.cwd)
  const main = mainRules(folderAll)
  const mainIds = new Set(main.map((e) => e.id))
  const folder = main.filter((e) => fresh(e.id))
  // An entry filed under other folders belongs to another project; one filed nowhere fits every folder.
  const here = new Set(folderAll.map((e) => e.id))
  const foreign = (e: CatalogEntry) => (e.folders ?? []).length > 0 && !here.has(e.id)

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
  const persona = hydra
    ? undefined
    : rankEntries(entries, req.prompt, { kinds: ['person'], mode: 'become', tiers: LEAD_TIERS })[0]
  let lead: { id: string; name: string; text: string } | null = null
  if (hydra) {
    const id = hydraLeadEntry(entries, hydra.path, hydra.name)?.id ?? `lead:${hydra.name}`
    if (fresh(id)) lead = { id, name: hydra.name, text: leadFileText(hydra.path) }
  } else if (persona && persona.score >= LEAD_MIN && fresh(persona.entry.id))
    lead = {
      id: persona.entry.id,
      name: persona.entry.name,
      text: loadText(persona.entry),
    }

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
    [owner, s.folder, ...matchParts(s.inline, s.pointers), s.lead].filter(Boolean)
  const fits = (s: Sections) => frame(parts(s)).length <= TOTAL_CAP

  let s: Sections = { folder: '', lead: '', inline: [], pointers: [] }
  const ids: string[] = []

  if (folder.length) {
    const prefix = `Folder rules for ${req.cwd}:\n\n`
    const blocks = folder.map(entryBlock)
    const cut = cutHead(
      blocks.join('\n\n'),
      TOTAL_CAP - frame([owner, prefix].filter(Boolean)).length,
      folder.map(loadRef).join(', '),
    )
    if (cut.kept > 0) {
      s.folder = prefix + cut.text
      let end = -2
      const ends = blocks.map((b) => (end += b.length + 2))
      ids.push(...folder.filter((_, i) => ends[i] <= cut.kept).map((e) => e.id))
    }
  }

  if (lead) {
    const full = `Lead for this message: ${lead.name}\n\n${lead.text}`.trimEnd()
    const pointer = `Lead for this message: ${lead.name}. Load the brief with core_use { chat: "${req.chat}", id: "${lead.id}", mode: "become" }.`
    if (fits({ ...s, lead: full })) {
      s = { ...s, lead: full }
      clearLeadOwed(sent)
    } else if (fits({ ...s, lead: pointer })) {
      s = { ...s, lead: pointer }
      setLeadOwed(sent, lead.id)
    }
  }

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
  const record = mode === 'delta' ? [...seen, ...ids] : ids
  sent[req.session] = [...new Set(record)]
  writeSent(files.sent, sent)

  const bytes = Buffer.byteLength(text, 'utf8')
  const ms = Math.round(performance.now() - started)
  appendLog(dir, { event: 'pack', chat: req.chat, session: req.session, mode, ids, bytes, ms }, now)
  return { mode, text, ids, bytes, ms }
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

  const entries = [...loadCatalog(dir).entries.values()]
  const seen = new Set([...(sent[req.session] ?? []), ...(inPrompt ? (placed?.ids ?? []) : [])])
  const folderAll = folderKnowledgeOf(entries, req.cwd)
  const mainIds = new Set(mainRules(folderAll).map((e) => e.id))
  const here = new Set(folderAll.map((e) => e.id))
  const foreign = (e: CatalogEntry) => (e.folders ?? []).length > 0 && !here.has(e.id)

  const hits = rankEntries(entries, req.prompt).filter(
    (s) =>
      s.score >= MATCH_MIN &&
      s.entry.kind !== 'person' &&
      !mainIds.has(s.entry.id) &&
      !foreign(s.entry) &&
      !seen.has(s.entry.id),
  )
  const inline: string[] = []
  const pointers: string[] = []
  const ids: string[] = []
  for (const { entry } of hits) {
    if (loadText(entry).trim() && inline.length < MATCH_INLINE) {
      const next = matchText([...inline, entryBlock(entry)], pointers)
      if (next.length <= MATCH_CAP) {
        inline.push(entryBlock(entry))
        ids.push(entry.id)
        continue
      }
    }
    if (pointers.length < MATCH_POINTERS) {
      const line = `- ${entry.id} - ${entry.when} (${loadRef(entry)})`
      if (matchText(inline, [...pointers, line]).length <= MATCH_CAP) {
        pointers.push(line)
        ids.push(entry.id)
      }
    }
  }
  const text = ids.length ? matchText(inline, pointers) : ''

  if (ids.length) {
    sent[req.session] = [...new Set([...(sent[req.session] ?? []), ...ids])]
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
    },
    now,
  )
  return { text, ids, chars: text.length }
}
