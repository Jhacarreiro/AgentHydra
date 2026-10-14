import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { CliMayteRole } from '../climayte-lib'
import { replyWhenDone } from '../mcp-managers'
import { type CatalogEntry, loadCatalog, loadRef, loadText } from './catalog'
import { addPick, emptyDoc, type HydraDoc, leadLine, parseHydra, renderHydra } from './hydra-md'
import { appendLog } from './log'
import { chatPaths } from './paths'
import { openOrSend, seatOf } from './seats'

const WAIT_S = 30
const TERMINAL = ['done', 'failed', 'cancelled']
const GROUP = 'hydra-core'

export interface Report {
  status: string
  text: string | null
}

export interface Daemon {
  dispatch(prompt: string, title: string, cwd: string): Promise<string>
  report(id: string, waitS: number): Promise<Report | null>
}

export type UseArgs = {
  chat: string
  id: string
  mode: 'become' | 'consult' | 'hire' | 'load'
  question?: string
  job?: string
  cwd?: string
  caller?: CliMayteRole
}

type Files = ReturnType<typeof chatPaths>

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

function folderOf(files: Files, cwd: string | undefined): string {
  const folder = cwd || (existsSync(files.cwd) ? readFileSync(files.cwd, 'utf8').trim() : '')
  if (!folder) throw new Error('no folder: pass cwd, the calling chat has none')
  return folder
}

export function defaultDaemon(api: (path: string, init?: RequestInit) => Promise<unknown>): Daemon {
  return {
    async dispatch(prompt, title, cwd) {
      const reply = (await api('/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ prompt, title, kind: 'review', light: true, cwd }],
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

function pick(files: Files, e: CatalogEntry, mode: 'consult' | 'hire'): void {
  const doc = readDoc(files.hydraMd)
  if (!doc) return
  addPick(doc, e, mode)
  writeDoc(files.hydraMd, doc)
}

async function consult(dir: string, args: UseArgs, e: CatalogEntry, daemon: Daemon, now: Date) {
  const files = chatPaths(dir, args.chat)
  const job =
    args.job ??
    (await daemon.dispatch(
      consultPrompt(e, args.question ?? ''),
      `Consult ${e.name}`,
      folderOf(files, args.cwd),
    ))
  const r = await daemon.report(job, WAIT_S)
  pick(files, e, 'consult')
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'consult', id: e.id, job }, now)
  if (!r || !TERMINAL.includes(r.status)) return { job, status: 'working' }
  return { job, status: r.status, text: r.text }
}

async function seatConsult(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  if (!args.question) {
    const seat = seatOf(dir, args.chat, e)
    if (!seat) throw new Error(`${e.id} has no seat in this chat yet: consult it with a question`)
    const r = await replyWhenDone({ id: seat.chat, title: seat.title }, null, WAIT_S)
    return r.status === 'done'
      ? { seat, status: 'done', reply: r.reply }
      : { seat, status: 'working', read: `core_use { chat, id: "${e.id}", mode: "consult" }` }
  }
  const { seat, sentAfter } = await openOrSend(dir, args.chat, e, args.question, args.cwd)
  pick(chatPaths(dir, args.chat), e, 'consult')
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'consult', id: e.id, seat: seat.chat }, now)
  const r = await replyWhenDone({ id: seat.chat, title: seat.title }, sentAfter, WAIT_S)
  return r.status === 'done'
    ? { seat, status: 'done', reply: r.reply }
    : { seat, status: 'working', read: `core_use { chat, id: "${e.id}", mode: "consult" }` }
}

async function seatHire(dir: string, args: UseArgs, e: CatalogEntry, now: Date) {
  if (!args.job) throw new Error('hire needs a job: say what the seat does')
  const { seat } = await openOrSend(dir, args.chat, e, args.job, args.cwd)
  pick(chatPaths(dir, args.chat), e, 'hire')
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'hire', id: e.id, seat: seat.chat }, now)
  return { status: 'started', seat }
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
  pick(files, e, 'hire')
  appendLog(dir, { chat: args.chat, event: 'use', mode: 'hire', id: e.id }, now)
  const path = loadRef(e)
  const prefix = `You are hired as ${e.name}: ${e.when}. Read your full text at ${path} before you start.`
  return { id: e.id, persona: path, prefix, question: args.question ?? null }
}

export async function use(dir: string, args: UseArgs, daemon: Daemon, now = new Date()) {
  const e = entryOf(dir, args.id)
  checkMode(e, args.mode)
  if (
    (args.mode === 'consult' || args.mode === 'hire') &&
    (args.caller === 'drone' || args.caller === 'seat')
  )
    throw new Error(
      `A ${args.caller} cannot ${args.mode} ${e.id}: ask your Prime chat to ${args.mode} it.`,
    )
  switch (args.mode) {
    case 'become':
      return become(dir, args, e, now)
    case 'consult':
      if (args.caller === 'prime') return seatConsult(dir, args, e, now)
      if (!args.job && !args.question) throw new Error('consult needs a question')
      return consult(dir, args, e, daemon, now)
    case 'hire':
      if (args.caller === 'prime') return seatHire(dir, args, e, now)
      return hire(dir, args, e, now)
    case 'load':
      return { id: e.id, text: loadText(e) }
  }
}
