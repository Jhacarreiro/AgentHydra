// The people add-on's own routes (server/src/people-host.ts, `routes`): none without the add-on on this PC.
import type { Hono } from 'hono'
import { type PeopleAddon, getPeopleAddon } from '../../../../server/src/people-host'

type ServerHono = Parameters<NonNullable<PeopleAddon['routes']>>[0]

export default async function plugin(app: Hono): Promise<void> {
  const addon = await getPeopleAddon()
  addon?.routes?.(app as unknown as ServerHono)
}
