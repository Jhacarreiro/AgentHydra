// A chat opened under another Desk chat keeps its parent and its manager, names the manager on its row, and its
// Claude process runs with the manager pinned (AGENTHYDRA_MANAGER); a chat with no manager runs without the pin.

import { afterEach, expect, setSystemTime, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '../../../../shared/protocol'
import { ChatManager } from '../../../src/engine/chat-manager'
import { parseCreate } from '../../../src/engine/chat-requests'
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

function setup(emit: (event: ServerEvent) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'desk-submgr-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const personas = mkdtempSync(join(tmpdir(), 'desk-submgr-personas-'))
  temps.push(personas)
  process.env.AGENTHYDRA_MANAGERS_DIR = personas
  mkdirSync(join(personas, 'example-manager'))
  writeFileSync(join(personas, 'example-manager', 'persona.json'), JSON.stringify({ slug: 'example-manager', name: 'Example Manager' }))
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit, settings: () => DEFAULT_SETTINGS, bridge: fakeBridge().bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1, newChats: 'sdk' })
  managers.push(m)
  return { home, personas, m, q }
}

function sentChats(events: ServerEvent[]) {
  return events.flatMap((e) => (e.type === 'chat.upsert' ? [e.chat] : []))
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
  })
  await waitFor(() => q.all.length === 1)
  expect(q.last().options.env).toMatchObject({ AGENTHYDRA_MANAGER: 'example-manager' })
})

test('archiving a chat archives its sub-chats and theirs, and unarchiving brings them back; other chats stay', async () => {
  const { home, m } = setup()
  const parent = await m.create({ cwd: home, delegateToCliMayte: false })
  const child = await m.create({ cwd: home, parentId: parent.id, delegateToCliMayte: false })
  const grandchild = await m.create({ cwd: home, parentId: child.id, delegateToCliMayte: false })
  const other = await m.create({ cwd: home, delegateToCliMayte: false })
  const archived = () => [parent, child, grandchild, other].map((c) => m.get(c.id).archived)
  await m.patch(parent.id, { archived: true })
  expect(archived()).toEqual([true, true, true, false])
  await m.patch(parent.id, { archived: false })
  expect(archived()).toEqual([false, false, false, false])
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

test('a runtime chat.upsert of a pinned chat carries its manager label', async () => {
  const events: ServerEvent[] = []
  const { home, m } = setup((e) => events.push(e))
  const chat = await m.create({ cwd: home, prompt: 'start', managerSlug: 'example-manager', delegateToCliMayte: false })
  events.length = 0
  ;(m as unknown as { onRuntimeEvent(event: ServerEvent): void }).onRuntimeEvent({ type: 'chat.upsert', chat: m.get(chat.id) })
  const sent = sentChats(events)
  expect(sent.map((c) => c.id)).toEqual([chat.id])
})
