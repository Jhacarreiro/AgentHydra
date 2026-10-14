import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { type CatalogEntry, LEAD_TIERS, loadCatalog, loadRef, loadText } from './catalog'
import { rankEntries } from './find'
import { leadName, parseHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { folderKnowledgeOf, mainRules } from './tree'

export const TOTAL_CAP = 9500
const INLINE_MATCHES = 3
const MATCH_MIN = 4
/** A match is pasted in full only this strong (a name hit or several); weaker ones go as one-line pointers. */
const INLINE_MIN = 20
const LEAD_MIN = 4
/** What a slot or file chat gets per message from the hook: strong matches only, at most this many characters. */
export const MATCH_CAP = 2000

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

type Sent = Record<string, string[]>

interface Sections {
  folder: string
  lead: string
  inline: string[]
  pointers: string[]
}

function readSent(file: string): Sent {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Sent
  } catch {
    return {}
  }
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
    pointers.length
      ? `Also matching (core_find { need, chat } loads any of them):\n${pointers.join('\n')}`
      : '',
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
  let lead: { key: string; name: string; text: string } | null = null
  if (hydra && fresh(`lead:${hydra.name}`))
    lead = { key: `lead:${hydra.name}`, name: hydra.name, text: leadFileText(hydra.path) }
  else if (persona && persona.score >= LEAD_MIN && fresh(persona.entry.id))
    lead = {
      key: persona.entry.id,
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
    [s.folder, ...matchParts(s.inline, s.pointers), s.lead].filter(Boolean)
  const fits = (s: Sections) => frame(parts(s)).length <= TOTAL_CAP

  let s: Sections = { folder: '', lead: '', inline: [], pointers: [] }
  const ids: string[] = []

  if (folder.length) {
    const prefix = `Folder rules for ${req.cwd}:\n\n`
    const blocks = folder.map(entryBlock)
    const cut = cutHead(
      blocks.join('\n\n'),
      TOTAL_CAP - frame([prefix]).length,
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
    const pointer = `Lead for this message: ${lead.name}. Load the brief with core_use { chat: "${req.chat}", id: "${lead.key}", mode: "become" }.`
    if (fits({ ...s, lead: full })) s = { ...s, lead: full }
    else if (fits({ ...s, lead: pointer })) s = { ...s, lead: pointer }
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
  ids.push(...inlineIds, ...pointerIds, ...(s.lead && lead ? [lead.key] : []))
  const record = mode === 'delta' ? [...seen, ...ids] : ids
  sent[req.session] = [...new Set(record)]
  mkdirSync(dirname(files.sent), { recursive: true })
  writeFileSync(files.sent, JSON.stringify(sent, null, 2))

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

/** Per-message matches for a slot or file chat: strong hits not yet sent this session, at most MATCH_CAP characters. */
export function matchFor(dir: string, req: PlacedRequest, now = new Date()): Match {
  const files = chatPaths(dir, req.chat)
  const entries = [...loadCatalog(dir).entries.values()]
  const sent = readSent(files.sent)
  const seen = new Set([...(sent[req.session] ?? []), ...(readPlaced(files.placed)?.ids ?? [])])
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
  const head = 'Hydra Core, new for this message:\n\n'
  let text = ''
  const ids: string[] = []
  for (const { entry } of hits) {
    const next = text ? `${text}\n\n${entryBlock(entry)}` : `${head}${entryBlock(entry)}`
    if (next.length > MATCH_CAP) continue
    text = next
    ids.push(entry.id)
  }

  if (ids.length) {
    sent[req.session] = [...new Set([...(sent[req.session] ?? []), ...ids])]
    mkdirSync(dirname(files.sent), { recursive: true })
    writeFileSync(files.sent, JSON.stringify(sent, null, 2))
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
