export type OutcomeKind = 'followed' | 'undone' | 'misled' | 'stale'

export interface OutcomeRow {
  type: 'outcome'
  adviceId: string
  kind: OutcomeKind
  at: string
  snapshotAt: string | null
  points: number | null
  version: string | null
}

export interface Reconciled {
  added: OutcomeRow[]
  outcomes: OutcomeRow[]
}

export interface Summary {
  root: string
  issued: number
  followed: number
  everFollowed: number
  undone: number
  misled: number
  stale: number
  feedback: { wrong: number; undone: number; right: number }
  badRate: number | null
}

export function reconcile(root: string, options?: { now?: number }): Reconciled
export function summarize(root: string, options?: { now?: number }): Summary
