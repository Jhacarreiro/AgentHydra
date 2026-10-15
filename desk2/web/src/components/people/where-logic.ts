import type { PeopleStoreStatus } from '@shared/people-store'

/** "just now", "5 min ago", "3 h ago", "2 d ago"; the exact time goes in the tooltip. */
export function ago(iso: string, now = Date.now()): string {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return ''
  const s = Math.max(0, Math.round((now - t) / 1000))
  if (s < 45) return 'just now'
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`
  return `${Math.round(s / 86_400)} d ago`
}

/** The last-sync line next to Sync now. */
export function syncLine(st: PeopleStoreStatus, now = Date.now()): string {
  if (st.syncing) return 'Syncing…'
  if (!st.lastSyncAt) return 'Not synced yet'
  return `Synced ${ago(st.lastSyncAt, now)}`
}

export interface WhereView {
  /** Connections can be picked (it has an app id). */
  canPick: boolean
  showAccount: boolean
  showSignIn: boolean
  showSync: boolean
}

export function whereView(st: PeopleStoreStatus): WhereView {
  const onConnections = st.home === 'connections'
  return {
    canPick: st.configured,
    showAccount: st.configured && st.signedIn && st.account !== null,
    showSignIn: st.configured && !st.signedIn,
    showSync: onConnections && st.configured && st.signedIn
  }
}

export const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
