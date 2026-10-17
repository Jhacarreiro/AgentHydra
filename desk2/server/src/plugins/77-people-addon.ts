// The people add-on's routes (server/src/people-host.ts, `routes`), with the Desk services it calls registered first. With
// no add-on on this PC, Settings still reads the absent shapes its People and store screens expect, and writes refuse.
import type { Context, Hono } from 'hono'
import { PEOPLE_SAVE, PEOPLE_STATE } from '@shared/people'
import { type PeopleAddon, getPeopleAddon, registerDeskServices } from '../../../../server/src/people-host'
import type { ServerContext } from '../context'
import { sniff } from '../media/cache'
import { notOwnPage } from '../own-page'
import { renameOver, writeFlushed } from '../write-flushed'

type ServerHono = Parameters<NonNullable<PeopleAddon['routes']>>[0]

const WHAT_PEOPLE = "the people setup's API"
const WHAT_STORE = "the people store's API"
const NOT_HERE = 'The CrAInium people add-on is not installed on this PC.'
const NOT_INSTALLED = 'The people add-on is not installed on this PC.'
const ABSENT_PEOPLE = { available: false, empty: false, folder: '', authority: null, managers: [], starters: [] }
const ABSENT_STORE = { available: false, home: 'pc', crainium: { available: false, reason: NOT_HERE }, syncing: false, lastSyncAt: null, error: null }

export default async function plugin(app: Hono, ctx: ServerContext): Promise<void> {
  registerDeskServices({
    notOwnPage,
    writeFlushed,
    renameOver,
    sniff,
    managerChanged: (slug) => (ctx.deps.managerChanged as ((slug: string) => void) | undefined)?.(slug),
  })
  const addon = await getPeopleAddon()
  if (addon) addon.routes?.(app as unknown as ServerHono)
  else absentRoutes(app)
}

function absentRoutes(app: Hono): void {
  const refused = (c: Context, what: string) => {
    const why = notOwnPage(c.req.raw.headers, what)
    return why ? c.json({ error: why }, 403) : null
  }
  app.get(PEOPLE_STATE, (c) => refused(c, WHAT_PEOPLE) ?? c.json(ABSENT_PEOPLE))
  app.post(PEOPLE_SAVE, (c) => refused(c, WHAT_PEOPLE) ?? c.json({ error: NOT_INSTALLED }, 400))
  app.get('/api/people-store', (c) => refused(c, WHAT_STORE) ?? c.json(ABSENT_STORE))
  app.put('/api/people-store/home', (c) => refused(c, WHAT_STORE) ?? c.json({ error: NOT_HERE }, 409))
  app.post('/api/people-store/sync', (c) => refused(c, WHAT_STORE) ?? c.json({ error: NOT_HERE }, 409))
}
