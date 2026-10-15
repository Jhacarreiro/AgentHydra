import { ROUTINES_EVERY_MS, type RoutineProposal } from '@shared/routines'
import { judge, slotsOf, type Seen } from './decide'
import { parseProposalText, parseRoutineText, readEntries, type Entry } from './manifest'
import { message } from './proc'
import type { TaskReading } from './wintask'
import { PROMPT_LOOK_MS } from './manager-config'
import { enabled, memOf, readStatus, reportBroken, save, type Manager } from './manager'
import { settleCommands } from './manager-settle'
import { pollPrompts, recordTaskRun, startRun } from './manager-runs'
import { centralEntries, refreshCentral } from './manager-central'

/** Whether this computer reads and runs an entry: a local file, or a central routine placed here. */
export const runsHere = (e: Entry): boolean => !e.central || e.central.placed

/** A look soon after this one, for what the store just brought. */
function lookSoon(m: Manager): void {
  const soon = (): void => {
    if (!m.stopping) schedule(m, 1000)
  }
  if (m.looking) void m.looking.then(soon)
  else soon()
}

/** The central store's routines and proposals, from this computer's copy; the store is read again in the background
 *  (refreshCentral says how often), and a look follows when it brought a change. */
function centralRead(m: Manager, localIds: Set<string>): { entries: Entry[]; proposals: RoutineProposal[] } {
  const c = m.central
  if (!c) return { entries: [], proposals: [] }
  void refreshCentral(c, false, m.clock()).then((changed) => {
    if (changed) lookSoon(m)
  })
  return centralEntries(c, localIds)
}

/** Reads each routine's file, status and Windows task, and the central store's routines beside them. A windowsTask routine
 *  off Windows is broken; the tasks are read in one call; a central routine that runs elsewhere is listed, never read. */
async function readAll(m: Manager): Promise<{ seen: Seen[]; proposals: RoutineProposal[] }> {
  const local = readEntries(m.routinesDir, parseRoutineText)
  const localProposals = readEntries(m.proposedDir, parseProposalText)
  const central = centralRead(m, new Set([...local, ...localProposals].map((e) => e.id)))
  const entries = [...local, ...central.entries].map((e): Entry => {
    if (e.def?.windowsTask !== undefined && runsHere(e) && m.platform !== 'win32')
      return { id: e.id, def: null, broken: 'a Windows task runs only on Windows', ...(e.central ? { central: e.central } : {}) }
    return e
  })
  const names = [...new Set(entries.flatMap((e) => (e.def?.windowsTask !== undefined && runsHere(e) ? [e.def.windowsTask] : [])))]
  let readings: TaskReading[] = []
  let taskError: string | null = null
  if (names.length) {
    try {
      readings = await m.tasks.read(names)
    } catch (err) {
      taskError = `Windows could not read its tasks: ${message(err)}`
    }
  }
  const taskOf = new Map(readings.map((r) => [r.path, r]))
  const reads = await Promise.all(
    entries.map(async (entry): Promise<Seen> => {
      if (!runsHere(entry)) return { entry, reading: null, readError: null, task: null }
      const path = entry.def?.windowsTask
      if (path !== undefined) return { entry, reading: null, readError: taskError, task: taskOf.get(path) ?? null }
      const status = entry.def ? await readStatus(entry.def) : { reading: null, readError: null }
      return { entry, reading: status.reading, readError: status.readError, task: null }
    }),
  )
  const found = localProposals.flatMap((e) => (e.def ? [e.def] : []))
  return { seen: reads, proposals: [...found, ...central.proposals] }
}

/** One look: reads everything, judges, and starts the runs that fell due. One look at a time. */
export function look(m: Manager): Promise<void> {
  m.looking ??= (async () => {
    try {
      const t = m.clock()
      await pollPrompts(m, t)
      const read = await readAll(m)
      m.seen = read.seen
      m.proposals = read.proposals
      // After the read, so each run is settled against its routine's own file.
      await settleCommands(m)
      m.lastError = null
      m.checkedAt = t
      for (const s of m.seen) {
        reportBroken(m, s)
        const mem = memOf(m, s.entry, t)
        recordTaskRun(m, s, mem)
        const j = judge(s, mem, t, enabled(m), false)
        if (j.skipSlot !== null) mem.lastSlot = j.skipSlot
        if (j.start && s.entry.def) startRun(m, s.entry.def, mem, j.slot)
      }
      save(m)
    } catch (err) {
      m.lastError = `the last look failed: ${message(err)}`
      console.error('[routines] look failed:', err)
    } finally {
      schedule(m)
    }
  })().finally(() => (m.looking = null))
  return m.looking
}

/** The next look: in ROUTINES_EVERY_MS, or sooner for the earliest schedule slot (+1 s) or a prompt run being watched. */
export function schedule(m: Manager, delay?: number): void {
  clearTimeout(m.timer)
  m.timer = undefined
  m.nextCheckAt = null
  if (m.stopping) return
  const t = m.clock()
  let wait = delay ?? ROUTINES_EVERY_MS
  if (delay === undefined) {
    for (const s of m.seen) {
      if (!runsHere(s.entry)) continue
      const next = slotsOf(s.entry, t)?.next
      if (next != null) wait = Math.min(wait, next - t + 1000)
    }
    if (Object.values(m.memory).some((mem) => mem.running?.workerId)) wait = Math.min(wait, PROMPT_LOOK_MS)
  }
  wait = Math.max(wait, 1000)
  m.nextCheckAt = t + wait
  m.timer = setTimeout(() => void look(m), wait)
  // A look never keeps the process alive: Desk stopping stops it.
  ;(m.timer as { unref?: () => void }).unref?.()
}
