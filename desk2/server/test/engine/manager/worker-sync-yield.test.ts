// A pass over the CliMayte chats' workers reads one worker at a time and lets the event loop run between two
// (2026-10-09: with 10 to 30 running workers one pass held the server's one thread for seconds, and a click's request
// waited behind all of it).

import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatManager } from '../../../src/engine/chat-manager'
import { DEFAULT_SETTINGS } from '../../../src/settings'
import { fakeBridge, fakeQueries } from './fakes'

const temps: string[] = []
const managers: ChatManager[] = []
afterEach(async () => {
  for (const m of managers.splice(0)) await m.closeAll()
  for (const d of temps.splice(0)) rmSync(d, { recursive: true, force: true })
})

test('other work runs between one worker\'s read and the next', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-sync-yield-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const q = fakeQueries()
  const m = new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: q.queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  managers.push(m)
  await m.create({ cwd: home, prompt: 'first worker' })
  await m.create({ cwd: home, prompt: 'second worker' })
  for (const row of b.state.rows) Object.assign(row, { status: 'running', accountId: 'cli-110', account: '#110 a' })

  const order: string[] = []
  let reads = 0
  b.bridge.workerItems = async () => {
    reads += 1
    order.push(`read ${reads}`)
    if (reads === 1) setImmediate(() => order.push('other work'))
    return []
  }
  await m.syncWorkers()
  expect(order.slice(0, 3)).toEqual(['read 1', 'other work', 'read 2'])
})

// 2026-10-17: after a restart every chat starts closed and the first pass reads every worker, oldest chat first; the
// newest chats, the ones at work, showed their done ring until the pass reached them (79 s over 377 workers).
test('after a restart the chats whose worker runs are read first, before the finished ones', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-sync-first-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const make = () => new ChatManager({ home, claudeHome: home, emit: () => {}, settings: () => DEFAULT_SETTINGS, bridge: b.bridge, queryImpl: fakeQueries().queryImpl, agentHydraMcp: null, env: { PATH: '/bin' }, storeDebounceMs: 1 })
  const before = make()
  for (const prompt of ['old one', 'old two', 'the one at work']) {
    const chat = await before.create({ cwd: home, prompt })
    while (!before.get(chat.id).workerId) await new Promise((r) => setTimeout(r, 5))
  }
  await before.closeAll()
  b.state.rows.forEach((row, i) => Object.assign(row, { status: i === 2 ? 'running' : 'done', accountId: 'cli-110', account: '#110 a' }))

  const m = make()
  managers.push(m)
  const atWork = m.list().find((c) => c.workerId === b.state.rows[2]!.id)!
  expect(atWork.status).toBe('closed')
  const statusAtRead: string[] = []
  b.bridge.workerItems = async () => {
    statusAtRead.push(m.get(atWork.id).status)
    return []
  }
  await m.syncWorkers()
  // The first read is the running worker's, so the chat after it already shows working when the next read starts.
  expect(statusAtRead).toEqual(['closed', 'working', 'working'])
})
