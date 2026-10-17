// The calls "Your people" makes (shared/people.ts).
import { PEOPLE_SAVE, PEOPLE_STATE, type PeopleSaveRequest, type PeopleSaveResponse, type PeopleState } from '@shared/people'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
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
  return body as T
}

export const loadPeople = (): Promise<PeopleState> => call(PEOPLE_STATE)

export const savePeopleRequest = (req: PeopleSaveRequest): Promise<PeopleSaveResponse> =>
  call(PEOPLE_SAVE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
