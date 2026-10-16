// Where your people live (Settings → People): the status /api/people-store answers
// (server/src/people-store/service.ts PeopleStatus), served by server/src/plugins/76-people-store.ts.
export const PEOPLE_STORE = '/api/people-store'
export const PEOPLE_STORE_HOME = `${PEOPLE_STORE}/home`
export const PEOPLE_STORE_SYNC = `${PEOPLE_STORE}/sync`

export type PeopleHomeKind = 'pc' | 'crainium'

export interface PeopleStoreStatus {
  /** False without the CrAInium people add-on on this PC: Settings shows no People section. */
  available: boolean
  home: PeopleHomeKind
  /** CrAInium (private): `available` is true only when the door is here and answering. */
  crainium: { available: boolean; owner?: string; people?: number; reason?: string }
  syncing: boolean
  lastSyncAt: string | null
  /** Plain words, or null when the last sync was fine. */
  error: string | null
}
