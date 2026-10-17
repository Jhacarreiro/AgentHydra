// The dashboard reads: a static site through Desk 2's /ah/api to the one AgentHydra daemon (server/src/routes/dashboards.ts),
// and a template dashboard from Desk 2's own server (server/src/plugins/47-project-dashboard.ts).
import type { Dashboard, DashboardList } from '@shared/dashboards'
import type { ProjectDashboard, ProjectDashboardList } from '@shared/project-dashboard'

const BASE = '/ah/api/dashboards'

async function call<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`)
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown }) | null
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (!body) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body
}

export const listDashboards = (): Promise<DashboardList> => call('')

export const getDashboard = (cwd: string): Promise<Dashboard> => call(`/workspace?cwd=${encodeURIComponent(cwd)}`)

/** Thrown by getTemplate for a project with no dashboard spec: the page shows its static site instead. */
export class NoTemplate extends Error {}

async function own<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init)
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown; spec?: unknown }) | null
  if (res.status === 404 && body?.spec === false) throw new NoTemplate(typeof body.error === 'string' ? body.error : 'no dashboard spec')
  if (!res.ok) throw new Error(typeof body?.error === 'string' && body.error ? body.error : `${res.status} ${res.statusText}`)
  if (!body) throw new Error(`${res.status} ${res.statusText}: not a JSON answer`)
  return body
}

/** A project's template dashboard; `waitMs` lets a first read of its sources finish before the answer. */
export const getTemplate = (cwd: string, waitMs = 0): Promise<ProjectDashboard> =>
  own(`/api/project-dashboard?cwd=${encodeURIComponent(cwd)}${waitMs ? `&wait=${waitMs}` : ''}`)

export const refreshTemplate = (cwd: string): Promise<ProjectDashboard> =>
  own('/api/project-dashboard/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cwd }) })

export const listTemplates = (): Promise<ProjectDashboardList> => own('/api/project-dashboards')
