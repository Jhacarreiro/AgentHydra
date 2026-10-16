// The seats a chat opened (its sub-chats: Hydra Core seats and sub-managers, each a Desk chat whose parentId is this
// chat), summed up for the parent's own view (owner, 2026-10-16: "why doesn't the parent get the aggregate of the
// personas? Like three agents, two personas working. Expected timeline"). The sidebar nests them under the parent;
// this is the line the parent's transcript shows under its last message (SeatsRow.vue). Pure, so it is tested.
import type { ChatSummary, CliMayteWorker } from '@shared/protocol'
import { chatWorkers } from '@/components/climayte/dock'
import { etaLeft, minutesText } from './logic'

export type SeatState = 'needs_you' | 'working' | 'error' | 'limited' | 'idle'

export interface Seat {
  id: string
  name: string
  state: SeatState
  /** What it is doing now (the chat's activity line), for the name's hover. */
  activity: string | null
}

export interface SeatGroup {
  state: SeatState
  /** What the names in it are doing: 'working', 'needs you' / 'need you'. */
  verb: string
  seats: Seat[]
}

export interface SeatsSummary {
  total: number
  /** The seats that are not idle, by state: needs you first, then working, error, usage limit. */
  groups: SeatGroup[]
  /** The CliMayte workers the seats started that are still active (each seat's own worker left out). */
  agents: number
  /** When the latest still-working estimate runs out (epoch ms), among those workers and the seats themselves (a Hydra
   *  Core seat writes an `ETA:` line for each message, the daemon's SEAT_ETA_INSTRUCTION); null when none gave one. */
  etaEndsAt: number | null
  /** When the earliest working seat began: its turn, or its oldest active worker; null when none works. */
  since: number | null
}

const ORDER: SeatState[] = ['needs_you', 'working', 'error', 'limited']

const verbOf = (state: SeatState, n: number): string =>
  state === 'needs_you' ? (n === 1 ? 'needs you' : 'need you') : state === 'error' ? 'stopped on an error' : state === 'limited' ? 'waiting on usage' : 'working'

/** The seat's persona name, else its title before ' · ' (a seat's title is 'Ava · <the task>'). */
const nameOf = (c: ChatSummary): string => c.manager?.name || c.title.split(' · ')[0]!.trim() || c.title

function stateOf(c: ChatSummary): SeatState {
  if (c.status === 'needs_you' || c.pendingCount > 0) return 'needs_you'
  if (c.status === 'error') return 'error'
  if (c.status === 'limited') return 'limited'
  if (c.status === 'working' || c.status === 'starting' || c.climayteActive > 0 || (c.backgroundActive ?? 0) > 0) return 'working'
  return 'idle'
}

const etaEnd = (w: CliMayteWorker): number | null => (w.active && w.eta && w.eta.tookS === null ? w.eta.at + w.eta.minutes * 60_000 : null)

const maxOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.max(...ok) : null
}
const minOf = (xs: (number | null)[]): number | null => {
  const ok = xs.filter((x): x is number => x !== null)
  return ok.length ? Math.min(...ok) : null
}

/** The seats under `parent` (those in the same list as it, live or archived, as the sidebar nests them), or null with none. */
export function seatsOf(parent: Pick<ChatSummary, 'id' | 'archived'>, chats: readonly ChatSummary[], workers: readonly CliMayteWorker[]): SeatsSummary | null {
  const kids = chats.filter((c) => c.parentId === parent.id && c.archived === parent.archived).sort((a, b) => a.createdAt - b.createdAt)
  if (!kids.length) return null
  const seats = kids.map((c): Seat => ({ id: c.id, name: nameOf(c), state: stateOf(c), activity: c.activity }))
  const groups = ORDER.flatMap((state) => {
    const of = seats.filter((s) => s.state === state)
    return of.length ? [{ state, verb: verbOf(state, of.length), seats: of }] : []
  })
  const started = kids.map((c) => ({ c, ws: chatWorkers([...workers], c.sessionId, c.workerIds).filter((w) => w.active && w.id !== c.workerId) }))
  const live = started.flatMap((s) => s.ws)
  // The worker each seat runs as: its own estimate for the message it is on.
  const own = workers.filter((w) => kids.some((c) => c.workerId === w.id))
  const working = started.filter((s) => stateOf(s.c) === 'working')
  return {
    total: kids.length,
    groups,
    agents: live.length,
    etaEndsAt: maxOf([...live, ...own].map(etaEnd)),
    since: minOf(working.flatMap((s) => [s.c.turnStartedAt, ...s.ws.map((w) => w.startedAt)]))
  }
}

/** '3 seats', '1 seat'. */
export const seatCount = (n: number): string => `${n} ${n === 1 ? 'seat' : 'seats'}`

/** How long the seats' work has run: '1 h 20 min so far', 'just started'. */
export function soFar(since: number, now: number): string {
  const min = Math.floor((now - since) / 60_000)
  return min < 1 ? 'just started' : `${minutesText(min)} so far`
}

/** What follows the names: 'N agents running', then the estimate ('about 1 h 20 min left'), else how long the work has run. */
export function seatsTail(s: SeatsSummary, now: number): string[] {
  const agents = s.agents > 0 ? `${s.agents} ${s.agents === 1 ? 'agent' : 'agents'} running` : ''
  const time = s.etaEndsAt !== null ? etaLeft(s.etaEndsAt, now) : s.since !== null ? soFar(s.since, now) : ''
  return [agents, time].filter(Boolean)
}

/**
 * The whole line as text, the row's label for a screen reader: '3 seats · Mia needs you · Ava, Leo working ·
 * 4 agents running · about 1 h 40 min left'; '2 seats · none working' when every seat is idle.
 */
export function seatsLabel(s: SeatsSummary, now: number): string {
  const groups = s.groups.map((g) => `${g.seats.map((x) => x.name).join(', ')} ${g.verb}`)
  return [seatCount(s.total), ...(groups.length ? groups : ['none working']), ...seatsTail(s, now)].join(' · ')
}
