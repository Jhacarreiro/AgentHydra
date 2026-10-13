import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { type CatalogEntry, loadCatalog, loadRef, loadText } from './catalog'
import { addPick, emptyDoc, type HydraDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'

const WAIT_S = 30
const TERMINAL = ['done', 'failed', 'cancelled']
const GROUP = 'hydra-core'

export interface Report {
  status: string
  text: string | null
}

export interface Daemon {
  dispatch(prompt: string, title: string): Promise<string>
  report(id: string, waitS: number): Promise<Report | null>
}

export type UseArgs = {
  chat: string
  id: string
  mode: 'become' | 'consult' | 'hire' | 'load'
  question?: string
  job?: string
}

function writeDoc(file: string, doc: HydraDoc): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, renderHydra(doc))
}

function readDoc(file: string): HydraDoc | null {
  return existsSync(file) ? parseHydra(readFileSync(file, 'utf8')) : null
}

function entryOf(dir: string, id: string): CatalogEntry {
  const e = loadCatalog(dir).entries.get(id)
  if (!e) throw new Error(`no catalog entry ${id}: use core_find to get an id`)
  return e
}

function checkMode(e: CatalogEntry, mode: UseArgs['mode']): void {
  if (e.kind === 'person') {
    if (mode === 'load') throw new Error(`${e.id} is a person: use become, consult or hire`)
    if (!(e.modes ?? []).includes(mode)) throw new Error(`${e.id} does not allow mode ${mode}`)
    return
  }
  if (mode !== 'load') throw new Error(`${e.id} is not a person: use mode load`)
}

function readText(v: unknown): string | null {
  for (const k of ['report', 'text', 'answer', 'result']) {
    const x = (v as Record<string, unknown>)[k]
    if (typeof x === 'string') return x
  }
  return null
}

export function defaultDaemon(api: (path: string, init?: RequestInit) => Promise<unknown>): Daemon {
  return {
    async dispatch(prompt, title) {
      const reply = (await api('/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ prompt, title, kind: 'review', light: true }],
          group: GROUP,
        }),
      })) as { workers?: { id?: unknown }[] }
      const id = reply.workers?.[0]?.id
      if (typeof id !== 'string') throw new Error('the daemon did not return a worker id')
      return id
    },
    async report(id, waitS) {
      // The report view is a bare list of rows, one per worker.
      const rows = (await api(
        `/api/corch/workers?ids=${encodeURIComponent(id)}&report=1&wait=${waitS}&chars=4000`,
      )) as Record<string, unknown>[]
      if (!Array.isArray(rows))
        throw new Error('the daemon answered the report view with something other than a list')
      const w = rows.find((x) => x.id === id)
      if (!w) return null
      return { status: String(w.status ?? ''), text: readText(w) }
    },
  }
}

function consultPrompt(e: CatalogEntry, question: string): string {
  return [
    `You are consulted as ${e.name}: ${e.when}`,
    `Full text: ${loadRef(e)}`,
    '',
    'Question:',
    question,
    '',
    'Answer in at most 300 words; read only; change nothing.',
  ].join('\n')
}

async function consult(dir: string, args: UseArgs, e: CatalogEntry, daemon: Daemon, now: Date) {
  const files = chatPaths(dir, args.chat)
  const job =
    args.job ?? (await daemon.dispatch(consultPrompt(e, args.question ?? ''), `Consult ${e.name}`))
  const r = await daemon.report(job, WAIT_S)
  const doc = readDoc(files.hydraMd)
  if (doc) {
    addPick(doc, e, 'consult')
    writeDoc(files.hydraMd, doc)
  }
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'consult', id: e.id, job }, now)
  if (!r || !TERMINAL.includes(r.status)) return { job, status: 'working' }
  return { job, status: r.status, text: r.text }
}

function become(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  const files = chatPaths(dir, args.chat)
  const doc = readDoc(files.hydraMd) ?? emptyDoc(now)
  doc.lead = leadLine(e)
  doc.updated = now.toISOString()
  writeDoc(files.hydraMd, doc)
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'become', id: e.id }, now)
  return { lead: doc.lead, text: loadText(e) }
}

function hire(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  const files = chatPaths(dir, args.chat)
  const doc = readDoc(files.hydraMd)
  if (doc) {
    addPick(doc, e, 'hire')
    writeDoc(files.hydraMd, doc)
  }
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'hire', id: e.id }, now)
  const path = loadRef(e)
  const prefix = `You are hired as ${e.name}: ${e.when}. Read your full text at ${path} before you start.`
  return { id: e.id, persona: path, prefix, question: args.question ?? null }
}

export async function use(dir: string, args: UseArgs, daemon: Daemon, now = new Date()) {
  const e = entryOf(dir, args.id)
  checkMode(e, args.mode)
  switch (args.mode) {
    case 'become':
      return become(dir, args, e, now)
    case 'consult':
      if (!args.job && !args.question) throw new Error('consult needs a question')
      return consult(dir, args, e, daemon, now)
    case 'hire':
      return hire(dir, args, e, now)
    case 'load':
      return { id: e.id, text: loadText(e) }
  }
}
