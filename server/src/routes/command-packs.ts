/**
 * Command packs (server/src/command-packs.ts, docs/COMMAND-PACKS.md): GET /api/command-packs reads the list
 * and the last run, PUT saves the list and starts a run, POST /api/command-packs/sync starts one. A run pulls
 * git repos and can take a while, so both answer at once with `busy: true`; `?wait=1` answers when it is done.
 */

import { commandPacksView, runCommandPacks, saveCommandPacks } from '../command-packs'
import { app } from '../http-app'
import { jsonBody } from '../route-helpers'

app.get('/api/command-packs', (c) => c.json(commandPacksView()))

app.put('/api/command-packs', async (c) => {
  const body = await jsonBody(c)
  const saved = saveCommandPacks(body.packs)
  if (!saved.ok) return c.json({ error: saved.error }, 400)
  const run = runCommandPacks()
  if (c.req.query('wait')) await run.catch(() => {})
  else run.catch(() => {})
  return c.json(commandPacksView())
})

app.post('/api/command-packs/sync', async (c) => {
  const run = runCommandPacks()
  if (c.req.query('wait')) await run.catch(() => {})
  else run.catch(() => {})
  return c.json(commandPacksView())
})
