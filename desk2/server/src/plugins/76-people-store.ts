// Where your people live (Settings → People): /api/people-store answers the status, PUT .../home picks This PC or
// Connections, POST .../signin, .../signout and .../sync act on it. The store itself is AgentHydra's
// (server/src/people-store/): the people on this PC or in the person's Connections account, synced.
// Only Desk 2's own page may call it (own-page.ts); Desk's localOnly guard runs first on every route.
// The store is loaded when the first call or the start-up sync needs it, so a missing package never stops Desk 2.
import type { Context, Hono } from 'hono'
import { notOwnPage } from '../own-page'

const WHAT = "the people store's API"
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

async function service() {
  return (await import('../../../../server/src/people-store')).peopleService()
}

export default function plugin(app: Hono): void {
  // Pull on start: quietly, and never blocking the boot.
  void service()
    .then((s) => s.syncOnStart())
    .catch(() => {
      // floor-ok: a failed start sync is recorded in the status Settings shows
    })

  const guard = (c: Context) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    return why ? c.json({ error: why }, 403) : null
  }

  app.get('/api/people-store', async (c) => guard(c) ?? c.json(await (await service()).status()))
  app.put('/api/people-store/home', async (c) => {
    const denied = guard(c)
    if (denied) return denied
    const body = (await c.req.json().catch(() => null)) as { home?: unknown } | null
    if (body?.home !== 'pc' && body?.home !== 'connections') return c.json({ error: 'home must be pc or connections' }, 400)
    try {
      return c.json(await (await service()).setHome(body.home))
    } catch (e) {
      return c.json({ error: words(e) }, 409)
    }
  })
  for (const action of ['signin', 'signout'] as const) {
    app.post(`/api/people-store/${action}`, async (c) => {
      const denied = guard(c)
      if (denied) return denied
      try {
        const s = await service()
        return c.json(action === 'signin' ? await s.signIn() : await s.signOut())
      } catch (e) {
        return c.json({ error: words(e) }, 409)
      }
    })
  }
  app.post('/api/people-store/sync', async (c) => {
    const denied = guard(c)
    if (denied) return denied
    const s = await service()
    await s.syncNow()
    return c.json(await s.status())
  })
}
