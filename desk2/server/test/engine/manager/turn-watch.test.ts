// A write to the session file of a turn in flight reaches the chat at once (about 1 s), not at the next 3 s poll.

import { afterEach, expect, test } from 'bun:test'
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

async function until(ok: () => boolean, what: string): Promise<void> {
  const end = Date.now() + 5_000
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('a write to the turn in flight shows in the chat within about a second, with no poll', async () => {
  const home = mkdtempSync(join(tmpdir(), 'desk-turn-watch-'))
  temps.push(home)
  process.env.HYDRA_DESK_HOME = home
  const b = fakeBridge()
  const m = new ChatManager({
    home,
    claudeHome: home,
    emit: () => {},
    settings: () => DEFAULT_SETTINGS,
    bridge: b.bridge,
    queryImpl: fakeQueries().queryImpl,
    agentHydraMcp: null,
    env: { PATH: '/bin' },
    storeDebounceMs: 1,
    retryDelays: { firstMs: 5, maxMs: 20 },
  })
  managers.push(m)
  const chat = await m.create({ cwd: home, prompt: 'reply with the word pong' })
  await until(() => !!m.get(chat.id).workerId, 'the worker')
  Object.assign(b.state.rows[0]!, { accountId: 'acct-1' })
  const file = join(home, 'worker-session-1.jsonl')
  writeFileSync(file, '')
  b.bridge.workerFileOf = () => file
  await m.syncWorkers(chat.id)

  b.state.workerItems['worker-session-1'] = [
    { kind: 'user', id: 'u-1', ts: 1, text: 'reply with the word pong' },
    { kind: 'assistant_text', id: 'a-1', ts: 2, text: 'pong' },
  ]
  const written = Date.now()
  appendFileSync(file, '{"type":"assistant"}\n')
  await until(() => m.listItems(chat.id).some((i) => i.kind === 'assistant_text' && i.text === 'pong'), 'the reply')
  expect(Date.now() - written).toBeLessThan(1000)
})
