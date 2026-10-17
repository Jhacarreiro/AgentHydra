// A listener registered through the host's onPlacement gets one call per placed message, and none after a reload.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  forgetPeopleAddon,
  loadPeopleAddon,
  type PlacementInput,
  reportPlacement,
} from '../src/people-host'

const FAKE_ADDON = `
export function peopleAddon(host) {
  host.onPlacement((input) => {
    globalThis.__placementSeen ??= []
    globalThis.__placementSeen.push(input.session)
  })
  return {}
}
`

type PlacementGlobal = { __placementSeen?: string[] }
const global = globalThis as PlacementGlobal
const seen = () => global.__placementSeen

let root = ''
let opts = {} as { home: string; env: Record<string, string>; appRoot: string; coreDir: string }

const placed = (session: string): PlacementInput => ({
  session,
  deskChat: null,
  source: 'test',
  message: 1,
  cwd: 'C:/Users/me/repo',
  promptChars: 10,
})

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'people-placement-'))
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, 'store'), { recursive: true })
  writeFileSync(join(checkout, 'store', 'people-door.mjs'), '')
  mkdirSync(join(checkout, 'people'), { recursive: true })
  writeFileSync(join(checkout, 'people', 'agenthydra.mjs'), FAKE_ADDON)
  opts = {
    home: join(root, 'home'),
    env: { SUE_DREDD_HOME: checkout },
    appRoot: join(root, 'AgentHydra'),
    coreDir: join(root, 'core'),
  }
  global.__placementSeen = []
})

afterEach(() => {
  forgetPeopleAddon()
  rmSync(root, { recursive: true, force: true })
  global.__placementSeen = undefined
})

test('a listener from onPlacement gets one call per placed message', async () => {
  await loadPeopleAddon(opts)
  reportPlacement(placed('s1'), new Date())
  reportPlacement(placed('s2'), new Date())
  expect(seen()).toEqual(['s1', 's2'])
})

test('a reload resets the listeners, so a placed message reaches none of the old ones', async () => {
  await loadPeopleAddon(opts)
  reportPlacement(placed('s1'), new Date())
  await loadPeopleAddon(opts)
  reportPlacement(placed('s2'), new Date())
  expect(seen()).toEqual(['s1', 's2'])
})
