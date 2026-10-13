// A chat opened under another Desk chat keeps its parent and its manager, names the manager on its row, and its
// Claude process runs with the manager pinned (AGENTHYDRA_MANAGER); a chat with no manager runs without the pin.

import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager, parseCreate } from '../../../src/engine/chat-manager'
import { currentManager } from '../../../src/engine/managers'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
const oldManagersDir = process.env.AGENTHYDRA_MANAGERS_DIR
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
  if (oldManagersDir === undefined) delete process.env.AGENTHYDRA_MANAGERS_DIR
  else process.env.AGENTHYDRA_MANAGERS_DIR = oldManagersDir
})

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 5))
  }
}

function setup() {
  const home = mkdtempSync(join(tmpdir(), 'desk-submgr-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const personas = mkdtempSync(join(tmpdir(), 'desk-submgr-personas-'))
  temps.push(personas)
  process.env.AGENTHYDRA_MANAGERS_DIR = personas
  mkdirSync(join(personas, 'example-manager'))
  writeFileSync(join(personas, 'example-manager', 'persona.json'), JSON.stringify({ slug: 'example-manager', name: 'Example Manager' }))
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  return { home, m, q }
}

test('a chat opened under a Desk chat keeps its parent and manager, and runs with the manager pinned', async () => {
  const { home, m, q } = setup()
  const parent = await m.create({ cwd: home, delegateToCliMayte: false })
  const child = await m.create({
    cwd: home,
    prompt: 'start',
    title: 'Example Manager · topic',
    parentId: parent.id,
    managerSlug: 'example-manager',
    delegateToCliMayte: false,
  })
  expect(m.get(child.id)).toMatchObject({
    parentId: parent.id,
    managerSlug: 'example-manager',
    manager: { slug: 'example-manager', name: 'Example Manager' },
  })
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.env).toMatchObject({ AGENTHYDRA_MANAGER: 'example-manager' })
})

test('a chat with no manager runs without the pin', async () => {
  const { home, m, q } = setup()
  const chat = await m.create({ cwd: home, prompt: 'hi', delegateToCliMayte: false })
  expect(m.get(chat.id).manager).toBeNull()
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.env?.AGENTHYDRA_MANAGER).toBeUndefined()
})

test('a parent that is not a Desk chat is refused', async () => {
  const { home, m } = setup()
  await expect(m.create({ cwd: home, parentId: 'no-such-chat', delegateToCliMayte: false })).rejects.toThrow('parentId names no Desk chat')
})

test('a manager slug that is not a slug is refused', () => {
  expect(() => parseCreate({ cwd: 'C:/work', managerSlug: '../evil' })).toThrow('managerSlug is not a manager slug')
})

test('the manager label is the pin, else the manager the session is on, and none without a persona', () => {
  setup()
  const personas = process.env.AGENTHYDRA_MANAGERS_DIR!
  mkdirSync(join(personas, 'sessions'))
  writeFileSync(join(personas, 'sessions', 'sess-1.json'), JSON.stringify({ manager: 'example-manager' }))
  expect(currentManager(null, 'sess-1')).toEqual({ slug: 'example-manager', name: 'Example Manager' })
  expect(currentManager('example-manager', null)).toEqual({ slug: 'example-manager', name: 'Example Manager' })
  expect(currentManager('ghost', 'sess-1')).toBeNull()
  expect(currentManager(null, 'unknown-session')).toBeNull()
})
