// The CrAInium people add-on, present or absent, as injectable opts for peopleState and savePeople.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

/** The in-repo people code on, as on a PC with the people door: a fake door in a temp home and no add-on module, so a
 *  test sees the same people on every PC (2026-10-15: core-lead's and sub-manager's 11 face tests read this PC's own
 *  door and failed on one without it). The returned cleanup forgets the load and removes the home. */
export async function usePeopleDoor(): Promise<() => void> {
  // Imported here, not at the top: people-setup.test.ts points HOME elsewhere before the people code loads.
  const { forgetPeopleAddon, loadPeopleAddon } = await import('../../../server/src/people-host')
  const home = mkdtempSync(join(tmpdir(), 'people-door-'))
  await loadPeopleAddon({ ...presentAddon(home), coreDir: join(home, 'core') })
  return () => {
    forgetPeopleAddon()
    rmSync(home, { recursive: true, force: true })
  }
}
