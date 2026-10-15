// Where your people live (Settings → People): the status AgentHydra's /api/people-store answers
// (server/src/people-store/service.ts PeopleStatus). Desk 2's server passes the calls on.
export const PEOPLE_STORE = '/api/people-store'
export const PEOPLE_STORE_HOME = `${PEOPLE_STORE}/home`
export const PEOPLE_STORE_SIGNIN = `${PEOPLE_STORE}/signin`
export const PEOPLE_STORE_SIGNOUT = `${PEOPLE_STORE}/signout`
export const PEOPLE_STORE_SYNC = `${PEOPLE_STORE}/sync`

export type PeopleHomeKind = 'pc' | 'connections'

export interface PeopleStoreStatus {
  home: PeopleHomeKind
  /** False when this build has no Connections app id. */
  configured: boolean
  signedIn: boolean
  account: { name: string; email: string | null } | null
  syncing: boolean
  lastSyncAt: string | null
  /** Plain words, or null when the last sync was fine. */
  error: string | null
  note: string | null
}
