// The Tools tab's calls to Desk's own routines API (desk2/server, the routine manager's routes), not the daemon's
// /ah/api/*: this copy of AgentHydra's window is served by Desk at /ah/, and standalone it is on Desk's origin too, so
// the paths are relative. Shapes are desk2/shared/routines.ts (the contract). Owner-only actions (every POST but
// `meta`) answer 403 unless the request carries X-Desk-Caller: window, which Desk's own web sends the same way
// (desk2/web/src/components/panes/api.ts). An error keeps its status and Desk's reason, so a 409 can show it inline.
import type { RoutineCampaigns, RoutineDetails, RoutinesRequest, RoutinesStatus } from '@desk/shared/routines'

export class RoutinesApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function answer<T>(res: Response): Promise<T> {
  const body: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const reason = (body as { error?: unknown } | null)?.error
    throw new RoutinesApiError(typeof reason === 'string' ? reason : `${res.status} ${res.statusText}`, res.status)
  }
  return body as T
}

const read = async <T>(path: string): Promise<T> => answer<T>(await fetch(path, { headers: { accept: 'application/json' } }))

/** GET /api/routines: what the manager saw last. `fresh` makes it look now. */
export const getRoutines = (fresh = false): Promise<RoutinesStatus> =>
  read<RoutinesStatus>(fresh ? '/api/routines?fresh=1' : '/api/routines')

/** GET /api/routines/:id/details: the whole-history numbers and a page of runs, newest first. `before` pages back. */
export function getRoutineDetails(id: string, opts: { limit?: number; before?: number | null } = {}): Promise<RoutineDetails> {
  const q = new URLSearchParams({ limit: String(opts.limit ?? 50) })
  if (opts.before != null) q.set('before', String(opts.before))
  return read<RoutineDetails>(`/api/routines/${encodeURIComponent(id)}/details?${q}`)
}

/** GET /api/routines/:id/campaigns: the ledger of each campaign the routine names (Desk reads the CrAInium for it). */
export const getRoutineCampaigns = (id: string): Promise<RoutineCampaigns> =>
  read<RoutineCampaigns>(`/api/routines/${encodeURIComponent(id)}/campaigns`)

/** POST /api/routines with one action. The answer is the whole status again. */
export async function postRoutines(body: RoutinesRequest): Promise<RoutinesStatus> {
  const res = await fetch('/api/routines', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-Desk-Caller': 'window' },
    body: JSON.stringify(body),
  })
  return answer<RoutinesStatus>(res)
}
