// The CrAInium people add-on, present or absent, as injectable opts for peopleState and savePeople.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FAKE_DOOR = join(import.meta.dir, '..', '..', '..', 'server', 'tests', 'fixtures', 'fake-people-door.mjs')

export function absentAddon(home: string) {
  return { home, env: {}, appRoot: join(home, 'AgentHydra') }
}

export function presentAddon(home: string) {
  mkdirSync(join(home, '.agenthydra'), { recursive: true })
  const command = [process.execPath, FAKE_DOOR, join(home, 'people.json'), join(home, 'door-log.txt')]
  writeFileSync(join(home, '.agenthydra', 'people-store.json'), JSON.stringify({ crainium: { command } }))
  return absentAddon(home)
}
