// A chat's face comes from the people add-on when one is loaded, and is none without it. The add-on is a fake module in
// a temp checkout; nothing here reads the real sue-dredd checkout or the real home.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { chatFace } from '../../src/engine/core-lead'
import { forgetPeopleAddon, loadPeopleAddon } from '../../../../server/src/people-host'

const FAKE_ADDON = `
export function peopleAddon() {
  return {
    face: (chat) => ({ slug: 'fake-lead', name: 'Fake Lead', role: 'lead' }),
  }
}
`

let root = ''
let opts = {} as { home: string; env: Record<string, string>; appRoot: string; coreDir: string }

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'people-face-'))
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
})

afterEach(() => {
  forgetPeopleAddon()
  rmSync(root, { recursive: true, force: true })
})

test('with the add-on loaded a chat takes its face from the add-on', async () => {
  await loadPeopleAddon(opts)
  expect(chatFace({ id: 'chat-1' })).toMatchObject({
    slug: 'fake-lead',
    name: 'Fake Lead',
    role: 'lead',
    photo: null,
  })
})

test('without the add-on a chat has no people face', async () => {
  await loadPeopleAddon({ home: opts.home, env: {}, appRoot: opts.appRoot, coreDir: opts.coreDir })
  expect(chatFace({ id: 'chat-1' })).toBeNull()
})
