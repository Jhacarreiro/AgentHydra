import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { type CatalogEntry, LEAD_TIERS, loadCatalog, loadRef, loadText } from './catalog'
import { rankEntries } from './find'
import { leadName, parseHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { folderKnowledgeOf, mainRules } from './tree'

export const FOLDER_CAP = 12 * 1024
export const MATCH_CAP = 2 * 1024
export const LEAD_CAP = 8 * 1024
const INLINE_MATCHES = 3
const POINTERS = 5
const MATCH_MIN = 4
/** A match is pasted in full only this strong (a name hit or several); weaker ones go as one-line pointers. */
const INLINE_MIN = 20
const LEAD_MIN = 4

export type PackMode = 'first' | 'full' | 'delta'

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

function readSent(file: string): Sent {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Sent
  } catch {
    return {}
  }
}

function capped(text: string, cap: number, where: string): string {
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes <= cap) return text
  const head = Buffer.from(text, 'utf8').subarray(0, cap).toString('utf8')
  return `${head}\n[cut at ${cap} of ${bytes} bytes; the rest is in ${where}]`
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
  return capped(readFileSync(path, 'utf8'), LEAD_CAP, path)
}

function entryBlock(e: CatalogEntry, cap: number): string {
  return `--- ${e.id} (${loadRef(e)}) ---\n${capped(loadText(e), cap, loadRef(e))}`
}

/**
 * What Agent Hydra attaches to a chat message: the folder's rules and the matching knowledge in full, the
 * lead, and a closing line the first time. Later messages get only what this session has not been sent yet.
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
  const pointers = matches
    .map((s) => s.entry)
    .filter((e) => !inline.includes(e))
    .slice(0, POINTERS)

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
      text: capped(loadText(persona.entry), LEAD_CAP, loadRef(persona.entry)),
    }

  const parts: string[] = []
  if (folder.length)
    parts.push(
      `Folder rules for ${req.cwd}:\n\n${capped(folder.map((e) => entryBlock(e, FOLDER_CAP)).join('\n\n'), FOLDER_CAP, folder.map(loadRef).join(', '))}`,
    )
  if (inline.length)
    parts.push(
      `Rulings and knowledge for this message:\n\n${inline.map((e) => entryBlock(e, MATCH_CAP)).join('\n\n')}`,
    )
  if (pointers.length)
    parts.push(
      `Also matching (core_find { need, chat } loads any of them):\n${pointers.map((e) => `- ${e.id} - ${e.when} (${loadRef(e)})`).join('\n')}`,
    )
  if (lead) parts.push(`Lead for this message: ${lead.name}\n\n${lead.text}`.trimEnd())

  const closing = `More is one core_find { need: "<what you need>", chat: "${req.chat}" } away; no other manager call is needed.`
  const header =
    mode === 'delta'
      ? 'Hydra Core, new for this message:'
      : 'Hydra Core attached for this chat and message:'
  const text =
    mode === 'delta'
      ? parts.length
        ? [header, ...parts].join('\n\n')
        : ''
      : [header, ...parts, closing].join('\n\n')

  const ids = [
    ...folder.map((e) => e.id),
    ...inline.map((e) => e.id),
    ...pointers.map((e) => e.id),
    ...(lead ? [lead.key] : []),
  ]
  const record = mode === 'delta' ? [...seen, ...ids] : ids
  sent[req.session] = [...new Set(record)]
  mkdirSync(dirname(files.sent), { recursive: true })
  writeFileSync(files.sent, JSON.stringify(sent, null, 2))

  const bytes = Buffer.byteLength(text, 'utf8')
  const ms = Math.round(performance.now() - started)
  appendLog(dir, { event: 'pack', chat: req.chat, session: req.session, mode, ids, bytes, ms }, now)
  return { mode, text, ids, bytes, ms }
}
