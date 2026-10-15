// The CrAInium home: runs the people door (a command from ~/.agenthydra/people-store.json, else the private sue-dredd
// checkout's store/people-door.mjs). The verb is an argument, a put sends the record as JSON on stdin, and the door
// prints one JSON object. The door never deletes; neither does this home.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findSueDredd } from '../sue-dredd-home'
import { agentHydraDir } from './this-pc'
import { HomeUnavailable, type PeopleHome, type PersonRecord, type PersonSummary } from './types'

export const DOOR_ENTRY = join('store', 'people-door.mjs')
export const DOOR_TIMEOUT_MS = 30_000
const UNREACHABLE = 'CrAInium is not reachable right now. Nothing was changed.'

/** Splits a command line on spaces, keeping "quoted parts" together. */
export function splitCommand(line: string): string[] {
  const out: string[] = []
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '')
  return out
}

/** The door's argv: the settings file's `crainium.command`, else the private checkout's door run with this node. */
export function findDoor(
  opts: { home?: string; env?: Record<string, string | undefined>; appRoot?: string } = {},
): string[] | null {
  try {
    const file = join(agentHydraDir(opts.home), 'people-store.json')
    const c = (JSON.parse(readFileSync(file, 'utf8')) as { crainium?: { command?: unknown } })
      .crainium?.command
    const argv = Array.isArray(c)
      ? c.filter((x): x is string => typeof x === 'string' && x !== '')
      : typeof c === 'string'
        ? splitCommand(c)
        : []
    if (argv.length) return argv
  } catch {
    // floor-ok: no settings file means the private checkout, or no door
  }
  const root = opts.appRoot ?? join(import.meta.dir, '..', '..', '..')
  const checkout = findSueDredd(DOOR_ENTRY, opts.env ?? process.env, root)
  return checkout ? [process.execPath, join(checkout, DOOR_ENTRY)] : null
}

export interface DoorReply {
  ok?: boolean
  code?: string
  error?: string
  [k: string]: unknown
}

/** Runs the door once. Unreachable, a missing command and a timeout become HomeUnavailable. */
export function runDoor(
  argv: string[],
  verb: string[],
  stdin?: string,
  timeoutMs = DOOR_TIMEOUT_MS,
): Promise<DoorReply> {
  return new Promise((done, fail) => {
    const [cmd, ...args] = argv
    const child = execFile(
      cmd,
      [...args, ...verb],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
        let reply: DoorReply | null = null
        try {
          reply = JSON.parse(String(stdout).trim()) as DoorReply
        } catch {
          // floor-ok: no JSON means the door did not answer
        }
        const code = (err as { code?: unknown } | null)?.code
        if (code === 3 || reply?.code === 'unreachable')
          return fail(new HomeUnavailable(UNREACHABLE))
        if (!reply) {
          if (code === 'ENOENT' || (err as { killed?: boolean } | null)?.killed)
            return fail(new HomeUnavailable(UNREACHABLE))
          return fail(new Error('The CrAInium door gave no answer.'))
        }
        done(reply)
      },
    )
    child.stdin?.on('error', () => undefined)
    child.stdin?.end(stdin ?? '')
  })
}

const must = (r: DoorReply): DoorReply => {
  if (r.ok === false) throw new Error(`CrAInium said no: ${r.error ?? r.code ?? 'unknown'}`)
  return r
}

export function createCrainiumHome(argv: string[], timeoutMs = DOOR_TIMEOUT_MS): PeopleHome {
  return {
    kind: 'crainium',
    async list() {
      const r = must(await runDoor(argv, ['list'], undefined, timeoutMs))
      return (r.people ?? []) as PersonSummary[]
    },
    async get(id) {
      const r = must(await runDoor(argv, ['get', id], undefined, timeoutMs))
      return (r.record as PersonRecord | null | undefined) ?? null
    },
    async put(record) {
      const r = await runDoor(argv, ['put'], JSON.stringify(record), timeoutMs)
      // A stale put means CrAInium already has this person as new or newer: nothing to push.
      if (r.ok === false && r.code === 'stale') return
      must(r)
    },
    async delete() {
      // CrAInium keeps every row: a delete never reaches the door.
    },
  }
}

export interface DoorStatus {
  available: boolean
  owner?: string
  people?: number
  reason?: string
}

export async function doorStatus(argv: string[] | null, timeoutMs = 8000): Promise<DoorStatus> {
  if (!argv) return { available: false, reason: 'CrAInium is not set up on this PC.' }
  try {
    const r = await runDoor(argv, ['status'], undefined, timeoutMs)
    if (r.ok === false || r.reachable === false) return { available: false, reason: UNREACHABLE }
    return {
      available: true,
      owner: typeof r.owner === 'string' ? r.owner : undefined,
      people: typeof r.people === 'number' ? r.people : undefined,
    }
  } catch (e) {
    return { available: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
