// The routines' definitions (shared/routines.ts says what the contract is). One file per routine in <desk home>/routines:
// a file that checks out is a routine to look at and run; one that does not is listed as 'broken' with its reason and
// never run. Proposals (<desk home>/routines/proposed) are checked the same way, plus their `why`. Nothing here runs a
// command or reads a clock.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RoutineDefinition, RoutineKind, RoutineProposal } from '@shared/routines'
import { momentOf, parseCron, systemZone } from './cron'

export const ROUTINE_ID = /^[a-z0-9][a-z0-9-]{0,39}$/
export const TIMEOUT_MIN = 5
export const TIMEOUT_MAX = 360
export const TIMEOUT_DEFAULT = 120
const ASKED_MAX = 500
const WHY_MAX = 500

/** Where a central routine runs, seen from this computer (routines/central.ts placementOf): pinned here, shared by every
 *  runner its labels match, or elsewhere. */
export type Placement = 'here' | 'shared' | 'elsewhere'

/** Where a central routine (routines/central.ts) is kept and where it runs: its document's path and the sha of its text in
 *  the store, its runner labels, where they place it (and why not here), and a schedule's time zone. */
export interface CentralMark {
  path: string
  docSha: string
  runsOn: string[]
  placement: Placement
  why: string | null
  timeZone?: string
}

/** One <id>.json in a folder: its definition, or the reason it is broken (and its `name`, when the file still says one).
 *  A central routine's entry carries its `central` mark. */
export type Entry<T extends RoutineDefinition = RoutineDefinition> =
  | { id: string; def: T; broken: null; central?: CentralMark }
  | { id: string; def: null; broken: string; name?: string; central?: CentralMark }

/** The name a file that does not check out still gives itself, so its card keeps its name rather than its file's. */
function nameIn(raw: string): string | undefined {
  try {
    const name = (JSON.parse(raw) as { name?: unknown } | null)?.name
    return typeof name === 'string' && name.trim() ? name.trim() : undefined
  } catch {
    return undefined
  }
}

const isArgv = (v: unknown): v is string[] => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === 'string' && s.length > 0)
const text = (v: unknown, key: string): string => {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`"${key}" must be a non-empty string`)
  return v.trim()
}

/** The keys this contract knows; `tick` is refused with its replacement. */
const KEYS = ['name', 'askedBy', 'schedule', 'status', 'windowsTask', 'run', 'prompt', 'cwd', 'timeoutMinutes', 'until', 'describe', 'modes']
/** A mode option: what the card shows (first letter capitalised) and what `modes.set` is handed. */
export const MODE_OPTION = /^[a-z][a-z0-9-]{0,19}$/
const MODES_MIN = 2
const MODES_MAX = 5

/** The object a routine file holds, or the reason it does not hold one. */
function objectOf(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('the file must hold one JSON object')
  return value as Record<string, unknown>
}

/** The one of `schedule`, `status` or `windowsTask` the object holds: how the routine decides when it runs. */
function whenOf(o: Record<string, unknown>): string {
  const whens = ['schedule', 'status', 'windowsTask'].filter((k) => o[k] !== undefined)
  if (whens.length !== 1) throw new Error('a routine has exactly one of "schedule", "status" or "windowsTask"')
  return whens[0]
}

/** Sets the `when` field the object holds (a cron expression, a status command or a Windows task), checked. */
function setWhen(def: RoutineDefinition, o: Record<string, unknown>, when: string): void {
  if (when === 'schedule') {
    if (typeof o.schedule !== 'string') throw new Error('"schedule" must be a cron expression in a string')
    parseCron(o.schedule)
    def.schedule = o.schedule.trim()
  } else if (when === 'status') {
    if (!isArgv(o.status)) throw new Error('"status" must be a command: a list of strings, the program first (run with no shell)')
    def.status = o.status
  } else {
    if (typeof o.windowsTask !== 'string' || !o.windowsTask.startsWith('\\') || o.windowsTask.length < 2)
      throw new Error('"windowsTask" must be the full path of a Windows task, e.g. "\\Example nightly job"')
    def.windowsTask = o.windowsTask
  }
}

/** What a routine runs: a Windows task runs nothing of ours, the others run a command or an AI prompt, never both. */
function setRunOrPrompt(def: RoutineDefinition, o: Record<string, unknown>, when: string): void {
  if (when === 'windowsTask') {
    if (o.run !== undefined || o.prompt !== undefined) throw new Error('a windowsTask routine has no "run" or "prompt": Windows runs it')
    return
  }
  if ((o.run !== undefined) === (o.prompt !== undefined)) throw new Error('a schedule or status routine has exactly one of "run" (a command) or "prompt" (an AI run)')
  if (o.run !== undefined) {
    if (!isArgv(o.run)) throw new Error('"run" must be a command: a list of strings, the program first (run with no shell)')
    def.run = o.run
  } else def.prompt = text(o.prompt, 'prompt')
}

function setTimeoutMinutes(def: RoutineDefinition, o: Record<string, unknown>): void {
  if (o.timeoutMinutes === undefined) return
  const minutes = o.timeoutMinutes
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < TIMEOUT_MIN || minutes > TIMEOUT_MAX)
    throw new Error(`"timeoutMinutes" must be a number from ${TIMEOUT_MIN} to ${TIMEOUT_MAX}`)
  def.timeoutMinutes = minutes
}

function setUntil(def: RoutineDefinition, o: Record<string, unknown>): void {
  if (o.until === undefined) return
  if (typeof o.until !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.until) || untilEndOf(o.until) === null)
    throw new Error('"until" must be a day, YYYY-MM-DD')
  def.until = o.until
}

function setDescribe(def: RoutineDefinition, o: Record<string, unknown>, when: string): void {
  if (o.describe === undefined) return
  if (typeof o.describe !== 'boolean') throw new Error('"describe" must be true or false')
  if (when === 'windowsTask' && o.describe) throw new Error('a windowsTask routine is not described: Windows runs it, and its output never reaches the manager')
  def.describe = o.describe
}

/** A status routine's `modes`: its options and the command that takes one. Only a status routine has them: its status is
 *  what says which one is in force. */
function setModes(def: RoutineDefinition, o: Record<string, unknown>, when: string): void {
  if (o.modes === undefined) return
  if (when !== 'status') throw new Error('only a status routine has "modes": its status says which one is in force')
  const modes = o.modes as Record<string, unknown> | null
  const shape = `"modes" must be { "options": ${MODES_MIN} to ${MODES_MAX} different names (a-z, 0-9 and -, starting with a letter), "set": a command }`
  if (!modes || typeof modes !== 'object' || Array.isArray(modes) || Object.keys(modes).some((k) => k !== 'options' && k !== 'set')) throw new Error(shape)
  const options = modes.options
  if (!Array.isArray(options) || options.length < MODES_MIN || options.length > MODES_MAX) throw new Error(shape)
  if (!options.every((x) => typeof x === 'string' && MODE_OPTION.test(x)) || new Set(options).size !== options.length) throw new Error(shape)
  if (!isArgv(modes.set)) throw new Error('"modes.set" must be a command: a list of strings, the program first (run with no shell)')
  def.modes = { options: options as string[], set: modes.set }
}

/** The definition in `value`, checked; `allowed` names extra keys that are not part of it (a proposal's `why`). Throws with the reason. */
export function checkDefinition(id: string, value: unknown, allowed: readonly string[] = []): RoutineDefinition {
  if (!ROUTINE_ID.test(id)) throw new Error('the id is the file name: 1 to 40 of a-z, 0-9 and -, starting with a letter or digit')
  const o = objectOf(value)
  if ('tick' in o) throw new Error('"tick" is gone: a routine that runs a command says "run" (an argv list)')
  for (const key of Object.keys(o)) if (!KEYS.includes(key) && !allowed.includes(key)) throw new Error(`unknown key "${key}"`)

  const name = text(o.name, 'name')
  const askedBy = text(o.askedBy, 'askedBy')
  if (askedBy.length > ASKED_MAX) throw new Error(`"askedBy" must be at most ${ASKED_MAX} characters`)

  const when = whenOf(o)
  const def: RoutineDefinition = { id, name, askedBy, timeoutMinutes: TIMEOUT_DEFAULT }
  setWhen(def, o, when)
  setRunOrPrompt(def, o, when)

  if (o.cwd !== undefined) def.cwd = text(o.cwd, 'cwd')
  if (def.prompt !== undefined && def.cwd === undefined) throw new Error('a prompt routine needs "cwd": the folder its chat works in')

  setTimeoutMinutes(def, o)
  setUntil(def, o)
  setDescribe(def, o, when)
  setModes(def, o, when)
  return def
}

/** The end of a `until` day (YYYY-MM-DD in `zone`, this computer's unless given), in ms: the start of the next day. Null when
 *  the text is not a real day. */
export function untilEndOf(day: string, zone: string = systemZone()): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const start = new Date(Date.UTC(y, mo - 1, d))
  if (start.getUTCFullYear() !== y || start.getUTCMonth() !== mo - 1 || start.getUTCDate() !== d) return null
  return momentOf(zone, Date.UTC(y, mo - 1, d + 1))
}

/** A routine file's text, checked. Throws with the reason. */
export function parseRoutineText(id: string, raw: string): RoutineDefinition {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error('the file is not JSON')
  }
  return checkDefinition(id, body)
}

/** A proposal's text, checked: the definition plus its `why`. Throws with the reason. */
export function parseProposalText(id: string, raw: string): RoutineProposal {
  let body: unknown
  try {
    body = JSON.parse(raw)
  } catch {
    throw new Error('the file is not JSON')
  }
  return checkProposal(id, body)
}

/** A proposal's object (from the API or a file), checked: the definition plus a required `why`. */
export function checkProposal(id: string, value: unknown): RoutineProposal {
  const def = checkDefinition(id, value, ['why'])
  const why = text((value as Record<string, unknown>).why, 'why')
  if (why.length > WHY_MAX) throw new Error(`"why" must be at most ${WHY_MAX} characters`)
  return { ...def, why }
}

/** The kind a definition is: how it decides when it runs. */
export function kindOf(def: RoutineDefinition): RoutineKind {
  if (def.schedule !== undefined) return 'schedule'
  if (def.status !== undefined) return 'status'
  return 'windowsTask'
}

/** Every *.json in a folder, checked with `parse`, by file name. A missing folder has none. */
export function readEntries<T extends RoutineDefinition>(dir: string, parse: (id: string, raw: string) => T): Entry<T>[] {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return []
  }
  return files
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f): Entry<T> => {
      const id = f.slice(0, -'.json'.length)
      let raw = ''
      try {
        raw = readFileSync(join(dir, f), 'utf8')
        return { id, def: parse(id, raw), broken: null }
      } catch (err) {
        return { id, def: null, broken: err instanceof Error ? err.message : String(err), name: nameIn(raw) }
      }
    })
}
