// "Your people" (shared/people.ts): GET /api/people/state says whether the people folders are empty and offers the
// starter managers; POST /api/people/save writes the folders docs/PEOPLE.md defines and runs the catalog build.
// Only Desk 2's own page may call it.

import type { Hono } from 'hono'
import { PEOPLE_SAVE, PEOPLE_STATE, type PeopleSaveRequest } from '@shared/people'
import type { ServerContext } from '../context'
import { notOwnPage } from '../own-page'
import { BadPeople, peopleState, savePeople } from '../people/setup'

const WHAT = "the people setup's API"

export default function plugin(app: Hono, _ctx: ServerContext): void {
  app.get(PEOPLE_STATE, (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    return why ? c.json({ error: why }, 403) : c.json(peopleState())
  })

  app.post(PEOPLE_SAVE, async (c) => {
    const why = notOwnPage(c.req.raw.headers, WHAT)
    if (why) return c.json({ error: why }, 403)
    const body = (await c.req.json().catch(() => null)) as PeopleSaveRequest | null
    if (!body || typeof body !== 'object') return c.json({ error: 'Send a JSON body.' }, 400)
    try {
      return c.json(await savePeople(body))
    } catch (e) {
      if (e instanceof BadPeople) return c.json({ error: e.message }, 400)
      throw e
    }
  })
}
