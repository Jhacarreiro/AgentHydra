import type { PeopleStoreStatus } from './where-types'

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
  /** CrAInium (private) can be picked: the door is here and answering. */
  canPick: boolean
  showSync: boolean
}

export function whereView(st: PeopleStoreStatus): WhereView {
  return {
    canPick: st.crainium.available,
    showSync: st.home === 'crainium' && st.crainium.available
  }
}
