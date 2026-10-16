// The CrAInium as a routine store (routines/central.ts says what a routine document is): the documents under routines/ in
// one docs repo key of the person's Connections workspace, read and written through their own Connections server's `docs`
// tool (connectors/connections-client.ts), the way any chat of theirs reads and writes a doc. And the CrAInium as the run
// board (routines/runs.ts says what a claim and a run event are), under the same repo key, through the `routine_runs` tool.
// Keeps nothing: routines/manager-central.ts keeps the copy on this computer. Every refusal is a StoreError with the
// CrAInium's code.

import { createHash } from 'node:crypto'
import { jsonAnswer } from '../connectors/connections-client'
import { DOC_FOLDER } from './central'
import type { Claim, RunEvent } from './runs'

/** One call of one of the person's Connections tools; its text answer. */
export type ToolCall = (params: Record<string, unknown>) => Promise<string>

/** The Connections tool the run board answers through. */
export const RUNS_TOOL = 'routine_runs'

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

/** A caller of one tool under one repo key: its text answer and its JSON, a refusal thrown with the CrAInium's code. */
function asker(call: ToolCall, repo: string) {
  return async (params: Record<string, unknown>): Promise<{ text: string; json: Record<string, unknown> | null }> => {
    const text = await call({ ...params, repo })
    const json = jsonAnswer(text)
    if (json && typeof json.error === 'string') throw new StoreError(`the CrAInium refused: ${String(json.detail ?? json.error)}`, json.error)
    return { text, json }
  }
}

export function crainiumStore(call: ToolCall, repo: string): RoutineStore {
  const ask = asker(call, repo)
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

/** The run board: one routine's claim per call, and the run log, under the store's repo key. */
export interface RunBoard {
  /** Asks for a routine's slot for this runner, or renews this runner's hold on it: the routine's claim after the ask (held
   *  when it names this slot and runner and has not ended). */
  claim(c: { routine: string; slot: number; runner: string; leaseMs: number }): Promise<Claim>
  /** Ends the holder's claim on a slot: its run ended, and no runner takes that slot again. */
  end(c: { routine: string; slot: number; runner: string }): Promise<void>
  /** Adds run events to the run log; an event with an id it holds replaces it. */
  report(events: RunEvent[]): Promise<void>
  /** The run log's newest run of each routine under the repo key, as its events (another computer's writing: checked when read). */
  latest(): Promise<unknown[]>
}

const msOf = (v: unknown): number | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? Date.parse(v) : null)

/** A claim as the board answers it ({ slot, holder, leaseUntil, endedAt } with ISO times), or null when it is not one. */
function claimOf(v: unknown): Claim | null {
  const c = v as Record<string, unknown> | null
  const slot = msOf(c?.slot)
  const leaseUntil = msOf(c?.leaseUntil)
  if (!c || slot === null || leaseUntil === null || typeof c.holder !== 'string' || (c.endedAt !== null && msOf(c.endedAt) === null)) return null
  return { slot, holder: c.holder, leaseUntil, endedAt: msOf(c.endedAt) }
}

export function crainiumRunBoard(call: ToolCall, repo: string): RunBoard {
  const ask = asker(call, repo)
  const iso = (ms: number): string => new Date(ms).toISOString()
  return {
    async claim({ routine, slot, runner, leaseMs }) {
      const { text, json } = await ask({ action: 'claim', routine, slot: iso(slot), runner, leaseMs })
      const claim = claimOf(json?.claim)
      if (!claim) throw new StoreError(`the run board answered no claim: ${firstLine(text)}`)
      return claim
    },
    async end({ routine, slot, runner }) {
      const { text, json } = await ask({ action: 'end', routine, slot: iso(slot), runner })
      if (!json || !('claim' in json)) throw new StoreError(`the run board did not say it ended the claim: ${firstLine(text)}`)
    },
    async report(events) {
      const { text, json } = await ask({ action: 'report', events })
      if (typeof json?.kept !== 'number') throw new StoreError(`the run log did not say it kept the events: ${firstLine(text)}`)
    },
    async latest() {
      const { text, json } = await ask({ action: 'latest' })
      if (!Array.isArray(json?.events)) throw new StoreError(`the run log answered no events: ${firstLine(text)}`)
      return json.events as unknown[]
    },
  }
}
