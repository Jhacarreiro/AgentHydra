import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type CatalogEntry, loadText } from './catalog'

export type Sent = Record<string, string[]>

/** Not a session: the chat's lead brief it still owes its next go, as the lead's catalog id. */
const OWED = '(lead owed)'

export function readSent(file: string): Sent {
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Sent
  } catch {
    return {}
  }
}

export function writeSent(file: string, sent: Sent): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(sent, null, 2))
}

export function setLeadOwed(sent: Sent, id: string): void {
  sent[OWED] = [id]
}

export function clearLeadOwed(sent: Sent): void {
  delete sent[OWED]
}

/** The lead brief a chat still owes, taken once: it is cleared from sent.json as it is read. */
export function takeLeadOwed(
  file: string,
  cat: Map<string, CatalogEntry>,
): { id: string; name: string; text: string } | null {
  const sent = readSent(file)
  const id = sent[OWED]?.[0]
  if (!id) return null
  clearLeadOwed(sent)
  writeSent(file, sent)
  const e = cat.get(id)
  return e ? { id: e.id, name: e.name, text: loadText(e) } : null
}
