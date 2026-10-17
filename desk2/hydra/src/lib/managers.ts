// The managers' pure helpers (HSwarm's Managers node): the state dots, and which of the work a routine started
// it is. A routine's work is found by its id: a CliMayte worker whose group begins `routine-<id>-`, an HSwarm
// job whose label begins `<id>`.

import { babysitterAttention, type BabysitterAct, type BabysitterChatState, type BabysitterStatus } from '@desk/shared/babysitter'
import type { InstanceManagerStatus, RecoveryState } from '@desk/shared/instance-manager'
import type { RoutineOutcome, RoutineState } from '@desk/shared/routines'

/** The dot a node or a row shows, as the tree draws it (HSwarmView's DOT_CLASS). */
export type ManagerDot = 'ok' | 'warn' | 'limit' | 'off' | 'run' | 'bad'

// Yellow ('warn') is only for what waits on the owner: a routine asking for his yes. A wait that ends by itself is
// not: a usage limit is 'limit' (Desk's usage-limit pink), a recovery under way is 'run', a due routine is 'ok'
// (owner, 2026-10-17: "Yellow icons should only ever be yellow if they require input from me").

/** A routine's state as its dot: running pulses, waiting for your yes is amber, idle and due are green, paused, off
 * and ended are grey, broken is red. */
export function routineDot(state: RoutineState): ManagerDot {
  if (state === 'running') return 'run'
  if (state === 'waiting') return 'warn'
  if (state === 'idle' || state === 'due') return 'ok'
  if (state === 'paused' || state === 'off' || state === 'ended') return 'off'
  return 'bad'
}

/** A manager's dot: a read that failed is red, switched off is grey, on is green. Undefined before the first read. */
export function managerDot(on: boolean | undefined, failed: boolean): ManagerDot | undefined {
  if (failed) return 'bad'
  if (on === undefined) return undefined
  return on ? 'ok' : 'off'
}

/** A stopped chat's dot: waiting for its limit to reset is the usage-limit pink, resumed is green, a continue AgentHydra
 * holds until the chat's app is idle is under way, and a continue that was refused, had no app to take it or was given
 * up on is red, since a person may have to step in. */
export function babysitterChatDot(state: BabysitterChatState): ManagerDot {
  if (state === 'waiting') return 'limit'
  if (state === 'resumed') return 'ok'
  if (state === 'held') return 'run'
  return 'bad'
}

/** The Babysitter's own dot (owner, 2026-10-16: chats needing its attention read in plain grey): red when its last
 * look failed or a stopped chat needs a person, the usage-limit pink while chats wait on a limit (shared babysitterAttention, which
 * Desk's Settings colours by too), else on or off. */
export function babysitterDot(s: BabysitterStatus | null | undefined): ManagerDot | undefined {
  const attention = s ? babysitterAttention(s) : null
  if (attention === 'person') return 'bad'
  if (attention === 'waiting') return 'limit'
  return managerDot(s?.enabled, false)
}

/** What the Babysitter did, as its dot: a delivered continue is green, a held one is under way, anything else is red. */
export function babysitterActDot(did: BabysitterAct['did']): ManagerDot {
  if (did === 'held') return 'run'
  return did === 'resumed' ? 'ok' : 'bad'
}

/** Recovery states that are still moving: the app is down or coming back, or the chats are being moved and watched. */
const RECOVERY_UNDER_WAY: RecoveryState[] = ['waiting', 'opening', 'moving', 'watching']

/** The Instance manager's dot: red when its read failed, a recovery failed or a chat in one is stuck; running while a
 * recovery is under way; else on or off. Undefined before the first read. */
export function instanceManagerDot(status: InstanceManagerStatus | null): ManagerDot | undefined {
  if (!status) return undefined
  const trouble = status.recoveries.some((r) => r.state === 'failed' || r.chats.some((c) => c.state === 'stuck'))
  if (status.error || trouble) return 'bad'
  if (status.recoveries.some((r) => RECOVERY_UNDER_WAY.includes(r.state))) return 'run'
  return managerDot(status.enabled, false)
}

/** Whether a CliMayte worker in this group is a routine's work: the group starts `routine-<id>-`. */
export function workerOfRoutine(group: string, id: string): boolean {
  return group.startsWith(`routine-${id}-`)
}

/** Whether an HSwarm job with this label is a routine's work: the label starts with the routine's id. */
export function jobOfRoutine(label: string | null | undefined, id: string): boolean {
  return (label ?? '').startsWith(id)
}

/** A run that can be started now: a routine that is idle or due (not paused, ended, off, broken or already running). */
export function canRunRoutine(state: RoutineState, busy: boolean): boolean {
  return !busy && (state === 'idle' || state === 'due')
}

/** The dot classes the managers' state dots use (the tree's DOT_CLASS, for the rows and tiles). */
export const MANAGER_DOT_CLASS: Record<ManagerDot, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  limit: 'bg-limited',
  off: 'bg-muted-foreground/50',
  run: 'bg-primary animate-pulse',
  bad: 'bg-destructive',
}

/** The text colour that goes with a dot, for the count or state word beside it. */
export const MANAGER_TEXT_CLASS: Record<ManagerDot, string> = {
  ok: 'text-success',
  warn: 'text-warning',
  limit: 'text-limited',
  off: 'text-muted-foreground',
  run: 'text-primary',
  bad: 'text-destructive',
}

/** The outcome's tone class: a failure is red, a busy look is muted. */
export function outcomeTone(outcome: RoutineOutcome): string {
  if (outcome === 'ok') return 'text-success'
  if (outcome === 'busy') return 'text-muted-foreground'
  return 'text-destructive'
}
