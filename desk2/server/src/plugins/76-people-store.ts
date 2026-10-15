// Where your people live (Settings → People): /api/people-store answers the status, PUT .../home picks This PC or
// CrAInium and POST .../sync syncs them. The store itself is AgentHydra's (server/src/people-store/): the people on
// this PC or in CrAInium (a private store reached through a door command), synced.
// Only Desk 2's own page may call it (own-page.ts); Desk's localOnly guard runs first on every route.
// The store is loaded when the first call or the start-up sync needs it, so a missing package never stops Desk 2.
import type { Context, Hono } from 'hono'
import { peopleAddonPresent } from '../../../../server/src/people-addon'
import { notOwnPage } from '../own-page'

const WHAT = "the people store's API"
const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))
const NOT_HERE = 'The CrAInium people add-on is not installed on this PC.'
const ABSENT = { available: false, home: 'pc', crainium: { available: false, reason: NOT_HERE }, syncing: false, lastSyncAt: null, error: null }

async function service() {
  return (await import('../../../../server/src/people-store')).peopleService()
}

export default function plugin(app: Hono): void {
  // Pull on start: quietly, and never blocking the boot.
  if (peopleAddonPresent())
    void service()
      .then((s) => s.syncOnStart())
      .catch(() => {
        // floor-ok: a failed start sync is recorded in the status Settings shows
      })

  const guard = (c: Context) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    return why ? c.json({ error: why }, 403) : null
  }

  app.get('/api/people-store', async (c) => {
    const denied = guard(c)
    if (denied) return denied
    if (!peopleAddonPresent()) return c.json(ABSENT)
    return c.json({ available: true, ...(await (await service()).status()) })
  })
  app.put('/api/people-store/home', async (c) => {
    const denied = guard(c)
    if (denied) return denied
    if (!peopleAddonPresent()) return c.json({ error: NOT_HERE }, 409)
    const body = (await c.req.json().catch(() => null)) as { home?: unknown } | null
    if (body?.home !== 'pc' && body?.home !== 'crainium') return c.json({ error: 'home must be pc or crainium' }, 400)
    try {
      return c.json(await (await service()).setHome(body.home))
    } catch (e) {
      return c.json({ error: words(e) }, 409)
    }
  })
  app.post('/api/people-store/sync', async (c) => {
    const denied = guard(c)
    if (denied) return denied
    if (!peopleAddonPresent()) return c.json({ error: NOT_HERE }, 409)
    const s = await service()
    await s.syncNow()
    return c.json(await s.status())
  })
}
