// The calls "Where your people live" makes (shared/people-store.ts).
import {
  PEOPLE_STORE,
  PEOPLE_STORE_HOME,
  PEOPLE_STORE_SIGNIN,
  PEOPLE_STORE_SIGNOUT,
  PEOPLE_STORE_SYNC,
  type PeopleHomeKind,
  type PeopleStoreStatus
} from '@shared/people-store'

async function call(path: string, init?: RequestInit): Promise<PeopleStoreStatus> {
  const res = await fetch(path, init)
  const text = await res.text()
  let body: unknown = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  if (!res.ok) {
    const err = body && typeof body === 'object' && 'error' in body ? String((body as { error: unknown }).error) : ''
    throw new Error(err || `${res.status} ${res.statusText}`)
  }
  return body as PeopleStoreStatus
}

const post = (path: string, body: unknown = {}) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

export const loadStatus = () => call(PEOPLE_STORE)
export const chooseHome = (home: PeopleHomeKind) => call(PEOPLE_STORE_HOME, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ home }) })
export const signIn = () => post(PEOPLE_STORE_SIGNIN)
export const signOut = () => post(PEOPLE_STORE_SIGNOUT)
export const syncNow = () => post(PEOPLE_STORE_SYNC)
