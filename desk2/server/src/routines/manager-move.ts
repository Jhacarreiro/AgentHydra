// Settings' Move to central (shared/routines.ts, "MOVING A ROUTINE"): the owner moves one of this computer's routine files
// into the central store, one at a time, from the window or by an agent on the owner's say. The move writes the routine to the store as a document pinned
// to this runner (routines/central.ts documentOf), so it would run here as it did, and marks it moving in
// <desk home>/routines-moving.json; the file keeps running meanwhile, and the document waits under Awaiting approval. The
// owner's approve signs the document into the store and retires the file (to routines/moved/) in the same step, so the
// routine runs from the store from then on and never from both: it keeps its id, and with it its memory (its runs, the
// newest slot it ran for, paused). The owner's discard retires the document, and the file runs on. A look finishes a move a
// trusted key approved elsewhere (or whose file could not be retired at the approve), and forgets one whose document left
// the store.

import { readFileSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RoutineDefinition } from '@shared/routines'
import { renameOverAsync } from '../write-flushed'
import { checkApproval, parseDoc } from './central'
import { parseRoutineText, ROUTINE_ID } from './manifest'
import { message } from './proc'
import type { Manager } from './manager'
import { groupStamp, writeWhole } from './manager-files'
import { approveMove, discardCentral, proposeMove, type Refusal } from './manager-central'

/** A move waiting for the owner: the sha its document was proposed with, and when (ms). */
interface Move {
  sha: string
  at: number
}

/** <desk home>/routines-moving.json: the moves waiting on this computer, by routine id. */
const marksFile = (m: Manager): string => join(m.ctx.home, 'routines-moving.json')

/** The moves waiting on this computer, by routine id. A file that does not read holds none: the files run on, and a move can
 *  start again. */
function moves(m: Manager): Map<string, Move> {
  let saved: Record<string, Partial<Move>> = {}
  try {
    saved = JSON.parse(readFileSync(marksFile(m), 'utf8')) as Record<string, Partial<Move>>
  } catch {
    return new Map()
  }
  return new Map(
    Object.entries(saved ?? {}).flatMap(([id, o]) =>
      ROUTINE_ID.test(id) && typeof o?.sha === 'string' && typeof o.at === 'number' ? [[id, { sha: o.sha, at: o.at }] as const] : [],
    ),
  )
}

const saveMoves = (m: Manager, all: Map<string, Move>): void => writeWhole(marksFile(m), Object.fromEntries(all))

/** Forgets the move of `id`. */
function forget(m: Manager, id: string): void {
  const all = moves(m)
  if (all.delete(id)) saveMoves(m, all)
}

/** The routines moving to the store: a mark here and the document in the store's copy. Their approve and discard are the
 *  move's, and their file takes no edit meanwhile (the document holds the file as it was moved). */
export function movingIds(m: Manager): Set<string> {
  const c = m.central
  return new Set(c ? [...moves(m).keys()].filter((id) => c.docs.has(id)) : [])
}

/** Takes the routine's file out of routines/ (into routines/moved/, kept, never read). Null when it is out, else why the file is
 *  still there. */
async function retire(m: Manager, id: string): Promise<string | null> {
  const moved = join(m.routinesDir, 'moved')
  try {
    await mkdir(moved, { recursive: true })
    await renameOverAsync(join(m.routinesDir, `${id}.json`), join(moved, `${id}-${groupStamp(m.clock())}.json`))
  } catch (err) {
    // A file already gone is out.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') return message(err)
  }
  return null
}

/** `move`: the owner's Move to central on a routine's card. Refused with no store, for a file that is missing or does not
 *  check out, for a routine moving already or whose id the store holds, and for one whose folder no document can name. */
export async function moveRoutine(m: Manager, id: string): Promise<Refusal | null> {
  const c = m.central
  if (!c) return { status: 400, error: `"${id}" was not moved: this computer reads no central store (${m.centralError ?? 'routines-store.json in its Desk home names one'})` }
  const file = join(m.routinesDir, `${id}.json`)
  let raw: string
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    return { status: 404, error: `no routine "${id}" is registered: routines/${id}.json is missing` }
  }
  if (movingIds(m).has(id)) return { status: 409, error: `"${id}" is moving already: approve or discard its move under Awaiting approval` }
  let def: RoutineDefinition
  try {
    def = parseRoutineText(id, raw)
  } catch (err) {
    return { status: 409, error: `"${id}" was not moved: its file does not check out: ${message(err)}` }
  }
  const proposed = await proposeMove(c, def, `Moved to the central store from routines/${id}.json on ${c.runner.id}, where it ran until this was approved.`)
  if ('status' in proposed) return proposed
  try {
    saveMoves(m, moves(m).set(id, { sha: proposed.sha, at: m.clock() }))
  } catch (err) {
    // Without its mark the document would sit beside the file as a problem: take it back out of the store.
    await discardCentral(c, id, m.clock())
    return { status: 500, error: `"${id}" was not moved: its move could not be marked on this computer: ${message(err)}` }
  }
  return null
}

/** The owner's yes to a move: the document signed into the store, then the file retired. A file that could not be retired
 *  runs on (the document waits beside it as a problem) until a look retires it. */
export async function approveMoving(m: Manager, id: string): Promise<Refusal | null> {
  const move = moves(m).get(id)
  if (!m.central || !move) return { status: 404, error: `no move of "${id}" is waiting` }
  const refused = await approveMove(m.central, id, move.sha, m.clock())
  if (refused) return refused
  const why = await retire(m, id)
  if (why) return { status: 500, error: `"${id}" is approved in the store, and routines/${id}.json could not be retired (${why}): the file runs until a look retires it` }
  forget(m, id)
  return null
}

/** The owner's no to a move: the document leaves the store, and the file runs on. */
export async function discardMoving(m: Manager, id: string): Promise<Refusal | null> {
  if (!m.central) return { status: 404, error: `no move of "${id}" is waiting` }
  const refused = await discardCentral(m.central, id, m.clock())
  if (refused) return refused
  forget(m, id)
  return null
}

/** Whether the document of a move is approved by a key this computer trusts. */
function approved(m: Manager, id: string): boolean {
  const cached = m.central?.docs.get(id)
  try {
    return !!cached && checkApproval(parseDoc(id, cached.text), m.central!.trusted).ok
  } catch {
    return false
  }
}

/** Before a look reads the files: a move whose document a trusted key approved retires its file, and one whose document left
 *  the store (a store read since the move no longer lists it) is forgotten, its file running on. */
export async function settleMoves(m: Manager): Promise<void> {
  const c = m.central
  if (!c) return
  const all = moves(m)
  let changed = false
  for (const [id, move] of all) {
    if (!c.docs.has(id)) {
      if (c.readAt !== null && c.readAt >= move.at) changed = all.delete(id)
    } else if (approved(m, id)) {
      const why = await retire(m, id)
      if (why) console.error(`[routines] the move of ${id} is approved, and its file could not be retired:`, why)
      else changed = all.delete(id)
    }
  }
  if (changed) saveMoves(m, all)
}
