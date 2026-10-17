// server/src/login-sync-arrivals.ts — tell the owner when a login sync brings in an account this PC
// did not have before, or deletes one because another PC deleted it. A pass collects one arrival per
// new instance it made here and one removal per instance it deleted (core/cli-login-sync.ts,
// core/desktop-login-sync.ts); each kind goes as ONE notification over the reset/incident channel.
//
// Never names an account's email: an instance is named by its number, which is what the owner reads.

import { sendOsNotification } from './notify-os'
import { getNotificationSettings } from './notify-settings'

/** One instance a sync made on this PC. `plan` is the CLI login's plan label when it carries one. */
export interface LoginArrival {
  kind: 'cli' | 'desktop'
  num: number | null
  plan: string | null
}

/** One instance a sync deleted here because a PC deleted it (owner, 2026-10-16: "let us know that the
 *  other person removed it"). `by` is that PC's name; `note` the reason its owner gave, when it opens. */
export interface LoginRemoval {
  kind: 'cli' | 'desktop'
  num: number | null
  by: string | null
  note: string | null
}

const KIND_LABEL: Record<LoginArrival['kind'], string> = {
  cli: 'Claude CLI account',
  desktop: 'Claude desktop instance',
}

/** One line per arrival: "Claude CLI account #7 (Max 20×)". Pure, so the wording is testable. */
export function arrivalLine(a: LoginArrival): string {
  const who = a.num === null ? '' : ` #${a.num}`
  const plan = a.plan ? ` (${a.plan})` : ''
  return `${KIND_LABEL[a.kind]}${who}${plan}`
}

/** The notification for one sync pass's arrivals, or null when nothing arrived. Several arrivals
 *  become one message listing them all. */
export function arrivalMessage(arrivals: LoginArrival[]): { title: string; body: string } | null {
  if (arrivals.length === 0) return null
  const n = arrivals.length
  return {
    title: n === 1 ? 'Login sync: 1 new account' : `Login sync: ${n} new accounts`,
    body: `Added by the sync: ${arrivals.map(arrivalLine).join('; ')}.`,
  }
}

const pcOf = (by: string | null): string => by ?? 'another PC'

/** What the delete guard on this PC is told when the sync deletes an instance (lifecycle.ts and
 *  cli-instances.ts ask every delete for a note). */
export function removalReason(by: string | null, note: string | null): string {
  return `Deleted on ${pcOf(by)}${note ? `: ${note}` : ''}`
}

/** The Login sync dialog's event line for an instance the sync deleted here. */
export function removalEvent(by: string | null, note: string | null): string {
  return `Deleted on ${pcOf(by)}, so deleted here too.${note ? ` Their note: “${note}”` : ''}`
}

/** One line per removal: "Claude desktop instance #7, deleted on PC-A: “not used any more”". */
export function removalLine(r: LoginRemoval): string {
  const who = r.num === null ? '' : ` #${r.num}`
  return `${KIND_LABEL[r.kind]}${who}, deleted on ${pcOf(r.by)}${r.note ? `: “${r.note}”` : ''}`
}

/** The notification for one sync pass's removals, or null when nothing was deleted here. */
export function removalMessage(removals: LoginRemoval[]): { title: string; body: string } | null {
  if (removals.length === 0) return null
  const n = removals.length
  return {
    title: n === 1 ? 'Login sync: 1 account deleted' : `Login sync: ${n} accounts deleted`,
    body: `Deleted here too: ${removals.map(removalLine).join('; ')}.`,
  }
}

/** Send one message over the desktop notification channel, when the owner has it on. Never throws: a
 *  failed toast must not take the sync pass down with it. */
async function notify(msg: { title: string; body: string } | null): Promise<void> {
  if (!msg) return
  const settings = getNotificationSettings()
  if (!settings.notifyEnabled || !settings.notifyDesktop) return
  try {
    await sendOsNotification({ ...msg, sticky: settings.notifyPersistent })
  } catch {
    // best-effort, like every notification channel
  }
}

/** Send one pass's arrivals. */
export const notifyLoginArrivals = (arrivals: LoginArrival[]): Promise<void> =>
  notify(arrivalMessage(arrivals))

/** Send one pass's removals. */
export const notifyLoginRemovals = (removals: LoginRemoval[]): Promise<void> =>
  notify(removalMessage(removals))
