// The CrAInium as a routine store (routines/central.ts says what a routine document is): the documents under routines/ in
// one docs repo key of the person's Connections workspace, read and written through their own Connections server's `docs`
// tool (connectors/connections-client.ts), the way any chat of theirs reads and writes a doc. Keeps nothing:
// routines/manager-central.ts keeps the copy on this computer. Every refusal is a StoreError with the CrAInium's code.

import { createHash } from 'node:crypto'
import { jsonAnswer } from '../connectors/connections-client'
import { DOC_FOLDER } from './central'

/** One call of the person's Connections `docs` tool; its text answer. */
export type DocsCall = (params: Record<string, unknown>) => Promise<string>

export class StoreError extends Error {
  constructor(
    message: string,
    /** The CrAInium's refusal code (docs_changed: the document moved on since the sha the write named), or null. */
    readonly code: string | null = null,
  ) {
    super(message)
  }
}

/** A document the store lists: its path and the sha of its text. */
export interface StoreDoc {
  path: string
  sha: string
}

export interface RoutineStore {
  list(): Promise<StoreDoc[]>
  get(path: string): Promise<{ text: string; sha: string }>
  /** Writes a document: `baseSha` replaces the version it names, null creates one. Answers the new text's sha. */
  put(path: string, text: string, baseSha: string | null): Promise<string>
  /** Takes a document out of the list; the store keeps its versions. */
  retire(path: string, reason: string): Promise<void>
}

/** The most documents one listing reads. */
const LIST_MAX = 100

/** The sha the CrAInium keeps for a document's text: sha256 of it, Windows line ends made plain. */
export const docSha = (text: string): string => createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex')

const firstLine = (text: string): string => text.trim().split('\n')[0]?.slice(0, 200) ?? ''

export function crainiumStore(call: DocsCall, repo: string): RoutineStore {
  async function ask(params: Record<string, unknown>): Promise<{ text: string; json: Record<string, unknown> | null }> {
    const text = await call({ ...params, repo })
    const json = jsonAnswer(text)
    if (json && typeof json.error === 'string') throw new StoreError(`the CrAInium refused: ${String(json.detail ?? json.error)}`, json.error)
    return { text, json }
  }
  return {
    async list() {
      const { text, json } = await ask({ action: 'search', folder: DOC_FOLDER, limit: LIST_MAX, format: 'json' })
      // A signed-out Connections answers in words, not a list.
      if (!Array.isArray(json?.docs)) throw new StoreError(`the CrAInium answered no list of documents: ${firstLine(text)}`)
      return (json.docs as Record<string, unknown>[]).flatMap((d) =>
        typeof d?.path === 'string' && typeof d.sha === 'string' && d.path.startsWith(DOC_FOLDER) && !d.retiredAt ? [{ path: d.path, sha: d.sha }] : [],
      )
    },
    async get(path) {
      const { text, json } = await ask({ action: 'get', path, format: 'json' })
      const doc = json?.doc as { text?: unknown; sha?: unknown } | undefined
      if (typeof doc?.text !== 'string' || typeof doc.sha !== 'string') throw new StoreError(`the CrAInium answered no text for ${path}: ${firstLine(text)}`)
      return { text: doc.text, sha: doc.sha }
    },
    async put(path, text, baseSha) {
      const { text: said } = await ask({ action: 'put', path, text, ...(baseSha ? { baseSha } : {}) })
      const sha = docSha(text)
      const version = /\(version ([0-9a-f]{12})\)/.exec(said)?.[1]
      if (!version || !sha.startsWith(version)) throw new StoreError(`the CrAInium did not say it stored ${path}: ${firstLine(said)}`)
      return sha
    },
    async retire(path, reason) {
      const { text: said } = await ask({ action: 'retire', path, reason })
      if (!said.startsWith('[docs] retired')) throw new StoreError(`the CrAInium did not say it retired ${path}: ${firstLine(said)}`)
    },
  }
}
