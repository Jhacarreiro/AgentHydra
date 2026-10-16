// Your people is absent without the CrAInium people add-on: no state is read and no save is written.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { absentAddon, presentAddon } from './people-addon-fixture'

const bareHome = mkdtempSync(join(tmpdir(), 'people-gate-bare-'))
const doorHome = mkdtempSync(join(tmpdir(), 'people-gate-door-'))
const KEYS = ['HOME', 'USERPROFILE', 'AGENTHYDRA_MANAGERS_DIR', 'AGENTHYDRA_PEOPLE_DIR'] as const
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]))
beforeAll(() => {
  process.env.HOME = bareHome
  process.env.USERPROFILE = bareHome
  process.env.AGENTHYDRA_MANAGERS_DIR = join(bareHome, 'legacy-managers')
  process.env.AGENTHYDRA_PEOPLE_DIR = join(bareHome, 'people')
})
afterAll(() => {
  for (const k of KEYS) if (saved[k] === undefined) delete process.env[k]
  else process.env[k] = saved[k]
  rmSync(bareHome, { recursive: true, force: true })
  rmSync(doorHome, { recursive: true, force: true })
})

const { BadPeople, peopleState, savePeople } = await import('../src/people/setup')

test('peopleState reports unavailable without the add-on and available with it', () => {
  expect(peopleState(absentAddon(bareHome))).toMatchObject({ available: false, empty: false, managers: [], starters: [] })
  expect(peopleState(presentAddon(doorHome))).toMatchObject({ available: true, empty: true })
})

test('savePeople refuses without the add-on and writes nothing', async () => {
  let built = false
  const build = async () => {
    built = true
    return { ok: true, message: 'built' }
  }
  await expect(
    savePeople({ authority: { name: 'Example', brief: 'Rulings.' }, managers: [] } as never, build, absentAddon(bareHome)),
  ).rejects.toBeInstanceOf(BadPeople)
  expect(built).toBe(false)
})
