// A stand-in people add-on for the core_use seam: a temp checkout whose module answers useMode from a global mock a test
// sets. No persona logic lives here; the real modes are tested where they live, with the add-on.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forgetPeopleAddon, loadPeopleAddon, type UseModeAsk } from '../src/people-host'

declare global {
  var __useModeMock: ((ask: UseModeAsk) => Promise<unknown> | unknown) | undefined
}

const MODULE = `
export function peopleAddon() {
  return { useMode: async (ask) => (globalThis.__useModeMock ? globalThis.__useModeMock(ask) : null) }
}
`

let root = ''

export async function installUseAddon(): Promise<void> {
  root = mkdtempSync(join(tmpdir(), 'use-addon-'))
  const checkout = join(root, 'checkout')
  mkdirSync(join(checkout, 'store'), { recursive: true })
  writeFileSync(join(checkout, 'store', 'people-door.mjs'), '')
  mkdirSync(join(checkout, 'people'), { recursive: true })
  writeFileSync(join(checkout, 'people', 'agenthydra.mjs'), MODULE)
  await loadPeopleAddon({
    home: join(root, 'home'),
    env: { SUE_DREDD_HOME: checkout },
    appRoot: join(root, 'AgentHydra'),
    coreDir: join(root, 'core'),
  })
}

export function removeUseAddon(): void {
  forgetPeopleAddon()
  globalThis.__useModeMock = undefined
  if (root) rmSync(root, { recursive: true, force: true })
  root = ''
}
