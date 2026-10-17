// With the CrAInium people add-on absent, its features are absent; with its door present, they are not.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ownerRouterHooks } from '../src/climayte-owner-sync'
import { peopleAddonPresent } from '../src/people-addon'

const FAKE = join(import.meta.dir, 'fixtures', 'fake-people-door.mjs')
let home = ''
const absent = () => ({ home, env: {}, appRoot: join(home, 'AgentHydra') })

function present(): ReturnType<typeof absent> {
  mkdirSync(join(home, '.agenthydra'), { recursive: true })
  const command = [process.execPath, FAKE, join(home, 'people.json'), join(home, 'log.txt')]
  writeFileSync(
    join(home, '.agenthydra', 'people-store.json'),
    JSON.stringify({ crainium: { command } }),
  )
  return absent()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'people-addon-'))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

test('the add-on is absent on a bare PC and present with a settings door', () => {
  expect(peopleAddonPresent(absent())).toBe(false)
  expect(peopleAddonPresent(present())).toBe(true)
})

test('the private checkout counts as the door when the settings file names none', () => {
  mkdirSync(join(home, 'sue-dredd', 'store'), { recursive: true })
  writeFileSync(join(home, 'sue-dredd', 'store', 'people-door.mjs'), '')
  expect(peopleAddonPresent(absent())).toBe(true)
})

test('owner router hooks are none without the add-on', () => {
  const ownerDir = join(home, 'owner')
  mkdirSync(ownerDir, { recursive: true })
  writeFileSync(
    join(ownerDir, 'settings.json'),
    JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'node C:/Users/me/managers/router.mjs' }] },
        ],
      },
    }),
  )
  expect(ownerRouterHooks(ownerDir)).toEqual([])
})
