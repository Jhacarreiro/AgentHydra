// The run board of the manager's central routines (routines/runs.ts says what a claim and a run event are; the CrAInium's
// board is routines/store-crainium.ts's). A routine shared between runners (its runsOn names no runner, and this one carries
// every label) is claimed slot by slot before it starts: the board grants a slot to the first runner that asks, with a lease
// of twice the routine's timeout that the holder renews while the run lives and ends when the run ends. A routine pinned to
// this runner needs no claim, so a board that does not answer holds back only the shared ones (they ask again at each look).
// Every central run, pinned or shared, is reported to the run log, best effort (what the board did not take is sent again
// before the next read), and the newest run of each central routine is read back for every computer's card.

import type { CentralRun, RoutineDefinition, RoutineRun, RoutineRunning, RunDescription } from '@shared/routines'
import type { Memory, SlotClaim } from './decide'
import type { Central } from './manager-central'
import type { Manager } from './manager'
import { message } from './proc'
import { foldRuns, runEvent, type Claim, type RunEvent, type RunFacts } from './runs'

/** The run log is read again at most this often, unless the page asks for a fresh look. */
export const RUNS_EVERY_MS = 60_000

/** A shared routine's lease: twice its timeout (in the manager's time scale), so a run that lives past its timeout is
 *  ended by its runner long before another runner may take its slot. */
const leaseMsOf = (m: Manager, def: RoutineDefinition): number => 2 * def.timeoutMinutes * 60_000 * m.timeoutScale

/** The central store of a central routine the last look saw (local files of the same id win, so they are never central). */
function centralOf(m: Manager, id: string): Central | null {
  return m.central && m.seen.some((s) => s.entry.id === id && s.entry.central) ? m.central : null
}

const facts = (c: Central, routine: string, slot: number | null, startedAt: number, at: number): RunFacts => ({
  store: c.config.repo,
  routine,
  runner: c.runner.id,
  slot,
  startedAt,
  at,
})

/** Sends run events to the run log; those it does not take wait in `unsent` for the next read. */
function report(c: Central, events: RunEvent[]): void {
  for (const e of events) {
    c.ownEvents.set(e.id, e)
    c.unsent.set(e.id, e)
  }
  void sendUnsent(c).catch(() => undefined)
}

async function sendUnsent(c: Central): Promise<void> {
  if (!c.unsent.size) return
  const batch = [...c.unsent.values()]
  try {
    await c.board.report(batch)
  } catch (err) {
    c.runsError = `the run log did not take this computer's runs: ${message(err)}`
    throw err
  }
  c.runsError = null
  // An event sent again meanwhile (a run's description) stays for the next send.
  for (const e of batch) if (c.unsent.get(e.id) === e) c.unsent.delete(e.id)
}

/** The routine's claim as the board answered it, kept in its memory: held by this runner for `asked`, or not. */
function keepClaim(mem: Memory, asked: number, claim: Claim, runner: string, at: number): SlotClaim {
  mem.claim = { asked, claim, mine: claim.holder === runner && claim.slot === asked && claim.endedAt === null, error: null, at }
  return mem.claim
}

/** Asks the run board for a shared routine's due slot: true when this runner holds it, and the run starts now. A slot the
 *  board says ran elsewhere, or that a newer claim passed, is behind the routine; any other answer waits for the next look
 *  (the board decides when a lapsed lease may be taken over). */
export async function claimSlot(m: Manager, def: RoutineDefinition, mem: Memory, slot: number): Promise<boolean> {
  const c = m.central
  if (!c) return false
  const t = m.clock()
  let claim: Claim
  try {
    claim = await c.board.claim({ routine: def.id, slot, runner: c.runner.id, leaseMs: leaseMsOf(m, def) })
  } catch (err) {
    mem.claim = { asked: slot, claim: null, mine: false, error: message(err), at: t }
    return false
  }
  const held = keepClaim(mem, slot, claim, c.runner.id, t)
  if (claim.slot > slot || (claim.slot === slot && claim.endedAt !== null)) mem.lastSlot = slot
  if (!held.mine) return false
  // The owner's Run now started a run while the board answered: that run is this slot's, so the claim ends (tendClaims).
  if (mem.running) {
    mem.lastSlot = slot
    return false
  }
  report(c, [runEvent('claimed', facts(c, def.id, slot, t, t))])
  return true
}

/** Ends the claim this runner holds on a routine's slot: its run ended. It is no longer held here while the board is asked
 *  (so it is asked once), and held again to be asked at the next look when the board does not answer. */
async function endClaim(c: Central, id: string, held: SlotClaim): Promise<void> {
  held.mine = false
  try {
    await c.board.end({ routine: id, slot: held.asked, runner: c.runner.id })
    held.error = null
  } catch (err) {
    held.mine = true
    held.error = message(err)
  }
}

/** The claims this runner holds: each one whose run lives is renewed once a quarter of its lease has passed (by this
 *  computer's clock); each one whose run ended, or never started here, is ended. */
export async function tendClaims(m: Manager): Promise<void> {
  const c = m.central
  if (!c) return
  const t = m.clock()
  for (const [id, mem] of Object.entries(m.memory)) {
    const held = mem.claim
    if (!held?.mine) continue
    if (mem.running?.slot !== held.asked) {
      await endClaim(c, id, held)
      continue
    }
    const def = m.seen.find((s) => s.entry.id === id)?.entry.def
    if (!def || t - held.at < leaseMsOf(m, def) / 4) continue
    try {
      keepClaim(mem, held.asked, await c.board.claim({ routine: id, slot: held.asked, runner: c.runner.id, leaseMs: leaseMsOf(m, def) }), c.runner.id, t)
    } catch (err) {
      held.error = message(err)
    }
  }
}

/** A central run started here: reported as routine.started. */
export function reportStarted(m: Manager, id: string, running: RoutineRunning): void {
  const c = centralOf(m, id)
  if (c) report(c, [runEvent('started', facts(c, id, running.slot ?? null, running.startedAt, running.startedAt))])
}

/** A central run ended here: reported as routine.ended, and a shared slot's claim ended. A run whose description is still
 *  being written is reported again once it is (reportDescribed). */
export function reportEnded(m: Manager, id: string, running: RoutineRunning | null, r: RoutineRun): void {
  const c = centralOf(m, id)
  if (!c) return
  const slot = running?.slot ?? null
  const ended = { endedAt: r.endedAt, outcome: r.outcome, exitCode: r.exitCode, lastLine: r.lastLine }
  const e = runEvent('ended', { ...facts(c, id, slot, r.startedAt, r.endedAt), ended })
  report(c, [e])
  if (r.description?.state === 'pending') c.describing.set(`${id}@${r.startedAt}`, e)
  const held = m.memory[id]?.claim
  if (slot !== null && held?.mine && held.asked === slot) void endClaim(c, id, held)
}

/** A central run's description, written after it ended: its routine.ended event goes again, with it. */
export function reportDescribed(m: Manager, id: string, r: RoutineRun, description: RunDescription): void {
  const c = m.central
  const e = c?.describing.get(`${id}@${r.startedAt}`)
  if (!c || !e) return
  c.describing.delete(`${id}@${r.startedAt}`)
  if (description.state === 'done') report(c, [{ ...e, data: { ...e.data, description: description.text } }])
}

/** Reads the run log's newest run of each routine, at most every RUNS_EVERY_MS unless forced; one read at a time. What this
 *  computer reported that the board did not take yet is sent first. A log that does not answer keeps what was read, with why. */
export function readRuns(c: Central, force: boolean, now: number): Promise<void> {
  if (c.runsReading) return c.runsReading
  if (!force && c.runsLastTry !== null && now - c.runsLastTry < RUNS_EVERY_MS) return Promise.resolve()
  c.runsLastTry = now
  c.runsReading = (async () => {
    try {
      const sent = await sendUnsent(c).then(
        () => true,
        () => false,
      )
      c.boardEvents = await c.board.latest()
      c.runsReadAt = now
      if (sent) c.runsError = null
      // This computer's own events stay only while they are newer than what the board answered.
      const held = new Set(c.boardEvents.map((e) => (e as { id?: unknown })?.id))
      const latest = foldRuns([...c.boardEvents, ...c.ownEvents.values()])
      for (const [id, e] of c.ownEvents) if (held.has(id) || latest.get(e.subject)?.key !== e.data.run) c.ownEvents.delete(id)
    } catch (err) {
      c.runsError = `the run log did not answer: ${message(err)}`
    }
  })().finally(() => (c.runsReading = null))
  return c.runsReading
}

/** A central routine's newest run, wherever it ran: the run log's, or this computer's newer one; null when none is known. */
export function latestRunOf(c: Central | null, id: string): CentralRun | null {
  if (!c) return null
  return foldRuns([...c.boardEvents, ...c.ownEvents.values()]).get(id)?.run ?? null
}
