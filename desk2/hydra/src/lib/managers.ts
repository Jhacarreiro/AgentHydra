// The managers' pure helpers (HSwarm's Managers node): the state dots, and which of the work an agent started
// it is. A standing agent's work is found by its name: a CliMayte worker whose group begins `<id>-`, an HSwarm
// job whose label begins `<id>`.

import type { ArchAIngelOutcome, ArchAIngelState } from '@desk/shared/archaingel'

/** The dot a node or a row shows, as the tree draws it (HSwarmView's DOT_CLASS). */
export type ManagerDot = 'ok' | 'warn' | 'off' | 'run' | 'bad'

/** A standing agent's state as its dot: running pulses, due waits, broken is red. */
export function agentDot(state: ArchAIngelState): ManagerDot {
  if (state === 'running') return 'run'
  if (state === 'due') return 'warn'
  if (state === 'idle') return 'ok'
  if (state === 'off') return 'off'
  return 'bad'
}

/** A manager's dot: a read that failed is red, switched off is grey, on is green. Undefined before the first read. */
export function managerDot(on: boolean | undefined, failed: boolean): ManagerDot | undefined {
  if (failed) return 'bad'
  if (on === undefined) return undefined
  return on ? 'ok' : 'off'
}

/** Whether a CliMayte worker in this group is an agent's work: the group starts `<id>-`. */
export function workerOfAgent(group: string, id: string): boolean {
  return group.startsWith(`${id}-`)
}

/** Whether an HSwarm job with this label is an agent's work: the label starts with the agent's id. */
export function jobOfAgent(label: string | null | undefined, id: string): boolean {
  return (label ?? '').startsWith(id)
}

/** A tick that can still be run again: an agent that is not off, broken or already running. */
export function canRunAgent(state: ArchAIngelState, busy: boolean): boolean {
  return !busy && (state === 'idle' || state === 'due')
}

/** The dot classes the managers' state dots use (the tree's DOT_CLASS, for the rows and tiles). */
export const MANAGER_DOT_CLASS: Record<ManagerDot, string> = {
  ok: 'bg-success',
  warn: 'bg-warning',
  off: 'bg-muted-foreground/50',
  run: 'bg-primary animate-pulse',
  bad: 'bg-destructive',
}

/** The outcome's tone class: a failure is red, a busy look is muted. */
export function outcomeTone(outcome: ArchAIngelOutcome): string {
  if (outcome === 'ok') return 'text-success'
  if (outcome === 'busy') return 'text-muted-foreground'
  return 'text-destructive'
}
