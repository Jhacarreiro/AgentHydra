import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Context } from 'hono'
import type { RoutineProposal, RoutineProposalRequest, RoutinesRequest } from '@shared/routines'
import { callerKind } from '../caller'
import { judge } from './decide'
import { checkDefinition, checkProposal, parseProposalText, ROUTINE_ID } from './manifest'
import { lastLineOf, message, runArgv } from './proc'
import { enabled, memOf, readStatus, save, type Manager } from './manager'
import { contractOf, writeWhole } from './manager-files'
import { look, runsHere } from './manager-look'
import { startRun } from './manager-runs'
import { status } from './manager-view'
import { approveCentral, discardCentral, editCentral, proposeCentral, type Refusal } from './manager-central'

/** The actions a caller may ask for, one per call; and those only the window may ask for. */
const ACTIONS = ['run', 'pause', 'resume', 'approve', 'discard', 'propose', 'edit', 'mode'] as const
type ActionName = (typeof ACTIONS)[number]
const OWNER_ACTIONS: readonly string[] = ['resume', 'approve', 'discard', 'edit', 'mode']
const OWNER_ONLY = { error: 'only the owner can do that, in Settings > Managers > Routines' }
const SHAPE =
  'the body must be JSON: { "enabled"?: true | false, "run"?: "<id>", "pause"?: "<id>", "resume"?: "<id>", "approve"?: "<id>", "discard"?: "<id>", "propose"?: { "id", "why", ...the contract, and for the central store "store": "central" with "runsOn", "timeZone" and "workdir" }, "edit"?: { "id": "<id>", "set": { ...contract keys, null removes one } }, "mode"?: { "id": "<id>", "value": "<one of its modes>" } }, one action per call besides "enabled"'
/** How long a routine's `modes.set` command may take. */
const MODE_MS = 60_000

/** POST /api/routines: does one action (or turns the manager on or off with `enabled`). */
export async function postRoutine(m: Manager, c: Context) {
  const body = (await c.req.json().catch(() => null)) as RoutinesRequest | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return c.json({ error: SHAPE }, 400)
  const actions = ACTIONS.filter((k) => body[k] !== undefined)
  if (!wellFormed(body, actions)) return c.json({ error: SHAPE }, 400)
  const owner = callerKind(c.req.raw.headers) === 'window'
  const [action] = actions
  if (body.enabled !== undefined && !owner) return c.json(OWNER_ONLY, 403)
  if (action !== undefined && OWNER_ACTIONS.includes(action) && !owner) return c.json(OWNER_ONLY, 403)
  const id = action === 'propose' ? '' : action === 'edit' ? body.edit!.id : action === 'mode' ? body.mode!.id : (body[action as 'run'] ?? '')
  if (action !== undefined && action !== 'propose' && !ROUTINE_ID.test(id)) return c.json({ error: `"${id}" is not a routine id` }, 400)

  if (body.enabled !== undefined && body.enabled !== m.ctx.settings().routines) m.ctx.updateSettings({ routines: body.enabled })
  if (body.enabled === true) await look(m)
  if (action === undefined) return c.json(status(m))

  const t = m.clock()
  switch (action) {
    case 'run':
      return runRoutine(m, c, id, t)
    case 'pause':
    case 'resume':
      return pauseOrResume(m, c, action, id, t)
    case 'edit':
      return editRoutine(m, c, body.edit!)
    case 'mode':
      return setMode(m, c, body.mode!)
    case 'propose':
      return proposeRoutine(m, c, body)
    default:
      return decideProposal(m, c, action, id)
  }
}

/** Whether one action carries the value it takes. */
function typedAction(body: RoutinesRequest, k: ActionName): boolean {
  if (k === 'propose') return typeof body.propose === 'object' && body.propose !== null
  if (k === 'edit') return typeof body.edit?.id === 'string' && typeof body.edit.set === 'object' && body.edit.set !== null && !Array.isArray(body.edit.set)
  if (k === 'mode') return typeof body.mode?.id === 'string' && typeof body.mode.value === 'string'
  return typeof body[k] === 'string'
}

/** A body with one action (or `enabled` alone), each action with the value it takes. */
function wellFormed(body: RoutinesRequest, actions: ActionName[]): boolean {
  const typed = actions.every((k) => typedAction(body, k))
  return !(
    (body.enabled !== undefined && typeof body.enabled !== 'boolean') ||
    actions.length > 1 ||
    (actions.length === 0 && body.enabled === undefined) ||
    !typed
  )
}

/** `run`: a Windows task runs through Windows; any other routine starts now, when its judge says it may. */
async function runRoutine(m: Manager, c: Context, id: string, t: number) {
  await look(m)
  const s = m.seen.find((x) => x.entry.id === id)
  if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
  const def = s.entry.def
  const mem = memOf(m, s.entry, t)
  if (def?.windowsTask !== undefined) {
    const j = judge(s, mem, t, enabled(m), false)
    if (j.state !== 'idle') return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
    try {
      await m.tasks.run(def.windowsTask)
    } catch (err) {
      return c.json({ error: `Windows refused to run "${id}": ${message(err)}` }, 500)
    }
    await look(m)
    return c.json(status(m))
  }
  const j = judge(s, mem, t, enabled(m), true)
  if (!j.start || !def) return c.json({ error: `"${id}" is ${j.state}: ${j.reason}` }, 409)
  startRun(m, def, mem, null)
  return c.json(status(m))
}

/** The ids of this computer's routine and proposal files. */
function localIds(m: Manager): Set<string> {
  const ids = (dir: string): string[] => {
    try {
      return readdirSync(dir).flatMap((f) => (f.endsWith('.json') ? [f.slice(0, -'.json'.length)] : []))
    } catch {
      return []
    }
  }
  return new Set([...ids(m.routinesDir), ...ids(m.proposedDir)])
}

/** A central action's answer: its refusal, or a look and the new status. */
async function centrally(m: Manager, c: Context, done: Promise<Refusal | null>) {
  const refused = await done
  if (refused) return c.json({ error: refused.error }, refused.status)
  await look(m)
  return c.json(status(m))
}

/** Whether `id` is a central document and no file on this computer has it: the action goes to the store. */
const isCentral = (m: Manager, id: string, file: string): boolean => !!m.central?.docs.has(id) && !existsSync(file)

async function pauseOrResume(m: Manager, c: Context, action: 'pause' | 'resume', id: string, t: number) {
  const s = m.seen.find((x) => x.entry.id === id)
  if (!s) return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing` }, 404)
  if (!runsHere(s.entry)) return c.json({ error: `"${id}" runs on ${s.entry.central?.runsOn.join(', ')}, not on this computer: ${action} it there` }, 409)
  const path = s.entry.def?.windowsTask
  if (path !== undefined) {
    try {
      await m.tasks.setEnabled(path, action === 'resume')
    } catch (err) {
      return c.json({ error: `Windows refused to ${action} "${id}": ${message(err)}` }, 500)
    }
  } else {
    memOf(m, s.entry, t).paused = action === 'pause'
    save(m)
  }
  await look(m)
  return c.json(status(m))
}

/** `edit`: the owner's edit (its Edit form, its Describe runs switch) writes the routine's own file: the keys `set` names,
 *  null removing one, every other key as it was. One that would not check out is refused and the file left alone. */
async function editRoutine(m: Manager, c: Context, edit: NonNullable<RoutinesRequest['edit']>) {
  const id = edit.id
  const routineFile = join(m.routinesDir, `${id}.json`)
  if (isCentral(m, id, routineFile)) return centrally(m, c, editCentral(m.central!, id, edit.set, m.clock()))
  let raw: Record<string, unknown>
  try {
    raw = JSON.parse(readFileSync(routineFile, 'utf8')) as Record<string, unknown>
  } catch {
    return c.json({ error: `no routine "${id}" is registered: routines/${id}.json is missing or not JSON` }, 404)
  }
  const next: Record<string, unknown> = { ...raw }
  for (const [key, value] of Object.entries(edit.set)) {
    if (value === null) delete next[key]
    else next[key] = value
  }
  try {
    checkDefinition(id, next)
  } catch (err) {
    return c.json({ error: `"${id}" was not saved: ${message(err)}` }, 409)
  }
  writeWhole(routineFile, next)
  await look(m)
  return c.json(status(m))
}

/** `mode`: the owner's pick on the card's Mode row. The routine's own `modes.set` takes it (its argv, the option appended),
 *  and its status, read again, says the mode now in force; the manager keeps no mode of its own. */
async function setMode(m: Manager, c: Context, pick: NonNullable<RoutinesRequest['mode']>) {
  const s = m.seen.find((x) => x.entry.id === pick.id)
  const def = s?.entry.def
  if (!s || !def) return c.json({ error: `no routine "${pick.id}" is registered, or its file does not check out` }, 404)
  if (!runsHere(s.entry)) return c.json({ error: `"${pick.id}" runs on ${s.entry.central?.runsOn.join(', ')}, not on this computer: set its mode there` }, 409)
  if (!def.modes) return c.json({ error: `"${pick.id}" has no modes` }, 400)
  if (!def.modes.options.includes(pick.value)) return c.json({ error: `"${pick.value}" is not one of ${def.modes.options.join(', ')}` }, 400)
  let output = ''
  const r = await runArgv([...def.modes.set, pick.value], { cwd: def.cwd, timeoutMs: MODE_MS, onOutput: (text) => (output = (output + text).slice(-4000)) })
  if (r.timedOut || r.error !== null || r.code !== 0) {
    const why = r.timedOut ? 'it timed out after 60 seconds' : r.error !== null ? `it could not start: ${r.error}` : `it exited ${r.code ?? 'without a code'}`
    const line = lastLineOf(output)
    return c.json({ error: `"${pick.id}" did not take ${pick.value}: ${why}${line ? ` (${line})` : ''}` }, 500)
  }
  const fresh = await readStatus(def)
  m.seen = m.seen.map((x) => (x.entry.id === pick.id ? { ...x, ...fresh } : x))
  return c.json(status(m))
}

async function proposeRoutine(m: Manager, c: Context, body: RoutinesRequest) {
  const raw = body.propose as unknown as Record<string, unknown>
  if (raw.store !== undefined) {
    if (raw.store !== 'central') return c.json({ error: 'the proposal is refused: "store" is "central", or left out for this computer' }, 400)
    if (!m.central) return c.json({ error: `the proposal is refused: this computer reads no central store (${m.centralError ?? 'routines-store.json in its Desk home names one'})` }, 400)
    return centrally(m, c, proposeCentral(m.central, raw as unknown as RoutineProposalRequest, localIds(m)))
  }
  const pid = typeof raw.id === 'string' ? raw.id : ''
  let proposal: RoutineProposal
  try {
    const rest = { ...raw }
    delete rest.id
    proposal = checkProposal(pid, rest)
  } catch (err) {
    return c.json({ error: `the proposal is refused: ${message(err)}` }, 400)
  }
  if (existsSync(join(m.routinesDir, `${pid}.json`)) || existsSync(join(m.proposedDir, `${pid}.json`)) || m.central?.docs.has(pid))
    return c.json({ error: `"${pid}" already exists as a routine or a proposal` }, 409)
  mkdirSync(m.proposedDir, { recursive: true })
  writeWhole(join(m.proposedDir, `${pid}.json`), contractOf(proposal))
  await look(m)
  return c.json(status(m))
}

/** approve and discard: the window only (checked in postRoutine). Each acts on the proposal file of that id. */
async function decideProposal(m: Manager, c: Context, action: 'approve' | 'discard', id: string) {
  const proposal = join(m.proposedDir, `${id}.json`)
  if (isCentral(m, id, proposal))
    return centrally(m, c, action === 'approve' ? approveCentral(m.central!, id, localIds(m), m.clock()) : discardCentral(m.central!, id, m.clock()))
  if (!existsSync(proposal)) return c.json({ error: `no proposal "${id}" is waiting` }, 404)
  if (action === 'discard') {
    rmSync(proposal, { force: true })
    await look(m)
    return c.json(status(m))
  }
  if (existsSync(join(m.routinesDir, `${id}.json`))) return c.json({ error: `a routine "${id}" already exists` }, 409)
  let approved: RoutineProposal
  try {
    approved = parseProposalText(id, readFileSync(proposal, 'utf8'))
  } catch (err) {
    return c.json({ error: `the proposal does not check out: ${message(err)}` }, 400)
  }
  const body2 = contractOf(approved)
  delete body2.why
  writeWhole(join(m.routinesDir, `${id}.json`), body2)
  rmSync(proposal, { force: true })
  await look(m)
  return c.json(status(m))
}
