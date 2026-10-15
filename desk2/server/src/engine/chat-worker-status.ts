// What a CliMayte worker says, read as a chat's status, setting and account.

import type { AccountRef, ChatSummary, ChatWait } from '@shared/protocol'
import type { AhWorker, WorkerSendSetting } from '../bridge/client'
import { workerAccountLabel } from '../bridge/climayte'

export const LIVE_STATUSES = new Set<ChatSummary['status']>(['starting', 'working', 'needs_you'])

const WORKER_EFFORTS: readonly WorkerSendSetting['effort'][] = ['low', 'medium', 'high', 'xhigh', 'max']
export const SUS_WHY = 'Hydra Desk sus meter: the setting that pushes back least.'

const modelFamily = (model: string | null): WorkerSendSetting['model'] | null =>
  !model ? null : /opus/i.test(model) ? 'opus' : /sonnet/i.test(model) ? 'sonnet' : /haiku/i.test(model) ? 'haiku' : null
const effortLevel = (effort: string | null): WorkerSendSetting['effort'] | undefined => WORKER_EFFORTS.find((x) => x === effort)

/** A counted setting ('claude-opus-5-5', 'high') as CliMayte's send takes it; null when it cannot say it. */
export function climayteSetting(model: string, effort: string): WorkerSendSetting | null {
  const family = modelFamily(model)
  const level = effortLevel(effort)
  return family && level ? { model: family, effort: level } : null
}

/** A worker's setting from before Sus, as CliMayte's send takes it. A part it cannot name, or none (the worker ran on
 *  CliMayte's own default), goes back as the nearest it can: Opus, xhigh, how CliMayte launches a Desk chat. */
export function restoreSetting(r: { model: string | null; effort: string | null }): WorkerSendSetting {
  return { model: modelFamily(r.model) ?? 'opus', effort: effortLevel(r.effort) ?? 'xhigh' }
}

/** The setting a worker's turn ran on, named as a Claude turn's is: the model its attempt reported, else the one it was given. */
export function workerTurnSetting(w: AhWorker): { model: string; effort: string } {
  return { model: w.reportedModel || w.model || 'default', effort: w.effort ?? 'default' }
}

/** The account a worker runs on now, as a chat shows it ('#68'). */
export function workerAccount(w: AhWorker): AccountRef {
  const label = workerAccountLabel(w) ?? (w.accountId as string)
  const num = /^#(\d+)$/.exec(label)
  return { id: w.accountId as string, label, configDir: null, ...(num ? { number: Number(num[1]) } : {}) }
}

/** A CliMayte worker's status as a chat's: queued and waiting are starting, running and checking are working. A waiting
 *  worker's activity is CliMayte's reason ("Every eligible account is at its usage limit ...; the first frees up at
 *  ..."), so the chat says what it waits for instead of "Starting…" for half an hour. */
export function workerChatStatus(w: Pick<AhWorker, 'status' | 'lastActivity' | 'waitUntil' | 'notBefore'> & { error?: string | null }): {
  status: ChatSummary['status']
  activity: string | null
  waiting: ChatWait | null
} {
  switch (w.status) {
    case 'queued': {
      // In line, not started yet: the chat is waiting, not booting. A hold time, when AgentHydra gives one, is when.
      const until = typeof w.notBefore === 'number' && w.notBefore > 0 ? w.notBefore : null
      return { status: 'starting', activity: 'Queued', waiting: { reason: plainReason(w.error) || 'In line for an account.', until } }
    }
    case 'waiting': {
      const reason = plainReason(w.error) || 'Waiting for an account.'
      const until = w.waitUntil ? Date.parse(w.waitUntil) : Number.NaN
      return {
        status: 'starting',
        activity: !w.error ? 'Waiting for an account' : /^waiting\b/i.test(w.error) ? w.error : `Waiting for an account: ${w.error}`,
        waiting: { reason, until: Number.isFinite(until) ? until : null },
      }
    }
    case 'running':
      return { status: 'working', activity: w.lastActivity, waiting: null }
    case 'checking':
      return { status: 'working', activity: 'Running its check', waiting: null }
    case 'failed':
      return { status: 'error', activity: null, waiting: null }
    case 'cancelled':
      return { status: 'stopped', activity: null, waiting: null }
    default:
      return { status: 'idle', activity: null, waiting: null }
  }
}

/** CliMayte's reason for a wait as the window shows it: one line, no account addresses. */
function plainReason(error: string | null | undefined): string {
  return (error ?? '').replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, 'an account').replace(/\s+/g, ' ').trim()
}
