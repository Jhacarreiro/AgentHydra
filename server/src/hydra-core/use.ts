import type { CliMayteRole } from '../climayte-lib'
import { deskChats } from '../desk-client'
import { completionsApi } from '../mcp-client'
import { peopleAddon } from '../people-host'
import {
  type Caller,
  type ChatOfCaller,
  chatOfCaller,
  refuse,
  type SeatParent,
  untracedRefusal,
} from './caller'
import { type CatalogEntry, loadCatalog, loadText } from './catalog'

const GROUP = 'hydra-core'

export interface Report {
  status: string
  text: string | null
}

export interface Daemon {
  /** `persona`: the worker runs as that persona's seat (role seat). */
  dispatch(prompt: string, title: string, cwd: string, persona?: string): Promise<string>
  report(id: string, waitS: number): Promise<Report | null>
  /** A seat kept as a worker: its session resumes with `text`. */
  send(id: string, text: string): Promise<void>
  /** The completion registry (completions.ts): tells this chat when a seat it opened finishes. */
  completions?: {
    waitFor(input: { ticket: string; label: string; read: string; after: number }): Promise<unknown>
    seen(ticket: string): Promise<unknown>
  }
}

export type UseArgs = {
  chat: string
  id: string
  mode: 'become' | 'consult' | 'hire' | 'load'
  question?: string
  job?: string
  cwd?: string
  caller?: CliMayteRole
  /** The traced caller (mcp-core), for the refusal journal. */
  who?: Caller
  /** The Desk chat `chat` is, as the caller resolved it (null: none); undefined: use() resolves `chat` itself. */
  desk?: SeatParent | null
  /** Keys this chat was filed under before (caller.ts chatOfCaller). */
  aliases?: string[]
  /** Why this call has no seat (logged with a seatless consult or hire). */
  why?: string
}

function entryOf(dir: string, id: string): CatalogEntry {
  const entries = loadCatalog(dir).entries
  const name = id.startsWith('lead:') ? id.slice('lead:'.length) : null
  const e =
    entries.get(id) ??
    (name === null
      ? undefined
      : [...entries.values()].find((x) => x.kind === 'person' && x.name === name))
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
    completions: completionsApi,
    async dispatch(prompt, title, cwd, persona) {
      const seat = persona ? { role: 'seat', persona } : {}
      const reply = (await api('/api/corch/workers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          tasks: [{ prompt, title, kind: 'review', light: true, cwd, ...seat }],
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
    async send(id, text) {
      const r = (await api(`/api/corch/workers/${encodeURIComponent(id)}/send`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })) as { ok?: boolean; message?: string }
      if (!r?.ok)
        throw new Error(`the seat ${id} did not take the message: ${r?.message ?? 'no answer'}`)
    },
  }
}

/** The words a refused consult or hire gets back. They name no role (ROLES.md: a drone is never told it is one). */
export function refusalOf(mode: string, id: string): string {
  return `This session cannot ${mode} ${id}: ask whoever started you to ${mode} it.`
}

/** The chat a seat opens under: the one the caller resolved (mcp-core), or the Desk chat `chat` names. */
async function seatChat(args: UseArgs): Promise<ChatOfCaller> {
  if (args.desk !== undefined)
    return { key: args.chat, desk: args.desk, aliases: args.aliases ?? [] }
  const chats = (await deskChats().catch(() => null)) as SeatParent[] | null
  const who = { role: args.caller, worker: null, deskChat: null, why: null }
  return chatOfCaller(who, chats, args.chat)
}

export async function use(dir: string, args: UseArgs, daemon: Daemon, now = new Date()) {
  const e = entryOf(dir, args.id)
  checkMode(e, args.mode)
  if (args.mode === 'load') return { id: e.id, text: loadText(e) }
  const seatMode = args.mode === 'consult' || args.mode === 'hire'
  // Traced by mcp-core and still nobody: only a Prime opens seats, and this caller cannot show it is one.
  if (seatMode && args.who && !args.who.role)
    refuse(args.who, untracedRefusal(`${args.mode} ${e.id}`, args.who.why), {
      dir,
      chat: args.chat,
      mode: args.mode,
      id: e.id,
    })
  if (seatMode && (args.caller === 'drone' || args.caller === 'seat'))
    refuse(
      args.who ?? { role: args.caller, worker: null, deskChat: null, why: null },
      refusalOf(args.mode, e.id),
      { dir, chat: args.chat, mode: args.mode, id: e.id },
    )
  // A seat opens under the chat's Desk row; the add-on decides what a chat with none gets.
  const chat = seatMode ? await seatChat(args) : null
  const answer = await peopleAddon()?.useMode?.({
    dir,
    mode: args.mode,
    entry: e,
    args,
    chat,
    daemon,
    now,
  })
  if (answer == null)
    throw new Error(`no people on this PC: ${args.mode} ${e.id} needs the people add-on`)
  return answer
}
