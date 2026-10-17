// When the Instances tab asks again who a Claude Desktop profile is signed into (useInstances' autoResolveAccounts).
// A pure rule, so the timers are testable without the store: each row is due once its last resolve is this old.
import type { CMInstance } from '@/lib/api'
import { loginChanged } from '@/lib/instance-appearance'

/** How long before an instance with NO identity yet (logged out, offline, unreadable) is retried.
 *  Short, because the thing that changes it — signing the profile in — is something the user does
 *  in the next minute and then looks straight at this table to confirm. A retry is a local file
 *  read that finds no token and gives up, so this is close to free. */
export const UNRESOLVED_RETRY_MS = 60_000
/** How long a RESOLVED identity is trusted before a background re-check. An account's email, name
 *  or plan can change without anything on disk changing (the user edits it at claude.ai), so the
 *  only way to notice is to ask again on a timer. Slow, because it costs one profile call per
 *  instance and the answer rarely changes. */
export const RESOLVED_REFRESH_MS = 15 * 60_000
/** A re-login IS visible on disk — config.json's `lastKnownAccountUuid` stops matching the
 *  identity on screen (see CMInstance.loginUuid) — so that case doesn't wait for the slow timer.
 *  Still throttled, so a mismatch that somehow persists can't turn the 4s poll into a profile-API
 *  hammer. */
export const LOGIN_CHANGED_RETRY_MS = 30_000
/** A login the live check could not confirm (status 'cache' or 'offline': the row's yellow mark, "Showing the last
 *  known account") is checked again this soon while its app runs, since signing back in happens in that app and the
 *  owner looks straight at the row for the mark to go (2026-10-16, owner: #8 kept its triangle after he signed in).
 *  The Instances tab's login watch (followLogins, every few seconds) is what asks. A closed one keeps the usual
 *  RESOLVED_REFRESH_MS: nothing changes its answer while the app is shut. */
export const UNCONFIRMED_RUNNING_RETRY_MS = 10_000
/** The live check could not confirm this row's login, so it shows the last known account (the yellow mark). */
export const unconfirmed = (i: Pick<CMInstance, 'account'>) => i.account?.status === 'cache' || i.account?.status === 'offline'

/** Whether a row whose identity was last resolved `ageMs` ago is due another resolve. */
export function resolveDue(i: Pick<CMInstance, 'account' | 'loginUuid' | 'isRunning'>, ageMs: number): boolean {
  // No identity yet (signed out / offline / unreadable): retry on the short timer.
  if (!i.account?.email && !i.account?.name) return ageMs >= UNRESOLVED_RETRY_MS
  // Signed into a different account than the one on screen: re-resolve promptly.
  if (loginChanged(i)) return ageMs >= LOGIN_CHANGED_RETRY_MS
  // Shown from the cache because the live check failed, with its app open: soon (see UNCONFIRMED_RUNNING_RETRY_MS).
  if (unconfirmed(i) && i.isRunning) return ageMs >= UNCONFIRMED_RUNNING_RETRY_MS
  // Known identity, same account: re-check occasionally in case the email/name/plan changed.
  return ageMs >= RESOLVED_REFRESH_MS
}
