// The project dashboard template's routes (shared/project-dashboard.ts): the window's dashboard page and Project Hydra
// read a project's spec filled from its sources here. 20-engine.ts puts the person's project folders in
// ctx.deps.projectFolders; without it (a test server with no engine) the list is empty.

import type { Context, Hono } from 'hono'
import type { ServerContext } from '../context'
import { dashboardService, type DashboardService, NoSpecError } from '../project-dashboard/service'

async function answer(c: Context, run: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json((await run()) as object)
  } catch (err) {
    if (err instanceof NoSpecError) return c.json({ error: err.message, spec: false }, 404)
    return c.json({ error: (err as Error).message }, 500)
  }
}

export default function plugin(app: Hono, ctx: ServerContext): void {
  const service = (ctx.deps.projectDashboards as DashboardService | undefined) ?? dashboardService({ home: ctx.home })
  const folders = async (): Promise<string[]> => {
    const list = ctx.deps.projectFolders as (() => Promise<string[]>) | undefined
    return list ? await list() : []
  }

  app.get('/api/project-dashboards', (c) => answer(c, async () => service.list(await folders())))

  app.get('/api/project-dashboard', (c) => {
    const cwd = c.req.query('cwd')?.trim()
    if (!cwd) return c.json({ error: 'cwd is required: a folder inside the project' }, 400)
    const wait = Math.min(Number(c.req.query('wait')) || 0, 30_000)
    return answer(c, () => service.get(cwd, wait))
  })

  app.post('/api/project-dashboard/refresh', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { cwd?: unknown } | null
    const cwd = typeof body?.cwd === 'string' ? body.cwd.trim() : ''
    if (!cwd) return c.json({ error: 'cwd is required: a folder inside the project' }, 400)
    return answer(c, () => service.refresh(cwd))
  })
}
