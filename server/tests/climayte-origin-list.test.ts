// server/tests/climayte-origin-list.test.ts — `origin=<session ids>` on the workers list (Desk 2's Background tasks
// panel asks it for the open chat).
//
// It answers the workers those chats dispatched, through the workers they dispatched and a wave's manager, and for a chat
// that is itself a worker the ones that worker dispatched, never the worker itself; `limit` counts the finished ones of
// those workers alone, so a chat's own finished worker stays listed however many newer ones the rest of the PC finished.

import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { climayteRun, setCliMayteAccountsProvider } from '../src/climayte'
import { workers } from '../src/climayte-core'
import { app } from '../src/http-app'
import '../src/routes/climayte'

// A fresh Hono keeps the shared app's router open for later files (climayte-origin.test.ts has the story).
const http = new Hono().route('/', app)

const scratch = mkdtempSync(join(tmpdir(), 'climayte-origin-list-'))
const CWD = join(scratch, 'repo')
mkdirSync(CWD, { recursive: true })
const GROUP = 'origin-list-g'
const SID = '11111111-2222-4333-8444-555555555555'
const OTHER = '99999999-0000-4000-8000-000000000000'
const OWN_OLD = '22222222-3333-4444-8555-666666666666'

const made: string[] = []
beforeAll(() => setCliMayteAccountsProvider(() => []))
afterAll(() => {
  // Removed, not cancelled: a worker with a chat origin that ends is pinged to its chat by a later file's ping outbox
  // (one process runs them all).
  for (const id of made) workers.delete(id)
  setCliMayteAccountsProvider(null)
  if (scratch) rmSync(scratch, { recursive: true, force: true })
})

const list = async (qs: string) =>
  (
    (await (
      await http.fetch(new Request(`http://127.0.0.1/api/corch/workers?group=${GROUP}&lean=1${qs}`))
    ).json()) as Array<{ id: string }>
  )
    .map((r) => r.id)
    .sort()

test('origin keeps the workers a chat dispatched, through workers and waves, with limit counting their finished ones', async () => {
  const names = [
    'direct',
    'child',
    'manager',
    'waveTask',
    'theirs',
    'ownWorker',
    'ownChild',
  ] as const
  const run = climayteRun({
    tasks: names.map((t) => ({ prompt: `do ${t}`, cwd: CWD, title: t, size: 'whole' as const })),
    group: GROUP,
  }).workers
  made.push(...run.map((w) => w.id))
  const id = Object.fromEntries(names.map((n, i) => [n, run[i]!.id])) as Record<
    (typeof names)[number],
    string
  >
  const set = (n: (typeof names)[number], over: Record<string, unknown>) =>
    Object.assign(workers.get(id[n])!, over)
  const chat = (sessionId: string) => ({
    kind: 'chat',
    sessionId,
    home: CWD,
    transcript: null,
    how: 'test',
  })
  // The chat's own worker finished long ago; another chat's finished since.
  set('direct', { origin: chat(SID), status: 'done', updatedAt: 1_000 })
  set('child', { origin: { kind: 'worker', workerId: id.direct } })
  set('manager', { origin: chat(SID), kind: 'manage', wave: 'wv-1' })
  set('waveTask', { origin: undefined, wave: 'wv-1' })
  set('theirs', { origin: chat(OTHER), status: 'done', updatedAt: Date.now() })
  // A chat that is itself a worker, asked by an earlier session of that worker.
  set('ownWorker', { origin: chat(OTHER), sessionId: 'own-now', sessions: [OWN_OLD] })
  set('ownChild', { origin: { kind: 'worker', workerId: id.ownWorker } })

  expect(await list(`&origin=${SID}`)).toEqual(
    [id.direct, id.child, id.manager, id.waveTask].sort(),
  )
  // limit=1 among the chat's own: its old finished worker stays, the newer one of another chat never takes its place.
  expect(await list(`&origin=${SID}&limit=1`)).toEqual(
    [id.direct, id.child, id.manager, id.waveTask].sort(),
  )
  expect(await list(`&origin=${SID}&limit=0`)).toEqual([id.child, id.manager, id.waveTask].sort())
  expect(await list(`&origin=${OWN_OLD}`)).toEqual([id.ownChild])
  expect(await list(`&origin=${SID},${OWN_OLD}`)).toEqual(
    [id.direct, id.child, id.manager, id.waveTask, id.ownChild].sort(),
  )
})
