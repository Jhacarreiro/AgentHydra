// Without the CrAInium people add-on, Settings reads the absent shapes and nothing is written. The checkout is an empty
// folder, so no add-on loads and the routes are the fallback in plugins/77-people-addon.ts.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { forgetPeopleAddon, loadPeopleAddon } from '../../../server/src/people-host'
import plugin from '../src/plugins/77-people-addon'

const root = mkdtempSync(join(tmpdir(), 'people-gate-'))
const KEYS = ['HOME', 'USERPROFILE', 'SUE_DREDD_HOME', 'AGENTHYDRA_MANAGERS_DIR', 'AGENTHYDRA_PEOPLE_DIR'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))

beforeAll(async () => {
  mkdirSync(join(root, 'home'), { recursive: true })
  process.env.HOME = join(root, 'home')
  process.env.USERPROFILE = join(root, 'home')
  process.env.SUE_DREDD_HOME = join(root, 'empty-checkout')
  process.env.AGENTHYDRA_MANAGERS_DIR = join(root, 'legacy-managers')
  process.env.AGENTHYDRA_PEOPLE_DIR = join(root, 'people')
  await loadPeopleAddon({
    home: join(root, 'home'),
    env: { SUE_DREDD_HOME: join(root, 'empty-checkout') },
    appRoot: join(root, 'AgentHydra'),
    coreDir: join(root, 'core'),
  })
})

afterAll(() => {
  forgetPeopleAddon()
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  rmSync(root, { recursive: true, force: true })
})

const OWN = {}
const CROSS = { 'sec-fetch-site': 'cross-site' }
const NOT_HERE = 'The CrAInium people add-on is not installed on this PC.'

async function app(): Promise<Hono> {
  const app = new Hono()
  await plugin(app, { deps: {} } as never)
  return app
}

test('people state reads as absent without the add-on, and only from the own page', async () => {
  const a = await app()
  const res = await a.request('/api/people/state', { headers: OWN })
  expect(await res.json()).toEqual({ available: false, empty: false, folder: '', authority: null, managers: [], starters: [] })
  expect((await a.request('/api/people/state', { headers: CROSS })).status).toBe(403)
})

test('saving people without the add-on is refused and writes nothing', async () => {
  const a = await app()
  const res = await a.request('/api/people/save', {
    method: 'POST',
    headers: { ...OWN, 'content-type': 'application/json' },
    body: JSON.stringify({ authority: { name: 'Example', brief: 'Rulings.' }, managers: [] }),
  })
  expect(res.status).toBe(400)
  expect(await res.json()).toEqual({ error: 'The people add-on is not installed on this PC.' })
})

test('the store reads as absent and its switch and sync are refused without the add-on', async () => {
  const a = await app()
  const status = await a.request('/api/people-store', { headers: OWN })
  expect(await status.json()).toEqual({
    available: false,
    home: 'pc',
    crainium: { available: false, reason: NOT_HERE },
    syncing: false,
    lastSyncAt: null,
    error: null,
  })
  const home = await a.request('/api/people-store/home', {
    method: 'PUT',
    headers: { ...OWN, 'content-type': 'application/json' },
    body: JSON.stringify({ home: 'crainium' }),
  })
  expect(home.status).toBe(409)
  expect(await home.json()).toEqual({ error: NOT_HERE })
  const sync = await a.request('/api/people-store/sync', { method: 'POST', headers: OWN })
  expect(sync.status).toBe(409)
  expect((await a.request('/api/people-store', { headers: CROSS })).status).toBe(403)
})
