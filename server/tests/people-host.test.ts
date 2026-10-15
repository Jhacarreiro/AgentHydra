// The people add-on seen from AgentHydra: absent, every seam is inert; present, every seam asks the add-on first. The
// add-on is a fake module in a temp checkout; nothing here reads the real sue-dredd checkout or the real home.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerRouterHooks } from '../src/climayte-owner-sync'
import type { CatalogEntry } from '../src/hydra-core/catalog'
import { pickLead } from '../src/hydra-core/lead'
import { MANAGER_TOOLS, managerTools } from '../src/mcp-managers'
import {
  forgetPeopleAddon,
  inRepoPeople,
  loadPeopleAddon,
  peopleAddon,
  peopleModulePresent,
} from '../src/people-host'

const FAKE_ADDON = `
export function peopleAddon() {
  return {
    tools: [{ name: 'fake_people_tool', description: 'A fake people tool.', inputSchema: { type: 'object', properties: {} }, run: async () => ({ ok: true }) }],
    start() {},
    lead: async () => ({ slug: 'fake-lead' }),
    face: (chat) => ({ slug: 'fake-lead', name: 'Fake Lead', role: 'lead' }),
    routes: (app) => { app.get('/api/fake-people', (c) => c.json({ ok: true })) },
    catalogEntries: () => [{ id: 'person:fake-lead', kind: 'person', name: 'Fake Lead', family: 'manager', tier: 'manager', modes: ['become'], when: 'a fake manager', tags: [], cost: 'free' }],
    routerHooks: () => [{ hooks: [{ type: 'command', command: 'node C:/Users/me/managers/router.mjs' }] }],
    chatNote: () => 'fake note',
  }
}
`

const MANAGER: CatalogEntry = {
  id: 'person:fake-lead',
  kind: 'person',
  name: 'Fake Lead',
  family: 'manager',
  tier: 'manager',
  modes: ['become'],
  when: 'a fake manager',
  tags: [],
  cost: 'free',
  how: 'a fake manager',
  load: { type: 'none' },
}

let root = ''
let opts = {} as { home: string; env: Record<string, string>; appRoot: string; coreDir: string }

function setup(withAddon: boolean): void {
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, 'store'), { recursive: true })
  writeFileSync(join(checkout, 'store', 'people-door.mjs'), '')
  if (withAddon) {
    mkdirSync(join(checkout, 'people'), { recursive: true })
    writeFileSync(join(checkout, 'people', 'agenthydra.mjs'), FAKE_ADDON)
  }
  opts = {
    home: join(root, 'home'),
    env: { SUE_DREDD_HOME: checkout },
    appRoot: join(root, 'AgentHydra'),
    coreDir: join(root, 'core'),
  }
}

const absent = () => ({ home: opts.home, env: {}, appRoot: opts.appRoot, coreDir: opts.coreDir })

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'people-host-'))
  setup(false)
})
afterEach(() => {
  forgetPeopleAddon()
  rmSync(root, { recursive: true, force: true })
})

test('without the add-on module nothing loads and the catalog file is not written', async () => {
  setup(false)
  expect(await loadPeopleAddon(opts)).toBeNull()
  expect(peopleAddon()).toBeNull()
  expect(peopleModulePresent(opts)).toBe(false)
  expect(existsSync(join(opts.coreDir, 'catalog', 'generated-people.json'))).toBe(false)
})

test('a checkout with only the door keeps the in-repo people code on', async () => {
  setup(false)
  await loadPeopleAddon(opts)
  expect(inRepoPeople(opts)).toBe(true)
  expect(managerTools(opts)).toEqual(MANAGER_TOOLS)
})

test('with the add-on module the add-on answers its seams and the in-repo code keeps the rest', async () => {
  setup(true)
  const addon = await loadPeopleAddon(opts)
  expect(addon?.tools?.map((t) => t.name)).toEqual(['fake_people_tool'])
  expect(peopleAddon()).toBe(addon)
  expect(inRepoPeople(opts)).toBe(true)
  expect(managerTools(opts)).toEqual(MANAGER_TOOLS)
})

test('the add-on catalog entries are written to core/catalog and removed when it goes', async () => {
  setup(true)
  await loadPeopleAddon(opts)
  const file = join(opts.coreDir, 'catalog', 'generated-people.json')
  expect(JSON.parse(readFileSync(file, 'utf8'))[0].id).toBe('person:fake-lead')
  await loadPeopleAddon(absent())
  expect(existsSync(file)).toBe(false)
})

test('owner router hooks come from the add-on when present and are none when absent', async () => {
  setup(true)
  const ownerDir = join(root, 'owner')
  mkdirSync(ownerDir, { recursive: true })
  await loadPeopleAddon(opts)
  expect(ownerRouterHooks(ownerDir, opts)).toEqual([
    { hooks: [{ type: 'command', command: 'node C:/Users/me/managers/router.mjs' }] },
  ])
  await loadPeopleAddon(absent())
  expect(ownerRouterHooks(ownerDir, absent())).toEqual([])
})

test('the lead pick asks the add-on when present and uses words alone when absent', async () => {
  setup(true)
  await loadPeopleAddon(opts)
  const withAddon = await pickLead([MANAGER], 'please review the release notes', 2000, {
    cache: false,
  })
  expect(withAddon).toMatchObject({ id: 'person:fake-lead', path: 'model' })
  await loadPeopleAddon(absent())
  const without = await pickLead([MANAGER], 'please review the release notes', 2000, {
    cache: false,
  })
  expect(without.path).toBe('words')
})
