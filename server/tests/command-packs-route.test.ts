// The answers of /api/command-packs (server/src/routes/command-packs.ts). A save starts a run and answers at
// once; that answer must already say busy, or Settings polls slowly and shows the run before it (found live:
// a saved pack read "Not pulled yet" while every account already held its commands). `?wait=1` answers with
// the run done. No packs, so the run pulls nothing and writes nothing: it only reads each account's folder.

import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import type { CommandPacksView } from '../src/command-packs'
import { app } from '../src/http-app'
import '../src/routes/command-packs'

const http = new Hono().route('/', app)
const RUN_MS = 60_000

test(
  'a save answers busy at once, and a waited sync answers with its run done',
  async () => {
    const saved = await http.request('/api/command-packs', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ packs: [] }),
    })
    expect(saved.status).toBe(200)
    expect(((await saved.json()) as CommandPacksView).busy).toBe(true)

    const synced = await http.request('/api/command-packs/sync?wait=1', { method: 'POST' })
    const view = (await synced.json()) as CommandPacksView
    expect(view.busy).toBe(false)
    expect(view.packs).toEqual([])
    expect(view.run?.packs).toEqual([])
  },
  RUN_MS,
)
