// The dashboard calls, through Desk 2's /ah/api to the one AgentHydra daemon (server/src/routes/dashboards.ts).
import type { Dashboard, DashboardList, DashboardWriteBody } from '@shared/dashboards'

const BASE = '/ah/api/dashboards'

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, init?.body ? { ...init, headers: { 'content-type': 'application/json' } } : init)
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (!body) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body
}

export const listDashboards = (): Promise<DashboardList> => call('')

export const getDashboard = (cwd: string): Promise<Dashboard> => call(`/workspace?cwd=${encodeURIComponent(cwd)}`)

export const writeDashboard = (body: DashboardWriteBody): Promise<Dashboard> =>
  call('/workspace', { method: 'POST', body: JSON.stringify(body) })
