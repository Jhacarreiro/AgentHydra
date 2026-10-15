/**
 * Where your people live (server/src/people-store/): GET /api/people-store is the status Settings shows,
 * PUT /api/people-store/home picks This PC or Connections, POST .../signin, .../signout and .../sync act on it,
 * and GET /api/people-store/people lists the people on this PC. A failed call answers in plain words.
 */
import { app } from '../http-app'
import { peopleService } from '../people-store'

const words = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// Pull on start: quietly, never blocking the boot.
void peopleService()
  .syncOnStart()
  .catch(() => {
    // floor-ok: a failed start sync is already recorded in the status
  })

app.get('/api/people-store', async (c) => c.json(await peopleService().status()))

app.get('/api/people-store/people', async (c) => c.json(await peopleService().list()))

app.put('/api/people-store/home', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { home?: unknown } | null
  if (body?.home !== 'pc' && body?.home !== 'connections')
    return c.json({ error: 'home must be pc or connections' }, 400)
  try {
    return c.json(await peopleService().setHome(body.home))
  } catch (e) {
    return c.json({ error: words(e) }, 409)
  }
})

app.post('/api/people-store/signin', async (c) => {
  try {
    return c.json(await peopleService().signIn())
  } catch (e) {
    return c.json({ error: words(e) }, 409)
  }
})

app.post('/api/people-store/signout', async (c) => {
  try {
    return c.json(await peopleService().signOut())
  } catch (e) {
    return c.json({ error: words(e) }, 409)
  }
})

app.post('/api/people-store/sync', async (c) => {
  await peopleService().syncNow()
  return c.json(await peopleService().status())
})
